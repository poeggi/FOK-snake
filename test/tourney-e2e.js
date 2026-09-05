// TOURNAMENT END TO END (HEAVY suite). Six real clients, one scripted server, one
// tournament played from the join code to the podium.
//
// WHAT THIS SUITE IS FOR. duel-spec.js and duel-spec-tree.js already prove the two hard
// things underneath a tournament: that a spectator's world is bit-for-bit the players'
// world, and that the relay tree survives its nodes dying. Neither of them knows what a
// tournament is. This one owns the layer above: the ROLES SHEET turning into a connection,
// the round ladder, the break between rounds, the result ladder, and every rule about who
// may do what -- driven through the real hello/signal drain, the real _netPostRes, the real
// session minting and the real screens.
//
// THE WORLD IS SHARED. test/tourney-world.js holds the scripted server and the six real
// harness clients; this suite only drives them and asserts. The server there is a STAND-IN
// and deliberately so: it is the CONTRACT written out as data (docs/API.md's tournament
// section), not FOK-server's implementation. The bracket arithmetic it performs is
// FOK-server's to get right and unit.php's to prove; what matters here is that a client
// handed these events behaves. So every assertion below is about a CLIENT: what it
// connected to, what it reported, what it drew, and -- just as often -- what it refused
// to do.
//
// Run: node test/tourney-e2e.js
const { mkWorld, RESULT_MS, MAX_DIRECT, MAX_LEVEL, BREAK_MS,
        TT_OVER_MS, TT_STATE_MS, TT_CONNECT_MS, TT_CONNECT_TRIES } = require('./tourney-world');

const IDS   = ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004', 'aaaa0005', 'aaaa0006'];
// clnt-CI-<the four hex that tell these ids apart>: the shape the live probes register
// under, so a name in the log traces back to the id that wore it. Here that is the tail
// (the live ids differ in their head instead).
const NAMES = IDS.map(id => 'clnt-CI-' + id.slice(-4));
const N = IDS.length;

const rows = [];
let fails = 0;
const A = (c, m) => { if(!c){ rows.push('FAIL: ' + m); fails++; } };

// ============================================================================
// THE RUN
// ============================================================================
const { srv, C, idx, clock, pump, settleAsync, clearAll } = mkWorld(IDS, NAMES);

// ---- 1) the lobby ---------------------------------------------------------
async function lobby(){
    for(const c of C) c.setPhase('tourneyLobby');
    for(const c of C) c.enter();
    await settleAsync();
    // Nothing held yet: the rows are the three offers plus BACK, and the announce is empty
    // because no lobby exists to announce.
    const r0 = C[1].rows();
    A(r0.length === 4 && r0[0].t === 'CREATE TOURNAMENT' && r0[1].t === 'ITEM STAKES (WINDSWEPPING): OFF'
      && r0[2].t === 'JOIN BY CODE' && r0[3].t === 'BACK',
      '1: an empty lobby offers ' + r0.map(x => x.t).join('/'));
    A(r0.every(x => x.en), '1: the tournament rows are greyed against a 4.3 server');
    C[1].draw();

    C[0].pick('ITEM STAKES');                  // stakes are the host's call, off by default
    A(C[0].rows()[1].t === 'ITEM STAKES (WINDSWEPPING): ON', '1: the stakes row did not toggle');
    await C[0].pick('CREATE TOURNAMENT');
    await settleAsync();
    const t0 = C[0].tt();
    A(t0 && t0.code === 'K7MZ4Q' && t0.stakes === true && t0.state === 'open',
      '1: the host does not hold the lobby it just created');
    // The host's own rows: START first, because it is the press the host is waiting to make
    // and sel starts on it -- greyed until somebody else is in the room -- then the code,
    // which is what you hand out WHILE waiting.
    const rh = C[0].rows();
    A(rh[0].t === 'START TOURNAMENT' && !rh[0].en && rh[0].note === '(NEED 2)',
      '1: START is offered to a host sitting alone (' + JSON.stringify(rh[0]) + ')');
    A(rh[1].t === 'SHOW JOIN CODE' && rh[1].en, '1: the host cannot reach the code (' + rh[1].t + ')');
    A(rh[rh.length - 1].t === 'BACK - CANCEL TOURNAMENT',
      '1: the host exit does not say it cancels the room (' + rh[rh.length - 1].t + ')');

    // The announce reaches the others through the real hello, and only while the screen
    // that shows it is open -- that is the whole reason hello asks for it by flag.
    await pump(1);
    const rl = C[1].rows();
    const ann = rl.filter(x => x.t.indexOf('K7MZ4Q') === 0);
    A(ann.length === 1 && ann[0].note === '1/10', '1: the open lobby did not reach the announce list');
    C[1].draw();

    C[1].pick('K7MZ4Q');                       // joined off the announce
    await settleAsync();
    for(let i = 2; i < N; i++){ await C[i].join('k7mz4q'); await settleAsync(); }   // and by code, lower case
    await pump(1);
    for(let i = 0; i < N; i++){
        const t = C[i].tt();
        A(t && t.players.length === N, '1: client ' + NAMES[i] + ' sees ' + (t ? t.players.length : 0) + ' of ' + N + ' players');
        A(t && t.stakes === true, '1: client ' + NAMES[i] + ' lost the stakes flag the host set');
    }
    // Nothing but an adopted players list ever SHRINKS the roster, and a lobby event can go
    // missing -- this scripted leave publishes none, exactly like the server's. So the open
    // lobby has to re-read state on its own, or a player who walked out sits in the room for
    // good and the screen shows a name nobody can play.
    const gone = srv.T.players.pop();
    clock(TT_STATE_MS + 1000);
    await pump(1);
    A(C[0].tt().players.length === N - 1,
      '1: an open lobby never re-read state, so a departed player stayed on the roster');
    srv.T.players.push(gone);
    clock(TT_STATE_MS + 1000);
    await pump(1);
    A(C[0].tt().players.length === N, '1: the roster grew back on the read-back but did not');

    // A guest sees the host's START row too, dark, saying whose press the room is waiting
    // on: ONE lobby screen instead of two, with every other row in the same place on both.
    // It is also the one row on the screen that is not theirs to press, so a guest's lobby
    // opens with nothing selected rather than under the cursor of a row that only fails.
    // The code itself is not the host's to keep: the person standing next to a newcomer is
    // the one who ends up showing it to them.
    const rg = C[3].rows();
    A(rg[0].t === 'START TOURNAMENT' && !rg[0].en && rg[0].note === 'HOST ONLY' && rg[0].nosel,
      '1: a guest\'s START row read as ' + JSON.stringify(rg[0]));
    A(C[3].sel() === -1, '1: a guest\'s lobby opened armed on row ' + C[3].sel());
    A(rg[1].t === 'SHOW JOIN CODE' && rg[1].en, '1: a guest cannot pass the code on (' + rg[1].t + ')');
    A(rg[rg.length - 1].t === 'BACK - LEAVE TOURNAMENT',
      '1: a guest is offered ' + rg[rg.length - 1].t + ' rather than one row that backs out and leaves');
    A(C[0].rows()[0].en, '1: START is greyed with a full room');
    C[0].draw();

    await C[0].start();
    clearAll();
    await pump(2);
    rows.push('1 lobby: host created with stakes ON, 5 joined (one off the announce, four by code), '
              + 'START host-only and greyed alone, ' + srv.T.order.length + ' round-1 matches dealt');
}

// ---- 2) one match, from the sheet to the report ---------------------------
// Everything a node does to six clients, asserted once per node: who was told to play, who
// was told to watch, who connected to whom, and who was allowed to report.
async function node(plan){
    const nid = srv.T.cursor;
    const nd = srv.T.nodes[nid];
    const [pa, pb] = nd.players;
    const ia = idx(pa), ib = idx(pb);
    await pump(1);
    // THE ROUND LADDER. Round 1 is level 1 and every round after it one deeper, so a node
    // knows its level before anybody plays it and the two sides can preset the match to it.
    const wantLvl = Math.min(nd.round, MAX_LEVEL);
    A(nd.lvl === wantLvl, '2 ' + nid + ': a round-' + nd.round + ' node is at level ' + nd.lvl
      + ', the ladder says ' + wantLvl);

    // -- the sheet reached everyone, and said the same thing to everyone --
    for(let i = 0; i < N; i++){
        const t = C[i].tt(), r = t && t.roles;
        A(!!r && r.nid === nid, '2 ' + nid + ': ' + NAMES[i] + ' holds sheet ' + (r ? r.nid : 'none'));
        if(!r) continue;
        const want = (i === ia || i === ib) ? 'play' : 'spectate';
        A(r.you === want, '2 ' + nid + ': ' + NAMES[i] + ' was told "' + r.you + '" instead of "' + want + '"');
        A(r.feeder === pa, '2 ' + nid + ': the feeder is ' + r.feeder + ', not players[0]');
        A(r.lvl === nd.lvl, '2 ' + nid + ': ' + NAMES[i] + ' was told level ' + r.lvl + ' for a level-' + nd.lvl + ' node');
        A(typeof r.stage === 'string' && r.stage, '2 ' + nid + ': the sheet carries no stage token');
        A(t.cursor === nid, '2 ' + nid + ': ' + NAMES[i] + ' points at node ' + t.cursor);
        A(C[i].phase() === 'tourneyCeremony', '2 ' + nid + ': ' + NAMES[i] + ' sat on ' + C[i].phase() + ' instead of the ceremony');
        C[i].draw();
    }

    // -- a spectator who steps off the ceremony to read the board can step back onto it --
    // ESC off the ceremony is the only way onto the board mid-node, and without a way back
    // reading the standings while the match is being set up is a one-way trip that ends at
    // LEAVE TOURNAMENT. The way back is the row the board OPENS on, because it is the press
    // the person who just pressed ESC is going to make next.
    let is_ = -1;
    for(let i = 0; i < N; i++) if(i !== ia && i !== ib){ is_ = i; break; }
    C[is_].setPhase('tourneyBracket');
    const rb = C[is_].rows();
    A(rb[0].t === 'WATCH THE MATCH' && rb[0].en, '2 ' + nid + ': the board offers '
      + rb.map(x => x.t).join('/') + ' -- no way back to the match being watched');
    A(C[is_].sel() === 0, '2 ' + nid + ': the way back to the match is not the pre-selected row');
    C[is_].draw();
    C[is_].pick('WATCH THE MATCH');
    A(C[is_].phase() === 'tourneyCeremony', '2 ' + nid + ': the way back landed on ' + C[is_].phase());
    // A player gets the row for their OWN match, in their own words. They cannot reach the
    // board from the ceremony at all (it refuses their ESC), but every other route onto it
    // -- a break, a forfeit -- leaves the same node dealt and the same way back owed.
    C[ia].setPhase('tourneyBracket');
    A(C[ia].rows()[0].t === 'GO TO YOUR MATCH',
      '2 ' + nid + ': the board a player sees opens on ' + C[ia].rows()[0].t);
    C[ia].setPhase('tourneyCeremony');

    // -- the feeder offers, and only the feeder --
    const sheetR = C[ia].tt().roles;
    A(C[ia].rec().offers.length === 1 && C[ia].rec().offers[0] === pb,
      '2 ' + nid + ': the feeder sent ' + JSON.stringify(C[ia].rec().offers) + ' instead of one offer to its opponent');
    A(C[ib].rec().offers.length === 0, '2 ' + nid + ': the answerer offered too -- both sides would mint a session');
    A(C[ia].p2p() && C[ib].p2p(), '2 ' + nid + ': a tournament match was left willing to fall back on the relay');

    // -- the session both sides mint carries the sheet's parameters --
    const sa = C[ia].sess(pb, 'host'), sb = C[ib].sess(pa, 'guest');
    for(const [who, s] of [[NAMES[ia], sa], [NAMES[ib], sb]]){
        A(s.hearts === nd.hm && s.heartsWant === nd.hm,
          '2 ' + nid + ': ' + who + ' opened at ' + s.hearts + ' hearts, sheet says ' + nd.hm);
        A(s.lvl0 === nd.lvl && s.levelWant === nd.lvl,
          '2 ' + nid + ': ' + who + ' opens the match on level ' + s.lvl0 + ' and expects ' + s.levelWant
          + ', the sheet says ' + nd.lvl);
        A(s.stakes === srv.T.stakes, '2 ' + nid + ': ' + who + ' lost the stakes flag');
        A(s.p2pOnly === true, '2 ' + nid + ': ' + who + ' minted a relay-capable tournament session');
    }

    // -- the watchers connected where the tree told them to --
    for(let i = 0; i < N; i++){
        if(i === ia || i === ib) continue;
        const w = C[i].rec().watches.map(x => x.peer);
        const mine = sheetR.primaries.indexOf(IDS[i]) >= 0 ? [pa] : sheetR.primaries.slice(0, MAX_DIRECT);
        A(JSON.stringify(w) === JSON.stringify(mine),
          '2 ' + nid + ': ' + NAMES[i] + ' watched ' + JSON.stringify(w) + ', the tree says ' + JSON.stringify(mine));
        A(C[i].rec().watches.every(x => x.tid === srv.T.tid && x.nid === nid),
          '2 ' + nid + ': ' + NAMES[i] + ' asked for a feed without naming the node');
        // The sheet IS the introduction: everyone on it may open a link to us unasked.
        A(C[i].spGranted(pa) && C[i].spGranted(sheetR.primaries[0]),
          '2 ' + nid + ': ' + NAMES[i] + ' did not pre-authorise the peers on its own sheet');
    }

    C[ia].inGame(true); C[ib].inGame(true);
    return { nid, pa, pb, ia, ib, sheet:sheetR };
}

// The two players declare the match over. `plan.win` is 0, 1 or 2 (draw) in players[] order.
async function finish(m, plan){
    const before = srv.log.filter(x => x.action === 'result' && x.nid === m.nid).length;
    // A feeder serving its cap of watchers. The match it is serving OUT OF is about to end,
    // and with it every timeline those links carry: nothing downstream of them will ever be
    // fed again. Left standing they cost nothing visible -- they just quietly hold both
    // fan-out slots, so every watcher of every LATER match is answered 'no' by a player who
    // looks, correctly, like it is already serving as many as it can.
    C[m.ia].spServe('dead0001'); C[m.ia].spServe('dead0002');
    // From here this client hears nothing: no result, no scoreboard, no sheet. Whatever it
    // ends up knowing, it learned from the state read-back.
    if(plan.miss != null) srv.mute(IDS[plan.miss], true);
    const sc = plan.score || [7, 4];
    if(plan.mode === 'walkout'){
        C[m.ia].walkOut('host', m.pb, sc);
        C[m.ia].inGame(false);          // the quit path leaves the duel on its own
        // The other side's duel ends too, with a win it dutifully reports -- onto a node
        // the server has already settled from the loss. A replay is a no-op, not a freeze.
        C[m.ib].endMatch('guest', m.pa, 1, sc);
    } else if(plan.mode === 'contradict'){
        C[m.ia].endMatch('host', m.pb, 0, sc);
        C[m.ib].endMatch('guest', m.pa, 1, sc);
    } else {
        C[m.ia].endMatch('host', m.pb, plan.win, sc);
        if(plan.mode !== 'silent') C[m.ib].endMatch('guest', m.pa, plan.win, sc);
    }
    await settleAsync();
    const posts = srv.log.filter(x => x.action === 'result' && x.nid === m.nid);
    const want = plan.mode === 'silent' ? 1 : 2;
    A(posts.length - before === want,
      '2 ' + m.nid + ': ' + (posts.length - before) + ' result posts, expected ' + want);
    A(posts.every(x => x.id === m.pa || x.id === m.pb),
      '2 ' + m.nid + ': a result was accepted from somebody who was not playing');
    clearAll();
    clock(TT_OVER_MS + 1000);      // the duelOver banner has had its moment
    await pump(2);
    // A settled match is off the board and nobody is still standing on the ceremony.
    for(let i = 0; i < N; i++)
        A(C[i].phase() !== 'tourneyCeremony' || srv.T.cursor,
          '2 ' + m.nid + ': ' + NAMES[i] + ' is still waiting on a ceremony for a finished tournament');
    A(C[m.ia].spOut() === 0,
      '2 ' + m.nid + ': the match ended and ' + NAMES[m.ia] + ' still serves '
      + C[m.ia].spOut() + ' link(s) out of it');
}

// ---- the break between rounds ---------------------------------------------
// A round ends on a scoreboard everybody reads and only the HOST clears. The first break is
// asserted in full; later ones are passed with the same helper. `opts.missed` is a client
// whose signal stream has been muted, which is how the state read-back gets tested: it must
// put the board up and take it down again with no events at all.
async function passBreak(opts){
    opts = opts || {};
    await pump(1);
    const b0 = C[0].brk();
    A(!!b0, 'B: a round ended and no scoreboard went up');
    if(!b0) return;
    const hi = idx(b0.host), nextNid = srv.T.brkNext, nd = srv.T.nodes[nextNid];
    A(hi >= 0 && b0.host === srv.T.host, 'B: the board names ' + b0.host + ' as the host');

    // -- the same board reached everyone, and everyone can draw it --
    for(let i = 0; i < N; i++){
        const b = C[i].brk(), t = C[i].tt();
        A(!!b && b.done === b0.done && b.next === b0.next,
          'B: ' + NAMES[i] + ' holds ' + JSON.stringify(b && [b.done, b.next]) + ' instead of the board everyone else has');
        A(C[i].phase() === 'tourneyRound', 'B: ' + NAMES[i] + ' sat on ' + C[i].phase() + ' rather than the scoreboard');
        A(t.cursor === null, 'B: ' + NAMES[i] + ' still points at a node while the tournament is between rounds');
        A(t.round === b0.next, 'B: ' + NAMES[i] + ' is on round ' + t.round + ', the board says ' + b0.next);
        C[i].draw();
        // Exactly one button in the whole field, and it is the host's.
        A(C[i].has('CONTINUE') === (i === hi),
          'B: ' + NAMES[i] + (i === hi ? ' was offered no CONTINUE' : ' was offered a CONTINUE that is not theirs'));
    }

    // -- the board says what the next round is, and where the cut fell --
    A(b0.next === nd.round && b0.lvl === nd.lvl && b0.hm === nd.hm,
      'B: the board describes round ' + b0.next + '/L' + b0.lvl + '/' + b0.hm + 'h, the next node is '
      + nd.round + '/L' + nd.lvl + '/' + nd.hm + 'h');
    A(b0.lvl === Math.min(b0.next, MAX_LEVEL), 'B: the ladder put round ' + b0.next + ' on level ' + b0.lvl);
    A(b0.matches === srv.T.order.filter(x => srv.T.nodes[x].round === nd.round).length,
      'B: the board promises ' + b0.matches + ' matches');
    A(b0.rows.length === N, 'B: the board holds ' + b0.rows.length + ' rows for ' + N + ' participants');
    A(b0.of === b0.advancers.length && b0.rows.filter(r => r.adv).length === b0.of,
      'B: ' + b0.of + ' through, ' + b0.rows.filter(r => r.adv).length + ' rows marked as through');
    // THE CUT is one line: every row that is through sits above every row that is not, which
    // is what lets the screen draw the rule between two neighbours and never disagree with
    // the colours around it.
    const cut = b0.rows.map(r => r.adv ? 1 : 0);
    A(JSON.stringify(cut) === JSON.stringify(cut.slice().sort((a, b) => b - a)),
      'B: the ladder is not cut in one place: ' + cut.join(''));
    // W-L-D is the round that just ended and nothing else: two of them per settled match.
    const settled = srv.T.order.filter(x => srv.T.nodes[x].round === b0.done && srv.T.nodes[x].state === 'done').length;
    const wld = b0.rows.reduce((a, r) => a + (r.w | 0) + (r.l | 0) + (r.d | 0), 0);
    A(wld === 2 * settled, 'B: ' + wld + ' results across the rows for ' + settled + ' settled matches');
    A(b0.rows.every(r => r.until >= 1), 'B: a row does not say how far that player got');
    A(b0.rows.filter(r => r.adv).every(r => r.until === b0.next),
      'B: a row that is through does not reach the round it is through to');

    // -- the two who just played got here from the duel, not from the 1:1 menu --
    if(opts.played) for(const i of opts.played)
        A(C[i].phase() === 'tourneyRound',
          'B: ' + NAMES[i] + ' left its match onto ' + C[i].phase() + ' instead of the tournament');

    // -- a client with no signals at all found the board anyway --
    if(opts.missed != null){
        const mi = opts.missed, t = C[mi].tt();
        A(!t.last || t.last.nid !== opts.node,
          'B: the muted client got a result signal after all -- there is nothing left to test');
        A(!!C[mi].brk() && C[mi].phase() === 'tourneyRound',
          'B: a client with a dead signal stream never found the scoreboard in the state read-back');
    }

    if(opts.first){
        // The button is dark until the board has been up long enough, and says how long for.
        const rh = C[hi].rows().filter(r => r.t === 'CONTINUE')[0];
        A(rh && !rh.en && /^[0-9]+S$/.test(rh.note),
          'B: CONTINUE is live the instant the board goes up (' + JSON.stringify(rh) + ')');
        // An early press is not the server's to refuse: it never leaves the client.
        const q0 = srv.log.length + srv.refused.length;
        await C[hi].cont();
        await settleAsync();
        A(srv.log.length + srv.refused.length === q0, 'B: an early CONTINUE was posted anyway');
        // And nobody else's press is worth a request either, host row or no host row.
        const gi = (hi + 1) % N;
        await C[gi].cont();
        await settleAsync();
        A(srv.log.length + srv.refused.length === q0, 'B: a guest posted a CONTINUE');
        A(!!C[gi].brk(), 'B: a guest pressing CONTINUE took its own board down');
    }

    clock(BREAK_MS + 100);
    if(opts.first){
        // OUR clock is not the server's. When ours says the wait is over and the server's
        // does not, the refusal has to read as nothing at all -- a button that answers "no"
        // for a second reads as a broken one, so it simply goes dark again for as long as
        // the server asked for, and the press that follows works.
        srv.T.brk.at = srv.at() + 400;
        C[hi].clrMsg();
        const before = srv.refused.filter(x => x.action === 'continue').length;
        await C[hi].pick('CONTINUE');
        await settleAsync();
        A(srv.refused.filter(x => x.action === 'continue' && x.status === 409).length === before + 1,
          'B: the press against a skewed server clock was not refused with a 409');
        A(C[hi].msg() === '', 'B: being told "too early" surfaced as "' + C[hi].msg() + '"');
        A(!!C[hi].brk() && !srv.T.cursor, 'B: a refused press moved the tournament on');
        const rr = C[hi].rows().filter(r => r.t === 'CONTINUE')[0];
        A(rr && !rr.en && rr.note, 'B: a refused CONTINUE stayed live (' + JSON.stringify(rr) + ')');
        clock(2000);
        rows.push('B refusal: a press the server called too early re-armed the wait silently and '
                  + 'the next one went through');
    }

    // -- the host clears it, and the field walks into the next round --
    await C[hi].pick('CONTINUE');
    await settleAsync();
    await pump(2);
    A(!srv.T.brk, 'B: the board is still up after the host cleared it');
    A(srv.T.cursor === nextNid, 'B: clearing the board dealt ' + srv.T.cursor + ' instead of ' + nextNid);
    for(let i = 0; i < N; i++){
        if(opts.missed === i) continue;              // deaf by design, see below
        A(C[i].brk() === null, 'B: ' + NAMES[i] + ' is still holding a board the host cleared');
        A(C[i].phase() !== 'tourneyRound', 'B: ' + NAMES[i] + ' is still sitting on a cleared board');
    }
    if(opts.missed != null){
        // The other direction, and the one that would otherwise strand a player on a
        // scoreboard for the rest of the evening: the sheet that ends a break can be missed
        // too, and the read-back has to take the board down as surely as it put it up.
        const mi = opts.missed;
        clock(TT_STATE_MS + 1000);
        await pump(1);
        A(C[mi].brk() === null, 'B: the muted client is still holding a cleared board');
        A(C[mi].tt().cursor === srv.T.cursor, 'B: the muted client never picked the next match up');
        srv.mute(IDS[mi], false);
        rows.push('B deaf client: with its signal stream muted, one client put the scoreboard up and '
                  + 'took it down again off the state read-back alone');
    }
    rows.push('B break ' + b0.done + '->' + b0.next + ': ' + b0.rows.length + ' rows cut at ' + b0.of
              + ' through, ' + b0.matches + ' match(es) at level ' + b0.lvl + '/' + b0.hm + ' hearts, '
              + 'host-only CONTINUE held for ' + (BREAK_MS / 1000) + 's');
}

// ---- the whole thing ------------------------------------------------------
(async function main(){
    await lobby();

    // ---- round 1: twelve matches, with four of them going wrong ----------
    let played = 0, frozen = '';
    while(srv.T.round === 1 && srv.T.cursor){
        const k = played++;
        const m = await node({});
        if(k === 3){
            // A SPECTATOR that has been serving the tier below it is about to be
            // backgrounded. It stands down rather than making everyone downstream
            // discover the silence, and the server re-deals the tree around it.
            const w = m.sheet.primaries[0], wi = idx(w);
            C[wi].spServe(m.sheet.secondaries[0]);
            C[wi].clear();
            C[wi].spStandDown();
            await settleAsync(); await pump(1);
            A(srv.log.some(x => x.action === 'standdown' && x.id === w), '3: the stand-down never reached the server');
            A(C[wi].spOut() === 0, '3: a stood-down primary is still serving ' + C[wi].spOut() + ' link(s)');
            const t = C[wi].tt();
            A(t.roles.primaries.indexOf(w) < 0, '3: the re-deal left the stood-down client a primary');
            A(t.roles.primaries.length === MAX_DIRECT, '3: the re-deal produced ' + t.roles.primaries.length + ' primaries');
            // A patch moves the tree, never the bracket.
            A(t.cursor === m.nid && t.round === 1, '3: a roles-patch moved the bracket');
            rows.push('3 stand-down: a backgrounded primary handed its relay duty back and the server '
                      + 're-dealt the tier to ' + t.roles.primaries.map(x => NAMES[idx(x)]).join('+') + ' without touching the bracket');
        }
        if(k === 5){
            // BOTH primaries die at once. Local recovery is out of options, so the one
            // client that noticed asks the server -- ONCE per generation, however many
            // times the machinery underneath it gives up.
            const s = m.sheet.secondaries[0], si = idx(s);
            C[si].clear(); C[si].spFeedDead();
            C[si].spOrphan(); C[si].spOrphan();
            await settleAsync(); await pump(1);
            const calls = srv.log.filter(x => x.action === 'orphan' && x.id === s);
            A(calls.length === 1, '4: ' + calls.length + ' orphan calls for one generation');
            const t = C[si].tt();
            A(t.roles.primaries.indexOf(s) >= 0, '4: the re-deal did not promote the orphan itself');
            A(C[si].rec().watches.length === 1 && C[si].rec().watches[0].peer === m.pa,
              '4: a promoted orphan re-sourced to ' + JSON.stringify(C[si].rec().watches.map(x => x.peer)) + ' instead of the feeder');
            rows.push('4 orphan: both primaries gone, one call per generation, the server promoted '
                      + NAMES[si] + ' and it re-sourced straight to the feeder');
        }
        if(k === 7){
            // A player walks out. Leaving is losing, and a reported loss settles at once
            // rather than making eight people wait out the walkover ladder.
            await finish(m, { mode:'walkout', score:[2, 9] });
            A(srv.T.nodes[m.nid].winner === m.pb, '5: walking out did not hand the match to the opponent');
            rows.push('5 walk-out: leaving reported a loss and settled the node on the spot');
            continue;
        }
        if(k === 9){
            // Both players claim the win. The node freezes and every client is told.
            await finish(m, { mode:'contradict', score:[8, 8] });
            frozen = m.nid;
            await pump(1);
            for(let i = 0; i < N; i++){
                const t = C[i].tt();
                A(t.frozen === m.nid, '6: ' + NAMES[i] + ' did not surface the freeze (' + t.frozen + ')');
            }
            A(/FROZEN/.test(C[m.ia].msg()), '6: the frozen node showed "' + C[m.ia].msg() + '"');
            A(srv.T.cursor === m.nid, '6: a frozen node let the tournament walk on regardless');
            C[m.ia].setPhase('tourneyBracket'); C[m.ia].draw();
            srv.adminClear(m.nid, m.pa);                      // an operator settles it
            await pump(2);
            for(let i = 0; i < N; i++) A(C[i].tt().frozen === '', '6: ' + NAMES[i] + ' still shows a cleared node as frozen');
            rows.push('6 contradiction: both players claimed ' + m.nid + ', the node froze, all six surfaced it, '
                      + 'and an operator clearing it un-wedged the schedule');
            continue;
        }
        if(k === 11){
            // A player is backgrounded and never reports. The lone win is HELD, then stands
            // when the server's timer runs out -- no client invented the outcome.
            await finish(m, { mode:'silent', win:0, score:[6, 1] });
            A(srv.T.cursor === m.nid, '7: a lone win settled the node instantly instead of being held');
            clock(RESULT_MS + 1000);
            await pump(2);
            A(srv.T.nodes[m.nid].state === 'done' && srv.T.nodes[m.nid].winner === m.pa,
              '7: the held win never stood (' + srv.T.nodes[m.nid].state + ')');
            // The player comes back to a dead match. Tearing that down is the session
            // layer's job (_netSessionEnd), not the tournament's -- so do it here and check
            // the tournament picks the returning client back up.
            C[m.ib].inGame(false);
            await pump(1);
            rows.push('7 no-show: the peer never reported, the lone win was held for ' + (RESULT_MS / 1000)
                      + 's and then stood');
            continue;
        }
        await finish(m, { win: k % 3 === 0 ? 1 : (k % 5 === 0 ? 2 : 0), score:[5 + (k % 4), 2 + (k % 3)] });
    }
    A(played === 2 * N, '2: round 1 ran ' + played + ' matches, the formula says ' + (2 * N));
    A(frozen !== '', '6: the contradiction scenario never ran');
    rows.push('2 round 1: ' + played + ' matches at 2 hearts, every sheet agreed on all six clients, '
              + 'only the feeder offered, only the two players reported');

    // ---- the interstitial -------------------------------------------------
    for(let i = 0; i < N; i++){
        const t = C[i].tt();
        A(t.round === 2, '8: ' + NAMES[i] + ' is on round ' + t.round + ' after the standings');
        A(t.standings.length === N, '8: ' + NAMES[i] + ' holds ' + t.standings.length + ' standings rows');
        A(JSON.stringify(t.standings.map(x => x.id)) === JSON.stringify(srv.T.standings.map(x => x.id)),
          '8: ' + NAMES[i] + ' ranked the table differently from the server');
        A(JSON.stringify(t.advancers) === JSON.stringify(srv.T.advancers),
          '8: ' + NAMES[i] + ' disagrees about who advanced');
    }
    A(srv.T.advancers.length === Math.max(2, Math.ceil(N / 2)), '8: ' + srv.T.advancers.length + ' advancers from ' + N + ' players');
    rows.push('8 interstitial: standings fanned out identically to all six, '
              + srv.T.advancers.length + ' of ' + N + ' advanced, bracket dealt');

    // ---- the break, then the knockouts and the 3-heart final --------------
    await passBreak({ first:true });
    const ko = await node({});
    A(ko.nid === 'ko1.1' && srv.T.nodes[ko.nid].hm === 2, '9: ' + ko.nid + ' is not a 2-heart knockout');
    // Somebody who is not playing this one loses their signal stream for the whole of it.
    let deaf = 0;
    while(deaf === ko.ia || deaf === ko.ib || IDS[deaf] === srv.T.host) deaf++;
    await finish(ko, { win:0, score:[9, 3], miss:deaf });
    await passBreak({ missed:deaf, node:ko.nid, played:[ko.ia, ko.ib] });
    const fin = await node({});
    A(fin.nid === 'final', '9: the bracket reached ' + fin.nid + ' instead of a final');
    A(srv.T.nodes.final.hm === 3, '9: the final is at ' + srv.T.nodes.final.hm + ' hearts, not 3');
    A(srv.T.nodes['ko1.1'].lvl === 2 && srv.T.nodes.final.lvl === 3,
      '9: the ladder played the knockouts at levels ' + srv.T.nodes['ko1.1'].lvl + '/' + srv.T.nodes.final.lvl);
    A(C[fin.ia].sess(fin.pb, 'host').lvl0 === 3, '9: the final minted a session opening on level 1');
    A(C[fin.ia].sess(fin.pb, 'host').hearts === 3, '9: the final minted a 2-heart session');
    // The one event that says who won is one-shot and expires like any other. Somebody who
    // is not in the final is deaf for the whole of it, and this server never names a podium
    // in the read-back either -- so the only thing left to work it out from is the bracket.
    // A tournament somebody won must never read as one that voided.
    let blind = 0;
    while(blind === fin.ia || blind === fin.ib) blind++;
    srv.T.quiet = true;
    await finish(fin, { win:0, score:[11, 8], miss:blind });
    rows.push('9 knockouts: ko1.1 at 2 hearts on level 2 and the final at 3 hearts on level 3, '
              + 'both dressed from the sheet');

    // ---- the podium -------------------------------------------------------
    srv.mute(IDS[blind], false);
    await pump(2);
    const champ = srv.T.podium[0];
    const bp = C[blind].tt().podium;
    A(Array.isArray(bp) && bp[0] === champ,
      '10: ' + NAMES[blind] + ' missed the over event and holds podium ' + JSON.stringify(bp)
      + ' instead of a podium led by ' + NAMES[idx(champ)]);
    A(JSON.stringify(bp) === JSON.stringify(srv.T.podium),
      '10: the bracket works out ' + JSON.stringify(bp) + ', the server settled '
      + JSON.stringify(srv.T.podium));
    for(let i = 0; i < N; i++){
        A(C[i].phase() === 'tourneyPodium', '10: ' + NAMES[i] + ' ended on ' + C[i].phase());
        const t = C[i].tt();
        A(t.state === 'done' && JSON.stringify(t.podium) === JSON.stringify(srv.T.podium),
          '10: ' + NAMES[i] + ' holds podium ' + JSON.stringify(t.podium));
        C[i].draw();
        const r = C[i].rows();
        // ONE row, where BACK sits: there is nothing left to leave, so letting go of the
        // picture and stepping off the screen are the same press.
        A(r.length === 1 && r[0].t === 'DONE', '10: a finished tournament offers ' + r.map(x => x.t).join('/'));
    }
    srv.T.quiet = false;
    C[0].pick('DONE');
    A(C[0].tt() === null && C[0].phase() === 'duelMenu', '10: DONE did not let go of the finished tournament');
    rows.push('10 podium: ' + NAMES[idx(champ)] + ' took it, all six landed on the podium screen '
              + '(' + NAMES[blind] + ' off the bracket alone, having heard nothing), DONE let go');

    // ---- what a client must REFUSE to do ----------------------------------
    // Every one of these is a signal a client could receive and must not act on.
    const spec = C[2], me = IDS[2];
    const tid = srv.T.tid;
    spec.clear();
    const before = spec.tt();
    spec.sigTo({ event:'roles', tid:'0'.repeat(32), nid:'r9.9', round:9, hm:3, players:[IDS[0], IDS[1]],
                 feeder:IDS[0], primaries:[me], secondaries:[], you:'play' });
    A(JSON.stringify(spec.tt()) === JSON.stringify(before), '11: a sheet for another tournament changed our picture');
    A(spec.rec().offers.length === 0 && spec.rec().watches.length === 0, '11: a sheet for another tournament made us connect');

    // A sheet that benches us: no ceremony, no connection, nothing to report.
    C[3].clear();
    C[3].sigTo({ event:'roles', tid:C[3].tt() ? C[3].tt().tid : tid, nid:'x1', round:2, hm:2,
                 players:[IDS[0], IDS[1]], feeder:IDS[0], primaries:[IDS[4]], secondaries:[], you:'idle' });
    C[3].tick();
    await settleAsync();
    A(C[3].phase() !== 'tourneyCeremony', '11: an idle sheet opened a ceremony');
    A(C[3].rec().offers.length === 0 && C[3].rec().watches.length === 0, '11: an idle sheet made us connect');

    // A spectator's result is refused by the server, and a spectator never sends one anyway:
    // over the whole tournament not one result post came from outside a match.
    const bad = srv.refused.filter(x => x.action === 'result');
    A(bad.length === 0, '11: ' + bad.length + ' result posts were refused -- a client sent one it had no business sending');
    const outsiders = srv.log.filter(x => x.action === 'result' &&
        srv.T.nodes[x.nid] && srv.T.nodes[x.nid].players.indexOf(x.id) < 0);
    A(outsiders.length === 0, '11: ' + outsiders.length + ' results came from a non-player');
    rows.push('11 refusals: a sheet for another tournament and a sheet that benches us both '
              + 'changed nothing; not one result was reported by anyone who was not playing');

    // ---- 12. the node states that never produce a match ------------------------------
    // A bye, a void and a freeze all close a node without two players ever meeting, and the
    // bracket has to say so: they used to render exactly like a match still awaiting its
    // turn, which is the one thing they are not. The line is a pure function of one node,
    // so it is checked as one, against the shape projectNodes() actually sends.
    const L = nd => C[0].line(nd);
    A(L({ nid:'ko1.1', players:[IDS[0], null], state:'settled', winner:IDS[0], draw:false, score:null })
        .indexOf('BYE') > 0, '12: a node with one empty slot did not read as a bye');
    A(L({ nid:'ko1.2', players:[null, IDS[1]], state:'settled', winner:IDS[1], draw:false, score:null })
        .indexOf('BYE') > 0, '12: a bye in the other slot did not read as one');
    A(L({ nid:'ko2.1', players:[null, null], state:'void', winner:null, draw:false, score:null })
        .indexOf('VOID') === 0, '12: a void node did not say it was void');
    A(L({ nid:'ko2.2', players:[IDS[0], IDS[1]], state:'frozen', winner:null, draw:false, score:null })
        .indexOf('FROZEN') > 0, '12: a frozen node did not say it was frozen');
    const pend = L({ nid:'final', players:[IDS[0], IDS[1]], state:'pending', winner:null, draw:false, score:null });
    A(pend.indexOf('BYE') < 0 && pend.indexOf('VOID') < 0 && pend.indexOf('FROZEN') < 0,
      '12: an ordinary pending node picked up a terminal label');
    rows.push('12 node states: bye, void and frozen each read as themselves; a pending node still reads as a pairing');

    // ---- 13. a sheet engaged AFTER the offer it authorises ---------------------------
    // _ttRoles never engages a sheet where it lands: the previous match has to be off the
    // board first, so engagement waits for a tick. The feeder offers the moment IT engages,
    // which can be a whole tick sooner -- or the very same signal drain, where our sheet is
    // parked and the offer answered a few lines later. Either way the answerer can mint its
    // session before it holds the sheet, and that session still has to end up carrying it:
    // the go repairs hearts and stakes on its own, but only a preset can REFUSE a wrong one,
    // and p2p-only has no wire representation at all. The peer here is a stranger id, so no
    // leftover _ttWant from the tournament above can dress the session early by accident.
    const late = C[4], lp = 'aaaa1234';
    late.clear();
    late.inGame(true);                 // the previous match is still on the board
    late.sigTo({ event:'roles', tid:late.tt().tid, nid:'late1', round:9, hm:2, stakes:false,
                 players:[lp, IDS[4]], feeder:lp, primaries:[], secondaries:[], you:'play' });
    let ls = late.mint(lp, 'guest');   // the offer lands first and is answered
    A(ls && ls.heartsWant === null && ls.stakesWant === null && ls.stakes === true && !ls.p2pOnly,
      '13: the session was dressed before the sheet was engaged -- there is no window left to test');
    late.inGame(false);
    late.tick();
    ls = late.sessNow();
    A(ls && ls.hearts === 2 && ls.heartsWant === 2,
      '13: engaging the sheet left the live session at ' + (ls && ls.hearts) + ' hearts');
    A(ls && ls.stakes === false && ls.stakesWant === false,
      '13: engaging the sheet left the live session playing for the wrong stakes');
    A(ls && ls.p2pOnly === true, '13: engaging the sheet left the live session relay-capable');
    rows.push('13 late sheet: a session minted before its roles sheet was engaged is dressed when it lands');

    // ---- 14. a finished-match stamp must not outlive its match -----------------------
    // _ttClearMatch is not the only way a duel leaves the board: a key pressed on the over
    // screen, a peer's bye and a dead connection all clear it without telling tourney.js.
    // The "a finished match is still on screen" stamp then belonged to a match that was
    // already gone, and the NEXT match inherited it -- and was torn down as a finished one
    // while it was being played, a few seconds after it started.
    const st = C[5];
    st.clear();
    st.inGame(true);                   // a match on the board, the way the last one ended
    st.sigTo({ event:'roles', tid:st.tt().tid, nid:'stale1', round:9, hm:2, stakes:false,
               players:[IDS[0], IDS[1]], feeder:IDS[0], primaries:[], secondaries:[], you:'idle' });
    st.endMatch('host', IDS[0], 0, [3, 1]);   // the sim declares it over: the stamp is made
    st.exit();                               // ...and the player walks off the over screen
    A(!st.live() && st.rec().exits === 1, '14: the walk-off did not take the match off the board');
    st.tick();
    st.inGame(true);                   // the NEXT match is live
    clock(TT_OVER_MS + 1000);
    st.tick();
    A(st.live() && st.rec().exits === 1,
      '14: a stamp from the previous match tore down the next one mid-play');
    st.inGame(false);
    rows.push('14 stale over-stamp: a match left by any other route does not take the next one down with it');

    // ---- 15. the stage token is the SERVER's, the WORDING is ours --------------------
    // `stage` is a token and never a caption: the server has no idea what language this
    // client is reading, and a client that renders an unknown token as nothing leaves a
    // headline blank on the one screen that exists to say what is about to be played.
    const S = (tok, r) => C[1].stage(tok, r);
    A(S('group', 1) === 'GROUP STAGE' && S('quarter', 2) === 'QUARTERS'
      && S('semi', 3) === 'SEMI FINALS' && S('final', 4) === 'THE FINAL',
      '15: a named stage read as ' + [S('group', 1), S('quarter', 2), S('semi', 3), S('final', 4)].join('/'));
    A(S('ko', 3) === 'ROUND 3', '15: a round of 16 read as "' + S('ko', 3) + '"');
    A(S('octofinal', 7) === 'ROUND 7' && S('', 2) === 'ROUND 2' && S(null, 5) === 'ROUND 5',
      '15: an unknown token did not fall back to a plain round number');
    rows.push('15 stage tokens: the four named stages read as themselves, and anything else -- '
              + 'including a token a newer server invents -- reads as a plain round number');

    // ---- 16. a result names the match that was PLAYED --------------------------------
    // The server deals the next node the instant a result settles, so from then until the
    // finished match leaves the screen the client holds TWO nodes: the one on the board and
    // the one just dealt. Reporting against the second is reporting on a match that has not
    // been played -- and walking off the over screen did exactly that, forfeiting the next
    // node before its ceremony had even connected.
    const rp = C[4];
    rp.clear();
    const rtid = rp.tt().tid;
    const sheet = (nid, you) => ({ event:'roles', tid:rtid, nid, round:9, stage:'ko', lvl:1, hm:2,
                                   stakes:false, players:[IDS[0], IDS[4]], feeder:IDS[0],
                                   primaries:[], secondaries:[], names:{}, you });
    rp.inGame(false);
    rp.sigTo(sheet('played', 'play'));
    rp.tick();                                   // the sheet engages: this node owns the board
    A(rp.playNid() === 'played', '16: the engaged node did not take the board, got "' + rp.playNid() + '"');
    rp.inGame(true);
    rp.sigTo(sheet('dealt', 'play'));            // the NEXT node, dealt while we are still playing
    A(rp.playNid() === 'played',
      '16: a sheet for the next node moved the board under the live match, to "' + rp.playNid() + '"');
    rp.walkOut('peer', IDS[0], [2, 5]);          // ESC on the over screen
    const res = rp.rec().posts.filter(p => p.action === 'result');
    A(res.length === 1 && res[0].nid === 'played' && res[0].outcome === 'loss',
      '16: walking out reported ' + JSON.stringify(res.map(p => p.nid + '/' + p.outcome)));
    rp.inGame(false); rp.tick();                 // the board clears, the dealt node engages
    A(rp.playNid() === 'dealt', '16: the node dealt during the match never took the board');
    rp.inGame(false); rp.clear();
    rows.push('16 report binding: a result names the node whose match was on the board, never the '
              + 'one dealt while it was still up -- walking out cannot forfeit the next match');

    // ---- 17. an offer that arrives mid-over-screen is kept, not dropped ---------------
    // THE HANG. The feeder offers the instant it engages; its peer may still be looking at
    // the previous match's over screen, where net-session refuses every offer because a live
    // game owns the session. Signals are one-shot, so that offer is the only one there will
    // be for the next 20 seconds -- and the answerer, which never offers, sat on CONNECTING
    // for a match whose invitation had already been delivered and thrown away.
    const pk = C[3];
    pk.clear();
    pk.inGame(true);                             // the last match is still on the board
    pk.sigTo({ event:'roles', tid:pk.tt().tid, nid:'park1', round:9, stage:'ko', lvl:1, hm:2,
               stakes:false, players:[IDS[0], IDS[3]], feeder:IDS[0], primaries:[],
               secondaries:[], names:{}, you:'play' });   // players[0] feeds: we answer
    pk.sigRaw('offer', IDS[0], { sdp:{ type:'offer', sdp:'v=0 park' }, seed:77 });
    A(pk.rec().answers.length === 0 && pk.rec().offers.length === 0,
      '17: the offer was acted on while a match still held the board');
    pk.inGame(false);
    pk.tick();                                   // the board clears: the sheet engages
    const ans = pk.rec().answers;
    A(ans.length === 1 && ans[0].peer === IDS[0] && ans[0].seed === 77,
      '17: the parked offer was never answered, got ' + JSON.stringify(ans));
    A(pk.rec().offers.length === 0, '17: the answerer offered as well -- both sides would offer');
    pk.clear();
    rows.push('17 parked offer: an offer that lands while the previous match is still on the '
              + 'board is answered the moment it clears, instead of being lost for good');

    // ---- 18. THE RECOVERY LADDER IS NOT A PROPERTY OF THE SCREEN ---------------------
    // The re-offer ladder and the walkover it ends in used to run only while the ceremony
    // itself was the screen in front of the player, so anything that took that screen away
    // silently removed both -- and the node hung for the whole tournament, not just for the
    // client that moved. A spectator pressing ESC to read the board, a player opening the
    // leave dialog, a reload landing back on the bracket: the match is being set up either
    // way, and the client that owes the offer owes it from wherever it is standing.
    const es = C[2];
    es.clear(); es.inGame(false);
    es.sigTo({ event:'roles', tid:es.tt().tid, nid:'esc1', round:9, stage:'ko', lvl:1, hm:2,
               stakes:false, players:[IDS[2], IDS[0]], feeder:IDS[2], primaries:[],
               secondaries:[], names:{}, you:'play' });   // we feed, so we offer
    es.tick();
    A(es.phase() === 'tourneyCeremony' && es.rec().offers.length === 1,
      '18: the ceremony did not open with an offer');
    es.setPhase('tourneyBracket');                        // the ceremony stops being the screen
    for(let t = 1; t < TT_CONNECT_TRIES; t++){
        clock(TT_CONNECT_MS + 1000); es.tick(); es.tick();
        A(es.rec().offers.length === t + 1,
          '18: re-offer ' + t + ' never happened away from the ceremony (' + es.rec().offers.length + ' offers)');
    }
    clock(TT_CONNECT_MS + 1000); es.tick();
    A(es.msg() === 'MATCH DID NOT CONNECT',
      '18: the ladder never gave the node back to the server, msg "' + es.msg() + '"');
    A(es.playNid() === '', '18: a match that never connected still holds the board');
    // ...and a ceremony that DID become a match leaves nothing behind for the ladder to trip
    // over: the quiet after a match that played is not a match that failed to connect.
    es.clrMsg(); es.clear();
    es.sigTo({ event:'roles', tid:es.tt().tid, nid:'esc2', round:9, stage:'ko', lvl:1, hm:2,
               stakes:false, players:[IDS[2], IDS[0]], feeder:IDS[2], primaries:[],
               secondaries:[], names:{}, you:'play' });
    es.tick();
    es.inGame(true); es.tick();                           // the match goes live
    es.inGame(false); es.setPhase('tourneyBracket');      // ...and ends, back to the bracket
    clock(TT_CONNECT_MS * 2); es.tick(); es.tick();
    A(es.rec().offers.length === 1 && es.msg() === '',
      '18: the ladder fired again after a match that had already played, msg "' + es.msg() + '"');
    es.clear();
    rows.push('18 the recovery ladder is not a property of the screen: leaving the ceremony keeps both the '
              + 're-offer ladder and the walkover that ends it, and a match that played arms neither');

    // ---- 19. a watcher's ladder never ends ------------------------------------------
    // The connect ladder ends in a walkover: four tries, then the node goes back to the
    // server. That verdict belongs to a PLAYER, who owes somebody a result. A watcher owes
    // nobody anything, and the match it cannot reach is most likely being played perfectly
    // well by the two people in it. Failing its ladder dropped it out of the ceremony and
    // onto the standings for the rest of the node -- one client stuck on the bracket while
    // the other spectator watched the same match without trouble.
    es.clrMsg(); es.clear(); es.inGame(false); es.setPhase('tourneyBracket');
    es.sigTo({ event:'roles', tid:es.tt().tid, nid:'spec1', round:9, stage:'ko', lvl:1, hm:2,
               stakes:false, players:[IDS[0], IDS[1]], feeder:IDS[0], primaries:[],
               secondaries:[IDS[2]], names:{}, you:'spectate' });
    es.tick();
    A(es.rec().watches.length === 1,
      '19: the sheet asked ' + es.rec().watches.length + ' nodes for a feed instead of the feeder');
    for(let t = 1; t <= TT_CONNECT_TRIES + 1; t++){
        clock(TT_CONNECT_MS + 1000); es.tick(); es.tick();
        A(es.rec().watches.length === t + 1,
          '19: re-ask ' + t + ' never happened (' + es.rec().watches.length + ' asks)');
        A(es.msg() !== 'MATCH DID NOT CONNECT',
          '19: a watcher declared the match dead after ' + t + ' unanswered asks');
        A(es.playNid() === '', '19: a spectated node took the board');
    }
    A(es.msg() === 'STILL LOOKING FOR A FEED',
      '19: the watcher sat on a ceremony that had stopped meaning anything, msg "' + es.msg() + '"');
    es.clrMsg(); es.clear();
    rows.push('19 watcher ladder: a spectator that cannot reach the feed keeps asking and says '
              + 'so, where a player hands the node back after four tries');

    // ---- 20+21) the leave dialog, and the way back into a tournament left behind ------
    // A SECOND world, because both of these need a tournament that is RUNNING and the one
    // above has been played to its podium. Three clients, started and then left alone: what
    // is under test here is the tournament SCREENS, not another bracket.
    {
        const W = mkWorld(IDS.slice(0, 3), NAMES.slice(0, 3));
        const [H, G, R] = W.C;                         // host, guest, and the one who reloads
        for(const c of W.C){ c.setPhase('tourneyLobby'); c.enter(); }
        await W.settleAsync();
        await H.pick('CREATE TOURNAMENT');
        await W.settleAsync();
        const code2 = H.tt().code;
        for(const c of [G, R]){ await c.join(code2); await W.settleAsync(); }
        await W.pump(1);
        await H.pick('START TOURNAMENT');
        await W.settleAsync();
        await W.pump(1);
        const tid2 = H.tt().tid;
        A(H.tt().state === 'running', '20: the second world never started (' + H.tt().state + ')');

        // ---- 20) the dialog is a QUESTION, and the tournament may not answer it ---------
        // The reported bug exactly: the confirmation appeared and was gone again before a
        // second press, with nothing pressed in between. Every tournament screen follows the
        // tournament as it moves, and the dialog had been made one of them.
        for(const c of W.C){ c.inGame(false); c.clrMsg(); c.clear(); }
        // A guard that reads the QUESTION instead of the screen under it gets this wrong in
        // the other direction too: tourneyRound is the one screen the standings are NOT
        // allowed to move on from, because it is a match on the board -- and with the dialog
        // up, the name the guard reads is the dialog's own.
        H.setPhase('tourneyRound');
        H.pick('BACK - END TOURNAMENT FOR ALL');
        H.sigTo({ event:'standings', tid:tid2, rows:[], advancers:[] });
        await W.settleAsync();
        A(H.phase() === 'tourneyQuit' && H.from() === 'tourneyRound',
          '20: standings pulled a backdrop that was a match on the board (' + H.from() + ')');
        H.key('back');
        A(H.phase() === 'tourneyRound', '20: NO left the match on the board behind');

        // Asked from the ceremony, which is where a host between matches actually stands --
        // and unlike tourneyRound it is a screen the standings are allowed to move on from,
        // so the backdrop below has somewhere to go.
        H.setPhase('tourneyCeremony');
        A(H.has('BACK - END TOURNAMENT FOR ALL'), '20: the host is not offered the ending mid-run');
        A(G.has('BACK - LEAVE TOURNAMENT'), '20: a guest mid-run is not offered a leave');
        H.pick('BACK - END TOURNAMENT FOR ALL');
        A(H.phase() === 'tourneyQuit' && H.from() === 'tourneyCeremony',
          '20: the ending was not asked about (' + H.phase() + ' from ' + H.from() + ')');

        // The poll. This is the one that did it: _ttSync runs off a timer, so the dialog was
        // overwritten within one cadence of opening it.
        W.clock(TT_STATE_MS + 1000); H.tick(); await W.settleAsync();
        A(H.phase() === 'tourneyQuit', '20: a state poll answered the question by itself (now ' + H.phase() + ')');
        // ...and a signal, which arrives on nobody's schedule at all.
        H.sigTo({ event:'standings', tid:tid2, rows:[], advancers:[] });
        await W.settleAsync();
        A(H.phase() === 'tourneyQuit', '20: a standings signal took the question off the screen');
        A(H.from() === 'tourneyBracket',
          '20: the screen BEHIND the question never moved with the tournament (' + H.from() + ')');
        // ...and a fresh roles sheet, which is the tournament moving on of its own accord.
        H.sigTo({ event:'roles', tid:tid2, nid:'m9', round:2, stage:'ko', lvl:1, hm:2,
                  stakes:false, players:[IDS[1], IDS[2]], feeder:IDS[1], primaries:[],
                  secondaries:[IDS[0]], names:{}, you:'spectate' });
        H.tick(); await W.settleAsync();
        A(H.phase() === 'tourneyQuit', '20: a roles sheet took the question off the screen');
        A(H.from() === 'tourneyCeremony',
          '20: the backdrop did not follow the tournament on to the ceremony (' + H.from() + ')');
        H.draw();                                      // the moved backdrop still paints

        // NO is "carry on", and carrying on means the tournament as it stands NOW.
        H.key('back');
        A(H.phase() === 'tourneyCeremony', '20: NO did not return to the screen behind the question');

        // The one re-point that is still allowed through, because it leaves nothing to ask:
        // a tournament that is over is not one anybody can be asked about leaving.
        G.setPhase('tourneyRound'); G.pick('BACK - LEAVE TOURNAMENT');
        A(G.phase() === 'tourneyQuit', '20: the guest leave was not asked about');
        G.sigTo({ event:'over', tid:tid2, podium:[IDS[0], IDS[1], IDS[2]] });
        await W.settleAsync();
        A(G.phase() === 'tourneyPodium', '20: a finished tournament left its leave dialog standing');

        // ---- 21) the way back in -------------------------------------------------------
        // Walking OUT of the screens is not leaving: the id stays on disk, and a reload --
        // which is what actually happens when somebody puts the phone down -- has to find it.
        A(R.held() === tid2, '21: a joined tournament was never written down (' + R.held() + ')');
        R.setPhase('duelMenu');
        A(R.held() === tid2, '21: stepping off the screens threw the way back away');
        R.forget();
        R.setPhase('tourneyLobby');
        await R.probe();
        await W.settleAsync();
        A(R.back() && R.back().tid === tid2, '21: the probe did not find the tournament on disk');
        const rr = R.rows();
        A(rr[0].t === 'REJOIN TOURNAMENT' && rr[0].en && rr[0].note === code2,
          '21: the way back is not the first row of the list (' + rr.map(x => x.t).join('/') + ')');
        R.draw();
        R.pick('REJOIN TOURNAMENT');
        await W.settleAsync();
        A(R.tt() && R.tt().tid === tid2 && R.tt().state === 'running',
          '21: rejoining did not put the tournament back');
        A(R.rows().some(x => x.t === 'BACK - LEAVE TOURNAMENT'), '21: the rejoined client is not really in it');

        // And a door that must not be offered: a tournament this device is no longer part of
        // forgets itself on the probe rather than showing a row that cannot be walked through.
        R.forget();
        W.srv.T.state = 'done';
        await R.probe();
        await W.settleAsync();
        A(R.back() === null && R.held() === '',
          '21: a finished tournament kept offering a way back into itself');
        A(R.rows()[0].t === 'CREATE TOURNAMENT', '21: REJOIN outlived the tournament it pointed at');
        W.srv.T.state = 'running';

        // ---- 20, the last answer: YES ends it, everywhere ------------------------------
        H.setPhase('tourneyRound'); H.pick('BACK - END TOURNAMENT FOR ALL');
        A(H.phase() === 'tourneyQuit', '20: the ending was not asked about the second time');
        await H.key('confirm', 0);                     // 0 is YES
        await W.settleAsync();
        A(H.tt() === null && H.held() === '', '20: YES did not end the tournament for the host');
        A(H.phase() === 'tourneyLobby', '20: the host was left on a screen for a tournament it left');
    }
    rows.push('20 leave dialog: a state poll, a standings signal and a roles sheet all reason '
              + 'about the screen BEHIND the confirmation instead of the confirmation -- moving '
              + 'it where they should and leaving a match on the board alone -- NO returns to it, '
              + 'YES ends the tournament, and one that finishes underneath still takes it down');
    rows.push('21 the way back: walking off the screens keeps the id, a reload finds it through '
              + 'the probe and REJOIN is the first row, and a tournament that has ended forgets it');

    console.log(rows.join('\n'));
    if(fails){ console.log('\nTOURNEY-E2E FAIL: ' + fails + ' assertion(s)'); process.exit(1); }
    console.log('\nTOURNEY-E2E PASSED');
})().catch(e => { console.log(rows.join('\n')); console.log('\nTOURNEY-E2E FAIL: ' + (e && e.stack || e)); process.exit(1); });
