// SERVER-PATH RESTART (rematch) test (DEFAULT suite). A rematch is host-authored now: the host runs
// a bilateral clock BURST (both sides measure the peer offset over ~150ms), nudges its own clock
// onto the shared midpoint, authors the new match's start PTS on that clock and ships it on the
// reliable 'rst'/'sched' lvl:0 with the agreed offset as 'bth' -- the joiner applies its own half
// from bth, so that single number lands on the same real instant on both. Before the burst a rematch
// carried whatever relative clock offset the two independent server syncs left UNCORRECTED into the
// new match. The peer's honest current-tick inputs then landed outside the rollback window and were
// refused (drop -> _rbWarnAt -> "CONNECTION LOST"), and past ~250ms one-sided apply diverged the
// ring -> DESYNC. This drives the REAL rematch RECEIVE path (__rematchHost -> rst lvl:0) over the
// simulated wire and asserts lockstep with NO drops.
//
// The last pair is a FALSIFICATION: the same rematch-across-an-offset holds WITH the burst but,
// with the burst nudge neutered (noBurst), the joiner begins the new match on its stale clock and
// the peer's inputs are refused -- drops (CONNECTION LOST). That the control reliably drops is what
// proves the burst, not mere latency slack, is doing the work.
const { runMatch } = require('./duel-driver');

// A rematch fires mid-run (opts.rematch.at seconds). err0 is the initial relative clock offset the
// server syncs leave; the burst must correct it across the restart.
//   clean     : a moderate offset that flashed CONNECTION LOST in the field (drop>0 before the fix)
//   loss+drift: a larger realistic offset + 3% loss (rst repeats must survive) + a drifting clock
const CONVERGE = [
    { name:'clean err0=90    ', secs:34, seed:0x77C0, p2pBoundary:true, wire:{ base:6, jit:3, loss:0.02 },
      phase:8, tjit:4, recv:true, clock:{ drift:600, err0:90, samples:8 }, rematch:{ at:14 } },
    { name:'loss+drift e=150 ', secs:34, seed:0x77C0, p2pBoundary:true, wire:{ base:7, jit:3, loss:0.03 },
      phase:8, tjit:4, recv:true, clock:{ drift:1200, err0:150, samples:8 }, rematch:{ at:14 } },
];

// Falsification pair: a rematch across err0=150. The burst corrects it at the restart (drop=0);
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

// Load-bearing: WITH the burst the rematch must hold (drop=0); the noBurst control must drop (the
// CONNECTION LOST symptom) -- else the scenario no longer isolates the restart burst and the
// guard is worthless, so fail it to force a re-examination.
const withBurst = runMatch(Object.assign({}, LB));
const noBurst   = runMatch(Object.assign({}, LB, { noBurst:true }));
const lbBad = withBurst.drop > 0 || !withBurst.converged || !!withBurst.firstDiverge
    || !withBurst.rematched || noBurst.drop === 0;
steps.push('burst load-bearing'.padEnd(18)
    + ' WITH: drop=' + withBurst.drop + ' conv=' + (withBurst.converged ? 'yes' : 'NO')
    + '  | noBurst(ctrl): drop=' + noBurst.drop
    + '   ' + (lbBad ? 'FAIL' : 'ok'));
if(lbBad) failed++;

console.log(steps.join('\n'));
if(failed){
    console.log('\nDUEL-REMATCH FAIL: ' + failed + ' case(s) -- the server-path restart did not hold lockstep'
        + '\n  (refused inputs / CONNECTION LOST / DESYNC exit), or the burst control failed to falsify.');
    process.exit(1);
}
console.log('\nDUEL-REMATCH PASSED');
