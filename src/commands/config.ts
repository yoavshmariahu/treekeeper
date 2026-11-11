import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultConfig, globalConfigPath, loadConfig } from "../core/config.js";
import { color } from "../util/color.js";
import { shortenPath } from "../util/paths.js";

const USAGE = `usage: treekeeper config <show|path|init>`;

export async function configCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? "show";

  if (sub === "path") {
    process.stdout.write(globalConfigPath() + "\n");
    return 0;
  }

  if (sub === "show") {
    const { config, sources, warnings } = await loadConfig();
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    if (sources.length === 0) {
      process.stderr.write(color.gray(`(defaults — no file at ${shortenPath(globalConfigPath())})\n`));
    }
    for (const w of warnings) process.stderr.write(color.yellow(`warn ${w}\n`));
    return 0;
  }

  if (sub === "init") {
    const path = globalConfigPath();
    const starter = {
      $schema: "https://github.com/yoavshmariahu/treekeeper",
      roots: defaultConfig().roots,
      minAge: "30m",
      interval: "15m",
      onDirty: "archive",
      onClosedPr: "archive",
      protectBranches: defaultConfig().protectBranches,
      protectPaths: [],
      sessions: { grace: "20m" },
    };
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(starter, null, 2) + "\n", { flag: "wx" });
      process.stdout.write(`wrote ${shortenPath(path)}\n`);
      return 0;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        process.stderr.write(`${shortenPath(path)} already exists\n`);
        return 1;
      }
      process.stderr.write(`could not write ${path}: ${(err as Error).message}\n`);
      return 1;
    }
  }

  process.stderr.write(USAGE + "\n");
  return 2;
}
