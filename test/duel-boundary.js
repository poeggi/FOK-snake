// P2P LEVEL-BOUNDARY test (DEFAULT suite). A level change in an ongoing 1:1 is pure P2P now: the
// host authors the next level's start PTS on its own clock and ships it on the reliable 'rst'
// (no /api/start.php, no stale-epoch 409), and the joiner steps ITS clock onto the host's -- the
// background align pings, applied in the rst handler -- so that single number lands on the same
// real instant on both. This drives the REAL boundary over the simulated wire (the atomic
// __levelUp shortcut the other tests use can't: it injects a shared start_pts and so could never
// reproduce the field's CONNECTION-LOST-at-level-2/3). Each scenario plays across >=1 boundary
// under a distinct adversity and asserts the two sims stay in lockstep.
//
// The last pair is a FALSIFICATION: the same drifting-clock match WITH alignment holds, but with
// alignment neutered (noAlign) the joiner re-anchors each boundary on its stale clock and the
// offset compounds until it blows the tolerance window and diverges. That the control reliably
// diverges is what proves the alignment -- not mere latency slack -- is doing the work.
const { runMatch } = require('./duel-driver');

// Adversity scenarios that must STAY in lockstep across the real P2P boundary. levelReached>=2
// guarantees at least one boundary was actually crossed (not just level-1 play). Durations are
// trimmed to the minimum that crosses a boundary so the pre-commit hook stays fast.
//   host-init         : host presses OK -> authors + ships rst (the common path)
//   loss+drift+doze   : 3% loss (rst repeats must survive) + drifting joiner clock + heavy-tail
//                       180ms stalls around boundaries (iOS-doze-like) -- three adversities at once
//   joiner-init reqlvl: joiner presses OK -> reqlvl -> host rst round trip (the other trigger)
const CONVERGE = [
    { name:'host-init clean   ', secs:28, seed:0x77C0, p2pBoundary:true, wire:{ base:5, jit:2, loss:0 },
      phase:8, tjit:4, recv:true },
    { name:'loss+drift+doze   ', secs:32, seed:0x77C0, p2pBoundary:true, wire:{ base:7, jit:3, loss:0.03, spike:{ p:0.02, ms:180 } },
      phase:8, tjit:4, recv:true, clock:{ drift:1500, err0:40, samples:8 } },
    { name:'joiner-init reqlvl', secs:30, seed:0x77C0, p2pBoundary:true, initJoiner:true, wire:{ base:6, jit:3, loss:0.02 },
      phase:8, tjit:4, recv:true, clock:{ drift:1000, err0:0, samples:8 } },
];

// Falsification pair: a heavily drifting joiner clock (models a doze-throttled device). Alignment
// snaps it back each boundary; without it the offset compounds and diverges. drift=12000 diverges
// fast (noAlign @~tick 500) so the default run stays cheap. The multi-seed robustness of the
// mechanism was verified separately at drift=6000 across 0x77C0/0xD0E1/0xBEEF/0x1234 (all diverge
// without alignment); a slower full sweep lives in the on-demand netprofile.
const LB = { secs:26, seed:0x77C0, p2pBoundary:true, wire:{ base:7, jit:3, loss:0.02 },
    phase:8, tjit:4, recv:true, clock:{ drift:12000, err0:6, samples:8 } };

const steps = [];
let failed = 0;

for(const sc of CONVERGE){
    const r = runMatch(sc);
    // A clean boundary: converged, no unhealed ring split, no product desync, no DESYNC exit, no
    // teleporting local head, and at least one boundary actually crossed. A gameplay duelOver is
    // fine (someone lost their lives); only a session-end (DESYNC - MATCH ENDED) is a failure.
    const bad = !r.converged || !!r.firstDiverge || r.desyncA > 0 || r.desyncB > 0
        || r.exitReason === 'session-end' || r.localJumps > 0 || r.levelReached < 2;
    const fd = r.firstDiverge ? ('  1stDiverge @' + r.firstDiverge.tick + ' [' + r.firstDiverge.fields.join(',') + ']') : '';
    steps.push(sc.name.trim().padEnd(20)
        + ' L' + r.levelReached + ' ups=' + r.levelUps
        + ' conv=' + (r.converged ? 'yes' : 'NO')
        + ' selfJumps=' + r.localJumps
        + ' desync=' + r.desyncA + '/' + r.desyncB
        + (r.exitReason ? ' exit=' + r.exitReason : '')
        + fd + '   ' + (bad ? 'FAIL' : 'ok'));
    if(bad) failed++;
}

// Load-bearing: WITH alignment must hold; the noAlign control must diverge (else the scenario no
// longer isolates alignment and the guard is worthless -- fail so it gets re-examined).
const withAlign = runMatch(Object.assign({}, LB));
const noAlign   = runMatch(Object.assign({}, LB, { noAlign:true }));
const lbBad = !!withAlign.firstDiverge || !withAlign.converged || !noAlign.firstDiverge;
steps.push('align load-bearing'.padEnd(20)
    + ' WITH: div=' + (withAlign.firstDiverge ? ('@' + withAlign.firstDiverge.tick) : 'none') + ' conv=' + (withAlign.converged ? 'yes' : 'NO')
    + '  | noAlign(ctrl): div=' + (noAlign.firstDiverge ? ('@' + noAlign.firstDiverge.tick) : 'none')
    + '   ' + (lbBad ? 'FAIL' : 'ok'));
if(lbBad) failed++;

console.log(steps.join('\n'));
if(failed){
    console.log('\nDUEL-BOUNDARY FAIL: ' + failed + ' case(s) -- the P2P level boundary did not hold lockstep'
        + '\n  (unhealed divergence / DESYNC exit / local teleport), or the alignment control failed to falsify.');
    process.exit(1);
}
console.log('\nDUEL-BOUNDARY PASSED');
