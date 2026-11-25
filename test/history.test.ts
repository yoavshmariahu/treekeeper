import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHistoryReport, isHistoryRange, parseLogLine, readRemovalEvents } from "../src/core/history";
import type { HistoryOptions, HistoryRange, RemovalEvent } from "../src/core/history";

/**
 * The log these tests read is written by `Logger.event`: one JSON object per
 * line, `reclaim` for a removed worktree and `branch-delete` for a branch
 * pruned on its own, mixed in with debug and warn lines.
 */

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-20T15:30:00.000Z");

function reclaimLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: "2026-11-20T10:00:00.000Z",
    level: "info",
    type: "reclaim",
    path: "/Users/dev/src/app-feat",
    repo: "/Users/dev/src/app",
    branch: "feat/thing",
    sizeKb: 1024,
    reason: "merged into origin/main",
    risks: [],
    archive: null,
    ...over,
  });
}

function branchLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: "2026-11-20T10:05:00.000Z",
    level: "info",
    type: "branch-delete",
    repo: "/Users/dev/src/app",
    branch: "old/thing",
    reason: "merged into origin/main",
    archive: null,
    ...over,
  });
}

function noise(): string[] {
  return [
    JSON.stringify({ ts: "2026-11-20T09:00:00.000Z", level: "debug", msg: "scan 12 repos" }),
    JSON.stringify({ ts: "2026-11-20T09:00:01.000Z", level: "warn", msg: "gh not available" }),
    JSON.stringify({ ts: "2026-11-20T09:00:02.000Z", level: "info", type: "skip", reason: "would reclaim, but dirty" }),
    JSON.stringify({ ts: "2026-11-20T09:00:03.000Z", level: "info", type: "archive-pruned", count: 3 }),
    JSON.stringify({ ts: "2026-11-20T09:00:04.000Z", level: "info", type: "sweep", worktrees: 2 }),
    "",
    "   ",
  ];
}

function event(over: Partial<RemovalEvent> = {}): RemovalEvent {
  return {
    kind: "worktree",
    at: NOW - 3600_000,
    repo: "/Users/dev/src/app",
    path: "/Users/dev/src/app-feat",
    branch: "feat",
    sizeKb: 1024,
    reason: "merged",
    archived: false,
    ...over,
  };
}

function report(events: readonly RemovalEvent[], over: Partial<HistoryOptions> = {}) {
  return buildHistoryReport(events, { now: NOW, range: "all", ...over });
}

async function withLog(body: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "treekeeper-history-"));
  try {
    await body(join(dir, "treekeeper.log"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("parseLogLine", () => {
  it("reads a removed worktree out of a reclaim line", () => {
    const e = parseLogLine(reclaimLine({ archive: "/Users/dev/.treekeeper/archive/app-feat" }))!;
    expect(e).toEqual({
      kind: "worktree",
      at: Date.parse("2026-11-20T10:00:00.000Z"),
      repo: "/Users/dev/src/app",
      path: "/Users/dev/src/app-feat",
      branch: "feat/thing",
      sizeKb: 1024,
      reason: "merged into origin/main",
      archived: true,
    });
  });

  it("reads a pruned branch as a removal that freed no disk and has no path", () => {
    const e = parseLogLine(branchLine())!;
    expect(e.kind).toBe("branch");
    expect(e.path).toBeNull();
    expect(e.sizeKb).toBe(0);
    expect(e.branch).toBe("old/thing");
    expect(e.archived).toBe(false);
  });

  it("ignores every log line that is not a removal", () => {
    for (const line of noise()) expect(parseLogLine(line)).toBeNull();
  });

  it("never throws on a log that ends mid-line: every truncation of a removal is skipped", () => {
    for (const line of [reclaimLine(), branchLine()]) {
      for (let i = 0; i < line.length; i += 1) {
        const prefix = line.slice(0, i);
        expect(() => parseLogLine(prefix)).not.toThrow();
        expect(parseLogLine(prefix)).toBeNull();
      }
      expect(parseLogLine(line)).not.toBeNull();
    }
  });

  it("never throws on malformed, hostile or wrongly typed lines", () => {
    const lines = [
      '["reclaim"]',
      '"reclaim"',
      '{"type":"reclaim"',
      '{"type":"reclaim","ts":123}',
      '{"type":"reclaim","ts":"not a date","repo":"/r","path":"/p"}',
      '{"type":"reclaim","ts":"1970-01-01T00:00:00.000Z","repo":"/r","path":"/p"}',
      '{"type":"reclaim","ts":"2026-11-20T10:00:00.000Z","repo":"","path":"/p"}',
      '{"type":"reclaim","ts":"2026-11-20T10:00:00.000Z","repo":"/r"}',
      '{"type":"reclaim","ts":"2026-11-20T10:00:00.000Z","repo":"/r","path":""}',
      '{"type":"branch-delete","ts":"2026-11-20T10:00:00.000Z","repo":"/r"}',
      '{"type":"branch-delete","ts":"2026-11-20T10:00:00.000Z","repo":"/r","branch":""}',
      '{"type":"branch-delete","ts":"2026-11-20T10:00:00.000Z","repo":"/r","branch":{"x":1}}',
      reclaimLine({ repo: 7 }),
      reclaimLine({ path: ["/p"] }),
      '\u0000"reclaim"\u0000',
      '{"type":"reclaim","ts":"2026-11-20T10:00:00.000Z","repo":"/r","path":"/p","sizeKb":{"a":[1,2,{"b":"reclaim"}]}}'.slice(0, 60),
    ];
    for (const line of lines) {
      expect(() => parseLogLine(line), line).not.toThrow();
      expect(parseLogLine(line), line).toBeNull();
    }
  });

  it("counts a size it cannot trust as zero rather than letting NaN into the totals", () => {
    for (const sizeKb of [undefined, null, -5, "big", Number.NaN, {}]) {
      const e = parseLogLine(reclaimLine({ sizeKb }))!;
      expect(e.sizeKb, JSON.stringify(sizeKb ?? null)).toBe(0);
    }
    expect(parseLogLine(reclaimLine({ sizeKb: 2048 }))!.sizeKb).toBe(2048);
  });

  it("keeps a detached worktree's removal, with no branch to show", () => {
    expect(parseLogLine(reclaimLine({ branch: null }))!.branch).toBeNull();
    expect(parseLogLine(reclaimLine({ branch: "" }))!.branch).toBeNull();
  });
});

describe("readRemovalEvents", () => {
  it("reads every removal from a log of mostly unrelated lines, in file order", async () => {
    await withLog(async (file) => {
      const lines = [...noise(), reclaimLine({ ts: "2026-11-18T10:00:00.000Z" }), ...noise(), branchLine(), ...noise()];
      await writeFile(file, lines.join("\n") + "\n");
      const events = await readRemovalEvents(file);
      expect(events.map((e) => e.kind)).toEqual(["worktree", "branch"]);
      expect(events[0]!.at).toBe(Date.parse("2026-11-18T10:00:00.000Z"));
    });
  });

  it("reads the last removal of a log that ends without a newline", async () => {
    await withLog(async (file) => {
      await writeFile(file, noise().join("\n") + "\n" + reclaimLine());
      expect(await readRemovalEvents(file)).toHaveLength(1);
    });
  });

  it("skips a log truncated mid-line and keeps every removal before it", async () => {
    await withLog(async (file) => {
      await writeFile(file, reclaimLine() + "\n" + branchLine() + "\n" + reclaimLine().slice(0, 70));
      const events = await readRemovalEvents(file);
      expect(events.map((e) => e.kind)).toEqual(["worktree", "branch"]);
    });
  });

  it("reads removals that straddle the stream's 1 MB chunk boundary, multi-byte names included", async () => {
    await withLog(async (file) => {
      const pad = (n: number): string =>
        JSON.stringify({ ts: "2026-11-20T09:00:00.000Z", level: "debug", msg: "x".repeat(n) });
      const chunk = 1 << 20;
      let text = "";
      const want: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        // Land a removal line right on each chunk boundary.
        while (text.length < chunk * (i + 1) - 40) text += pad(500) + "\n";
        const branch = `féature/é\u{1f333}-${i}`;
        want.push(branch);
        text += reclaimLine({ branch, sizeKb: 100 + i }) + "\n";
      }
      await writeFile(file, text);
      const events = await readRemovalEvents(file);
      expect(events.map((e) => e.branch)).toEqual(want);
      expect(events.map((e) => e.sizeKb)).toEqual([100, 101, 102, 103, 104, 105]);
    });
  });

  it("treats a log that does not exist yet as an empty history, not an error", async () => {
    await withLog(async (file) => {
      expect(await readRemovalEvents(file)).toEqual([]);
    });
  });
});

describe("buildHistoryReport", () => {
  it("counts a range as whole calendar days ending today", () => {
    const edge = Date.parse("2026-11-14T00:00:00.000Z");
    const r = report([event({ at: edge }), event({ at: edge - 1 })], { range: "7d" });
    expect(r.totals.worktrees).toBe(1);
    expect(r.byDay).toHaveLength(7);
    expect(r.byDay[0]!.day).toBe("2026-11-14");
    expect(r.byDay[6]!.day).toBe("2026-11-20");
    expect(r.from).toBe("2026-11-14T00:00:00.000Z");
    expect(r.to).toBe(new Date(NOW).toISOString());
    expect(report([], { range: "30d" }).byDay).toHaveLength(30);
  });

  it("cuts days at the given UTC offset instead of at UTC", () => {
    const at = Date.parse("2026-11-20T02:30:00.000Z");
    const west = report([event({ at })], { range: "7d", utcOffsetMinutes: -480 });
    expect(west.byDay.map((d) => d.day).slice(-2)).toEqual(["2026-11-19", "2026-11-20"]);
    expect(west.byDay.find((d) => d.day === "2026-11-19")!.worktrees).toBe(1);
    expect(west.from).toBe("2026-11-14T08:00:00.000Z");
    expect(west.utcOffsetMinutes).toBe(-480);

    const utc = report([event({ at })], { range: "7d" });
    expect(utc.byDay.find((d) => d.day === "2026-11-20")!.worktrees).toBe(1);
  });

  it("keeps empty days in the per-day series, so the chart has no gaps", () => {
    const r = report(
      [
        event({ at: Date.parse("2026-11-16T12:00:00.000Z"), sizeKb: 10 }),
        event({ at: Date.parse("2026-11-20T12:00:00.000Z"), sizeKb: 20 }),
      ],
      { range: "7d" },
    );
    expect(r.byDay.map((d) => d.day)).toEqual([
      "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20",
    ]);
    expect(r.byDay.map((d) => d.reclaimedKb)).toEqual([0, 0, 10, 0, 0, 0, 20]);
    expect(r.byDay.map((d) => d.worktrees)).toEqual([0, 0, 1, 0, 0, 0, 1]);
  });

  it("excludes events in the future of now", () => {
    const r = report([event({ at: NOW }), event({ at: NOW + 1 }), event({ at: NOW + 7 * DAY_MS })], {
      range: "7d",
    });
    expect(r.totals.worktrees).toBe(1);
    expect(r.byDay).toHaveLength(7);
    expect(r.byDay[6]!.day).toBe("2026-11-20");
  });

  it("caps the list of removals without losing them from the totals", () => {
    const events = Array.from({ length: 612 }, (_, i) =>
      event({ at: NOW - i * 60_000, sizeKb: 10, path: `/Users/dev/src/app-${i}` }),
    );
    const r = report(events, { range: "all" });
    expect(r.removals).toHaveLength(500);
    expect(r.removalsOmitted).toBe(112);
    expect(r.totals.worktrees).toBe(612);
    expect(r.totals.reclaimedKb).toBe(6120);
    // The cap keeps the newest, and the series still counts all of them.
    expect(r.removals[0]!.path).toBe("/Users/dev/src/app-0");
    expect(r.byDay.reduce((n, d) => n + d.worktrees, 0)).toBe(612);

    const none = report(events, { range: "all", maxRemovals: 0 });
    expect(none.removals).toEqual([]);
    expect(none.removalsOmitted).toBe(612);
    expect(none.totals.worktrees).toBe(612);
  });

  it("lists removed worktrees newest first, with the repo name, path, reason and archive flag", () => {
    const r = report([
      event({ at: NOW - 2 * 3600_000, repo: "/Users/dev/src/one", path: "/Users/dev/src/one-a", reason: "old" }),
      event({
        at: NOW - 3600_000, repo: "/Users/dev/src/two", path: "/Users/dev/src/two-b",
        branch: null, sizeKb: 7, reason: "pr merged", archived: true,
      }),
      event({ kind: "branch", at: NOW, repo: "/Users/dev/src/one", path: null, branch: "gone", sizeKb: 0 }),
    ]);
    expect(r.removals).toEqual([
      {
        at: new Date(NOW - 3600_000).toISOString(), repo: "/Users/dev/src/two", name: "two",
        path: "/Users/dev/src/two-b", branch: null, sizeKb: 7, reason: "pr merged", archived: true,
      },
      {
        at: new Date(NOW - 2 * 3600_000).toISOString(), repo: "/Users/dev/src/one", name: "one",
        path: "/Users/dev/src/one-a", branch: "feat", sizeKb: 1024, reason: "old", archived: false,
      },
    ]);
  });

  it("breaks the range down by repo, largest reclaim first, with each repo's last removal", () => {
    const r = report([
      event({ at: NOW - 5 * 60_000, repo: "/Users/dev/src/small", sizeKb: 10 }),
      event({ at: NOW - 4 * 60_000, repo: "/Users/dev/src/big", sizeKb: 4000 }),
      event({ at: NOW - 3 * 60_000, repo: "/Users/dev/src/big", sizeKb: 1000 }),
      event({ kind: "branch", at: NOW - 60_000, repo: "/Users/dev/src/branchy", path: null, sizeKb: 0 }),
      event({ kind: "branch", at: NOW - 2 * 60_000, repo: "/Users/dev/src/big", path: null, sizeKb: 0 }),
    ]);
    expect(r.byRepo.map((x) => [x.name, x.worktrees, x.reclaimedKb, x.branches])).toEqual([
      ["big", 2, 5000, 1],
      ["small", 1, 10, 0],
      ["branchy", 0, 0, 1],
    ]);
    expect(r.byRepo[0]!.lastRemovalAt).toBe(new Date(NOW - 2 * 60_000).toISOString());
    expect(r.byRepo[0]!.repo).toBe("/Users/dev/src/big");
    expect(r.totals).toEqual({ worktrees: 3, reclaimedKb: 5010, branches: 2, repos: 3 });
  });

  it("reports the whole log for the all-time range, and says when nothing was ever removed", () => {
    const old = Date.parse("2026-01-02T03:04:05.000Z");
    const r = report([event({ at: old, sizeKb: 5 }), event({ at: NOW, sizeKb: 6 })]);
    expect(r.range).toBe("all");
    expect(r.since).toBe(new Date(old).toISOString());
    expect(r.from).toBe("2026-01-02T00:00:00.000Z");
    expect(r.totals.reclaimedKb).toBe(11);
    expect(r.byDay).toHaveLength(Math.floor(NOW / DAY_MS) - Math.floor(old / DAY_MS) + 1);

    const empty = report([]);
    expect(empty.since).toBeNull();
    expect(empty.from).toBeNull();
    expect(empty.byDay).toEqual([]);
    expect(empty.removals).toEqual([]);
    expect(empty.totals).toEqual({ worktrees: 0, reclaimedKb: 0, branches: 0, repos: 0 });
    expect(empty.version).toBe(1);
    expect(empty.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it("dates the log from the oldest removal even when the range is shorter", () => {
    const r = report([event({ at: Date.parse("2025-06-01T00:00:00.000Z") }), event({ at: NOW })], {
      range: "7d",
    });
    expect(r.since).toBe("2025-06-01T00:00:00.000Z");
    expect(r.totals.worktrees).toBe(1);
  });

  it("is reachable from the package entry point, for a harness that reports in-process", async () => {
    const api = await import("../src/index");
    expect(typeof api.parseLogLine).toBe("function");
    expect(typeof api.readRemovalEvents).toBe("function");
    expect(typeof api.buildHistoryReport).toBe("function");
    expect(typeof api.isHistoryRange).toBe("function");
    expect(api.HISTORY_RANGES).toEqual(["7d", "30d", "all"]);
    expect(api.buildHistoryReport([event()], { now: NOW, range: "all" }).totals.worktrees).toBe(1);
  });

  it("accepts only the three ranges the dashboard offers", () => {
    expect(["7d", "30d", "all"].every(isHistoryRange)).toBe(true);
    for (const bad of ["1d", "7D", "", "all-time", 7, null, undefined]) {
      expect(isHistoryRange(bad), String(bad)).toBe(false);
    }
  });

  it("counts exactly the same events in the totals, the repo rows, the per-day series and the list", () => {
    const ranges: HistoryRange[] = ["7d", "30d", "all"];
    const repos = ["/s/alpha", "/s/beta", "/s/gamma", "/s/delta", "/s/alpha"];

    for (let seed = 1; seed <= 150; seed += 1) {
      const rand = mulberry32(seed);
      const events: RemovalEvent[] = [];
      for (let i = 0, n = Math.floor(rand() * 90); i < n; i += 1) {
        const future = rand() < 0.12;
        const span = rand() < 0.3 ? 400 * DAY_MS : 40 * DAY_MS;
        const at = future ? NOW + Math.floor(rand() * span) : NOW - Math.floor(rand() * span);
        const worktree = rand() < 0.6;
        events.push({
          kind: worktree ? "worktree" : "branch",
          at,
          repo: repos[Math.floor(rand() * repos.length)]!,
          path: worktree ? `/s/wt-${i}` : null,
          branch: rand() < 0.9 ? `b-${i}` : null,
          sizeKb: worktree ? Math.floor(rand() * 3_000_000) : 0,
          reason: "merged",
          archived: rand() < 0.2,
        });
      }

      const range = ranges[seed % 3]!;
      const offset = [0, -480, 330, 60][seed % 4]!;
      const maxRemovals = [500, 3, 0, 20][seed % 4]!;
      const r = buildHistoryReport(events, { now: NOW, range, utcOffsetMinutes: offset, maxRemovals });
      const where = `seed ${seed} range ${range} offset ${offset}`;

      // An independent count of the events the window should hold.
      const dayOf = (at: number): number => Math.floor((at + offset * 60_000) / DAY_MS);
      const days = r.byDay.map((d) => d.day);
      const counted = events.filter((e) => e.at <= NOW && days.includes(dayLabel(dayOf(e.at))));
      const wantWorktrees = counted.filter((e) => e.kind === "worktree");
      expect(r.totals.worktrees, where).toBe(wantWorktrees.length);
      expect(r.totals.branches, where).toBe(counted.length - wantWorktrees.length);
      expect(r.totals.reclaimedKb, where).toBe(wantWorktrees.reduce((n, e) => n + e.sizeKb, 0));
      expect(r.totals.repos, where).toBe(new Set(counted.map((e) => e.repo)).size);

      // The four views of that same window agree with each other.
      const sum = (f: (d: { worktrees: number; reclaimedKb: number; branches: number }) => number) =>
        r.byDay.reduce((n, d) => n + f(d), 0);
      expect(sum((d) => d.worktrees), where).toBe(r.totals.worktrees);
      expect(sum((d) => d.branches), where).toBe(r.totals.branches);
      expect(sum((d) => d.reclaimedKb), where).toBe(r.totals.reclaimedKb);
      expect(r.byRepo.reduce((n, x) => n + x.worktrees, 0), where).toBe(r.totals.worktrees);
      expect(r.byRepo.reduce((n, x) => n + x.branches, 0), where).toBe(r.totals.branches);
      expect(r.byRepo.reduce((n, x) => n + x.reclaimedKb, 0), where).toBe(r.totals.reclaimedKb);
      expect(r.byRepo).toHaveLength(r.totals.repos);
      expect(r.removals.length + r.removalsOmitted, where).toBe(r.totals.worktrees);
      if (r.removalsOmitted === 0) {
        expect(r.removals.reduce((n, x) => n + x.sizeKb, 0), where).toBe(r.totals.reclaimedKb);
      }

      // The window itself: contiguous calendar days ending today, every listed
      // removal inside it, and nothing newer than `now`.
      const past = events.filter((e) => e.at <= NOW);
      const oldest = past.length === 0 ? null : Math.min(...past.map((e) => e.at));
      expect(r.since, where).toBe(oldest === null ? null : new Date(oldest).toISOString());
      if (range === "all") {
        // All-time starts on the day of the oldest removal, so every event counts.
        expect(days.length > 0, where).toBe(oldest !== null);
        if (oldest !== null) expect(days[0], where).toBe(dayLabel(dayOf(oldest)));
        expect(counted.length, where).toBe(past.length);
      }
      if (days.length > 0) {
        expect(days[days.length - 1], where).toBe(dayLabel(dayOf(NOW)));
        if (range !== "all") expect(days.length, where).toBe(range === "7d" ? 7 : 30);
        for (let i = 1; i < days.length; i += 1) {
          expect(Date.parse(days[i]!) - Date.parse(days[i - 1]!), where).toBe(DAY_MS);
        }
      }
      let previous = Infinity;
      for (const entry of r.removals) {
        const at = Date.parse(entry.at);
        expect(at, where).toBeLessThanOrEqual(NOW);
        expect(at, where).toBeLessThanOrEqual(previous);
        previous = at;
        expect(days, where).toContain(dayLabel(dayOf(at)));
        expect(r.byRepo.find((x) => x.repo === entry.repo)!.worktrees, where).toBeGreaterThan(0);
      }
    }
  });
});

function dayLabel(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

/** A small deterministic PRNG, so a failure is always reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
