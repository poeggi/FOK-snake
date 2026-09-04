// ============================================================================
// net-session.js -- ONLINE 1:1 session lifecycle: lobby + handshake state,
// invites, quick match, the signal dispatcher, transition control, in-duel
// message handling and teardown. NETCODE (deterministic rollback): both
// clients run the deterministic sim locally from the shared seed; own input
// applies instantly (local feel on BOTH ends) and travels tick-stamped to the
// peer. The sim has no authority -- only inputs cross the wire -- but every
// TIMELINE ORIGIN (match/rematch/level/respawn/resume) is HOST-authored: the
// host runs a clock burst, authors start_pts on the agreed clock and ships ONE
// 'go' {why,seed,startPts,epoch,lvl,bth}; the joiner asks via 'req' {why,epoch}.
// Both are echo-acknowledged and retried until answered (_netTxShip); begins
// fire on the clock, never on the ack. A late peer input rewinds the sim and
// re-simulates locally (a sim tick is sub-microsecond, so replay is free).
// Server = matchmaking + signaling only. Loads LAST of the net files.
// Offline-first contract: see net-api.js.
// ============================================================================
// ---- lobby state (read by drawLobby + the lobby input row) ----
// ---- HANDSHAKE STATE. Deliberately SEPARATE from the lobby UI state: a
// handshake outlives navigation (an invite arriving on another screen, the user
// stepping into/out of a menu). Only an explicit abort (BACK/quit) or a timeout
// clears it. Putting these in _netLb is what silently killed handshakes before:
// every screen change reset the object and the peer's reply was then discarded.
var _netHs = { sent:null, sentAt:0, sentRelay:false,     // we invited; awaiting accept (sentRelay: DEPRECATED(relay))
               accepting:null, acceptingAt:0,            // we accepted; awaiting their offer
               offerTo:null, offerPayload:null, offeredAt:0, offerTries:0 };   // we offered; awaiting answer
function _netHsClear(){ _netHs = { sent:null, sentAt:0, sentRelay:false, accepting:null, acceptingAt:0,
                                   offerTo:null, offerPayload:null, offeredAt:0, offerTries:0 }; }
function _netHsActive(){ return !!(_netHs.sent || _netHs.accepting || _netHs.offerTo); }
// A session that is NOT an on-screen game and NOT part of a live handshake is
// debris: reap it (silently -- no bye; nobody is waiting on it).
function _netReapDead(){
    if(_netSess && !inGame && !_netHsActive()){ _netTeardown(); return true; }
    return false;
}
// UI-only lobby state.
let _netLb = { sel:0, invite:null, inviteSel:0, seeking:false, msg:'', err:false };
function netLobbyEnter(){
    // NAVIGATION, not an abort: never bye, never touch a live handshake -- an
    // invite arriving on another screen routes through here, and wiping our own
    // in-flight invite/accept was a prime cause of dropped connections.
    _netReapDead();                       // only debris (no game, no handshake)
    _netLb.sel = 0; _netLb.msg = ''; _netLb.err = false;
    if(_netOk()){
        _netTimeSync(true).then(()=>_netHello());   // mandate: measure on entering the multiplayer screen, report right away
        _netHello();                                // and refresh presence/friends immediately
        _netFrRefresh(false);                       // notice peer-side removals here too
    }
}
function netLobbyLeave(){
    // Explicit user abort (BACK): withdraw the invite, drop the handshake, tear
    // down a not-yet-playing session. A running game is never touched.
    if(!inGame) netEndSession();
    else _netSeekStop();
}
function _netRtcAvail(){ return typeof RTCPeerConnection === 'function'; }
// ---- worker-hosted duel seam (game.js owns the worker; these guard its absence) ----
function _netWD(){ return typeof netWorkerDuelOn === 'function' && netWorkerDuelOn(); }
// Push a fresh clock anchor to the worker's core: its tick target derives from ofs +
// startPts exactly like netTickTarget does here, so every adoption must reach it.
function _netClockPush(){
    if(_netSync.ofs == null) return;
    if(_netWD()) _wDuelSend({ t:'duelClock', ofs:_netSync.ofs, startPts:(_netSess && _netSess.startPts) || null });
    else if(inGame && _netSess && _netSess.game && typeof _fbSeedPhase === 'function') _fbSeedPhase();   // in-process: the grid moved, re-set the phase
}

// ---- invites ----
async function _netInviteSend(to){
    if(inGame) return;
    if(_netSess) _netTeardown();          // debris from a dead attempt: drop it silently, never bye the new target
    if(!_netOk()) return;
    const relay = !!cfg.noP2P;   // DEPRECATED(relay): with net-relay.js gone this is always false and the branches below collapse
    if(!relay && !_netRtcAvail()){ _netLb.msg = 'WEBRTC NOT SUPPORTED'; return; }   // relay mode needs no WebRTC
    if(_netHs.sent && _netHs.sent !== to) _netSignal(_netHs.sent, 'bye', '');       // switching targets: withdraw the old one
    _netHsClear();
    _netHs.sent = to; _netHs.sentAt = Date.now(); _netHs.sentRelay = relay;
    _netLb.msg = '';
    // The invite is gated on an ACCEPTED friendship, so it must not RACE the request
    // that establishes one. Firing both in the same breath meant the invite reached
    // the server while the friendship was still being recorded and came back 403 --
    // silently. That is exactly why sending a second one "worked": by then the
    // friendship had landed. Wait for it (a no-op once we are already friends).
    if(!_netFrOk[to]){
        _netLb.msg = 'CONNECTING...'; _uiDirty = true;
        const fr = netFriendRequest(to);
        if(fr && fr.then) await fr;
        if(_netHs.sent !== to) return;   // aborted while we waited
        _netLb.msg = '';
    }
    const res = await _netSignal(to, relay ? 'invite-relay' : 'invite', JSON.stringify({ profile:_netProfile() }));
    if(_netHs.sent !== to) return;   // superseded or aborted while the request was in flight
    if(res.json) return;             // the server took it: now we wait for a real answer
    // Refused. Say so now instead of showing WAITING for 30s over an invite that
    // was never delivered.
    _netHs.sent = null; _uiDirty = true;
    if(res.status === 403){
        // The server says we are NOT friends, whatever our local cache believes.
        // That belief is what made this permanent: netFriendRequest() no-ops while
        // _netFrOk[to] is set, so the friendship was never repaired and EVERY invite
        // to this player 403'd silently, forever. Drop the stale belief and re-ask.
        _netFrOkClear(to);
        delete _netFrRequested[to];
        netFriendRequest(to);
        _netLb.msg = netFriendBanned() ? 'TOO MANY FRIEND REQUESTS - TRY LATER' : 'NOT FRIENDS YET - RETRY IN A MOMENT';
    }
    else if(res.status === 503) _netLb.msg = 'SERVER FULL - TRY LATER';
    else if(res.status === 400 && /future/.test(res.err)) _netLb.msg = 'CLOCK RE-SYNCED - TRY AGAIN';
    else _netLb.msg = 'INVITE FAILED - TRY AGAIN';   // the reason is in the DEBUG overlay
}
function _netInviteAnswer(acc){
    const inv = _netLb.invite; if(!inv) return;
    _netLb.invite = null; _uiDirty = true;
    // Relay mode when EITHER side wants it (our setting, or the invite carried the bit). DEPRECATED(relay)
    const relay = !!cfg.noP2P || !!inv.relay;
    if(_netSess && !inGame) _netTeardown();   // debris must not block an accept
    if(!acc || inGame || (!relay && !_netRtcAvail())){ _netSignal(inv.from, 'decline', ''); return; }
    _netSignal(inv.from, relay ? 'accept-relay' : 'accept', JSON.stringify({ profile:_netProfile() }));
    _netHs.accepting = inv.from; _netHs.acceptingAt = Date.now();   // waiting for their offer now
    _netLb.msg = relay ? 'ACCEPTED - RELAY MODE...' : 'ACCEPTED - CONNECTING...';
}

// ---- quick match (pair with anyone waiting; ~1 Hz seek poll) ----
let _netSeekT = null;
function _netSeekStart(){
    if(_netSeekT || _netSess || !_netOk() || !_netTimers) return;
    if(!cfg.noP2P && !_netRtcAvail()){ _netLb.msg = 'WEBRTC NOT SUPPORTED'; return; }   // relay mode needs no WebRTC -- DEPRECATED(relay)
    _netLb.seeking = true; _netLb.msg = '';
    _netSeekT = setInterval(async ()=>{
        if(!_netLb.seeking || _netSess){ _netSeekStop(); return; }
        const r = await _netPost('/api/match.php', { id:getPlayerId(), action:'seek' });
        if(!r || !r.matched) return;
        _netSeekStop();
        if(r.peer_name) _netNameSeen(String(r.matched), r.peer_name);   // strangers: the pairing is the entitlement
        if(r.role === 'offerer'){ cfg.noP2P ? _netRelayOffer(String(r.matched)) : _netRtcOffer(String(r.matched)); }   // DEPRECATED(relay) fork
        else _netLb.msg = 'MATCHED - CONNECTING...';   // the offer arrives as a signal
        _uiDirty = true;
    }, 1000);
}
function _netSeekStop(){
    _netLb.seeking = false;
    if(_netSeekT){ clearInterval(_netSeekT); _netSeekT = null; _netPost('/api/match.php', { id:getPlayerId(), action:'cancel' }); }
}

// ---- signal dispatch (from hello + poll; each message is delivered exactly once) ----
function _netOnSignal(sig){
    try {
        const from = String(sig.from||'');
        _netSigLog('< '+String(sig.type)+' '+from.slice(0,4));   // debug overlay
        if(!/^[0-9a-f]{8}$/.test(from) && sig.type !== 'friend' && sig.type !== 'peer-net' && sig.type !== 'tourney') return;   // server-generated: sender is in the payload
        const pl = String(sig.payload||'');
        // SPECTATOR signalling rides the duel's own offer/answer/ice types, told apart by the
        // sp:1 marker the sender adds -- so the server contract needed exactly ONE new
        // client-sendable type ('watch') rather than three. Routed off HERE, before the duel
        // cases below, because a spectator link arriving as an 'offer' would otherwise read as
        // a reconnect of the match and tear down a perfectly good session.
        // 'tourney' is RESERVED: the server generates every one of them, so there is no
        // player id to check and the payload is the whole message. tourney.js decides what
        // is worth acting on -- and asks the server when it is not sure.
        if(sig.type === 'tourney'){
            if(typeof _ttOnSignal === 'function') _ttOnSignal(_netJson(pl));
            return;
        }
        if(sig.type === 'watch'){
            if(typeof _spOnWatch === 'function') _spOnWatch(from, _netJson(pl));
            return;
        }
        if((sig.type === 'offer' || sig.type === 'answer' || sig.type === 'ice')){
            const sd = _netJson(pl);
            if(sd && sd.sp){
                if(typeof _spOnSignal === 'function') _spOnSignal(sig.type, from, sd);
                return;
            }
        }
        switch(sig.type){
            case 'invite':
            case 'invite-relay': {   // DEPRECATED(relay) signal type
                if(_netSess || _netLb.invite){ _netSignal(from, 'decline', ''); return; }   // busy: tell them right away
                if(_netHs.sent === from){
                    // MUTUAL invite: both pressed INVITE -- both already said yes, so no
                    // dialog. Deterministic tie-break: the smaller ID sends the accept
                    // (and becomes the answerer); the larger one ignores the incoming
                    // invite and turns into the offerer when that accept arrives.
                    if(getPlayerId() < from){
                        _netHs.sent = null;
                        _netSignal(from, 'accept', JSON.stringify({ profile:_netProfile() }));
                        _netLb.msg = 'MUTUAL INVITE - CONNECTING...'; _uiDirty = true;
                    }
                    return;
                }
                // The ACCEPT? dialog lives on the lobby screen: an invite arriving on
                // a 1:1/social screen jumps there. Anywhere else (main menu, games,
                // settings, ...) the player is UNAVAILABLE -- decline immediately so
                // the inviter is not left waiting for the 30s staleness.
                if(phase === 'duelMenu' || phase === 'duel11' || phase === 'friends' || phase === 'friendId'){ netLobbyEnter(); phase = 'lobby'; }
                else if(phase !== 'lobby'){ _netSignal(from, 'decline', ''); return; }
                _netLb.invite = { from, profile:_netClampProfile(_netJson(pl).profile), relay: sig.type === 'invite-relay', at: Date.now() };
                _netNameSeen(from, _netLb.invite.profile.name);
                _netLb.inviteSel = 0; Snd.sfxPlay('nav', cfg.music); _uiDirty = true;
                break;
            }
            case 'accept':
            case 'accept-relay': {   // DEPRECATED(relay) signal type
                if(_netHs.sent !== from){ _netSigLog('< accept UNEXPECTED'); return; }   // not ours: visible, not silent
                const relayNow = _netHs.sentRelay || sig.type === 'accept-relay';
                _netHs.sent = null;
                const ap=_netClampProfile(_netJson(pl).profile); _netNameSeen(from, ap.name);
                if(relayNow) _netRelayOffer(from, ap);
                else _netRtcOffer(from, ap);
                break;
            }
            case 'decline':
                if(_netHs.sent === from){ _netHs.sent = null; _netLb.msg = 'DECLINED'; _uiDirty = true; }
                break;
            case 'offer': {
                const od = _netJson(pl);
                if(od.rc){
                    // A reconnect offer only makes sense against a live game with this peer.
                    // Arriving after the match ended (a late one-shot in the mailbox), it must
                    // NOT fall through to _netRtcAnswer and spin up a phantom one-sided duel.
                    if(_netSess && _netSess.peer === from && _netSess.game) _netRtcReanswer(from, od);
                    break;
                }
                // Relay when EITHER side wants it -- the same rule the invite path applies
                // (_netInviteAnswer). Quick match has no invite to carry the bit, so an
                // offerer without the setting sends a normal sdp offer; routing on that
                // alone silently ignored OUR relay setting and played full P2P.
                if(od.sdp && !cfg.noP2P) _netRtcAnswer(from, od); else _netRelayAnswer(from, od);   // DEPRECATED(relay) fork
                break;
            }
            case 'answer': {
                const d = _netJson(pl);
                // NOT gated on _netSess.pc: a relay session never builds one, so
                // that gate dropped the answer's profile and version on the whole
                // default path -- quick match then had no peerProfile at all.
                if(_netSess && _netSess.peer === from){
                    _netHs.offerTo = null; _netHs.offerPayload = null;   // OUR peer answered: stop re-sending (a stale answer from a past peer must NOT kill a current offer's retry)
                    if(!_netVerOk(d.v)){
                        _netTeardown();
                        _netLb.msg = 'VERSION MISMATCH - BOTH PLEASE RELOAD'; _uiDirty = true;
                        _netSignal(from, 'bye', '');
                        break;
                    }
                    if(d.profile){
                        _netSess.peerProfile = _netClampProfile(d.profile);
                        _netNameSeen(from, _netSess.peerProfile.name);
                    }
                    if(d.relay && _netSess.pc && !_netSess.game){   // DEPRECATED(relay): whole branch
                        // They answered in relay mode (their setting, not ours). Switch
                        // this attempt over at once rather than letting the pc time out.
                        _netRelayStart(_netSess);
                        _netLb.msg = 'RELAY MODE - CONNECTING...';   // nothing failed here: their choice
                    }
                    // rc is the offer generation: an answer only fits the pc built for THAT offer.
                    // Signals are one-shot but not ordered, so an answer to a superseded offer can
                    // still land, and setting it on the current pc wedges the connect for good.
                    else if(_netSess.pc && d.sdp && (d.rc|0) === (_netSess.rc|0)){
                        const s = _netSess;
                        s.pc.setRemoteDescription(d.sdp)
                            .then(()=>{ if(_netSess === s){ s.rdOk = true; _netIceFlush(s); } })
                            .catch(()=>{});
                    }
                }
                break;
            }
            case 'ice':
                if(_netSess && _netSess.peer === from && _netSess.pc){
                    const cand = _netJson(pl);
                    _netIceAdd(_netSess, cand);   // parked until the remote description settles
                    const extra = _netDeobfuscateCand(cand, _netPeerNet[from]);   // mDNS -> real IPv6, probed in parallel
                    if(extra){ _netIceAdd(_netSess, extra); _netDbg.iceDeob = (_netDbg.iceDeob|0)+1; }
                }
                break;
            case 'peer-net': {
                // Server hint (delivered with the accept, before offer/answer): the peer's
                // public IP + family and our own. Stored to de-obfuscate mDNS candidates.
                const d = _netJson(pl);
                const who = d && String(d.peer || '');
                if(/^[0-9a-f]{8}$/.test(who)){
                    _netPeerNet[who] = { ip:String(d.ip || ''), fam:d.family|0, selfFam:d.self_family|0 };
                    _netSigLog('< peer-net f' + (d.family|0) + (d.self_family===d.family && d.family ? ' match' : ''));
                }
                break;
            }
            case 'bye':
                if(_netSess && _netSess.peer === from) _netSessionEnd('OPPONENT LEFT', true);   // they said it first
                else if(_netHs.accepting === from){ _netHs.accepting = null; _netLb.msg = 'OPPONENT LEFT'; _uiDirty = true; }   // we accepted, they aborted before offering
                else if(_netLb.invite && _netLb.invite.from === from){ _netLb.invite = null; _netLb.msg = 'INVITE WITHDRAWN'; _uiDirty = true; }
                else if(_netHs.sent === from){ _netHs.sent = null; _netLb.msg = 'CANCELLED'; _uiDirty = true; }
                break;
            case 'friend': {
                // SERVER-generated friendship notification (clients cannot send it):
                // celebrate like a successful QR scan, so both sides know it worked.
                const d = _netJson(pl);
                const who = String(d.from || from || '');
                if(!/^[0-9a-f]{8}$/.test(who)) return;
                const nm = netFriendName(who) || fmtFriendId(who);
                if(d.event === 'accepted'){
                    const fresh = !_netFrOk[who];
                    _netFrOkMark(who);
                    addFriend(who);                       // mutual bookkeeping (idempotent)
                    if(fresh) _netFrCelebrate(nm + ' - YOU ARE FRIENDS!');   // else the request response already celebrated
                } else if(d.event === 'request'){
                    if(phase === 'friendId' || Date.now() - _netMyIdAt < 60000){
                        // We are (or were seconds ago) presenting our QR: showing it IS
                        // the consent, so the scan confirms the friendship automatically.
                        addFriend(who);
                        _netFrAccept(who);
                        _netFrCelebrate(nm + ' - YOU ARE FRIENDS!');
                    } else _netFrCelebrate(nm + ' ADDED YOU AS A FRIEND');
                } else if(d.event === 'expired'){
                    // The peer's account was TTL-removed and the friendship
                    // cancelled server-side: mirror it locally, no celebration.
                    removeFriend(who); _netFrOkClear(who);
                    _netFr.msg = nm + ' IS NO LONGER AVAILABLE';
                    _netLb.msg = _netFr.msg; _uiDirty = true;
                } else return;
                _netFrRefresh(false);                     // fresh states + names (mutual adds auto-accept there)
                break;
            }
            case 'undelivered': {
                // FAILURE RECEIPT (server-only): our invite/accept to `from` expired in
                // the mailbox uncollected (30s TTL) -- the peer never came to get it. Stop
                // waiting NOW and say so, instead of sitting on "INVITED - WAITING" for the
                // full staleness timeout. The reverse does not hold: no receipt is NOT a
                // delivery confirmation (the contract only promises the expiry, not the pickup).
                if(_netHs.sent === from){ _netHs.sent = null; _netLb.msg = 'PLAYER OFFLINE'; _uiDirty = true; }
                else if(_netHs.accepting === from){ _netHs.accepting = null; _netLb.msg = 'PLAYER LEFT'; _uiDirty = true; }
                break;
            }
            default:
                _netSigLog('< UNKNOWN ' + String(sig.type));   // e.g. a newer client's signal we do not understand yet
        }
    } catch(e){ _netSigLog('< ERR ' + String(sig.type)); }
}

// ---- transition delivery: ship-until-echoed ----
// Every transition (go/req) is ECHO-ACKNOWLEDGED: the receiver answers the packet straight
// back, verbatim plus a:1, FROM ITS RECEIVE HANDLER -- never from the tick loop, so a
// backgrounded tab (rAF frozen, dc.onmessage alive) still answers. Until that echo lands the
// sender keeps the packet in s.tx and re-sends it: fast repeats at 100/200ms cover the common
// single loss, then the liveness pass re-serves ~1/s (_netTxTick) -- interval-driven, so it
// too survives a backgrounded sender. There is at most ONE transition in flight per side
// (boundaries serialize on lvlPending), so a single slot is the whole protocol.
function _netTxShip(s, pkt){
    const now = _wall();
    s.tx = { pkt, since: now, lastAt: now, tries: 1 };
    _netSend(pkt);   // stamps pkt.pts once; every re-send keeps it (a repeat is always in the past)
    const rep = (n)=>{
        if(_netSess !== s || !s.game || !s.tx || s.tx.pkt !== pkt) return;
        s.tx.tries++; s.tx.lastAt = _wall();
        _netDbg.retx = (_netDbg.retx|0) + 1;
        _netSend(pkt);
        if(n < 2 && typeof setTimeout === 'function') setTimeout(()=>rep(n+1), 100);
    };
    if(typeof setTimeout === 'function') setTimeout(()=>rep(1), 100);
}
// One liveness pass over the pending transition: re-send ~1/s, and judge the ONE deadline.
// Only an unanswered 'go' kills -- the peer then never adopted the timeline we are already
// playing on, which IS out of sync, and the fault is attributed to THIS sender's packet. A
// pending 'req' never kills: its echo is normally instant, humans may legitimately sit on a
// match-over screen forever, and a genuinely dead link is the silence detector's verdict.
function _netTxTick(s){
    const tx = s.tx; if(!tx) return false;
    const now = _wall();
    if(tx.pkt.t === 'go' && now - tx.since > RB_PERSIST_KILL_MS){
        _netSigLog('! go unanswered ' + tx.tries + 'x');
        _netSessionEnd('OUT OF SYNC - MATCH ENDED');
        return true;
    }
    if(now - tx.lastAt >= 1000){ tx.lastAt = now; tx.tries++; _netDbg.retx = (_netDbg.retx|0) + 1; _netSend(tx.pkt); }
    return false;
}
// An echo (a:1) came back: clear the pending slot it answers. Keyed on (t, epoch) -- an echo
// of a SUPERSEDED transition (a late 'req' echo after the answering 'go' already cleared the
// slot, or a previous epoch's stray) is ignorable, the pending one has its own retries. But a
// KEY match with different content means the peer acknowledged a packet we never sent: the
// two sides disagree about the transition itself, and playing on would run two different
// timelines -- kill loudly, attributed here, instead of desyncing silently.
function _netTxEcho(s, m){
    const tx = s.tx; if(!tx) return;   // nothing pending: a duplicate echo of an already-cleared slot
    const p = tx.pkt;
    if(m.t !== p.t || (m.epoch|0) !== (p.epoch|0)) return;
    for(const k in p){
        if(k === 'pts') continue;   // transport stamp, not transition content
        if(m[k] !== p[k]){
            _netSigLog('! echo mismatch ' + p.t + '.' + k);
            _netSessionEnd('OUT OF SYNC - MATCH ENDED');
            return;
        }
    }
    s.tx = null;   // acknowledged: the retries stop
}
// The begin moment of an epoch is CLOCK-driven; the one-shot below is only the fast path to it.
// A throttled or backgrounded tab can defer or drop that timer, and a client that never begins
// keeps the new epoch on the session while its tick base stays on the old one -- from then on
// every packet the pair exchanges is epoch-gated, in BOTH directions, and nothing in the stream
// heals it. Arming the begin on the session lets the liveness pass fire it off the shared clock
// the moment startPts is reached, so the boundary lands even when the timer never arrives.
function _netArmBegin(s, atPts, fn){
    s.beginAt = atPts; s.beginFn = fn;
    const wait = Math.max(0, Math.min(5000, atPts - netPts()));
    if(wait <= 0 || typeof setTimeout !== 'function') _netFireBegin(s);
    else setTimeout(()=>{ _netFireBegin(s); }, wait);
}
// Fire an armed begin exactly once, whichever path reaches it first (timer, clock, or peer ask).
function _netFireBegin(s){
    if(!s || _netSess !== s || !s.game || !s.beginFn) return;
    const fn = s.beginFn;
    s.beginFn = null; s.beginAt = null;
    fn();
}
// A tick packet authored on a different base than ours. One boundary's worth of this is NORMAL --
// the two sides begin an epoch up to a lead apart -- so the fault is not the drop but its
// DURATION, and it is timed rather than counted. Pure DETECTOR: the repair is not here. A peer
// still behind our line has not echoed our 'go', so the pending-transition retries are already
// re-serving it (_netTxTick); a peer AHEAD of our line means our own begin is overdue, which
// _netEpochRecover fires off the shared clock below.
function _netEpochSplit(s, peerEp){
    _netDbg.epDrop = (_netDbg.epDrop|0) + 1;
    if(!s.epSplitAt) s.epSplitAt = _wall();
    s.epPeer = peerEp;
}
// Recovery from a persistent split, one pass per liveness tick:
//   1. An overdue begin fires off the shared clock. The usual cause is our own one-shot never
//      arriving, and that repair is entirely local -- no peer cooperation needed.
//   2. Past RB_PERSIST_KILL_MS the match is dead, on the same deadline as an unhealed desync.
//      Two clients on separate timelines IS out of sync; ending silent-and-split is the bug.
//      (The echo-ack ladder normally ends it sooner, attributed to the un-echoed 'go'.)
function _netEpochRecover(s){
    if(!s || !s.game || !inGame || !s.epSplitAt) return false;
    if(s.beginFn && s.beginAt != null){
        const p = netPts();
        if(p != null && p >= s.beginAt){ _netFireBegin(s); return false; }
    }
    if(_wall() - s.epSplitAt > RB_PERSIST_KILL_MS){ _netSessionEnd('OUT OF SYNC - MATCH ENDED'); return true; }
    return false;
}
// The epoch of OUR tick base. In worker-duel mode the base lives in the worker, so fall back to
// the session line -- the same reading the epoch gate takes.
function _netMyEpoch(){ return (typeof _rbEpoch === 'number') ? _rbEpoch|0 : (_netSess ? _netSess.epoch|0 : 0); }
// Server-issued start: both peers call start.php and receive the IDENTICAL
// absolute start PTS (the server owns the clock, so it owns the start point).
// A VERIFIED sync is a precondition, not a nicety: the two sims share one tick
// timeline (start_pts + tick count), so an unsynced clock does not mean "slightly
// off", it means the clients are simulating different games. There is deliberately
// NO unsynced fallback -- refusing to start is the honest outcome.
// Every start is EPOCH-KEYED, which is what makes the answer independent of WHEN each
// peer asks. The epoch counts halts in this connection: 0, then +1 per halt. Both
// peers count identically without anyone being authoritative -- deterministic lockstep
// means they see the same halts at the same ticks -- so they name the same number and
// the second to ask gets the SAME start_pts back, even if it is already in the past.
// That is the point: a late peer learns exactly how late it is instead of starting
// from a wrong origin. A `bye` resets the line, so the next match opens at epoch 0.
// A per-level start (reason 'level') re-anchors the shared clock at every LEVEL boundary the
// same way a rematch does: fresh sync + epoch + start_pts. That resets accumulated clock drift
// each level AND turns the level-up into a negotiated restart instead of a transmitted 'advance'
// input -- so a level boundary can never slip outside the rollback window and split the two sims.
async function _netRequestStart(s, reason){
    // A boundary in an ONGOING match is pure P2P now: the DataChannel is live and the joiner's
    // clock is aligned to the host each boundary, so the host authors the next start PTS locally
    // and ships it on the retried-until-echoed 'go' -- no /api/start.php round trip, no stale
    // epoch-line 409, and it keeps working even with the sign-in server unreachable. The server
    // path below stays for the match-IDENTITY moments (first start, rematch), which register and
    // verify the pair's epoch line.
    if(reason === 'level'){ _netOpenBoundary(s, reason); return; }
    if(!_netOk()){ _netSessionEnd('OFFLINE - CANNOT START'); return; }
    // The contract: a fresh sync ALWAYS precedes a new start PTS. Not "a sync from a
    // minute ago" -- start.php rejects a pts older than ~2s as stale. A rematch (the one
    // mid-match re-anchor still on this server path; a level routes P2P above and a respawn
    // opens its boundary directly) bounds the sweep so the player is not held on the cover;
    // the first start keeps the full-quality sweep (see NET_LEVEL_SYNC_MS).
    await _netTimeSync(true, (reason === 'first' || !reason) ? undefined : NET_LEVEL_SYNC_MS);
    if(_netSess !== s || !s.game) return;
    if(netPts() == null){ _netSessionEnd('NO CLOCK SYNC - CANNOT START'); return; }
    const _t0 = performance.now();
    const r = await _netPostRes('/api/start.php', { id: getPlayerId(), peer: s.peer,
        epoch: s.epoch|0, reason: reason || 'first', pts: netPts() });
    const _rtt = performance.now() - _t0;
    if(_netSess !== s || !s.game) return;
    if(!r.json){
        // 409 = the pair's epoch line is ahead of us. On a FIRST start that does not
        // mean we lost count -- it means the line OUTLIVED our last match: the server
        // keeps it ~5 min and only a bye clears it (signal.php -> Starts::forget), and
        // a fresh session always opens at 0. Ending silently made that permanent: the
        // line stayed stale, so every retry 409'd for the full five minutes, and the
        // peer -- told nothing -- sat on CONNECTION LOST. The bye IS the documented
        // reset, so send it: it clears the line, the next attempt is clean, and the
        // peer learns why instead of guessing.
        if(r.status === 409){
            _netSessionEnd((s.epoch|0) === 0 ? 'STALE MATCH - TRY AGAIN' : 'OUT OF SYNC - MATCH ENDED');
            return;
        }
        if(r.status === 400 && /pts/.test(r.err)){ _netSessionEnd('CLOCK SYNC FAILED - CANNOT START'); return; }
        _netSessionEnd('NO START TIME - CANNOT START'); return;
    }
    const d = r.json;
    if(typeof d.start_pts !== 'number'){ _netSessionEnd('NO START TIME - CANNOT START'); return; }
    // The contract ships `now` for a free clock re-check, and this is the moment it
    // matters most: both clients convert the SAME start_pts through their OWN offset,
    // so any error here lands directly in how far apart they begin. Same min-RTT rule
    // as the clock samples -- only adopt it when this round trip beat our best one,
    // since a slower one carries a worse estimate.
    if(typeof d.now === 'number' && (_netSync.rtt < 0 || _rtt < _netSync.rtt))
        _netSync = { ofs: d.now + _rtt/2 - _wall(), rtt: _rtt, at: Date.now() };
    s.startPts = d.start_pts;   // tick 0 of the shared timeline, for THIS epoch
    // The item-registry match handle plus THIS side's attestation secret. duel-core MACs its
    // ownership digest with the secret once a second, which is what lets the server verify a
    // steal it did not witness (see _wsAttest, items.js). Additive: a server that does not
    // send them leaves the duel unattested, exactly as it ran before the registry.
    if(typeof d.mid === 'string') s.mid = d.mid;
    if(typeof d.secret === 'string') s.secret = d.secret;
    _netClockPush();            // anchor + startPts move TOGETHER: the worker core must see both
    // Ship the shared start, then schedule tick 0. `theta` is the SHARED-clock residual the host's
    // burst settled on (null when it starved or did not burst); the joiner applies its half from
    // the 'bth' we stamp here -- a starved boundary ships NO bth, and both keep the prior clock.
    const shipAndSchedule = (theta) => {
        if(_netSess !== s || !s.game) return;
        // The host ships the 'go' and RETRIES it until echoed. why 'match' is refused by a peer
        // already inGame (a stale first-start must not restart a running match); 'rematch' happens
        // WHILE in game and is not.
        if(s.role === 'host'){
            const g = { t:'go', why:(reason === 'rematch') ? 'rematch' : 'match',
                        seed:s.seed, startPts:s.startPts, epoch:s.epoch|0, lvl:1,
                        hm:s.hearts|0, sk:s.stakes ? 1 : 0 };
            if(theta != null) g.bth = Math.round(theta);
            _netTxShip(s, g);
        }
        // The HOST authors the begin moment; the joiner takes it from the 'go' it receives -- that
        // packet re-anchors the joiner's clock to the shared midpoint (its half of `bth`) BEFORE it
        // begins. A joiner that instead began off its OWN start request would skip that nudge: the
        // go's inGame gate then swallows `bth` and the first-start burst is only half-applied (the
        // host moved its clock, the joiner did not). Deferring to the host packet is exactly how
        // every LEVEL boundary already begins the joiner, so the first start follows that path too.
        if(s.role !== 'host') return;
        // start_pts may already be in the PAST when we asked late (the epoch key is what lets the
        // server answer us with the same moment anyway). Then wait is 0 and we start at once -- the
        // clock-driven tick immediately puts us on the right tick, the fast-forward the contract
        // describes. The begin stays CLOCK-driven, never echo-gated: the retries run past it until
        // the echo lands or the deadline kills. No !inGame guard: a rematch happens WHILE in game.
        _netArmBegin(s, s.startPts, () => {
            s.lvlPending = false;   // this boundary is done: the next OK press may open the level after it
            s.lvl = 1;              // the level line restarts with the match (see _netStartNextLevel)
            beginOnlineDuel(s.seed, true);
        });
    };
    // Every server-authored start -- the FIRST start and a rematch alike -- runs the boundary burst
    // first, so both clocks meet at the shared midpoint before start_pts is read (the joiner applies
    // its half from the `bth` on the start packet). This is the SAME p2p clock sync a level boundary
    // does; the first start is no longer the one path that skipped it and left each client anchored on
    // its own independent server-sync offset -- the widest the clocks ever sit apart, right at level 1
    // where the snakes are closest and a dropped/late input is most likely to force a visible rollback.
    if(s.role === 'host') _netBurstThenStart(s, shipAndSchedule);
    else shipAndSchedule(null);
}
// Host-authored P2P boundary opener: no server. The host runs a bilateral boundary BURST (both
// sides measure the raw peer offset over the burst window), nudges its own clock onto the shared
// midpoint, then picks tick 0 = netPts()+LEAD on that clock and ships it on a retried-until-echoed
// 'go' with the burst residual as 'bth' -- the joiner applies its own half from bth, so the single
// PTS denotes the same real instant on both (a starved burst ships NO bth: both keep the prior
// clock). LEAD covers the go's transit and its fast repeats (the one constant to raise if a future
// TURN path runs longer one-way). Host only: the joiner never reaches here (it asks with 'req',
// bursts when the host's 'bs' datagrams arrive, and waits for the go). `why` names the boundary
// and rides the go so the joiner arms the matching begin (a rebuild -- or the resume's adopt-only
// re-anchor).
function _netOpenBoundary(s, why){
    if(_netSess !== s || !s.game || s.role !== 'host') return;
    if(netPts() == null){ _netSessionEnd('NO CLOCK SYNC - CANNOT START'); s.lvlPending = false; return; }
    // A resume follows an outage, and an outage is exactly when a device's raw clock stands still
    // (a parked page freezes performance.now) -- the raw offset the low-pass remembers may have
    // jumped arbitrarily. Drop the memory: the first post-resume verdict applies unmodified.
    if(why === 'resume') s.bsPrev = null;
    _netBurstThenStart(s, (theta)=>{
        if(_netSess !== s || !s.game){ s.lvlPending = false; return; }
        // A REBUILD boundary (level/respawn) restarts the timeline: tick 0 is a fresh instant just
        // ahead. A RESUME moves ONLY the anchor: pick the startPts that maps OUR CURRENT tick onto
        // the burst-verified clock (tick 0 lands in the past, so nobody rewinds and the armed
        // begin fires at once) -- the peer adopting the same number lands on the same mapping,
        // and the clock steering absorbs the few-tick residual.
        const startPts = (why === 'resume') ? Math.round(netPts() - simTick * TICK_MS)
                                            : netPts() + NET_BURST_LEAD_MS;
        s.startPts = startPts;
        _netClockPush();            // anchor + startPts move together: the core must see both
        const g = { t:'go', why, seed:s.seed, startPts:startPts, epoch:s.epoch|0, lvl:(s.lvl|0) || 1,
                    hm:s.hearts|0, sk:s.stakes ? 1 : 0 };
        if(theta != null) g.bth = Math.round(theta);
        _netTxShip(s, g);
        _netArmBegin(s, startPts, () => {
            s.lvlPending = false;   // this boundary is done: the next OK press may open the level after it
            if(why === 'level') beginOnlineDuelLevel(true, s.lvl);
            else if(why === 'respawn') beginOnlineDuelRespawn(true);
            else if(why === 'resume') resumeOnlineDuel();
        });
    });
}

// ---- in-session messages ----
function _netHandleMsg(txt){
    let m; try{ m = JSON.parse(txt); }catch(e){ return; }
    if(!m || typeof m !== 'object') return;
    // The INBOUND spectator tap: the opponent's packets, forwarded on parsed. Byte-identity
    // downstream costs nothing -- every packet on this wire was produced by JSON.stringify, so
    // re-serializing the parsed object reproduces the original text exactly. A no-op unless
    // someone is actually watching.
    if(typeof _spTapIn === 'function') _spTapIn(m);
    _netHandleParsed(m);
}
// The message body proper, split from the parse above so a SPECTATOR can feed it packets that
// never came off its own DataChannel -- one dispatcher, one set of gates, for a duel peer and a
// spectator alike. srcIdx is the AUTHOR's player index, known only on the spectator path (its
// envelope carries it); a duel peer passes nothing and every derivation below stays as it was.
function _netHandleParsed(m, srcIdx){
    // Boundary clock-burst datagrams: handled BEFORE the pts future-gate below. Their whole point is
    // to measure a clock offset, so a stamp lands in our "future" exactly when there IS an offset --
    // the gate would drop the samples that matter most. They carry only NTP-style stamps and never
    // touch the tick stream or the lag stats. The burst is its own trigger: a 'bs' arriving while we
    // are not collecting and hold no usable theta opens OUR run, so the peer's redundant datagrams --
    // any ONE of the six -- start the reply, with no separate one-shot trigger packet to lose. Open
    // BEFORE folding, so the run's fresh-sample reset does not wipe this very datagram.
    if(m.t === 'bs'){
        const s = _netSess;
        if(s && s.game && !s.bsRunning && !_netBurstTheta(s)) _netBurstRun(s);
        _netBurstRecv(s, m);
        return;
    }
    // A transition echo (a:1): route it to the pending slot and stop -- an echoed 'go' must never
    // run the go handler. Handled BEFORE the pts gate: an echo carries the ORIGINAL packet's stamp
    // back verbatim (that is what "verbatim" buys: bit-identical comparison), so its pts is a round
    // trip stale by construction and must feed neither the future-gate nor the one-way lag stats.
    if(m.a === 1){
        if(_netSess) _netTxEcho(_netSess, m);
        return;
    }
    // The stamp is CHECKED, not just logged. A peer cannot have sent from our
    // future; a packet claiming otherwise is bogus and is dropped. The tolerance
    // matters: unlike the server -- which IS the clock and can be zero-tolerance --
    // we compare against our ESTIMATE of it, so a strict test would discard honest
    // packets. Discards are visible, never silent.
    if(typeof m.pts === 'number' && Number.isFinite(m.pts)){   // NaN/Infinity would slip the future-gate below and poison the lag stats
        const mine = netPts();
        if(mine != null){
            // MEASURE FIRST, judge second. The samples worth seeing most are exactly the
            // ones the gate throws away: a delta far enough negative to be rejected IS
            // the broken anchor. Gating before recording made the average survivorship-
            // biased -- the statistic meant to reveal that failure quietly excluded its
            // own evidence and kept reading healthy. The packet is still dropped below;
            // it just no longer vanishes from the diagnostics on its way out.
            // The PTS delta: how far in OUR past the peer says this packet was sent.
            // It is a one-way transit estimate, but it is NOT the same number as the
            // latency we report to the server -- that one is half a measured round
            // trip to the SERVER. This is the real one-way peer path, and it carries
            // both clients' clock-offset error with it. Worth watching separately:
            // if the average drifts away from ~half the peer RTT, the anchors are off.
            // Stamped RAW (never tick-quantized): pts and tick have a fixed relation on both
            // clients, so the sub-tick part is exactly the signal -- rounding it to the tick would
            // hide the send/receive jitter this readout exists to expose.
            _netDbg.lag = mine - m.pts;
            _netLagN.push(_netDbg.lag);
            if(_netLagN.length > 64) _netLagN.shift();
            let _s = 0, _mn = Infinity, _mx = -Infinity;
            for(const v of _netLagN){ _s += v; if(v < _mn) _mn = v; if(v > _mx) _mx = v; }
            _netDbg.lagAvg = _s / _netLagN.length;
            _netDbg.lagMin = _mn; _netDbg.lagMax = _mx; _netDbg.lagN = _netLagN.length;
            // NOW judge. A peer cannot have sent from our future, so this packet is
            // bogus and is not applied. The tolerance matters: unlike the server --
            // which IS the clock and can be zero-tolerance -- we compare against our
            // ESTIMATE of it, so a strict test would discard honest packets.
            if(m.pts - mine > NET_PTS_TOL){
                _rbRefused();
                _netSigLog('! future pts +' + Math.round(m.pts - mine) + 'ms');
                return;
            }
        }
    }
    // Epoch gate for the tick-stream packets. simTick and the rollback tick-base reset at
    // every level boundary, so an 'in'/'h'/'st'/'rs' authored before the boundary carries
    // ticks from the previous epoch's timeline. Mapped onto the post-reset base they land far
    // in the "future" and _netPeerInput refuses them -- harmless now (a refusal never warns),
    // but still pure noise on every level transition. Drop a stale-epoch
    // tick packet silently here; go/req carry and check their own epoch already.
    // Compared against _rbEpoch (the epoch of OUR tick base), not s.epoch: between a halt and
    // the scheduled start the session line is already bumped while the sim still ticks the old
    // timeline, and a packet from that window is only usable by a peer still on the SAME base.
    // Every peer that passes the version gate stamps ep on these four types, so absence
    // is not special-cased: a missing ep reads as epoch 0 and gates like any other.
    if(_netSess && (m.t === 'in' || m.t === 'h' || m.t === 'st' || m.t === 'rs')){
        // A peer stamping an epoch other than our base announces the split on every packet it
        // sends. Recover off that, not off the player pressing something.
        if((m.ep|0) !== _netMyEpoch()){ _netEpochSplit(_netSess, m.ep|0); return; }
        _netSess.epSplitAt = 0;   // a packet on our own base: the two tick streams are shared again
    }
    switch(m.t){
        case 'go': {   // the ONE timeline opener: match / rematch / level / respawn / resume, host-authored
            const s = _netSess;
            if(!s || s.role === 'host' || !s.game) break;
            // ECHO FIRST, unconditionally, from this receive handler -- a delivery ack, not
            // agreement. Duplicates (the sender's retries) re-echo too: dedup applies to the
            // EFFECT below, never to the answer, or a lost first echo would strand the sender
            // retrying a transition we already run. Refusals echo as well -- each refused case
            // is one the sender can already live with (a stale 'match' against a running game
            // dies of its own dedup on the sender; a validation failure ends the session loudly).
            // a:1 leads so the copied fields keep their order -- the original pts stays last,
            // where _netSend stamped it (the echo keeps it: it declares the ORIGINAL send moment).
            _netSend(Object.assign({ a:1 }, m));
            if(s.tx && s.tx.pkt.t === 'req'){ s.tx = null; }   // the go IS the answer to our pending ask: stop its retries
            const ep = (typeof m.epoch === 'number') ? m.epoch|0 : (s.epoch|0);
            if(s.ctlEpoch === ep) break;   // a retry of a boundary already applied: the re-echo above was all it needed
            if(m.why === 'match' && inGame) break;   // a stale first-start must not restart a running match
            // No shared clock, no match: starting on different timelines is exactly
            // the desync this architecture exists to make impossible. Validate BEFORE
            // consuming the epoch, so a malformed copy does not block a good repeat.
            if(typeof m.startPts !== 'number' || netPts() == null){ _netSessionEnd('NO CLOCK SYNC - CANNOT START'); break; }
            // The heart cap rides EVERY go and is adopted verbatim: one number, host-authored,
            // so both sims open on the same cap however each side got here. Where a preset
            // exists (a tournament roles sheet said 2), a go that disagrees is a protocol
            // fault rather than a difference to absorb -- the bracket would otherwise score a
            // match the two clients did not play under the same rules. The echo verifier
            // makes the agreement byte-exact for free (hm is just another copied field).
            const hm = _duelHearts(m.hm);
            if(s.heartsWant != null && hm !== s.heartsWant){ _netSessionEnd('MATCH SETUP MISMATCH'); break; }
            s.hearts = hm;
            // Item stakes ride the same packet for the same reason, and the reason is sharper:
            // a wrong cap is at least visible on both HUDs, while a stakes disagreement is
            // silent and one-sided for the whole match. The believing side attests and claims
            // every gain; the other never attests, so it ships no tag to corroborate them and
            // the registry holds each one as unwitnessed. Anything a session picked up before
            // this packet is a local guess -- the go is where the two agree. Absent reads as
            // OFF: an unstated stake is one nobody agreed to play for.
            // A SPECTATOR pins it off whatever the players agreed: it holds neither wardrobe
            // and has no match secret to attest with (net-spec.js mints its session that way).
            const sk = !netSpectating() && !!m.sk;
            if(s.stakesWant != null && sk !== s.stakesWant){ _netSessionEnd('MATCH SETUP MISMATCH'); break; }
            s.stakes = sk;
            s.ctlEpoch = ep;
            s.seed = (m.seed>>>0) || s.seed;
            // A SPECTATOR pushes every boundary's origin its own bias into the future, so its sim
            // opens late by exactly the amount it runs behind (net-spec.js). Same one number, one
            // addition: the whole "spectators are delayed" behaviour is this line plus the matching
            // delay on the very first boot. A player's bias is 0 and this is the old assignment.
            const gPts = m.startPts + netSpecBias();
            s.startPts = gPts;         // the epoch tick 0 is measured from: every boundary moves it
            s.epoch = ep;              // stay on the pair's epoch line
            if(m.why === 'level') _lvlCover = true;
            // Nudge OUR clock half of the way onto the shared MIDPOINT BEFORE we read startPts, so
            // the single number lands on the same real instant here as on the host. `bth` is the
            // SHARED-clock residual the host's boundary burst settled on (its low-passed raw
            // offset plus both sides' clock corrections); the host already applied -bth/2, we
            // apply +bth/2, so neither takes the whole jump. A rebuild resets the sim to tick 0,
            // so the clock step is invisible; a resume only shifts the tick target slightly and
            // the clock steering absorbs it. An ABSENT bth is the host's on-wire confession of a
            // starved burst: log the failure and keep the prior in-play clock, itself
            // burst-verified at the previous boundary (bth 0 is an ordinary zero residual).
            // ...and a spectator applies NONE of it: bth is the residual of a burst measured
            // between the two PLAYERS, and half of it is the host's half of a jump only those two
            // agreed to take. Nudging a third party's clock by it would drag it off the shared
            // timeline every boundary, in a direction that has nothing to do with its own offset.
            if(netSpectating()){ /* not our burst, not our correction */ }
            else if(m.bth == null) _netSigLog('! BURST SYNC FAILED (host starved) -> prior clock');
            else _netBurstApply(s, m.bth);
            // This boundary's burst is spent: forget its samples, so the NEXT boundary's arriving
            // 'bs' finds no usable theta and re-opens our run. Kept samples here would block that
            // trigger and starve the host's next burst.
            _netBurstReset(s);
            // m.lvl carries the target level NUMBER (host-authored, >= 2 on a level go); it is the
            // one rebuild input, so both sims build the identical (seed, level) board however
            // their private counters drifted. `why` picks the rebuild; the begin stays CLOCK-
            // driven (armed here, fired at startPts), never gated on our echo landing.
            _netArmBegin(s, gPts, () => {
                if(m.why === 'level') beginOnlineDuelLevel(false, m.lvl);
                else if(m.why === 'respawn') beginOnlineDuelRespawn(false);
                else if(m.why === 'resume') resumeOnlineDuel();
                else beginOnlineDuel(s.seed, false);   // match | rematch
            });
            break;
        }
        case 'req': {   // the ONE intent ask: a peer wants a boundary opened (level / rematch / resume)
            const s = _netSess;
            if(!s || !s.game) break;
            // Echo first, from the receive handler, unconditionally -- the ask is acknowledged
            // even when the effect below refuses or dedups it (see the go handler's rationale).
            _netSend(Object.assign({ a:1 }, m));
            if(m.why === 'level'){   // joiner asks P0 to open the next level; the epoch pins it to the boundary
                if(s.role !== 'host') break;
                if(typeof m.epoch !== 'number' || (m.epoch|0) === (s.epoch|0)) _netStartNextLevel(s);
                // Behind our line: a joiner that missed the boundary we already opened. No action --
                // that go is still pending in OUR tx slot and its retries are already re-serving it.
            } else if(m.why === 'again'){   // match over, peer pressed PLAY AGAIN (either role sends it)
                s.peerAgain = true; _netMaybeRestart(); _uiDirty = true;
            } else if(m.why === 'resume'){   // the resync SENDER settled as the joiner (it healed the host): ask for the clock re-anchor
                if(s.role !== 'host') break;
                if(typeof m.epoch !== 'number' || (m.epoch|0) === (s.epoch|0)) _netRecoveryStart(s);
                // Behind our line: a boundary is already open; its pending go re-serves the re-anchor.
            }
            break;
        }
        case 'in': _netDbg.hbRx++;   // both ends apply the other's input
            if(_netSess){ if(_netWD()) _wDuelSend({ t:'peerPkt', m, p:srcIdx }); else _netPeerInput(m, srcIdx); }
            break;
        case 'h':    // divergence check / state recovery / full resync: the core's
        case 'st':   // packets -- routed to wherever the core runs (worker or in-process)
        case 'rs':
            if(_netSess && inGame){
                if(_netWD()) _wDuelSend({ t:'peerPkt', m });
                else if(m.t === 'h') _rbCheckHash(m);
                else if(m.t === 'st') _rbCheckState(m);
                else _rbApplyResync(m);
            }
            break;
        case 'bye': _netSessionEnd('OPPONENT LEFT'); break;
        case 'pi': _netDbg.hbRx++; break;   // liveness ping: receiving it already refreshed lastRecv
    }
}
// The in-game warning, or null. Both causes mean the same thing to a player: what
// the other side is doing is not reaching us.
function netDuelWarn(){
    const s = _netSess;
    if(!s || !s.game || !inGame) return null;
    if(s.reconnecting) return 'RECONNECTING...';
    // Spectating has its own two-line vocabulary, and neither of the duel's warnings applies:
    // there is no opponent whose silence could be OUR connection fault, and a disagreement with
    // the feed is not the two players being OUT OF SYNC. The banner is persistent and lowest
    // priority by design -- it tells a watcher what screen they are looking at, so it renders
    // through the existing _drawDuelWarn with no new draw code at all.
    if(netSpectating()){
        const d = netSpecDbg();
        if(!d.rx || (netSpecFeedAge() > RB_WARN_MS)) return 'RE-SYNCING...';
        return 'SPECTATING';
    }
    // CONNECTION LOST is a pure SILENCE detector: nothing on the wire for ~2 heartbeats
    // (RB_WARN_MS). Every inbound datagram -- the minimal 'pi' liveness ping included --
    // refreshes lastRecvWall before dispatch, so a link still carrying ANYTHING never
    // flashes; a refused input is not a fault (it still arrived). Relay arrivals ride
    // jittered HTTP round trips, so relay warns at DOUBLE the p2p bar. DEPRECATED(relay)
    if(Date.now() - s.lastRecvWall > (s.relay ? RB_WARN_MS * 2 : RB_WARN_MS) && !(s.relay && performance.now() < s.relayGraceUntil)) return 'CONNECTION LOST';
    // OUT OF SYNC is the OTHER fault: the link is fine, the worlds diverged (a hash
    // disagreed). duel-core fires one targeted repair per verdict; this banner is its live
    // status. It clears the instant a hash agrees again (_rbBadSince -> 0); unhealed past
    // the same 2s deadline as silence, the liveness timer ends the match. The age is
    // clamped to >= 1: a verdict landing in the same Date.now() millisecond as this check
    // would otherwise read as age 0 = healthy and hide the banner for that instant.
    const dsyFor = _netWD() ? (_netDbg.dsyFor|0) : (_rbBadSince ? Math.max(1, Date.now() - _rbBadSince) : 0);
    if(dsyFor > 0) return 'OUT OF SYNC';
    return null;
}
// Which snake is ours. The offerer is P0 and the answerer P1 -- an index, not a
// rank: neither client can touch the other's snake, and there is no authority.
function netMyIndex(){ return (_netSess && _netSess.role === 'host') ? 0 : 1; }
// The pair's current epoch line (halts so far this connection); _rbReset captures it as the
// epoch of the tick base it is starting (see _rbEpoch).
function netEpoch(){ return _netSess ? _netSess.epoch|0 : 0; }
// The tick the SHARED CLOCK says we should be on, or null when there is no match
// to pace (local play keeps its frame-time accumulator untouched).
//
// Pacing an online duel from local frame time was a slow poison: both clients start
// at tick 0 together and then NOTHING re-aligns them. A dropped frame, a 59.94Hz
// panel, a GC pause -- each one slides a client permanently off the other, and the
// error only accumulates. The peer's input then looks later and later, so
// corrections grow the longer a match runs and eventually fall outside the rewind
// window entirely. The clock is the one thing both clients already agree on, so it
// -- not our frame timer -- decides which tick we are on. Drift stops being small
// and starts being impossible.
function netTickTarget(){
    const s = _netSess;
    if(!s || !s.game || !inGame || !s.startPts) return null;
    const p = netPts();
    if(p == null) return null;
    const t = Math.floor((p - s.startPts) / TICK_MS);
    // A target wildly away from our tick means the ORIGIN is wrong (startPts), not that
    // we mis-ticked -- the clock cannot really be a minute out. Steering toward it would
    // just chase a bad number, so report it and steer nowhere; the accumulator keeps the
    // game running at 60Hz either way, and the next start re-bases the origin.
    if(Math.abs(t - simTick) > 600){
        // A PENDING BEGIN means we have already adopted the next origin and are waiting for
        // the clock to reach it: the old tick count measured against the new origin is
        // meaningless BY DESIGN, not a bad number, so it earns no line in the overlay. A
        // spectator waits its whole bias here, at every boundary.
        if(!s.beginFn) _netSigLog('! tick target ' + (t - simTick) + 't off: bad start origin');
        return null;
    }
    return t;
}
// The CONTINUOUS tick position on the shared clock (netTickTarget without the floor),
// for the phase seed at duel start and the one-shot displacement snap: both clients
// fire each tick at the MIDDLE of its wall-time window, so neither is the early one.
// Same bad-origin guard as the integer target.
function netTickTargetF(){
    const s = _netSess;
    if(!s || !s.game || !inGame || !s.startPts) return null;
    const p = netPts();
    if(p == null) return null;
    const ft = (p - s.startPts) / TICK_MS;
    return Math.abs(ft - simTick) > 600 ? null : ft;
}
// ---- role queries + the two game-loop hooks (called from game.js / input.js) ----
function netGameActive(){ return !!(_netSess && _netSess.game); }
// NOT authority -- purely "which snake is mine". Both clients run the same sim.
function netHosting(){ return !!(_netSess && _netSess.game && _netSess.role === 'host'); }
function netWaitingAgain(){ return !!(_netSess && _netSess.game && _netSess.myAgain); }
// PLAY AGAIN online: both sides must agree; each press ships its own req{why:'again'}
// (retried until echoed), and the restart then rides a go{why:'rematch'} carrying a
// fresh seed and a new start_pts; both sides adopt the new epoch.
function netAgain(){
    const s = _netSess; if(!s || !s.game) return;
    s.myAgain = true; _netTxShip(s, { t:'req', why:'again', epoch:(s.epoch|0) }); _netMaybeRestart(); _uiDirty = true;
}
function _netMaybeRestart(){
    const s = _netSess;
    if(!s || !s.game || !s.myAgain || !s.peerAgain) return;
    s.myAgain = s.peerAgain = false;
    if(s.role !== 'host') return;   // P0 draws the seed: setup, not authority
    s.seed = (Math.random()*0x100000000)>>>0;
    if(!_netOk()){ _netSessionEnd('NO SERVER - CANNOT RESTART'); return; }
    // A rematch is a HALT: it advances the epoch on both peers. They count it
    // independently and arrive at the same number, which is what lets the server hand
    // whichever asks second the identical start_pts.
    s.epoch = (s.epoch|0) + 1;
    // A fresh sync always precedes a new start PTS (start.php rejects a pts older than
    // ~2s as stale), and _netRequestStart owns that whole sequence -- sync, epoch,
    // reason, the 409/400 handling and the re-check. Reuse it rather than re-implement
    // a second, subtly different start path here.
    _netRequestStart(s, 'rematch');
}
// Advance to the next duel level online. EITHER player's OK press triggers it; the level
// boundary re-negotiates a shared start_pts (like a rematch, but score/lives carry over and
// the host authors the target level on the go). Only P0 opens a boundary, so a joiner press
// asks the host with req{why:'level'}; P0 owns the epoch bump + the go.
function netRequestNextLevel(){
    const s = _netSess; if(!s || !s.game || !inGame) return;
    _lvlCover = true;
    if(s.role === 'host') _netStartNextLevel(s);
    else _netTxShip(s, { t:'req', why:'level', epoch:(s.epoch|0) });   // epoch pins the ask to THIS boundary; retried until echoed (or superseded by the go itself)
}
// A duel death crossed DEATH_DUR (the sim emitted duelHalt and now holds in 'dying', see
// _duelNetHold in sim.js): the respawn is a negotiated boundary like a level-up, so the pair
// re-anchors on a fresh burst + start_pts instead of each sim rebuilding on its own clock.
// Both sims cross deterministically, so BOTH clients call this; only the host opens the
// boundary (go {why:'respawn'}), the joiner's sim simply keeps holding until that go begins
// it. Duplicate halts (a rollback replay re-crossing the death) fold into the one-boundary
// guard in _netStartRespawn.
function netDuelHalt(){
    const s = _netSess; if(!s || !s.game || !inGame) return;
    if(s.role === 'host') _netStartRespawn(s);
}
function _netStartRespawn(s){
    if(!s || !s.game || s.role !== 'host' || s.lvlPending) return;   // one start per boundary (duplicate halts land here)
    s.lvlPending = true;
    s.epoch = (s.epoch|0) + 1;   // a respawn is a HALT like any other: the epoch advances
    // No _lvlCover: the held 'dying' frame is the natural cover while the boundary negotiates.
    // s.lvl stays -- the go re-ships the CURRENT level; the respawn rebuild ignores it anyway.
    _netOpenBoundary(s, 'respawn');
}
// A FULL resync burst settled (duel-core _rbRecovered -> here; armed only by a reconnect or a
// peer detected a whole ring behind, never by the routine single-rs desync repair). The burst
// healed the peer's STATE -- but the pair is still ticking on the anchor from before the
// outage, carrying whatever clock drift the outage accumulated (a throttled background tab, a
// reconnect over a different network path). Open a RESUME boundary: burst-verify the clocks
// and move ONLY the anchor + epoch. No rebuild, no tick reset -- the sims never stopped, so
// what they hold IS the state and stays. No state hash rides the resume go either: the 1Hz
// comparator confirms the healed state within a second anyway, and a wrong verdict there
// already has its own repair ladder. The resync SENDER is the settled side and can be EITHER
// role (send authority is who-is-ahead); only the host authors boundaries, so a joiner settle
// asks with req{why:'resume'} instead.
function _netResyncSettled(){
    const s = _netSess; if(!s || !s.game || !inGame) return;
    if(s.tx) return;   // a transition already in flight is itself a (re-)anchoring boundary: let it land
    // No clock verdict, nothing to re-anchor onto. Unlike a rebuild boundary -- which MUST have a
    // shared timeline or the match cannot continue -- a skipped resume is safe: the pair keeps
    // playing on the old anchor and the repair ladder carries on. Recovery is never lethal.
    if(netPts() == null) return;
    if(s.role === 'host') _netRecoveryStart(s);
    else _netTxShip(s, { t:'req', why:'resume', epoch:(s.epoch|0) });
}
function _netRecoveryStart(s){
    if(!s || !s.game || s.role !== 'host' || s.lvlPending || s.tx) return;   // one boundary at a time
    if(netPts() == null) return;   // a clockless window refuses the resume instead of killing the match (see _netResyncSettled)
    s.lvlPending = true;
    s.epoch = (s.epoch|0) + 1;   // a recovery is a HALT like any other: the epoch advances
    _netOpenBoundary(s, 'resume');
}
function _netStartNextLevel(s){
    if(!s || !s.game || s.role !== 'host' || s.lvlPending) return;   // one start per boundary
    _lvlCover = true;   // host may arrive here from a joiner req{why:'level'} (no local press): cover its board too
    s.lvlPending = true;
    s.epoch = (s.epoch|0) + 1;   // a level boundary is a HALT: the epoch advances, exactly like a rematch
    // The host owns the target level exactly like the epoch: authored HERE, shipped on the
    // go, adopted by BOTH sims. The board is a pure function of (seed, level), so a level
    // number that lived as a private per-client counter turned any miscounted begin into two
    // DIFFERENT boards from one boundary. Clamp mirrors the sim's own endless-duel rule:
    // past MAX_LEVELS every level re-runs the hardest board.
    s.lvl = Math.min(((s.lvl|0) || 1) + 1, MAX_LEVELS);
    _netRequestStart(s, 'level');
}
// Local leave (quit dialog YES / duelOver NO): tell the peer, tear down silently.
function netEndSession(){
    // The ONE universal abort. Safe to call in any state -- it withdraws a pending
    // sent invite, dismisses a received invite dialog, stops matchmaking, and tears
    // down a session whether it is still negotiating, relay-initialising, or a
    // running game. Every exit path (lobby leave/enter, quit, duel exit) uses it.
    _netSeekStop();
    if(_netHs.sent) _netSignal(_netHs.sent, 'bye', '');            // withdraw a pending invite
    if(_netHs.accepting) _netSignal(_netHs.accepting, 'bye', '');   // we accepted but bail out
    _netHsClear();
    _netLb.invite = null;
    const s = _netSess;
    if(s){ try{ _netSend({ t:'bye' }); }catch(e){} _netSignal(s.peer, 'bye', ''); }
    _netTeardown();
}
// Remote/failed end: back to the 1:1 menu with a message (never a crash, never a freeze).
// remoteBye = the peer already told us it is gone, so saying it back is noise.
// Every OTHER ending must say goodbye: not just courtesy, it is what clears the
// pair's epoch line server-side (signal.php -> Starts::forget). Dying silently left
// that line stale for ~5 minutes, so the pair's NEXT match opened at epoch 0 against
// a server that had moved on and 409'd -- a match that could not be started again
// until the line aged out.
function _netSessionEnd(msg, remoteBye){
    const s = _netSess; if(!s) return;
    const wasGame = s.game;
    if(!remoteBye && s.peer) _netSignal(s.peer, 'bye', '');
    // Clear the handshake too (as netEndSession/_netUnload do): a mid-game reconnect
    // leaves _netHs.offerTo latched, and without this the now-out-of-game _netHsTick
    // would resume re-sending stale offers to the departed peer + show 'NO RESPONSE'.
    _netHsClear();
    _netTeardown();
    if(wasGame && inGame){   // only while the online duel is actually still on screen
        inGame = false; _wsend({ t:'phase', phase:'menu' });
        phase = (typeof tourneyExitPhase === 'function' && tourneyExitPhase()) || 'duel11';
        showHUD(false); Snd.musicStop();
        _duelMsg = msg; _duelMsgAt = _msgNow();
        Snd.sfxPlay('fail', cfg.music); _uiDirty = true;
    } else if(phase === 'lobby'){ _netLb.msg = msg; _uiDirty = true; }
}
function _netTeardown(){
    if(typeof _wDuelEnd === 'function') _wDuelEnd();   // worker-hosted core: deactivate + reset there too
    const s = _netSess; _netSess = null;   // nulling this stops the relay loop + liveness (both check _netSess === s)
    // AFTER _netSess is nulled: netEpoch() then reads 0, the line a fresh pair opens on.
    // Resetting while the session is still visible would keep its final epoch in the
    // mirror, and the next match's packets would be epoch-gated from tick one.
    _rbReset();
    if(!s) return;
    if(s.peer) delete _netPeerNet[s.peer];   // the IP hint was for THIS match's path; a new match (or a network switch) gets a fresh one
    s.game = false; s.relay = false;
    if(s.connT) clearTimeout(s.connT);
    if(s.liveT) clearInterval(s.liveT);
    if(s.warmT) clearInterval(s.warmT);
    if(s.relayAbort){ try{ s.relayAbort.abort(); }catch(e){} s.relayAbort = null; }   // DEPRECATED(relay): close the held relay socket now
    try{ if(s.dc){ s.dc.onopen=s.dc.onmessage=s.dc.onclose=null; s.dc.close(); } }catch(e){}
    try{ if(s.pc){ s.pc.onconnectionstatechange=s.pc.onicecandidate=s.pc.ondatachannel=null; s.pc.close(); } }catch(e){}
    s.dc = null; s.pc = null; s.rdOk = false; s.iceQ = [];   // a deferred ICE-holdback timer then sees s.pc !== its captured pc and skips
}

