import type { Config } from "../core/config.js";
import { loadConfig } from "../core/config.js";
import type { Forge } from "../core/forge.js";
import { createForge } from "../core/forge.js";
import { discoverRepos, reposFromPaths } from "../core/scan.js";
import { Logger } from "../util/log.js";
import { expandPath } from "../util/paths.js";

export interface CliFlags {
  apply?: boolean;
  yes?: boolean;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  all?: boolean;
  force?: boolean;
  minAge?: string;
  sessionGrace?: string;
  forge?: string;
  refresh?: boolean;
  branchesOnly?: boolean;
  worktreesOnly?: boolean;
  sizes?: boolean;
  interval?: string;
  config?: string;
  roots?: string[];
}

export interface Context {
  config: Config;
  logger: Logger;
  forge: Forge;
  warnings: string[];
  configSources: string[];
}

/** Load config, apply CLI overrides, and build the shared logger and forge. */
export async function createContext(flags: CliFlags): Promise<Context> {
  const loaded = await loadConfig(flags.config ? expandPath(flags.config) : undefined);
  const config = loaded.config;

  if (flags.minAge !== undefined) config.minAge = flags.minAge;
  if (flags.sessionGrace !== undefined) config.sessions.grace = flags.sessionGrace;
  if (flags.forge === "none" || flags.forge === "github") config.forge = flags.forge;
  if (flags.worktreesOnly) config.pruneBranches = false;
  if (flags.roots && flags.roots.length > 0) config.roots = flags.roots.map((r) => expandPath(r));
  if (flags.verbose) config.logLevel = "debug";

  const logger = new Logger({
    level: config.logLevel,
    file: config.logFile,
    quiet: flags.quiet === true,
  });

  for (const w of loaded.warnings) logger.warn(w);

  const forge = createForge({
    kind: config.forge,
    cacheTtl: config.forgeCacheTtl,
    logger,
    refresh: flags.refresh === true,
  });

  return { config, logger, forge, warnings: loaded.warnings, configSources: loaded.sources };
}

/** Which repos a command should operate on, from positionals, `--all`, or cwd. */
export async function resolveRepos(
  ctx: Context,
  positionals: string[],
  flags: CliFlags,
): Promise<string[]> {
  const scan = { maxDepth: ctx.config.maxDepth, protectPaths: ctx.config.protectPaths, logger: ctx.logger };

  if (positionals.length > 0) {
    return reposFromPaths(positionals.map((p) => expandPath(p)), scan);
  }
  if (flags.all) {
    return discoverRepos({ ...scan, roots: ctx.config.roots });
  }
  // Default to the repo containing the cwd, falling back to the configured
  // roots when the cwd is not inside one (e.g. the daemon, started from "/").
  const here = await reposFromPaths([process.cwd()], { ...scan, maxDepth: 1 });
  if (here.length > 0) return here;
  return discoverRepos({ ...scan, roots: ctx.config.roots });
}
