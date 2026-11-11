import { readFile } from "node:fs/promises";
import { loadConfig } from "../core/config.js";
import {
  daemonStatus, installDaemon, setDaemonRunning, sweepArgv, uninstallDaemon,
} from "../daemon/service.js";
import { formatKb } from "../util/bytes.js";
import { color } from "../util/color.js";
import { shortenPath } from "../util/paths.js";
import { formatAgo, formatDuration } from "../util/time.js";
import type { CliFlags } from "./context.js";

const USAGE = `usage: treekeeper daemon <install|uninstall|start|stop|status|logs>`;

export async function daemonCommand(args: string[], flags: CliFlags): Promise<number> {
  const sub = args[0] ?? "status";

  switch (sub) {
    case "install": {
      const { config } = await loadConfig();
      const interval = flags.interval ?? config.interval;
      const result = await installDaemon(interval);
      for (const m of result.messages) {
        process.stdout.write((result.ok ? "" : color.yellow("warn ")) + m + "\n");
      }
      if (result.ok) {
        process.stdout.write(
          color.gray(`it runs: ${sweepArgv().slice(1).join(" ")}\n`) +
          color.gray("change the interval in config.json, then re-run `treekeeper daemon install`\n"),
        );
      }
      return result.ok ? 0 : 1;
    }
    case "uninstall": {
      const result = await uninstallDaemon();
      for (const m of result.messages) process.stdout.write(m + "\n");
      return result.ok ? 0 : 1;
    }
    case "start":
    case "stop": {
      const result = await setDaemonRunning(sub === "start");
      for (const m of result.messages) process.stdout.write(m + "\n");
      return result.ok ? 0 : 1;
    }
    case "status": {
      const status = await daemonStatus();
      if (flags.json) {
        process.stdout.write(JSON.stringify(status, null, 2) + "\n");
        return 0;
      }
      const lines = [
        `manager   ${status.manager}`,
        `installed ${status.installed ? color.green("yes") : color.gray("no")}` +
          (status.unitPath ? color.gray(`  ${shortenPath(status.unitPath)}`) : ""),
        `scheduled ${status.active ? color.green("yes") : color.gray("no")}` +
          (status.intervalSeconds ? color.gray(`  every ${formatDuration(status.intervalSeconds * 1000)}`) : ""),
      ];
      if (status.lastSweep) {
        const s = status.lastSweep;
        lines.push(
          `last run  ${formatAgo(s.at)}` +
            color.gray(`  ${s.worktrees} worktree(s), ${s.branches} branch(es), ${formatKb(s.reclaimedKb)} in ${formatDuration(s.durationMs)}`),
        );
      } else {
        lines.push(`last run  ${color.gray("never")}`);
      }
      lines.push(`logs      ${shortenPath(status.logFile)}`);
      process.stdout.write(lines.join("\n") + "\n");
      return 0;
    }
    case "logs": {
      const status = await daemonStatus();
      try {
        const text = await readFile(status.logFile, "utf8");
        const lines = text.split("\n");
        process.stdout.write(lines.slice(-200).join("\n"));
      } catch {
        process.stderr.write(`no daemon log yet at ${status.logFile}\n`);
        return 1;
      }
      return 0;
    }
    default:
      process.stderr.write(USAGE + "\n");
      return 2;
  }
}
