#!/usr/bin/env bash
# Code checks, no dependencies beyond node + git. Two tiers, one script:
#
#   bash test/checks.sh            FAST tier (the local pre-commit hook): every
#                                  cheap correctness guard -- syntax, ASCII, sim
#                                  determinism/invariants, all smoke tests, and the
#                                  single-scenario netcode paths (handshake, worker,
#                                  relay, clock burst). ~8s. Snappy enough to run on
#                                  every commit.
#
#   bash test/checks.sh --full     REGRESSION tier (CI + after any significant
#     (or --regression)            netcode/sim rework, before a release): FAST plus
#                                  the six heavy duel sweeps (duel-desync/-boundary/
#                                  -epoch/-rematch/-respawn/-outage). Those play many full
#                                  20-40s lockstep matches over lossy/dozing/dropped
#                                  wires to shake out rare, slow-accumulation
#                                  divergence and prove interruption recovery. ~2min.
#
# CI runs --full on every push/PR, so the regression tier still gates the auto-deploy
# to Pages -- moving it off the local hook trades nothing but the developer's wait.
# See test/README.md ("Test tiers") for which suites live where and why.
set -euo pipefail
cd "$(dirname "$0")/.."

# Tier + on-demand-profile selection from the first arg. The deep profilers imply the
# full suite (you would not profile a half-run). Anything else is a usage error rather
# than a silent fast run.
FULL=0
case "${1:-}" in
    ""|--fast)              FULL=0 ;;
    --full|--regression)    FULL=1 ;;
    --profile|--netprofile) FULL=1 ;;
    --live)                 FULL=0 ;;
    *) echo "usage: bash test/checks.sh [--full|--regression|--profile|--netprofile|--live]"; exit 2 ;;
esac

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

echo "[checks] shipped sources stay on the supported browser floor"
node test/check-compat.js

echo "[checks] worker snapshot mirrors all sim state"
node test/check-snapshot.js

echo "[checks] no main-thread writes to worker-owned state"
node test/check-ownership.js

echo "[checks] headless smoke tests"
for t in test/smoke-*.js; do suite "$t"; done

echo "[checks] service-worker fetch policy: a slow uplink falls back to cache within the timeout, API traffic never does"
suite test/sw-cache.js

echo "[checks] two-client handshake (invite / connect over a signal bus)"
suite test/net-handshake.js
suite test/smoke-worker.js

echo "[checks] P2P boundary clock burst: both sides agree on the peer offset and nudge to the shared midpoint"
suite test/duel-sync.js

echo "[checks] duel banners: CONNECTION LOST is pure silence (refusals never flash), OUT OF SYNC tracks a hash divergence"
suite test/duel-warn.js

echo "[checks] touch input funnel: a same-direction swipe collapses onto the dpad (no per-48px flood), real turns still author"
suite test/duel-touch.js

# --- REGRESSION tier: the heavy duel sweeps (many long lockstep matches). Skipped by
# the fast pre-commit run; CI (--full) and a manual --full after a netcode/sim rework
# run them. Each plays real 20-40s boosting matches over lossy/dozing wires -- the only
# way rare, slow-accumulation divergence shows up -- so together they dominate runtime.
if [ "$FULL" = 1 ]; then
    echo "[checks] boosting duel stays in lockstep (two clients, real match, over a lossy wire)"
    suite test/duel-desync.js

    echo "[checks] P2P level boundary holds lockstep (host bursts to the shared midpoint, ships bth on the go)"
    suite test/duel-boundary.js

    echo "[checks] a lost boundary begin is repaired, not survived silently (no split onto separate tick bases)"
    suite test/duel-epoch.js

    echo "[checks] server-path restart (rematch) holds lockstep (host bursts to the shared midpoint on every start)"
    suite test/duel-rematch.js

    echo "[checks] post-death respawn is clean (a full resync never yanks your own snake back to a death cell)"
    suite test/duel-respawn.js

    echo "[checks] connection-interruption recovery (a <4s wire outage is survived; an over-long one still kills)"
    suite test/duel-outage.js

    echo "[checks] one-sided suspend recovery (a backgrounded client re-anchors its tick base and re-converges; the live side never jumps)"
    suite test/duel-suspend.js

    echo "[checks] rollback is one-sided under a clock offset (falls on the AHEAD client; a modest skew is absorbed, lockstep holds)"
    suite test/duel-asym.js

    echo "[checks] wall-clock drift immunity (the lockstep timeline rides the monotonic clock; an NTP slew/step is inert)"
    suite test/duel-drift.js
else
    echo "[checks] (fast tier) skipping heavy duel sweeps -- run 'bash test/checks.sh --full' after any netcode/sim rework"
fi

echo "[checks] duel sim rules (speed round per-level stable across respawns; fragile bars crush like single player)"
suite test/sim-duel.js

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

# On-demand netcode profile (NOT part of the default run): bash test/checks.sh --netprofile
# Two clients over a simulated wire; reports rollback rate/depth, live-apply ratio and the
# warm-ping A/B across realistic links, so the lag/artifact bottleneck is a number.
if [ "${1:-}" = "--netprofile" ]; then
    echo "[checks] two-client duel netcode profile"
    node test/duel-profile.js
fi

# On-demand LIVE server contract (NOT part of the default run, and never in CI):
# bash test/checks.sh --live. Needs the network and a running deployment, so it can
# gate neither a commit nor a push. Checks the peer-net hint the direct-IPv6 path
# depends on -- see test/peer-net.sh for what breaks silently when it regresses.
if [ "${1:-}" = "--live" ]; then
    echo "[checks] live server: peer-net direct-connection hint"
    bash test/peer-net.sh
fi
