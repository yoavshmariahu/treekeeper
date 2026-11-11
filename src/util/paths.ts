import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

/** Expand a leading `~` and resolve to an absolute path. */
export function expandPath(input: string, base = process.cwd()): string {
  let p = input.trim();
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith(`~${sep}`)) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

/** Collapse `$HOME` back to `~` for display. */
export function shortenPath(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(home + sep) ? "~" + p.slice(home.length) : p;
}

/** True when `child` is `parent` or lives underneath it. Pure string compare. */
export function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(base);
}

/** realpath that falls back to the input when the path does not exist. */
export async function realpathSafe(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** Where treekeeper keeps config, logs, cache and archives. */
export function treekeeperHome(): string {
  const override = process.env.TREEKEEPER_HOME;
  if (override && override.trim() !== "") return expandPath(override);
  return join(homedir(), ".treekeeper");
}

/**
 * Very small glob matcher: supports `*` (not crossing `/`), `**` (crossing it)
 * and `?`. Enough for branch names and path patterns, and it keeps the
 * dependency count at zero.
 */
export function matchGlob(pattern: string, value: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(value);
}

export function matchAnyGlob(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => matchGlob(p, value));
}

const cache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
        out += "(?:.*\\/)?";
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  const re = new RegExp(out);
  cache.set(pattern, re);
  return re;
}
