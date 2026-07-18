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
// Not wired into the game yet -- the main-thread mirror/input wiring is the final step.
// ============================================================================
importScripts('assets.js', 'sim.js');

// sim.js reads cfg.diff / cfg.turbo. Declare it on the worker global so those bare
// references resolve; the main thread sends the real config via {t:'cfg'} before starting.
self.cfg = { diff: 1, turbo: true };

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
    postMessage({ t: 'frame', snap, events: simEvents.splice(0) });
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
    while (_acc >= TICK_MS && ran < MAX_CATCHUP) { _acc -= TICK_MS; update(); ran++; }
    if (ran >= MAX_CATCHUP) _acc = 0;
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
