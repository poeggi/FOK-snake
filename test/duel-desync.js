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
const { runMatch, jouster } = require('./duel-driver');
const lane = require('./lanes');

const steps = [];
const log = s => { steps.push(s); };

// Scenarios chosen to exercise each pinpointed failure independently:
//   clean-boost : phase offset only, NO loss -> isolates the deferred-rollback boost drop (F1)
//   lossy-boost : + packet loss              -> stresses the redundancy/loss window (F3)
//   long-levels : the multi-boundary soak    -> exercises the level-boundary epoch gap (F2).
//                 It has to cross TWO boundaries (L1->L2->L3), which this seed reaches at
//                 ~28s, so the length sits just past that and expectLevel:3 holds it there:
//                 running longer only buys more level-3 minutes, running shorter silently
//                 drops the second boundary and the name stops being true.
//   windswept   : jousting passes + loss     -> the near-miss steal, sim AND wardrobe write-back
//   headroom    : CRUCIAL -- do not shorten, reseed, relax maxRb or fold into another case. It is
//                 the only guard on the duel pairing's load-bearing invariant, and it is a HARD
//                 zero: there is no "a few rollbacks are fine" reading of it to erode.
//                 The clocks START 60ms apart (err0 60 -- past the whole authoring lead) on a
//                 28ms-RTT channel; the REAL first-start burst sync must first bring the relative
//                 pts to nearly 0 (asserted via startSync), and only then does play open. From
//                 there the wire alone spends 90% of the budget the design GUARANTEES -- which is
//                 ONE TICK_MS, not SIM_LEAD of them (see THE AUTHORING CLOCK in js/sim.js): a
//                 record born just before the next tick fires is only (SIM_LEAD-1) whole ticks
//                 from its target, so 14+1 = 15ms of 16.67ms. opts.authorPhase is what puts
//                 authoring at that instant. WITHOUT it the driver stamps every record at the
//                 tick boundary, the budget silently doubles to 33.3ms, and this lane stays green
//                 out past a 32ms wire while guarding nothing -- which is exactly what it did
//                 while the wire read base:31. Measured cliff at worst-case authoring: 15ms
//                 rollback-free, 17ms rolling back in the hundreds. So the lane holds 0 rollbacks
//                 ONLY if the burst residual stays inside the remaining margin AND the author
//                 headroom does its job -- it PROVES both ends of the chain at once: the burst
//                 earns the sub-tick condition, and every input then lands within its authoring
//                 lead, delivered on time (or via the one-tick-late shortcut) and NEVER rolls
//                 back (maxRb:0). The wire is tied to SIM_LEAD as (SIM_LEAD-1) ticks: change the
//                 lead and the wire and err0 must be re-scaled with it, or the lane stops being a
//                 guard and starts passing vacuously. The match levels through
//                 the REAL L1->L2 req->go boundary (re-burst on the wire) into a speed round both
//                 clients must see (expectLevel/expectSpeed), under heavy movement and multi-touch
//                 gestures from BOTH ends. The noburst twin lane proves the burst is load-bearing:
//                 apply disabled, same start gap -> the raw 60ms gap outlasts the lead and
//                 rollbacks appear. (Correction survival across
//                 boundaries at LARGER err0 is duel-boundary/duel-rematch territory.)
const SCEN = [
    { name:'clean-boost  phase8 jit  ', seed:0xD0E1, secs:12, wire:{ base:5,  jit:2,  loss:0    }, phase:8, tjit:4, recv:true },
    { name:'lossy-boost  5% loss      ', seed:0xBEEF, secs:20, wire:{ base:12, jit:6,  loss:0.05 }, phase:8, tjit:4, recv:true },
    { name:'long-levels  to L2-3      ', seed:0x77C0, secs:32, wire:{ base:7,  jit:3,  loss:0.02 }, phase:8, tjit:4, recv:true, expectLevel:3 },
    // Clocks start 28-32ms apart (err0 30 +/- anchor jitter): ~1.8 engine ticks of raw pts gap,
    // unplayable at 0rb if left standing. startBurst runs the production first-start burst over
    // the same delayed wire (host _netBurstThenStart -R/2; the joiner applies the host-computed
    // bth residual from the go -- its own samples would starve at this RTT) BEFORE the first game
    // tick, exactly as a real 2.6 match syncs on its first go. The lane asserts the sync itself:
    // |gap0| > 25 (the start condition is real) and |gap1| <= 3 (relative pts brought to nearly
    // 0). Play then runs with tick schedules ALIGNED (phase0/tjit0) on a wire that alone uses
    // 90% of the one-tick budget: 13-15ms transit (base14 +/- jit1) against the 16.67ms tick.
    // The tick is the ceiling by physics -- at a 17ms worst packet the record is over budget and
    // a rollback would be CORRECT (measured there: rb in the hundreds). It is the SUM of net +
    // residual pts + any schedule skew that must stay under a tick, so the burst residual eats
    // the remaining margin directly: a ~1.5ms residual regression flips this lane red. That
    // is the point -- the sub-tick margin the engine owes either side is only available if
    // PTS alignment works, so this lane tests both at once. With skew zeroed this is a
    // KNOWN-0rb condition and maxRb:0 is exact; any rb here is a real headroom (or burst)
    // leak to debug.
    //
    // p2pBoundary is ACTIVE coverage: the pilots level through the REAL L1->L2 req->go boundary
    // (epoch bump, simTick->0, re-burst on the wire), and L2 for this seed is a SPEED round --
    // faster game ticks, more moves, more records -- which BOTH clients must observe
    // (expectLevel:2 + expectSpeed). The atomic test shortcut would re-zero _netSync.ofs and
    // silently WIPE the correction, turning the lane red for the wrong reason; the real boundary
    // re-earns it on the wire. Boundary-burst survival at larger err0 stays duel-boundary
    // (err0 40) / duel-rematch (err0 90) territory. Schedule skew is a separate stress -- see
    // clean-boost.
    //
    // postAuthor: worst-case input phase. Steers are authored AFTER their tick ran (a real touch
    // lands mid-interval, after the boundary's flush already left) and each is HELD to the last
    // interval that still names the coming step boundary (_gDue==SIM_LEAD; from anywhere earlier
    // in the window the target is that same boundary, so the pilot loses nothing -- one interval
    // later the authoring floor moves it to the NEXT boundary, which would degrade the pilot and
    // measure nothing about the netcode). A flush deferred to the next tick then burns one of the
    // lead's ticks, and the wire below is sized to eat nearly all of what is left: it arrives
    // transit-late, a guaranteed rollback. Only the send-at-authoring contract (netLocalInput's
    // leading-edge flush; netTickPost for boost) keeps a whole-lead-minus-transit budget and holds
    // rb at 0. A deferred-only flush fails this scenario with rb in the hundreds. The default authoring path is DOUBLY best-case -- pre-tick (the
    // same boundary's flush ships the record, zero deferral) and at maximum _gDue (autopilot
    // intents are born right after a game step) -- which is how that defect stayed green here.
    // doubleEvery: every 2nd intent is a MULTI gesture (fast fingers), alternating between a
    // DOUBLE in the last interval (both records must ship at authoring -- proves the two-flush
    // cap) and a TRIPLE at birth (its third record exceeds the cap and coalesces into the next
    // tick's flush -- the cap-deferred path stays on the wire and inside the authoring lead).
    // Decoys are provably-inert reverses of the dirQueue TAIL -- see duel-driver.
    // CRUCIAL (see header): the 0-rollback headroom guard. Keep it long and keep maxRb at 0.
    { name:'headroom     burst 0rb   ', seed:0x7002, secs:30, wire:{ base:14, jit:1,  loss:0    }, phase:0, tjit:0, clock:{ err0:60, drift:5, samples:8 }, startBurst:true, p2pBoundary:true, recv:true, postAuthor:true, authorPhase:0.05, doubleEvery:2, maxRb:0, expectSync:{ minGap0:50, maxGap1:3 }, expectLevel:2, expectSpeed:true },
    // Falsification twin: identical start gap and wire, burst APPLY disabled (noBurst) -> the raw
    // 30ms (~1.8 tick) offset stands, the ahead peer runs a persistent tick lead, the other side's
    // inputs land late there, rollbacks MUST appear (minRb) while the pair still HEALS by rollback
    // (all health gates stay on). RED without the burst, GREEN with -- proves the lane above is
    // load-bearing, not vacuously 0.
    { name:'headroom     noburst RED ', seed:0x7002, secs:10, wire:{ base:14, jit:1,  loss:0    }, phase:0, tjit:0, clock:{ err0:60, drift:5, samples:8 }, startBurst:true, noBurst:true, recv:true, postAuthor:true, authorPhase:0.05, doubleEvery:2, minRb:1, expectSync:{ minGap1:50 } },
    // WINDSWEPT steal over the wire. The autopilot deliberately keeps two cells of clearance, so
    // under it the near-miss rules are dead code -- this lane flies the `jouster` director instead:
    // adjacent opposing lanes, one cell apart, boosting down the lane and braking into the turns,
    // then chasing whatever comes loose. That is the only way the driver ever produces a near miss.
    // What it guards, beyond the usual health gates:
    //   expectWs   both a blow and a completed pickup actually happen (the lane cannot pass
    //              vacuously by simply never staging a near miss), and the two sims agree on the
    //              full steal state -- both worn lists AND the loose item -- after the settle.
    //   wsOwnBad   the per-device write-back moved the gear the same way the sim did, both halves:
    //              the winner's device gained it, the loser's lost it. Needs flushFx, which runs
    //              the browser's presentation half (the 2-tick queues) inside the tick loop -- so
    //              this is also the only lane where the deferred fx path itself is exercised under
    //              rollback, i.e. where a cosmetic kind that never reaches _fxQ shows up as a miss.
    // Both wardrobes are stocked from BOTH tables (shop + box) so the sim's fixed-order registry,
    // the per-slot displacement and the price ladder all participate. Lossy on purpose: a steal
    // that is rolled back mid-flight and re-simmed must land on the same wardrobe on both ends.
    { name:'windswept    steal 5% loss', seed:0xBEEF, secs:25, wire:{ base:12, jit:6, loss:0.05 }, phase:8, tjit:4, recv:true,
      director: jouster, flushFx:true, ws:{ A:['shades','moustache','crown'], B:['cylinder','glasses3d','wizard'] },
      expectWs:{ minBlows:1, minSteals:1 } },
];

let failed = 0;
for(const sc of lane(SCEN)){
    const r = runMatch(sc);
    const rbOver = sc.maxRb != null && r.rb > sc.maxRb;
    const rbUnder = sc.minRb != null && r.rb < sc.minRb;
    const ss = r.startSync, ex = sc.expectSync;
    const g0 = ss ? Math.abs(ss.gap0) : 0, g1 = ss ? Math.abs(ss.gap1) : 0;
    const syncBad = !!ex && (!ss
        || (ex.minGap0 != null && g0 <= ex.minGap0)     // the start condition was not actually hard
        || (ex.maxGap1 != null && g1 > ex.maxGap1)      // burst failed to bring pts to nearly 0
        || (ex.minGap1 != null && g1 <= ex.minGap1));   // noburst twin: the gap must SURVIVE
    const lvlBad = sc.expectLevel != null && r.levelReached < sc.expectLevel;   // the real boundary must fire
    const spdBad = !!sc.expectSpeed && !(r.speedRoundA && r.speedRoundB);       // BOTH clients must see the speed round
    const ew = sc.expectWs;
    const wsBad = !!ew && (r.wsBlows < ew.minBlows || r.wsSteals < ew.minSteals   // the rules must have actually fired
        || !r.wsSame || r.wsOwnBad > 0);                                          // and both ends agree, sim AND wardrobe
    const bad = r.localJumps > 0 || !!r.firstDiverge || !r.converged
        || r.desyncA > 0 || r.desyncB > 0 || r.exitReason === 'session-end' || rbOver || rbUnder
        || syncBad || lvlBad || spdBad || wsBad;
    const fd = r.firstDiverge ? ('  1stDiverge @' + r.firstDiverge.tick + ' [' + r.firstDiverge.fields.join(',') + ']') : '';
    const rbNote = sc.maxRb != null ? (rbOver ? '  rb>' + sc.maxRb + ' HEADROOM LEAK' : '  (<=' + sc.maxRb + ' rb: headroom holds)')
        : sc.minRb != null ? (rbUnder ? '  rb<' + sc.minRb + ' LANE NOT LOAD-BEARING' : '  (rb>=' + sc.minRb + ': burst is load-bearing)') : '';
    const syncNote = ss ? ' pts=' + ss.gap0 + '->' + ss.gap1 + (syncBad ? ' SYNC BAD' : '') : '';
    log(sc.name.trim().padEnd(22)
        + ' L' + r.levelReached + (lvlBad ? ' NO LEVEL-UP' : '')
        + (sc.expectSpeed ? ' speed=' + (r.speedRoundA ? 'A' : '-') + (r.speedRoundB ? 'B' : '-') + (spdBad ? ' MISSED' : '') : '')
        + ' conv=' + (r.converged ? 'yes' : 'NO')
        + ' selfJumps=' + r.localJumps + (r.maxLocalJump > 1 ? '(max' + r.maxLocalJump + ')' : '')
        + (ew ? ' ws=' + r.wsBlows + 'blown/' + r.wsSteals + 'stolen'
                 + (r.wsSame ? '' : ' SIM SPLIT') + (r.wsOwnBad ? ' WARDROBE x' + r.wsOwnBad : '') : '')
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
        + '\n  not stay in lockstep (own-snake teleports / unhealed hash split / DESYNC exit),'
        + '\n  or the windswept steal did not fire / left the two devices wearing different gear.');
    process.exit(1);
}
console.log('\nDUEL-DESYNC PASSED');
