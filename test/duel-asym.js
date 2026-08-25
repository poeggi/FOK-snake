// DIRECTIONAL rollback asymmetry under a clock offset (REGRESSION suite). In a duel the two clients
// keep independent wall clocks; a residual sync error leaves one running its sim AHEAD of the other
// on the shared timeline. Rollback is then ONE-SIDED and always the same side:
//
//   * the AHEAD client receives the slow peer's inputs already in ITS past -> it must ROLL BACK.
//   * the BEHIND client receives the ahead peer's inputs still in ITS future -> it LIVE-APPLIES,
//     and never rolls back a single one (rbBehind is a HARD invariant zero, not merely "small").
//
// That is the asymmetry a player reports as "my device stutters and theirs is smooth" -- the
// rollbacks (structuredClone re-sims) all land on whichever device's clock sits ahead.
//
// FIDELITY: a clock offset is not just a netPts/target shift. The real loop's _fbSeedPhase (game.js)
// seeds each client's fixed-timestep tick phase from its OWN clock, so an e0-ahead clock also FIRES
// ~e0 ms early and opens a proportional simTick lead (~0.06 tick/ms: 20ms -> ~1.2 ticks). The driver
// models that with clockLeadsFire (bursts off, so the offset is fixed and the coupling is exact).
//
// There is exactly ONE absorber, and it is narrow -- about one tick: the +1-tick authoring headroom
// plus the one-tick-late shortcut in _netPeerInput (duel-core.js) let the ahead client LIVE-APPLY a
// peer input that lands up to ~1 tick in its past instead of rolling back. So on this 10ms link the
// onset is a ~22-25ms offset (a ~1.4-tick lead) -- the field guess of ~20ms sits right AT that edge
// (a ~1.2-tick lead, still absorbed, but only just). It is NOT the several-tick band an earlier
// version of this test wrongly reported: that came from a harness bug (the clock offset was not
// coupled to the fire schedule, so no lead ever opened); clockLeadsFire fixes it.
//
// Asserted over an otherwise CLEAN wire (fixed 10ms latency, no jitter/loss, aligned rAF phase) so
// the clock offset is the SOLE variable and the result is not luck:
//   ABSORB : B +15ms ahead -> BOTH sides zero rollback (inside the ~1-tick absorbing band).
//   ONSET  : B +40ms ahead -> the AHEAD client (B) rolls back, the BEHIND client (A) still zero
//            -- onset is near ONE tick of offset, far below the ~70ms an earlier version claimed.
//   ASYM   : B +150ms ahead -> AHEAD rolls back heavily, BEHIND exactly zero, and lockstep STILL
//            holds (converged, no desync, no self-jump). Heavy one-sided rollback is a smoothness
//            cost on one device, not a correctness failure.
const { runMatch } = require('./duel-driver');

// The driver installs err0 on the peer (B is the AHEAD client) and, with clockLeadsFire, leads B's
// fire schedule by the same offset -- so err0 alone drives both the target lead and the fire lead.
// Bursts off (noBurst) so the offset stays fixed and the coupling is exact. Sample the peak simTick
// lead so each rollback claim is tied to a real, measured lead.
function measure(seed, err0){
    let leadMax = 0;
    const r = runMatch({ seed, secs:15, wire:{ base:10, jit:0, loss:0 }, phase:0, tjit:0, recv:true,
        clock:{ err0, drift:0, samples:8 }, clockLeadsFire:true, noBurst:true,
        onSample:(now, A, B) => { const l = B.__simTick() - A.__simTick(); if(l > leadMax) leadMax = l; } });
    return { rbAhead: r.rbB, rbBehind: r.rbA, leadMax,
             converged: r.converged, desync: r.desyncA + '/' + r.desyncB, selfJumps: r.localJumps };
}

const SEEDS = [0x77C0, 0xD0E1];
const steps = [];
const ok = (c, m) => { steps.push((c ? 'ok  ' : 'ERR ') + m); if(!c) throw new Error(m); };

for(const seed of SEEDS){
    const sd = seed.toString(16);

    // ABSORB: a ~15ms lead is inside the one-tick absorbing band -- the shortcut live-applies the
    // slightly-late peer inputs, so NEITHER side rolls back even though a real (sub-two-tick) lead
    // has opened. The behind client is zero here for the same reason it is zero everywhere.
    const ab = measure(seed, 15);
    steps.push(`ABSORB B+15ms  seed ${sd}: leadMax=${ab.leadMax}  rb ahead/behind=${ab.rbAhead}/${ab.rbBehind}  conv=${ab.converged?'yes':'NO'}`);
    ok(ab.rbAhead === 0 && ab.rbBehind === 0, `15ms skew absorbed: zero rollback on both sides (got ${ab.rbAhead}/${ab.rbBehind})`);
    ok(ab.leadMax >= 1, `15ms skew DOES open a real simTick lead -- the clock offset is coupled to the schedule (leadMax ${ab.leadMax})`);
    ok(ab.converged, '15ms skew: sims still converge');

    // ONSET: a 40ms lead is past the one-tick band, so the ahead client now rolls back -- while the
    // behind client is still exactly zero. Proves the onset is near ONE tick of offset, not several.
    const on = measure(seed, 40);
    steps.push(`ONSET  B+40ms  seed ${sd}: leadMax=${on.leadMax}  rb ahead/behind=${on.rbAhead}/${on.rbBehind}  conv=${on.converged?'yes':'NO'}`);
    ok(on.rbAhead > 0, `40ms skew makes the AHEAD client roll back (onset is near one tick; got ${on.rbAhead})`);
    ok(on.rbBehind === 0, `at onset the BEHIND client still never rolls back (got ${on.rbBehind})`);
    ok(on.converged, '40ms skew: sims still converge');

    // ASYM: a 150ms lead (~9 ticks) runs B far ahead. The asymmetry is stark and, being a pure
    // function of which clock is ahead, ENTIRELY one-directional.
    const as = measure(seed, 150);
    steps.push(`ASYM   B+150ms seed ${sd}: leadMax=${as.leadMax}  rb ahead/behind=${as.rbAhead}/${as.rbBehind}  conv=${as.converged?'yes':'NO'} desync=${as.desync} selfJumps=${as.selfJumps}`);
    ok(as.leadMax >= 8, `150ms skew runs the AHEAD client genuinely ahead (leadMax ${as.leadMax})`);
    ok(as.rbBehind === 0, `the BEHIND client never rolls back -- a hard invariant, not just small (got ${as.rbBehind})`);
    ok(as.rbAhead >= 40, `the AHEAD client absorbs the rollbacks (got ${as.rbAhead}, expected many)`);
    ok(as.rbAhead > as.rbBehind * 20 + 10, `rollback is lopsided onto the ahead client (${as.rbAhead} vs ${as.rbBehind})`);
    // The whole point: one-sided rollback is a SMOOTHNESS cost, never a correctness one.
    ok(as.converged, 'despite heavy one-sided rollback, the sims still converge (lockstep holds)');
    ok(as.desync === '0/0', `no desync under the asymmetry (got ${as.desync})`);
    ok(as.selfJumps === 0, `no own-snake teleport under the asymmetry (got ${as.selfJumps})`);
}

console.log(steps.join('\n'));
console.log('\nduel-asym (rollback falls one-sided on the AHEAD clock; a ~one-tick skew is absorbed) PASSED');
