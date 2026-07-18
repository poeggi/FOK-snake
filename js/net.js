// ============================================================================
// net.js -- ALL online features: FOK-server API client (presence heartbeat,
// signals, global scores), the ONLINE 1:1 lobby (invites, quick match) and the
// WebRTC duel session. NETCODE (deterministic rollback): both clients run the
// deterministic sim locally from the shared seed; own input applies instantly
// (local feel on BOTH ends) and travels tick-stamped to the peer. There is no
// host and no authority -- only inputs cross the wire. A late peer input rewinds
// the sim and re-simulates locally (a sim tick is sub-microsecond, so replay is
// free). Server = matchmaking + signaling only.
// Server contract: FOK-server docs/API.md (https://fok-server.poggensee.it).
//
// OFFLINE-FIRST CONTRACT: this file is strictly additive. Every entry point
// no-ops when cfg.offline is ON, when the browser lacks fetch/WebRTC/timers,
// or when the server is unreachable. Every network failure is a silent soft
// failure -- local play must work IDENTICALLY with the server down, the
// device offline, or this file deleted (all callers guard with typeof).
// ============================================================================
const NET_BASE = 'https://fok-server.poggensee.it';
const NET_API_BUILT = 3;    // the contract MAJOR this client implements (API.md: Versioning; v3 = t.txt clock, epoch-keyed starts + sync gate, remote debug flag, 3.1 = peer-net hint)
// The server's `api` is a "MAJOR.MINOR" string (older servers sent the bare MAJOR as a
// number). Only the MAJOR gates compatibility -- a newer MINOR on the same major is purely
// additive. Returns the major integer, or null if unparseable.
const NET_API_BUILT_MINOR = 1;   // this client is built against 3.1 (the peer-net hint)
function _netApiMajor(a){
    if(typeof a === 'number') return Math.floor(a);
    if(typeof a === 'string'){ const m = a.match(/^\s*(\d+)/); return m ? +m[1] : null; }
    return null;
}
function _netApiMinor(a){
    if(typeof a === 'string'){ const m = a.match(/^\s*\d+\.(\d+)/); return m ? +m[1] : 0; }
    return 0;   // a bare integer (legacy) is x.0
}
var _netDbgSrv = null;      // the server's last debug INSTRUCTION (null = never heard one); kept apart from cfg.debug, which is what we DO
var _netApiNewer = false;   // server MAJOR is newer -> online features disable with a notice
var _netApiOutdated = false;   // server MINOR is newer (same major): still compatible, but an update exists
var _netSrvErr = false;     // last heartbeat failed (shared by every online screen)
function netStatusNotice(){
    if(cfg.offline) return 'OFFLINE MODE (SETTINGS > NETWORK)';
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
function _netOk(){ return !cfg.offline && !_netApiNewer && typeof fetch === 'function'; }
const _netTimers = (typeof setInterval === 'function' && typeof clearInterval === 'function');
// How far a peer's PTS may exceed ours before we call it bogus. We check against
// our ESTIMATE of the server clock (a few ms of sync error) over a jittery link,
// so this is sync error + jitter -- not zero. Zero tolerance here would drop
// honest packets, which is the silent-drop failure this whole layer keeps hitting.
const NET_PTS_TOL = 250;
// Idle keepalive period. Must stay well under the 1s CONNECTION LOST warning: the
// thing being watched for has to arrive faster than the watcher's patience.
const NET_KEEPALIVE_MS = 300;
// Silence ladder (wall-clock ms, derived from the 16-tick heartbeat -- something should
// arrive every ~267ms). Wall-clock, NOT ticks: a suspended tab freezes simTick too, so only
// real elapsed time reveals the gap on the side that was asleep.
const RB_WARN_MS = Math.round(32 * TICK_MS);          // ~533ms (2 missed beats) -> CONNECTION LOST warning
const RB_RECONNECT_MS = Math.round(128 * TICK_MS);    // ~2133ms (8 missed) -> rebuild the p2p link, keep the match
const RB_RECONNECT_TIMEOUT_MS = 8000;                 // the rebuild never recovered -> end the match
// Max JSON we will put in one DataChannel message. 1280 is the IPv6 minimum MTU (and a
// safe IPv4 floor); ~70B goes to IP+UDP+DTLS+SCTP headers, so the payload budget is
// what is left. Worst case today: an 'in' with a full 12-input redundant log (~711B)
// and an 'h' with per-field hashes (~561B).
const NET_PKT_MAX = 1200;
// Live network stats + the debug-overlay ring (declared early: the transport below stamps lastSrvAt).
var _netDbg = { rtt:-1, relayRtt:-1, srvOfs:0, peerTkOfs:0, lag:0, inRx:0, inTx:0, hbRx:0, hbTx:0, iceDeob:0, path:'', inLog:[], sigLog:[],
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
        const r = await fetch(NET_BASE + path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
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
        const r = await fetch(NET_BASE + path, signal ? { signal } : undefined);
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
function _netProfile(){
    let n = ''; try{ n = localStorage.getItem('lastSName') || ''; }catch(e){}
    return { name:(n||'PLAYER').slice(0,MAX_NAME), color:cfg.snakeColor|0, shopItems:cfg.wornItems||{} };
}
function _netClampProfile(p){
    p = (p && typeof p === 'object') ? p : {};
    return { name: String(p.name||'???').slice(0,MAX_NAME),
             color: Math.abs(p.color|0) % SNAKE_COLORS.length,
             shopItems: (p.shopItems && typeof p.shopItems === 'object') ? p.shopItems : {} };
}

// ---- PTS clock sync (API: time synchronization). The server clock in unix
// MILLISECONDS is the one PTS reality; we measure our offset via time.php
// (5 samples, keep the lowest-RTT one) and adjust ourselves. REQUIRED before
// an online game starts; re-synced when older than a minute. ----
var _netSync = { ofs:null, rtt:-1, at:0 };
// WHOLE milliseconds, always. The offset carries a fractional part (it is derived
// from rtt/2), and an un-rounded PTS serialises as 1784190294971.8 -- which PHP's
// strict is_int() rejects with 400 'invalid pts', silently killing the signal. It
// only failed SOMETIMES because rtt/2 occasionally lands on a whole millisecond.
function netPts(){ return _netSync.ofs == null ? null : Math.round(Date.now() + _netSync.ofs); }
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
        const r = await fetch(NET_BASE + '/api/t.txt', { cache:'no-store' });
        const h = r.headers && r.headers.get && r.headers.get('X-Fok-T');
        const m = h && /t=(\d+)/.exec(h);
        if(m) return Number(m[1]) / 1000;   // the header is MICROseconds; PTS is milliseconds
    } catch(e){}
    const j = await _netGet('/api/time.php');
    return (j && typeof j.t === 'number') ? j.t : null;
}
async function _netTimeSync(force, budgetMs){
    if(_netSyncBusy || !_netOk()) return;
    // NEVER re-anchor while a duel is being played. netPts() now DRIVES the tick
    // number, so moving the anchor moves the whole timeline under our feet -- a
    // periodic self-inflicted desync. The anchor is set at the match start and
    // re-set only at the natural breaks (new level, respawn); in between it stays
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
            if(!best || rtt < best.rtt) best = { rtt, ofs: t + rtt/2 - Date.now() };
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
    if(best) _netSync = { ofs: best.ofs, rtt: best.rtt, at: Date.now() };
    const lat = _netLatFromSamples(rtts);
    if(lat != null) _netLat = { value: Math.max(0, Math.min(60000, lat)), at: Date.now(), pending: true };
}

// ---- live network stats (DEBUG LEVEL 2+ overlay and the debug export) ----
// Debug overlay split into three corner quadrants (the fourth, graphics, is the
// caller's -- it owns the layout numbers). N = network/transport (top-left),
// T = timing/timekeeping (top-right), S = sim/rollback health (bottom-right).
//   pts = engine tick clock (60/s). rtt/lat = SERVER round-trip / reported latency.
//   anc = this device's clock offset vs the server (mr = min-rtt, a = age); PTS
//   rests on it, so a wrong anc puts us out of step with the peer.
//   P<i>[R] = my index, R=relay; ep = epoch; tgt = clock-driven tick target
//   ptk = peer-tick (sub-tick, ~0 = aligned); pts live lag / avg. delta = peer one-way pts-delta (latest, then avg + min/max)
//   rb = rollbacks/resim-ticks, mx = deepest; live = inputs applied with NO rewind
//   dsy = desync, hok = hash-ok; in = input records rx/tx; pkt = ALL packets rx/tx
//   path = ICE pair (host=LAN, srflx=hairpin)
function netDebugQuad(){
    const d = _netDbg, N = [], T = [], S = [];
    T.push('pts ' + simTick + ' ' + (simNow/1000).toFixed(1) + 's');
    if(cfg.offline){ N.push('offline'); return { net: N.join('\n'), time: T.join('\n'), sim: '' }; }
    T.push((_netSync.ofs == null)
        ? ('anc -- ' + (d.srvOfs ? '(hello ' + Math.round(d.srvOfs) + ')' : 'unsynced'))
        : ('anc ' + (_netSync.ofs>=0?'+':'') + Math.round(_netSync.ofs) + ' mr' + Math.round(_netSync.rtt) +
           ' a' + ((_netSync.at ? (Date.now()-_netSync.at) : 0)/1000).toFixed(0) + 's'));
    // wall = the PTS our LOCAL wall clock currently equals (Date.now()+anc). Two synced
    // devices read the same value; it is the shared time the tick target is derived from.
    const _wp = netPts();
    T.push('wall ' + (_wp==null ? '-- unsynced' : _wp + ' ' + (_wp/1000).toFixed(1) + 's'));
    N.push('rtt ' + (d.rtt<0?'--':Math.round(d.rtt)) + ' lat ' + (_netLat.value==null?'--':_netLat.value));
    if(_netSess && _netSess.game){
        const _tgt = netTickTarget();
        N.push('P' + netMyIndex() + (_netSess.relay?'R':'') + ' v ' + String(_netSess.peer).slice(0,4) + ' ep' + (_netSess.epoch|0));
        N.push(d.path || 'path ?');
        N.push('in ' + d.inRx + '/' + d.inTx + '  pkt ' + d.hbRx + '/' + d.hbTx);
        N.push('drop ' + _rbDbg.drop + ' lost ' + _rbDbg.lost);
        // tgt = the tick the wall PTS says we should be at; d = tgt-simTick, i.e. how far
        // our engine sim sits from the wall clock (the drift the accumulator steers out).
        T.push('tgt ' + (_tgt==null?'--':_tgt + ' d' + (_tgt-simTick>=0?'+':'') + (_tgt-simTick)) + '  ptk ' + d.peerTkOfs.toFixed(2));
        T.push('pts live lag ' + Math.round(d.lag) + (d.lagN ? '  avg. delta ' + Math.round(d.lagAvg) + ' ' + Math.round(d.lagMin) + '/' + Math.round(d.lagMax) : ''));
        S.push('rb ' + _rbDbg.rb + '/' + _rbDbg.resim + ' mx' + _rbDbg.maxRew + '  live ' + _rbDbg.live);
        S.push('dsy ' + _rbDbg.desync + ' hok ' + _rbDbg.hashOk + ' fix ' + (_rbDbg.fix|0));
        if(d.inLog.length) N.push('< ' + d.inLog.join(' '));
    } else {
        N.push('online ' + _netCounts.online + '  playing ' + _netCounts.playing);
        if(_netLb.invite && Date.now()-(_netLb.invite.at||0) < 30000) N.push('INVITE FROM ' + String(_netLb.invite.from).slice(0,4) + (_netLb.invite.relay?' (relay)':''));
        if(_netHs.sent) N.push('INVITED ' + String(_netHs.sent).slice(0,4) + ' - waiting');
        if(_netHs.accepting) N.push('ACCEPTED ' + String(_netHs.accepting).slice(0,4) + ' - awaiting offer');
        if(_netHs.offerTo) N.push('OFFERED ' + String(_netHs.offerTo).slice(0,4) + ' x' + _netHs.offerTries);
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
        N.push('srv ' + conn + ' | data ' + fmt(performance.now() - d.lastSrvAt) + ' ago');
    }
    for(const e of _netDbg.sigLog.slice(-3)) N.push(e);   // last few only -- ICE floods it mid-game
    return { net: N.join('\n'), time: T.join('\n'), sim: S.join('\n') };
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
    let mine = ''; try{ mine = localStorage.getItem('lastSName') || ''; }catch(e){}
    mine = (mine || 'YOU').slice(0, MAX_NAME);
    const peer = (_netSess.peerProfile && _netSess.peerProfile.name) || netFriendName(_netSess.peer) || fmtFriendId(_netSess.peer);
    return netHosting() ? [mine, peer] : [peer, mine];
}
// The two duel snakes' LOOKS in PLAYER order (P0 = host, P1 = joiner). Each side
// knows its own config and the peer's exchanged profile, and both derive the pair
// the same way -- so the duel looks IDENTICAL on both screens. Previously each
// client rendered P0 with its OWN colour and P1 with the next index, so the two
// players saw different colours for the same snakes and never saw each other's
// cosmetics (the profile carried them; nothing read them). null = not online.
function netDuelLook(){
    if(!netGameActive()) return null;
    const N = SNAKE_COLORS.length;
    const pp = _netSess.peerProfile || {};
    const mine   = { c: (cfg.snakeColor|0) % N, i: cfg.wornItems || {} };
    // NETWORK setting: render the peer as a plain default snake (no cosmetics, colour 0).
    // Purely a local view choice -- it never crosses the wire and does not touch the sim.
    const theirs = cfg.noRemoteCosmetics ? { c: 0, i: {} }
                 : { c: Math.abs(pp.color|0) % N,
                     i: (pp.shopItems && typeof pp.shopItems === 'object') ? pp.shopItems : {} };
    const a = netHosting() ? mine : theirs;   // P0 is always the host
    const b = netHosting() ? theirs : mine;   // P1 is always the joiner
    let c0 = a.c, c1 = b.c;
    if(c0 === c1) c1 = (c1 + 1) % N;          // same pick: nudge P1 -- deterministic, so both agree
    return { c0, c1, i0: a.i, i1: b.i };
}
// The rare-event scale an online match runs with (host's setting on both ends).
function netDuelX10(){ return _netSess ? !!_netSess.x10 : !!cfg.x10; }
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
    return { base:NET_BASE, offline:!!cfg.offline, rttMs:_netDbg.rtt, relayRttMs:_netDbg.relayRtt, relay:!!(_netSess&&_netSess.relay), path:_netDbg.path, serverClockOfsMs:_netDbg.srvOfs,
             pts:simTick, peerTickOfs:_netDbg.peerTkOfs, rollbacks:_rbDbg.rb, resimTicks:_rbDbg.resim, maxRewindTicks:_rbDbg.maxRew,
             inputDrops:_rbDbg.drop, desyncs:_rbDbg.desync, hashOk:_rbDbg.hashOk, fixes:_rbDbg.fix|0, epoch:_netSess?_netSess.epoch:null,
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
    if(_netHelloBusy || cfg.offline || typeof fetch !== 'function') return;   // deliberately NOT _netOk: see the api re-check below
    _netHelloBusy = true;
    const body = { id: getPlayerId() };
    try{ const n = localStorage.getItem('lastSName'); if(n) body.name = String(n).slice(0, MAX_NAME); }catch(e){}
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
    // Undelivered signals expire server-side after 30s: both a sent invite (we get
    // no answer) and a received invite dialog (the sender's is long gone) go stale.
    if(_netHs.sent && Date.now() - _netHs.sentAt > 30000){ _netHs.sent = null; _netLb.msg = 'NO ANSWER'; _uiDirty = true; }
    if(_netLb.invite && Date.now() - (_netLb.invite.at||0) > 30000){ _netLb.invite = null; _uiDirty = true; }
    if(_netHs.accepting && Date.now() - _netHs.acceptingAt > 30000){ _netHs.accepting = null; _netLb.msg = 'NO RESPONSE'; _uiDirty = true; }
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
// MY ID) and during a handshake: a long-poll the server answers the instant a
// signal exists (~150ms), or with 204 after `wait` seconds of real silence. The
// main menu keeps the cheap 10s short-poll (no held worker when merely idling).
//
// wait is capped server-side at 8. HTTP gives one response per request, so the
// request necessarily ends there -- the underlying TCP/TLS socket is NOT torn
// down, keep-alive reuses it for the next one. Re-arming happens the moment a
// response lands (below) rather than on the next tick, so exactly one request is
// outstanding at all times and the link is never left idle.
async function _netPollOnce(){
    if(_netPollBusy || !_netOk() || !_netPollDue()) return;
    const held = (_netSess && !_netSess.game) || phase === 'lobby' || phase === 'duelMenu' || phase === 'friends' || phase === 'friendId';
    _netPollBusy = true; _netPollBusyAt = Date.now();
    _netDbg.pollAt = performance.now(); _netDbg.pollHeld = held;   // debug overlay: is a connection open right now?
    _netPollAbort = (typeof AbortController === 'function') ? new AbortController() : null;
    const r = await _netGet('/api/poll.php?id=' + getPlayerId() + (held ? '&wait=8' : ''), _netPollAbort ? _netPollAbort.signal : undefined);
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
function _netFriendApi(action, peer){
    const body = { id: getPlayerId(), action };
    if(peer) body.peer = peer;
    return _netPost('/api/friend.php', body);
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
    if(!_netOk() || _netFrOk[id]) return null;
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
            if(f.state === 'pending' && !f.outgoing && getFriends().includes(f.id)) _netFrAccept(f.id);
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
    if(done && done.then) done.then(r => { if(!r){ const q=_netFrRmQueue(); if(!q.includes(id)){ q.push(id); _netFrRmSave(q); } } });
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

// ---- lobby state (read by drawLobby + the lobby input row) ----
// ---- HANDSHAKE STATE. Deliberately SEPARATE from the lobby UI state: a
// handshake outlives navigation (an invite arriving on another screen, the user
// stepping into/out of a menu). Only an explicit abort (BACK/quit) or a timeout
// clears it. Putting these in _netLb is what silently killed handshakes before:
// every screen change reset the object and the peer's reply was then discarded.
var _netHs = { sent:null, sentAt:0, sentRelay:false,     // we invited; awaiting accept
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

// ---- invites ----
async function _netInviteSend(to){
    if(inGame) return;
    if(_netSess) _netTeardown();          // debris from a dead attempt: drop it silently, never bye the new target
    if(!_netOk()) return;
    const relay = !!cfg.noP2P;
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
        _netLb.msg = 'NOT FRIENDS YET - RETRY IN A MOMENT';
    }
    else if(res.status === 503) _netLb.msg = 'SERVER FULL - TRY LATER';
    else if(res.status === 400 && /future/.test(res.err)) _netLb.msg = 'CLOCK RE-SYNCED - TRY AGAIN';
    else _netLb.msg = 'INVITE FAILED - TRY AGAIN';   // the reason is in the DEBUG overlay
}
function _netInviteAnswer(acc){
    const inv = _netLb.invite; if(!inv) return;
    _netLb.invite = null; _uiDirty = true;
    // Relay mode when EITHER side wants it (our setting, or the invite carried the bit).
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
    if(!cfg.noP2P && !_netRtcAvail()){ _netLb.msg = 'WEBRTC NOT SUPPORTED'; return; }   // relay mode needs no WebRTC
    _netLb.seeking = true; _netLb.msg = '';
    _netSeekT = setInterval(async ()=>{
        if(!_netLb.seeking || _netSess){ _netSeekStop(); return; }
        const r = await _netPost('/api/match.php', { id:getPlayerId(), action:'seek' });
        if(!r || !r.matched) return;
        _netSeekStop();
        if(r.peer_name) _netNameSeen(String(r.matched), r.peer_name);   // strangers: the pairing is the entitlement
        if(r.role === 'offerer'){ cfg.noP2P ? _netRelayOffer(String(r.matched)) : _netRtcOffer(String(r.matched)); }
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
            case 'invite-relay': {
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
            case 'accept-relay': {
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
                if(od.rc && _netSess && _netSess.peer === from && _netSess.game){ _netRtcReanswer(from, od); break; }   // reconnect: rebuild the transport, keep the match
                if(od.sdp) _netRtcAnswer(from, od); else _netRelayAnswer(from, od);   // no sdp = relay mode
                break;
            }
            case 'answer': {
                _netHs.offerTo = null; _netHs.offerPayload = null;   // answered: stop re-sending
                const d = _netJson(pl);
                // NOT gated on _netSess.pc: a relay session never builds one, so
                // that gate dropped the answer's profile and version on the whole
                // default path -- quick match then had no peerProfile at all.
                if(_netSess && _netSess.peer === from){
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
                    if(_netSess.pc && d.sdp) _netSess.pc.setRemoteDescription(d.sdp).catch(()=>{});
                }
                break;
            }
            case 'ice':
                if(_netSess && _netSess.peer === from && _netSess.pc){
                    const cand = _netJson(pl);
                    try{ _netSess.pc.addIceCandidate(cand).catch(()=>{}); }catch(e){}
                    const extra = _netDeobfuscateCand(cand, _netPeerNet[from]);   // mDNS -> real IPv6, probed in parallel
                    if(extra){ try{ _netSess.pc.addIceCandidate(extra).catch(()=>{}); _netDbg.iceDeob = (_netDbg.iceDeob|0)+1; }catch(e){} }
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
function _netMkSess(peer, role){
    return { peer, role, pc:null, dc:null, seed:0, peerProfile:null, game:false,
             relay:false, connT:null, relayAbort:null, relaySeq:-1, relayGraceUntil:0,
             epoch:0,   // halts so far in THIS connection: both peers count identically (a bye resets the line)
             lastRecv:0, lastSent:0, liveT:null, myAgain:false, peerAgain:false,
             lastSentTick:-1, lastPhase:'', lastBarsV:-1,
             lastRecvWall:0, reconnectAt:0, reconnecting:false };   // lastRecvWall: Date.now() clock; mid-game p2p rebuild
}
// Stamp a received packet on BOTH clocks. lastRecvWall (Date.now) is the wall clock: it keeps
// advancing while a tab is suspended, so on wake the real silence is visible even when
// performance.now() (and every timer) froze during a screen-off.
function _netMarkRecv(s){ if(s){ s.lastRecv = performance.now(); s.lastRecvWall = Date.now(); } }
let _netHiddenAt = 0;   // Date.now() when we last went hidden, for the wake-up away-time
function _netRtcInit(peer, role){
    _netSess = _netMkSess(peer, role);
    const pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.l.google.com:19302' }] });
    _netSess.pc = pc;
    pc.onicecandidate = e => { if(e.candidate) _netSignal(peer, 'ice', JSON.stringify(e.candidate)); };
    pc.onconnectionstatechange = () => {
        const s = _netSess;
        if(!s || s.pc !== pc || s.relay) return;   // relay mode: the RTC attempt no longer owns the session
        if(pc.connectionState === 'failed' || pc.connectionState === 'closed'){
            if(!s.game) _netRelayStart(s);              // P2P never came up: fall back NOW (earlier than the 5s timer)
            else if(!s.reconnectAt) _netReconnect(s);   // an established game lost its channel: rebuild it, do NOT end
        }
    };
    // P2P gets 5 seconds; then the match falls back to the server relay.
    if(_netTimers) _netSess.connT = setTimeout(()=>{ if(_netSess && _netSess.pc === pc && !_netSess.game) _netRelayStart(_netSess); }, 5000);
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
        _netSignal(peer, 'answer', JSON.stringify({ profile:_netProfile(), v:_swVersion }));
        return;
    }
    if(_netSess) _netTeardown();          // unrelated debris must not swallow the offer
    _netHs.accepting = null;
    _netTimeSync();
    _netSignal(peer, 'answer', JSON.stringify({ profile:_netProfile(), v:_swVersion }));
    _netRelaySessionStart(peer, 'peer', d.seed, d.x10, _netClampProfile(d.profile));
}
async function _netRtcOffer(peer, peerProfile){   // we invited / we are the quick-match offerer: we make the seed
    if(!_netRtcAvail() || inGame){ _netSigLog('> offer SKIP'); return; }
    if(_netSess) _netTeardown();          // debris: replace it, never silently skip the offer
    const pc = _netRtcInit(peer, 'host');
    if(peerProfile) _netSess.peerProfile = peerProfile;
    _netSess.seed = (Math.random()*0x100000000)>>>0;
    _netWire(pc.createDataChannel('fok', { ordered:false, maxRetransmits:0 }));
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
    pc.ondatachannel = e => _netWire(e.channel);
    _netTimeSync();   // in parallel with the ICE handshake: synced by the time sched arrives
    try {
        await pc.setRemoteDescription(d.sdp);
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
function _netSend(o){
    const s = _netSess;
    if(!s) return;
    const pts = netPts();
    if(pts != null && o.pts === undefined) o.pts = pts;   // API: every peer message carries the sender's PTS
    if(o.t === 'in' || o.t === 'pi') _netDbg.hbTx++;   // input-channel packets sent (incl. idle keepalives)
    if(s.relay){ _netRelaySend(s, o); return; }
    if(!s.dc || s.dc.readyState !== 'open') return;
    try{
        const j = JSON.stringify(o);
        // One datagram or nothing. Over the path MTU, SCTP fragments the message and
        // losing ANY fragment loses the whole thing -- on a channel that never
        // retransmits, a fragmented packet is a packet that mostly does not arrive. The
        // budget leaves room for IP+UDP+DTLS+SCTP headers (~70B) under a 1280 floor.
        if(j.length > NET_PKT_MAX){ _netDbg.oversize = (_netDbg.oversize|0) + 1; _netSigLog('! packet ' + j.length + 'B > budget'); }
        s.dc.send(j); s.lastSent = performance.now();
    }catch(e){}
}
// Fall back to the server relay: same messages, ~200-400ms one-way -- the local
// snake stays instant (prediction), corrections just arrive slower. The user
// sees why: a short message now and a RELAY MODE tag on the board.
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
async function _netRelaySend(s, o){
    if(!_netOk()) return;
    try {
        const _t0 = performance.now();
        const r = await fetch(NET_BASE + '/api/relay.php', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ id:getPlayerId(), peer:s.peer, payload:JSON.stringify(o), pts:o.pts }) });
        s.lastSent = performance.now();
        _netDbg.relayRtt = performance.now() - _t0;   // client<->server relay-POST round-trip (about half the peer path)
        if(r.status === 503) _netSessionEnd('SERVER FULL - TRY LATER');   // capped: honest busy, end the attempt
        else if(r.status === 429) { /* relay backlog full: drop this packet, the next correction supersedes it */ }
    } catch(e){}
}
async function _netRelayLoop(s){
    while(_netSess === s && s.game && s.relay){
        if(!_netOk()) return;
        // Abortable: without this the held socket lingers up to 8s after a teardown
        // (leaving a match, or unload), long after we stopped caring about it.
        s.relayAbort = (typeof AbortController === 'function') ? new AbortController() : null;
        const r = await _netGet('/api/relay.php?id=' + getPlayerId() + '&peer=' + s.peer + '&wait=8',
                                s.relayAbort ? s.relayAbort.signal : undefined);
        s.relayAbort = null;
        if(_netSess !== s || !s.game || !s.relay) return;
        if(!r && _netTimers) await new Promise(res => setTimeout(res, 1000));   // transport error: back off
        if(r && Array.isArray(r.messages)){
            for(const m of r.messages){
                if((m.seq|0) <= s.relaySeq) continue;   // exactly-once, in order
                s.relaySeq = m.seq|0;
                _netMarkRecv(s);
                _netHandleMsg(String(m.payload||''));
            }
        }
    }
}
// Read the SELECTED ICE candidate pair so we KNOW the real path: host = direct LAN (~1ms),
// srflx/prflx = reflexive -- hairpins out through the router/internet even on one LAN, the usual
// cause of "same-Wifi but 100ms jitter" -- relay = via a TURN server. Plus the true P2P RTT.
function _netPathStat(s){
    if(!s || s.relay){ if(s && s.relay) _netDbg.path = 'relay  srv ' + (_netDbg.relayRtt>=0 ? Math.round(_netDbg.relayRtt)+'ms' : '--'); return; }
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
        const rtt = (typeof pair.currentRoundTripTime === 'number') ? Math.round(pair.currentRoundTripTime * 1000) + 'ms' : '?';
        const pn = _netPeerNet[s.peer];
        // 'deob' = the de-obfuscated real IP (grafted from the peer-net hint) is the one that
        // connected, i.e. the direct IPv6 path won past mDNS. Otherwise it is a normal host
        // (LAN mDNS resolved), srflx (STUN reflexive) or prflx pair.
        const deob = pn && pn.ip && addr(rem) === pn.ip ? ' deob' : '';
        _netDbg.path = ty(loc) + '/' + ty(rem) + (fam(addr(rem)) ? ' ' + fam(addr(rem)) : '') + deob + '  p2p-rtt ' + rtt;
    }).catch(()=>{});
}
// In-game liveness: the DataChannel is the session -- ping when idle, 3s silence = dead.
function _netLiveStart(){
    if(!_netTimers) return;
    _netSess.liveT = setInterval(()=>{
        const s = _netSess; if(!s || !s.game) return;
        const nowMs = performance.now();
        if(!s.pathAt || nowMs - s.pathAt > 2000){ s.pathAt = nowMs; _netPathStat(s); }   // refresh the ICE-path readout ~0.5Hz
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
        if(nowMs - s.lastSent > NET_KEEPALIVE_MS) _netSend(inGame ? { t:'in', tk:_rbToWire(simTick), l:_rbSent } : { t:'pi' });
        // The re-offer retry is gated off in-game, so drive it from here while reconnecting.
        if(s.reconnecting && s.role === 'host' && _netHs.offerTo === s.peer && _netHs.offerPayload && Date.now() - _netHs.offeredAt > 2000){
            _netHs.offeredAt = Date.now(); _netSignal(s.peer, 'offer', _netHs.offerPayload);
        }
        // Silence on the WALL clock (Date.now): a suspended tab freezes performance.now() and
        // the timers, so only real elapsed time reveals the gap on the side that was asleep.
        const nowW = Date.now();
        const silent = nowW - s.lastRecvWall;
        if(s.relay){
            if(nowMs < s.relayGraceUntil) return;                       // relay just engaged: let the peer catch up
            if(silent > 3000) _netSessionEnd('CONNECTION LOST');        // relay has no transport to rebuild -> a long silence ends it
            return;
        }
        // p2p ladder: WARN (netDuelWarn) -> RECONNECT (rebuild the link) -> hard KILL if it never recovers.
        if(silent > RB_RECONNECT_MS){
            if(!s.reconnectAt) _netReconnect(s);
            else if(nowW - s.reconnectAt > RB_RECONNECT_TIMEOUT_MS) _netSessionEnd('CONNECTION LOST');
        } else if(s.reconnectAt && silent < RB_WARN_MS){
            _netReconnectDone(s);   // packets flowing again -- recovered
        }
    }, 250);
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
    const pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.l.google.com:19302' }] });
    s.pc = pc;
    pc.onicecandidate = e => { if(e.candidate) _netSignal(s.peer, 'ice', JSON.stringify(e.candidate)); };
    pc.onconnectionstatechange = () => { /* a failed rebuild is owned by the liveness timeout */ };
    return pc;
}
async function _netRtcReoffer(s){
    if(!_netRtcAvail()) return;
    const pc = _netRtcRebuild(s);
    _netWire(pc.createDataChannel('fok', { ordered:false, maxRetransmits:0 }));
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
    pc.ondatachannel = e => _netWire(e.channel);
    try {
        await pc.setRemoteDescription(d.sdp);
        const an = await pc.createAnswer();
        await pc.setLocalDescription(an);
        _netSignal(from, 'answer', JSON.stringify({ sdp:pc.localDescription, rc:1, v:_swVersion }));
    } catch(e){}
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
async function _netRequestStart(s, reason){
    if(!_netOk()){ _netSessionEnd('OFFLINE - CANNOT START'); return; }
    // The contract: a fresh sync ALWAYS precedes a new start PTS. Not "a sync from a
    // minute ago" -- start.php rejects a pts older than ~2s as stale.
    await _netTimeSync(true);
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
        _netSync = { ofs: d.now + _rtt/2 - Date.now(), rtt: _rtt, at: Date.now() };
    s.startPts = d.start_pts;   // tick 0 of the shared timeline, for THIS epoch
    // 'sched' is the FIRST start and is refused while inGame (a stale one must not
    // restart a running match). Every later start -- rematch, level, respawn -- happens
    // WHILE in game, so it must ride 'rst' or the peer silently ignores it and only
    // one client restarts.
    if(s.role === 'host') _netSend({ t: (reason === 'first' || !reason) ? 'sched' : 'rst',
                                     seed:s.seed, startPts:d.start_pts, x10:s.x10, epoch:s.epoch|0 });
    // start_pts may already be in the PAST when we asked late (the epoch key is what
    // lets the server answer us with the same moment anyway). Then wait is 0 and we
    // start at once -- the clock-driven tick immediately puts us on the right tick,
    // which IS the fast-forward the contract describes.
    // No !inGame guard: a rematch or a next-level start happens WHILE in game.
    const go = () => { if(_netSess === s && s.game){ beginOnlineDuel(s.seed, s.role === 'host'); if(s.role === 'host') _netSend({ t:'start' }); } };
    const wait = Math.max(0, Math.min(5000, d.start_pts - netPts()));
    if(wait <= 0 || typeof setTimeout !== 'function') go(); else setTimeout(go, wait);
}

// ---- in-session messages ----
function _netHandleMsg(txt){
    let m; try{ m = JSON.parse(txt); }catch(e){ return; }
    if(!m || typeof m !== 'object') return;
    // The stamp is CHECKED, not just logged. A peer cannot have sent from our
    // future; a packet claiming otherwise is bogus and is dropped. The tolerance
    // matters: unlike the server -- which IS the clock and can be zero-tolerance --
    // we compare against our ESTIMATE of it, so a strict test would discard honest
    // packets. Discards are visible, never silent.
    if(typeof m.pts === 'number'){
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
                _rbDbg.drop++; _rbWarnAt = performance.now();
                _netSigLog('! future pts +' + Math.round(m.pts - mine) + 'ms');
                return;
            }
        }
    }
    switch(m.t){
        case 'sched':
        case 'rst': {   // the match / rematch start moment, issued by the server, relayed by P0
            const s = _netSess;
            if(!s || s.role === 'host' || !s.game) break;
            if(m.t === 'sched' && inGame) break;
            s.seed = (m.seed>>>0) || s.seed;
            if(m.x10 !== undefined) s.x10 = !!m.x10;
            const go = () => { if(_netSess === s && s.game) beginOnlineDuel(s.seed, false); };
            // No shared clock, no match: starting on different timelines is exactly
            // the desync this architecture exists to make impossible.
            if(typeof m.startPts !== 'number' || netPts() == null){ _netSessionEnd('NO CLOCK SYNC - CANNOT START'); break; }
            s.startPts = m.startPts;   // the epoch tick 0 is measured from: a rematch moves it
            if(typeof m.epoch === 'number') s.epoch = m.epoch|0;   // stay on the pair's epoch line
            const wait = Math.max(0, Math.min(5000, m.startPts - netPts()));
            if(wait <= 0 || typeof setTimeout !== 'function') go(); else setTimeout(go, wait);
            break;
        }
        case 'start': break;   // schedule confirmation; its PTS is already in the past
        case 'in': _netDbg.hbRx++; if(_netSess) _netPeerInput(m); break;   // both ends apply the other's input
        case 'h': if(_netSess && inGame) _rbCheckHash(m); break;   // divergence check
        case 'st': if(_netSess && inGame) _rbCheckState(m); break; // authoritative-state recovery
        case 'again':
            if(_netSess && _netSess.game){ _netSess.peerAgain = true; _netMaybeRestart(); _uiDirty = true; }
            break;
        case 'bye': _netSessionEnd('OPPONENT LEFT'); break;
        case 'pi': _netDbg.hbRx++; break;   // liveness ping: receiving it already refreshed lastRecv
    }
}
// ================================================================
// DETERMINISTIC ROLLBACK NETCODE  -- no host, no authority
// ================================================================
// Both clients run the SAME deterministic sim from the same seed and the same
// server-issued start moment, so nobody has to be told what the world looks like.
// ONLY INPUTS cross the wire, each stamped with the tick it was authored on, and
// every client applies every input at its authored tick. Two sims fed identical
// inputs at identical ticks stay identical -- that is what the golden-hash tests
// already prove offline.
//
// Nobody transmits positions, so "do not accept updates about your own snake" is
// structural rather than a check: no such message exists. Your own input is
// authored on your own tick and can never be contradicted, so your snake is never
// corrected.
//
// A remote input that arrives LATE (authored for a tick we have already run) is
// honoured by rewinding to that tick and re-simulating: the remote snake visibly
// corrects, and its sounds may land late. That is the price of zero input lag,
// and it only shows when latency is high.
const RB_RING = 40;          // ticks we can rewind (~666ms at 60Hz)
const RB_FUTURE = 30;        // an input authored this far ahead of us is not honest
var _rbRing = [];            // [{tk, snap}] -- snap is the state BEFORE tick tk ran
var _rbLog = new Map();      // tick -> [cmd] : every input, BOTH players, by authored tick
var _rbSeq = 0;              // our outgoing input sequence
var _rbPeerSeq = -1;         // highest peer sequence applied
// Every packet repeats the recent inputs, so a lost one is repaired by the next
// without a retransmit (the DataChannel is deliberately unreliable). 12 covers far
// more than any hand generates inside a round trip, and keeps the worst-case packet
// (~700 bytes) inside both the 1280-byte datagram budget and the relay's 2KB cap.
const RB_REDUNDANCY = 12;
var _rbSent = [];            // recent local inputs, resent for redundancy
var _rbDbg = { rb:0, resim:0, drop:0, maxRew:0, desync:0, hashOk:0, lost:0, live:0, fix:0 };
// simTick is a FREE-RUNNING counter from page load -- startDuel does not reset it,
// and it ticks through the menus. So two clients enter a duel with wildly different
// values (one at 45000, the other at 3000) and their raw ticks mean nothing to each
// other. Every wire tick is therefore relative to this base, captured when the duel
// starts: both clients start at the same server-issued start_pts, so relative tick 0
// is the same instant on both. Without it every input lands outside the accept
// window and is dropped -- which looks exactly like "nothing ever gets through".
var _rbBase = 0;
var _rbPhase = '';   // last seen duel phase: drives the re-anchor at level/respawn breaks
// When we last had HARD evidence the two worlds are not the same game: a refused
// input, or a hash that disagreed. Silence alone would not have caught the
// tick-base bug -- packets kept arriving, they were just all unusable.
// -1e9, not 0: performance.now() is legitimately ~0 just after load, and a falsy
// check would then read a real warning as "never warned".
var _rbWarnAt = -1e9;
// The in-game warning, or null. Both causes mean the same thing to a player: what
// the other side is doing is not reaching us.
function netDuelWarn(){
    const s = _netSess;
    if(!s || !s.game || !inGame) return null;
    const nowMs = performance.now();
    if(s.reconnecting) return 'RECONNECTING...';
    if(nowMs - _rbWarnAt < 3000) return 'CONNECTION LOST';
    if(Date.now() - s.lastRecvWall > RB_WARN_MS && !(s.relay && nowMs < s.relayGraceUntil)) return 'CONNECTION LOST';
    return null;
}
function _rbToWire(tk){ return tk - _rbBase; }
function _rbFromWire(tk){ return (tk|0) + _rbBase; }
function _rbReset(){
    _rbRing = []; _rbLog = new Map(); _rbSeq = 0; _rbPeerSeq = -1; _rbSent = []; _rbHashQ = []; _rbStateQ = [];
    _netLagN = [];   // a new match is a new path: do not average across the old one
    _rbBase = simTick;
    _rbPhase = '';
    _rbWarnAt = -1e9;
    _rbDbg = { rb:0, resim:0, drop:0, maxRew:0, desync:0, hashOk:0, lost:0, live:0, fix:0, desyncAt:'' };
}
// Two identical sims fed identical inputs produce identical state, so a hash that
// disagrees IS the divergence -- and, with no state on the wire to fake, it is also
// the only tamper signal a cheat could raise. FNV-1a over the snapshot: simSnapshot
// builds its keys in a fixed order, so the JSON is byte-stable across clients.
// Presentation-only, CLIENT-LOCAL snapshot fields must never enter the hash. The
// snapshot exists to mirror the sim into the worker, so it carries a few things the
// simulation does not actually depend on -- and _shimmerThreshold is derived from
// THIS device's best score in localStorage (startGame; startDuel never resets it).
// Hashing it made two honest clients disagree permanently with nobody even touching
// a key: the recurring DESYNC on free-running snakes. A divergence must mean the
// GAME diverged, or the detector is just noise.
// A duel simulates `players` -- NOT the classic globals. But simSnapshot carries the
// whole sim (it exists to mirror state into the worker), so it also hauls along each
// device's leftovers from its own last single-player game: snake, score, lives, heart,
// _earlyHeartTrigger, _shimmerThreshold (from localStorage!) and the rest. startDuel
// never resets them because the duel never reads them. Hashing all that compared two
// devices' single-player history and called the difference a divergence -- every
// comparison, forever, hash-ok 0, with the two sims in perfect lockstep.
//
// So hash exactly what the duel simulates, and nothing else. A whitelist, not a
// blacklist: a blacklist means the next field added to the snapshot silently rejoins
// the hash and this comes back.
// NOT _barsV: it is a change-TICKER for the worker transport ("bars differ from what
// I last sent"), not game state -- a monotonic counter over every bars change since
// page load, so two devices carry different bases and it can never match. `bars`
// itself is here, which is the actual state; the ticker says nothing extra.
const RB_HASH_DUEL = ['phase','level','gem','gemsDone','bars','simTick','simNow',
    'gPer','_gDue','phaseAt','gemAt','deathMsg','spawnAt','powerPellet','powerPelletAt',
    '_powerMode','_powerModeAt','_barMoveTick','players','duelWinner','_duelX10',
    '_speedRound','_rngState'];
// Per-FIELD hashes alongside the whole-state one. A bare "DESYNC" cannot say what
// diverged -- we hold the peer's hash, not its state, so there is nothing to diff.
// These cost ~600 bytes/s and turn an unactionable alarm into a field name, which is
// the only way to find a divergence that only happens on real devices.
function _rbHashFields(snap){
    const o = {};
    // JSON.stringify(undefined) is undefined, not a string: a field may legitimately be absent.
    for(const k of RB_HASH_DUEL) o[k] = _rbStrHash(JSON.stringify(snap[k]) || 'u');
    return o;
}
function _rbStrHash(s){
    let h = 0x811c9dc5;
    for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
}
function _rbHash(snap){
    let s;
    try {
        const o = {};
        for(const k of RB_HASH_DUEL) o[k] = snap[k];
        s = JSON.stringify(o);
    } catch(e){ return 0; }
    let h = 0x811c9dc5;
    for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
}
// A hash may only be compared once its tick has SETTLED. The peer hashes tick t with
// its own input already applied; our snapshot for t stays provisional until that
// input reaches us and rolls us back. Comparing on arrival therefore mismatches
// every time either player steers -- a false desync once a second, which is not a
// divergence at all, just a race. So park the peer's hash and check it only after
// enough ticks have passed for any in-flight input for t to have landed.
const RB_SETTLE = 30;        // ~500ms: far beyond any latency we would still be playing at
var _rbHashQ = [];           // [{tk, h}] peer hashes waiting for their tick to settle
function _rbCheckHash(m){
    _rbHashQ.push({ tk:_rbFromWire(m.tk), h:m.h>>>0, f:(m.f && typeof m.f === 'object') ? m.f : null });
    if(_rbHashQ.length > 8) _rbHashQ.shift();
}
// Called each tick: compare whatever has settled and is still inside the ring.
function _rbHashSettle(){
    if(!_rbHashQ.length) return;
    for(let i = _rbHashQ.length - 1; i >= 0; i--){
        const q = _rbHashQ[i];
        if(simTick < q.tk + RB_SETTLE) continue;          // still in flight: leave it parked
        _rbHashQ.splice(i, 1);
        let e = null;
        for(let j = _rbRing.length - 1; j >= 0; j--) if(_rbRing[j].tk === q.tk){ e = _rbRing[j]; break; }
        if(!e) continue;                                   // aged out of the ring: not comparable
        if(_rbHash(e.snap) === q.h){ _rbDbg.hashOk++; continue; }
        // Deterministic sims do not drift back into agreement: this one is permanent.
        // NOT a connection warning -- the link is fine, the worlds are not.
        _rbDbg.desync++;
        // NAME the field. Without this a desync is unactionable: it says two worlds
        // differ but not how, and the difference may only exist on real devices.
        let where = '?';
        if(q.f){
            const mine = _rbHashFields(e.snap), bad = [];
            for(const k in mine) if(q.f[k] !== undefined && q.f[k] !== mine[k]) bad.push(k);
            for(const k in q.f) if(mine[k] === undefined) bad.push(k + '(absent)');
            if(bad.length) where = bad.join(',');
        }
        _rbDbg.desyncAt = where;
        _netSigLog('! DESYNC @' + q.tk + ' ' + where);
        _duelMsg = 'DESYNC: ' + where.slice(0, 28); _duelMsgAt = _msgNow(); _uiDirty = true;
    }
}
// ---- Authoritative-state recovery (same deterministic ~1/s tick as the hash) ----
// The hash only DETECTS a divergence; this RECOVERS from it. Each client owns its OWN snake
// and submits it as a flat cell list; the peer overwrites its copy of THAT snake (never its
// own). Gems/items follow the shared PRNG, so the MORE ADVANCED world (higher gemsDone) wins
// and its gem/RNG/power state is adopted. Corrections are applied at the SETTLED tick and
// re-converge through the normal rollback resim -- so both worlds heal without a host.
var _rbStateQ = [];          // [{tk,i,s,gd,...}] peer states parked until their tick settles
function _rbSendState(t, sn){
    if(!sn || !sn.players) return;
    const mi = netMyIndex(), me = sn.players[mi];
    if(!me || !Array.isArray(me.snake)) return;
    const cells = [];
    for(const c of me.snake) cells.push(c.x, c.y);   // flat [x0,y0,x1,y1,...]: compact on the wire
    const o = { t:'st', tk:_rbToWire(t), i:mi, s:cells, gd:sn.gemsDone|0, gem:sn.gem, rng:sn._rngState,
                pp:sn.powerPellet, ppa:sn.powerPelletAt, pm:sn._powerMode, pma:sn._powerModeAt };
    // A very long snake can push the state past the one-datagram cap; skip it this second
    // rather than fragment -- the hash still flags the divergence, recovery just lands later.
    if(JSON.stringify(o).length > NET_PKT_MAX){ _rbDbg.stbig = (_rbDbg.stbig|0) + 1; return; }
    _netSend(o);
}
function _rbCheckState(m){
    if(typeof m.tk !== 'number' || typeof m.i !== 'number' || !Array.isArray(m.s)) return;
    _rbStateQ.push({ tk:_rbFromWire(m.tk), i:m.i|0, s:m.s, gd:m.gd|0, gem:m.gem, rng:m.rng,
                     pp:m.pp, ppa:m.ppa, pm:m.pm, pma:m.pma });
    if(_rbStateQ.length > 8) _rbStateQ.shift();
}
function _rbCellsEqual(a, flat){
    if(!Array.isArray(a) || a.length * 2 !== flat.length) return false;
    for(let i = 0; i < a.length; i++) if(a[i].x !== (flat[2*i]|0) || a[i].y !== (flat[2*i+1]|0)) return false;
    return true;
}
// Called each live tick beside _rbHashSettle: apply any peer state whose tick has settled.
function _rbStateSettle(){
    if(!_rbStateQ.length) return;
    const mine = netMyIndex();
    for(let i = _rbStateQ.length - 1; i >= 0; i--){
        const q = _rbStateQ[i];
        if(simTick < q.tk + RB_SETTLE) continue;         // still in flight: leave it parked
        _rbStateQ.splice(i, 1);
        if(q.i === mine) continue;                       // never let the peer overwrite our own snake
        let e = null;
        for(let j = _rbRing.length - 1; j >= 0; j--) if(_rbRing[j].tk === q.tk){ e = _rbRing[j]; break; }
        if(!e || !e.snap || !e.snap.players || !e.snap.players[q.i]) continue;   // aged out / not comparable
        let changed = false;
        // Per-owner snake authority: adopt the peer's own snake if our copy of it differs.
        if(!_rbCellsEqual(e.snap.players[q.i].snake, q.s)){
            const cells = [];
            for(let k = 0; k + 1 < q.s.length; k += 2) cells.push({ x:q.s[k]|0, y:q.s[k+1]|0 });
            e.snap.players[q.i].snake = cells;
            changed = true;
        }
        // Gems/items follow the PRNG: the more advanced world (higher gemsDone) wins.
        if(q.gd > (e.snap.gemsDone|0)){
            e.snap.gemsDone = q.gd; e.snap.gem = q.gem; e.snap._rngState = q.rng;
            e.snap.powerPellet = q.pp; e.snap.powerPelletAt = q.ppa;
            e.snap._powerMode = q.pm; e.snap._powerModeAt = q.pma;
            changed = true;
        }
        if(changed){ _rbDbg.fix = (_rbDbg.fix|0) + 1; _netSigLog('~ FIX @' + q.tk + ' i' + q.i); _rbRollback(q.tk); }
    }
}
// The ring must own its states: simSnapshot() hands out LIVE references (the sim
// mutates players[i].snake in place), so an un-cloned entry would rot as the game
// runs. structuredClone keeps the Sets that JSON would silently flatten.
function _rbClone(o){
    if(typeof structuredClone === 'function') return structuredClone(o);
    const c = JSON.parse(JSON.stringify(o));
    c._gourangaEaten = new Set();   // JSON cannot carry a Set (classic-only state)
    return c;
}
function _rbAdd(tk, cmd){
    let a = _rbLog.get(tk);
    if(!a){ a = []; _rbLog.set(tk, a); }
    a.push(cmd);
}
// The ring entry for a tick MUST be the state BEFORE that tick's commands -- that is
// what makes it a rollback point, and what makes the hash mean the same thing on both
// clients. Our own input is applied live, before netTickPre reaches its tick, so
// without this the snapshot would bake it in while the peer -- applying the SAME input
// at the SAME tick, but after ITS snapshot -- hashed the state without it. Identical
// sims, different snapshot boundary, and a desync reported on every steer.
function _rbEnsureSnap(t){
    if(_rbRing.length && _rbRing[_rbRing.length-1].tk === t) return;   // already have it
    _rbRing.push({ tk:t, snap:_rbClone(simSnapshot()) });
    if(_rbRing.length > RB_RING) _rbRing.shift();
}
// Which snake is ours. The offerer is P0 and the answerer P1 -- an index, not a
// rank: neither client can touch the other's snake, and there is no authority.
function netMyIndex(){ return (_netSess && _netSess.role === 'host') ? 0 : 1; }
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
        _rbWarnAt = performance.now();
        return null;
    }
    return t;
}
// Called by the game loop immediately BEFORE each update(). Records the state the
// tick starts from, then feeds that tick its inputs -- local and remote alike, so
// a re-simulation reproduces the tick exactly.
function netTickPre(){
    if(!netGameActive() || !inGame) return;
    const t = simTick + 1;                       // update() increments first: this is the tick about to run
    _rbEnsureSnap(t);
    // Our own input was applied the moment it happened (netLocalInput), at exactly this
    // point in the tick order -- so skip it here or it lands twice. A ROLLBACK re-sim
    // goes through _rbRollback, which applies the log in full: _live is only about this
    // live pass.
    const cmds = _rbLog.get(t);
    if(cmds) for(const c of cmds){ if(!c._live) simCommand(c); }
    if(!_replaying){ _rbHashSettle(); _rbStateSettle(); }
    // NO re-anchor here. The tick is floor((netPts() - startPts) / TICK_MS), so moving
    // the anchor while startPts stays put SHIFTS THE WHOLE TIMELINE: the target jumps by
    // however far the clock moved, and if it jumps backwards simTick is suddenly ahead
    // of it and the loop stops ticking entirely -- the sim freezes for exactly that long.
    // A device clock is seconds off (anchor -2318ms in the field), so this froze the game
    // for ~10s at the start of a duel: no movement, no dpad, not even the exit button,
    // because nothing was simulating at all.
    //
    // That is why the contract pairs them: "a fresh sync ALWAYS precedes a new start
    // PTS". A re-anchor is only safe together with a new start_pts, which re-bases the
    // timeline to match. _netRequestStart already does exactly that pairing, and it is
    // the only place allowed to. When the per-level/respawn starts land, they get their
    // re-anchor for free by going through it.
    if(!_replaying) _rbPhase = phase;
    if((t & 63) === 0){
        for(const k of _rbLog.keys()) if(k < t - RB_RING - 8) _rbLog.delete(k);
        // Full state + hash every 64 ticks (~1s): the state snapshot repairs a divergence,
        // the hash detects one. Sent at the tick boundary so it has the whole ring window
        // to arrive. Keyed to the deterministic tick, so both clients emit on the same tick.
        if(!_replaying){
            const sn = _rbRing[_rbRing.length-1].snap;
            _netSend({ t:'h', tk:_rbToWire(t), h:_rbHash(sn), f:_rbHashFields(sn) });
            _rbSendState(t, sn);
        }
    } else if((t & 15) === 0 && !_replaying){
        // 16-tick heartbeat (~267ms), on the OFF-64 ticks so it never doubles up with the
        // full state. Carries the recent input log = free input-redundancy repair, and keeps
        // SOMETHING on the wire every 16 ticks for liveness.
        _netSend({ t:'in', tk:_rbToWire(simTick), l:_rbSent });
    }
}
// Rewind to `toTick` and re-simulate to where we were, now including the input
// that arrived late. Silent: _replaying keeps the re-run from re-firing visuals
// that already played.
function _rbRollback(toTick){
    let idx = -1;
    for(let i = _rbRing.length - 1; i >= 0; i--) if(_rbRing[i].tk <= toTick){ idx = i; break; }
    if(idx < 0) return false;                    // older than the ring: unrecoverable
    const from = _rbRing[idx].tk, target = simTick, keep = phase, preBarsV = _barsV;
    simApply(_rbClone(_rbRing[idx].snap));       // clone: the ring entry stays pristine
    _sfxQ = _sfxQ.filter(q => q.tk <= simTick);  // sounds predicted past the rewind: cancelled...
    _fxQ  = _fxQ.filter(q => q.tk <= simTick);   // ...same for visual effects (bonus/crush/fireworks)
    _rbRing.length = idx;                        // these states are void; re-recorded below
    _replaying = true;
    for(let t = from; t <= target; t++){
        _rbRing.push({ tk:t, snap:_rbClone(simSnapshot()) });
        const cmds = _rbLog.get(t);
        if(cmds) for(const c of cmds) simCommand(c);
        update();
        if(simEvents.length) drainSimEvents();   // ...and the re-run queues the RIGHT ones
    }
    _replaying = false;
    simEvents.length = 0;
    if(_rbRing.length > RB_RING) _rbRing.splice(0, _rbRing.length - RB_RING);
    if(_barsV !== preBarsV && typeof renderBarsOffscreen === 'function') renderBarsOffscreen();
    if(keep === 'quitConfirm'){                  // the quit overlay survives a rewind
        if(phase !== 'duelOver'){ prevPhase = phase; phase = keep; }
        else Snd.duck(false);
    }
    _rbDbg.rb++; _rbDbg.resim += (target - from + 1);
    _rbDbg.maxRew = Math.max(_rbDbg.maxRew, target - from + 1);
    _uiDirty = true;
    return true;
}
// Did players[pi]'s head move between tick `tk` and now? A moved head means a step ran
// (and consumed whatever direction was queued) since tk, so a late dir for tk missed its
// step and must be rewound in. Head unmoved => the dir is still pending => apply it live.
// The ring holds the PRE-tick snapshot for every ticked tick within RB_RING; if tk aged
// out (or anything looks off), assume a step happened -> rewind (the safe answer).
function _rbPeerSteppedSince(pi, tk){
    if(!players || !players[pi] || !players[pi].snake.length) return true;
    let snap = null;
    for(let i = _rbRing.length - 1; i >= 0; i--) if(_rbRing[i].tk === tk){ snap = _rbRing[i].snap; break; }
    if(!snap || !snap.players || !snap.players[pi] || !snap.players[pi].snake.length) return true;
    const a = players[pi].snake[0], b = snap.players[pi].snake[0];
    return a.x !== b.x || a.y !== b.y;
}
// The peer's inputs -> our log, always under the OTHER index: a hostile peer can
// steer nothing but its own snake. Each packet repeats the last few inputs, so a
// lost one is repaired by the next without a retransmit (the DataChannel is
// deliberately unreliable).
function _netPeerInput(m){
    if(!netGameActive() || !inGame || !Array.isArray(m.l)) return;
    // Every packet -- including the idle keepalive -- carries the sender's own tick, so
    // read the offset HERE. Reading it per-record only updated while the peer was
    // actively steering, because a redundant record continues past it: the number then
    // froze at whatever the last steer said and looked like a dead readout.
    if(typeof m.tk === 'number'){
        // Sub-tick precise offset from the shared clock (peer's send PTS vs our now), so the
        // readout shows fractions instead of a floored tick. Falls back to the integer tick
        // difference if a PTS is missing. DIAGNOSTIC ONLY -- nothing consumes this value.
        const _p = netPts();
        _netDbg.peerTkOfs = (typeof m.pts === 'number' && _p != null)
            ? (m.pts - _p) / TICK_MS
            : (_rbFromWire(m.tk) - simTick);
    }
    const oP = 1 - netMyIndex();
    let earliest = Infinity;
    for(const r of m.l){
        const q = r.q|0;
        if(q <= _rbPeerSeq) continue;            // already applied (redundant copy)
        // Sequence gap the redundancy window could NOT cover = inputs truly lost. Every
        // packet repeats the last RB_REDUNDANCY inputs, so a gap only survives to here once
        // the missing q has been shifted off the sender's log (>RB_REDUNDANCY packets in a
        // row lost). The gap size IS the lost-input count. (_rbPeerSeq < 0 = first ever.)
        if(_rbPeerSeq >= 0 && q > _rbPeerSeq + 1) _rbDbg.lost += (q - _rbPeerSeq - 1);
        const tk = _rbFromWire(r.tk);            // their duel-relative tick -> our counter
        const d = (r.d && typeof r.d === 'object') ? { x:r.d.x|0, y:r.d.y|0 } : null;
        const okDir = d && Math.abs(d.x) + Math.abs(d.y) === 1;
        let cmd = null;
        if(r.k === 'dir' && okDir)     cmd = { t:'dir', p:oP, dir:d };
        else if(r.k === 'bs' && okDir) cmd = { t:'boost', p:oP, dir:d, now:!!r.n };
        else if(r.k === 'be')          cmd = { t:'boostend', p:oP };
        else if(r.k === 'adv')         cmd = { t:'advance' };   // peer started the next level
        if(!cmd){ _rbDbg.drop++; _rbWarnAt = performance.now(); continue; }
        // Beyond the rewind window there is no honest way to honour it: applying it
        // at the wrong tick would desync the two worlds silently. Refuse, visibly.
        if(tk <= simTick - RB_RING){ _rbDbg.drop++; _rbWarnAt = performance.now(); _netSigLog('! input too old @' + tk); continue; }
        // Authored far ahead of us: an honest peer stamps its OWN current tick.
        if(tk > simTick + RB_FUTURE){ _rbDbg.drop++; _rbWarnAt = performance.now(); _netSigLog('! input from the future @' + tk); continue; }
        _rbPeerSeq = q;
        _rbAdd(tk, cmd);
        _netDbg.inRx++;
        _netDbg.inLog.unshift(String(r.k) + '@' + tk);
        if(_netDbg.inLog.length > 5) _netDbg.inLog.length = 5;
        if(tk <= simTick){
            // A late input can often be applied RIGHT NOW instead of rewinding, when doing so
            // reaches the IDENTICAL state a replay-at-tk would -- the whole slack the step
            // interval (and the boost grace) gives us. Each such case is bit-identical to the
            // rewind, so it converges with an un-upgraded peer; it is just the cheaper path.
            //  - dir: takes effect only at the peer's next STEP. If the peer has NOT stepped
            //    since tk (head unmoved), the queued turn is still pending -> apply live.
            //  - boost start, grace-delayed (keyboard/dpad, cmd.now false): only ARMS the boost;
            //    it does not engage for BOOST_GRACE_TICKS. If it has not had time to engage on
            //    either sim, it has changed nothing yet -> apply live, anchoring boostSince to
            //    the REAL tick (the log replays at tk, so a later rewind stays consistent).
            //  - boost end: matters only if a boosted step already ran since tk (head moved).
            // Applied live AND logged: a later rewind past tk restores the snapshot (dropping
            // this live effect) and replays from the log, so it lands exactly once either way.
            let live = false;
            if(cmd.t === 'dir')           live = !_rbPeerSteppedSince(oP, tk);
            else if(cmd.t === 'boost')    live = !cmd.now && (simTick - tk) < BOOST_GRACE_TICKS;
            else if(cmd.t === 'boostend') live = !_rbPeerSteppedSince(oP, tk);
            if(live){
                simCommand(cmd);
                // The sender applied it at its simTick (= tk-1; it stamps tk = simTick+1), and
                // both the rollback resim and netTickPre apply it at tk-1 too. Anchor there.
                if(cmd.t === 'boost') players[oP].boostSince = tk - 1;
                _rbDbg.live++;
            } else if(tk < earliest) earliest = tk;   // ran through its step / already engaged: rewind
        } else {
            // Arrived AHEAD of its tick: just logged above, netTickPre applies it on time. This
            // is the best case (the behind-client sees the ahead-client's inputs like this) --
            // count it as live too: it lands with no rewind.
            _rbDbg.live++;
        }
    }
    if(earliest !== Infinity) _rbRollback(earliest);
}
// Local input during an online duel. It is applied IMMEDIATELY -- exactly like
// single player -- and also logged for the tick it belongs to, so a rollback
// re-simulation reproduces it.
//
// Logging it WITHOUT applying it was wrong: it made online input wait for netTickPre
// to run, which quietly coupled the controls to the tick loop. The moment that loop
// is not ticking (at a match start the clock-driven target is not ahead of us yet)
// the input just sat in the log, unapplied -- dead controls and dead boost for the
// first seconds of a duel, on every device. Single player never had that because it
// applies on the spot. The sim is the same, so the input path must be the same.
// Returns true when the online path consumed it; p!==0 is swallowed (no local P2).
function netLocalInput(kind, p, d, now){
    if(!netGameActive()) return false;
    if(p !== 0) return true;
    if(!inGame) return true;
    const myP = netMyIndex();
    const tk = simTick + 1;
    const cmd = kind === 'dir' ? { t:'dir', p:myP, dir:{x:d.x,y:d.y} }
              : kind === 'bs'  ? { t:'boost', p:myP, dir:{x:d.x,y:d.y}, now:!!now }
              : kind === 'adv' ? { t:'advance' }   // start the next level -- same command single player sends
                               : { t:'boostend', p:myP };
    _rbEnsureSnap(tk);   // pin the PRE-input state as tk's rollback point, before we apply it
    cmd._live = true;    // netTickPre must not apply it a second time (a re-sim still does)
    _rbAdd(tk, cmd);
    simCommand(cmd);   // NOW, like single player. The log is for the re-sim, not the delivery.
    const rec = { q:++_rbSeq, tk:_rbToWire(tk), k:kind, d: d ? {x:d.x, y:d.y} : null, n: now?1:0 };
    _rbSent.push(rec);
    if(_rbSent.length > RB_REDUNDANCY) _rbSent.shift();
    _netDbg.inTx++;
    _netSend({ t:'in', tk:_rbToWire(simTick), l:_rbSent });   // the whole recent log: redundancy, not just this one
    return true;
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
    const s = _netSess; _netSess = null;   // nulling this stops the relay loop + liveness (both check _netSess === s)
    if(!s) return;
    if(s.peer) delete _netPeerNet[s.peer];   // the IP hint was for THIS match's path; a new match (or a network switch) gets a fresh one
    s.game = false; s.relay = false;
    if(s.connT) clearTimeout(s.connT);
    if(s.liveT) clearInterval(s.liveT);
    if(s.relayAbort){ try{ s.relayAbort.abort(); }catch(e){} s.relayAbort = null; }   // close the held relay socket now
    try{ if(s.dc){ s.dc.onopen=s.dc.onmessage=s.dc.onclose=null; s.dc.close(); } }catch(e){}
    try{ if(s.pc){ s.pc.onconnectionstatechange=s.pc.onicecandidate=s.pc.ondatachannel=null; s.pc.close(); } }catch(e){}
}

// ---- global highscores ----
// The classic-game input log: tick-stamped [tick, code] pairs recorded main-side,
// sent with the score as replay material (server-side validation, see API.md).
// Codes: 0-3 steer URDL-order (see _netDirCode), 4-7 boost start + dir, 8 boost end.
let _netSeed = 0, _netInputs = [];
function _netDirCode(d){ return d.y < 0 ? 0 : d.x > 0 ? 1 : d.y > 0 ? 2 : 3; }
function netNoteGameStart(seed){ _netSeed = seed>>>0; _netInputs = []; }
function _netLog(code){ if(inGame && !players && _netInputs.length < 20000) _netInputs.push([simTick|0, code]); }
function netLogDir(d){ _netLog(_netDirCode(d)); }
function netLogBoost(d){ _netLog(4 + _netDirCode(d)); }
function netLogBoostEnd(){ _netLog(8); }
function netSubmitScore(name, sc, lvl){
    if(!_netOk() || !(sc > 0)) return;
    _netPost('/api/scores.php', {
        id: getPlayerId(), name: String(name).slice(0,MAX_NAME),
        score: sc|0, level: Math.max(1, lvl|0),
        diff: cfg.diff|0, color: cfg.snakeColor|0, shopItems: cfg.wornItems||{},
        seed: _netSeed, inputs: _netInputs,
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
