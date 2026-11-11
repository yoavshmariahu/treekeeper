import { describe, expect, it } from "vitest";
import { parseWorktreeList } from "../src/core/git";

describe("parseWorktreeList", () => {
  it("parses the main worktree, branches, detached and locked entries", () => {
    const porcelain = [
      "worktree /Users/me/src/app",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /Users/me/src/app-feature",
      "HEAD def456",
      "branch refs/heads/feature/login",
      "",
      "worktree /Users/me/src/app-detached",
      "HEAD 999aaa",
      "detached",
      "",
      "worktree /Users/me/src/app-locked",
      "HEAD 777bbb",
      "branch refs/heads/wip",
      "locked reason: benchmarking",
      "",
    ].join("\n");

    const list = parseWorktreeList(porcelain);
    expect(list).toHaveLength(4);

    expect(list[0]).toMatchObject({ path: "/Users/me/src/app", branch: "main", isMain: true });
    expect(list[1]).toMatchObject({
      path: "/Users/me/src/app-feature",
      branch: "feature/login",
      isMain: false,
      head: "def456",
    });
    expect(list[2]).toMatchObject({ detached: true, branch: null, isMain: false });
    expect(list[3]).toMatchObject({ locked: true, lockReason: "reason: benchmarking" });
  });

  it("handles a bare main repo and prunable entries", () => {
    const list = parseWorktreeList(
      ["worktree /srv/app.git", "bare", "", "worktree /srv/gone", "HEAD aaa", "prunable gitdir file points to non-existent location", ""].join("\n"),
    );
    expect(list[0]).toMatchObject({ bare: true, isMain: true });
    expect(list[1]).toMatchObject({ prunable: true });
  });

  it("returns nothing for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});
