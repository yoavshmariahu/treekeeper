#!/usr/bin/env bash
#
# Publish the current version to npm and tag it.
#
# The one step that cannot be scripted is the second factor. This account's
# 2FA is a passkey, so there is no code to generate ahead of time: the browser
# has to mint a one-time token and the script pauses to let you do that. That
# pause is deliberate and must stay — do not replace it with a bypass-2FA
# token.
#
# Usage:
#   scripts/release.sh                 # publish the version in package.json
#   scripts/release.sh --skip-tests    # trust CI, skip the local suite
#   scripts/release.sh --dry-run       # preflight only, publish nothing
#
set -euo pipefail

SKIP_TESTS=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    -h|--help)    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()    { printf '  \033[32mok\033[0m  %s\n' "$*"; }
fail()  { printf '  \033[31mno\033[0m  %s\n' "$*" >&2; exit 1; }

NAME=$(node -p 'require("./package.json").name')
VERSION=$(node -p 'require("./package.json").version')
TAG="v$VERSION"

bold "Releasing $NAME@$VERSION"

# --- which npm -------------------------------------------------------------
# Below 11.15.0, npm opens the browser and polls at the same time, then throws
# a 404 on its own stale poll *after* the passkey already succeeded. It looks
# like a rejected credential and is not one. Newer npm just prints the URLs.
NPM=(npm)
LOCAL_NPM=$(npm --version)
if [ "$(printf '%s\n11.15.0\n' "$LOCAL_NPM" | sort -V | head -1)" != "11.15.0" ]; then
  NPM=(npx -y npm@latest)
  echo "  local npm $LOCAL_NPM is older than 11.15.0; using 'npx -y npm@latest'"
fi

# --- preflight -------------------------------------------------------------
step "Preflight"

[ -z "$(git status --porcelain)" ] || fail "working tree is dirty; commit or stash first"
ok "working tree clean"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || fail "on branch '$BRANCH', expected main"
ok "on main"

WHO=$(npm whoami 2>/dev/null) || fail "not logged in to npm; run 'npm login'"
ok "logged in as $WHO"

grep -q "^## $VERSION\$" CHANGELOG.md || fail "CHANGELOG.md has no '## $VERSION' section"
ok "CHANGELOG.md documents $VERSION"

if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
  fail "$NAME@$VERSION is already published; bump with 'npm version <patch|minor|major>' first"
fi
ok "$VERSION is not on the registry yet"

if [ "$SKIP_TESTS" -eq 0 ]; then
  npm test >/dev/null 2>&1 || fail "npm test failed; run 'npm test' to see it"
  ok "tests pass"
else
  echo "  --  tests skipped"
fi

# Also builds dist/ via prepack, so this is the real tarball.
PACK_OUT=$(npm pack --dry-run 2>&1)
printf '%s\n' "$PACK_OUT" | grep -E 'package size|unpacked size|total files' | sed 's/npm notice/  /'
ok "tarball builds"

if [ "$DRY_RUN" -eq 1 ]; then
  step "Dry run — stopping before tag and publish"
  exit 0
fi

# --- tag -------------------------------------------------------------------
# Tag before publishing: the OTP is short-lived, so nothing slow goes between
# minting it and the upload.
step "Tag $TAG"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  ok "$TAG already exists (npm version makes its own tag)"
else
  git tag -a "$TAG" -m "$TAG"
  ok "created $TAG"
fi

# --- publish ---------------------------------------------------------------
step "Publish"
echo "  attempting publish to get an auth session (this is expected to fail with EOTP)"

OUT=$("${NPM[@]}" publish 2>&1) && PUBLISH_RC=0 || PUBLISH_RC=$?

if [ "$PUBLISH_RC" -eq 0 ]; then
  ok "published without a second factor"
else
  AUTH_ID=$(printf '%s\n' "$OUT" \
    | grep -oE 'https://www\.npmjs\.com/auth/cli/[A-Za-z0-9._-]+' \
    | head -1 | sed 's|.*/||')

  if [ -z "$AUTH_ID" ]; then
    echo "$OUT" >&2
    echo >&2
    fail "could not find an auth URL in that output; read the URLs above and finish by hand:
       \"${NPM[*]}\" publish --otp=<token>"
  fi

  cat <<EOF

  Authenticate with your passkey, then copy the token:

    1. open  https://www.npmjs.com/auth/cli/$AUTH_ID
             and click "Use security key"
    2. open  https://registry.npmjs.org/-/v1/done?authId=$AUTH_ID
             and copy the token out of the JSON

EOF
  printf '  paste the token here: '
  if [ -r /dev/tty ]; then read -r OTP < /dev/tty; else read -r OTP; fi
  [ -n "$OTP" ] || fail "no token given; nothing was published"

  # Single-use and short-lived, so go straight to the upload.
  "${NPM[@]}" publish --otp="$OTP" || fail "publish failed; the token may have expired — rerun this script"
  ok "published"
fi

# --- after -----------------------------------------------------------------
step "Push tag"
git push --follow-tags
ok "pushed"

step "GitHub release"
if command -v gh >/dev/null 2>&1; then
  NOTES=$(awk -v v="## $VERSION" 'index($0,v)==1{f=1;next} /^## /{f=0} f' CHANGELOG.md)
  if gh release view "$TAG" >/dev/null 2>&1; then
    ok "release $TAG already exists"
  else
    gh release create "$TAG" --title "$TAG" --notes "$NOTES"
    ok "created release $TAG"
  fi
else
  echo "  --  gh not installed; skipping"
fi

step "Verify"
npm view "$NAME@$VERSION" version dist.tarball
echo
echo "  checking the published binary runs..."
npx -y "$NAME@$VERSION" --help >/dev/null 2>&1 \
  && ok "'treekeeper --help' works from the registry" \
  || echo "  --  could not run the published bin; try 'npx -y $NAME@$VERSION --help' yourself"

bold "
Done: $NAME@$VERSION
  https://www.npmjs.com/package/$NAME"
