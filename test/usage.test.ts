import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/core/config";
import type { Config } from "../src/core/config";
import { createForge } from "../src/core/forge";
import type { Plan, RepoPlan, WorktreeCandidate } from "../src/core/plan";
import { buildUsageReport, readVolumes, summarizeUsage } from "../src/core/usage";
import type { VolumeProbe } from "../src/core/usage";
import { Logger } from "../src/util/log";
import { makeFixture } from "./fixture";
import type { Fixture } from "./fixture";

/**
 * `readVolumes` is tested through an injected probe, so no real filesystem is
 * touched; `summarizeUsage` is pure and tested on hand-built plans.
 */

function worktree(over: Partial<WorktreeCandidate> & { path: string }): WorktreeCandidate {
  return {
    repo: "/s/app",
    repoName: "app",
    branch: "feat",
    head: "a".repeat(40),
    sizeKb: null,
    verdict: { action: "keep", reason: "unmerged commits", code: "unmerged", risks: [] },
    merge: { kind: "unmerged", forgeAvailable: false },
    activity: null,
    lastTouched: 0,
    dirty: false,
    dirtyCount: 0,
    ...over,
  };
}

const reclaim = { action: "reclaim", reason: "merged into origin/main", code: "merged", risks: [] } as const;
const main = { action: "keep", reason: "the repo's own checkout", code: "main-worktree", risks: [] } as const;

function repoPlan(over: Partial<RepoPlan> & { repo: string }): RepoPlan {
  return {
    name: over.repo.split("/").pop()!,
    defaultBranch: "main",
    forgeAvailable: false,
    worktrees: [],
    branches: [],
    skipped: null,
    ...over,
  };
}

function plan(repos: RepoPlan[]): Plan {
  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    now: 0,
    roots: ["/s"],
    repos,
    summary: {
      repos: repos.length, worktreesScanned: 0, worktreesReclaimable: 0,
      worktreesKept: 0, branchesDeletable: 0, reclaimKb: 0,
    },
    warnings: [],
  };
}

function branch(name: string) {
  return {
    repo: "/s/app", repoName: "app", name, head: "b".repeat(40),
    verdict: { action: "reclaim" as const, reason: "merged", code: "merged", risks: [] },
    merge: { kind: "no-branch" as const },
  };
}

/** A probe over a made-up filesystem: `devices` maps a path to its volume. */
function probe(
  devices: Record<string, number>,
  volumes: Record<number, { bsize: number; blocks: number; bfree: number; bavail: number }>,
): VolumeProbe {
  return {
    stat: async (path) => {
      const dev = devices[path];
      if (dev === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { dev };
    },
    statfs: async (path) => {
      const fs = volumes[devices[path]!];
      if (!fs) throw new Error("EIO");
      return fs;
    },
  };
}

describe("readVolumes", () => {
  const big = { bsize: 4096, blocks: 1_000_000, bfree: 250_000, bavail: 200_000 };
  const other = { bsize: 1024, blocks: 500, bfree: 100, bavail: 100 };

  it("reports total, used and free space for the volume behind a root", async () => {
    const [v] = await readVolumes(["/Volumes/data"], probe({ "/Volumes/data": 1 }, { 1: big }));
    expect(v).toEqual({
      roots: ["/Volumes/data"],
      totalKb: 4_000_000,
      // Used is what the filesystem has given out (blocks - bfree), while free
      // is what an unprivileged user may still take (bavail).
      usedKb: 3_000_000,
      freeKb: 800_000,
    });
  });

  it("reports one volume once, however many roots live on it", async () => {
    const volumes = await readVolumes(
      ["/s/a", "/s/b", "/s/a", "/elsewhere"],
      probe({ "/s/a": 1, "/s/b": 1, "/elsewhere": 2 }, { 1: big, 2: other }),
    );
    expect(volumes).toHaveLength(2);
    expect(volumes[0]!.roots).toEqual(["/s/a", "/s/b"]);
    expect(volumes[1]!.roots).toEqual(["/elsewhere"]);
    expect(volumes[1]!.totalKb).toBe(500);
  });

  it("leaves out a root that cannot be read instead of failing the report", async () => {
    const volumes = await readVolumes(
      ["/gone", "/s/a", "/unreadable"],
      probe({ "/s/a": 1, "/unreadable": 9 }, { 1: big }),
    );
    expect(volumes.map((v) => v.roots)).toEqual([["/s/a"]]);
  });

  it("never reports negative use when a filesystem reports more free than total", async () => {
    const [v] = await readVolumes(
      ["/s"],
      probe({ "/s": 1 }, { 1: { bsize: 4096, blocks: 10, bfree: 50, bavail: 50 } }),
    );
    expect(v!.usedKb).toBe(0);
  });

  it("has no volume to report when no root exists", async () => {
    expect(await readVolumes([], probe({}, {}))).toEqual([]);
    expect(await readVolumes(["/nope"], probe({}, {}))).toEqual([]);
  });
});

describe("summarizeUsage", () => {
  it("counts the linked worktrees of a repo, their size, and what is reclaimable now", () => {
    const { repos, totals } = summarizeUsage(
      plan([
        repoPlan({
          repo: "/s/app",
          worktrees: [
            worktree({ path: "/s/app", verdict: main, sizeKb: 99_999 }),
            worktree({ path: "/s/app-feat", sizeKb: 300 }),
            worktree({ path: "/s/app-done", sizeKb: 700, verdict: reclaim }),
          ],
          branches: [branch("gone"), branch("also-gone")],
        }),
      ]),
    );
    expect(repos).toEqual([
      {
        repo: "/s/app", name: "app", worktrees: 2, sizeKb: 1000, unmeasured: 0,
        reclaimableWorktrees: 1, reclaimableKb: 700, branchesDeletable: 2,
      },
    ]);
    expect(totals).toEqual({
      repos: 1, worktrees: 2, sizeKb: 1000, unmeasured: 0,
      reclaimableWorktrees: 1, reclaimableKb: 700, branchesDeletable: 2,
    });
  });

  it("takes the size of a worktree the plan did not measure from the injected sizes", () => {
    const { repos } = summarizeUsage(
      plan([
        repoPlan({
          repo: "/s/app",
          worktrees: [worktree({ path: "/s/app-a" }), worktree({ path: "/s/app-b", sizeKb: 5 })],
        }),
      ]),
      new Map([["/s/app-a", 40]]),
    );
    expect(repos[0]!.sizeKb).toBe(45);
    expect(repos[0]!.unmeasured).toBe(0);
  });

  it("keeps a worktree it could not measure out of the sizes without corrupting them", () => {
    const { repos, totals } = summarizeUsage(
      plan([
        repoPlan({
          repo: "/s/app",
          worktrees: [
            worktree({ path: "/s/app-a", sizeKb: 100 }),
            // du failed on this one, and it is also reclaimable.
            worktree({ path: "/s/app-b", verdict: reclaim }),
            worktree({ path: "/s/app-c" }),
          ],
        }),
      ]),
      new Map([["/s/app-b", null]]),
    );
    expect(repos[0]!.worktrees).toBe(3);
    expect(repos[0]!.sizeKb).toBe(100);
    expect(repos[0]!.unmeasured).toBe(2);
    expect(repos[0]!.reclaimableWorktrees).toBe(1);
    expect(repos[0]!.reclaimableKb).toBe(0);
    expect(Number.isFinite(totals.sizeKb)).toBe(true);
    expect(totals).toEqual({
      repos: 1, worktrees: 3, sizeKb: 100, unmeasured: 2,
      reclaimableWorktrees: 1, reclaimableKb: 0, branchesDeletable: 0,
    });
  });

  it("leaves each repo's own checkout out of the counts, so its worktrees are not counted twice", () => {
    const { repos, totals } = summarizeUsage(
      plan([
        repoPlan({
          repo: "/s/app",
          worktrees: [worktree({ path: "/s/app", verdict: main, sizeKb: 1_000_000 })],
        }),
      ]),
    );
    expect(repos[0]!.worktrees).toBe(0);
    expect(repos[0]!.sizeKb).toBe(0);
    expect(totals.worktrees).toBe(0);
    expect(totals.repos).toBe(1);
  });

  it("sets a skipped repo aside with its reason and counts none of it", () => {
    const { repos, skipped, totals } = summarizeUsage(
      plan([
        repoPlan({
          repo: "/s/off",
          skipped: "disabled in .treekeeper.json",
          worktrees: [worktree({ path: "/s/off-a", sizeKb: 500, verdict: reclaim })],
          branches: [branch("x")],
        }),
        repoPlan({ repo: "/s/app", worktrees: [worktree({ path: "/s/app-a", sizeKb: 1 })] }),
      ]),
    );
    expect(skipped).toEqual([{ repo: "/s/off", name: "off", reason: "disabled in .treekeeper.json" }]);
    expect(repos.map((r) => r.repo)).toEqual(["/s/app"]);
    expect(totals).toEqual({
      repos: 1, worktrees: 1, sizeKb: 1, unmeasured: 0,
      reclaimableWorktrees: 0, reclaimableKb: 0, branchesDeletable: 0,
    });
  });

  it("puts the repos that hold the most disk first", () => {
    const { repos, totals } = summarizeUsage(
      plan([
        repoPlan({ repo: "/s/small", worktrees: [worktree({ path: "/s/small-a", sizeKb: 10 })] }),
        repoPlan({ repo: "/s/huge", worktrees: [worktree({ path: "/s/huge-a", sizeKb: 9000 })] }),
        repoPlan({ repo: "/s/quiet" }),
        repoPlan({ repo: "/s/medium", worktrees: [worktree({ path: "/s/medium-a", sizeKb: 500 })] }),
        // Same size as /s/medium: more worktrees wins, then the name.
        repoPlan({
          repo: "/s/busy",
          worktrees: [
            worktree({ path: "/s/busy-a", sizeKb: 250 }),
            worktree({ path: "/s/busy-b", sizeKb: 250 }),
          ],
        }),
      ]),
    );
    expect(repos.map((r) => r.name)).toEqual(["huge", "busy", "medium", "small", "quiet"]);
    expect(totals.repos).toBe(5);
    expect(totals.sizeKb).toBe(10_010);
  });

  it("is reachable from the package entry point, alongside the plan it summarizes", async () => {
    const api = await import("../src/index");
    expect(typeof api.buildUsageReport).toBe("function");
    expect(typeof api.summarizeUsage).toBe("function");
    expect(typeof api.readVolumes).toBe("function");
    expect(api.summarizeUsage(plan([repoPlan({ repo: "/s/app" })])).totals.repos).toBe(1);
  });

  it("always has totals that are the sum of the rows it shows", () => {
    const sizes = new Map<string, number | null>();
    const repos: RepoPlan[] = [];
    for (let i = 0; i < 25; i += 1) {
      const worktrees: WorktreeCandidate[] = [worktree({ path: `/s/r${i}`, verdict: main, sizeKb: 1234 })];
      for (let w = 0; w < i % 5; w += 1) {
        const path = `/s/r${i}-${w}`;
        const measured = (i + w) % 3 !== 0;
        if (!measured) sizes.set(path, null);
        worktrees.push(
          worktree({
            path,
            sizeKb: measured ? (i + 1) * (w + 1) * 11 : null,
            ...(w % 2 === 0 ? { verdict: reclaim } : {}),
          }),
        );
      }
      repos.push(
        repoPlan({
          repo: `/s/r${i}`,
          skipped: i % 7 === 6 ? "unreadable" : null,
          worktrees,
          branches: Array.from({ length: i % 3 }, (_, b) => branch(`b${b}`)),
        }),
      );
    }
    const { repos: rows, totals, skipped } = summarizeUsage(plan(repos), sizes);
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0);
    expect(totals.repos).toBe(rows.length);
    expect(rows.length + skipped.length).toBe(25);
    expect(totals.worktrees).toBe(sum((r) => r.worktrees));
    expect(totals.sizeKb).toBe(sum((r) => r.sizeKb));
    expect(totals.unmeasured).toBe(sum((r) => r.unmeasured));
    expect(totals.reclaimableWorktrees).toBe(sum((r) => r.reclaimableWorktrees));
    expect(totals.reclaimableKb).toBe(sum((r) => r.reclaimableKb));
    expect(totals.branchesDeletable).toBe(sum((r) => r.branchesDeletable));
    for (const row of rows) {
      expect(row.reclaimableWorktrees).toBeLessThanOrEqual(row.worktrees);
      expect(row.reclaimableKb).toBeLessThanOrEqual(row.sizeKb);
    }
  });
});

describe("buildUsageReport on a real repo", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await makeFixture();
  }, 120_000);

  afterAll(async () => {
    if (fx) await rm(fx.root, { recursive: true, force: true });
  });

  function config(): Config {
    const base = defaultConfig();
    return {
      ...base,
      roots: [fx.root],
      minAge: "0",
      forge: "none",
      sessions: { ...base.sessions, detectors: [] },
      archive: { ...base.archive, dir: join(fx.root, "archive") },
      logFile: join(fx.root, "treekeeper.log"),
    };
  }

  it("reports every linked worktree with its size, and leaves them all on disk", async () => {
    const measured: string[] = [];
    const cfg = config();
    const report = await buildUsageReport({
      config: cfg,
      forge: createForge({ kind: "none", cacheTtl: "10m" }),
      logger: new Logger({ level: "error" }),
      measure: async (path) => {
        measured.push(path);
        return 64;
      },
    });

    expect(report.version).toBe(1);
    expect(report.roots).toEqual([fx.root]);
    expect(report.volumes).toHaveLength(1);
    expect(report.volumes[0]!.totalKb).toBeGreaterThan(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);

    const row = report.repos.find((r) => r.repo === fx.repo)!;
    // merged, unmerged, dirty, closed — the main checkout is not counted.
    expect(row.worktrees).toBe(4);
    expect(row.unmeasured).toBe(0);
    expect(row.sizeKb).toBeGreaterThan(0);
    expect(row.reclaimableWorktrees).toBe(2);
    expect(row.branchesDeletable).toBe(1);
    expect(report.totals.worktrees).toBe(4);
    // The plan sized what it would reclaim; `measure` filled in the rest, and
    // never ran on the main checkout.
    expect(measured).not.toContain(fx.repo);
    expect(measured.sort()).toEqual([fx.paths.closed, fx.paths.unmerged].sort());

    for (const path of Object.values(fx.paths)) expect(existsSync(path)).toBe(true);
    expect(existsSync(join(fx.root, "archive"))).toBe(false);
  });

  it("gives up a measurement that is aborted mid-flight", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(
      buildUsageReport({
        config: config(),
        forge: createForge({ kind: "none", cacheTtl: "10m" }),
        logger: new Logger({ level: "error" }),
        signal: stop.signal,
        measure: async () => 1,
      }),
    ).rejects.toThrow();
  });
});
