import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, loadRepoConfig } from "../src/core/config";

async function withConfig(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), "tk-config-"));
  const path = join(dir, "config.json");
  await writeFile(path, contents);
  return { dir, path };
}

describe("loadConfig", () => {
  it("returns defaults when there is no file", async () => {
    const { config, sources } = await loadConfig("/nonexistent/treekeeper/config.json");
    expect(sources).toEqual([]);
    expect(config.minAge).toBe(defaultConfig().minAge);
  });

  it("merges a partial file over the defaults", async () => {
    const { path } = await withConfig(JSON.stringify({ minAge: "2h", pruneBranches: false }));
    const { config } = await loadConfig(path);
    expect(config.minAge).toBe("2h");
    expect(config.pruneBranches).toBe(false);
    expect(config.onDirty).toBe("archive");
  });

  it("tolerates comments and trailing commas", async () => {
    const { path } = await withConfig(`{
      // how long a worktree must sit untouched
      "minAge": "90m", /* inline */
      "roots": ["/tmp/a"],
    }`);
    const { config, warnings } = await loadConfig(path);
    expect(config.minAge).toBe("90m");
    expect(config.roots).toEqual(["/tmp/a"]);
    expect(warnings).toEqual([]);
  });

  it("warns about unknown and mistyped options instead of crashing", async () => {
    const { path } = await withConfig(JSON.stringify({ minAgee: "2h", maxDepth: "three" }));
    const { config, warnings } = await loadConfig(path);
    expect(warnings.some((w) => w.includes("minAgee"))).toBe(true);
    expect(warnings.some((w) => w.includes("maxDepth"))).toBe(true);
    expect(config.maxDepth).toBe(defaultConfig().maxDepth);
  });

  it("rejects an invalid duration rather than treating it as zero", async () => {
    const { path } = await withConfig(JSON.stringify({ minAge: "soon" }));
    const { config, warnings } = await loadConfig(path);
    expect(warnings.some((w) => w.includes("minAge"))).toBe(true);
    expect(config.minAge).toBe(defaultConfig().minAge);
  });

  it("expands ~ in roots and the archive directory", async () => {
    const { path } = await withConfig(JSON.stringify({ roots: ["~/code"] }));
    const { config } = await loadConfig(path);
    expect(config.roots[0]).toMatch(/^\/.*\/code$/);
  });

  it("falls back to defaults for malformed JSON", async () => {
    const { path } = await withConfig("{ not json");
    const { config, warnings } = await loadConfig(path);
    expect(warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
    expect(config.minAge).toBe(defaultConfig().minAge);
  });
});

describe("loadRepoConfig", () => {
  it("layers a repo file over the parent config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tk-repo-"));
    await writeFile(join(dir, ".treekeeper.json"), JSON.stringify({ minAge: "6h", enabled: false }));
    const { config } = await loadRepoConfig(dir, defaultConfig());
    expect(config.minAge).toBe("6h");
    expect(config.enabled).toBe(false);
  });

  it("returns the parent untouched when the repo has no file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tk-repo-"));
    const parent = defaultConfig();
    const { config } = await loadRepoConfig(dir, parent);
    expect(config).toBe(parent);
  });
});
