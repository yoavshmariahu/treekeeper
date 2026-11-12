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

## One-time setup

Trusted publishing is configured per package, in the package's own settings on
npmjs.com — which means **it cannot be configured until the package exists**.
The very first version therefore has to be published from a laptop, once.

### Step 1 — the first publish (once, by hand)

npm accounts with 2FA set to `auth-and-writes` are prompted for a second
factor on every publish. Two ways through it:

- **Authenticator app:** `npm publish --otp=<6-digit code>`. Use a fresh code;
  `prepublishOnly` runs typecheck and the full suite first and spends about
  30 seconds before the upload starts.
- **Passkey or security key, or if the browser confirmation keeps failing:**
  create a granular access token on npmjs.com (Access Tokens → Generate New
  Token → Granular) with **Read and write (publish and stage)** on this
  package and **Bypass 2FA enabled**, give it a short expiry, then
  `npm config set //registry.npmjs.org/:_authToken <token>` and
  `npm publish`. Revoke the token once step 2 is done.

The browser confirmation flow has a race worth recognising: npm opens the
browser and polls `/-/v1/done?authId=…` at the same time. Approving in the
browser consumes the session, the second poll returns `404`, and npm throws
`HttpErrorGeneral: 404 Not Found` *after* authentication already succeeded —
so the credential is written but the upload never happens. `npm whoami` will
work afterwards. Re-running with `--otp` avoids the flow entirely.

### Step 2 — connect the trusted publisher (once)

npmjs.com → **treekeeper** → **Settings** → **Trusted Publisher** → GitHub
Actions:

| Field | Value |
| --- | --- |
| Organization or user | `yoavshmariahu` |
| Repository | `treekeeper` |
| Workflow filename | `release.yml` |
| Environment name | *(leave empty)* |
| Allowed actions | enable **npm publish** |

Notes that will save you time:

- All fields are case-sensitive and **npm does not validate them on save** —
  a typo only surfaces as a failed publish.
- A connection cannot be edited after creation. Delete and recreate instead.
- A new configuration must complete a successful publish within **2 days** or
  it expires.
- `package.json`'s `repository.url` must match the GitHub repository exactly.
  It does today; if the repo is ever renamed or moved, update it or publishing
  breaks.

### Step 3 — lock it down (once)

With OIDC working, set npmjs.com → **treekeeper** → **Settings** →
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
