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
// and the 1Hz 'h' with per-field hashes (~575B). Declared HERE (not net.js):
// both the transport and the core enforce it, and the sim worker loads only the core.
const NET_PKT_MAX = 1200;
const RB_SNAP_EVERY = 2;     // snapshot every 2nd tick: a rollback lands on the nearest earlier
                             // entry and re-sims at most one extra tick -- a sub-microsecond tick
                             // against a full clone saved on every other tick.
const RB_DEPTH = 64;         // rewind window in TICKS (~1067ms at 60Hz): the oldest input we still
                             // accept and roll back to. An input older than this is REFUSED, so a
                             // tick that ran RB_DEPTH ago can no longer be rewritten -- it is immutable.
const RB_HASH_LAG = RB_DEPTH;// the 1Hz detector freezes the hash of a tick this many ticks old -- one
                             // already immutable -- so a later late-input rollback can never re-record
                             // it after we sent. Hashing the live ring tip (still mutable) instead made
                             // the peer compare its settled copy against our stale hash: a phantom desync
                             // that scaled with latency. Both clients emit on the same deterministic tick
                             // and freeze the SAME immutable tick, so the compare is apples-to-apples.
const RB_RING = 36;          // ring ENTRIES kept, THINNED by RB_SNAP_EVERY. Spans RB_DEPTH ticks of
                             // rewind history plus a few entries of headroom so the immutable hash tick
                             // (RB_HASH_LAG old) is always still in the ring to hash and compare.
                             // A divergence older than the ring gets a full resync, not a rollback.
const RB_FUTURE = 32;        // honest inputs are authored up to a GAME tick ahead (dir stamps its
                             // effective boundary, simTick + _gDue <= gPer) plus start-time skew;
                             // beyond half a second ahead is a connection problem -- refuse it
var _rbRing = [];            // [{tk, snap}] -- snap is the state BEFORE tick tk ran
var _rbLog = new Map();      // tick -> [cmd] : every input, BOTH players, by authored tick
var _rbSeq = 0;              // our outgoing input sequence
var _rbPeerSeq = -1;         // highest peer sequence applied
var _lastLocalDir = null;    // last dir we AUTHORED for our snake -- the intent-change gate (netLocalInput)
// Every packet repeats the recent inputs, so a lost one is repaired by the next without a
// retransmit (the DataChannel is deliberately unreliable). 8 covers far more than any hand
// generates inside a round trip, and keeps the worst-case packet (~500 bytes) well inside both
// the 1280-byte datagram budget and the relay's 2KB cap.
const RB_REDUNDANCY = 8;
// What we ACCEPT from a peer, kept above RB_REDUNDANCY: a peer on an older patch may still emit
// the legacy 12 (patches interop), so rejecting at 8 would starve a mixed-version duel of the
// other side's inputs. The guard exists only to refuse the clearly-abusive (a hostile peer could
// pack tens of thousands into one `l`, each an unbounded _rbLog append + re-sim cost).
const RB_RX_MAX = 12;
// Radio-warm keepalive cadence, in TICKS. The game's real send cadence in play is the
// 16-tick input heartbeat (~267ms) plus sporadic turns -- sparse enough that an iOS WiFi
// radio dozes between beats and pays ~150ms wake latency on the NEXT inbound packet
// (measured: p2p-rtt 166ms, drop 0 lost 0 -- delay, not loss). A tiny bare ping every
// ~4 ticks (~67ms) keeps each client's OWN radio out of that doze. THE tunable to A/B on
// a real PC+iOS pair: raise it if the trickle is enough, lower it (~33ms at 2) if it dozes.
const NET_WARM_EVERY = 4;
var _rbSent = [];            // recent local inputs, resent for redundancy
// Deferred-input marker: authoring past the leading-edge cap sets this; netTickPre flushes
// it once (latest-valid, since _rbSent already holds the most recent records). A burst of
// touches or key-repeats beyond the cap collapses to a single send, not one packet each.
var _netInDirty = false;
// One-shot repair resend, as a countdown: every input-carrying flush arms it to 2, each
// input-free netTickPre counts it down, and the resend fires when it reaches 0 -- two tick
// boundaries (~27-33ms) after the flush, not one. Real loss is bursty (a radio stall, a
// full queue), so a repair only ~10-17ms behind the original tends to die with it; the
// extra tick decorrelates the pair. A fresh input flush re-arms the countdown: that packet
// already carries the whole redundancy log, so it IS the superseding repair. Still repairs
// a lost datagram from a player who then goes quiet far inside the 16-tick heartbeat's
// ~267ms, and still fires at most once per armed flush.
var _netInRepeat = 0;
// Cap for the leading-edge flush: counts the input-authored flushes of the current tick
// cycle (bumped by the immediate, netTickPre and netTickPost flushes, zeroed when
// netTickPre opens the next cycle). The first TWO turns of a cycle ship the moment they
// are authored -- a fast double gesture lands two distinct turns inside one tick, and
// deferring the second turned it into a guaranteed-late flush whenever it was authored
// on the last interval before its boundary. Anything past two only marks _netInDirty and
// coalesces into the next tick's flush, so a touchmove storm still costs bounded packets
// per tick, not one per event (the spam collapse the cap exists for survives).
var _netInFlush = 0;
// A received input that lands AFTER its own tick needs a rollback re-sim (the clone-heavy
// path). Many packets draining together after a busy frame would each trigger their own --
// a rollback flood on the single main thread. Instead every _netPeerInput only RECORDS the
// earliest tick that needs rewinding here; netTickPre does ONE rollback per tick covering
// them all, so the expensive op is capped at the tick rate no matter the packet rate.
var _rbRewindTo = Infinity;
var _rbDbg = { rb:0, resim:0, drop:0, maxRew:0, desync:0, hashOk:0, lost:0, live:0, fix:0 };
// simTick is a FREE-RUNNING counter from page load -- startDuel does not reset it,
// and it ticks through the menus. So two clients enter a duel with wildly different
// values (one at 45000, the other at 3000) and their raw ticks mean nothing to each
// other. Every wire tick is therefore relative to this base, captured when the duel
// starts: both clients start at the same server-issued start_pts, so relative tick 0
// is the same instant on both. Without it every input lands outside the accept
// window and is dropped -- which looks exactly like "nothing ever gets through".
var _rbBase = 0;
// The session epoch _rbBase belongs to, captured at the same reset that captures the base.
// Tick-stream packets ('in'/'h'/'st'/'rs') are stamped and gated with THIS (see _netSend and
// the epoch gate in _netHandleMsg), because s.epoch advances at the HALT while the sims keep
// ticking the old timeline until the scheduled start -- the two disagree for that whole window.
var _rbEpoch = 0;
var _rbPhase = '';   // last seen duel phase: drives the re-anchor at level/respawn breaks
var _rbBadSince = 0;      // wall clock of the FIRST unhealed mismatch (0 = healthy): repeated
                          // failed repairs escalate to a session end on the persistence deadline
// A refused packet is normal jitter under independent clocks: the redundant resend
// re-delivers that input at a usable tick and the two worlds never actually diverge (the
// hash stays equal). It is NOT a connection fault -- the packet DID arrive -- and NOT a
// warning of any kind. Only genuine SILENCE (net.js, nothing on the wire) raises CONNECTION
// LOST, and only a disagreeing hash raises OUT OF SYNC; a refusal just counts as a drop.
function _rbRefused(){ _rbDbg.drop++; }
// A redundant-log record older than the rewind window is undeliverable (the peer
// must refuse it), so resending it repairs nothing: prune before every send.
function _rbSentPrune(){
    if(_rbSent.length && _rbFromWire(_rbSent[0].tk) <= simTick - RB_DEPTH)
        _rbSent = _rbSent.filter(r => _rbFromWire(r.tk) > simTick - RB_DEPTH);
}
function _rbToWire(tk){ return tk - _rbBase; }
function _rbFromWire(tk){ return (tk|0) + _rbBase; }
function _rbReset(){
    _rbRing = []; _rbLog = new Map(); _rbHeads = new Map(); _rbSeq = 0; _rbPeerSeq = -1; _rbSent = []; _rbHashQ = []; _rbStateQ = [];
    _lastLocalDir = null;   // a fresh match/level carries no authoring history
    _netInDirty = false;
    _netInRepeat = 0;
    _netInFlush = 0;
    _rbResyncSend = 0;
    _rbRewindTo = Infinity;
    _rbBadSince = 0;
    _netLagN = [];   // a new match is a new path: do not average across the old one
    _rbBase = simTick;
    _rbEpoch = (typeof netEpoch === 'function') ? netEpoch() : 0;
    _rbPhase = '';
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
    '_powerMode','_powerModeAt','heart','heartAt','_barMoveTick','players','duelWinner','_duelX10',
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
             powerPellet, powerPelletAt, _powerMode, _powerModeAt, heart, heartAt, _barMoveTick,
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
const RB_SETTLE = RB_HASH_LAG;  // HASH settle: judge a tick only once BOTH clients' snapshots of it
                             // are immutable. The sender already froze it at RB_HASH_LAG old; our own
                             // copy stops moving once no accepted input can still rewrite it, which is
                             // RB_DEPTH ticks after the tick ran -- the SAME margin. Comparing sooner
                             // races an in-flight late input and reads a phantom desync once a second.
const RB_STATE_SETTLE = 0;   // STATE settle: NONE. The peer's snake is AUTHORITATIVE and does not
                             // depend on our inputs settling, so apply it the moment its tick is in
                             // the past (simTick >= tk) -- no wait. Applying immediately keeps the
                             // correction in the seamless in-ring path; a future-stamped state (tk >
                             // simTick) still parks here until we reach its tick.
var _rbHashQ = [];           // [{tk, h}] peer hashes waiting for their tick to settle
function _rbCheckHash(m){
    // Keep ONLY the known field-hash keys: a hostile peer could otherwise ship an `f`
    // with tens of thousands of keys that the mismatch diff (_rbHashSettle) then iterates.
    let f = null;
    if(m.f && typeof m.f === 'object'){ f = {}; for(const k of RB_HASH_DUEL) if(k in m.f) f[k] = m.f[k]; }
    _rbHashQ.push({ tk:_rbFromWire(m.tk), h:m.h>>>0, f });
    if(_rbHashQ.length > 8) _rbHashQ.shift();
    // A hash rides RB_HASH_LAG behind its sender's live tick, so reconstruct that live tick to
    // tell "peer froze" from "hash is just old". Backup detector for a quiet straightaway where no
    // 'in' packet flows; the packet-level detector in _netPeerInput is the primary (no built-in lag).
    _rbNoteBehindPeer(_rbFromWire(m.tk) + RB_HASH_LAG);
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
        if(_rbHash(e.snap) === q.h){ _rbDbg.hashOk++; _rbBadSince = 0; continue; }   // agreement heals the escalation clock
        // Deterministic sims do not drift back into agreement: this one is permanent.
        // NOT a connection warning -- the link is fine, the worlds are not.
        _rbDbg.desync++;
        if(!_rbBadSince) _rbBadSince = Date.now();   // escalation runs from the FIRST unhealed verdict
        // NO connection warning here: the link is fine, the worlds are not. The DESYNC
        // message below reports it; the escalation deadline handles persistence.
        // The verdict arrives WITH its diagnosis (the 1Hz hash always carries the
        // per-field hashes): name the diverged fields and fire exactly ONE targeted
        // repair -- our own snake for a players divergence, the host's full state for
        // anything structural. Deterministic on both clients: the rule is a pure
        // function of the verdict. A repair that failed simply mismatches again next
        // second and earns exactly one more shot; unknown fields fire both (safe).
        let where = '?', struct = true, snakes = true;
        if(q.f){
            const mine = _rbHashFields(e.snap), bad = [];
            for(const k in mine) if(q.f[k] !== undefined && q.f[k] !== mine[k]) bad.push(k);
            for(const k in q.f) if(mine[k] === undefined) bad.push(k + '(absent)');
            if(bad.length){
                where = bad.join(',');
                snakes = bad.indexOf('players') >= 0;
                struct = bad.some(k => k !== 'players');
            }
        }
        if(snakes && _rbRing.length){ const le = _rbRing[_rbRing.length - 1]; _rbSendState(le.tk, le.snap); }
        if(struct && netMyIndex() === 0) _rbResyncSend = 1;   // ONE rs, not a burst: the next verdict is the retry
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
    // Carry the COMPLETE snake -- cells AND dir/boost/accrual/score/lives, via the same
    // _rbPackPlayer descriptor the full resync uses (R1: one player field set). A cells-only
    // patch only fixes the head for a single tick: the peer then re-steps our snake with a stale
    // direction/boost/accrual and re-diverges next tick. That is why an outage longer than the
    // redundant input window (~8 inputs) could never heal the 'players' field -- once the early
    // inputs aged out, this fallback was the only repair left and it never converged. The full
    // pack makes the peer's copy of our snake byte-identical in one shot.
    const o = Object.assign({ t:'st', tk:_rbToWire(t), i:mi, gd:sn.gemsDone|0, gem:sn.gem, rng:sn._rngState,
                pp:sn.powerPellet, ppa:sn.powerPelletAt, pm:sn._powerMode, pma:sn._powerModeAt,
                hb:sn.heart, hba:sn.heartAt }, _rbPackPlayer(me));
    const pts = netPts();
    if(pts != null) o.pts = pts;   // stamped HERE so the size check sees the final packet and the string can be reused
    // A very long snake can push the state past the one-datagram cap; skip it this second
    // rather than fragment -- the hash still flags the divergence, recovery just lands later.
    const j = JSON.stringify(o);
    if(j.length > NET_PKT_MAX){ _rbDbg.stbig = (_rbDbg.stbig|0) + 1; return; }
    _netSend(o, j);
}
// A snake cannot exceed the board (COLS*ROWS cells = 2 ints each); a peer claiming more
// is malformed/hostile -- reject rather than adopt a giant array the sim then clones and
// hashes every tick. Applies to both the per-owner 'st' and the resync's packed snakes.
function _rbCellsSane(flat){ return Array.isArray(flat) && flat.length <= 2 * COLS * ROWS; }
function _rbCheckState(m){
    if(typeof m.tk !== 'number' || typeof m.i !== 'number' || !_rbCellsSane(m.s)) return;
    _rbStateQ.push({ tk:_rbFromWire(m.tk), i:m.i|0, s:m.s, d:m.d, dq:m.dq, bd:m.bd, bg:m.bg, sa:m.sa,
                     sc:m.sc, l:m.l, al:m.al, su:m.su,
                     gd:m.gd|0, gem:m.gem, rng:m.rng,
                     pp:m.pp, ppa:m.ppa, pm:m.pm, pma:m.pma, hb:m.hb, hba:m.hba });
    if(_rbStateQ.length > 8) _rbStateQ.shift();
}
// ---- FULL RESYNC: the whole duel state, snapshotted by whoever is CURRENT on the shared clock,
// for a divergence too deep for the ring to rewind. Two callers apply it (see _rbApplyResync):
//   * ORDINARY structural desync -- HOST-authoritative, only the joiner (P1) adopts (else a peer
//     'rs' could overwrite the whole world past the per-owner 'st' ownership guard).
//   * ONE-SIDED SUSPEND catch-up -- ROLE-AGNOSTIC: whoever froze is a full ring behind and adopts
//     the sender's entire frontier (both snakes) to re-anchor its tick base. A frozen HOST needs
//     this too, so the send authority (below) is role-agnostic and gated on who is AHEAD.
// It adopts EVERYTHING including both snakes -- keeping its own would guarantee a permanent
// mismatch. This is the only thing that heals a STRUCTURAL desync (the 'st' packet carries no
// level/bars/phase). Sent in a small burst because the channel is unreliable and this can fragment.
const RB_RESYNC_BURST = 4;
var _rbResyncSend = 0;       // full-resync sends still owed (whoever is ahead of a frozen peer)
// A peer packet stamped a full RB_DEPTH behind our sim can only mean the peer FROZE (backgrounded)
// while we ran on: arm an authoritative resync burst so it can catch its tick base forward. Gated
// on _rbRing so we only offer to heal once we actually have a frontier to send.
function _rbNoteBehindPeer(peerTk){
    if(peerTk <= simTick - RB_DEPTH && _rbRing.length) _rbResyncSend = RB_RESYNC_BURST;
}
function _rbPackPlayer(p){
    const s = []; for(const c of p.snake) s.push(c.x, c.y);
    return { s, d:p.dir, dq:p.dirQueue, bd:p.boostDir, bg:!!p.boosting,
             sa:p.stepAccum, sc:p.score|0, l:p.lives|0, al:p.alive!==false, su:p.slowUntil|0 };
}
// The inverse of _rbPackPlayer: overwrite `into` with the packed snake. Shared by the full
// resync (host's p0/p1) and the per-owner 'st' apply, so both adopt the exact same field set.
function _rbUnpackPlayer(pk, into){
    const s = []; for(let k = 0; k + 1 < pk.s.length; k += 2) s.push({ x:pk.s[k]|0, y:pk.s[k+1]|0 });
    into.snake = s; into.dir = pk.d; into.dirQueue = pk.dq || []; into.boostDir = pk.bd;
    into.boosting = !!pk.bg; into.stepAccum = pk.sa;
    into.score = pk.sc|0; into.lives = pk.l|0; into.alive = pk.al !== false; into.slowUntil = pk.su|0;
}
// tk MUST be the ring entry's own tick (not the live simTick, which is one behind in netTickPre),
// or the peer applies it to the wrong ring slot. Carries EVERY field the hash covers (RB_HASH_DUEL)
// so an adopting peer becomes byte-identical -- a missing field would keep the hashes apart forever.
function _rbFullState(sn, tk){
    if(!sn || !sn.players || !sn.players[0] || !sn.players[1]) return null;
    return { t:'rs', tk:_rbToWire(tk),
        ph:sn.phase, lv:sn.level|0, gd:sn.gemsDone|0, gem:sn.gem, ga:sn.gemAt, dm:sn.deathMsg, bv:sn._barsV|0,
        // gd/gdUntil ride along: they are hashed AND drive bar flight during power mode,
        // so an rs that dropped them re-diverged the bars (and split rng under power mode).
        bars:sn.bars.map(b => [b.x, b.y, (b.fragile?1:0)|(b.paired?2:0), b.pairEnd?b.pairEnd.x:-1, b.pairEnd?b.pairEnd.y:-1, b.gd==null?-1:b.gd|0, b.gdUntil|0]),
        gat:sn._gAt|0,   // hashed: without it the "full" state was not byte-identical
        gp:sn.gPer, gdue:sn._gDue, pha:sn.phaseAt, spa:sn.spawnAt, ldw:!!sn.levelDoneWaiting,
        rng:sn._rngState, sr:!!sn._speedRound, dw:sn.duelWinner, x10:!!sn._duelX10,
        pp:sn.powerPellet, ppa:sn.powerPelletAt, pm:!!sn._powerMode, pma:sn._powerModeAt, bmt:sn._barMoveTick|0,
        hb:sn.heart, hba:sn.heartAt,
        p0:_rbPackPlayer(sn.players[0]), p1:_rbPackPlayer(sn.players[1]) };
}
function _rbApplyResync(m){
    if(!players || !m || !m.p0 || !m.p1) return;
    if(!_rbCellsSane(m.p0.s) || !_rbCellsSane(m.p1.s)) return;   // reject a resync with an over-board snake
    if(Array.isArray(m.bars) && m.bars.length > COLS * ROWS) return;
    const T = _rbFromWire(m.tk);
    // TWO kinds of resync land here, told apart by WHERE the sender's frontier T sits relative to
    // our sim -- and the guard MUST run before simSnapshot(), which hands back LIVE references (an
    // unpack into snap.players mutates the real snake): a non-adopting role must bail untouched.
    //   * CATCH-UP (T a full ring AHEAD of us): a one-sided suspend -- WE froze while the sender ran
    //     on, so the tick BASE diverged and no in-ring rollback reaches T. Role-agnostic: a frozen
    //     HOST must catch up too. Handled below by adopting the sender's ENTIRE frontier.
    //   * ORDINARY (T at/behind our tick, or just ahead): a small structural divergence. Stays
    //     HOST-authoritative -- only the joiner (P1) adopts, or a peer 'rs' could overwrite the whole
    //     world (both snakes/level/rng/winner), bypassing the per-owner 'st' ownership guard.
    const catchUp = T > simTick + RB_DEPTH;
    if(!catchUp && netMyIndex() !== 1) return;
    // The FULL authoritative snapshot AT tick T: the whole SHARED world (level/gems/rng/bars/
    // power/heart/timers) plus the HOST's own snake (p0). How we treat OUR snake (p1) depends on
    // the branch below.
    const snap = simSnapshot();
    snap.phase = m.ph; snap.level = m.lv|0; snap.gemsDone = m.gd|0; snap.gem = m.gem; snap.gemAt = m.ga; snap.deathMsg = m.dm; snap._barsV = (snap._barsV|0) + 1;
    snap.bars = (m.bars || []).map(a => { const b = { x:a[0]|0, y:a[1]|0, fragile:!!(a[2]&1), paired:!!(a[2]&2) }; if(a[3] >= 0) b.pairEnd = { x:a[3]|0, y:a[4]|0 }; if(a.length > 5 && a[5] >= 0){ b.gd = a[5]|0; b.gdUntil = a[6]|0; } return b; });
    snap._gAt = m.gat|0;
    snap.gPer = m.gp; snap._gDue = m.gdue; snap.phaseAt = m.pha; snap.spawnAt = m.spa; snap.levelDoneWaiting = !!m.ldw;
    snap._rngState = m.rng; snap._speedRound = !!m.sr; snap.duelWinner = m.dw; snap._duelX10 = !!m.x10;
    snap.powerPellet = m.pp; snap.powerPelletAt = m.ppa; snap._powerMode = !!m.pm; snap._powerModeAt = m.pma; snap._barMoveTick = m.bmt|0;
    snap.heart = m.hb; snap.heartAt = m.hba;
    _rbUnpackPlayer(m.p0, snap.players[0]);   // the HOST's snake is the host's to author (both branches adopt it)
    if(catchUp){
        // ONE-SIDED SUSPEND CATCH-UP (role-agnostic). The sender's frontier is a FULL RING ahead of
        // our sim -- only possible if WE froze (backgrounded tab / iOS radio doze) while it ran on, so
        // the tick BASE diverged and no in-ring rollback reaches T. A frozen HOST needs this too, hence
        // role-agnostic. We produced NO inputs while frozen, so the sender (current on the shared clock)
        // holds the authoritative continuation of BOTH snakes -- including its dead-reckoning of OURS
        // (with no inputs, our snake simply ran straight, which is exactly what the sender simulated).
        // Adopt the sender's ENTIRE frontier and re-anchor forward. Keeping our stale frozen snake
        // instead baked an N-cell own-snake divergence into the ring that the 64-lag hash detector
        // tripped on; a death landing before it aged out then cascaded to a DESYNC match-end. The one
        // forward catch-up snap of our own head is correct here (duel-suspend.js allows the frozen side
        // exactly one). Bug C -- an own-head yank BACK to a death cell -- is guarded on the ORDINARY
        // aged-out path below, where T is NOT a full ring ahead so the sender's copy can predate our
        // live respawn; here the sender is current, so its copy IS the truth. The shared spawnAt still
        // respawns both sides in lockstep, and being byte-identical to the sender needs no 'st' back.
        _rbUnpackPlayer(m.p1, snap.players[1]);   // adopt the sender's copy of the OTHER snake too
        // Ring convention: entry tk=T holds the state at simTick T-1 (snapshot taken in netTickPre
        // BEFORE tick T runs). Anchoring at T put our _gDue countdown one decrement ahead -> a 1-tick
        // game-phase divergence. The residual to the live frontier is closed by the integer-lag catch-up.
        snap.simTick = T - 1; snap.simNow = (T - 1) * TICK_MS;
        simApply(snap); _rbRing = []; _rbLog = new Map(); _rbHeads = new Map();
        _rbStateQ = []; _rbHashQ = [];
        _rbResyncSend = 0;
        _rbDbg.fix = (_rbDbg.fix|0) + 1;
        _netSigLog('~ RESYNC-CATCHUP @' + T);
        return;
    }
    snap.simTick = T - 1; snap.simNow = (T - 1) * TICK_MS;   // ring convention: entry tk=T holds the state at simTick T-1
    let e = null;
    for(let j = _rbRing.length - 1; j >= 0; j--) if(_rbRing[j].tk === T){ e = _rbRing[j]; break; }
    if(e){
        // IN-RING: keep OUR own snake as WE recorded it at T (the ring entry), not the host's copy
        // -- we own our snake. Only the shared world + the host's snake are the host's to correct.
        // Rolling forward then REPLAYS our logged inputs from T, re-deriving our own snake exactly.
        // Both sims land byte-identical at the frontier and STAY converged (a rollback renders
        // final-only, so no visible jump). Adopting the host's stale copy here is what re-yanked
        // our head after a preceding hard-apply had wiped the log the replay needs.
        if(e.snap && e.snap.players && e.snap.players[1]) snap.players[1] = e.snap.players[1];
        e.snap = _rbClone(snap); _rbRollback(T);
    } else {
        // AGED OUT (a long doze / far clock drift): T is gone from the ring, so there is NO log to
        // replay and a hard apply of the host's STALE copy of our snake would yank our own head to
        // an old/dead cell -- the "after a death the level did not start clean" glitch (bug C). We
        // OWN our snake (the per-owner 'st' ownership rule above), so keep our own geometry and take
        // only the authoritative shared world + our match state (lives/alive/score; the shared
        // respawn timers were already copied into snap). Our snake then simply resumes forward from
        // where it froze -- no teleport -- and the shared spawnAt respawns BOTH sides to the spawn
        // cell in lockstep. One 'st' pushes our snake to the host so it converges to us (the hash
        // would otherwise flag 'players' next second and the host would re-resync): no resync-forever.
        const mine = snap.players[1];
        mine.lives = m.p1.l|0; mine.alive = m.p1.al !== false; mine.score = m.p1.sc|0;
        // Re-anchor our tick to the host's frontier when T is AHEAD (the doze case: we froze, the
        // shared clock ran on, so netTickTarget is already out there). Catching up stops our inputs
        // from landing in the host's deep past -- which is what made it re-resync every second. Same
        // ring convention as the catch-up (line 423) and in-ring (line 431) branches: entry tk=T
        // holds the state at simTick T-1, so we anchor at T-1, NOT T. Anchoring at T (the old bug
        // here) labelled a T-1 state as tick T -> our _gDue countdown and our kept own-snake both sat
        // one tick ahead of the adopted world -> a permanent 1-tick game-phase + 1-cell own-snake
        // divergence (seen when a RESYNC-burst 'rs' lands here right after the catch-up wiped the
        // ring). Never rewind (T <= simTick: keep our tick so the shared world is not dragged back).
        const anchor = T > simTick ? T - 1 : simTick;
        snap.simTick = anchor; snap.simNow = anchor * TICK_MS; simApply(snap); _rbRing = []; _rbLog = new Map(); _rbHeads = new Map();
        _rbSendState(anchor, simSnapshot());
    }
    _rbStateQ = []; _rbHashQ = [];
    _rbResyncSend = 0;
    _rbDbg.fix = (_rbDbg.fix|0) + 1;   // a repair landing is HEALING, not a connection event
    _netSigLog('~ RESYNC @' + T);
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
        let e = null;
        for(let j = _rbRing.length - 1; j >= 0; j--) if(_rbRing[j].tk === q.tk){ e = _rbRing[j]; break; }
        if(e && e.snap && e.snap.players && e.snap.players[q.i]){
            // Recent enough to be in the ring: patch the historical snapshot and roll forward, so
            // the correction lands seamlessly (no visible jump). Adopt the WHOLE snake (dir/boost/
            // accrual too, via _rbUnpackPlayer) -- a cells-only patch re-diverges on the next step.
            const before = JSON.stringify(_rbPackPlayer(e.snap.players[q.i]));
            _rbUnpackPlayer(q, e.snap.players[q.i]);
            let changed = JSON.stringify(_rbPackPlayer(e.snap.players[q.i])) !== before;
            // gems/items follow the PRNG: the more advanced world wins -- but only by a
            // PLAUSIBLE margin. An unbounded gd (e.g. 0x7fffffff) would let a peer forge the
            // lead and dictate the shared gem/RNG state; one st cycle is at most a level or two.
            if(q.gd > (e.snap.gemsDone|0) && q.gd <= (e.snap.gemsDone|0) + 30){
                e.snap.gemsDone = q.gd; e.snap.gem = q.gem; e.snap._rngState = q.rng;
                e.snap.powerPellet = q.pp; e.snap.powerPelletAt = q.ppa;
                e.snap._powerMode = q.pm; e.snap._powerModeAt = q.pma;
                e.snap.heart = q.hb; e.snap.heartAt = q.hba;
                changed = true;
            }
            if(changed){ _rbDbg.fix = (_rbDbg.fix|0) + 1; _netSigLog('~ FIX @' + q.tk + ' i' + q.i); _rbRollback(q.tk); }
        } else {
            // Aged out of the ring: too old to rewind to. Do NOT incrementally snap the snake
            // (that jumps every second and never heals the structural state); a divergence this
            // deep needs a FULL resync of the whole game state -- the host owns that (below).
            if(netMyIndex() === 0) _rbResyncSend = 1;   // I'm host: ship ONE full state (the next verdict retries)
        }
    }
}
// The ring must own its states: _rbDuelSnap() hands out LIVE references (the sim
// mutates players[i].snake in place), so an un-cloned entry would rot as the game runs.
// A duel snapshot is pure JSON data -- numbers, strings, bools, null, {x,y} cells, arrays
// and the two snake bodies, no Set/Map/Date -- so this tight recursive copy is exact
// (byte-identical to structuredClone) and ~8x cheaper on this shape (measured). That
// matters: a clone runs every 2nd tick AND again through every rollback re-sim, so it is
// the dominant duel-only main-thread cost -- and on the single-thread path it competes
// with touch and render, where structuredClone's overhead was starving touchmove delivery.
function _rbClone(o){
    if(o === null || typeof o !== 'object') return o;
    if(Array.isArray(o)){ const n = new Array(o.length); for(let i = 0; i < o.length; i++) n[i] = _rbClone(o[i]); return n; }
    const n = {};
    for(const k in o) if(Object.prototype.hasOwnProperty.call(o, k)) n[k] = _rbClone(o[k]);
    return n;
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
    // One rollback per tick, covering every late input that arrived since the last tick
    // (recorded by _netPeerInput). Done first, while simTick is still the last-completed tick,
    // so the re-sim corrects history before this tick's snapshot, inputs and hash settle.
    if(_rbRewindTo !== Infinity){ _rbRollback(_rbRewindTo); _rbRewindTo = Infinity; }
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
    // Coalescing input flush: the first turns of a cycle already shipped at authoring (the
    // leading-edge flush in netLocalInput, capped at two); everything authored past the
    // cap only marked _netInDirty and collapses here into a single latest-valid packet --
    // a burst of touches or key-repeats costs one send, not one per event. It carries the
    // whole recent log (_rbSent) for redundancy, so a heartbeat this same tick would only
    // repeat it: skip it.
    let _inFlushed = false;
    _netInFlush = 0;   // a new tick cycle: authored turns may ship at once again
    if(_netInDirty && !_replaying){
        _rbSentPrune();
        _netSend({ t:'in', tk:_rbToWire(simTick), l:_rbSent });
        _netDbg.inTx++;
        _netInDirty = false;
        _inFlushed = true;
        _netInFlush++;
        _netInRepeat = 2;   // arm the repair countdown (see its declaration)
    } else if(_netInRepeat && !_replaying){
        // Repair countdown (see the _netInRepeat declaration). Decrement FIRST so it
        // fires exactly once no matter what the send below does on a closed channel.
        if(--_netInRepeat === 0){
            _rbSentPrune();
            if(_rbSent.length){
                _netSend({ t:'in', tk:_rbToWire(simTick), l:_rbSent });
                _inFlushed = true;
            }
        }
    }
    if((t & 63) === 0){
        for(const k of _rbLog.keys()) if(k < t - RB_DEPTH - 8) _rbLog.delete(k);
        for(const k of _rbHeads.keys()) if(k < t - RB_DEPTH - 8) _rbHeads.delete(k);
        // The 1Hz detector, keyed to the deterministic tick so both clients emit on the
        // same tick. It ALWAYS carries the per-field hashes (~575B): a mismatch verdict
        // lands with its diagnosis in hand and the targeted repair fires right there in
        // _rbHashSettle -- no request round trip, no repair cadence of its own. Fires on its
        // own cadence even when an input flush already went out this tick (they carry different data).
        if(!_replaying && _rbRing.length){
            // Freeze the hash of the tick RB_HASH_LAG in the past -- immutable, so no later
            // rollback can re-record it after we send. Both clients run this on the same
            // deterministic tick and target the same tk. Skip if it has aged out of the ring
            // (only near a level start, before the ring is deep enough): nothing to compare yet.
            const hk = t - RB_HASH_LAG;
            let he = null;
            for(let j = _rbRing.length - 1; j >= 0; j--) if(_rbRing[j].tk === hk){ he = _rbRing[j]; break; }
            if(he){
                const hb = _rbHashBoth(he.snap);
                _netSend({ t:'h', tk:_rbToWire(hk), h:hb.h, f:hb.f });
            }
        }
    } else if(!_inFlushed && (t & 15) === 0 && !_replaying){
        // 16-tick heartbeat (~267ms), on the OFF-64 ticks so it never doubles up with the
        // full state. Carries the recent input log = free input-redundancy repair, and keeps
        // SOMETHING on the wire every 16 ticks for liveness.
        _rbSentPrune();
        _netSend({ t:'in', tk:_rbToWire(simTick), l:_rbSent });
    } else if(!_inFlushed && (t % NET_WARM_EVERY) === 0 && !_replaying){
        // Radio-warm keepalive (see NET_WARM_EVERY): a bare ~15B ping on the ticks that would
        // otherwise be silent, so the wire never idles long enough for an iOS radio to doze.
        // p2p ONLY -- _netSend drops a warm ping on the relay path (HTTP-polled; a ~20Hz ping
        // there would hammer the server). The 267ms/1Hz sends already keep those ticks awake.
        _netSend({ t:'pi', w:1 });
    }
    // Full resync burst (role-agnostic): ship the whole duel state on consecutive ticks so at least
    // one survives the unreliable, possibly-fragmenting channel. Armed on a heavy desync, a reconnect,
    // or when a peer packet shows the peer froze a full ring behind us (_rbNoteBehindPeer). NOT
    // host-only: a frozen JOINER's resync must reach a frozen-then-caught HOST too. Authority is by
    // WHO IS AHEAD (only a client current on the shared clock ever arms this), not by role. The
    // ORDINARY-desync apply stays joiner-only inside _rbApplyResync, so a stale peer 'rs' still cannot
    // overwrite the live world -- only the catch-up branch (peer a full ring behind) is role-agnostic.
    // Not during a rollback re-sim.
    if(!_replaying && _rbResyncSend > 0 && _rbRing.length){
        const last = _rbRing[_rbRing.length-1];
        const full = _rbFullState(last.snap, last.tk);   // stamp the ring entry's OWN tick
        if(full) _netSend(full);
        _rbResyncSend--;
    }
}
// Send side of the tick, called immediately AFTER update(). boost/boostend arm at the END of
// update (simArmTick), so without this they miss THIS tick's netTickPre flush and wait a whole
// frame for the next one -- the ~16ms that ate the +1 authoring headroom and pushed every boost
// one tick late onto the wire. A turn is authored on the input event and already rides the
// pre-flush; this closes the boost gap so ALL events leave the wire the same tick they happen.
// Idempotent with the pre-flush: _netInDirty clears on the first send, so an input never doubles.
function netTickPost(){
    if(!netGameActive() || !inGame || _replaying) return;
    if(_netInDirty){
        _rbSentPrune();
        _netSend({ t:'in', tk:_rbToWire(simTick), l:_rbSent });
        _netDbg.inTx++;
        _netInDirty = false;
        _netInFlush++;
        _netInRepeat = 2;   // arm the repair countdown (see its declaration)
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
    // An honest peer sends at most RB_RX_MAX records; a hostile one could pack tens of
    // thousands into one `l` (each an unbounded _rbLog append + a re-sim cost). Cap it.
    if(m.l.length > RB_RX_MAX){ _rbDbg.drop++; return; }
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
        // Every packet stamps the sender's OWN current tick (no lag), so this is the primary
        // "peer froze while we ran on" detector: if it is a full ring behind us, arm a resync
        // burst to catch its tick base forward. Cheap; _rbNoteBehindPeer no-ops unless truly deep.
        _rbNoteBehindPeer(_rbFromWire(m.tk));
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
        if(!cmd){ _rbRefused(); continue; }
        // Beyond the rewind window there is no honest way to honour it: applying it
        // at the wrong tick would desync the two worlds silently. Refuse, visibly.
        if(tk <= simTick - RB_DEPTH){ _rbRefused(); _netSigLog('! input too old @' + tk); continue; }
        // Authored far ahead of us: an honest peer stamps its OWN current tick.
        if(tk > simTick + RB_FUTURE){ _rbRefused(); _netSigLog('! input from the future @' + tk); continue; }
        _rbPeerSeq = q;
        _rbAdd(tk, cmd);
        _netDbg.inRx++;
        _netDbg.inLog.unshift(String(r.k) + '@' + tk);
        if(_netDbg.inLog.length > 4) _netDbg.inLog.length = 4;
        // Deterministic lockstep: an input is applied by the tick loop at its authored tick. THE
        // BUFFER: the peer authors one tick ahead of its own sim and sends at once, so a remote
        // input normally arrives while its tick is still in OUR future -- it sits in the log and
        // netTickPre applies it on time, no rollback. That one tick of wire slack keeps the common
        // case rollback-free (tk > simTick, below).
        //
        // ONE-TICK-LATE SHORTCUT (tk === simTick): the input for the tick that JUST ran. Apply it
        // live here and skip the rollback, but ONLY if that tick did not already consume it:
        //   dir   -- the target must not have stepped at simTick (a step consumed the old heading);
        //            _rbPeerSteppedSince is exactly that test.
        //   boost -- no accrual boundary at simTick (tk > _gAt); a boundary already spent the old
        //            boost flag into stepAccum, so a flip authored for it must be rolled in instead.
        // This is lockstep-safe where a general past-input live-apply is NOT: simTick is the newest
        // past tick, so (a) no rollback can ever start later than it -- every future rollback's
        // replay re-applies the log entry we just added at tk, it can never be skipped -- and (b)
        // there are no already-recorded intermediate snapshots between tk and now to leave stale.
        // The old unbounded live-apply violated both and was the duel-desync boost/dir bug.
        //
        // Anything older than one tick, or a tick that already stepped/accrued: no honest shortcut
        // -- record the earliest such past tick and let netTickPre do ONE rollback+replay covering
        // every late input from this drain (batching caps it at one re-sim per tick).
        if(tk === simTick && (cmd.t === 'dir' ? !_rbPeerSteppedSince(oP, tk) : tk > _gAt)){
            simCommand(cmd); _rbDbg.live++;   // SHORTCUT here: spend the peer's headroom -- inject live right before sim, no rollback
        } else if(tk <= simTick){ if(tk < earliest) earliest = tk; }
        else _rbDbg.live++;
    }
    // Do NOT rollback here: record the earliest rewind and let netTickPre do a SINGLE re-sim
    // covering every packet that arrived this tick. Replaying the full log from the earliest
    // tick reaches the identical state as N separate rollbacks would, at a fraction of the cost.
    if(earliest < _rbRewindTo) _rbRewindTo = earliest;
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
    // HEADROOM (mandatory, non-negotiable -- half of a pair with the shortcut in _netPeerInput).
    // Every local input is authored at least ONE tick in the FUTURE, never at simTick or earlier,
    // and sent at once. That lead IS the network transmit headroom: the window for the peer to
    // receive it and apply it on its own timeline BEFORE its sim reaches the authored tick, so the
    // common case costs no rollback. Author at the current tick and the wire gets zero time -> a
    // rollback on every single input. The two authoring sites below each spend exactly this rule;
    // the peer SPENDS the headroom via the one-tick-late shortcut in _netPeerInput.
    let tk = simTick + 1;   // HEADROOM here: boost/boostend authored +1 -- tightest lead that still leaves one full tick of wire slack
    if(kind === 'dir'){
        // HEADROOM here (mandatory): a turn is step-granular -- no effect before the next game-tick
        // boundary -- so it is authored at that boundary (simTick + _gDue, always >= simTick+1) and
        // applied from the shared log, local and peer alike. That >= one-tick lead is the wire slack.
        const P = players && players[myP];
        if(!P) return true;
        const S = (phase === 'duel' && _gDue > 0) ? simTick + _gDue : simTick + 1;   // <- authored one step boundary ahead
        // Intent-change gate (source-agnostic: keyboard, dpad and free-touch swipe all funnel here).
        // A turn onto the heading the snake already holds is dropped by the sim on BOTH clients, so
        // authoring a wire record for it is pure waste -- one peer rollback/live-apply for a snake
        // that never turned. A held dpad key and keyboard auto-repeat already suppress this at the
        // source; a continuous same-direction swipe does not, so it re-emits one no-op turn per
        // ~48px of slide. Suppress ONLY when it is PROVABLY a no-op: the new dir equals BOTH our last
        // AUTHORED dir (so no distinct turn is queued behind it in the not-yet-applied window -- this
        // is what the caution below forbids predicting, so we read a committed fact, not a forecast)
        // AND our snake's CURRENT heading (so a respawn/level heading reset -- which changes P.dir
        // without an authored record -- is never mis-suppressed; that turn goes through). Both true
        // means same-as-heading now and through S: the sim would discard it either way.
        if(_lastLocalDir && _lastLocalDir.x === d.x && _lastLocalDir.y === d.y &&
           P.dir && P.dir.x === d.x && P.dir.y === d.y) return true;
        // The sim's dir handler is the SOLE authority on which turns count (same-as-heading,
        // reverse, queue full), applied identically on both clients and every rollback re-sim.
        // Do NOT re-judge that here against a predicted queue: a correction can change dir/dirQueue
        // before S, so a press this predicts is redundant may be one the corrected sim accepts --
        // and dropping it here loses it on both sides. Only coalesce an exact duplicate already
        // authored for S (a record the sim already has); this is also the same-key spam guard.
        const log = _rbLog.get(S);
        if(log) for(let i = 0; i < log.length; i++){ const c = log[i]; if(c.t === 'dir' && c.p === myP && c.dir.x === d.x && c.dir.y === d.y) return true; }
        _lastLocalDir = { x:d.x, y:d.y };   // remember the intent we just authored (the gate's baseline)
        _rbAdd(S, { t:'dir', p:myP, dir:{x:d.x, y:d.y} });
        const drec = { q:++_rbSeq, tk:_rbToWire(S), k:'dir', d:{x:d.x, y:d.y} };
        _rbSentPrune(); _rbSent.push(drec);
        if(_rbSent.length > RB_REDUNDANCY) _rbSent.shift();
        _netInDirty = true;   // fallback: the next tick's flush carries it if the cap below hits
        // Leading-edge flush ("sent at once", as the HEADROOM contract above promises): the
        // wire record is complete right here, and the next netTickPre averages half a tick
        // away -- pure added latency on a real link, where every ms of the authoring lead
        // matters. Ship the first TWO turns of a cycle immediately (a fast double gesture
        // must not defer its second record); _netInFlush caps it there, so anything past
        // two still coalesces into the next tick's flush.
        if(_netInFlush < 2 && !_replaying){
            _rbSentPrune();
            _netSend({ t:'in', tk:_rbToWire(simTick), l:_rbSent });
            _netDbg.inTx++;
            _netInDirty = false;
            _netInFlush++;
            _netInRepeat = 2;   // arm the repair countdown (see its declaration)
        }
        return true;
    }
    const cmd = kind === 'bs' ? { t:'boost', p:myP, dir:{x:d.x,y:d.y}, now:!!now }
                              : { t:'boostend', p:myP };
    // Authored for tk and applied FROM THE LOG (netTickPre + every re-sim), exactly like a
    // turn -- never live. simArmTick runs at the END of update(), so a live apply here lands
    // the flip in the owner's ring snapshot one tick BEFORE the peer's log-driven apply lands
    // it in theirs: a standing one-tick boosting-flag split that the settled-history hash
    // reads as a real desync (-> resync snap -> the visible self/gem jumps). Logging it the
    // same way both sides replay it removes the split, and there is no _live record left for a
    // deferred rollback to drop.
    _rbAdd(tk, cmd);
    const rec = kind === 'bs' ? { q:++_rbSeq, tk:_rbToWire(tk), k:'bs', d:{x:d.x, y:d.y}, n: now?1:0 }
                              : { q:++_rbSeq, tk:_rbToWire(tk), k:'be' };   // be carries no dir/now: the receiver reads neither
    _rbSentPrune(); _rbSent.push(rec);
    if(_rbSent.length > RB_REDUNDANCY) _rbSent.shift();
    _netInDirty = true;   // flushed with the next tick's input packet (the redundancy log carries it)
    return true;
}

