import { listArchives, pruneArchives } from "../core/archive.js";
import { loadConfig } from "../core/config.js";
import { dirSizeKb } from "../core/size.js";
import { formatBytes, formatKb } from "../util/bytes.js";
import { color } from "../util/color.js";
import { shortenPath } from "../util/paths.js";
import { formatAgo, parseDuration } from "../util/time.js";
import type { CliFlags } from "./context.js";

const USAGE = `usage: treekeeper archive <list|prune|path>`;

export async function archiveCommand(args: string[], flags: CliFlags): Promise<number> {
  const { config } = await loadConfig();
  const sub = args[0] ?? "list";

  if (sub === "path") {
    process.stdout.write(config.archive.dir + "\n");
    return 0;
  }

  if (sub === "prune") {
    const retention = parseDuration(config.archive.retention);
    const result = await pruneArchives(config.archive.dir, retention);
    process.stdout.write(
      result.removed.length === 0
        ? `nothing older than ${config.archive.retention}\n`
        : `pruned ${result.removed.length} archive(s), freed ${formatKb(result.freedKb)}\n`,
    );
    return 0;
  }

  if (sub !== "list") {
    process.stderr.write(USAGE + "\n");
    return 2;
  }

  const records = await listArchives(config.archive.dir);
  if (flags.json) {
    process.stdout.write(JSON.stringify(records, null, 2) + "\n");
    return 0;
  }

  if (records.length === 0) {
    process.stdout.write(`no archives in ${shortenPath(config.archive.dir)}\n`);
    return 0;
  }

  const total = (await dirSizeKb(config.archive.dir)) ?? 0;
  process.stdout.write(
    `${color.bold(String(records.length))} archive(s) in ${shortenPath(config.archive.dir)} ` +
    color.gray(`(${formatKb(total)}, retention ${config.archive.retention})\n\n`),
  );

  for (const r of records) {
    const bits = [
      r.bundle ? `${r.bundle.commits} unmerged commit${r.bundle.commits === 1 ? "" : "s"}` : null,
      r.patch ? `diff ${formatBytes(r.patch.bytes)}` : null,
      r.untracked
        ? `${r.untracked.count} untracked${r.untracked.truncated ? " (list only)" : ""}`
        : null,
    ].filter(Boolean);
    process.stdout.write(
      `${color.cyan(r.id)}  ${color.gray(formatAgo(Date.parse(r.createdAt)))}\n` +
      `  ${color.gray(r.reason)}${bits.length > 0 ? `  ${color.yellow(bits.join(", "))}` : color.gray("  (nothing unique)")}\n` +
      `  ${color.gray(shortenPath(r.dir))}\n`,
    );
  }
  process.stdout.write(
    color.gray("\neach archive has a RESTORE.md with the exact commands to bring it back\n"),
  );
  return 0;
}
