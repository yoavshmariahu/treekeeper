import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { globalConfigPath, loadConfig } from "../core/config.js";
import { discoverRepos } from "../core/scan.js";
import { daemonStatus } from "../daemon/service.js";
import { gitVersion } from "../core/git.js";
import { have, runOk } from "../util/exec.js";
import { color } from "../util/color.js";
import { Logger } from "../util/log.js";
import { shortenPath } from "../util/paths.js";

interface Check {
  name: string;
  ok: boolean | "warn";
  detail: string;
}

/** Check that everything treekeeper depends on is actually present. */
export async function doctorCommand(json: boolean): Promise<number> {
  const checks: Check[] = [];
  const { config, warnings, sources } = await loadConfig();

  const git = await gitVersion();
  checks.push({
    name: "git",
    ok: git !== null,
    detail: git ?? "not found on PATH — treekeeper cannot do anything without it",
  });

  const gh = await have("gh");
  if (config.forge === "github") {
    if (!gh) {
      checks.push({
        name: "gh",
        ok: "warn",
        detail: "not installed — squash-merged branches will not be detected (brew install gh)",
      });
    } else {
      const auth = await runOk("gh", ["auth", "status"], { timeoutMs: 20_000 });
      checks.push({
        name: "gh",
        ok: auth !== null ? true : "warn",
        detail: auth !== null ? "installed and authenticated" : "installed but not logged in (gh auth login)",
      });
    }
  } else {
    checks.push({ name: "gh", ok: true, detail: "forge is disabled in config" });
  }

  const lsof = await have("lsof");
  checks.push({
    name: "lsof",
    ok: lsof ? true : "warn",
    detail: lsof
      ? "available — can tell when a process is still in a worktree"
      : "missing — the 'process' session detector will be skipped",
  });

  checks.push({
    name: "config",
    ok: warnings.length === 0,
    detail: sources.length > 0
      ? `${shortenPath(sources[0]!)}${warnings.length > 0 ? ` — ${warnings.length} warning(s)` : ""}`
      : `using defaults (no file at ${shortenPath(globalConfigPath())})`,
  });

  const repos = await discoverRepos({
    roots: config.roots,
    maxDepth: config.maxDepth,
    protectPaths: config.protectPaths,
    logger: new Logger({ level: "error" }),
  });
  checks.push({
    name: "roots",
    ok: repos.length > 0 ? true : "warn",
    detail: `${repos.length} repo(s) under ${config.roots.map(shortenPath).join(", ")}`,
  });

  for (const detector of config.sessions.detectors) {
    if (detector === "claude-code") {
      const dir = join(homedir(), ".claude", "projects");
      const present = await exists(dir);
      checks.push({
        name: "detector claude-code",
        ok: true,
        detail: present ? `reading ${shortenPath(dir)}` : "no Claude Code sessions on this machine",
      });
    } else if (detector === "codex") {
      const dir = join(homedir(), ".codex", "sessions");
      const present = await exists(dir);
      checks.push({
        name: "detector codex",
        ok: true,
        detail: present ? `reading ${shortenPath(dir)}` : "no Codex sessions on this machine",
      });
    }
  }

  const daemon = await daemonStatus();
  checks.push({
    name: "daemon",
    ok: daemon.installed ? (daemon.active ? true : "warn") : "warn",
    detail: daemon.installed
      ? daemon.active ? "installed and scheduled" : "installed but not loaded (treekeeper daemon start)"
      : "not installed (treekeeper daemon install)",
  });

  if (json) {
    process.stdout.write(JSON.stringify({ checks, warnings }, null, 2) + "\n");
    return checks.some((c) => c.ok === false) ? 1 : 0;
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const mark = c.ok === true ? color.green("ok  ") : c.ok === "warn" ? color.yellow("warn") : color.red("fail");
    process.stdout.write(`${mark}  ${c.name.padEnd(width)}  ${color.gray(c.detail)}\n`);
  }
  for (const w of warnings) process.stdout.write(color.yellow(`warn  config: ${w}\n`));

  return checks.some((c) => c.ok === false) ? 1 : 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
