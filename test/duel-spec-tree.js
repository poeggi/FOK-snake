// THE RELAY TREE (HEAVY suite). duel-spec.js proves a spectator's world is the players'
// world. This one proves the SHAPE that lets more than a handful of people watch at once,
// and that the shape survives the nodes in it dying.
//
// THE TREE. A phone cannot serve eight DataChannels mid-match, so a feeder serves
// SPEC_MAX_DIRECT and redirects the rest to the nodes it is already serving. Those become
// primaries; the redirected ones hang off them at hops 2 and pace themselves at exactly the
// SAME offset -- relaying is cut-through, so a hop costs a wire crossing, not playback delay,
// and a tier must not decide which frame you are looking at. Nobody designs the tree: it falls
// out of that one refusal rule.
//
// THE THREE FAILURES IT HAS TO SURVIVE, none of which may cost a single wrong tick:
//   A) Nothing. The steady state: a secondary dual-connected to both primaries, feeding
//      from one, holding the other open and SILENT -- so a failover costs one flag rather
//      than a connect -- and never once touching the players.
//   B) The primary it feeds from dies. Local recovery, no server, no generation change:
//      the standby is promoted on the close, not on a timeout.
//   C) BOTH primaries die at the same instant, with a late joiner among the orphans. Every
//      relay in the tree is gone, so the survivors go back to the source -- and the
//      players, whose fan-out was full a moment ago, now have room by exactly the same
//      arithmetic that displaced them.
// Run: node test/duel-spec-tree.js
const { runSpec } = require('./spec-driver');
const lane = require('./lanes');

const WIRE = { base:20, jit:8, loss:0.05, asym:6 };
const rows = [];
let fails = 0;
const A = (c, m) => { if(!c){ rows.push('FAIL: ' + m); fails++; } };

// Bytes that crossed a spectator channel from one named client to another. The pair map is
// how "served entirely by a primary" stops being a story about roles and becomes a number.
const bytes = (r, from, to) => r.pairB[from + '>' + to] | 0;

function alive(tag, r, name, hops){
    const s = r.spectators[name];
    A(!!s, tag + ': ' + name + ' missing from the report');
    if(!s) return null;
    A(s.on, tag + ' ' + name + ': stopped watching before the end');
    A(s.divN === 0, tag + ' ' + name + ': ' + s.divN + ' settled ticks disagreed with the players ('
                    + s.divFrom + '..' + s.divTo + ')');
    A(s.authored === 0, tag + ' ' + name + ': authored ' + s.authored + ' input records');
    A(s.duelOut === 0, tag + ' ' + name + ': sent ' + s.duelOut + ' duel packets toward the players');
    A(s.dbg.over === 0, tag + ' ' + name + ': ' + s.dbg.over + ' envelopes exceeded SPEC_PKT_MAX');
    A(s.cmp > 20, tag + ' ' + name + ': only ' + s.cmp + ' hash comparisons -- it never really ran');
    if(hops != null) A(s.hops === hops, tag + ' ' + name + ': hops ' + s.hops + ' (want ' + hops + ')');
    return s;
}

// ---- A) the steady-state tree, and the warm standby that makes it survivable ----------
if(lane.step()){
    const r = runSpec({ secs:14, seed:0x77C3, wire:WIRE,
                        watchers:[{ at:1.2, from:'A' }, { at:1.6, from:'A' }, { at:3.2, from:'A' }] });
    A(!r.exitReason, 'A: the match ended early (' + r.exitReason + ' @' + r.diedAt + 's)');
    const s1 = alive('A', r, 'S1', 1), s2 = alive('A', r, 'S2', 1);
    const s3 = alive('A', r, 'S3', 2);
    A(r.players.A.outN === 2, 'A: the feeder serves ' + r.players.A.outN + ' links (SPEC_MAX_DIRECT is 2)');
    if(s3){
        A(s3.inN === 2, 'A: the secondary holds ' + s3.inN + ' feed links (want both primaries)');
        A(s3.subN === 1, 'A: ' + s3.subN + ' of them are subscribed -- a standby that talks is not a standby');
    }
    // UNIFORMITY, the property the whole tier arrangement is allowed to exist under: nobody in
    // the room is watching a different moment of the same match. The offset is flat, so this is
    // not a tendency to check at the end -- it is true at every sample or it is not true.
    if(s1 && s2 && s3){
        A(s1.bias === s3.bias && s2.bias === s3.bias,
          'A: offsets ' + [s1.bias, s2.bias, s3.bias].join('/') + 'ms -- a tier changed the pacing');
        A(r.lagSpread <= 3, 'A: two watchers sat ' + r.lagSpread
                            + ' ticks apart at one instant -- they are seeing different frames');
    }
    A(bytes(r, 'A', 'S3') === 0 && bytes(r, 'S3', 'A') === 0,
      'A: the feeder and the secondary exchanged ' + (bytes(r, 'A', 'S3') + bytes(r, 'S3', 'A'))
      + ' bytes -- the whole point of the tier is that they never meet');
    const standby = Math.min(bytes(r, 'S1', 'S3'), bytes(r, 'S2', 'S3'));
    const feed = Math.max(bytes(r, 'S1', 'S3'), bytes(r, 'S2', 'S3'));
    A(standby * 6 < feed, 'A: the standby sent ' + standby + 'B against the feed\'s ' + feed
                          + 'B -- it is a second stream, not a standby');
    rows.push('A tree: feeder serves 2, all three watchers pace at ' + (s3 ? s3.bias : '?')
              + 'ms, never more than ' + r.lagSpread + ' tick(s) apart (rb '
              + [s1, s2, s3].map(s => s ? s.rb : '?').join('/') + '), the secondary holds a '
              + standby + 'B warm standby (feed ' + feed + 'B), ' + r.checks + ' hash checks');
}

// ---- B) the primary a secondary feeds from dies ---------------------------------------
if(lane.step()){
    const r = runSpec({ secs:14, seed:0x77C3, wire:WIRE,
                        watchers:[{ at:1.2, from:'A' }, { at:1.6, from:'A' }, { at:3.2, from:'A' }],
                        kill:[{ at:7.0, who:'@feed:S3' }] });
    A(!r.exitReason, 'B: the match ended early (' + r.exitReason + ' @' + r.diedAt + 's)');
    const dead = r.killed[0];
    A(dead === 'S1' || dead === 'S2', 'B: killed "' + dead + '", which is not the secondary\'s feeder');
    const s3 = alive('B', r, 'S3', 2);
    if(s3){
        A(s3.gen === 0, 'B: generation moved to ' + s3.gen
                        + ' -- promoting a standby changes our source, not the stream\'s owner');
        A(s3.inN === 1 && s3.subN === 1, 'B: after the failover it holds ' + s3.inN + ' link(s), '
                                          + s3.subN + ' subscribed (want 1/1)');
    }
    A(bytes(r, 'A', 'S3') === 0, 'B: the failover fell back on the feeder (' + bytes(r, 'A', 'S3')
                                 + 'B) instead of the surviving primary');
    rows.push('B primary death: ' + dead + ' died at 7s, the standby was promoted on the close, '
              + r.checks + ' checks, no settled tick wrong');
}

// ---- C) a late joiner, then the whole middle tier dies at once ------------------------
if(lane.step()){
    const r = runSpec({ secs:17, seed:0x77C3, wire:WIRE,
                        watchers:[{ at:1.2, from:'A' }, { at:1.6, from:'A' },
                                  { at:3.2, from:'A' }, { at:8.0, from:'A' }],
                        kill:[{ at:11.0, who:'S1' }, { at:11.0, who:'S2' }] });
    A(!r.exitReason, 'C: the match ended early (' + r.exitReason + ' @' + r.diedAt + 's)');
    // The late joiner arrives mid-match to a full feeder and is served entirely by the tier
    // below it -- context, fresh checkpoint and tail all minted by a primary. The feeder's
    // only involvement is the refusal, which travels over signalling, not the feed.
    const s4 = alive('C', r, 'S4', 2);
    const fromPlayers = bytes(r, 'A', 'S4') + bytes(r, 'B', 'S4');
    A(fromPlayers > 0, 'C: the late joiner never reached a player even after the tier died');
    const s3 = alive('C', r, 'S3', 2);
    for(const pair of [['S3', s3], ['S4', s4]]){
        const n = pair[0], s = pair[1];
        if(!s) continue;
        A(s.subN === 1, 'C ' + n + ': ' + s.subN + ' subscribed feeds after the recovery (want 1)');
        A(s.dbg.boot === 1, 'C ' + n + ': booted ' + s.dbg.boot + ' times -- a re-source is not a re-boot');
    }
    rows.push('C tier wipeout: both primaries died at 11s, the two orphans re-sourced from the '
              + 'players (' + fromPlayers + 'B) without a re-boot, ' + r.checks + ' checks, '
              + 'no settled tick wrong');
}

// ---- D) the tournament drain: every node asks at the same moment ----------------------
// A roles sheet reaches players, primaries and secondaries in ONE signal drain, so a
// secondary asks its primary while that primary is itself still several seconds of
// offer/answer/ICE/go/boot away from having a timeline. The primary cannot serve yet and
// PARKS the ask -- and a parked ask is only worth holding if something releases it. It is
// released by the same rule that answers a live one, or the secondary watches nothing until
// its own re-ask ladder happens to come round again, and nothing at all if that ladder runs
// out first: exactly one spectator left on the bracket screen while the other watches fine.
if(lane.step()){
    const on = {};
    const START = 2.2;
    const r = runSpec({ secs:16, seed:0x2C0D, wire:WIRE, playersAt:START,
                        watchers:[{ at:0.2, from:'A' }, { at:0.2, from:'A' }, { at:0.2, from:'S1' }],
                        onSample:(now, c)=>{ for(const n of ['S1', 'S2', 'S3'])
                                                 if(on[n] == null && c[n].c.__specOn()) on[n] = now; } });
    A(!r.exitReason, 'D: the match ended early (' + r.exitReason + ' @' + r.diedAt + 's)');
    alive('D', r, 'S1', 1); alive('D', r, 'S2', 1);
    const s3 = alive('D', r, 'S3', 2);
    A(on.S3 != null, 'D: the secondary asked a primary that was not ready and never got a feed at all');
    // The park is the whole mechanism here: held while there is nothing to serve, gone the
    // moment there is. One still sitting on a primary at the end of the match was never
    // answered -- and it holds fan-out room the next watcher will be refused for.
    for(const n of ['S1', 'S2'])
        if(r.spectators[n]) A(r.spectators[n].askN === 0,
                              'D: ' + n + ' still holds ' + r.spectators[n].askN + ' parked ask(s)');
    // Promptly, too: its primary's boot plus one handshake, with no re-ask cycle in between.
    if(on.S1 != null && on.S3 != null)
        A(on.S3 - on.S1 < 1400, 'D: the secondary started ' + (on.S3 - on.S1)
                                + 'ms after its primary -- it waited out its own re-ask');
    rows.push('D one drain: all three ask at once, the secondary is fed ' + (on.S3 - on.S1)
              + 'ms after the primary it hangs off, and no ask is left parked anywhere');
}

console.log(rows.join('\n'));
if(fails){ console.log('\nDUEL-SPEC-TREE FAIL: ' + fails + ' assertion(s)'); process.exit(1); }
console.log('\nDUEL-SPEC-TREE PASSED');
