# Releasing

Published by hand from a laptop. There is deliberately no CI publishing and no
trusted-publisher connection between npm and GitHub Actions.

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

## Publishing a version

```bash
npm version patch        # or minor / major — edits package.json, makes a tag
npm publish              # prepack builds dist/ first
git push --follow-tags
```

Keep `npm publish` fast on purpose: the only lifecycle hook is `prepack`, which
runs `tsc`. The test suite deliberately does **not** run here — it runs in CI on
every push, and a 30-second hook between entering a one-time password and the
upload is long enough for that password to expire. Run `npm test` yourself
before releasing.

## Two-factor authentication

The account has 2FA set to `auth-and-writes`, so every publish needs a second
factor.

**With an authenticator app:** `npm publish --otp=<6-digit code>`.

**With a passkey or security key** there is no code to type, so the browser has
to mint one. npm 11.15.0 or later prints the two URLs you need; older versions
try to open the browser and poll at the same time, and throw
`HttpErrorGeneral: 404 Not Found` on their own stale poll *after* authentication
has already succeeded — which looks like a rejected credential and is not one.
If the system npm is older and package-managed, run a newer one through npx:

```bash
npx -y npm@latest publish          # fails immediately with EOTP + two URLs
```

1. Open `https://www.npmjs.com/auth/cli/<id>`, click **Use security key**,
   authenticate.
2. Open `https://registry.npmjs.org/-/v1/done?authId=<id>` and copy the token
   out of the JSON.
3. `npx -y npm@latest publish --otp=<token>` — promptly, it is single-use and
   short-lived.

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

## Checklist

- [ ] `npm test` passes
- [ ] `CHANGELOG.md` has an entry for the version
- [ ] `npm version <patch|minor|major>`
- [ ] `npm publish`
- [ ] `git push --follow-tags`
