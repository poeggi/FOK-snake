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
//                 latency + jitter + pts-desync ALL below one engine tick (16.67ms) with heavy
//                 movement from BOTH ends -> PROVES the one-tick author headroom does its job:
//                 every input lands within its authoring lead, so it is delivered on time (or via
//                 the one-tick-late shortcut) and NEVER rolls back. Asserted hard as maxRb:0. The
//                 contrast is clean-boost, whose ~half-a-tick schedule skew (phase8/tjit4) pushes a
//                 handful of inputs past the lead and does roll back -- shrink the skew below a tick
//                 and the count is exactly zero.
const SCEN = [
    { name:'clean-boost  phase8 jit  ', seed:0xD0E1, secs:12, wire:{ base:5,  jit:2,  loss:0    }, phase:8, tjit:4, recv:true },
    { name:'lossy-boost  5% loss      ', seed:0xBEEF, secs:20, wire:{ base:12, jit:6,  loss:0.05 }, phase:8, tjit:4, recv:true },
    { name:'long-levels  to L2-3      ', seed:0x77C0, secs:40, wire:{ base:7,  jit:3,  loss:0.02 }, phase:8, tjit:4, recv:true },
    // Sub-tick net + pts with tick schedules ALIGNED (phase0/tjit0): net 2-6ms (base4+/-jit2)
    // plus a real independent-clock pts-desync (err0 4ms + small drift) sum to ~10ms, a safe
    // 6.67ms inside the 16.67ms tick. It is the SUM of net + pts + any schedule skew -- not any
    // one term -- that must stay under a tick; with skew zeroed this is a KNOWN-0rb condition, so
    // maxRb:0 is exact. Any rb here is a real headroom leak to debug, and it holds across the
    // seed sweep (not seed-sensitive). Schedule skew is a separate stress -- see clean-boost.
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
    { name:'headroom     subtick 0rb  ', seed:0x77C0, secs:30, wire:{ base:4,  jit:2,  loss:0    }, phase:0, tjit:0, clock:{ err0:4, drift:5, samples:8 }, recv:true, postAuthor:true, doubleEvery:3, maxRb:0 },
];

let failed = 0;
for(const sc of SCEN){
    const r = runMatch(sc);
    const rbOver = sc.maxRb != null && r.rb > sc.maxRb;
    const bad = r.localJumps > 0 || !!r.firstDiverge || !r.converged
        || r.desyncA > 0 || r.desyncB > 0 || r.exitReason === 'session-end' || rbOver;
    const fd = r.firstDiverge ? ('  1stDiverge @' + r.firstDiverge.tick + ' [' + r.firstDiverge.fields.join(',') + ']') : '';
    const rbNote = sc.maxRb != null ? (rbOver ? '  rb>' + sc.maxRb + ' HEADROOM LEAK' : '  (<=' + sc.maxRb + ' rb: headroom holds)') : '';
    log(sc.name.trim().padEnd(22)
        + ' L' + r.levelReached
        + ' conv=' + (r.converged ? 'yes' : 'NO')
        + ' selfJumps=' + r.localJumps + (r.maxLocalJump > 1 ? '(max' + r.maxLocalJump + ')' : '')
        + ' desync=' + r.desyncA + '/' + r.desyncB
        + ' rb=' + r.rb + ' lost=' + r.lost
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
