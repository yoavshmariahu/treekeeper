import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { have, run } from "../util/exec.js";
import type { Logger } from "../util/log.js";
import { treekeeperHome } from "../util/paths.js";
import { redactRemote } from "../util/redact.js";
import { parseDuration } from "../util/time.js";
import { originUrl } from "./git.js";

export type PrState = "OPEN" | "MERGED" | "CLOSED";

export interface PrRef {
  number: number;
  state: PrState;
  headRefName: string;
  headRefOid: string;
  mergedAt: number | null;
  closedAt: number | null;
  url: string;
  title: string;
}

/** Pull requests for a repo, keyed by head branch name. */
export type PrIndex = Map<string, PrRef[]>;

export interface Forge {
  readonly kind: string;
  /**
   * `null` means "no information available" (no remote, no CLI, offline) which
   * callers must treat as "unknown", never as "no PR exists".
   */
  lookup(repo: string): Promise<PrIndex | null>;
  readonly unavailableReason: string | null;
}

export interface ForgeOptions {
  kind: "github" | "none";
  cacheTtl: string;
  logger?: Logger;
  /** Ignore cached answers (used by `--refresh`). */
  refresh?: boolean;
  limit?: number;
}

export function createForge(opts: ForgeOptions): Forge {
  if (opts.kind === "none") return new NullForge("disabled by config");
  return new GitHubForge(opts);
}

class NullForge implements Forge {
  readonly kind = "none";
  readonly unavailableReason: string | null;
  constructor(reason: string | null) {
    this.unavailableReason = reason;
  }
  async lookup(): Promise<PrIndex | null> {
    return null;
  }
}

interface CacheFile {
  version: 1;
  fetchedAt: number;
  remote: string;
  prs: PrRef[];
}

class GitHubForge implements Forge {
  readonly kind = "github";
  unavailableReason: string | null = null;
  private readonly ttlMs: number;
  private readonly memo = new Map<string, PrIndex | null>();
  private ghChecked = false;

  constructor(private readonly opts: ForgeOptions) {
    this.ttlMs = parseDuration(opts.cacheTtl);
  }

  async lookup(repo: string): Promise<PrIndex | null> {
    if (this.memo.has(repo)) return this.memo.get(repo)!;
    const result = await this.fetch(repo);
    this.memo.set(repo, result);
    return result;
  }

  private async fetch(repo: string): Promise<PrIndex | null> {
    const remote = await originUrl(repo);
    if (!remote) {
      this.opts.logger?.debug(`forge: ${repo} has no origin remote`);
      return null;
    }
    if (!isGitHubRemote(remote)) {
      this.opts.logger?.debug(`forge: ${redactRemote(remote)} is not a github remote`);
      return null;
    }

    const cachePath = join(treekeeperHome(), "cache", `gh-${hash(remote)}.json`);
    if (!this.opts.refresh) {
      const cached = await readCache(cachePath);
      if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
        this.opts.logger?.debug(`forge: cache hit for ${redactRemote(remote)}`);
        return index(cached.prs);
      }
    }

    if (!this.ghChecked) {
      this.ghChecked = true;
      if (!(await have("gh"))) {
        this.unavailableReason =
          "the GitHub CLI (gh) is not installed, so squash-merged branches cannot be detected";
        this.opts.logger?.warn(this.unavailableReason);
      }
    }
    if (this.unavailableReason) {
      const cached = await readCache(cachePath);
      return cached ? index(cached.prs) : null;
    }

    const r = await run(
      "gh",
      [
        "pr", "list",
        "--repo", remote,
        "--state", "all",
        "--limit", String(this.opts.limit ?? 300),
        "--json", "number,state,headRefName,headRefOid,mergedAt,closedAt,url,title",
      ],
      { timeoutMs: 60_000 },
    );

    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout).trim().split("\n")[0] ?? "unknown error";
      this.opts.logger?.warn(`forge: gh pr list failed for ${redactRemote(remote)}: ${detail}`);
      // Stale data beats no data: ancestry alone misses squash merges, and a
      // missing PR record can only ever make treekeeper *more* conservative.
      const cached = await readCache(cachePath);
      return cached ? index(cached.prs) : null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      this.opts.logger?.warn(`forge: could not parse gh output for ${redactRemote(remote)}`);
      return null;
    }
    if (!Array.isArray(parsed)) return null;

    const prs = parsed.flatMap((item) => (isPrLike(item) ? [toPrRef(item)] : []));
    await writeCache(cachePath, { version: 1, fetchedAt: Date.now(), remote: redactRemote(remote), prs });
    this.opts.logger?.debug(`forge: fetched ${prs.length} PRs for ${redactRemote(remote)}`);
    return index(prs);
  }
}

function index(prs: PrRef[]): PrIndex {
  const map: PrIndex = new Map();
  for (const pr of prs) {
    const list = map.get(pr.headRefName);
    if (list) list.push(pr);
    else map.set(pr.headRefName, [pr]);
  }
  for (const list of map.values()) list.sort((a, b) => b.number - a.number);
  return map;
}

/**
 * Pick the PR that decides a branch's fate. A branch name can be reused across
 * several PRs, so prefer a merged PR whose head sha still matches the local tip,
 * then any merged PR, then the newest.
 */
export function selectPr(prs: readonly PrRef[] | undefined, localTip: string | null): PrRef | null {
  if (!prs || prs.length === 0) return null;
  if (localTip) {
    const exact = prs.find((p) => p.headRefOid === localTip && p.state === "MERGED");
    if (exact) return exact;
  }
  const merged = prs.find((p) => p.state === "MERGED");
  if (merged) return merged;
  const open = prs.find((p) => p.state === "OPEN");
  if (open) return open;
  return prs[0] ?? null;
}

function isGitHubRemote(remote: string): boolean {
  return /github\.com/i.test(remote) || /^git@github\.com/i.test(remote);
}

function hash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

async function readCache(path: string): Promise<CacheFile | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      parsed !== null && typeof parsed === "object" &&
      (parsed as CacheFile).version === 1 && Array.isArray((parsed as CacheFile).prs)
    ) {
      return parsed as CacheFile;
    }
  } catch {
    /* no usable cache */
  }
  return null;
}

async function writeCache(path: string, data: CacheFile): Promise<void> {
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(data));
  } catch {
    /* a cache that cannot be written is not an error */
  }
}

function isPrLike(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && typeof (v as Record<string, unknown>)["number"] === "number";
}

function toPrRef(item: Record<string, unknown>): PrRef {
  const stateRaw = String(item["state"] ?? "").toUpperCase();
  const state: PrState = stateRaw === "MERGED" || stateRaw === "CLOSED" ? stateRaw : "OPEN";
  return {
    number: Number(item["number"]),
    state,
    headRefName: String(item["headRefName"] ?? ""),
    headRefOid: String(item["headRefOid"] ?? ""),
    mergedAt: toEpoch(item["mergedAt"]),
    closedAt: toEpoch(item["closedAt"]),
    url: String(item["url"] ?? ""),
    title: String(item["title"] ?? ""),
  };
}

function toEpoch(v: unknown): number | null {
  if (typeof v !== "string" || v === "") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
