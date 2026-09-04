// TOURNAMENT END TO END (HEAVY suite). Six real clients, one scripted server, one
// tournament played from the join code to the podium.
//
// WHAT THIS SUITE IS FOR. duel-spec.js and duel-spec-tree.js already prove the two hard
// things underneath a tournament: that a spectator's world is bit-for-bit the players'
// world, and that the relay tree survives its nodes dying. Neither of them knows what a
// tournament is. This one owns the layer above: the ROLES SHEET turning into a connection,
// the result ladder, and every rule about who may do what -- driven through the real
// hello/signal drain, the real _netPostRes, the real session minting and the real screens.
//
// THE CLIENTS ARE REAL. Each is a full harness sandbox with the whole game loaded. The only
// things replaced are the four seams that need hardware we do not have: fetch (routed into
// the scripted server), _netRtcOffer and _netSignal (recorded), and _duelExit (the sim
// teardown a headless client cannot run). Everything else -- tourney.js, net-api.js's hello,
// net-session.js's signal dispatch, net-rtc.js's _netMkSess, net-spec.js's grant/standdown/
// orphan logic, screens.js's four tournament screens -- is the shipping code.
//
// THE SERVER IS A STAND-IN, and deliberately so: it is the CONTRACT written out as data
// (docs/API.md's tournament section), not FOK-server's implementation. The bracket
// arithmetic it performs is FOK-server's to get right and unit.php's to prove; what matters
// here is that a client handed these events behaves. So every assertion below is about a
// CLIENT: what it connected to, what it reported, what it drew, and -- just as often --
// what it refused to do.
//
// Run: node test/tourney-e2e.js
const { runInGame } = require('./harness');

const IDS   = ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004', 'aaaa0005', 'aaaa0006'];
const NAMES = ['KAI', 'JO', 'ADA', 'LEO', 'MIA', 'ZED'];
const N = IDS.length;
const RESULT_MS = 15000;      // tournament_result_ms: how long a lone win is held
const MAX_DIRECT = 2;         // SPEC_MAX_DIRECT, quoted so the expectation is readable here

const rows = [];
let fails = 0;
const A = (c, m) => { if(!c){ rows.push('FAIL: ' + m); fails++; } };

// ============================================================================
// THE SCRIPTED SERVER
// One tournament, held as plain data. Every response and every event is exactly the shape
// docs/API.md documents, because that shape is the only thing the client is entitled to.
// ============================================================================
function mkServer(){
    const T = { tid:'7f3c9a21b4d85e60c1f2a3b4c5d6e7f8', code:'K7MZ4Q', host:'', stakes:false,
                max:10, state:'open', players:[], round:0, cursor:null,
                nodes:{}, order:[], standings:[], advancers:[], podium:null };
    const out = {};                 // player id -> queued signals, drained by hello
    const names = {};               // the server's own player table
    const log = [];                 // every ACCEPTED post: {id, action, nid}
    const refused = [];             // every refusal: {id, action, status}
    let NOW = 100000;

    const ok   = (o) => ({ status:200, json:Object.assign({ ok:true }, o || {}) });
    const bad  = (st, err) => ({ status:st, json:{ ok:false, error:err } });
    const q    = (id, d) => { (out[id] || (out[id] = [])).push({ type:'tourney', from:'', payload:JSON.stringify(d) }); };
    const all  = (d) => { for(const p of T.players) q(p.id, d); };
    const ids  = () => T.players.map(p => p.id);
    const seat = (id) => { for(const p of T.players) if(p.id === id) return p.seat; return -1; };

    // ---- the schedule -------------------------------------------------------
    // Round 1 is SPARSE above four players: every pair up to 4, then the two circulant
    // offsets, which is the 2N the lobby quotes. Round 1 and every knockout but the final
    // are played at 2 hearts; the final is an ordinary 3-heart duel.
    function schedule(){
        const p = ids(), n = p.length, out2 = [];
        if(n <= 4){ for(let i = 0; i < n; i++) for(let j = i + 1; j < n; j++) out2.push([p[i], p[j]]); }
        else for(const off of [1, 2]) for(let i = 0; i < n; i++) out2.push([p[i], p[(i + off) % n]]);
        return out2;
    }
    function mkNode(nid, round, hm, pl){
        T.nodes[nid] = { nid, round, hm, players:pl, state:'pending', winner:null, draw:false,
                         score:null, reports:{}, heldAt:0, excl:{} };
        return nid;
    }
    function summary(nd){
        return { nid:nd.nid, round:nd.round, hm:nd.hm, players:nd.players.slice(),
                 state:nd.state, winner:nd.winner, draw:nd.draw, score:nd.score };
    }
    function nodesOfRound(r){ return T.order.filter(nid => T.nodes[nid].round === r).map(nid => summary(T.nodes[nid])); }

    // ---- roles --------------------------------------------------------------
    // feeder = players[0], always. The two watchers at the head of the list serve the
    // relay tree's first tier; everyone after them hangs off those two.
    function tree(nd){
        const watchers = ids().filter(x => nd.players.indexOf(x) < 0);
        const primaries = watchers.filter(x => !nd.excl[x]).slice(0, MAX_DIRECT);
        return { primaries, secondaries: watchers.filter(x => primaries.indexOf(x) < 0) };
    }
    function sheet(nid, forId){
        const nd = T.nodes[nid], t = tree(nd);
        const round = T.order.filter(x => T.nodes[x].round === nd.round);
        return { event:'roles', tid:T.tid, round:nd.round, match:round.indexOf(nid) + 1, of:round.length,
                 nid, hm:nd.hm, stakes:T.stakes, players:nd.players.slice(), feeder:nd.players[0],
                 primaries:t.primaries, secondaries:t.secondaries, names:Object.assign({}, names),
                 you: nd.players.indexOf(forId) >= 0 ? 'play' : (t.primaries.indexOf(forId) >= 0 || t.secondaries.indexOf(forId) >= 0 ? 'spectate' : 'idle') };
    }
    function deal(nid){
        T.cursor = nid; T.round = T.nodes[nid].round; T.nodes[nid].state = 'live';
        for(const p of T.players) q(p.id, sheet(nid, p.id));
    }
    function patch(nid){
        const t = tree(T.nodes[nid]);
        all({ event:'roles-patch', tid:T.tid, nid, primaries:t.primaries, secondaries:t.secondaries });
    }

    // ---- settling -----------------------------------------------------------
    function standings(){
        const pts = {}, diff = {};
        for(const id of ids()){ pts[id] = 0; diff[id] = 0; }
        for(const nid of T.order){
            const nd = T.nodes[nid];
            if(nd.round !== 1 || nd.state !== 'done') continue;
            const [a, b] = nd.players, sc = nd.score || [0, 0];
            diff[a] += sc[0] - sc[1]; diff[b] += sc[1] - sc[0];
            if(nd.draw){ pts[a] += 0.5; pts[b] += 0.5; }
            else if(nd.winner) pts[nd.winner] += 1;
        }
        const rank = ids().slice().sort((x, y) => (pts[y] - pts[x]) || (diff[y] - diff[x]) || (seat(x) - seat(y)));
        T.standings = rank.map((id, i) => ({ seat:seat(id), id, pts:pts[id], diff:diff[id], rank:i + 1 }));
        T.advancers = rank.slice(0, Math.max(2, Math.ceil(ids().length / 2)));
    }
    // Three advancers: the two below the top seed meet, and the winner meets the top seed
    // in the final. The final's second slot is filled once ko1.1 settles.
    function buildKo(){
        const a = T.advancers;
        T.order.push(mkNode('ko1.1', 2, 2, [a[1], a[2]]));
        T.order.push(mkNode('final', 3, 3, [a[0], null]));
    }
    function settle(nid, winner, draw, score){
        const nd = T.nodes[nid];
        nd.state = 'done'; nd.winner = winner; nd.draw = !!draw; nd.score = score;
        all({ event:'result', tid:T.tid, nid, winner, draw:!!draw, score });
        advance();
    }
    function advance(){
        const i = T.order.indexOf(T.cursor);
        const fin = T.nodes['final'];
        if(fin && !fin.players[1] && T.nodes['ko1.1'].state === 'done') fin.players[1] = T.nodes['ko1.1'].winner;
        if(i + 1 < T.order.length){ deal(T.order[i + 1]); return; }
        if(T.round === 1){
            standings();
            all({ event:'standings', tid:T.tid, rows:T.standings, advancers:T.advancers });
            buildKo(); deal('ko1.1'); return;
        }
        T.state = 'done'; T.cursor = null;
        const f = T.nodes['final'], k = T.nodes['ko1.1'];
        T.podium = [f.winner, f.players[f.players[0] === f.winner ? 1 : 0], k.players[k.players[0] === k.winner ? 1 : 0]];
        all({ event:'over', tid:T.tid, podium:T.podium });
    }
    // The result ladder. A reported LOSS settles at once. A lone win or draw is HELD: the
    // peer may still agree, contradict, or never speak. Contradiction freezes the node.
    function report(id, nid, outcome, score){
        const nd = T.nodes[nid];
        if(!nd) return bad(404, 'no such node');
        if(nd.players.indexOf(id) < 0) return bad(403, 'not your match');
        if(nd.state === 'done' || nd.state === 'frozen') return ok();     // a replay is a no-op
        if(nid !== T.cursor) return bad(409, 'not the current node');
        const me = nd.players.indexOf(id), peer = nd.players[1 - me];
        // Reports arrive as [own, opponent]; the node holds them in players[] order.
        const sc = me === 0 ? [score[0] | 0, score[1] | 0] : [score[1] | 0, score[0] | 0];
        nd.reports[id] = { outcome, sc };
        if(outcome === 'loss'){ settle(nid, peer, false, sc); return ok(); }
        const other = nd.reports[peer];
        if(!other){ nd.heldAt = NOW; return ok({ held:true }); }
        if(outcome === 'draw' && other.outcome === 'draw'){ settle(nid, null, true, sc); return ok(); }
        if(outcome === 'win' && other.outcome === 'loss'){ settle(nid, id, false, sc); return ok(); }
        nd.state = 'frozen';
        all({ event:'freeze', tid:T.tid, nid });
        return ok({ frozen:true });
    }
    // The lazy deadline: nobody's timer, just the next request to arrive after it passed.
    function deadlines(){
        const nd = T.cursor ? T.nodes[T.cursor] : null;
        if(!nd || nd.state !== 'live' || !nd.heldAt || NOW - nd.heldAt < RESULT_MS) return false;
        for(const id of nd.players){
            const r = nd.reports[id];
            if(!r) continue;
            if(r.outcome === 'draw') settle(nd.nid, null, true, r.sc);
            else settle(nd.nid, id, false, r.sc);
            return true;
        }
        return false;
    }

    const srv = {
        T, log, refused,
        now(v){ NOW = v; },
        name(id, n){ names[id] = n; },
        deadlines,
        // An operator clearing a frozen node from the admin surface.
        adminClear(nid, winner){ const nd = T.nodes[nid]; nd.state = 'live'; settle(nid, winner, false, nd.score || [0, 0]); },
        post(url, body){
            if(/hello\.php$/.test(url)){
                const id = String(body.id || ''), sigs = out[id] || [];
                out[id] = [];
                const r = { ok:true, api:'4.1', now:Date.now(), online:N, playing:0,
                            friends_playing:{}, signals:sigs };
                if(body.tourneys) r.tourneys = (T.state === 'open' && T.players.length && ids().indexOf(id) < 0)
                    ? [{ tid:T.tid, code:T.code, host:T.host, host_name:names[T.host] || '?',
                         players:T.players.length, max:T.max, stakes:T.stakes }] : [];
                return { status:200, json:r };
            }
            if(!/tournament\.php$/.test(url)) return bad(404, 'no such endpoint');
            const id = String(body.id || ''), act = String(body.action || '');
            const note = (r) => { if(r.status === 200) log.push({ id, action:act, nid:body.nid || '' });
                                  else refused.push({ id, action:act, status:r.status }); return r; };
            deadlines();
            switch(act){
                case 'create':
                    if(T.state !== 'open' || T.players.length) return note(bad(409, 'you already host one'));
                    T.host = id; T.stakes = !!body.stakes;
                    T.players = [{ id, name:names[id] || '?', seat:0 }];
                    return note(ok({ tid:T.tid, code:T.code, stakes:T.stakes, max:T.max }));
                case 'join': {
                    if(body.tid && body.tid !== T.tid) return note(bad(404, 'no such tournament'));
                    if(body.code && String(body.code).toUpperCase() !== T.code) return note(bad(404, 'no such tournament'));
                    if(ids().indexOf(id) >= 0) return note(ok({ tid:T.tid, code:T.code, stakes:T.stakes, max:T.max,
                                                               players:T.players.map(p => ({ id:p.id, name:p.name })), host:T.host, state:T.state }));
                    if(T.state !== 'open') return note(bad(409, 'already started'));
                    if(T.players.length >= T.max) return note(bad(409, 'tournament is full'));
                    T.players.push({ id, name:names[id] || '?', seat:T.players.length });
                    all({ event:'lobby', tid:T.tid, code:T.code, host:T.host, state:T.state, stakes:T.stakes,
                          max:T.max, players:T.players.map(p => ({ id:p.id, name:p.name })) });
                    return note(ok({ tid:T.tid, code:T.code, stakes:T.stakes, max:T.max, host:T.host, state:T.state,
                                     players:T.players.map(p => ({ id:p.id, name:p.name })) }));
                }
                case 'start':
                    if(id !== T.host) return note(bad(403, 'host only'));
                    if(T.state !== 'open') return note(bad(409, 'already started'));
                    if(T.players.length < 2) return note(bad(409, 'need 2 players'));
                    T.state = 'running';
                    schedule().forEach((pl, i) => T.order.push(mkNode('r1.' + (i + 1), 1, 2, pl)));
                    deal(T.order[0]);
                    return note(ok({ tid:T.tid, state:T.state }));
                case 'leave': {
                    const i = ids().indexOf(id);
                    if(i >= 0) T.players.splice(i, 1);
                    return note(ok());
                }
                case 'state': {
                    if(body.tid !== T.tid) return note(bad(404, 'no such tournament'));
                    const r = { tid:T.tid, state:T.state, code:T.code, host:T.host, stakes:T.stakes, max:T.max,
                                players:T.players.map(p => ({ id:p.id, name:p.name })), round:T.round,
                                cursor:T.cursor, schedule:nodesOfRound(1),
                                bracket:T.order.filter(x => T.nodes[x].round > 1).map(x => summary(T.nodes[x])),
                                standings:T.standings };
                    if(T.cursor) r.roles = sheet(T.cursor, id);
                    if(T.podium) r.podium = T.podium;
                    return note(ok(r));
                }
                case 'result':
                    return note(report(id, String(body.nid || ''), String(body.outcome || ''), body.score || [0, 0]));
                case 'standdown': {
                    const nd = T.nodes[String(body.nid || '')];
                    if(!nd || nd.nid !== T.cursor) return note(bad(409, 'not the current node'));
                    nd.excl[id] = 1; patch(nd.nid);
                    return note(ok());
                }
                case 'orphan': {
                    const nd = T.nodes[String(body.nid || '')];
                    if(!nd || nd.nid !== T.cursor) return note(bad(409, 'not the current node'));
                    for(const p of tree(nd).primaries) nd.excl[p] = 1;   // the sources it could not reach
                    patch(nd.nid);
                    return note(ok());
                }
            }
            return note(bad(400, 'unknown action'));
        },
    };
    return srv;
}

// ============================================================================
// THE CLIENTS
// ============================================================================
function driverSrc(id){
    return '\n;(function(){\n'
        + '  var REC = globalThis.__REC = { offers:[], watches:[], sigs:[], exits:0 };\n'
        + '  var clock = 100000;\n'
        + '  performance.now = function(){ return clock; };\n'
        + '  cfg.offline = false; cfg.music = 0; cfg.sfx = 0;\n'
        + '  getPlayerId = function(){ return "' + id + '"; };\n'
        + '  globalThis.fetch = function(url, opt){\n'
        + '      var r = globalThis.__srv(String(url), JSON.parse(opt.body));\n'
        + '      return Promise.resolve({ status:r.status, json:function(){ return Promise.resolve(r.json); } });\n'
        + '  };\n'
        // The four seams a headless client cannot run for real.
        + '  _netRtcOffer = function(peer){ REC.offers.push(String(peer)); };\n'
        + '  _netSignal = function(to, type, payload){ REC.sigs.push({ to:String(to), type:String(type), payload:String(payload) }); };\n'
        + '  _netTimeSync = function(){};\n'
        + '  _duelExit = function(){ inGame = false; _netSess = null; REC.exits++; phase = (typeof tourneyExitPhase === "function" && tourneyExitPhase()) || "duel11"; };\n'
        // specWatch is the REAL one, wrapped: it still grants, still signals, still sets
        // p2p-only. Only the RTCPeerConnection it would open is missing from this world.
        + '  var _realWatch = specWatch;\n'
        + '  specWatch = function(peer, tid, nid){ REC.watches.push({ peer:String(peer), tid:String(tid||""), nid:String(nid||"") }); return _realWatch(peer, tid, nid); };\n'
        + '  var C = globalThis.__C = {\n'
        + '    now: function(v){ clock = v; },\n'
        + '    hello: function(){ return _netHello(); },\n'
        + '    tick: function(){ _ttTick(); },\n'
        + '    phase: function(){ return phase; },\n'
        + '    setPhase: function(p){ phase = p; },\n'
        + '    msg: function(){ return _ttUi.msg; },\n'
        + '    tt: function(){ return _tt ? JSON.parse(JSON.stringify(_tt)) : null; },\n'
        + '    rec: function(){ return JSON.parse(JSON.stringify(REC)); },\n'
        + '    clear: function(){ REC.offers = []; REC.watches = []; REC.sigs = []; REC.exits = 0; },\n'
        + '    enter: function(){ return tourneyEnter(); },\n'
        + '    create: function(s){ return tourneyCreate(s); },\n'
        + '    join: function(c){ return tourneyJoin(c); },\n'
        + '    start: function(){ return tourneyStart(); },\n'
        + '    rows: function(){ return tourneyRows().map(function(r){ return { t:r.t, en:r.en !== false, note:r.note || "" }; }); },\n'
        + '    pick: function(t){ var rs = tourneyRows(); for(var i = 0; i < rs.length; i++) if(rs[i].t.indexOf(t) === 0){ _ttUi.sel = i; return rs[i].act(); } throw "no row " + t; },\n'
        + '    draw: function(){ var s = SCREENS[phase]; if(!s || !s.d) throw "no screen for " + phase; s.d(); return true; },\n'
        + '    sess: function(peer, role){ var s = _netMkSess(peer, role); return { hearts:s.hearts, heartsWant:s.heartsWant, stakes:s.stakes, p2pOnly:s.p2pOnly }; },\n'
        + '    p2p: function(){ return _netP2POnly; },\n'
        + '    inGame: function(v){ inGame = !!v; },\n'
        // The sim declaring a duel over, through the one path game.js uses: set the board,
        // then call the hook the phase change fires.
        + '    endMatch: function(role, peer, winner, sc){\n'
        + '        _netSess = { role:role, peer:peer, mid:"m-" + Math.random().toString(16).slice(2, 8), game:true };\n'
        + '        players = [{ score:sc[0] | 0 }, { score:sc[1] | 0 }]; duelWinner = winner; inGame = true;\n'
        + '        phase = "duelOver"; tourneyMatchOver();\n'
        + '    },\n'
        + '    walkOut: function(role, peer, sc){\n'
        + '        _netSess = { role:role, peer:peer, mid:"m-walk", game:true };\n'
        + '        players = [{ score:sc[0] | 0 }, { score:sc[1] | 0 }]; duelWinner = -1; inGame = true;\n'
        + '        tourneyMatchLeft();\n'
        + '    },\n'
        // net-spec state a headless client cannot reach on its own: a live feed that has
        // gone quiet, and relay duty to stand down from.
        + '    spFeedDead: function(){ _spOn = true; _spHops = 2; _spFeedAt = _spNow() - 9999; },\n'
        + '    spServe: function(peer){ _spOut.push({ peer:peer, dc:null, pc:null }); },\n'
        + '    spOut: function(){ return _spOut.length; },\n'
        + '    spStandDown: function(){ specStandDown(); },\n'
        + '    spOrphan: function(){ _spOrphan(); },\n'
        + '    spGranted: function(pid){ return !!_spGrant[pid]; },\n'
        + '    sigTo: function(d){ _netOnSignal({ type:"tourney", from:"", payload:JSON.stringify(d) }); },\n'
        + '  };\n'
        + '})();\n';
}

// ============================================================================
// THE RUN
// ============================================================================
const srv = mkServer();
const C = IDS.map((id, i) => {
    const sb = runInGame(driverSrc(id));
    sb.__srv = (url, body) => srv.post(url, body);
    srv.name(id, NAMES[i]);
    return sb.__C;
});
const idx = (id) => IDS.indexOf(id);
let NOW = 100000;

const TT_OVER_MS = 4000;       // tourney.js: how long a settled match holds the screen
const flush = () => new Promise(r => setImmediate(r));
const clearAll = () => { for(const c of C) c.clear(); };
async function settleAsync(){ for(let i = 0; i < 8; i++) await flush(); }
function clock(ms){ NOW += ms; srv.now(NOW); for(const c of C) c.now(NOW); }
// One heartbeat for everyone: hello drains the signal mailbox through the real dispatcher,
// then the housekeeping tick acts on whatever it left behind. Repeated until nothing new
// arrives, because acting on an event routinely asks the server another question.
async function pump(times){
    for(let k = 0; k < (times || 3); k++){
        for(const c of C){ c.hello(); }
        await settleAsync();
        for(const c of C){ c.tick(); }
        await settleAsync();
    }
}

// ---- 1) the lobby ---------------------------------------------------------
async function lobby(){
    for(const c of C) c.setPhase('tourneyLobby');
    for(const c of C) c.enter();
    await settleAsync();
    // Nothing held yet: the rows are the three offers plus BACK, and the announce is empty
    // because no lobby exists to announce.
    const r0 = C[1].rows();
    A(r0.length === 4 && r0[0].t === 'CREATE TOURNAMENT' && r0[1].t === 'ITEM STAKES: OFF'
      && r0[2].t === 'JOIN BY CODE' && r0[3].t === 'BACK',
      '1: an empty lobby offers ' + r0.map(x => x.t).join('/'));
    A(r0.every(x => x.en), '1: the tournament rows are greyed against a 4.1 server');
    C[1].draw();

    C[0].pick('ITEM STAKES');                  // stakes are the host's call, off by default
    A(C[0].rows()[1].t === 'ITEM STAKES: ON', '1: the stakes row did not toggle');
    await C[0].pick('CREATE TOURNAMENT');
    await settleAsync();
    const t0 = C[0].tt();
    A(t0 && t0.code === 'K7MZ4Q' && t0.stakes === true && t0.state === 'open',
      '1: the host does not hold the lobby it just created');
    // The host's own rows: START greyed until somebody else is in the room.
    const rh = C[0].rows();
    A(rh[0].t === 'START TOURNAMENT' && !rh[0].en && rh[0].note === '(NEED 2)',
      '1: START is offered to a host sitting alone (' + JSON.stringify(rh[0]) + ')');

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
    // A guest is offered no START row, ever.
    const rg = C[3].rows();
    A(!rg.some(x => x.t.indexOf('START') === 0), '1: a guest is offered START');
    A(rg[0].t === 'LEAVE TOURNAMENT', '1: a guest is offered ' + rg[0].t + ' rather than LEAVE');
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

    // -- the sheet reached everyone, and said the same thing to everyone --
    for(let i = 0; i < N; i++){
        const t = C[i].tt(), r = t && t.roles;
        A(!!r && r.nid === nid, '2 ' + nid + ': ' + NAMES[i] + ' holds sheet ' + (r ? r.nid : 'none'));
        if(!r) continue;
        const want = (i === ia || i === ib) ? 'play' : 'spectate';
        A(r.you === want, '2 ' + nid + ': ' + NAMES[i] + ' was told "' + r.you + '" instead of "' + want + '"');
        A(r.feeder === pa, '2 ' + nid + ': the feeder is ' + r.feeder + ', not players[0]');
        A(t.cursor === nid, '2 ' + nid + ': ' + NAMES[i] + ' points at node ' + t.cursor);
        A(C[i].phase() === 'tourneyCeremony', '2 ' + nid + ': ' + NAMES[i] + ' sat on ' + C[i].phase() + ' instead of the ceremony');
        C[i].draw();
    }

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

    // ---- the knockouts, and the 3-heart final -----------------------------
    const ko = await node({});
    A(ko.nid === 'ko1.1' && srv.T.nodes[ko.nid].hm === 2, '9: ' + ko.nid + ' is not a 2-heart knockout');
    await finish(ko, { win:0, score:[9, 3] });
    const fin = await node({});
    A(fin.nid === 'final', '9: the bracket reached ' + fin.nid + ' instead of a final');
    A(srv.T.nodes.final.hm === 3, '9: the final is at ' + srv.T.nodes.final.hm + ' hearts, not 3');
    A(C[fin.ia].sess(fin.pb, 'host').hearts === 3, '9: the final minted a 2-heart session');
    await finish(fin, { win:0, score:[11, 8] });
    rows.push('9 knockouts: ko1.1 at 2 hearts and the final at 3, both dressed from the sheet');

    // ---- the podium -------------------------------------------------------
    await pump(2);
    const champ = srv.T.podium[0];
    for(let i = 0; i < N; i++){
        A(C[i].phase() === 'tourneyPodium', '10: ' + NAMES[i] + ' ended on ' + C[i].phase());
        const t = C[i].tt();
        A(t.state === 'done' && JSON.stringify(t.podium) === JSON.stringify(srv.T.podium),
          '10: ' + NAMES[i] + ' holds podium ' + JSON.stringify(t.podium));
        C[i].draw();
        const r = C[i].rows();
        A(r[0].t === 'DONE' && r[1].t === 'BACK', '10: a finished tournament offers ' + r.map(x => x.t).join('/'));
    }
    C[0].pick('DONE');
    A(C[0].tt() === null && C[0].phase() === 'duelMenu', '10: DONE did not let go of the finished tournament');
    rows.push('10 podium: ' + NAMES[idx(champ)] + ' took it, all six landed on the podium screen, DONE let go');

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

    console.log(rows.join('\n'));
    if(fails){ console.log('\nTOURNEY-E2E FAIL: ' + fails + ' assertion(s)'); process.exit(1); }
    console.log('\nTOURNEY-E2E PASSED');
})().catch(e => { console.log(rows.join('\n')); console.log('\nTOURNEY-E2E FAIL: ' + (e && e.stack || e)); process.exit(1); });
