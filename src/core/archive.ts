import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ArchiveConfig } from "./config.js";
import type { MergeStatus, Risk } from "./decide.js";
import * as git from "./git.js";
import { dirSizeKb } from "./size.js";
import { run } from "../util/exec.js";
import type { Logger } from "../util/log.js";
import { formatBytes } from "../util/bytes.js";
import { formatStamp } from "../util/time.js";

export interface ArchiveRecord {
  version: 1;
  id: string;
  dir: string;
  createdAt: string;
  repo: string;
  repoName: string;
  worktree: string | null;
  branch: string | null;
  head: string | null;
  reason: string;
  risks: Risk[];
  pr: { number: number; url: string; state: string } | null;
  /** Commits that were not reachable from the default branch. */
  bundle: { file: string; commits: number; revRange: string } | null;
  /** Uncommitted tracked changes. */
  patch: { file: string; bytes: number } | null;
  untracked: { count: number; bytes: number; file: string | null; truncated: boolean } | null;
}

export interface ArchiveInput {
  repo: string;
  worktreePath: string | null;
  branch: string | null;
  head: string | null;
  reason: string;
  risks: Risk[];
  merge: MergeStatus;
  /** Base ref to diff history against, e.g. `refs/remotes/origin/main`. */
  base: string | null;
  config: ArchiveConfig;
  logger?: Logger;
  now?: number;
}

const META = "meta.json";

/**
 * Save everything that would be lost, *before* anything is removed.
 *
 * A cleanly merged worktree has nothing unique in it, so only a small metadata
 * record is written. Anything with unmerged commits, uncommitted changes or
 * untracked files gets a bundle, a patch and a tarball — which is what makes
 * an unattended daemon a reasonable thing to run.
 */
export async function archiveWork(input: ArchiveInput): Promise<ArchiveRecord | null> {
  if (!input.config.enabled) return null;

  const now = input.now ?? Date.now();
  const repoName = basename(input.repo);
  const slug = (input.branch ?? "detached").replace(/[^a-zA-Z0-9._-]/g, "-");
  const id = join(repoName, `${slug}-${formatStamp(now)}`);
  const dir = join(input.config.dir, id);

  await mkdir(dir, { recursive: true });

  const record: ArchiveRecord = {
    version: 1,
    id,
    dir,
    createdAt: new Date(now).toISOString(),
    repo: input.repo,
    repoName,
    worktree: input.worktreePath,
    branch: input.branch,
    head: input.head,
    reason: input.reason,
    risks: input.risks,
    pr: prOf(input.merge),
    bundle: null,
    patch: null,
    untracked: null,
  };

  // 1. Commits that exist nowhere else.
  if (input.branch) {
    const revRange = input.base ? `${input.base}..${input.branch}` : input.branch;
    const commits = input.base
      ? await git.commitsNotIn(input.repo, input.base, input.branch)
      : [];
    if (!input.base || commits.length > 0) {
      const file = join(dir, "commits.bundle");
      const ok = await git.createBundle(input.repo, file, [revRange]);
      if (ok) {
        record.bundle = { file, commits: commits.length, revRange };
      } else {
        input.logger?.warn(`archive: could not bundle ${revRange} for ${input.branch}`);
      }
    }
  }

  // 2. Uncommitted tracked changes.
  if (input.worktreePath) {
    const diff = await git.diffAgainstHead(input.worktreePath);
    if (diff) {
      const file = join(dir, "uncommitted.patch");
      await writeFile(file, diff);
      record.patch = { file, bytes: Buffer.byteLength(diff) };
    }

    // 3. Untracked (but not ignored) files.
    const untracked = await git.untrackedFiles(input.worktreePath);
    if (untracked.length > 0) {
      record.untracked = await saveUntracked(
        input.worktreePath, untracked, dir, input.config, input.logger,
      );
    }
  }

  await writeFile(join(dir, META), JSON.stringify(record, null, 2) + "\n");
  await writeFile(join(dir, "RESTORE.md"), restoreDoc(record));
  input.logger?.debug(`archive: wrote ${dir}`);
  return record;
}

async function saveUntracked(
  worktree: string,
  files: string[],
  dir: string,
  cfg: ArchiveConfig,
  logger?: Logger,
): Promise<ArchiveRecord["untracked"]> {
  let bytes = 0;
  for (const f of files) {
    try {
      const st = await stat(join(worktree, f));
      bytes += st.size;
    } catch {
      /* raced away */
    }
    if (bytes > cfg.maxUntrackedBytes) break;
  }

  const listFile = join(dir, "untracked.txt");
  await writeFile(listFile, files.join("\n") + "\n");

  if (bytes > cfg.maxUntrackedBytes) {
    logger?.warn(
      `archive: ${files.length} untracked files total ${formatBytes(bytes)}, over the ` +
      `${formatBytes(cfg.maxUntrackedBytes)} limit — saved the file list only`,
    );
    return { count: files.length, bytes, file: listFile, truncated: true };
  }

  const tarball = join(dir, "untracked.tar.gz");
  const r = await run("tar", ["-czf", tarball, "-C", worktree, "-T", listFile], {
    timeoutMs: 300_000,
  });
  if (r.code !== 0) {
    logger?.warn(`archive: tar failed (${(r.stderr || "").trim().split("\n")[0] ?? ""}) — kept the list`);
    return { count: files.length, bytes, file: listFile, truncated: true };
  }
  return { count: files.length, bytes, file: tarball, truncated: false };
}

function prOf(merge: MergeStatus): ArchiveRecord["pr"] {
  if ("pr" in merge && merge.pr) {
    return { number: merge.pr.number, url: merge.pr.url, state: merge.pr.state };
  }
  return null;
}

function restoreDoc(r: ArchiveRecord): string {
  const lines: string[] = [
    `# Archive: ${r.branch ?? "(detached)"}`,
    "",
    `Removed from \`${r.worktree ?? r.repo}\` on ${r.createdAt}.`,
    `Reason: ${r.reason}.`,
    r.risks.length > 0 ? `Flagged: ${r.risks.join(", ")}.` : "Nothing unique was at risk.",
    "",
    "## Restore",
    "",
    "```bash",
    `cd ${r.repo}`,
  ];

  if (r.bundle) {
    lines.push(
      `# ${r.bundle.commits} commit(s) that were not on the default branch`,
      `git fetch ${r.bundle.file} '*:*'`,
      `git branch ${r.branch ?? "restored"} ${r.head ?? "FETCH_HEAD"}`,
    );
  } else {
    lines.push(`# all commits were already on the default branch`, `git branch ${r.branch ?? "restored"} ${r.head ?? ""}`);
  }

  lines.push(`git worktree add ../${basename(r.worktree ?? r.repo)} ${r.branch ?? "restored"}`);

  if (r.patch) {
    lines.push("", "# uncommitted changes", `git apply ${r.patch.file}`);
  }
  if (r.untracked && !r.untracked.truncated && r.untracked.file) {
    lines.push("", "# untracked files", `tar -xzf ${r.untracked.file} -C .`);
  } else if (r.untracked) {
    lines.push("", `# ${r.untracked.count} untracked files were too large to copy; see untracked.txt`);
  }

  lines.push("```", "");
  return lines.join("\n");
}

export async function listArchives(dir: string): Promise<ArchiveRecord[]> {
  const out: ArchiveRecord[] = [];
  let repoDirs;
  try {
    repoDirs = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const repoDir of repoDirs) {
    if (!repoDir.isDirectory()) continue;
    let entries;
    try {
      entries = await readdir(join(dir, repoDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const metaPath = join(dir, repoDir.name, e.name, META);
      try {
        const parsed: unknown = JSON.parse(await readFile(metaPath, "utf8"));
        if (parsed && typeof parsed === "object") out.push(parsed as ArchiveRecord);
      } catch {
        /* an archive without readable metadata is not listed */
      }
    }
  }
  out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return out;
}

export interface PruneResult {
  removed: string[];
  freedKb: number;
}

/** Delete archives older than the retention window. */
export async function pruneArchives(
  dir: string,
  retentionMs: number,
  now = Date.now(),
): Promise<PruneResult> {
  const result: PruneResult = { removed: [], freedKb: 0 };
  for (const record of await listArchives(dir)) {
    const age = now - Date.parse(record.createdAt);
    if (!Number.isFinite(age) || age < retentionMs) continue;
    const kb = (await dirSizeKb(record.dir)) ?? 0;
    try {
      await rm(record.dir, { recursive: true, force: true });
      result.removed.push(record.id);
      result.freedKb += kb;
    } catch {
      /* leave it for next time */
    }
  }
  return result;
}
