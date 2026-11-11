import { buildPlan } from "../core/plan.js";
import { renderPlan } from "../core/render.js";
import { listArchives } from "../core/archive.js";
import { discoverRepos } from "../core/scan.js";
import { daemonStatus } from "../daemon/service.js";
import { formatKb } from "../util/bytes.js";
import { color } from "../util/color.js";
import { shortenPath } from "../util/paths.js";
import { formatAgo } from "../util/time.js";
import type { CliFlags } from "./context.js";
import { createContext } from "./context.js";

/** A whole-machine overview: what is reclaimable, and is the daemon running. */
export async function statusCommand(flags: CliFlags): Promise<number> {
  const ctx = await createContext({ ...flags, quiet: true });
  const repos = await discoverRepos({
    roots: ctx.config.roots,
    maxDepth: ctx.config.maxDepth,
    protectPaths: ctx.config.protectPaths,
    logger: ctx.logger,
  });

  const plan = await buildPlan({
    config: ctx.config,
    repos,
    forge: ctx.forge,
    logger: ctx.logger,
  });

  const service = await daemonStatus();
  const archives = await listArchives(ctx.config.archive.dir);

  if (flags.json) {
    process.stdout.write(
      JSON.stringify({ plan, daemon: service, archives: archives.length }, null, 2) + "\n",
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push(
    `${color.bold("treekeeper")}  ` +
    color.gray(`${plan.summary.repos} repos · ${plan.summary.worktreesScanned} worktrees · roots ${ctx.config.roots.map(shortenPath).join(", ")}`),
  );
  lines.push(
    service.installed
      ? `daemon     ${service.active ? color.green("scheduled") : color.yellow("installed, not loaded")}` +
        color.gray(`  every ${ctx.config.interval}`)
      : `daemon     ${color.gray("not installed")}  ${color.gray("run `treekeeper daemon install`")}`,
  );
  if (service.lastSweep) {
    lines.push(`last sweep ${formatAgo(service.lastSweep.at)}  ` + color.gray(
      `reclaimed ${formatKb(service.lastSweep.reclaimedKb)} from ${service.lastSweep.worktrees} worktree(s)`,
    ));
  }
  if (archives.length > 0) {
    const newest = archives[0]!;
    lines.push(
      `archives   ${archives.length} kept in ${shortenPath(ctx.config.archive.dir)}  ` +
      color.gray(`newest ${formatAgo(Date.parse(newest.createdAt))}, retention ${ctx.config.archive.retention}`),
    );
  }
  lines.push("");
  lines.push(renderPlan(plan, { verbose: flags.verbose }));

  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}
