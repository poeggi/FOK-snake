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
const NET_API_BUILT = 3;    // the contract MAJOR this client implements (API.md: Versioning; v3 = t.txt clock, epoch-keyed starts + sync gate, remote debug flag, 3.1 = peer-net hint)
// The server's `api` is a "MAJOR.MINOR" string. Only the MAJOR gates compatibility -- a
// newer MINOR on the same major is purely additive. Returns the major integer, or null
// if unparseable (a soft failure, like every network failure here: no flags raised).
const NET_API_BUILT_MINOR = 4;   // built against 3.4 (3.1 peer-net hint + 3.2 relay pull/piggyback + 3.3 relay 'gone' leave signal + 3.4 score `completed` flag + `platform` tag on scores/profile; per-player stats.php available, not yet consumed)
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
// Time budget for the server clock re-sync at a REMATCH (the one mid-match boundary still
// served by start.php; level, respawn and resume boundaries are pure P2P and use the burst).
// The full-quality sweep is 5 samples at a 200ms spread (~800ms) -- too long to sit on the
// cover between matches. Bounded, _netTimeSync adopts the best min-RTT sample so far
// and start.php's `now` gives it a final min-RTT refinement, so the anchor stays clean while
// the wait roughly halves. THE lever if a rematch still feels slow (lower) or drifts (raise).
// The FIRST start -- before anyone is watching a clock -- keeps the unbudgeted full sweep.
const NET_LEVEL_SYNC_MS = 400;
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
const NET_BURST_WAIT_MS = 250;    // window past the LAST send == the max round trip the burst can verify; the early-out closes a healthy link at ~its own RTT
const NET_BURST_MIN = 5;          // accept-gate per direction: 5 of 6 delivered = at most ONE loss; anything worse means the channel is too unreliable to trust
const NET_BURST_SLEW_MS = 120;    // cap on the per-boundary clock nudge; a realistic offset (<150ms) is corrected in one
const NET_BURST_LEAD_MS = 250;    // host's lead when it authors a start PTS on its own clock: covers the start packet's transit + reliable repeats
const NET_BURST_TRIES = 10;       // starved-burst retries before the boundary opens anyway on the PRIOR clock (itself
                                  // burst-verified at the last boundary). 10 x ~340ms (probe span + WAIT window) stays
                                  // inside the RB_PERSIST_KILL_MS silence deadline, so a genuinely dead peer ends the
                                  // match through the liveness path, never through the clock sync.
// How long a pending invite (sent, received, or accepting) lingers before it goes stale.
// The server drops undelivered signals at 30s; we give up a touch sooner so the UI resolves
// to NO ANSWER / clears the dialog while the peer could, in theory, still collect it.
const NET_INVITE_STALE_MS = 24000;
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
var _netDbg = { rtt:-1, p2pRtt:-1, relayRtt:-1, relayDrop:0, relayAge:0, srvOfs:0, peerTkOfs:0, lag:0, inRx:0, inTx:0, hbRx:0, hbTx:0, iceDeob:0, path:'', inLog:[], sigLog:[],
                pollAt:0, pollHeld:false,   // pollAt = when the in-flight poll opened (0 = none open)
                lagAvg:0, lagMin:0, lagMax:0, lagN:0 };   // peer PTS delta, averaged over _netLagN
var _netLagN = [];   // rolling window of peer PTS deltas: one sample is noise, the average is the figure
function _netSigLog(line){ _netDbg.sigLog.unshift(line); if(_netDbg.sigLog.length>6) _netDbg.sigLog.length=6; _uiDirty=true; }

// ---- transport (soft-fail JSON; null = any kind of failure) ----
// Returns {status, json}: json is null unless the server said ok. status 0 = the
// request never completed. Callers that only care "did it work" use _netPost.
async function _netPostRes(path, body){
    if(!_netOk()) return { status:0, json:null };
    try {
        const r = await fetch(NET_BASE + path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body), cache:'no-store', priority:'high' });
        _netDbg.lastSrvAt = performance.now();   // a POST always carries data both ways = real communication
        let j = null; try{ j = await r.json(); }catch(e){}   // an error status may carry no JSON at all
        // Keep the server's own reason ({"ok":false,"error":"..."}): guessing it
        // from the status alone is how 'invalid pts' got misread as a clock drift.
        return { status: r.status, json: (j && j.ok) ? j : null, err: (j && j.error) ? String(j.error) : '' };
    } catch(e){ return { status:0, json:null, err:'' }; }
}
async function _netPost(path, body){ return (await _netPostRes(path, body)).json; }
async function _netGet(path, signal){
    if(!_netOk()) return null;
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
        return (j && j.ok) ? j : null;
    } catch(e){ return null; }
}
// Every caller ignored the result of this, so the server REFUSING a signal was
// indistinguishable from success: a 403 (no accepted friendship), a 400 (our clock
// drifted ahead of the server's), a 503 (relay full) or a plain blip all vanished
// while the UI sat on "INVITED - WAITING" until the 30s timeout. Failures are now
// logged in the debug overlay, and the invite path reports them to the user.
async function _netSignal(to, type, payload){
    _netSigLog('> '+type+' '+String(to).slice(0,4));   // debug overlay
    const body = { id:getPlayerId(), to, type, payload: payload||'' };
    const pts = (typeof netPts === 'function') ? netPts() : null;
    if(pts != null) body.pts = pts - 50;   // stamped slightly in the past: the server hard-rejects future PTS
    const res = await _netPostRes('/api/signal.php', body);
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
        let s = ''; try{ s = localStorage.getItem('lastSName') || ''; }catch(e){}
        _netMyNameC = { v:s, at:n };
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
function _netProfile(){
    return { name:(_netMyName()||'PLAYER').slice(0,MAX_NAME), color:cfg.snakeColor|0, shopItems:cfg.wornItems||{}, platform:_detectPlatform() };
}
function _netClampProfile(p){
    p = (p && typeof p === 'object') ? p : {};
    return { name: String(p.name||'???').slice(0,MAX_NAME),
             color: Math.abs(p.color|0) % SNAKE_COLORS.length,
             shopItems: (p.shopItems && typeof p.shopItems === 'object') ? p.shopItems : {},
             platform: (typeof p.platform === 'string') ? p.platform.slice(0,12) : null };
}

// ---- PTS clock sync (API: time synchronization). The server clock in unix
// MILLISECONDS is the one PTS reality; we measure our offset via time.php
// (5 samples, keep the lowest-RTT one) and adjust ourselves. REQUIRED before
// an online game starts; re-synced when older than a minute. ----
var _netSync = { ofs:null, rtt:-1, at:0 };
// The lockstep timeline rides the MONOTONIC clock, never Date.now(). Date.now() is the wall
// clock, which the OS silently slews and steps (its time daemon disciplining toward network
// time) -- anchoring the shared PTS to it let those adjustments leak straight into the timeline
// as drift. A foregrounding phone can move its wall clock ~10ms in a minute this way (~167ppm),
// far past any crystal error, which is exactly the "not normal wall drift" the field reported.
// performance.now() is a monotonic clock: it never decreases and is not subject to adjustments;
// timeOrigin pins it to a wall reading captured ONCE at context start, so this reads like a wall
// clock but cannot be nudged afterward. Whole ms (PHP is_int rejects a fractional pts). The
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
// MANDATED latency report (API: Latency measurement and reporting): the same
// time.php samples yield the value -- at least three, an extreme FIRST sample
// (cold connection: DNS/TCP/TLS) discarded, the rest averaged for stability.
var _netLat = { value:null, at:0, pending:false };
function _netLatFromSamples(rtts){
    if(rtts.length < 3) return null;
    const rest = rtts.slice(1);
    const avgRest = rest.reduce((a,b)=>a+b,0) / rest.length;
    const use = (rtts[0] > 2.5 * avgRest) ? rest : rtts;   // extreme first value: discard
    return Math.round(use.reduce((a,b)=>a+b,0) / use.length);
}
let _netSyncBusy = false;
// A duel is PAUSED here: READY/GO between levels and after a death. Cheap moments to
// re-anchor, because nothing is being steered.
function _netSyncBreak(){ return phase === 'duelReady' || phase === 'duelOver'; }
// The clock source, in PTS milliseconds. PREFERRED: a header on a STATIC file, so
// Apache stamps it without PHP ever running. That matters because the wait for a
// PHP-FPM worker happens BEFORE php starts -- php cannot see it, cannot subtract it,
// and it would otherwise land in our offset as if it were network delay, exactly
// when the server is busiest. time.php stays as the fallback for when the header is
// unreadable (a proxy stripping it, CORS).
async function _netClockMs(){
    try {
        const r = await fetch(NET_BASE + '/api/t.txt', { cache:'no-store', priority:'high' });
        const h = r.headers && r.headers.get && r.headers.get('X-Fok-T');
        const m = h && /t=(\d+)/.exec(h);
        if(m) return Number(m[1]) / 1000;   // the header is MICROseconds; PTS is milliseconds
    } catch(e){}
    const j = await _netGet('/api/time.php');
    return (j && typeof j.t === 'number') ? j.t : null;
}
async function _netTimeSync(force, budgetMs){
    if(_netSyncBusy || !_netOk()) return;
    // NEVER re-anchor while a duel is being played. netPts() DRIVES the tick
    // number, so moving the anchor moves the whole timeline under our feet -- a
    // periodic self-inflicted desync. The anchor is set at the match start and
    // re-set only with a negotiated start (new level, rematch); in between it stays
    // exactly where it was, drift and all. A few ms of drift across one level is
    // invisible; a step mid-game is not.
    if((phase === 'duel' || phase === 'duelPaused') && !_netSyncBreak()) return;
    if(!force && _netSync.ofs != null) return;   // anchored: it holds until a break re-anchors it
    _netSyncBusy = true;
    let best = null;
    const rtts = [];
    // budgetMs (optional) caps how long we sample before adopting the best so far -- the
    // menu-music sync passes a short one so it never holds the track past its 2s wall. The
    // spread shrinks to fit, and a trailing request may overshoot by one round trip.
    const _syncStart = (typeof performance !== 'undefined') ? performance.now() : 0;
    const _spread = budgetMs ? Math.max(40, Math.min(200, Math.floor(budgetMs / 6))) : 200;
    for(let i = 0; i < 5; i++){
        const t0 = performance.now();
        const t = await _netClockMs();
        const rtt = performance.now() - t0;
        if(t != null){
            rtts.push(rtt);
            // Keep the LOWEST-rtt sample, never an average: a sample delayed by queuing
            // carries that delay straight into its offset, so averaging spreads the poison
            // instead of discarding it. The fastest sample is the least polluted one.
            if(!best || rtt < best.rtt) best = { rtt, ofs: t + rtt/2 - _wall() };
            // Budgeted (menu-music) sync: adopt as soon as we have ANY sample so netPts()
            // is usable within one round trip -- the menu gate then almost always sees a
            // synced clock inside its short wall. Later samples only refine it. NEVER
            // incrementally re-anchor mid-duel: that is the self-inflicted step we refuse.
            if(budgetMs && !(phase === 'duel' || phase === 'duelPaused'))
                _netSync = { ofs: best.ofs, rtt: best.rtt, at: Date.now() };
        }
        if(budgetMs && performance.now() - _syncStart >= budgetMs) break;   // bounded: adopt best-so-far
        // SPREAD the samples. Back-to-back requests hit the same server load and can
        // all be slow together, leaving no clean sample to pick -- five bad samples
        // give a bad offset just as confidently as one.
        if(i < 4 && typeof setTimeout === 'function') await new Promise(res => setTimeout(res, _spread));
    }
    _netSyncBusy = false;
    // Guard the ADOPTION, not just the start: five samples take ~500ms, so a sync
    // begun at a break can land after play resumed -- and adopting it there would be
    // the very mid-game step we just refused. Drop it; the next break re-anchors.
    if(_netSync.ofs != null && (phase === 'duel' || phase === 'duelPaused') && !_netSyncBreak()) best = null;
    if(best){ _netSync = { ofs: best.ofs, rtt: best.rtt, at: Date.now() }; _netClockPush(); }
    const lat = _netLatFromSamples(rtts);
    if(lat != null) _netLat = { value: Math.max(0, Math.min(60000, lat)), at: Date.now(), pending: true };
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
    for(const e of _netDbg.sigLog.slice(-3)) Nx.push(e);   // last few only -- ICE floods it mid-game
    return { net:{main:Nm,more:Nx}, time:{main:Tm,more:Tx}, sim:{main:Sm,more:Sx} };
}
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
    const mine = (_netMyName() || 'YOU').slice(0, MAX_NAME);
    const peer = (_netSess.peerProfile && _netSess.peerProfile.name) || netFriendName(_netSess.peer) || fmtFriendId(_netSess.peer);
    return netHosting() ? [mine, peer] : [peer, mine];
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
    const _pp = _netSess.peerProfile || null, _host = netHosting();
    if(_netLookC && _netLookC.pp === _pp && _netLookC.host === _host && _netLookC.col === (cfg.snakeColor|0)
       && _netLookC.wi === cfg.wornItems && _netLookC.nrc === !!cfg.noRemoteCosmetics) return _netLookC.val;
    const N = SNAKE_COLORS.length;
    const pp = _pp || {};
    const mine   = { c: (cfg.snakeColor|0) % N, i: cfg.wornItems || {} };
    // NETWORK setting: render the peer as a plain default snake (no cosmetics, colour 0).
    // Purely a local view choice -- it never crosses the wire and does not touch the sim.
    const theirs = cfg.noRemoteCosmetics ? { c: 0, i: {} }
                 : { c: Math.abs(pp.color|0) % N,
                     i: (pp.shopItems && typeof pp.shopItems === 'object') ? pp.shopItems : {} };
    const a = _host ? mine : theirs;          // P0 is always the host
    const b = _host ? theirs : mine;          // P1 is always the joiner
    let c0 = a.c, c1 = b.c;
    if(c0 === c1) c1 = (c1 + 1) % N;          // same pick: nudge P1 -- deterministic, so both agree
    const val = { c0, c1, i0: a.i, i1: b.i };
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
             counts:_netCounts };
}

// ---- heartbeat: the one periodic request (presence + signal mailbox, ~30s) ----
let _netCounts = { online:0, playing:0 };
let _netFriendsOnline = {};
let _netFriendsLat = {};
// Enabling STRICTLY OFFLINE stops the heartbeat, so presence stops being refreshed and
// would otherwise FREEZE at its last-known values -- friends left showing "online", a live-
// looking player count. Drop it all now so offline reads as offline, not as a stale snapshot.
function netOfflineClear(){
    _netCounts = { online:0, playing:0 };
    _netFriendsOnline = {}; _netFriendsLat = {};
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
let _netHelloBusy = false;
async function _netHello(){
    if(_netHelloBusy || netOffline() || typeof fetch !== 'function') return;   // deliberately NOT _netOk: see the api re-check below
    _netHelloBusy = true;
    const body = { id: getPlayerId() };
    { const n = _netMyName(); if(n) body.name = String(n).slice(0, MAX_NAME); }
    if(_netLat.pending && _netLat.value != null) body.latency = _netLat.value;   // the mandated report
    if(Date.now() - _netLat.at > 180000) _netTimeSync(true);                     // re-measure every few minutes (lands next hello)
    if(_netSess && _netSess.game) body.duel_with = _netSess.peer;
    if(phase === 'lobby' || phase === 'friends') body.friends = getFriends().slice(0,64);
    // auto_accept: presenting our QR / being on the add-friend screen IS the
    // consent, so the server accepts incoming friend requests immediately (the
    // contract mechanism; complements the client-side QR accept). Expires ~60s.
    if(phase === 'friendId' || phase === 'friends' || Date.now() - _netMyIdAt < 60000) body.auto_accept = true;
    // REPORT what is true, never what was asked: the admin view tells an instruction
    // the client has not picked up yet ('pending') from a client that turned debug on
    // by itself ('self'), and deriving one from the other would erase that difference.
    if((cfg.debug|0) > 0) body.debug = true;
    const t0 = performance.now();
    const r = await _netPost('/api/hello.php', body);
    _netHelloBusy = false;
    if(r){ _netDbg.rtt = performance.now() - t0; if(r.now) _netDbg.srvOfs = r.now + _netDbg.rtt/2 - Date.now(); }   // now = server PTS in ms
    // Undelivered signals expire server-side after 30s; we bail a bit sooner
    // (NET_INVITE_STALE_MS): a sent invite -> NO ANSWER, a received dialog clears.
    if(_netHs.sent && Date.now() - _netHs.sentAt > NET_INVITE_STALE_MS){ _netHs.sent = null; _netLb.msg = 'NO ANSWER'; _uiDirty = true; }
    if(_netLb.invite && Date.now() - (_netLb.invite.at||0) > NET_INVITE_STALE_MS){ _netLb.invite = null; _uiDirty = true; }
    if(_netHs.accepting && Date.now() - _netHs.acceptingAt > NET_INVITE_STALE_MS){ _netHs.accepting = null; _netLb.msg = 'NO RESPONSE'; _uiDirty = true; }
    if(!r){ _netSrvErr = true; _uiDirty = true; return; }
    _netSrvErr = false;
    const _srvMaj = _netApiMajor(r.api), _srvMin = _netApiMinor(r.api);   // re-evaluated every heartbeat: un-latches after a server rollback
    _netApiNewer = (_srvMaj !== null && _srvMaj > NET_API_BUILT);   // newer MAJOR gates online off
    _netApiOutdated = (_srvMaj === NET_API_BUILT && _srvMin > NET_API_BUILT_MINOR);   // newer MINOR: still works, but flag an update
    // HONOUR the server's debug instruction: an operator flips it per player to
    // diagnose a client in the field without asking its user to do anything. Acted on
    // when the instruction CHANGES, not every heartbeat -- a steady `false` must not
    // fight a developer who turned debug on locally, which is the 'self' state the
    // admin view exists to show. A change is the operator actually asking.
    if(typeof r.debug === 'boolean'){
        if(_netDbgSrv !== null && r.debug !== _netDbgSrv){
            cfg.debug = r.debug ? Math.max(1, cfg.debug|0) : 0;
            saveCfg(); _uiDirty = true;
        } else if(_netDbgSrv === null && r.debug && !(cfg.debug|0)){
            cfg.debug = 1; saveCfg(); _uiDirty = true;   // first hello already carries an instruction
        }
        _netDbgSrv = r.debug;
    }
    if(body.latency != null) _netLat.pending = false;   // delivered; omit until the next measurement
    _netCounts = { online:r.online|0, playing:r.playing|0 };
    if(r.friends_online) _netFriendsOnline = r.friends_online;
    if(r.friends_latency) _netFriendsLat = r.friends_latency;
    if(r.friends_name) for(const k in r.friends_name) _netNameSeen(k, r.friends_name[k]);   // authorization-gated: accepted friends only
    _netFrFlushRemovals();
    (r.signals||[]).forEach(_netOnSignal);
    _uiDirty = true;
}

// ---- adaptive signal poll: 1 Hz wherever matchmaking is live (lobby, the 1:1
// menu, or a connection being set up), every 10 s in the main menu so invites
// still surface there, silent everywhere else (incl. during games: the
// DataChannel is the session). Gated on _netOk() -- offline clients never poll. ----
let _netPollTick = 0;
function _netPollDue(){
    if(_netSess && _netSess.game && !_netSess.reconnecting) return false;   // reconnecting: poll so the re-handshake signals flow
    if(phase === 'lobby' || phase === 'duelMenu' || phase === 'friends' || phase === 'friendId') return true;
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
// Hold the connection OPEN on every matchmaking screen (1:1 menu, lobby, friends,
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
async function _netPollOnce(){
    if(_netPollBusy || !_netOk() || !_netPollDue()) return;
    const held = (_netSess && (!_netSess.game || _netSess.reconnecting)) || phase === 'lobby' || phase === 'duelMenu' || phase === 'friends' || phase === 'friendId';   // long-poll during a reconnect so the re-handshake signals arrive fast
    _netPollBusy = true; _netPollBusyAt = Date.now();
    _netDbg.pollAt = performance.now(); _netDbg.pollHeld = held;   // debug overlay: is a connection open right now?
    _netPollAbort = (typeof AbortController === 'function') ? new AbortController() : null;
    const r = await _netGet('/api/poll.php?id=' + getPlayerId() + (held ? '&wait=9' : ''), _netPollAbort ? _netPollAbort.signal : undefined);
    _netPollBusy = false; _netPollAbort = null; _netDbg.pollAt = 0;
    if(r && r.signals && r.signals.length) r.signals.forEach(_netOnSignal);
    // Straight back in, no gap. Only on a SUCCESSFUL reply: a failure (or an abort
    // from backgrounding) falls through to the 1s tick, which is the backoff that
    // stops a broken server from spinning this into a hot loop.
    if(held && r && _netOk() && !(typeof document !== 'undefined' && document.hidden)) _netPollOnce();
}
if(_netTimers) setInterval(()=>{
    _netPollTick++;
    if(!_netOk()) return;
    _netHsTick();
    // A held poll answers within 8s; anything past 15s is a zombie (frozen tab,
    // dead socket). Cut it loose so the loop can breathe again.
    if(_netPollBusy && Date.now() - _netPollBusyAt > 15000) _netPollAbortNow();
    // The lobby's friend dots + counters live in the hello response: refresh
    // them every 5s while the screen is open (single-flight via _netHelloBusy).
    if((phase === 'lobby' || phase === 'friends' || phase === 'friendId') && _netPollTick % 5 === 0){ _netHello(); if(phase === 'friends') _netFrRefresh(false); }   // keep auto_accept fresh on the QR screen
    _netPollOnce();
}, 1000);

// ---- Connection lifecycle across focus loss. A backgrounded tab has its held
// long-poll frozen or killed by the OS: the fetch may never settle, leaving
// _netPollBusy latched forever and the client deaf to every signal until a
// reload. So: drop the connection on blur, build a FRESH one on focus. ----
function _netPollAbortNow(){
    if(_netPollAbort){ try{ _netPollAbort.abort(); }catch(e){} _netPollAbort = null; }
    _netPollBusy = false;
}
if(typeof document !== 'undefined' && document.addEventListener){
    document.addEventListener('visibilitychange', ()=>{
        if(document.hidden){ _netHiddenAt = Date.now(); _netPollAbortNow(); return; }   // backgrounded: note when, to measure how long
        // Foregrounded: nothing from before is trustworthy -- start over.
        const awayMs = _netHiddenAt ? Date.now() - _netHiddenAt : 0; _netHiddenAt = 0;
        _netPollAbortNow();
        _netHelloBusy = false;
        if(_netOk()){ _netTimeSync(true).then(()=>_netHello()); _netHello(); if(phase === 'friends') _netFrRefresh(false); }
        // A screen-off/background almost always kills the p2p transport (ICE times out while
        // suspended), but performance.now() and the timers freeze -- so the silence timer can
        // miss it on wake. Measure the away time on the WALL clock and rebuild if it was more
        // than a blink; a rebuild that turns out unnecessary just re-establishes cheaply.
        if(_netSess && _netSess.game && !_netSess.relay && !_netSess.reconnectAt && awayMs > RB_WARN_MS) _netReconnect(_netSess);
    });
}

// ---- Unload: reload / tab close / browser quit. Every timeout we have is a JS
// timer that dies with the page, so a leaving client can only be polite on the
// way out -- otherwise the peer waits for ITS timeout (3s in-game, 30s mid-
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

// ---- friendships (friend.php): relations exist only once the SERVER recorded
// them -- the local list is just the UI seed. Adds run the request handshake,
// removals reach the server (queued through localStorage when offline). ----
let _netFr = { list:null, at:0, loading:false, sel:0, confirm:null, confirmSel:1, msg:'' };
var _netMyIdAt = 0;   // last moment the MY ID screen (our QR) was on display
// Friendships that reached ACCEPTED at least once: an accepted id vanishing from
// the authoritative server list means the PEER removed it -- mirror that locally.
let _netFrOk = (function(){ try{ return JSON.parse(localStorage.getItem('fok-snake-friend-ok')||'{}')||{}; }catch(e){ return {}; } })();
function _netFrOkSave(){ try{ localStorage.setItem('fok-snake-friend-ok', JSON.stringify(_netFrOk)); }catch(e){} }
function _netFrOkMark(id){ if(!_netFrOk[id]){ _netFrOk[id]=1; _netFrOkSave(); } }
function _netFrOkClear(id){ if(_netFrOk[id]){ delete _netFrOk[id]; _netFrOkSave(); } }
const _netFrRequested = {};   // id -> last attempt ms (time-based retry, NOT a permanent latch)
let _netFrBannedUntil = 0;    // 429 seen: quiet for a minute, then let a user-driven request re-check
function netFriendBanned(){ return Date.now() < _netFrBannedUntil; }
// _netPostRes, not _netPost: friend.php answers 429 for the 1h request ban, and the
// status-blind variant made that indistinguishable from a blip -- the UI then sat on
// 'NOT FRIENDS YET - RETRY IN A MOMENT' for an hour of a condition that will not clear.
function _netFriendApi(action, peer){
    const body = { id: getPlayerId(), action };
    if(peer) body.peer = peer;
    return _netPostRes('/api/friend.php', body).then(res => {
        if(res.status === 429) _netFrBannedUntil = Date.now() + 60000;   // re-checked, not trusted: one minute of quiet, then try again
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
    if(!_netOk() || _netFrOk[id] || netFriendBanned()) return null;
    if(_netFrRequested[id] && Date.now() - _netFrRequested[id] < 30000) return null;
    _netFrRequested[id] = Date.now();
    const p = _netFriendApi('request', id);
    if(!p || !p.then) return null;
    return p.then(r => {
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
function netFriendsEnter(){
    _netFr.sel = 0; _netFr.confirm = null; _netFr.msg = '';
    _netFrRefresh(true);
}
function _netFrRefresh(migrate){
    if(!_netOk() || _netFr.loading) return;
    _netFr.loading = true;
    _netFriendApi('list').then(r => {
        _netFr.loading = false;
        if(!r || !Array.isArray(r.friends)) return;
        _netFr.list = r.friends; _netFr.at = Date.now();
        const seen = {};
        for(const f of r.friends){
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
            } else if(migrate) netFriendRequest(id);   // never synced: run the handshake
        }
        _uiDirty = true;
    });
}
function _netFrAccept(id){
    _netFrOkMark(id);
    if(!_netOk()) return;
    _netFriendApi('accept', id).then(r => {
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
    const done = _netFriendApi('remove', id);
    if(done && done.then) done.then(r => { if(!r){ const q=_netFrRmQueue(); if(q.indexOf(id) < 0){ q.push(id); _netFrRmSave(q); } } });
    _uiDirty = true;
}
function _netFrFlushRemovals(){
    const q = _netFrRmQueue();
    if(!q.length || !_netOk()) return;
    for(const id of q.slice()) _netFriendApi('remove', id).then(r => { if(r) _netFrRmSave(_netFrRmQueue().filter(x => x !== id)); });
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
    _netPost('/api/scores.php', {
        id: getPlayerId(), name: String(name).slice(0,MAX_NAME),
        score: sc|0, level: Math.max(1, lvl|0),
        diff: cfg.diff|0, color: cfg.snakeColor|0, shopItems: cfg.wornItems||{},
        platform: _detectPlatform(),   // device category (pc/mobile/tv/console) for the global board
        seed: _netSeed, inputs: _netInputs,
        completed: !!completed,   // the run CLEARED level 10 (a win), not merely reached it
        pts: netPts() != null ? netPts() - 50 : undefined,   // the game-over moment on the PTS clock
    }).then(r => { if(r){ _netScores = null; _netScoresAt = 0; } });   // bust the cache: the tab shows the fresh board
}
let _netScores = null, _netScoresAt = 0, _netScoresLoading = false;
function netFetchScores(){   // called by the GLOBAL tab draw; cached 60s, single-flight
    if(!_netOk() || _netScoresLoading) return;
    if(_netScores && Date.now() - _netScoresAt < 60000) return;
    _netScoresLoading = true; _uiDirty = true;
    _netGet('/api/scores.php?limit=100').then(r => {
        _netScoresLoading = false;
        if(r && Array.isArray(r.scores)){ _netScores = r.scores; _netScoresAt = Date.now(); }
        _uiDirty = true;
    });
}

// ---- boot: the ~30s heartbeat, always-on while online is allowed. First one after
// a short delay so boot itself never touches the network path. All soft-fail. ----
if(_netTimers){
    setInterval(_netHello, 30000);
    setTimeout(_netHello, 3000);
    setTimeout(()=>{ if(_netOk()) _netFrRefresh(true); }, 3500);   // contract: reconcile the local friend list vs the server at startup
    // Sync the clock DURING the coin-drop splash (bounded) so menu music can start already
    // aligned to the shared server time. Soft: offline / no-fetch just skips it.
    setTimeout(()=>{ if(_netOk() && _netSync.ofs == null) _netTimeSync(true, 1800); }, 0);
    // Daily automatic cloud backup (opt-in). One check a few seconds after boot, then hourly;
    // the once-a-day throttle lives in _maybeAutoCloudBackup so these fire freely.
    setTimeout(()=>{ if(typeof _maybeAutoCloudBackup === 'function') _maybeAutoCloudBackup(); }, 6000);
    setInterval(()=>{ if(typeof _maybeAutoCloudBackup === 'function') _maybeAutoCloudBackup(); }, 3600000);
}
