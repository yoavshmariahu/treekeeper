import type { DirtyPolicy } from "./config.js";
import type { PrRef } from "./forge.js";
import { formatAgo, formatDuration } from "../util/time.js";

/** How the work on a branch relates to the default branch and its pull request. */
export type MergeStatus =
  | { kind: "merged-ancestor"; base: string }
  | { kind: "merged-pr"; pr: PrRef }
  | { kind: "merged-pr-extra"; pr: PrRef; extra: number }
  | { kind: "closed-pr"; pr: PrRef }
  | { kind: "open-pr"; pr: PrRef }
  | { kind: "unmerged"; forgeAvailable: boolean }
  | { kind: "no-branch" };

export type Risk = "dirty" | "closed-pr" | "extra-commits";

export interface Verdict {
  action: "reclaim" | "keep";
  /** Human sentence shown in the plan and written to the log. */
  reason: string;
  /** Stable identifier for scripts reading `--json`. */
  code: string;
  /** Why this removal needs an archive first. Empty when the work is safely merged. */
  risks: Risk[];
}

export interface Policy {
  minAgeMs: number;
  closedPrGraceMs: number;
  onDirty: DirtyPolicy;
  onClosedPr: DirtyPolicy;
  onExtraCommits: DirtyPolicy;
  /** Bypasses the age gate and the dirty / extra-commits / closed-PR holds. */
  force: boolean;
}

export interface WorktreeFacts {
  now: number;
  isMain: boolean;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  branch: string | null;
  protectedBranch: boolean;
  protectedPath: boolean;
  /** The worktree contains the caller's working directory. */
  isCwd: boolean;
  merge: MergeStatus;
  dirty: boolean;
  dirtyCount: number;
  /** Most recent agent/human activity, or null when nothing was detected. */
  activity: { detector: string; lastActivity: number; detail: string } | null;
  activityIsRecent: boolean;
  /** Newest mtime seen for this worktree, used for the age gate. */
  lastTouched: number;
  inUse: boolean;
}

const keep = (code: string, reason: string): Verdict => ({ action: "keep", reason, code, risks: [] });

/**
 * Decide the fate of one worktree.
 *
 * Pure on purpose: every signal is gathered elsewhere, so the rules that decide
 * whether a developer's directory gets deleted are a single readable function
 * with a truth table in the tests.
 *
 * Invariant: a worktree is only ever reclaimed when its commits are reachable
 * from the default branch, or its pull request was merged or closed. `force`
 * does not relax that.
 */
export function decideWorktree(f: WorktreeFacts, policy: Policy): Verdict {
  if (f.isMain) return keep("main-worktree", "the repo's main worktree");
  if (f.protectedPath) return keep("protected-path", "matches protectPaths");
  if (f.isCwd) return keep("cwd", "your current working directory");
  if (f.locked) {
    return keep("locked", `locked${f.lockReason ? `: ${f.lockReason}` : ""}`);
  }
  if (f.detached || !f.branch) return keep("detached", "detached HEAD — no branch to check");
  if (f.protectedBranch) return keep("protected-branch", `${f.branch} matches protectBranches`);

  const risks: Risk[] = [];
  let mergedReason: string;

  switch (f.merge.kind) {
    case "merged-ancestor":
      mergedReason = `merged into ${f.merge.base}`;
      break;
    case "merged-pr":
      mergedReason = `PR #${f.merge.pr.number} merged`;
      break;
    case "merged-pr-extra": {
      const n = f.merge.extra;
      const detail = `PR #${f.merge.pr.number} merged, but the local branch has ${n} commit${n === 1 ? "" : "s"} the PR never had`;
      if (policy.onExtraCommits === "keep" && !policy.force) {
        return keep("extra-commits", detail);
      }
      risks.push("extra-commits");
      mergedReason = detail;
      break;
    }
    case "closed-pr": {
      const detail = `PR #${f.merge.pr.number} closed without merging`;
      if (policy.onClosedPr === "keep" && !policy.force) {
        return keep("closed-pr", `${detail} — onClosedPr is "keep"`);
      }
      const closedAt = f.merge.pr.closedAt;
      if (!policy.force && closedAt !== null) {
        const waited = f.now - closedAt;
        if (waited < policy.closedPrGraceMs) {
          return keep(
            "closed-pr-grace",
            `${detail} ${formatAgo(closedAt, f.now)} — holding for ${formatDuration(policy.closedPrGraceMs - waited)} more`,
          );
        }
      }
      risks.push("closed-pr");
      mergedReason = detail;
      break;
    }
    case "open-pr":
      return keep("open-pr", `PR #${f.merge.pr.number} is still open`);
    case "unmerged":
      return keep(
        "unmerged",
        f.merge.forgeAvailable
          ? "not merged and has no merged pull request"
          : "not merged (no pull-request data available)",
      );
    case "no-branch":
      return keep("no-branch", "no branch to check");
  }

  // Work is finished. Now the "is anyone still using it" gates.
  // A live process is checked first because it is the least ambiguous signal
  // and deserves the clearest message.
  if (f.inUse) {
    return keep("in-use", `${mergedReason}, but a running process is still in it`);
  }
  if (f.activityIsRecent && f.activity) {
    return keep(
      "session-active",
      `${mergedReason}, but ${f.activity.detector} activity ${formatAgo(f.activity.lastActivity, f.now)}`,
    );
  }

  if (!policy.force) {
    // Clamped: file mtimes carry sub-millisecond fractions while Date.now()
    // truncates, so a worktree touched this instant can otherwise look like it
    // was touched in the future.
    const age = Math.max(0, f.now - f.lastTouched);
    if (age < policy.minAgeMs) {
      return keep(
        "too-young",
        `${mergedReason}, but touched ${formatAgo(f.lastTouched, f.now)} (minAge ${formatDuration(policy.minAgeMs)})`,
      );
    }
  }

  if (f.dirty) {
    if (policy.onDirty === "keep" && !policy.force) {
      return keep(
        "dirty",
        `${mergedReason}, but has ${f.dirtyCount} uncommitted change${f.dirtyCount === 1 ? "" : "s"}`,
      );
    }
    risks.push("dirty");
  }

  return {
    action: "reclaim",
    reason: mergedReason,
    code: f.merge.kind,
    risks,
  };
}

export interface BranchFacts {
  now: number;
  name: string;
  isDefault: boolean;
  protectedBranch: boolean;
  /** A worktree still has this branch checked out. */
  hasWorktree: boolean;
  /** This branch is the current HEAD of the main worktree. */
  isCurrent: boolean;
  merge: MergeStatus;
  lastCommit: number | null;
}

/**
 * Decide whether a local branch with no worktree should be deleted.
 *
 * Deleting a branch only drops a pointer, so this is cheaper to get wrong than
 * a worktree — but it can still orphan commits, so unmerged branches are never
 * touched and closed-PR branches get archived like worktrees do.
 */
export function decideBranch(f: BranchFacts, policy: Policy): Verdict {
  if (f.isDefault) return keep("default-branch", "the default branch");
  if (f.isCurrent) return keep("current-branch", "currently checked out");
  if (f.protectedBranch) return keep("protected-branch", "matches protectBranches");
  if (f.hasWorktree) return keep("has-worktree", "still checked out in a worktree");

  switch (f.merge.kind) {
    case "merged-ancestor":
      return { action: "reclaim", reason: `merged into ${f.merge.base}`, code: f.merge.kind, risks: [] };
    case "merged-pr":
      return { action: "reclaim", reason: `PR #${f.merge.pr.number} merged`, code: f.merge.kind, risks: [] };
    case "merged-pr-extra": {
      const detail = `PR #${f.merge.pr.number} merged, local tip has ${f.merge.extra} extra commit(s)`;
      if (policy.onExtraCommits === "keep" && !policy.force) return keep("extra-commits", detail);
      return { action: "reclaim", reason: detail, code: f.merge.kind, risks: ["extra-commits"] };
    }
    case "closed-pr": {
      const detail = `PR #${f.merge.pr.number} closed without merging`;
      if (policy.onClosedPr === "keep" && !policy.force) return keep("closed-pr", detail);
      const closedAt = f.merge.pr.closedAt;
      if (!policy.force && closedAt !== null && f.now - closedAt < policy.closedPrGraceMs) {
        return keep("closed-pr-grace", `${detail} ${formatAgo(closedAt, f.now)} — still in the grace window`);
      }
      return { action: "reclaim", reason: detail, code: f.merge.kind, risks: ["closed-pr"] };
    }
    case "open-pr":
      return keep("open-pr", `PR #${f.merge.pr.number} is still open`);
    case "unmerged":
      return keep("unmerged", "not merged");
    case "no-branch":
      return keep("no-branch", "no branch");
  }
}
