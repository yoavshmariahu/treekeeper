import { stat, statfs } from "node:fs/promises";
import type { Config } from "./config.js";
import type { Forge } from "./forge.js";
import type { Plan } from "./plan.js";
import { buildPlan } from "./plan.js";
import { discoverRepos } from "./scan.js";
import { dirSizeKb } from "./size.js";
import type { Logger } from "../util/log.js";

/**
 * What is on disk right now: the volumes behind the configured roots, and per
 * repo the linked worktrees, their size, and what a sweep could take.
 *
 * This only ever plans. It never applies a plan, removes, archives or prunes.
 */

export interface VolumeUsage {
  /** The configured roots that live on this volume. */
  roots: string[];
  totalKb: number;
  usedKb: number;
  /** Space available to an unprivileged user. */
  freeKb: number;
}

export interface RepoUsage {
  repo: string;
  name: string;
  /** Linked worktrees. The repo's main checkout is not one of them. */
  worktrees: number;
  /** Disk the linked worktrees occupy, summed over those that could be measured. */
  sizeKb: number;
  /** Linked worktrees whose size could not be measured. */
  unmeasured: number;
  reclaimableWorktrees: number;
  reclaimableKb: number;
  /** Branches a sweep would prune on their own, beyond those that go with a worktree. */
  branchesDeletable: number;
}

export interface UsageTotals {
  repos: number;
  worktrees: number;
  sizeKb: number;
  unmeasured: number;
  reclaimableWorktrees: number;
  reclaimableKb: number;
  branchesDeletable: number;
}

export interface UsageReport {
  version: 1;
  generatedAt: string;
  /** How long the measurement took. */
  durationMs: number;
  roots: string[];
  volumes: VolumeUsage[];
  /** Largest on disk first. Repos the plan skipped are in `skipped` instead. */
  repos: RepoUsage[];
  totals: UsageTotals;
  skipped: Array<{ repo: string; name: string; reason: string }>;
  warnings: string[];
}

/** The two filesystem probes `readVolumes` needs, injectable for tests. */
export interface VolumeProbe {
  stat(path: string): Promise<{ dev: number }>;
  statfs(path: string): Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;
}

const realProbe: VolumeProbe = { stat: (p) => stat(p), statfs: (p) => statfs(p) };

/**
 * Total / used / free for each volume that holds a root. Roots on the same
 * volume are reported once, together; a root that cannot be read is left out.
 */
export async function readVolumes(
  roots: readonly string[],
  probe: VolumeProbe = realProbe,
): Promise<VolumeUsage[]> {
  const byDevice = new Map<number, VolumeUsage>();
  for (const root of roots) {
    try {
      const { dev } = await probe.stat(root);
      const seen = byDevice.get(dev);
      if (seen) {
        if (!seen.roots.includes(root)) seen.roots.push(root);
        continue;
      }
      const fs = await probe.statfs(root);
      const kb = (blocks: number): number => Math.round((blocks * fs.bsize) / 1024);
      byDevice.set(dev, {
        roots: [root],
        totalKb: kb(fs.blocks),
        usedKb: kb(Math.max(0, fs.blocks - fs.bfree)),
        freeKb: kb(fs.bavail),
      });
    } catch {
      /* a root that does not exist yet has no volume to report */
    }
  }
  return [...byDevice.values()];
}

/**
 * Per-repo and overall usage from a plan. Pure.
 *
 * `sizes` supplies the size of worktrees the plan did not measure (a plan only
 * measures what it would reclaim); a path missing from both counts as unmeasured.
 */
export function summarizeUsage(
  plan: Plan,
  sizes: ReadonlyMap<string, number | null> = new Map(),
): Pick<UsageReport, "repos" | "totals" | "skipped"> {
  const repos: RepoUsage[] = [];
  const skipped: UsageReport["skipped"] = [];
  const totals: UsageTotals = {
    repos: 0, worktrees: 0, sizeKb: 0, unmeasured: 0,
    reclaimableWorktrees: 0, reclaimableKb: 0, branchesDeletable: 0,
  };

  for (const r of plan.repos) {
    if (r.skipped !== null) {
      skipped.push({ repo: r.repo, name: r.name, reason: r.skipped });
      continue;
    }
    const row: RepoUsage = {
      repo: r.repo, name: r.name, worktrees: 0, sizeKb: 0, unmeasured: 0,
      reclaimableWorktrees: 0, reclaimableKb: 0, branchesDeletable: r.branches.length,
    };
    for (const w of r.worktrees) {
      // The main checkout is the repo itself, and often the directory that
      // holds the linked worktrees; counting it would count them twice.
      if (w.verdict.code === "main-worktree") continue;
      const sizeKb = w.sizeKb ?? sizes.get(w.path) ?? null;
      row.worktrees += 1;
      if (sizeKb === null) row.unmeasured += 1;
      else row.sizeKb += sizeKb;
      if (w.verdict.action === "reclaim") {
        row.reclaimableWorktrees += 1;
        row.reclaimableKb += sizeKb ?? 0;
      }
    }
    repos.push(row);
    totals.repos += 1;
    totals.worktrees += row.worktrees;
    totals.sizeKb += row.sizeKb;
    totals.unmeasured += row.unmeasured;
    totals.reclaimableWorktrees += row.reclaimableWorktrees;
    totals.reclaimableKb += row.reclaimableKb;
    totals.branchesDeletable += row.branchesDeletable;
  }

  repos.sort(
    (a, b) =>
      b.sizeKb - a.sizeKb ||
      b.worktrees - a.worktrees ||
      b.branchesDeletable - a.branchesDeletable ||
      a.name.localeCompare(b.name) ||
      a.repo.localeCompare(b.repo),
  );
  return { repos, totals, skipped };
}

export interface UsageOptions {
  config: Config;
  forge: Forge;
  logger?: Logger;
  /** Checked between steps; an aborted measurement rejects. */
  signal?: AbortSignal;
  /** How a worktree is measured. Default `du -sk`. */
  measure?: (path: string) => Promise<number | null>;
  /** How many worktrees are measured at once. Default 4. */
  concurrency?: number;
}

/**
 * Plan every repo under the configured roots, measure every linked worktree,
 * and read the volumes. Slow (`gh` per repo, `du` per worktree), so callers
 * cache the result.
 */
export async function buildUsageReport(opts: UsageOptions): Promise<UsageReport> {
  const started = Date.now();
  const { config, signal } = opts;
  const measure = opts.measure ?? dirSizeKb;

  const repos = await discoverRepos({
    roots: config.roots,
    maxDepth: config.maxDepth,
    protectPaths: config.protectPaths,
    logger: opts.logger,
  });
  signal?.throwIfAborted();

  const plan = await buildPlan({ config, repos, forge: opts.forge, logger: opts.logger });
  signal?.throwIfAborted();

  // The plan measured what it would reclaim. Measure the other linked
  // worktrees here rather than with `allSizes`, which would also run `du` over
  // every main checkout — slow, and not a number this report shows.
  const pending: string[] = [];
  for (const r of plan.repos) {
    for (const w of r.worktrees) {
      if (w.verdict.code !== "main-worktree" && w.sizeKb === null) pending.push(w.path);
    }
  }
  const sizes = new Map<string, number | null>();
  const workers = Math.max(1, Math.min(opts.concurrency ?? 4, pending.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < pending.length) {
        signal?.throwIfAborted();
        const path = pending[next]!;
        next += 1;
        sizes.set(path, await measure(path));
      }
    }),
  );
  signal?.throwIfAborted();

  const volumes = await readVolumes(config.roots);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    roots: [...config.roots],
    volumes,
    ...summarizeUsage(plan, sizes),
    warnings: [...plan.warnings],
  };
}
