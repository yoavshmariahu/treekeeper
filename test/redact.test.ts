import { describe, expect, it } from "vitest";
import { redactRemote, redactSecrets, redactValue } from "../src/util/redact";

describe("redactRemote", () => {
  it("strips embedded credentials from an https remote", () => {
    expect(redactRemote("https://user:github_pat_11ABCDEFGHIJKLMNOPQRST@github.com/o/r.git"))
      .toBe("https://github.com/o/r.git");
    expect(redactRemote("https://ghp_abcdefghijklmnopqrstuvwxyz@github.com/o/r.git"))
      .toBe("https://github.com/o/r.git");
  });

  it("leaves clean remotes untouched", () => {
    expect(redactRemote("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(redactRemote("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });
});

describe("redactSecrets", () => {
  it("scrubs credentials out of error text from git and gh", () => {
    const message =
      "gh pr list failed for https://Org:github_pat_11ABJHHQA0Fol3ze1FCLitABCDEFGH@github.com/Org/repo.git: not found";
    const out = redactSecrets(message);
    expect(out).not.toContain("github_pat_");
    expect(out).not.toContain("Org:");
    expect(out).toContain("https://github.com/Org/repo.git");
  });

  it("scrubs bare tokens of well-known shapes", () => {
    expect(redactSecrets("token ghp_0123456789abcdefghij here")).toBe("token [redacted] here");
    expect(redactSecrets("glpat-0123456789abcdefghij")).toBe("[redacted]");
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[redacted]");
  });

  it("leaves ordinary text alone", () => {
    const text = "removed ~/src/app-feature [feat/login] 1.2G — PR #88 merged";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("redactValue", () => {
  it("walks nested log fields", () => {
    const fields = {
      path: "/src/app",
      remote: "https://u:ghp_0123456789abcdefghij@github.com/o/r.git",
      risks: ["dirty"],
      nested: { url: "https://u:glpat-0123456789abcdefghij@gitlab.com/o/r.git" },
      count: 3,
    };
    const out = redactValue(fields);
    expect(out.remote).toBe("https://github.com/o/r.git");
    expect(out.nested.url).toBe("https://gitlab.com/o/r.git");
    expect(out.risks).toEqual(["dirty"]);
    expect(out.count).toBe(3);
  });
});
