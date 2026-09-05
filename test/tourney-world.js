// THE TOURNAMENT WORLD: one scripted server and N real clients, shared by every suite that
// needs a whole tournament to exist.
//
// This is not a suite. It holds no assertions and decides nothing -- it is the CONTRACT
// (docs/API.md's tournament section) written out as data, plus the four seams a headless
// client cannot run for real. tourney-e2e.js drives it through one six-player tournament
// with every failure mode injected; tourney-full.js (on demand) drives a full field through
// the whole round ladder. Both are looking at the same world, which is the point: a shape
// that only one suite's private stand-in server produces proves nothing about the client.
//
// THE CLIENTS ARE REAL. Each is a full harness sandbox with the whole game loaded. The only
// things replaced are fetch (routed into the scripted server), _netRtcOffer and _netSignal
// (recorded), and _duelExit (the sim teardown a headless client cannot run). Everything
// else -- tourney.js, net-api.js's hello, net-session.js's signal dispatch, net-rtc.js's
// _netMkSess, net-spec.js's grant/standdown/orphan logic, screens.js's tournament screens --
// is the shipping code.
const { runInGame } = require('./harness');

// Server-side settings, quoted here so the expectations that read them stay readable.
const RESULT_MS    = 15000;    // tournament_result_ms: how long a lone win is held
const BREAK_MS     = 1000;     // tournament_break_ms: how long the scoreboard must stay up
const BREAK_TTL_MS = 120000;   // tournament_break_ttl_ms: when a break clears itself
const MAX_DIRECT   = 2;        // SPEC_MAX_DIRECT
const MAX_LEVEL    = 10;       // MAX_LEVELS: the ladder cannot go deeper than the game does
// Client-side timings the run has to step over.
const TT_OVER_MS   = 4000;     // tourney.js: how long a settled match holds the screen
const TT_CONNECT_MS    = 20000;   // tourney.js: a ceremony that has not connected by now re-offers
const TT_CONNECT_TRIES = 4;       // tourney.js: re-offers before the node goes back to the server
const TT_STATE_MS  = 5000;     // tourney.js: the floor between unforced state() read-backs

// ============================================================================
// THE SCRIPTED SERVER
// One tournament, held as plain data. Every response and every event is exactly the shape
// docs/API.md documents, because that shape is the only thing the client is entitled to.
// ============================================================================
function mkServer(opts){
    const O = opts || {};
    const T = { tid:'7f3c9a21b4d85e60c1f2a3b4c5d6e7f8', code:'K7MZ4Q', host:'', stakes:false,
                max:10, state:'open', players:[], round:0, cursor:null,
                nodes:{}, order:[], standings:[], advancers:[], podium:null,
                brk:null, brkNext:'', seen:[], feeds:{}, cut:O.cut | 0, quiet:!!O.quietPodium };
    const out = {};                 // player id -> queued signals, drained by hello
    const muted = {};               // ids whose signal stream is dead: state() is all they have
    const names = {};               // the server's own player table
    const log = [];                 // every ACCEPTED post: {id, action, nid}
    const refused = [];             // every refusal: {id, action, status}
    let NOW = 100000;

    const ok   = (o) => ({ status:200, json:Object.assign({ ok:true }, o || {}) });
    const bad  = (st, err, extra) => ({ status:st, json:Object.assign({ ok:false, error:err }, extra || {}) });
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
    // THE ROUND LADDER: round 1 is level 1 and every round after it one deeper, capped at
    // the last level the game has. A node knows its own level from the moment it is built,
    // which is what lets a bracket be drawn with the levels on it before anything is played.
    function mkNode(nid, round, hm, pl){
        T.nodes[nid] = { nid, round, hm, lvl:Math.min(round, MAX_LEVEL), players:pl,
                         state:'pending', winner:null, draw:false,
                         score:null, reports:{}, heldAt:0, excl:{} };
        return nid;
    }
    // A TOKEN, never a caption: the client owns the wording.
    function stageOf(nd){
        if(nd.round === 1) return 'group';
        if(nd.nid === 'final') return 'final';
        const n = T.order.filter(x => T.nodes[x].round === nd.round).length;
        return n === 4 ? 'quarter' : (n <= 2 ? 'semi' : 'ko');
    }
    function summary(nd){
        return { nid:nd.nid, round:nd.round, hm:nd.hm, lvl:nd.lvl, stage:stageOf(nd),
                 players:nd.players.slice(), state:nd.state, winner:nd.winner,
                 draw:nd.draw, score:nd.score };
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
        return { event:'roles', tid:T.tid, round:nd.round, stage:stageOf(nd),
                 match:round.indexOf(nid) + 1, of:round.length,
                 nid, hm:nd.hm, lvl:nd.lvl, stakes:T.stakes, players:nd.players.slice(), feeder:nd.players[0],
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

    // ---- the break between rounds -------------------------------------------
    // A finished round stops on a scoreboard and waits for the HOST. `round` has already
    // moved to the round about to be played; `break.done` is the one that ended.
    function openBreak(nid){
        T.brk = { done:T.round, at:NOW };
        T.brkNext = nid; T.round = T.nodes[nid].round; T.cursor = null;
        all(board());
    }
    function closeBreak(){
        const nid = T.brkNext;
        T.brk = null; T.brkNext = '';
        deal(nid);
    }
    // DERIVED on every read, so a forfeit during the break shows up in the board a late
    // client asks for rather than in a snapshot taken before it happened.
    function board(){
        if(!T.brk) return null;
        const nd = T.nodes[T.brkNext], done = T.brk.done | 0;
        const rnd = T.order.filter(x => T.nodes[x].round === nd.round);
        const through = done === 1 ? T.advancers.slice()
              : rnd.reduce((a, x) => a.concat(T.nodes[x].players.filter(Boolean)), []);
        const st = {};
        for(const r of T.standings) st[r.id] = r;
        const rows = T.seen.map(p => {
            const s = st[p.id], w = { seat:p.seat, id:p.id, name:names[p.id] || null,
                        pts:s ? s.pts : 0, diff:s ? s.diff : 0, rank:s ? s.rank : p.seat + 1,
                        adv:through.indexOf(p.id) >= 0, gone:ids().indexOf(p.id) < 0, w:0, l:0, d:0 };
            w.until = w.adv ? nd.round : done;
            return w;
        });
        // w/l/d count the round that just ended and nothing else.
        for(const nid of T.order){
            const n2 = T.nodes[nid];
            if(n2.round !== done || n2.state !== 'done') continue;
            for(const id of n2.players){
                const w = rows.filter(x => x.id === id)[0];
                if(!w) continue;
                if(n2.draw) w.d++; else if(n2.winner === id) w.w++; else if(n2.winner) w.l++;
            }
        }
        // An elimination ladder: still in, then whoever went out most recently, then by rank.
        rows.sort((a, b) => (b.adv - a.adv) || (b.until - a.until) || (a.rank - b.rank));
        return { event:'round', tid:T.tid, done, next:nd.round, stage:stageOf(nd), lvl:nd.lvl,
                 hm:nd.hm, matches:rnd.length, of:through.length, host:T.host, at:T.brk.at,
                 wait:BREAK_MS, auto:BREAK_TTL_MS, rows, advancers:through.slice() };
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
        T.advancers = rank.slice(0, T.cut || Math.max(2, Math.ceil(ids().length / 2)));
        for(const r of T.standings) r.adv = T.advancers.indexOf(r.id) >= 0;
    }
    // The knockout tree. Three advancers is the odd default field: the two below the top
    // seed meet, and the winner meets the top seed in the final. Any other field is paired
    // top against bottom and halved every round until one node is left, which is the final.
    // Slots a round cannot know yet are filled by T.feeds as the round below it settles.
    function buildKo(){
        const a = T.advancers;
        if(a.length === 3){
            T.order.push(mkNode('ko1.1', 2, 2, [a[1], a[2]]));
            T.order.push(mkNode('final', 3, 3, [a[0], null]));
            T.feeds['ko1.1'] = { to:'final', slot:1 };
            return;
        }
        let src = a.slice(), round = 2, seeded = true;
        while(src.length > 1){
            const n = src.length, made = [];
            for(let i = 0; i < n / 2; i++){
                const last = n === 2, nid = last ? 'final' : ('ko' + (round - 1) + '.' + (i + 1));
                const x = src[i], y = src[n - 1 - i];
                T.order.push(mkNode(nid, round, last ? 3 : 2, seeded ? [x, y] : [null, null]));
                if(!seeded){ T.feeds[x] = { to:nid, slot:0 }; T.feeds[y] = { to:nid, slot:1 }; }
                made.push(nid);
            }
            src = made; seeded = false; round++;
        }
    }
    function settle(nid, winner, draw, score){
        const nd = T.nodes[nid];
        nd.state = 'done'; nd.winner = winner; nd.draw = !!draw; nd.score = score;
        const feed = T.feeds[nid];              // the winner walks into the node above
        if(feed && winner) T.nodes[feed.to].players[feed.slot] = winner;
        all({ event:'result', tid:T.tid, nid, winner, draw:!!draw, score });
        advance();
    }
    function advance(){
        const i = T.order.indexOf(T.cursor), done = T.round;
        if(i + 1 < T.order.length){
            // A ROUND boundary stops on a scoreboard; a match boundary inside a round does not.
            const next = T.order[i + 1];
            if(T.nodes[next].round !== done) openBreak(next); else deal(next);
            return;
        }
        if(done === 1){
            standings();
            all({ event:'standings', tid:T.tid, rows:T.standings, advancers:T.advancers });
            buildKo(); openBreak('ko1.1'); return;
        }
        T.state = 'done'; T.cursor = null; T.brk = null; T.brkNext = '';
        // Third is the better-placed of the two who lost one round below the final.
        const f = T.nodes['final'], rk = {};
        for(const r of T.standings) rk[r.id] = r.rank;
        const third = T.order.filter(x => T.nodes[x].round === f.round - 1)
              .map(x => T.nodes[x])
              .map(n => n.players[n.players[0] === n.winner ? 1 : 0])
              .filter(Boolean)
              .sort((x, y) => (rk[x] | 0) - (rk[y] | 0))[0] || null;
        T.podium = [f.winner, f.players[f.players[0] === f.winner ? 1 : 0], third];
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
        // A host who closed their browser must not be able to wedge an evening everybody
        // else is still in, so the break clears itself the same lazy way.
        if(T.brk && NOW - T.brk.at >= BREAK_TTL_MS){ closeBreak(); return true; }
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
        at(){ return NOW; },
        name(id, n){ names[id] = n; },
        // A client whose signals stop arriving -- a dropped poll, a backgrounded tab, a
        // reload. Everything it learns after this it has to learn from the state read-back.
        mute(id, on){ if(on) muted[id] = 1; else delete muted[id]; },
        deadlines, board,
        // An operator clearing a frozen node from the admin surface.
        adminClear(nid, winner){ const nd = T.nodes[nid]; nd.state = 'live'; settle(nid, winner, false, nd.score || [0, 0]); },
        post(url, body){
            if(/hello\.php$/.test(url)){
                const id = String(body.id || ''), sigs = muted[id] ? [] : (out[id] || []);
                out[id] = [];
                const r = { ok:true, api:'4.3', now:Date.now(), online:Math.max(1, T.players.length),
                            playing:0, friends_playing:{}, signals:sigs };
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
                    T.seen = T.players.slice();
                    return note(ok({ tid:T.tid, code:T.code, stakes:T.stakes, max:T.max }));
                case 'join': {
                    if(body.tid && body.tid !== T.tid) return note(bad(404, 'no such tournament'));
                    if(body.code && String(body.code).toUpperCase() !== T.code) return note(bad(404, 'no such tournament'));
                    if(ids().indexOf(id) >= 0) return note(ok({ tid:T.tid, code:T.code, stakes:T.stakes, max:T.max,
                                                               players:T.players.map(p => ({ id:p.id, name:p.name })), host:T.host, state:T.state }));
                    if(T.state !== 'open') return note(bad(409, 'already started'));
                    if(T.players.length >= T.max) return note(bad(409, 'tournament is full'));
                    const p = { id, name:names[id] || '?', seat:T.players.length };
                    T.players.push(p); T.seen.push(p);
                    all({ event:'lobby', tid:T.tid, code:T.code, host:T.host, state:T.state, stakes:T.stakes,
                          max:T.max, players:T.players.map(x => ({ id:x.id, name:x.name })) });
                    return note(ok({ tid:T.tid, code:T.code, stakes:T.stakes, max:T.max, host:T.host, state:T.state,
                                     players:T.players.map(x => ({ id:x.id, name:x.name })) }));
                }
                case 'start':
                    if(id !== T.host) return note(bad(403, 'host only'));
                    if(T.state !== 'open') return note(bad(409, 'already started'));
                    if(T.players.length < 2) return note(bad(409, 'need 2 players'));
                    T.state = 'running';
                    schedule().forEach((pl, i) => T.order.push(mkNode('r1.' + (i + 1), 1, 2, pl)));
                    deal(T.order[0]);
                    return note(ok({ tid:T.tid, state:T.state }));
                case 'continue': {
                    if(ids().indexOf(id) < 0) return note(bad(403, 'not a participant'));
                    if(id !== T.host) return note(bad(403, 'host only'));
                    if(!T.brk) return note(bad(409, 'no break open'));
                    const left = T.brk.at + BREAK_MS - NOW;
                    // The scoreboard is the whole point of stopping, and a press that beats
                    // it is the tap that ended the last match arriving late.
                    if(left > 0) return note(bad(409, 'too early', { retry_ms:left }));
                    closeBreak();
                    return note(ok());
                }
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
                    // Always present, null when no break is open: the read-back is what puts
                    // the scoreboard back after a missed signal, and takes it down after a
                    // missed sheet.
                    r['break'] = board();
                    if(T.cursor) r.roles = sheet(T.cursor, id);
                    // docs/API.md puts the podium in the read-back. A server build that only
                    // announces it in the one-shot 'over' event does not, and a client that
                    // missed that event must still not call a won tournament a void one.
                    if(T.podium && !T.quiet) r.podium = T.podium;
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
        + '  var REC = globalThis.__REC = { offers:[], answers:[], watches:[], sigs:[], posts:[], exits:0 };\n'
        + '  var clock = 100000;\n'
        + '  performance.now = function(){ return clock; };\n'
        + '  cfg.offline = false; cfg.music = 0; cfg.sfx = 0;\n'
        + '  getPlayerId = function(){ return "' + id + '"; };\n'
        + '  globalThis.fetch = function(url, opt){\n'
        + '      var b = JSON.parse(opt.body); REC.posts.push(b);\n'
        + '      var r = globalThis.__srv(String(url), b);\n'
        + '      return Promise.resolve({ status:r.status, json:function(){ return Promise.resolve(r.json); } });\n'
        + '  };\n'
        // The four seams a headless client cannot run for real.
        + '  _netRtcOffer = function(peer){ REC.offers.push(String(peer)); };\n'
        + '  _netRtcAnswer = function(peer, d){ if(inGame) return; REC.answers.push({ peer:String(peer), seed:(d && d.seed) | 0 }); };\n'
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
        + '    clrMsg: function(){ _ttUi.msg = ""; },\n'
        + '    tt: function(){ return _tt ? JSON.parse(JSON.stringify(_tt)) : null; },\n'
        + '    rec: function(){ return JSON.parse(JSON.stringify(REC)); },\n'
        + '    clear: function(){ REC.offers = []; REC.answers = []; REC.watches = []; REC.sigs = []; REC.posts = []; REC.exits = 0; },\n'
        + '    enter: function(){ return tourneyEnter(); },\n'
        + '    create: function(s){ return tourneyCreate(s); },\n'
        + '    join: function(c){ return tourneyJoin(c); },\n'
        + '    start: function(){ return tourneyStart(); },\n'
        // The break: the board as the client holds it, the button it is offered, and the
        // stage token turned into the words this client would draw.
        + '    brk: function(){ var b = tourneyBreak(); return b ? JSON.parse(JSON.stringify(b)) : null; },\n'
        + '    cont: function(){ return tourneyContinue(); },\n'
        + '    stage: function(tok, r){ return _ttStage(tok, r); },\n'
        + '    rows: function(){ return tourneyRows().map(function(r){ return { t:r.t, en:r.en !== false, note:r.note || "", nosel:!!r.nosel }; }); },\n'
        // WHICH ROW THE SCREEN OPENS ON, which is a rule about rows and not about drawing:
        // -1 is unarmed, and a list whose first row is not this player's to press opens there.
        + '    sel: function(){ return tourneySel(); },\n'
        + '    pick: function(t){ var rs = tourneyRows(); for(var i = 0; i < rs.length; i++) if(rs[i].t.indexOf(t) === 0){ _ttUi.sel = i; return rs[i].act(); } throw "no row " + t; },\n'
        + '    has: function(t){ return tourneyRows().some(function(r){ return r.t.indexOf(t) === 0; }); },\n'
        + '    draw: function(){ var s = SCREENS[phase]; if(!s || !s.d) throw "no screen for " + phase; s.d(); return true; },\n'
        + '    line: function(nd){ return _ttMatchLine(tourneyView() || {}, nd.nid, nd); },\n'
        + '    snap: function(s){ return s ? { hearts:s.hearts, heartsWant:s.heartsWant, stakes:s.stakes, stakesWant:s.stakesWant, lvl0:s.lvl0, lvl:s.lvl, levelWant:s.levelWant, p2pOnly:s.p2pOnly } : null; },\n'
        + '    sess: function(peer, role){ return C.snap(_netMkSess(peer, role)); },\n'
        // A session that already EXISTS when the sheet is engaged, which is the case a fresh
        // _netMkSess can never show: the offer is answered before the sheet comes off the queue.
        + '    mint: function(peer, role){ _netSess = _netMkSess(peer, role); return C.snap(_netSess); },\n'
        + '    sessNow: function(){ return C.snap(_netSess); },\n'
        + '    p2p: function(){ return _netP2POnly; },\n'
        + '    inGame: function(v){ inGame = !!v; },\n'
        + '    live: function(){ return inGame; },\n'
        + '    exit: function(){ _duelExit(); },\n'
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
        // The watch handshake, which is signalling and nothing else. _spTick is driven by a
        // setInterval the sandbox does not have, so the housekeeping that answers a parked
        // ask has to be stepped by hand -- and every leg of it goes out through _netSignal,
        // which the world can now actually deliver.
        + '    spTick: function(){ _spTick(); },\n'
        + '    spAsks: function(){ return _spAsk.map(function(a){ return a.from; }); },\n'
        + '    spWants: function(){ return _spWant.map(function(w){ return w.to; }); },\n'
        + '    spHs: function(){ return specHandshaking(); },\n'
        + '    spStatus: function(){ return specStatus(); },\n'
        + '    pollDue: function(){ return _netPollDue(); },\n'
        // A LIVE match, as the feeder is in when a watcher reaches it: a session that says
        // game, a board that says inGame, and the seed a bootstrap context is built from.
        + '    goLive: function(peer, role){\n'
        + '        _netSess = _netMkSess(peer, role); _netSess.game = true;\n'
        + '        _netSess.seed = 0x51ec7a70; _netSess.startPts = 1000; _netSess.lvl = 1;\n'
        + '        inGame = true; return true; },\n'
        + '    takeSigs: function(){ var s = REC.sigs; REC.sigs = []; return JSON.parse(JSON.stringify(s)); },\n'
        + '    sigTo: function(d){ _netOnSignal({ type:"tourney", from:"", payload:JSON.stringify(d) }); },\n'
        // A signal from another PLAYER rather than from the server: the duel handshake types.
        + '    sigRaw: function(type, from, d){ _netOnSignal({ type:type, from:from, payload:JSON.stringify(d) }); },\n'
        + '    playNid: function(){ return _ttPlayNid; },\n'
        // The leave dialog: opening it, the screen it is standing over, and the two
        // answers as the real input handler gives them.
        + '    ask: function(to){ return tourneyAsk(to); },\n'
        + '    from: function(){ return _ttUi.from; },\n'
        + '    key: function(a, sel){ if(sel !== undefined) quitConfirmSel = sel;\n'
        + '                           var h = UI_INPUT[phase];\n'
        + '                           if(!h || !h[a]) throw "no " + a + " on " + phase;\n'
        + '                           return h[a](); },\n'
        // The way back into a tournament this device walked out of: what is on disk,
        // and what the probe made of it.
        + '    held: function(){ return _ttHeld(); },\n'
        + '    back: function(){ return _ttBack ? JSON.parse(JSON.stringify(_ttBack)) : null; },\n'
        + '    probe: function(){ return _ttProbe(); },\n'
        // A RELOAD, which is the only way the way-back ever gets exercised for real:
        // the picture of the tournament is gone from memory, the id on disk is not.
        // Deliberately not _ttDrop -- that is the terminal route, and it wipes the id.
        + '    forget: function(){ _tt = null; _ttPend = null; _ttNid = ""; _ttPlayNid = ""; _ttBack = null; },\n'
        + '  };\n'
        + '})();\n';
}

// ============================================================================
// THE WORLD
// The server, the clients and the one clock they share. Every suite gets the same helpers,
// because a suite that steps its own world forward differently is testing its own stepping.
// ============================================================================
function mkWorld(ids, names, opts){
    const srv = mkServer(opts);
    const C = ids.map((id, i) => {
        const sb = runInGame(driverSrc(id));
        sb.__srv = (url, body) => srv.post(url, body);
        srv.name(id, names[i]);
        return sb.__C;
    });
    let NOW = 100000;
    const flush = () => new Promise(r => setImmediate(r));
    const w = {
        srv, C, ids, names,
        idx: (id) => ids.indexOf(id),
        now: () => NOW,
        clearAll(){ for(const c of C) c.clear(); },
        // Signals actually DELIVERED, peer to peer, through the real dispatcher. Without
        // this the world records the watch handshake and drops it on the floor, which is
        // precisely the leg -- ask, ok, offer, ice -- that has no carrier but the mailbox.
        deliver(){
            let n = 0;
            for(let i = 0; i < C.length; i++){
                for(const s of C[i].takeSigs()){
                    const j = ids.indexOf(s.to);
                    if(j < 0) continue;
                    let d = {};
                    try{ d = JSON.parse(s.payload || '{}'); }catch(e){ d = {}; }
                    C[j].sigRaw(s.type, ids[i], d); n++;
                }
            }
            return n;
        },
        clock(ms){ NOW += ms; srv.now(NOW); for(const c of C) c.now(NOW); },
        async settleAsync(){ for(let i = 0; i < 8; i++) await flush(); },
        // One heartbeat for everyone: hello drains the signal mailbox through the real
        // dispatcher, then the housekeeping tick acts on whatever it left behind. Repeated
        // because acting on an event routinely asks the server another question.
        async pump(times){
            for(let k = 0; k < (times || 3); k++){
                for(const c of C){ c.hello(); }
                await w.settleAsync();
                // The spectator housekeeping runs off a setInterval this sandbox does not
                // have, so a heartbeat here is what stands in for it. It belongs in the
                // shared beat rather than in the suites: on a real client it is running the
                // whole time, and a world where it only runs where a suite remembers to ask
                // is a world where anything it is responsible for looks like it works.
                for(const c of C){ c.spTick(); }
                for(const c of C){ c.tick(); }
                await w.settleAsync();
            }
        },
    };
    return w;
}

module.exports = { mkServer, driverSrc, mkWorld,
                   RESULT_MS, BREAK_MS, BREAK_TTL_MS, MAX_DIRECT, MAX_LEVEL,
                   TT_OVER_MS, TT_STATE_MS, TT_CONNECT_MS, TT_CONNECT_TRIES };
