import { run, runLines, runOk } from "../util/exec.js";
import { dirname, resolve } from "node:path";

export interface Worktree {
  path: string;
  /** Short branch name, or null when detached/bare. */
  branch: string | null;
  head: string | null;
  isMain: boolean;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
}

export interface LocalBranch {
  name: string;
  head: string;
  upstream: string | null;
}

const GIT_TIMEOUT = 30_000;

async function git(cwd: string, args: string[]): Promise<string | null> {
  return runOk("git", ["-C", cwd, ...args], { timeoutMs: GIT_TIMEOUT });
}

/** Top-level directory of the worktree containing `dir`, or null. */
export async function repoToplevel(dir: string): Promise<string | null> {
  const out = await git(dir, ["rev-parse", "--show-toplevel"]);
  return out ? resolve(out) : null;
}

/**
 * The *main* worktree of the repo containing `dir`. Given a linked worktree this
 * returns the original clone, which is where worktree and branch operations have
 * to run.
 */
export async function mainRepoPath(dir: string): Promise<string | null> {
  const common = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) return null;
  const abs = resolve(common);
  // ".../repo/.git" -> ".../repo"; a bare repo's common dir is the repo itself.
  const base = abs.endsWith("/.git") || abs.endsWith("\\.git") ? dirname(abs) : abs;
  return base;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const out = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return out === "true";
}

/** Parse `git worktree list --porcelain`. The first record is the main worktree. */
export function parseWorktreeList(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  let current: Worktree | null = null;

  const push = () => {
    if (current) out.push(current);
  };

  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      push();
      current = {
        path: resolve(line.slice("worktree ".length)),
        branch: null,
        head: null,
        isMain: out.length === 0,
        detached: false,
        bare: false,
        locked: false,
        lockReason: null,
        prunable: false,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "").trim();
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
      const reason = line.slice("locked".length).trim();
      current.lockReason = reason === "" ? null : reason;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  push();
  return out;
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  return out === null ? [] : parseWorktreeList(out);
}

export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
}

/** origin/HEAD if known, else the first of main/master/trunk that exists. */
export async function defaultBranch(repo: string): Promise<string> {
  const symref = await git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (symref) return symref.replace(/^refs\/remotes\/origin\//, "");

  const remoteShow = await git(repo, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (remoteShow && remoteShow !== "origin/HEAD") return remoteShow.replace(/^origin\//, "");

  for (const candidate of ["main", "master", "trunk"]) {
    if (await refExists(repo, `refs/heads/${candidate}`)) return candidate;
  }
  const head = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return head && head !== "HEAD" ? head : "main";
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  const r = await run("git", ["-C", repo, "show-ref", "--verify", "--quiet", ref], {
    timeoutMs: GIT_TIMEOUT,
  });
  return r.code === 0;
}

export async function revParse(repo: string, ref: string): Promise<string | null> {
  return git(repo, ["rev-parse", "--verify", "--quiet", ref]);
}

export async function originUrl(repo: string): Promise<string | null> {
  return git(repo, ["remote", "get-url", "origin"]);
}

export async function isAncestor(repo: string, maybeAncestor: string, descendant: string): Promise<boolean> {
  const r = await run(
    "git",
    ["-C", repo, "merge-base", "--is-ancestor", maybeAncestor, descendant],
    { timeoutMs: GIT_TIMEOUT },
  );
  return r.code === 0;
}

/** Commits on `branch` that are not reachable from `base`. */
export async function commitsNotIn(repo: string, base: string, branch: string): Promise<string[]> {
  return runLines("git", ["-C", repo, "rev-list", `${base}..${branch}`], { timeoutMs: GIT_TIMEOUT });
}

export async function localBranches(repo: string): Promise<LocalBranch[]> {
  const lines = await runLines(
    "git",
    ["-C", repo, "for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(upstream:short)", "refs/heads/"],
    { timeoutMs: GIT_TIMEOUT },
  );
  const out: LocalBranch[] = [];
  for (const line of lines) {
    const [name, head, upstream] = line.split("\t");
    if (!name || !head) continue;
    out.push({ name, head, upstream: upstream && upstream !== "" ? upstream : null });
  }
  return out;
}

export interface DirtyState {
  dirty: boolean;
  /** Up to a few entries, for the explanation shown to the user. */
  sample: string[];
  count: number;
}

/** Uncommitted changes, including untracked files but not ignored ones. */
export async function dirtyState(worktreePath: string): Promise<DirtyState> {
  const out = await git(worktreePath, ["status", "--porcelain", "--untracked-files=normal"]);
  if (out === null) return { dirty: false, sample: [], count: 0 };
  const lines = out.split("\n").filter((l) => l.trim() !== "");
  return { dirty: lines.length > 0, sample: lines.slice(0, 5), count: lines.length };
}

export async function untrackedFiles(worktreePath: string): Promise<string[]> {
  return runLines(
    "git",
    ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"],
    { timeoutMs: GIT_TIMEOUT },
  );
}

/** Seconds-precision commit time of a ref, as epoch ms. */
export async function commitTime(repo: string, ref: string): Promise<number | null> {
  const out = await git(repo, ["log", "-1", "--format=%ct", ref]);
  if (!out) return null;
  const n = Number(out);
  return Number.isFinite(n) ? n * 1000 : null;
}

export interface RemoveResult {
  ok: boolean;
  method: "git" | "none";
  error?: string;
}

export async function removeWorktree(
  repo: string,
  worktreePath: string,
  force: boolean,
): Promise<RemoveResult> {
  const args = ["-C", repo, "worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);
  const r = await run("git", args, { timeoutMs: 120_000 });
  if (r.code === 0) return { ok: true, method: "git" };
  return { ok: false, method: "none", error: (r.stderr || r.stdout).trim() };
}

export async function deleteBranch(repo: string, branch: string, force = true): Promise<boolean> {
  const r = await run("git", ["-C", repo, "branch", force ? "-D" : "-d", branch], {
    timeoutMs: GIT_TIMEOUT,
  });
  return r.code === 0;
}

export async function remotePrune(repo: string, remote = "origin"): Promise<boolean> {
  const r = await run("git", ["-C", repo, "remote", "prune", remote], { timeoutMs: 60_000 });
  return r.code === 0;
}

export async function createBundle(
  repo: string,
  destFile: string,
  revs: string[],
): Promise<boolean> {
  if (revs.length === 0) return false;
  const r = await run("git", ["-C", repo, "bundle", "create", destFile, ...revs], {
    timeoutMs: 180_000,
  });
  return r.code === 0;
}

/** `git diff HEAD --binary` for a worktree, or null when there is nothing to save. */
export async function diffAgainstHead(worktreePath: string): Promise<string | null> {
  const r = await run("git", ["-C", worktreePath, "diff", "HEAD", "--binary"], {
    timeoutMs: 120_000,
  });
  if (r.code !== 0) return null;
  return r.stdout.trim() === "" ? null : r.stdout;
}

export async function gitVersion(): Promise<string | null> {
  const out = await runOk("git", ["--version"], { timeoutMs: 10_000 });
  return out ? out.replace(/^git version\s*/, "") : null;
}
