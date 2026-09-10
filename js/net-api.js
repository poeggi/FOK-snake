// ============================================================================
// net-api.js -- FOK-server API client: transport (fetch wrappers, signals),
// version/platform handshake, PTS clock sync, presence heartbeat + adaptive
// poll, friendships, global highscores + the classic input log. Loads FIRST
// of the net files: net-rtc.js and net-session.js use its constants/helpers.
// Server contract: FOK-server docs/API.md (https://fok-server.poggensee.it).
//
// OFFLINE-FIRST CONTRACT: the net files are strictly additive. Every entry
// point no-ops when cfg.offline is ON, when the browser lacks fetch/WebRTC/
// timers, or when the server is unreachable. Every network failure is a silent
// soft failure -- local play must work IDENTICALLY with the server down, the
// device offline, or these files deleted (all callers guard with typeof).
// ============================================================================
const NET_BASE = 'https://fok-server.poggensee.it';
// The one STUN host, shared by every RTCPeerConnection in this client. It MUST resolve
// BOTH A and AAAA: the p2p connect wants candidates on whichever family works, and the
// public-address discovery in net-rtc.js can only name a family it gathered over.
const NET_STUN_URL = 'stun:stun.cloudflare.com:3478';
const NET_API_BUILT = 4;    // the contract MAJOR this client implements (API.md: Versioning; v4 = the ITEM REGISTRY -- the server owns item-instance ownership, so a transfer moves one row instead of copying a flag)
// The server's `api` is a "MAJOR.MINOR" string. Only the MAJOR gates compatibility -- a
// newer MINOR on the same major is purely additive. Returns the major integer, or null
// if unparseable (a soft failure, like every network failure here: no flags raised).
const NET_API_BUILT_MINOR = 12;   // built against 4.12 = THE PRINTED KEY FITS THE GAME'S OWN SCANNER: an event's poster is rendered by the server at exactly version 3 / level L / mask 0, which is the one shape this client's decoder reads, and its key is 11 characters NAMING ITS OWN EVENT rather than 16 beside an eid. Eleven is the whole budget: 42 bytes of URL prefix against a 53-byte version-3 symbol. So both codes an event shows are 53 bytes and THE DOT is what tells them apart -- a pass carries its eid in front of its own dot, a key has none. `join` therefore takes {id, code} with NO eid and the server reads the event out of the code, which is the only thing that can work for a key; the eid comes back on the answer. 4.11 = EVENTS: a room an operator opens on the server, joined by scanning its QR -- straight in when it is OPEN, after the organizer approves when it is CLOSED. THE SERVER IS THE ROSTER: membership is rows there and nothing else, so a client reads `events` on hello/poll fresh whenever a screen needs it, keeps no copy, reconciles nothing at startup and puts nothing in the vault -- deliberately NOT the friends-list pattern, whose local copy plus startup reconciliation is what makes a restored config fire a burst of requests. A member learns it was removed by the event simply being gone from that list. The live pass QR is why the identifiers are the length they are: this client's fixed version-3 encoder takes 53 text bytes, the URL prefix is 42, and 4 + 1 + 6 is what is left -- which is also why a pass names no issuer, so the server cannot learn who passed an event on. An event TOURNAMENT is an ordinary tournament with `eid` as a tag and a membership check on the way in, and the event MONITOR is an ordinary SPECTATOR: the same 'watch' signal, the same P2P feed, the same renderer, no second transport anywhere. `monitor_allowed` rides `state` and every `events` row so a client can ask whether a screen is offered WITHOUT claiming the slot, and `you` always describes the caller's own ROW rather than the role it is playing, so a member holding a free monitor lease still reads member; 4.10 = ONE AT A TIME: nothing of ours leaves beside a PARKED POLL unless a player is waiting on it right now -- the duel handshake (signal, start), a tournament action, a friend request, a seek -- and never two of them, because two beside the hold race each other and BOTH pay the full queue wait; everything nobody is waiting for (the beat, the roster, a score) waits for the poll to answer, one hold at most. t.txt is not a request for the rule: it is static, starts no work on the server, and the clock sweep must never queue behind a hold. A pts is refused only past pts_ahead_max_ms (200 ms), warned at half of it, so what we send is the reading we hold -- unbackdated, which is what makes the server's log evidence about our anchor; 4.9 = the poll is a COMPLETE beat: it carries `api` and the server's `debug` instruction on every body it sends (the two things a client cannot know are due, so it can never be its job to ask), and takes `aa` / `fl` / `tl` / `de` / `db` -- the hello answers a screen holding a poll used to send a second request for. A client on such a screen sends nothing beside its poll at all, not even the 60 s beat, because the poll is one; what stays hello's is what the CLIENT knows is due and the server cannot (a rename, a latency reading, its nets, and duel_with during a game, where nothing holds a poll anyway). Why it is worth a minor: a request sent beside a parked poll can be the one that takes the host to a concurrency its worker pool has not served before, and pays ~130 ms for the fork; 4.8 = a host may REPLACE the tournament it holds: a create answered 409 (already hosting) is re-sent with replace:true after the player confirms, ending the old one exactly as their own leave would and opening the new one in the same call, so a client never ends up holding neither (the old lobby is told 'host opened a new one'); 4.7 = a duel is ANNOUNCED as it begins: start.php records it (both peers call it at the match-identity moments), the heartbeat's duel_with refreshes it and hello's duel_end clears it at teardown, with duel_private marking a duel that counts everywhere but is never attributed to a person; 4.6 = friend presence as DELTAS against a cursor (friends_since on hello, fs on the poll -> friends_delta / friends_at / friends_more), the counters and the hold decision on the poll's 200, no friend ids on the wire and no screen tick; 4.5 = the 60 s heartbeat against a 120 s online window (every window a beat keeps alive -- presence, duel, auto-accept, the signal TTL -- doubled with it); 4.4, including its RE-RELEASE (the roster on hello's `friends_list`: feature-detected, never version-gated, because a server may answer to 4.4 without it) (ICE trickled in batches as one `ices` signal; the clock anchored on a quiet wire, with the server's own queue wait `q_ms` and start.php's `resync` hint to say when a sample is worth trusting; the hold decision in hello's `pace`); 4.3 = the tournament round ladder: a match starts at the level the bracket says, and a finished round stops on a scoreboard the host clears; 4.2 = hello `nets`: we report our own public address in BOTH families; 4.1 = tournament.php + the 'watch'/'tourney' signal pair + friends_playing; every 3.x minor is folded into the 4.0 baseline
function _netApiMajor(a){
    if(typeof a === 'string'){ const m = a.match(/^\s*(\d+)/); return m ? +m[1] : null; }
    return null;
}
function _netApiMinor(a){
    if(typeof a === 'string'){ const m = a.match(/^\s*\d+\.(\d+)/); return m ? +m[1] : 0; }
    return 0;
}
var _netDbgSrv = null;      // the server's last debug INSTRUCTION (null = never heard one); kept apart from cfg.debug, which is what we DO
var _netApiNewer = false;   // server MAJOR is newer -> online features disable with a notice
var _netApiOutdated = false;   // server MINOR is newer (same major): still compatible, but an update exists
var _netSrvErr = false;     // last heartbeat failed (shared by every online screen)
function netStatusNotice(){
    if(netOffline()) return 'OFFLINE MODE (SETTINGS > NETWORK)';
    if(_netApiNewer) return 'GAME UPDATE REQUIRED - PLEASE RELOAD';
    if(_netApiOutdated) return 'UPDATE AVAILABLE - PLEASE RELOAD';
    if(_netSrvErr) return 'SERVER UNREACHABLE - RETRYING';
    return null;
}
// Main-menu update note ONLY (no offline/unreachable noise): the server's contract is
// ahead of this build. REQUIRED = a newer major (online is disabled); AVAILABLE = a newer
// minor (online still works, but new features are missing). null when we are up to date.
function netUpdateNotice(){
    if(_netApiNewer) return 'UPDATE REQUIRED - PLEASE RELOAD';
    if(_netApiOutdated) return 'UPDATE AVAILABLE - PLEASE RELOAD';
    return null;
}
// EFFECTIVE offline: the stored toggle, OR forced by a file:// install (null origin -- the
// server is unreachable anyway, so mask it rather than fail every call). Masked at read; the
// stored cfg.offline is never mutated, so a local install keeps its saved preference.
function netOffline(){ return !!cfg.offline || (typeof _runFromFile === 'function' && _runFromFile()); }
function _netOk(){ return !netOffline() && !_netApiNewer && typeof fetch === 'function'; }
const _netTimers = (typeof setInterval === 'function' && typeof clearInterval === 'function');
// How far a peer's PTS may exceed ours before we call it bogus. We check against
// our ESTIMATE of the server clock (a few ms of sync error) over a jittery link,
// so this is sync error + jitter -- not zero. Zero tolerance here would drop
// honest packets, which is the silent-drop failure this whole layer keeps hitting.
const NET_PTS_TOL = 250;
// Idle keepalive period. Must stay comfortably under RB_WARN_MS (~533ms, below): the
// thing being watched for has to arrive faster than the watcher's patience -- and
// in-game the 16-tick input heartbeat (~267ms) is the real cadence anyway.
const NET_KEEPALIVE_MS = 300;
// The server anchor is refreshed by AGE, never by event: a sweep runs when the anchor is
// older than this (the multiplayer door, a first start, a spectator boot), not because a
// boundary came by. Drift is 1-3ms a minute, so a ten-minute anchor is tens of ms off at
// worst -- inside what the P2P burst closes at the next boundary (NET_BURST_SLEW_MS).
const NET_ANCHOR_MAX_AGE_MS = 600000;
// ---- P2P boundary clock BURST (raw-clock measurement, host-computed residual, over the DataChannel) ----
// During a duel the server clock sync is gated OFF (_netTimeSync refuses while playing: moving the
// anchor moves the tick timeline under our feet). So the two peers keep their clocks in step
// DIRECTLY, peer-to-peer -- but only at the one moment it matters: a boundary. Before EVERY
// timeline origin (match start, level advance, rematch, post-death respawn, recovery resume --
// no 'go' ships without a fresh clock verdict) the host opens a short bilateral BURST: each side
// fires NET_BURST_N 'bs' datagrams one engine tick apart, then holds the collection window open
// until NET_BURST_WAIT_MS past its last send -- that window IS the largest round trip the burst
// can verify -- finishing the instant both directions already have enough samples, so a healthy
// link is never slowed. The burst is its OWN trigger: the first host datagram to reach the joiner
// opens the joiner's run (any of the N is enough -- no one-shot trigger packet whose single loss
// could hang the boundary).
// The MEASUREMENT runs on the RAW clock (the 'rts' stamp: _wall() with no correction -- the only
// place raw time ever crosses the wire). Raw deltas are stationary across boundaries: in a
// zero-drift world every burst measures the SAME raw offset no matter how many nudges the shared
// clock has absorbed, which is what makes the host's low-pass filter sound. Each side keeps the
// MINIMUM raw one-way delta per direction -- delay only ever ADDS (queueing, jitter, WiFi
// power-save doze), so the min is the least-biased sample -- skipping sq 0 for timing (it is the
// path pre-warm; its delivery still counts). Every datagram piggybacks the sender's own
// forward-min (mr) and its delivery count (mn), so both sides can gate on both directions; and
// because pts and rts are stamped in the same instant, pts - rts on ANY datagram hands the
// receiver the sender's current clock correction for free (s.bsPeerC).
// The HOST computes the verdict: the raw offset from the two direction-mins, low-passed against
// the previous boundary's raw offset (the first of a session applies unmodified), then converted
// to the SHARED-clock residual R = raw + (host correction - joiner correction) -- how far the two
// NET clocks actually sit apart right now. The host applies -R/2 (slew-capped) and TRANSMITS R on
// the 'go' ('bth'); the joiner applies +R/2 -- the clocks meet at the shared MIDPOINT, neither is
// the master, and neither takes the whole jump. Absolute path latency cancels out of the raw
// offset entirely (only ASYMMETRY biases it) -- the scheme is deliberately insensitive to link
// latency, TURN-relayed paths included. That is what lets the host author ONE start PTS on its
// (now midpoint) clock and ship it on the 'go' with no server round trip -- the joiner reads the
// same real instant from that number. Gated: a starved or impossible burst ships NO bth at all --
// the joiner logs the failure and BOTH sides keep the prior in-play clock, itself burst-verified
// at the last boundary; the applied nudge is slew-capped so one bad estimate cannot teleport the
// timeline (it converges over the next boundaries, inside the rollback window).
const NET_BURST_N = 6;            // datagrams each side fires in one boundary burst; sq 0 is the pre-warm
const NET_BURST_GAP_TICKS = 1;    // probe CREATION cadence in engine ticks (x TICK_MS, absolute deadlines from the run's t0 -- a late timer never stretches the schedule); the send itself is never paced
const NET_BURST_WAIT_MS = 200;    // window past the LAST send == the max round trip the burst can verify; the early-out closes a healthy link at ~its own RTT
const NET_BURST_MIN = 5;          // accept-gate per direction: 5 of 6 delivered = at most ONE loss; anything worse means the channel is too unreliable to trust
const NET_BURST_SLEW_MS = 200;    // cap on the per-boundary clock nudge: damage control against ONE bad verdict, never reached by a realistic residual (<150ms = a 75ms nudge); ~12 ticks, well inside the rollback ring
const NET_BURST_LEAD_MS = 500;    // host's lead when it authors a start PTS on its own clock: covers the go's transit, its
                                  // reliable repeats AND the joiner's half of the burst residual -- that clock nudge must be
                                  // SETTLED well before either side reaches the PTS it is measured against
const NET_BURST_TRIES = 10;       // starved-burst retries before the boundary opens anyway on the PRIOR clock (itself
                                  // burst-verified at the last boundary). 10 x ~290ms (probe span + WAIT window) stays
                                  // inside the RB_PERSIST_KILL_MS silence deadline, so a genuinely dead peer ends the
                                  // match through the liveness path, never through the clock sync.
// How long a pending invite (sent, received, or accepting) lingers before it goes stale.
// The server keeps an undelivered signal for its signal TTL, the 120 s online window; we
// give up well before that so the UI resolves to NO ANSWER / clears the dialog. A signal the
// server still delivers after this window is dead on arrival, and refused by its stamp
// (_netSigStale).
const NET_INVITE_STALE_MS = 24000;
// A signal older than the staleness window when it arrives. `created` is the server's stamp
// in whole seconds, read against the server clock where we have one and against the wall
// clock plus the offset the last hello measured where we do not. No stamp = never stale.
function _netSigStale(sig){
    const c = sig && sig.created;
    if(typeof c !== 'number' || !(c > 0)) return false;
    const p = typeof netPts === 'function' ? netPts() : null;
    const srv = p != null ? p : Date.now() + (_netDbg.srvOfs || 0);
    return srv - c * 1000 > NET_INVITE_STALE_MS;
}
// Silence ladder (wall-clock ms, derived from the 16-tick heartbeat -- something should
// arrive every ~267ms). Wall-clock, NOT ticks: a suspended tab freezes simTick too, so only
// real elapsed time reveals the gap on the side that was asleep.
const RB_WARN_MS = Math.round(32 * TICK_MS);          // ~533ms (2 missed beats) -> CONNECTION LOST / OUT OF SYNC banner
const RB_RECONNECT_MS = Math.round(64 * TICK_MS);     // ~1067ms (4 missed) -> start a p2p link rebuild, still inside the kill window
// The single persistence deadline for BOTH faults: a peer we have not heard from, or a
// hash that keeps disagreeing after its resync, is a dead match once it lasts this long.
// The banner shows from ~RB_WARN_MS; the recovery attempt (p2p rebuild / resync) runs in
// the gap; unrecovered past this -> end. 4s: two heartbeats to notice, then a wide margin
// for a p2p link rebuild -- a >=1.5s interruption must recover the match, not end it.
const RB_PERSIST_KILL_MS = 4000;
// A wedged sim is not a quiet wire. The radio-warm beat is a wall-clock interval that exists to
// ping HARDEST when the sim is not ticking, so a peer whose sim died keeps the silence detector
// perfectly happy ~15x a second while its world stands still -- silence can never be the verdict
// on it. Its tick standing still is. The windows where a sim is ENTITLED to sit still (the burst
// to tick 0, a level or respawn boundary, a resume negotiation) are all bounded by the go ladder
// at RB_PERSIST_KILL_MS, so judge no faster than that ladder can end one, and kill at double: a
// level-up can never read as a death, and a corpse is still called in seconds rather than never.
const RB_SIM_STALL_MS = RB_PERSIST_KILL_MS;      // no proof the peer's sim moved -> CONNECTION LOST
const RB_SIM_KILL_MS = RB_PERSIST_KILL_MS * 2;   // ... and past this the match ends, like any dead link
// NET_PKT_MAX (the one-datagram payload budget) lives in duel-core.js: the core
// enforces it too, and the sim worker loads the core WITHOUT this file.
// Send-buffer congestion line: once the SCTP buffer already holds a few packets, a
// new one would sit BEHIND them and arrive late by the backlog's drain time. For
// lockstep a late input is worse than a lost one (the redundant log repairs a loss
// for free; nothing un-delays a delivery), so past this line the repairable periodic
// traffic is dropped, not queued. At ~4KB/s of duel traffic this should NEVER trip:
// the counter (CONG in the overlay) being nonzero is itself a finding.
const NET_SEND_CONG = 4 * NET_PKT_MAX;
// DataChannel options. PRE-NEGOTIATED (negotiated:true + a fixed id): both peers open it
// with the same id rather than one announcing it in-band and the other waiting on
// ondatachannel. That drops the DCEP open handshake -- the channel is usable the instant
// DTLS/SCTP is up, one round trip sooner to the first packet. Safe because both sides run
// this identical code. ordered:false + maxRetransmits:0 keeps it unreliable/unordered for
// the rollback netcode: no head-of-line stall, no retransmit lag -- a lost input is repaired
// by the redundant log, not the transport.
const NET_DC_OPTS = { negotiated:true, id:0, ordered:false, maxRetransmits:0 };
// Live network stats + the debug-overlay ring (declared early: the transport below stamps lastSrvAt).
var _netDbg = { rtt:-1, p2pRtt:-1, relayRtt:-1, relayDrop:0, relayAge:0, srvOfs:0, peerTkOfs:0, lag:0, inRx:0, inTx:0, hbRx:0, hbTx:0, iceDeob:0, iceTx:0, iceBat:0, qMs:0, path:'', inLog:[], sigLog:[],
                pollAt:0, pollHeld:false,   // pollAt = when the in-flight poll opened (0 = none open)
                lagAvg:0, lagMin:0, lagMax:0, lagN:0 };   // peer PTS delta, averaged over _netLagN
var _netLagN = [];   // rolling window of peer PTS deltas: one sample is noise, the average is the figure
function _netSigLog(line){ _netDbg.sigLog.unshift(line); if(_netDbg.sigLog.length>6) _netDbg.sigLog.length=6; _uiDirty=true; }

// ---- OUR OWN TRAFFIC, and the server's own queue (API 4.4) ----
// The clock offset is this device's ONE binding onto the shared clock, and HALF of any
// delay a sample meets lands straight in it. Measured on the live server through a single
// duel: five requests waited exactly 51ms before any work ran, on workers that were already
// warm -- so they had queued behind EACH OTHER, and most of them were this client's own
// signal.php burst. A clock sample taken beside that burst inherits the same wait, which
// is why a sample only counts when nothing of ours is in flight.
//
// The HELD long poll is deliberately NOT counted: it is parked server-side with nothing
// flowing, so it schedules against nothing -- and counting it would mean never anchoring
// on a matchmaking screen, where a poll is open by design, all of the time.
var _netFlight = 0;
// The high-water mark of that count. A 135ms wait read against a 3 here is this client
// queueing behind itself; the same wait against a 1 is a genuinely busy host, and they
// are different problems. Never reset -- it is the worst moment of the session.
var _netFlightMax = 0;
// q_ms is how long a request waited for a worker BEFORE any work ran. It is the one
// figure no client can measure for itself: the wait is over before our code starts, and
// inside our round trip it is indistinguishable from network delay. A non-trivial reading
// means the host is queueing in this very instant.
const NET_QMS_BUSY = 5;          // ms; 0 is the ordinary reading, the slice we measured showed 51
const NET_QMS_FRESH_MS = 4000;   // how long a reading stands for -- load moves, and a stale figure is not evidence
var _netQ = { ms:0, at:0, flight:0 };
// ...and it is read together with how many requests of ours were open when it was taken --
// the reading itself cannot tell a busy host from a client queueing behind ITSELF, and the
// two are different problems with different fixes. The count is taken before the request
// leaves the flight counter, so 1 means this request alone.
function _netQNote(j){ if(j && typeof j.q_ms === 'number'){ _netQ = { ms: Math.max(0, j.q_ms|0), at: Date.now(), flight: _netFlight }; _netDbg.qMs = _netQ.ms; } }
function netHostBusy(){ return !!_netQ.at && Date.now() - _netQ.at < NET_QMS_FRESH_MS && _netQ.ms >= NET_QMS_BUSY; }
// The self-check the server asked for: a queue wait measured while more than one request of
// ours was open is OUR overlap, not the host's load. Shown in the debug overlay, because
// the whole point of the gate above is that this never reads true.
function netSelfStacked(){ return netHostBusy() && _netQ.flight > 1; }
// start.php compared our proof of the shared clock against our opponent's and found the two
// too far apart. Only the server ever sees both, so this is the only evidence that exists
// that a PAIR is mis-anchored -- and it is a hint, not a refusal: the start it rides on
// stands, and the next one is given a full re-measure.
var _netResync = false;
// ---- the pace (API 4.4) ----
// The beat is CONTRACT, not wire. These intervals are stated in the contract and are the
// same for every client, so they live here as constants. An earlier 4.4 server also sent
// them in `pace`; they never carried anything but these numbers, and reading them back off
// the wire only bought a second place for the same value to be wrong.
const NET_HELLO_MS = 60000;   // between heartbeats: half the 120 s online window, so one missed beat never reads as offline
const NET_POLL_S   = 5;       // the longest hold poll.php serves, in whole seconds (`wait=`)
// One thing does depend on the moment, and it is the biggest lever there is: a held poll
// owns a server worker for its whole duration, so a server under pressure withdraws `hold`
// first, by tier. A 4.3 server sends none of this and this default -- exactly what the
// client did before -- stands.
var _netPace = { hold:true };
// How many 1s ticks apart an UNHELD mailbox read sits: where the held poll's answer would
// have landed, so withdrawing the hold does not cost the server a request per second
// where one held poll used to sit.
const NET_UNHELD_EVERY = NET_POLL_S;
// ---- the background gate (the contract's 100ms request gap, 4.4) ----
// What a request costs this host is not its bytes: it is the slice it waits for a
// worker before any work runs, and that slice is paid PER REQUEST IN FLIGHT. Two of ours
// leaving in the same instant pay it twice -- which is what a 135ms hello and a 127ms
// friend list from one client in one second are a picture of.
//
// So background traffic -- the heartbeat, the roster, items, the cloud backup, scores --
// goes out ONE AT A TIME through here, spaced by the gap the contract states and never
// beside anything else of ours. None of it is anything a player is waiting for.
//
// The duel path used to be exempt outright, on the grounds that it is the latency a player
// feels. The server then measured what that exemption costs: at the moment a match was
// dealt, one client had start.php and tournament.php leave in the same millisecond and BOTH
// waited 128ms for a worker while the pool mean was 2.5ms. Being past the gate is not the
// same as going out together -- two exempt calls in one tick race each other and both pay
// the queue, where one behind the other pays it once. So the duel's SERVER ROUND TRIPS come
// through here as well now. What stays outside is the long poll itself: it IS the parked
// slot the rule allows beside one other request, and gating it would only park the mailbox.
// SPACING, not a wait: it is sized just above what one request costs, so a stacked burst
// drains in milliseconds and no single call is ever held long enough for a player to feel it.
const NET_GAP_MS = 100;        // the contract's spacing between any two requests of ours
const NET_GAP_STEP_MS = 20;
const NET_GAP_TRIES = 100;     // ~2s of patience, counted in steps rather than measured: outlasts a full clock sweep
// TWO background tiers. The default one is background but still time-bound -- the
// heartbeat, the roster, the scores -- and may go out beside a poll parked server-side.
// NET_BG_IDLE is the tier nobody is waiting for at all (items, the cloud backup), and it
// stands aside for a HELD poll as well: parked or not, that poll owns a connection the
// whole time, and the slice is paid per request in flight up there, not per running worker.
// Bounded like every other wait here, so an idle-tier request is delayed, never dropped.
const NET_BG_IDLE = 'idle';
// ...and NET_BG_SOLO is the third: a request that must not go out BESIDE another of ours,
// but owes no spacing once the wire is clear. That is the signalling burst -- an offer, an
// ICE batch, a bye. Serialised, because the contract counts requests in flight and does not
// care which of them a player is waiting for; unspaced, because a handshake that is merely
// second in line still costs a connection nothing, while a handshake held back a quarter of
// a second per message costs one visibly.
const NET_BG_SOLO = 'solo';
// The peer of the duel we have just STOPPED playing, waiting for a beat to carry it out.
// Absence clears nothing server-side (a client closed mid-match never sends again), so the
// end has to be STATED -- and a bye that went over the DataChannel is the one end the server
// cannot see for itself. Held until a hello is answered rather than dropped on the first
// attempt: a stale end names a peer the server no longer has us playing and is ignored there,
// so carrying it one beat too far is free, while losing it costs a WATCH row its whole window.
var _netDuelEnd = '';
var _netSentAt = 0;            // when the last request of ours -- either lane -- went out
var _netGapQ = null;           // the tail of the background queue
// How long a background request must still wait, or 0 for "go now". THE rule, kept apart
// from the waiting so it can be read at a glance and tested without a clock:
//   anything of ours in flight -> wait, whatever the time says. This is the whole point.
//   otherwise -> whatever is left of the gap since the last request went out.
// _netFlight deliberately does not count a HELD poll: it is parked server-side with nothing
// flowing, so it schedules against nothing -- and counting it would stall every heartbeat
// behind the poll a lobby holds open by design. Where a held poll DOES have to count -- the
// idle tier -- the CALLER adds it, so this rule stays one line and one meaning.
// The solo lane owes the first line and not the second: never beside another of ours, but
// nothing more once the wire is clear.
function _netGapWait(now, flight, tier){
    if(flight > 0) return NET_GAP_STEP_MS;
    if(tier === NET_BG_SOLO) return 0;
    return Math.max(0, _netSentAt + NET_GAP_MS - now);
}
// What the gate hands the rule above: our own requests in flight, plus a PARKED HOLD of ours
// for every lane but the exempt one. A hold owns a worker for its whole wait, so a request
// sent beside it is the one that can take the host to a concurrency it has not served -- and
// two beside it race each other and BOTH pay the full wait, which is why nothing but the
// exempt lane may. The exempt lane is what a player is waiting on right now, where waiting
// for the hold to answer would be worse than sending. Both kinds of hold count the same: the
// worker does not know which endpoint parked it.
// ...and a RUNNING clock sweep counts as traffic on every lane, probes and the gaps between
// them alike: the contract's sweep is exclusive, nothing of ours leaves until its last sample
// is back. The sweep itself is not gated: t.txt starts no work, so it is not a request for
// this rule at all and has nothing to gain by queueing behind a hold.
function _netGapFlight(tier){ return _netFlight + (_netSyncBusy ? 1 : 0) + ((tier !== NET_BG_SOLO && (_netPollHeld || _netRelayHeld)) ? 1 : 0); }
// How many callers are waiting at the gate right now. The poll reads it: it must not park a
// worker again while work of ours is still queued behind the one it just released.
var _netGapN = 0;
function _netGate(tier){
    // No timer host, no pacing: the same line the heartbeat and the connect timers draw.
    // A build without one cannot schedule anything anyway, so gating there would only park
    // traffic against a wait that never comes due. The RULE above is what is worth testing,
    // and it is a pure function precisely so it can be tested without a clock.
    if(!_netTimers) return Promise.resolve();
    _netGapN++;
    const run = async () => {
        // Counted, NOT clock-bounded: a request whose promise never settles would leave a
        // clock-bounded wait spinning for ever. Past the count we go anyway -- a background
        // request delayed for ever is a heartbeat never sent, and that reads as offline.
        for(let i = 0; i < NET_GAP_TRIES; i++){
            const w = _netGapWait(Date.now(), _netGapFlight(tier), tier);
            if(w <= 0) break;
            await new Promise(res => setTimeout(res, Math.min(w, NET_GAP_MS)));
        }
        _netSentAt = Date.now();
    };
    const done = () => { _netGapN--; };
    const p = (_netGapQ || Promise.resolve()).then(run, run).then(done, done);
    _netGapQ = p;
    return p;
}
// `hold` is all of `pace` that is left. The interval fields an earlier 4.4 server still
// sends beside it are IGNORED rather than adopted: they only ever carried the constants
// above, and a second source for a number that has one is a second place to be wrong.
function _netPaceOf(j){
    const p = j && j.pace;
    if(p && typeof p === 'object' && typeof p.hold === 'boolean') _netPace.hold = p.hold;
}
// Batched ICE (`ices`, API 4.4) is only safe toward a peer that KNOWS the type: an older
// client hands an unknown signal to its default branch and the WHOLE array is gone --
// silently, and the candidates in it are the ones a direct route rides. So the gate is the
// PEER's build rather than the server's, and app MAJOR 4 is the line that speaks 4.4.
const NET_ICES_PEER_MAJOR = 4;
// The build line on the wire is APP_VERSION, which carries a leading 'v' ('v4.0.0').
function _netIcesPeerOk(v){ const m = /^\s*v?(\d+)/i.exec(String(v || '')); return !!m && +m[1] >= NET_ICES_PEER_MAJOR; }

// ---- transport (soft-fail JSON; null = any kind of failure) ----
// Returns {status, json}: json is null unless the server said ok. status 0 = the
// request never completed. Callers that only care "did it work" use _netPost.
async function _netPostRes(path, body, bg){
    if(!_netOk()) return { status:0, json:null };
    const idle = (bg === NET_BG_IDLE);
    if(bg) await _netGate(bg);
    if(!_netOk()) return { status:0, json:null };   // the gate is a wait, and offline can be switched on inside it
    _netFlight++;   // ...so the clock sync can tell a quiet wire from this one
    _netSentAt = Date.now();
    if(_netFlight > _netFlightMax) _netFlightMax = _netFlight;
    try {
        // priority: the duel path and the heartbeat are what a player is waiting for; the idle
        // tier is not, and telling the browser so lets it put its stream last on the shared
        // connection instead of scheduling it beside the traffic it was asked to stand behind.
        const r = await fetch(NET_BASE + path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body), cache:'no-store', priority: idle ? 'low' : 'high' });
        _netDbg.lastSrvAt = performance.now();   // a POST always carries data both ways = real communication
        let j = null; try{ j = await r.json(); }catch(e){}   // an error status may carry no JSON at all
        _netQNote(j);   // every response carries the queue wait, error replies included
        // Keep the server's own reason ({"ok":false,"error":"..."}): guessing it
        // from the status alone is how 'invalid pts' got misread as a clock drift.
        return { status: r.status, json: (j && j.ok) ? j : null, body: j, err: (j && j.error) ? String(j.error) : '' };
    } catch(e){ return { status:0, json:null, body:null, err:'' }; }
    finally { _netFlight--; }
}
async function _netPost(path, body, bg){ return (await _netPostRes(path, body, bg)).json; }
async function _netGet(path, signal, held, bg){
    if(!_netOk()) return null;
    if(bg) await _netGate(bg);
    if(!_netOk()) return null;
    // held: a long poll parked server-side with nothing flowing. It schedules against
    // nothing, so it does not make the wire busy for the clock sync's purposes.
    if(!held) _netFlight++;
    _netSentAt = Date.now();
    if(_netFlight > _netFlightMax) _netFlightMax = _netFlight;
    try {
        // no-store: never let an intermediary cache a held-poll reply; high priority:
        // these are the match's critical path, ahead of any incidental page fetch.
        const _opt = { cache:'no-store', priority:'high' };
        if(signal) _opt.signal = signal;
        const r = await fetch(NET_BASE + path, _opt);
        // A 204 (held long-poll expiring with nothing to say) IS communication: the
        // request went out and the server answered. Stamping only data-bearing
        // replies made this climb forever on an idle-but-healthy link, which is the
        // opposite of what a liveness readout is for. Any completed exchange counts.
        _netDbg.lastSrvAt = performance.now();
        if(r.status === 204) return { ok:true, signals:[] };
        const j = await r.json();
        _netQNote(j);
        return (j && j.ok) ? j : null;
    } catch(e){ return null; }
    finally { if(!held) _netFlight--; }
}
// Background traffic that cannot use the helpers above: the cloud backup reads the raw
// response because it acts on 403 / 404 / 413 itself, which a soft-fail helper has already
// thrown away. It is still this client's traffic, so it is still counted (the clock sync
// must see it) and still paced (the gate must see it) -- the request a client sends least
// often is the last one that should be invisible to both.
async function netBgFetch(path, opt){
    // Refused exactly like the two helpers above: status 0 is the "never completed" shape both
    // callers already read as a failure, and a stub json() keeps them off a TypeError path.
    if(!_netOk()) return { status:0, json:()=>Promise.resolve(null) };
    await _netGate(NET_BG_IDLE);   // the cloud backup is the idle tier by definition: nobody is waiting for it
    // The gate is a wait, and offline can be switched on inside it -- a long wait here, since
    // this tier also stands aside for a held poll.
    if(!_netOk()) return { status:0, json:()=>Promise.resolve(null) };
    _netFlight++;
    _netSentAt = Date.now();
    if(_netFlight > _netFlightMax) _netFlightMax = _netFlight;
    try { return await fetch(NET_BASE + path, opt); }
    finally { _netFlight--; }
}
// Every caller ignored the result of this, so the server REFUSING a signal was
// indistinguishable from success: a 403 (no accepted friendship), a 400 (our clock
// drifted ahead of the server's), a 503 (relay full) or a plain blip all vanished
// while the UI sat on "INVITED - WAITING" until the staleness timeout. Failures are now
// logged in the debug overlay, and the invite path reports them to the user.
async function _netSignal(to, type, payload){
    _netSigLog('> '+type+' '+String(to).slice(0,4));   // debug overlay
    const body = { id:getPlayerId(), to, type, payload: payload||'' };
    const pts = (typeof netPts === 'function') ? netPts() : null;
    if(pts != null) body.pts = pts;
    // The solo lane: a signal never goes out beside another request of ours (the deal burst
    // is exactly that -- a sheet, an offer and a start in the same tick), and never waits
    // out the background spacing either. See NET_BG_SOLO.
    const res = await _netPostRes('/api/signal.php', body, NET_BG_SOLO);
    if(!res.json){
        _netSigLog('! ' + type + ' FAILED ' + (res.status || 'net') + (res.err ? ' ' + res.err : ''));
        // Contract: 'bogus pts: in the future' means OUR clock drifted ahead. Re-sync
        // at once, or every subsequent signal is rejected the same way. Only for that
        // reason -- 'invalid pts' is a malformed value, which no re-sync can fix.
        if(res.status === 400 && /future/.test(res.err)) _netTimeSync(true);
        // 429 = the PEER's mailbox is full, not silence. The offer ladder gives up after
        // 3 tries with 'NO RESPONSE', which points at the wrong player.
        else if(res.status === 429 && _netHs.sent === to) _netLb.msg = 'PLAYER BUSY - TRY LATER';
    }
    return res;
}
function _netJson(s){ try{ const v = JSON.parse(s); return (v && typeof v === 'object') ? v : {}; }catch(e){ return {}; } }
// An `ices` payload is a JSON ARRAY. Anything else is ignored rather than guessed at: a
// batch we cannot read is a batch whose candidates we never had.
function _netJsonArr(s){ try{ const v = JSON.parse(s); return Array.isArray(v) ? v : []; }catch(e){ return []; } }

// ---- player profile (sent with invites/offers; received ones are UNTRUSTED) ----
// Do these two builds share a SIMULATION? Compare MAJOR.MINOR only, so 2.0.0 and
// 2.0.1 play together. The patch auto-bumps on every commit, so an exact match meant
// two devices practically never agreed and refused to duel over a changed pixel.
//
// What actually has to match is determinism, not the build: two clients whose sims
// differ desync, two whose message strings differ do not. So major.minor is a PROMISE
// that a patch never changes the sim -- when one does (a new rule, a different roll),
// the MINOR must move, or two clients will silently diverge instead of refusing to
// start. The golden hashes in test/ are what say whether it changed.
function _netVerLine(v){ return String(v == null ? '' : v).split('.').slice(0, 2).join('.'); }
function _netVerOk(theirs){
    if(!theirs) return true;                         // said nothing: nothing to refuse over
    return _netVerLine(theirs) === _netVerLine(_swVersion);
}
// The local display name, cached: netPlayerNames() runs EVERY FRAME during an online
// duel (HUD labels), and localStorage.getItem is a synchronous disk-backed read that
// does not belong in a render path. The name only changes at name entry, so a short
// TTL keeps the cache honest without any invalidation wiring.
var _netMyNameC = { v:'', at:0 };
function _netMyName(){
    const n = Date.now();
    if(n - _netMyNameC.at > 10000){
        _netMyNameC = { v:getPlayerName(), at:n };
    }
    return _netMyNameC.v;
}
// Name entry wrote lastSName: drop the cache so the next read sees it (the TTL alone
// only covers writes that bypass the game, e.g. a cloud-backup restore).
function netNameChanged(){ _netMyNameC.at = 0; }
// Device CATEGORY (API 3.4 'platform' tag): one of pc/mobile/tv/console, best-effort
// from the UA plus touch/pointer/screen. Cached -- the answer is fixed for the tab. It
// is deliberately coarse and never authoritative: the server whitelists these four and
// stores anything else as null, so a wrong or unknown guess just shows no badge.
var _platformC = null;
function _detectPlatform(){
    if(_platformC) return _platformC;
    let ua = ''; try { ua = (navigator.userAgent || '').toLowerCase(); } catch(e){}
    let p;
    if(/playstation|xbox|nintendo/.test(ua)) p = 'console';
    else if(/smart-?tv|googletv|android ?tv|appletv|crkey|tizen|web ?os|hbbtv|netcast|bravia|\baft[a-z]*\b|\btv\b/.test(ua)) p = 'tv';
    else {
        let touch = false, coarse = false, small = false;
        try { touch = (navigator.maxTouchPoints || 0) > 0 || ('ontouchstart' in window); } catch(e){}
        try { coarse = !!(window.matchMedia && matchMedia('(pointer:coarse)').matches); } catch(e){}
        try { small = Math.min(screen.width || 9999, screen.height || 9999) < 900; } catch(e){}
        // iPadOS reports a desktop UA, so /ipad/ alone misses it -- the touch+coarse+small
        // combination catches phones and tablets that the UA string hides.
        if(/android|iphone|ipad|ipod|iemobile|blackberry|mobile|tablet|silk|kindle/.test(ua) || (touch && coarse && small)) p = 'mobile';
        else p = 'pc';
    }
    _platformC = p; return p;
}
// wornUids/wornSeqs are the item-registry half of the profile: the server's unique id, and
// our view of its version, for each windswept item we are WEARING into the match. Both
// clients seed the sim's windswept state from these two exchanged profiles, so a transfer can
// name the exact instance that moved (see _ws in sim.js, itemWornUids in items.js). Items
// bought offline have no uid yet and simply do not appear here.
function _netProfile(){
    const wu = (typeof itemWornUids === 'function') ? itemWornUids() : { uids:{}, seqs:{} };
    return { name:(_netMyName()||'PLAYER').slice(0,MAX_NAME), color:cfg.snakeColor|0, shopItems:cfg.wornItems||{},
             wornUids:wu.uids, wornSeqs:wu.seqs, platform:_detectPlatform() };
}
// A peer's uid/seq map is untrusted input the SIM then hashes, so it is clamped to plain
// {string: string|int} pairs of a bounded size before it can reach _wsSeed. A malformed entry
// becomes an unregistered item, which is a state the duel already handles.
function _netClampUids(o, num){
    const out = {};
    if(!o || typeof o !== 'object') return out;
    let n = 0;
    for(const k in o){
        if(++n > WINDSWEPT_ITEMS.length) break;
        if(typeof k !== 'string' || k.length > 32) continue;
        out[k] = num ? (o[k]|0) : (typeof o[k] === 'string' ? o[k].slice(0,32) : '');
    }
    return out;
}
function _netClampProfile(p){
    p = (p && typeof p === 'object') ? p : {};
    return { name: String(p.name||'???').slice(0,MAX_NAME),
             color: Math.abs(p.color|0) % SNAKE_COLORS.length,
             shopItems: (p.shopItems && typeof p.shopItems === 'object') ? p.shopItems : {},
             wornUids: _netClampUids(p.wornUids, false),
             wornSeqs: _netClampUids(p.wornSeqs, true),
             platform: (typeof p.platform === 'string') ? p.platform.slice(0,12) : null };
}

// ---- PTS clock sync (API: time synchronization). The server clock in unix
// MILLISECONDS is the one PTS reality; we measure our offset via t.txt
// (3-5 samples, keep the lowest-RTT one) and adjust ourselves. REQUIRED before
// an online game starts; refreshed by AGE (NET_ANCHOR_MAX_AGE_MS). ----
var _netSync = { ofs:null, rtt:-1, at:0 };
// The lockstep timeline rides the MONOTONIC clock, never Date.now(). Date.now() is the wall
// clock, which the OS silently slews and steps (its time daemon disciplining toward network
// time) -- anchoring the shared PTS to it let those adjustments leak straight into the timeline
// as drift. A foregrounding phone can move its wall clock ~10ms in a minute this way (~167ppm),
// far past any crystal error, which is exactly the "not normal wall drift" the field reported.
// performance.now() is a monotonic clock: it never decreases and is not subject to adjustments;
// timeOrigin pins it to a wall reading captured ONCE at context start, so this reads like a wall
// clock but cannot be nudged afterward. Whole ms (the server rejects a fractional pts). The
// staleness/silence timers below stay on Date.now() -- those genuinely want adjustable wall time.
function _wall(){
    return (typeof performance !== 'undefined' && performance.now && performance.timeOrigin != null)
        ? performance.timeOrigin + performance.now()
        : Date.now();
}
function netPts(){ return _netSync.ofs == null ? null : Math.round(_wall() + _netSync.ofs); }
// RAW pts: this device's un-nudged monotonic clock -- netPts() WITHOUT the _netSync correction.
// Read by exactly one consumer: the 'rts' stamp on burst-sync datagrams (_netSend), where a
// stationary-across-nudges reading is the point (see the NET_BURST_* block). NEVER used by a
// game mechanic -- the sim, the tick timeline and every other packet stamp run on netPts().
function netRawPts(){ return Math.round(_wall()); }
// OPTIONAL latency report (API: display only -- the admin UI and friends_latency; nothing
// in gameplay reads it): the same clock samples yield the value -- at least three, an
// extreme FIRST sample (cold connection: DNS/TCP/TLS) discarded, the rest averaged.
var _netLat = { value:null, at:0, pending:false };
function _netLatFromSamples(rtts){
    if(rtts.length < 3) return null;
    const rest = rtts.slice(1);
    const avgRest = rest.reduce((a,b)=>a+b,0) / rest.length;
    const use = (rtts[0] > 2.5 * avgRest) ? rest : rtts;   // extreme first value: discard
    return Math.round(use.reduce((a,b)=>a+b,0) / use.length);
}
let _netSyncBusy = false;
// The clock source, in PTS milliseconds. PREFERRED: a header on a STATIC file, so
// the web server stamps it without a worker ever running. That matters because the wait
// for a worker happens BEFORE it starts -- it cannot see it, cannot subtract it,
// and it would otherwise land in our offset as if it were network delay, exactly
// when the server is busiest. time.php stays as the fallback for when the header is
// unreadable (a proxy stripping it, CORS).
async function _netClockMs(){
    // Counted like any request of ours: the gate must see the probe so nothing leaves beside it.
    _netFlight++; _netSentAt = Date.now();
    try {
        const r = await fetch(NET_BASE + '/api/t.txt', { cache:'no-store', priority:'high' });
        const h = r.headers && r.headers.get && r.headers.get('X-Fok-T');
        const m = h && /t=(\d+)/.exec(h);
        if(m) return Number(m[1]) / 1000;   // the header is MICROseconds; PTS is milliseconds
    } catch(e){}
    finally { _netFlight--; }
    // Ungated, and the only round trip left that is: the gate is a WAIT, and a wait taken
    // here would land inside the round trip this function measures -- straight into the
    // clock offset both clients start a match from. _netQuiet() has already established a
    // clear wire before any sweep runs, which is the serialisation this one needs.
    const j = await _netGet('/api/time.php');
    return (j && typeof j.t === 'number') ? j.t : null;
}
// Wait -- briefly -- for our own wire to go quiet before taking a sample. Quiet means
// quiet, not "mostly idle". Bounded, because a client that is genuinely busy still needs an
// anchor and a rough one beats none at all; what a busy client does NOT do is report the
// figure it measured (see below).
const NET_QUIET_STEP_MS = 20;
const NET_QUIET_TRIES = 12;   // ~240ms of patience, counted in steps rather than measured
async function _netQuiet(){
    if(typeof setTimeout !== 'function') return _netFlight <= 0;
    // Counted, NOT clock-bounded: a request whose promise never settles would leave a
    // clock-bounded wait spinning for ever, and this runs on the path that anchors a match.
    for(let i = 0; i < NET_QUIET_TRIES && _netFlight > 0; i++)
        await new Promise(res => setTimeout(res, NET_QUIET_STEP_MS));
    return _netFlight <= 0;
}
// The anchor is refreshed by AGE, never by event: a sweep runs when nothing is anchored yet,
// when the anchor is older than NET_ANCHOR_MAX_AGE_MS, or when a caller forces one (a
// foreground, a "future pts" refusal, the server's resync hint).
function _netAnchorStale(){ return _netSync.ofs == null || Date.now() - _netSync.at > NET_ANCHOR_MAX_AGE_MS; }
async function _netAnchorRefresh(opts, force){ if(force || _netAnchorStale()) await _netTimeSync(true, opts); }
// Adopt a sample. nudge = move the anchor HALF the way to the reading: the residual is left
// to the next sweep and to the P2P burst, and one polluted reading can only ever do half
// its damage. A missing anchor is always set outright -- there is nothing to nudge from.
function _netAnchorAdopt(smp, nudge){
    const cur = _netSync.ofs;
    const ofs = (nudge && cur != null) ? cur + (smp.ofs - cur) / 2 : smp.ofs;
    _netSync = { ofs, rtt: smp.rtt, at: Date.now() };
    _netClockPush();
}
// opts: { n: samples (default 5), nudge: half-delta adoption (default: set outright) }.
async function _netTimeSync(force, opts){
    if(_netSyncBusy || !_netOk()) return;
    // NEVER re-anchor while a duel is being played. netPts() DRIVES the tick number, so
    // moving the anchor moves the whole timeline under our feet -- a periodic
    // self-inflicted desync. The anchor is set before the match and left exactly where it
    // is, drift and all, until the match is over: the P2P burst keeps the two PEERS in step
    // at every boundary, which is the only agreement play depends on. A few ms of drift
    // across a match is invisible; a step mid-game is not.
    if(phase === 'duel' || phase === 'duelPaused') return;
    if(!force && _netSync.ofs != null) return;   // anchored: it holds until age or a caller re-anchors it
    const n = (opts && opts.n) || 5;
    const hadAnchor = _netSync.ofs != null;
    _netSyncBusy = true;
    let best = null, rough = null;
    const rtts = [];
    try {
        for(let i = 0; i < n; i++){
            // CLEAN = nothing of ours was in flight around this sample, and the server was not
            // queueing while it answered. Only a clean sample may set the offset or be reported
            // as latency.
            const quiet = await _netQuiet();
            const t0 = performance.now();
            const t = await _netClockMs();
            const rtt = performance.now() - t0;
            const clean = quiet && _netFlight <= 0 && !netHostBusy();
            if(t != null){
                const smp = { rtt, ofs: t + rtt/2 - _wall() };
                // Keep the LOWEST-rtt sample, never an average: a sample delayed by queuing
                // carries that delay straight into its offset, so averaging spreads the poison
                // instead of discarding it. The fastest sample is the least polluted one.
                if(clean){ rtts.push(rtt); if(!best || rtt < best.rtt) best = smp; }
                else if(!rough || rtt < rough.rtt) rough = smp;
                // Unanchored: adopt at once, so netPts() is usable after ONE round trip (the
                // menu-music gate waits on exactly that). Later samples only refine it.
                if(_netSync.ofs == null){ const u = best || rough; _netSync = { ofs: u.ofs, rtt: u.rtt, at: Date.now() }; }
            }
            // SPREAD the samples by the request gap. Back-to-back requests hit the same server
            // load and can all be slow together, leaving no clean sample to pick.
            if(i < n - 1 && typeof setTimeout === 'function') await new Promise(res => setTimeout(res, NET_GAP_MS));
        }
    } finally { _netSyncBusy = false; }
    // Not one clean sample in the whole sweep: take the least bad one anyway. An unanchored
    // client cannot play at all, and a rough anchor is corrected at the next sweep.
    if(!best) best = rough;
    // Guard the ADOPTION, not just the start: a sweep begun before a match can land after
    // play began -- and adopting it there would be the very mid-game step we just refused.
    if(_netSync.ofs != null && (phase === 'duel' || phase === 'duelPaused')) best = null;
    if(best) _netAnchorAdopt(best, !!(opts && opts.nudge) && hadAnchor);
    const lat = _netLatFromSamples(rtts);
    // Nothing clean enough to report: say NOTHING rather than send a figure that measured
    // our own burst.
    if(lat != null) _netLat = { value: Math.max(0, Math.min(60000, lat)), at: Date.now(), pending: true };
    else _netLat.at = Date.now();
    // The sweep held the mailbox re-arm back (the gate counts a running sweep as traffic);
    // let it go now rather than on the next 1s tick.
    if(typeof _netPollOnce === 'function') _netPollOnce();
}

// ---- live network stats (DEBUG LEVEL 2+ overlay and the debug export) ----
// Debug overlay split into three corner quadrants (the fourth, graphics, is the
// caller's -- it owns the layout numbers). N = network/transport (top-left),
// T = timing/timekeeping (top-right), S = sim/rollback health (bottom-right).
//   pts = engine tick clock (60/s). srv rtt/lat = round-trip to the SERVER / reported latency.
//   vs <peer> <v4|v6|relay> = who + how we are connected; p2p <ms> = the DIRECT peer RTT
//   (from the ICE candidate-pair, NOT the server) -- the number that governs duel lag.
//   anc = this device's clock offset vs the server (mr = min-rtt, a = age); PTS
//   rests on it, so a wrong anc puts us out of step with the peer.
//   P<i>[R] = my index, R=relay; ep = epoch; tgt = clock-driven tick target
//   ptk = peer-tick (sub-tick, ~0 = aligned); pts live/avg = peer one-way pts-delta (latest, then avg + min/max)
//   rb = rollbacks/resim-ticks, mx = deepest; live = inputs applied with NO rewind
//   dsy = desync, hok = hash-ok; in = input records rx/tx; pkt = ALL packets rx/tx
//   path = ICE pair (host=LAN, srflx=hairpin), also carrying p2p-rtt at level 3
// A PTS as UTC time-of-day (hh:mm:ss.t): the shared server clock is unix ms, so the
// same PTS renders identically on every device regardless of its timezone.
function _netHms(pts){
    const t = Math.floor(pts/100) % 864000;   // tenths within the UTC day
    const s = Math.floor(t/10);
    const p2 = n => (n<10?'0':'')+n;
    return p2(Math.floor(s/3600)) + ':' + p2(Math.floor(s/60)%60) + ':' + p2(s%60) + '.' + (t%10);
}
// Each quadrant returns { main, more }: main = the <=3 lines the Level-2 dock shows,
// more = the extra lines that appear only at Level 3. The overlay stacks `more` away
// from the screen corner so the essentials stay pinned to it.
function netDebugQuad(){
    const d = _netDbg, Nm = [], Nx = [], Tm = [], Tx = [], Sm = [], Sx = [];
    Tm.push('pts ' + simTick + ' ' + (simNow/1000).toFixed(1) + 's');
    if(netOffline()){ Nm.push('offline'); return { net:{main:Nm,more:Nx}, time:{main:Tm,more:Tx}, sim:{main:Sm,more:Sx} }; }
    Tm.push((_netSync.ofs == null)
        ? ('anc -- ' + (d.srvOfs ? '(hello ' + Math.round(d.srvOfs) + ')' : 'unsynced'))
        : ('anc ' + (_netSync.ofs>=0?'+':'') + Math.round(_netSync.ofs) + ' mr' + Math.round(_netSync.rtt) +
           ' a' + ((_netSync.at ? (Date.now()-_netSync.at) : 0)/1000).toFixed(0) + 's'));
    Nm.push('srv rtt ' + (d.rtt<0?'--':Math.round(d.rtt)) + ' lat ' + (_netLat.value==null?'--':_netLat.value));
    if(_netSess && _netSess.game){
        const _tgt = netTickTarget();
        Nx.push('P' + netMyIndex() + (_netSess.relay?'R':'') + ' v ' + String(_netSess.peer).slice(0,4) + ' ep' + (_netSess.epoch|0));
        // WHO + HOW we are connected to the other side. Name from their profile; IP/family from
        // the server's peer-net hint (present on BOTH sides -- offerer and accepter alike).
        const _pn = _netPeerNet[_netSess.peer];
        const _pnm = (_netSess.peerProfile && _netSess.peerProfile.name) || ('#' + String(_netSess.peer).slice(0,4));
        // The peer's IP gets its OWN line: a full IPv6 next to the name overflows the quadrant.
        Nm.push('vs ' + _pnm + '  ' + (_netSess.relay ? 'relay' : _pn && _pn.ip ? (_pn.fam ? 'v' + _pn.fam : 'p2p') : 'p2p (no ip hint)')
            + (!_netSess.relay && d.p2pRtt >= 0 ? '  p2p ' + d.p2pRtt + 'ms' : ''));
        if(!_netSess.relay && _pn && _pn.ip) Nx.push(_pn.ip);
        Nx.push(d.path || 'path ?');
        Nx.push('in ' + d.inRx + '/' + d.inTx + '  pkt ' + d.hbRx + '/' + d.hbTx);
        // RETX n = transition re-sends (go/req shipped again because no echo landed yet).
        Nm.push('drop ' + _rbDbg.drop + ' lost ' + _rbDbg.lost + (d.congDrop ? '  CONG ' + d.congDrop : '')
            + (d.retx ? '  RETX ' + d.retx : ''));
        // pts live = the peer's one-way pts-delta (how late their inputs land) -- the number
        // that predicts rollbacks, so it takes the Level-2 slot the wall clock used to hold.
        Tm.push('pts live ' + Math.round(d.lag) + (d.lagN ? '  avg ' + Math.round(d.lagAvg) + ' ' + Math.round(d.lagMin) + '/' + Math.round(d.lagMax) : ''));
        // tgt = the tick the wall PTS says we should be at; d = tgt-simTick, i.e. how far
        // our engine sim sits from the wall clock (the drift the accumulator steers out).
        Tx.push('tgt ' + (_tgt==null?'--':_tgt + ' d' + (_tgt-simTick>=0?'+':'') + (_tgt-simTick)) + '  ptk ' + d.peerTkOfs.toFixed(2));
        // wall = the PTS our LOCAL wall clock currently equals (Date.now()+anc) as UTC
        // hh:mm:ss.t; two synced devices show the SAME string -- a sync check, not a
        // per-tick number, so it rides at Level 3 now.
        Tx.push('wall ' + (netPts()==null ? '-- unsynced' : _netHms(netPts())));
        // pset = phase sets this match (the start seed counts as the first) + how long
        // ago the last one fired. A healthy match reads "1x" with the age growing.
        Tx.push('pset ' + (d.psetN|0) + 'x' + (d.psetAt ? ' ' + ((performance.now() - d.psetAt)/1000).toFixed(0) + 's ago' : ''));
        Sm.push('rb ' + _rbDbg.rb + '/' + _rbDbg.resim + ' mx' + _rbDbg.maxRew + '  live ' + _rbDbg.live);
        // hlst = peer hashes that reached us but could never be judged. Non-zero means the
        // divergence detector is BLIND, which looks identical to healthy on every other line.
        Sx.push('dsy ' + _rbDbg.desync + ' hok ' + _rbDbg.hashOk + ' hlst ' + (_rbDbg.hashLost|0) + ' fix ' + (_rbDbg.fix|0));
        if(d.inLog.length) Nx.push('< ' + d.inLog.join(' '));
    } else {
        Nm.push('online ' + _netCounts.online + '  playing ' + _netCounts.playing);
        if(_netLb.invite && Date.now()-(_netLb.invite.at||0) < NET_INVITE_STALE_MS) Nm.push('INVITE FROM ' + String(_netLb.invite.from).slice(0,4) + (_netLb.invite.relay?' (relay)':''));
        if(_netHs.sent) Nm.push('INVITED ' + String(_netHs.sent).slice(0,4) + ' - waiting');
        if(_netHs.accepting) Nm.push('ACCEPTED ' + String(_netHs.accepting).slice(0,4) + ' - awaiting offer');
        if(_netHs.offerTo) Nm.push('OFFERED ' + String(_netHs.offerTo).slice(0,4) + ' x' + _netHs.offerTries);
    }
    // Two different facts, because one cannot answer for the other: whether a
    // connection is OPEN right now, and how long since the last completed exchange.
    // On a held long-poll those diverge by design -- the connection sits open for
    // up to 8s saying nothing, so the age climbing to ~8s is health, not silence.
    // HELD = one connection held open (matchmaking screens), REQ = a plain request
    // in flight, idle = between polls (main menu: one every 10s).
    if(d.lastSrvAt){
        const fmt = (ms) => ms < 1000 ? Math.round(ms) + 'ms' : (ms/1000).toFixed(1) + 's';
        const conn = _netDbg.pollAt
            ? (_netDbg.pollHeld ? 'HELD ' : 'REQ ') + fmt(performance.now() - _netDbg.pollAt)
            : 'idle';
        Nx.push('srv ' + conn + ' | data ' + fmt(performance.now() - d.lastSrvAt) + ' ago');
    }
    // The queue wait, with what it means: x1 is the host's own load, anything above it is
    // this client's overlap. SELF-STACKED takes a level-2 line because it is a bug in here,
    // not a condition out there; mx is the worst concurrency of the whole session.
    if(_netQ.at && Date.now() - _netQ.at < NET_QMS_FRESH_MS)
        (netSelfStacked() ? Nm : Nx).push('q ' + _netQ.ms + 'ms x' + _netQ.flight
            + (netSelfStacked() ? ' SELF-STACKED' : '') + '  mx' + _netFlightMax);
    for(const e of _netDbg.sigLog.slice(-3)) Nx.push(e);   // last few only -- ICE floods it mid-game
    return { net:{main:Nm,more:Nx}, time:{main:Tm,more:Tx}, sim:{main:Sm,more:Sx} };
}
// Watchable = playing AND online. A stale 'playing' with the friend gone offline would
// otherwise offer a watch that can only time out.
function netFriendPlaying(id){ return _netFriendsPlaying[id] === true && _netFriendsOnline[id] === true; }
function netFriendE2E(id){
    const theirs = _netFriendsLat ? _netFriendsLat[id] : null;
    const ours = _netLat.value != null ? _netLat.value : (_netDbg.rtt >= 0 ? _netDbg.rtt : null);
    if(theirs == null || ours == null) return null;
    return Math.round(theirs/2 + ours/2);   // send->receive via the server path (NOT an RTT)
}
// The two display names of an online duel in PLAYER order (P0 = host, P1 = the
// joiner), for the HUD and the winner banner. null when not in an online game.
function netPlayerNames(){
    if(!netGameActive()) return null;
    // Spectating: neither name is ours. Both arrive in the bootstrap context, already in
    // player order -- there is no "mine" to place at P0 or P1.
    const sn = (typeof netSpecNames === 'function') ? netSpecNames() : null;
    if(sn) return sn;
    const mine = (_netMyName() || 'YOU').slice(0, MAX_NAME);
    const peer = (_netSess.peerProfile && _netSess.peerProfile.name) || netFriendName(_netSess.peer) || fmtFriendId(_netSess.peer);
    return netHosting() ? [mine, peer] : [peer, mine];
}
// ONE side of a duel, named. P1/P2 is a slot number, and a slot number is what you write
// when you do not know who is in the slot -- but by the time a duel is running, both names
// are known on both sides. Every place that used to print a slot number asks here instead,
// so the HUD, the winner banner and the heart-lost line all say the same word for the same
// person. PLAYER 1 / PLAYER 2 survives only as the fallback it always should have been: a
// local duel on one keyboard, where the second player has no account and so has no name.
function duelSideName(i){
    i = i ? 1 : 0;
    const nms = (typeof netPlayerNames === 'function') ? netPlayerNames() : null;
    let n = nms ? String(nms[i] || '') : (i === 0 ? String(_netMyName() || '') : '');
    n = n.trim();
    return n ? n.slice(0, MAX_NAME) : ('PLAYER ' + (i + 1));
}
// The two players' device categories in PLAYER order (P0 = host, P1 = joiner), for the
// duel ready splash. Mine from _detectPlatform(); the peer's from its exchanged profile
// (null if an older client sent none -- that side just shows no badge). null = offline.
function netDuelPlatforms(){
    if(!netGameActive()) return null;
    const mine = _detectPlatform();
    const pp = _netSess.peerProfile || {};
    const peer = (typeof pp.platform === 'string') ? pp.platform : null;
    return netHosting() ? [mine, peer] : [peer, mine];
}
// The two duel snakes' LOOKS in PLAYER order (P0 = host, P1 = joiner). Each side
// knows its own config and the peer's exchanged profile, and both derive the pair
// the same way -- so the duel looks IDENTICAL on both screens. Previously each
// client rendered P0 with its OWN colour and P1 with the next index, so the two
// players saw different colours for the same snakes and never saw each other's
// cosmetics (the profile carried them; nothing read them). null = not online.
// Memoized: three call sites read this EVERY FRAME (HUD + both board draws), yet every
// input is fixed for the whole match -- the peer profile object only ever changes by
// reference, and the shop/settings are unreachable mid-duel.
var _netLookC = null;
function netDuelLook(){
    if(!netGameActive()) return null;
    // Spectating: the feeder already resolved the pair (including its own same-colour nudge),
    // so adopt it verbatim -- deriving it again here from a config that belongs to neither
    // player would show the watcher two snakes the players themselves never saw.
    const sl = (typeof netSpecLook === 'function') ? netSpecLook() : null;
    if(sl) return sl;
    const _pp = _netSess.peerProfile || null, _host = netHosting();
    if(_netLookC && _netLookC.pp === _pp && _netLookC.host === _host && _netLookC.col === (cfg.snakeColor|0)
       && _netLookC.wi === cfg.wornItems && _netLookC.nrc === !!cfg.noRemoteCosmetics) return _netLookC.val;
    const N = SNAKE_COLORS.length;
    const pp = _pp || {};
    const mine   = { c: (cfg.snakeColor|0) % N, i: cfg.wornItems || {} };
    // NETWORK setting: render the peer as a plain default snake -- no cosmetics and no
    // colour of its own. Purely a local view choice: it never crosses the wire and does
    // not touch the sim. `hid` names the slot the hidden snake sits in, because the
    // WINDSWEPT half of a look does not come from the profile at all (the sim owns it,
    // see _wsLook) and has to be suppressed at the draw.
    const hide = !!cfg.noRemoteCosmetics;
    const theirs = hide ? { c: 0, i: {} }
                 : { c: Math.abs(pp.color|0) % N,
                     i: (pp.shopItems && typeof pp.shopItems === 'object') ? pp.shopItems : {} };
    const a = _host ? mine : theirs;          // P0 is always the host
    const b = _host ? theirs : mine;          // P1 is always the joiner
    const hid = hide ? (_host ? 1 : 0) : -1;
    let c0 = a.c, c1 = b.c;
    // Same pick: one of the two has to move. Normally P1, by SLOT, so both clients agree
    // on the picture. A hidden peer forced to colour 0 is a local view already -- and the
    // slot rule would then recolour OUR OWN snake whenever we are the joiner, which is the
    // one thing this setting must never do. So the hidden side is the side that moves.
    if(c0 === c1){ if(hid === 0) c0 = (c0 + 1) % N; else c1 = (c1 + 1) % N; }
    const val = { c0, c1, i0: a.i, i1: b.i, hid };
    _netLookC = { pp:_pp, host:_host, col:cfg.snakeColor|0, wi:cfg.wornItems, nrc:!!cfg.noRemoteCosmetics, val };
    return val;
}
// How far into the game track we already are, measured on the SHARED clock: the music
// is anchored to the same start_pts as tick 0, so both clients place the loop at the
// same point instead of each starting it at pos 0 whenever its own tab arrived. 0 =
// not an online duel (or no clock yet): start the track at the beginning, as always.
function netMusicSeekSec(){
    const s = _netSess, p = netPts();
    if(!s || !s.game || !s.startPts || p == null) return 0;
    const dt = (p - s.startPts) / 1000;
    return dt > 0 ? dt : 0;
}
// MENU music position on the SHARED server clock (NOT a duel start -- just absolute PTS).
// musicPlay does `seekSec % loopLen`, so passing the absolute second count drops every
// client (on the same audio style) onto the same bar of the menu loop. 0 until the clock
// is synced, then they converge -- the game.js menu-music gate waits briefly for the sync.
function netMenuSeekSec(){ const p = netPts(); return p != null ? p/1000 : 0; }
function netDebugInfo(){
    return { base:NET_BASE, offline:netOffline(), rttMs:_netDbg.rtt, relayRttMs:_netDbg.relayRtt, relay:!!(_netSess&&_netSess.relay), path:_netDbg.path, serverClockOfsMs:_netDbg.srvOfs,
             pts:simTick, peerTickOfs:_netDbg.peerTkOfs, rollbacks:_rbDbg.rb, resimTicks:_rbDbg.resim, maxRewindTicks:_rbDbg.maxRew,
             inputDrops:_rbDbg.drop, congDrops:_netDbg.congDrop|0, desyncs:_rbDbg.desync, hashOk:_rbDbg.hashOk, hashLost:_rbDbg.hashLost|0, fixes:_rbDbg.fix|0, txRetries:_netDbg.retx|0, epoch:_netSess?_netSess.epoch:null,
             inRx:_netDbg.inRx, inTx:_netDbg.inTx, lastPeerInputs:_netDbg.inLog.slice(),
             peerLagMs:_netDbg.lag, peerPtsDeltaAvgMs:_netDbg.lagAvg, peerPtsDeltaMinMs:_netDbg.lagMin, peerPtsDeltaMaxMs:_netDbg.lagMax, peerPtsDeltaN:_netDbg.lagN, ptsSync:{ synced:_netSync.ofs!=null, offsetMs:_netSync.ofs, rttMs:_netSync.rtt, ageMs:_netSync.at?Date.now()-_netSync.at:null },
             latencyReport:{ ms:_netLat.value, ageMs:_netLat.at?Date.now()-_netLat.at:null }, friendsLatency:_netFriendsLat,
             session: _netSess ? { peer:_netSess.peer, role:_netSess.role, game:_netSess.game } : null,
             iceDeob:_netDbg.iceDeob|0, peerNet: _netSess ? (_netPeerNet[_netSess.peer] || null) : null,
             // 4.4, and the whole point of it: iceSignals vs iceBatches says how many
             // requests the batching actually saved, and srvQueueMs is the server telling
             // us how long its last answer waited for a worker.
             // ...and srvQueueFlight is what tells a busy HOST from a client queueing behind
             // itself: the same wait read against 1 is the server's load, against 3 it is ours.
             iceSignals:_netDbg.iceTx|0, iceBatches:_netDbg.iceBat|0, srvQueueMs:_netDbg.qMs|0,
             srvQueueFlight:_netQ.flight|0, selfStacked:netSelfStacked(),
             pace:{ hold:_netPace.hold, roster:_netFrHello ? 'hello' : 'friend' },
             flightMax:_netFlightMax,
             counts:_netCounts };
}

// ---- heartbeat: the one periodic request (presence + signal mailbox, ~60 s) ----
let _netCounts = { online:0, playing:0 };
let _netFriendsOnline = {};
let _netFriendsLat = {};
// Accepted friends currently IN a 1vs1, from the same authorization-gated presence delta
// as the online map. It is the entire discovery surface for spectating: a friend you can
// watch is a friend the server says is playing right now.
let _netFriendsPlaying = {};
// Open tournament lobbies the server announces to us: hosts whose address reaches it the
// same way ours does, i.e. the people in this room. Asked for only while a screen that
// shows them is open, and empty on a pre-4.1 server.
let _netTourneys = [];
// THE ONE LANDING PLACE for the announce, whichever request brought it -- the hello
// or the poll's tl. The tournament screens read the list as a list of rooms; an
// EVENT PAGE reads it as NEWS, because an event's open lobbies are served to its
// members regardless of network, and that is the only thing that tells a page
// already on screen that a tournament has opened.
function _netTtApply(v){
    _netTourneys = Array.isArray(v) ? v : [];
    if(typeof eventTourneySeen === 'function') eventTourneySeen(_netTourneys);
}
// Who wants it. The lobby lists it; the event page needs it as news and rides the
// poll it is already sending for `ev`, so it costs no request of its own.
function _netTlWant(){
    return phase === 'tourneyLobby' || (typeof eventTlWant === 'function' && eventTlWant());
}
// The server's contract MINOR, or -1 before the first hello. Features that need a newer
// server than 4.0 gate on this rather than on a failed POST.
let _netSrvMin = -1;
function netSrvMinor(){ return _netSrvMin; }
// ---- presence, as the server serves it (4.6): a cursor and deltas ----
// The cursor is the server's `friends_at`, never our clock. 0 = "I know nothing": every
// presence screen opens on it, so its first answer carries every accepted friend. A delta
// entry is a friend's WHOLE current state, so applying one blind is always right and a
// repeated row costs nothing. No ids go over the wire: the server knows the roster.
let _netFrSince = 0;
let _netFrSub = false;      // on a presence screen at the last tick: the edge is a screen opening
let _netFrPages = 0;        // continuation pages chained off one answer's friends_more
const NET_FR_PAGES = 8;     // ...bounded: a server that never stops saying "more" gets the next tick
// The screens with a friend's state on them. MY ID and the tournament lobby show none.
function _netFrScreen(){ return phase === 'duelLobby' || phase === 'friends'; }
// A presence screen opened: read it whole.
function netPresenceOpen(){ _netFrSince = 0; _netFrSub = true; }
// THE one place presence lands, whichever request brought it -- a poll's 200 or a hello.
// A 204 brings nothing and changes nothing: the cursor stands, the next read spans the
// longer interval.
function _netFrApply(r){
    if(!r || typeof r !== 'object') return;
    if(typeof r.online === 'number') _netCounts = { online:r.online|0, playing:r.playing|0 };
    const d = r.friends_delta;
    if(!d || typeof d !== 'object'){ _uiDirty = true; return; }
    for(const id in d){
        const e = d[id];
        if(!e || typeof e !== 'object') continue;
        const on = e.online === true;
        _netFriendsOnline[id] = on;
        _netFriendsLat[id] = (on && typeof e.latency === 'number') ? e.latency : null;
        _netFriendsPlaying[id] = e.playing === true;
        if(e.name) _netNameSeen(id, e.name);
        // The roster row the friends screen draws carries the same two fields.
        if(_netFr.list) for(const f of _netFr.list) if(f.id === id){ f.online = on; f.latency = _netFriendsLat[id]; }
    }
    if(typeof r.friends_at === 'number' && r.friends_at > 0) _netFrSince = r.friends_at;
    _uiDirty = true;
    // friends_more: the cap cut the answer short. Continue AT ONCE with the cursor just given,
    // never at the next tick -- a friend on the page not yet read is a friend shown wrong.
    if(r.friends_more === true){ if(_netFrPages < NET_FR_PAGES){ _netFrPages++; _netFrMore(); } }
    else _netFrPages = 0;
}
// One unheld poll on the solo lane: second in line behind whatever is out, never beside it.
async function _netFrMore(){
    const r = await _netGet('/api/poll.php?id=' + getPlayerId() + '&fs=' + _netFrSince, undefined, false, NET_BG_SOLO);
    if(r && r.signals && r.signals.length) r.signals.forEach(_netOnSignal);
    _netFrApply(r);
}
// Enabling STRICTLY OFFLINE stops the heartbeat, so presence stops being refreshed and
// would otherwise FREEZE at its last-known values -- friends left showing "online", a live-
// looking player count. Drop it all now so offline reads as offline, not as a stale snapshot.
function netOfflineClear(){
    _netCounts = { online:0, playing:0 }; _netFrSince = 0;
    _netFriendsOnline = {}; _netFriendsLat = {}; _netFriendsPlaying = {}; _netTourneys = []; _netSrvMin = -1;
    if(_netFr.list) for(const f of _netFr.list){ f.online = false; f.latency = null; }
    _uiDirty = true;
}
let _netFriendNames = (function(){ try{ return JSON.parse(localStorage.getItem('fok-snake-friend-names')||'{}') || {}; }catch(e){ return {}; } })();
function _netNameSeen(id, name){
    if(!/^[0-9a-f]{8}$/.test(id||'') || !name) return;
    const n = String(name).slice(0, MAX_NAME);
    if(_netFriendNames[id] === n) return;
    _netFriendNames[id] = n;
    try{ localStorage.setItem('fok-snake-friend-names', JSON.stringify(_netFriendNames)); }catch(e){}
}
function netFriendName(id){ return _netFriendNames[id] || null; }
// THE one landing place for what the server tells us unasked: the contract version and
// the operator's debug instruction. Both travel server-to-client ONLY -- a client cannot
// know either is due, so it can never be its job to ask -- which is why from 4.9 they ride
// EVERY poll answer with a body as well as every hello, and why a client on a screen
// holding a poll can stop beating without going deaf to them.
// A 204 is a body-less answer we synthesise as {ok,signals} (see _netGet), so `api` is
// absent there: leave the latch alone rather than reading its absence as a rollback.
function _netSrvSays(r){
    if(!r || typeof r !== 'object') return;
    if(typeof r.api === 'string'){
        const _srvMaj = _netApiMajor(r.api), _srvMin = _netApiMinor(r.api);   // re-evaluated on every answer: un-latches after a server rollback
        _netSrvMin = (_srvMaj === NET_API_BUILT && _srvMin !== null) ? _srvMin : -1;   // only a same-MAJOR minor means anything to us
        _netApiNewer = (_srvMaj !== null && _srvMaj > NET_API_BUILT);   // newer MAJOR gates online off
        _netApiOutdated = (_srvMaj === NET_API_BUILT && _srvMin > NET_API_BUILT_MINOR);   // newer MINOR: still works, but flag an update
    }
    // HONOUR the server's debug instruction: an operator flips it per player to
    // diagnose a client in the field without asking its user to do anything. Acted on
    // when the instruction CHANGES, not every answer -- a steady `false` must not
    // fight a developer who turned debug on locally, which is the 'self' state the
    // admin view exists to show. A change is the operator actually asking.
    if(typeof r.debug === 'boolean'){
        if(_netDbgSrv !== null && r.debug !== _netDbgSrv){
            cfg.debug = r.debug ? Math.max(1, cfg.debug|0) : 0;
            saveCfg(); _uiDirty = true;
        } else if(_netDbgSrv === null && r.debug && !(cfg.debug|0)){
            cfg.debug = 1; saveCfg(); _uiDirty = true;   // the first answer already carries an instruction
        }
        _netDbgSrv = r.debug;
    }
}
let _netHelloBusy = false, _netHelloSeen = false;
async function _netHello(){
    if(_netHelloBusy || netOffline() || typeof fetch !== 'function') return;   // deliberately NOT _netOk: see the api re-check below
    _netHelloBusy = true;
    const body = { id: getPlayerId() };
    { const n = _netMyName(); if(n) body.name = String(n).slice(0, MAX_NAME); }
    if(_netLat.pending && _netLat.value != null) body.latency = _netLat.value;   // the mandated report
    if(_netDuelEnd) body.duel_end = _netDuelEnd;   // applied server-side BEFORE duel_with, so one beat may carry both
    // s.peer, not just s.game: a SPECTATOR's synthetic session is game:true with a
    // deliberately EMPTY peer (net-spec.js), and an empty duel_with is not an absent one --
    // the server validates the id and refuses the whole heartbeat.
    if(_netSess && _netSess.game && _netSess.peer){
        body.duel_with = _netSess.peer;
        // Sent on EVERY beat while it holds, never once: the server reads an absent
        // flag as public, so a bare beat would hand the duel back to the friends list.
        if(cfg.privateDuels) body.duel_private = true;
    }
    // Presence rides a CURSOR (4.6): no ids, the server serves the caller's accepted friends
    // whose state changed after it. Asked for only where a friend's state is on screen.
    if(_netFrScreen()) body.friends_since = _netFrSince;
    // The ROSTER, which the friends_* maps above are not: they answer for ids we already
    // named, this is who our friends ARE -- pending rows, outgoing rows, names for ids this
    // device has never seen. Asked for only on the screen that shows it, and only so that
    // screen stops sending a friend.php list beside a heartbeat it was sending anyway.
    if(phase === 'friends') body.friends_list = true;
    // The announce is served only when asked for, so ask only while it can be seen.
    if(phase === 'tourneyLobby') body.tourneys = true;
    // The caller's own event rows, and the only way a client learns it is in an event at
    // all: the menu entry shows while the list is non-empty and hides when it is empty, and
    // a member that was removed finds the row simply gone. Asked for on the hello or poll
    // that PRECEDES a screen that needs it, never on every beat -- and never stored, because
    // the server is the roster (js/events.js).
    if(_netEvWant()) body.events = true;
    // Our own public addresses, both families (see net-rtc.js: the server can only observe the
    // one the browser happened to use). Sent on every hello once discovered -- the server no-ops
    // when nothing changed, so it costs nothing -- and needs no version gate: a 4.1 server
    // ignores the unknown key. The refresh is throttled by its own ~5min TTL, so riding the
    // heartbeat here is one RTCPeerConnection every few minutes, not one per hello.
    // ...and not DURING a match: a gather opens a throwaway peer connection and spends STUN
    // round trips beside the duel's own DataChannel, while the addresses it finds are only
    // ever used to open the NEXT one. What is already known still rides along; the TTL means
    // the first hello after the match refreshes.
    if(typeof netNetsRefresh === 'function'){
        if(!(typeof netGameActive === 'function' && netGameActive())) netNetsRefresh();
        const nets = netPublicNets();
        if(nets.length) body.nets = nets;
    }
    // auto_accept: presenting our QR / being on the add-friend screen IS the
    // consent, so the server accepts incoming friend requests immediately (the
    // contract mechanism; complements the client-side QR accept). Expires ~60s.
    if(phase === 'myId' || phase === 'friends' || Date.now() - _netMyIdAt < 60000) body.auto_accept = true;
    // REPORT what is true, never what was asked: the admin view tells an instruction
    // the client has not picked up yet ('pending') from a client that turned debug on
    // by itself ('self'), and deriving one from the other would erase that difference.
    if((cfg.debug|0) > 0) body.debug = true;
    const t0 = performance.now();
    const r = await _netPost('/api/hello.php', body, true);
    _netHelloBusy = false;
    if(r){ _netDbg.rtt = performance.now() - t0; if(r.now) _netDbg.srvOfs = r.now + _netDbg.rtt/2 - Date.now(); }   // now = server PTS in ms
    // Undelivered signals expire server-side at the signal TTL; we bail well before that
    // (NET_INVITE_STALE_MS): a sent invite -> NO ANSWER, a received dialog clears.
    if(_netHs.sent && Date.now() - _netHs.sentAt > NET_INVITE_STALE_MS){ _netHs.sent = null; _netLb.msg = 'NO ANSWER'; _uiDirty = true; }
    if(_netLb.invite && Date.now() - (_netLb.invite.at||0) > NET_INVITE_STALE_MS){ _netLb.invite = null; _uiDirty = true; }
    if(_netHs.accepting && Date.now() - _netHs.acceptingAt > NET_INVITE_STALE_MS){ _netHs.accepting = null; _netLb.msg = 'NO RESPONSE'; _uiDirty = true; }
    if(!r){ _netSrvErr = true; _uiDirty = true; return; }
    if(body.duel_end && _netDuelEnd === body.duel_end) _netDuelEnd = '';   // answered: the end is on record
    _netSrvErr = false;
    _netPaceOf(r);   // whether we may still hold a worker while we wait
    // The session's FIRST item drain rides the first ANSWERED heartbeat rather than a
    // load-time timer: a fixed delay after load lands in the middle of the resume burst,
    // where a wire this client is about to make busy looks quiet, while a hello that just
    // came back is the one moment we know for certain nothing else of ours is out. It also
    // arrives with the pace the server just named already applied.
    if(!_netHelloSeen){ _netHelloSeen = true; if(typeof itemKick === 'function') itemKick(); }
    _netSrvSays(r);
    if(body.latency != null) _netLat.pending = false;   // delivered; omit until the next measurement
    _netFrApply(r);   // the counters, and the presence delta where one was asked for
    if(body.tourneys) _netTtApply(r.tourneys);
    if(body.events) _netEvApply(r.events);
    // FEATURE-DETECTED, never version-gated: the roster on hello is a re-release of 4.4,
    // so a server answering "4.4" may or may not carry it. It answered once = it answers,
    // and the periodic friend.php list stands down. It never answered = that call stays,
    // which is the whole reason this is a fallback and not a minor check.
    if(body.friends_list && Array.isArray(r.friends)){ _netFrHello = true; _netFrAdopt(r.friends, false); }
    _netFrFlushRemovals();
    (r.signals||[]).forEach(_netOnSignal);
    _uiDirty = true;
}

// ---- adaptive signal poll: 1 Hz wherever matchmaking is live (lobby, the 1vs1
// menu, or a connection being set up), every 10 s in the main menu so invites
// still surface there, silent everywhere else (incl. during games: the
// DataChannel is the session). Gated on _netOk() -- offline clients never poll. ----
let _netPollTick = 0;
// 4.9: what a screen HOLDING a poll used to send a second request for now rides the poll.
// Two of the answers are FEATURE-DETECTED, never version-gated (a minor is re-released, so a
// server may answer "4.9" without them): the old route stands until the poll has served the
// answer once, exactly as _netFrHello does for the roster on hello.
let _netFrPoll = false;    // the poll serves `friends`: netFriendsEnter sends nothing beside it
let _netTtPoll = false;    // the poll serves `tourneys`: the tournament lobby's 5 s hello stands down
let _netFlWant = false;    // ask for the roster on the next poll (one-shot, armed by netFriendsEnter)
let _netTlAt = 0;          // when the announce last came back: tl makes the server answer AT ONCE, so it rides a tick of its own
const NET_TOURNEYS_MS = 5000;   // the announce tick the tournament lobby used to spend a hello on
let _netEvAt = 0;          // when the caller's event rows last came back
// ev ANSWERS AT ONCE, exactly like fl and tl: poll.php never 204s a request that asked for
// rows, so riding every poll would cut every hold short and spin an event screen into a hot
// loop. It gets a tick of its own for the same reason the announce does.
const NET_EVENTS_MS = 5000;
// aa, de and db cannot be seen in a 204, so a client only stops beating for them against a
// server that states 4.9. fl and tl are read off the answer instead (see the latches above).
function _netPoll49(){ return netSrvMinor() >= 9; }
// Is a held poll parked on a worker right now? While one is, a hello beside it is the
// request that can pay the pool's ~130 ms fork, and from 4.9 it buys nothing.
function _netHolding(){ return _netPollHoldEnd > 0 && Date.now() < _netPollHoldEnd; }
// THE beat rule: a hello is due unless a poll is already being one for us. Against a server
// older than 4.9 a poll is only most of a beat (no `api`, no debug instruction, no arming),
// so the hello stands whatever else is in flight.
function _netBeatDue(){ return !(_netPoll49() && _netHolding()); }
function _netPollDue(){
    // A match still needs the mailbox, at a fifth of the rate. A tournament one has to have
    // it -- roles sheets, patches and the result of OUR OWN node all arrive as signals, and
    // an undelivered one expires at the server's signal TTL -- and ANY of them can be asked to be watched, which
    // is the same mailbox and the one leg of the watch handshake that has nowhere else to
    // arrive. A duel that never polls is a duel nobody can ever start watching.
    if(_netSess && _netSess.game && !_netSess.reconnecting){
        // ...and once somebody IS reaching us, 1 Hz until they are through. Every leg of the
        // handshake is a signal and the node being asked is by definition a node in a match,
        // so the slow cadence lands on precisely the client that must answer fastest: the ask,
        // the offer and the ICE behind them each wait a poll, which together outlives the ask
        // itself, and the watcher sits on CONNECTING for the whole match with nothing wrong at
        // either end for any ladder to find.
        if(typeof specHandshaking === 'function' && specHandshaking()) return true;
        return _netPollTick % 5 === 0;   // reconnecting: poll so the re-handshake signals flow
    }
    if(phase === 'duelLobby' || phase === 'multiplayer' || phase === 'duelMenu' || phase === 'friends' || phase === 'myId') return true;
    // An event screen is a matchmaking screen: the four `event` signals arrive in the
    // ordinary mailbox, and a monitor's watch handshake -- ask, offer, ICE -- has nowhere
    // else to land at all.
    if(typeof eventScreen === 'function' && eventScreen()) return true;
    if(typeof tourneyActive === 'function' && tourneyActive()) return true;   // a held tournament reaches us wherever we are
    if(phase === 'tourneyLobby') return true;
    if(_netSess) return true;                        // offer/answer/ice in flight
    if(phase === 'menu') return _netPollTick % 10 === 0;
    return false;
}
// An unanswered offer is re-sent every 2s (max 3 tries) -- signals are one-shot
// and expire, so without this a single lost offer killed the whole attempt.
function _netHsTick(){
    if(!_netOk() || !_netHs.offerTo || inGame) return;   // reconnect re-offers are driven by the liveness loop, not here (no 3-try cap)
    // NOTE: do NOT stop on _netSess.game -- a relay session is game=true from the
    // first instant, which killed this retry on the default path. Only the peer's
    // ANSWER (handled in the signal switch) proves delivery and clears offerTo.
    const age = Date.now() - _netHs.offeredAt;
    if(age < 2000) return;
    if(_netHs.offerTries >= 3){ _netHs.offerTo = null; _netHs.offerPayload = null; _netLb.msg = 'NO RESPONSE'; _uiDirty = true; return; }
    _netHs.offerTries++; _netHs.offeredAt = Date.now();
    _netSignal(_netHs.offerTo, 'offer', _netHs.offerPayload);
}
let _netPollBusy = false, _netPollBusyAt = 0, _netPollAbort = null;
let _netPollDown = false;   // the last poll failed: the next success is the mailbox coming BACK
// Is a HELD poll open right now? Not a debug readout: every lane but the exempt one waits
// on this (see _netGapFlight). An unheld poll is a request like any other and is counted by
// _netFlight. _netRelayHeld is the same fact about the OTHER hold a client can have open --
// DEPRECATED(relay)'s held GET, set by _netRelayLoop -- and it lives here rather than beside
// that loop so the gate's own inputs are all in one file.
let _netPollHeld = false, _netRelayHeld = false;
// When the server lets the worker of the last HELD poll go, and before when no held poll
// may be armed. An abort closes the socket on our side and nothing else: the server learns of a
// gone client only when it writes, and the hold loop writes nothing until it answers, so
// an aborted hold stays parked on its worker until its own deadline. Arming another one
// before then puts this client on two workers, which on a small pool is the next request
// of ours queueing. The foreground hello drains the mailbox meanwhile.
let _netPollHoldEnd = 0, _netPollNotBefore = 0;
function _netPollResume(){ _netPollAbortNow(); _netPollNotBefore = _netPollHoldEnd; }
// Hold the connection OPEN on every matchmaking screen (1vs1 menu, lobby, friends,
// MY ID) and during a handshake: a long-poll -- the server HOLDS the request and
// re-checks the mailbox every ~20ms (a server-side poll, NOT a push), answering as
// soon as a signal lands or with 204 after `wait` seconds of real silence. The
// main menu keeps the cheap 10s short-poll (no held worker when merely idling).
//
// wait is capped server-side at 9. HTTP gives one response per request, so the
// request necessarily ends there -- the underlying TCP/TLS socket is NOT torn
// down, keep-alive reuses it for the next one. Re-arming happens the moment a
// response lands (below) rather than on the next tick, so exactly one request is
// outstanding at all times and the link is never left idle.
// A duel is being SET UP: an offer out, an offer in, or a session that has not started
// playing yet. It is the window where everything else this client sends competes with the
// handshake for the same worker pool, and the handshake is the part a player is watching.
function netForming(){
    return !!(_netHs.offerTo || _netHs.sent || _netHs.accepting || (_netSess && !_netSess.game)
           || (typeof specHandshaking === 'function' && specHandshaking()));
}
async function _netPollOnce(){
    if(_netPollBusy || _netSyncBusy || !_netOk() || !_netPollDue()) return;   // a clock sweep is exclusive: no re-arm until its last sample is back
    // The tournament screens are matchmaking screens like the rest, and hold like them:
    // between matches EVERY signal that moves the evening on -- a lobby join, the next
    // roles sheet, the offer for a match this client is about to answer -- arrives here,
    // and a 1s short-poll put a second on each leg of a handshake the 1vs1 path does in
    // ~150ms. Not the podium: that tournament is over and nothing further is coming. Not
    // during a match either -- _netSess.game short-circuits above, so the eight people
    // watching hold nothing while they watch.
    const _held = (_netSess && (!_netSess.game || _netSess.reconnecting)) || phase === 'duelLobby' || phase === 'multiplayer' || phase === 'duelMenu' || phase === 'friends' || phase === 'myId'
               || (typeof eventScreen === 'function' && eventScreen())
               || phase === 'tourneyLobby' || phase === 'tourneyBracket' || phase === 'tourneyRound' || phase === 'tourneyCeremony';   // long-poll during a reconnect so the re-handshake signals arrive fast
    // ...and only while the server still lets us. `hold:false` withdraws holding outright
    // (a held poll owns a worker for its whole duration -- the single biggest thing one
    // idle client costs a busy host); the 1 Hz tick below then carries the mailbox instead,
    // which is slower per signal but costs the server a worker only while it answers.
    const held = _netPace.hold && _held;
    // Withdrawing the hold must not COST the server requests. Falling back to the 1s tick
    // sends five unheld polls where the 5 s held one sent a single request: cheaper per
    // request, five times as many of them, and the count in flight is the thing the whole
    // pacing contract is about. So when we wanted to hold and were not allowed to, read the
    // mailbox where the hold's answer would have landed instead -- "poll without waiting and
    // lean on the heartbeat", still well inside an undelivered signal's life.
    //
    // ONLY while merely browsing, which is also the only tier the server withdraws the hold
    // from first. Anything with a handshake in flight keeps the 1s tick: the offer ladder
    // retries every 2s and gives up after three, so a mailbox read that lands seconds late
    // would answer an offer that has already been abandoned at the other end.
    const _idle = !_netSess && !netForming()
               && !(typeof tourneyActive === 'function' && tourneyActive());
    if(_held && !held && _idle && (_netPollTick % NET_UNHELD_EVERY)) return;
    if(held && Date.now() < _netPollNotBefore) return;   // the aborted hold is still parked on its worker
    _netPollBusy = true; _netPollBusyAt = Date.now();
    _netDbg.pollAt = performance.now(); _netDbg.pollHeld = held;   // debug overlay: is a connection open right now?
    _netPollHeld = held;
    _netPollHoldEnd = held ? Date.now() + NET_POLL_S * 1000 + 500 : 0;
    _netPollAbort = (typeof AbortController === 'function') ? new AbortController() : null;
    // A HELD poll goes out ungated: it is the parked slot the contract allows beside one
    // other request, and holding it back would only park the mailbox itself. An UNHELD one
    // is an ordinary request and takes the solo lane like any other -- second in line rather
    // than beside, which is the whole rule.
    // fs: on a presence screen the poll's return carries the friend delta, the counters and
    // the hold decision (4.6), so those screens send no hello of their own.
    const fs = _netFrScreen() ? '&fs=' + _netFrSince : '';
    // ...and with it (4.9) the rest of what a holding screen used to send a hello for.
    // fl and tl make the server ANSWER AT ONCE -- a screen that just opened is not waiting
    // for a signal that is not coming -- so tl rides a 5 s tick of its own rather than every
    // poll, or the tournament lobby's hold would never stand. aa only ARMS; clearing
    // auto-accept early stays hello's, and the window lapses on its own either way.
    const de = (_netPoll49() && _netDuelEnd) ? _netDuelEnd : '';
    const fl = _netFlWant;
    const tl = _netTlWant() && Date.now() - _netTlAt >= NET_TOURNEYS_MS;
    const ev = _netEvWant() && Date.now() - _netEvAt >= NET_EVENTS_MS;
    const aa = _netPoll49() && (phase === 'myId' || phase === 'friends' || Date.now() - _netMyIdAt < 60000);
    const q = fs + (de ? '&de=' + de : '')
                 + (_netPoll49() ? '&db=' + ((cfg.debug|0) > 0 ? 1 : 0) : '')   // REPORT what is true: a poll that never says is never woken with an instruction
                 + (aa ? '&aa=1' : '') + (fl ? '&fl=1' : '') + (tl ? '&tl=1' : '') + (ev ? '&ev=1' : '');
    const r = await _netGet('/api/poll.php?id=' + getPlayerId() + (held ? '&wait=' + NET_POLL_S : '') + q,
                            _netPollAbort ? _netPollAbort.signal : undefined, held, held ? undefined : NET_BG_SOLO);
    _netPollBusy = false; _netPollHeld = false; _netPollAbort = null; _netDbg.pollAt = 0;
    if(r) _netPollHoldEnd = 0;   // answered: the worker is free. An abort or a failure leaves the deadline standing.
    if(r && r.signals && r.signals.length) r.signals.forEach(_netOnSignal);
    if(r){
        _netSrvSays(r);   // api + the operator's debug instruction: on every body, so a client that has stopped beating still hears both
        _netPaceOf(r); _netFrApply(r);
        // The end is applied server-side BEFORE the hold, so a 204 records it too -- and a
        // 204 is the answer we synthesise, which is why any answer at all clears it.
        if(de && _netDuelEnd === de) _netDuelEnd = '';
        // Re-derived from the answer, never latched once: a server that stops serving one of
        // these -- a rollback, a re-released minor -- puts its fallback back, the same way
        // _netSrvSays un-latches the minor rather than trusting what it saw before.
        if(fl){ _netFlWant = false; _netFrPoll = Array.isArray(r.friends); if(_netFrPoll) _netFrAdopt(r.friends, false); }
        if(tl){ _netTlAt = Date.now(); _netTtPoll = Array.isArray(r.tourneys); if(_netTtPoll) _netTtApply(r.tourneys); }
        if(ev){ _netEvAt = Date.now(); _netEvApply(r.events); }
    }
    // The mailbox was down and is back. A push may have died in between (the server drops an
    // undelivered signal at its TTL), and only the whole picture recovers one: hand a held
    // tournament the doubt -- AFTER the drain above, so what this answer carried is already
    // in. Edge-triggered: once per outage, never per failure.
    if(!r) _netPollDown = true;
    else if(_netPollDown){ _netPollDown = false; if(typeof tourneyMailboxLost === 'function') tourneyMailboxLost(); }
    // Straight back in, through the slot below. Only on a SUCCESSFUL reply: a failure (or an
    // abort from backgrounding) falls through to the 1s tick, which is the backoff that
    // stops a broken server from spinning this into a hot loop.
    if(held && r && _netOk() && !(typeof document !== 'undefined' && document.hidden)) _netPollArm();
}
// THE SLOT. What is due goes out after the poll answers and before the next one is armed --
// one hold at most -- so a screen that holds a poll for as long as it is open still gets its
// background work away, and never sends it BESIDE the hold. THE RULE, kept apart from the
// waiting so it reads at a glance and tests without a clock, exactly like _netGapWait: the
// poll may not park a worker again while work of ours is queued at the gate or in flight.
function _netArmHold(gapN, flight){ return gapN > 0 || flight > 0; }
// ...and the wait itself, bounded on the gate's own count, because a request that never
// settles must not cost the mailbox its arm.
async function _netPollArm(){
    if(!_netTimers){ _netPollOnce(); return; }
    for(let i = 0; i < NET_GAP_TRIES && _netArmHold(_netGapN, _netFlight); i++)
        await new Promise(res => setTimeout(res, NET_GAP_STEP_MS));
    if(_netOk() && !(typeof document !== 'undefined' && document.hidden)) _netPollOnce();
}
if(_netTimers) setInterval(()=>_netTick(), 1000);
// The 1 Hz housekeeping tick, named so the rules inside it can be driven by a test.
function _netTick(){
    _netPollTick++;
    if(!_netOk()) return;
    _netHsTick();
    // A held poll answers within 8s; anything past 15s is a zombie (frozen tab,
    // dead socket). Cut it loose so the loop can breathe again.
    if(_netPollBusy && Date.now() - _netPollBusyAt > 15000) _netPollAbortNow();
    // A presence screen just opened by whatever route: read it whole (cursor 0).
    const sub = _netFrScreen();
    if(sub && !_netFrSub) _netFrSince = 0;
    _netFrSub = sub;
    // The lobby and friends screens refresh out of the poll they hold (fs, 4.6): friend
    // state, counters and hold ride its return. From 4.9 the tournament lobby joins them --
    // `tl` puts the announce on the same poll -- and this 5 s hello, which was 2-wide every
    // five seconds and the most expensive of the three, stands down the moment the poll has
    // served the list once. It stays as the fallback for a server that does not, because a
    // re-released minor may answer 4.9 without it.
    if(phase === 'tourneyLobby' && !_netTtPoll && _netPollTick % 5 === 0) _netHello();
    _netPollOnce();
}

// ---- Connection lifecycle across focus loss. A backgrounded tab has its held
// long-poll frozen or killed by the OS: the fetch may never settle, leaving
// _netPollBusy latched forever and the client deaf to every signal until a
// reload. So: drop the connection on blur, build a FRESH one on focus. ----
function _netPollAbortNow(){
    if(_netPollAbort){ try{ _netPollAbort.abort(); }catch(e){} _netPollAbort = null; }
    _netPollBusy = false; _netPollHeld = false;
}
if(typeof document !== 'undefined' && document.addEventListener){
    document.addEventListener('visibilitychange', ()=>{
        if(document.hidden){ _netHiddenAt = Date.now(); _netPollAbortNow(); return; }   // backgrounded: note when, to measure how long
        // Foregrounded: nothing from before is trustworthy -- start over.
        const awayMs = _netHiddenAt ? Date.now() - _netHiddenAt : 0; _netHiddenAt = 0;
        _netPollResume();   // drop the latch, and no held poll before the aborted one's worker is free
        _netHelloBusy = false;
        // SEQUENCED, not fanned out. This used to fire a clock sync, a heartbeat and a
        // roster read into the same instant -- and the clock sample was then taken against
        // the two requests standing beside it, which is the one thing a sample must never
        // be. A resume is exactly when a client re-anchors, so a sample polluted here lands
        // in the offset the whole lockstep timeline hangs from. Heartbeat first (it is what
        // tells the server we are back), the anchor second, once the wire is our own again;
        // the roster comes with the heartbeat or on its own tick above.
        _netFrSince = 0;   // whatever presence we held is as old as the sleep: read it whole
        if(_netOk()) _netHello().then(()=>_netTimeSync(true), ()=>_netTimeSync(true));
        // A screen-off/background almost always kills the p2p transport (ICE times out while
        // suspended), but performance.now() and the timers freeze -- so the silence timer can
        // miss it on wake. Measure the away time on the WALL clock and rebuild if it was more
        // than a blink; a rebuild that turns out unnecessary just re-establishes cheaply.
        if(_netSess && _netSess.game && !_netSess.relay && !_netSess.reconnectAt && awayMs > RB_WARN_MS) _netReconnect(_netSess);
        // A long background is where a phone changes network without ever going offline (wifi to
        // cellular, or a different wifi on the way home). Re-gather rather than keep reporting an
        // address that now belongs to somebody else's line.
        if(typeof netNetsRefresh === 'function') netNetsRefresh(awayMs > NET_NETS_HIDE_MS);
    });
}
// Coming back online is the other network change worth re-gathering for, and the only one the
// browser tells us about outright.
if(typeof addEventListener === 'function') addEventListener('online', ()=>{ if(typeof netNetsRefresh === 'function') netNetsRefresh(true); });

// ---- Unload: reload / tab close / browser quit. Every timeout we have is a JS
// timer that dies with the page, so a leaving client can only be polite on the
// way out -- otherwise the peer waits for ITS timeout (3s in-game, the staleness window mid-
// handshake). A normal fetch() is cancelled the instant the page goes away;
// sendBeacon is the one send the browser still delivers after teardown.
//
// beforeunload ONLY, deliberately: pagehide also fires on a mere backgrounding
// (iOS), and saying goodbye there would kill a session the ordinary game logic
// already handles. Caveat: iOS Safari often skips beforeunload, so a swipe-close
// there still falls back to the peer's own liveness timeout -- by design, since
// the alternative is ending live games every time the user switches apps. ----
function _netBeacon(path, body){
    try{
        if(typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
        const b = (typeof Blob === 'function') ? new Blob([JSON.stringify(body)], { type:'application/json' }) : JSON.stringify(body);
        return !!navigator.sendBeacon(NET_BASE + path, b);
    }catch(e){ return false; }
}
function _netUnload(){
    if(_netOk()){
        const me = getPlayerId(), told = {};
        const tell = (to, type) => {
            if(!to || told[to]) return;              // one goodbye per peer, whatever their role was
            told[to] = 1;
            _netBeacon('/api/signal.php', { id:me, to, type, payload:'' });
        };
        if(_netSess)       tell(_netSess.peer, 'bye');       // a running or forming match
        if(_netHs.sent)    tell(_netHs.sent, 'bye');         // an invite nobody has answered yet
        if(_netHs.accepting) tell(_netHs.accepting, 'bye');  // we accepted, their offer is in flight
        if(_netHs.offerTo) tell(_netHs.offerTo, 'bye');      // our offer, still unanswered
        if(_netLb.invite)  tell(_netLb.invite.from, 'decline');   // their invite is open on our screen: we are gone = unavailable
        if(_netSeekT)      _netBeacon('/api/match.php', { id:me, action:'cancel' });   // do not leave a ghost in the queue
    }
    // The seek POST would be cancelled mid-flight; the beacon above already did it.
    if(_netSeekT){ clearInterval(_netSeekT); _netSeekT = null; _netLb.seeking = false; }
    _netPollAbortNow();   // abort() really does close the held long-poll's socket
    _netHsClear();
    _netTeardown();       // DataChannel + RTCPeerConnection closed, relay poll aborted, timers cleared
}
if(typeof window !== 'undefined' && window.addEventListener) window.addEventListener('beforeunload', _netUnload);

// The ACTION ENDPOINTS -- tournament.php and event.php -- are one shape: always POST,
// always {id, action, ...}, always answered by one switch. So they are wrapped once.
//
// NET_BG_SOLO for both, and the reason is the same for both: a player is waiting on
// the screen this fills right now. It is not background, but the cost the gate exists
// for is paid per request IN FLIGHT -- what the server measured was this kind of call
// and start.php leaving in the same millisecond and both waiting 128 ms for a worker
// on an idle host. Second in line costs one wait; side by side costs two.
async function netActionPost(path, action, extra){
    const body = Object.assign({ id:getPlayerId(), action }, extra || {});
    return await _netPostRes(path, body, NET_BG_SOLO);
}

// ---- friendships (friend.php): relations exist only once the SERVER recorded
// them -- the local list is just the UI seed. Adds run the request handshake,
// removals reach the server (queued through localStorage when offline). ----
let _netFr = { list:null, at:0, loading:false, sel:0, confirm:null, confirmSel:1, msg:'' };
// Has a hello ever come back carrying the roster? Latched on the first one that does, and
// never re-checked: this is a property of the server, not of a response.
var _netFrHello = false;
var _netMyIdAt = 0;   // last moment the MY ID screen (our QR) was on display
// Friendships that reached ACCEPTED at least once: an accepted id vanishing from
// the authoritative server list means the PEER removed it -- mirror that locally.
let _netFrOk = (function(){ try{ return JSON.parse(localStorage.getItem('fok-snake-friend-ok')||'{}')||{}; }catch(e){ return {}; } })();
// TWO different facts, deliberately kept apart. _netFrOk = the server called this
// friendship ACCEPTED. _netFrSent = the server merely HAS our request. Only the second
// one decides whether to ask again: a pending row is stored (a,b)-keyed and never expires
// server-side, so re-asking every launch until the peer happens to accept is pure noise --
// and it never converged, because the answer to a delivered request is 'pending', which
// the acceptance marker refuses to record.
let _netFrSent = (function(){ try{ return JSON.parse(localStorage.getItem('fok-snake-friend-sent')||'{}')||{}; }catch(e){ return {}; } })();
function _netFrSentSave(){ try{ localStorage.setItem('fok-snake-friend-sent', JSON.stringify(_netFrSent)); }catch(e){} }
function _netFrSentMark(id){ if(!_netFrSent[id]){ _netFrSent[id]=1; _netFrSentSave(); } }
// A RESTORE re-asserts the player id out of the backup, so every marker we hold was
// recorded against a DIFFERENT identity. Keeping them would silently suppress exactly the
// requests the restored save needs. Cleared from _applyRestoredConfig (storage.js).
function netFriendMarkersReset(){ _netFrOk = {}; _netFrSent = {}; _netFrOkSave(); _netFrSentSave(); }
function _netFrOkSave(){ try{ localStorage.setItem('fok-snake-friend-ok', JSON.stringify(_netFrOk)); }catch(e){} }
function _netFrOkMark(id){ if(!_netFrOk[id]){ _netFrOk[id]=1; _netFrOkSave(); } }
function _netFrOkClear(id){ if(_netFrOk[id]){ delete _netFrOk[id]; _netFrOkSave(); } }
const _netFrRequested = {};   // id -> last attempt ms (time-based retry, NOT a permanent latch)
let _netFrBannedUntil = 0;    // 429 seen: quiet for a minute, then let a user-driven request re-check
function netFriendBanned(){ return Date.now() < _netFrBannedUntil; }
// _netPostRes, not _netPost: friend.php answers 429 for the 1h request ban, and the
// status-blind variant made that indistinguishable from a blip -- the UI then sat on
// 'NOT FRIENDS YET - RETRY IN A MOMENT' for an hour of a condition that will not clear.
// 3.5 throttles the 'request' action per id: ~1s between requests, then a 60s cooldown
// after a streak, on top of the 1h spam ban. retry_after carries the wait in seconds;
// without it (a pre-3.5 server, or a body-less 429) fall back to a minute.
function _netFrWait(res){ const w = res.body && +res.body.retry_after; return w > 0 ? Math.min(w, 3600) : 60; }
// bg: everything periodic or deferred -- the roster read and the queued removals -- is
// paced with the rest of the background traffic, and waits out a held poll with it. A
// 'request' and an 'accept' are NOT: somebody pressed a button and the invite path awaits
// the answer before it may offer at all, so those take the exempt lane -- never beside
// another request of ours, but never held back for a poll either.
function _netFriendApi(action, peer, bg){
    const body = { id: getPlayerId(), action };
    if(peer) body.peer = peer;
    return _netPostRes('/api/friend.php', body, bg).then(res => {
        if(res.status === 429) _netFrBannedUntil = Date.now() + _netFrWait(res)*1000;   // re-checked, not trusted: quiet for the stated wait, then try again
        return res.json;
    });
}
// The QR-success treatment for friendship events: jingle + confetti + the text
// on whichever social screen is (or gets) opened.
function _netFrCelebrate(text){
    Snd.sfxPlay('achievement', cfg.music);
    if(typeof spawnConfetti === 'function') spawnConfetti();
    _netFr.msg = text;
    _netLb.msg = text;
    _duelMsg = text; _duelMsgAt = _msgNow();
    _uiDirty = true;
}
// Returns a promise for the request's outcome (null when nothing was sent), so a
// caller that NEEDS the friendship to exist -- the invite path -- can wait for it
// instead of racing it.
function netFriendRequest(id){
    // Retry after 30s: a request lost to a blip must not block the friendship
    // (and therefore every future invite, which is friendship-gated) forever.
    if(!_netOk() || _netFrOk[id] || _netFrSent[id] || netFriendBanned()) return null;
    if(_netFrRequested[id] && Date.now() - _netFrRequested[id] < 30000) return null;
    _netFrRequested[id] = Date.now();
    const p = _netFriendApi('request', id, NET_BG_SOLO);
    if(!p || !p.then) return null;
    return p.then(r => {
        // Delivered: the server holds the row from here, whatever the peer does about it.
        if(r) _netFrSentMark(id);
        // 'accepted' = server auto-match (crossing requests, race-proof since
        // v0.14.1). React now instead of waiting for the async 'friend' signal.
        if(r && r.state === 'accepted' && !_netFrOk[id]){
            _netFrOkMark(id); addFriend(id);
            _netFrCelebrate((netFriendName(id) || fmtFriendId(id)) + ' - YOU ARE FRIENDS!');
            _netFrRefresh(false);
        }
        return r;
    });
}
// User-driven ADD FRIEND. The entry screen must not close on an ID that does not
// exist, so this one reports the server's verdict instead of firing and forgetting:
// it bypasses netFriendRequest's soft gates (a person retyping a corrected ID must
// not be told to wait 30s for their own previous attempt) and reads the STATUS, not
// just the body -- 429 is the request ban / spam cooldown and will not clear on a
// retry, while a refused peer is an ID nobody owns. No answer at all stays
// offline-safe: the friend is kept locally and the background handshake retries.
// Resolves { ok, state } | { offline:true } | { error:'unknown'|'rate' }.
function netFriendVerify(id){
    if(!_netOk()) return Promise.resolve({ offline:true });
    if(netFriendBanned()) return Promise.resolve({ error:'rate', wait:Math.ceil((_netFrBannedUntil-Date.now())/1000) });
    _netFrRequested[id] = Date.now();
    return _netPostRes('/api/friend.php', { id:getPlayerId(), action:'request', peer:id }, NET_BG_SOLO).then(res => {
        if(res.status === 429){ const w=_netFrWait(res); _netFrBannedUntil = Date.now() + w*1000; return { error:'rate', wait:w }; }
        if(!res.status || res.status >= 500) return { offline:true };   // no answer / server fault: not a verdict on the ID
        if(!res.json) return { error:'unknown' };   // 4xx: the server refused this peer outright
        // API 3.5: exists:false = nobody ever registered that id, nothing was recorded and
        // there is no 'state'. A pre-3.5 server omits the field, and absence is NOT a
        // verdict -- fall through to the state it did answer with.
        if(res.json.exists === false) return { error:'unknown' };
        const st = res.json.state;
        if(st === 'accepted' && !_netFrOk[id]){ _netFrOkMark(id); _netFrRefresh(false); }
        return { ok:true, state:st };
    }, () => ({ offline:true }));
}
// The MY ID screen opened: one hello now, so the server arms auto-accept for the QR about
// to be shown instead of waiting for the beat (up to a minute). The screen's own poll
// carries the request itself the moment it lands; the client-side accept is what answers
// it, this only lets the server accept on our behalf meanwhile.
function netMyIdEnter(){
    _netMyIdAt = Date.now();
    // From 4.9 the screen's own poll arms it with `aa`, on the request it was making anyway.
    if(_netOk() && !_netPoll49()) _netHello();
}
function netFriendsEnter(){
    _netFr.sel = 0; _netFr.confirm = null; _netFr.msg = '';
    netPresenceOpen();
    // The roster rides the poll this screen is about to hold anyway (`fl`, 4.9), so nothing
    // travels beside it -- the ask costs the request we were making regardless. Until the
    // poll has served it once, the old route stands: the heartbeat where the server puts the
    // roster on hello, friend.php where it does not. The migration friend.php runs has
    // already happened once at startup, whichever route this screen takes.
    _netFlWant = true;
    if(_netFrPoll) return;
    if(_netFrHello) _netHello();
    else _netFrRefresh(true);
}
function _netFrRefresh(migrate){
    if(!_netOk() || _netFr.loading) return;
    _netFr.loading = true;
    _netFriendApi('list', null, true).then(r => {
        _netFr.loading = false;
        if(r && Array.isArray(r.friends)) _netFrAdopt(r.friends, migrate);
    });
}
// THE one place a roster is read, whichever request brought it. hello's friends_list and
// friend.php's list answer byte for byte, and a roster that meant different things by the
// route it arrived on would be a roster nothing could trust.
// The migrate pass fires only for ids the server does not list AND we have never sent --
// a restored backup or friends added offline -- so it is silent on a synced client and a
// one-time trickle otherwise. It is SPACED because the server admits one friend.php call
// per second per caller: a bare loop got one through, left the rest unsent, and repeated
// the identical burst next launch -- never converging, while looking like an abuser.
const NET_FR_MIG_MS = 1000;
var _netFrMigQ = [], _netFrMigT = 0;
function _netFrMigPush(id){ if(_netFrMigQ.indexOf(id) < 0) _netFrMigQ.push(id); _netFrMigArm(); }
function _netFrMigArm(){
    if(_netFrMigT || !_netFrMigQ.length || typeof setTimeout !== 'function') return;
    _netFrMigT = setTimeout(function(){
        _netFrMigT = 0;
        const id = _netFrMigQ.shift();
        if(id) netFriendRequest(id);
        _netFrMigArm();
    }, NET_FR_MIG_MS);
}
function _netFrAdopt(list, migrate){
    _netFr.list = list; _netFr.at = Date.now();
    const seen = {};
    for(const f of list){
        seen[f.id] = true;
        if(f.name) _netNameSeen(f.id, f.name);
        if(f.state === 'accepted') _netFrOkMark(f.id);
        // an incoming request from someone we also added locally: accept right away
        if(f.state === 'pending' && !f.outgoing && getFriends().indexOf(f.id) >= 0) _netFrAccept(f.id);
    }
    for(const id of getFriends()){
        if(seen[id]) continue;
        if(_netFrOk[id]){
            // Was accepted, now gone from the server: the peer ended it. Mirror
            // the removal -- one side cancelled means GONE, no manual cleanup.
            removeFriend(id); _netFrOkClear(id);
            const gnm = netFriendName(id) || fmtFriendId(id);
            _netFr.msg = gnm + ' REMOVED THE FRIENDSHIP';
            _netLb.msg = _netFr.msg; _duelMsg = _netFr.msg; _duelMsgAt = _msgNow();
        } else if(migrate) _netFrMigPush(id);   // never synced: run the handshake, one per second
    }
    _uiDirty = true;
}
function _netFrAccept(id){
    _netFrOkMark(id);
    if(!_netOk()) return;
    _netFriendApi('accept', id, NET_BG_SOLO).then(r => {
        if(r){ _netFr.msg = 'ACCEPTED ' + (netFriendName(id) || fmtFriendId(id)); _netFrRefresh(false); }
        _uiDirty = true;
    });
    addFriend(id);   // mutual: they are our friend locally too
}
// Removal: local list immediately; the server best-effort now, queued (and
// flushed on later hellos) when it cannot be reached -- the relation must die
// server-side too, since the server only serves data between recorded friends.
function _netFrRmQueue(){ try{ return JSON.parse(localStorage.getItem('fok-snake-friend-rm')||'[]')||[]; }catch(e){ return []; } }
function _netFrRmSave(q){ try{ localStorage.setItem('fok-snake-friend-rm', JSON.stringify(q)); }catch(e){} }
function _netFrRemove(id){
    _netFrOkClear(id);
    removeFriend(id);
    if(_netFr.list) _netFr.list = _netFr.list.filter(f => f.id !== id);
    delete _netFrRequested[id];
    _netFr.msg = 'REMOVED ' + (netFriendName(id) || fmtFriendId(id));
    const done = _netFriendApi('remove', id, true);
    if(done && done.then) done.then(r => { if(!r){ const q=_netFrRmQueue(); if(q.indexOf(id) < 0){ q.push(id); _netFrRmSave(q); } } });
    _uiDirty = true;
}
function _netFrFlushRemovals(){
    const q = _netFrRmQueue();
    if(!q.length || !_netOk()) return;
    for(const id of q.slice()) _netFriendApi('remove', id, true).then(r => { if(r) _netFrRmSave(_netFrRmQueue().filter(x => x !== id)); });
}
// Rows for the FRIENDS screen: the server list is authoritative when present;
// local-only ids show as NOT SYNCED (handshake pending / offline).
function _netFrRows(){
    const rows = [], seen = {};
    if(_netFr.list) for(const f of _netFr.list){ seen[f.id]=true; rows.push({ id:f.id, state:f.state, outgoing:!!f.outgoing, online:f.online===true, latency:(f.latency==null?null:f.latency|0) }); }
    for(const id of getFriends()) if(!seen[id]) rows.push({ id, state:'local', outgoing:true, online:false, latency:null });
    return rows;
}

// ---- global highscores ----
// The classic-game input log: tick-stamped [tick, code] pairs recorded main-side,
// sent with the score as replay material (server-side validation, see API.md).
// Codes: 0-3 steer URDL-order (see _netDirCode), 4-7 boost start + dir, 8 boost end.
let _netSeed = 0, _netInputs = [];
function _netDirCode(d){ return d.y < 0 ? 0 : d.x > 0 ? 1 : d.y > 0 ? 2 : 3; }
function netNoteGameStart(seed){ _netSeed = seed>>>0; _netInputs = []; }
// tk (optional) pins the authored tick: boost transitions are issued beside the sim
// (worker home included) and arrive here via a tick-stamped event, while the mirror's
// simTick lags a frame behind.
function _netLog(code, tk){ if(inGame && !players && _netInputs.length < 16384) _netInputs.push([(tk == null ? simTick : tk)|0, code]); }
function netLogDir(d){ _netLog(_netDirCode(d)); }
function netLogBoost(d, tk){ _netLog(4 + _netDirCode(d), tk); }
function netLogBoostEnd(tk){ _netLog(8, tk); }
function netSubmitScore(name, sc, lvl, completed){
    if(!_netOk() || !(sc > 0)) return;
    const pts = netPts();
    _netPost('/api/scores.php', {
        id: getPlayerId(), name: String(name).slice(0,MAX_NAME),
        score: sc|0, level: Math.max(1, lvl|0),
        diff: cfg.diff|0, color: cfg.snakeColor|0, shopItems: cfg.wornItems||{},
        platform: _detectPlatform(),   // device category (pc/mobile/tv/console) for the global board
        seed: _netSeed, inputs: _netInputs,
        completed: !!completed,   // the run CLEARED level 10 (a win), not merely reached it
        pts: pts != null ? pts : undefined,   // the game-over moment on the PTS clock
    }, true).then(r => { if(r){ _netScores = null; _netScoresAt = 0; } });   // bust the cache: the tab shows the fresh board
}
let _netScores = null, _netScoresAt = 0, _netScoresLoading = false;
function netFetchScores(){   // called by the GLOBAL tab draw; cached 60s, single-flight
    if(!_netOk() || _netScoresLoading) return;
    if(_netScores && Date.now() - _netScoresAt < 60000) return;
    _netScoresLoading = true; _uiDirty = true;
    _netGet('/api/scores.php?limit=100', undefined, false, true).then(r => {
        _netScoresLoading = false;
        if(r && Array.isArray(r.scores)){ _netScores = r.scores; _netScoresAt = Date.now(); }
        _uiDirty = true;
    });
}

// ---- boot: the NET_HELLO_MS heartbeat, always-on while online is allowed. First one after
// a short delay so boot itself never touches the network path. All soft-fail. ----
// The beat's PHASE is load time and nothing else: each one re-arms off the previous, never
// off Date.now() and never off the shared server clock, so two clients sit on the same
// millisecond only if they loaded on it. A served jitter budget used to add an offset on top
// of that; it bought nothing, because what separates a roomful of clients is the gate they
// all queue at (NET_GAP_MS), which spaces the calls rather than the sessions making them.
if(_netTimers){
    // 4.9: a poll is a COMPLETE beat -- presence, `api`, the debug instruction and (with
    // `aa`) auto-accept all ride it -- so a client holding one owes no hello at all, and the
    // beat beside it was the last of the three standing pairs. What only a hello carries is
    // what the client itself knows is due: a rename (typed on a screen that holds nothing),
    // its nets (refreshed at the multiplayer door), a latency reading (display only) and
    // duel_with during a game, where no poll is held either. The beat resumes the moment the
    // hold does not stand.
    (function _netBeat(){ setTimeout(()=>{ if(_netBeatDue()) _netHello(); _netBeat(); }, NET_HELLO_MS); })();
    setTimeout(_netHello, 3000);
    setTimeout(()=>{ if(_netOk()) _netFrRefresh(true); }, 3500);   // contract: reconcile the local friend list vs the server at startup
    // Sync the clock DURING the coin-drop splash so menu music can start already aligned to
    // the shared server time: the first sample anchors at once, the rest refine. Soft:
    // offline / no-fetch just skips it.
    setTimeout(()=>{ if(_netOk() && _netSync.ofs == null) _netTimeSync(true); }, 0);
    // Daily automatic cloud backup (opt-in). One check a few seconds after boot, then hourly;
    // the once-a-day throttle lives in _maybeAutoCloudBackup so these fire freely.
    setTimeout(()=>{ if(typeof _maybeAutoCloudBackup === 'function') _maybeAutoCloudBackup(); }, 6000);
    setInterval(()=>{ if(typeof _maybeAutoCloudBackup === 'function') _maybeAutoCloudBackup(); }, 3600000);
}
