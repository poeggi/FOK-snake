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
                                 (net-handshake, smoke-worker, relay-sim, duel-sync,
                                 duel-warn).
    bash test/checks.sh --full   REGRESSION tier (~2min) -- FAST plus the five heavy duel
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
   + bumped epoch + host-authored level -> `beginOnlineDuelLevel` -> `_rbReset`),
   with the wire still flowing so a pre-boundary packet lands after `simTick` reset
   to 0.

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

### duel-warn.js  (FAST tier -- the CONNECTION LOST banner guard)

Drives the real receive path with crafted refused packets and asserts the banner text
`netDuelWarn()` reports. A LONE refused peer packet is normal jitter under independent
clocks -- the redundant resend re-delivers that input a beat later at a usable tick, so
the two worlds never diverge -- yet refusing one packet used to arm the 3s banner, a
scary self-healing flash on a healthy link. The guard proves a lone future/stale/future-
pts refusal shows NO banner, while a sustained burst (a real one-sided stall) and total
silence still do. Divergence itself is caught separately by the hash -> DESYNC, never by
this banner, so the debounce drops no real signal.

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

Plays real P2P level-ups (host bursts to the shared midpoint and ships `bth` on the
`go`, joiner applies its half) over loss + drift + doze, and asserts both sims stay
byte-identical across the `simTick` reset to 0. It guards the boundary PATH -- epoch
bump, `simTick`->0, the echo-acked `go {why:'level'}` and its retries over a lossy
wire, the joiner's `req {why:'level'}` round trip. The burst MECHANISM is proven elsewhere (see `duel-sync.js` for the unit test and
`duel-rematch.js` for the load-bearing control), because a single level boundary can't
host that control: the only offset present is one level's accumulation, and a constant
offset that survives a level survives the next unchanged, while drift big enough to
compound across a boundary already blows level 1 (which has not bursted yet) -- so a
noBurst run at the same realistic drift converges too. The multi-boundary accumulation
the burst bounds is a slow sweep in the on-demand netprofile.

### duel-epoch.js  (REGRESSION tier -- the lost-begin / split guard)

Swallows one client's one-shot boundary BEGIN timer (`eatBegin`), the way a throttled or
backgrounded tab defers or drops it, and asserts the pair does not end up on separate
tick bases. Both roles are driven: losing the host's begin and losing the joiner's need
different repairs, since only the host can re-serve a start (an unechoed `go` keeps
retrying) and a joiner can only ask (`req`). The fail gate is the DURATION of the split (a boundary is legitimately
one-sided while the start is in flight) plus `splitBlind` -- a split that outlives the
ask deadline with no banner showing. That blindness is the real finding: with the two
clients on different bases the epoch gate drops the peer's hash one layer above the
comparator, the link still carries packets so nothing reads as silent, and neither sim
is frozen, so all three detectors go quiet at the same instant.

### smoke-epoch-mirror.js  (FAST tier -- the main-thread epoch-mirror guard)

The wire stamps and gates epochs on MAIN (`_netSend` writes `o.ep` from `_rbEpoch`,
`_netHandleMsg` compares against it), while the DEFAULT browser runtime hosts duel-core
in `sim-worker.js` -- where `netEpoch()` does not exist. This guard proves main's
dormant core adopts the base epoch at every begin in BOTH homes, that outbound tick
packets carry it, and that a teardown returns the mirror to 0 (a fresh pair's line).
A frozen mirror is invisible to every duel-* sweep -- the driver boots the in-process
home only -- yet in the field it splits a worker-mode client from any peer whose epoch
advances (FORCE SINGLE THREADED, file://, a demoted worker) at the FIRST boundary.

### smoke-level-wire.js  (FAST tier -- the wire-authored level-number guard)

The duel board is a pure function of (gameSeed, level), so the two clients build
identical barricades exactly as long as they agree on the level NUMBER. The host owns
that number like it owns the epoch and ships it in the go's `lvl` field; both sims
adopt it in `startDuelLevel`. This guard perturbs a client's private level counter
and proves the wire value wins, that a duplicate begin rebuilds the byte-identical
board (idempotent boundary), that the number crosses the main->worker seam, and that
the host session authors 2, 3, ... on successive boundaries. Without the wire number,
any path that runs a begin a different number of times on the two clients -- a
duplicate fire, a stray press, a version skew -- silently rebuilds two DIFFERENT
worlds from one boundary ("barricades different"), detectable only after the fact.

### smoke-respawn-halt.js  (FAST tier -- the online death-boundary guard)

An ONLINE duel death is a negotiated boundary, not a local rebuild: the sim (armed with
`net:true` at the online entry) holds in `dying` after the death animation and emits ONE
`duelHalt`; the host answers with an epoch bump + clock burst + `go {why:'respawn'}`, and
both clients rebuild the same level at tick 0 from the fresh shared start_pts -- so every
respawn re-cancels clock drift exactly like a level-up. The guard proves the hold + the
one-shot emit, the host's one-boundary dedup (duplicate halts fold), that a `duelHalt`
surfacing inside a rollback REPLAY still dispatches (a death introduced by a late input
crosses DEATH_DUR only in the replay -- swallowed, both clients would hold forever), that
the joiner's `go {why:'respawn'}` rebuild keeps level/players and the hold armed, and that
a LOCAL duel still rebuilds immediately (control). The driver-based sweeps below stay on
the local-rebuild path by design (they boot the sim directly, not through the online
entry), so this guard is the coverage for the held path.

### smoke-recovery-resume.js  (FAST tier -- the outage recovery-resume guard)

An outage (a reconnect, or a peer detected a whole rollback ring behind) heals over a
FULL resync burst -- but the pair is then still ticking on the clock anchor from BEFORE
the outage, carrying whatever drift the outage accumulated (a throttled background tab, a
reconnect over a different network path). The burst settling opens a RESUME boundary
(`go {why:'resume'}`): a fresh clock burst, a startPts that maps the CURRENT tick onto
the verified clock (in the past, so the armed begin fires at once and nobody rewinds),
and an epoch bump -- and nothing else: no rebuild, no tick reset, no ring clear, because
the sims never stopped and what they hold IS the state. The guard drives the real
netTickPre decrement path and proves: the routine single-rs desync repair does NOT open
the boundary (control -- a re-anchor storm under jitter is the failure this distinction
prevents); a joiner settle asks with `req {why:'resume'}` exactly once; a settle under a
pending transition stays quiet (that transition re-anchors anyway); a host settle ships
ONE resume go with epoch+1 and a current-tick startPts while sim/ring stay untouched; the
joiner's go adopts anchor + epoch only; a stale-epoch req is echoed but refused; the
worker home's settle crosses the seam as a `duelRecovered` event into the same
`_netResyncSettled`; and the worker-side adopt rides the ordinary `duelClock` push.

### duel-rematch.js  (REGRESSION tier -- the server-path restart guard)

Same idea across a host-authored rematch/restart (a new `start_pts` moves tick zero):
the host must burst to the shared midpoint on EVERY start, not just at level boundaries.
Also carries the burst load-bearing control.

### duel-respawn.js  (REGRESSION tier -- the post-death clean-start guard)

Freezes one client for seconds (the `doze` knob = iOS WiFi power-save / a backgrounded
tab) while a head-on `collider` director drives both snakes into deaths, so the host
owes the frozen peer a FULL RESYNC whose tick has aged out of its rollback ring. Asserts
the resync never yanks your own head back to a death cell (`selfJumps==0`), never storms
(a resync every second because our own snake never converged), and never ends the match.
Guards the fix that a resync repairs only the shared world + the host's snake -- each
client still owns its own snake.

### duel-outage.js  (REGRESSION tier -- the interruption-recovery guard)

Blacks out the WHOLE wire for a fixed span (the `outage` knob = a WiFi drop / a few
lost seconds) while BOTH clients keep ticking and steering, so each mispredicts the
other for the duration. On restore the redundant input log + the state/hash resync must
re-converge them, the CONNECTION LOST banner must clear, and the match must NOT
session-end -- as long as the silence stayed under the 4s deadline. The load-bearing
control is an over-long outage that MUST kill: it proves the recovery cases pass because
the link genuinely returned in time, not because the deadline never bites. Guards the fix
that the per-owner state packet carries the WHOLE snake (dir/boost/accrual, not just
cells), so recovery no longer stalls once the outage outlasts the redundant input window.

Run any of them directly, or the whole regression tier:

    node test/duel-desync.js         # one suite
    bash test/checks.sh --full       # fast tier + all five heavy sweeps (what CI runs)

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
