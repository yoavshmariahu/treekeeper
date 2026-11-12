# Releasing

Published by hand from a laptop. There is deliberately no CI publishing and no
trusted-publisher connection between npm and GitHub Actions.

`scripts/release.sh` drives the whole thing:

```bash
./scripts/release.sh --dry-run    # preflight only, publishes nothing
./scripts/release.sh              # the real thing
```

It publishes whatever version is in `package.json`. For a follow-up release,
bump first — `npm version patch` (or `minor` / `major`) edits `package.json`
and makes the tag, and the script reuses that tag rather than making its own.
Add the matching `## <version>` section to `CHANGELOG.md` before you start, or
the preflight stops you.

## What the script does

1. **Preflight** — clean tree, on `main`, logged in to npm, `CHANGELOG.md` has
   a section for this version, the version is not already on the registry,
   `npm test`, and `npm pack --dry-run`.
2. **Tag** `v<version>`, before publishing, so nothing slow sits between
   minting a one-time token and the upload.
3. **Publish**, pausing for the second factor (below).
4. **After** — `git push --follow-tags`, a `gh` release with notes sliced out
   of the changelog, then `npm view` and an `npx … --help` against the
   published package.

`--skip-tests` skips the local suite, which CI runs on every push anyway.

## Why the package is scoped

The unscoped name `treekeeper` is unavailable — npm's similarity check rejects
it:

```
403 Forbidden - PUT https://registry.npmjs.org/treekeeper
Package name too similar to existing package timekeeper
```

Scoped names are exempt, so the package is `@yoavsh/treekeeper`. The binaries
are unaffected and remain `treekeeper` and `tk`; `bin` names are independent of
the package name. `publishConfig.access` is `public`, so no `--access` flag is
needed.

When you reference the package in docs, keep the scope — a bare
`npx -y treekeeper` resolves to an unrelated package.

## Two-factor authentication

The account has 2FA set to `auth-and-writes`, so every publish needs a second
factor. The account's factor is a passkey, so there is no code to generate
ahead of time: the browser has to mint the token. The script's pause is that
second factor — it is not an obstacle to route around.

The script attempts one publish to open an auth session, which is expected to
fail with `EOTP`, then prints the two URLs and waits:

1. Open `https://www.npmjs.com/auth/cli/<id>`, click **Use security key**,
   authenticate.
2. Open `https://registry.npmjs.org/-/v1/done?authId=<id>` and copy the token
   out of the JSON.
3. Paste it at the prompt — promptly, it is single-use and short-lived. If it
   expires, just rerun the script; the tag and the preflight are idempotent.

If the script cannot find the URLs in npm's output it prints that output raw
and leaves you to finish by hand with
`npx -y npm@latest publish --otp=<token>`.

**With an authenticator app** instead, `npm publish --otp=<6-digit code>` is
enough and none of the above applies.

### Why the script may run npm through npx

npm 11.15.0 or later prints the two URLs. Older versions try to open the
browser and poll at the same time, and throw `HttpErrorGeneral: 404 Not Found`
on their own stale poll *after* authentication has already succeeded — which
looks like a rejected credential and is not one. The script compares the local
npm version and falls back to `npx -y npm@latest` when it is too old, so this
is handled for you.

## Why publish stays this thin

The only lifecycle hook is `prepack`, which runs `tsc`. The test suite
deliberately does **not** run there — a 30-second hook between entering a
one-time password and the upload is long enough for that password to expire.
The script runs the tests up front instead, well before the token exists.

## Things that do not work, and why

- **`npm stage publish`** (staging, which defers 2FA to an approval step) fails
  for a package that does not exist yet: `400 Bad Request ... Version
  uniqueness check failed unexpectedly`. A registry-side bug, despite the docs
  saying staging can create a new package.
- **A granular access token with "Bypass 2FA"** would make publishing
  non-interactive, but it is a credential that defeats the account's second
  factor, and because npm's package picker only lists packages that already
  exist, it would have to be scoped to every package on the account. npm also
  removes direct token publishing in January 2027.
