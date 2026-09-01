// net-relay.js -- DEPRECATED: the HTTP server-relay fallback for duels (api/relay.php).
//
// Do NOT extend this. It exists only as the p2p-failed path on hosts where WebRTC cannot
// reach the peer, and it is on the way out: the replacement is a TURN server (coturn) in
// _netRtcInit's iceServers, which keeps the IDENTICAL DataChannel (same unreliable-unordered
// netcode, one forwarding hop) and retires relay.php entirely. That is infra, not logic --
// coturn needs a host with open UDP, which the current shared webhost cannot provide.
//
// Everything relay-specific lives in THIS FILE so the removal is a file delete plus the
// residual hook list in docs/DEPRECATED-relay.md. New netcode belongs in net-rtc.js /
// net-session.js and must work over the DataChannel without a relay equivalent.

// ---- Relay-mode handshake: no RTCPeerConnection at all -- the offer carries the seed but
// NO sdp, the answer only the profile, then both sides start.php + relay.php immediately. ----
function _netRelaySessionStart(peer, role, seed, peerProfile){
    if(_netSess) _netTeardown();   // never silently skip: the offer/answer is already out
    _netSess = _netMkSess(peer, role);
    _netSess.seed = (seed>>>0) || 1;
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
    const payload = JSON.stringify({ seed, profile:_netProfile(), v:_swVersion });
    _netHs.offerTo = peer; _netHs.offerPayload = payload; _netHs.offeredAt = Date.now(); _netHs.offerTries = 1;
    _netSignal(peer, 'offer', payload);
    _netRelaySessionStart(peer, 'host', seed, peerProfile);
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
    _netRelaySessionStart(peer, 'peer', d.seed, _netClampProfile(d.profile));
}
// ---- Relay transport: same messages as the DataChannel, ~200-400ms one-way. The local
// snake stays instant (prediction), corrections just arrive slower. The user sees why:
// a short message now and a RELAY MODE tag on the board. ----
function netRelayActive(){ return !!(_netSess && _netSess.game && _netSess.relay); }
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
