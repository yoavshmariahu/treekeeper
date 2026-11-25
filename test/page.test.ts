import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PAGE_CSP, PAGE_HTML } from "../src/ui/page";
import { FakeDocument, FakeElement } from "./fake-dom";
import type { HistoryPayload, UsagePayload } from "../src/ui/server";

/**
 * The page ships as one HTML document. These tests take it apart the way a
 * browser would: the inline stylesheet and script, the attributes that could
 * name an outside host, and then the script itself, run over a DOM that throws
 * if anything tries to build markup from a string.
 */

const STYLE = /<style>([\s\S]*?)<\/style>/.exec(PAGE_HTML)![1]!;
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE_HTML)![1]!;
const BODY = PAGE_HTML.slice(PAGE_HTML.indexOf("<body>") + 6, PAGE_HTML.indexOf("<script>"));

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("base64");

describe("the dashboard document", () => {
  it("is one self-contained document: one inline stylesheet, one inline script, no other resource", () => {
    expect(PAGE_HTML.startsWith("<!doctype html>")).toBe(true);
    expect(PAGE_HTML.match(/<style[\s>]/g)).toHaveLength(1);
    expect(PAGE_HTML.match(/<script/g)).toHaveLength(1);
    expect(PAGE_HTML).not.toMatch(/<script[^>]+src=/);
    expect(PAGE_HTML).not.toMatch(/<link[^>]+rel="stylesheet"/);
    expect(PAGE_HTML).not.toMatch(/<(img|iframe|frame|object|embed|video|audio|source|track)[\s>]/);
    expect(PAGE_HTML).not.toMatch(/@import|@font-face|srcdoc|javascript:/);
    // No CSS that fetches anything: no url(), so no web font and no background image.
    expect(STYLE).not.toContain("url(");
  });

  it("names no host but its own: every URL in the page is a data: or same-origin path", () => {
    const attrs = [...PAGE_HTML.matchAll(/\b(?:src|href|action|poster|srcset|xlink:href)="([^"]*)"/g)];
    expect(attrs).toHaveLength(1);
    expect(attrs[0]![1]).toBe("data:,");

    // The only absolute URL anywhere is the SVG namespace, which is an
    // identifier the browser never requests.
    const absolute = PAGE_HTML.match(/https?:\/\/[^\s"'()<>]+/g) ?? [];
    expect([...new Set(absolute)]).toEqual(["http://www.w3.org/2000/svg"]);
    expect(PAGE_HTML).not.toMatch(/["'(]\/\/[a-z0-9]/i);

    // The script has one fetch, and every URL it can build is a path on the
    // server that served the page.
    expect([...SCRIPT.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1])).toEqual(["url"]);
    const paths = [...new Set([...SCRIPT.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]!))].sort();
    expect(paths).toEqual(["/api/history?range=", "/api/usage", "/api/usage?refresh=1"]);
    expect(SCRIPT).toContain('getJson("/api/history?range=" + encodeURIComponent(state.range))');
  });

  it("pins the exact stylesheet and script it ships, by hash, under a default-src of none", () => {
    // A stale hash here is a blank page in a real browser; nothing else notices.
    expect(PAGE_CSP).toContain(`script-src 'sha256-${sha256(SCRIPT)}'`);
    expect(PAGE_CSP).toContain(`style-src 'sha256-${sha256(STYLE)}'`);
    expect(PAGE_CSP.startsWith("default-src 'none'")).toBe(true);
    expect(PAGE_CSP).toContain("connect-src 'self'");
    expect(PAGE_CSP).toContain("base-uri 'none'");
    expect(PAGE_CSP).toContain("form-action 'none'");
    expect(PAGE_CSP).toContain("frame-ancestors 'none'");
    expect(PAGE_CSP).toContain("img-src data:");
    expect(PAGE_CSP).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|\*|https?:/);
    // Exactly one hash per directive, and both are 32-byte digests.
    expect(PAGE_CSP.match(/sha256-[A-Za-z0-9+/]{43}=/g)).toHaveLength(2);
  });

  it("has no way to turn a string into markup, and no way to run one", () => {
    for (const sink of [
      "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment",
      "setHTMLUnsafe", "parseFromString", "eval(", "new Function", "Function(", "srcdoc",
    ]) {
      expect(SCRIPT, sink).not.toContain(sink);
    }
    // Everything dynamic goes in as text or as an attribute value.
    expect(SCRIPT).toContain("node.textContent = String(text)");
    expect(SCRIPT).toContain("createElement");
    expect(SCRIPT).toContain("createElementNS");
  });
});

describe("the dashboard script, run over a DOM", () => {
  const HOSTILE_REPO = "/s/</script><script>alert(1)</script>";
  const HOSTILE_BRANCH = '"><img src=x onerror=alert(1)>';
  const HOSTILE_PATH = "/s/wt-<svg onload=alert(1)>";
  const HOSTILE_REASON = "merged & closed <b>bold</b>";

  function history(over: Partial<HistoryPayload["history"]> = {}, daemon = daemonInfo()): HistoryPayload {
    const day = (i: number): string => new Date(Date.UTC(2026, 10, 20) - i * 86_400_000).toISOString().slice(0, 10);
    const byDay = Array.from({ length: 30 }, (_, i) => ({
      day: day(29 - i),
      worktrees: i === 29 ? 2 : i === 10 ? 1 : 0,
      reclaimedKb: i === 29 ? 12_000_000 : i === 10 ? 6_768_592 : 0,
      branches: i === 29 ? 3 : 0,
    }));
    return {
      logFile: "/tmp/treekeeper.log",
      daemon,
      history: {
        version: 1,
        generatedAt: "2026-11-20T15:30:00.000Z",
        range: "30d",
        from: byDay[0]!.day + "T00:00:00.000Z",
        to: "2026-11-20T15:30:00.000Z",
        utcOffsetMinutes: 0,
        since: "2026-02-01T00:00:00.000Z",
        totals: { worktrees: 35, reclaimedKb: 18_768_592, branches: 663, repos: 7 },
        byRepo: [
          {
            repo: HOSTILE_REPO, name: "thinker", worktrees: 33, reclaimedKb: 18_000_000,
            branches: 252, lastRemovalAt: "2026-11-20T14:00:00.000Z",
          },
          {
            repo: "/s/thinkerall", name: "thinkerall", worktrees: 2, reclaimedKb: 768_592,
            branches: 4, lastRemovalAt: "2026-11-19T09:00:00.000Z",
          },
        ],
        byDay,
        removals: [
          {
            at: "2026-11-20T14:00:00.000Z", repo: HOSTILE_REPO, name: "thinker", path: HOSTILE_PATH,
            branch: HOSTILE_BRANCH, sizeKb: 1_048_576, reason: HOSTILE_REASON, archived: true,
          },
          {
            at: "2026-11-19T09:00:00.000Z", repo: "/s/thinkerall", name: "thinkerall", path: "/s/wt-2",
            branch: null, sizeKb: 2048, reason: "pull request merged", archived: false,
          },
        ],
        removalsOmitted: 0,
        ...over,
      },
    };
  }

  function daemonInfo(): HistoryPayload["daemon"] {
    return {
      manager: "launchd",
      installed: true,
      active: true,
      intervalSeconds: 900,
      lastSweep: {
        at: Date.now() - 20 * 60_000, durationMs: 4200, repos: 12,
        worktrees: 2, branches: 5, reclaimedKb: 4096, failures: 0,
      },
      sweeps: 148,
      totalReclaimedKb: 18_768_592,
    };
  }

  function usage(over: Partial<UsagePayload["usage"]> = {}): UsagePayload {
    return {
      usage: {
        version: 1,
        generatedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 42_000,
        roots: ["/s"],
        volumes: [{ roots: ["/s"], totalKb: 1_000_000_000, usedKb: 950_000_000, freeKb: 50_000_000 }],
        repos: [
          {
            repo: HOSTILE_REPO, name: "thinker", worktrees: 9, sizeKb: 5_000_000, unmeasured: 1,
            reclaimableWorktrees: 3, reclaimableKb: 1_500_000, branchesDeletable: 4,
          },
          {
            repo: "/s/quiet", name: "quiet", worktrees: 0, sizeKb: 0, unmeasured: 0,
            reclaimableWorktrees: 0, reclaimableKb: 0, branchesDeletable: 0,
          },
        ],
        totals: {
          repos: 2, worktrees: 9, sizeKb: 5_000_000, unmeasured: 1,
          reclaimableWorktrees: 3, reclaimableKb: 1_500_000, branchesDeletable: 4,
        },
        skipped: [{ repo: "/s/off", name: "off", reason: HOSTILE_REASON }],
        warnings: ["gh is not installed; using git ancestry only"],
        ...over,
      },
    };
  }

  interface Answer {
    status?: number;
    body?: unknown;
    unreadable?: boolean;
  }

  interface Run {
    doc: FakeDocument;
    calls: string[];
    text: () => string;
    html: () => string;
    find: (id: string) => FakeElement;
    flush: () => Promise<void>;
  }

  async function run(answer: (url: string) => Answer): Promise<Run> {
    const doc = new FakeDocument(BODY);
    const calls: string[] = [];
    const fetch = (url: string): Promise<unknown> => {
      calls.push(url);
      const a = answer(url);
      const status = a.status ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => (a.unreadable ? Promise.reject(new Error("not json")) : Promise.resolve(a.body)),
      });
    };
    const win = {
      addEventListener: () => undefined,
      requestAnimationFrame: (fn: () => void) => {
        fn();
        return 1;
      },
      setInterval: () => 1,
    };
    // The page's own IIFE, with nothing in scope but the globals a browser gives it.
    const exec = new Function("window", "document", "fetch", "Node", "self", SCRIPT) as (
      ...args: unknown[]
    ) => void;
    const { FakeNode } = await import("./fake-dom");
    exec(win, doc, fetch, FakeNode, undefined);
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
    };
    await flush();
    return {
      doc,
      calls,
      text: () => doc.text(),
      html: () => doc.root.serialize(),
      find: (id) => doc.getElementById(id)!,
      flush,
    };
  }

  it("asks its own server for the history and the usage, and nothing else", async () => {
    const r = await run((url) => ({ body: url.startsWith("/api/history") ? history() : usage() }));
    expect(r.calls).toEqual(["/api/history?range=30d", "/api/usage"]);
  });

  it("shows the removal totals, the repo rows, the per-day chart and the removal list", async () => {
    const r = await run((url) => ({ body: url.startsWith("/api/history") ? history() : usage() }));

    expect(r.find("history-state").hidden).toBe(true);
    expect(r.find("history-empty").hidden).toBe(true);
    expect(r.find("history-body").hidden).toBe(false);

    // 18768592 KB of reclaim, 35 worktrees, 663 branches, 7 repos.
    const tiles = r.find("tiles").textContent;
    expect(tiles).toContain("17.9G");
    expect(tiles).toContain("from 35 removed worktrees");
    expect(tiles).toContain("663");
    expect(tiles).toContain("pruned without a worktree");
    expect(tiles).toContain("Repos touched");
    expect(tiles).toContain("7");

    const repoRows = r.find("repos").descendants().filter((n) => n.tagName === "tr");
    expect(repoRows).toHaveLength(3); // header + two repos
    expect(repoRows[1]!.textContent).toContain("thinker");
    expect(repoRows[1]!.textContent).toContain("33");
    expect(repoRows[1]!.textContent).toContain("252");

    const svg = r.find("chart").descendants().filter((n) => n.tagName === "svg");
    expect(svg).toHaveLength(1);
    expect(svg[0]!.namespace).toBe("svg");
    const bars = r.find("chart").descendants().filter((n) => n.getAttribute("class") === "bar");
    const hits = r.find("chart").descendants().filter((n) => n.getAttribute("class") === "hit");
    expect(bars).toHaveLength(2); // the two days that reclaimed anything
    expect(hits).toHaveLength(30); // one hit target per day in the range
    expect(r.find("chart-title").textContent).toBe("Space reclaimed per day");
    expect(r.find("chart-meta").textContent).toContain("peak 11.4G");

    const removalRows = r.find("removals").descendants().filter((n) => n.tagName === "tr");
    expect(removalRows).toHaveLength(3); // header + two removals
    expect(r.find("removals-meta").textContent).toBe("35 worktrees, newest first");
    expect(removalRows[1]!.textContent).toContain("1.0G");
    expect(removalRows[1]!.textContent).toContain("archived first");
    expect(removalRows[2]!.textContent).toContain("(detached)");
    expect(r.find("daemon").textContent).toContain("Daemon scheduled");
    expect(r.find("daemon").textContent).toContain("every 15m");
    expect(r.find("daemon").textContent).toContain("148 sweeps");
  });

  it("puts untrusted branch names, paths and reasons into the page as text, never as markup", async () => {
    const r = await run((url) => ({ body: url.startsWith("/api/history") ? history() : usage() }));

    // The hostile strings did reach the page...
    const text = r.text();
    expect(text).toContain(HOSTILE_BRANCH);
    expect(text).toContain(HOSTILE_REASON);
    const titles = r.doc.root.descendants().map((n) => n.getAttribute("title"));
    expect(titles).toContain(HOSTILE_PATH);
    expect(titles).toContain(HOSTILE_REPO);

    // ...and every one of them is a text node or an attribute value, so the
    // serialized page carries them escaped and holds no injected element.
    const html = r.html();
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;svg onload=alert(1)&gt;");
    expect(html).toContain("merged &amp; closed &lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg onload");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('"><img');
    // No attribute value can close its own tag: none of them hold a raw < or >.
    for (const [, value] of html.matchAll(/="([^"]*)"/g)) expect(value).not.toMatch(/[<>]/);
    const tags = new Set(r.doc.root.descendants().map((n) => n.tagName));
    for (const smuggled of ["img", "script", "b", "iframe", "object"]) {
      expect(tags.has(smuggled), smuggled).toBe(false);
    }
  });

  it("reloads the history for another range when the range is changed", async () => {
    const r = await run((url) => ({ body: url.startsWith("/api/history") ? history() : usage() }));
    const segments = r.doc.querySelectorAll(".seg");
    expect(segments.map((s) => s.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);

    segments[0]!.fire("click");
    await r.flush();
    expect(r.calls).toEqual(["/api/history?range=30d", "/api/usage", "/api/history?range=7d"]);
    expect(segments.map((s) => s.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);

    // Clicking the range it is already on asks the server for nothing.
    segments[0]!.fire("click");
    await r.flush();
    expect(r.calls).toHaveLength(3);
  });

  it("groups a long range into wider bars so the chart stays readable", async () => {
    const byDay = Array.from({ length: 400 }, (_, i) => ({
      day: new Date(Date.UTC(2025, 9, 17) + i * 86_400_000).toISOString().slice(0, 10),
      worktrees: i % 50 === 0 ? 1 : 0,
      reclaimedKb: i % 50 === 0 ? 500_000 : 0,
      branches: 0,
    }));
    const r = await run((url) => ({
      body: url.startsWith("/api/history") ? history({ range: "all", byDay }) : usage(),
    }));
    expect(r.find("chart-title").textContent).toBe("Space reclaimed per week");
    const hits = r.find("chart").descendants().filter((n) => n.getAttribute("class") === "hit");
    expect(hits).toHaveLength(Math.ceil(400 / 7));
    // Every bar's label still accounts for the days it covers.
    expect(hits.some((h) => (h.getAttribute("aria-label") ?? "").includes(" – "))).toBe(true);
  });

  it("offers the rest of a long removal list, and says what the cap left out", async () => {
    const removals = Array.from({ length: 500 }, (_, i) => ({
      at: new Date(Date.parse("2026-11-20T14:00:00.000Z") - i * 60_000).toISOString(),
      repo: "/s/thinker", name: "thinker", path: `/s/wt-${i}`, branch: `b-${i}`,
      sizeKb: 1024, reason: "merged", archived: false,
    }));
    const r = await run((url) => ({
      body: url.startsWith("/api/history") ? history({ removals, removalsOmitted: 112 }) : usage(),
    }));
    const rows = () => r.find("removals").descendants().filter((n) => n.tagName === "tr").length - 1;
    expect(rows()).toBe(50);
    expect(r.find("removals-more").textContent).toContain("450 not shown");

    const more = r.find("removals-more").descendants().find((n) => n.tagName === "button")!;
    expect(more.textContent).toBe("Show 50 more");
    more.fire("click");
    expect(rows()).toBe(100);
    expect(r.calls).toHaveLength(2); // shown from what is already loaded
  });

  it("shows the volumes, the per-repo worktrees and what is reclaimable now", async () => {
    const r = await run((url) => ({ body: url.startsWith("/api/history") ? history() : usage() }));

    expect(r.find("usage-state").hidden).toBe(true);
    expect(r.find("usage-body").hidden).toBe(false);
    expect(r.find("usage-refresh").disabled).toBe(false);

    const volume = r.find("volumes").textContent;
    expect(volume).toContain("Volume holding /s");
    expect(volume).toContain("906.0G used of 953.7G");
    expect(volume).toContain("47.7G free");
    expect(volume).toContain("low on space");
    const fill = r.find("volumes").descendants().find((n) => n.className.includes("meter-fill"))!;
    expect(fill.className).toContain("critical");
    expect(fill.style.width).toBe("95.0%");

    const stats = r.find("usage-stats").textContent;
    expect(stats).toContain("Linked worktrees");
    expect(stats).toContain("in 1 repo");
    expect(stats).toContain("4.8G");
    expect(stats).toContain("1 worktree could not be measured");
    expect(stats).toContain("1.4G");
    expect(stats).toContain("3 finished worktrees");

    const rows = r.find("usage-repos").descendants().filter((n) => n.tagName === "tr");
    expect(rows).toHaveLength(3); // header + the one repo with worktrees + totals
    expect(rows[1]!.textContent).toContain("+1 unmeasured");
    expect(rows[2]!.textContent).toContain("Total");

    const notes = r.find("usage-notes").textContent;
    expect(notes).toContain("1 other repo has no linked worktrees");
    expect(notes).toContain("Skipped: off (");
    expect(notes).toContain("Note: gh is not installed");
    expect(notes).toContain("Nothing on this page removes anything");
    expect(r.find("usage-meta").textContent).toContain("took 42s");
  });

  it("re-measures the usage only when asked, and says so while it waits", async () => {
    let answers = 0;
    const r = await run((url) => {
      if (url.startsWith("/api/usage")) answers += 1;
      return { body: url.startsWith("/api/history") ? history() : usage() };
    });
    expect(answers).toBe(1);
    r.find("usage-refresh").fire("click");
    await r.flush();
    expect(r.calls[r.calls.length - 1]).toBe("/api/usage?refresh=1");
    expect(answers).toBe(2);
  });

  it("says nothing has been removed yet when the log holds no removal", async () => {
    const r = await run((url) => ({
      body: url.startsWith("/api/history")
        ? history({
            since: null, from: null, byDay: [], removals: [], removalsOmitted: 0,
            byRepo: [], totals: { worktrees: 0, reclaimedKb: 0, branches: 0, repos: 0 },
          })
        : usage(),
    }));
    expect(r.find("history-empty").hidden).toBe(false);
    expect(r.find("history-body").hidden).toBe(true);
    expect(r.find("history-empty").textContent).toContain("Nothing removed yet");
    expect(r.find("history-empty").textContent).toContain("/tmp/treekeeper.log");
  });

  it("reports a range with only branch deletions instead of an empty chart", async () => {
    const r = await run((url) => ({
      body: url.startsWith("/api/history")
        ? history({
            totals: { worktrees: 0, reclaimedKb: 0, branches: 12, repos: 1 },
            removals: [], byRepo: [
              {
                repo: "/s/app", name: "app", worktrees: 0, reclaimedKb: 0, branches: 12,
                lastRemovalAt: "2026-11-20T14:00:00.000Z",
              },
            ],
          })
        : usage(),
    }));
    expect(r.find("range-empty").hidden).toBe(true);
    expect(r.find("removals").textContent).toContain("only branches");
    expect(r.find("tiles").textContent).toContain("no worktrees removed");
  });

  it("says which half of the page failed when a data source does not answer", async () => {
    const r = await run((url) =>
      url.startsWith("/api/history")
        ? { status: 500, body: { error: "log unreadable" } }
        : { status: 500, body: { error: "du exploded" } },
    );
    expect(r.find("history-state").hidden).toBe(false);
    expect(r.find("history-state").className).toContain("error");
    expect(r.find("history-state").textContent).toBe(
      "Could not load the removal history: log unreadable",
    );
    expect(r.find("usage-state").textContent).toBe("Could not measure current usage: du exploded");
    expect(r.find("usage-body").hidden).toBe(true);
    // The refresh button is live again, so the page is not stuck.
    expect(r.find("usage-refresh").disabled).toBe(false);
  });

  it("survives a response that is not JSON at all", async () => {
    const r = await run(() => ({ status: 502, unreadable: true }));
    expect(r.find("history-state").textContent).toContain("unreadable response (HTTP 502)");
    expect(r.find("usage-state").textContent).toContain("unreadable response (HTTP 502)");
  });
});
