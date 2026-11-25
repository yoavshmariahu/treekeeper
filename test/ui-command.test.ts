import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, createServer } from "node:net";
import { get as httpGet } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { createContext } from "../src/commands/context";
import { uiCommand } from "../src/commands/ui";
import type { UiCommandDeps } from "../src/commands/ui";
import type { HistoryReport } from "../src/core/history";
import type { HistoryPayload } from "../src/ui/server";

/**
 * The command is driven in-process through `UiCommandDeps`, inside a throwaway
 * TREEKEEPER_HOME with its own config and log. Nothing here applies a plan, and
 * every server it starts is bound by the OS to a free loopback port and closed
 * through the abort signal before the test ends.
 */

let dir: string;
let configPath: string;
let logFile: string;
let homeWas: string | undefined;

const REMOVAL = {
  ts: "2026-11-20T10:00:00.000Z",
  level: "info",
  type: "reclaim",
  path: "/s/app-feat",
  repo: "/s/app",
  branch: "feat",
  sizeKb: 2048,
  reason: "merged into origin/main",
  archive: null,
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "treekeeper-ui-"));
  homeWas = process.env.TREEKEEPER_HOME;
  process.env.TREEKEEPER_HOME = join(dir, "home");
  logFile = join(dir, "treekeeper.log");
  configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      roots: [join(dir, "src")],
      logFile,
      forge: "none",
      sessions: { detectors: [] },
      archive: { dir: join(dir, "archive") },
    }),
  );
  await writeFile(
    logFile,
    [
      JSON.stringify({ ts: "2026-11-20T09:00:00.000Z", level: "debug", msg: "scanning" }),
      JSON.stringify(REMOVAL),
      JSON.stringify({ ...REMOVAL, type: "branch-delete", ts: "2026-11-20T10:01:00.000Z", branch: "old" }),
    ].join("\n") + "\n",
  );
});

afterAll(async () => {
  if (homeWas === undefined) delete process.env.TREEKEEPER_HOME;
  else process.env.TREEKEEPER_HOME = homeWas;
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Output {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run something that writes to the console, with the console collected. */
async function capture(body: () => Promise<number>): Promise<Output> {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    return { code: await body(), stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

/** Start the dashboard, hand its URL to `body`, then stop it through the signal. */
async function withServer(
  body: (url: string) => Promise<void>,
  flags: Record<string, unknown> = {},
): Promise<Output & { opened: string[] }> {
  const stop = new AbortController();
  let listening: (url: string) => void;
  const url = new Promise<string>((resolve) => (listening = resolve));
  const opened: string[] = [];
  const deps: UiCommandDeps = {
    signal: stop.signal,
    onListening: (u) => listening(u),
    openBrowser: (u) => opened.push(u),
  };

  const run = capture(() => uiCommand({ config: configPath, noOpen: true, ...flags }, deps));
  // A safety net: never leave a server up if the body throws or hangs.
  const timer = setTimeout(() => stop.abort(), 30_000);
  try {
    await body(await url);
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
  return { ...(await run), opened };
}

function fetchText(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // agent: false, so no pooled socket outlives the request.
    httpGet(url, { agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

/** What a plain TCP connection to a port gets: an error code, or "connected". */
function probe(port: string | number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: Number(port), timeout: 2000 });
    socket.on("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve("timeout");
    });
    socket.on("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "error"));
  });
}

describe("treekeeper ui --json", () => {
  it("prints the all-time removal history and starts no server", async () => {
    const opened: string[] = [];
    let listened = 0;
    const out = await capture(() =>
      uiCommand(
        { config: configPath, json: true },
        { onListening: () => (listened += 1), openBrowser: (u) => opened.push(u) },
      ),
    );
    expect(out.code).toBe(0);
    expect(listened).toBe(0);
    expect(opened).toEqual([]);

    const report = JSON.parse(out.stdout) as HistoryReport;
    expect(report.version).toBe(1);
    expect(report.range).toBe("all");
    expect(report.totals).toEqual({ worktrees: 1, reclaimedKb: 2048, branches: 1, repos: 1 });
    expect(report.removals).toHaveLength(1);
    expect(report.removals[0]!.path).toBe("/s/app-feat");
    expect(report.since).toBe("2026-11-20T10:00:00.000Z");
    // Pretty-printed, so `treekeeper ui --json | jq` and a human both read it.
    expect(out.stdout.endsWith("\n")).toBe(true);
    expect(out.stdout).toContain("\n  \"totals\": {");
  });

  it("never appends to the log it just read", async () => {
    const before = await readFile(logFile);
    await capture(() => uiCommand({ config: configPath, json: true, verbose: true }));
    expect(await readFile(logFile)).toEqual(before);
  });

  it("is also what `treekeeper ui --json` on the command line runs", async () => {
    const out = await capture(() => main(["ui", "--json", "--config", configPath]));
    expect(out.code).toBe(0);
    expect((JSON.parse(out.stdout) as HistoryReport).totals.worktrees).toBe(1);
  });
});

describe("treekeeper ui --port", () => {
  it("refuses a port that is not one, with exit 2 and no server", async () => {
    for (const port of ["abc", "-1", "70000", "123456", "12.5", "", "8080x", " "]) {
      const out = await capture(() => uiCommand({ config: configPath, port, noOpen: true }));
      expect(out.code, port).toBe(2);
      expect(out.stderr, port).toContain("--port must be a whole number from 0 to 65535");
    }
    const cli = await capture(() => main(["ui", "--port", "abc", "--config", configPath]));
    expect(cli.code).toBe(2);
  });

  it("reports a port it cannot have instead of crashing", async () => {
    const taken = createServer();
    const port = await new Promise<number>((resolve) => {
      taken.listen(0, "127.0.0.1", () => resolve((taken.address() as { port: number }).port));
    });
    try {
      const out = await capture(() =>
        uiCommand({ config: configPath, port: String(port), noOpen: true }),
      );
      expect(out.code).toBe(1);
      expect(out.stderr).toContain(`could not listen on 127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });
});

describe("treekeeper ui", () => {
  it("serves the dashboard on a loopback port and stops when it is asked to", async () => {
    let page = { status: 0, body: "" };
    let history: HistoryPayload | null = null;
    let url = "";
    const out = await withServer(async (u) => {
      url = u;
      page = await fetchText(u);
      const res = await fetchText(new URL("/api/history?range=all", u).toString());
      history = JSON.parse(res.body) as HistoryPayload;
    });

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(new URL(url).port).not.toBe("0");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>treekeeper</title>");
    // The history route is wired to the log the config names.
    expect(history!.history.totals.worktrees).toBe(1);
    expect(history!.logFile).toBe(logFile);

    // The abort signal stopped it: the command returned 0, said so, and the
    // port answers nothing now.
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(url);
    expect(out.stderr).toContain("local and read-only");
    expect(out.stderr).toContain("stopped");
    expect(await probe(new URL(url).port)).toBe("ECONNREFUSED");
  });

  it("leaves the browser alone with --no-open, and opens it without", async () => {
    const closed = await withServer(async () => undefined, { noOpen: true });
    expect(closed.opened).toEqual([]);

    const opens = await withServer(async () => undefined, { noOpen: false });
    expect(opens.opened).toHaveLength(1);
    expect(opens.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it("writes nothing to the log while the dashboard is up", async () => {
    const before = await readFile(logFile);
    await withServer(async (url) => {
      await fetchText(new URL("/api/history?range=7d", url).toString());
    });
    expect(await readFile(logFile)).toEqual(before);
  });

  it("is a command the CLI offers, with its two flags", async () => {
    const out = await capture(() => main(["--help"]));
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/^\s*ui\s+A local, read-only dashboard/m);
    expect(out.stdout).toContain("--port <n>");
    expect(out.stdout).toContain("--no-open");
    // An unknown flag is a usage error, not a server.
    const bad = await capture(() => main(["ui", "--delete-everything"]));
    expect(bad.code).toBe(2);
  });
});

describe("createContext", () => {
  it("builds a logger that cannot write to the log file when logToFile is off", async () => {
    const before = await readFile(logFile);
    const quiet = await createContext({ config: configPath, quiet: true }, { logToFile: false });
    expect(quiet.config.logFile).toBe(logFile);
    quiet.logger.warn("a warning nobody should record");
    quiet.logger.event("reclaim", { path: "/s/should-not-be-logged", repo: "/s/app", sizeKb: 1 });
    expect(await readFile(logFile)).toEqual(before);

    // The flag is what prevents it: the default logger does append.
    const loud = await createContext({ config: configPath, quiet: true }, {});
    loud.logger.event("reclaim", { path: "/s/logged", repo: "/s/app", sizeKb: 1 });
    const after = await readFile(logFile, "utf8");
    expect(after.length).toBeGreaterThan(before.length);
    expect(after).toContain("/s/logged");
    expect(after).not.toContain("/s/should-not-be-logged");

    // Put the log back the way the other tests expect it.
    await writeFile(logFile, before);
  });
});
