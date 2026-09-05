// TOURNAMENT FULL LADDER (ON DEMAND -- not part of any tier). A full field of ten real
// clients plays every match of every round, from the join code to the podium.
//
// WHY THIS EXISTS BESIDE tourney-e2e.js. That suite is the one that runs on every --full:
// six clients, twelve matches, and every failure mode injected one at a time. Keeping it
// that size is deliberate. But a tournament is a LADDER, and a ladder only shows itself at
// full length: the round-robin at the player cap, a break between every pair of rounds, the
// level walking up one per round, the stage tokens turning from GROUP STAGE into QUARTER
// FINALS into SEMI FINALS into THE FINAL, and the bracket halving until one node is left.
// None of that is reachable in twelve matches, and all of it is what a player actually
// sees. This suite walks it once, end to end, and is run by hand:
//
//   node test/tourney-full.js        (or: bash test/checks.sh --tourney)
//
// The world -- the scripted server and the ten harness clients -- is test/tourney-world.js,
// the same one tourney-e2e.js drives. The clients are the shipping client.
const { mkWorld, MAX_LEVEL, BREAK_MS, BREAK_TTL_MS,
        TT_OVER_MS, TT_STATE_MS } = require('./tourney-world');

const IDS   = ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004', 'aaaa0005',
               'aaaa0006', 'aaaa0007', 'aaaa0008', 'aaaa0009', 'aaaa0010'];
// The clnt-CI-<id tail> shape the live probes use: one naming convention for every
// client this project invents, and a name in the log traces back to the id that wore it.
const NAMES = IDS.map(id => 'clnt-CI-' + id.slice(-4));
const N = IDS.length;              // the player cap: tournament_max_players
const CUT = 8;                     // how many survive the round-robin, so the tree is 8-4-2

const rows = [];
let fails = 0;
const A = (c, m) => { if(!c){ rows.push('FAIL: ' + m); fails++; } };

const { srv, C, idx, clock, pump, settleAsync, clearAll } = mkWorld(IDS, NAMES, { cut:CUT });

// Everyone the server still counts as a member. A forfeit mid-run leaves the rest of the
// field playing on, so most expectations below are about these and not about all ten.
const alive = () => IDS.map((id, i) => i).filter(i => srv.T.players.some(p => p.id === IDS[i]));
const nodesOf = (r) => srv.T.order.filter(x => srv.T.nodes[x].round === r);

// ---- 1) a full room -------------------------------------------------------
async function lobby(){
    for(const c of C){ c.setPhase('tourneyLobby'); c.enter(); }
    await settleAsync();
    await C[0].create(false);
    await settleAsync();
    for(let i = 1; i < N; i++){ await C[i].join('K7MZ4Q'); await settleAsync(); }
    await pump(1);
    for(const i of alive())
        A((C[i].tt() || {}).players.length === N,
          '1: ' + NAMES[i] + ' sees ' + ((C[i].tt() || {}).players || []).length + ' of ' + N + ' players');
    // The cap is the server's, and it is the number the lobby was built around.
    A(srv.T.max === N, '1: the room holds ' + srv.T.max + ' but the field is ' + N);
    await C[0].start();
    clearAll();
    await pump(2);
    const r1 = nodesOf(1).length;
    A(r1 === 2 * N, '1: ' + r1 + ' round-1 matches for ' + N + ' players');
    rows.push('1 lobby: ' + N + ' players (the cap), ' + r1 + ' round-robin matches dealt');
}

// ---- 2) one match -------------------------------------------------------
// The per-node contract, asserted on every one of the 27 nodes rather than on a sample:
// the sheet said the same thing to everybody, the level is the one the ladder owes this
// round, both sides preset the match to it, and exactly the two players reported.
async function playNode(seen){
    const nid = srv.T.cursor, nd = srv.T.nodes[nid];
    const [pa, pb] = nd.players, ia = idx(pa), ib = idx(pb);
    await pump(1);
    const wantLvl = Math.min(nd.round, MAX_LEVEL);
    A(nd.lvl === wantLvl, nid + ': a round-' + nd.round + ' node is at level ' + nd.lvl
      + ', the ladder says ' + wantLvl);

    for(const i of alive()){
        const t = C[i].tt(), r = t && t.roles;
        A(!!r && r.nid === nid, nid + ': ' + NAMES[i] + ' holds sheet ' + (r ? r.nid : 'none'));
        if(!r) continue;
        const want = (i === ia || i === ib) ? 'play' : 'spectate';
        A(r.you === want, nid + ': ' + NAMES[i] + ' was told "' + r.you + '" instead of "' + want + '"');
        A(r.lvl === nd.lvl && r.hm === nd.hm,
          nid + ': ' + NAMES[i] + ' was told level ' + r.lvl + '/' + r.hm + ' hearts for a '
          + nd.lvl + '/' + nd.hm + ' node');
        A(C[i].phase() === 'tourneyCeremony', nid + ': ' + NAMES[i] + ' sat on ' + C[i].phase());
        seen.stage[String(r.stage)] = (seen.stage[String(r.stage)] | 0) + 1;
        A(C[i].stage(r.stage, r.round) !== '', nid + ': the stage token drew as nothing');
    }
    C[ia].draw(); C[ib].draw();

    // ONE mechanic, parameterised: the level the match opens at is a field of the session,
    // exactly like the heart cap and the stakes, and both sides arrive at it from the sheet.
    for(const [who, s] of [[NAMES[ia], C[ia].sess(pb, 'host')], [NAMES[ib], C[ib].sess(pa, 'guest')]]){
        A(s.lvl0 === nd.lvl && s.levelWant === nd.lvl,
          nid + ': ' + who + ' opens on level ' + s.lvl0 + ', the sheet says ' + nd.lvl);
        A(s.hearts === nd.hm && s.heartsWant === nd.hm,
          nid + ': ' + who + ' opened at ' + s.hearts + ' hearts, sheet says ' + nd.hm);
        A(s.stakes === srv.T.stakes && s.p2pOnly === true,
          nid + ': ' + who + ' minted a tournament session with the wrong terms');
    }

    C[ia].inGame(true); C[ib].inGame(true);
    const before = srv.log.filter(x => x.action === 'result' && x.nid === nid).length;
    // Vary the result so the standings are a real ladder rather than seat order, and so the
    // score difference tie-break has something to break.
    const k = seen.nodes++;
    const win = (k % 3 === 2) ? 1 : 0, sc = [5 + (k % 4), 1 + (k % 3)];
    C[ia].endMatch('host', pb, win, sc);
    C[ib].endMatch('guest', pa, win, sc);
    await settleAsync();
    const posts = srv.log.filter(x => x.action === 'result' && x.nid === nid);
    A(posts.length - before === 2, nid + ': ' + (posts.length - before) + ' result posts, expected 2');
    A(posts.every(x => x.id === pa || x.id === pb), nid + ': a result was accepted from a spectator');
    A(srv.T.nodes[nid].state === 'done', nid + ': settled as ' + srv.T.nodes[nid].state);
    seen.lvl[nd.lvl] = (seen.lvl[nd.lvl] | 0) + 1;
    clearAll();
    clock(TT_OVER_MS + 1000);
    await pump(2);
}

// ---- 3) the break between two rounds --------------------------------------
// Every round boundary stops here. `mode` is how this particular one is left: the host
// presses CONTINUE, or nobody does and the break's own TTL clears it.
async function passBreak(mode){
    const b0 = C[alive()[0]].brk();
    const done = b0 ? b0.done | 0 : -1;
    const nextNid = srv.T.brkNext, nd = srv.T.nodes[nextNid];
    const hi = idx(srv.T.host);

    // -- the whole field is looking at the same board --
    for(const i of alive()){
        const b = C[i].brk();
        A(!!b && b.done === done && b.next === nd.round,
          'break ' + done + ': ' + NAMES[i] + ' holds ' + (b ? b.done + '->' + b.next : 'no board'));
        A(C[i].phase() === 'tourneyRound',
          'break ' + done + ': ' + NAMES[i] + ' sat on ' + C[i].phase() + ' instead of the scoreboard');
        A((C[i].tt() || {}).cursor === null,
          'break ' + done + ': ' + NAMES[i] + ' still points at a match during the break');
        C[i].draw();
    }

    // -- the board describes the round about to be played --
    const nRows = nodesOf(nd.round).length;
    A(b0.matches === nRows && b0.lvl === Math.min(nd.round, MAX_LEVEL) && b0.hm === nd.hm,
      'break ' + done + ': the board promises ' + b0.matches + ' matches at level ' + b0.lvl
      + '/' + b0.hm + ' hearts, the bracket holds ' + nRows + ' at ' + nd.lvl + '/' + nd.hm);
    A(b0.of === b0.rows.filter(r => r.adv).length && b0.of === nRows * 2,
      'break ' + done + ': ' + b0.of + ' through into ' + nRows + ' matches');
    A(b0.rows.length === N, 'break ' + done + ': ' + b0.rows.length + ' rows for a field of ' + N);
    // THE CUT IS ONE LINE. Everyone still in sits above everyone who is out, so the screen
    // can draw the cut as a rule between two rows instead of hunting for it.
    const cut = b0.rows.map(r => (r.adv ? 1 : 0));
    A(JSON.stringify(cut) === JSON.stringify(cut.slice().sort((x, y) => y - x)),
      'break ' + done + ': the advancing half is not a contiguous block: ' + cut.join(''));
    // w/l/d count the round that just ended, and every match in it put two rows up.
    const wld = b0.rows.reduce((a, r) => a + (r.w | 0) + (r.l | 0) + (r.d | 0), 0);
    A(wld === 2 * nodesOf(done).length,
      'break ' + done + ': ' + wld + ' results across the rows for ' + nodesOf(done).length + ' matches');
    // The stage caption is the client's wording of the server's token, never the token.
    const caption = C[hi].stage(b0.stage, b0.next);
    A(caption && caption.indexOf('undefined') < 0,
      'break ' + done + ': stage token "' + b0.stage + '" drew as "' + caption + '"');

    // -- CONTINUE belongs to the host and to nobody else --
    for(const i of alive())
        A(C[i].has('CONTINUE') === (i === hi),
          'break ' + done + ': ' + NAMES[i] + (i === hi ? ' was not offered CONTINUE' : ' was offered CONTINUE'));

    // -- the wait is real: the row is dark, with the countdown on it, until it runs out --
    const early = C[hi].rows().filter(r => r.t === 'CONTINUE')[0];
    A(early && !early.en && /^[0-9]+S$/.test(early.note),
      'break ' + done + ': CONTINUE was live immediately, note "' + (early ? early.note : '-') + '"');
    clock(BREAK_MS + 100);
    A(C[hi].rows().filter(r => r.t === 'CONTINUE')[0].en,
      'break ' + done + ': CONTINUE stayed dark after the wait ran out');

    if(mode === 'forfeit'){
        // Somebody who is already out closes the game during the break. The board is derived
        // on every read, so the rest of the field learns it from the next state read-back --
        // there is no event for it -- and the tournament plays on without them.
        const out = b0.rows.filter(r => !r.adv && !r.gone)[0];
        const li = idx(out.id);
        await C[li].pick('BACK - LEAVE TOURNAMENT');
        // The row opens the QUESTION, it does not answer it: walking out of a tournament
        // mid-run costs the matches you were still due, so it is asked about first.
        A(C[li].phase() === 'tourneyQuit',
          'break ' + done + ': ' + NAMES[li] + ' left without being asked (' + C[li].phase() + ')');
        await C[li].key('confirm', 0);              // 0 is YES
        await settleAsync();
        A(C[li].tt() === null, 'break ' + done + ': ' + NAMES[li] + ' left but still holds a tournament');
        A(srv.T.players.length === N - 1, 'break ' + done + ': the roster did not shrink on the leave');
        clock(TT_STATE_MS + 1000);
        await pump(1);
        const seen2 = C[hi].brk().rows.filter(r => r.id === out.id)[0];
        A(seen2 && seen2.gone === true,
          'break ' + done + ': the field never saw ' + NAMES[li] + ' go');
        A(C[hi].brk().rows.length === N,
          'break ' + done + ': a departed player was dropped from the ladder rather than marked');
        rows.push('  a player already out left mid-break: marked gone on the read-back, field played on');
    }

    if(mode === 'ttl'){
        // Nobody presses. A break that is never continued is not a tournament that stops:
        // the server clears it on its own and deals the next round.
        const pressed = srv.log.filter(x => x.action === 'continue').length;
        clock(BREAK_TTL_MS + 1000);
        await pump(2);
        A(srv.log.filter(x => x.action === 'continue').length === pressed,
          'break ' + done + ': somebody pressed CONTINUE on the break that was meant to expire');
        rows.push('  a break nobody continued expired on its own after ' + (BREAK_TTL_MS / 1000) + 's');
    } else {
        await C[hi].pick('CONTINUE');
        await settleAsync();
        await pump(1);
    }

    A(srv.T.brk === null && srv.T.cursor === nextNid,
      'break ' + done + ': the break is ' + (srv.T.brk ? 'still open' : 'closed on ' + srv.T.cursor));
    for(const i of alive())
        A(C[i].phase() !== 'tourneyRound',
          'break ' + done + ': ' + NAMES[i] + ' was left on the scoreboard after the break closed');
    rows.push('3 break ' + done + '->' + nd.round + ': ' + b0.of + ' of ' + N + ' through, '
              + b0.matches + ' match(es) at level ' + b0.lvl + '/' + b0.hm + ' hearts, "'
              + caption + '", left by ' + (mode === 'ttl' ? 'timeout' : 'the host'));
    return done;
}

// ---- 4) the ladder, walked -----------------------------------------------
async function ladder(){
    const seen = { nodes:0, stage:{}, lvl:{}, breaks:[] };
    let guard = 0;
    while(srv.T.state === 'running' && guard++ < 80){
        if(srv.T.brk){
            // The three exits a break has, one each: the host presses, somebody forfeits
            // while it is up, and the last one is left to time out.
            const mode = seen.breaks.length === 1 ? 'forfeit'
                       : (nodesOf(srv.T.nodes[srv.T.brkNext].round).length === 1 ? 'ttl' : 'press');
            seen.breaks.push(await passBreak(mode));
            continue;
        }
        if(!srv.T.cursor) break;
        await playNode(seen);
    }
    A(guard < 80, '4: the ladder never reached the podium');

    // Every round played, every round boundary stopped on a scoreboard.
    const rounds = [];
    for(let r = 1; srv.T.order.some(x => srv.T.nodes[x].round === r); r++) rounds.push(r);
    A(JSON.stringify(seen.breaks) === JSON.stringify(rounds.slice(0, -1)),
      '4: breaks after rounds ' + seen.breaks.join(',') + ' for rounds ' + rounds.join(','));
    A(seen.nodes === srv.T.order.length,
      '4: ' + seen.nodes + ' matches played of ' + srv.T.order.length + ' in the bracket');
    A(srv.T.order.every(x => srv.T.nodes[x].state === 'done'),
      '4: the tournament ended with a node still unplayed');
    // THE LEVEL LADDER, end to end: one level per round and nothing skipped.
    const played = Object.keys(seen.lvl).map(Number).sort((a, b) => a - b);
    A(JSON.stringify(played) === JSON.stringify(rounds.map(r => Math.min(r, MAX_LEVEL))),
      '4: levels ' + played.join(',') + ' for rounds ' + rounds.join(','));
    // All four named stages came out of one run, which is the only way to prove the client
    // is not quietly drawing every round the same.
    for(const tok of ['group', 'quarter', 'semi', 'final'])
        A(seen.stage[tok] > 0, '4: no node in the whole ladder was a "' + tok + '"');
    rows.push('4 ladder: ' + seen.nodes + ' matches over ' + rounds.length + ' rounds ('
              + rounds.map(r => nodesOf(r).length).join('+') + '), levels '
              + played.join('/') + ', stages ' + Object.keys(seen.stage).join('/'));
}

// ---- 5) the podium --------------------------------------------------------
async function podium(){
    await pump(2);
    for(const i of alive()){
        const t = C[i].tt();
        A(t && t.state === 'done' && JSON.stringify(t.podium) === JSON.stringify(srv.T.podium),
          '5: ' + NAMES[i] + ' holds podium ' + JSON.stringify(t && t.podium));
        A(C[i].phase() === 'tourneyPodium', '5: ' + NAMES[i] + ' ended on ' + C[i].phase());
        A(C[i].brk() === null, '5: ' + NAMES[i] + ' still holds a scoreboard on the podium');
        A(C[i].has('DONE'), '5: ' + NAMES[i] + ' has no way off the podium');
        C[i].draw();
    }
    const p = srv.T.podium;
    A(p[0] && p[1] && p[2] && p[0] !== p[1] && p[1] !== p[2],
      '5: the podium is ' + JSON.stringify(p));
    rows.push('5 podium: ' + p.map(id => NAMES[idx(id)]).join(' > ') + ', held identically by all '
              + alive().length + ' remaining clients');
}

// ---- 6) a level off the wire is still untrusted ---------------------------
// The ladder is the only thing that ever asks for a level above 1, which makes it the only
// thing that could ask for one this build does not have. A sheet is not proof.
async function hostileLevels(){
    const i = alive()[0], me = IDS[i], peer = IDS[alive()[1]];
    let k = 0;
    for(const [lvl, want] of [[MAX_LEVEL, MAX_LEVEL], [12, 1], [99, 1], [0, 1], [-3, 1], [null, 1]]){
        const d = { event:'roles', tid:srv.T.tid, round:9, stage:'ko', nid:'x9.' + (++k), hm:2,
                    stakes:false, players:[me, peer], feeder:me, primaries:[], secondaries:[],
                    names:{}, you:'play' };
        if(lvl !== null) d.lvl = lvl;
        C[i].setPhase('tourneyBracket'); C[i].inGame(false);
        C[i].sigTo(d);
        await settleAsync();
        clock(TT_OVER_MS + 1000);      // the sheet is engaged by the housekeeping tick
        C[i].tick();
        await settleAsync();
        const s = C[i].sess(peer, 'host');
        A(s.lvl0 === want && s.levelWant === want,
          '6: a sheet naming level ' + String(lvl) + ' opened the match on ' + s.lvl0
          + ', it should open on ' + want);
    }
    rows.push('6 hostile sheet: level ' + MAX_LEVEL + ' is honoured and 12/99/0/-3/absent all open level 1');
}

(async () => {
    await lobby();
    await ladder();
    await podium();
    await hostileLevels();
    for(const r of rows) console.log(r);
    if(fails){ console.log('\nTOURNEY-FULL FAILED (' + fails + ')'); process.exit(1); }
    console.log('\nTOURNEY-FULL PASSED');
})().catch(e => { console.log('TOURNEY-FULL CRASHED: ' + (e && e.stack || e)); process.exit(1); });
