# Duel packet-rate + rollback invariants

All fixes here are shipped and guarded by test/duel-asym.js + test/duel-touch.js.
What follows is only the part NOT recoverable from the code and tests.

## Invariants

- Rollback asymmetry is real, one-directional, and expected. Under a clock
  offset the AHEAD client receives the slow peer's inputs in its PAST (rolls
  back); the BEHIND client receives them in its FUTURE (live-applies).
  rbBehind is a HARD ZERO, never merely small. Heavy one-sided rollback
  (at +150ms offset: rbAhead ~83-125, rbBehind 0) is a SMOOTHNESS cost on the
  ahead device, NOT a correctness failure - lockstep still holds.
- Onset is ~one tick (~22-25ms on a 10ms link), not ~70-80ms. There is only
  ONE absorber: the +1 authoring headroom plus the one-tick-late shortcut in
  _netPeerInput (see project_fok_headroom_shortcut.md), about one tick wide.
- netLocalInput must not PRE-JUDGE an input as redundant. A rollback can
  change dirQueue before step S, so a locally-predicted-redundant press may be
  one the corrected sim accepts. A send-side filter must be limited to
  PROVABLY redundant presses (facts already committed), never predictions.
  The shipped intent-change gate (AXIS-wide since v2.6.6) obeys this:
  suppress iff BOTH _lastLocalDir (a committed fact) AND players[myP].dir lie
  on the press's axis (nonzero dot products) - the sim's judging anchor
  (dirQueue tail or P.dir) is then provably on that axis too and discards the
  record on both clients, as same-as-last or as a reverse. Requiring the LIVE
  heading guards a respawn/level heading reset (changes P.dir with no
  authored record).

## Do not retry

- Send-side coalescing at the wire layer (defer-all, coalesce-same-tick
  extras): tried, REGRESSED rollbacks in the profiler, reverted. Immediate
  send minimizes rollbacks; any further fix belongs at the input/authoring
  layer.
- A fixed packets-per-second cap (e.g. "max 120/sec"): rejected as meaningless
  - 120Hz is just the iOS touchmove rate. The right lever is GAME-SEMANTIC
  (the sim consumes one turn per game-step, dirQueue holds at most 3), not a
  clock.
- Making clockLeadsFire the driver default: it is opt-in for a reason. The
  burst suites (boundary/rematch/outage) rely on the decoupled model - their
  bursts re-sync the clock and would also re-seed the fire phase; a static
  coupling broke duel-rematch at err0=150. NOTE the harness bug it fixed:
  setting phase:0 DECOUPLES the clock offset from the fire schedule so no
  simTick lead ever opens, which silently masks the whole effect.
- Claiming a measured before/after on the receive-side rollback cap: the
  profiler could NOT reproduce a multi-rollback flood on a clean link. The
  real vector is an on-device GC/HUD stall then many queued packets draining
  at once, which the profiler does not model. The cap is cheap insurance and
  correct - do not over-claim it.

## Closed: reverse-slide flood

Fixed in v2.6.6 by widening the gate from exact-equality to the press's axis
(see the invariant above). The sim discards a reverse like a same-direction
turn, so a reverse slide now authors at most ONE record. The touch brake is
safe by construction: 'boostend' authors on a separate ungated path. Guarded
by test/duel-touch.js reverse-slide + brake lanes (flood bound, no
over-suppression, brake still authors and stops the boost). A doze-sweep
control run proved the gate does NOT cause the deep-doze residual (that was
the netTickPre repair-order bug, fixed in the same commit - see
Nothing open here.

## Harness invariant: a faked duel start MUST arm through _netArmBegin

Any rig that stands up a duel by hand (CDP-driven real browsers, scratch
probes) must NOT call beginOnlineDuel directly. Production never does: both
the host path and the joiner path hand it to _netArmBegin(s, startPts, ...),
which fires it AT startPts on the shared clock, so both sims reach tick 0 at
the same shared instant and simTick == _dcTarget() from tick one.

Calling it immediately with a startPts in the future makes each page free-run
from tick 0 the moment its own round trip lands. That skew is PERMANENT: the
catch-up in _stepTicks (and its main-thread twin in the game.js frame loop)
only closes a DEFICIT (d > 1); nothing pulls back a sim that is ahead. The
one-way design is correct in production - _acc accrues real elapsed time so a
sim cannot outrun the wall clock, and the only two _netClockPush() sites move
the anchor and startPts together at a boundary that re-zeroes simTick - so a
standing lead is unreachable there. It is reachable only by faking the start.

Symptom to recognise: rollbacks-per-received-record pinned at 1.00 with
live-applies at 0.00 and maxRew equal to the standing offset, invariant to the
modeled link delay. The rate is a step function of the offset and of nothing
else (measured: offset 11 -> 1.00 rb, maxRew 12; offset 0 -> 0.00 rb, 1.00
live, maxRew 0). test/duel-driver.js was always correct here (it sets
startPts = Date.now() right after startDuel()).

Clean baseline (real browser instances, production-armed start, gestures on
both sides):

    link 0ms   -> rb/rec 0.00, live/rec 1.00, maxRew 0   (x3 lanes)
    link 20ms  -> rb/rec 0.00 and 0.05    (27ms effective, inside the 33.3ms lead)
    link 40ms  -> rb/rec 0.35, maxRew 4   (47ms effective, PAST the lead)

That is the headroom-plus-shortcut pairing doing exactly its job: everything
under the 2-tick lead is absorbed with zero rollback, and degradation begins
only once the wire exceeds it.

Related: project_fok_headroom_shortcut.md, project_fok_netcode_housekeeping.md.
