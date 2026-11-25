import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { HistoryReport, RemovalEvent } from "../core/history.js";
import { HISTORY_RANGES, buildHistoryReport, isHistoryRange } from "../core/history.js";
import type { UsageReport } from "../core/usage.js";
import type { SweepRecord } from "../daemon/state.js";
import { PAGE_CSP, PAGE_HTML } from "./page.js";

/**
 * The dashboard's HTTP server.
 *
 * Read-only by construction: three GET routes, each of which only reads. There
 * is no route that removes, archives, prunes or changes anything, and nothing
 * here can reach `applyPlan`.
 */

/** The only address the dashboard is ever bound to. */
export const UI_HOST = "127.0.0.1";

export const UI_ROUTES = {
  page: "/",
  history: "/api/history",
  usage: "/api/usage",
} as const;

/** What `status` shows about the daemon, for the page's daemon line. */
export interface UiDaemonInfo {
  manager: string;
  installed: boolean;
  /** Loaded with the service manager and scheduled to run. */
  active: boolean;
  intervalSeconds: number | null;
  lastSweep: SweepRecord | null;
  sweeps: number;
  totalReclaimedKb: number;
}

/** Body of `GET /api/history`. */
export interface HistoryPayload {
  history: HistoryReport;
  /** Null when the daemon state could not be read. */
  daemon: UiDaemonInfo | null;
  /** Where the history was read from, for the empty state. */
  logFile: string | null;
}

/** Body of `GET /api/usage`. */
export interface UsagePayload {
  usage: UsageReport;
}

/** Body of every JSON error response. */
export interface ErrorPayload {
  error: string;
}

/** Everything the server reads, injected so it can run without real repos or a real home. */
export interface UiServerDeps {
  /** Every removal event on record. Called on each history request. */
  readEvents: () => Promise<RemovalEvent[]>;
  readDaemon: () => Promise<UiDaemonInfo>;
  /** The slow one. Never run twice at once; its result is cached for `usageTtlMs`. */
  measureUsage: () => Promise<UsageReport>;
  logFile?: string;
  now?: () => number;
  /** Minutes east of UTC that cut calendar days. Default: this machine's zone at `now`. */
  utcOffsetMinutes?: number;
  /** How long a usage measurement is served before it is taken again. Default 5 minutes. */
  usageTtlMs?: number;
}

const DEFAULT_USAGE_TTL_MS = 5 * 60_000;

export function createUiServer(deps: UiServerDeps): Server {
  const now = deps.now ?? Date.now;
  const usageTtlMs = deps.usageTtlMs ?? DEFAULT_USAGE_TTL_MS;

  let cached: { report: UsageReport; at: number } | null = null;
  let inflight: Promise<UsageReport> | null = null;

  /** One measurement at a time: concurrent callers share the one in flight. */
  const usage = (refresh: boolean): Promise<UsageReport> => {
    if (inflight) return inflight;
    if (!refresh && cached && now() - cached.at < usageTtlMs) return Promise.resolve(cached.report);

    const run = Promise.resolve().then(() => deps.measureUsage());
    inflight = run;
    const settle = (): void => {
      if (inflight === run) inflight = null;
    };
    run.then((report) => {
      cached = { report, at: now() };
      settle();
    }, settle);
    return run;
  };

  const history = async (range: HistoryReport["range"]): Promise<HistoryPayload> => {
    const at = now();
    const [events, daemon] = await Promise.all([
      deps.readEvents(),
      deps.readDaemon().catch(() => null),
    ]);
    return {
      history: buildHistoryReport(events, {
        now: at,
        range,
        utcOffsetMinutes: deps.utcOffsetMinutes ?? -new Date(at).getTimezoneOffset(),
      }),
      daemon,
      logFile: deps.logFile ?? null,
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // DNS-rebinding defence: a page on another origin can point a hostname at
    // 127.0.0.1, but it cannot make the browser send our address as the Host.
    const port = req.socket.localPort;
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `${UI_HOST}:${port}` && host !== `localhost:${port}`) {
      sendText(req, res, 403, "forbidden: this server only answers to 127.0.0.1\n");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      req.resume();
      sendText(req, res, 405, "method not allowed: this server is read-only\n", { Allow: "GET, HEAD" });
      return;
    }

    const target = req.url ?? "/";
    const q = target.indexOf("?");
    const path = q === -1 ? target : target.slice(0, q);
    const params = new URLSearchParams(q === -1 ? "" : target.slice(q + 1));

    switch (path) {
      case UI_ROUTES.page:
        send(req, res, 200, "text/html; charset=utf-8", PAGE_HTML);
        return;

      case UI_ROUTES.history: {
        const range = params.get("range") ?? "all";
        if (!isHistoryRange(range)) {
          sendJson(req, res, 400, { error: `range must be one of ${HISTORY_RANGES.join(", ")}` });
          return;
        }
        sendJson(req, res, 200, await history(range));
        return;
      }

      case UI_ROUTES.usage: {
        const payload: UsagePayload = { usage: await usage(params.get("refresh") === "1") };
        sendJson(req, res, 200, payload);
        return;
      }

      default:
        sendText(req, res, 404, "not found\n");
    }
  };

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent) res.destroy();
      else sendJson(req, res, 500, { error: message });
    });
  });
}

/**
 * Start listening on 127.0.0.1 and resolve with the port. Port 0 lets the OS
 * pick a free one.
 */
export function listenLocal(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, UI_HOST, () => {
      server.removeListener("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extra: Record<string, string> = {},
): void {
  // The client may have gone away while a measurement ran.
  if (res.destroyed || res.writableEnded) return;
  const bytes = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": bytes.length,
    "Content-Security-Policy": PAGE_CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(req.method === "HEAD" ? undefined : bytes);
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: HistoryPayload | UsagePayload | ErrorPayload,
): void {
  send(req, res, status, "application/json; charset=utf-8", JSON.stringify(body) + "\n");
}

function sendText(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: string,
  extra: Record<string, string> = {},
): void {
  send(req, res, status, "text/plain; charset=utf-8", body, extra);
}
