# Summary

Synchronizer for [siemens-mobile-hacks/patches](https://github.com/siemens-mobile-hacks/patches), the git mirror of [https://patches.kibab.com](https://patches.kibab.com).

It downloads patches from the site, checks them for common problems and commits every patch change as a separate commit.

# Usage

All commands run in the directory of the patches repository.

```shell
git clone https://github.com/siemens-mobile-hacks/patches
git clone https://github.com/siemens-mobile-hacks/patches-syncer
cd patches-syncer && pnpm install && cd ../patches

TSX=../patches-syncer/node_modules/.bin/tsx
$TSX ../patches-syncer/src/syncPatches.ts --cookie=login:password_hash  # download changed patches
$TSX ../patches-syncer/src/getBadPatches.ts > bad.md                    # update bad patches list
$TSX ../patches-syncer/src/commitPatches.ts --dry-run                   # show commits which would be created
$TSX ../patches-syncer/src/commitPatches.ts                             # commit changes
```

`syncPatches.ts` options:

| Option                 | Description                         |
|------------------------|-------------------------------------|
| `--cookie`             | Kibab cookie: `login:password_hash` |
| `--full-sync`          | Run full sync (~3h)                 |
| `--from-model <model>` | Run sync starting from the model    |
| `--patches <ids>`      | Patches IDs for partial sync        |

`commitPatches.ts` creates one commit per changed patch, dated by the patch mtime. If more than 100 patches changed at once, it creates one commit for all of them. Changes in `bad.md` are committed separately.

# CI

The sync workflow lives in the patches repository and runs [tools/ci.sh](tools/ci.sh) from the patches directory every day.

# AI-assisted contributions

We are not against AI. We are against vibe coding, AI slop, and attempts to offload engineering work to a model. This project prioritizes quality, not development speed or results at any cost.

1. **Do not use AI-generated text in human-to-human communication.**

   Write comments, discussions, PR descriptions, and responses to reviewers yourself.

2. **Do not let AI submit PRs or commits.**

   The author must always be a human who has personally reviewed the changes and takes responsibility for them.

4. **Do not submit code primarily designed or written by AI.**

   Architecture, algorithms, code organization, and the final implementation must be decided by a human. AI may only be used as an auxiliary tool.

6. **You must understand all the code you submit.**

   You must be able to explain every change, justify your decisions, and fix any problems yourself. If you do not understand the code, open a feature request instead of a PR.

8. **Code must be simple, clear, and tested.**

   Follow KISS, the project's coding style, and its existing architecture. Do not introduce unnecessary abstractions, dependencies, or untested changes.

AI slop PRs will be closed without review.
