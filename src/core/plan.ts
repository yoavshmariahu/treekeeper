import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Config } from "./config.js";
import { loadRepoConfig } from "./config.js";
import type { BranchFacts, MergeStatus, Policy, Verdict, WorktreeFacts } from "./decide.js";
import { decideBranch, decideWorktree } from "./decide.js";
import type { Forge, PrIndex } from "./forge.js";
import { selectPr } from "./forge.js";
import * as git from "./git.js";
import type { Worktree } from "./git.js";
import { dirSizeKb } from "./size.js";
import type { ActivityContext, ActivityHit } from "./sessions.js";
import { createActivityContext, detectActivity, isActive } from "./sessions.js";
import type { Logger } from "../util/log.js";
import { isInside, matchGlob } from "../util/paths.js";
import { parseDuration } from "../util/time.js";

export interface WorktreeCandidate {
  repo: string;
  repoName: string;
  path: string;
  branch: string | null;
  head: string | null;
  sizeKb: number | null;
  verdict: Verdict;
  merge: MergeStatus;
  activity: ActivityHit | null;
  lastTouched: number;
  dirty: boolean;
  dirtyCount: number;
}

export interface BranchCandidate {
  repo: string;
  repoName: string;
  name: string;
  head: string;
  verdict: Verdict;
  merge: MergeStatus;
}

export interface RepoPlan {
  repo: string;
  name: string;
  defaultBranch: string;
  forgeAvailable: boolean;
  worktrees: WorktreeCandidate[];
  branches: BranchCandidate[];
  /** Set when the repo was skipped entirely (opted out, unreadable). */
  skipped: string | null;
}

export interface PlanSummary {
  repos: number;
  worktreesScanned: number;
  worktreesReclaimable: number;
  worktreesKept: number;
  branchesDeletable: number;
  reclaimKb: number;
}

export interface Plan {
  version: 1;
  generatedAt: string;
  now: number;
  roots: string[];
  repos: RepoPlan[];
  summary: PlanSummary;
  warnings: string[];
}

export interface PlanOptions {
  config: Config;
  repos: string[];
  forge: Forge;
  logger?: Logger;
  now?: number;
  cwd?: string;
  force?: boolean;
  /** Measure every worktree, not just the ones being reclaimed. */
  allSizes?: boolean;
  /** Plan branch deletions only, leaving every worktree in place. */
  skipWorktrees?: boolean;
}

export function policyFromConfig(cfg: Config, force = false): Policy {
  return {
    minAgeMs: parseDuration(cfg.minAge),
    closedPrGraceMs: parseDuration(cfg.closedPrGrace),
    onDirty: cfg.onDirty,
    onClosedPr: cfg.onClosedPr,
    onExtraCommits: cfg.onExtraCommits,
    force,
  };
}

export async function buildPlan(opts: PlanOptions): Promise<Plan> {
  const now = opts.now ?? Date.now();
  const cwd = opts.cwd ?? process.cwd();
  const warnings: string[] = [];
  const activity = await createActivityContext(opts.config, opts.logger, now);
  const repos: RepoPlan[] = [];

  for (const repo of opts.repos) {
    const repoPlan = await planRepo(repo, { ...opts, now, cwd }, activity, warnings);
    repos.push(repoPlan);
  }

  if (opts.forge.unavailableReason) warnings.push(opts.forge.unavailableReason);

  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    now,
    roots: opts.config.roots,
    repos,
    summary: summarize(repos),
    warnings,
  };
}

async function planRepo(
  repo: string,
  opts: PlanOptions & { now: number; cwd: string },
  activity: ActivityContext,
  warnings: string[],
): Promise<RepoPlan> {
  const name = basename(repo);
  const { config: cfg, warnings: cfgWarnings } = await loadRepoConfig(repo, opts.config);
  for (const w of cfgWarnings) warnings.push(w);

  const empty: RepoPlan = {
    repo, name, defaultBranch: "", forgeAvailable: false,
    worktrees: [], branches: [], skipped: null,
  };

  if (!cfg.enabled) return { ...empty, skipped: "disabled in .treekeeper.json" };

  const policy = policyFromConfig(cfg, opts.force ?? false);
  const defaultBranch = await git.defaultBranch(repo);
  const prIndex = await opts.forge.lookup(repo);
  const bases = await resolveBases(repo, defaultBranch);

  const worktrees = await git.listWorktrees(repo);
  if (worktrees.length === 0) {
    return { ...empty, defaultBranch, skipped: "not a readable git repo" };
  }

  const wtCandidates: WorktreeCandidate[] = [];
  for (const wt of worktrees) {
    if (wt.bare) continue;
    if (opts.skipWorktrees) {
      wtCandidates.push(skippedWorktree(repo, name, wt));
      continue;
    }
    wtCandidates.push(
      await planWorktree(repo, name, wt, {
        cfg, policy, bases, prIndex, activity, now: opts.now, cwd: opts.cwd,
        allSizes: opts.allSizes ?? false, logger: opts.logger,
      }),
    );
  }

  const branches = cfg.pruneBranches
    ? await planBranches(repo, name, {
        cfg, policy, bases, prIndex, defaultBranch, worktrees, wtCandidates, now: opts.now,
      })
    : [];

  return {
    repo,
    name,
    defaultBranch,
    forgeAvailable: prIndex !== null,
    worktrees: wtCandidates,
    branches,
    skipped: null,
  };
}

function skippedWorktree(repo: string, repoName: string, wt: Worktree): WorktreeCandidate {
  return {
    repo,
    repoName,
    path: wt.path,
    branch: wt.branch,
    head: wt.head,
    sizeKb: null,
    verdict: wt.isMain
      ? { action: "keep", reason: "the repo's main worktree", code: "main-worktree", risks: [] }
      : { action: "keep", reason: "worktrees not considered (--branches-only)", code: "branches-only", risks: [] },
    merge: { kind: "no-branch" },
    activity: null,
    lastTouched: 0,
    dirty: false,
    dirtyCount: 0,
  };
}

interface WorktreeCtx {
  cfg: Config;
  policy: Policy;
  bases: string[];
  prIndex: PrIndex | null;
  activity: ActivityContext;
  now: number;
  cwd: string;
  allSizes: boolean;
  logger?: Logger;
}

async function planWorktree(
  repo: string,
  repoName: string,
  wt: Worktree,
  ctx: WorktreeCtx,
): Promise<WorktreeCandidate> {
  const merge = wt.isMain || wt.detached || !wt.branch
    ? ({ kind: "no-branch" } as MergeStatus)
    : await mergeStatus(repo, wt.branch, wt.head, ctx.bases, ctx.prIndex);

  // Only pay for the expensive probes when the worktree could actually go.
  const cheapKeep = wt.isMain || isProtectedPath(ctx.cfg, wt.path) || wt.locked;
  const finished = isFinished(merge);

  let dirty = false;
  let dirtyCount = 0;
  let hit: ActivityHit | null = null;
  let lastTouched = 0;

  if (!cheapKeep) {
    try {
      const st = await stat(wt.path);
      lastTouched = st.mtimeMs;
    } catch {
      lastTouched = 0;
    }
    if (finished) {
      const d = await git.dirtyState(wt.path);
      dirty = d.dirty;
      dirtyCount = d.count;
      hit = await detectActivity(ctx.activity, wt.path);
      if (hit) lastTouched = Math.max(lastTouched, hit.lastActivity);
    }
  }

  const facts: WorktreeFacts = {
    now: ctx.now,
    isMain: wt.isMain,
    detached: wt.detached,
    locked: wt.locked,
    lockReason: wt.lockReason,
    branch: wt.branch,
    protectedBranch: wt.branch !== null && isProtectedBranch(ctx.cfg, wt.branch),
    protectedPath: isProtectedPath(ctx.cfg, wt.path),
    isCwd: isInside(wt.path, ctx.cwd),
    merge,
    dirty,
    dirtyCount,
    activity: hit,
    activityIsRecent: isActive(ctx.activity, hit),
    lastTouched,
    inUse:
      hit?.detector === "process" ||
      (ctx.activity.processCwds?.some((p) => isInside(wt.path, p)) ?? false),
  };

  const verdict = decideWorktree(facts, ctx.policy);
  const sizeKb =
    verdict.action === "reclaim" || ctx.allSizes ? await dirSizeKb(wt.path) : null;

  return {
    repo,
    repoName,
    path: wt.path,
    branch: wt.branch,
    head: wt.head,
    sizeKb,
    verdict,
    merge,
    activity: hit,
    lastTouched,
    dirty,
    dirtyCount,
  };
}

interface BranchCtx {
  cfg: Config;
  policy: Policy;
  bases: string[];
  prIndex: PrIndex | null;
  defaultBranch: string;
  worktrees: Worktree[];
  wtCandidates: WorktreeCandidate[];
  now: number;
}

async function planBranches(
  repo: string,
  repoName: string,
  ctx: BranchCtx,
): Promise<BranchCandidate[]> {
  // Branches whose worktree survives this sweep must survive with it. Branches
  // whose worktree is being reclaimed are deleted as part of that removal, so
  // they are not listed here twice.
  const keptByWorktree = new Set<string>();
  const removedWithWorktree = new Set<string>();
  for (const c of ctx.wtCandidates) {
    if (!c.branch) continue;
    if (c.verdict.action === "reclaim") removedWithWorktree.add(c.branch);
    else keptByWorktree.add(c.branch);
  }

  const mainWt = ctx.worktrees.find((w) => w.isMain);
  const currentBranch = mainWt?.branch ?? null;

  const out: BranchCandidate[] = [];
  for (const branch of await git.localBranches(repo)) {
    if (removedWithWorktree.has(branch.name)) continue;
    const merge = await mergeStatus(repo, branch.name, branch.head, ctx.bases, ctx.prIndex);
    const facts: BranchFacts = {
      now: ctx.now,
      name: branch.name,
      isDefault: branch.name === ctx.defaultBranch,
      protectedBranch: isProtectedBranch(ctx.cfg, branch.name),
      hasWorktree: keptByWorktree.has(branch.name),
      isCurrent: branch.name === currentBranch,
      merge,
      lastCommit: null,
    };
    const verdict = decideBranch(facts, ctx.policy);
    if (verdict.action === "reclaim") {
      out.push({ repo, repoName, name: branch.name, head: branch.head, verdict, merge });
    }
  }
  return out;
}

/** Candidate base refs for ancestry checks, remote first. */
async function resolveBases(repo: string, defaultBranch: string): Promise<string[]> {
  const bases: string[] = [];
  for (const ref of [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`]) {
    if (await git.refExists(repo, ref)) bases.push(ref);
  }
  return bases;
}

export async function mergeStatus(
  repo: string,
  branch: string,
  tip: string | null,
  bases: string[],
  prIndex: PrIndex | null,
): Promise<MergeStatus> {
  const head = tip ?? (await git.revParse(repo, `refs/heads/${branch}`));
  if (!head) return { kind: "unmerged", forgeAvailable: prIndex !== null };

  for (const base of bases) {
    if (await git.isAncestor(repo, head, base)) {
      return { kind: "merged-ancestor", base: base.replace(/^refs\/(remotes|heads)\//, "") };
    }
  }

  const pr = selectPr(prIndex?.get(branch), head);
  if (!pr) return { kind: "unmerged", forgeAvailable: prIndex !== null };

  if (pr.state === "MERGED") {
    if (pr.headRefOid === head) return { kind: "merged-pr", pr };
    const base = bases[0];
    const extra = base ? (await git.commitsNotIn(repo, base, branch)).length : 0;
    return extra > 0 ? { kind: "merged-pr-extra", pr, extra } : { kind: "merged-pr", pr };
  }
  if (pr.state === "CLOSED") return { kind: "closed-pr", pr };
  return { kind: "open-pr", pr };
}

function isFinished(merge: MergeStatus): boolean {
  return (
    merge.kind === "merged-ancestor" ||
    merge.kind === "merged-pr" ||
    merge.kind === "merged-pr-extra" ||
    merge.kind === "closed-pr"
  );
}

export function isProtectedBranch(cfg: Config, branch: string): boolean {
  return cfg.protectBranches.some((p) => (p.includes("*") || p.includes("?") ? matchGlob(p, branch) : p === branch));
}

export function isProtectedPath(cfg: Config, path: string): boolean {
  return cfg.protectPaths.some((p) =>
    p.includes("*") || p.includes("?") ? matchGlob(p, path) : isInside(p, path),
  );
}

function summarize(repos: RepoPlan[]): PlanSummary {
  let worktreesScanned = 0;
  let worktreesReclaimable = 0;
  let worktreesKept = 0;
  let branchesDeletable = 0;
  let reclaimKb = 0;

  for (const r of repos) {
    for (const w of r.worktrees) {
      if (w.verdict.code === "main-worktree") continue;
      worktreesScanned += 1;
      if (w.verdict.action === "reclaim") {
        worktreesReclaimable += 1;
        reclaimKb += w.sizeKb ?? 0;
      } else {
        worktreesKept += 1;
      }
    }
    branchesDeletable += r.branches.length;
  }

  return {
    repos: repos.filter((r) => r.skipped === null).length,
    worktreesScanned,
    worktreesReclaimable,
    worktreesKept,
    branchesDeletable,
    reclaimKb,
  };
}

/** Every worktree the plan would remove, flattened. */
export function reclaimable(plan: Plan): WorktreeCandidate[] {
  return plan.repos.flatMap((r) => r.worktrees.filter((w) => w.verdict.action === "reclaim"));
}
