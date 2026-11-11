import { describe, expect, it } from "vitest";
import { cliPath, launchdPlist, sweepArgv, systemdService, systemdTimer } from "../src/daemon/service";

describe("sweepArgv", () => {
  it("runs this installation's CLI with a non-interactive sweep", () => {
    const argv = sweepArgv();
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toBe(cliPath());
    expect(argv.slice(2)).toEqual(["gc", "--all", "--apply", "--yes", "--quiet"]);
  });
});

describe("launchdPlist", () => {
  const plist = launchdPlist(900);

  it("is a well-formed plist with the interval and label", () => {
    expect(plist.startsWith('<?xml version="1.0"')).toBe(true);
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("com.treekeeper.agent");
    expect(plist).toContain("<key>StartInterval</key>\n  <integer>900</integer>");
    expect(plist.trimEnd().endsWith("</plist>")).toBe(true);
  });

  it("carries a PATH that can find git and gh", () => {
    expect(plist).toMatch(/<key>PATH<\/key>/);
    expect(plist).toContain("/opt/homebrew/bin");
    expect(plist).toContain("/usr/local/bin");
  });

  it("runs at low priority so a sweep never fights the editor for IO", () => {
    expect(plist).toContain("<key>LowPriorityIO</key>");
    expect(plist).toContain("<string>Background</string>");
  });

  it("escapes XML metacharacters in paths", () => {
    expect(plist).not.toMatch(/<string>[^<]*[&](?!(amp|lt|gt|quot);)/);
  });
});

describe("systemd units", () => {
  it("writes a oneshot service that runs the sweep", () => {
    const service = systemdService();
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=");
    expect(service).toContain("gc --all --apply --yes --quiet");
    expect(service).toContain("IOSchedulingClass=idle");
  });

  it("writes a timer that survives downtime", () => {
    const timer = systemdTimer(900);
    expect(timer).toContain("OnUnitActiveSec=900");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("WantedBy=timers.target");
  });
});
