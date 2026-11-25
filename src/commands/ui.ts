import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { RemovalEvent } from "../core/history.js";
import { buildHistoryReport, readRemovalEvents } from "../core/history.js";
import { buildUsageReport } from "../core/usage.js";
import { daemonStatus } from "../daemon/service.js";
import { readState } from "../daemon/state.js";
import type { UiDaemonInfo } from "../ui/server.js";
import { UI_HOST, createUiServer, listenLocal } from "../ui/server.js";
import { color } from "../util/color.js";
import type { CliFlags } from "./context.js";
import { createContext } from "./context.js";

/** Seams for driving the command in-process; the CLI passes none of them. */
export interface UiCommandDeps {
  /** Stops the server when aborted, exactly as SIGINT and SIGTERM do. */
  signal?: AbortSignal;
  /** Called with the dashboard URL once the server is listening. */
  onListening?: (url: string) => void;
  /** Replaces launching the system browser. */
  openBrowser?: (url: string) => void;
}

/**
 * A local, read-only dashboard: what treekeeper has removed, what is on disk
 * now, and whether the daemon is running. `--json` prints the removal history
 * and exits without starting a server.
 *
 * Nothing here removes, archives or prunes, and the logger is built without a
 * log file, so looking at the history never adds to it.
 */
export async function uiCommand(flags: CliFlags, deps: UiCommandDeps = {}): Promise<number> {
  const port = parsePort(flags.port);
  if (port === null) {
    process.stderr.write(`--port must be a whole number from 0 to 65535, got "${flags.port}".\n`);
    return 2;
  }

  const context = (): ReturnType<typeof createContext> =>
    createContext({ ...flags, quiet: true }, { logToFile: false });
  const { config } = await context();
  const logFile = config.logFile;

  if (flags.json) {
    const now = Date.now();
    const report = buildHistoryReport(await readRemovalEvents(logFile), {
      now,
      range: "all",
      utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  const stopping = new AbortController();
  const server = createUiServer({
    readEvents: memoizedEvents(logFile),
    readDaemon,
    // A fresh context per measurement: config edits take effect, and the forge
    // (which remembers every lookup for its lifetime) is not reused.
    measureUsage: async () => {
      const ctx = await context();
      return buildUsageReport({
        config: ctx.config,
        forge: ctx.forge,
        logger: ctx.logger,
        signal: stopping.signal,
      });
    },
    logFile,
  });

  let bound: number;
  try {
    bound = await listenLocal(server, port);
  } catch (err) {
    process.stderr.write(`could not listen on ${UI_HOST}:${port}: ${(err as Error).message}\n`);
    return 1;
  }

  const url = `http://${UI_HOST}:${bound}/`;
  process.stdout.write(`${color.bold("treekeeper ui")}  ${url}\n`);
  process.stderr.write(color.gray("local and read-only · ctrl-c to stop\n"));
  deps.onListening?.(url);
  if (!flags.noOpen) (deps.openBrowser ?? openInBrowser)(url);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      deps.signal?.removeEventListener("abort", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    deps.signal?.addEventListener("abort", stop);
    if (deps.signal?.aborted) stop();
  });

  // Give up on a measurement in flight, then drop every connection: a browser
  // tab holds its keep-alive socket open far longer than anyone waits on ctrl-c.
  stopping.abort();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  process.stderr.write("stopped\n");
  return 0;
}

/** `undefined` means "let the OS pick" (0); null means the value is not a port. */
function parsePort(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (!/^\d{1,5}$/.test(raw.trim())) return null;
  const port = Number(raw.trim());
  return port <= 65_535 ? port : null;
}

/**
 * Read the log's removal events, re-reading only when the file has changed.
 * The log grows by megabytes; a range click should not re-scan all of it.
 */
function memoizedEvents(logFile: string): () => Promise<RemovalEvent[]> {
  let memo: { key: string; events: RemovalEvent[] } | null = null;
  return async () => {
    let key = "missing";
    try {
      const st = await stat(logFile);
      key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      /* no log yet: an empty history */
    }
    if (memo && memo.key === key) return memo.events;
    const events = await readRemovalEvents(logFile);
    memo = { key, events };
    return events;
  };
}

async function readDaemon(): Promise<UiDaemonInfo> {
  const [service, state] = await Promise.all([daemonStatus(), readState()]);
  return {
    manager: service.manager,
    installed: service.installed,
    active: service.active,
    intervalSeconds: service.intervalSeconds,
    lastSweep: state.lastSweep,
    sweeps: state.sweeps,
    totalReclaimedKb: state.totalReclaimedKb,
  };
}

/** Best effort. A machine with no browser, or no `open`, still gets the URL on stdout. */
function openInBrowser(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (opener === null) return;
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* not installed, or no display */
    });
    child.unref();
  } catch {
    /* never fail the command over a browser */
  }
}
