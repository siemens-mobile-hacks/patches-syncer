#!/bin/bash
set -e
set -x

SYNCER="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$SYNCER/node_modules/.bin/tsx"

# Run update
(cd "$SYNCER" && pnpm install --frozen-lockfile)
"$TSX" "$SYNCER/src/syncPatches.ts" --cookie="$KIBAB_TEST_USER" "$@"
"$TSX" "$SYNCER/src/getBadPatches.ts" > bad.md

# Commit
git config --local core.hooksPath /notexistent
git config --local user.email "41898282+github-actions[bot]@users.noreply.github.com"
git config --local user.name "github-actions[bot]"

export TZ=
git diff --exit-code patches bad.md || {
	git stash
	git pull
	git stash pop
	"$TSX" "$SYNCER/src/commitPatches.ts"
	git push
}

# Reset git settings
git config --local --unset user.email
git config --local --unset user.name
