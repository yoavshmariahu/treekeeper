import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { treekeeperHome } from "../util/paths.js";

export interface SweepRecord {
  at: number;
  durationMs: number;
  repos: number;
  worktrees: number;
  branches: number;
  reclaimedKb: number;
  failures: number;
}

export interface State {
  version: 1;
  lastSweep: SweepRecord | null;
  sweeps: number;
  totalReclaimedKb: number;
}

export function statePath(): string {
  return join(treekeeperHome(), "state.json");
}

export async function readState(): Promise<State> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(), "utf8"));
    if (parsed && typeof parsed === "object" && (parsed as State).version === 1) {
      return parsed as State;
    }
  } catch {
    /* first run */
  }
  return { version: 1, lastSweep: null, sweeps: 0, totalReclaimedKb: 0 };
}

export async function recordSweep(sweep: SweepRecord): Promise<void> {
  const state = await readState();
  state.lastSweep = sweep;
  state.sweeps += 1;
  state.totalReclaimedKb += sweep.reclaimedKb;
  try {
    await mkdir(treekeeperHome(), { recursive: true });
    await writeFile(statePath(), JSON.stringify(state, null, 2) + "\n");
  } catch {
    /* a missing state file only costs a status line */
  }
}
