/**
 * Programmatic entry point, for harnesses that would rather call treekeeper
 * in-process than shell out to the CLI.
 *
 *   import { loadConfig, createForge, discoverRepos, buildPlan, applyPlan } from "treekeeper";
 */
export { loadConfig, loadRepoConfig, defaultConfig, globalConfigPath } from "./core/config.js";
export type { Config, SessionConfig, ArchiveConfig, DirtyPolicy } from "./core/config.js";

export { buildPlan, policyFromConfig, reclaimable, mergeStatus } from "./core/plan.js";
export type {
  Plan, PlanOptions, PlanSummary, RepoPlan, WorktreeCandidate, BranchCandidate,
} from "./core/plan.js";

export { decideWorktree, decideBranch } from "./core/decide.js";
export type {
  Verdict, Policy, WorktreeFacts, BranchFacts, MergeStatus, Risk,
} from "./core/decide.js";

export { applyPlan } from "./core/apply.js";
export type { ApplyOptions, ApplyResult, Removal, Failure } from "./core/apply.js";

export { archiveWork, listArchives, pruneArchives } from "./core/archive.js";
export type { ArchiveRecord } from "./core/archive.js";

export { createForge, selectPr } from "./core/forge.js";
export type { Forge, PrRef, PrIndex, PrState } from "./core/forge.js";

export { discoverRepos, reposFromPaths } from "./core/scan.js";
export { createActivityContext, detectActivity, isActive } from "./core/sessions.js";
export type { ActivityContext, ActivityHit } from "./core/sessions.js";

export { renderPlan, renderApply, summaryLine } from "./core/render.js";
export { Logger } from "./util/log.js";
export { parseDuration, formatDuration } from "./util/time.js";
export { main as cli } from "./cli.js";
