// ============================================================================
// net-spec.js -- the SPECTATOR wire: watching a duel you are not playing, and
// serving that feed on to others. Loads after net-session.js.
//
// The duel itself is untouched. _netSess stays exactly what it always was --
// ONE session, ONE unreliable DataChannel, two players -- and every spectator
// link lives here, on its own RTCPeerConnection with its own RELIABLE ordered
// channel. Nothing in this file can make a player's match slower.
//
// IRON RULE: a spectator runs the SAME sim as the players. It is not a video
// feed and not a second implementation -- it is duel-core with input authoring
// switched off, fed the two players' own wire packets verbatim.
//
//   feeder (a player)  --envelopes-->  primary 0 ------> secondaries
//                      --envelopes-->  primary 1 ------> secondaries
//
// A feeder serves at most SPEC_MAX_DIRECT links: fanning eight channels out of
// a phone mid-match is the one thing that would cost that player the match.
//
// WHY A SPECTATOR RUNS BEHIND. Its sim origin (startPts) is pushed SPEC_DELAY_MS
// per hop into the future, so its tick counter sits ~24 ticks under the feeder's.
// A forwarded input for tick X therefore arrives while X is still in the
// spectator's FUTURE: it lands in the input log and the tick loop applies it on
// time. No rollback, ever, on a healthy feed -- which is what makes a two-tier
// tree affordable. The bias is only useful if the sim actually HOLDS it, and the
// tick loop steers forward only (see game.js: "the shared clock STEERS this"),
// so the boot is DELAYED by the same bias: we buffer the feed, start the sim
// deliberately late, and the one-extra-tick-per-frame correction settles us onto
// the biased target from below.
// ============================================================================

// One datagram is not the budget here: this channel is reliable and ordered, so
// SCTP fragmentation is a latency cost, not a loss risk. The cap exists to bound
// what a hostile feeder can make us parse -- an 'rs' with a long snake and a full
// bar list is the largest honest envelope, and it fits several times over.
const SPEC_PKT_MAX = 16384;
const SPEC_MAX_DIRECT = 2;      // direct spectators one node will serve (the tree's branching factor)
const SPEC_DELAY_MS = 400;      // how far behind the live edge a spectator runs, PER HOP
// Pre-negotiated like the duel channel (no DCEP round trip), but ORDERED and
// RELIABLE -- the opposite of the duel's. A spectator has no second copy of a
// lost envelope to fall back on: it authors nothing, so there is no redundant
// input log repairing its stream. id 1 (not 0) purely so a channel is
// identifiable as a spectator one; each link has its own pc, so ids never clash.
const SPEC_DC_OPTS = { negotiated:true, id:1, ordered:true };
const SPEC_SILENCE_MS = 1500;      // a feed this quiet is dead: fail over to the standby
const SPEC_FEED_SILENCE_MS = 2000; // the FEEDER is quiet: primaries pull the backup feeder
const SPEC_CKPT_MS = 10000;        // checkpoint 'rs' cadence, so a late joiner needs a bounded tail
const SPEC_BUF_MAX = 900;          // envelopes held since the checkpoint (~45s of duel traffic)
const SPEC_GRANT_MS = 30000;       // how long a granted watch request stays good
// A watch that arrives BEFORE the match it names is the ORDINARY case, not an error: a
// tournament deals the roles sheet to players and spectators in one signal drain, and the
// two players still have an offer/answer/ICE/go handshake in front of them. So neither end
// treats "not yet" as a verdict -- the node parks the ask until it has a timeline, and the
// asker keeps asking ('watch' is not in the receipt set, so a lost one has to be re-sent).
const SPEC_ASK_RETRY_MS = 1500;    // re-ask cadence for a watch nobody has answered
const SPEC_ASK_TTL_MS = 20000;     // how long an unanswered ask stays live, at EITHER end
// What a spectator's sim actually needs. 'pi' (liveness) and 'bs' (clock burst) are
// the two players' business; 'req' is an ask, never an effect. Everything else in
// the duel protocol IS the timeline: 'go' opens boundaries, 'in' carries inputs,
// 'st'/'rs' repair, 'h' proves we still agree, 'bye' ends it.
const SPEC_FWD = { go:1, in:1, st:1, rs:1, bye:1, h:1 };

// ---- state --------------------------------------------------------------
var _spOut = [];        // links I SERVE (downstream)
var _spIn  = [];        // links FEEDING me (upstream; two while dual-connected)
var _spOn = false;      // I am spectating (my sim is being driven by a feed)
var _spHops = 1;        // how many forwarding hops from the feeder I sit
var _spGen = 0;         // FEED generation: bumped when a backup feeder takes over
var _spSeq = 0;         // my outbound envelope sequence, as a feeder
var _spSeen = -1;       // highest envelope seq applied (dedup across a dual-connect)
var _spCtx = null;      // the bootstrap context I hold (mine as feeder, or the one I was sent)
var _spRs = null;       // newest checkpoint 'rs' envelope
var _spBuf = [];        // envelopes since _spRs, for a late joiner
var _spQ = [];          // pre-boot buffer (see the boot-delay note in the header)
var _spBootT = null;    // the pending boot timer
var _spRole = '';       // '' | 'feeder' | 'primary' | 'secondary'
var _spTid = '', _spNid = '';
var _spGrant = {};      // peer id -> ms when we authorised it to open a spectator link
var _spWant = [];       // MY outstanding watch requests: [{to, at, last}] -- a secondary asks BOTH primaries
var _spAsk = [];        // asks PARKED on me, waiting for a match to serve: [{from, at}]
var _spT = null;        // the 250ms housekeeping timer
var _spSrc = '';        // peer id of the link currently feeding me
var _spLostAt = 0;
var _spOrphanG = -1;    // generation the server was last told we had run out of sources in      // when the feed first fell silent (the terminal deadline runs off this)
var _spCkptAt = 0;
var _spReqAt = 0;       // last fresh-state ask (throttle)
var _spFeedAt = 0;      // wall time of the last envelope that reached me
var _spDbg = { rx:0, tx:0, dup:0, over:0, fail:0, gen:0, boot:0 };

// ---- predicates the rest of the app asks ---------------------------------
// TRUE while this client is watching a match rather than playing one. The duel
// core reads it to disable input authoring, exempt the resync adoption gate and
// widen the future window; _netSend reads it to guarantee we transmit NOTHING
// toward the two players. A spectator is invisible to the match it watches.
function netSpectating(){ return _spOn; }
function netSpecRole(){ return _spRole; }
function netSpecDbg(){ return _spDbg; }
// How long since anything reached us off the feed, in ms (0 before the first envelope).
// The spectator's equivalent of the duel's silence detector -- and the only thing its
// banner needs, because a spectator has no second measure of "is this working".
function netSpecFeedAge(){ return (_spOn && _spFeedAt) ? (_spNow() - _spFeedAt) : 0; }
// The sim-origin bias in ms: how far behind the live edge we deliberately run.
function netSpecBias(){ return _spOn ? SPEC_DELAY_MS * Math.max(1, _spHops|0) : 0; }
// The two players' worn-item lists / display names / snake looks, in PLAYER order,
// taken from the bootstrap context. A spectator owns neither snake, so every
// per-player presentation input has to come off the wire rather than from cfg.
function netSpecWs(){ return (_spOn && _spCtx && Array.isArray(_spCtx.ws)) ? _spCtx.ws : null; }
function netSpecNames(){ return (_spOn && _spCtx && Array.isArray(_spCtx.names)) ? _spCtx.names : null; }
function netSpecLook(){ return (_spOn && _spCtx && _spCtx.look && typeof _spCtx.look === 'object') ? _spCtx.look : null; }

// ---- small helpers -------------------------------------------------------
function _spNow(){ return (typeof _wall === 'function') ? _wall() : Date.now(); }
function _spRtcOk(){ return typeof RTCPeerConnection === 'function'; }
function _spSend(l, o){
    if(!l || !l.dc || l.dc.readyState !== 'open') return false;
    try{
        const j = JSON.stringify(o);
        if(j.length > SPEC_PKT_MAX){ _spDbg.over++; return false; }
        l.dc.send(j); _spDbg.tx++; return true;
    }catch(e){ return false; }
}
function _spFind(arr, peer){ for(const l of arr) if(l.peer === peer) return l; return null; }
// Take a pending watch request off the list, answering "was this reply ours to act on" --
// and handing back the entry, because a refusal we mean to retry has to keep its deadline.
function _spWantDrop(peer){
    for(let i = _spWant.length - 1; i >= 0; i--) if(_spWant[i].to === peer) return _spWant.splice(i, 1)[0];
    return null;
}
// Put an unanswered ask back on the ladder, keeping its ORIGINAL deadline: a re-ask is a
// retry of one request, not a new one, and must not buy itself more time. Pointless once we
// have a source -- a booted spectator chases nothing.
function _spWantKeep(w){
    if(!w || _spOn || _spCtx || _spBootT != null) return;
    _spWant.push({ to:w.to, at:w.at, last:_spNow() });
    _spArm();
}
function _spGrantOk(peer){ const g = _spGrant[peer] || 0; return !!g && _spNow() - g <= SPEC_GRANT_MS; }
// Hold an ask we cannot serve yet. Re-asking refreshes it rather than stacking: the asker
// gives up on its own deadline, and this list must not outlive that.
function _spAskPark(from){
    for(const a of _spAsk) if(a.from === from){ a.at = _spNow(); return; }
    _spAsk.push({ from, at:_spNow() });
    _spArm();
}
function _spKill(l){
    if(!l) return;
    try{ if(l.dc) l.dc.close(); }catch(e){}
    try{ if(l.pc) l.pc.close(); }catch(e){}
    l.dead = true;
}
function _spDrop(arr, peer){
    for(let i = arr.length - 1; i >= 0; i--) if(arr[i].peer === peer){ _spKill(arr[i]); arr.splice(i, 1); }
}
function _spPrune(){
    for(let i = _spOut.length - 1; i >= 0; i--) if(_spOut[i].dead) _spOut.splice(i, 1);
    for(let i = _spIn.length - 1; i >= 0; i--) if(_spIn[i].dead) _spIn.splice(i, 1);
}
// Housekeeping runs while we serve OR consume; _spTick stops it when neither is true.
function _spArm(){
    if(_spT != null || typeof setInterval !== 'function') return;
    _spT = setInterval(_spTick, 250);
}
function _spDisarm(){ if(_spT != null){ clearInterval(_spT); _spT = null; } }

// ---- signalling ----------------------------------------------------------
// Spectator SDP/ICE rides the SAME signal types as the duel's; the sp:1 marker is
// what tells the two apart. Reusing the types keeps the server contract at exactly
// the one new client-sendable signal the API documents ('watch') -- a separate
// 'sp-offer' type would have needed a server change for no gain.
function _spSignal(to, type, obj){
    obj.sp = 1;
    _netSignal(to, type, JSON.stringify(obj));
}
// The watch handshake. Payload keys tid/nid are the documented contract; k carries
// the step. 'watch' is not in the receipt set, so a lost one is simply a feed that
// never starts -- failing to get a feed is not a failed connection.
function _spWatchSig(to, k, extra){
    _netSignal(to, 'watch', JSON.stringify(Object.assign({ tid:_spTid, nid:_spNid, k }, extra || {})));
}
function _spMkPc(peer, arr, kind){
    const pc = new RTCPeerConnection({ iceServers:[{ urls:NET_STUN_URL }] });
    const l = { peer, pc, dc:null, rdOk:false, iceQ:[], sub:false, kind, dead:false,
                openAt:0, lastAt:_spNow(), live:false };
    pc.onicecandidate = e => { if(e.candidate) _spSignal(peer, 'ice', { c:e.candidate }); };
    pc.onconnectionstatechange = () => {
        if(pc.connectionState !== 'failed' && pc.connectionState !== 'closed') return;
        _spDbg.fail++;
        _spDrop(arr, peer);
        if(kind === 'in') _spFeedGone(peer);
    };
    arr.push(l);
    return l;
}
function _spWire(l, onMsg){
    l.dc.onopen = () => { l.openAt = _spNow(); l.lastAt = _spNow(); if(l.kind === 'out') _spServeOpen(l); };
    l.dc.onmessage = e => { l.lastAt = _spNow(); onMsg(l, String(e.data)); };
    l.dc.onclose = () => { if(l.kind === 'in') _spFeedGone(l.peer); };
}
// WE offer: the watcher initiates, so a feeder never has to hold pending state for
// a spectator that may never come back.
async function _spOffer(peer){
    if(!_spRtcOk()) return;
    _spDrop(_spIn, peer);
    const l = _spMkPc(peer, _spIn, 'in');
    l.dc = l.pc.createDataChannel('fokspec', SPEC_DC_OPTS);
    _spWire(l, _spOnFeedMsg);
    try{
        const of = await l.pc.createOffer();
        await l.pc.setLocalDescription(of);
        _spSignal(peer, 'offer', { sdp:l.pc.localDescription });
        _spArm();
    }catch(e){ _spDrop(_spIn, peer); }
}
async function _spAnswer(peer, d){
    if(!_spRtcOk() || !d || !d.sdp) return;
    // Only a peer we granted may open a link, and only while the grant is fresh.
    // Without this, any id could make a player fan a channel out mid-match.
    // `|0` here would be a silent disaster: a wall-clock ms does not fit in an int32,
    // so every grant would read as stale and no spectator link would ever open.
    const g = _spGrant[peer] || 0;
    if(!g || _spNow() - g > SPEC_GRANT_MS) return;
    if(_spOut.length >= SPEC_MAX_DIRECT && !_spFind(_spOut, peer)) return;
    _spDrop(_spOut, peer);
    const l = _spMkPc(peer, _spOut, 'out');
    l.dc = l.pc.createDataChannel('fokspec', SPEC_DC_OPTS);
    _spWire(l, _spOnServeMsg);
    try{
        await l.pc.setRemoteDescription(d.sdp);
        l.rdOk = true; _spIceFlush(l);
        const an = await l.pc.createAnswer();
        await l.pc.setLocalDescription(an);
        _spSignal(peer, 'answer', { sdp:l.pc.localDescription });
        _spArm();
    }catch(e){ _spDrop(_spOut, peer); }
}
function _spIceFlush(l){
    if(!l.iceQ.length) return;
    const q = l.iceQ; l.iceQ = [];
    for(const c of q){ try{ l.pc.addIceCandidate(c).catch(()=>{}); }catch(e){} }
}
function _spIceAdd(l, c){
    if(!l || !l.pc || !c) return;
    if(!l.rdOk){ l.iceQ.push(c); return; }
    try{ l.pc.addIceCandidate(c).catch(()=>{}); }catch(e){}
}
// Routed here from _netOnSignal BEFORE the duel's own offer/answer/ice cases: a
// spectator link must never be mistaken for a reconnect of the match.
function _spOnSignal(type, from, d){
    if(type === 'offer'){ _spAnswer(from, d); return; }
    const l = _spFind(_spIn, from) || _spFind(_spOut, from);
    if(!l || !l.pc) return;
    if(type === 'answer'){
        if(!d.sdp) return;
        l.pc.setRemoteDescription(d.sdp).then(()=>{ l.rdOk = true; _spIceFlush(l); }).catch(()=>{});
        return;
    }
    if(type === 'ice') _spIceAdd(l, d.c);
}
// The watch round trip. A request may be answered 'ok' (open a link), or 'no' with
// an optional redirect to a node that still has room -- which is how the tree fills
// out when nobody assigned roles (a plain "watch a friend", no tournament).
function _spOnWatch(from, d){
    const k = d && d.k;
    if(k === 'req'){
        const can = !_spOn && netGameActive() && inGame && !!_spCtxBuild() && _spOut.length < SPEC_MAX_DIRECT;
        const relay = _spOn && !!_spCtx && _spOut.length < SPEC_MAX_DIRECT;
        if(can || relay){
            _spGrant[from] = _spNow();
            _spWatchSig(from, 'ok');
            _spArm();
            return;
        }
        // Not servable YET rather than not servable. Our own sheet named this peer, and we
        // are still working through the handshake that will give us something to serve --
        // so PARK the ask and answer it the moment there is a timeline (_spAskPump). The
        // grant is the gate: only a peer the sheet introduced can make us hold state, and
        // that is exactly the set with a reason to be early. A FULL fan-out is a different
        // answer and keeps the redirect below: room is what it is short of, not time.
        if(_spOut.length + _spAsk.length < SPEC_MAX_DIRECT && _spGrantOk(from)){
            _spAskPark(from);
            return;
        }
        // Refused, but not turned away: hand back EVERY node we are already serving.
        // The asker takes the first as its feed and the rest as warm standbys, which
        // is what makes a primary's death cost one flag instead of a fresh connect.
        _spWatchSig(from, 'no', { alt:(_spOut.length ? _spOut[0].peer : ''), alts:_spOut.map(l => l.peer) });
        return;
    }
    if(k === 'ok'){
        if(!_spWantDrop(from)) return;
        _spOffer(from);
        return;
    }
    if(k === 'no'){
        const w = _spWantDrop(from);
        if(!w) return;
        const list = Array.isArray(d.alts) ? d.alts : [d.alt];
        const alts = [];
        for(const a of list){
            const v = String(a || '');
            if(/^[0-9a-f]{8}$/.test(v) && v !== getPlayerId() && !_spFind(_spIn, v)) alts.push(v);
        }
        // Refused with nowhere else to send us. Stay on the ladder instead of taking it as
        // the answer: a node with no room says so by naming who does, so a bare refusal
        // means it had nothing to serve -- which is a state that ends in seconds.
        if(!alts.length){ _netSigLog('! watch refused'); _spWantKeep(w); return; }
        for(const a of alts.slice(0, SPEC_MAX_DIRECT)) specWatch(a, _spTid, _spNid);
        return;
    }
    // A primary asking the OTHER player to become the backup feeder. Lockstep means
    // that player already holds BOTH input streams, so it can serve the identical
    // timeline the dead feeder was serving -- under a bumped generation, which is
    // what tells everyone downstream to restart their sequence line.
    if(k === 'feed-req'){
        if(_spOn || !netGameActive() || !inGame) return;
        _spGen = Math.max(_spGen | 0, d.g | 0) + 1;
        _spSeq = 0;
        _spDbg.gen++;
        _spGrant[from] = _spNow();
        _spRole = 'feeder';
        _spRs = null; _spBuf = []; _spCkptAt = 0;   // the new generation starts on a fresh checkpoint
        _spWatchSig(from, 'ok');
        _spArm();
    }
}
// Pre-authorise the peers a tournament roles sheet says will connect to us, so the
// watch round trip is skipped entirely on the assigned path (the sheet IS the
// introduction). Phase E calls this on every roles / roles-patch signal.
function specGrant(ids){
    const now = _spNow();
    for(const id of (ids || [])) if(/^[0-9a-f]{8}$/.test(String(id))) _spGrant[String(id)] = now;
}
// Declare which match we are serving/watching, so both ends of a watch name the
// same node. '' outside a tournament (the doc allows a bare watch: a request the
// recipient may honour or ignore).
function specNode(tid, nid){ _spTid = String(tid || ''); _spNid = String(nid || ''); }
// Ask `peer` for a feed.
function specWatch(peer, tid, nid){
    if(!/^[0-9a-f]{8}$/.test(String(peer || ''))) return;
    if(tid !== undefined || nid !== undefined) specNode(tid, nid);
    _spWantDrop(peer);
    _spWant.push({ to:peer, at:_spNow() });
    _netTimeSync();          // the feed's startPts is on the shared clock: we need it before the boot
    netP2POnlySet(true);     // every spectator link is direct or nothing
    _spWatchSig(peer, 'req');
    _spArm();
}

// ---- serving (feeder / primary) -----------------------------------------
// The bootstrap context: everything a fresh sim needs before the first 'rs' can
// mean anything. Built by the feeder from its live session; a relaying primary
// re-sends the one it was given with hops incremented, so every node downstream
// biases its own origin by its own depth.
function _spCtxBuild(){
    if(_spOn) return _spCtx ? Object.assign({}, _spCtx, { hops:(_spCtx.hops | 0) + 1, g:_spGen | 0 }) : null;
    const s = (typeof _netSess !== 'undefined') ? _netSess : null;
    if(!s || !s.game || !inGame) return null;
    const host = netMyIndex() === 0;
    // pids in PLAYER-INDEX order. A primary needs them to reach the OTHER player when its
    // feeder dies: under lockstep that player holds both input streams, so it is the only
    // node that can serve the identical timeline (see the backup-feeder step in _spTick).
    const me = getPlayerId();
    return { t:'sctx', g:_spGen | 0, hops:1, pids:(host ? [me, s.peer] : [s.peer, me]),
             seed:s.seed >>> 0, startPts:s.startPts || 0, ep:_netMyEpoch(),
             hm:s.hearts, stakes:!!s.stakes,
             ws:_duelWsLists(host), names:netPlayerNames(), look:netDuelLook() };
}
// One envelope. `p` is the AUTHOR's player index -- explicit, because a spectator
// receives both players' packets on one channel and cannot infer the author from
// its own role the way a duel peer can.
// The other player: the one named in the bootstrap context that is not feeding us. It is
// asked to become the BACKUP FEEDER, so it must be reachable even when the feeder's link is
// the thing that died -- which is why the ids ride the context rather than the live links.
// Both players named in the bootstrap context (never ourselves).
function _spPlayers(){
    const p = (_spCtx && Array.isArray(_spCtx.pids)) ? _spCtx.pids : [];
    const out = [];
    for(const id of p){ const v = String(id || ''); if(/^[0-9a-f]{8}$/.test(v) && v !== getPlayerId()) out.push(v); }
    return out;
}
function _spOther(){
    const p = (_spCtx && Array.isArray(_spCtx.pids)) ? _spCtx.pids : null;
    if(!p) return '';
    for(const id of p){ const v = String(id || ''); if(/^[0-9a-f]{8}$/.test(v) && v !== _spSrc && v !== getPlayerId()) return v; }
    return '';
}
function _spWrap(m, p){ return { t:'sp', g:_spGen | 0, n:_spSeq++, p:p | 0, m }; }
function _spPush(env){
    _spBuf.push(env);
    if(_spBuf.length > SPEC_BUF_MAX) _spBuf.shift();
    for(const l of _spOut) if(l.sub) _spSend(l, env);
}
// The two taps a feeder puts on its own duel. OUTBOUND: our packets, forwarded from
// the point where _netSend has finished stamping them -- so a spectator receives the
// exact bytes the opponent does. INBOUND: the opponent's packets, forwarded parsed.
// Both are no-ops with no spectators attached, which is every duel nobody watches.
function _spTapOut(o){
    if(_spOn || !_spOut.length || !o || !SPEC_FWD[o.t] || o.a === 1) return;
    _spPush(_spWrap(o, netMyIndex()));
}
function _spTapIn(m){
    if(_spOn || !_spOut.length || !m || !SPEC_FWD[m.t] || m.a === 1) return;
    // A spectator hash-checks against ONE author, or its 8-deep verdict queue thrashes;
    // the feeder's own hash is the one that answers "do I still agree with my source".
    if(m.t === 'h') return;
    _spPush(_spWrap(m, 1 - netMyIndex()));
}
// A relaying primary forwards verbatim: same generation, same sequence, so a
// secondary dual-connected to both primaries dedups the overlap for free.
function _spRelay(env){
    if(!_spOut.length) return;
    _spBuf.push(env);
    if(_spBuf.length > SPEC_BUF_MAX) _spBuf.shift();
    for(const l of _spOut) if(l.sub) _spSend(l, env);
}
// A fresh link asks for the stream; we answer with the whole bootstrap in order.
// A warm STANDBY unsubscribes right after (ssub 0): a secondary's second
// connection is held open and silent, so a failover costs one flag, not a connect.
function _spServeOpen(l){
    const ctx = _spCtxBuild();
    if(!ctx){ _spSend(l, { t:'sno' }); return; }
    _spSend(l, ctx);
    _spServeTail(l);
    l.sub = true;
    _spArm();
}
// Serve one link the whole bootstrap tail: a FRESH checkpoint, then every envelope
// since it. Minting first is what makes the tail short and, far more importantly, what
// makes it COMPLETE: the new node's sim lands within one bias of the live edge with an
// unbroken input log behind it. Serving a checkpoint that is merely the newest one we
// happen to hold would strand it seconds back with a hole where the inputs between that
// checkpoint and our first buffered envelope should be -- a hole nothing downstream can
// fill, because those packets are gone from every buffer in the tree.
//
// A relaying primary mints its OWN, and may: its world is byte-identical to the players'
// (that is the claim this whole file rests on), just one bias older -- which puts the
// state it hands down BEHIND its secondary's target, exactly where a boot needs it.
function _spServeTail(l){
    const was = l.sub; l.sub = false;   // the checkpoint's own fan-out must not double-send here
    _spCkpt(true);
    l.sub = was;
    if(_spRs) _spSend(l, _spRs);
    for(const env of _spBuf) _spSend(l, env);
}
function _spOnServeMsg(l, txt){
    let d; try{ d = JSON.parse(txt); }catch(e){ return; }
    if(!d || typeof d !== 'object') return;
    if(d.t === 'ssub'){ const on = d.on !== 0; if(on) _spServeTail(l); l.sub = on; return; }
    if(d.t === 'sreq'){ _spServeTail(l); return; }
}
// The checkpoint: a full 'rs' of our own sim, enveloped like any other packet, so a
// late joiner needs only [sctx, this, the tail since] rather than the whole match.
//
// THE SEQUENCE NUMBER IS THE POINT when a relaying primary mints one. Relaying is
// verbatim -- same generation, same n -- so that a secondary hanging off both primaries
// dedups the overlap for free, and a locally minted envelope must not invent a number in
// that space. It carries _spSeen: the number of the newest envelope already folded into
// the state, which is precisely what the checkpoint asserts. A fresh subscriber (seen
// -1) takes it and every later relay outranks it; a dual-connected one still dedups.
function _spCkpt(force){
    if(!_spOut.length || !inGame) return;
    const now = _spNow();
    if(!force && now - _spCkptAt < SPEC_CKPT_MS) return;
    const rs = _rbSpecSnapshot();
    if(!rs) return;
    _spCkptAt = now;
    const env = _spOn ? { t:'sp', g:_spGen | 0, n:_spSeen | 0, p:0, m:rs }
                      : _spWrap(rs, netMyIndex());
    _spRs = env; _spBuf = [];
    for(const l of _spOut) if(l.sub) _spSend(l, env);
}

// ---- consuming (spectator) ----------------------------------------------
function _spOnFeedMsg(l, txt){
    let d; try{ d = JSON.parse(txt); }catch(e){ return; }
    if(!d || typeof d !== 'object') return;
    if(d.t === 'sno'){
        // The link came up and the node had nothing to serve after all -- its match ended,
        // or had not started. A race with that match, not a verdict: drop the link and go
        // back on the ladder rather than sitting on a dead one.
        const peer = l.peer;
        _spDrop(_spIn, peer);
        _spWantKeep(_spWantDrop(peer) || { to:peer, at:_spNow() });
        return;
    }
    if(d.t === 'sctx'){ _spOnCtx(l, d); return; }
    if(d.t !== 'sp') return;
    _spDbg.rx++;
    _spFeedAt = _spNow();
    l.live = true;
    // A bumped generation means a DIFFERENT feeder now owns the stream: its
    // sequence starts over, so the dedup line has to start over with it.
    if((d.g | 0) > (_spGen | 0)){ _spGen = d.g | 0; _spSeen = -1; _spRs = null; _spBuf = []; _spDbg.gen++; }
    else if((d.g | 0) < (_spGen | 0)) return;      // a straggler from the dead generation
    if((d.n | 0) <= _spSeen){ _spDbg.dup++; return; }
    _spSeen = d.n | 0;
    // Keep serving what we consume (a primary is a spectator that also feeds).
    if(d.m && d.m.t === 'rs'){ _spRs = d; _spBuf = []; for(const o of _spOut) if(o.sub) _spSend(o, d); }
    else _spRelay(d);
    if(_spBootT != null){ _spQ.push(d); if(_spQ.length > SPEC_BUF_MAX) _spQ.shift(); return; }
    if(!_spOn) return;                          // context refused / not booted: nothing to drive
    _spDeliver(d);
}
function _spOnCtx(l, ctx){
    // A GENERATION BUMP: the BACKUP FEEDER has taken over. We do not re-boot -- our sim is
    // running and was correct up to the moment the old feeder went quiet -- we re-point the
    // feed at this link and let the fresh checkpoint behind this greeting close the gap.
    // Treating it as a standby instead would be fatal: the ssub 0 below would silence the
    // one node still able to feed us.
    if(_spOn && (ctx.g | 0) > (_spGen | 0)){
        _spGen = ctx.g | 0;
        _spCtx = ctx;
        _spSeen = -1;                            // the new generation restarts the sequence line
        _spRs = null; _spBuf = [];               // and so does anything we hold for our own watchers
        _spSrc = l ? l.peer : _spSrc;
        _spFeedAt = _spNow(); _spLostAt = 0;
        if(l) for(const o of _spIn) o.sub = (o === l);
        _spDbg.gen++;
        _netSigLog('~ SPEC GEN ' + _spGen);
        return;
    }
    // Running with NO live feed: this is the re-watch after our source died, so the
    // greeting is not a second source, it is our only one. Take it. Standing it down
    // here would leave the silence ladder to discover the mistake SPEC_SILENCE_MS
    // later, and every tick of that is a tick with no inputs to apply.
    //
    // _spHops and the bias it sets DO NOT MOVE. They are baked into this node's sim
    // origin; re-deriving them from the new context would shift the timeline under a
    // running world. Being one hop from the feeder while still pacing for two costs
    // nothing but slack, and slack is the one thing a spectator can afford.
    if(_spOn && l && !_spIn.some(x => x.sub)){
        l.sub = true;
        _spSrc = l.peer;
        _spFeedAt = _spNow(); _spLostAt = 0;
        _netSigLog('~ SPEC RESOURCE ' + String(l.peer).slice(0, 4));
        return;
    }
    // Already running (or about to): this greeting is our SECOND source -- the warm
    // STANDBY. Hold it open and tell it to go silent, so a failover later costs one
    // flag rather than a connect (see _spTick).
    if(_spOn || _spCtx || _spBootT != null){
        if(l && l.sub !== true){ l.sub = false; _spSend(l, { t:'ssub', on:0 }); }
        return;
    }
    if(l){ l.sub = true; _spSrc = l.peer; }     // this link is the ACTIVE feed: _spReq asks it
    _spCtx = ctx;
    _spGen = ctx.g | 0;
    _spHops = Math.max(1, ctx.hops | 0);
    _spRole = _spHops > 1 ? 'secondary' : 'primary';
    _spQ = [];
    // Boot DELIBERATELY LATE by exactly the bias this node runs at (see the header):
    // the sim then settles onto its biased target from BELOW, which is the only
    // direction the tick loop's one-extra-tick correction can move it.
    const wait = SPEC_DELAY_MS * _spHops;
    if(typeof setTimeout !== 'function'){ _spBoot(); return; }
    _spBootT = setTimeout(_spBoot, wait);
    _spArm();
}
function _spBoot(){
    _spBootT = null;
    const ctx = _spCtx;
    if(!ctx) return;
    if(netPts() == null){ _spCtx = null; _spQ = []; return; }   // no shared clock, no timeline
    if(_netSess) _netTeardown();
    // peer stays EMPTY on purpose. The synthetic session's "peer" would be our feeder, and
    // every duel-side courtesy that signals s.peer -- the 'bye' on _netSessionEnd above all --
    // would then land on a player mid-match and end THEIR duel. A spectator has no peer; it
    // has a feed, and the feed is owned by _spIn.
    _netSess = _netMkSess('', 'peer');
    _netSess.game = true;
    _netSess.p2pOnly = true;
    _netSess.seed = ctx.seed >>> 0;
    _netSess.hearts = _duelHearts(ctx.hm);
    _netSess.stakes = false;             // a spectator claims nothing: no item ever changes hands here
    _netSess.epoch = ctx.ep | 0;
    _netSess.startPts = (ctx.startPts || 0) + SPEC_DELAY_MS * _spHops;
    _spOn = true;
    _spSeen = -1;
    _spDbg.boot++;
    beginOnlineDuel(ctx.seed >>> 0, false);
    // Everything that arrived while we were deliberately waiting, in order. The
    // first entry is normally the checkpoint 'rs' that rebuilds the whole world.
    const q = _spQ; _spQ = [];
    for(const env of q){ _spSeen = env.n | 0; _spDeliver(env); }
    _spArm();
    _uiDirty = true;
}
function _spDeliver(env){
    const m = env.m;
    if(!m || typeof m !== 'object') return;
    if(m.t === 'bye'){ specStop('MATCH OVER'); return; }
    _netHandleParsed(m, env.p | 0);
}
// Ask the feeder for a fresh full state. The ONE repair a spectator is allowed:
// it never sends a correction toward the players, because it is not a party to
// their lockstep and its opinion of the world is by construction the stale one.
function _spReq(){
    const now = _spNow();
    if(now - _spReqAt < 1000) return;
    _spReqAt = now;
    for(const l of _spIn) if(l.sub) _spSend(l, { t:'sreq' });
}
// duel-core's hook: our world disagreed with the feeder's. Never a repair toward
// the players -- just ask the source to say it again.
function netSpecResync(){ if(_spOn) _spReq(); }
// Stop watching: tear every link down and hand the sim back to the menu.
function specStop(msg){
    for(const l of _spIn) _spKill(l);
    for(const l of _spOut) _spKill(l);
    _spIn = []; _spOut = [];
    _spWant = []; _spAsk = []; _spQ = []; _spRs = null; _spBuf = [];
    if(_spBootT != null){ clearTimeout(_spBootT); _spBootT = null; }
    const was = _spOn;
    _spOn = false; _spCtx = null; _spRole = ''; _spSeen = -1; _spFeedAt = 0; _spLostAt = 0; _spSrc = ''; _spOrphanG = -1;
    _spDisarm();
    netP2POnlySet(false);
    if(was) _netSessionEnd(msg || 'STOPPED WATCHING');
}
// Ask the OTHER PLAYER to become the backup feeder. Under lockstep it holds both input
// streams, so it can serve the identical timeline once the generation is bumped. We ask
// it DIRECTLY over signalling rather than over the feed link -- the link is exactly what
// may have died -- and register the ask, so its 'ok' is ours to act on.
function _spAskBackup(now){
    const bk = _spOther();
    if(!bk) return false;
    _spWantDrop(bk); _spWant.push({ to:bk, at:now });
    _spWatchSig(bk, 'feed-req', { g:_spGen | 0 });
    _netSigLog('~ SPEC BACKUP FEEDER');
    return true;
}
// A feed link died. A secondary holds a warm standby and simply promotes it. A primary
// has no second source, and a CLOSE is not silence: silence could be a backgrounded
// phone worth waiting SPEC_FEED_SILENCE_MS for, but a closed channel is already the
// answer. Ask for the backup feeder now -- every tick spent waiting is a tick this node
// has no inputs for and must extrapolate, and extrapolated ticks are wrong ticks.
function _spFeedGone(peer){
    _spDrop(_spIn, peer);
    if(!_spOn) return;
    for(const l of _spIn){
        if(l.dc && l.dc.readyState === 'open'){ _spSend(l, { t:'ssub', on:1 }); l.sub = true; _spFeedAt = _spNow(); return; }
    }
    const now = _spNow();
    if(!_spLostAt) _spLostAt = now;
    if(_spHops === 1){ if(_spAskBackup(now)) _spFeedAt = now; return; }
    // A DEEPER node has just lost the relay it hung off, and holds no standby either.
    // Go back to the source: the players are named in the context we booted with, and
    // the one whose fan-out we were displaced by may well have room now that the node
    // between us is gone. If it does not, its refusal redirects us into what is left of
    // the tree -- the same rule that put us here in the first place.
    if(!_spIn.length) for(const pid of _spPlayers()) specWatch(pid, _spTid, _spNid);
}

// ---- housekeeping --------------------------------------------------------
// Asks parked on us, answered the moment we have a timeline to hand out. Until then each
// costs one list entry -- against which the alternative is a spectator that asked one second
// too early and watches nothing at all, because nothing anywhere would ask again.
function _spAskPump(now){
    if(!_spAsk.length) return;
    const servable = !_spOn && netGameActive() && inGame && !!_spCtxBuild();
    for(let i = _spAsk.length - 1; i >= 0; i--){
        const a = _spAsk[i];
        if(now - a.at > SPEC_ASK_TTL_MS){ _spAsk.splice(i, 1); continue; }
        if(!servable || _spOut.length >= SPEC_MAX_DIRECT) continue;
        _spAsk.splice(i, 1);
        _spGrant[a.from] = now;
        _spWatchSig(a.from, 'ok');
    }
}
// Our own outstanding asks, re-sent until the deadline. Two ordinary things make one ask too
// few: 'watch' carries no receipt, so a lost one is simply a feed that never starts; and the
// node we are asking may be seconds from having a match at all. Silence stops the instant we
// have a source, so this never runs alongside a working feed.
function _spWantPump(now){
    for(let i = _spWant.length - 1; i >= 0; i--){
        const w = _spWant[i];
        if(now - w.at > SPEC_ASK_TTL_MS){ _spWant.splice(i, 1); continue; }
        if(_spOn || _spCtx || _spBootT != null) continue;
        if(now - (w.last || w.at) < SPEC_ASK_RETRY_MS) continue;
        w.last = now;
        _spWatchSig(w.to, 'req');
    }
}
// One pass every 250ms: checkpoints, silence detection, failover, and the
// escalation ladder when local recovery has run out of options.
function _spTick(){
    const now = _spNow();
    _spPrune();
    if(!_spOn && _spOut.length) _spCkpt(false);
    _spAskPump(now);
    _spWantPump(now);
    if(_spOn && _spCtx && _spFeedAt && now - _spFeedAt > SPEC_SILENCE_MS){
        if(!_spLostAt) _spLostAt = _spFeedAt;
        // The feeder's heartbeat runs at 16 ticks, so silence this long is unambiguous:
        // switch to the standby if we hold one, otherwise ask for a fresh state (which
        // also proves whether the link is alive at all).
        let cur = null, alt = null;
        for(const l of _spIn){ if(l.sub && !cur) cur = l; else if(!alt && l.dc && l.dc.readyState === 'open') alt = l; }
        if(alt){
            if(cur) cur.sub = false;
            alt.sub = true; _spSend(alt, { t:'ssub', on:1 });
            _spSrc = alt.peer; _spFeedAt = now;
            _netSigLog('~ SPEC FAILOVER ' + String(alt.peer).slice(0, 4));
        } else if(_spHops === 1 && now - _spFeedAt > SPEC_FEED_SILENCE_MS){
            // A PRIMARY whose feeder has gone quiet this long -- with no close to go on --
            // pulls the backup feeder.
            _spAskBackup(now);
            _spFeedAt = now;
        } else _spReq();
        // Halfway to the deadline with nothing recovered locally: escalate to the server
        // while there is still time for a re-deal to arrive and save the watch.
        if(now - _spLostAt > RB_PERSIST_KILL_MS / 2) _spOrphan();
        // Nothing upstream has answered for as long as a duel gets before it is declared
        // dead. A watch with no source left is over; say so rather than sit on a frozen
        // board. The deadline runs off _spLostAt, so re-asking never postpones it.
        if(now - _spLostAt > RB_PERSIST_KILL_MS) specStop('CONNECTION LOST');
    } else if(_spOn) _spLostAt = 0;
    if(!_spOn && !_spOut.length && !_spWant.length && !_spAsk.length) _spDisarm();
}
// Proactive stand-down: a backgrounded primary cannot forward, and the server can
// re-deal the role long before anyone downstream notices the silence -- so we say so
// instead of making everyone downstream discover it. Outside a tournament there is
// nobody to tell and the hook is simply absent: a bare watch just loses its relay.
function specStandDown(){
    const had = _spOut.length;
    for(const l of _spOut) _spKill(l);
    _spOut = [];
    _spRs = null; _spBuf = [];
    _spCkptAt = 0;
    if(had && _spTid && typeof tourneyStandDown === 'function') tourneyStandDown(_spTid, _spNid);
}
// Local recovery is out of options: the feeder is gone, no standby answered, and the
// other player is not serving either. The server deals roles, so it is the only thing
// left that can hand us a new source. Once per generation -- a second call would only
// race the re-deal that is already coming.
function _spOrphan(){
    if(_spOrphanG === (_spGen | 0)) return;
    _spOrphanG = _spGen | 0;
    _netSigLog('~ SPEC ORPHAN');
    if(_spTid && typeof tourneyOrphan === 'function') tourneyOrphan(_spTid, _spNid);
}
