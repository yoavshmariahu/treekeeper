# Integrating treekeeper with an agent harness

treekeeper decides from state — git, your forge, and what the agents left on disk — not from harness callbacks. So the best integration is usually **no integration**:

```bash
treekeeper daemon install
```

That installs a launchd agent (macOS) or a systemd user timer (Linux) that sweeps every `interval`. It works for every harness at once, including ones you install next month.

The snippets below are for when you want a sweep tied to a specific moment instead.

## The command to run

Whatever the harness, the hook body is the same:

```bash
npx -y treekeeper gc --all --apply --yes --quiet
```

- `--yes` skips the confirmation prompt (hooks have no TTY)
- `--quiet` prints only the summary line; the full record still goes to `~/.treekeeper/treekeeper.log`
- exit code is 0 on success, 75 if another sweep holds the lock, 1 if something could not be archived

Drop `--all` to limit the sweep to the repo the hook fired in.

## Claude Code

Add a `SessionEnd` hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "npx -y treekeeper gc --all --apply --yes --quiet" }
        ]
      }
    ]
  }
}
```

treekeeper reads `~/.claude/projects/<slugified-cwd>/*.jsonl` to tell when a Claude Code session last touched a worktree, so a sweep triggered by one session will not remove a worktree another session is still using. Set `CLAUDE_CONFIG_DIR` if your config lives elsewhere.

A slash command is often nicer than a hook, because you see the plan first. `~/.claude/commands/gc.md`:

```markdown
---
description: Remove worktrees and branches whose work is already merged
allowed-tools: Bash(treekeeper:*)
---

Run `treekeeper gc --all` and show me the plan. If it looks right, run it with `--apply --yes`.
```

## Codex CLI

treekeeper detects Codex activity from `~/.codex/sessions/**/*.jsonl` (matching the recorded `cwd`). To sweep on a schedule instead, use the daemon. To sweep from a notify hook in `~/.codex/config.toml`:

```toml
notify = ["bash", "-lc", "npx -y treekeeper gc --all --apply --yes --quiet"]
```

## Cursor / Windsurf / JetBrains agents

These keep session state in editor-internal databases, so treekeeper relies on its generic detectors instead — the `process` detector (an agent working in a directory is a process whose cwd is that directory) and `mtime`. Both are on by default and need no setup; just run the daemon.

## Aider

`.aider.chat.history.md` inside the worktree is the activity signal, and it is on by default. For a sweep after each session, wrap your invocation:

```bash
aider "$@"; npx -y treekeeper gc --apply --yes --quiet
```

## A harness treekeeper has never heard of

Teach it the activity signal rather than wiring up a hook. Either point at a file whose mtime tracks the session:

```json
{
  "sessions": {
    "extraPaths": ["{worktree}/.myagent/session.log", "~/.myharness/state/{worktree}.json"]
  }
}
```

...or give it a command, where exit 0 means "an agent is still working here":

```json
{
  "sessions": {
    "commands": [
      { "name": "myharness", "command": "pgrep -f \"myharness.*$TREEKEEPER_WORKTREE\" > /dev/null" }
    ]
  }
}
```

`$TREEKEEPER_WORKTREE` is set to the worktree being considered.

## Reading the plan from a script

```bash
treekeeper gc --all --json > plan.json

jq '.summary' plan.json
jq -r '.repos[].worktrees[] | select(.verdict.action == "reclaim") | "\(.path)\t\(.sizeKb)\t\(.verdict.reason)"' plan.json
jq -r '.repos[].worktrees[] | select(.verdict.action == "keep") | "\(.path)\t\(.verdict.code)"' plan.json
```

Each worktree carries a `verdict` with a stable `code` (`merged-ancestor`, `unmerged`, `session-active`, `too-young`, `dirty`, `closed-pr-grace`, `protected-branch`, …), a human `reason`, and the `risks` that would need archiving. Script against `code`, show `reason` to people.

With `--apply --json` you get `{ "plan": …, "result": … }`, where `result` lists what was removed, what was archived and what was skipped.

## CI

treekeeper is built for developer machines, where worktrees outlive their usefulness. In CI, where the checkout is thrown away anyway, it buys you nothing — except on a long-lived self-hosted runner, where a nightly job is reasonable:

```yaml
- run: npx -y treekeeper gc --root "$RUNNER_WORKDIR" --apply --yes
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Set `archive.enabled: false` there if the runner has no business keeping archives.
