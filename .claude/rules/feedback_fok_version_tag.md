# Versioning is fully automated by the pre-commit hook

Versioning is AUTOMATED. Never hand-edit sw.js or any in-game version string.

## How it works
- Tracked hook at `.githooks/pre-commit`, wired via local `core.hooksPath = .githooks`. Runs on EVERY commit.
- Version = semantic `snake-vMAJOR.MINOR.PATCH`:
  - MAJOR.MINOR is derived from the latest git tag (`git describe --tags --abbrev=0`, strips leading `v`). Tag `v1.3.0` -> `1.3`.
  - PATCH auto-increments each commit; resets to 0 when MAJOR.MINOR changes vs what is in sw.js.
- The hook rewrites sw.js: line-1 AUTO-MANAGED header, `// version ...` comment (duplicated with CACHE for bogus-update detection), `const CACHE`, and `const ASSETS` (rebuilt from `git ls-files` of js/css/json/svg/woff2/woff/ttf, minus sw.js). Then `git add sw.js`.
- The in-game version string is read at RUNTIME from the cache key: `_swVersion` = the caches.keys() entry starting `snake-` (game.js), rendered in drawMenu bottom-left.

## How to apply (CRITICAL)
- Never hand-edit sw.js version/CACHE/ASSETS -- the hook overwrites them; manual edits are pointless.
- Never hand-edit an in-game version string -- there is none to edit; it derives from the cache key.
- To bump MAJOR.MINOR: create a git tag (e.g. `git tag v1.4.0`); the next commit's hook picks it up and resets PATCH to 0.
- New asset files auto-appear in ASSETS on commit, but only if tracked/staged -- `git add` them.
- The hook needs bash + sed/awk/date (Git Bash on Windows). Commits trigger it automatically since core.hooksPath is set locally.
- No non-ASCII in source; run git with an explicit repo path (`git -C`).
