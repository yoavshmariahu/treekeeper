# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/yoavshmariahu/treekeeper/security/advisories/new)
instead, which opens a draft advisory only the maintainers can see.

Expect an acknowledgement within a few days.

## What counts as a vulnerability here

treekeeper deletes directories and reads credentials that other tools hand it,
so the interesting classes are:

- **Work destroyed without a recoverable archive.** A path where a worktree or
  branch is removed and the archive is missing, empty or does not restore. This
  is the most serious category; the archive is the only thing that makes
  unattended removal defensible.
- **A credential reaching disk or a terminal.** Remotes routinely carry tokens
  (`https://user:ghp_…@github.com/o/r.git`) and `git` and `gh` echo them in
  error text. Everything is scrubbed at a single logging chokepoint
  ([`src/util/redact.ts`](src/util/redact.ts)) and in the pull-request cache. A
  token that gets past it belongs here, not in a public issue.
- **Removal outside the intended scope** — anything deleted outside a
  configured root, or a path traversal through a crafted branch name, worktree
  path or config value.
- **Privilege or persistence surprises** in the installed launchd plist or
  systemd unit.

A worktree that was *kept* when it could have gone is a normal bug, not a
vulnerability — open an issue.

## Scope

Supported: the latest published version on the default branch. There are no
runtime dependencies, so advisories for this package concern its own code.
