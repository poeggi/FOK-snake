# Duel test tooling

The 1:1 duel runs deterministic lockstep with per-tick rollback: each client owns
its snake, both sims replay an identical input log, and a divergence is detected by
a 1Hz hash of the rollback ring. These tests boot TWO full clients over a simulated
wire and prove the pair stays in lockstep while a real, boosting match is played.

Everything here is headless Node against the real `js/*` (loaded in a VM by
`harness.js`) -- no browser, no server, no relay.

## Test tiers

`test/checks.sh` runs in two tiers so the local pre-commit hook stays snappy while the
full regression coverage still gates every deploy:

    bash test/checks.sh          FAST tier (~8s) -- the local pre-commit hook. Every
                                 cheap guard: syntax, ASCII, sim determinism + invariants,
                                 all smoke tests, and the single-scenario netcode paths
                                 (net-handshake, smoke-worker, relay-sim, duel-align).
    bash test/checks.sh --full   REGRESSION tier (~2min) -- FAST plus the four heavy duel
                                 sweeps below. CI runs this on every push/PR, so it gates
                                 the auto-deploy to Pages.

RUN `--full` LOCALLY after any significant netcode or sim rework (and before a release).
The fast tier proves each netcode PATH still works; the regression tier plays many long,
lossy, dozing matches to catch rare, slow-accumulation divergence a single scenario misses.
The heavy sweeps dominate runtime (each plays real 20-40s lockstep matches), which is the
whole reason they are not on the commit hot path -- they are not weaker, just slower.

## Files

### duel-driver.js  (shared engine, imported -- not run directly)

One place that:

1. Boots two full clients (`mk(id, seed, role)`) over a simulated wire:
   one-way `base` delay + `jit` jitter + `loss` drop + `asym` imbalance + heavy-tail
   `spike`, independently-phased frame clocks (`phase`, `tjit`), and optional
   independent device clocks (`clock: {drift, err0}`) that carry a frozen anchor
   error -- the same clock/wire surface the profiler uses.

2. DRIVES a real match (`runMatch(opts)`), keeping BOTH snakes busy the whole way.
   The default director is an opponent-aware autopilot: both clients compute the
   SAME role split from the shared lockstep world, so the snake nearer the gem
   chases it (EATER) while the other ROVES a perimeter circuit -- looping corner to
   corner, turning at each and boosting the long edges -- because two greedy snakes
   racing one gem would collide head-on and burn all three lives in level 1. The
   split keeps a steady stream of turns and boost transitions coming from both sides,
   right next to peer packets (the exact concurrency a deferred-rollback boost bug
   needs), with the straight edges as the natural quiet phases -- dense, never sparse.
   Each steers onto its target closing the larger torus axis first, boosts on
   straightaways and brakes into turns (the real `bs`/`be` arm path), and dodges its
   own body, the opponent's body, and the opponent's predicted next cell. The eater
   role alternates as gems respawn, so both snakes get gem chases over a match.

3. Advances levels through the REAL online boundary: when both clients are parked at
   `levelDone`, the driver replays the receive end of a level-up (shared `start_pts`
   + bumped epoch -> `beginOnlineDuelLevel` -> `_rbReset`), with the wire still
   flowing so a pre-boundary packet lands after `simTick` reset to 0.

4. DETECTS divergence continuously and honestly: it compares each client's rollback
   ring snapshot at an IMMUTABLE past tick -- RB_DEPTH ticks behind the slower sim.
   An accepted input reaches at most RB_DEPTH ticks back, so a tick that ran that long
   ago can no longer be rewritten by any late arrival; a healthy pair is byte-identical
   there, and the first tick that disagrees (with the diverged field names) is the bug's
   fingerprint. Comparing any nearer would read a tick still inside the rewrite window
   and false-positive whenever a lossy wire redelivers an input dozens of ticks late --
   the same stale read the product's own detector dodges by freezing its 1Hz hash at
   RB_HASH_LAG. It also tallies visible LOCAL head jumps (my own head teleporting = a
   dropped live input), the product `_rbDbg.desync` verdicts, and the 8s `_rbBadSince`
   exit clock.

`runMatch(opts)` returns a report; the important fields are in the metrics glossary
below. Pass `opts.director` to replace the autopilot, `opts.capture` to snapshot the
diverged tick's state and input logs, `opts.desyncProbe` to classify each product
desync verdict as stale-vs-real against the ring-agreement history.

### duel-desync.js  (REGRESSION tier -- the boost-lockstep guard)

Runs four scenarios through the driver and FAILS if a boosting duel does not stay
in lockstep. This is the coverage the dir-only convergence test (`relay-sim.js`)
never had: it never boosts, so the boost path shipped a desync no test could see.

    clean-boost   phase offset only, no loss   -- isolates the boost/rollback path
    lossy-boost   + 5% packet loss             -- stresses the redundancy/loss window
    long-levels   longer run to levels 2-3     -- exercises the level-boundary path
    headroom      sub-tick clock, 0 rollbacks  -- proves the 1-tick input headroom holds

Fail gate (any one trips it): a local-head jump, a first-divergence, non-convergence
at the end, a product desync verdict on either client, or a session-end exit.

### duel-boundary.js  (REGRESSION tier -- the level-boundary guard)

Plays real P2P level-ups (host authors the start PTS, joiner aligns its clock) over
loss + drift + doze, and asserts both sims stay byte-identical across the `simTick`
reset to 0. Includes an "align load-bearing" control: the SAME match with clock
alignment disabled must diverge, proving the alignment is what holds it.

### duel-rematch.js  (REGRESSION tier -- the server-path restart guard)

Same idea across a server-issued rematch/restart (a new `start_pts` moves tick zero):
the joiner must re-align its clock on EVERY start, not just at level boundaries. Also
carries the align load-bearing control.

### duel-respawn.js  (REGRESSION tier -- the post-death clean-start guard)

Freezes one client for seconds (the `doze` knob = iOS WiFi power-save / a backgrounded
tab) while a head-on `collider` director drives both snakes into deaths, so the host
owes the frozen peer a FULL RESYNC whose tick has aged out of its rollback ring. Asserts
the resync never yanks your own head back to a death cell (`selfJumps==0`), never storms
(a resync every second because our own snake never converged), and never ends the match.
Guards the fix that a resync repairs only the shared world + the host's snake -- each
client still owns its own snake.

Run any of them directly, or the whole regression tier:

    node test/duel-desync.js         # one suite
    bash test/checks.sh --full       # fast tier + all four heavy sweeps (what CI runs)

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
