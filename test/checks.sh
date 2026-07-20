#!/usr/bin/env bash
# Code checks shared by the pre-commit hook and CI (kept in one place so local
# and CI run exactly the same thing). Fast, no dependencies beyond node + git.
set -euo pipefail
cd "$(dirname "$0")/.."

# A suite whose async body stalls (an await that never settles) drains the event
# loop and exits 0 having asserted NOTHING -- which read as a pass and hid a real
# regression. Every suite that ends in a completion banner must actually show it.
suite(){
    local out
    out="$(node "$1")" || { printf '%s\n' "$out"; return 1; }
    printf '%s\n' "$out"
    case "$out" in
        *PASSED*) ;;
        *) echo "[checks] $1 exited 0 with no PASSED banner -- stalled or silently skipped"; return 1 ;;
    esac
}

echo "[checks] JS syntax"
for f in js/*.js; do node --check "$f"; done

echo "[checks] ASCII-only sources"
node test/check-ascii.js

echo "[checks] worker snapshot mirrors all sim state"
node test/check-snapshot.js

echo "[checks] no main-thread writes to worker-owned state"
node test/check-ownership.js

echo "[checks] headless smoke tests"
for t in test/smoke-*.js; do suite "$t"; done

echo "[checks] two-client handshake (invite / connect over a signal bus)"
suite test/net-handshake.js
suite test/smoke-worker.js
suite test/relay-sim.js

echo "[checks] sim invariants"
suite test/sim-invariants.js

echo "[checks] sim determinism"
suite test/sim-determinism.js

echo "[checks] sim side-effect sequence"
suite test/sim-events.js

echo "[checks] sim headless purity"
node test/sim-purity.js

echo "[checks] mystery-box economy"
suite test/box-odds.js

# On-demand deep profile (NOT part of the default run): bash test/checks.sh --profile
# Walks every screen + both game modes + hot helpers and flags items above 8ms.
if [ "${1:-}" = "--profile" ]; then
    echo "[checks] performance profile"
    node test/profile.js
fi
