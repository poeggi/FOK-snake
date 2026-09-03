// ============================================================================
// duel-core.js -- the DETERMINISTIC ROLLBACK CORE of the online 1:1 duel: the
// snapshot ring, the input log, live-apply vs rewind, hashes, state recovery and
// the full resync. Split out of the net layer so the same code runs in TWO homes:
//   - the SIM WORKER (the default wherever Worker exists): sim-worker.js
//     importScripts this file and drives it off its own clock; net-session.js
//     forwards wire packets in ({t:'peerPkt'}) and local inputs ({t:'lin'}), and
//     the core's sends/debug ride postMessage back out;
//   - the MAIN thread (no-Worker browsers + the headless test harness), driven
//     by game.js loop() via netTickPre(), talking to the net files directly.
// The net files (net-api/net-rtc/net-session.js) keep everything transport:
// sessions, signaling, WebRTC, the clock sync, netDuelWarn/netMyIndex/
// netTickTarget (they read session state).
// ============================================================================
// ================================================================
// DETERMINISTIC ROLLBACK NETCODE  -- nobody owns the state
// ================================================================
// Both clients run the SAME deterministic sim from the same seed and the same
// agreed start moment (the server issues the match/rematch one, the HOST authors
// every later boundary's -- see net-session.js), so nobody has to be told what
// the world looks like.
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
// what is left. Worst case today: an 'in' with a full 8-record redundant log and the
// 1Hz 'h' with its per-field hash array (~220B); smoke-net measures both against this
// budget. Declared HERE (not the net files):
// both the transport and the core enforce it, and the sim worker loads only the core.
const NET_PKT_MAX = 1200;
const RB_SNAP_EVERY = LEVEL_CFG[9].normal;   // = 3, ONE game step at the fastest duel pace
                             // (level-10 normal gPer -- the speed-round rate, js/sim.js): between
                             // snapshots the snakes move at most one cell. A rollback lands on the
                             // nearest earlier entry and re-sims at most two extra ticks -- sub-
                             // microsecond ticks against a full clone every 3rd tick, not every 2nd.
                             // _rbEnsureSnap also PINS an entry on every 64-tick hash tick: 64 is
                             // not a multiple of the step, and the 1Hz freeze looks its tick up
                             // EXACTLY (_rbRingFind), on this side and on the peer's.
const RB_DEPTH = 64;         // rewind window in TICKS (~1067ms at 60Hz): the oldest input we still
                             // accept and roll back to. An input older than this is REFUSED, so a
                             // tick that ran RB_DEPTH ago can no longer be rewritten -- it is immutable.
const RB_HASH_LAG = RB_DEPTH;// the 1Hz detector freezes the hash of a tick this many ticks old -- one
                             // already immutable -- so a later late-input rollback can never re-record
                             // it after we sent. Hashing the live ring tip (still mutable) instead made
                             // the peer compare its settled copy against our stale hash: a phantom desync
                             // that scaled with latency. Both clients emit on the same deterministic tick
                             // and freeze the SAME immutable tick, so the compare is apples-to-apples.
const RB_RING = 26;          // ring ENTRIES kept, THINNED by RB_SNAP_EVERY (+ the pinned hash ticks).
                             // Worst-case span 69 ticks -- RB_DEPTH of rewind history plus headroom so
                             // the immutable hash tick (RB_HASH_LAG old) is always still in the ring to
                             // hash and compare. The deepest exact lookup is the 1Hz freeze at
                             // RB_HASH_LAG+1 back: at most 23 newer pushes land in that window, so the
                             // pinned entry survives with 3 entries to spare. A divergence older than
                             // the ring gets a full resync, not a rollback.
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
// What we ACCEPT from a peer: exactly what an honest one can emit. Every gate-passing peer
// sends at most RB_REDUNDANCY records (the version gate refuses cross-minor duels). The cap
// exists to refuse the clearly-abusive: a hostile peer could pack tens of thousands into one
// `l`, each an unbounded _rbLog append + a re-sim cost.
const RB_RX_MAX = RB_REDUNDANCY;
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
// One-shot repair resend, as a countdown: an input-carrying flush arms it to 2, each
// input-free netTickPre counts it down, and the resend fires at 0 -- two tick boundaries
// (~27-33ms) behind the flush. Real loss is bursty (a radio stall, a full queue), so the
// gap decorrelates the repair from the burst that ate the original. A fresh input flush
// re-arms it (that packet carries the whole redundancy log, so it IS the repair); fires
// at most once per armed flush, well inside the 16-tick heartbeat's ~267ms.
var _netInRepeat = 0;
// Cap for the leading-edge flush: counts the input-authored flushes of the current tick
// cycle (bumped by the immediate, netTickPre and netTickPost flushes, zeroed when
// netTickPre opens the next cycle). The first TWO turns of a cycle ship the moment they
// are authored -- a fast double gesture lands two distinct turns inside one tick, and a
// second record deferred to the boundary leaves with zero wire budget. Anything past two
// only marks _netInDirty and coalesces into the next tick's flush, so a touchmove storm
// costs bounded packets per tick, not one per event.
var _netInFlush = 0;
// A received input that lands AFTER its own tick needs a rollback re-sim (the clone-heavy
// path). Many packets draining together after a busy frame would each trigger their own --
// a rollback flood on the single main thread. Instead every _netPeerInput only RECORDS the
// earliest tick that needs rewinding here; netTickPre does ONE rollback per tick covering
// them all, so the expensive op is capped at the tick rate no matter the packet rate.
var _rbRewindTo = Infinity;
function _rbDbgFresh(){ return { rb:0, resim:0, drop:0, maxRew:0, desync:0, hashOk:0, hashLost:0, lost:0, live:0, fix:0, desyncAt:'' }; }
var _rbDbg = _rbDbgFresh();
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
var _rbBadSince = 0;      // wall clock of the FIRST unhealed mismatch (0 = healthy): repeated
                          // failed repairs escalate to a session end on the persistence deadline
// A refused packet is normal jitter under independent clocks: the redundant resend
// re-delivers that input at a usable tick and the two worlds never actually diverge (the
// hash stays equal). It is NOT a connection fault -- the packet DID arrive -- and NOT a
// warning of any kind. Only genuine SILENCE (net-rtc.js, nothing on the wire) raises CONNECTION
// LOST, and only a disagreeing hash raises OUT OF SYNC; a refusal just counts as a drop.
function _rbRefused(){ _rbDbg.drop++; }
// A redundant-log record older than the rewind window is undeliverable (the peer
// must refuse it), so resending it repairs nothing: prune before every send.
function _rbSentPrune(){
    if(_rbSent.length && _rbFromWire(_rbSent[0].tk) <= simTick - RB_DEPTH)
        _rbSent = _rbSent.filter(r => _rbFromWire(r.tk) > simTick - RB_DEPTH);
}
// Append a freshly-authored record: pruned first, capped at the redundancy window.
function _rbSentAdd(rec){
    _rbSentPrune(); _rbSent.push(rec);
    if(_rbSent.length > RB_REDUNDANCY) _rbSent.shift();
}
function _rbToWire(tk){ return tk - _rbBase; }
function _rbFromWire(tk){ return (tk|0) + _rbBase; }
function _rbReset(){
    _rbRing = []; _rbLog = new Map(); _rbHeads = new Map(); _rbSeq = 0; _rbPeerSeq = -1; _rbSent = []; _rbHashQ = []; _rbMyHash = []; _rbStateQ = []; _rbResyncQ = null;
    _lastLocalDir = null;   // a fresh match/level carries no authoring history
    _netInDirty = false;
    _netInRepeat = 0;
    _netInFlush = 0;
    _rbResyncSend = 0;
    _rbResyncFull = false;
    _rbRewindTo = Infinity;
    _rbBadSince = 0;
    _netLagN = [];   // a new match is a new path: do not average across the old one
    _rbBase = simTick;
    _rbEpoch = (typeof netEpoch === 'function') ? netEpoch() : 0;
    _rbDbg = _rbDbgFresh();
}
// RESUME boundary (go why:'resume'): the epoch line moves but the TIMELINE does not -- the
// sims never stopped, so the base, ring, log and sent-window all keep their meaning. Adopt
// only the epoch stamp/gate. A _rbReset here would instead rebase wire ticks mid-flight and
// orphan every packet the peer already has in the air.
function _rbAdoptEpoch(){ if(typeof netEpoch === 'function') _rbEpoch = netEpoch(); }
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
// ALSO the 'h' wire contract: the per-field hashes ride as a positional array in THIS
// order (see _rbHashBoth), so reordering or extending the list changes the wire format.
// That is a sim-minor bump -- the version gate refuses cross-minor duels, so both ends
// of any match always share one list.
const RB_HASH_DUEL = ['phase','level','gem','gemsDone','bars','simTick','simNow',
    'gPer','_gDue','_gAt','phaseAt','gemAt','deathMsg','spawnAt','powerPellet','powerPelletAt',
    '_powerMode','_powerModeAt','heart','heartAt','_barMoveTick','players','duelWinner',
    '_speedRound','_nmWasAdjacent','_ws','_rngState'];
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
             players, duelWinner, _speedRound, _nmWasAdjacent, _ws, _rngState };
}
// Per-FIELD hashes alongside the whole-state one. A bare "DESYNC" cannot say what
// diverged -- we hold the peer's hash, not its state, so there is nothing to diff.
// They turn an unactionable alarm into a field name, which is the only way to find a
// divergence that only happens on real devices. On the wire they ride inside 'h' as a
// positional 16-bit array (see _rbHashBoth); this named 32-bit map is the tests'
// diagnostic view (the product diff in _rbHashSettle reads _rbHashBoth's 16-bit array).
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
// Whole-state hash alone. _rbHashBoth builds the identical JSON bytes (see its comment),
// so this is the same wire value from the same single serialization contract.
function _rbHash(snap){ return _rbHashBoth(snap).h; }
// Whole hash + per-field hashes from ONE serialization pass. JSON.stringify of the
// whitelist object is byte-identical to '{' + the '"key":<field JSON>' parts joined by
// ',' + '}' (insertion order; undefined fields omitted -- exactly what JSON.stringify
// does), so the whole-state hash comes out wire-identical to _rbHash while the state
// is only walked once. This is the 64-tick boundary's hot path: the separate calls
// were the single biggest recurring main-thread spike.
// The per-field hashes ship as a positional 16-bit array in RB_HASH_DUEL order: the
// field NAMES are shared code and stay off the wire. 16 bits make a false per-field
// agreement a 1/65536 fluke -- behind a 32-bit whole-state mismatch that already proved
// SOMETHING diverged. If every field collides its way out of the diff, the verdict names
// none and fires both repairs (the safe fallback in _rbHashSettle), so a collision can
// delay a targeted repair, not sync.
function _rbHashBoth(snap){
    try {
        const f = [], parts = [];
        for(const k of RB_HASH_DUEL){
            const s = JSON.stringify(snap[k]);   // undefined when the field is absent
            f.push(_rbStrHash(s === undefined ? 'u' : s) & 0xffff);
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
const RB_SETTLE = RB_HASH_LAG + 2;  // HASH settle: judge a tick only once BOTH clients' snapshots
                             // of it are immutable. Our own copy stops moving once no accepted input
                             // can still rewrite it -- RB_DEPTH ticks after the tick ran; the sender
                             // froze it at RB_HASH_LAG+1 old (its emit tick -- the schedule in
                             // netTickPre). Comparing sooner races an in-flight late input and reads
                             // a phantom desync once a second. The +2 also gives the typical verdict
                             // its OWN tick phase (2 mod 64): freeze (0), emit (1), judge (2) never stack.
const RB_STATE_SETTLE = 0;   // STATE settle: NONE. The peer's snake is AUTHORITATIVE and does not
                             // depend on our inputs settling, so apply it the moment its tick is in
                             // the past (simTick >= tk) -- no wait. Applying immediately keeps the
                             // correction in the seamless in-ring path; a future-stamped state (tk >
                             // simTick) still parks here until we reach its tick.
var _rbHashQ = [];           // [{tk, h}] peer hashes waiting for their tick to settle
function _rbCheckHash(m){
    // The per-field hashes are positional (RB_HASH_DUEL order): clamp to the known
    // length so a hostile peer cannot ship tens of thousands of entries for the
    // mismatch diff (_rbHashSettle) to iterate.
    const f = Array.isArray(m.f) ? m.f.slice(0, RB_HASH_DUEL.length) : null;
    // g = the peer's item-attestation tag for that tick (see _wsAttest). Parked with the
    // hash and only kept once the verdict proves the _ws field agreed.
    _rbHashQ.push({ tk:_rbFromWire(m.tk), h:m.h>>>0, f, g:m.g });
    if(_rbHashQ.length > 8){ _rbHashQ.shift(); _rbDbg.hashLost++; }   // evicted before it could be judged: count it, never drop a verdict in silence
    // A hash rides RB_HASH_LAG+1 behind its sender's live tick (the emit tick, see the schedule
    // in netTickPre), so reconstruct that live tick to tell "peer froze" from "hash is just old".
    // Backup detector for a quiet straightaway where no 'in' packet flows; the packet-level
    // detector in _netPeerInput is the primary (no built-in lag).
    _rbNoteBehindPeer(_rbFromWire(m.tk) + RB_HASH_LAG + 1);
}
// Exact-tick ring lookup, newest-first. NOT for _rbRollback, which wants the nearest
// entry at-or-BEFORE a tick -- a different predicate that stays inline there.
function _rbRingFind(tk){
    for(let j = _rbRing.length - 1; j >= 0; j--) if(_rbRing[j].tk === tk) return _rbRing[j];
    return null;
}
// Our OWN frozen hash per hash tick, held independently of the snapshot ring. A verdict
// compares the peer's hash for tick tk against ours for tk, so it can only be reached while a
// settled copy of tk still exists on this side. Deriving that copy from the ring ties detection
// to RB_RING: the ring spans RB_RING*RB_SNAP_EVERY ticks while the verdict sits RB_HASH_LAG
// behind, leaving only a handful of ticks of arrival margin -- past it a peer hash has nothing
// to compare against and yields NO verdict at all, and with no verdict there is no OUT OF SYNC
// banner, no 'st'/'rs' repair and no escalation, so a real divergence stays permanent AND
// silent. We already compute this exact value when we send our own hash for the same tick, so
// keep it: RB_MYHASH_KEEP entries one hash-tick apart tolerate several seconds of arrival lag,
// whatever the ring depth is tuned to.
const RB_MYHASH_KEEP = 8;
var _rbMyHash = [];          // [{tk,h,f}] oldest first, one per hash tick
function _rbMyHashAdd(tk, hb){
    if(_rbMyHash.length && _rbMyHash[_rbMyHash.length - 1].tk === tk) return;
    _rbMyHash.push({ tk, h:hb.h, f:hb.f });
    if(_rbMyHash.length > RB_MYHASH_KEEP) _rbMyHash.shift();
}
function _rbMyHashFind(tk){
    for(let j = _rbMyHash.length - 1; j >= 0; j--) if(_rbMyHash[j].tk === tk) return _rbMyHash[j];
    return null;
}
// ---- ITEM ATTESTATION: the duel half of the handover ----------------------------------
// A cosmetic that changes hands has to end up owned by exactly one player ON THE SERVER, and
// the only two parties who witnessed the steal are the two clients. So each client attests
// what it saw: on every hash tick it MACs a digest of "which item instance is worn by whom"
// with its own per-match secret and ships that tag beside the hash it was already sending.
// The peer's tag for the same tick is what turns a client's report into EVIDENCE -- the
// server holds both secrets, so it can verify a tag it did not produce and no client can
// forge the other side's agreement (see items.js and the server's Items::claim ladder).
//
// WHY the transfer is derived HERE rather than from the 'wsget' event: that event is in
// FX_DEFER, so it re-queues on every rollback re-sim and a claim built from it would fire
// again for a transfer that was rolled back and replayed. What we attest instead is the
// frozen hash tick hk (= 64k - 64, on the pinned 64-grid), which is immutable by construction
// and identical on both clients -- so diffing the ownership map between consecutive attested
// ticks yields each transfer exactly once, in the same window, on both sides.
//
// An item with no uid (bought while offline, never registered) simply has nothing to name on
// the server: it stays out of the digest and generates no claim. It is still worn, drawn and
// stealable -- offline play is never blocked, it is only unattestable.
var _wsMid = '', _wsSec = '', _wsIds = ['', ''], _wsSeqs = null;
var _wsOwnPrev = null;       // the uid -> player-index map at the previously attested tick
var _wsPend = [];            // gains held back for the peer's tag
var _wsPeerTag = [];         // [{tk,g}] peer tags for ticks whose _ws provably agreed
const WS_TAG_RE = /^[0-9a-f]{16}$/;
const WS_CLAIM_WAIT = 128;   // drain ticks (~2.1s) a gain waits for the peer's tag before shipping unproven
const WS_PEERTAG_KEEP = 8;   // one per hash tick, the same arrival margin RB_MYHASH_KEEP allows
const WS_PEND_MAX = 8;

// Match identity for the attestation, from the server's start.php (mid + this side's secret)
// plus the two player ids in sim index order. Cleared per match: a tag keyed with a previous
// match's secret would read as tampering, not as a stale packet.
function _wsClaimReset(mid, sec, ids, seqs){
    _wsMid = typeof mid === 'string' ? mid : '';
    _wsSec = typeof sec === 'string' ? sec : '';
    _wsIds = Array.isArray(ids) ? [ids[0] || '', ids[1] || ''] : ['', ''];
    _wsSeqs = (seqs && typeof seqs === 'object') ? seqs : {};
    _wsOwnPrev = null; _wsPend = []; _wsPeerTag = [];
}
// uid -> owning player index, from a ring snapshot. The LOOSE item counts as its owner's:
// while it is in flight or lying on the board it has left nobody's inventory, and leaving it
// out would read as a disappearance followed by an unrelated appearance instead of one
// transfer. Empty uids are skipped -- unregistered items share the '' key and are not
// instances the server knows.
function _wsOwnAt(sn){
    const o = {}, ws = sn && sn._ws;
    if(!ws) return o;
    for(let i = 0; i < 2; i++){ const m = ws.u[i]; for(const k in m) if(m[k]) o[m[k]] = i; }
    if(ws.it && ws.it.uid) o[ws.it.uid] = ws.it.own;
    return o;
}
// The attested ownership digest: uid=owner pairs, uid-SORTED so it is a function of the state
// and not of the order the two clients happened to reach it in, hashed so it stays inside the
// server's ws_digest cap however much gear is in play.
function _wsDigestOf(own){
    const ks = Object.keys(own).sort();
    let s = '';
    for(let i = 0; i < ks.length; i++) s += ks[i] + '=' + own[ks[i]] + ';';
    return sha256Hex(s);
}
// The catalog id behind a uid, for the local inventory fix-up in items.js. The server keys
// everything by uid and never needs it.
function _wsItemOf(sn, uid){
    const ws = sn && sn._ws;
    if(!ws) return '';
    for(let i = 0; i < 2; i++){ const m = ws.u[i]; for(const k in m) if(m[k] === uid) return k; }
    return (ws.it && ws.it.uid === uid) ? ws.it.id : '';
}
function _wsRelease(c, g){
    if(typeof _wsClaimOut !== 'function') return;
    _wsClaimOut({ mid:_wsMid, uid:c.uid, item:c.item, from:c.from, to:c.to, tick:c.tick,
                  seq:c.seq, digest:c.dg, myTag:c.tag, peerTag:g || '' });
}
// Every uid whose owner CHANGED between the two attested ticks. A uid that only appears is a
// mint or a resync import, and one that only disappears is an item displaced out of a wear
// slot but still owned (see the pickup in sim.js) -- neither changed hands, and reporting
// either would move a server row nothing moved.
function _wsDiff(prev, now, hk, dg, tag, snap){
    const me = netMyIndex();
    for(const uid in now){
        const a = prev[uid], b = now[uid];
        if(a === undefined || a === b) continue;
        // seq is the compare-and-swap the server checks: our view of the instance's version
        // BEFORE this transfer. Bumped here, at the deterministic attest tick, so a steal and
        // a steal-back inside one match each compare against the right value.
        const seq = _wsSeqs[uid] | 0;
        _wsSeqs[uid] = seq + 1;
        const c = { uid, item:_wsItemOf(snap, uid), from:_wsIds[a], to:_wsIds[b],
                    tick:hk, seq, dg, tag, wait:WS_CLAIM_WAIT };
        // "I LOST it" needs no corroboration: a client has nothing to gain by giving an item
        // away, so the server settles that direction on the caller's own tag alone -- send it
        // at once and let it settle the peer's gain. "I TOOK it" is the direction that pays,
        // so it waits for the peer's tag for the same tick and ships unproven only once the
        // wait runs out, where the server holds it through its grace period instead.
        if(b === me){ if(_wsPend.length < WS_PEND_MAX) _wsPend.push(c); }
        else if(a === me) _wsRelease(c, '');
    }
}
// Runs on the emit tick, against the snapshot whose hash is being frozen: attest that tick's
// ownership, and derive any transfer since the last attested one. Returns the tag to ship
// inside the 'h' packet.
function _wsAttest(hk, snap){
    if(!_wsMid || !_wsSec || !_wsIds[0] || !_wsIds[1]) return '';
    const own = _wsOwnAt(snap);
    const dg = _wsDigestOf(own);
    const tag = itemTag(_wsSec, _wsMid, hk, dg);
    if(_wsOwnPrev && tag) _wsDiff(_wsOwnPrev, own, hk, dg, tag, snap);
    _wsOwnPrev = own;
    return tag;
}
// A peer tag is only worth keeping for a tick whose _ws we KNOW agreed. Two sides that
// diverged attested different digests, so the peer's tag would be valid for a state we never
// saw -- and the server reads an unverifiable peer tag as provable tampering and freezes the
// item. A benign desync must not destroy gear, so an unproven claim (no tag at all) is
// strictly better than a wrong one.
function _wsPeerTagAdd(tk, g){
    if(typeof g !== 'string' || !WS_TAG_RE.test(g)) return;
    _wsPeerTag.push({ tk, g });
    if(_wsPeerTag.length > WS_PEERTAG_KEEP) _wsPeerTag.shift();
}
// Called each tick: ship the gains whose corroboration has arrived, and the ones that waited
// long enough. The countdown is in DRAIN TICKS, not simTick -- a level boundary resets simTick
// to 0, and a deadline expressed in it would never expire.
function _wsDrain(){
    if(!_wsPend.length) return;
    for(let i = _wsPend.length - 1; i >= 0; i--){
        const c = _wsPend[i];
        let g = '';
        for(let j = _wsPeerTag.length - 1; j >= 0; j--) if(_wsPeerTag[j].tk === c.tick){ g = _wsPeerTag[j].g; break; }
        if(!g && --c.wait > 0) continue;
        _wsPend.splice(i, 1);
        _wsRelease(c, g);
    }
}
// Called each tick: judge whatever has settled and we still hold a comparable copy of.
function _rbHashSettle(){
    if(!_rbHashQ.length) return;
    for(let i = _rbHashQ.length - 1; i >= 0; i--){
        const q = _rbHashQ[i];
        if(simTick < q.tk + RB_SETTLE) continue;          // still in flight: leave it parked
        _rbHashQ.splice(i, 1);
        // Our settled hash for that tick: the cache first (it outlives the ring), the ring
        // second for a tk off the shared hash cadence. _rbHashBoth is one pass: the whole
        // hash for the verdict, the field hashes for the diff.
        let hb = _rbMyHashFind(q.tk);
        if(!hb){ const e = _rbRingFind(q.tk); if(e) hb = _rbHashBoth(e.snap); }
        if(!hb){ _rbDbg.hashLost++; continue; }             // no settled copy of that tick here: not comparable
        // Whole-state agreement covers _ws too, so the peer's tag attests the same ownership
        // we did: worth keeping as corroboration for any transfer at that tick.
        if(hb.h === q.h){ _rbDbg.hashOk++; _rbBadSince = 0; _wsPeerTagAdd(q.tk, q.g); continue; }   // agreement heals the escalation clock
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
        if(q.f && hb.f){
            // Positional diff, both sides already the wire's 16 bits (_rbHashBoth masks).
            // A short or malformed array reads undefined past its end, mismatches every
            // remaining field and lands in the fire-both-repairs fallback -- safe.
            const bad = [];
            for(let fi = 0; fi < RB_HASH_DUEL.length; fi++)
                if(q.f[fi] !== hb.f[fi]) bad.push(RB_HASH_DUEL[fi]);
            if(bad.length){
                where = bad.join(',');
                snakes = bad.indexOf('players') >= 0;
                struct = bad.some(k => k !== 'players');
                // The worlds split, but not over WHO OWNS WHAT: the peer attested the same
                // ownership digest we did, so its tag still corroborates a transfer at this
                // tick. If _ws is among the diverged fields it does not, and no tag is kept.
                if(bad.indexOf('_ws') < 0) _wsPeerTagAdd(q.tk, q.g);
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
    // A very long snake can push the state past the one-datagram cap; _netSend enforces that
    // budget universally and DROPS the oversize packet rather than fragment -- the hash still
    // flags the divergence, recovery just lands on a later, shorter state.
    _netSend(o);
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
// TRUE while the owed sends are a FULL outage burst (a reconnect, or a peer detected a whole
// ring behind) rather than the routine single-rs desync repair. Only a full burst finishing
// fires the recovery hook (_rbRecovered below): the outage healed the peer's STATE, but the
// pair still ticks on the pre-outage clock anchor, so the net layer answers with a RESUME
// boundary (fresh burst + anchor + epoch, no rebuild). A one-packet repair must NOT open a
// boundary every time a hash disagrees -- that would be a re-anchor storm under jitter.
var _rbResyncFull = false;
// An ORDINARY 'rs' stamped a little AHEAD of our sim, parked until the sim reaches its tick.
// The sender's frontier legitimately sits a tick or two past a peer whose loop fires later,
// so the ring entry for T does not exist here YET -- that is an EARLY packet, not an aged-out
// divergence. Falling through to the aged-out branch wiped the whole ring, and with it the
// pinned 64-grid hash snapshots: the next 1Hz emit then silently skipped a full verdict
// cycle, which under a running escalation clock is the difference between healing and the
// OUT OF SYNC deadline. Newest wins if another arrives before the drain.
var _rbResyncQ = null;
function _rbArmFullResync(){ _rbResyncSend = RB_RESYNC_BURST; _rbResyncFull = true; }
// A peer packet stamped a full RB_DEPTH behind our sim can only mean the peer FROZE (backgrounded)
// while we ran on: arm an authoritative resync burst so it can catch its tick base forward. Gated
// on _rbRing so we only offer to heal once we actually have a frontier to send.
function _rbNoteBehindPeer(peerTk){
    if(peerTk <= simTick - RB_DEPTH && _rbRing.length) _rbArmFullResync();
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
        rng:sn._rngState, sr:!!sn._speedRound, dw:sn.duelWinner, nma:!!sn._nmWasAdjacent,
        // The windswept registry rides whole: who wears what, plus any item lying on the
        // board. Hashed, so an rs that dropped it would keep the hashes apart forever.
        ws:sn._ws ? { w:[sn._ws.w[0].slice(), sn._ws.w[1].slice()],
                      u:[sn._ws.u[0], sn._ws.u[1]], it:sn._ws.it } : null,
        pp:sn.powerPellet, ppa:sn.powerPelletAt, pm:!!sn._powerMode, pma:sn._powerModeAt, bmt:sn._barMoveTick|0,
        hb:sn.heart, hba:sn.heartAt,
        p0:_rbPackPlayer(sn.players[0]), p1:_rbPackPlayer(sn.players[1]) };
}
// A loose windswept item off the wire, rebuilt in the sim's own key order. An unknown id or an
// off-board cell drops the item rather than importing it: losing one cosmetic beats adopting
// a state the local sim would then hash differently forever.
function _rbWsItem(o){
    if(!o || !WS[o.id]) return null;
    if(!(o.x >= 0 && o.x < COLS && o.y >= 0 && o.y < ROWS)) return null;
    const uid = (typeof o.uid === 'string' && WS_UID_RE.test(o.uid)) ? o.uid : '';
    return { id:o.id, uid, own:o.own ? 1 : 0, x:o.x|0, y:o.y|0, at:o.at|0 };
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
    if(!catchUp && T > simTick){ _rbResyncQ = m; return; }   // early, not aged-out: park (see _rbResyncQ)
    // The FULL authoritative snapshot AT tick T: the whole SHARED world (level/gems/rng/bars/
    // power/heart/timers) plus the HOST's own snake (p0). How we treat OUR snake (p1) depends on
    // the branch below.
    const snap = simSnapshot();
    snap.phase = m.ph; snap.level = m.lv|0; snap.gemsDone = m.gd|0; snap.gem = m.gem; snap.gemAt = m.ga; snap.deathMsg = m.dm; snap._barsV = (snap._barsV|0) + 1;
    snap.bars = (m.bars || []).map(a => { const b = { x:a[0]|0, y:a[1]|0, fragile:!!(a[2]&1), paired:!!(a[2]&2) }; if(a[3] >= 0) b.pairEnd = { x:a[3]|0, y:a[4]|0 }; if(a.length > 5 && a[5] >= 0){ b.gd = a[5]|0; b.gdUntil = a[6]|0; } return b; });
    snap._gAt = m.gat|0;
    snap.gPer = m.gp; snap._gDue = m.gdue; snap.phaseAt = m.pha; snap.spawnAt = m.spa; snap.levelDoneWaiting = !!m.ldw;
    snap._rngState = m.rng; snap._speedRound = !!m.sr; snap.duelWinner = m.dw; snap._nmWasAdjacent = !!m.nma;
    snap._ws = null;
    if(m.ws){
        const u = Array.isArray(m.ws.u) ? m.ws.u : [];
        const s0 = _wsSeed(m.ws.w && m.ws.w[0], u[0]), s1 = _wsSeed(m.ws.w && m.ws.w[1], u[1]);
        snap._ws = { w:[s0.w, s1.w], u:[s0.u, s1.u], it:_rbWsItem(m.ws.it) };
    }
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
        _rbResyncQ = null;   // parked pre-jump, it is now an OLD state that would regress this adoption
        _rbResyncSend = 0; _rbResyncFull = false;   // adopting a catch-up cancels our own owed burst: a stale full-flag must not fire a later bogus recovery
        _rbDbg.fix = (_rbDbg.fix|0) + 1;
        _netSigLog('~ RESYNC-CATCHUP @' + T);
        return;
    }
    snap.simTick = T - 1; snap.simNow = (T - 1) * TICK_MS;   // ring convention: entry tk=T holds the state at simTick T-1
    const e = _rbRingFind(T);
    if(e){
        // IN-RING: keep OUR own snake as WE recorded it at T (the ring entry), not the host's copy
        // -- we own our snake. Only the shared world + the host's snake are the host's to correct.
        // Rolling forward then REPLAYS our logged inputs from T, re-deriving our own snake exactly.
        // Both sims land byte-identical at the frontier and STAY converged (a rollback renders
        // final-only, so no visible jump). Adopting the host's stale copy here is what re-yanked
        // our head after a preceding hard-apply had wiped the log the replay needs.
        if(e.snap && e.snap.players && e.snap.players[1]) snap.players[1] = e.snap.players[1];
        e.snap = _rbCloneSnap(snap); _rbRollback(T);
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
    _rbResyncSend = 0; _rbResyncFull = false;   // adopting a resync cancels our own owed sends (and any stale full-flag with them)
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
        const e = _rbRingFind(q.tk);
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
// SHAPE-SPECIALIZED cloner (measured 6-12x over the previous generic recursion, which
// was the dominant duel-only main-thread cost: a clone runs on every snapshot tick AND
// through every rollback re-record). Knowing the layout removes all per-key reflection;
// the price is a CONTRACT: a clone must serialize byte-identical to its source, because
// JSON.stringify of the pinned snapshots feeds the duel hash and a rollback replaces
// live state on ONE side only -- so nested key ORDER and key PRESENCE must be
// reproduced exactly, or identical logical states hash apart after a repair.
// Snake cells, dir/dirQueue/boostDir, powerPellet/heart are always {x,y}; a player
// always carries _mkDuelPlayer's field set in its order. Two shapes are NOT fixed and
// are cloned by the flat one-level walker instead of a literal: bars (three construction
// sites -- the _placeBars base {x,y,fragile}, its paired extension {x,y,paired,fragile},
// the resync wire rebuild {x,y,fragile,paired} -- plus pairEnd/gd/gdUntil appended in
// play) and the gem ({x,y} from freeCell with tier/spawnAt appended, and it also crosses
// the rs/st wire verbatim). KEEP IN SYNC with _rbDuelSnap / _mkDuelPlayer.
function _rbCloneFlat(b){
    const n = {};
    for(const k in b){ const v = b[k]; n[k] = (v && typeof v === 'object') ? { x:v.x, y:v.y } : v; }
    return n;
}
function _rbClonePlayer(p){
    const sn = p.snake, s = new Array(sn.length);
    for(let i = 0; i < sn.length; i++){ const c = sn[i]; s[i] = { x:c.x, y:c.y }; }
    const dq = p.dirQueue || [], q = new Array(dq.length);
    for(let i = 0; i < dq.length; i++){ const d = dq[i]; q[i] = { x:d.x, y:d.y }; }
    return { snake:s, dir:p.dir ? { x:p.dir.x, y:p.dir.y } : p.dir, dirQueue:q,
             boostDir:p.boostDir ? { x:p.boostDir.x, y:p.boostDir.y } : p.boostDir,
             boosting:p.boosting, stepAccum:p.stepAccum, score:p.score, lives:p.lives,
             alive:p.alive, slowUntil:p.slowUntil };
}
// The windswept registry, cloned to the same shape the sim builds (see _ws in sim.js and
// _duelStealRoll's item literal): the per-field hash stringifies this object, so the key
// ORDER here is part of the byte-identity contract, not a style choice.
function _rbCloneWs(v){
    if(!v) return v;
    const it = v.it;
    return { w:[ v.w[0].slice(), v.w[1].slice() ],
             // The uid maps are cloned key-by-key in their own insertion order, which
             // JSON.stringify then reproduces -- same contract as the key order below.
             u:[ Object.assign({}, v.u[0]), Object.assign({}, v.u[1]) ],
             it: it ? { id:it.id, uid:it.uid, own:it.own, x:it.x, y:it.y, at:it.at } : it };
}
function _rbCloneSnap(s){
    const bs = s.bars || [], bars = new Array(bs.length);
    for(let i = 0; i < bs.length; i++) bars[i] = _rbCloneFlat(bs[i]);
    return { phase:s.phase, level:s.level, gem:s.gem ? _rbCloneFlat(s.gem) : s.gem,
        gemsDone:s.gemsDone, bars, _barsV:s._barsV, simTick:s.simTick, simNow:s.simNow,
        gPer:s.gPer, _gDue:s._gDue, _gAt:s._gAt, phaseAt:s.phaseAt, gemAt:s.gemAt,
        deathMsg:s.deathMsg, spawnAt:s.spawnAt, levelDoneWaiting:s.levelDoneWaiting,
        powerPellet:s.powerPellet ? { x:s.powerPellet.x, y:s.powerPellet.y } : s.powerPellet,
        powerPelletAt:s.powerPelletAt, _powerMode:s._powerMode, _powerModeAt:s._powerModeAt,
        heart:s.heart ? { x:s.heart.x, y:s.heart.y } : s.heart, heartAt:s.heartAt,
        _barMoveTick:s._barMoveTick,
        players:s.players ? [ _rbClonePlayer(s.players[0]), _rbClonePlayer(s.players[1]) ] : s.players,
        duelWinner:s.duelWinner, _speedRound:s._speedRound, _nmWasAdjacent:s._nmWasAdjacent,
        _ws:_rbCloneWs(s._ws), _rngState:s._rngState };
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
    if(t % RB_SNAP_EVERY && (t & 63)) return; // thinned: this tick rewinds via the previous entry.
                                              // The 64-grid hash ticks are PINNED into the ring even
                                              // off the step: the 1Hz freeze and the settle fallback
                                              // look t-RB_HASH_LAG up EXACTLY, and 64 % RB_SNAP_EVERY != 0.
    if(_rbRing.length && _rbRing[_rbRing.length-1].tk === t) return;   // already have it
    _rbRing.push({ tk:t, snap:_rbCloneSnap(_rbDuelSnap()) });
    if(_rbRing.length > RB_RING) _rbRing.shift();
}
// The full input flush: prune, ship the redundancy log, and run the cycle bookkeeping.
// The repair resend and the 16-tick heartbeat are deliberate variants WITHOUT this
// bookkeeping (they repeat, not author): those stay inline where they are.
function _netInFlushNow(){
    _rbSentPrune();
    _netSend({ t:'in', tk:_rbToWire(simTick), l:_rbSent });
    _netDbg.inTx++;
    _netInDirty = false;
    _netInFlush++;
    _netInRepeat = 2;   // arm the repair countdown (see its declaration)
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
    if(!_replaying){
        // EVERY repair that can rebuild the world -- a parked 'rs' draining, a hash-verdict
        // repair, a settled peer 'st' patch -- MUST run BEFORE this tick's snapshot and log-feed
        // below. Each rebuilds from a ring entry and replays the log only up to simTick; tick t
        // has not run yet, so its records are NOT part of any replay. When a repair ran AFTER
        // the log-feed (the old order), it silently discarded the records just fed for t: the
        // pass then stepped t without them while they stayed in the log, so both clients' logs
        // matched and the worlds diverged anyway -- unhealably, because every later repair ate
        // that pass's fresh records the same way and re-opened the split it had just closed.
        // (The doze residual: the catch-up burst's trailing 'rs' parks, drains one pass later,
        // and lands exactly on a tick just fed a boost -- 'players' splits ~7 ticks after wake.)
        // Parked early 'rs' first (see _rbResyncQ): once the sim reaches its tick it applies
        // through the normal in-ring path, before this tick's hash/state verdicts settle.
        if(_rbResyncQ && _rbFromWire(_rbResyncQ.tk) <= simTick){
            const rq = _rbResyncQ; _rbResyncQ = null; _rbApplyResync(rq);
        }
        _rbHashSettle(); _rbStateSettle(); _wsDrain();
    }
    _rbEnsureSnap(t);
    // Our own input was applied the moment it happened (netLocalInput), at exactly this
    // point in the tick order -- so skip it here or it lands twice. A ROLLBACK re-sim
    // goes through _rbRollback, which applies the log in full: _live is only about this
    // live pass.
    const cmds = _rbLog.get(t);
    if(cmds) for(const c of cmds){ if(!c._live) simCommand(c); }
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
    // the only place allowed to. The per-level and rematch starts get their re-anchor
    // for free by going through it.
    // Coalescing input flush: the first turns of a cycle already shipped at authoring (the
    // leading-edge flush in netLocalInput, capped at two); everything authored past the
    // cap only marked _netInDirty and collapses here into a single latest-valid packet --
    // a burst of touches or key-repeats costs one send, not one per event. It carries the
    // whole recent log (_rbSent) for redundancy, so a heartbeat this same tick would only
    // repeat it: skip it.
    let _inFlushed = false;
    _netInFlush = 0;   // a new tick cycle: authored turns may ship at once again
    if(_netInDirty && !_replaying){
        _netInFlushNow();
        _inFlushed = true;
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
    // ---- The recurring-job tick schedule: one job per phase -- a staircase, not a spike ----
    // t mod 64:  0 = pinned snapshot clone (_rbEnsureSnap)   1 = hash freeze+emit (hk = t-65)
    //            2 = typical verdict tick (RB_SETTLE)       17 = log/heads prune
    // t mod 16:  5 = heartbeat           t mod 4: 0 = warm ping (else-if'd, ~15B)
    // The 3-tick snapshot grid is coprime to these and drifts through them (1/3 coincidence),
    // so no tick ever stacks more than TWO jobs. Every phase is a pure function of the shared
    // simTick. The FROZEN tick grid (0 mod 64) is the only one with a wire contract, and it is
    // exactly the grid the ring PINS -- on this side and on the peer's; the emit and judge
    // phases are each side's local business, so old-patch peers lose nothing.
    if((t & 63) === 17){
        for(const k of _rbLog.keys()) if(k < t - RB_DEPTH - 8) _rbLog.delete(k);
        for(const k of _rbHeads.keys()) if(k < t - RB_DEPTH - 8) _rbHeads.delete(k);
    }
    if((t & 63) === 1){
        // The 1Hz detector, keyed to the deterministic tick so both clients emit on the
        // same tick. It ALWAYS carries the per-field hashes (~575B): a mismatch verdict
        // lands with its diagnosis in hand and the targeted repair fires right there in
        // _rbHashSettle -- no request round trip, no repair cadence of its own. Fires on its
        // own cadence even when an input flush already went out this tick (they carry different data).
        if(!_replaying && _rbRing.length){
            // Freeze the hash of the PINNED tick one past RB_HASH_LAG -- immutable, so no
            // later rollback can re-record it after we send, and one tick AFTER its clone was
            // taken, so the clone and this hash+send never share a tick. Both clients run this
            // on the same deterministic tick and target the same tk. Skip if it has aged out of
            // the ring (only near a level start, before the ring is deep enough): nothing to
            // compare yet.
            const hk = t - RB_HASH_LAG - 1;
            const he = _rbRingFind(hk);
            if(he){
                const hb = _rbHashBoth(he.snap);
                _rbMyHashAdd(hk, hb);   // the peer's hash for hk is judged against THIS, however late it lands
                // The item attestation rides the SAME tick and the same packet: hk is frozen
                // here, so both clients sign the identical ownership state (see _wsAttest).
                // Omitted when there is nothing to attest -- a local duel, or a match with no
                // registered gear in it.
                const o = { t:'h', tk:_rbToWire(hk), h:hb.h, f:hb.f };
                const g = _wsAttest(hk, he.snap);
                if(g) o.g = g;
                _netSend(o);
            }
        }
    } else if(!_inFlushed && (t & 15) === 5 && !_replaying){
        // 16-tick heartbeat (~267ms), phased off every other job's tick. Carries the recent
        // input log = free input-redundancy repair, and keeps SOMETHING on the wire every
        // 16 ticks for liveness.
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
        // A FULL burst settling means the outage is over: the peer holds our frontier, but the
        // pair is still anchored on the pre-outage clock. Hand the moment to the net layer,
        // which opens a RESUME boundary (burst + anchor + epoch, no rebuild). Home-installed
        // hook, like _rbPostRollback: the main-thread home calls _netResyncSettled directly
        // (game.js), the worker home crosses the seam as a 'duelRecovered' duel event.
        if(_rbResyncSend === 0 && _rbResyncFull){
            _rbResyncFull = false;
            if(typeof _rbRecovered === 'function') _rbRecovered();
        }
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
    if(_netInDirty) _netInFlushNow();
}
// Rewind to `toTick` and re-simulate to where we were, now including the input
// that arrived late. Silent: _replaying keeps the re-run from re-firing visuals
// that already played.
function _rbRollback(toTick){
    let idx = -1;
    for(let i = _rbRing.length - 1; i >= 0; i--) if(_rbRing[i].tk <= toTick){ idx = i; break; }
    if(idx < 0) return false;                    // older than the ring: unrecoverable
    const from = _rbRing[idx].tk, target = simTick, keep = phase, preBarsV = _barsV;
    simApplyDuel(_rbCloneSnap(_rbRing[idx].snap));   // clone: the ring entry stays pristine
    _sfxQ = _sfxQ.filter(q => q.tk <= simTick);  // sounds predicted past the rewind: cancelled...
    _fxQ  = _fxQ.filter(q => q.tk <= simTick);   // ...same for visual effects (bonus/crush/fireworks)
    _rbRing.length = idx;                        // these states are void; re-recorded below
    _replaying = true;
    for(let t = from; t <= target; t++){
        _rbNoteHeads(t, true);                   // re-record: the corrected past can move heads
        if(t % RB_SNAP_EVERY === 0 || (t & 63) === 0)   // same grid as _rbEnsureSnap, pinned hash ticks included
            _rbRing.push({ tk:t, snap:_rbCloneSnap(_rbDuelSnap()) });
        const cmds = _rbLog.get(t);
        if(cmds) for(const c of cmds) simCommand(c);
        update();
        if(simEvents.length) drainSimEvents();   // ...and the re-run queues the RIGHT ones
    }
    _replaying = false;
    simEvents.length = 0;
    if(_rbRing.length > RB_RING) _rbRing.splice(0, _rbRing.length - RB_RING);
    // Presentation reconciliation is the HOME's business, not the core's: the main-thread
    // home installs _rbPostRollback (game.js) to re-render moved bars and keep the quit
    // overlay up; the worker home installs none (its bars re-render with the next posted
    // frame, and quitConfirm is a main-thread phase its sim never holds).
    if(typeof _rbPostRollback === 'function') _rbPostRollback(_barsV !== preBarsV, keep);
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
        // A turn onto the heading the snake already holds -- or its exact REVERSE -- is dropped by
        // the sim on BOTH clients, so authoring a wire record for it is pure waste: one peer
        // rollback/live-apply for a snake that never turned. A held dpad key and keyboard
        // auto-repeat already suppress this at the source; a continuous swipe does not, so a slide
        // along the travel axis (with or against it) re-emits one no-op turn per ~48px.
        // Suppress ONLY when it is PROVABLY a no-op. The sim's dir handler judges a record against
        // the LAST ACCEPTED dir (the dirQueue tail, or P.dir when the queue is empty), and that
        // anchor only ever changes when a record is ACCEPTED. So when BOTH our last AUTHORED dir
        // (a committed fact -- nothing distinct is queued behind it) AND our snake's CURRENT
        // heading lie on the press's axis (equal or opposite), the judging anchor is provably on
        // that axis too, and the sim discards the record on both clients -- as same-as-last or as
        // a reverse. Requiring the LIVE heading keeps a respawn/level heading reset -- which
        // changes P.dir without an authored record -- from ever being mis-suppressed: a turn off
        // the new spawn axis always goes through. (Unit dirs: nonzero dot product == same axis.)
        // The full-queue revoke path (_dirEnqueue pops the tail, then re-judges) never fires
        // under this premise either: a FULL queue implies heading-perpendicular-to-tail
        // (queued neighbors alternate axes), so a tail on the press's axis fails the heading
        // half of the premise -- and a tail on the OTHER axis fails the authored half, since
        // the record that set _lastLocalDir to the press's axis would itself have emptied
        // slot 3 (and any later refill re-aims _lastLocalDir at the tail's axis). A
        // suppressed press therefore always takes the plain judge-vs-tail path, a true no-op.
        if(_lastLocalDir && P.dir &&
           (_lastLocalDir.x * d.x + _lastLocalDir.y * d.y) !== 0 &&
           (P.dir.x * d.x + P.dir.y * d.y) !== 0) return true;
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
        _rbSentAdd({ q:++_rbSeq, tk:_rbToWire(S), k:'dir', d:{x:d.x, y:d.y} });
        _netInDirty = true;   // fallback: the next tick's flush carries it if the cap below hits
        // Leading-edge flush ("sent at once", as the HEADROOM contract above promises): the
        // wire record is complete right here, and the next netTickPre averages half a tick
        // away -- pure added latency on a real link, where every ms of the authoring lead
        // matters. Ship the first TWO turns of a cycle immediately (a fast double gesture
        // must not defer its second record); _netInFlush caps it there, so anything past
        // two still coalesces into the next tick's flush.
        if(_netInFlush < 2 && !_replaying) _netInFlushNow();
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
    _rbSentAdd(kind === 'bs' ? { q:++_rbSeq, tk:_rbToWire(tk), k:'bs', d:{x:d.x, y:d.y}, n: now?1:0 }
                             : { q:++_rbSeq, tk:_rbToWire(tk), k:'be' });   // be carries no dir/now: the receiver reads neither
    _netInDirty = true;   // flushed with the next tick's input packet (the redundancy log carries it)
    return true;
}

