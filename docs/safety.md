# What treekeeper will and will not delete

treekeeper deletes directories and git branches without being asked, so the rules matter more than the features. They live in one pure function, [`src/core/decide.ts`](../src/core/decide.ts), with a truth table in [`test/decide.test.ts`](../test/decide.test.ts).

## The invariant

> A worktree is removed only when its commits are reachable from the default branch, or its pull request was merged or closed.

Nothing overrides this. `--force` does not. If treekeeper cannot establish that the work landed — no ancestry, no PR data, `gh` missing, GitHub unreachable — the answer is *keep*. Being unable to tell is treated as "not finished", never as "no PR exists".

## Never touched, under any flags

- the repo's main worktree
- the worktree containing your current directory
- a worktree held by `git worktree lock`
- a detached HEAD (no branch to reason about)
- a branch matching `protectBranches` (`main`, `master`, `trunk`, `develop`, `dev`, `release/*` by default)
- a path matching `protectPaths`
- a repo with `{"enabled": false}` in its `.treekeeper.json`
- the default branch, and any branch currently checked out somewhere

## Held back until the coast is clear

These are the gates `--force` bypasses, except where noted:

| Gate | Default | `--force` |
|---|---|---|
| Agent session activity within `sessions.grace` | 20m | **still held** |
| A process whose cwd is inside the worktree | — | **still held** |
| Worktree touched within `minAge` | 30m | bypassed |
| Uncommitted changes (`onDirty`) | archive, then remove | bypassed |
| Merged PR with extra local commits (`onExtraCommits`) | keep | bypassed |
| Closed-unmerged PR inside `closedPrGrace` (`onClosedPr`) | 7d hold, then archive | bypassed |

A live session or a live process always wins. Everything else is a policy you can set.

## Before every removal

1. **Archive.** Commits not on the default branch become a `git bundle`; uncommitted changes become a `git diff HEAD --binary` patch; untracked non-ignored files become a tarball. Each archive has a `RESTORE.md` with the commands to undo it. If archiving fails, the worktree is kept.
2. **Re-verify.** The plan is a snapshot, and a daemon may have built it minutes ago. Immediately before removal treekeeper re-checks that the directory still exists, the branch and HEAD have not moved, the worktree is not newly locked, and no uncommitted changes appeared. Anything that moved is left for the next sweep.
3. **Remove with git.** `git worktree remove`, never a blind `rm -rf`, so git's own bookkeeping stays correct. `--force` is used only after a successful archive.
4. **Log.** A JSON line per removal in `~/.treekeeper/treekeeper.log`: path, branch, size, reason, risks, archive location.

## Concurrency

Multiple agents and multiple sessions share a machine, so:

- a lock file (`~/.treekeeper/sweep.lock`) allows one sweep at a time; a second exits with code 75 rather than racing
- a stale lock from a killed process is detected by pid liveness and cleared
- the `process` detector means a worktree another session is actively sitting in is never a candidate, even if its branch is merged

## Credentials

Remotes with embedded tokens (`https://user:ghp_…@github.com/o/r.git`) are common, and `git` and `gh` echo them in error messages. treekeeper scrubs credentials at the logging chokepoint, so no token reaches the log file, the PR cache or stdout. See [`src/util/redact.ts`](../src/util/redact.ts).

## Branches

Deleting a branch only drops a pointer, but it can still orphan commits, so the same rules apply: unmerged branches are never deleted, and a closed-PR branch is bundled before it goes. A branch still checked out in a worktree treekeeper decided to keep is kept with it.

## Reporting a problem

If treekeeper removed something it should not have, the archive directory and `~/.treekeeper/treekeeper.log` together say exactly what happened and why. Both are worth attaching to an issue.
