// P2P LEVEL-BOUNDARY test (DEFAULT suite). A level change in an ongoing 1:1 is pure P2P now: at the
// boundary the host runs a bilateral clock BURST (both sides measure the peer offset over ~150ms),
// nudges its own clock onto the shared midpoint, authors the next level's start PTS on that clock
// and ships it on the echo-acked go {why:'level'} (no /api/start.php, no stale-epoch 409) with the agreed offset
// as 'bth' -- the joiner applies its own half from bth, so that single number lands on the same real
// instant on both. This drives the REAL boundary over the simulated wire (the atomic __levelUp
// shortcut the other tests use can't: it injects a shared start_pts and so could never reproduce the
// field's CONNECTION-LOST-at-level-2/3). Each scenario plays across >=1 boundary under a distinct
// adversity -- loss, drift, doze -- and asserts the two sims stay byte-identical across the simTick
// reset to 0.
//
// This test guards the boundary PATH (epoch bump, simTick->0, go + its echo-acked retries over a
// lossy wire, the req {why:'level'} round trip). The burst MECHANISM is guarded elsewhere and not re-proven
// here: duel-sync.js is the unit test (both sides compute the same theta and nudge to the midpoint),
// and duel-rematch.js is the load-bearing control (a fresh server sync injects a correctable offset
// the burst must remove, drop>0 without it). A single level boundary can't host that control: the
// only offset present is what accumulated during one level, and a constant offset that survives a
// level survives the next unchanged (drift big enough to compound across a boundary already blows
// level 1, where nothing has bursted yet), so a noBurst run at the same realistic drift converges
// too -- the multi-boundary accumulation the burst actually bounds is a slow sweep that lives in the
// on-demand netprofile, not this fast guard.
const { runMatch } = require('./duel-driver');

// Adversity scenarios that must STAY in lockstep across the real P2P boundary. levelReached>=2
// guarantees at least one boundary was actually crossed (not just level-1 play). Durations are
// trimmed to the minimum that crosses a boundary so the pre-commit hook stays fast.
//   host-init         : host presses OK -> authors + ships the go (the common path)
//   loss+drift+doze   : 3% loss (go retries must survive) + drifting joiner clock + heavy-tail
//                       180ms stalls around boundaries (iOS-doze-like) -- three adversities at once
//   joiner-init req   : joiner presses OK -> req -> host go round trip (the other trigger)
const CONVERGE = [
    { name:'host-init clean   ', secs:28, seed:0x77C0, p2pBoundary:true, wire:{ base:5, jit:2, loss:0 },
      phase:8, tjit:4, recv:true },
    { name:'loss+drift+doze   ', secs:32, seed:0x77C0, p2pBoundary:true, wire:{ base:7, jit:3, loss:0.03, spike:{ p:0.02, ms:180 } },
      phase:8, tjit:4, recv:true, clock:{ drift:1500, err0:40, samples:8 } },
    { name:'joiner-init req   ', secs:30, seed:0x77C0, p2pBoundary:true, initJoiner:true, wire:{ base:6, jit:3, loss:0.02 },
      phase:8, tjit:4, recv:true, clock:{ drift:1000, err0:0, samples:8 } },
];

const steps = [];
let failed = 0;

for(const sc of CONVERGE){
    const r = runMatch(sc);
    // A clean boundary: converged, no unhealed ring split, no product desync, no DESYNC exit, no
    // teleporting local head, and at least one boundary actually crossed. A gameplay duelOver is
    // fine (someone lost their lives); only a session-end (OUT OF SYNC - MATCH ENDED) is a failure.
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

console.log(steps.join('\n'));
if(failed){
    console.log('\nDUEL-BOUNDARY FAIL: ' + failed + ' case(s) -- the P2P level boundary did not hold lockstep'
        + '\n  (unhealed divergence / DESYNC exit / local teleport).');
    process.exit(1);
}
console.log('\nDUEL-BOUNDARY PASSED');
