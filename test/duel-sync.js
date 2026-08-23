// P2P boundary clock-BURST primitive (DEFAULT suite). Replaces the continuous joiner->host align
// ping (duel-align.js) with a short, symmetric burst run at every boundary: BOTH sides fire a few
// stamped datagrams, each keeps the MINIMUM one-way delta per direction, piggybacks its own
// forward-min so both end holding the SAME two numbers, and each nudges its OWN clock half of the
// agreed offset onto the shared midpoint. Neither side is the master.
//
// This drives the real net.js burst primitive directly (no full match), over a modelled wire with
// a frozen clock offset (e0) + path asymmetry (asym) + jitter, and proves the four properties the
// lockstep boundary depends on:
//   1. IDENTICAL theta   -- both sides compute the same offset (the invariant the nudge relies on;
//                           if they differed, the two sims would derive different ticks at tick 0).
//   2. correct offset    -- theta has the right sign + magnitude (peer clock recovered).
//   3. midpoint, no master -- each side applies ~theta/2 with OPPOSITE sign; after both apply, the
//                           two clocks agree to under one tick (residual = the fundamental path
//                           asymmetry/2, the same floor the old one-directional scheme had).
//   4. doze-robust + gated -- an injected heavy-delay sample never moves the min; a starved burst
//                           (a one-sided doze) is REJECTED so the previous in-play clock is kept.
const { mk } = require('./duel-driver');

const NET_BASE = 1784500000000;
const TICK = 1000 / 60;

const steps = [];
let failed = 0;
const line = (name, ok, detail)=>{ steps.push(name.padEnd(22) + detail + (ok ? '  ok' : '  FAIL')); if(!ok) failed++; };

// Deliver one burst datagram sender->receiver: fire it at true-time `sendT` (so its send-pts is
// stamped on the sender's clock then) and fold it at `recvT` (the receiver's clock then). Mirrors
// duel-align's roundTrip, which drives __now to the exact send/receive instants around each __recv.
function deliver(sender, receiver, sendT, recvT){
    sender.__now = sendT;
    sender.__out.length = 0;
    sender.__burstPing();
    const pkt = sender.__out[sender.__out.length - 1];
    if(pkt == null) return;
    receiver.__now = recvT;
    receiver.__recv(pkt);
}

// Run a full burst between a host (clock error 0) and a joiner (clock error e0), over a wire with
// one-way delay `half`, asymmetry `asym` (A->B gets +asym/2, B->A -asym/2) and jitter `jit`. An
// optional `spike` adds a one-shot heavy delay to a single A->B sample (models a doze burst). N
// rounds, each A->B then B->A, so the piggybacked forward-mins converge on both sides.
function runBurst({ e0 = 0, half = 20, asym = 0, jit = 0, N = 10, spike = 0, dropBA = 0 }){
    const A = mk('aaaaaaaa', 0xB0B0, 'host');
    const B = mk('bbbbbbbb', 0xB0B0, 'peer');
    A.__clkInstall(0, 0, NET_BASE);
    B.__clkInstall(e0, 0, NET_BASE);
    A.__burstReset(); B.__burstReset();
    // Deterministic jitter: a tiny fixed LCG so the min-of-samples has something to pick from
    // without making the test flaky. Seeded per burst.
    let seed = 0x9e3779b9 >>> 0;
    const jitv = ()=>{ seed = (seed * 1664525 + 1013904223) >>> 0; return jit ? ((seed / 0xffffffff) * 2 - 1) * jit : 0; };
    let t = 0;
    for(let i = 0; i < N; i++){
        const dAB = half + asym / 2 + jitv() + ((spike && i === Math.floor(N / 2)) ? spike : 0);
        deliver(A, B, t, t + dAB);
        t += 1;
        if(i >= dropBA) {           // dropBA: skip the first `dropBA` B->A samples (starve one direction)
            const dBA = half - asym / 2 + jitv();
            deliver(B, A, t, t + dBA);
        }
        t += 1;
    }
    const thetaA = A.__burstTheta(), thetaB = B.__burstTheta();
    const appliedA = A.__burstApply(), appliedB = B.__burstApply();
    // Read both clocks at ONE common true-time instant to measure the residual between them.
    A.__now = t; B.__now = t;
    const residual = B.__pts() - A.__pts();
    return { thetaA, thetaB, appliedA, appliedB, residual };
}

// 1. Symmetric recovery: joiner clock 40ms ahead, clean wire. Both must agree on theta, recover
//    the offset (theta ~ -e0), each apply ~half of it with opposite sign, and end < 1 tick apart.
{
    const e0 = 40, r = runBurst({ e0, half: 20 });
    const want = -e0;                                   // theta = host - joiner = -e0 (asym 0)
    const identical = r.thetaA === r.thetaB;
    const recovered = Math.abs(r.thetaA - want) <= 2;
    const symmetric = Math.abs(r.appliedA + r.appliedB) <= 1 && Math.sign(r.appliedA) === -Math.sign(r.appliedB)
                      && Math.abs(Math.abs(r.appliedA) - Math.abs(want) / 2) <= 2;
    const agree = Math.abs(r.residual) < TICK;
    line('sym +40 clean', identical && recovered && symmetric && agree,
        ' theta=' + r.thetaA + '/' + r.thetaB + ' applied=' + r.appliedA.toFixed(1) + '/' + r.appliedB.toFixed(1) + ' resid=' + r.residual.toFixed(1));
}

// 2. Opposite sign: joiner clock 30ms BEHIND. theta must flip sign; still symmetric + agreeing.
{
    const e0 = -30, r = runBurst({ e0, half: 25 });
    const identical = r.thetaA === r.thetaB;
    const recovered = Math.abs(r.thetaA - (-e0)) <= 2;
    const agree = Math.abs(r.residual) < TICK;
    line('sym -30 clean', identical && recovered && agree,
        ' theta=' + r.thetaA + ' applied=' + r.appliedA.toFixed(1) + '/' + r.appliedB.toFixed(1) + ' resid=' + r.residual.toFixed(1));
}

// 3. Path asymmetry: the residual floor. theta is biased by -asym/2 (unrecoverable with timestamps
//    alone), but both sides still AGREE and the residual stays the same asym/2 the old scheme had.
{
    const e0 = 50, asym = 12, r = runBurst({ e0, half: 30, asym });
    const identical = r.thetaA === r.thetaB;
    const near = Math.abs(r.thetaA - (-e0 - asym / 2)) <= 2;   // expected theta = -e0 - asym/2
    const agree = Math.abs(r.residual) < TICK;                  // asym/2 = 6ms < one tick
    line('asym 12', identical && near && agree,
        ' theta=' + r.thetaA + ' resid=' + r.residual.toFixed(1) + ' (floor ' + (asym / 2) + ')');
}

// 4. Doze spike + jitter: one A->B sample delayed 200ms (a power-save burst). The MIN must ignore
//    it -- theta the same as the clean run to within jitter -- so a dozing radio can't bias the clock.
{
    const e0 = 40, clean = runBurst({ e0, half: 20, jit: 4 });
    const dozed = runBurst({ e0, half: 20, jit: 4, spike: 200 });
    const rejected = Math.abs(dozed.thetaA - clean.thetaA) <= 2;
    line('doze spike ignored', rejected,
        ' clean=' + clean.thetaA + ' dozed=' + dozed.thetaA);
}

// 5. Accept-gate: starve the B->A direction (only 2 samples). Below NET_BURST_MIN the estimate is
//    untrustworthy, so theta must be null and apply a no-op -- the previous clock is kept.
{
    const r = runBurst({ e0: 40, half: 20, N: 10, dropBA: 8 });   // 10-8 = 2 B->A samples < MIN(3)
    const gated = r.thetaA === null && r.appliedA === 0;
    line('starved -> rejected', gated,
        ' theta=' + JSON.stringify(r.thetaA) + ' applied=' + r.appliedA);
}

console.log(steps.join('\n'));
if(failed){
    console.log('\nDUEL-SYNC FAIL: ' + failed + '/5 -- the boundary clock burst did not agree on/recover the peer'
        + ' offset symmetrically (or failed to reject a doze/starved burst). See js/net.js _netBurst*.');
    process.exit(1);
}
console.log('\nDUEL-SYNC PASSED');
