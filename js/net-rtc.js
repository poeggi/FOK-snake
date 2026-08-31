// ============================================================================
// net-rtc.js -- the duel wire: WebRTC P2P DataChannel (the server only relays
// SDP/ICE), mDNS candidate de-obfuscation, the relay fallback transport, path
// stats, liveness checks and mid-game reconnect. Loads after net-api.js,
// before net-session.js. Offline-first contract: see net-api.js.
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
function _netMkSess(peer, role){
    return { peer, role, pc:null, dc:null, seed:0, peerProfile:null, game:false,
             rdOk:false, iceQ:[],   // remote description settled; candidates parked until it is
             relay:false, connT:null, relayAbort:null, relaySeq:-1, relayGraceUntil:0,
             relayPending:null, relayBusy:false,   // relay outbound coalesce: latest-wins slot + one-in-flight guard
             ctlEpoch:-1,   // last epoch we started via a control message: dedups the reliable-control repeats
             epoch:0,   // halts so far in THIS connection: both peers count identically (a bye resets the line)
             lastStart:null, lastStartAt:0, reshipAt:0,   // host: the start packet that opened the current epoch, when we shipped it, and when we last re-served it (see _netReshipStart)
             lastRecv:0, lastSent:0, liveT:null, myAgain:false, peerAgain:false, lvlPending:false,
             bsFwd:Infinity, bsRev:Infinity, bsNf:0, bsRevN:0, bsSeq:0, bsRunning:false,   // boundary clock-burst: my min forward-delta, the peer's min forward-delta (piggybacked), my sample count, the peer's reported count, my outgoing seq, a burst in progress
             lastSentTick:-1, lastPhase:'', lastBarsV:-1,
             lastRecvWall:0, reconnectAt:0, reconnecting:false };   // lastRecvWall: Date.now() clock; mid-game p2p rebuild
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
    const pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.cloudflare.com:3478' }] });
    _netSess.pc = pc;
    pc.onicecandidate = e => { if(e.candidate) _netSignalIce(peer, JSON.stringify(e.candidate)); };
    pc.onconnectionstatechange = () => {
        const s = _netSess;
        if(!s || s.pc !== pc || s.relay) return;   // relay mode: the RTC attempt no longer owns the session
        if(pc.connectionState === 'failed' || pc.connectionState === 'closed'){
            if(!s.game) _netRelayStart(s);              // P2P never came up: fall back NOW (earlier than the 6s timer)
            else if(!s.reconnectAt) _netReconnect(s);   // an established game lost its channel: rebuild it, do NOT end
        }
    };
    // P2P gets 6 seconds; then the match falls back to the server relay.
    if(_netTimers) _netSess.connT = setTimeout(()=>{ if(_netSess && _netSess.pc === pc && !_netSess.game) _netRelayStart(_netSess); }, 6000);
    return pc;
}
// Relay-mode handshake (no-P2P bit set): no RTCPeerConnection at all -- the
// offer carries the seed but NO sdp, the answer only the profile, then both
// sides start.php + relay.php immediately.
function _netRelaySessionStart(peer, role, seed, x10, peerProfile){
    if(_netSess) _netTeardown();   // never silently skip: the offer/answer is already out
    _netSess = _netMkSess(peer, role);
    _netSess.seed = (seed>>>0) || 1;
    _netSess.x10 = !!x10;
    if(peerProfile) _netSess.peerProfile = peerProfile;
    _netSess.relay = true;
    _netSeekStop();
    _netSess.game = true; _netMarkRecv(_netSess);
    _netSess.relayGraceUntil = performance.now() + 12000;
    _netLb.msg = 'RELAY MODE - CONNECTING...';
    _duelMsg = 'RELAY MODE - VIA SERVER'; _duelMsgAt = _msgNow(); _uiDirty = true;
    _netLiveStart();
    _netRelayLoop(_netSess);
    _netRequestStart(_netSess);
}
function _netRelayOffer(peer, peerProfile){   // inviter/offerer in relay mode: make the seed, offer with no sdp
    if(inGame){ _netSigLog('> offer SKIP(ingame)'); return; }
    if(_netSess) _netTeardown();          // debris: replace it, never silently skip the offer
    const seed = (Math.random()*0x100000000)>>>0;
    _netTimeSync();
    const payload = JSON.stringify({ seed, profile:_netProfile(), v:_swVersion, x10:!!cfg.x10 });
    _netHs.offerTo = peer; _netHs.offerPayload = payload; _netHs.offeredAt = Date.now(); _netHs.offerTries = 1;
    _netSignal(peer, 'offer', payload);
    _netRelaySessionStart(peer, 'host', seed, !!cfg.x10, peerProfile);
}
function _netRelayAnswer(peer, d){   // acceptor/answerer in relay mode: answer with just the profile
    if(d && !_netVerOk(d.v)){
        _netLb.msg = 'VERSION MISMATCH - BOTH PLEASE RELOAD'; _uiDirty = true;
        _netSignal(peer, 'bye', ''); return;
    }
    // No phase guard: an offer is a legitimate reply wherever the user stands
    // (and quick match delivers one unsolicited). Only a running game refuses.
    if(inGame){ _netSigLog('< offer SKIP(ingame)'); return; }
    if(_netSess && _netSess.peer === peer){
        // Duplicate offer: the host re-sent because our answer was lost. Re-answer
        // and KEEP the session -- tearing it down would restart the whole connect.
        _netSignal(peer, 'answer', JSON.stringify({ profile:_netProfile(), v:_swVersion, relay:true }));
        return;
    }
    if(_netSess) _netTeardown();          // unrelated debris must not swallow the offer
    _netHs.accepting = null;
    _netTimeSync();
    // `relay:true` tells an offerer that DID build a peer connection to come over now.
    // Without it, it waits out the full 6s P2P timer before falling back to the mode
    // we already committed to -- 6s of dead air on every mixed-setting pairing.
    _netSignal(peer, 'answer', JSON.stringify({ profile:_netProfile(), v:_swVersion, relay:true }));
    _netRelaySessionStart(peer, 'peer', d.seed, d.x10, _netClampProfile(d.profile));
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
        _netSess.x10 = !!cfg.x10;   // the host's rare-event scale rules the match
        const payload = JSON.stringify({ sdp:pc.localDescription, seed:_netSess.seed, profile:_netProfile(), v:_swVersion, x10:_netSess.x10 });
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
        _netSignal(peer, 'answer', JSON.stringify({ sdp: _netSess.pc && _netSess.pc.localDescription, profile:_netProfile(), v:_swVersion }));
        return;
    }
    if(_netSess) _netTeardown();          // unrelated debris must not swallow the offer
    const pc = _netRtcInit(peer, 'peer');
    _netSess.peerProfile = _netClampProfile(d.profile);
    _netNameSeen(peer, _netSess.peerProfile.name);
    _netSess.seed = (d.seed>>>0) || 1;
    _netSess.x10 = !!d.x10;   // the host's rare-event scale, pinned for the match
    _netHs.accepting = null;
    _netWire(pc.createDataChannel('fok', NET_DC_OPTS));   // pre-negotiated: open our own end at the same id as the offerer
    _netTimeSync();   // in parallel with the ICE handshake: synced by the time sched arrives
    try {
        await pc.setRemoteDescription(d.sdp);
        if(_netSess && _netSess.pc === pc){ _netSess.rdOk = true; _netIceFlush(_netSess); }
        const an = await pc.createAnswer();
        await pc.setLocalDescription(an);
        _netSignal(peer, 'answer', JSON.stringify({ sdp:pc.localDescription, profile:_netProfile(), v:_swVersion }));
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
            if(netMyIndex() === 0){ if(_netWD()) _wDuelSend({ t:'duelResync' }); else _rbResyncSend = RB_RESYNC_BURST; }   // the drop diverged us: host ships a full resync
            _duelMsg = 'RECONNECTED'; _duelMsgAt = _msgNow(); _uiDirty = true;
            return;
        }
        if(s.relay){   // P2P completed AFTER the relay fallback: upgrade to the direct path
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
    dc.onclose = () => { const s = _netSess; if(s && s.game && !s.relay && !s.reconnectAt) _netReconnect(s); };   // unexpected close mid-game: rebuild, do not end
}
// A message type that is a one-shot CONTROL transition (a phase change), as opposed to the
// self-healing input/liveness stream. Control has no redundancy and the peer DEPENDS on it
// -- a lost `rst` hangs the guest -- so both transports make it reliable: the relay retries
// (_netRelayCtl), the DataChannel repeats (_netCtlRepeat). The receiver dedups by epoch
// (rst/sched) or is idempotent (start/again/bye).
function _netIsCtl(t){ return t === 'sched' || t === 'rst' || t === 'start' || t === 'again' || t === 'bye' || t === 'reqlvl'; }
// Repeat a pre-serialized control message twice more over the DataChannel, spaced, to
// survive the unreliable channel's occasional drop without an ack protocol. Stops early if
// the session or channel is gone. Same j (its original pts) each time -- a repeat is always
// in the past, so the receiver's future-gate passes it.
function _netCtlRepeat(s, j){
    let n = 0;
    const rep = () => {
        if(++n > 2 || _netSess !== s || !s.game || !s.dc || s.dc.readyState !== 'open') return;
        try{ s.dc.send(j); }catch(e){}
        if(typeof setTimeout === 'function') setTimeout(rep, 100);
    };
    if(typeof setTimeout === 'function') setTimeout(rep, 100);
}
// `pre` (optional) is o already serialized -- callers that had to stringify anyway
// (the st size check) pass it so the packet is not serialized twice.
function _netSend(o, pre){
    const s = _netSess;
    if(!s) return;
    const pts = netPts();
    if(pts != null && o.pts === undefined){ o.pts = pts; pre = undefined; }   // API: every peer message carries the sender's PTS (added after pre was built: re-serialize)
    // Tick-stream packets are epoch-scoped (see the gate in _netHandleMsg): simTick and the
    // rollback tick-base reset at every level boundary, so stamp the epoch this copy was
    // authored under. The receiver drops a copy that crossed a boundary instead of mapping
    // its pre-reset ticks onto the new timeline. None of these types ever carry `pre`.
    if((o.t === 'in' || o.t === 'h' || o.t === 'st' || o.t === 'rs') && o.ep === undefined){
        // Stamp the epoch of the TICK BASE the ticks are measured on (_rbEpoch), not the live
        // session line: a halt bumps s.epoch while both sims keep ticking the old timeline until
        // the scheduled start, and a packet from that window stamped with the bumped epoch walks
        // through the receive gate onto a reset receiver -- whole-log refusals on every boundary.
        o.ep = (typeof _rbEpoch === 'number') ? _rbEpoch|0 : (s.epoch|0); pre = undefined;
    }
    if(o.w){
        // The radio-warm ping only needs SOMETHING on the wire within the doze interval, so if
        // real traffic (a turn, boost or heartbeat) already went out this window the ping is
        // redundant -- skip it. p2p-only regardless: an HTTP-polled relay cannot doze, and 20Hz
        // posts would hammer it. Threshold sits one tick under the warm cadence so the idle beat
        // itself is never suppressed by frame jitter -- only genuinely recent real traffic is.
        if(s.relay || performance.now() - s.lastSent < (NET_WARM_EVERY - 1) * TICK_MS) return;
    }
    if(o.t === 'in' || o.t === 'pi') _netDbg.hbTx++;   // input-channel packets sent (incl. idle keepalives)
    if(s.relay){ _netRelaySend(s, o); return; }
    if(!s.dc || s.dc.readyState !== 'open') return;
    try{
        const j = pre !== undefined ? pre : JSON.stringify(o);
        // One datagram or nothing. Over the path MTU, SCTP fragments the message and
        // losing ANY fragment loses the whole thing -- on a channel that never
        // retransmits, a fragmented packet is a packet that mostly does not arrive. The
        // budget leaves room for IP+UDP+DTLS+SCTP headers (~70B) under a 1280 floor.
        if(j.length > NET_PKT_MAX) _netSigLog('! packet ' + j.length + 'B > budget');
        // Congestion guard (see NET_SEND_CONG): drop the repairable types rather than
        // queue them late. Rare one-shot control messages (sched/rst/start/again/bye/reqlvl)
        // still queue and are repeated below -- for those, late beats never.
        if(s.dc.bufferedAmount > NET_SEND_CONG && (o.t==='in'||o.t==='pi'||o.t==='h'||o.t==='st'||o.t==='rs')){
            _netDbg.congDrop = (_netDbg.congDrop|0) + 1;
            if(!_netDbg.congAt || performance.now() - _netDbg.congAt > 1000){
                _netDbg.congAt = performance.now();
                _netSigLog('! send buffer congested ' + s.dc.bufferedAmount + 'B');
            }
            _uiDirty = true;
            return;
        }
        s.dc.send(j); s.lastSent = performance.now();
        if(_netIsCtl(o.t)) _netCtlRepeat(s, j);   // unreliable channel: repeat the transition a couple of times
    }catch(e){}
}
// ---- boundary clock burst (symmetric midpoint; see NET_BURST_* above) ----
// Open a fresh burst: forget the previous boundary's samples so this one measures the clock as it
// is NOW. Both sides call it when a boundary opens.
function _netBurstReset(s){
    s = s || _netSess; if(!s) return;
    s.bsFwd = Infinity; s.bsRev = Infinity; s.bsNf = 0; s.bsRevN = 0; s.bsSeq = 0;
}
// Fire one burst datagram: _netSend stamps our send-pts (o.pts); we add our best forward-min so
// far (mr) and how many samples it is over (mn), so the peer learns the one direction it cannot
// measure itself and can gate on our sample count.
function _netBurstPing(s){
    s = s || _netSess;
    if(!s || !s.game || netPts() == null) return;
    _netSend({ t:'bs', sq: s.bsSeq++, mr:(s.bsFwd === Infinity ? null : Math.round(s.bsFwd)), mn: s.bsNf });
}
// Fold one received burst datagram. m.pts = the peer's send-pts (OUR forward direction: recv-pts
// minus send-pts = clock offset + this direction's transit); m.mr/m.mn = the peer's own
// forward-min and its count (OUR reverse direction, which only the peer can measure). Keep the MIN
// of each direction -- the least-delayed datagram is the least clock-offset-biased one.
function _netBurstRecv(s, m){
    s = s || _netSess;
    if(!s) return;
    const r = netPts(); if(r == null || typeof m.pts !== 'number') return;
    const d = r - m.pts;
    if(d < s.bsFwd) s.bsFwd = d;
    s.bsNf++;
    if(typeof m.mr === 'number' && m.mr < s.bsRev) s.bsRev = m.mr;
    if(typeof m.mn === 'number' && m.mn > s.bsRevN) s.bsRevN = m.mn|0;
}
// The agreed peer clock offset from the two exchanged direction-mins, or null if the burst is
// unusable (too few samples either way, or an impossible round trip). Both sides feed the SAME two
// numbers in, so both get the IDENTICAL theta -- the invariant the symmetric nudge relies on.
function _netBurstTheta(s){
    s = s || _netSess; if(!s) return null;
    if(s.bsNf < NET_BURST_MIN || s.bsRevN < NET_BURST_MIN) return null;   // starved (a dozing side): keep the old clock
    if(s.bsFwd === Infinity || s.bsRev === Infinity) return null;
    const host = (s.role === 'host');
    const mAB = host ? s.bsRev : s.bsFwd;   // A->B: the host measures it via the peer's mr; the joiner measures it directly
    const mBA = host ? s.bsFwd : s.bsRev;   // B->A: the reverse
    const rttMin = mAB + mBA;               // the offsets cancel in the sum: this is 2x the min one-way latency
    if(!(rttMin >= 0) || rttMin > 5000) return null;   // impossible/absurd: a one-sided doze inflated one direction
    return { theta:(mBA - mAB) / 2, rttMin, host };   // theta > 0 => the host clock LEADS the joiner's
}
// Nudge OUR clock half of theta onto the shared midpoint (slew-capped). The host pulls its clock
// back, the joiner steps its clock up; with the same theta on both, they meet at the exact
// midpoint (residual 0). `theta` may be passed EXPLICITLY -- the joiner applies the value the host
// measured and shipped on the start packet (bth), so both use the IDENTICAL number with no
// convergence race; omitted, it is computed locally from this side's own burst samples (a rejected
// or unusable burst -> no-op). Returns the applied ms, 0 when nothing was applied.
function _netBurstApply(s, theta){
    s = s || _netSess;
    if(!s || _netSync.ofs == null) return 0;
    if(theta == null){ const t = _netBurstTheta(s); if(!t) return 0; theta = t.theta; }
    if(!theta) return 0;
    let d = (s.role === 'host' ? -1 : 1) * (theta / 2);
    if(d >  NET_BURST_SLEW_MS) d =  NET_BURST_SLEW_MS;   // symmetric clamp: clips to the same magnitude on both sides
    if(d < -NET_BURST_SLEW_MS) d = -NET_BURST_SLEW_MS;
    _netSync = { ofs:_netSync.ofs + d, rtt:_netSync.rtt, at:Date.now() };
    _netClockPush();
    return d;
}
// Run one side's outgoing burst: fire NET_BURST_N stamped datagrams NET_BURST_GAP_MS (~one engine
// tick) apart, then HOLD the collection window open up to NET_BURST_WAIT_MS longer -- waiting for the
// peer's return datagrams to cross a full (possibly doze-inflated) round trip -- but finish the
// instant both directions are already usable (early-out), so a healthy link is never slowed and a
// slow one still gets its samples. `done` fires at finish. Timer-driven so the pings genuinely spread
// over the wire and the min-filter has samples to pick from; with no timers available, or if we are
// torn down mid-burst, it degrades to a single synchronous ping + immediate done (which the
// accept-gate then rejects as starved -> the prior clock is kept).
function _netBurstRun(s, done){
    s = s || _netSess;
    if(!s || !s.game){ if(done) done(); return; }
    _netBurstReset(s);
    s.bsRunning = true;
    if(typeof setTimeout !== 'function'){ _netBurstPing(s); s.bsRunning = false; if(done) done(); return; }
    let sent = 0, waited = 0;
    const finish = ()=>{ if(_netSess === s) s.bsRunning = false; if(done && _netSess === s && s.game) done(); };
    const step = ()=>{
        if(_netSess !== s || !s.game){ s.bsRunning = false; return; }   // torn down mid-burst: abandon
        if(sent < NET_BURST_N){ _netBurstPing(s); sent++; setTimeout(step, NET_BURST_GAP_MS); return; }
        // Every ping sent: keep collecting until both directions have enough samples (theta usable),
        // or the extra window runs out -- whichever comes first.
        if(_netBurstTheta(s) || waited >= NET_BURST_WAIT_MS){ finish(); return; }
        waited += NET_BURST_GAP_MS;
        setTimeout(step, NET_BURST_GAP_MS);
    };
    step();
}
// Host side of a boundary: open the joiner's burst ('bsync'), run our own, then hand `then` the
// agreed peer offset (theta; 0 if the burst was unusable). The caller applies OUR half, authors the
// start PTS on the nudged clock, and ships theta on the start packet as `bth` for the joiner's half.
function _netBurstThenStart(s, then){
    s = s || _netSess;
    if(!s || !s.game || s.role !== 'host'){ if(then) then(0); return; }
    _netSend({ t:'bsync', epoch:(s.epoch|0) });   // trigger the joiner's burst; both measure over the same window
    _netBurstRun(s, ()=>{
        if(_netSess !== s || !s.game) return;
        const bt = _netBurstTheta(s);
        const theta = bt ? bt.theta : 0;
        _netBurstApply(s, theta);   // host applies -theta/2 here; the joiner applies +theta/2 from bth
        then(theta);
    });
}
// Fall back to the server relay: same messages, ~200-400ms one-way -- the local
// snake stays instant (prediction), corrections just arrive slower. The user
// sees why: a short message now and a RELAY MODE tag on the board.
function netRelayActive(){ return !!(_netSess && _netSess.game && _netSess.relay); }
// TODO(netcode, long-term): replace this HTTP relay with TURN (coturn) as the p2p-failed
// path. A coturn entry in iceServers keeps the IDENTICAL DataChannel (same unreliable-
// unordered netcode, one forwarding hop) and retires relay.php entirely. This is infra,
// not logic: coturn needs a host with open UDP, which the shared webhost cannot provide
// (the STUN-only iceServers in _netRtcInit). ACCEPTED as long-term; until then this relay
// IS the real fallback path -- its floor is ~RTT plus a few ms server-side, but verify on
// live devices before trusting it for play.
function _netRelayStart(s){
    if(_netSess !== s || s.game) return;
    s.relay = true;
    if(s.connT){ clearTimeout(s.connT); s.connT = null; }
    // Retire the failed RTC attempt: its late close/failed events must not
    // touch the relay session (both handlers also check s.relay).
    try{ if(s.dc) s.dc.close(); }catch(e){}
    try{ if(s.pc) s.pc.close(); }catch(e){}
    s.dc = null; s.pc = null;
    _netSeekStop();
    s.game = true; _netMarkRecv(s);
    s.relayGraceUntil = performance.now() + 12000;   // the peer may fall back up to ~5s later; let it arrive
    _netLb.msg = 'P2P FAILED - CONNECTING VIA RELAY...';
    _duelMsg = 'RELAY MODE - VIA SERVER'; _duelMsgAt = _msgNow(); _uiDirty = true;
    _netLiveStart();
    _netRelayLoop(s);
    _netRequestStart(s);
}
// Deliver a batch of relayed messages exactly once, in seq order. Shared by the held GET and
// the pull-piggyback POST reply (API 3.2): the server drains each message to whichever of the
// two arrives first, so both paths MUST run the same seq dedup + recv-mark or they drift.
function _netRelayDeliver(s, msgs){
    if(!Array.isArray(msgs)) return;
    for(const m of msgs){
        if((m.seq|0) <= s.relaySeq) continue;   // exactly-once, in order
        s.relaySeq = m.seq|0;
        if(typeof m.age === 'number') _netDbg.relayAge = m.age|0;   // diag: ms it sat on the server (mailbox wait vs pool-queue delay)
        _netMarkRecv(s);
        _netHandleMsg(String(m.payload||''));
    }
}
// One relay POST. Returns 'ok' when the message is off our hands (a clean send, or a 503
// that ended the session), 'resend' when the hub REFUSED it and asks for a retry (store
// full), or 'drop' on a self-healing failure (back-off 429s, a 400 clock, transport error).
async function _netRelayPost(s, o){
    if(!_netOk()) return 'drop';
    try {
        const _t0 = performance.now();
        // The ENVELOPE pts is backdated like every other PTS we send: the server
        // rejects a future one outright (zero tolerance), and stamping it raw made
        // an asymmetric-link clock bias 400 every packet of the match -- silently,
        // since nothing below looked at the status. The payload keeps the true pts,
        // so the peer's lag math is untouched.
        // pull (API 3.2): piggyback our OWN inbound onto this reply, so receive survives a
        // saturated FPM pool that stalls the held GET. Harmless on a 3.1 server (ignored),
        // but the reply is DRAINED, so we MUST consume messages[] below -- which we do.
        const r = await fetch(NET_BASE + '/api/relay.php', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ id:getPlayerId(), peer:s.peer, payload:JSON.stringify(o),
                                   pts: o.pts != null ? o.pts - 50 : undefined, pull: true }),
            cache:'no-store', priority:'high' });
        s.lastSent = performance.now();
        _netDbg.relayRtt = performance.now() - _t0;   // client<->server relay-POST round-trip (about half the peer path)
        if(r.status === 503){ _netSessionEnd('SERVER FULL - TRY LATER'); return 'ok'; }   // capped: honest busy, end the attempt
        if(r.status === 400 || r.status === 429){
            // 429 = the per-second rate block, a full peer backlog, or a momentarily-full hub
            // store; 400 is almost always our clock. All used to look like a healthy send and
            // surfaced 4s later as CONNECTION LOST, blaming the network.
            let j = null; try{ j = await r.json(); }catch(e){}
            const err = (j && j.error) ? String(j.error) : '';
            _netDbg.relayDrop = (_netDbg.relayDrop|0) + 1;
            _netSigLog('! relay ' + r.status + (err ? ' ' + err : ''));
            if(r.status === 400 && /future/.test(err)) _netTimeSync(true);
            // 'store full' = the hub's shared memory was momentarily full and REFUSED the
            // message (not delivered), so the server asks us to resend -- a dropped input is
            // exactly what desyncs relay into the burst. The other 429s (rate limit, backlog
            // full) mean back OFF, and a 400 is our clock: those self-heal via the next packet.
            return (r.status === 429 && /store full/.test(err)) ? 'resend' : 'drop';
        }
        // 2xx: consume any inbound piggybacked on this reply (pull). The server drained it on
        // return, so this is the ONLY chance to read it -- same dedup as the GET.
        try{ const j = await r.json(); if(j && j.messages) _netRelayDeliver(s, j.messages); }catch(e){}
        return 'ok';
    } catch(e){ return 'drop'; }
}
// Drain the coalesce slot: keep ONE POST in flight, always sending the freshest pending
// input packet. A local steer POSTs an `in` immediately, so on a 200-400ms relay RTT a key
// burst would otherwise pile up as concurrent fetches (and trip the rate cap). Each `in`
// carries the whole _rbSent redundant log, so a newer one strictly supersedes an older:
// dropping the ones between loses nothing, and the send rate self-limits to the round trip.
async function _netRelayPump(s){
    if(s.relayBusy) return;
    s.relayBusy = true;
    while(_netSess === s && s.game && s.relay && s.relayPending){
        const o = s.relayPending; s.relayPending = null;
        const code = await _netRelayPost(s, o);
        // 'store full' REFUSED the input (not delivered); dropping it is what desyncs relay
        // into the burst, so re-slot for a resend -- UNLESS a newer `in` already took the slot
        // (it carries the same redundant log, so it supersedes). Pace it so a persistently full
        // hub is not hot-looped; in real play the next tick's `in` supersedes it anyway.
        if(code === 'resend' && !s.relayPending){
            s.relayPending = o;
            if(typeof setTimeout === 'function') await new Promise(res => setTimeout(res, 20));
        }
    }
    s.relayBusy = false;
}
// A one-shot control transition, retried with backoff so a single lost POST cannot hang a
// phase change. 'ok' (a clean send, or a 503 that ended the session) stops it; 'resend' (hub
// store full) and 'drop' both retry. The receiver dedups (epoch / idempotent), so a duplicate
// that DID land is harmless.
async function _netRelayCtl(s, o){
    for(let i = 0; i < 3; i++){
        if(_netSess !== s || !s.game || !s.relay) return;
        if((await _netRelayPost(s, o)) === 'ok') return;
        if(typeof setTimeout === 'function') await new Promise(res => setTimeout(res, 120 * (i + 1)));
    }
}
function _netRelaySend(s, o){
    if(!_netOk()) return;
    if(o.t === 'in'){ s.relayPending = o; _netRelayPump(s); return; }   // coalesce: latest wins, one in flight
    if(_netIsCtl(o.t)){ _netRelayCtl(s, o); return; }                   // reliable: retry with backoff
    _netRelayPost(s, o);                                               // pi/h/st/rs: low-rate, self-healing, send once
}
// Act on one relay GET reply. `gone` (API 3.3) is the server telling us the pairing was torn
// down (the peer sent a bye/decline): relay has no DataChannel-close, so without this the peer
// sat in the game until its own liveness timeout -- exactly the reported bug. Treat it like an
// in-band bye (remoteBye: the server already knows, no need to say it back). Otherwise deliver
// any messages through the shared exactly-once dedup.
function _netRelayOnReply(s, r){
    if(!r) return false;
    if(r.gone){ _netSessionEnd('OPPONENT LEFT', true); return true; }
    _netRelayDeliver(s, r.messages);
    return false;
}
async function _netRelayLoop(s){
    while(_netSess === s && s.game && s.relay){
        if(!_netOk()) return;
        // Abortable: without this the held socket lingers up to 8s after a teardown
        // (leaving a match, or unload), long after we stopped caring about it.
        s.relayAbort = (typeof AbortController === 'function') ? new AbortController() : null;
        const r = await _netGet('/api/relay.php?id=' + getPlayerId() + '&peer=' + s.peer + '&wait=9',
                                s.relayAbort ? s.relayAbort.signal : undefined);
        s.relayAbort = null;
        if(_netSess !== s || !s.game || !s.relay) return;
        if(!r && _netTimers) await new Promise(res => setTimeout(res, 1000));   // transport error: back off
        if(_netRelayOnReply(s, r)) return;   // 'gone' ended the session -> stop polling
    }
}
// Read the SELECTED ICE candidate pair so we KNOW the real path: host = direct LAN (~1ms),
// srflx/prflx = reflexive -- hairpins out through the router/internet even on one LAN, the usual
// cause of "same-Wifi but 100ms jitter" -- relay = via a TURN server. Plus the true P2P RTT.
function _netPathStat(s){
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
// TIMELINE BREAK RECOVERY (post-suspend hard-snap): a wall clock >600 ticks past the sim means
// the sim was FROZEN (a long device/tab suspend) while the clock ran on. It can never catch that
// up, and relay keeps feeding data on wake so the silence timeout never fires -- leaving a
// permanent false CONNECTION LOST with no recovery. Re-anchor startPts to where the sim actually
// is: both peers froze at ~the same tick and share the clock, so both snap to ~the same origin and
// resume IN SYNC (the frozen span is simply skipped; any few-tick residual is left to the normal
// rollback/resync). Small gaps self-heal via the catch-up ladder and never reach the >600 guard.
function _netBreakRecover(s){
    if(!inGame || !s || !s.startPts) return false;
    const p = netPts();
    if(p == null || Math.abs(Math.floor((p - s.startPts) / TICK_MS) - simTick) <= 600) return false;
    s.startPts = p - simTick * TICK_MS;   // origin := the sim's real position on the shared clock
    _netClockPush();                      // main + worker core must both re-anchor
    _netSigLog('! timeline break -> re-anchored (suspend recovery)');
    return true;
}
// In-game liveness: the DataChannel is the session -- ping when idle, 4s silence = dead.
function _netLiveStart(){
    if(!_netTimers) return;
    _netSess.liveT = setInterval(_netLiveCheck, 250);
}
// ONE liveness pass (ping-when-idle, reconnect/kill on silence, end a stuck desync). Split out
// of the setInterval body so the headless duel driver can run the REAL check on its simulated
// clock -- the timeouts and the kill are then tested by the same code the browser runs, not a
// re-implementation. Production calls it every 250ms; the driver pumps it off its fake clock.
function _netLiveCheck(){
    const s = _netSess; if(!s || !s.game) return;
    const nowMs = performance.now();
    if(!s.pathAt || nowMs - s.pathAt > 2000){ s.pathAt = nowMs; _netPathStat(s); }   // refresh the ICE-path readout ~0.5Hz
    // A desync whose one-shot-per-verdict repairs keep failing is a dead match too:
    // same deadline as a failed reconnect. Worker mode mirrors the age in each frame.
    const _dsyFor = _netWD() ? (_netDbg.dsyFor|0) : (_rbBadSince ? Date.now() - _rbBadSince : 0);
    if(inGame && _dsyFor > RB_PERSIST_KILL_MS){ _netSessionEnd('OUT OF SYNC - MATCH ENDED'); return; }
    _netBreakRecover(s);   // post-suspend hard-snap: re-anchor a sim frozen far behind the clock
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
    if(s.relay){
        if(nowMs < s.relayGraceUntil) return;                             // relay just engaged: let the peer catch up
        if(silent > RB_PERSIST_KILL_MS) _netSessionEnd('CONNECTION LOST'); // relay has no transport to rebuild -> silence past the deadline ends it
        return;
    }
    // p2p ladder: WARN (netDuelWarn, ~RB_WARN_MS) -> RECONNECT (rebuild the link, ~RB_RECONNECT_MS)
    // -> hard KILL at the deadline. The kill is unconditional so "silence past the deadline ends
    // the match" holds even where no rebuild was possible; below it, start one rebuild or clear it.
    if(silent > RB_PERSIST_KILL_MS){ _netSessionEnd('CONNECTION LOST'); return; }
    if(silent > RB_RECONNECT_MS && !s.reconnectAt) _netReconnect(s);
    else if(s.reconnectAt && silent < RB_WARN_MS) _netReconnectDone(s);   // packets flowing again -- recovered
}
// ---- mid-game reconnect: rebuild the p2p transport WITHOUT restarting the match ----
// The sim keeps running on both sides throughout (each ticks off the shared clock), so once
// packets flow again the periodic state+hash recovery re-converges them. We only rebuild the
// dead RTCPeerConnection/DataChannel; epoch, seed and sim state are untouched.
function _netReconnect(s){
    if(!s || s.reconnectAt || s.relay || !_netRtcAvail()) return;
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
    const pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.cloudflare.com:3478' }] });
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
        const payload = JSON.stringify({ sdp:pc.localDescription, rc:1, v:_swVersion });
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
        if(s.pc.localDescription) _netSignal(from, 'answer', JSON.stringify({ sdp:s.pc.localDescription, rc:1, v:_swVersion }));
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
        _netSignal(from, 'answer', JSON.stringify({ sdp:pc.localDescription, rc:1, v:_swVersion }));
    } catch(e){}
}
