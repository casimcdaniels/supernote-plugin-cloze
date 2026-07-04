#!/bin/bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: ./release.sh <version> [--dry-run]

<version> is anything `npm version` accepts:
  - an explicit semver, e.g. 1.2.0
  - a bump keyword: patch | minor | major | prepatch | preminor | premajor | prerelease

Bumps package.json, builds the plugin via buildPlugin.sh, commits the version
bump, tags it vX.Y.Z, pushes both, and creates a GitHub release with
build/outputs/<name>.snplg attached.

--dry-run: bumps the version and builds so you can inspect the .snplg, then
           reverts package.json and stops — no commit, tag, push, or release.

Requires: gh (authenticated via `gh auth login`), npm, git; a clean working tree.
EOF
  exit 1
}

[[ $# -ge 1 && $# -le 2 ]] || usage
VERSION_ARG="$1"
[[ "$VERSION_ARG" != "-h" && "$VERSION_ARG" != "--help" ]] || usage

DRY_RUN=0
if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ -n "${2:-}" ]]; then
  usage
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

command -v npm >/dev/null 2>&1 || { echo "Error: npm is required." >&2; exit 1; }
if [[ "$DRY_RUN" -eq 0 ]]; then
  command -v gh >/dev/null 2>&1 || { echo "Error: install the GitHub CLI: https://cli.github.com" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "Error: run 'gh auth login' first." >&2; exit 1; }
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree has uncommitted changes:" >&2
  git status --short >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$DRY_RUN" -eq 0 && "$BRANCH" != "main" ]]; then
  read -r -p "You're on branch '$BRANCH', not 'main'. Continue? [y/N] " REPLY
  [[ "$REPLY" =~ ^[Yy]$ ]] || exit 1
fi

# npm version writes package.json/package-lock.json immediately, before we've
# committed anything — if anything below fails, put them back the way they were.
cleanup_bump() {
  if [[ -n "$(git status --porcelain -- package.json package-lock.json 2>/dev/null)" ]]; then
    echo "==> Reverting local version bump" >&2
    git checkout -- package.json package-lock.json 2>/dev/null || git checkout -- package.json
  fi
}
trap cleanup_bump ERR

echo "==> Bumping version ($VERSION_ARG)"
NPM_TAG="$(npm version "$VERSION_ARG" --no-git-tag-version)"
NEW_VERSION="${NPM_TAG#v}"
TAG="v${NEW_VERSION}"

if [[ "$DRY_RUN" -eq 0 ]] && git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists." >&2
  exit 1
fi

echo "==> Building plugin"
./buildPlugin.sh

PACKAGE_NAME="$(node -p "require('./package.json').name")"
SNPLG_PATH="build/outputs/${PACKAGE_NAME}.snplg"
[[ -f "$SNPLG_PATH" ]] || { echo "Error: expected build output not found at $SNPLG_PATH" >&2; exit 1; }

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "==> Dry run complete. Built: $SNPLG_PATH (version $NEW_VERSION)"
  cleanup_bump
  trap - ERR
  exit 0
fi

echo "==> Committing version bump"
git add package.json package-lock.json 2>/dev/null || git add package.json
git commit -m "chore: release ${TAG}"

echo "==> Tagging ${TAG}"
git tag -a "$TAG" -m "Release ${TAG}"

echo "==> Pushing commit and tag"
git push origin "$BRANCH"
git push origin "$TAG"

echo "==> Creating GitHub release"
gh release create "$TAG" "$SNPLG_PATH" --title "$TAG" --generate-notes

trap - ERR
echo "Done: $(gh release view "$TAG" --json url -q .url)"
