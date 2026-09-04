// ============================================================================
// net-rtc.js -- the duel wire: WebRTC P2P DataChannel (the server only relays
// SDP/ICE), mDNS candidate de-obfuscation, path stats, liveness checks and
// mid-game reconnect. Loads after net-api.js, before net-session.js.
// Offline-first contract: see net-api.js.
// The HTTP server-relay fallback is DEPRECATED and lives in net-relay.js; what
// remains here are the hooks that hand it the session (docs/DEPRECATED-relay.md).
// ============================================================================
// ---- WebRTC session: P2P DataChannel; the server only relays SDP/ICE ----
var _netSess = null;   // {peer, role:'host'|'peer', pc, dc, ...} -- var: hoisted callers must see undefined, never TDZ
// Server 'peer-net' hints, keyed by peer id: { ip, fam, selfFam }. The server's view of
// each peer's public IP + address family, used to de-obfuscate mDNS ICE candidates (below).
var _netPeerNet = {};
// Rewrite a peer's mDNS host candidate (`<uuid>.local`) to use its real IPv6, learned from
// the server's peer-net hint. IPv6 ONLY: with no NAT the candidate's (revealed) port is the
// reachable one, so real-IP + that port is a directly connectable candidate. On IPv4 the
// port would be NAT-translated and the graft would be wrong, so we never do it there.
function _netDeobfuscateCand(cand, pn){
    if(!pn || !pn.ip || pn.fam !== 6 || pn.ip.indexOf(':') < 0) return null;
    const s = cand && cand.candidate;
    if(!s || !/ typ host/i.test(s)) return null;
    const parts = s.split(' ');                       // candidate:<foundation> <comp> <transport> <priority> <address> <port> typ host ...
    if(parts.length < 6 || !/\.local$/i.test(parts[4])) return null;
    parts[4] = pn.ip;
    parts[3] = String((parseInt(parts[3],10)||0) + 1);   // outrank the mDNS twin: this real IP is tried FIRST (the .local one only resolves on a shared LAN)
    return { candidate: parts.join(' '), sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex, usernameFragment: cand.usernameFragment };
}
// Remote ICE candidates can arrive in the SAME drained batch as the offer/answer they
// belong to (the mailbox delivers oldest-first), i.e. while setRemoteDescription is
// still resolving -- and addIceCandidate before the remote description is set rejects
// with InvalidStateError, which the soft-fail catch turns into a SILENT drop. Delivery
// is one-shot, so a candidate lost there is lost for good: the connect then leans on
// later-arriving candidates and prflx discovery, which is exactly the intermittent
// "P2P sometimes never comes up" failure. So: park candidates until the description
// has settled (s.rdOk, set by the paths that await it), then flush them in order.
function _netIceAdd(s, cand){
    if(!s || !s.pc) return;
    if(!s.rdOk){ s.iceQ.push(cand); return; }
    _netIceRelease(s, cand);
}
// HAPPY EYEBALLS for the ICE race: v6 should win wherever it is viable, v4 stays the
// automatic fallback. Two levers, both on the REMOTE candidates we feed the pc:
//  - v4 literals wait out a short head start, so the v6 pairs run their checks
//    uncontested first (worst case: +200ms setup on a v4-only path);
//  - v6 candidates get HALF a type-preference step of extra priority -- outranks any
//    v4 twin of the same type without ever reordering host vs srflx.
// mDNS .local candidates (family unknown until resolved) enter immediately.
const NET_ICE_V4_HOLD_MS = 200;
function _netCandFam(cand){
    const p = (cand && cand.candidate || '').split(' '), a = p[4] || '';
    if(/\.local$/i.test(a)) return 0;
    return a.indexOf(':') >= 0 ? 6 : (a ? 4 : 0);
}
function _netIceBias(cand){
    if(_netCandFam(cand) !== 6) return cand;
    const p = cand.candidate.split(' ');
    p[3] = String((parseInt(p[3], 10) || 0) + 8388608);
    return { candidate: p.join(' '), sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex, usernameFragment: cand.usernameFragment };
}
function _netIceRelease(s, cand){
    const pc = s.pc;
    const add = () => { if(s.pc === pc){ try{ pc.addIceCandidate(_netIceBias(cand)).catch(()=>{}); }catch(e){} } };
    if(_netCandFam(cand) === 4 && typeof setTimeout === 'function') setTimeout(add, NET_ICE_V4_HOLD_MS);
    else add();
}
function _netIceFlush(s){
    if(!s || !s.pc || !s.iceQ.length) return;
    const q = s.iceQ; s.iceQ = [];
    for(const c of q) _netIceRelease(s, c);
}
// ---- OUR OWN PUBLIC ADDRESSES, in both families (the hello `nets` field, server 4.2) ----
// The server only ever sees us on the ONE family the browser picked for that request, and a
// browser gives us no way to ask for the other. On a dual-stack line Happy Eyeballs can sit on
// v6 for hours, so our public v4 address is never observed -- which is exactly why "tournaments
// nearby" stayed empty for a host talking v6 and a phone talking v4 in the SAME ROOM: two
// networks that can never compare equal. ICE can see both, so we discover them ourselves and
// report them; the server derives the network (v4 as-is, v6 collapsed to the /64).
const NET_NETS_MAX = 4;            // the server's cap on the list; a longer one is a 400
const NET_NETS_ADDR_MAX = 45;      // ...and on each entry (a full v6 literal is 45 chars)
const NET_NETS_TTL_MS = 300000;    // ~5min. One RTCPeerConnection every few minutes, never one per hello
const NET_NETS_HIDE_MS = 60000;    // a background longer than this may well be a different network
const NET_NETS_GATHER_MS = 2500;   // give the gather up rather than hold a pc open waiting
let _netNets = [], _netNetsAt = 0, _netNetsBusy = false;
// What ICE gathers by nature but nobody outside this device can be reached on -- and what the
// server would discard anyway. A `.local` is Chrome's mDNS placeholder: not an address at all.
// The carrier-grade range is dropped for a different reason: it IS routable, but it is shared
// across a whole region, so treating it as "this room" would make strangers look like neighbours.
function _netAddrPublic(a){
    a = String(a || '');
    if(!a || a.length > NET_NETS_ADDR_MAX || /\.local$/i.test(a)) return false;
    if(a.indexOf(':') >= 0){
        if(!/^[0-9a-f:]+$/i.test(a)) return false;   // a zone id (%eth0) or any other decoration is not an address we can report
        return /^[23][0-9a-f]{0,3}$/i.test(a.split(':')[0]);   // GLOBAL UNICAST 2000::/3 only -- drops fe80 link-local, fc/fd ULA, fec0 site-local, ::1
    }
    const o = a.split('.');
    if(o.length !== 4 || o.some(p => !/^\d{1,3}$/.test(p) || +p > 255)) return false;
    const n = o.map(Number);
    if(n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] >= 224) return false;      // this-host, private, loopback, multicast and above
    if(n[0] === 172 && n[1] >= 16 && n[1] <= 31) return false;                      // private
    if(n[0] === 192 && n[1] === 168) return false;                                  // private
    if(n[0] === 169 && n[1] === 254) return false;                                  // link-local
    if(n[0] === 100 && n[1] >= 64 && n[1] <= 127) return false;                     // carrier-grade NAT: routable, but a whole region shares it
    return true;
}
// The address and type off one gathered candidate. `address` is the modern field; the SDP line
// is the fallback, and its 5th token is the address in every candidate ever written.
function _netCandAddr(cand){
    const line = (cand && cand.candidate) || '';
    const m = line.match(/ typ (\w+)/);
    return { addr: (cand && cand.address) || line.split(' ')[4] || '', type: m ? m[1] : '' };
}
// One-shot ICE gather against the dual-stack STUN host. No connection to the game server over
// either family, no camera or microphone, nothing signalled to anyone. Soft-fail like every
// other network path here: an empty result just means hello carries no `nets` and the server
// keeps matching us exactly the way it does today.
function _netNetsGather(){
    if(_netNetsBusy || typeof RTCPeerConnection !== 'function' || typeof setTimeout !== 'function') return;
    if(typeof netOffline === 'function' && netOffline()) return;
    _netNetsBusy = true;
    let pc = null, tmr = null, done = false;
    // Best address per family. A SERVER-REFLEXIVE candidate is what the STUN server actually saw,
    // so it is the authority; a host candidate qualifies only where there is no NAT to hide behind
    // -- routine for v6, never for v4 -- and _netAddrPublic is what decides that. One per family:
    // the server uses the first of each anyway, so a second is payload carrying no new meaning.
    const best = {};
    const finish = ()=>{
        if(done) return;
        done = true;
        if(tmr != null && typeof clearTimeout === 'function') clearTimeout(tmr);
        try{ if(pc) pc.close(); }catch(e){}
        pc = null;
        const out = [];
        for(const f of [4, 6]) if(best[f]) out.push(best[f].addr);
        _netNets = out.slice(0, NET_NETS_MAX);
        _netNetsAt = Date.now();
        _netNetsBusy = false;
        if(typeof _netSigLog === 'function') _netSigLog('nets ' + (out.join(' ') || 'none'));
    };
    try{
        pc = new RTCPeerConnection({ iceServers:[{ urls:NET_STUN_URL }] });
        pc.onicecandidate = (e)=>{
            const cand = e && e.candidate;
            if(!cand || !((cand.candidate || '') + (cand.address || ''))){ finish(); return; }   // end-of-candidates
            const c = _netCandAddr(cand);
            if(!_netAddrPublic(c.addr)) return;
            const fam = c.addr.indexOf(':') >= 0 ? 6 : 4;
            const rank = c.type === 'srflx' ? 0 : (c.type === 'host' ? 1 : 2);
            if(!best[fam] || rank < best[fam].rank) best[fam] = { addr:c.addr, rank:rank };
        };
        pc.createDataChannel('nets');   // gathering needs an m-line to gather for
        Promise.resolve(pc.createOffer()).then(o => { if(pc) return pc.setLocalDescription(o); }).catch(()=>finish());
        tmr = setTimeout(finish, NET_NETS_GATHER_MS);
    }catch(e){ finish(); }
}
// Cadence: once shortly after startup, then whenever the cache is older than the TTL. The
// heartbeat calls this every time and the TTL is what makes that cheap. `force` is for the
// moments the network underneath us may have changed outright -- coming back online, or waking
// from a long background -- which is precisely when the address we last reported goes stale.
function netNetsRefresh(force){
    if(!force && _netNetsAt && Date.now() - _netNetsAt < NET_NETS_TTL_MS) return;
    _netNetsGather();
}
function netPublicNets(){ return _netNets.slice(0, NET_NETS_MAX); }

// P2P-ONLY MODE. Tournament matches and every spectator link must run on a direct
// DataChannel: the deprecated server relay's jittered HTTP round trips cannot hold the
// spectator tree's forwarding budget, and a bracket must not score a match that ran on a
// transport the rest of the tournament is not using. The LATCH covers the window before a
// session exists (the relay handshake mints its own), the per-session flag covers a link
// that is already up; either one refuses.
let _netP2POnly = false;
function netP2POnlySet(v){ _netP2POnly = !!v; }
function netP2POnly(){ return _netP2POnly || !!(_netSess && _netSess.p2pOnly); }
function _netMkSess(peer, role){
    const s = { peer, role, pc:null, dc:null, seed:0, peerProfile:null, game:false,
             rdOk:false, iceQ:[],   // remote description settled; candidates parked until it is
             // DEPRECATED(relay): session slots owned by net-relay.js -- drop with it.
             relay:false, connT:null, relayAbort:null, relaySeq:-1, relayGraceUntil:0,
             relayPending:null, relayBusy:false,   // relay outbound coalesce: latest-wins slot + one-in-flight guard
             rc:0,   // offer GENERATION: bumped per re-offer, echoed by the answerer, checked on receive (a stale answer must not poison a fresh pc)
             ctlEpoch:-1,   // last epoch we started via a control message: dedups the transition retries
             epoch:0,   // halts so far in THIS connection: both peers count identically (a bye resets the line)
             tx:null,   // the ONE pending un-echoed transition ({pkt, since, lastAt, tries}; see _netTxShip)
             lastRecv:0, lastSent:0, liveT:null, warmT:null, myAgain:false, peerAgain:false, lvlPending:false,
             bsFwd:Infinity, bsRev:Infinity, bsNf:0, bsRevN:0, bsSeq:0, bsRunning:false,   // boundary clock-burst: my min forward-delta, the peer's min forward-delta (piggybacked), my sample count, the peer's reported count, my outgoing seq, a burst in progress
             // Per-MATCH negotiated parameters. BOTH ride every go, because neither survives a
             // disagreement: hearts is the cap both sims open on, and stakes says whether a steal
             // really changes hands off the board. Stakes is the sharper of the two -- a side that
             // believes they are on attests its ownership digest and claims every gain, while a
             // side that believes they are off never attests at all, so nothing corroborates the
             // first side and nothing anywhere can see that the two disagreed.
             // heartsWant/stakesWant are PRESETS (a tournament roles sheet): a go that
             // contradicts one is a protocol fault and ends the match.
             hearts:START_LIVES, stakes:true, heartsWant:null, stakesWant:null,
             // Tournament matches and every spectator link are P2P-ONLY: the deprecated
             // server relay is not an acceptable transport for them (see _netRelayStart).
             p2pOnly:false,
             lastSentTick:-1, lastPhase:'', lastBarsV:-1,
             lastRecvWall:0, reconnectAt:0, reconnecting:false,
             // simSeenWall: the last time we had PROOF the peer's sim advanced (see _netSimStalled).
             // 0 means "no baseline yet", which is never a fault -- a match that has not ticked cannot stall.
             simSeenWall:0, peerTk:null };   // lastRecvWall: Date.now() clock; mid-game p2p rebuild
    // A tournament match's parameters live on the ROLES SHEET, and the offer carries none
    // of them. Both sides mint their session here, so this is the one point both paths
    // share -- and the answerer, which never gets to speak, is dressed by it too.
    if(typeof tourneyDressSession === 'function') tourneyDressSession(s);
    return s;
}
// Stamp a received packet on BOTH clocks. lastRecvWall (Date.now) is the wall clock: it keeps
// advancing while a tab is suspended, so on wake the real silence is visible even when
// performance.now() (and every timer) froze during a screen-off.
function _netMarkRecv(s){ if(s){ s.lastRecv = performance.now(); s.lastRecvWall = Date.now(); } }
let _netHiddenAt = 0;   // Date.now() when we last went hidden, for the wake-up away-time
// ICE candidates get ONE retry on a server 5xx: delivery is one-shot, and a lost
// candidate silently narrows the paths ICE can pick from for the whole match (the
// direct-IPv6 route rides exactly one of these). Other signals have their own
// retry ladders (offer re-send, invite staleness) or are expendable.
async function _netSignalIce(to, payload){
    const r = await _netSignal(to, 'ice', payload);
    if(r && !r.json && r.status >= 500 && typeof setTimeout === 'function')
        setTimeout(() => { _netSignal(to, 'ice', payload); }, 400);
}
function _netRtcInit(peer, role){
    _netSess = _netMkSess(peer, role);
    const pc = new RTCPeerConnection({ iceServers:[{ urls:NET_STUN_URL }] });
    _netSess.pc = pc;
    pc.onicecandidate = e => { if(e.candidate) _netSignalIce(peer, JSON.stringify(e.candidate)); };
    pc.onconnectionstatechange = () => {
        const s = _netSess;
        // DEPRECATED(relay): the fallback hook -- without net-relay.js a failed P2P just ends the attempt.
        if(!s || s.pc !== pc || s.relay) return;   // relay mode: the RTC attempt no longer owns the session
        if(pc.connectionState === 'failed' || pc.connectionState === 'closed'){
            if(!s.game) _netRelayStart(s);              // P2P never came up: fall back NOW (earlier than the 6s timer)
            else if(!s.reconnectAt) _netReconnect(s);   // an established game lost its channel: rebuild it, do NOT end
        }
    };
    // P2P gets 6 seconds; then the match falls back to the server relay. DEPRECATED(relay)
    if(_netTimers) _netSess.connT = setTimeout(()=>{ if(_netSess && _netSess.pc === pc && !_netSess.game) _netRelayStart(_netSess); }, 6000);
    return pc;
}
async function _netRtcOffer(peer, peerProfile){   // we invited / we are the quick-match offerer: we make the seed
    if(!_netRtcAvail() || inGame){ _netSigLog('> offer SKIP'); return; }
    if(_netSess) _netTeardown();          // debris: replace it, never silently skip the offer
    const pc = _netRtcInit(peer, 'host');
    if(peerProfile) _netSess.peerProfile = peerProfile;
    _netSess.seed = (Math.random()*0x100000000)>>>0;
    _netWire(pc.createDataChannel('fok', NET_DC_OPTS));
    try {
        const of = await pc.createOffer();
        await pc.setLocalDescription(of);
        const payload = JSON.stringify({ sdp:pc.localDescription, seed:_netSess.seed, profile:_netProfile(), v:_swVersion });
        _netHs.offerTo = peer; _netHs.offerPayload = payload; _netHs.offeredAt = Date.now(); _netHs.offerTries = 1;
        _netSignal(peer, 'offer', payload);
        _netLb.msg = 'CONNECTING (P2P)...'; _uiDirty = true;
    } catch(e){ _netSessionEnd('CONNECTION FAILED'); }
}
async function _netRtcAnswer(peer, d){   // we accepted / we are the quick-match answerer: seed comes with the offer
    if(d && !_netVerOk(d.v)){
        _netLb.msg = 'VERSION MISMATCH - BOTH PLEASE RELOAD'; _uiDirty = true;
        _netSignal(peer, 'bye', '');
        return;
    }
    if(!_netRtcAvail() || inGame){ _netSigLog('< offer SKIP'); return; }
    if(_netSess && _netSess.peer === peer){
        // Duplicate offer: the host re-sent because our answer was lost. Answer
        // again; tearing the forming session down here would break the connect.
        _netSignal(peer, 'answer', JSON.stringify({ sdp: _netSess.pc && _netSess.pc.localDescription, profile:_netProfile(), v:_swVersion, rc:(d && d.rc)|0 }));
        return;
    }
    if(_netSess) _netTeardown();          // unrelated debris must not swallow the offer
    const pc = _netRtcInit(peer, 'peer');
    _netSess.peerProfile = _netClampProfile(d.profile);
    _netNameSeen(peer, _netSess.peerProfile.name);
    _netSess.seed = (d.seed>>>0) || 1;
    _netHs.accepting = null;
    _netWire(pc.createDataChannel('fok', NET_DC_OPTS));   // pre-negotiated: open our own end at the same id as the offerer
    _netTimeSync();   // in parallel with the ICE handshake: synced by the time the go arrives
    try {
        await pc.setRemoteDescription(d.sdp);
        if(_netSess && _netSess.pc === pc){ _netSess.rdOk = true; _netIceFlush(_netSess); }
        const an = await pc.createAnswer();
        await pc.setLocalDescription(an);
        _netSignal(peer, 'answer', JSON.stringify({ sdp:pc.localDescription, profile:_netProfile(), v:_swVersion, rc:(d && d.rc)|0 }));
        _netLb.msg = 'CONNECTING (P2P)...'; _uiDirty = true;
    } catch(e){ _netSessionEnd('CONNECTION FAILED'); }
}
function _netWire(dc){
    _netSess.dc = dc;
    dc.onopen = () => {
        const s = _netSess; if(!s) return;
        if(s.reconnectAt){   // a rebuilt channel after a mid-game drop: SAME timeline, no re-start
            _netReconnectDone(s);
            _netMarkRecv(s);
            if(netMyIndex() === 0){ if(_netWD()) _wDuelSend({ t:'duelResync' }); else _rbArmFullResync(); }   // the drop diverged us: host ships a full resync (and a resume boundary when it settles)
            _duelMsg = 'RECONNECTED'; _duelMsgAt = _msgNow(); _uiDirty = true;
            return;
        }
        if(s.relay){   // DEPRECATED(relay): P2P completed AFTER the fallback -- upgrade to the direct path
            s.relay = false;
            _netLb.msg = 'P2P CONNECTED'; _duelMsg = 'P2P CONNECTED'; _duelMsgAt = _msgNow(); _uiDirty = true;
            _netMarkRecv(s);
            return;
        }
        if(s.connT){ clearTimeout(s.connT); s.connT = null; }
        _netSeekStop();
        s.game = true; _netMarkRecv(s);
        _netLiveStart();
        _netRequestStart(s);
        // the shared start (seed + start_pts) arrives via this request; no state frames
    };
    dc.onmessage = e => { if(_netSess){ _netMarkRecv(_netSess); _netHandleMsg(String(e.data)); } };
    dc.onclose = () => { const s = _netSess; if(s && s.game && !s.relay && !s.reconnectAt) _netReconnect(s); };   // unexpected close mid-game: rebuild, do not end (!s.relay: DEPRECATED(relay))
}
// A message type that is a one-shot CONTROL transition (a phase change), as opposed to the
// self-healing input/liveness stream. The wire knows exactly three: 'go' (the one timeline
// opener), 'req' (the one intent ask) and 'bye' (best-effort farewell). go/req are ECHO-
// ACKNOWLEDGED: the sender keeps the pending packet in s.tx and retries until the receiver
// answers it back verbatim with a:1 (_netTxShip/_netTxEcho in net-session.js); the relay
// transport additionally retries the raw send (_netRelayCtl). bye rides best-effort -- its
// server-side signal twin is the reliable copy.
function _netIsCtl(t){ return t === 'go' || t === 'req' || t === 'bye'; }
// Every drop/divert decision runs FIRST; the time stamps are the FINAL act before serialize+send,
// for every packet type alike. What sits between a stamp and the wire is pure one-way-delta error,
// so the tail must be minimal AND constant -- a stamp taken before a variable amount of guard work
// would turn that work's jitter into measured clock offset.
function _netSend(o){
    const s = _netSess;
    if(!s) return;
    // A SPECTATOR IS SILENT. Its session is synthetic -- there is no duel peer at the other end
    // of it -- and its whole contract with the match it watches is that the match cannot tell it
    // is there. One choke point rather than a condition on each of the eight send sites in the
    // tick schedule: whatever is added there later inherits the silence for free.
    if(typeof netSpectating === 'function' && netSpectating()) return;
    // Tick-stream packets are epoch-scoped (see the gate in _netHandleMsg): simTick and the
    // rollback tick-base reset at every level boundary, so stamp the epoch this copy was
    // authored under. The receiver drops a copy that crossed a boundary instead of mapping
    // its pre-reset ticks onto the new timeline.
    if((o.t === 'in' || o.t === 'h' || o.t === 'st' || o.t === 'rs') && o.ep === undefined){
        // Stamp the epoch of the TICK BASE the ticks are measured on (_rbEpoch), not the live
        // session line: a halt bumps s.epoch while both sims keep ticking the old timeline until
        // the scheduled start, and a packet from that window stamped with the bumped epoch walks
        // through the receive gate onto a reset receiver -- whole-log refusals on every boundary.
        o.ep = (typeof _rbEpoch === 'number') ? _rbEpoch|0 : (s.epoch|0);
    }
    if(o.w){
        // The radio-warm ping only needs SOMETHING on the wire within the doze interval, so if
        // real traffic (a turn, boost or heartbeat) already went out this window the ping is
        // redundant -- skip it. p2p-only regardless: an HTTP-polled relay cannot doze, and 20Hz
        // posts would hammer it. Threshold sits one tick under the warm cadence so the idle beat
        // itself is never suppressed by frame jitter -- only genuinely recent real traffic is.
        if(s.relay || performance.now() - s.lastSent < (NET_WARM_EVERY - 1) * TICK_MS) return;   // s.relay: DEPRECATED(relay)
    }
    if(o.t === 'in' || o.t === 'pi') _netDbg.hbTx++;   // input-channel packets sent (incl. idle keepalives)
    if(!s.relay && (!s.dc || s.dc.readyState !== 'open')) return;
    // Congestion guard (see NET_SEND_CONG): drop the repairable types rather than
    // queue them late. Rare one-shot control messages (go/req/bye) still queue --
    // for those, late beats never (go/req are retried until echoed anyway) -- and
    // 'bs' is deliberately not listed: a queued burst probe is rejected by its own
    // min-filter, while a dropped one starves the boundary.
    if(!s.relay && s.dc.bufferedAmount > NET_SEND_CONG && (o.t==='in'||o.t==='pi'||o.t==='h'||o.t==='st'||o.t==='rs')){
        _netDbg.congDrop = (_netDbg.congDrop|0) + 1;
        if(!_netDbg.congAt || performance.now() - _netDbg.congAt > 1000){
            _netDbg.congAt = performance.now();
            _netSigLog('! send buffer congested ' + s.dc.bufferedAmount + 'B');
        }
        _uiDirty = true;
        return;
    }
    // FINAL stamps, nothing but serialize+send past this point. pts is the NET clock (the
    // corrected shared timeline) on EVERY packet -- stamped once: a copy that already carries one
    // (a control retry, an echo) keeps it, honestly declaring the send moment of the ORIGINAL.
    // rts is the RAW clock, burst-sync only, the very last field -- the one place raw time
    // crosses the wire (see netRawPts), stamped in the same instant as pts so their difference
    // IS this sender's current clock correction.
    const pts = netPts();
    if(pts != null && o.pts === undefined) o.pts = pts;   // API: every peer message carries the sender's PTS
    if(o.t === 'bs' && o.rts === undefined) o.rts = netRawPts();
    if(s.relay){ _netRelaySend(s, o); return; }   // DEPRECATED(relay): the transport fork -- drop this line with net-relay.js
    try{
        const j = JSON.stringify(o);
        // One datagram or nothing. Over the path MTU, SCTP fragments the message and
        // losing ANY fragment loses the whole thing -- on a channel that never
        // retransmits, a fragmented packet is a packet that mostly does not arrive. The
        // budget leaves room for IP+UDP+DTLS+SCTP headers (~70B) under a 1280 floor.
        // DROPPED, not sent-and-hoped: the oversize case is the 'st' state snapshot of a
        // very long snake -- the hash still flags the divergence, recovery lands on a
        // later, shorter packet (see _rbSendState).
        if(j.length > NET_PKT_MAX){
            _netDbg.stbig = (_netDbg.stbig|0) + 1;
            _netSigLog('! packet ' + j.length + 'B > budget: dropped');
            return;
        }
        s.dc.send(j); s.lastSent = performance.now();
        // The OUTBOUND spectator tap, at the one point where the packet is finished: a
        // spectator receives the exact object the opponent does, stamps and all. A no-op
        // with nobody watching, which is every duel nobody watches.
        if(typeof _spTapOut === 'function') _spTapOut(o);
    }catch(e){}
}
// ---- boundary clock burst (raw measurement, host residual; see NET_BURST_* above) ----
// Open a fresh burst: forget the previous boundary's samples so this one measures the clock as it
// is NOW. Both sides call it when a boundary opens. s.bsPrev -- the host's low-pass memory --
// deliberately SURVIVES: it holds the previous boundary's RAW offset, which stays comparable
// across clock nudges; it dies with the session, and at a resume boundary (an outage freezes a
// parked device's raw clock, so the remembered offset may have jumped arbitrarily).
function _netBurstReset(s){
    s = s || _netSess; if(!s) return;
    s.bsFwd = Infinity; s.bsRev = Infinity; s.bsNf = 0; s.bsRevN = 0; s.bsSeq = 0; s.bsPeerC = null;
}
// Fire one burst datagram: _netSend stamps the net pts AND the raw rts as its final act; we add
// our best raw forward-min so far (mr) and how many datagrams we have received (mn), so the peer
// learns the one direction it cannot measure itself and can gate on our delivery count.
function _netBurstPing(s){
    s = s || _netSess;
    if(!s || !s.game || netPts() == null) return;
    _netSend({ t:'bs', sq: s.bsSeq++, mr:(s.bsFwd === Infinity ? null : Math.round(s.bsFwd)), mn: s.bsNf });
}
// Fold one received burst datagram. m.rts = the peer's RAW send stamp (OUR forward direction: raw
// recv minus raw send = raw clock offset + this direction's transit); m.mr/m.mn = the peer's own
// forward-min and its delivery count (OUR reverse direction, which only the peer can measure).
// Keep the MIN of each direction -- the least-delayed datagram is the least biased one. sq 0 is
// the PRE-WARM: its delivery counts, its timing is not trusted (the first packet pays the path's
// setup costs -- radio spin-up, ICE consent, cold caches -- which would poison the min). And
// m.pts - m.rts, both stamped in the same instant on the sender, IS the sender's current clock
// correction: kept as s.bsPeerC for the residual conversion, no extra wire field needed. Raw
// stamps span arbitrary device epochs, so no per-sample magnitude bound is possible -- finiteness
// here plus the rttMin window at the verdict (where the epochs cancel) are the sanity.
function _netBurstRecv(s, m){
    s = s || _netSess;
    if(!s || typeof m.rts !== 'number' || !Number.isFinite(m.rts)) return;
    const d = netRawPts() - m.rts;
    if(typeof m.pts === 'number' && Number.isFinite(m.pts)) s.bsPeerC = m.pts - m.rts;
    if((m.sq|0) > 0 && d < s.bsFwd) s.bsFwd = d;
    s.bsNf++;
    if(typeof m.mr === 'number' && Number.isFinite(m.mr) && m.mr < s.bsRev) s.bsRev = m.mr;
    if(typeof m.mn === 'number' && m.mn > s.bsRevN) s.bsRevN = m.mn|0;
}
// The RAW peer clock offset from the two exchanged direction-mins, or null if the burst is
// unusable (too few deliveries either way, no peer correction seen, or an impossible round trip).
// Both sides fold the SAME two numbers, so both recover the identical raw offset; only the HOST
// turns it into the applied residual (the joiner takes its half from the go's bth).
function _netBurstTheta(s){
    s = s || _netSess; if(!s) return null;
    if(s.bsNf < NET_BURST_MIN || s.bsRevN < NET_BURST_MIN) return null;   // starved (loss/doze): keep the old clock
    if(s.bsFwd === Infinity || s.bsRev === Infinity || s.bsPeerC == null) return null;
    const host = (s.role === 'host');
    const mAB = host ? s.bsRev : s.bsFwd;   // A->B: the host reads it from the peer's mr; the joiner measures it directly
    const mBA = host ? s.bsFwd : s.bsRev;   // B->A: the reverse
    const rttMin = mAB + mBA;               // the raw offsets cancel in the sum: this is 2x the min one-way latency
    if(!(rttMin >= 0) || rttMin > 5000) return null;   // impossible/absurd: a one-sided doze inflated one direction
    return { o:(mBA - mAB) / 2, rttMin, host };   // o > 0 => the host RAW clock leads the joiner's
}
// Convert a RAW offset to the SHARED-clock residual: how far the two NET clocks sit apart right
// now. Each side's netPts carries its own correction (_netSync.ofs), so the raw offset is off by
// their difference; the peer's correction arrived for free as bsPeerC (pts - rts on any probe).
// Role-mapped so host and joiner derive the same number from their mirrored views.
function _netBurstResidual(s, o){
    const own = _netSync.ofs || 0, peer = s.bsPeerC || 0;
    return o + (s.role === 'host' ? own - peer : peer - own);
}
// Nudge OUR clock half of the residual onto the shared midpoint (slew-capped). The host pulls its
// clock back, the joiner steps its clock up; with the same R on both, they meet at the exact
// midpoint. `theta` (the residual, ms) may be passed EXPLICITLY -- the joiner applies the value
// the host computed and shipped on the start packet (bth), so both use the IDENTICAL number with
// no convergence race; omitted, it is derived locally from this side's own burst samples (a
// rejected or unusable burst -> no-op). Returns the applied ms, 0 when nothing was applied.
function _netBurstApply(s, theta){
    s = s || _netSess;
    if(!s || _netSync.ofs == null) return 0;
    if(theta == null){ const t = _netBurstTheta(s); if(!t) return 0; theta = _netBurstResidual(s, t.o); }
    if(!theta || !Number.isFinite(theta)) return 0;
    let d = (s.role === 'host' ? -1 : 1) * (theta / 2);
    if(d >  NET_BURST_SLEW_MS) d =  NET_BURST_SLEW_MS;   // symmetric clamp: clips to the same magnitude on both sides
    if(d < -NET_BURST_SLEW_MS) d = -NET_BURST_SLEW_MS;
    _netSync = { ofs:_netSync.ofs + d, rtt:_netSync.rtt, at:Date.now() };
    _netClockPush();
    return d;
}
// Run one side's outgoing burst: CREATE the NET_BURST_N datagrams at absolute deadlines
// NET_BURST_GAP_TICKS engine ticks apart from the run's t0 -- a late timer never pushes the later
// deadlines back, so the probe schedule cannot stretch -- then HOLD the collection window open
// until NET_BURST_WAIT_MS past the LAST deadline. That window IS the largest round trip the burst
// can verify; the early-out closes it the instant both directions are usable, so a healthy link
// finishes at ~its own RTT. `done` fires at finish. With no timers available, or torn down
// mid-burst, it degrades to a single synchronous ping + immediate done (which the accept-gate
// then rejects as starved -> the prior clock is kept).
function _netBurstRun(s, done){
    s = s || _netSess;
    if(!s || !s.game){ if(done) done(); return; }
    if(s.bsRunning){ if(done) done(); return; }   // a second trigger must not _netBurstReset the run already collecting
    _netBurstReset(s);
    s.bsRunning = true;
    if(typeof setTimeout !== 'function'){ _netBurstPing(s); s.bsRunning = false; if(done) done(); return; }
    const gap = NET_BURST_GAP_TICKS * TICK_MS;
    const t0 = performance.now();
    const dEnd = t0 + (NET_BURST_N - 1) * gap + NET_BURST_WAIT_MS;
    let sent = 0;
    const finish = ()=>{ if(_netSess === s) s.bsRunning = false; if(done && _netSess === s && s.game) done(); };
    const step = ()=>{
        if(_netSess !== s || !s.game){ s.bsRunning = false; return; }   // torn down mid-burst: abandon
        if(sent < NET_BURST_N){
            _netBurstPing(s); sent++;
            setTimeout(step, Math.max(0, t0 + sent * gap - performance.now()));
            return;
        }
        // Every ping sent: keep collecting until both directions have enough samples (a usable
        // verdict), or the window's absolute deadline passes -- whichever comes first.
        if(_netBurstTheta(s) || performance.now() >= dEnd){ finish(); return; }
        setTimeout(step, gap);
    };
    step();
}
// Host side of a boundary: run our burst and hand `then` the SHARED-clock residual (ms) it
// settled on -- or null when it starved. The burst datagrams themselves are the trigger -- the
// first 'bs' to reach the peer opens ITS run (see the 'bs' handler in net-session.js), so both
// sides measure over the same window with no separate one-shot trigger packet that a single loss
// could hang the boundary on. On success the raw offset is LOW-PASSED against the previous
// boundary's (s.bsPrev; the first of a session applies unmodified) -- sound only because raw
// offsets are stationary across clock nudges -- then converted to the residual, applied here
// (-R/2), and handed out for the 'go' (bth = R, the joiner's +R/2). A starved window is retried
// NET_BURST_TRIES times; if the peer still is not answering, then(null): the boundary proceeds
// WITHOUT a bth -- both sides keep the prior in-play clock, itself burst-verified at the last
// boundary -- and the liveness silence ladder (not the clock sync) judges a genuinely dead peer.
function _netBurstThenStart(s, then){
    s = s || _netSess;
    if(!s || !s.game || s.role !== 'host'){ if(then) then(null); return; }
    let tries = 0;
    const attempt = ()=>{
        if(_netSess !== s || !s.game) return;
        // A reply-triggered run may already be collecting (our previous try's datagrams opened the
        // peer's run, whose replies re-opened ours). WAIT for it rather than calling _netBurstRun --
        // its already-running early-out would fire `done` at once and burn every retry in one tick.
        if(s.bsRunning && typeof setTimeout === 'function'){ setTimeout(attempt, 50); return; }
        _netBurstRun(s, ()=>{
            if(_netSess !== s || !s.game) return;
            const bt = _netBurstTheta(s);
            if(!bt){
                if(++tries < NET_BURST_TRIES){ _netSigLog('! burst starved -> retry ' + tries); attempt(); return; }
                _netSigLog('! BURST SYNC FAILED f' + (s.bsNf|0) + '/' + NET_BURST_N + ' r' + (s.bsRevN|0) + '/' + NET_BURST_N + ' x' + tries);
                then(null);
                return;
            }
            const est = (s.bsPrev == null) ? bt.o : (s.bsPrev + bt.o) / 2;
            s.bsPrev = bt.o;
            const R = _netBurstResidual(s, est);
            if(!Number.isFinite(R)){ then(null); return; }
            _netBurstApply(s, R);   // host applies -R/2 here; the joiner applies +R/2 from bth
            then(R);
        });
    };
    attempt();
}
// Read the SELECTED ICE candidate pair so we KNOW the real path: host = direct LAN (~1ms),
// srflx/prflx = reflexive -- hairpins out through the router/internet even on one LAN, the usual
// cause of "same-Wifi but 100ms jitter" -- relay = via a TURN server. Plus the true P2P RTT.
function _netPathStat(s){
    // DEPRECATED(relay): the relay branch reports the server RTT; without it this is a plain `if(!s) return`.
    if(!s || s.relay){ if(s && s.relay){ _netDbg.path = 'relay  srv ' + (_netDbg.relayRtt>=0 ? Math.round(_netDbg.relayRtt)+'ms' : '--'); _netDbg.p2pRtt = -1; } return; }
    if(!s.pc || typeof s.pc.getStats !== 'function') return;
    s.pc.getStats().then(st => {
        let pair = null;
        st.forEach(r => { if(r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
        if(!pair) st.forEach(r => { if(!pair && r.type === 'candidate-pair' && r.state === 'succeeded') pair = r; });
        if(!pair) return;
        const loc = st.get(pair.localCandidateId), rem = st.get(pair.remoteCandidateId);
        const ty = c => (c && c.candidateType) ? c.candidateType : '?';
        const addr = c => (c && (c.address || c.ip)) || '';
        const fam = a => a ? (a.indexOf(':') >= 0 ? 'v6' : 'v4') : '';
        _netDbg.p2pRtt = (typeof pair.currentRoundTripTime === 'number') ? Math.round(pair.currentRoundTripTime * 1000) : -1;
        const rtt = _netDbg.p2pRtt >= 0 ? _netDbg.p2pRtt + 'ms' : '?';
        const pn = _netPeerNet[s.peer];
        // 'deob' = the de-obfuscated real IP (grafted from the peer-net hint) is the one that
        // connected, i.e. the direct IPv6 path won past mDNS. Otherwise it is a normal host
        // (LAN mDNS resolved), srflx (STUN reflexive) or prflx pair.
        const deob = pn && pn.ip && addr(rem) === pn.ip ? ' deob' : '';
        _netDbg.path = ty(loc) + '/' + ty(rem) + (fam(addr(rem)) ? ' ' + fam(addr(rem)) : '') + deob + '  p2p-rtt ' + rtt;
    }).catch(()=>{});
}
// TIMELINE BREAK (the tick target >600 ticks, ~10s, AHEAD of our sim): the sim was FROZEN while
// the clock ran on. That is well past RB_PERSIST_KILL_MS, so the peer saw nothing from us for long
// enough to have killed the session on its side already -- there is nobody left to resume against.
// Only that direction counts: a target BEHIND the sim is a boundary whose origin was authored in
// the future, which is how every level starts. Small gaps self-heal via the catch-up ladder.
function _netBreakRecover(s){
    if(!inGame || !s || !s.startPts || s.lvlPending) return false;
    const p = netPts();
    if(p == null || Math.floor((p - s.startPts) / TICK_MS) - simTick <= 600) return false;
    _netSigLog('! timeline break >600t -> ending (the peer timed us out long ago)');
    _netSessionEnd('CONNECTION LOST');
    return true;
}
// In-game liveness: the DataChannel is the session -- ping when idle, 4s silence = dead.
function _netLiveStart(){
    if(!_netTimers) return;
    _netSess.liveT = setInterval(_netLiveCheck, 250);
    // Radio-warm beat for the session's WHOLE life, not just while the sim ticks. The
    // tick-scheduled warm ping stops with the ticks, which leaves the windows a duel is
    // built on -- the burst-to-tick-0 lead, level/respawn boundaries, a resume negotiation
    // -- silent long enough for a cellular radio to doze right before the most
    // latency-critical packets. The w-gate in _netSend does ALL the suppression: any real
    // traffic (burst probes included) within the warm window skips the ping, and the relay
    // path never pings at all.
    _netSess.warmT = setInterval(()=>{ _netSend({ t:'pi', w:1 }); }, NET_WARM_EVERY * TICK_MS);
}
// ONE liveness pass (ping-when-idle, reconnect/kill on silence, end a stuck desync). Split out
// of the setInterval body so the headless duel driver can run the REAL check on its simulated
// clock -- the timeouts and the kill are then tested by the same code the browser runs, not a
// re-implementation. Production calls it every 250ms; the driver pumps it off its fake clock.
function _netLiveCheck(){
    const s = _netSess; if(!s || !s.game) return;
    // A SPECTATOR's session is synthetic: no DataChannel, no peer, nothing to ping or
    // reconnect to. Its liveness is the FEED's, and net-spec's own 250ms pass owns that
    // ladder (silence -> warm standby -> fresh-state ask -> backup feeder). Running the
    // duel ladder here would read permanent silence off a channel that never existed and
    // kill the watch a few seconds in.
    if(typeof netSpectating === 'function' && netSpectating()) return;
    const nowMs = performance.now();
    if(!s.pathAt || nowMs - s.pathAt > 2000){ s.pathAt = nowMs; _netPathStat(s); }   // refresh the ICE-path readout ~0.5Hz
    // A desync whose one-shot-per-verdict repairs keep failing is a dead match too:
    // same deadline as a failed reconnect. Worker mode mirrors the age in each frame.
    const _dsyFor = _netWD() ? (_netDbg.dsyFor|0) : (_rbBadSince ? Date.now() - _rbBadSince : 0);
    if(inGame && _dsyFor > RB_PERSIST_KILL_MS){ _netSessionEnd('OUT OF SYNC - MATCH ENDED'); return; }
    if(_netBreakRecover(s)) return;   // sim frozen ~10s behind the shared clock: the match is over, stop here
    if(_netEpochRecover(s)) return;   // the pair drifted onto separate epoch bases: fire an overdue begin, or end
    if(_netTxTick(s)) return;         // pending-transition retry (~1/s) + the unanswered-go deadline
    // The idle keepalive carries the recent input log, so it doubles as repair:
    // a lost LAST input would otherwise sit unfixed until the player pressed
    // something else. An empty log is just an alive check, as before.
    //
    // The keepalive PERIOD used to equal the warning THRESHOLD: this ran on a
    // 1000ms interval (setInterval never fires early, often late) while the warning
    // fires after 1000ms of silence. So the gap crossed the line just before every
    // single arrival -- CONNECTION LOST flashed once a second on a perfect link.
    // Deterministic, not a jitter edge case. A keepalive must be comfortably faster
    // than whatever watches for its absence: three per window, so three must
    // genuinely go missing before we say a word.
    if(nowMs - s.lastSent > NET_KEEPALIVE_MS)
        _netSend(inGame && !_netWD() ? { t:'in', tk:_rbToWire(simTick), l:_rbSent } : { t:'pi' });   // worker duel: _rbSent lives in the worker; its 16-tick heartbeat covers repair
    // The re-offer retry is gated off in-game, so drive it from here while reconnecting.
    if(s.reconnecting && s.role === 'host' && _netHs.offerTo === s.peer && _netHs.offerPayload && Date.now() - _netHs.offeredAt > 2000){
        _netHs.offeredAt = Date.now(); _netSignal(s.peer, 'offer', _netHs.offerPayload);
    }
    // Silence on the WALL clock (Date.now): a suspended tab freezes performance.now() and
    // the timers, so only real elapsed time reveals the gap on the side that was asleep.
    const nowW = Date.now();
    const silent = nowW - s.lastRecvWall;
    if(s.relay){   // DEPRECATED(relay): whole branch
        if(nowMs < s.relayGraceUntil) return;                             // relay just engaged: let the peer catch up
        if(silent > RB_PERSIST_KILL_MS) _netSessionEnd('CONNECTION LOST'); // relay has no transport to rebuild -> silence past the deadline ends it
        return;
    }
    // A sim that is ENTITLED to sit still pushes the stall baseline forward instead of being
    // judged by it, so the deadline starts at the end of a legitimate pause. Done here, on the
    // one pass that already owns the liveness clocks, so the predicate itself stays pure.
    if(s.tx || s.lvlPending || s.reconnecting) s.simSeenWall = nowW;
    // p2p ladder: WARN (netDuelWarn, ~RB_WARN_MS) -> RECONNECT (rebuild the link, ~RB_RECONNECT_MS)
    // -> hard KILL at the deadline. The kill is unconditional so "silence past the deadline ends
    // the match" holds even where no rebuild was possible; below it, start one rebuild or clear it.
    if(silent > RB_PERSIST_KILL_MS){ _netSessionEnd('CONNECTION LOST'); return; }
    // The wedged-sim ladder has no RECONNECT rung: the transport is fine, so rebuilding it would
    // repair nothing. Warn, then end the match -- there is no third thing to try.
    if(_netSimStalled(s, RB_SIM_KILL_MS)){ _netSigLog('! peer sim stalled -> ending'); _netSessionEnd('CONNECTION LOST'); return; }
    if(silent > RB_RECONNECT_MS && !s.reconnectAt) _netReconnect(s);
    else if(s.reconnectAt && silent < RB_WARN_MS) _netReconnectDone(s);   // packets flowing again -- recovered
}
// ---- mid-game reconnect: rebuild the p2p transport WITHOUT restarting the match ----
// The sim keeps running on both sides throughout (each ticks off the shared clock), so once
// packets flow again the periodic state+hash recovery re-converges them. We only rebuild the
// dead RTCPeerConnection/DataChannel; epoch, seed and sim state are untouched.
function _netReconnect(s){
    if(!s || s.reconnectAt || s.relay || !_netRtcAvail()) return;   // s.relay: DEPRECATED(relay)
    s.reconnectAt = Date.now();   // wall clock: the timeout must survive a suspend too
    s.reconnecting = true;             // _netPollDue() polls again so the re-handshake signals flow
    _netPollAbortNow();                // start a fresh poll immediately, don't wait out a held one
    _duelMsg = 'RECONNECTING...'; _duelMsgAt = _msgNow(); _uiDirty = true;
    _netSigLog('~ reconnect');
    if(s.role === 'host') _netRtcReoffer(s);   // the host re-offers; the peer answers when its own silence trips
}
function _netReconnectDone(s){
    if(!s) return;
    s.reconnectAt = 0; s.reconnecting = false; s.rcOfferSdp = null;
    _netHs.offerTo = null; _netHs.offerPayload = null;
}
function _netRtcRebuild(s){
    try{ if(s.dc){ s.dc.onopen=s.dc.onmessage=s.dc.onclose=null; s.dc.close(); } }catch(e){}
    try{ if(s.pc){ s.pc.onconnectionstatechange=s.pc.onicecandidate=s.pc.ondatachannel=null; s.pc.close(); } }catch(e){}
    s.dc = null;
    s.rdOk = false; s.iceQ = [];   // candidates for the dead pc are void; the rebuild parks afresh
    const pc = new RTCPeerConnection({ iceServers:[{ urls:NET_STUN_URL }] });
    s.pc = pc;
    pc.onicecandidate = e => { if(e.candidate) _netSignalIce(s.peer, JSON.stringify(e.candidate)); };
    pc.onconnectionstatechange = () => { /* a failed rebuild is owned by the liveness timeout */ };
    return pc;
}
async function _netRtcReoffer(s){
    if(!_netRtcAvail()) return;
    const pc = _netRtcRebuild(s);
    _netWire(pc.createDataChannel('fok', NET_DC_OPTS));
    try {
        const of = await pc.createOffer();
        await pc.setLocalDescription(of);
        const payload = JSON.stringify({ sdp:pc.localDescription, rc:(s.rc = (s.rc|0) + 1), v:_swVersion });
        _netHs.offerTo = s.peer; _netHs.offerPayload = payload; _netHs.offeredAt = Date.now(); _netHs.offerTries = 1;
        _netSignal(s.peer, 'offer', payload);
    } catch(e){}
}
async function _netRtcReanswer(from, d){
    if(!_netRtcAvail()) return;
    const s = _netSess;
    const sdpStr = d.sdp && d.sdp.sdp;
    // The host re-sends the SAME offer every ~2s until it hears an answer. A duplicate must
    // NOT tear down and rebuild the pc we are already answering on -- re-send the answer and
    // keep the forming connection (mirrors the initial-handshake duplicate-offer path).
    if(s.reconnecting && s.pc && s.rcOfferSdp === sdpStr){
        if(s.pc.localDescription) _netSignal(from, 'answer', JSON.stringify({ sdp:s.pc.localDescription, rc:(d.rc|0), v:_swVersion }));
        return;
    }
    if(!s.reconnectAt){ s.reconnectAt = Date.now(); s.reconnecting = true; _duelMsg = 'RECONNECTING...'; _duelMsgAt = _msgNow(); _uiDirty = true; }
    s.rcOfferSdp = sdpStr;
    const pc = _netRtcRebuild(s);
    _netWire(pc.createDataChannel('fok', NET_DC_OPTS));   // pre-negotiated: our own end, same id as the re-offer
    try {
        await pc.setRemoteDescription(d.sdp);
        if(s.pc === pc){ s.rdOk = true; _netIceFlush(s); }
        const an = await pc.createAnswer();
        await pc.setLocalDescription(an);
        _netSignal(from, 'answer', JSON.stringify({ sdp:pc.localDescription, rc:(d.rc|0), v:_swVersion }));
    } catch(e){}
}
