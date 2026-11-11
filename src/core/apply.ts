import { stat } from "node:fs/promises";
import type { Config } from "./config.js";
import { loadRepoConfig } from "./config.js";
import type { ArchiveRecord } from "./archive.js";
import { archiveWork, pruneArchives } from "./archive.js";
import * as git from "./git.js";
import type { BranchCandidate, Plan, WorktreeCandidate } from "./plan.js";
import type { Logger } from "../util/log.js";
import { parseDuration } from "../util/time.js";

export interface ApplyOptions {
  plan: Plan;
  config: Config;
  logger: Logger;
  force?: boolean;
  /** Skip the just-in-time safety re-check (only for tests). */
  skipReverify?: boolean;
}

export interface Removal {
  path: string;
  branch: string | null;
  repo: string;
  sizeKb: number;
  reason: string;
  archive: string | null;
}

export interface Failure {
  target: string;
  stage: "reverify" | "archive" | "remove" | "branch";
  message: string;
}

export interface ApplyResult {
  removedWorktrees: Removal[];
  deletedBranches: Array<{ repo: string; name: string; reason: string; archive: string | null }>;
  reclaimedKb: number;
  archives: ArchiveRecord[];
  failures: Failure[];
  prunedArchives: string[];
}

/**
 * Carry out a plan.
 *
 * Each worktree is re-checked immediately before removal, because a plan is a
 * snapshot: with a daemon, minutes can pass between deciding and acting, and in
 * that time an agent may have started working in the directory again.
 */
export async function applyPlan(opts: ApplyOptions): Promise<ApplyResult> {
  const { plan, logger } = opts;
  const result: ApplyResult = {
    removedWorktrees: [],
    deletedBranches: [],
    reclaimedKb: 0,
    archives: [],
    failures: [],
    prunedArchives: [],
  };

  for (const repoPlan of plan.repos) {
    if (repoPlan.skipped) continue;
    const { config: cfg } = await loadRepoConfig(repoPlan.repo, opts.config);
    const base = await preferredBase(repoPlan.repo, repoPlan.defaultBranch);

    for (const candidate of repoPlan.worktrees) {
      if (candidate.verdict.action !== "reclaim") continue;
      await removeWorktree(candidate, { cfg, base, result, logger, opts });
    }

    for (const branch of repoPlan.branches) {
      await deleteBranch(branch, { cfg, base, result, logger });
    }

    await git.pruneWorktrees(repoPlan.repo);
    if (cfg.pruneRemotes) await git.remotePrune(repoPlan.repo);
  }

  if (opts.config.archive.enabled) {
    const pruned = await pruneArchives(
      opts.config.archive.dir,
      parseDuration(opts.config.archive.retention),
      plan.now,
    );
    result.prunedArchives = pruned.removed;
    if (pruned.removed.length > 0) {
      logger.event("archive-pruned", { count: pruned.removed.length, freedKb: pruned.freedKb });
    }
  }

  return result;
}

interface StepCtx {
  cfg: Config;
  base: string | null;
  result: ApplyResult;
  logger: Logger;
  opts?: ApplyOptions;
}

async function removeWorktree(c: WorktreeCandidate, ctx: StepCtx): Promise<void> {
  const { logger, result } = ctx;

  if (!(ctx.opts?.skipReverify ?? false)) {
    const problem = await reverify(c);
    if (problem) {
      logger.warn(`skipping ${c.path}: ${problem}`);
      logger.event("skip", { path: c.path, branch: c.branch, stage: "reverify", reason: problem });
      result.failures.push({ target: c.path, stage: "reverify", message: problem });
      return;
    }
  }

  let archive: ArchiveRecord | null = null;
  try {
    archive = await archiveWork({
      repo: c.repo,
      worktreePath: c.path,
      branch: c.branch,
      head: c.head,
      reason: c.verdict.reason,
      risks: c.verdict.risks,
      merge: c.merge,
      base: ctx.base,
      config: ctx.cfg.archive,
      logger,
    });
  } catch (err) {
    const message = (err as Error).message;
    // Never remove work we failed to back up.
    logger.error(`archive failed for ${c.path}, keeping it: ${message}`);
    result.failures.push({ target: c.path, stage: "archive", message });
    return;
  }
  if (archive) result.archives.push(archive);

  const archived = archive !== null;
  let removal = await git.removeWorktree(c.repo, c.path, false);
  if (!removal.ok && (archived || ctx.opts?.force)) {
    removal = await git.removeWorktree(c.repo, c.path, true);
  }

  if (!removal.ok) {
    const message = removal.error ?? "git worktree remove failed";
    logger.error(`could not remove ${c.path}: ${message}`);
    result.failures.push({ target: c.path, stage: "remove", message });
    return;
  }

  const sizeKb = c.sizeKb ?? 0;
  result.removedWorktrees.push({
    path: c.path,
    branch: c.branch,
    repo: c.repo,
    sizeKb,
    reason: c.verdict.reason,
    archive: archive?.dir ?? null,
  });
  result.reclaimedKb += sizeKb;
  logger.event("reclaim", {
    path: c.path,
    repo: c.repo,
    branch: c.branch,
    sizeKb,
    reason: c.verdict.reason,
    risks: c.verdict.risks,
    archive: archive?.dir ?? null,
  });

  if (c.branch) {
    const ok = await git.deleteBranch(c.repo, c.branch, true);
    if (ok) {
      result.deletedBranches.push({
        repo: c.repo,
        name: c.branch,
        reason: c.verdict.reason,
        archive: archive?.dir ?? null,
      });
    } else {
      logger.warn(`removed ${c.path} but could not delete branch ${c.branch}`);
      result.failures.push({
        target: `${c.repo}#${c.branch}`,
        stage: "branch",
        message: "git branch -D failed",
      });
    }
  }
}

async function deleteBranch(b: BranchCandidate, ctx: StepCtx): Promise<void> {
  const { logger, result } = ctx;

  // The tip may have moved since the plan was built.
  const tip = await git.revParse(b.repo, `refs/heads/${b.name}`);
  if (tip !== b.head) {
    const message = "branch tip moved since the plan was built";
    logger.warn(`skipping branch ${b.name}: ${message}`);
    result.failures.push({ target: `${b.repo}#${b.name}`, stage: "reverify", message });
    return;
  }

  let archive: ArchiveRecord | null = null;
  if (b.verdict.risks.length > 0) {
    archive = await archiveWork({
      repo: b.repo,
      worktreePath: null,
      branch: b.name,
      head: b.head,
      reason: b.verdict.reason,
      risks: b.verdict.risks,
      merge: b.merge,
      base: ctx.base,
      config: ctx.cfg.archive,
      logger,
    });
    if (archive) result.archives.push(archive);
  }

  if (await git.deleteBranch(b.repo, b.name, true)) {
    result.deletedBranches.push({
      repo: b.repo,
      name: b.name,
      reason: b.verdict.reason,
      archive: archive?.dir ?? null,
    });
    logger.event("branch-delete", {
      repo: b.repo,
      branch: b.name,
      reason: b.verdict.reason,
      archive: archive?.dir ?? null,
    });
  } else {
    result.failures.push({
      target: `${b.repo}#${b.name}`,
      stage: "branch",
      message: "git branch -D failed",
    });
  }
}

/**
 * Confirm the worktree is still exactly what the plan described. Anything that
 * moved — a new commit, a switched branch, a fresh file — means the snapshot is
 * stale and the worktree is left alone until the next sweep.
 */
async function reverify(c: WorktreeCandidate): Promise<string | null> {
  try {
    const st = await stat(c.path);
    if (!st.isDirectory()) return "no longer a directory";
    if (st.mtimeMs > c.lastTouched + 1_000) return "directory changed since the plan was built";
  } catch {
    return "directory no longer exists";
  }

  const worktrees = await git.listWorktrees(c.repo);
  const current = worktrees.find((w) => w.path === c.path);
  if (!current) return "no longer a registered worktree";
  if (current.branch !== c.branch) return `branch changed to ${current.branch ?? "(detached)"}`;
  if (current.head !== c.head) return "new commits since the plan was built";
  if (current.locked) return "worktree was locked";

  if (!c.dirty) {
    const dirty = await git.dirtyState(c.path);
    if (dirty.dirty) return "uncommitted changes appeared since the plan was built";
  }
  return null;
}

async function preferredBase(repo: string, defaultBranch: string): Promise<string | null> {
  for (const ref of [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`]) {
    if (await git.refExists(repo, ref)) return ref;
  }
  return null;
}
