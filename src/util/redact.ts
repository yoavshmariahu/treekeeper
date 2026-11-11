/**
 * Credential scrubbing for anything that might reach a log file or stdout.
 *
 * Remotes routinely carry secrets — `https://user:ghp_xxx@github.com/o/r.git`
 * is a perfectly ordinary origin URL — and git and gh echo them back in error
 * messages. treekeeper writes a persistent log, so a token must never make it
 * that far.
 */

/** `https://user:token@host/path` -> `https://host/path`. */
export function redactRemote(url: string): string {
  return url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/]*@/, "$1");
}

const PATTERNS: Array<[RegExp, string]> = [
  // userinfo in any URL
  [/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/\s]*@/g, "$1"],
  // well-known token shapes, even when they appear bare
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\b(?:xox[baprs]-)[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
];

/** Remove credentials from free text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Recursively redact strings in a value destined for a log record. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v);
    return out as unknown as T;
  }
  return value;
}
