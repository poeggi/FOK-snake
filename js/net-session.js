// ============================================================================
// net-session.js -- ONLINE 1:1 session lifecycle: lobby + handshake state,
// invites, quick match, the signal dispatcher, server-issued starts, in-duel
// message handling and teardown. NETCODE (deterministic rollback): both
// clients run the deterministic sim locally from the shared seed; own input
// applies instantly (local feel on BOTH ends) and travels tick-stamped to the
// peer. There is no host and no authority -- only inputs cross the wire. A
// late peer input rewinds the sim and re-simulates locally (a sim tick is
// sub-microsecond, so replay is free). Server = matchmaking + signaling only.
// Loads LAST of the net files. Offline-first contract: see net-api.js.
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
        if(!/^[0-9a-f]{8}$/.test(from) && sig.type !== 'friend' && sig.type !== 'peer-net') return;   // server-generated: sender is in the payload
        const pl = String(sig.payload||'');
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
                if(phase === 'duelMenu' || phase === 'friends' || phase === 'friendId'){ netLobbyEnter(); phase = 'lobby'; }
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

// Ship a start (sched/rst) AND keep it. The joiner's epoch has exactly ONE writer -- the 'rst'
// handler below -- so a start that never lands is not a delayed boundary but a permanent split:
// both sides then refuse each other's tick packets on epoch, and nothing in the stream heals it.
function _netShipStart(s, pkt){ s.lastStart = pkt; s.lastStartAt = _wall(); _netSend(pkt); }
// Re-serve that start to a joiner still on an older epoch. Idempotent: the receiver dedups by
// ctlEpoch, and the ORIGINAL startPts is what lands it on our timeline instead of a private one.
function _netReshipStart(s, peerEp){
    if(!s || !s.game || s.role !== 'host' || !s.lastStart) return;   // only P0 authors a start
    if((peerEp|0) >= (s.epoch|0)) return;
    const now = _wall();
    // A boundary is legitimately one-sided while it is in flight, so "behind" only means "lost"
    // once our ship and its repeats (0/100/200ms) are well past.
    if(now - (s.lastStartAt || 0) < 1000) return;
    if(now - (s.reshipAt || 0) < 1000) return;         // the trigger is the peer's 60/s stream: one re-serve per second
    s.reshipAt = now;
    _netDbg.reship = (_netDbg.reship|0) + 1;
    _netSigLog('! peer an epoch behind (' + (peerEp|0) + ' < ' + (s.epoch|0) + '): re-sending the start');
    _netSend(s.lastStart);
}
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
    // A level boundary in an ONGOING match is pure P2P now: the DataChannel is live and the
    // joiner's clock is aligned to the host each level, so the host authors the next start PTS
    // locally and ships it on the reliable 'rst' -- no /api/start.php round trip, no stale
    // epoch-line 409, and it keeps working even with the sign-in server unreachable. The server
    // path below stays for the match-IDENTITY moments (first start, rematch), which register and
    // verify the pair's epoch line.
    if(reason === 'level'){ _netStartLevelP2P(s); return; }
    if(!_netOk()){ _netSessionEnd('OFFLINE - CANNOT START'); return; }
    // The contract: a fresh sync ALWAYS precedes a new start PTS. Not "a sync from a
    // minute ago" -- start.php rejects a pts older than ~2s as stale. A mid-match re-anchor
    // (level-up / rematch / respawn) bounds the sweep so the player is not held on the cover;
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
    _netClockPush();            // anchor + startPts move TOGETHER: the worker core must see both
    // Ship the shared start, then schedule tick 0. `theta` is the burst-agreed peer offset the host
    // measured (0 when it did not burst); the joiner applies its half from the 'bth' we stamp here.
    const shipAndSchedule = (theta) => {
        if(_netSess !== s || !s.game) return;
        // 'sched' is the FIRST start and is refused while inGame (a stale one must not restart a
        // running match). Every later start -- rematch, respawn -- happens WHILE in game, so it must
        // ride 'rst' or the peer silently ignores it and only one client restarts.
        if(s.role === 'host') _netShipStart(s, { t: (reason === 'first' || !reason) ? 'sched' : 'rst',
                                         seed:s.seed, startPts:s.startPts, x10:s.x10, epoch:s.epoch|0,
                                         lvl:0, bth:Math.round(theta || 0) });
        // The HOST authors the begin moment; the joiner takes it from the sched/rst it receives --
        // that packet re-anchors the joiner's clock to the shared midpoint (its half of `bth`) BEFORE
        // it begins. A joiner that instead began off its OWN start request would skip that nudge: the
        // sched's inGame gate then swallows `bth` and the first-start burst is only half-applied (the
        // host moved its clock, the joiner did not). Deferring to the host packet is exactly how every
        // LEVEL boundary already begins the joiner, so the first start now follows that one path too.
        if(s.role !== 'host') return;
        // start_pts may already be in the PAST when we asked late (the epoch key is what lets the
        // server answer us with the same moment anyway). Then wait is 0 and we start at once -- the
        // clock-driven tick immediately puts us on the right tick, the fast-forward the contract
        // describes. No !inGame guard: a rematch happens WHILE in game.
        const go = () => {
            if(_netSess !== s || !s.game) return;
            s.lvlPending = false;   // this boundary is done: the next OK press may open the level after it
            beginOnlineDuel(s.seed, true);
            _netSend({ t:'start' });
        };
        const wait = Math.max(0, Math.min(5000, s.startPts - netPts()));
        if(wait <= 0 || typeof setTimeout !== 'function') go(); else setTimeout(go, wait);
    };
    // Every server-authored start -- the FIRST start and a rematch alike -- runs the boundary burst
    // first, so both clocks meet at the shared midpoint before start_pts is read (the joiner applies
    // its half from the `bth` on the start packet). This is the SAME p2p clock sync a level boundary
    // does; the first start is no longer the one path that skipped it and left each client anchored on
    // its own independent server-sync offset -- the widest the clocks ever sit apart, right at level 1
    // where the snakes are closest and a dropped/late input is most likely to force a visible rollback.
    if(s.role === 'host') _netBurstThenStart(s, shipAndSchedule);
    else shipAndSchedule(0);
}
// Host-authored P2P level start: no server. The host runs a bilateral boundary BURST (both sides
// measure the peer offset over ~150ms), nudges its own clock onto the shared midpoint, then picks
// tick 0 = netPts()+LEAD on that clock and ships it reliably on 'rst' with the agreed offset as
// 'bth' -- the joiner applies its own half from bth, so the single PTS denotes the same real
// instant on both. LEAD covers the rst's transit and its reliable repeats. Host only: the joiner
// never reaches here (it nudges with 'reqlvl', bursts on 'bsync', and waits for the rst).
function _netStartLevelP2P(s){
    if(_netSess !== s || !s.game || s.role !== 'host') return;
    if(netPts() == null){ _netSessionEnd('NO CLOCK SYNC - CANNOT START'); s.lvlPending = false; return; }
    _netBurstThenStart(s, (theta)=>{
        if(_netSess !== s || !s.game){ s.lvlPending = false; return; }
        const startPts = netPts() + NET_BURST_LEAD_MS;   // tick 0 of the new epoch, on the host's now-midpoint clock
        s.startPts = startPts;
        _netClockPush();            // anchor + startPts move together: the core must see both
        _netShipStart(s, { t:'rst', seed:s.seed, startPts:startPts, x10:s.x10, epoch:s.epoch|0, lvl:1, bth:Math.round(theta) });
        const go = () => {
            if(_netSess !== s || !s.game) return;
            s.lvlPending = false;   // this boundary is done: the next OK press may open the level after it
            beginOnlineDuelLevel(true);
        };
        const wait = Math.max(0, Math.min(5000, startPts - netPts()));
        if(wait <= 0 || typeof setTimeout !== 'function') go(); else setTimeout(go, wait);
    });
}

// ---- in-session messages ----
function _netHandleMsg(txt){
    let m; try{ m = JSON.parse(txt); }catch(e){ return; }
    if(!m || typeof m !== 'object') return;
    // Boundary clock-burst datagrams: handled BEFORE the pts future-gate below. Their whole point is
    // to measure a clock offset, so a stamp lands in our "future" exactly when there IS an offset --
    // the gate would drop the samples that matter most. They carry only NTP-style stamps and never
    // touch the tick stream or the lag stats. 'bsync' is the host's trigger to open OUR burst so both
    // sides measure over the same window; 'bs' is one measured datagram.
    if(m.t === 'bsync'){
        // The trigger is repeated (reliable control) and retried, so one attempt arrives many times.
        // (epoch,n) keys it: a late repeat must not open a second run and wipe the samples the host
        // is still collecting on.
        if(_netSess && _netSess.role !== 'host'){
            const id = (m.epoch|0) + ':' + (m.n|0);
            if(_netSess.bsSyncId !== id){ _netSess.bsSyncId = id; _netBurstRun(_netSess); }
        }
        return;
    }
    if(m.t === 'bs'){ _netBurstRecv(_netSess, m); return; }
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
    // tick packet silently here; sched/rst/reqlvl carry and check their own epoch already.
    // Compared against _rbEpoch (the epoch of OUR tick base), not s.epoch: between a halt and
    // the scheduled start the session line is already bumped while the sim still ticks the old
    // timeline, and a packet from that window is only usable by a peer still on the SAME base.
    // Every peer that passes the version gate stamps ep on these four types, so absence
    // is not special-cased: a missing ep reads as epoch 0 and gates like any other.
    if(_netSess
       && (m.t === 'in' || m.t === 'h' || m.t === 'st' || m.t === 'rs')
       && (m.ep|0) !== ((typeof _rbEpoch === 'number') ? _rbEpoch|0 : (_netSess.epoch|0))){
        // A peer stamping an epoch BELOW our line announces a missed start on every packet it
        // sends. Recover off that, not off the player pressing something.
        _netReshipStart(_netSess, m.ep|0);
        return;
    }
    switch(m.t){
        case 'sched':
        case 'rst': {   // the match / rematch / level start moment, issued by the server, relayed by P0
            const s = _netSess;
            if(!s || s.role === 'host' || !s.game) break;
            const ep = (typeof m.epoch === 'number') ? m.epoch|0 : (s.epoch|0);
            // Dedup the reliable-control repeats: the sender repeats a start 2-3x (neither
            // transport guarantees delivery), so act on each epoch exactly once -- a second
            // copy must not re-trigger beginOnlineDuel and reset a level already running.
            if(s.ctlEpoch === ep) break;
            if(m.t === 'sched' && inGame) break;
            // No shared clock, no match: starting on different timelines is exactly
            // the desync this architecture exists to make impossible. Validate BEFORE
            // consuming the epoch, so a malformed copy does not block a good repeat.
            if(typeof m.startPts !== 'number' || netPts() == null){ _netSessionEnd('NO CLOCK SYNC - CANNOT START'); break; }
            s.ctlEpoch = ep;
            s.seed = (m.seed>>>0) || s.seed;
            if(m.x10 !== undefined) s.x10 = !!m.x10;
            s.startPts = m.startPts;   // the epoch tick 0 is measured from: a rematch/level moves it
            s.epoch = ep;              // stay on the pair's epoch line
            if(m.lvl) _lvlCover = true;
            // Nudge OUR clock half of the way onto the shared MIDPOINT BEFORE we read startPts, so
            // the single number lands on the same real instant here as on the host. `bth` is the
            // peer offset the host measured in the boundary burst and shipped with the start; we
            // apply the joiner's half (+bth/2) while the host already applied -bth/2, so neither
            // takes the whole jump. The sim resets to tick 0 at EVERY start, so the clock step is
            // invisible. bth 0/absent (a first start, or a starved/rejected burst) is a safe no-op
            // that keeps the shared server sync, exactly as a cold start did before.
            _netBurstApply(s, m.bth || 0);
            const go = () => { if(_netSess === s && s.game){ if(m.lvl) beginOnlineDuelLevel(false); else beginOnlineDuel(s.seed, false); } };
            const wait = Math.max(0, Math.min(5000, m.startPts - netPts()));
            if(wait <= 0 || typeof setTimeout !== 'function') go(); else setTimeout(go, wait);
            break;
        }
        case 'start': break;   // schedule confirmation; its PTS is already in the past
        case 'in': _netDbg.hbRx++;   // both ends apply the other's input
            if(_netSess){ if(_netWD()) _wDuelSend({ t:'peerPkt', m }); else _netPeerInput(m); }
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
        case 'again':
            if(_netSess && _netSess.game){ _netSess.peerAgain = true; _netMaybeRestart(); _uiDirty = true; }
            break;
        case 'reqlvl':   // joiner asks P0 to open the next level; the epoch pins it to the boundary
            if(_netSess && _netSess.game && _netSess.role === 'host'){
                if(typeof m.epoch !== 'number' || (m.epoch|0) === (_netSess.epoch|0)) _netStartNextLevel(_netSess);
                // Behind our line: not an ask for the NEXT boundary, but a joiner that missed the
                // one we already opened, re-asking with the only epoch it has.
                else _netReshipStart(_netSess, m.epoch|0);
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
    // CONNECTION LOST is a pure SILENCE detector: nothing on the wire for ~2 heartbeats
    // (RB_WARN_MS). Every inbound datagram -- the minimal 'pi' liveness ping included --
    // refreshes lastRecvWall before dispatch, so a link still carrying ANYTHING never
    // flashes; a refused input is not a fault (it still arrived). Relay arrivals ride
    // jittered HTTP round trips, so relay warns at DOUBLE the p2p bar. DEPRECATED(relay)
    if(Date.now() - s.lastRecvWall > (s.relay ? RB_WARN_MS * 2 : RB_WARN_MS) && !(s.relay && performance.now() < s.relayGraceUntil)) return 'CONNECTION LOST';
    // OUT OF SYNC is the OTHER fault: the link is fine, the worlds diverged (a hash
    // disagreed). duel-core fires one targeted repair per verdict; this banner is its live
    // status. It clears the instant a hash agrees again (_rbBadSince -> 0); unhealed past
    // the same 2s deadline as silence, the liveness timer ends the match.
    const dsyFor = _netWD() ? (_netDbg.dsyFor|0) : (_rbBadSince ? Date.now() - _rbBadSince : 0);
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
        _netSigLog('! tick target ' + (t - simTick) + 't off: bad start origin');
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
// PLAY AGAIN online: both sides must agree; the restart then rides an rst message
// carrying a fresh seed and a new start_pts, and both sides adopt the new epoch.
function netAgain(){
    const s = _netSess; if(!s || !s.game) return;
    s.myAgain = true; _netSend({ t:'again' }); _netMaybeRestart(); _uiDirty = true;
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
// each sim auto-advances its own level deterministically). Only P0 relays the server-issued
// start, so a joiner press nudges the host with 'reqlvl'; P0 owns the epoch bump + request.
function netRequestNextLevel(){
    const s = _netSess; if(!s || !s.game || !inGame) return;
    _lvlCover = true;
    if(s.role === 'host') _netStartNextLevel(s);
    else _netSend({ t:'reqlvl', epoch:(s.epoch|0) });   // epoch pins the ask to THIS boundary
}
function _netStartNextLevel(s){
    if(!s || !s.game || s.role !== 'host' || s.lvlPending) return;   // one start per boundary
    _lvlCover = true;   // host may arrive here from a joiner reqlvl (no local press): cover its board too
    s.lvlPending = true;
    s.epoch = (s.epoch|0) + 1;   // a level boundary is a HALT: the epoch advances, exactly like a rematch
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
        phase = 'duelMenu'; showHUD(false); Snd.musicStop();
        _duelMsg = msg; _duelMsgAt = _msgNow();
        Snd.sfxPlay('fail', cfg.music); _uiDirty = true;
    } else if(phase === 'lobby'){ _netLb.msg = msg; _uiDirty = true; }
}
function _netTeardown(){
    _rbReset();
    if(typeof _wDuelEnd === 'function') _wDuelEnd();   // worker-hosted core: deactivate + reset there too
    const s = _netSess; _netSess = null;   // nulling this stops the relay loop + liveness (both check _netSess === s)
    if(!s) return;
    if(s.peer) delete _netPeerNet[s.peer];   // the IP hint was for THIS match's path; a new match (or a network switch) gets a fresh one
    s.game = false; s.relay = false;
    if(s.connT) clearTimeout(s.connT);
    if(s.liveT) clearInterval(s.liveT);
    if(s.relayAbort){ try{ s.relayAbort.abort(); }catch(e){} s.relayAbort = null; }   // DEPRECATED(relay): close the held relay socket now
    try{ if(s.dc){ s.dc.onopen=s.dc.onmessage=s.dc.onclose=null; s.dc.close(); } }catch(e){}
    try{ if(s.pc){ s.pc.onconnectionstatechange=s.pc.onicecandidate=s.pc.ondatachannel=null; s.pc.close(); } }catch(e){}
    s.dc = null; s.pc = null; s.rdOk = false; s.iceQ = [];   // a deferred ICE-holdback timer then sees s.pc !== its captured pc and skips
}

