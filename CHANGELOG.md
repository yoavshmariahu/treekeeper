# Changelog

## 0.1.0

First release.

- `treekeeper gc` — plan and apply worktree and branch cleanup, dry run by default
- Detects finished work from git ancestry and from merged or closed pull requests (via `gh`), so squash merges are caught
- Holds back worktrees with live agent sessions (Claude Code, Codex, Aider), live processes, recent changes, or uncommitted work
- Archives unmerged commits, uncommitted diffs and untracked files before any removal, with a `RESTORE.md`
- `treekeeper daemon install` — launchd (macOS) and systemd user timers (Linux)
- `status`, `watch`, `archive`, `config` and `doctor` commands
- `--json` output for any harness to read
- Credential scrubbing for all output and cached data
