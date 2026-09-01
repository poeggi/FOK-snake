// SERVER-PATH RESTART (rematch) test (DEFAULT suite). A rematch is host-authored: the host runs
// a bilateral clock BURST (both sides measure the peer offset over ~150ms), nudges its own clock
// onto the shared midpoint, authors the new match's start PTS on that clock and ships it on the
// echo-acked go {why:'rematch'} with the agreed offset as 'bth' -- the joiner applies its own half
// from bth, so that single number lands on the same real instant on both. Without that nudge the
// restart inherits whatever relative offset the two independent server syncs left: the peer's
// honest current-tick inputs then land outside the rollback window and are refused (dropped
// inputs), and past ~250ms of one-sided apply the ring splits -> OUT OF SYNC. This drives the REAL
// rematch RECEIVE path (__rematchHost -> go why:'rematch') over the wire and asserts lockstep with NO drops.
//
// The last row is a FALSIFICATION: the same rematch-across-an-offset holds WITH the burst but,
// with the burst nudge neutered (noBurst), the two clients restart ~err0 apart and STAY skewed:
// every input from the ahead side lands ticks late on the behind side -- a per-input rollback
// storm with half-second silent gaps (the CONNECTION LOST jank; under field loss it decays to
// OUT OF SYNC). That the control reliably storms is what proves the burst, not mere latency
// slack, is doing the work. Its treatment arm is LB, which is also CONVERGE's second case: one
// run serves both claims, so the control is the only extra match this file pays for.
const { runMatch } = require('./duel-driver');

// A rematch fires mid-run (opts.rematch.at seconds). err0 is the initial relative clock offset the
// server syncs leave; the burst must correct it across the restart. Each run plays 8s, restarts,
// then plays the second match out -- the restart is the subject, so the run-up only has to be long
// enough for a real multi-input, multi-level match to be under way when it fires.
//   clean     : a moderate offset that flashed CONNECTION LOST in the field (drop>0 before the fix)
//   loss+drift: a larger realistic offset + 3% loss (go retries must survive) + a drifting clock.
//               Doubles as the treatment arm of the falsification pair below.
const LB = { name:'loss+drift e=150 ', secs:24, seed:0x77C0, p2pBoundary:true, wire:{ base:7, jit:3, loss:0.03 },
    phase:8, tjit:4, recv:true, clock:{ drift:1200, err0:150, samples:8 }, rematch:{ at:8 } };

// Minimum rb the control must ADD over the treatment run for the pair to falsify anything.
// Observed 173 vs 48 (+125): the floor sits well under that, so ordinary wire noise cannot trip it
// while a collapse of the effect still can.
const LB_MARGIN = 80;

const CONVERGE = [
    { name:'clean err0=90    ', secs:24, seed:0x77C0, p2pBoundary:true, wire:{ base:6, jit:3, loss:0.02 },
      phase:8, tjit:4, recv:true, clock:{ drift:600, err0:90, samples:8 }, rematch:{ at:8 } },
    LB,
];

const steps = [];
let failed = 0;

let withBurst = null;
for(const sc of CONVERGE){
    const r = runMatch(sc);
    if(sc === LB) withBurst = r;   // the treatment arm of the falsification pair
    // A clean rematch: the restart actually fired, converged, no refused inputs (drop=0 -> no
    // CONNECTION LOST flash), no ring split, no product desync, no DESYNC session-end, no local
    // teleport. A gameplay duelOver in the SECOND match is fine; only a session-end is a failure.
    const bad = !r.rematched || !r.converged || !!r.firstDiverge || r.drop > 0
        || r.desyncA > 0 || r.desyncB > 0 || r.exitReason === 'session-end' || r.localJumps > 0;
    const fd = r.firstDiverge ? ('  1stDiverge @' + r.firstDiverge.tick + ' [' + r.firstDiverge.fields.join(',') + ']') : '';
    steps.push(sc.name.trim().padEnd(18)
        + ' rematched=' + (r.rematched ? 'yes' : 'NO')
        + ' conv=' + (r.converged ? 'yes' : 'NO')
        + ' drop=' + r.drop + ' (A' + r.dropA + '/B' + r.dropB + ')'
        + ' selfJumps=' + r.localJumps
        + ' desync=' + r.desyncA + '/' + r.desyncB
        + (r.exitReason ? ' exit=' + r.exitReason : '')
        + fd + '   ' + (bad ? 'FAIL' : 'ok'));
    if(bad) failed++;
}

// Load-bearing: WITH the burst the rematch must hold (drop=0, asserted in the loop above); the
// noBurst control must show the skew storm. Both runs share the FIRST match (and its err0-skew
// rollbacks), so the discriminator is the rb the control ADDS on top of the treatment run -- an
// absolute floor would ride on the shared first match and go stale with any unrelated shift.
// If the gap collapses the scenario no longer isolates the restart burst and the guard is
// worthless, so fail it to force a re-examination.
const noBurst = runMatch(Object.assign({}, LB, { noBurst:true }));
const lbBad = noBurst.rb < withBurst.rb + LB_MARGIN;
steps.push('burst load-bearing'.padEnd(18)
    + ' WITH: drop=' + withBurst.drop + ' rb=' + withBurst.rb + ' conv=' + (withBurst.converged ? 'yes' : 'NO')
    + '  | noBurst(ctrl): rb=' + noBurst.rb
    + '   ' + (lbBad ? 'FAIL' : 'ok'));
if(lbBad) failed++;

console.log(steps.join('\n'));
if(failed){
    console.log('\nDUEL-REMATCH FAIL: ' + failed + ' case(s) -- the server-path restart did not hold lockstep'
        + '\n  (refused inputs / CONNECTION LOST / DESYNC exit), or the burst control failed to falsify.');
    process.exit(1);
}
console.log('\nDUEL-REMATCH PASSED');
