import { describe, expect, it } from "vitest";
import { formatAgo, formatDuration, parseDuration } from "../src/util/time";

describe("parseDuration", () => {
  it("parses single units", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration("2w")).toBe(1_209_600_000);
  });

  it("parses compound and bare values", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1d 12h")).toBe(129_600_000);
    expect(parseDuration("0")).toBe(0);
    expect(parseDuration(2_500)).toBe(2_500);
  });

  it("is case and whitespace tolerant", () => {
    expect(parseDuration(" 2H ")).toBe(7_200_000);
  });

  it("throws rather than silently disabling a safety gate", () => {
    for (const bad of ["", "soon", "30 minutes", "5x", "m30", "-5m"]) {
      expect(() => parseDuration(bad), bad).toThrow();
    }
  });
});

describe("formatDuration", () => {
  it("uses at most two units", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(1_800_000)).toBe("30m");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
    expect(formatDuration(604_800_000)).toBe("7d");
  });
});

describe("formatAgo", () => {
  it("collapses very recent timestamps", () => {
    const now = 1_000_000_000_000;
    expect(formatAgo(now - 1_000, now)).toBe("just now");
    expect(formatAgo(now - 600_000, now)).toBe("10m ago");
  });
});
