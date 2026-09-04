// DUEL one-sided suspend recovery (REGRESSION suite). The field repro: in a 1:1 duel one
// device (a phone) is backgrounded for a few seconds while the OTHER keeps playing, then
// foregrounded -- "connection re-established... but then out of sync, and resync fails."
//
// This is an ASYMMETRIC suspend: only ONE sim freezes, the peer's clock and sim run on. The
// `doze` knob models exactly that -- it freezes one client's clock+sim+timers (no tick, send,
// or receive) for `ms`, the peer keeps running, and on resume the frozen side is `ms` of ticks
// behind the SHARED lockstep clock. The two sims are then simulating different tick NUMBERS for
// the same wall time, and no amount of world-state resync reconciles a tick-BASE misalignment.
//
// The recovery machinery had two role-gated holes that this exercises from BOTH sides:
//   * a full resync (_rbApplyResync) only ever healed the JOINER, so a frozen HOST could never
//     re-anchor its tick forward -> it died every time (deterministic).
//   * resync AUTHORITY was host-only, so a frozen (stale) host would even ship its stale world
//     as authoritative and drag the LIVE joiner backwards.
// The fix is ahead-authoritative and role-agnostic: whoever is CURRENT on the shared clock is
// the authority; whoever is BEHIND (was frozen) catches its tick forward and adopts. This test
// stays in the RECOVERABLE band -- freezes short enough that the live peer never crosses the 4s
// silence deadline -- so the ONLY thing on trial is whether the resync reconciles the tick base.
const { runMatch } = require('./duel-driver');
const lane = require('./lanes');

const WIRE = { base:20, jit:10, loss:0.05, asym:8, spike:{ p:0.03, ms:60 } };
const SEEDS = [0x51E0D000, 0x9E3779B1, 0xDEADBEEF].map(x => x >>> 0);
// at 3.0s (a real multi-input match is under way); freeze 3.0s -- the longest silence still inside
// the recoverable band (peak silence < RB_PERSIST_KILL_MS), so a clean system MUST re-converge.
// The band has one contract, not a per-duration one: the longest freeze in it is the binding case.
const MS = [3000];
const WHO = ['A', 'B'];   // A = the HOST froze (was 30/30 dead), B = the JOINER froze (was fragile)
// PINNED repair-eats-input seeds: with these, the catch-up burst's trailing 'rs' (parked, then
// drained by netTickPre) -- or a later hash/'st' repair -- used to land on exactly the tick the
// pass had just fed an input for. The repair rebuilt the world from the ring (replay reaches only
// simTick; the pending tick's records are not part of any replay), so the just-fed record was
// dropped from the world while staying in BOTH logs: identical logs, silently split worlds, and
// every later repair re-opened the split the same way until the 4s desync deadline ended the
// match. Guarded by netTickPre's order contract: every repair runs BEFORE the tick's log-feed.
const PINNED = [
    { who:'B', ms:2500, seed:0xcb7ca15d >>> 0 },
    { who:'B', ms:2500, seed:0xad9b7bdf >>> 0 },
    { who:'B', ms:3000, seed:0xc6ddbf1e >>> 0 },
];

const cases = [];
for(const who of WHO) for(const ms of MS) for(const seed of SEEDS) cases.push({ who, ms, seed });
cases.push(...PINNED);

const rows = [];
let fails = 0, total = 0, sessionEnds = 0, jumps = 0;
for(const { who, ms, seed } of lane(cases)){
    total++;
    // catchup:true models the fixed-timestep integer-lag close every real duel client runs
    // per tick (sim-worker._step): after the resync re-anchors the frozen side to the sender's
    // ring tick, this closes the final tick-or-two residual toward the shared clock. Without
    // it the frozen side would sit permanently a tick behind (a modelling gap, not a bug).
    const r = runMatch({ seed, secs: 3 + Math.ceil(ms/1000) + 7, wire:WIRE, phase:8, tjit:4,
        recv:true, catchup:true, doze:{ at:3.0, ms, who } });
    // A frozen client MUST snap its own head exactly once when the resync re-anchors its tick
    // forward across the dozed span (the "connection re-established" reconcile the field shows
    // -- rendered final-only, so it is one redraw, not an animated slide). That single snap on
    // the FROZEN side is legitimate; the LIVE side must never see its own head teleport, and
    // neither side may session-end or fail to re-converge.
    const frozeJumps = who === 'A' ? r.localJumpsA : r.localJumpsB;
    const liveJumps  = who === 'A' ? r.localJumpsB : r.localJumpsA;
    const ok = r.converged && r.exitReason == null && liveJumps === 0 && frozeJumps <= 1;
    if(!ok){
        fails++;
        if(r.exitReason === 'session-end') sessionEnds++;
        jumps += r.localJumps;
        const div = r.firstDiverge ? (r.firstDiverge.tick + ':' + (r.firstDiverge.fields||[]).join(',')) : '-';
        rows.push((who === 'A' ? 'HOST' : 'JOINER') + ' froze ' + ms + 'ms seed ' + seed.toString(16)
            + ': conv=' + r.converged + ' exit=' + (r.exitReason || '-')
            + ' frozeJumps=' + frozeJumps + ' liveJumps=' + liveJumps
            + ' desync=' + r.desyncA + '/' + r.desyncB + ' 1stDiv=' + div);
    }
}

console.log('swept ' + total + ' one-sided suspends (host + joiner, recoverable band): '
    + (total - fails) + ' recovered, ' + fails + ' failed'
    + ' (' + sessionEnds + ' session-ends, ' + jumps + ' self-jumps)');
if(rows.length) console.log(rows.join('\n'));

if(fails > 0){
    console.log('\nDUEL-SUSPEND FAIL: a one-sided suspend did not re-converge -- resync failed to reconcile the'
        + ' tick base. ' + fails + '/' + total + ' failed.');
    process.exit(1);
}
console.log('\nDUEL-SUSPEND PASSED');
