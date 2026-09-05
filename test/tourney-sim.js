// TOURNAMENT SIMULATION (ON DEMAND -- not part of any tier). A five-player tournament in
// which every single match is actually PLAYED: two real sims in lockstep, three real
// spectators hanging off the real relay tree, all of it over a wire with latency, jitter,
// packet loss, asymmetry and blackouts. Twelve matches, from the join code to the podium.
//
// WHY THIS EXISTS BESIDE THE OTHER TWO. tourney-e2e.js proves the ORCHESTRATION (sheets,
// results, failure modes) and tourney-full.js walks the LADDER at the player cap; both of
// them fake the matches -- a client is told "you won 5:2" and the bracket moves on. Neither
// ever runs a frame of the game. This one is the other half: the bracket is small enough to
// walk in one sitting, and every node on it is a real duel with a real audience on a wire
// that misbehaves. The question it answers is the one the other two cannot ask -- does a
// tournament survive an evening of bad network, or does it merely survive good bookkeeping?
//
//   node test/tourney-sim.js        (or: bash test/checks.sh --tourney-sim)
//
// THE TWO WORLDS AND THE SEAM BETWEEN THEM. The bracket, the sheets, the breaks and the
// podium come from test/tourney-world.js (the scripted server + five harness clients, the
// shipping client code). The match itself comes from test/spec-driver.js's runSpec: two
// players plus watchers, real sims, modelled wire. They meet at exactly one point -- the
// verdict. The sim plays the match out and says who won; that verdict is handed to the two
// world clients through the same endMatch() path the sim uses in the browser, and the world
// settles the node on it. Nothing else crosses.
//
// Two deliberate limits, so nobody reads more into a green run than is there:
//   - The sim always opens on LEVEL 1. The ladder's per-round level is asserted on the
//     session both players mint (as everywhere else), but tourney-full.js is what proves
//     the level ladder end to end; playing round 3 at level 3 would only re-prove it slower.
//   - The two sides are autopilots, so most matches are decided on score rather than on a
//     death. A knockout node cannot take a draw -- the server has no winner to walk up the
//     bracket -- so a drawn knockout is REPLAYED on a fresh seed, which is what the real
//     server does with one too.
const { mkWorld, MAX_DIRECT, BREAK_MS, TT_OVER_MS, TT_STATE_MS } = require('./tourney-world');
const { runSpec } = require('./spec-driver');

const IDS   = ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004', 'aaaa0005'];
// clnt-CI-<the four hex that tell these ids apart>: the shape the live probes register
// under, so a name in the log traces back to the id that wore it. Here that is the tail
// (the live ids differ in their head instead).
const NAMES = IDS.map(id => 'clnt-CI-' + id.slice(-4));
const N = IDS.length;              // five: 2N round-robin matches, then a 3-strong knockout
const TAIL = 2500;                 // ms of CALM wire after each match, so "healed" is provable
const SEED0 = 0x7A1E, SEEDSTEP = 0x9E37;

// THE EVENING'S NETWORK, one profile per match. The blackout walks around the tree on
// purpose: the host, the guest, each primary, the secondary, and once the whole room at the
// same time. `who` is a role in the MATCH, not a person -- 'A' is the feeder/host of that
// node, 'S1'/'S2' are its two primaries and 'S3' the secondary that hangs off them.
const NET = [
    { tag:'clean lan',      secs:10, wire:{ base:12, jit:4,  loss:0,    asym:0 }, out:[] },
    { tag:'home wifi',      secs:10, wire:{ base:20, jit:8,  loss:0.02, asym:4 }, out:[] },
    { tag:'lossy wifi',     secs:11, wire:{ base:20, jit:8,  loss:0.05, asym:6 }, out:[] },
    { tag:'guest dark',     secs:11, wire:{ base:20, jit:8,  loss:0.02, asym:6 }, out:[{ at:5.0, ms:900,  who:'B'  }] },
    { tag:'host dark',      secs:11, wire:{ base:20, jit:8,  loss:0.02, asym:6 }, out:[{ at:5.5, ms:900,  who:'A'  }] },
    { tag:'primary dark',   secs:11, wire:{ base:24, jit:10, loss:0.03, asym:6 }, out:[{ at:4.5, ms:1200, who:'S1' }] },
    { tag:'other primary',  secs:11, wire:{ base:24, jit:10, loss:0.03, asym:6 }, out:[{ at:4.5, ms:1200, who:'S2' }] },
    { tag:'secondary dark', secs:11, wire:{ base:24, jit:10, loss:0.03, asym:6 }, out:[{ at:4.5, ms:1500, who:'S3' }] },
    { tag:'mobile',         secs:11, wire:{ base:35, jit:14, loss:0.03, asym:8 }, out:[] },
    { tag:'two gaps',       secs:12, wire:{ base:20, jit:8,  loss:0.02, asym:6 }, out:[{ at:3.5, ms:800,  who:'S1' },
                                                                                       { at:7.0, ms:900,  who:'B'  }] },
    { tag:'everyone dark',  secs:12, wire:{ base:20, jit:8,  loss:0.02, asym:6 }, out:[{ at:6.0, ms:1000, who:'*'  }] },
    { tag:'the long final', secs:12, wire:{ base:28, jit:12, loss:0.03, asym:8 }, out:[{ at:4.0, ms:900,  who:'A'  },
                                                                                       { at:8.0, ms:900,  who:'S2' }] },
];

const rows = [];
let fails = 0;
const A = (c, m) => { if(!c){ rows.push('FAIL: ' + m); fails++; } };

const { srv, C, idx, clock, pump, settleAsync, clearAll } = mkWorld(IDS, NAMES, {});
const nodesOf = (r) => srv.T.order.filter(x => srv.T.nodes[x].round === r);

// HEALED, not merely quiet. divN counts settled ticks where a spectator's world disagreed
// with the players'; divClean is the last tick at which it agreed again. Zero disagreement
// is a heal, and so is disagreement that stopped -- but silence after the last comparison
// is not, which is what the calm tail after every match exists to rule out.
const healed = (s) => s.divN === 0 || (s.divClean != null && s.divClean > s.divTo);
// The sim's own verdict, in players[] order. Autopilots rarely kill each other inside the
// clock, so most matches are decided on score, exactly as a timed-out duel is.
const verdict = (r) => {
    if(r.winner === 0 || r.winner === 1) return r.winner;
    const sc = r.score || [0, 0];
    return sc[0] === sc[1] ? 2 : (sc[0] > sc[1] ? 0 : 1);
};

// ---- 1) five players in a room -------------------------------------------
async function lobby(){
    for(const c of C){ c.setPhase('tourneyLobby'); c.enter(); }
    await settleAsync();
    await C[0].create(false);
    await settleAsync();
    for(let i = 1; i < N; i++){ await C[i].join('K7MZ4Q'); await settleAsync(); }
    await pump(1);
    for(let i = 0; i < N; i++)
        A((C[i].tt() || {}).players.length === N,
          '1: ' + NAMES[i] + ' sees ' + ((C[i].tt() || {}).players || []).length + ' of ' + N + ' players');
    await C[0].start();
    clearAll();
    await pump(2);
    A(nodesOf(1).length === 2 * N, '1: ' + nodesOf(1).length + ' round-robin matches for ' + N + ' players');
    rows.push('1 lobby: ' + N + ' players, ' + nodesOf(1).length + ' round-robin matches, '
              + 'then a knockout on the top ' + Math.max(2, Math.ceil(N / 2)));
}

// ---- 2) one match, played --------------------------------------------------
// Everything here is per-node and asserted on all twelve, not on a sample: the tree the
// sheet dealt, the links the watchers actually opened, the match as it was played over the
// evening's wire, and the verdict landing back on the bracket unchanged.
function playMatch(p, sh, seed){
    // The watchers are wired the way the sheet says: the primaries take their feed from the
    // feeder, the secondary dual-connects to both primaries and picks one.
    const watchers = sh.primaries.map(() => ({ at:0.5, from:'A' }))
        .concat(sh.secondaries.map(() => ({ at:1.5, from:['S1', 'S2'] })));
    return runSpec({ secs:p.secs, seed, wire:p.wire,
                     specWire:{ base:p.wire.base + 8, jit:p.wire.jit + 4 },
                     watchers, outage:p.out, settleTail:TAIL });
}

async function playNode(seen){
    const nid = srv.T.cursor, nd = srv.T.nodes[nid];
    const [pa, pb] = nd.players, ia = idx(pa), ib = idx(pb);
    const p = NET[seen.nodes % NET.length];
    await pump(1);

    const sh = (C[ia].tt() || {}).roles;
    A(!!sh && sh.nid === nid, nid + ': the host holds sheet ' + (sh ? sh.nid : 'none'));
    if(!sh) return;
    // The feeder is the first player on the node and therefore the offer host. Every hop
    // below depends on it, which is why it is re-asserted on every node rather than once.
    A(sh.feeder === pa, nid + ': the feeder is ' + sh.feeder + ', the node opens with ' + pa);
    const wantP = Math.min(MAX_DIRECT, N - 2);
    A(sh.primaries.length === wantP && sh.secondaries.length === N - 2 - wantP,
      nid + ': the tree is ' + sh.primaries.length + '+' + sh.secondaries.length
      + ' for ' + (N - 2) + ' watchers');

    // -- the two sides mint the match the sheet describes --
    for(const [who, s] of [[NAMES[ia], C[ia].sess(pb, 'host')], [NAMES[ib], C[ib].sess(pa, 'guest')]]){
        A(s.hearts === nd.hm && s.heartsWant === nd.hm,
          nid + ': ' + who + ' opened at ' + s.hearts + ' hearts, sheet says ' + nd.hm);
        A(s.lvl0 === nd.lvl && s.levelWant === nd.lvl,
          nid + ': ' + who + ' opens on level ' + s.lvl0 + ', sheet says ' + nd.lvl);
        A(s.stakes === srv.T.stakes && s.p2pOnly === true,
          nid + ': ' + who + ' minted a tournament session with the wrong terms');
    }
    // -- the watchers connected where the tree told them to --
    for(let i = 0; i < N; i++){
        if(i === ia || i === ib) continue;
        const w = C[i].rec().watches.map(x => x.peer);
        const mine = sh.primaries.indexOf(IDS[i]) >= 0 ? [pa] : sh.primaries.slice(0, MAX_DIRECT);
        A(JSON.stringify(w) === JSON.stringify(mine),
          nid + ': ' + NAMES[i] + ' watched ' + JSON.stringify(w) + ', the tree says ' + JSON.stringify(mine));
        A(C[i].rec().watches.every(x => x.tid === srv.T.tid && x.nid === nid),
          nid + ': ' + NAMES[i] + ' asked for a feed without naming the node');
    }
    C[ia].inGame(true); C[ib].inGame(true);

    // -- the match itself --
    // A knockout draw has nowhere to go: settle() walks a WINNER up the bracket, so a node
    // with none would leave the round above holding an empty slot forever. Replay it.
    let r = null, win = 2, tries = 0;
    while(tries < 3){
        r = playMatch(p, sh, ((SEED0 + seen.nodes * SEEDSTEP) ^ (0x5A5A * tries)) >>> 0);
        win = verdict(r);
        tries++;
        if(win !== 2 || nd.round === 1) break;
    }
    seen.replays += tries - 1;

    const gap = p.out.map(o => o.who).join('+') || 'none';
    A(!r.exitReason || r.exitReason === 'duelOver',
      nid + ' [' + p.tag + ']: the match ended as "' + r.exitReason + '" at ' + r.diedAt + 's');
    A(r.warnA === null && r.warnB === null,
      nid + ' [' + p.tag + ']: the players settled still showing "' + r.warnA + '"/"' + r.warnB + '"');
    // The players get the same predicate as the audience. Two sides running on prediction
    // through a dark wire WILL disagree while it is dark -- that is what rollback is for --
    // so what is asserted is the repair: they agreed again after the last disagreement.
    A(healed(r.pairDiv), nid + ' [' + p.tag + ']: the two players never came back together -- '
      + 'apart from tick ' + r.pairDiv.divFrom + ' to ' + r.pairDiv.divTo
      + ', last agreement ' + r.pairDiv.divClean);
    // A blackout that never landed is a profile that tested nothing.
    A(r.outages.every(o => o.hits > 0),
      nid + ' [' + p.tag + ']: a blackout on ' + gap + ' never actually darkened the wire');
    A(win !== 2 || nd.round === 1, nid + ': a knockout node was still a draw after ' + tries + ' tries');

    // -- the audience --
    for(const n of Object.keys(r.spectators)){
        const s = r.spectators[n];
        const hops = sh.primaries.length >= MAX_DIRECT && n === 'S3' ? 2 : 1;
        A(s.on, nid + ' [' + p.tag + ']: ' + n + ' was not watching at the end');
        A(s.hops === hops, nid + ' [' + p.tag + ']: ' + n + ' sat ' + s.hops + ' hops out, the tree says ' + hops);
        A(healed(s), nid + ' [' + p.tag + ']: ' + n + ' never caught up -- wrong from tick '
          + s.divFrom + ' to ' + s.divTo + ', last agreement ' + s.divClean);
        // THE IRON RULE, on every node of the tournament: a spectator subscribes and does
        // nothing else. It authors no input and puts nothing on the duel wire.
        A(s.authored === 0, nid + ' [' + p.tag + ']: ' + n + ' authored ' + s.authored + ' inputs');
        A(s.duelOut === 0, nid + ' [' + p.tag + ']: ' + n + ' put ' + s.duelOut + ' packets on the duel wire');
        A(s.upTypes.every(t => t === 'ssub'),
          nid + ' [' + p.tag + ']: ' + n + ' sent ' + JSON.stringify(s.upTypes) + ' upstream');
        seen.lag = Math.max(seen.lag, s.lagMax | 0);
    }

    // -- the verdict goes back to the bracket --
    const before = srv.log.filter(x => x.action === 'result' && x.nid === nid).length;
    C[ia].endMatch('host', pb, win, r.score || [0, 0]);
    C[ib].endMatch('guest', pa, win, r.score || [0, 0]);
    await settleAsync();
    const posts = srv.log.filter(x => x.action === 'result' && x.nid === nid);
    A(posts.length - before === 2, nid + ': ' + (posts.length - before) + ' result posts, expected 2');
    A(posts.every(x => x.id === pa || x.id === pb), nid + ': a result was accepted from a spectator');
    const done = srv.T.nodes[nid];
    A(done.state === 'done', nid + ': settled as ' + done.state);
    A(JSON.stringify(done.score) === JSON.stringify(r.score || [0, 0]),
      nid + ': the bracket recorded ' + JSON.stringify(done.score) + ' for a ' + JSON.stringify(r.score) + ' match');
    A(win === 2 ? done.draw : done.winner === nd.players[win],
      nid + ': the bracket made ' + done.winner + ' the winner of a match ' + NAMES[idx(nd.players[win])] + ' won');

    seen.nodes++;
    seen.tags.push(p.tag);
    seen.gaps += p.out.length;
    rows.push('  ' + nid.padEnd(7) + NAMES[ia] + ' v ' + NAMES[ib] + '  ' + p.tag.padEnd(15)
              + 'base ' + p.wire.base + 'ms jit ' + p.wire.jit + ' loss ' + Math.round(p.wire.loss * 100)
              + '% dark ' + gap.padEnd(5) + ' -> ' + JSON.stringify(r.score)
              + (r.pairDiv.divN ? '  (players apart for ' + (r.pairDiv.divTo - r.pairDiv.divFrom)
                                  + ' ticks, back together by ' + r.pairDiv.divClean + ')' : '')
              + (tries > 1 ? '  (replayed ' + (tries - 1) + 'x on a draw)' : ''));
    clearAll();
    clock(TT_OVER_MS + 1000);
    await pump(2);
}

// ---- 3) the break between rounds ------------------------------------------
// The evening's OTHER outage, and a different animal: not a lost packet but a client whose
// signal stream is dead for a whole break. It has to come back off the state read-back
// alone, because nothing will ever re-send it the sheet it slept through.
async function passBreak(seen){
    const b0 = C[0].brk();
    const hi = idx(srv.T.host), deaf = (hi + 2) % N;
    A(!!b0 && b0.rows.length === N, 'break: the board holds ' + (b0 ? b0.rows.length : 0) + ' rows for ' + N);
    for(let i = 0; i < N; i++){
        A(C[i].phase() === 'tourneyRound', 'break: ' + NAMES[i] + ' sat on ' + C[i].phase());
        C[i].draw();
    }
    srv.mute(IDS[deaf], true);
    clock(BREAK_MS + 100);
    await C[hi].pick('CONTINUE');
    await settleAsync();
    await pump(1);
    A(srv.T.brk === null, 'break: the board is still up after the host cleared it');
    A(C[deaf].brk() !== null, 'break: the deaf client saw a signal it should never have received');
    clock(TT_STATE_MS + 1000);
    await pump(1);
    A(C[deaf].brk() === null, 'break: the deaf client is still holding a cleared board');
    A(C[deaf].tt().cursor === srv.T.cursor, 'break: the deaf client never picked the next match up');
    srv.mute(IDS[deaf], false);
    seen.breaks.push(b0.done);
    rows.push('3 break ' + b0.done + '->' + b0.next + ': ' + b0.of + ' of ' + N + ' through at level '
              + b0.lvl + '/' + b0.hm + ' hearts; ' + NAMES[deaf]
              + ' slept through it with a dead signal stream and rejoined off the state read-back');
}

// ---- 4) the evening ------------------------------------------------------
async function evening(){
    const seen = { nodes:0, replays:0, gaps:0, lag:0, tags:[], breaks:[] };
    let guard = 0;
    while(srv.T.state === 'running' && guard++ < 40){
        if(srv.T.brk){ await passBreak(seen); continue; }
        if(!srv.T.cursor) break;
        await playNode(seen);
    }
    A(guard < 40, '4: the tournament never reached the podium');
    A(seen.nodes === srv.T.order.length,
      '4: ' + seen.nodes + ' matches played of ' + srv.T.order.length + ' in the bracket');
    A(srv.T.order.every(x => srv.T.nodes[x].state === 'done'),
      '4: the tournament ended with a node still unplayed');
    A(seen.breaks.length === 2, '4: ' + seen.breaks.length + ' round breaks, expected 2');
    rows.push('4 evening: ' + seen.nodes + ' matches played for real over ' + seen.gaps
              + ' blackouts, worst spectator lag ' + seen.lag + ' ticks, '
              + seen.replays + ' knockout draw(s) replayed');
    return seen;
}

// ---- 5) the podium --------------------------------------------------------
async function podium(){
    await pump(2);
    for(let i = 0; i < N; i++){
        const t = C[i].tt();
        A(t && t.state === 'done' && JSON.stringify(t.podium) === JSON.stringify(srv.T.podium),
          '5: ' + NAMES[i] + ' holds podium ' + JSON.stringify(t && t.podium));
        A(C[i].phase() === 'tourneyPodium', '5: ' + NAMES[i] + ' ended on ' + C[i].phase());
        C[i].draw();
    }
    const p = srv.T.podium;
    A(p[0] && p[1] && p[2] && p[0] !== p[1] && p[1] !== p[2], '5: the podium is ' + JSON.stringify(p));
    rows.push('5 podium: ' + p.map(id => NAMES[idx(id)]).join(' > ')
              + ', held identically by all ' + N + ' clients');
}

(async () => {
    const t0 = Date.now();
    await lobby();
    await evening();
    await podium();
    for(const r of rows) console.log(r);
    console.log('\n' + Math.round((Date.now() - t0) / 1000) + 's wall');
    if(fails){ console.log('TOURNEY-SIM FAILED (' + fails + ')'); process.exit(1); }
    console.log('TOURNEY-SIM PASSED');
})().catch(e => { console.log('TOURNEY-SIM CRASHED: ' + (e && e.stack || e)); process.exit(1); });
