#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { archiveCommand } from "./commands/archive.js";
import { configCommand } from "./commands/config.js";
import { daemonCommand } from "./commands/daemon.js";
import { doctorCommand } from "./commands/doctor.js";
import { gcCommand } from "./commands/gc.js";
import { statusCommand } from "./commands/status.js";
import { watchCommand } from "./commands/watch.js";
import type { CliFlags } from "./commands/context.js";
import { color } from "./util/color.js";

const HELP = `${color.bold("treekeeper")} — reclaim disk from finished agent worktrees

${color.bold("USAGE")}
  treekeeper <command> [options] [path...]

${color.bold("COMMANDS")}
  gc [path...]        Plan a sweep (default). Add --apply to carry it out.
  status              What is reclaimable right now, plus daemon state.
  watch               Sweep on an interval in the foreground.
  daemon <sub>        install | uninstall | start | stop | status | logs
  archive <sub>       list | prune | path
  config <sub>        show | path | init
  doctor              Check git, gh, lsof, config and detectors.

${color.bold("OPTIONS")}
  --apply             Actually remove things (default is a dry run)
  -y, --yes           Skip the confirmation prompt
  --all               Every repo under the configured roots
  --json              Machine-readable output on stdout
  -q, --quiet         Summary only
  -v, --verbose       Show kept worktrees and debug logging
  --force             Bypass the age gate and the dirty / closed-PR holds
  --min-age <dur>     Override minAge, e.g. 2h
  --session-grace <d> Override how long after agent activity a worktree is held
  --forge <kind>      github | none  (none = git ancestry only)
  --refresh           Ignore the cached pull-request data
  --branches-only     Prune branches, leave every worktree alone
  --worktrees-only    Remove worktrees, do not prune other branches
  --sizes             Measure every worktree, not just the removable ones
  --root <dir>        Override roots (repeatable)
  --interval <dur>    Interval for watch / daemon install
  --config <file>     Use a specific config file
  -h, --help          This text
  --version           Version

${color.bold("EXAMPLES")}
  treekeeper gc --all                   # what could go, across every repo
  treekeeper gc --all --apply --yes     # the sweep a harness hook should run
  treekeeper gc --json | jq .summary    # read the plan from a script
  treekeeper daemon install             # sweep on a schedule, forever

${color.gray("A worktree is only ever removed when its work is merged, or its pull request")}
${color.gray("was merged or closed — and anything unique is archived before it goes.")}
`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        apply: { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        all: { type: "boolean" },
        json: { type: "boolean" },
        quiet: { type: "boolean", short: "q" },
        verbose: { type: "boolean", short: "v" },
        force: { type: "boolean" },
        refresh: { type: "boolean" },
        sizes: { type: "boolean" },
        "branches-only": { type: "boolean" },
        "worktrees-only": { type: "boolean" },
        "min-age": { type: "string" },
        "session-grace": { type: "string" },
        forge: { type: "string" },
        root: { type: "string", multiple: true },
        interval: { type: "string" },
        config: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\nTry \`treekeeper --help\`.\n`);
    return 2;
  }

  const { values, positionals } = parsed;

  if (values.version) {
    process.stdout.write((await version()) + "\n");
    return 0;
  }

  const [command = "gc", ...rest] = positionals;

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const flags: CliFlags = {
    apply: values.apply,
    yes: values.yes,
    json: values.json,
    quiet: values.quiet,
    verbose: values.verbose,
    all: values.all,
    force: values.force,
    refresh: values.refresh,
    sizes: values.sizes,
    branchesOnly: values["branches-only"],
    worktreesOnly: values["worktrees-only"],
    minAge: values["min-age"],
    sessionGrace: values["session-grace"],
    forge: values.forge,
    interval: values.interval,
    config: values.config,
    roots: values.root,
  };

  switch (command) {
    case "gc":
    case "clean":
      return gcCommand(rest, flags);
    case "status":
      return statusCommand(flags);
    case "watch":
      return watchCommand(flags);
    case "daemon":
      return daemonCommand(rest, flags);
    case "archive":
      return archiveCommand(rest, flags);
    case "config":
      return configCommand(rest);
    case "doctor":
      return doctorCommand(values.json === true);
    case "help":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`unknown command "${command}". Try \`treekeeper --help\`.\n`);
      return 2;
  }
}

async function version(): Promise<string> {
  try {
    const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const pkg: unknown = JSON.parse(text);
    return String((pkg as { version?: unknown }).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (import.meta.url.endsWith("/cli.js") || import.meta.url.endsWith("/cli.ts"));

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`treekeeper: ${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 1;
    });
}
