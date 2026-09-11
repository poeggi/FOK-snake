# Versioning is automated by the pre-commit hook; the gate is load-bearing

- Tracked hook `.githooks/pre-commit` (local `core.hooksPath=.githooks`) runs
  on every commit: runs the FAST checks, stamps APP_VERSION into js/assets.js
  and stages it, then rewrites sw.js (AUTO-MANAGED header, `// version`
  comment, `const CACHE`, `const ASSETS` = path -> first 12 hex of the STAGED
  blob id, from `git ls-files -s` js/css/json/svg/woff2/woff/ttf minus sw.js
  and ^(test/|.github/), './' = index.html) and `git add sw.js`. Checks run
  BEFORE the bump. Needs Git Bash on Windows. test/check-sw.js (CI) verifies
  the three stamps agree and every id matches the tree.
- Version `snake-vMAJOR.MINOR.PATCH`: MAJOR.MINOR from the latest `v[0-9]*`
  tag, PATCH auto-increments and resets to 0 when MAJOR.MINOR changes vs
  sw.js. The in-game version is read at runtime from the cache key.
- NEVER hand-edit sw.js or any version string. New assets appear in ASSETS
  only if tracked/staged.
- To bump MINOR: annotated tag `vX.Y.0` -> commit (hook resets PATCH) ->
  `git tag -f vX.Y.0 HEAD` -> push branch+tag. Squash into X.Y.0: restore the
  base stamps (`git checkout <base> -- sw.js js/assets.js`) and put the
  annotated tag on the base commit BEFORE committing, then `git tag -fa` after.

## THE VERSION GATE
Clients matchmake on MAJOR.MINOR only, so patches interop. ANY sim rule change
(one two clients can DISAGREE about mid-match: movement, collision, spawn,
scoring maths) MUST bump MINOR or old+new clients silently desync. A change
that only alters emitted side effects (achievement thresholds, cosmetics) is
not one: regoldening sim-events is not evidence a minor is owed; regoldening
sim-determinism is.

Deliberate overrides exist (2.6.9 dirQueue, two 2.7.x lockstep changes shipped
as patches). Accepted; do not re-litigate or retag. When an override is asked
for: state the cost once, then ship it.

APP_VERSION carries a leading `v` on the wire. Version tests pin the FORMAT of
APP_VERSION (accept optional v, force its major), never a number: the hook
rewrites the number after checks run.
