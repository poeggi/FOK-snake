# Duel INVARIANT: tick 0 IS the boundary's startPts, on both clients

Shipped 4.4.1. Guarded by the tick-coincidence check in test/duel-desync.js.

THE INVARIANT: every timeline opener names ONE absolute PTS, and both sims must
zero their counter AT it -- not when their own timer happens to fire. A match
start takes that number from the server (`start_pts`, a flat 1000 ms lead, see
FOK-server Starts.php); a level, respawn or rematch boundary takes it from the
HOST, minted `netPts() + NET_BURST_LEAD_MS` on its just-burst-corrected clock and
shipped verbatim on the `go`. The joiner adopts the number and applies its half
of the burst residual (`bth`) so that one number denotes the same real instant on
both sides.

## Why arming on the PTS was not enough

`_netArmBegin(s, startPts, fn)` arms on the agreed number, but it fires on a
LOCAL setTimeout, and the rebuild used to set `simTick = 0` unconditionally --
never asking how far past startPts this client actually was. So each side started
counting whenever its own timer landed.

The moment the two fires straddle a tick boundary that is a whole-tick offset,
and NOTHING closes it: the steady-state catch-up in every home repairs only a
deficit of MORE than one tick (`d > 1` in game.js, sim-worker.js and
test/duel-driver.js alike), and nothing pulls back a sim that is ahead.

It is not a desync -- the pair still agrees on every hashed field, so the hash,
the convergence check and the desync counters all stay clean. The cost is
rollback: the side left running ahead receives ON-TIME peer records for a tick it
has already stepped, and pays a rollback for each one. Measured on the
duel-desync headroom lane: 75 rollbacks over a 60 s match, from a single boundary
that handed one client one extra tick.

## The rule

`_netBoundarySettle()` (net-session.js) runs at the rebuild, after the sim has
zeroed: it asks how many ticks have already elapsed against startPts and runs
exactly that many. Normally none. `_dcBoundarySettle()` in sim-worker.js is its
twin -- a twin, not a second implementation.

PLAYERS ONLY, and this is load-bearing. Running a tick means simulating it, which
means holding its inputs. A player does; a SPECTATOR never does -- it authors
nothing and replays what the players forward. `beginOnlineDuel` also serves a
watcher ATTACHING to a match already in progress, where the elapsed ticks are
real (~100 for a 1.5 s-old match) and simulating them is exactly wrong: a joiner
boots from a CHECKPOINT off the feed. Without the guard, every spectator suite
diverges from the first tick it invented.

A `startPts` already in the PAST is not an error and must not be clamped: it
means tick 0 has happened, so the client owes those ticks and running them puts
it level with the host. Clamping to 0 would park it that far behind and the
`d > 1` catch-up would grind it back a tick per frame. Bounded at 120 ticks so a
stale or malformed go cannot run away.

NET_BURST_LEAD_MS is 500, not 250: the joiner applies its half of the burst
residual when the `go` lands, and that clock nudge has to be SETTLED well before
either side reaches the PTS it is measured against. At 250 ms it was arriving in
the same few tens of ms as the fire, which is how the two ended up zeroing on
opposite sides of a tick.

## The guard (test/duel-desync.js `tickSplit`)

One shared clock and one agreed startPts mean the two sims must share a tick at
some point in every stretch between boundaries. Comparing `tickA - tickB` at a
single instant proves NOTHING on its own -- with a staggered fire phase
(opts.phase/tjit) one side has already ticked this interval and the other has
not, so the difference legitimately reads 1 for part of every interval. But it
comes back to 0 inside that same interval. A sim that zeroed off the agreed PTS
never does. So the fault is a stretch whose MINIMUM difference never reaches
zero, never any single reading.

Sampled with both clients pinned to the loop's own `now`, BEFORE the fire phase:
`fireOnce` moves a client's `__now` to its sub-tick authoring instant
(postAuthor/authorPhase) and netPts rides `__now`, so a reading taken after it
compares two different instants. The rebase crossing is skipped (the two cross it
one sample apart). The noburst twin opts out -- a pair running WITHOUT the burst
is the result that lane exists to demonstrate.

Two metrics that do NOT work here, both tried: raw `tickA - tickB` (measures the
fire phase) and each side's own tick-to-PTS deviation (a `phase:8` stagger is
8/16.67 = 0.48 ticks and swamps the signal).

## Do not relitigate

- The `d > 1` catch-up gate is correct as it stands; the fix belongs at the
  reset, not by widening the gate to `d >= 1` (that oscillates on the floor
  boundary in steady state).
- The spectator's flat SPEC_DELAY_MS = 100 origin bias is NOT the problem here
  and was not changed. It is deliberately hop-count-independent so every watcher
  of a match sits on the same tick (project_fok_spectator.md).

Related: project_fok_rollback_flood.md (the harness-invariant half of this),
project_fok_headroom_shortcut.md, project_fok_clock_drift_fix.md.
