# Duel lockstep invariants (tick model, headroom, boundary, clock, dirQueue)

Online 1vs1 is deterministic lockstep: no host authority over the sim,
inputs-only JSON on the wire (redundant input log + ~1/s state hash),
rollback, WebRTC + HTTP relay fallback, NET_PKT_MAX=1200 one-datagram cap.

## Tick model
- ENGINE tick = fixed 1/60 s (`simTick`); every duration, catch-up and
  network cadence is an integer number of them.
- GAME/move tick = fixed per level: G engine ticks (LEVEL_CFG easy/normal/
  hard hold G). Normal movement steps every 2nd game tick (period 2G), boost
  every game tick (period G): boost is a PARITY TOGGLE, exactly 2x, never a
  re-divisor. Implemented as gPer/_gDue countdown + _stepAccum (normal +1,
  boost +2 per game tick, spend 2 per step).
- G tables: easy 7,7,7,6,6,6,5,5,4,4; normal 6,6,6,5,5,5,4,4,3,3; hard
  5,5,4,4,3,3,3,2,2,2. netInterval = max(4, G), unaffected by boost.

## HEADROOM + SHORTCUT (non-negotiable pairing, js/duel-core.js)
- HEADROOM (`netLocalInput`): every local input is authored >= ONE tick in
  the future (dir at `simTick + _gDue`, boost/boostend at `simTick+1`) and
  sent at once. That lead is the transmit window. Do not widen it or collapse
  it. "Sent at once" = leading-edge flush at authoring, capped by
  `_netInFlush` at one flush per tick, plus `_netInRepeat` (the next
  input-free netTickPre repeats the last flush once).
- SHORTCUT (`_netPeerInput`): a peer input with `tk === simTick` is
  live-applied (`simCommand`) instead of rolled back, ONLY if that tick did
  not already consume it (dir -> `!_rbPeerSteppedSince(oP, tk)`; boost ->
  `tk > _gAt`). This is the only lockstep-safe live-apply; anything older
  goes through ONE batched rollback+replay in netTickPre. A general
  past-input live-apply is unsound (a later rollback drops it).
- The duel-desync `headroom subtick 0rb` lane is discriminating only with
  driver opts `postAuthor` (hold the steer to `_gDue==1`) + `doubleEvery`.
  Do not weaken it.

## Rollback asymmetry (guarded by duel-asym.js + duel-touch.js)
- Under a clock offset the AHEAD client rolls back, the BEHIND client
  live-applies; rbBehind is a hard zero. Heavy one-sided rollback is a
  smoothness cost, not a correctness failure.
- netLocalInput never PRE-JUDGES an input as redundant (a rollback can change
  dirQueue). The send-side intent-change gate is axis-wide: suppress iff BOTH
  `_lastLocalDir` and `players[myP].dir` lie on the press's axis, which is
  provably discarded on both clients. Requiring the live heading guards a
  respawn/level heading reset. `boostend` authors on a separate ungated path.
- Do not retry: wire-layer send coalescing (regressed rollbacks); a fixed
  packets-per-second cap; making `clockLeadsFire` the driver default (burst
  suites rely on the decoupled model); claiming a measured before/after on
  the receive-side rollback cap (cheap insurance, not measurable).
- A rig that fakes a duel start MUST arm through `_netArmBegin`, never call
  beginOnlineDuel directly: the catch-up closes only a deficit (`d > 1`), so
  a sim started ahead stays ahead forever (symptom: rb/rec pinned at 1.00,
  maxRew = the offset).

## Tick 0 IS the boundary's startPts, on both clients
Every timeline opener names ONE absolute PTS: a match start takes
`start_pts` from the server (flat 1000 ms lead); a level/respawn/rematch
boundary takes it from the HOST (`netPts() + NET_BURST_LEAD_MS`, 500 so the
joiner's `bth` nudge settles before the fire). `_netArmBegin` fires on a
local timer, so `_netBoundarySettle()` (net-session.js; twin
`_dcBoundarySettle()` in sim-worker.js) runs at the rebuild and steps exactly
the ticks already elapsed against startPts, bounded at 120. A startPts in the
past is not an error and must not be clamped. PLAYERS ONLY: a spectator boots
from a checkpoint and must never invent ticks. Guard: duel-desync `tickSplit`
(the minimum of tickA-tickB over a stretch must reach 0; single readings
prove nothing; sampled before the fire phase; the noburst twin opts out). Do
not widen the `d > 1` gate to `d >= 1`.

## The timeline runs on monotonic _wall(), never Date.now()
`netPts()` and both ofs compute sites use `_wall()` = performance.timeOrigin +
performance.now(); sim-worker.js mirrors it. OS wall-clock slew (NTP) leaked
into the timeline otherwise. Deliberately still Date.now(): `at:` stamps,
silence tracking, staleness, hidden-time. Harness: performance.timeOrigin
carries err0 drift-free; Date.now keeps err0 + drift. Guard: duel-drift.js.

## dirQueue: pop-then-judge at the cap (`_dirEnqueue` in sim.js, shared)
1. Below the cap (queue < 3): judge d against the LAST REGISTERED direction
   (tail, or live heading when empty); same/reverse = not registered.
2. AT the cap: pop the tail, then judge vs the new tail; perpendicular
   REPLACES the revoked turn, same/reverse just cancels it.
3. Consume side: one entry per MOVE, reverse-of-heading skip stays.
Newest-wins is the mandated design. Boost-cancel-by-contrary-nudge lives in
input.js (_isOpp). Locked by sim-duel.js section C. Do not relitigate the
judge-vs-tail anchor, one-consume-per-move, the 3-slot cap or the reverse skip.
