import { applyPlan } from "../core/apply.js";
import { buildPlan } from "../core/plan.js";
import { renderApply, renderPlan } from "../core/render.js";
import { color } from "../util/color.js";
import { formatKb } from "../util/bytes.js";
import { confirm } from "../util/prompt.js";
import { acquireLock } from "../daemon/lock.js";
import { recordSweep } from "../daemon/state.js";
import type { CliFlags } from "./context.js";
import { createContext, resolveRepos } from "./context.js";

export async function gcCommand(positionals: string[], flags: CliFlags): Promise<number> {
  const ctx = await createContext(flags);
  const repos = await resolveRepos(ctx, positionals, flags);

  if (repos.length === 0) {
    if (flags.json) {
      process.stdout.write(JSON.stringify({ version: 1, repos: [], error: "no git repos found" }) + "\n");
    } else {
      process.stderr.write(
        `no git repos found. Looked in ${ctx.config.roots.join(", ")}.\n` +
        `Set "roots" in your config, pass a path, or run from inside a repo.\n`,
      );
    }
    return 1;
  }

  const plan = await buildPlan({
    config: ctx.config,
    repos,
    forge: ctx.forge,
    logger: ctx.logger,
    force: flags.force,
    allSizes: flags.sizes,
    skipWorktrees: flags.branchesOnly,
  });

  if (!flags.apply) {
    if (flags.json) {
      process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    } else {
      const text = renderPlan(plan, { verbose: flags.verbose, quiet: flags.quiet });
      process.stdout.write(text + "\n");
      if (plan.summary.worktreesReclaimable > 0 || plan.summary.branchesDeletable > 0) {
        process.stdout.write(color.gray("re-run with --apply to do it\n"));
      }
    }
    return 0;
  }

  const nothingToDo =
    plan.summary.worktreesReclaimable === 0 && plan.summary.branchesDeletable === 0;

  if (!nothingToDo && !flags.yes) {
    if (!flags.json) {
      process.stdout.write(renderPlan(plan, { verbose: flags.verbose }) + "\n\n");
    }
    const ok = await confirm(
      `Remove ${plan.summary.worktreesReclaimable} worktree(s) (${formatKb(plan.summary.reclaimKb)}) ` +
      `and ${plan.summary.branchesDeletable} branch(es)?`,
      false,
    );
    if (!ok) {
      process.stderr.write("aborted — nothing was removed\n");
      return 130;
    }
  }

  // One sweep at a time per machine: a scheduled sweep and a manual one must
  // never race over the same worktree.
  const lock = await acquireLock();
  if (!lock) {
    const message = "another treekeeper sweep is already running";
    if (flags.json) process.stdout.write(JSON.stringify({ error: message }) + "\n");
    else process.stderr.write(message + "\n");
    return 75;
  }

  const startedAt = Date.now();
  let result;
  try {
    result = await applyPlan({
      plan,
      config: ctx.config,
      logger: ctx.logger,
      force: flags.force,
    });
  } finally {
    await lock.release();
  }

  await recordSweep({
    at: startedAt,
    durationMs: Date.now() - startedAt,
    repos: plan.summary.repos,
    worktrees: result.removedWorktrees.length,
    branches: result.deletedBranches.length,
    reclaimedKb: result.reclaimedKb,
    failures: result.failures.length,
  });

  if (flags.json) {
    process.stdout.write(JSON.stringify({ plan, result }, null, 2) + "\n");
  } else {
    process.stdout.write(renderApply(result, plan) + "\n");
  }
  return result.failures.some((f) => f.stage === "archive") ? 1 : 0;
}
