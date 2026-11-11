import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../util/exec.js";
import { treekeeperHome } from "../util/paths.js";
import { parseDuration } from "../util/time.js";
import type { SweepRecord } from "./state.js";
import { readState } from "./state.js";

export const LABEL = "com.treekeeper.agent";
export const SYSTEMD_UNIT = "treekeeper";

export type Manager = "launchd" | "systemd" | "unsupported";

export interface DaemonStatus {
  manager: Manager;
  installed: boolean;
  /** Loaded with the service manager and scheduled to run. */
  active: boolean;
  unitPath: string | null;
  intervalSeconds: number | null;
  lastSweep: SweepRecord | null;
  logFile: string;
}

export function currentManager(): Manager {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") return "systemd";
  return "unsupported";
}

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function systemdDir(): string {
  const base = process.env.XDG_CONFIG_HOME
    ? resolve(process.env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  return join(base, "systemd", "user");
}

function daemonLogPath(): string {
  return join(treekeeperHome(), "daemon.out.log");
}

/** Absolute path to this installation's CLI entry point. */
export function cliPath(): string {
  return resolve(fileURLToPath(new URL("../cli.js", import.meta.url)));
}

/** The command a scheduled sweep runs. */
export function sweepArgv(extra: string[] = []): string[] {
  return [process.execPath, cliPath(), "gc", "--all", "--apply", "--yes", "--quiet", ...extra];
}

export async function daemonStatus(): Promise<DaemonStatus> {
  const manager = currentManager();
  const state = await readState();
  const base: DaemonStatus = {
    manager,
    installed: false,
    active: false,
    unitPath: null,
    intervalSeconds: null,
    lastSweep: state.lastSweep,
    logFile: daemonLogPath(),
  };

  if (manager === "launchd") {
    const path = launchAgentPath();
    const plist = await readIfPresent(path);
    base.unitPath = path;
    base.installed = plist !== null;
    if (plist) {
      const m = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist);
      base.intervalSeconds = m?.[1] ? Number(m[1]) : null;
      const list = await run("launchctl", ["list", LABEL], { timeoutMs: 10_000 });
      base.active = list.code === 0;
    }
    return base;
  }

  if (manager === "systemd") {
    const timer = join(systemdDir(), `${SYSTEMD_UNIT}.timer`);
    const unit = await readIfPresent(timer);
    base.unitPath = timer;
    base.installed = unit !== null;
    if (unit) {
      const m = /OnUnitActiveSec=(\d+)/.exec(unit);
      base.intervalSeconds = m?.[1] ? Number(m[1]) : null;
      const active = await run("systemctl", ["--user", "is-active", `${SYSTEMD_UNIT}.timer`], {
        timeoutMs: 10_000,
      });
      base.active = active.stdout.trim() === "active";
    }
    return base;
  }

  return base;
}

export interface InstallResult {
  ok: boolean;
  manager: Manager;
  unitPath: string | null;
  messages: string[];
}

/** Write and load the service definition for the current platform. */
export async function installDaemon(interval: string): Promise<InstallResult> {
  const manager = currentManager();
  const seconds = Math.max(60, Math.round(parseDuration(interval) / 1000));
  const messages: string[] = [];

  if (manager === "launchd") {
    const path = launchAgentPath();
    await mkdir(dirname(path), { recursive: true });
    await mkdir(treekeeperHome(), { recursive: true });
    await writeFile(path, launchdPlist(seconds));

    // bootout first so a re-install picks up a changed interval.
    await run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`], { timeoutMs: 15_000 });
    const boot = await run(
      "launchctl",
      ["bootstrap", `gui/${process.getuid?.() ?? 501}`, path],
      { timeoutMs: 20_000 },
    );
    if (boot.code !== 0) {
      const legacy = await run("launchctl", ["load", "-w", path], { timeoutMs: 20_000 });
      if (legacy.code !== 0) {
        messages.push(`wrote ${path} but launchctl could not load it: ${(boot.stderr || legacy.stderr).trim()}`);
        return { ok: false, manager, unitPath: path, messages };
      }
    }
    messages.push(`installed ${path}`, `sweeping every ${seconds}s · logs in ${daemonLogPath()}`);
    return { ok: true, manager, unitPath: path, messages };
  }

  if (manager === "systemd") {
    const dir = systemdDir();
    await mkdir(dir, { recursive: true });
    await mkdir(treekeeperHome(), { recursive: true });
    const servicePath = join(dir, `${SYSTEMD_UNIT}.service`);
    const timerPath = join(dir, `${SYSTEMD_UNIT}.timer`);
    await writeFile(servicePath, systemdService());
    await writeFile(timerPath, systemdTimer(seconds));

    await run("systemctl", ["--user", "daemon-reload"], { timeoutMs: 20_000 });
    const enable = await run(
      "systemctl",
      ["--user", "enable", "--now", `${SYSTEMD_UNIT}.timer`],
      { timeoutMs: 20_000 },
    );
    if (enable.code !== 0) {
      messages.push(`wrote the units but systemctl failed: ${enable.stderr.trim()}`);
      return { ok: false, manager, unitPath: timerPath, messages };
    }
    messages.push(
      `installed ${servicePath} and ${timerPath}`,
      `sweeping every ${seconds}s`,
      "tip: `loginctl enable-linger $USER` keeps the timer running while you are logged out",
    );
    return { ok: true, manager, unitPath: timerPath, messages };
  }

  messages.push(
    `no supported service manager on ${process.platform}.`,
    "Run `treekeeper watch` under your own supervisor, or schedule `treekeeper gc --all --apply --yes`.",
  );
  return { ok: false, manager, unitPath: null, messages };
}

export async function uninstallDaemon(): Promise<InstallResult> {
  const manager = currentManager();
  const messages: string[] = [];

  if (manager === "launchd") {
    const path = launchAgentPath();
    await run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`], { timeoutMs: 15_000 });
    await run("launchctl", ["unload", "-w", path], { timeoutMs: 15_000 });
    await rm(path, { force: true });
    messages.push(`removed ${path}`);
    return { ok: true, manager, unitPath: path, messages };
  }

  if (manager === "systemd") {
    const dir = systemdDir();
    await run("systemctl", ["--user", "disable", "--now", `${SYSTEMD_UNIT}.timer`], { timeoutMs: 20_000 });
    await rm(join(dir, `${SYSTEMD_UNIT}.timer`), { force: true });
    await rm(join(dir, `${SYSTEMD_UNIT}.service`), { force: true });
    await run("systemctl", ["--user", "daemon-reload"], { timeoutMs: 20_000 });
    messages.push("removed the treekeeper timer and service");
    return { ok: true, manager, unitPath: null, messages };
  }

  messages.push("nothing to uninstall");
  return { ok: true, manager, unitPath: null, messages };
}

export async function setDaemonRunning(running: boolean): Promise<InstallResult> {
  const manager = currentManager();
  const messages: string[] = [];
  if (manager === "launchd") {
    const path = launchAgentPath();
    const uid = process.getuid?.() ?? 501;
    const r = running
      ? await run("launchctl", ["bootstrap", `gui/${uid}`, path], { timeoutMs: 20_000 })
      : await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { timeoutMs: 20_000 });
    messages.push(r.code === 0 ? (running ? "started" : "stopped") : (r.stderr || r.stdout).trim());
    return { ok: r.code === 0, manager, unitPath: path, messages };
  }
  if (manager === "systemd") {
    const r = await run(
      "systemctl",
      ["--user", running ? "start" : "stop", `${SYSTEMD_UNIT}.timer`],
      { timeoutMs: 20_000 },
    );
    messages.push(r.code === 0 ? (running ? "started" : "stopped") : r.stderr.trim());
    return { ok: r.code === 0, manager, unitPath: null, messages };
  }
  messages.push(`not supported on ${process.platform}`);
  return { ok: false, manager, unitPath: null, messages };
}

export function launchdPlist(seconds: number): string {
  const args = sweepArgv()
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  const log = escapeXml(daemonLogPath());
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${seconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(schedulerPath())}</string>
  </dict>
</dict>
</plist>
`;
}

export function systemdService(): string {
  const [exe, ...rest] = sweepArgv();
  return `[Unit]
Description=treekeeper — reclaim disk from finished agent worktrees
Documentation=https://github.com/yoavshmariahu/treekeeper

[Service]
Type=oneshot
Nice=5
IOSchedulingClass=idle
Environment=PATH=${schedulerPath()}
ExecStart=${exe} ${rest.join(" ")}
`;
}

export function systemdTimer(seconds: number): string {
  return `[Unit]
Description=treekeeper periodic sweep

[Timer]
OnBootSec=300
OnUnitActiveSec=${seconds}
AccuracySec=60
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/**
 * Service managers start jobs with a minimal PATH, which would hide `git` and
 * `gh`. Carry the installing shell's PATH plus the usual suspects.
 */
function schedulerPath(): string {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const current = (process.env.PATH ?? "").split(":").filter((p) => p !== "");
  const seen = new Set<string>();
  return [...current, ...extra].filter((p) => (seen.has(p) ? false : (seen.add(p), true))).join(":");
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
