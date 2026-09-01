// DUEL desync regression test (DEFAULT suite). Two full clients play a REAL match --
// autopilot toward gems (so levels advance), boost engaged on straightaways and braked into
// turns -- over an independently-phased, jittery, mildly-lossy wire. This is the coverage the
// dir-only convergence tests (relay-sim.js) never had: NO boosting, so the boost path shipped
// a desync no test could see.
//
// A healthy lockstep pair guarantees three things, all asserted here:
//   1. your OWN head never teleports  -- it is a pure function of your own logged inputs, so a
//      rollback re-sim always reproduces it. A local-head jump means a live-applied input (a
//      boost) was dropped by a rollback: the exact deferred-rollback boost bug.
//   2. no unhealed divergence         -- ring snapshots at a settled past tick hash-agree.
//   3. re-convergence + no desync kill -- the sims end on one identical world, no DESYNC exit.
// See test/README.md for the driver, the metrics, and how to run each scenario.
const { runMatch } = require('./duel-driver');

const steps = [];
const log = s => { steps.push(s); };

// Scenarios chosen to exercise each pinpointed failure independently:
//   clean-boost : phase offset only, NO loss -> isolates the deferred-rollback boost drop (F1)
//   lossy-boost : + packet loss              -> stresses the redundancy/loss window (F3)
//   long-levels : longer run to levels 2-3   -> exercises the level-boundary epoch gap (F2)
//   headroom    : CRUCIAL -- do not shorten, reseed, relax maxRb or fold into another case. It is
//                 the only guard on the duel pairing's load-bearing invariant, and it is a HARD
//                 zero: there is no "a few rollbacks are fine" reading of it to erode.
//                 The clocks START >20ms apart (err0 24 -- well over an engine tick's worth of pts
//                 gap) on a ~10ms-RTT channel; the REAL first-start burst sync must first bring the
//                 relative pts to nearly 0 (asserted via startSync), and only then does play open.
//                 From there latency + jitter + the burst RESIDUAL sum below one tick (16.67ms)
//                 with heavy movement from BOTH ends -> PROVES the chain end to end: the burst
//                 earns the sub-tick condition, and the one-tick author headroom then does its job
//                 -- every input lands within its authoring lead, delivered on time (or via the
//                 one-tick-late shortcut) and NEVER rolls back. Asserted hard as maxRb:0. The
//                 noburst twin lane proves the burst is load-bearing: apply disabled, same start
//                 gap -> rollbacks appear. (Correction survival across level/rematch boundaries
//                 at large err0 is duel-boundary/duel-rematch territory.)
const SCEN = [
    { name:'clean-boost  phase8 jit  ', seed:0xD0E1, secs:12, wire:{ base:5,  jit:2,  loss:0    }, phase:8, tjit:4, recv:true },
    { name:'lossy-boost  5% loss      ', seed:0xBEEF, secs:20, wire:{ base:12, jit:6,  loss:0.05 }, phase:8, tjit:4, recv:true },
    { name:'long-levels  to L2-3      ', seed:0x77C0, secs:40, wire:{ base:7,  jit:3,  loss:0.02 }, phase:8, tjit:4, recv:true },
    // Clocks start 22-26ms apart (err0 24 +/- anchor jitter): >20ms of raw pts gap, ~1.4 engine
    // ticks -- unplayable at 0rb if left standing. startBurst runs the production first-start
    // burst over the same delayed wire (host _netBurstThenStart -R/2, joiner's own-sample half)
    // BEFORE the first game tick, exactly as a real 2.6 match syncs on its first go. The lane
    // asserts the sync itself: |gap0| > 20 (the start condition is real) and |gap1| <= 3
    // (relative pts brought to nearly 0). Play then runs with tick schedules ALIGNED
    // (phase0/tjit0): net 3-7ms (base5+/-jit2) plus the ~1-2ms burst residual sum well inside
    // the 16.67ms tick. It is the SUM of net + residual pts + any schedule skew -- not any one
    // term -- that must stay under a tick; with skew zeroed this is a KNOWN-0rb condition, so
    // maxRb:0 is exact. Any rb here is a real headroom (or burst) leak to debug. p2pBoundary is
    // DEFENSIVE: this pilot config does not finish a level inside 30s (the lane plays out at L1),
    // but if a boundary ever does fire it must be the real req->go one (which re-bursts on the
    // wire) and never the atomic test shortcut -- the shortcut re-zeroes _netSync.ofs, silently
    // WIPING the correction and turning this lane red for the wrong reason. Boundary-burst
    // survival itself is asserted in duel-boundary (err0 40) and duel-rematch (err0 90, with its
    // own noBurst control). Schedule skew is a separate stress -- see clean-boost.
    //
    // postAuthor: worst-case input phase. Steers are authored AFTER their tick ran (a real touch
    // lands mid-interval, after the boundary's flush already left) and each is HELD to the last
    // interval before its target step boundary (_gDue==1; the target is the same from anywhere in
    // the window, so the pilot loses nothing). A flush deferred to the next tick then has exactly
    // ZERO wire budget: it arrives transit-late, a guaranteed rollback. Only the send-at-authoring
    // contract (netLocalInput's leading-edge flush; netTickPost for boost) keeps a
    // full-tick-minus-transit budget and holds rb at 0. A deferred-only flush fails this scenario
    // with rb in the hundreds. The default authoring path is DOUBLY best-case -- pre-tick (the
    // same boundary's flush ships the record, zero deferral) and at maximum _gDue (autopilot
    // intents are born right after a game step) -- which is how that defect stayed green here.
    // doubleEvery: every 3rd intent is a MULTI gesture, alternating between a DOUBLE in the last
    // interval (both records must ship at authoring -- proves the two-flush cap) and a TRIPLE at
    // birth (its third record exceeds the cap and coalesces into the next tick's flush -- the
    // cap-deferred path stays on the wire and inside the authoring lead). See duel-driver.
    // CRUCIAL (see header): the 0-rollback headroom guard. Keep it long and keep maxRb at 0.
    { name:'headroom     burst 0rb   ', seed:0x77C0, secs:30, wire:{ base:5,  jit:2,  loss:0    }, phase:0, tjit:0, clock:{ err0:24, drift:5, samples:8 }, startBurst:true, p2pBoundary:true, recv:true, postAuthor:true, doubleEvery:3, maxRb:0, expectSync:{ minGap0:20, maxGap1:3 } },
    // Falsification twin: identical start gap and wire, burst APPLY disabled (noBurst) -> the raw
    // 24ms (~1.4 tick) offset stands, the ahead peer runs a persistent tick lead, the other side's
    // inputs land late there, rollbacks MUST appear (minRb) while the pair still HEALS by rollback
    // (all health gates stay on). RED without the burst, GREEN with -- proves the lane above is
    // load-bearing, not vacuously 0.
    { name:'headroom     noburst RED ', seed:0x77C0, secs:10, wire:{ base:5,  jit:2,  loss:0    }, phase:0, tjit:0, clock:{ err0:24, drift:5, samples:8 }, startBurst:true, noBurst:true, recv:true, postAuthor:true, doubleEvery:3, minRb:1, expectSync:{ minGap1:20 } },
];

let failed = 0;
for(const sc of SCEN){
    const r = runMatch(sc);
    const rbOver = sc.maxRb != null && r.rb > sc.maxRb;
    const rbUnder = sc.minRb != null && r.rb < sc.minRb;
    const ss = r.startSync, ex = sc.expectSync;
    const g0 = ss ? Math.abs(ss.gap0) : 0, g1 = ss ? Math.abs(ss.gap1) : 0;
    const syncBad = !!ex && (!ss
        || (ex.minGap0 != null && g0 <= ex.minGap0)     // the start condition was not actually hard
        || (ex.maxGap1 != null && g1 > ex.maxGap1)      // burst failed to bring pts to nearly 0
        || (ex.minGap1 != null && g1 <= ex.minGap1));   // noburst twin: the gap must SURVIVE
    const bad = r.localJumps > 0 || !!r.firstDiverge || !r.converged
        || r.desyncA > 0 || r.desyncB > 0 || r.exitReason === 'session-end' || rbOver || rbUnder || syncBad;
    const fd = r.firstDiverge ? ('  1stDiverge @' + r.firstDiverge.tick + ' [' + r.firstDiverge.fields.join(',') + ']') : '';
    const rbNote = sc.maxRb != null ? (rbOver ? '  rb>' + sc.maxRb + ' HEADROOM LEAK' : '  (<=' + sc.maxRb + ' rb: headroom holds)')
        : sc.minRb != null ? (rbUnder ? '  rb<' + sc.minRb + ' LANE NOT LOAD-BEARING' : '  (rb>=' + sc.minRb + ': burst is load-bearing)') : '';
    const syncNote = ss ? ' pts=' + ss.gap0 + '->' + ss.gap1 + (syncBad ? ' SYNC BAD' : '') : '';
    log(sc.name.trim().padEnd(22)
        + ' L' + r.levelReached
        + ' conv=' + (r.converged ? 'yes' : 'NO')
        + ' selfJumps=' + r.localJumps + (r.maxLocalJump > 1 ? '(max' + r.maxLocalJump + ')' : '')
        + ' desync=' + r.desyncA + '/' + r.desyncB
        + ' rb=' + r.rb + ' lost=' + r.lost + syncNote
        + (r.exitReason ? ' exit=' + r.exitReason + '@' + r.diedAt.toFixed(0) + 's' : '')
        + fd + rbNote
        + '   ' + (bad ? 'FAIL' : 'ok'));
    if(bad) failed++;
}

console.log(steps.join('\n'));
if(failed){
    console.log('\nDUEL-DESYNC FAIL: ' + failed + '/' + SCEN.length + ' scenario(s) diverged -- a boosting duel does'
        + '\n  not stay in lockstep (own-snake teleports / unhealed hash split / DESYNC exit).');
    process.exit(1);
}
console.log('\nDUEL-DESYNC PASSED');
