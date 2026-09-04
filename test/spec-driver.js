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
//           tail, ssub standby, sreq), the envelope sequence/generation dedup, the
//           boot delay, the bias, the failover ladder, and the sim itself.
//   FAKED -- the WebRTC half only: SDP and ICE are replaced by a two-step driver
//           connect, and each spectator DataChannel is a queue with the same one-way
//           delay/jitter model as the duel wire (ordered and lossless, as SCTP
//           reliable-ordered guarantees).
//
// Signals (watch / offer / answer) ride a driver bus with a configurable one-way delay,
// standing in for the server's long-poll drain.
const { runInGame, HOOKS, autopilot, NET_BASE } = require('./duel-driver');

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
//   opts.director    input director (default duel-driver's autopilot)
//   opts.onSample    (now, cl) diagnostic tap
function runSpec(opts){
    const secs = opts.secs || 14;
    const seed = (opts.seed >>> 0) || 0xD0E1;
    const W = opts.wire || { base:20, jit:6 };
    const SW = opts.specWire || { base:W.base, jit:W.jit };
    const SIG = opts.sigMs == null ? 120 : opts.sigMs;
    const dir = opts.director || autopilot;
    const watchers = opts.watchers || [];
    const kills = (opts.kill || []).map(k => ({ at:Math.round(k.at * 1000), who:k.who, done:false }));

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
    cl.A.c.__p2pStart(seed, 'host', null, null);
    cl.B.c.__p2pStart(seed, 'peer', null, null);
    cl.A.c.__setPeer(P_ID.B); cl.B.c.__setPeer(P_ID.A);
    watchers.forEach((w, i) => {
        const name = 'S' + (i + 1);
        const o = add(name, S_ID[i], mkClient(S_ID[i], opts.hookS), true);
        o.c.__specInit();
        o.at = Math.round(w.at * 1000);
        o.from = [].concat(w.from);      // one entry, or two for a dual-connect standby
        o.asked = false;
    });
    const names = Object.keys(cl);
    const TICK = cl.A.c.__TICK;

    // ---- wires ----
    const duel = { AB:[], BA:[] };                        // the players' unreliable channel
    const spec = [];                                      // [{ at, toId, fromId, kind, txt }]
    const sigs = [];                                      // [{ at, from, to, type, payload }]
    const lastSpecAt = {};                                // ordered delivery per directed link
    const oneWay = (w) => Math.max(1, (w.base || 3) + (rnd() * 2 - 1) * (w.jit || 0));

    const emitDuel = (o, dirn) => {
        for(const txt of o.c.__out.splice(0)){
            let t = '?'; try{ t = (JSON.parse(txt).t) || '?'; }catch(e){}
            if(t === 'pi') continue;
            if(rnd() < (W.loss || 0)) continue;
            duel[dirn].push([o.c.__now + oneWay(W), txt]);
        }
    };
    const drainDuel = (q, C) => { for(let j = 0; j < q.length; j++){
        if(q[j][0] <= C.__now){ C.__recv(q[j][1]); q.splice(j--, 1); } } };

    const pumpSpec = (now) => {
        for(const n of names){
            const o = cl[n];
            for(const f of o.c.__spDrain()){
                const key = o.id + '>' + f.to;
                // Reliable and ORDERED: a frame never overtakes the one before it.
                const at = Math.max(now + oneWay(SW), (lastSpecAt[key] || 0) + 0.001);
                lastSpecAt[key] = at;
                o.txB = (o.txB | 0) + f.txt.length;
                const pk = n + '>' + ((byId[f.to] && byId[f.to].name) || f.to);
                pairB[pk] = (pairB[pk] | 0) + f.txt.length;
                spec.push({ at, toId:f.to, fromId:o.id, kind:(f.kind === 'out' ? 'in' : 'out'), txt:f.txt });
            }
            for(const s of o.c.__sigDrain()) sigs.push({ at:now + SIG, from:s.from, to:s.to, type:s.type, payload:s.payload });
        }
        for(let i = 0; i < spec.length; i++){
            const f = spec[i];
            if(f.at > now) continue;
            const t = byId[f.toId];
            if(t) t.c.__spFeed(f.fromId, f.kind, f.txt);
            spec.splice(i--, 1);
        }
        for(let i = 0; i < sigs.length; i++){
            const g = sigs[i];
            if(g.at > now) continue;
            const t = byId[g.to];
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
    const cmp = { checks:0 };
    const checkDiverge = () => {
        const st = Math.min(cl.A.c.__simTick(), cl.B.c.__simTick()) - LAG;
        const tk = st - (st % SNAP);
        if(tk < SNAP) return;
        const ha = cl.A.c.__ringHashAt(tk), hb = cl.B.c.__ringHashAt(tk);
        if(ha != null && hb != null && ha !== hb && !firstDiverge)
            firstDiverge = { who:'A/B', tick:tk, fields:diffFields(cl.A.c, cl.B.c, tk) };
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
    for(let now = 0; now <= secs * 1000; now++){
        for(const n of names) cl[n].c.__now = now;
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

        if(!cl.A.c.__alive() || !cl.B.c.__alive()){ exitReason = 'session-end'; diedAt = now / 1000; break; }
        if(cl.A.c.__phase() === 'duelOver' || cl.B.c.__phase() === 'duelOver'){ exitReason = 'duelOver'; diedAt = now / 1000; break; }

        for(const n of names){ const o = cl[n]; while(now >= o.next) fireOnce(o); }
        emitDuel(cl.A, 'AB'); emitDuel(cl.B, 'BA');
        drainDuel(duel.AB, cl.B.c); drainDuel(duel.BA, cl.A.c);
        pumpSpec(now);
        if(now % 1000 === 0){
            const row = { at:now };
            for(const n of names) row[n] = cl[n].txB | 0;
            txSeries.push(row);
        }
        maybeLevelUp();
        checkDiverge();
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
            cmp: o.cmp | 0, divFrom: o.divFrom == null ? null : o.divFrom, divTo: o.divTo == null ? null : o.divTo,
            divN: o.divN | 0, divClean: o.divClean == null ? null : o.divClean,
            inN: o.c.__inN(), outN: o.c.__outN(), subN: o.c.__subN(), txB: o.txB | 0,
            lag: (o.c.__specOn() && o.c.__alive()) ? cl.A.c.__simTick() - o.c.__simTick() : null,
            warn: o.c.__warn(), sig: o.c.__sigDump(), gone: !!o.gone,
            // Nothing ever drains a spectator's DUEL outbox, so whatever sits in it is
            // every packet it tried to send toward the two players. The iron rule says none.
            duelOut: o.c.__out.length,
        };
    }
    const players = {};
    for(const n of ['A', 'B']) players[n] = { outN:cl[n].c.__outN(), inN:cl[n].c.__inN(),
                                              role:cl[n].c.__specRole(), gen:cl[n].c.__specGen(),
                                              txB:cl[n].txB | 0,
                                              dbg:cl[n].c.__specDbg(), sig:cl[n].c.__sigDump() };
    return {
        firstDiverge, exitReason, diedAt, levelUps, levelReached, checks:cmp.checks, txSeries, pairB,
        killed: kills.map(k => k.hit || null),
        spectators, players, cl, trace,
        rbA: cl.A.c.__rbDbg(), rbB: cl.B.c.__rbDbg(),
        warnA: cl.A.c.__warn(), warnB: cl.B.c.__warn(),
    };
}

module.exports = { runSpec, mkClient, SPEC_HOOKS, P_ID, S_ID, NET_BASE };
