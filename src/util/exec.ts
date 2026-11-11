import { execFile } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the binary itself could not be launched (not installed, EACCES, timeout). */
  failedToStart: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  input?: string;
}

/**
 * Run a command without ever throwing. Every caller in treekeeper has to make a
 * decision from the exit code (a missing `gh`, a repo without a remote, a branch
 * that vanished), so an exception-based API would just mean try/catch everywhere.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        env: opts.env ?? process.env,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr, failedToStart: false });
          return;
        }
        const code = typeof err.code === "number" ? err.code : null;
        resolve({
          code: code ?? 127,
          stdout: stdout ?? "",
          stderr: stderr ?? String(err.message ?? ""),
          failedToStart: code === null,
        });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** stdout trimmed on success, `null` on any failure. */
export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<string | null> {
  const r = await run(cmd, args, opts);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** stdout split into non-empty trimmed lines; `[]` on failure. */
export async function runLines(cmd: string, args: string[], opts: RunOptions = {}): Promise<string[]> {
  const out = await runOk(cmd, args, opts);
  if (out === null || out === "") return [];
  return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

const haveCache = new Map<string, boolean>();

/** Whether an executable is on PATH. Cached for the life of the process. */
export async function have(cmd: string): Promise<boolean> {
  const cached = haveCache.get(cmd);
  if (cached !== undefined) return cached;
  const probe = process.platform === "win32" ? "where" : "which";
  const r = await run(probe, [cmd], { timeoutMs: 5_000 });
  const ok = r.code === 0 && r.stdout.trim().length > 0;
  haveCache.set(cmd, ok);
  return ok;
}
