// ============================================================================
// duel-core.js -- the DETERMINISTIC ROLLBACK CORE of the online 1:1 duel: the
// snapshot ring, the input log, live-apply vs rewind, hashes, state recovery and
// the full resync. Split out of net.js so the same code runs in TWO homes:
//   - the SIM WORKER (the default wherever Worker exists): sim-worker.js
//     importScripts this file and drives it off its own clock; net.js forwards
//     wire packets in ({t:'peerPkt'}) and local inputs ({t:'lin'}), and the
//     core's sends/debug ride postMessage back out;
//   - the MAIN thread (no-Worker browsers + the headless test harness), driven
//     by game.js loop() via netTickPre(), talking to net.js directly.
// net.js keeps everything transport: sessions, signaling, WebRTC, the clock
// sync, netDuelWarn/netMyIndex/netTickTarget (they read session state).
// ============================================================================
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
// Max JSON we will put in one DataChannel message. 1280 is the IPv6 minimum MTU (and a
// safe IPv4 floor); ~70B goes to IP+UDP+DTLS+SCTP headers, so the payload budget is
// what is left. Worst case today: an 'in' with a full 12-input redundant log (~711B)
// and an 'hfr'-reply 'h' with per-field hashes (~561B). Declared HERE (not net.js):
// both the transport and the core enforce it, and the sim worker loads only the core.
const NET_PKT_MAX = 1200;
const RB_RING = 32;          // ring ENTRIES kept. Snapshots are THINNED (RB_SNAP_EVERY), so these
                             // entries span RB_DEPTH ticks at half the per-tick clone cost.
                             // Rollback is for short hiccups only: something arrives every 16
                             // ticks; a divergence older than the ring gets a full resync.
const RB_SNAP_EVERY = 2;     // snapshot every 2nd tick: a rollback lands on the nearest earlier
                             // entry and re-sims at most one extra tick -- a sub-microsecond tick
                             // against a full clone saved on every other tick.
const RB_DEPTH = RB_RING * RB_SNAP_EVERY;   // rewind window in TICKS (~1067ms at 60Hz)
const RB_FUTURE = 16;        // an input authored more than one heartbeat (16 ticks) ahead of us is not
                             // honest -- treat it as a connection problem and refuse it
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
var _rbBadAt = -1e9;      // tick of the last hash mismatch: opens the st repair window
var _rbFdReqTk = -1;      // tick we asked the peer to re-hash WITH per-field hashes (dedup)
const RB_ST_WINDOW = 600; // ~10s of st repair after a mismatch, then the wire goes quiet again
function _rbToWire(tk){ return tk - _rbBase; }
function _rbFromWire(tk){ return (tk|0) + _rbBase; }
function _rbReset(){
    _rbRing = []; _rbLog = new Map(); _rbHeads = new Map(); _rbSeq = 0; _rbPeerSeq = -1; _rbSent = []; _rbHashQ = []; _rbStateQ = [];
    _rbResyncSend = 0;
    _rbBadAt = -1e9; _rbFdReqTk = -1;
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
    'gPer','_gDue','_gAt','phaseAt','gemAt','deathMsg','spawnAt','powerPellet','powerPelletAt',
    '_powerMode','_powerModeAt','_barMoveTick','players','duelWinner','_duelX10',
    '_speedRound','_rngState'];
// Ring snapshots are duel-SCOPED: the hash whitelist plus the two unhashed fields a
// duel tick still touches (_barsV is the bars change-ticker the renderer watches;
// levelDoneWaiting gates 'advance'). The full simSnapshot would drag every classic-
// mode leftover (hearts, gouranga sets, the classic snake) through structuredClone
// dozens of times a second -- dead weight the duel never reads, cloned and GC'd for
// nothing. Applied back via simApplyDuel (sim.js), which writes exactly this set.
// Built DIRECTLY from the sim globals -- this runs dozens of times a second, so it
// must not materialize the full classic-mode snapshot just to subset it. The set =
// the hash whitelist above plus the two unhashed fields a duel tick still touches.
// KEEP IN SYNC with simApplyDuel (sim.js), which writes exactly this set back on a
// rollback restore.
function _rbDuelSnap(){
    return { phase, level, gem, gemsDone, bars, _barsV, simTick, simNow, gPer, _gDue, _gAt,
             phaseAt, gemAt, deathMsg, spawnAt, levelDoneWaiting,
             powerPellet, powerPelletAt, _powerMode, _powerModeAt, _barMoveTick,
             players, duelWinner, _duelX10, _speedRound, _rngState };
}
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
// Whole hash + per-field hashes from ONE serialization pass. JSON.stringify of the
// whitelist object is byte-identical to '{' + the '"key":<field JSON>' parts joined by
// ',' + '}' (insertion order; undefined fields omitted -- exactly what JSON.stringify
// does), so both hashes come out wire-identical to _rbHash/_rbHashFields while the
// state is only walked once. This is the 64-tick boundary's hot path: the separate
// calls were the single biggest recurring main-thread spike.
function _rbHashBoth(snap){
    try {
        const f = {}, parts = [];
        for(const k of RB_HASH_DUEL){
            const s = JSON.stringify(snap[k]);   // undefined when the field is absent
            f[k] = _rbStrHash(s === undefined ? 'u' : s);
            if(s !== undefined) parts.push('"' + k + '":' + s);
        }
        return { h: _rbStrHash('{' + parts.join(',') + '}'), f };
    } catch(e){ return { h: 0, f: null }; }
}
// A hash may only be compared once its tick has SETTLED. The peer hashes tick t with
// its own input already applied; our snapshot for t stays provisional until that
// input reaches us and rolls us back. Comparing on arrival therefore mismatches
// every time either player steers -- a false desync once a second, which is not a
// divergence at all, just a race. So park the peer's hash and check it only after
// enough ticks have passed for any in-flight input for t to have landed.
const RB_SETTLE = 24;        // HASH settle (~400ms): a hash may only be compared once our own
                             // snapshot of its tick has stopped moving, or a late input makes it
                             // read as a false desync every time either player steers.
const RB_STATE_SETTLE = 0;   // STATE settle: NONE. The peer's snake is AUTHORITATIVE and does not
                             // depend on our inputs settling, so apply it the moment its tick is in
                             // the past (simTick >= tk) -- no wait. Applying immediately keeps the
                             // correction in the seamless in-ring path; a future-stamped state (tk >
                             // simTick) still parks here until we reach its tick.
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
        if(_rbHash(e.snap) === q.h){ _rbDbg.hashOk++; if(q.tk === _rbFdReqTk) _rbFdReqTk = -1; continue; }
        // Deterministic sims do not drift back into agreement: this one is permanent.
        // NOT a connection warning -- the link is fine, the worlds are not.
        // An 'hfr' REPLY (fields for a tick we already flagged) is the SAME divergence
        // coming back with names -- it must not count, warn or re-arm a second time.
        const isReply = !!q.f && q.tk === _rbFdReqTk;
        if(!isReply){
            _rbDbg.desync++;
            _rbBadAt = simTick;                        // open the st repair-channel window
            // A confirmed divergence the rollback recovery could not prevent: the host ships a full
            // resync so the peer adopts the whole authoritative state (the only cure for a structural
            // desync). Re-armed here every mismatch, so it keeps trying until the hashes agree again.
            if(netMyIndex() === 0) _rbResyncSend = RB_RESYNC_BURST;
            _rbWarnAt = performance.now();
        }
        // NAME the field. Without this a desync is unactionable: it says two worlds
        // differ but not how, and the difference may only exist on real devices.
        let where = '?';
        if(q.f){
            const mine = _rbHashFields(e.snap), bad = [];
            for(const k in mine) if(q.f[k] !== undefined && q.f[k] !== mine[k]) bad.push(k);
            for(const k in q.f) if(mine[k] === undefined) bad.push(k + '(absent)');
            if(bad.length) where = bad.join(',');
            _rbFdReqTk = -1;
        } else if(q.tk !== _rbFdReqTk){
            // The periodic hash travels BARE; the field hashes exist only to name a
            // divergence. Ask the peer to re-hash THIS tick with fields -- its ring
            // spans RB_DEPTH ticks, and settle plus a round trip sits well inside that.
            _rbFdReqTk = q.tk;
            _netSend({ t:'hfr', tk:_rbToWire(q.tk) });
        }
        _rbDbg.desyncAt = where;
        _netSigLog('! DESYNC @' + q.tk + ' ' + where);
        _duelMsg = 'DESYNC: ' + where.slice(0, 28); _duelMsgAt = _msgNow(); _uiDirty = true;
    }
}
// The peer's whole-hash disagreed with ours for this tick and it wants the per-field
// hashes to name the divergence: recompute from the ring and reply as a normal 'h'
// carrying `f` (the requester re-compares it through the same settle path). Aged out
// of the ring = no reply; the requester's '?' stands.
function _rbFieldHashReq(m){
    // The request itself is positive evidence the peer sees a divergence with us --
    // open our st repair window here too, so repair flows even when the peer's own
    // hashes never reach us.
    _rbBadAt = simTick;
    const tk = _rbFromWire(m.tk);
    for(let j = _rbRing.length - 1; j >= 0; j--) if(_rbRing[j].tk === tk){
        const hb = _rbHashBoth(_rbRing[j].snap);
        _netSend({ t:'h', tk:m.tk, h:hb.h, f:hb.f });
        return;
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
    const pts = netPts();
    if(pts != null) o.pts = pts;   // stamped HERE so the size check sees the final packet and the string can be reused
    // A very long snake can push the state past the one-datagram cap; skip it this second
    // rather than fragment -- the hash still flags the divergence, recovery just lands later.
    const j = JSON.stringify(o);
    if(j.length > NET_PKT_MAX){ _rbDbg.stbig = (_rbDbg.stbig|0) + 1; return; }
    _netSend(o, j);
}
function _rbCheckState(m){
    if(typeof m.tk !== 'number' || typeof m.i !== 'number' || !Array.isArray(m.s)) return;
    _rbStateQ.push({ tk:_rbFromWire(m.tk), i:m.i|0, s:m.s, gd:m.gd|0, gem:m.gem, rng:m.rng,
                     pp:m.pp, ppa:m.ppa, pm:m.pm, pma:m.pma });
    if(_rbStateQ.length > 8) _rbStateQ.shift();
}
// ---- FULL RESYNC: the whole duel state, from the HOST as authority, for a divergence too deep
// for the ring to rewind. The peer adopts everything (level, bars, phase, gems, rng, the host's
// snake) but KEEPS its own snake -- the host's view of it is stale and the peer's 'st' repairs the
// host's side. This is the only thing that heals a STRUCTURAL desync (the 'st' packet carries no
// level/bars/phase). Sent in a small burst because the channel is unreliable and this can fragment.
const RB_RESYNC_BURST = 4;
var _rbResyncSend = 0;       // full-resync sends still owed (host only)
function _rbPackPlayer(p){
    const s = []; for(const c of p.snake) s.push(c.x, c.y);
    return { s, d:p.dir, dq:p.dirQueue, bd:p.boostDir, bs:p.boostSince|0, bg:!!p.boosting,
             sa:p.stepAccum, sc:p.score|0, l:p.lives|0, al:p.alive!==false, su:p.slowUntil|0 };
}
// tk MUST be the ring entry's own tick (not the live simTick, which is one behind in netTickPre),
// or the peer applies it to the wrong ring slot. Carries EVERY field the hash covers (RB_HASH_DUEL)
// so an adopting peer becomes byte-identical -- a missing field would keep the hashes apart forever.
function _rbFullState(sn, tk){
    if(!sn || !sn.players || !sn.players[0] || !sn.players[1]) return null;
    return { t:'rs', tk:_rbToWire(tk),
        ph:sn.phase, lv:sn.level|0, gd:sn.gemsDone|0, gem:sn.gem, ga:sn.gemAt, dm:sn.deathMsg, bv:sn._barsV|0,
        bars:sn.bars.map(b => [b.x, b.y, (b.fragile?1:0)|(b.paired?2:0), b.pairEnd?b.pairEnd.x:-1, b.pairEnd?b.pairEnd.y:-1]),
        gp:sn.gPer, gdue:sn._gDue, pha:sn.phaseAt, spa:sn.spawnAt, ldw:!!sn.levelDoneWaiting,
        rng:sn._rngState, sr:!!sn._speedRound, dw:sn.duelWinner, x10:!!sn._duelX10,
        pp:sn.powerPellet, ppa:sn.powerPelletAt, pm:!!sn._powerMode, pma:sn._powerModeAt, bmt:sn._barMoveTick|0,
        p0:_rbPackPlayer(sn.players[0]), p1:_rbPackPlayer(sn.players[1]) };
}
function _rbApplyResync(m){
    if(!players || !m || !m.p0 || !m.p1) return;
    const T = _rbFromWire(m.tk);
    const unpackInto = (pk, into) => {
        const s = []; for(let k = 0; k + 1 < pk.s.length; k += 2) s.push({ x:pk.s[k]|0, y:pk.s[k+1]|0 });
        into.snake = s; into.dir = pk.d; into.dirQueue = pk.dq || []; into.boostDir = pk.bd;
        into.boostSince = pk.bs|0; into.boosting = !!pk.bg; into.stepAccum = pk.sa;
        into.score = pk.sc|0; into.lives = pk.l|0; into.alive = pk.al !== false; into.slowUntil = pk.su|0;
    };
    // The FULL authoritative snapshot AT tick T. Lockstep needs both sims byte-identical, so we
    // adopt BOTH snakes (keeping our own would guarantee a permanent mismatch -> resync forever).
    const snap = simSnapshot();
    snap.phase = m.ph; snap.level = m.lv|0; snap.gemsDone = m.gd|0; snap.gem = m.gem; snap.gemAt = m.ga; snap.deathMsg = m.dm; snap._barsV = (snap._barsV|0) + 1;
    snap.bars = (m.bars || []).map(a => { const b = { x:a[0]|0, y:a[1]|0, fragile:!!(a[2]&1), paired:!!(a[2]&2) }; if(a[3] >= 0) b.pairEnd = { x:a[3]|0, y:a[4]|0 }; return b; });
    snap.gPer = m.gp; snap._gDue = m.gdue; snap.phaseAt = m.pha; snap.spawnAt = m.spa; snap.levelDoneWaiting = !!m.ldw;
    snap._rngState = m.rng; snap._speedRound = !!m.sr; snap.duelWinner = m.dw; snap._duelX10 = !!m.x10;
    snap.powerPellet = m.pp; snap.powerPelletAt = m.ppa; snap._powerMode = !!m.pm; snap._powerModeAt = m.pma; snap._barMoveTick = m.bmt|0;
    unpackInto(m.p0, snap.players[0]); unpackInto(m.p1, snap.players[1]);
    snap.simTick = T - 1; snap.simNow = (T - 1) * TICK_MS;   // ring convention: entry tk=T holds the state at simTick T-1
    // Apply it at T through the SAME path a normal correction uses: drop it into the ring entry
    // for T and roll forward, replaying the logged inputs. Both sims then land on identical state
    // at T and evolve identically -> they converge and STAY converged (no loop). If T has aged out
    // of the ring (clocks drifted far), fall back to a hard apply at our current tick.
    let e = null;
    for(let j = _rbRing.length - 1; j >= 0; j--) if(_rbRing[j].tk === T){ e = _rbRing[j]; break; }
    if(e){ e.snap = _rbClone(snap); _rbRollback(T); }
    else { snap.simTick = simTick; snap.simNow = simNow; simApply(snap); _rbRing = []; _rbLog = new Map(); }
    _rbStateQ = []; _rbHashQ = [];
    _rbResyncSend = 0;
    _rbDbg.fix = (_rbDbg.fix|0) + 1; _rbWarnAt = performance.now();
    _netSigLog('~ RESYNC @' + T);
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
        if(simTick < q.tk + RB_STATE_SETTLE) continue;   // authoritative: apply almost immediately (not the hash wait)
        _rbStateQ.splice(i, 1);
        if(q.i === mine) continue;                       // never let the peer overwrite our own snake
        const cells = [];
        for(let k = 0; k + 1 < q.s.length; k += 2) cells.push({ x:q.s[k]|0, y:q.s[k+1]|0 });
        let e = null;
        for(let j = _rbRing.length - 1; j >= 0; j--) if(_rbRing[j].tk === q.tk){ e = _rbRing[j]; break; }
        if(e && e.snap && e.snap.players && e.snap.players[q.i]){
            // Recent enough to be in the ring: patch the historical snapshot and roll forward, so
            // the correction lands seamlessly (no visible jump).
            let changed = false;
            if(!_rbCellsEqual(e.snap.players[q.i].snake, q.s)){ e.snap.players[q.i].snake = cells; changed = true; }
            if(q.gd > (e.snap.gemsDone|0)){                 // gems/items follow the PRNG: the more advanced world wins
                e.snap.gemsDone = q.gd; e.snap.gem = q.gem; e.snap._rngState = q.rng;
                e.snap.powerPellet = q.pp; e.snap.powerPelletAt = q.ppa;
                e.snap._powerMode = q.pm; e.snap._powerModeAt = q.pma;
                changed = true;
            }
            if(changed){ _rbDbg.fix = (_rbDbg.fix|0) + 1; _netSigLog('~ FIX @' + q.tk + ' i' + q.i); _rbRollback(q.tk); }
        } else {
            // Aged out of the ring: too old to rewind to. Do NOT incrementally snap the snake
            // (that jumps every second and never heals the structural state); a divergence this
            // deep needs a FULL resync of the whole game state -- the host owns that (below).
            if(netMyIndex() === 0) _rbResyncSend = RB_RESYNC_BURST;   // I'm host: ship the full state
            _rbWarnAt = performance.now();                            // one CONNECTION LOST flash while it heals
        }
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
// Head positions per tick (BEFORE the tick ran), kept BESIDE the thinned ring: the
// live-apply test (_rbPeerSteppedSince) needs the exact-tick head, which the ring no
// longer holds for every tick. Four ints per tick instead of a full clone.
var _rbHeads = new Map();
function _rbNoteHeads(t, force){
    if(!players || (!force && _rbHeads.has(t))) return;
    const a = players[0] && players[0].snake[0], b = players[1] && players[1].snake[0];
    if(!a || !b) return;
    _rbHeads.set(t, [a.x, a.y, b.x, b.y]);
}
function _rbEnsureSnap(t){
    _rbNoteHeads(t);                          // every tick, including the thinned ones
    if(t % RB_SNAP_EVERY) return;             // thinned: this tick rewinds via the previous entry
    if(_rbRing.length && _rbRing[_rbRing.length-1].tk === t) return;   // already have it
    _rbRing.push({ tk:t, snap:_rbClone(_rbDuelSnap()) });
    if(_rbRing.length > RB_RING) _rbRing.shift();
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
        for(const k of _rbLog.keys()) if(k < t - RB_DEPTH - 8) _rbLog.delete(k);
        for(const k of _rbHeads.keys()) if(k < t - RB_DEPTH - 8) _rbHeads.delete(k);
        // Full state + hash every 64 ticks (~1s): the state snapshot repairs a divergence,
        // the hash detects one. Sent at the tick boundary so it has the whole ring window
        // to arrive. Keyed to the deterministic tick, so both clients emit on the same tick.
        if(!_replaying && _rbRing.length){
            const sn = _rbRing[_rbRing.length-1].snap;
            // The periodic hash travels BARE (~60B). The per-field hashes exist only to
            // NAME a divergence, so they are fetched on demand ('hfr') on a mismatch --
            // shipping them every healthy second would spend ~500B/s on data that is
            // only ever read when the whole hash disagrees.
            _netSend({ t:'h', tk:_rbToWire(t), h:_rbHash(sn) });
            // The authoritative-state channel is REPAIR; on a healthy link it is a
            // byte-for-byte no-op. Send it only while a divergence is recent -- the
            // hash detects one within ~1s and re-opens the window.
            if(t - _rbBadAt < RB_ST_WINDOW) _rbSendState(t, sn);
        }
    } else if((t & 15) === 0 && !_replaying){
        // 16-tick heartbeat (~267ms), on the OFF-64 ticks so it never doubles up with the
        // full state. Carries the recent input log = free input-redundancy repair, and keeps
        // SOMETHING on the wire every 16 ticks for liveness.
        _netSend({ t:'in', tk:_rbToWire(simTick), l:_rbSent });
    }
    // Full resync burst (host only): ship the whole duel state on consecutive ticks so at least
    // one survives the unreliable, possibly-fragmenting channel. Triggered on a heavy desync or a
    // reconnect. Not during a rollback re-sim.
    if(!_replaying && _rbResyncSend > 0 && netMyIndex() === 0 && _rbRing.length){
        const last = _rbRing[_rbRing.length-1];
        const full = _rbFullState(last.snap, last.tk);   // stamp the ring entry's OWN tick
        if(full) _netSend(full);
        _rbResyncSend--;
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
    simApplyDuel(_rbClone(_rbRing[idx].snap));   // clone: the ring entry stays pristine
    _sfxQ = _sfxQ.filter(q => q.tk <= simTick);  // sounds predicted past the rewind: cancelled...
    _fxQ  = _fxQ.filter(q => q.tk <= simTick);   // ...same for visual effects (bonus/crush/fireworks)
    _rbRing.length = idx;                        // these states are void; re-recorded below
    _replaying = true;
    for(let t = from; t <= target; t++){
        _rbNoteHeads(t, true);                   // re-record: the corrected past can move heads
        if(t % RB_SNAP_EVERY === 0) _rbRing.push({ tk:t, snap:_rbClone(_rbDuelSnap()) });
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
// The heads log covers EVERY tick within the window (the ring itself is thinned); if tk
// aged out (or anything looks off), assume a step happened -> rewind (the safe answer).
function _rbPeerSteppedSince(pi, tk){
    if(!players || !players[pi] || !players[pi].snake.length) return true;
    const h = _rbHeads.get(tk);
    if(!h) return true;
    const a = players[pi].snake[0];
    return a.x !== h[pi*2] || a.y !== h[pi*2 + 1];
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
        if(tk <= simTick - RB_DEPTH){ _rbDbg.drop++; _rbWarnAt = performance.now(); _netSigLog('! input too old @' + tk); continue; }
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
            // Boost transitions are GAME-TICK granular: the boosting flag is only read
            // at accrual boundaries, so a flip authored after the last one (_gAt) has
            // changed nothing yet on either sim -- apply live, bit-identical.
            else if(cmd.t === 'boost' || cmd.t === 'boostend') live = tk > _gAt;
            // A live apply corrects the present but not the recorded past: with a hash
            // boundary between the authored tick and now, the boundary's ring snapshot
            // would disagree with the sender's -- a false DESYNC. Rewind instead; the
            // re-sim re-records the ring, keeping the hashed history consistent.
            if(live && ((tk >> 6) !== (simTick >> 6) || ((simTick & 63) === 0 && tk < simTick))) live = false;
            if(live){
                simCommand(cmd);
                _rbDbg.live++;
            } else if(tk < earliest) earliest = tk;   // crossed a step / accrual boundary: rewind
        } else {
            // Arrived AHEAD of its tick: just logged above, netTickPre applies it on time. This
            // is the best case (the behind-client sees the ahead-client's inputs like this) --
            // count it as live too: it lands with no rewind.
            _rbDbg.live++;
        }
    }
    if(earliest !== Infinity) _rbRollback(earliest);
}
// In-process ONLINE home: the arming stage's real transitions go through the input
// path (wire + log). Local 1:1 and classic keep the straight-to-sim default; the
// worker home installs its own wrapper over this one (sim-worker.js).
{ const _armSim = simArmIssue;
  simArmIssue = (p, kind, d) => {
      if(netGameActive() && !(typeof netWorkerDuelOn === 'function' && netWorkerDuelOn())) netLocalInput(kind, 0, d, true);
      else _armSim(p, kind, d);
  }; }
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
    // Worker-hosted duel (main thread only): the core lives in the sim worker, so the
    // input is forwarded there -- the worker's copy of this function does the applying
    // and emits the wire record back. In the worker (and in-process) this is undefined.
    if(typeof netWorkerDuelOn === 'function' && netWorkerDuelOn()){
        _wDuelSend({ t:'lin', k:kind, d: d ? { x:d.x, y:d.y } : null, n: now ? 1 : 0 });
        return true;
    }
    const myP = netMyIndex();
    let tk = simTick + 1;
    if(kind === 'dir'){
        // A turn is STEP-granular: it has zero effect before the next game-tick
        // boundary, so it is AUTHORED there (simTick + _gDue) -- the record then
        // usually arrives before its own tick and applies with no rewind at all,
        // the same quantization model boost transitions use. During READY/GO
        // aiming no game ticks run; those stamp the next engine tick as before.
        const P = players && players[myP];
        if(!P) return true;
        const S = (phase === 'duel' && _gDue > 0) ? simTick + _gDue : simTick + 1;
        // KEYFRAME FILTER: predict the queue at S (live queue + records already
        // authored for S) and drop what the sim would drop -- pressing the aim you
        // already have, a reverse, or past the 3-deep queue. A dropped press never
        // reaches the log or the wire, so both sims see identical silence.
        const pend = (_rbLog.get(S) || []).filter(c => c.t === 'dir' && c.p === myP);
        const last = pend.length ? pend[pend.length - 1].dir
                   : (P.dirQueue.length ? P.dirQueue[P.dirQueue.length - 1] : P.dir);
        if((d.x === last.x && d.y === last.y) || (d.x === -last.x && d.y === -last.y)
           || P.dirQueue.length + pend.length >= 3) return true;
        _rbAdd(S, { t:'dir', p:myP, dir:{x:d.x,y:d.y} });   // netTickPre applies it AT S, both here and peer-side
        const drec = { q:++_rbSeq, tk:_rbToWire(S), k:'dir', d:{x:d.x, y:d.y}, n:0 };
        _rbSent.push(drec);
        if(_rbSent.length > RB_REDUNDANCY) _rbSent.shift();
        _netDbg.inTx++;
        _netSend({ t:'in', tk:_rbToWire(simTick), l:_rbSent });
        return true;
    }
    const cmd = kind === 'bs'  ? { t:'boost', p:myP, dir:{x:d.x,y:d.y}, now:!!now }
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

