// SERVER-PATH RESTART (rematch) test (DEFAULT suite). A level boundary in an ongoing match is
// pure P2P and P2P-aligns the joiner's clock to the host (rst lvl:1). A first-start/rematch is
// different: it is SERVER-issued (start.php authors the start_pts; host relays it on 'sched'/'rst'
// with lvl:0). The joiner used to align ONLY on lvl:1, so a rematch carried whatever relative
// clock offset the two independent server syncs left UNCORRECTED into the new match. The peer's
// honest current-tick inputs then landed outside the rollback window and were refused (drop ->
// _rbWarnAt -> "CONNECTION LOST"), and past ~250ms one-sided apply diverged the ring -> DESYNC.
// The fix aligns the joiner's clock on EVERY start (net.js rst handler), so the server-authored
// start_pts lands on the same real instant on both. This drives the REAL rematch RECEIVE path
// (__rematchHost -> rst lvl:0) over the simulated wire and asserts lockstep with NO drops.
//
// The last pair is a FALSIFICATION: the same rematch-across-an-offset holds WITH alignment but,
// with alignment neutered (noAlign), the joiner begins the new match on its stale clock and the
// peer's inputs are refused -- drops (CONNECTION LOST). That the control reliably drops is what
// proves the alignment, not mere latency slack, is doing the work.
const { runMatch } = require('./duel-driver');

// A rematch fires mid-run (opts.rematch.at seconds); the joiner's align window still carries the
// last level's samples (consumed only at a start), the realistic field condition. err0 is the
// initial relative clock offset the server syncs leave; the fix must correct it across the restart.
//   clean     : a moderate offset that flashed CONNECTION LOST in the field (drop>0 before the fix)
//   loss+drift: a larger realistic offset + 3% loss (rst repeats must survive) + a drifting clock
const CONVERGE = [
    { name:'clean err0=90    ', secs:34, seed:0x77C0, p2pBoundary:true, wire:{ base:6, jit:3, loss:0.02 },
      phase:8, tjit:4, recv:true, clock:{ drift:600, err0:90, samples:8 }, rematch:{ at:14 } },
    { name:'loss+drift e=150 ', secs:34, seed:0x77C0, p2pBoundary:true, wire:{ base:7, jit:3, loss:0.03 },
      phase:8, tjit:4, recv:true, clock:{ drift:1200, err0:150, samples:8 }, rematch:{ at:14 } },
];

// Falsification pair: a rematch across err0=150. Alignment corrects it at the restart (drop=0);
// without it the offset carries uncorrected and the peer's current-tick inputs are refused.
const LB = { secs:34, seed:0x77C0, p2pBoundary:true, wire:{ base:6, jit:3, loss:0.02 },
    phase:8, tjit:4, recv:true, clock:{ drift:600, err0:150, samples:8 }, rematch:{ at:14 } };

const steps = [];
let failed = 0;

for(const sc of CONVERGE){
    const r = runMatch(sc);
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

// Load-bearing: WITH alignment the rematch must hold (drop=0); the noAlign control must drop (the
// CONNECTION LOST symptom) -- else the scenario no longer isolates the restart alignment and the
// guard is worthless, so fail it to force a re-examination.
const withAlign = runMatch(Object.assign({}, LB));
const noAlign   = runMatch(Object.assign({}, LB, { noAlign:true }));
const lbBad = withAlign.drop > 0 || !withAlign.converged || !!withAlign.firstDiverge
    || !withAlign.rematched || noAlign.drop === 0;
steps.push('align load-bearing'.padEnd(18)
    + ' WITH: drop=' + withAlign.drop + ' conv=' + (withAlign.converged ? 'yes' : 'NO')
    + '  | noAlign(ctrl): drop=' + noAlign.drop
    + '   ' + (lbBad ? 'FAIL' : 'ok'));
if(lbBad) failed++;

console.log(steps.join('\n'));
if(failed){
    console.log('\nDUEL-REMATCH FAIL: ' + failed + ' case(s) -- the server-path restart did not hold lockstep'
        + '\n  (refused inputs / CONNECTION LOST / DESYNC exit), or the alignment control failed to falsify.');
    process.exit(1);
}
console.log('\nDUEL-REMATCH PASSED');
