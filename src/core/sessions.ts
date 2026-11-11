import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, SessionCommand } from "./config.js";
import { run } from "../util/exec.js";
import type { Logger } from "../util/log.js";
import { expandPath, isInside } from "../util/paths.js";
import { parseDuration } from "../util/time.js";

export interface ActivityHit {
  /** Which detector saw it: "claude-code", "process", "mtime", … */
  detector: string;
  /** Epoch ms of the most recent activity. */
  lastActivity: number;
  detail: string;
}

export interface ActivityContext {
  now: number;
  graceMs: number;
  detectors: Set<string>;
  extraPaths: string[];
  commands: SessionCommand[];
  logger?: Logger;
  /** Absolute paths that are the cwd of some live process; null when unknown. */
  processCwds: string[] | null;
}

/** Directories whose contents say nothing about whether an agent is working. */
const MTIME_SKIP = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next", ".nuxt", ".venv",
  "venv", "__pycache__", ".cache", "coverage", ".turbo", ".pytest_cache",
  ".gradle", ".mypy_cache", ".ruff_cache", "vendor", ".terraform",
]);

const MTIME_MAX_ENTRIES = 4_000;
const MTIME_MAX_DEPTH = 3;

export async function createActivityContext(
  cfg: Config,
  logger?: Logger,
  now = Date.now(),
): Promise<ActivityContext> {
  const detectors = new Set(cfg.sessions.detectors);
  const ctx: ActivityContext = {
    now,
    graceMs: parseDuration(cfg.sessions.grace),
    detectors,
    extraPaths: cfg.sessions.extraPaths,
    commands: cfg.sessions.commands,
    logger,
    processCwds: null,
  };
  if (detectors.has("process")) {
    ctx.processCwds = await loadProcessCwds(logger);
  }
  return ctx;
}

/**
 * Is an agent (or a human) still working in this worktree?
 *
 * Detectors are deliberately layered: the harness-specific ones give a precise
 * answer with a timestamp, while `process` and `mtime` are the catch-all that
 * makes this work with harnesses treekeeper has never heard of.
 */
export async function detectActivity(
  ctx: ActivityContext,
  worktreePath: string,
): Promise<ActivityHit | null> {
  const cutoff = ctx.now - ctx.graceMs;
  const hits: ActivityHit[] = [];

  if (ctx.detectors.has("process") && ctx.processCwds) {
    const match = ctx.processCwds.find((p) => isInside(worktreePath, p));
    if (match) {
      hits.push({
        detector: "process",
        lastActivity: ctx.now,
        detail: "a running process is sitting in this directory",
      });
    }
  }

  if (ctx.detectors.has("claude-code")) {
    const hit = await claudeCodeActivity(worktreePath, cutoff);
    if (hit) hits.push(hit);
  }
  if (ctx.detectors.has("codex")) {
    const hit = await codexActivity(worktreePath, cutoff, ctx);
    if (hit) hits.push(hit);
  }
  if (ctx.detectors.has("aider")) {
    const hit = await newestFileIn(
      worktreePath,
      [".aider.chat.history.md", ".aider.input.history"],
      "aider",
      cutoff,
    );
    if (hit) hits.push(hit);
  }
  if (ctx.extraPaths.length > 0) {
    const paths = ctx.extraPaths.map((p) =>
      expandPath(p.replaceAll("{worktree}", worktreePath)),
    );
    const hit = await newestPath(paths, "extra-path", cutoff);
    if (hit) hits.push(hit);
  }
  if (ctx.detectors.has("mtime")) {
    const hit = await mtimeActivity(worktreePath, cutoff);
    if (hit) hits.push(hit);
  }

  for (const cmd of ctx.commands) {
    const r = await run("sh", ["-c", cmd.command], {
      timeoutMs: 15_000,
      env: { ...process.env, TREEKEEPER_WORKTREE: worktreePath },
      cwd: undefined,
    });
    if (r.code === 0) {
      hits.push({
        detector: cmd.name,
        lastActivity: ctx.now,
        detail: `custom check "${cmd.name}" reported activity`,
      });
    }
  }

  if (hits.length === 0) return null;
  hits.sort((a, b) => b.lastActivity - a.lastActivity);
  return hits[0]!;
}

/** `true` when the hit falls inside the session grace window. */
export function isActive(ctx: ActivityContext, hit: ActivityHit | null): boolean {
  if (!hit) return false;
  return hit.lastActivity >= ctx.now - ctx.graceMs;
}

// --- harness-specific detectors --------------------------------------------

/**
 * Claude Code stores one JSONL transcript per session under
 * `~/.claude/projects/<slugified-cwd>/`, so the newest transcript mtime is the
 * last time an agent did anything in that worktree.
 */
export function claudeProjectSlugs(worktreePath: string): string[] {
  const all = worktreePath.replace(/[^a-zA-Z0-9]/g, "-");
  const slashesOnly = worktreePath.replace(/\//g, "-");
  return all === slashesOnly ? [all] : [all, slashesOnly];
}

async function claudeCodeActivity(worktreePath: string, cutoff: number): Promise<ActivityHit | null> {
  const base = process.env.CLAUDE_CONFIG_DIR
    ? expandPath(process.env.CLAUDE_CONFIG_DIR)
    : join(homedir(), ".claude");
  for (const slug of claudeProjectSlugs(worktreePath)) {
    const dir = join(base, "projects", slug);
    const hit = await newestInDir(dir, ".jsonl", "claude-code", cutoff);
    if (hit) return hit;
  }
  return null;
}

/**
 * Codex CLI writes rollout transcripts under `~/.codex/sessions/<y>/<m>/<d>/`.
 * Only recently-modified files are opened, and only their head is read, so the
 * cwd match stays cheap even with thousands of archived sessions.
 */
async function codexActivity(
  worktreePath: string,
  cutoff: number,
  ctx: ActivityContext,
): Promise<ActivityHit | null> {
  const root = join(homedir(), ".codex", "sessions");
  const recent: Array<{ path: string; mtime: number }> = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || recent.length >= 40) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const st = await stat(p);
          if (st.mtimeMs >= cutoff) recent.push({ path: p, mtime: st.mtimeMs });
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  await walk(root, 0);

  recent.sort((a, b) => b.mtime - a.mtime);
  for (const file of recent) {
    try {
      const handle = await readFile(file.path, "utf8");
      const head = handle.slice(0, 8_000);
      if (head.includes(`"cwd":"${worktreePath}"`) || head.includes(`"cwd": "${worktreePath}"`)) {
        return {
          detector: "codex",
          lastActivity: file.mtime,
          detail: "a Codex session transcript was updated",
        };
      }
    } catch (err) {
      ctx.logger?.debug(`codex detector: ${(err as Error).message}`);
    }
  }
  return null;
}

// --- generic detectors ------------------------------------------------------

/**
 * Last-resort signal that covers every harness: did anything inside the
 * worktree change recently? Bounded in depth and entry count so a sweep over
 * dozens of worktrees stays fast.
 */
async function mtimeActivity(worktreePath: string, cutoff: number): Promise<ActivityHit | null> {
  let visited = 0;
  let newest = 0;
  let newestPathSeen = "";

  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (visited >= MTIME_MAX_ENTRIES) return false;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (visited >= MTIME_MAX_ENTRIES) return false;
      visited += 1;
      if (MTIME_SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MTIME_MAX_DEPTH && (await walk(p, depth + 1))) return true;
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = await stat(p);
        if (st.mtimeMs > newest) {
          newest = st.mtimeMs;
          newestPathSeen = e.name;
        }
        if (st.mtimeMs >= cutoff) return true; // early exit: already "active"
      } catch {
        /* ignore */
      }
    }
    return false;
  };

  const active = await walk(worktreePath, 0);
  if (!active && newest < cutoff) return null;
  return {
    detector: "mtime",
    lastActivity: newest,
    detail: `files changed recently (${newestPathSeen})`,
  };
}

async function loadProcessCwds(logger?: Logger): Promise<string[] | null> {
  if (process.platform === "win32") return null;
  const r = await run("lsof", ["-d", "cwd", "-Fn"], { timeoutMs: 30_000 });
  if (r.code !== 0 && r.stdout.trim() === "") {
    logger?.debug("process detector: lsof unavailable, skipping");
    return null;
  }
  const out = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("n/")) out.add(line.slice(1));
  }
  return [...out];
}

async function newestInDir(
  dir: string,
  suffix: string,
  detector: string,
  cutoff: number,
): Promise<ActivityHit | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(suffix)) continue;
    try {
      const st = await stat(join(dir, e.name));
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      /* ignore */
    }
  }
  if (newest === 0 || newest < cutoff) return null;
  return { detector, lastActivity: newest, detail: "a session transcript was updated" };
}

async function newestFileIn(
  base: string,
  names: string[],
  detector: string,
  cutoff: number,
): Promise<ActivityHit | null> {
  return newestPath(names.map((n) => join(base, n)), detector, cutoff);
}

async function newestPath(paths: string[], detector: string, cutoff: number): Promise<ActivityHit | null> {
  let newest = 0;
  let which = "";
  for (const p of paths) {
    try {
      const st = await stat(p);
      if (st.mtimeMs > newest) {
        newest = st.mtimeMs;
        which = p;
      }
    } catch {
      /* missing is fine */
    }
  }
  if (newest === 0 || newest < cutoff) return null;
  return { detector, lastActivity: newest, detail: `${which} was updated` };
}
