# Releasing

## How releases work

Tag a version and GitHub Actions publishes it. `.github/workflows/release.yml`
authenticates to npm with **trusted publishing** (OIDC), so there is no npm
token stored in the repository, in Actions secrets, or on anyone's laptop.

```bash
npm version patch          # or minor / major — writes package.json and tags
git push --follow-tags
```

The workflow runs typecheck, the test suite and a clean build, refuses to
continue if the tag disagrees with `package.json`, then publishes. Provenance
is attached automatically; `--provenance` is not needed and is not passed.

## Why the package is scoped

The unscoped name `treekeeper` is unavailable: npm's similarity check rejects
it with

```
403 Forbidden - PUT https://registry.npmjs.org/treekeeper
Package name too similar to existing package timekeeper
```

Scoped names are exempt from that check, so the package publishes as
`@yoavsh/treekeeper`. The binaries are unaffected and remain `treekeeper` and
`tk` — `bin` names are independent of the package name. `publishConfig.access`
is set to `public` in `package.json`, so a scoped publish does not need
`--access public` on the command line.

## One-time setup

Trusted publishing is configured per package, in the package's own settings on
npmjs.com — which means **it cannot be configured until the package exists**.
The very first version therefore has to be published from a laptop, once.

### Step 1 — the first publish (once, by hand)

Use **staged publishing**, not `npm publish`. Staging splits the operation in
two: uploading the tarball needs no second factor, and the 2FA challenge moves
to a separate approval step you complete in the browser. That matters here for
two reasons — it works with a passkey as the only second factor, and it means
no token with "Bypass 2FA" ever has to exist. npm's own guidance says the same:
*"We encourage you to delete all your tokens with bypass enabled and switch to
using a trust relationship in your automated workflows, or create a GAT
without bypass and use `npm stage publish`."*

Staging needs npm **11.15.0+** and Node **22.14.0+**. If the system npm is
older, run a newer one through npx rather than replacing a package-managed
install:

```bash
npm --version                        # 11.15.0 or later?
npx -y npm@latest stage publish      # ...if not
npm stage publish                    # ...if so
```

Add `--dry-run` first to see the tarball without staging anything.

Staging a name that does not yet exist creates it as a public `0.0.0-stage`
placeholder. The name becomes visible immediately; the staged tarball's
contents stay private until approval.

Then approve, which is where the second factor is required:

- **Browser:** npmjs.com → your account → **Staged Packages** → the version →
  **Approve**, and complete the 2FA challenge.
- **CLI:** `npm stage list treekeeper` to get the stage id, then
  `npm stage approve <stage-id>`.

You are prompted for 2FA either way. On approval the version is published to
the package page as a normal release.

#### Why not `npm publish` directly

It works, but on an account with 2FA set to `auth-and-writes` it demands a
second factor inline, and that flow has a race worth recognising: npm opens the
browser and polls `/-/v1/done?authId=…` at the same time. Approving in the
browser consumes the session, the second poll returns `404`, and npm throws
`HttpErrorGeneral: 404 Not Found` *after* authentication already succeeded — so
the credential is written but the upload never happens, and `npm whoami` works
afterwards, which makes it look like a rejected credential. With an
authenticator app you can skip the flow with `npm publish --otp=<code>`. With a
passkey there is no code to type, so stage-and-approve is the route.

### Step 2 — connect the trusted publisher (once)

npmjs.com → **@yoavsh/treekeeper** → **Settings** → **Trusted Publisher** →
GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `yoavshmariahu` |
| Repository | `treekeeper` |
| Workflow filename | `release.yml` |
| Environment name | *(leave empty)* |
| Allowed actions | enable **npm publish** |

Or from the CLI, which needs npm 11.15.0+ and 2FA enabled on the account
(trust commands reject a bypass-2FA token outright):

```bash
npm trust github @yoavsh/treekeeper --file release.yml --repo yoavshmariahu/treekeeper --allow-publish
npm trust list @yoavsh/treekeeper
```

Notes that will save you time:

- All fields are case-sensitive and **npm does not validate them on save** —
  a typo only surfaces as a failed publish.
- A connection cannot be edited after creation. Delete and recreate instead.
- A new configuration must complete a successful publish within **2 days** or
  it expires.
- `package.json`'s `repository.url` must match the GitHub repository exactly.
  It does today; if the repo is ever renamed or moved, update it or publishing
  breaks.
- A token issued through a trust relationship can run `npm publish` and
  `npm stage publish`, but never the other `npm stage` subcommands — so if the
  workflow is set to stage rather than publish, approval always stays manual.
- The docs disagree on how many trusted publishers a package may have (the CLI
  page says one, the website docs say ten). Assume one until you need a second.

### Step 3 — lock it down (once)

With OIDC working, set npmjs.com → **@yoavsh/treekeeper** → **Settings** →
**Publishing access** → **Require two-factor authentication and disallow
tokens**. This does not affect the OIDC workflow, and it means a stolen npm
token cannot publish treekeeper at all. Then delete any token from step 1.

## Why not just keep using a token?

GitHub has announced that **direct publishing with a granular access token
will be removed in January 2027**; bypass-2FA tokens are already barred from
account and governance actions as of August 2026. Trusted publishing is the
path that does not need revisiting.

## Checklist

- [ ] `CHANGELOG.md` has an entry for the version
- [ ] `npm version <patch|minor|major>`
- [ ] `git push --follow-tags`
- [ ] the `release` workflow went green, and the version is on npm
