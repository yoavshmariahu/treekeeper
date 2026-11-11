const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a duration like "30m", "2h", "7d", "1h30m", "0" or a bare number of
 * milliseconds. Throws on anything else so a typo in a config file is loud
 * rather than silently becoming 0 (which would disable a safety gate).
 */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new Error(`invalid duration: ${input}`);
    return Math.round(input);
  }
  const text = input.trim().toLowerCase();
  if (text === "" ) throw new Error("invalid duration: empty string");
  if (/^\d+$/.test(text)) return Number(text);

  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/g;
  let total = 0;
  let matched = 0;
  let consumed = 0;
  for (const m of text.matchAll(re)) {
    const [whole, value, unit] = m;
    total += Number(value) * UNITS[unit as string]!;
    matched += 1;
    consumed += whole.length;
  }
  const stripped = text.replace(/[\s,]/g, "");
  if (matched === 0 || consumed < stripped.length) {
    throw new Error(`invalid duration: ${input} (use e.g. 30m, 2h, 7d)`);
  }
  return Math.round(total);
}

/** "3m", "2h 10m", "4d" — compact, at most two units. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const d = Math.floor(ms / UNITS.d!);
  const h = Math.floor((ms % UNITS.d!) / UNITS.h!);
  const m = Math.floor((ms % UNITS.h!) / UNITS.m!);
  const s = Math.floor((ms % UNITS.m!) / UNITS.s!);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** "12m ago" / "just now" */
export function formatAgo(timestamp: number, now = Date.now()): string {
  const delta = now - timestamp;
  if (delta < 45_000) return "just now";
  return `${formatDuration(delta)} ago`;
}

export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatStamp(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
