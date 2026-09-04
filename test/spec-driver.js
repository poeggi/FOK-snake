// N-client SPECTATOR driver: two players running a real duel over the simulated wire
// (duel-driver's clocks, autopilot and divergence surface, unchanged) plus an arbitrary
// number of watchers hanging off the relay tree.
//
// It is deliberately a LAYER on duel-driver rather than a rewrite of runMatch: the
// existing two-client suites are the regression net for the netcode, and they must keep
// running exactly the code they run today. Everything new lives here.
//
// What is REAL and what is faked:
//   REAL -- the whole watch handshake (req/ok/no/feed-req), the grant window, the
//           SPEC_MAX_DIRECT fan-out cap, the serve state machine (sctx + checkpoint +
//           tail, ssub standby), the envelope sequence/generation dedup, the
//           boot delay, the bias, the failover ladder, and the sim itself.
//   FAKED -- the WebRTC half only: SDP and ICE are replaced by a two-step driver
//           connect, and each spectator DataChannel is a queue with the same one-way
//           delay/jitter model as the duel wire (ordered and lossless, as SCTP
//           reliable-ordered guarantees).
//
// Signals (watch / offer / answer) ride a driver bus with a configurable one-way delay,
// standing in for the server's long-poll drain.
const { runInGame, HOOKS, autopilot, resetPilot, NET_BASE } = require('./duel-driver');

// Hooks appended after duel-driver's: the signal bus, the fake spectator channels, and
// the spectator-side surface a test reads.
const SPEC_HOOKS = `
;(function(){
  // ---- signal bus -------------------------------------------------------
  // Every outbound signal is captured instead of POSTed. The debug log line still
  // runs, so a test can read the same overlay trace a player would see.
  globalThis.__sigOut = [];
  _netSignal = async (to, type, payload)=>{
    _netSigLog('> '+type+' '+String(to).slice(0,4));
    __sigOut.push({ from:getPlayerId(), to:String(to), type:String(type), payload:String(payload||'') });
  };
  globalThis.__sigDrain = ()=> __sigOut.splice(0);
  globalThis.__onSig    = (from, type, payload)=> _netOnSignal({ from, type, payload });

  // ---- fake spectator channels -----------------------------------------
  // A link is built exactly as _spMkPc would build it, minus the RTCPeerConnection:
  // same fields, same _spWire hookup, so every state machine above the channel is the
  // product's own. Frames land in __spq for the driver to carry.
  globalThis.__spq = [];
  globalThis.__spMk = (peer, kind)=>{
    const arr = kind === 'out' ? _spOut : _spIn;
    _spDrop(arr, peer);
    const l = { peer, pc:{ close(){} }, dc:null, rdOk:true, iceQ:[], sub:false, kind,
                dead:false, openAt:0, lastAt:_spNow(), live:false };
    l.dc = { readyState:'open', bufferedAmount:0,
             send(j){ __spq.push({ to:peer, kind, txt:j }); },
             close(){ l.dc.readyState = 'closed'; } };
    arr.push(l);
    _spWire(l, kind === 'out' ? _spOnServeMsg : _spOnFeedMsg);
    _spArm();
    return l;
  };
  globalThis.__spOpen = (peer, kind)=>{ const l = _spFind(kind === 'out' ? _spOut : _spIn, peer); if(l && l.dc.onopen) l.dc.onopen(); };
  globalThis.__spFeed = (peer, kind, txt)=>{ const l = _spFind(kind === 'out' ? _spOut : _spIn, peer); if(l && l.dc.onmessage) l.dc.onmessage({ data:txt }); };
  globalThis.__spDrain = ()=> __spq.splice(0);
  // Every message this node put on a link it is FED BY, by type. The passivity rule is a
  // claim about this list and nothing else: a spectator subscribes and unsubscribes, and
  // says nothing else to anybody for the whole match.
  globalThis.__upTx = [];
  { const _oSend = _spSend;
    _spSend = (l, o)=>{ if(l && l.kind === 'in'){ try{ __upTx.push(String(o && o.t)); }catch(e){} } return _oSend(l, o); }; }
  globalThis.__upTypes = ()=> Array.from(new Set(__upTx)).sort();
  // The link dies the way a closed channel dies: onclose fires, then it is dropped.
  globalThis.__spCut = (peer)=>{
    for(const arr of [_spIn, _spOut]){
      const l = _spFind(arr, peer); if(!l) continue;
      l.dc.readyState = 'closed';
      if(l.dc.onclose) l.dc.onclose();
      _spDrop(arr, peer);
    }
  };
  // The SDP half, replaced. The grant window and the fan-out cap stay REAL -- they are
  // the two rules that keep a phone from fanning eight channels out mid-match.
  _spOffer = async (peer)=>{
    _spDrop(_spIn, peer);
    __spMk(peer, 'in');
    __sigOut.push({ from:getPlayerId(), to:peer, type:'offer', payload:'{"sp":1}' });
  };
  _spAnswer = async (peer, d)=>{
    const g = _spGrant[peer] || 0;
    if(!g || _spNow() - g > SPEC_GRANT_MS) return;
    if(_spOut.length >= SPEC_MAX_DIRECT && !_spFind(_spOut, peer)) return;
    __spMk(peer, 'out');
    __sigOut.push({ from:getPlayerId(), to:peer, type:'answer', payload:'{"sp":1}' });
    __spOpen(peer, 'out');
  };
  _spOnSignal = (type, from, d)=>{
    if(type === 'offer'){ _spAnswer(from, d); return; }
    if(type === 'answer') __spOpen(from, 'in');
  };

  // The duel driver names its peer 'ffffffff' -- enough for two clients that only ever
  // talk to each other, but the bootstrap context carries the PLAYERS' real ids (a primary
  // needs them to reach the backup feeder), so each player is given its true opponent.
  globalThis.__setPeer = (id)=>{ if(_netSess) _netSess.peer = String(id); };

  // ---- spectator surface ------------------------------------------------
  // A watcher never calls __p2pStart: it has a shared clock and nothing else until a
  // feed boots its sim.
  globalThis.__specInit = ()=>{ _netSync = { ofs:0, rtt:1, at:Date.now() }; simTick = 0; simNow = 0; };
  globalThis.__watch    = (peer, tid, nid)=> specWatch(peer, tid, nid);
  globalThis.__grant    = (ids)=> specGrant(ids);
  globalThis.__node     = (tid, nid)=> specNode(tid, nid);
  globalThis.__specOn   = ()=> netSpectating();
  globalThis.__specRole = ()=> netSpecRole();
  globalThis.__specDbg  = ()=> Object.assign({}, netSpecDbg());
  globalThis.__specBias = ()=> netSpecBias();
  globalThis.__specHops = ()=> _spHops;
  globalThis.__specGen  = ()=> _spGen | 0;
  globalThis.__specSrc  = ()=> _spSrc || '';
  globalThis.__specAge  = ()=> netSpecFeedAge();
  globalThis.__askN     = ()=> _spAsk.length;
  globalThis.__outN     = ()=> _spOut.length;
  globalThis.__inN      = ()=> _spIn.length;
  globalThis.__subN     = ()=> _spIn.filter(l => l.sub).length;
  globalThis.__specStop = ()=> specStop('X');
  globalThis.__standDown= ()=> specStandDown();
  globalThis.__ctxHops  = ()=> _spCtx ? (_spCtx.hops|0) : 0;
  globalThis.__names    = ()=> netPlayerNames();
  globalThis.__wsLists  = ()=> JSON.stringify(_duelWsLists(false));
  globalThis.__startPts = ()=> _netSess ? _netSess.startPts : null;
  globalThis.__hearts   = ()=> _netSess ? _netSess.hearts : null;
  globalThis.__target   = ()=> netTickTarget();
  // Every call that reaches the AUTHORING end while spectating. _armIndex already returns
  // -1 up at the input layer, so a healthy spectator never even tries; the swallow inside
  // netLocalInput is the second half of the belt-and-braces. Zero is the iron-rule
  // assertion, and it has to be zero on BOTH counts.
  globalThis.__authored = 0;
  { const _oLI = netLocalInput;
    netLocalInput = function(kind, p, d, now){ if(netSpectating()) __authored++; return _oLI(kind, p, d, now); }; }
  globalThis.__authoredN = ()=> __authored;
  // WHAT THE MATCH SAID. A tournament match is settled by its own sim and by nothing else:
  // the winner index the duel declared (2 = draw), the two scores, the hearts still standing.
  // Read off the shipping globals, so a harness cannot invent a result the players did not play.
  globalThis.__winner = ()=> (typeof duelWinner !== 'undefined') ? duelWinner : -1;
  globalThis.__score  = ()=> (typeof players !== 'undefined' && players) ? players.map(p => p.score | 0) : null;
  globalThis.__lives  = ()=> (typeof players !== 'undefined' && players) ? players.map(p => p.lives | 0) : null;
  globalThis.__len    = ()=> (typeof players !== 'undefined' && players) ? players.map(p => p.snake.length | 0) : null;
})();`;

// Both roles get the same hook set: a player is also a potential feeder, and the backup
// feeder is a player that starts serving mid-match.
function mkClient(id, extra){ return runInGame(HOOKS(id) + SPEC_HOOKS + (extra || '')); }

const P_ID = { A:'aaaaaaaa', B:'bbbbbbbb' };
const S_ID = ['cccccccc', 'dddddddd', 'eeeeeeee', 'abababab', 'cdcdcdcd'];

// Run a duel with a spectator tree attached and return a report.
//   opts.secs        simulated seconds (default 14)
//   opts.wire        duel wire { base, jit, loss, asym }  (duel-driver's model)
//   opts.specWire    spectator-channel wire (default: the duel wire, lossless)
//   opts.sigMs       one-way signal delay, standing in for the long poll (default 120)
//   opts.watchers    [{ at, from }]  -- one entry per watcher, in S_ID order; `from` is
//                    a client NAME ('A' | 'S1' | ...): who to ask for a feed
//   opts.kill        [{ at, who }]   -- cut every spectator link of that client
//   opts.outage      [{ at, ms, who }] -- a SHORT blackout on one node ('*' = the whole wire)
//   opts.settleTail  ms of CALM run after secs (default 0 = off)
//   opts.director    input director (default duel-driver's autopilot)
//   opts.onSample    (now, cl) diagnostic tap
function runSpec(opts){
    const secs = opts.secs || 14;
    const seed = (opts.seed >>> 0) || 0xD0E1;
    const W = opts.wire || { base:20, jit:6 };
    const SW = opts.specWire || { base:W.base, jit:W.jit };
    const SIG = opts.sigMs == null ? 120 : opts.sigMs;
    const dir = opts.director || autopilot;
    resetPilot();               // a run is reproducible on its own, not on what ran before it
    const watchers = opts.watchers || [];
    const kills = (opts.kill || []).map(k => ({ at:Math.round(k.at * 1000), who:k.who, done:false }));
    // SHORT OUTAGES, the difference between this and opts.kill being that the node comes BACK.
    // A dark node keeps running -- it ticks, authors, serves and sends -- but nothing it puts on
    // a wire arrives and nothing arrives at it, which is duel-driver's own opts.outage model
    // (runMatch: a WiFi drop where both clients stay awake) applied per node instead of to the
    // whole link. The interesting part is never the outage: it is what the tree looks like on
    // the far side of one, so every window is meant to be SHORT -- inside RB_PERSIST_KILL_MS,
    // which is the silence that ends a match, and inside the spectator's own terminal deadline.
    const outs = [].concat(opts.outage || []).map(o => ({
        who:o.who || '*', at:Math.round(o.at * 1000), ms:o.ms | 0, hits:0 }));
    let darkSet = null;
    const dark = (n) => !!darkSet && (darkSet.has(n) || darkSet.has('*'));
    // THE CALM TAIL. Everything a spectator repairs, it repairs on a cadence: the feeder
    // pushes a checkpoint every SPEC_CKPT_MS and the node adopts it on the next settled
    // tick, so a stretch of wrong history that OPENS near the end of a run cannot be shown
    // to close inside it -- not because the repair failed but because the run stopped
    // first. The tail is the answer: past `secs` the wire keeps carrying at the same
    // latency but stops losing packets, stops going dark and opens no new level, and the
    // divergence tracker keeps comparing. "Healed" then means what it says -- given a quiet
    // line, the node came back to the players' history -- instead of meaning "the clock ran
    // out clean". It is off by default: a suite that does not ask for a coda keeps the exact
    // run it had before, down to the packet.
    let calm = false;

    let rndS = (opts.rndSeed || 0x51ED) >>> 0;
    const rnd = () => (rndS = (rndS * 1103515245 + 12345) >>> 0) / 4294967296;

    // ---- clients ----
    const cl = {};                       // name -> { name, id, c, k, next, spec }
    const byId = {};
    const add = (name, id, c, spec) => {
        const o = { name, id, c, k:0, next:0, spec, pend:null, fresh:false };
        cl[name] = o; byId[id] = o; return o;
    };
    add('A', P_ID.A, mkClient(P_ID.A, opts.hookA), false);
    add('B', P_ID.B, mkClient(P_ID.B, opts.hookB), false);
    // The players' duel can be made to start LATE. A tournament deals the roles sheet to
    // every node in ONE signal drain, so a spectator asks for its feed while the two
    // players are still working through an offer/answer/ICE/go handshake -- the node it
    // asks has no timeline to serve yet. That window is the ordinary case rather than an
    // edge, so it belongs in the driver and not in a test that fakes it.
    let started = false;
    const startPlayers = ()=>{
        cl.A.c.__p2pStart(seed, 'host', null, null);
        cl.B.c.__p2pStart(seed, 'peer', null, null);
        cl.A.c.__setPeer(P_ID.B); cl.B.c.__setPeer(P_ID.A);
        started = true;
    };
    const playersAt = Math.round((opts.playersAt || 0) * 1000);
    if(!playersAt) startPlayers();
    watchers.forEach((w, i) => {
        const name = 'S' + (i + 1);
        const o = add(name, S_ID[i], mkClient(S_ID[i], opts.hookS), true);
        o.c.__specInit();
        o.at = Math.round(w.at * 1000);
        o.from = [].concat(w.from);      // one entry, or two for a dual-connect standby
        o.asked = false;
    });
    const names = Object.keys(cl);
    // The roles sheet is the introduction, and it reaches every node: tourney.js grants
    // players, primaries and secondaries on each of them the moment it lands. Mirror that
    // here, or a driver watcher would be a stranger to the node it is about to ask.
    for(const n of names) cl[n].c.__grant(names.filter(m => m !== n).map(m => cl[m].id));
    const TICK = cl.A.c.__TICK;

    // ---- wires ----
    const duel = { AB:[], BA:[] };                        // the players' unreliable channel
    const spec = [];                                      // [{ at, toId, fromId, kind, txt }]
    const sigs = [];                                      // [{ at, from, to, type, payload }]
    const lastSpecAt = {};                                // ordered delivery per directed link
    const oneWay = (w) => Math.max(1, (w.base || 3) + (rnd() * 2 - 1) * (w.jit || 0));

    const emitDuel = (o, dirn) => {
        const lost = dark(o.name);      // the outbox still drains: the device sent, the wire ate it
        for(const txt of o.c.__out.splice(0)){
            let t = '?'; try{ t = (JSON.parse(txt).t) || '?'; }catch(e){}
            if(t === 'pi') continue;
            if(lost || (!calm && rnd() < (W.loss || 0))) continue;
            duel[dirn].push([o.c.__now + oneWay(W), txt]);
        }
    };
    const drainDuel = (q, C, name) => { if(dark(name)) return; for(let j = 0; j < q.length; j++){
        if(q[j][0] <= C.__now){ C.__recv(q[j][1]); q.splice(j--, 1); } } };

    const pumpSpec = (now) => {
        for(const n of names){
            const o = cl[n], lost = dark(n);
            for(const f of o.c.__spDrain()){
                if(lost) continue;
                const key = o.id + '>' + f.to;
                // Reliable and ORDERED: a frame never overtakes the one before it.
                const at = Math.max(now + oneWay(SW), (lastSpecAt[key] || 0) + 0.001);
                lastSpecAt[key] = at;
                o.txB = (o.txB | 0) + f.txt.length;
                const pk = n + '>' + ((byId[f.to] && byId[f.to].name) || f.to);
                pairB[pk] = (pairB[pk] | 0) + f.txt.length;
                spec.push({ at, toId:f.to, fromId:o.id, kind:(f.kind === 'out' ? 'in' : 'out'), txt:f.txt });
            }
            for(const s of o.c.__sigDrain()){ if(lost) continue;
                sigs.push({ at:now + SIG, from:s.from, to:s.to, type:s.type, payload:s.payload }); }
        }
        for(let i = 0; i < spec.length; i++){
            const f = spec[i];
            if(f.at > now) continue;
            const t = byId[f.toId];
            if(t && dark(t.name)) continue;      // in flight when the lights went out: held, not lost
            if(t) t.c.__spFeed(f.fromId, f.kind, f.txt);
            spec.splice(i--, 1);
        }
        for(let i = 0; i < sigs.length; i++){
            const g = sigs[i];
            if(g.at > now) continue;
            const t = byId[g.to];
            if(t && dark(t.name)) continue;
            if(t) t.c.__onSig(g.from, g.type, g.payload);
            sigs.splice(i--, 1);
        }
    };

    // ---- per-client tick ----
    const fireOnce = (o) => {
        o.c.__now = 0 | o.next;
        if(!o.spec){
            const v = o.c.__view();
            if(v) applyDir(o.c, dir(v));
        }
        if(o.c.__alive()) o.c.__tick1();
        if(o.c.__alive()) o.c.__tickCatchup();   // the spectator's whole pacing story rides this
        o.k++; o.next = o.k * TICK;
    };
    const applyDir = (C, out) => {
        if(!out) return;
        if(out.boost === 'end') C.__boostEnd();
        else if(out.boost) C.__boost(out.boost, out.now);
        if(out.steer) C.__steer(out.steer);
    };

    // ---- divergence: every spectator against the players, at a settled past tick ----
    const SNAP = cl.A.c.__rbSnap();
    const LAG = opts.settleLag || cl.A.c.__rbDepth();
    let firstDiverge = null;
    // The two PLAYERS get the same from/to/clean bookkeeping a spectator gets, and for the
    // same reason. While the wire is dark both sides run on prediction, so a blackout leaves
    // a wrong stretch of shared history behind it and "they never disagreed" was never the
    // claim rollback makes. The claim is that they agreed AGAIN afterwards -- a last
    // agreement past the last disagreement, which is the spectator predicate one tier up.
    const pair = { divN:0, divFrom:null, divTo:null, divClean:null };
    const cmp = { checks:0 };
    const checkDiverge = () => {
        const st = Math.min(cl.A.c.__simTick(), cl.B.c.__simTick()) - LAG;
        const tk = st - (st % SNAP);
        if(tk < SNAP) return;
        const ha = cl.A.c.__ringHashAt(tk), hb = cl.B.c.__ringHashAt(tk);
        if(ha != null && hb != null){
            if(ha !== hb){
                if(!firstDiverge) firstDiverge = { who:'A/B', tick:tk, fields:diffFields(cl.A.c, cl.B.c, tk) };
                if(pair.divFrom == null) pair.divFrom = tk;
                pair.divTo = tk; pair.divN++;
            } else if(pair.divTo != null) pair.divClean = tk;
        }
        if(ha == null) return;
        for(const n of names){
            const o = cl[n];
            if(!o.spec || !o.c.__specOn()) continue;
            const hs = o.c.__ringHashAt(tk);
            if(hs == null) continue;            // not that far along yet: the bias IS lateness
            cmp.checks++;
            o.cmp = (o.cmp | 0) + 1;
            if(hs !== ha){
                // A spectator is only ever as right as its FEED. While the feed is silent it has
                // no inputs to apply and extrapolates, so an outage leaves a wrong stretch of
                // history behind it. The claim is not "never wrong": it is that every mismatch
                // sits inside a known outage and that the node re-converges EXACTLY afterwards.
                if(!firstDiverge) firstDiverge = { who:n, tick:tk, fields:diffFields(cl.A.c, o.c, tk) };
                if(o.divFrom == null) o.divFrom = tk;
                o.divTo = tk; o.divN = (o.divN | 0) + 1;
            } else if(o.divTo != null) o.divClean = tk;
        }
    };
    const diffFields = (x, y, tk) => {
        const fx = x.__ringFieldsAt(tk) || {}, fy = y.__ringFieldsAt(tk) || {};
        return Object.keys(fx).filter(k => fx[k] !== fy[k]);
    };

    // ---- pacing: how far behind the players each spectator actually SITS ----
    // Under a flat offset the interesting number is not any one node's distance from the
    // players -- it is the distance between two SPECTATORS at the same instant, because a
    // tier is a routing fact and must not decide which frame you are looking at. lagSpread
    // is therefore sampled ACROSS the watchers, not accumulated per node: their common drift
    // against the players cancels, and only disagreement between them survives.
    // A node is judged only once SPEC_SETTLE_MS have passed since it came up, because the
    // boot deliberately starts low and climbs onto the target from below. Rollbacks are
    // banked because _rbReset zeroes the tally at every level boundary.
    const SPEC_SETTLE_MS = 1500;
    let lagSpread = 0;
    const sampleLag = (now) => {
        const ta = cl.A.c.__simTick(), tk = [];
        for(const n of names){
            const o = cl[n];
            if(!o.spec || !o.c.__specOn() || !o.c.__alive()) continue;
            const rb = o.c.__rbDbg().rb | 0;
            if(rb < (o.rbLast | 0)) o.rbBank = (o.rbBank | 0) + (o.rbLast | 0);
            o.rbLast = rb;
            if(o.lagT0 == null) o.lagT0 = now;
            if(now - o.lagT0 < SPEC_SETTLE_MS) continue;
            const lag = ta - o.c.__simTick();
            o.lagMin = o.lagMin == null ? lag : Math.min(o.lagMin, lag);
            o.lagMax = o.lagMax == null ? lag : Math.max(o.lagMax, lag);
            tk.push(o.c.__simTick());
        }
        if(tk.length > 1) lagSpread = Math.max(lagSpread, Math.max(...tk) - Math.min(...tk));
    };

    // ---- level boundaries: the real P2P path, host-authored over the wire ----
    let lastBoundaryLevel = 0, levelUps = 0;
    const maybeLevelUp = () => {
        const va = cl.A.c.__view(), vb = cl.B.c.__view();
        if(!(va && vb && va.waiting && vb.waiting)) return;
        if(va.level === lastBoundaryLevel) return;
        lastBoundaryLevel = va.level;
        cl.A.c.__reqNextLevel();
        levelUps++;
    };

    // ---- run ----
    let exitReason = null, diedAt = 0, levelReached = 1, nextLive = 0;
    const trace = [], txSeries = [], pairB = {};
    const TAIL = opts.settleTail | 0;
    for(let now = 0; now <= secs * 1000 + TAIL; now++){
        calm = now > secs * 1000;
        darkSet = null;
        if(!calm) for(const o of outs) if(now >= o.at && now < o.at + o.ms){
            (darkSet || (darkSet = new Set())).add(o.who); o.hits++;
        }
        for(const n of names) cl[n].c.__now = now;
        if(!started && now >= playersAt) startPlayers();
        for(const n of names) cl[n].c.__fire();
        if(now >= nextLive){   // production's 250ms liveness pass (warn / reconnect / keepalive / kill)
            for(const n of names) if(cl[n].c.__alive()) cl[n].c.__live();
            nextLive += 250;
        }

        for(const n of names){
            const o = cl[n];
            if(!o.spec || o.asked || now < o.at) continue;
            o.asked = true;
            for(const f of o.from){ const t = cl[f]; if(t) o.c.__watch(t.id, 't0', 'r1.0'); }
        }
        for(const k of kills){
            if(k.done || now < k.at) continue;
            k.done = true;
            // '@feed:S3' kills whichever client is feeding S3 right now. Which of two
            // interchangeable primaries a secondary settled on is a race, not a fact a
            // test should hard-code -- but "the one you are actually using dies" is
            // exactly the scenario worth killing.
            let who = k.who;
            if(who.indexOf('@feed:') === 0){
                const src = cl[who.slice(6)] ? cl[who.slice(6)].c.__specSrc() : '';
                who = (byId[src] && byId[src].name) || '';
            }
            const victim = cl[who];
            if(!victim) continue;
            k.hit = who;
            // The node vanishes from the tree: every peer holding a link to it sees a close.
            for(const n of names){ if(n === who) continue; cl[n].c.__spCut(victim.id); }
            victim.c.__specStop();
            victim.gone = true;
        }

        if(started && (!cl.A.c.__alive() || !cl.B.c.__alive())){ exitReason = 'session-end'; diedAt = now / 1000; break; }
        if(cl.A.c.__phase() === 'duelOver' || cl.B.c.__phase() === 'duelOver'){ exitReason = 'duelOver'; diedAt = now / 1000; break; }

        for(const n of names){ const o = cl[n]; while(now >= o.next) fireOnce(o); }
        emitDuel(cl.A, 'AB'); emitDuel(cl.B, 'BA');
        drainDuel(duel.AB, cl.B.c, 'B'); drainDuel(duel.BA, cl.A.c, 'A');
        pumpSpec(now);
        if(now % 1000 === 0){
            const row = { at:now };
            for(const n of names) row[n] = cl[n].txB | 0;
            txSeries.push(row);
        }
        if(!calm) maybeLevelUp();   // no new boundary in the coda: it is a settle, not more game
        checkDiverge();
        if(now % 50 === 0) sampleLag(now);
        const va = cl.A.c.__view(); if(va) levelReached = Math.max(levelReached, va.level);
        if(opts.onSample) opts.onSample(now, cl, trace);
    }

    const spectators = {};
    for(const n of names){
        const o = cl[n];
        if(!o.spec) continue;
        spectators[n] = {
            on: o.c.__specOn(), role: o.c.__specRole(), hops: o.c.__specHops(), gen: o.c.__specGen(),
            bias: o.c.__specBias(), dbg: o.c.__specDbg(), authored: o.c.__authoredN(),
            upTypes: o.c.__upTypes(),
            cmp: o.cmp | 0, divFrom: o.divFrom == null ? null : o.divFrom, divTo: o.divTo == null ? null : o.divTo,
            divN: o.divN | 0, divClean: o.divClean == null ? null : o.divClean,
            inN: o.c.__inN(), outN: o.c.__outN(), subN: o.c.__subN(), askN: o.c.__askN(), txB: o.txB | 0,
            lag: (o.c.__specOn() && o.c.__alive()) ? cl.A.c.__simTick() - o.c.__simTick() : null,
            lagMin: o.lagMin == null ? null : o.lagMin, lagMax: o.lagMax == null ? null : o.lagMax,
            rb: (o.rbBank | 0) + (o.rbLast | 0),
            warn: o.c.__warn(), sig: o.c.__sigDump(), gone: !!o.gone,
            // Nothing ever drains a spectator's DUEL outbox, so whatever sits in it is
            // every packet it tried to send toward the two players. The iron rule says none.
            duelOut: o.c.__out.length,
        };
    }
    const players = {};
    for(const n of ['A', 'B']) players[n] = { outN:cl[n].c.__outN(), inN:cl[n].c.__inN(), askN:cl[n].c.__askN(),
                                              role:cl[n].c.__specRole(), gen:cl[n].c.__specGen(),
                                              txB:cl[n].txB | 0,
                                              dbg:cl[n].c.__specDbg(), sig:cl[n].c.__sigDump() };
    return {
        firstDiverge, pairDiv:pair, exitReason, diedAt, levelUps, levelReached, checks:cmp.checks, txSeries, pairB,
        lagSpread,
        // The match's own verdict, straight off the sim: -1 nobody yet, 0/1 a winner, 2 a draw.
        winner: cl.A.c.__winner(), score: cl.A.c.__score(), lives: cl.A.c.__lives(), len: cl.A.c.__len(),
        outages: outs.map(o => ({ who:o.who, at:o.at, ms:o.ms, hits:o.hits })), tail:TAIL,
        killed: kills.map(k => k.hit || null),
        spectators, players, cl, trace,
        rbA: cl.A.c.__rbDbg(), rbB: cl.B.c.__rbDbg(),
        warnA: cl.A.c.__warn(), warnB: cl.B.c.__warn(),
    };
}

module.exports = { runSpec, mkClient, SPEC_HOOKS, P_ID, S_ID, NET_BASE };
