import { describe, expect, it } from "vitest";
import { decideBranch, decideWorktree } from "../src/core/decide";
import type { BranchFacts, MergeStatus, Policy, WorktreeFacts } from "../src/core/decide";
import type { PrRef } from "../src/core/forge";

const NOW = 1_700_000_000_000;

const policy = (over: Partial<Policy> = {}): Policy => ({
  minAgeMs: 30 * 60_000,
  closedPrGraceMs: 7 * 86_400_000,
  onDirty: "archive",
  onClosedPr: "archive",
  onExtraCommits: "keep",
  force: false,
  ...over,
});

const pr = (over: Partial<PrRef> = {}): PrRef => ({
  number: 42,
  state: "MERGED",
  headRefName: "feat",
  headRefOid: "abc",
  mergedAt: NOW - 86_400_000,
  closedAt: NOW - 86_400_000,
  url: "https://github.com/o/r/pull/42",
  title: "a change",
  ...over,
});

const facts = (over: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
  now: NOW,
  isMain: false,
  detached: false,
  locked: false,
  lockReason: null,
  branch: "feat",
  protectedBranch: false,
  protectedPath: false,
  isCwd: false,
  merge: { kind: "merged-ancestor", base: "origin/main" },
  dirty: false,
  dirtyCount: 0,
  activity: null,
  activityIsRecent: false,
  lastTouched: NOW - 4 * 3_600_000,
  inUse: false,
  ...over,
});

describe("decideWorktree — the happy path", () => {
  it("reclaims a merged, idle, clean worktree", () => {
    const v = decideWorktree(facts(), policy());
    expect(v.action).toBe("reclaim");
    expect(v.risks).toEqual([]);
    expect(v.reason).toContain("merged into origin/main");
  });

  it("reclaims a squash-merged branch via its pull request", () => {
    const v = decideWorktree(facts({ merge: { kind: "merged-pr", pr: pr() } }), policy());
    expect(v.action).toBe("reclaim");
    expect(v.reason).toBe("PR #42 merged");
  });
});

describe("decideWorktree — things it must never touch", () => {
  const cases: Array<[string, Partial<WorktreeFacts>, string]> = [
    ["the main worktree", { isMain: true }, "main-worktree"],
    ["a protected path", { protectedPath: true }, "protected-path"],
    ["the caller's cwd", { isCwd: true }, "cwd"],
    ["a locked worktree", { locked: true }, "locked"],
    ["a detached HEAD", { detached: true, branch: null }, "detached"],
    ["a protected branch", { protectedBranch: true }, "protected-branch"],
  ];

  for (const [name, over, code] of cases) {
    it(`keeps ${name}`, () => {
      const v = decideWorktree(facts(over), policy());
      expect(v.action).toBe("keep");
      expect(v.code).toBe(code);
    });

    it(`keeps ${name} even with --force`, () => {
      expect(decideWorktree(facts(over), policy({ force: true })).action).toBe("keep");
    });
  }
});

describe("decideWorktree — unfinished work", () => {
  it("keeps an unmerged branch", () => {
    const v = decideWorktree(facts({ merge: { kind: "unmerged", forgeAvailable: true } }), policy());
    expect(v.action).toBe("keep");
    expect(v.code).toBe("unmerged");
  });

  it("keeps an unmerged branch even with --force", () => {
    const v = decideWorktree(
      facts({ merge: { kind: "unmerged", forgeAvailable: true } }),
      policy({ force: true }),
    );
    expect(v.action).toBe("keep");
  });

  it("says so when the forge could not be consulted", () => {
    const v = decideWorktree(facts({ merge: { kind: "unmerged", forgeAvailable: false } }), policy());
    expect(v.reason).toContain("no pull-request data");
  });

  it("keeps a branch with an open pull request", () => {
    const v = decideWorktree(facts({ merge: { kind: "open-pr", pr: pr({ state: "OPEN" }) } }), policy());
    expect(v.action).toBe("keep");
    expect(v.code).toBe("open-pr");
  });
});

describe("decideWorktree — the in-use gates", () => {
  it("keeps a worktree with recent agent activity", () => {
    const v = decideWorktree(
      facts({
        activityIsRecent: true,
        activity: { detector: "claude-code", lastActivity: NOW - 120_000, detail: "" },
      }),
      policy(),
    );
    expect(v.action).toBe("keep");
    expect(v.code).toBe("session-active");
    expect(v.reason).toContain("claude-code");
  });

  it("keeps a worktree a process is sitting in", () => {
    const v = decideWorktree(facts({ inUse: true }), policy());
    expect(v.code).toBe("in-use");
  });

  it("keeps a worktree touched inside minAge", () => {
    const v = decideWorktree(facts({ lastTouched: NOW - 60_000 }), policy());
    expect(v.code).toBe("too-young");
  });

  it("--force overrides only the age gate, not an active session", () => {
    expect(decideWorktree(facts({ lastTouched: NOW - 60_000 }), policy({ force: true })).action).toBe("reclaim");
    expect(
      decideWorktree(
        facts({ activityIsRecent: true, activity: { detector: "mtime", lastActivity: NOW, detail: "" } }),
        policy({ force: true }),
      ).action,
    ).toBe("keep");
    expect(decideWorktree(facts({ inUse: true }), policy({ force: true })).action).toBe("keep");
  });
});

describe("decideWorktree — uncommitted changes", () => {
  it("archives and reclaims when onDirty is archive", () => {
    const v = decideWorktree(facts({ dirty: true, dirtyCount: 3 }), policy({ onDirty: "archive" }));
    expect(v.action).toBe("reclaim");
    expect(v.risks).toContain("dirty");
  });

  it("keeps when onDirty is keep", () => {
    const v = decideWorktree(facts({ dirty: true, dirtyCount: 3 }), policy({ onDirty: "keep" }));
    expect(v.action).toBe("keep");
    expect(v.reason).toContain("3 uncommitted changes");
  });

  it("keeps dirty and unmerged regardless of policy", () => {
    const v = decideWorktree(
      facts({ dirty: true, dirtyCount: 1, merge: { kind: "unmerged", forgeAvailable: true } }),
      policy({ onDirty: "archive" }),
    );
    expect(v.action).toBe("keep");
    expect(v.code).toBe("unmerged");
  });
});

describe("decideWorktree — merged PR with extra local commits", () => {
  const merge: MergeStatus = { kind: "merged-pr-extra", pr: pr(), extra: 2 };

  it("keeps by default", () => {
    const v = decideWorktree(facts({ merge }), policy());
    expect(v.action).toBe("keep");
    expect(v.reason).toContain("2 commits the PR never had");
  });

  it("archives and reclaims when configured to", () => {
    const v = decideWorktree(facts({ merge }), policy({ onExtraCommits: "archive" }));
    expect(v.action).toBe("reclaim");
    expect(v.risks).toContain("extra-commits");
  });
});

describe("decideWorktree — closed, unmerged pull requests", () => {
  it("holds for the grace window", () => {
    const merge: MergeStatus = { kind: "closed-pr", pr: pr({ state: "CLOSED", closedAt: NOW - 86_400_000 }) };
    const v = decideWorktree(facts({ merge }), policy());
    expect(v.action).toBe("keep");
    expect(v.code).toBe("closed-pr-grace");
    expect(v.reason).toContain("holding for");
  });

  it("reclaims once the grace window has passed, flagged for archiving", () => {
    const merge: MergeStatus = {
      kind: "closed-pr",
      pr: pr({ state: "CLOSED", closedAt: NOW - 30 * 86_400_000 }),
    };
    const v = decideWorktree(facts({ merge }), policy());
    expect(v.action).toBe("reclaim");
    expect(v.risks).toContain("closed-pr");
  });

  it("never reclaims when onClosedPr is keep", () => {
    const merge: MergeStatus = {
      kind: "closed-pr",
      pr: pr({ state: "CLOSED", closedAt: NOW - 30 * 86_400_000 }),
    };
    expect(decideWorktree(facts({ merge }), policy({ onClosedPr: "keep" })).action).toBe("keep");
  });
});

describe("decideBranch", () => {
  const bfacts = (over: Partial<BranchFacts> = {}): BranchFacts => ({
    now: NOW,
    name: "feat",
    isDefault: false,
    protectedBranch: false,
    hasWorktree: false,
    isCurrent: false,
    merge: { kind: "merged-ancestor", base: "origin/main" },
    lastCommit: null,
    ...over,
  });

  it("deletes a merged branch with no worktree", () => {
    expect(decideBranch(bfacts(), policy()).action).toBe("reclaim");
  });

  it("keeps the default, current, protected and still-checked-out branches", () => {
    expect(decideBranch(bfacts({ isDefault: true }), policy()).code).toBe("default-branch");
    expect(decideBranch(bfacts({ isCurrent: true }), policy()).code).toBe("current-branch");
    expect(decideBranch(bfacts({ protectedBranch: true }), policy()).code).toBe("protected-branch");
    expect(decideBranch(bfacts({ hasWorktree: true }), policy()).code).toBe("has-worktree");
  });

  it("keeps unmerged branches", () => {
    expect(
      decideBranch(bfacts({ merge: { kind: "unmerged", forgeAvailable: true } }), policy({ force: true })).action,
    ).toBe("keep");
  });
});
