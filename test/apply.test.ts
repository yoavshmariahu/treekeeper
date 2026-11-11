import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { applyPlan } from "../src/core/apply";
import { listArchives } from "../src/core/archive";
import { defaultConfig } from "../src/core/config";
import type { Config } from "../src/core/config";
import { createForge } from "../src/core/forge";
import { localBranches, listWorktrees } from "../src/core/git";
import { buildPlan } from "../src/core/plan";
import { Logger } from "../src/util/log";
import { git, makeFixture } from "./fixture";
import type { Fixture } from "./fixture";
import { pr, stubForge } from "./stub-forge";
import type { Forge } from "../src/core/forge";

let fx: Fixture;

// Each test gets a fresh repo: these tests destroy things on purpose.
beforeEach(async () => {
  fx = await makeFixture();
}, 120_000);

afterEach(async () => {
  if (fx) await rm(fx.root, { recursive: true, force: true });
});

function config(over: Partial<Config> = {}): Config {
  const base = defaultConfig();
  return {
    ...base,
    roots: [fx.root],
    minAge: "0",
    forge: "none",
    sessions: { ...base.sessions, detectors: [] },
    archive: { ...base.archive, dir: join(fx.root, "archive") },
    logFile: join(fx.root, "treekeeper.log"),
    ...over,
  };
}

async function sweep(cfg = config(), forge?: Forge) {
  const logger = new Logger({ level: "error", file: cfg.logFile });
  const plan = await buildPlan({
    config: cfg,
    repos: [fx.repo],
    forge: forge ?? createForge({ kind: cfg.forge, cacheTtl: cfg.forgeCacheTtl }),
    logger,
    cwd: fx.root,
  });
  const result = await applyPlan({ plan, config: cfg, logger });
  return { plan, result };
}

const exists = async (p: string) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

describe("applyPlan", () => {
  it("removes merged worktrees and leaves unmerged ones alone", async () => {
    const { result } = await sweep();

    expect(await exists(fx.paths.merged)).toBe(false);
    expect(await exists(fx.paths.dirty)).toBe(false);
    expect(await exists(fx.paths.unmerged)).toBe(true);
    expect(await exists(fx.paths.closed)).toBe(true);
    expect(await exists(fx.repo)).toBe(true);

    expect(result.removedWorktrees.map((r) => r.path).sort()).toEqual(
      [fx.paths.dirty, fx.paths.merged].sort(),
    );
    expect(result.failures).toEqual([]);
    expect(result.reclaimedKb).toBeGreaterThan(0);
  });

  it("deregisters the worktrees it removed", async () => {
    await sweep();
    const paths = (await listWorktrees(fx.repo)).map((w) => w.path).sort();
    expect(paths).toEqual([fx.repo, fx.paths.unmerged, fx.paths.closed].sort());
  });

  it("deletes the branch of every removed worktree, plus merged orphan branches", async () => {
    await sweep();
    const names = (await localBranches(fx.repo)).map((b) => b.name).sort();
    expect(names).toEqual(["abandoned", "keepme", "main", "wip"]);
  });

  it("archives uncommitted and untracked work before removing it", async () => {
    const cfg = config();
    await sweep(cfg);

    const archives = await listArchives(cfg.archive.dir);
    const dirtyArchive = archives.find((a) => a.branch === "dirty-merged");
    expect(dirtyArchive, "an archive exists for the dirty worktree").toBeDefined();
    expect(dirtyArchive!.risks).toContain("dirty");

    expect(dirtyArchive!.patch).not.toBeNull();
    const patch = await readFile(dirtyArchive!.patch!.file, "utf8");
    expect(patch).toContain("local edit");

    expect(dirtyArchive!.untracked).not.toBeNull();
    expect(dirtyArchive!.untracked!.count).toBe(1);
    expect(await exists(dirtyArchive!.untracked!.file!)).toBe(true);

    expect(await exists(join(dirtyArchive!.dir, "RESTORE.md"))).toBe(true);
    expect(await readFile(join(dirtyArchive!.dir, "RESTORE.md"), "utf8")).toContain("git apply");
  });

  it("writes a record even when nothing unique was at stake", async () => {
    const cfg = config();
    await sweep(cfg);
    const archives = await listArchives(cfg.archive.dir);
    const clean = archives.find((a) => a.branch === "merged-feat");
    expect(clean).toBeDefined();
    expect(clean!.patch).toBeNull();
    expect(clean!.risks).toEqual([]);
  });

  it("leaves an abandoned branch alone when there is no pull-request data", async () => {
    const { result } = await sweep(config({ onClosedPr: "archive", closedPrGrace: "0" }));
    expect(result.removedWorktrees.map((r) => r.branch)).not.toContain("abandoned");
    expect(await exists(fx.paths.closed)).toBe(true);
  });

  it("reclaims a squash-merged branch that git ancestry cannot see", async () => {
    const tip = await git(fx.paths.unmerged, "rev-parse", "HEAD");
    const { result } = await sweep(
      config(),
      stubForge([pr({ headRefName: "wip", number: 7, state: "MERGED", headRefOid: tip })]),
    );
    expect(result.removedWorktrees.map((r) => r.branch)).toContain("wip");
    expect(await exists(fx.paths.unmerged)).toBe(false);
  });

  it("holds a closed pull request for the grace window, then archives its commits", async () => {
    const tip = await git(fx.paths.closed, "rev-parse", "HEAD");
    const closed = (closedAt: number) =>
      stubForge([pr({ headRefName: "abandoned", number: 9, state: "CLOSED", mergedAt: null, closedAt, headRefOid: tip })]);

    // Closed yesterday: still inside the 7d grace window.
    const held = await sweep(config(), closed(Date.now() - 86_400_000));
    expect(held.result.removedWorktrees.map((r) => r.branch)).not.toContain("abandoned");
    expect(await exists(fx.paths.closed)).toBe(true);

    // Closed a month ago: gone, but its unique commit is bundled first.
    const cfg = config();
    const swept = await sweep(cfg, closed(Date.now() - 30 * 86_400_000));
    expect(swept.result.removedWorktrees.map((r) => r.branch)).toContain("abandoned");
    expect(await exists(fx.paths.closed)).toBe(false);

    const archive = (await listArchives(cfg.archive.dir)).find((a) => a.branch === "abandoned");
    expect(archive?.risks).toContain("closed-pr");
    expect(archive?.bundle?.commits).toBe(1);

    // The bundle really does bring the work back.
    await git(fx.repo, "fetch", archive!.bundle!.file, "refs/heads/abandoned:refs/heads/restored");
    expect(await git(fx.repo, "rev-parse", "refs/heads/restored")).toBe(tip);
  });

  it("archives extra local commits when a merged PR did not contain them", async () => {
    await git(fx.paths.merged, "commit", "--allow-empty", "-m", "extra local work");
    const tip = await git(fx.paths.merged, "rev-parse", "HEAD");
    const cfg = config({ onExtraCommits: "archive" });
    const { result } = await sweep(
      cfg,
      stubForge([
        pr({ headRefName: "merged-feat", number: 3, state: "MERGED", headRefOid: "f".repeat(40) }),
      ]),
    );

    expect(result.removedWorktrees.map((r) => r.branch)).toContain("merged-feat");
    const archive = (await listArchives(cfg.archive.dir)).find((a) => a.branch === "merged-feat");
    expect(archive?.risks).toContain("extra-commits");
    expect(archive?.bundle?.commits).toBe(1);
    await git(fx.repo, "fetch", archive!.bundle!.file, "refs/heads/merged-feat:refs/heads/restored");
    expect(await git(fx.repo, "rev-parse", "refs/heads/restored")).toBe(tip);
  });

  it("refuses to act on a worktree that changed after the plan was built", async () => {
    const cfg = config();
    const logger = new Logger({ level: "error" });
    const plan = await buildPlan({
      config: cfg,
      repos: [fx.repo],
      forge: createForge({ kind: "none", cacheTtl: "10m" }),
      logger,
      cwd: fx.root,
    });

    // An agent starts working in it again between planning and applying.
    await git(fx.paths.merged, "commit", "--allow-empty", "-m", "a new commit");

    const result = await applyPlan({ plan, config: cfg, logger });
    expect(await exists(fx.paths.merged)).toBe(true);
    expect(result.failures.some((f) => f.stage === "reverify")).toBe(true);
  });

  it("logs an audit trail of everything it removed", async () => {
    const cfg = config();
    await sweep(cfg);
    const log = await readFile(cfg.logFile, "utf8");
    const events = log
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { type?: string; path?: string });
    const reclaims = events.filter((e) => e.type === "reclaim");
    expect(reclaims).toHaveLength(2);
    expect(reclaims.map((r) => r.path).sort()).toEqual([fx.paths.dirty, fx.paths.merged].sort());
    expect(events.some((e) => e.type === "branch-delete")).toBe(true);
  });

  it("is a no-op the second time", async () => {
    await sweep();
    const { result } = await sweep();
    expect(result.removedWorktrees).toEqual([]);
    expect(result.deletedBranches).toEqual([]);
    expect(result.failures).toEqual([]);
  });
});
