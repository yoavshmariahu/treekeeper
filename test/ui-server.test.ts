import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RemovalEvent } from "../src/core/history";
import type { UsageReport } from "../src/core/usage";
import { PAGE_CSP, PAGE_HTML } from "../src/ui/page";
import { UI_HOST, UI_ROUTES, createUiServer, listenLocal } from "../src/ui/server";
import type { HistoryPayload, UiDaemonInfo, UiServerDeps, UsagePayload } from "../src/ui/server";

/**
 * Every data source is injected, so these tests never touch a real repo, a real
 * log or the real daemon — but the requests are real HTTP over a real loopback
 * socket on a port the OS picks, closed again in teardown.
 */

const open: Server[] = [];

afterEach(async () => {
  while (open.length > 0) {
    const server = open.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function events(): RemovalEvent[] {
  return [
    {
      kind: "worktree", at: Date.parse("2026-11-20T10:00:00.000Z"), repo: "/s/app",
      path: "/s/app-feat", branch: "feat", sizeKb: 2048, reason: "merged", archived: false,
    },
    {
      kind: "branch", at: Date.parse("2026-06-01T10:00:00.000Z"), repo: "/s/app",
      path: null, branch: "old", sizeKb: 0, reason: "merged", archived: false,
    },
  ];
}

function daemon(): UiDaemonInfo {
  return {
    manager: "launchd", installed: true, active: true, intervalSeconds: 900,
    lastSweep: null, sweeps: 3, totalReclaimedKb: 2048,
  };
}

function usageReport(): UsageReport {
  return {
    version: 1,
    generatedAt: "2026-11-20T15:00:00.000Z",
    durationMs: 10,
    roots: ["/s"],
    volumes: [],
    repos: [],
    totals: {
      repos: 0, worktrees: 0, sizeKb: 0, unmeasured: 0,
      reclaimableWorktrees: 0, reclaimableKb: 0, branchesDeletable: 0,
    },
    skipped: [],
    warnings: [],
  };
}

interface Harness {
  port: number;
  calls: { events: number; daemon: number; usage: number };
  get: (path: string, opts?: Options) => Promise<Reply>;
}

interface Options {
  method?: string;
  host?: string | null;
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: () => unknown;
}

async function serve(over: Partial<UiServerDeps> = {}): Promise<Harness> {
  const calls = { events: 0, daemon: 0, usage: 0 };
  const server = createUiServer({
    readEvents: async () => {
      calls.events += 1;
      return events();
    },
    readDaemon: async () => {
      calls.daemon += 1;
      return daemon();
    },
    measureUsage: async () => {
      calls.usage += 1;
      return usageReport();
    },
    logFile: "/tmp/treekeeper.log",
    now: () => Date.parse("2026-11-20T15:30:00.000Z"),
    utcOffsetMinutes: 0,
    ...over,
  });
  open.push(server);
  const port = await listenLocal(server, 0);
  return { port, calls, get: (path, opts) => fetchRaw(port, path, opts) };
}

function fetchRaw(port: number, path: string, opts: Options = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.host !== undefined) headers.Host = opts.host ?? "";
    const req = request(
      { host: UI_HOST, port, path, method: opts.method ?? "GET", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body) as unknown,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** One request written straight onto the socket, headers and all. */
function raw(port: number, lines: string[]): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: UI_HOST, port }, () =>
      // Connection: close, so the reply is complete when the socket ends.
      socket.write([...lines, "Connection: close"].join("\r\n") + "\r\n\r\n"),
    );
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (text += chunk));
    socket.on("close", () => resolve(text));
    socket.on("error", (err: NodeJS.ErrnoException) => resolve(`socket error ${err.code}`));
    setTimeout(() => socket.destroy(), 2000);
  });
}

describe("createUiServer", () => {
  it("serves the dashboard document itself, with the policy that pins its script", async () => {
    const { get } = await serve();
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toBe(PAGE_HTML);
    expect(res.headers["content-security-policy"]).toBe(PAGE_CSP);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(PAGE_HTML));
  });

  it("answers a HEAD with the headers and no body", async () => {
    const { get } = await serve();
    const res = await get("/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
    expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(PAGE_HTML));
  });

  it("answers the history route with the report for the range asked for", async () => {
    const { get, calls } = await serve();
    const all = (await get(UI_ROUTES.history)).json() as HistoryPayload;
    expect(all.history.range).toBe("all");
    expect(all.history.totals).toEqual({ worktrees: 1, reclaimedKb: 2048, branches: 1, repos: 1 });
    expect(all.daemon).toEqual(daemon());
    expect(all.logFile).toBe("/tmp/treekeeper.log");

    const week = (await get(`${UI_ROUTES.history}?range=7d`)).json() as HistoryPayload;
    expect(week.history.range).toBe("7d");
    expect(week.history.byDay).toHaveLength(7);
    // The branch deletion from June is outside the week, the worktree is in it.
    expect(week.history.totals).toEqual({ worktrees: 1, reclaimedKb: 2048, branches: 0, repos: 1 });
    expect(calls.events).toBe(2);
  });

  it("refuses a range it does not offer, before reading anything", async () => {
    const { get, calls } = await serve();
    const res = await get(`${UI_ROUTES.history}?range=1d`);
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.json()).toEqual({ error: "range must be one of 7d, 30d, all" });
    expect(calls.events).toBe(0);
  });

  it("answers the usage route with the measured report", async () => {
    const { get } = await serve();
    const res = await get(UI_ROUTES.usage);
    expect(res.status).toBe(200);
    expect((res.json() as UsagePayload).usage).toEqual(usageReport());
  });

  it("still serves the history when the daemon state cannot be read", async () => {
    const { get } = await serve({
      readDaemon: async () => {
        throw new Error("no state.json");
      },
    });
    const res = await get(UI_ROUTES.history);
    expect(res.status).toBe(200);
    expect((res.json() as HistoryPayload).daemon).toBeNull();
  });

  it("is read-only: it offers three GET routes and refuses every other method", async () => {
    const { get, calls } = await serve();
    expect(Object.values(UI_ROUTES)).toEqual(["/", "/api/history", "/api/usage"]);

    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const path of [...Object.values(UI_ROUTES), "/apply", "/api/gc?apply=1"]) {
        const res = await get(path, { method });
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.allow, `${method} ${path}`).toBe("GET, HEAD");
        expect(res.body).toContain("read-only");
      }
    }
    // Nothing a non-GET could reach ever read, let alone wrote.
    expect(calls).toEqual({ events: 0, daemon: 0, usage: 0 });

    // And the module has nothing on hand that could remove anything: no apply,
    // no archive, no child process, no filesystem write.
    const source = (await readFile(new URL("../src/ui/server.ts", import.meta.url), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      "applyPlan", "archiveWork", "pruneArchives", "deleteBranch", "removeWorktree",
      "child_process", "spawn", "execFile", "node:fs", "writeFile", "unlink", "rmdir",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("answers an unknown path with 404", async () => {
    const { get } = await serve();
    const res = await get("/../etc/passwd");
    expect(res.status).toBe(404);
    expect(res.body).toBe("not found\n");
    expect((await get("/api/history/extra")).status).toBe(404);
  });

  it("refuses a request that did not address this loopback server by name", async () => {
    // Raw sockets, because an http client fills in a Host header of its own.
    const { port, calls } = await serve();
    for (const header of [
      "Host: treekeeper.example.com",
      `Host: evil.example.com:${port}`,
      `Host: 127.0.0.1:${port + 1}`,
      "Host: 127.0.0.1",
      `Host: [::1]:${port}`,
      "Host:",
    ]) {
      const res = await raw(port, [`GET ${UI_ROUTES.history} HTTP/1.1`, header]);
      expect(res, header).toContain("403 Forbidden");
      expect(res, header).toContain("only answers to 127.0.0.1");
    }
    // A request with no Host at all never reaches the handler either.
    expect(await raw(port, ["GET / HTTP/1.1"])).toContain("400 Bad Request");
    expect(await raw(port, ["GET / HTTP/1.0"])).toContain("403 Forbidden");
    expect(calls).toEqual({ events: 0, daemon: 0, usage: 0 });

    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      const res = await raw(port, ["GET / HTTP/1.1", `Host: ${host}`]);
      expect(res, host).toContain("200 OK");
    }
  });

  it("listens on the loopback address only", async () => {
    const { port } = await serve();
    const server = open[open.length - 1]!;
    const address = server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    expect(address.family).toBe("IPv4");

    const external = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .find((i) => i.family === "IPv4" && !i.internal);
    if (external) {
      // Nothing is listening on this machine's own LAN address.
      const refused = await new Promise<string>((resolve) => {
        const socket = connect({ host: external.address, port, timeout: 2000 });
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
      expect(refused, `${external.address}:${port}`).not.toBe("connected");
    }
  });

  it("measures usage once for requests that arrive together, then serves it from cache", async () => {
    let clock = 1_000_000;
    let release = (): void => undefined;
    let calls = 0;
    const { get } = await serve({
      now: () => clock,
      usageTtlMs: 60_000,
      measureUsage: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return usageReport();
      },
    });

    const concurrent = Promise.all([
      get(UI_ROUTES.usage), get(UI_ROUTES.usage), get(UI_ROUTES.usage),
      get(UI_ROUTES.usage), get(UI_ROUTES.usage),
    ]);
    // Let all five reach the handler before the one measurement finishes.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
    release();
    const replies = await concurrent;
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    for (const reply of replies) expect((reply.json() as UsagePayload).usage).toEqual(usageReport());
    expect(calls).toBe(1);

    // Inside the TTL, the cached measurement answers.
    clock += 59_000;
    expect((await get(UI_ROUTES.usage)).status).toBe(200);
    expect(calls).toBe(1);

    // refresh=1 measures again, however fresh the cache is.
    const refreshed = get(`${UI_ROUTES.usage}?refresh=1`);
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await refreshed).status).toBe(200);
    expect(calls).toBe(2);

    // And so does the first request after the TTL lapses.
    clock += 60_001;
    const stale = get(UI_ROUTES.usage);
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await stale).status).toBe(200);
    expect(calls).toBe(3);
  });

  it("turns a data source that fails into a 500 with a JSON error, not a hung request", async () => {
    const broken = await serve({
      readEvents: async () => {
        throw new Error("log unreadable");
      },
    });
    const res = await broken.get(UI_ROUTES.history);
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.json()).toEqual({ error: "log unreadable" });

    let attempts = 0;
    const flaky = await serve({
      measureUsage: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("du exploded");
        return usageReport();
      },
    });
    const first = await flaky.get(UI_ROUTES.usage);
    expect(first.status).toBe(500);
    expect(first.json()).toEqual({ error: "du exploded" });
    // A failure is not cached: the next request measures again.
    const second = await flaky.get(UI_ROUTES.usage);
    expect(second.status).toBe(200);
    expect(attempts).toBe(2);
  });
});
