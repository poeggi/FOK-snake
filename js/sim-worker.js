// ============================================================================
// sim-worker.js -- runs the deterministic simulation OFF the render thread.
// Loads the same assets.js + sim.js as the main page; ticks the sim on its own
// fixed-timestep clock and posts a state snapshot + the batch of sim events after
// every tick. The main thread mirrors the snapshot for rendering (render.js reads
// the mirrored globals), replays the events, and forwards input/commands here.
//
// Protocol
//   main -> worker : {t:'cfg', cfg}                 set difficulty/turbo config
//                    {t:'run', on}                  start / stop the tick loop
//                    {t:'start', seed, bestScore}   startGame()
//                    {t:'phase', phase}             UI-driven phase change (menus)
//                    {t:'dir', dir:{x,y}}           queue a steering input
//                    {t:'boost', dir} / {t:'boostend'}
//                    {t:'pause'} / {t:'resume'}
//   worker -> main : {t:'frame', snap, events}      one post per ticked frame
//
// Runs everything Worker-capable browsers play: classic, local 1:1, and (with
// duel-core.js, below) the ONLINE duel's sim + rollback. game.js falls back to an
// in-process sim only where Worker construction fails (file://, exotic browsers).
// ============================================================================
importScripts('assets.js', 'sim.js', 'duel-core.js');

// sim.js reads cfg.diff / cfg.turbo. Declare it on the worker global so those bare
// references resolve; the main thread sends the real config via {t:'cfg'} before starting.
self.cfg = { diff: 1, turbo: true };

// ---- ONLINE DUEL MODE: duel-core.js (rollback ring, input log, hashes, resync)
// runs HERE, off the render thread. net.js stays on main and forwards wire packets
// in ({t:'peerPkt'}) and local inputs ({t:'lin'}); the core's outbound packets and
// debug go back over postMessage. duel-core references a handful of main-thread
// globals -- this prelude gives them worker-appropriate homes.
let _dcOn = false, _dcMy = 0, _dcOfs = null, _dcStartPts = 0;
let _dcSnapN = 0, _dcSnapAt = 0;   // phase-set counter + moment, mirrored to the timing overlay
let _dcEvents = [];   // [{tk, e}] tick-tagged sim events for the main-thread 2-tick queues
let _dcRewTo = 0;     // deepest rewind since the last post (0 = none): main cancels stale fx
self.inGame = false;
self._replaying = false;
self._uiDirty = false;
self._sfxQ = []; self._fxQ = [];   // core rewinds filter these locally; _dcRewTo carries the fact to main
self._duelMsg = ''; self._duelMsgAt = 0;
self._msgNow = () => performance.now();
self.netGameActive = () => _dcOn;
self.netMyIndex = () => _dcMy;
self.netPts = () => _dcOfs == null ? null : Math.round(Date.now() + _dcOfs);
self._netSend = (o, pre) => { if(_dcOn) postMessage({ t:'wire', o }); };
self._netSigLog = (line) => { if(_dcOn) postMessage({ t:'dsig', line }); };
self._netDbg = { inRx:0, inTx:0, inLog:[], peerTkOfs:0, lag:0, hbRx:0, hbTx:0 };
// Tick-tag events instead of game.js's direct dispatch: main replays them from its own
// queues (2-tick cosmetic delay); during a rollback re-sim only the deferred cosmetic
// kinds re-queue -- the same rule as game.js drainSimEvents under _replaying.
self.drainSimEvents = () => {
    for(const e of simEvents){
        if(_replaying && !(e.t==='sfx'||e.t==='bonus'||e.t==='fw'||e.t==='crush')) continue;
        _dcEvents.push({ tk: simTick, e });
    }
    simEvents.length = 0;
};
// Note the deepest rewind per post so main can cancel already-queued cosmetics past it.
const _dcRbOrig = _rbRollback;
self._rbRollback = function(toTick){
    const r = _dcRbOrig(toTick);
    if(r && (!_dcRewTo || toTick < _dcRewTo)) _dcRewTo = toTick;
    return r;
};
// Online, the arming stage's real transitions go through the input path (wire + log);
// local 1:1 / classic keep the default straight-to-sim issue.
const _armIssueSim = simArmIssue;
self.simArmIssue = (p, kind, d) => { if (_dcOn) netLocalInput(kind, 0, d, true); else _armIssueSim(p, kind, d); };
// Phase is SET, only when the shared grid moves (duel start, and a re-anchor via
// duelClock). Seed the accumulator so ticks fire mid-window on the grid. NOT polled:
// e = ft - simTick - 0.5 sweeps a full unit every tick period, so a continuous detector
// fires every tick as normal operation -- the grid only actually moves on an anchor change.
function _dcSeedPhase(){
    if(_dcOfs == null || !_dcStartPts) return;
    const ft0 = (Date.now() + _dcOfs - _dcStartPts) / TICK_MS;
    _acc = Math.max(-TICK_MS, Math.min(TICK_MS, (ft0 - simTick - 0.5) * TICK_MS));
    _dcSnapN++; _dcSnapAt = performance.now();
}
// The shared-clock tick target (net.js netTickTarget's worker twin, same 600-tick
// origin sanity window). null = steer nowhere, free-run at 60Hz.
function _dcTarget(){
    if(!_dcOn || !_dcStartPts || _dcOfs == null) return null;
    const t = Math.floor((Date.now() + _dcOfs - _dcStartPts) / TICK_MS);
    return Math.abs(t - simTick) > 600 ? null : t;
}

let _timer = null, _last = 0, _acc = 0;

// Transport packing: cloning ~100 {x,y} objects at 60Hz dominated the sim thread's cost
// (the tick itself is sub-microsecond). The snake travels as one flat Int16Array (a
// single memcpy to clone); bars only change on level-begin/crush, so they are sent
// packed only then (null = "unchanged since the last post", main keeps its copy).
// game.js _unpackSnap() is the exact inverse -- keep the two in sync.
let _barsVSent = -1;
function _post() {
    const snap = simSnapshot();
    const s = snap.snake;
    if (s) {
        const sf = new Int16Array(s.length * 2);
        for (let i = 0; i < s.length; i++) { sf[i*2] = s[i].x; sf[i*2+1] = s[i].y; }
        snap.snake = sf;
    }
    if (Array.isArray(snap.bars)) {
        if (_barsV !== _barsVSent) {
            _barsVSent = _barsV;
            const b = snap.bars, bf = new Int16Array(b.length * 6);
            for (let i = 0; i < b.length; i++) {
                bf[i*6]   = b[i].x;                bf[i*6+1] = b[i].y;
                bf[i*6+2] = b[i].fragile ? 1 : 0;  bf[i*6+3] = b[i].paired ? 1 : 0;
                bf[i*6+4] = b[i].pairEnd ? b[i].pairEnd.x : -1;
                bf[i*6+5] = b[i].pairEnd ? b[i].pairEnd.y : -1;
            }
            snap.bars = bf;
        } else snap.bars = null;
    }
    const msg = { t: 'frame', snap, events: simEvents.splice(0) };
    if (_dcOn) {
        // Duel extras: tick-tagged events, the rewind marker, and the debug counters the
        // main-thread overlay shows. warnAgo travels as an AGE (worker and main have
        // different performance.now() origins).
        msg.duel = { ev: _dcEvents.splice(0), rew: _dcRewTo, rb: _rbDbg,
                     inRx: _netDbg.inRx, inTx: _netDbg.inTx, inLog: _netDbg.inLog, ptk: _netDbg.peerTkOfs,
                     warnAgo: performance.now() - _rbWarnAt, dsyFor: _rbBadSince ? Date.now() - _rbBadSince : 0,
                     psetN: _dcSnapN, psetAgo: _dcSnapAt ? performance.now() - _dcSnapAt : -1,
                     msg: _duelMsg };
        // ONE-SHOT: a duel message is an event, not a state. Clearing it after posting
        // stops a set-once worker message (e.g. DESYNC) from re-asserting every frame and
        // clobbering a main-authored message (RECONNECTING/RECONNECTED); main owns display duration.
        _duelMsg = '';
        _dcRewTo = 0;
    }
    postMessage(msg);
}

// Self-correcting fixed-timestep loop (workers have no requestAnimationFrame). We poll on a
// short interval and run whole ticks for the elapsed real time, so the sim keeps true 60 Hz
// regardless of interval jitter -- this is the whole point of moving it off the render thread.
function _step() {
    const now = performance.now();
    let dt = now - _last; _last = now;
    if (dt > 250) dt = 250;            // clamp a long stall (e.g. worker was throttled)
    _acc += dt;
    let ran = 0;
    while (_acc >= TICK_MS && ran < MAX_CATCHUP) { _acc -= TICK_MS; if (_dcOn) netTickPre(); update(); ran++; }
    if (ran >= MAX_CATCHUP) _acc = 0;
    if (_dcOn) {
        // Online duel: gross INTEGER tick lag (a stall, a catch-up truncation) is closed
        // by one extra tick per pass toward the shared-clock target. The sub-tick PHASE is
        // not steered here -- it is SET on an anchor change (_dcSeedPhase); polling it would
        // fire every tick, since the phase measure sweeps a full unit each tick period.
        const tgt = _dcTarget();
        const d = tgt === null ? 0 : tgt - simTick;
        if (tgt !== null && d > 1 && d <= 120 && ran < MAX_CATCHUP) { netTickPre(); update(); ran++; }
        if (simEvents.length) drainSimEvents();
    }
    // Post every tick during gameplay; menus/splash only pace cosmetic animation off
    // simNow, so 30 Hz halves the idle message churn with no visible cost. Any tick that
    // emitted events posts regardless -- events must never wait.
    const gameplay = phase!=='splash' && phase!=='menu' && phase!=='settings' && phase!=='scores'
                  && phase!=='achievements' && phase!=='shop' && phase!=='credits' && phase!=='news';
    if (ran > 0 && (gameplay || simEvents.length || simTick % 2 === 0)) _post();
}

function _run(on) {
    if (on) { if (_timer) return; _last = performance.now(); _acc = 0; _timer = setInterval(_step, 4); }
    else if (_timer) { clearInterval(_timer); _timer = null; }
}

// Command handling lives in sim.js (simCommand) so the sim effect is identical here and in
// the headless path. The worker only adds its tick-loop + snapshot-post wrapping.
onmessage = (e) => {
    const m = e.data;
    switch (m.t) {
        case 'cfg':      self.cfg = m.cfg; break;
        // ---- online duel (net.js on main forwards; duel-core here simulates) ----
        case 'duelStartNet':   // a (re)start: fresh seed/startPts, rollback state rebased
            _dcMy = m.my|0; _dcOfs = (m.ofs == null ? null : m.ofs); _dcStartPts = m.startPts || 0;
            _dcOn = true; self.inGame = true;
            simCommand({ t:'startDuel', seed:m.seed>>>0, x10:!!m.x10 });
            _rbReset();                                  // AFTER startDuel: it rewinds simTick, the base reads it
            _netDbg.inRx = 0; _netDbg.inTx = 0; _netDbg.inLog.length = 0;
            _dcEvents.length = 0; _dcRewTo = 0; _duelMsg = '';
            _last = performance.now(); _acc = 0; _dcSnapN = 0; _dcSnapAt = 0;
            _dcSeedPhase();   // the grid exists now: set the phase once (pset -> 1x)
            _post(); _run(true);
            break;
        case 'duelClock':      // main re-anchored (paired with a new start_pts where required)
            _dcOfs = m.ofs; if (m.startPts != null) _dcStartPts = m.startPts;
            _dcSeedPhase();    // the grid moved: re-set the phase to it (one pset event)
            break;
        case 'duelResync':     // transport asks the host to ship the full state (reconnect)
            if (_dcOn) _rbResyncSend = RB_RESYNC_BURST;
            break;
        case 'duelEndNet':
            _dcOn = false; self.inGame = false; _rbReset(); _dcEvents.length = 0; _dcRewTo = 0;
            break;
        case 'peerPkt': {      // a wire packet from the peer (pts-gated on main already)
            if (!_dcOn) break;
            const p = m.m;
            if (p.t === 'in'){ _netDbg.hbRx++; _netPeerInput(p); }
            else if (p.t === 'h')   _rbCheckHash(p);
            else if (p.t === 'st')  _rbCheckState(p);
            else if (p.t === 'rs')  _rbApplyResync(p);
            break;
        }
        case 'lin':            // local input: assign tick, apply, log, emit the wire record
            if (_dcOn) netLocalInput(m.k, 0, m.d, !!m.n);
            break;
        case 'run':      _run(m.on); break;
        case 'pause':    if (phase === 'playing' || phase === 'duel') { simCommand(m); _post(); _run(false); } break;   // freeze the clock so timers don't expire while paused
        case 'resume':   if (phase === 'paused' || phase === 'duelPaused') { simCommand(m); _run(true); } break;        // running loop will _post
        case 'start':
        case 'startDuel':
        case 'phase':
        case 'advance':  simCommand(m); _post(); break;   // one-shot state changes: post immediately
        default:         simCommand(m);                    // dir / boost / boostend: applied on the next tick's post
    }
};
