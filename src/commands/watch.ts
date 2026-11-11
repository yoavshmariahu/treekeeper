import { color } from "../util/color.js";
import { formatDuration, parseDuration } from "../util/time.js";
import { loadConfig } from "../core/config.js";
import type { CliFlags } from "./context.js";
import { gcCommand } from "./gc.js";

/**
 * Foreground watcher, for people who would rather supervise treekeeper
 * themselves (tmux, pm2, Docker) than install a launchd/systemd unit.
 *
 * Config is re-read every pass, so editing config.json takes effect without a
 * restart.
 */
export async function watchCommand(flags: CliFlags): Promise<number> {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const { config } = await loadConfig();
  const firstInterval = parseDuration(flags.interval ?? config.interval);
  process.stderr.write(
    `${color.bold("treekeeper")} watching ${config.roots.join(", ")} every ${formatDuration(firstInterval)}\n` +
    color.gray("ctrl-c to stop\n"),
  );

  while (!stopping) {
    await gcCommand([], { ...flags, all: true, apply: true, yes: true });
    if (stopping) break;

    const { config: fresh } = await loadConfig();
    const intervalMs = parseDuration(flags.interval ?? fresh.interval);
    // Wake up often enough to notice a signal promptly.
    const deadline = Date.now() + intervalMs;
    while (!stopping && Date.now() < deadline) {
      await sleep(Math.min(1_000, deadline - Date.now()));
    }
  }

  process.stderr.write("stopped\n");
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
