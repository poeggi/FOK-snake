// SPECTATING (HEAVY suite). A spectator is not a video feed and not a second netcode: it is
// the SAME sim the two players run, with input authoring switched off, driven by their own
// wire packets forwarded verbatim. This suite is the proof of that claim -- and of the one
// design idea the whole tree rests on.
//
// THE IDEA. A spectator biases its sim ORIGIN by SPEC_DELAY_MS per hop and delays its BOOT by
// the same amount, so it runs ~24 ticks under the feeder. Every forwarded input for tick X
// therefore arrives while X is still in its FUTURE: the log takes it and the tick loop applies
// it on time. No rollback on a healthy feed, which is what makes relaying affordable at all.
// The boot has to be late as well as biased because the tick loop steers FORWARD ONLY (game.js:
// "the shared clock STEERS this, it does not gate it") -- a spectator that started on time
// could never fall back to its target.
//
// What each section pins down:
//   A) A watcher stays byte-identical to the players' world across level boundaries, at every
//      settled tick, for a whole match -- while authoring NOTHING and sending them NOTHING.
//   B) A late joiner gets [context, fresh checkpoint, tail] and converges the same way, which
//      is the property a mid-match spectator and every relayed node depend on.
//   C) The fan-out cap is what keeps a phone from serving eight channels mid-match. A refused
//      watcher is REDIRECTED to a node already being served, and the two-tier tree falls out
//      of that rule by itself: hops 2, double bias, same byte-identical world.
//   D) The feeder's relay duty dying is not the match dying. Under lockstep the OTHER player
//      holds both input streams, so the primaries pull it in as the BACKUP FEEDER under a
//      bumped generation and the feed resumes -- still with zero divergence.
// Run: node test/duel-spec.js
const { runSpec } = require('./spec-driver');
const lane = require('./lanes');

const WIRE = { base:20, jit:8, loss:0.05, asym:6 };
const rows = [];
let fails = 0;
const A = (c, m) => { if(!c){ rows.push('FAIL: ' + m); fails++; } };

// Every spectator, in every section, must satisfy these -- they are the iron rule and the
// convergence claim, not section-specific detail.
function common(tag, r, name){
    const s = r.spectators[name];
    A(!!s, tag + ': ' + name + ' missing from the report');
    if(!s) return null;
    A(s.on, tag + ' ' + name + ': not spectating at the end of the run');
    A(s.dbg.boot === 1, tag + ' ' + name + ': booted ' + s.dbg.boot + ' times (want exactly 1)');
    A(s.authored === 0, tag + ' ' + name + ': authored ' + s.authored + ' input records -- a spectator owns no snake');
    A(s.duelOut === 0, tag + ' ' + name + ': sent ' + s.duelOut + ' duel packets toward the players -- a spectator is invisible');
    A(s.cmp > 20, tag + ' ' + name + ': only ' + s.cmp + ' hash comparisons -- it never really ran');
    A(s.dbg.over === 0, tag + ' ' + name + ': ' + s.dbg.over + ' envelopes exceeded SPEC_PKT_MAX');
    // Not "first mismatch" but EVERY mismatch: a spectator that goes wrong for a stretch and
    // is then repaired by the next checkpoint would pass a first-diverge check the moment the
    // repair lands. The claim is the stronger one -- no settled tick ever disagreed at all.
    A(s.divN === 0, tag + ' ' + name + ': ' + s.divN + ' settled ticks disagreed with the players ('
                    + s.divFrom + '..' + s.divTo + ')');
    A(s.warn === 'SPECTATING', tag + ' ' + name + ': banner is ' + JSON.stringify(s.warn));
    return s;
}
function noDiverge(tag, r){
    if(!r.firstDiverge) return;
    A(false, tag + ': ' + r.firstDiverge.who + ' diverged at tick ' + r.firstDiverge.tick
             + ' [' + r.firstDiverge.fields.join(',') + ']');
}

// ---- A) a clean watch, across level boundaries --------------------------------------
if(lane.step()){
    const r = runSpec({ secs:20, seed:0x77C0, wire:WIRE, watchers:[{ at:1.2, from:'A' }] });
    const s = common('A', r, 'S1');
    noDiverge('A', r);
    A(!r.exitReason, 'A: the match ended early (' + r.exitReason + ' @' + r.diedAt + 's)');
    A(r.levelUps >= 1, 'A: no level boundary was crossed -- the run proves nothing about them');
    if(s){
        A(s.role === 'primary' && s.hops === 1, 'A: role/hops = ' + s.role + '/' + s.hops + ' (want primary/1)');
        A(s.bias === 400, 'A: bias ' + s.bias + 'ms (want one hop)');
        A(s.dbg.gen === 0, 'A: generation moved to ' + s.dbg.gen + ' on a healthy feed');
        A(s.lag > 12 && s.lag < 45, 'A: settled ' + s.lag + ' ticks behind (want ~24 -- the bias)');
    }
    rows.push('A clean watch: ' + r.checks + ' hash checks, ' + r.levelUps + ' level-ups, lag '
              + (s ? s.lag : '?') + 't, rx ' + (s ? s.dbg.rx : '?') + ', authored ' + (s ? s.authored : '?'));
}

// ---- B) a LATE joiner: context + fresh checkpoint + tail ------------------------------
if(lane.step()){
    const r = runSpec({ secs:18, seed:0x2B71, wire:WIRE,
                        watchers:[{ at:1.2, from:'A' }, { at:11.0, from:'A' }] });
    common('B', r, 'S1');
    const s2 = common('B', r, 'S2');
    noDiverge('B', r);
    A(!r.exitReason, 'B: the match ended early (' + r.exitReason + ' @' + r.diedAt + 's)');
    if(s2) A(s2.hops === 1, 'B: the late joiner sits at hops ' + s2.hops + ' (the feeder had room)');
    rows.push('B late join @11s: ' + (s2 ? s2.cmp : '?') + ' checks after joining, lag '
              + (s2 ? s2.lag : '?') + 't -- the checkpoint landed it within one bias');
}

// ---- C) the fan-out cap, the redirect, and the two-tier tree it produces ---------------
if(lane.step()){
    const r = runSpec({ secs:16, seed:0x77C3, wire:WIRE,
                        watchers:[{ at:1.2, from:'A' }, { at:1.6, from:'A' }, { at:3.2, from:'A' }] });
    common('C', r, 'S1'); common('C', r, 'S2');
    const s3 = common('C', r, 'S3');
    noDiverge('C', r);
    A(!r.exitReason, 'C: the match ended early (' + r.exitReason + ' @' + r.diedAt + 's)');
    A(r.players.A.outN === 2, 'C: the feeder is serving ' + r.players.A.outN + ' links (SPEC_MAX_DIRECT is 2)');
    if(s3){
        A(s3.hops === 2 && s3.role === 'secondary',
          'C: the redirected watcher is ' + s3.role + ' at hops ' + s3.hops + ' (want secondary/2)');
        A(s3.bias === 800, 'C: a two-hop node runs at ' + s3.bias + 'ms bias (want twice one hop)');
    }
    rows.push('C fan-out cap: feeder serves ' + r.players.A.outN + ', the third watcher relays at hops '
              + (s3 ? s3.hops : '?') + '/' + (s3 ? s3.bias : '?') + 'ms, ' + r.checks + ' checks, no divergence');
}

// ---- D) the feeder's relay duty dies: the other player takes over ----------------------
if(lane.step()){
    const r = runSpec({ secs:18, seed:0x51ED, wire:WIRE,
                        watchers:[{ at:1.2, from:'A' }, { at:1.6, from:'A' }],
                        kill:[{ at:7.0, who:'A' }] });
    const s1 = common('D', r, 'S1');
    const s2 = common('D', r, 'S2');
    noDiverge('D', r);
    A(!r.exitReason, 'D: the match ended early (' + r.exitReason + ' @' + r.diedAt + 's)');
    A(r.players.B.role === 'feeder', 'D: player B is "' + r.players.B.role + '", not the backup feeder');
    A(r.players.B.outN >= 1, 'D: the backup feeder serves ' + r.players.B.outN + ' links');
    for(const pair of [['S1', s1], ['S2', s2]]){
        const n = pair[0], s = pair[1];
        if(!s) continue;
        A(s.gen >= 1, 'D ' + n + ': generation is ' + s.gen + ' -- it never switched feeder');
        A(s.hops === 1, 'D ' + n + ': hops ' + s.hops + ' after the switch (want 1)');
    }
    rows.push('D backup feeder: B took over at generation ' + (s1 ? s1.gen : '?') + ', serving '
              + r.players.B.outN + ', ' + r.checks + ' checks, no divergence');
}

console.log(rows.join('\n'));
if(fails){ console.log('\nDUEL-SPEC FAIL: ' + fails + ' assertion(s)'); process.exit(1); }
console.log('\nDUEL-SPEC PASSED');
