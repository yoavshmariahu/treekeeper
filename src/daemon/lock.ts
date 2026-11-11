import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { treekeeperHome } from "../util/paths.js";

const LOCK = "sweep.lock";

export interface Lock {
  release(): Promise<void>;
}

function lockPath(): string {
  return join(treekeeperHome(), LOCK);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the machine-wide sweep lock, so a scheduled sweep and a manual
 * `treekeeper gc --apply` can never remove the same worktree twice.
 * Returns null when another sweep holds it.
 */
export async function acquireLock(): Promise<Lock | null> {
  const path = lockPath();
  await mkdir(treekeeperHome(), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      return {
        release: async () => {
          try {
            await unlink(path);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Stale lock from a killed process? Clear it once and retry.
      let holder: number | null = null;
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        const pid = (parsed as { pid?: unknown }).pid;
        holder = typeof pid === "number" ? pid : null;
      } catch {
        holder = null;
      }
      if (holder !== null && alive(holder)) return null;
      try {
        await unlink(path);
      } catch {
        return null;
      }
    }
  }
  return null;
}
