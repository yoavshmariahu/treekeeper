import type { ApplyResult } from "./apply.js";
import type { Plan, RepoPlan, WorktreeCandidate } from "./plan.js";
import { formatKb } from "../util/bytes.js";
import { color, padEndVisible, visibleWidth } from "../util/color.js";
import { shortenPath } from "../util/paths.js";

export interface RenderOptions {
  /** Show kept worktrees too (default: only when there are few). */
  verbose?: boolean;
  /** Only the summary line. */
  quiet?: boolean;
}

/** The human-readable plan. */
export function renderPlan(plan: Plan, opts: RenderOptions = {}): string {
  const out: string[] = [];
  if (opts.quiet) return summaryLine(plan);

  for (const repo of plan.repos) {
    const block = renderRepo(repo, opts);
    if (block.length > 0) {
      out.push(...block, "");
    }
  }

  for (const warning of plan.warnings) {
    out.push(color.yellow(`note  ${warning}`));
  }
  if (plan.warnings.length > 0) out.push("");

  out.push(summaryLine(plan));
  return out.join("\n");
}

function renderRepo(repo: RepoPlan, opts: RenderOptions): string[] {
  if (repo.skipped) {
    return opts.verbose ? [`${color.bold(repo.name)}  ${color.gray(`skipped — ${repo.skipped}`)}`] : [];
  }

  const reclaim = repo.worktrees.filter((w) => w.verdict.action === "reclaim");
  const kept = repo.worktrees.filter(
    (w) => w.verdict.action === "keep" && w.verdict.code !== "main-worktree",
  );
  const showKept = opts.verbose ? kept : [];

  if (reclaim.length === 0 && showKept.length === 0 && repo.branches.length === 0) return [];

  const rows: Array<[string, string, string, string, string]> = [];
  for (const w of reclaim) rows.push(row(w, true));
  for (const w of showKept) rows.push(row(w, false));

  const widths = [0, 0, 0, 0];
  for (const r of rows) {
    for (let i = 0; i < 4; i += 1) {
      widths[i] = Math.max(widths[i]!, visibleWidth(r[i]!));
    }
  }

  const head = `${color.bold(repo.name)} ${color.gray(`(${repo.defaultBranch})`)}${
    repo.forgeAvailable ? "" : color.gray(" [no PR data]")
  }`;
  const lines = [head];

  for (const r of rows) {
    const cells = [
      padEndVisible(r[0]!, widths[0]!),
      padEndVisible(r[1]!, widths[1]!),
      padEndVisible(r[2]!, widths[2]!),
      padEndVisible(r[3]!, widths[3]!),
      r[4]!,
    ];
    lines.push(`  ${cells.join("  ").trimEnd()}`);
  }

  if (repo.branches.length > 0) {
    const names = repo.branches.map((b) => b.name);
    const shown = names.slice(0, 6).join(" ");
    const more = names.length > 6 ? color.gray(` +${names.length - 6} more`) : "";
    lines.push(
      `  ${color.red("DELETE")}  ${names.length} merged branch${names.length === 1 ? "" : "es"}: ${color.gray(shown)}${more}`,
    );
  }

  return lines;
}

function row(w: WorktreeCandidate, reclaim: boolean): [string, string, string, string, string] {
  const action = reclaim ? color.red("RECLAIM") : color.gray("keep   ");
  const path = reclaim ? shortenPath(w.path) : color.gray(shortenPath(w.path));
  const branch = w.branch ? color.cyan(`[${w.branch}]`) : color.gray("[detached]");
  const size = w.sizeKb === null ? "" : (reclaim ? color.yellow(formatKb(w.sizeKb)) : color.gray(formatKb(w.sizeKb)));
  const risks = w.verdict.risks.length > 0 ? color.yellow(` (${w.verdict.risks.join(", ")})`) : "";
  const reason = (reclaim ? color.gray(w.verdict.reason) : color.gray(w.verdict.reason)) + risks;
  return [action, path, branch, size, reason];
}

export function summaryLine(plan: Plan): string {
  const s = plan.summary;
  if (s.worktreesReclaimable === 0 && s.branchesDeletable === 0) {
    return color.green(
      `nothing to clean — ${s.worktreesScanned} worktree${s.worktreesScanned === 1 ? "" : "s"} across ${s.repos} repo${s.repos === 1 ? "" : "s"} all still in play`,
    );
  }
  return [
    `would reclaim ${color.bold(String(s.worktreesReclaimable))} worktree${s.worktreesReclaimable === 1 ? "" : "s"}`,
    `(${color.bold(formatKb(s.reclaimKb))})`,
    `and delete ${color.bold(String(s.branchesDeletable))} branch${s.branchesDeletable === 1 ? "" : "es"}`,
    color.gray(`· ${s.worktreesKept} kept`),
  ].join(" ");
}

/** What actually happened, after `--apply`. */
export function renderApply(result: ApplyResult, plan: Plan): string {
  const out: string[] = [];

  for (const r of result.removedWorktrees) {
    const parts = [
      color.green("reclaimed"),
      shortenPath(r.path),
      r.branch ? color.cyan(`[${r.branch}]`) : "",
      color.yellow(formatKb(r.sizeKb)),
      color.gray(`— ${r.reason}`),
    ].filter((p) => p !== "");
    out.push(parts.join("  "));
  }

  const branchOnly = result.deletedBranches.filter(
    (b) => !result.removedWorktrees.some((w) => w.branch === b.name && w.repo === b.repo),
  );
  if (branchOnly.length > 0) {
    out.push(
      `${color.green("deleted")}  ${branchOnly.length} branch${branchOnly.length === 1 ? "" : "es"} ${color.gray(
        branchOnly.slice(0, 8).map((b) => b.name).join(" "),
      )}`,
    );
  }

  const archived = result.archives.filter((a) => a.bundle || a.patch || a.untracked);
  if (archived.length > 0) {
    out.push("");
    out.push(color.gray(`archived unique work from ${archived.length} of them:`));
    for (const a of archived.slice(0, 10)) {
      const bits = [
        a.bundle ? `${a.bundle.commits} commit${a.bundle.commits === 1 ? "" : "s"}` : null,
        a.patch ? "uncommitted diff" : null,
        a.untracked ? `${a.untracked.count} untracked` : null,
      ].filter(Boolean);
      out.push(color.gray(`  ${shortenPath(a.dir)}  (${bits.join(", ")})`));
    }
  }

  for (const f of result.failures) {
    out.push(color.yellow(`kept  ${shortenPath(f.target)} — ${f.message}`));
  }

  if (out.length > 0) out.push("");

  const nothing = result.removedWorktrees.length === 0 && result.deletedBranches.length === 0;
  out.push(
    nothing
      ? color.green("nothing to clean")
      : `${color.bold("reclaimed")} ${formatKb(result.reclaimedKb)} · ` +
        `${result.removedWorktrees.length} worktree${result.removedWorktrees.length === 1 ? "" : "s"}, ` +
        `${result.deletedBranches.length} branch${result.deletedBranches.length === 1 ? "" : "es"} · ` +
        color.gray(`${plan.summary.worktreesKept} kept`),
  );
  return out.join("\n");
}
