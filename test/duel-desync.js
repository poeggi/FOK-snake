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
const SCEN = [
    { name:'clean-boost  phase8 jit  ', seed:0xD0E1, secs:20, wire:{ base:5,  jit:2,  loss:0    }, phase:8, tjit:4, recv:true },
    { name:'lossy-boost  5% loss      ', seed:0xBEEF, secs:20, wire:{ base:12, jit:6,  loss:0.05 }, phase:8, tjit:4, recv:true },
    { name:'long-levels  to L2-3      ', seed:0x77C0, secs:40, wire:{ base:7,  jit:3,  loss:0.02 }, phase:8, tjit:4, recv:true },
];

let failed = 0;
for(const sc of SCEN){
    const r = runMatch(sc);
    const bad = r.localJumps > 0 || !!r.firstDiverge || !r.converged
        || r.desyncA > 0 || r.desyncB > 0 || r.exitReason === 'session-end';
    const fd = r.firstDiverge ? ('  1stDiverge @' + r.firstDiverge.tick + ' [' + r.firstDiverge.fields.join(',') + ']') : '';
    log(sc.name.trim().padEnd(22)
        + ' L' + r.levelReached
        + ' conv=' + (r.converged ? 'yes' : 'NO')
        + ' selfJumps=' + r.localJumps + (r.maxLocalJump > 1 ? '(max' + r.maxLocalJump + ')' : '')
        + ' desync=' + r.desyncA + '/' + r.desyncB
        + ' rb=' + r.rb + ' lost=' + r.lost
        + (r.exitReason ? ' exit=' + r.exitReason + '@' + r.diedAt.toFixed(0) + 's' : '')
        + fd
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
