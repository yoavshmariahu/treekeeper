import { createReadStream } from "node:fs";
import { basename } from "node:path";

/**
 * Removal history, read back out of the JSONL event log.
 *
 * `applyPlan` appends a `reclaim` event for every worktree it removes and a
 * `branch-delete` event for every branch it prunes on its own. Nothing else
 * records history, so the log is the single source for "what did treekeeper
 * take, from where, and how much did that free".
 */

export type HistoryRange = "7d" | "30d" | "all";

export const HISTORY_RANGES: readonly HistoryRange[] = ["7d", "30d", "all"];

export function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === "string" && (HISTORY_RANGES as readonly string[]).includes(value);
}

/** One thing treekeeper removed, as recorded in the log. */
export interface RemovalEvent {
  /** A removed worktree (`reclaim`) or a branch pruned on its own (`branch-delete`). */
  kind: "worktree" | "branch";
  /** Epoch ms of the log line. */
  at: number;
  /** Absolute path of the repo's main checkout. */
  repo: string;
  /** The removed worktree's path; null for a branch. */
  path: string | null;
  branch: string | null;
  /** Disk the removal freed, in KB. Always 0 for a branch. */
  sizeKb: number;
  reason: string;
  /** Whether unique work was archived before the removal. */
  archived: boolean;
}

export interface HistoryTotals {
  worktrees: number;
  reclaimedKb: number;
  branches: number;
  /** Repos with at least one removal in the range. */
  repos: number;
}

export interface RepoHistory {
  repo: string;
  /** `basename(repo)`, for display. */
  name: string;
  worktrees: number;
  reclaimedKb: number;
  branches: number;
  /** ISO time of the newest removal (worktree or branch) in the range. */
  lastRemovalAt: string;
}

export interface DayHistory {
  /** Calendar day, `YYYY-MM-DD`, in the report's UTC offset. */
  day: string;
  worktrees: number;
  reclaimedKb: number;
  branches: number;
}

export interface RemovalEntry {
  at: string;
  repo: string;
  name: string;
  path: string;
  branch: string | null;
  sizeKb: number;
  reason: string;
  archived: boolean;
}

export interface HistoryReport {
  version: 1;
  generatedAt: string;
  range: HistoryRange;
  /** Start of the first day in the window; null when "all" has no events. */
  from: string | null;
  to: string;
  /** Offset that decided where one calendar day ends and the next begins. */
  utcOffsetMinutes: number;
  /** ISO time of the oldest removal in the whole log, whatever the range. */
  since: string | null;
  totals: HistoryTotals;
  /** Largest reclaimed first. */
  byRepo: RepoHistory[];
  /** One entry per calendar day of the window, oldest first, empty days included. */
  byDay: DayHistory[];
  /** Removed worktrees, newest first, capped at `maxRemovals`. */
  removals: RemovalEntry[];
  /** How many older worktree removals the cap left out of `removals`. */
  removalsOmitted: number;
}

export interface HistoryOptions {
  now: number;
  range: HistoryRange;
  /** Minutes east of UTC used to cut calendar days. Default 0 (UTC). */
  utcOffsetMinutes?: number;
  /** Cap on `removals`. Default 500. */
  maxRemovals?: number;
}

const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<Exclude<HistoryRange, "all">, number> = { "7d": 7, "30d": 30 };

/**
 * One log line to a removal event, or null for anything else: debug and warn
 * lines, other event types, truncated or malformed JSON. Never throws.
 */
export function parseLogLine(line: string): RemovalEvent | null {
  // The log is mostly debug lines; skip the JSON parse for those.
  if (!line.includes('"reclaim"') && !line.includes('"branch-delete"')) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;

  if (rec.type !== "reclaim" && rec.type !== "branch-delete") return null;
  if (typeof rec.ts !== "string") return null;
  const at = Date.parse(rec.ts);
  if (!Number.isFinite(at) || at <= 0) return null;
  if (typeof rec.repo !== "string" || rec.repo === "") return null;

  const reason = typeof rec.reason === "string" ? rec.reason : "";
  const archived = typeof rec.archive === "string" && rec.archive !== "";

  if (rec.type === "reclaim") {
    if (typeof rec.path !== "string" || rec.path === "") return null;
    const sizeKb =
      typeof rec.sizeKb === "number" && Number.isFinite(rec.sizeKb) && rec.sizeKb > 0
        ? rec.sizeKb
        : 0;
    return {
      kind: "worktree",
      at,
      repo: rec.repo,
      path: rec.path,
      branch: typeof rec.branch === "string" && rec.branch !== "" ? rec.branch : null,
      sizeKb,
      reason,
      archived,
    };
  }

  if (typeof rec.branch !== "string" || rec.branch === "") return null;
  return {
    kind: "branch",
    at,
    repo: rec.repo,
    path: null,
    branch: rec.branch,
    sizeKb: 0,
    reason,
    archived,
  };
}

/**
 * Every removal event in a log file, in file order. The file is read as a
 * stream, since it grows without bound and is mostly lines this skips. A log
 * that does not exist yet is an empty history, not an error.
 */
export async function readRemovalEvents(logFile: string): Promise<RemovalEvent[]> {
  const events: RemovalEvent[] = [];
  const take = (line: string): void => {
    const event = parseLogLine(line);
    if (event) events.push(event);
  };

  let tail = "";
  try {
    const stream = createReadStream(logFile, { encoding: "utf8", highWaterMark: 1 << 20 });
    for await (const chunk of stream as AsyncIterable<string>) {
      const text = tail + chunk;
      let start = 0;
      for (;;) {
        const end = text.indexOf("\n", start);
        if (end === -1) break;
        take(text.slice(start, end));
        start = end + 1;
      }
      tail = text.slice(start);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  if (tail !== "") take(tail);
  return events;
}

/**
 * Summarize removal events for one range. Pure: the same events, `now` and
 * options always give the same report.
 *
 * A range is a whole number of calendar days ending today, so "7d" is today
 * and the six days before it. That keeps the totals, the per-repo rows, the
 * per-day series and the list in agreement: each counts exactly the events
 * that fall on one of the days in `byDay`.
 */
export function buildHistoryReport(
  events: readonly RemovalEvent[],
  opts: HistoryOptions,
): HistoryReport {
  const { now, range } = opts;
  const offsetMinutes = Number.isFinite(opts.utcOffsetMinutes) ? Math.trunc(opts.utcOffsetMinutes!) : 0;
  const offsetMs = offsetMinutes * 60_000;
  const maxRemovals = Math.max(0, Math.floor(opts.maxRemovals ?? 500));

  const dayOf = (at: number): number => Math.floor((at + offsetMs) / DAY_MS);
  const today = dayOf(now);

  // Nothing later than `now` is history yet (a clock that jumped, a test's fixed `now`).
  const past = events.filter((e) => e.at <= now);

  let oldest: number | null = null;
  for (const e of past) {
    if (oldest === null || e.at < oldest) oldest = e.at;
  }

  const firstDay: number | null =
    range === "all" ? (oldest === null ? null : dayOf(oldest)) : today - (RANGE_DAYS[range] - 1);

  const inRange = firstDay === null ? [] : past.filter((e) => dayOf(e.at) >= firstDay);

  const totals: HistoryTotals = { worktrees: 0, reclaimedKb: 0, branches: 0, repos: 0 };
  const repos = new Map<string, { row: RepoHistory; last: number }>();
  const days = new Map<number, DayHistory>();
  if (firstDay !== null) {
    for (let d = firstDay; d <= today; d += 1) {
      days.set(d, { day: dayLabel(d), worktrees: 0, reclaimedKb: 0, branches: 0 });
    }
  }

  const removed: RemovalEvent[] = [];
  for (const e of inRange) {
    let entry = repos.get(e.repo);
    if (!entry) {
      entry = {
        row: {
          repo: e.repo, name: basename(e.repo), worktrees: 0, reclaimedKb: 0, branches: 0,
          lastRemovalAt: "",
        },
        last: e.at,
      };
      repos.set(e.repo, entry);
    }
    if (e.at > entry.last) entry.last = e.at;

    const day = days.get(dayOf(e.at))!;
    if (e.kind === "worktree") {
      totals.worktrees += 1;
      totals.reclaimedKb += e.sizeKb;
      entry.row.worktrees += 1;
      entry.row.reclaimedKb += e.sizeKb;
      day.worktrees += 1;
      day.reclaimedKb += e.sizeKb;
      removed.push(e);
    } else {
      totals.branches += 1;
      entry.row.branches += 1;
      day.branches += 1;
    }
  }
  totals.repos = repos.size;

  const byRepo = [...repos.values()]
    .map(({ row, last }) => ({ ...row, lastRemovalAt: new Date(last).toISOString() }))
    .sort(
      (a, b) =>
        b.reclaimedKb - a.reclaimedKb ||
        b.worktrees - a.worktrees ||
        b.branches - a.branches ||
        a.name.localeCompare(b.name) ||
        a.repo.localeCompare(b.repo),
    );

  // Newest first; a stable sort keeps log order among removals in the same millisecond.
  removed.sort((a, b) => b.at - a.at);
  const removals: RemovalEntry[] = removed.slice(0, maxRemovals).map((e) => ({
    at: new Date(e.at).toISOString(),
    repo: e.repo,
    name: basename(e.repo),
    path: e.path ?? "",
    branch: e.branch,
    sizeKb: e.sizeKb,
    reason: e.reason,
    archived: e.archived,
  }));

  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    range,
    from: firstDay === null ? null : new Date(firstDay * DAY_MS - offsetMs).toISOString(),
    to: new Date(now).toISOString(),
    utcOffsetMinutes: offsetMinutes,
    since: oldest === null ? null : new Date(oldest).toISOString(),
    totals,
    byRepo,
    byDay: [...days.values()],
    removals,
    removalsOmitted: removed.length - removals.length,
  };
}

function dayLabel(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}
