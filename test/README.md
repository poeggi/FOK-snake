# Duel test tooling

The 1:1 duel runs deterministic lockstep with per-tick rollback: each client owns
its snake, both sims replay an identical input log, and a divergence is detected by
a 1Hz hash of the rollback ring. These tests boot TWO full clients over a simulated
wire and prove the pair stays in lockstep while a real, boosting match is played.

Everything here is headless Node against the real `js/*` (loaded in a VM by
`harness.js`) -- no browser, no server, no relay.

## Files

### duel-driver.js  (shared engine, imported -- not run directly)

One place that:

1. Boots two full clients (`mk(id, seed, role)`) over a simulated wire:
   one-way `base` delay + `jit` jitter + `loss` drop + `asym` imbalance + heavy-tail
   `spike`, independently-phased frame clocks (`phase`, `tjit`), and optional
   independent device clocks (`clock: {drift, err0}`) that carry a frozen anchor
   error -- the same clock/wire surface the profiler uses.

2. DRIVES a real match (`runMatch(opts)`). The default director is an
   opponent-aware autopilot: both clients compute the SAME assignment from the
   shared lockstep world, so exactly one snake chases the shared gem (EATER) while
   the other heads for a fixed corner (PATROL) -- two greedy snakes racing one gem
   would collide head-on and burn all three lives in level 1. The eater steers onto
   the gem closing the larger torus axis first, boosts on straightaways and brakes
   into turns (the real `bs`/`be` arm path, fired right next to peer packets -- the
   exact concurrency a deferred-rollback boost bug needs), and dodges its own body,
   the opponent's body, and the opponent's predicted next cell.

3. Advances levels through the REAL online boundary: when both clients are parked at
   `levelDone`, the driver replays the receive end of a level-up (shared `start_pts`
   + bumped epoch -> `beginOnlineDuelLevel` -> `_rbReset`), with the wire still
   flowing so a pre-boundary packet lands after `simTick` reset to 0.

4. DETECTS divergence continuously and honestly: it compares each client's rollback
   ring snapshot at a settled PAST tick (comfortably behind both sims, so every input
   for it has been delivered and rolled in). A healthy pair is byte-identical there;
   the first tick that disagrees, and which hashed field diverged, is the bug's
   fingerprint. It also tallies visible LOCAL head jumps (my own head teleporting =
   a dropped live input), the product `_rbDbg.desync` verdicts, and the 8s
   `_rbBadSince` exit clock.

`runMatch(opts)` returns a report; the important fields are in the metrics glossary
below. Pass `opts.director` to replace the autopilot, `opts.capture` to snapshot the
diverged tick's state and input logs, `opts.desyncProbe` to classify each product
desync verdict as stale-vs-real against the ring-agreement history.

### duel-desync.js  (DEFAULT suite -- the regression guard)

Runs three scenarios through the driver and FAILS if a boosting duel does not stay
in lockstep. This is the coverage the dir-only convergence test (`relay-sim.js`)
never had: it never boosts, so the boost path shipped a desync no test could see.

    clean-boost   phase offset only, no loss   -- isolates the boost/rollback path
    lossy-boost   + 5% packet loss             -- stresses the redundancy/loss window
    long-levels   longer run to levels 2-3     -- exercises the level-boundary path

Fail gate (any one trips it): a local-head jump, a first-divergence, non-convergence
at the end, a product desync verdict on either client, or a session-end exit.

Run it:

    node test/duel-desync.js
    # or via the full pre-commit / CI suite:
    bash test/checks.sh

### duel-profile.js  (on-demand -- latency/rollback profiler)

Sweeps wire profiles and reports latency/rollback cost. Not in the default suite;
run when tuning the rollback constants.

## Metrics glossary

    converged     both sims end on ONE identical world (tick + full-state hash)
    firstDiverge  first settled past tick whose ring hash split, with the field names
    localJumps    my own head moved >1 cell in a tick = a live input a rollback dropped
    desyncA/B     product 1Hz-hash desync verdicts each client raised (match totals)
    badA/B        1 if the 8s unhealed-desync exit clock was armed at the end
    rb / resim    rollbacks / re-simmed ticks (cost of the deferred-rollback design)
    lost          input records that never arrived (loss window exercised)
    levelReached  highest duel level the match got to
    desyncProbe   {stale, real, unknown}: each desync verdict classified against the
                  settled ring-agreement history (stale = peer's frozen hash was
                  rewritten by a later rollback = a false positive)

## Why the ring-hash compare is the honest test

Normal live rollback produces a noisy per-tick hash: the peer hashes a tick with its
own input already applied, while our copy of that tick stays provisional until that
input reaches us. Comparing on arrival mismatches every time either player steers.
The ring snapshot at a tick that is already IMMUTABLE (no accepted input can still
rewrite it) is the real equality test -- that is what both the driver's detector and
the product's own 1Hz detector compare.
