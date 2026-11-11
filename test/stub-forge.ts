import type { Forge, PrIndex, PrRef } from "../src/core/forge";

/** A Forge that returns exactly the pull requests a test wants it to. */
export function stubForge(prs: PrRef[]): Forge {
  const index: PrIndex = new Map();
  for (const pr of prs) {
    const list = index.get(pr.headRefName) ?? [];
    list.push(pr);
    index.set(pr.headRefName, list);
  }
  return {
    kind: "stub",
    unavailableReason: null,
    lookup: async () => index,
  };
}

export function pr(over: Partial<PrRef> & { headRefName: string }): PrRef {
  return {
    number: 1,
    state: "MERGED",
    headRefOid: "0".repeat(40),
    mergedAt: Date.now() - 86_400_000,
    closedAt: Date.now() - 86_400_000,
    url: `https://github.com/o/r/pull/1`,
    title: "a change",
    ...over,
  };
}
