#!/usr/bin/env bash
# Code checks shared by the pre-commit hook and CI (kept in one place so local
# and CI run exactly the same thing). Fast, no dependencies beyond node + git.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[checks] JS syntax"
for f in js/*.js; do node --check "$f"; done

echo "[checks] ASCII-only sources"
node test/check-ascii.js

echo "[checks] headless smoke test"
node test/smoke.js

echo "[checks] sim invariants"
node test/sim-invariants.js

echo "[checks] sim determinism"
node test/sim-determinism.js

echo "[checks] sim side-effect sequence"
node test/sim-events.js

echo "[checks] sim headless purity"
node test/sim-purity.js
