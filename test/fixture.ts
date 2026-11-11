import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "treekeeper test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "treekeeper test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return stdout.trim();
}

export interface Fixture {
  root: string;
  repo: string;
  origin: string;
  paths: {
    merged: string;
    unmerged: string;
    dirty: string;
    closed: string;
  };
}

/**
 * A real repo with a real origin and four real worktrees, covering each
 * decision branch: merged, unmerged, merged-but-dirty, and a branch whose only
 * record is a (simulated) closed pull request.
 */
export async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treekeeper-")));
  const origin = join(root, "origin.git");
  const repo = join(root, "app");

  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "init", "--initial-branch=main", repo);
  await git(repo, "remote", "add", "origin", origin);

  await writeFile(join(repo, "README.md"), "# app\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  await git(repo, "push", "-u", "origin", "main");

  // A branch that was merged into main the ordinary way.
  await commitOnBranch(repo, "merged-feat", "feat.txt", "merged work\n");
  await git(repo, "checkout", "main");
  await git(repo, "merge", "--no-ff", "-m", "merge merged-feat", "merged-feat");

  // A branch that was merged and whose worktree still has local edits.
  await commitOnBranch(repo, "dirty-merged", "dirty.txt", "also merged\n");
  await git(repo, "checkout", "main");
  await git(repo, "merge", "--no-ff", "-m", "merge dirty-merged", "dirty-merged");

  // A branch that is merged and has no worktree at all.
  await commitOnBranch(repo, "stale-merged", "stale.txt", "stale\n");
  await git(repo, "checkout", "main");
  await git(repo, "merge", "--no-ff", "-m", "merge stale-merged", "stale-merged");

  await git(repo, "push", "origin", "main");

  // Unmerged work: a worktree and a bare branch.
  await commitOnBranch(repo, "wip", "wip.txt", "in progress\n");
  await commitOnBranch(repo, "keepme", "keep.txt", "unmerged, no worktree\n");

  // Abandoned work, as a closed PR would leave it.
  await commitOnBranch(repo, "abandoned", "abandoned.txt", "closed without merging\n");
  await git(repo, "checkout", "main");

  const paths = {
    merged: join(root, "app-merged"),
    unmerged: join(root, "app-wip"),
    dirty: join(root, "app-dirty"),
    closed: join(root, "app-abandoned"),
  };

  await git(repo, "worktree", "add", paths.merged, "merged-feat");
  await git(repo, "worktree", "add", paths.unmerged, "wip");
  await git(repo, "worktree", "add", paths.dirty, "dirty-merged");
  await git(repo, "worktree", "add", paths.closed, "abandoned");

  // Uncommitted work in the merged worktree, plus an untracked file.
  await writeFile(join(paths.dirty, "README.md"), "# app\nlocal edit\n");
  await writeFile(join(paths.dirty, "scratch.txt"), "untracked scratch\n");

  return { root, repo, origin, paths };
}

async function commitOnBranch(repo: string, branch: string, file: string, body: string) {
  await git(repo, "checkout", "-b", branch, "main");
  await writeFile(join(repo, file), body);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", `work on ${branch}`);
}
