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
// WHAT AN EVENING CONTAINS. Every node is played on the parameters its own sheet deals --
// the round's level, the round's hearts, item stakes on -- and under one of three pilots,
// because a tournament that only ever plays one kind of match proves only that one kind of
// match survives. `auto` chases gems, which is what produces score, ten-gem progressions
// and real level boundaries mid-match. `joust` flies near-miss passes, which is the only
// thing that rolls the windswept steal dice: gear blown loose, flown, and picked up by the
// other snake. `kill` crashes on purpose, which is deaths, negotiated respawn boundaries
// and a match that ends on hearts instead of on the clock. The wire underneath is the one
// that hurts: 20ms base with 20ms of jitter reorders packets around the 16.7ms tick, so the
// two sides mispredict each other and roll back for real, on top of loss and blackouts.
//
// One deliberate limit remains. A knockout node cannot take a draw -- the server has no
// winner to walk up the bracket -- so the two pilots that routinely end 0:0 fly only in the
// round-robin, where a draw is worth half a point to each; a knockout that still draws is
// REPLAYED on a fresh seed, which is what the real server does with one too.
const { mkWorld, MAX_DIRECT, BREAK_MS, TT_OVER_MS } = require('./tourney-world');
const { runSpec } = require('./spec-driver');
const { autopilot, jouster, collider } = require('./duel-driver');
const DIRS = { auto:autopilot, joust:jouster, kill:collider };

const IDS   = ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004', 'aaaa0005'];
// clnt-CI-<the four hex that tell these ids apart>: the shape the live probes register
// under, so a name in the log traces back to the id that wore it. Here that is the tail
// (the live ids differ in their head instead).
const NAMES = IDS.map(id => 'clnt-CI-' + id.slice(-4));
const N = IDS.length;              // five: 2N round-robin matches, then a 3-strong knockout
const TAIL = 2500;                 // ms of CALM wire after each match, so "healed" is provable
const SEED0 = 0x7A1E, SEEDSTEP = 0x9E37;
// Worn windswept gear, one distinct set per side. No windswept list ever crosses the wire:
// each client derives the identical [P0,P1] pair from the two profiles, so a match with
// stakes on is also a continuous test that both sides agree on what is being stolen.
const WS = { A:['shades', 'moustache', 'crown'], B:['cylinder', 'glasses3d', 'wizard'] };

// THE EVENING, one row per node in bracket order: the wire it is played over and the pilot
// both sides fly under. The blackout walks around the tree on purpose: the host, the guest,
// each primary, the secondary, and once the whole room at the same time. `who` is a role in
// the MATCH, not a person -- 'A' is the feeder/host of that node, 'S1'/'S2' are its two
// primaries and 'S3' the secondary that hangs off them.
//
// The house wire is 20ms base with 20ms of jitter. That is deliberate and it is the point:
// the spread straddles the 16.7ms tick, so peer inputs land a tick or two late or out of
// order and each side rolls back and resimulates over its own prediction. A profile that
// never provoked one would be testing the repair path not at all, which is why the run
// asserts the rollbacks HAPPENED as well as that they healed.
//
// `dir` is the pilot the FEEDER side flies and `dirB` the pilot the other side flies. They
// are named separately because two people do not play alike: a gem farmer against a hunter
// is an ordinary match, and it is also the only shape a knockout can be dealt -- two of the
// same pilot on one seed mirror each other into the 0:0 or equal-score draw that a knockout
// has no way to settle. A round-robin can take a draw (half a point each) and gets them.
const NET = [
    { tag:'clean lan',      dir:'auto',  secs:30, wire:{ base:12, jit:6,  loss:0,    asym:0 }, out:[] },
    { tag:'home wifi',      dir:'joust', secs:30, wire:{ base:20, jit:20, loss:0.02, asym:4 }, out:[] },
    { tag:'lossy wifi',     dir:'auto',  dirB:'kill', secs:32, wire:{ base:20, jit:20, loss:0.05, asym:6 }, out:[] },
    { tag:'guest dark',     dir:'kill',  secs:30, wire:{ base:20, jit:20, loss:0.02, asym:6 }, out:[{ at:5.0, ms:900,  who:'B'  }] },
    { tag:'host dark',      dir:'auto',  secs:32, wire:{ base:20, jit:20, loss:0.02, asym:6 }, out:[{ at:5.5, ms:900,  who:'A'  }] },
    { tag:'primary dark',   dir:'joust', secs:30, wire:{ base:24, jit:20, loss:0.03, asym:6 }, out:[{ at:4.5, ms:1200, who:'S1' }] },
    { tag:'other primary',  dir:'auto',  secs:32, wire:{ base:24, jit:20, loss:0.03, asym:6 }, out:[{ at:4.5, ms:1200, who:'S2' }] },
    { tag:'secondary dark', dir:'kill',  secs:30, wire:{ base:24, jit:20, loss:0.03, asym:6 }, out:[{ at:4.5, ms:1500, who:'S3' }] },
    { tag:'mobile',         dir:'auto',  dirB:'joust', secs:32, wire:{ base:35, jit:24, loss:0.03, asym:8 }, out:[] },
    { tag:'two gaps',       dir:'joust', secs:30, wire:{ base:20, jit:20, loss:0.02, asym:6 }, out:[{ at:3.5, ms:800,  who:'S1' },
                                                                                                   { at:7.0, ms:900,  who:'B'  }] },
    { tag:'everyone dark',  dir:'auto',  dirB:'joust', secs:34, wire:{ base:20, jit:20, loss:0.02, asym:6 }, out:[{ at:6.0, ms:1000, who:'*'  }] },
    { tag:'the long final', dir:'auto',  dirB:'joust', secs:40, wire:{ base:28, jit:20, loss:0.03, asym:8 }, out:[{ at:4.0, ms:900,  who:'A'  },
                                                                                                   { at:8.0, ms:900,  who:'S2' }] },
];

const rows = [];
let fails = 0;
const A = (c, m) => { if(!c){ rows.push('FAIL: ' + m); fails++; } };

const { srv, C, idx, clock, pump, settleAsync, clearAll } = mkWorld(IDS, NAMES, {});
const nodesOf = (r) => srv.T.order.filter(x => srv.T.nodes[x].round === r);

// HEALED, not merely quiet. divN counts settled ticks where a spectator's world disagreed
// with the players'; divOpen says whether the LAST comparison of the run was one of them.
// Zero disagreement is a heal, and so is disagreement that stopped -- but silence after
// the last comparison is not, which is what the calm tail after every match exists to
// rule out. The flag is the predicate rather than a tick comparison because simTick
// restarts at every level boundary, so tick numbers from two levels are two clocks.
const healed = (s) => s.divN === 0 || (!s.divOpen && s.divClean != null);
// How a stretch of wrong history ended: on its own, or only because the boundary rebuilt
// the world from (seed, level). Both are a heal; they are not the same evidence.
const howHealed = (s) => s.divN === 0 ? '' : (s.divBoundary ? ' across the level boundary'
                                                            : ' by tick ' + s.divClean);
// The sim's own verdict, in players[] order. Autopilots rarely kill each other inside the
// clock, so most matches are decided on score, exactly as a timed-out duel is.
const verdict = (r) => {
    if(r.winner === 0 || r.winner === 1) return r.winner;
    const sc = r.score || [0, 0];
    return sc[0] === sc[1] ? 2 : (sc[0] > sc[1] ? 0 : 1);
};

// ---- 0) the predicate itself ----------------------------------------------
// Every node below claims a heal, and the claim is worth nothing unless the predicate can
// still say NO. These are the shapes it has to tell apart -- including the one it used to
// read wrong: an agreement whose tick number is SMALLER than the disagreement's, because a
// level boundary restarted the clock between them.
function predicate(){
    A(healed({ divN:0 }), '0: a node that never disagreed did not count as healed');
    A(!healed({ divN:3, divTo:279, divClean:null, divOpen:true }),
      '0: a node still wrong at the last comparison counted as healed');
    A(!healed({ divN:3, divTo:279, divClean:200, divOpen:true }),
      '0: a node wrong AGAIN after its last agreement counted as healed');
    A(healed({ divN:3, divTo:279, divClean:300, divOpen:false, divBoundary:false }),
      '0: a node that came back inside the level did not count as healed');
    A(healed({ divN:3, divTo:279, divClean:141, divOpen:false, divBoundary:true }),
      '0: a node that came back only after a level boundary did not count as healed');
    rows.push('0 predicate: a heal is an agreement AFTER the last disagreement, in comparison'
              + ' order -- tick numbers restart at every level boundary');
}

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
function playMatch(p, sh, nd, seed){
    // The watchers are wired the way the sheet says: the primaries take their feed from the
    // feeder, the secondary dual-connects to both primaries and picks one.
    const watchers = sh.primaries.map(() => ({ at:0.5, from:'A' }))
        .concat(sh.secondaries.map(() => ({ at:1.5, from:['S1', 'S2'] })));
    // The match opens on the node's OWN terms, not on a 1vs1's: the round's level, the round's
    // hearts, and the gear both players are wearing into it.
    return runSpec({ secs:p.secs, seed, wire:p.wire,
                     specWire:{ base:p.wire.base + 8, jit:p.wire.jit + 4 },
                     lvl:nd.lvl, hearts:nd.hm, ws:WS, director:DIRS[p.dir], dirB:DIRS[p.dirB || p.dir],
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
        r = playMatch(p, sh, nd, ((SEED0 + seen.nodes * SEEDSTEP) ^ (0x5A5A * tries)) >>> 0);
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
      + 'apart at ' + r.pairDiv.divTicks + ' settled tick(s), last one tick ' + r.pairDiv.divTo
      + ', last agreement ' + r.pairDiv.divClean);
    // A blackout that never landed is a profile that tested nothing.
    A(r.outages.every(o => o.hits > 0),
      nid + ' [' + p.tag + ']: a blackout on ' + gap + ' never actually darkened the wire');
    A(win !== 2 || nd.round === 1, nid + ': a knockout node was still a draw after ' + tries + ' tries');
    // THE MATCH WAS THE ONE THE SHEET DEALT. The level is a parameter of the shared duel
    // start, so a node in round 3 opens on level 3 and the board is a pure function of
    // (seed, level) -- if the two sides read different numbers the very first frame differs.
    A(r.levelReached >= nd.lvl,
      nid + ' [' + p.tag + ']: dealt at level ' + nd.lvl + ' but the match only reached ' + r.levelReached);
    // Item stakes are on, so every near miss rolls the steal dice. The windswept lists never
    // cross the wire: both clients derive them from the two profiles, which means one shared
    // string read at the same tick, all match long, or the first roll splits the timeline.
    A(r.wsSplit === 0 && r.wsSame,
      nid + ' [' + p.tag + ']: the two sides disagreed about the worn gear on ' + r.wsSplit + ' samples');
    seen.lvlUps += r.levelUps;
    seen.blows += r.wsBlows; seen.steals += r.wsSteals;
    seen.rb += r.rb.A + r.rb.B; seen.resim += r.resim.A + r.resim.B;
    const lv = r.lives || [nd.hm, nd.hm];
    const deaths = Math.max(0, nd.hm * 2 - (lv[0] + lv[1]));
    seen.deaths += deaths;
    if(r.exitReason === 'duelOver' && (lv[0] === 0 || lv[1] === 0)) seen.onHearts++;

    // -- the audience --
    for(const n of Object.keys(r.spectators)){
        const s = r.spectators[n];
        const hops = sh.primaries.length >= MAX_DIRECT && n === 'S3' ? 2 : 1;
        A(s.on, nid + ' [' + p.tag + ']: ' + n + ' was not watching at the end');
        A(s.hops === hops, nid + ' [' + p.tag + ']: ' + n + ' sat ' + s.hops + ' hops out, the tree says ' + hops);
        A(healed(s), nid + ' [' + p.tag + ']: ' + n + ' never caught up -- wrong at '
          + s.divTicks + ' settled tick(s), last one tick ' + s.divTo
          + ', last agreement ' + s.divClean);
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
              + (p.dir + '/' + (p.dirB || p.dir)).padEnd(12) + 'L' + nd.lvl + '/' + nd.hm + 'h  '
              + 'base ' + p.wire.base + 'ms jit ' + p.wire.jit + ' loss ' + Math.round(p.wire.loss * 100)
              + '% dark ' + gap.padEnd(5) + ' -> ' + JSON.stringify(r.score)
              + '  lvl' + r.levelReached + ' up' + r.levelUps + ' d' + deaths
              + ' blow' + r.wsBlows + '/steal' + r.wsSteals + ' rb' + (r.rb.A + r.rb.B)
              + (r.pairDiv.divN ? '  (players apart at ' + r.pairDiv.divTicks
                                  + ' tick(s), back together' + howHealed(r.pairDiv) + ')' : '')
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
    srv.mute(IDS[deaf], false);                  // the mailbox comes back: one read recovers the board
    await pump(1);
    A(C[deaf].brk() === null, 'break: the deaf client is still holding a cleared board');
    A(C[deaf].tt().cursor === srv.T.cursor, 'break: the deaf client never picked the next match up');
    seen.breaks.push(b0.done);
    rows.push('3 break ' + b0.done + '->' + b0.next + ': ' + b0.of + ' of ' + N + ' through at level '
              + b0.lvl + '/' + b0.hm + ' hearts; ' + NAMES[deaf]
              + ' slept through it with a dead signal stream and rejoined off the state read-back');
}

// ---- 4) the evening ------------------------------------------------------
async function evening(){
    const seen = { nodes:0, replays:0, gaps:0, lag:0, tags:[], breaks:[],
                   lvlUps:0, deaths:0, onHearts:0, blows:0, steals:0, rb:0, resim:0 };
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
    // AN EVENING THAT CONTAINED A GAME. Each of these is a whole category of the shared sim
    // that a tournament is supposed to carry end to end, and each one of them was silently
    // absent from every run of this suite before: matches were short enough that nobody ever
    // reached ten gems, nobody wore anything, nobody died, and the wire was calm enough that
    // no side ever had to take a prediction back. A green run that contained none of it is
    // not evidence about tournaments, it is evidence about bookkeeping.
    A(seen.lvlUps > 0, '4: not one match crossed a level boundary');
    A(seen.deaths > 0, '4: nobody died all evening');
    A(seen.onHearts > 0, '4: not one match was decided on hearts rather than on the clock');
    A(seen.blows > 0, '4: item stakes were on and no gear was ever knocked loose');
    A(seen.steals > 0, '4: gear came loose ' + seen.blows + ' times and never once changed owner');
    A(seen.rb > 0, '4: not one rollback all evening -- the wire never provoked a mispredict, '
                 + 'so nothing here says the repair path works');
    rows.push('4 evening: ' + seen.nodes + ' matches played for real over ' + seen.gaps
              + ' blackouts, worst spectator lag ' + seen.lag + ' ticks, '
              + seen.replays + ' knockout draw(s) replayed');
    rows.push('4 the game: ' + seen.lvlUps + ' level boundaries crossed, ' + seen.deaths
              + ' deaths (' + seen.onHearts + ' match(es) ended on hearts), ' + seen.blows
              + ' items blown loose and ' + seen.steals + ' stolen, ' + seen.rb
              + ' rollbacks resimulating ' + seen.resim + ' ticks -- all healed');
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
    predicate();
    await lobby();
    await evening();
    await podium();
    for(const r of rows) console.log(r);
    console.log('\n' + Math.round((Date.now() - t0) / 1000) + 's wall');
    if(fails){ console.log('TOURNEY-SIM FAILED (' + fails + ')'); process.exit(1); }
    console.log('TOURNEY-SIM PASSED');
})().catch(e => { console.log('TOURNEY-SIM CRASHED: ' + (e && e.stack || e)); process.exit(1); });
