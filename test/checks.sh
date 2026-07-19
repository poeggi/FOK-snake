#!/usr/bin/env bash
# Code checks shared by the pre-commit hook and CI (kept in one place so local
# and CI run exactly the same thing). Fast, no dependencies beyond node + git.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[checks] JS syntax"
for f in js/*.js; do node --check "$f"; done

echo "[checks] ASCII-only sources"
node test/check-ascii.js

echo "[checks] worker snapshot mirrors all sim state"
node test/check-snapshot.js

echo "[checks] no main-thread writes to worker-owned state"
node test/check-ownership.js

echo "[checks] headless smoke tests"
for t in test/smoke-*.js; do node "$t"; done

echo "[checks] two-client handshake (invite / connect over a signal bus)"
node test/net-handshake.js
node test/smoke-worker.js
node test/relay-sim.js

echo "[checks] sim invariants"
node test/sim-invariants.js

echo "[checks] sim determinism"
node test/sim-determinism.js

echo "[checks] sim side-effect sequence"
node test/sim-events.js

echo "[checks] sim headless purity"
node test/sim-purity.js

echo "[checks] mystery-box economy"
node test/box-odds.js

# On-demand deep profile (NOT part of the default run): bash test/checks.sh --profile
# Walks every screen + both game modes + hot helpers and flags items above 8ms.
if [ "${1:-}" = "--profile" ]; then
    echo "[checks] performance profile"
    node test/profile.js
fi
