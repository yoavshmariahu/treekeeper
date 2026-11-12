# Contributing

```bash
npm install
npm test          # unit tests + integration tests against real git repos
npm run typecheck
npm run build
node dist/cli.js gc --all     # always a dry run without --apply
```

## Layout

```
src/core/decide.ts     the rules: pure, no I/O, fully unit-tested
src/core/plan.ts       gathers facts and builds a plan
src/core/apply.ts      archives, re-verifies, then removes
src/core/sessions.ts   "is an agent still working here?" detectors
src/core/forge.ts      pull-request state via the gh CLI
src/daemon/            launchd / systemd scheduling, lock, state
src/commands/          one file per CLI command
```

## Ground rules

- **Decisions stay pure.** New rules go in `decide.ts` as a function of facts, with a test case. Signal gathering stays in `plan.ts` and `sessions.ts`.
- **Nothing is removed without an archive and a re-verify.** If you add a removal path, it goes through `applyPlan`.
- **Keep runtime dependencies at zero.** Dev dependencies are fine.
- **Any new signal source needs a test against a real repo.** See `test/fixture.ts` — it builds an actual repo with real worktrees, and `test/stub-forge.ts` fakes pull-request state.

## Adding a session detector

Add it to `src/core/sessions.ts`, register the name in `config.ts` (`normalize`'s known-detector list and the default list), and document it in the README table. A detector returns the epoch-ms timestamp of the most recent activity, or `null`. Prefer a cheap check: detectors run per worktree, on every sweep.

Before writing a new detector, check whether the generic `process` and `mtime` detectors already cover your harness — they usually do.

## Releasing

Published by hand — see [RELEASING.md](RELEASING.md).
