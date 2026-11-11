import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expandPath, treekeeperHome } from "../util/paths.js";
import { parseDuration } from "../util/time.js";

export type DirtyPolicy = "archive" | "keep";
export type ForgeKind = "github" | "none";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SessionCommand {
  name: string;
  /** Shell command; exit code 0 means "an agent is still working here". */
  command: string;
}

export interface SessionConfig {
  /** A worktree touched by any detector inside this window is left alone. */
  grace: string;
  detectors: string[];
  /**
   * Extra files/dirs whose mtime counts as agent activity.
   * `{worktree}` is substituted with the worktree path.
   */
  extraPaths: string[];
  commands: SessionCommand[];
}

export interface ArchiveConfig {
  enabled: boolean;
  dir: string;
  retention: string;
  /** Untracked files above this total are listed instead of copied. */
  maxUntrackedBytes: number;
}

export interface Config {
  /** Directories scanned for git repos (and therefore for their worktrees). */
  roots: string[];
  maxDepth: number;
  /** A worktree must be untouched this long before it can be reclaimed. */
  minAge: string;
  /** A worktree whose PR was closed unmerged waits this long on top of minAge. */
  closedPrGrace: string;
  onDirty: DirtyPolicy;
  onClosedPr: DirtyPolicy;
  /** PR merged but the local branch tip has commits the PR never had. */
  onExtraCommits: DirtyPolicy;
  protectBranches: string[];
  protectPaths: string[];
  /** Also delete merged local branches that have no worktree. */
  pruneBranches: boolean;
  pruneRemotes: boolean;
  forge: ForgeKind;
  forgeCacheTtl: string;
  /** Daemon sweep interval. */
  interval: string;
  sessions: SessionConfig;
  archive: ArchiveConfig;
  logFile: string;
  logLevel: LogLevel;
  /** Set to false in a repo's .treekeeper.json to opt that repo out entirely. */
  enabled: boolean;
}

export const CONFIG_FILENAME = "config.json";
export const REPO_CONFIG_FILENAME = ".treekeeper.json";

export function defaultConfig(): Config {
  const home = treekeeperHome();
  return {
    roots: ["~/src"],
    maxDepth: 3,
    minAge: "30m",
    closedPrGrace: "7d",
    onDirty: "archive",
    onClosedPr: "archive",
    onExtraCommits: "keep",
    protectBranches: ["main", "master", "trunk", "develop", "dev", "release/*"],
    protectPaths: [],
    pruneBranches: true,
    pruneRemotes: false,
    forge: "github",
    forgeCacheTtl: "10m",
    interval: "15m",
    sessions: {
      grace: "20m",
      detectors: ["claude-code", "codex", "aider", "process", "mtime"],
      extraPaths: [],
      commands: [],
    },
    archive: {
      enabled: true,
      dir: join(home, "archive"),
      retention: "14d",
      maxUntrackedBytes: 64 * 1024 * 1024,
    },
    logFile: join(home, "treekeeper.log"),
    logLevel: "info",
    enabled: true,
  };
}

export interface LoadedConfig {
  config: Config;
  /** Files that contributed, in precedence order. */
  sources: string[];
  warnings: string[];
}

export function globalConfigPath(): string {
  const override = process.env.TREEKEEPER_CONFIG;
  if (override && override.trim() !== "") return expandPath(override);
  return join(treekeeperHome(), CONFIG_FILENAME);
}

/** Load the user-level config, falling back to defaults when absent. */
export async function loadConfig(path = globalConfigPath()): Promise<LoadedConfig> {
  const base = defaultConfig();
  const warnings: string[] = [];
  const sources: string[] = [];

  const raw = await readJsonIfPresent(path, warnings);
  if (raw !== null) {
    sources.push(path);
    mergeInto(base, raw, warnings, path);
  }
  normalize(base, warnings);
  return { config: base, sources, warnings };
}

/** Layer a repo-local `.treekeeper.json` on top of an already-loaded config. */
export async function loadRepoConfig(repoPath: string, parent: Config): Promise<LoadedConfig> {
  const path = join(repoPath, REPO_CONFIG_FILENAME);
  const warnings: string[] = [];
  const raw = await readJsonIfPresent(path, warnings);
  if (raw === null) return { config: parent, sources: [], warnings };
  const merged: Config = structuredClone(parent);
  mergeInto(merged, raw, warnings, path);
  normalize(merged, warnings);
  return { config: merged, sources: [path], warnings };
}

async function readJsonIfPresent(
  path: string,
  warnings: string[],
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      warnings.push(`could not read ${path}: ${(err as Error).message}`);
    }
    return null;
  }
  // Tolerate `//` and `/* */` comments and trailing commas — these files get
  // hand-edited, and a strict parser turns a comment into a crashed daemon.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`${path}: expected a JSON object, ignoring`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    warnings.push(`${path}: invalid JSON (${(err as Error).message}), ignoring`);
    return null;
  }
}

const KNOWN_KEYS = new Set<keyof Config | string>([
  "roots", "maxDepth", "minAge", "closedPrGrace", "onDirty", "onClosedPr",
  "onExtraCommits", "protectBranches", "protectPaths", "pruneBranches",
  "pruneRemotes", "forge", "forgeCacheTtl", "interval", "sessions", "archive",
  "logFile", "logLevel", "enabled", "$schema",
]);

function mergeInto(
  target: Config,
  raw: Record<string, unknown>,
  warnings: string[],
  source: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`${source}: unknown option "${key}"`);
  }

  strArray(raw, "roots", warnings, source, (v) => (target.roots = v));
  num(raw, "maxDepth", warnings, source, (v) => (target.maxDepth = v));
  dur(raw, "minAge", warnings, source, (v) => (target.minAge = v));
  dur(raw, "closedPrGrace", warnings, source, (v) => (target.closedPrGrace = v));
  enumOf(raw, "onDirty", ["archive", "keep"], warnings, source, (v) => (target.onDirty = v as DirtyPolicy));
  enumOf(raw, "onClosedPr", ["archive", "keep"], warnings, source, (v) => (target.onClosedPr = v as DirtyPolicy));
  enumOf(raw, "onExtraCommits", ["archive", "keep"], warnings, source, (v) => (target.onExtraCommits = v as DirtyPolicy));
  strArray(raw, "protectBranches", warnings, source, (v) => (target.protectBranches = v));
  strArray(raw, "protectPaths", warnings, source, (v) => (target.protectPaths = v));
  bool(raw, "pruneBranches", warnings, source, (v) => (target.pruneBranches = v));
  bool(raw, "pruneRemotes", warnings, source, (v) => (target.pruneRemotes = v));
  enumOf(raw, "forge", ["github", "none"], warnings, source, (v) => (target.forge = v as ForgeKind));
  dur(raw, "forgeCacheTtl", warnings, source, (v) => (target.forgeCacheTtl = v));
  dur(raw, "interval", warnings, source, (v) => (target.interval = v));
  str(raw, "logFile", warnings, source, (v) => (target.logFile = v));
  enumOf(raw, "logLevel", ["debug", "info", "warn", "error"], warnings, source, (v) => (target.logLevel = v as LogLevel));
  bool(raw, "enabled", warnings, source, (v) => (target.enabled = v));

  const sessions = raw["sessions"];
  if (sessions !== undefined) {
    if (isObject(sessions)) {
      dur(sessions, "grace", warnings, source, (v) => (target.sessions.grace = v));
      strArray(sessions, "detectors", warnings, source, (v) => (target.sessions.detectors = v));
      strArray(sessions, "extraPaths", warnings, source, (v) => (target.sessions.extraPaths = v));
      const cmds = sessions["commands"];
      if (cmds !== undefined) {
        if (Array.isArray(cmds)) {
          const out: SessionCommand[] = [];
          for (const c of cmds) {
            if (isObject(c) && typeof c["command"] === "string") {
              out.push({
                name: typeof c["name"] === "string" ? c["name"] : "custom",
                command: c["command"],
              });
            } else {
              warnings.push(`${source}: sessions.commands entries need a "command" string`);
            }
          }
          target.sessions.commands = out;
        } else {
          warnings.push(`${source}: sessions.commands must be an array`);
        }
      }
    } else {
      warnings.push(`${source}: sessions must be an object`);
    }
  }

  const archive = raw["archive"];
  if (archive !== undefined) {
    if (isObject(archive)) {
      bool(archive, "enabled", warnings, source, (v) => (target.archive.enabled = v));
      str(archive, "dir", warnings, source, (v) => (target.archive.dir = v));
      dur(archive, "retention", warnings, source, (v) => (target.archive.retention = v));
      num(archive, "maxUntrackedBytes", warnings, source, (v) => (target.archive.maxUntrackedBytes = v));
    } else {
      warnings.push(`${source}: archive must be an object`);
    }
  }
}

function normalize(cfg: Config, warnings: string[]): void {
  cfg.roots = cfg.roots.map((r) => expandPath(r));
  cfg.protectPaths = cfg.protectPaths.map((p) => (p.includes("*") ? expandPath0(p) : expandPath(p)));
  cfg.archive.dir = expandPath(cfg.archive.dir);
  cfg.logFile = expandPath(cfg.logFile);
  if (cfg.maxDepth < 1) {
    warnings.push("maxDepth must be at least 1, using 1");
    cfg.maxDepth = 1;
  }
  const unknownDetectors = cfg.sessions.detectors.filter(
    (d) => !["claude-code", "codex", "aider", "process", "mtime"].includes(d),
  );
  for (const d of unknownDetectors) warnings.push(`unknown session detector "${d}"`);
}

/** Expand `~` in a glob without resolving the wildcards away. */
function expandPath0(pattern: string): string {
  if (pattern === "~" || pattern.startsWith("~/")) {
    const home = expandPath("~");
    return pattern === "~" ? home : `${home}/${pattern.slice(2)}`;
  }
  return pattern;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

type Sink<T> = (value: T) => void;

function str(raw: Record<string, unknown>, key: string, w: string[], src: string, set: Sink<string>) {
  const v = raw[key];
  if (v === undefined) return;
  if (typeof v === "string") set(v);
  else w.push(`${src}: ${key} must be a string`);
}

function num(raw: Record<string, unknown>, key: string, w: string[], src: string, set: Sink<number>) {
  const v = raw[key];
  if (v === undefined) return;
  if (typeof v === "number" && Number.isFinite(v)) set(v);
  else w.push(`${src}: ${key} must be a number`);
}

function bool(raw: Record<string, unknown>, key: string, w: string[], src: string, set: Sink<boolean>) {
  const v = raw[key];
  if (v === undefined) return;
  if (typeof v === "boolean") set(v);
  else w.push(`${src}: ${key} must be true or false`);
}

function strArray(raw: Record<string, unknown>, key: string, w: string[], src: string, set: Sink<string[]>) {
  const v = raw[key];
  if (v === undefined) return;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) set(v as string[]);
  else w.push(`${src}: ${key} must be an array of strings`);
}

function dur(raw: Record<string, unknown>, key: string, w: string[], src: string, set: Sink<string>) {
  const v = raw[key];
  if (v === undefined) return;
  if (typeof v !== "string" && typeof v !== "number") {
    w.push(`${src}: ${key} must be a duration like "30m"`);
    return;
  }
  try {
    parseDuration(v);
    set(String(v));
  } catch (err) {
    w.push(`${src}: ${key} — ${(err as Error).message}`);
  }
}

function enumOf(
  raw: Record<string, unknown>,
  key: string,
  allowed: string[],
  w: string[],
  src: string,
  set: Sink<string>,
) {
  const v = raw[key];
  if (v === undefined) return;
  if (typeof v === "string" && allowed.includes(v)) set(v);
  else w.push(`${src}: ${key} must be one of ${allowed.join(", ")}`);
}
