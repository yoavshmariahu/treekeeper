import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { defaultConfig } from "../src/core/config";
import type { Config } from "../src/core/config";
import { buildPlan } from "../src/core/plan";
import type { Plan } from "../src/core/plan";
import { createForge } from "../src/core/forge";
import { discoverRepos } from "../src/core/scan";
import { Logger } from "../src/util/log";
import { makeFixture } from "./fixture";
import type { Fixture } from "./fixture";

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture();
}, 120_000);

afterAll(async () => {
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

async function plan(cfg = config()): Promise<Plan> {
  return buildPlan({
    config: cfg,
    repos: [fx.repo],
    forge: createForge({ kind: cfg.forge, cacheTtl: cfg.forgeCacheTtl }),
    logger: new Logger({ level: "error" }),
    cwd: fx.root,
  });
}

const forPath = (p: Plan, path: string) =>
  p.repos[0]!.worktrees.find((w) => w.path === path)!;

describe("discoverRepos", () => {
  it("finds the main repo once, from the clone and from its worktrees", async () => {
    const repos = await discoverRepos({ roots: [fx.root], maxDepth: 2 });
    expect(repos).toEqual([fx.repo]);
  });
});

describe("buildPlan on a real repo", () => {
  it("keeps the main worktree", async () => {
    const p = await plan();
    const main = forPath(p, fx.repo);
    expect(main.verdict.action).toBe("keep");
    expect(main.verdict.code).toBe("main-worktree");
  });

  it("reclaims a worktree whose branch is merged into the default branch", async () => {
    const w = forPath(await plan(), fx.paths.merged);
    expect(w.verdict.action).toBe("reclaim");
    expect(w.verdict.reason).toMatch(/merged into (origin\/)?main/);
    expect(w.sizeKb).toBeGreaterThan(0);
  });

  it("keeps a worktree with unmerged commits", async () => {
    const w = forPath(await plan(), fx.paths.unmerged);
    expect(w.verdict.action).toBe("keep");
    expect(w.verdict.code).toBe("unmerged");
  });

  it("keeps an unmerged worktree even with --force", async () => {
    const p = await buildPlan({
      config: config(),
      repos: [fx.repo],
      forge: createForge({ kind: "none", cacheTtl: "10m" }),
      logger: new Logger({ level: "error" }),
      cwd: fx.root,
      force: true,
    });
    expect(forPath(p, fx.paths.unmerged).verdict.action).toBe("keep");
  });

  it("flags a merged worktree with uncommitted changes for archiving", async () => {
    const w = forPath(await plan(), fx.paths.dirty);
    expect(w.verdict.action).toBe("reclaim");
    expect(w.verdict.risks).toContain("dirty");
    expect(w.dirty).toBe(true);
  });

  it("keeps the same worktree when onDirty is keep", async () => {
    const w = forPath(await plan(config({ onDirty: "keep" })), fx.paths.dirty);
    expect(w.verdict.action).toBe("keep");
    expect(w.verdict.code).toBe("dirty");
  });

  it("holds every worktree back while minAge has not elapsed", async () => {
    const p = await plan(config({ minAge: "7d" }));
    expect(p.summary.worktreesReclaimable).toBe(0);
    expect(forPath(p, fx.paths.merged).verdict.code).toBe("too-young");
  });

  it("deletes merged branches with no worktree, and only those", async () => {
    const names = (await plan()).repos[0]!.branches.map((b) => b.name);
    expect(names).toContain("stale-merged");
    expect(names).not.toContain("keepme");
    expect(names).not.toContain("wip");
    expect(names).not.toContain("main");
    // Branches removed together with their worktree are not listed twice.
    expect(names).not.toContain("merged-feat");
  });

  it("leaves branches alone with --worktrees-only (pruneBranches: false)", async () => {
    const p = await plan(config({ pruneBranches: false }));
    expect(p.repos[0]!.branches).toEqual([]);
  });

  it("leaves worktrees alone with --branches-only", async () => {
    const p = await buildPlan({
      config: config(),
      repos: [fx.repo],
      forge: createForge({ kind: "none", cacheTtl: "10m" }),
      logger: new Logger({ level: "error" }),
      cwd: fx.root,
      skipWorktrees: true,
    });
    expect(p.summary.worktreesReclaimable).toBe(0);
    expect(p.repos[0]!.branches.map((b) => b.name)).toContain("stale-merged");
  });

  it("protects a worktree whose path is in protectPaths", async () => {
    const w = forPath(await plan(config({ protectPaths: [fx.paths.merged] })), fx.paths.merged);
    expect(w.verdict.code).toBe("protected-path");
  });

  it("protects a branch matched by a protectBranches glob", async () => {
    const w = forPath(await plan(config({ protectBranches: ["merged-*"] })), fx.paths.merged);
    expect(w.verdict.code).toBe("protected-branch");
  });

  it("never reclaims the worktree holding the caller's cwd", async () => {
    const p = await buildPlan({
      config: config(),
      repos: [fx.repo],
      forge: createForge({ kind: "none", cacheTtl: "10m" }),
      logger: new Logger({ level: "error" }),
      cwd: join(fx.paths.merged, "nested", "dir"),
    });
    expect(forPath(p, fx.paths.merged).verdict.code).toBe("cwd");
  });

  it("respects a repo-level .treekeeper.json opt-out", async () => {
    const { writeFile, rm: remove } = await import("node:fs/promises");
    const path = join(fx.repo, ".treekeeper.json");
    await writeFile(path, JSON.stringify({ enabled: false }));
    try {
      const p = await plan();
      expect(p.repos[0]!.skipped).toContain("disabled");
      expect(p.summary.worktreesReclaimable).toBe(0);
    } finally {
      await remove(path, { force: true });
    }
  });

  it("summarises what it would do", async () => {
    const s = (await plan()).summary;
    expect(s.repos).toBe(1);
    expect(s.worktreesReclaimable).toBe(2); // merged + dirty-merged
    expect(s.worktreesKept).toBe(2); // wip + abandoned
    expect(s.reclaimKb).toBeGreaterThan(0);
  });
});
