import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { expandPath, isInside, matchGlob, shortenPath } from "../src/util/paths";

describe("expandPath", () => {
  it("expands a leading tilde", () => {
    expect(expandPath("~/src")).toBe(`${homedir()}/src`);
    expect(expandPath("~")).toBe(homedir());
  });
  it("leaves absolute paths alone and resolves relative ones", () => {
    expect(expandPath("/tmp/x")).toBe("/tmp/x");
    expect(expandPath("b", "/a")).toBe("/a/b");
  });
  it("does not treat ~foo as a home directory", () => {
    expect(expandPath("~foo", "/a")).toBe("/a/~foo");
  });
});

describe("shortenPath", () => {
  it("collapses the home directory", () => {
    expect(shortenPath(`${homedir()}/src/x`)).toBe("~/src/x");
    expect(shortenPath("/opt/x")).toBe("/opt/x");
  });
});

describe("isInside", () => {
  it("matches a directory and its descendants", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
  });
  it("does not match a sibling with a shared prefix", () => {
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });
});

describe("matchGlob", () => {
  it("matches * within a path segment only", () => {
    expect(matchGlob("release/*", "release/1.2")).toBe(true);
    expect(matchGlob("release/*", "release/a/b")).toBe(false);
    expect(matchGlob("feat-*", "feat-login")).toBe(true);
    expect(matchGlob("feat-*", "fix-login")).toBe(false);
  });
  it("matches ** across segments", () => {
    expect(matchGlob("/src/**/node_modules", "/src/a/b/node_modules")).toBe(true);
    expect(matchGlob("/src/**/keep", "/src/keep")).toBe(true);
  });
  it("escapes regex metacharacters", () => {
    expect(matchGlob("v1.0", "v1.0")).toBe(true);
    expect(matchGlob("v1.0", "v1x0")).toBe(false);
  });
});
