import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LogLevel } from "../core/config.js";
import { color } from "./color.js";
import { redactSecrets, redactValue } from "./redact.js";
import { formatClock } from "./time.js";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface LoggerOptions {
  level?: LogLevel;
  /** JSONL destination. Omit to log to the console only. */
  file?: string;
  /** Suppress console output (the log file still receives everything). */
  quiet?: boolean;
}

export class Logger {
  readonly level: LogLevel;
  private readonly file: string | undefined;
  private readonly quiet: boolean;
  private fileBroken = false;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? "info";
    this.file = opts.file;
    this.quiet = opts.quiet ?? false;
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.emit("error", msg, fields);
  }

  /**
   * A durable record of something treekeeper *did* (or decided not to do).
   * Always written to the log file regardless of level, because this is the
   * audit trail a developer reads after a worktree disappears.
   */
  event(type: string, fields: LogFields = {}): void {
    this.write({ ts: new Date().toISOString(), level: "info", type, ...redactValue(fields) });
  }

  private emit(level: LogLevel, rawMsg: string, rawFields?: LogFields): void {
    const msg = redactSecrets(rawMsg);
    const fields = rawFields ? redactValue(rawFields) : undefined;
    this.write({ ts: new Date().toISOString(), level, msg, ...(fields ?? {}) });
    if (this.quiet || ORDER[level] < ORDER[this.level]) return;
    const tag =
      level === "error" ? color.red("error") :
      level === "warn" ? color.yellow("warn") :
      level === "debug" ? color.gray("debug") :
      color.gray(formatClock(Date.now()));
    const extra = fields && Object.keys(fields).length > 0 ? color.gray(` ${compact(fields)}`) : "";
    // stderr, so that `--json` keeps stdout machine-readable.
    process.stderr.write(`${tag} ${msg}${extra}\n`);
  }

  private write(record: LogFields): void {
    if (!this.file || this.fileBroken) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(record) + "\n");
    } catch {
      // A broken log file must never take the daemon down; report once.
      this.fileBroken = true;
      if (!this.quiet) {
        process.stderr.write(color.yellow(`warn could not write log file ${this.file}\n`));
      }
    }
  }
}

function compact(fields: LogFields): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}
