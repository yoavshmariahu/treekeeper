import { run } from "../util/exec.js";

/** Disk usage in KB. Uses `du` (fast, counts real blocks); null when unavailable. */
export async function dirSizeKb(path: string): Promise<number | null> {
  const r = await run("du", ["-sk", path], { timeoutMs: 120_000 });
  if (r.code !== 0 && r.stdout.trim() === "") return null;
  const first = r.stdout.trim().split("\n")[0] ?? "";
  const kb = Number(first.split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb : null;
}
