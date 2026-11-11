import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isGitRepo, mainRepoPath } from "./git.js";
import { isInside, matchAnyGlob } from "../util/paths.js";
import type { Logger } from "../util/log.js";

/** Directories never worth descending into when hunting for repos. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "vendor", "target", "dist", "build",
  ".next", ".nuxt", ".venv", "venv", "__pycache__", ".cache", ".pnpm-store",
  "Library", "Applications", ".Trash", ".cargo", ".rustup", ".gradle", ".m2",
]);

export interface ScanOptions {
  roots: string[];
  maxDepth: number;
  protectPaths?: string[];
  logger?: Logger;
}

/**
 * Find the main worktree of every git repo under `roots`.
 *
 * A linked worktree found during the walk resolves to its parent clone, so a
 * repo is discovered whether the root holds the clone, the worktrees, or both.
 */
export async function discoverRepos(opts: ScanOptions): Promise<string[]> {
  const found = new Set<string>();
  const seen = new Set<string>();

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (seen.has(dir)) return;
    seen.add(dir);
    if (opts.protectPaths && matchAnyGlob(opts.protectPaths, dir)) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES" && code !== "ENOTDIR" && code !== "EPERM") {
        opts.logger?.debug(`scan: cannot read ${dir}: ${(err as Error).message}`);
      }
      return;
    }

    const hasGit = entries.some((e) => e.name === ".git");
    if (hasGit) {
      const main = await mainRepoPath(dir);
      if (main) {
        found.add(main);
        // Stop here: `git worktree list` from the main repo enumerates the rest,
        // and nested repos inside a checkout are not ours to garbage-collect.
        return;
      }
    }

    if (depth >= opts.maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") && entry.name !== ".worktrees") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Follow a symlinked root one level, but never let a loop trap the walk.
        try {
          const st = await stat(child);
          if (!st.isDirectory()) continue;
        } catch {
          continue;
        }
      }
      await walk(child, depth + 1);
    }
  };

  for (const root of opts.roots) {
    await walk(root, 0);
  }
  return [...found].sort();
}

/**
 * Resolve the repos implied by explicit CLI paths. A path inside a repo or
 * worktree resolves to that repo; a plain directory is scanned shallowly.
 */
export async function reposFromPaths(paths: string[], opts: Omit<ScanOptions, "roots">): Promise<string[]> {
  const out = new Set<string>();
  for (const p of paths) {
    if (await isGitRepo(p)) {
      const main = await mainRepoPath(p);
      if (main) {
        out.add(main);
        continue;
      }
    }
    for (const repo of await discoverRepos({ ...opts, roots: [p] })) out.add(repo);
  }
  return [...out].sort();
}

/** True when any root contains the given path — used to sanity-check config. */
export function underAnyRoot(roots: string[], path: string): boolean {
  return roots.some((r) => isInside(r, path));
}
