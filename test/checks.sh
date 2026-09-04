#!/usr/bin/env bash
# Code checks, no dependencies beyond node + git. Two tiers, one script:
#
#   bash test/checks.sh            FAST tier (the local pre-commit hook): every cheap
#                                  correctness guard -- syntax, ASCII, sim determinism
#                                  and invariants, all smoke tests, and the
#                                  single-scenario netcode paths (handshake, worker,
#                                  clock burst). Snappy enough to run on every commit.
#
#   bash test/checks.sh --full     REGRESSION tier (CI + after any significant
#     (or --regression)            netcode/sim rework, before a release): FAST plus the
#                                  heavy duel sweeps. Those play many full 20-40s
#                                  lockstep matches over lossy/dozing/dropped wires to
#                                  shake out rare, slow-accumulation divergence and
#                                  prove interruption recovery.
#
# The suite table lives in test/run-suites.js, which runs the suites ACROSS CORES: each
# one is a pure, isolated process, so nothing but the old shell loop made them wait for
# each other. Set JOBS=1 for a serial run when a failure is easier to read that way.
# Arguments after the tier go straight to it, which is how the CI matrix asks for its
# slice of the work: bash test/checks.sh --full --shard 2/5.
#
# CI runs --full on every push/PR, so the regression tier still gates the auto-deploy to
# Pages. See test/README.md ("Test tiers") for which suites live where and why.
set -euo pipefail
cd "$(dirname "$0")/.."

# Tier + on-demand-profile selection from the first arg. The deep profilers imply the
# full suite (you would not profile a half-run). Anything else is a usage error rather
# than a silent fast run.
case "${1:-}" in
    ""|--fast)              TIER=--fast ;;
    --full|--regression)    TIER=--full ;;
    --profile|--netprofile) TIER=--full ;;
    --live)                 TIER=--fast ;;
    *) echo "usage: bash test/checks.sh [--full|--regression|--profile|--netprofile|--live]"; exit 2 ;;
esac

node test/run-suites.js "$TIER" "${@:2}"

if [ "$TIER" = --fast ]; then
    echo "[checks] (fast tier) skipping the heavy duel sweeps -- run 'bash test/checks.sh --full' after any netcode/sim rework"
fi

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
# gate neither a commit nor a push. Two contracts live here: the peer-net hint the
# direct-IPv6 path depends on (see test/peer-net.sh), and the API 4.0 item registry,
# where a client/server disagreement over the attestation MAC would otherwise show up
# only as a duel that silently refuses every steal.
if [ "${1:-}" = "--live" ]; then
    echo "[checks] live server: peer-net direct-connection hint"
    bash test/peer-net.sh
    echo "[checks] live server: item registry contract"
    node test/items-live.js
fi
