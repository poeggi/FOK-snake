// Shared two-client DUEL driver: one place that boots two full clients over a simulated
// wire (independent device clocks, one-way delay + jitter + loss + asymmetry + heavy-tail
// spikes), DRIVES a real match (autopilot toward gems -> level-ups, boost engage/brake,
// respawns), and DETECTS divergence continuously. Both the default-suite regression test
// (duel-desync.js) and the on-demand latency profiler (duel-profile.js) build on this, so
// the boost/level path is exercised by the same code the profiler measures.
//
// Divergence is read the honest way: each client keeps a rollback ring of PAST snapshots
// keyed by tick. A past tick (comfortably behind both sims) has had every input for it
// delivered and rolled back in, so its snapshot is settled -- comparing the two clients'
// ring hash AT THAT TICK is a true equality test, not the noisy live-hash lag that normal
// rollback produces. The first tick that disagrees, and which hashed field diverged, is the
// bug's fingerprint (e.g. `players` diverging the instant a local boost is dropped).
const { runInGame } = require('./harness');

// HOOKS: the profiler's clock/wire/tick surface (kept identical so the profiler can share
// this driver) PLUS the gameplay hooks a real match needs -- boost arm/brake, a view of the
// local snake+gem for the autopilot, and ring-snapshot hashes for continuous divergence.
const HOOKS = (id) => `
;(function(){
  localStorage.setItem('fok-snake-pid', ${JSON.stringify(id)});
  cfg.offline=false;
  globalThis.fetch = async ()=>({ status:0, json:async()=>null });
  _netPost = async ()=>null; _netGet = async ()=>null; _netTimeSync = async ()=>{};
  _netPollOnce = async ()=>{}; _netRelayLoop = async ()=>{};
  // NB: _netRequestStart is left REAL. The driver never reaches its server branch (first/rematch
  // boot via __p2pStart, not the server), but the p2pBoundary mode drives its 'level' branch --
  // the host-authored P2P start (_netStartLevelP2P) -- for real over the wire.
  // Mocked clocks (see duel-profile.js for the full rationale): performance.now is TRUE shared
  // time (frame domain); Date.now is this client's WALL clock, carrying a frozen anchor error
  // (__clkE0) + relative drift (__clkDr). Both default 0 (perfect sync).
  //
  // The lockstep timeline now reads the MONOTONIC clock (net.js _wall() = timeOrigin +
  // performance.now()), NOT Date.now(). So the model splits cleanly here:
  //   * timeOrigin carries the real inter-device anchor error (__clkE0) and NOTHING else --
  //     the standing offset the boundary burst must still measure and correct, and the lead
  //     that opens the one-sided rollback (duel-asym). It never moves after install.
  //   * Date.now keeps __clkE0 + drift, for the wall-only uses (silence/staleness timers).
  //     Its drift term is now INERT for the timeline -- which is exactly the fix: an OS wall
  //     adjustment (NTP slew) can no longer leak into the shared PTS. duel-drift.js asserts it.
  globalThis.__NET_BASE = 1784500000000;
  globalThis.__now = 0; globalThis.__clkE0 = 0; globalThis.__clkDr = 0;
  performance.now = ()=> __now;
  performance.timeOrigin = __NET_BASE + __clkE0;   // monotonic origin: wall captured ONCE, drift-free
  Date.now = ()=> __NET_BASE + __now + __clkE0 + __clkDr * __now;
  globalThis.__clkInstall = (e0, dr, startPts)=>{
    __clkE0 = e0; __clkDr = dr;
    performance.timeOrigin = __NET_BASE + e0;   // anchor error lives in the monotonic origin now
    simTick = 0; simNow = 0;
    if(_netSess) _netSess.startPts = startPts;
    _rbReset();
  };
  // Wall-only perturbations, for duel-drift.js. __clkStep bumps ONLY Date.now (via __clkE0), never
  // the monotonic origin -- an OS wall adjustment (NTP correction / foregrounding jump) the lockstep
  // timeline must ignore, since netPts rides _wall() = timeOrigin + performance.now(). __wallNow
  // exposes this client's raw wall clock so a test can confirm the step really landed.
  globalThis.__clkStep = (ms)=>{ __clkE0 += ms; };
  globalThis.__wallNow = ()=> Date.now();
  globalThis.__ivals = [];
  globalThis.setInterval = (fn, ms)=>{ __ivals.push({ fn, ms, next: __now + ms }); return __ivals.length; };
  globalThis.clearInterval = ()=>{};
  globalThis.setTimeout = (fn, ms)=>{ __ivals.push({ fn, ms:0, next: __now + ms, once:true }); return -1; };
  globalThis.__fire = ()=>{ for(const iv of __ivals){ if(iv.done) continue;
      while(__now >= iv.next){ iv.fn(); if(iv.once){ iv.done=true; break; } iv.next += iv.ms; } } };
  globalThis.__out = [];
  globalThis.__p2pStart = (seed, role)=>{
    _netSync = { ofs:0, rtt:1, at:Date.now() };
    simTick = role==='host' ? 45000 : 3000; simNow = simTick*TICK_MS; inGame = true;
    _netSess = _netMkSess('ffffffff', role);
    _netSess.seed = seed>>>0; _netSess.game = true; _netSess.pc = null;
    _netSess.dc = { readyState:'open', bufferedAmount:0, send(j){ __out.push(j); }, close(){} };
    _netMarkRecv(_netSess);
    _netLiveStart();
    startDuel(seed>>>0, false);
    _rbReset();
    _netSess.startPts = Date.now();
  };
  globalThis.__recv    = (txt)=>{ if(_netSess){ _netMarkRecv(_netSess); _netHandleMsg(txt); } };
  globalThis.__pts       = ()=> netPts();                      // this client's shared-timeline PTS right now
  // ---- boundary clock BURST hooks (symmetric midpoint: BOTH sides measure + nudge half) ----
  globalThis.__burstReset = ()=> _netBurstReset(_netSess);     // open a fresh burst (forget last boundary's samples)
  globalThis.__burstPing  = ()=> _netBurstPing(_netSess);      // fire one stamped burst datagram
  globalThis.__burstTheta = ()=>{ const t = _netBurstTheta(_netSess); return t ? t.theta : null; };  // agreed peer offset (ms), or null if unusable
  globalThis.__burstApply = ()=> _netBurstApply(_netSess);     // nudge our clock half-way to the midpoint; returns applied ms
  globalThis.__bsFwd      = ()=> _netSess ? _netSess.bsFwd : Infinity;   // my measured min forward-delta
  globalThis.__bsRev      = ()=> _netSess ? _netSess.bsRev : Infinity;   // the peer's min forward-delta (piggybacked)
  globalThis.__tick1   = ()=>{ netTickPre(); update(); netTickPost(); };   // exactly ONE engine tick, real path
  globalThis.__tickCatchup = ()=>{
    const t = netTickTarget(); if(t === null) return;
    const d = t - simTick;
    if(d > 1 && d <= 120){ netTickPre(); update(); netTickPost(); }
  };
  // ---- gameplay hooks (what makes this a real match, not a dir-only zigzag) ----
  globalThis.__me      = ()=> netMyIndex();
  globalThis.__steer   = (d)=>{ gameSteer(0, d); };              // author a turn for MY snake
  globalThis.__boost   = (d, now)=>{ gameBoostStart(0, d, !!now); };  // ARM boost (simArmTick issues the real bs)
  globalThis.__boostEnd= ()=>{ gameBoostEnd(0); };              // ARM release -> real be
  // Level-up: replay the RECEIVE end of the real online boundary (net.js: adopt epoch +
  // start_pts, then beginOnlineDuelLevel -> startDuelLevel -> _rbReset). The server POST /
  // rst relay is transport, not sim, so the driver supplies the shared start_pts + epoch
  // both sides agree on; the SIM side (simTick->0, _gAt->0, ring reset) is the REAL code.
  globalThis.__levelUp = (startPts, epoch)=>{
    if(!_netSess) return;
    _netSync = { ofs:0, rtt:1, at:Date.now() };   // a fresh sync always precedes a new start (re-anchor)
    _netSess.epoch = epoch|0; _netSess.startPts = startPts;
    beginOnlineDuelLevel(_netSess.role === 'host');
  };
  // REAL P2P boundary (p2pBoundary mode): this client "presses OK". Host -> authors the next
  // start PTS locally and ships 'rst' over the wire; joiner -> nudges the host with 'reqlvl'. The
  // start crosses the simulated wire (loss/jitter/doze), the joiner aligns its clock in the rst
  // handler, and both fast-forward to tick 0 -- the exact path that flashed CONNECTION LOST live.
  globalThis.__reqNextLevel = ()=> netRequestNextLevel();
  globalThis.__lvlPending   = ()=> !!(_netSess && _netSess.lvlPending);
  // REAL rematch RECEIVE path. A rematch is host-authored (only the host runs _netRequestStart for
  // it; the joiner just receives the rst). This hook is the SEND end the mocked server would drive:
  // the host runs the boundary BURST (bsync + bilateral 'bs' over the wire), nudges its own clock
  // onto the shared midpoint, authors the start_pts on that clock and ships 'rst' lvl:0 with the
  // agreed peer offset as 'bth'. The joiner receives it through the REAL _netHandleMsg and applies
  // its half from bth -- so whether a lvl:0 start midpoint-syncs the joiner's clock (it must, or an
  // offset carries uncorrected into the new match) is the real code.
  globalThis.__rematchHost = (epoch, seed)=>{
    const s = _netSess; if(!s || s.role !== 'host' || !s.game) return;
    s.epoch = epoch|0; s.seed = seed>>>0; s.lvlPending = true;
    _netBurstThenStart(s, (theta)=>{
      if(_netSess !== s || !s.game){ s.lvlPending = false; return; }
      const sp = netPts() + 250;   // author on the now-midpoint clock (production uses NET_BURST_LEAD_MS)
      s.startPts = sp; _netClockPush();
      _netSend({ t:'rst', seed:s.seed, startPts:sp, epoch:s.epoch, lvl:0, bth:Math.round(theta) });
      const go = ()=>{ if(_netSess === s && s.game){ s.lvlPending = false; beginOnlineDuel(s.seed, true); } };
      const wait = Math.max(0, Math.min(5000, sp - netPts()));
      if(wait <= 0) go(); else setTimeout(go, wait);
    });
  };
  // Falsification knob: neuter the boundary clock-burst nudge on BOTH sides so a test can PROVE it
  // is load-bearing (RED without it, GREEN with it) rather than merely tolerating a small offset.
  // With the nudge gone, a drifting clock is never corrected and the two sims diverge.
  globalThis.__disableBurst = ()=>{ _netBurstApply = ()=>0; };
  // The local player's world (+ the opponent), for the Node-side autopilot. Torus-relative.
  globalThis.__view    = ()=>{
    if(!players) return null;
    const mi = netMyIndex(), P = players[mi], O = players[1-mi]; if(!P) return null;
    return { mi, phase, level, gemsDone, cols:COLS, rows:ROWS,
             hx:P.snake[0].x, hy:P.snake[0].y, dx:P.dir.x, dy:P.dir.y,
             alive:!!P.alive, boosting:!!P.boosting, len:P.snake.length,
             body:P.snake.map(c=>({x:c.x,y:c.y})),
             ox:(O&&O.snake[0])?O.snake[0].x:-1, oy:(O&&O.snake[0])?O.snake[0].y:-1,
             odx:O?O.dir.x:0, ody:O?O.dir.y:0, oalive:!!(O&&O.alive),
             obody:O?O.snake.map(c=>({x:c.x,y:c.y})):[],
             gemx: gem?gem.x:-1, gemy: gem?gem.y:-1,
             waiting: phase === 'levelDone' && !!levelDoneWaiting };
  };
  // ---- divergence surface ----
  globalThis.__alive   = ()=> !!_netSess;
  globalThis.__warn    = ()=> netDuelWarn();   // the exact in-game banner a player sees (null = none)
  globalThis.__silent  = ()=> _netSess ? Date.now() - _netSess.lastRecvWall : 0;   // wall-clock ms since our last inbound packet
  globalThis.__live    = ()=>{ _netLiveCheck(); };   // run ONE real liveness pass (kill/reconnect/keepalive) -- the driver pumps it at 250ms like production
  globalThis.__phase   = ()=> phase;
  globalThis.__hashNow = ()=> _rbHash(simSnapshot());
  globalThis.__simTick = ()=> simTick;
  globalThis.__rbBase  = ()=> _rbBase;
  globalThis.__rbDepth = ()=> RB_DEPTH;   // immutability horizon: a tick this far back can no longer be rewritten by any accepted input
  globalThis.__rbDbg   = ()=> Object.assign({}, _rbDbg);
  globalThis.__netDbg  = ()=> Object.assign({}, _netDbg);
  globalThis.__badSince= ()=> _rbBadSince;                      // 0 = healthy; else wall clock of the first unhealed mismatch
  globalThis.__setBad  = (age)=>{ _rbBadSince = age > 0 ? Date.now() - age : 0; };   // force an unhealed-divergence age (ms), or 0 to heal, for the OUT OF SYNC banner test
  // Ring-snapshot hashes at a PAST tick: the settled-history equality test the continuous
  // detector uses. The ring is thinned to even ticks (RB_SNAP_EVERY), so pass an even tk.
  globalThis.__ringTicks   = ()=> _rbRing.map(e=>e.tk);
  globalThis.__ringHashAt  = (tk)=>{ for(let i=_rbRing.length-1;i>=0;i--) if(_rbRing[i].tk===tk) return _rbHash(_rbRing[i].snap); return null; };
  globalThis.__ringFieldsAt= (tk)=>{ for(let i=_rbRing.length-1;i>=0;i--) if(_rbRing[i].tk===tk) return _rbHashFields(_rbRing[i].snap); return null; };
  globalThis.__ringSnapAt  = (tk)=>{ for(let i=_rbRing.length-1;i>=0;i--) if(_rbRing[i].tk===tk) return JSON.parse(JSON.stringify(_rbRing[i].snap)); return null; };
  // The input log for a tick range: what commands each client will replay for those ticks.
  // Both clients MUST hold an identical log (lockstep), so a diff here localises a lost/misfiled input.
  globalThis.__logRange = (lo, hi)=>{ const o=[]; for(let t=lo;t<=hi;t++){ const c=_rbLog.get(t); if(c&&c.length) o.push([t, c.map(x=>x.t+(x.p!=null?'/p'+x.p:'')+(x.dir?'('+x.dir.x+','+x.dir.y+')':'')+(x.now?'!':''))]); } return o; };
  // Capture the product's own signal log so the driver can classify each DESYNC verdict
  // ('! DESYNC @<tk> <fields>') against the settled ring-agreement history (stale vs real).
  // Bare-name assignment (not globalThis.): matches how the product calls _netSigLog.
  globalThis.__sig = [];
  { const _oS = _netSigLog; _netSigLog = (s)=>{ globalThis.__sig.push(s); return _oS(s); }; }
  globalThis.__sigDump = ()=> globalThis.__sig.slice();
  // Rollback trace: every _rbRollback with the context to EXPLAIN why it fired -- target tick,
  // current sim tick (how late the input was = sim-to), the logged command(s) at the target,
  // and the level/epoch/phase/accrual state. Used to prove a rollback under sub-tick,
  // schedule-locked conditions is a real bug (headroom leak), never tolerated as noise.
  globalThis.__rbTrace = [];
  { const _oRB = _rbRollback; _rbRollback = (toTick)=>{
      const at = _rbLog.get(toTick);
      globalThis.__rbTrace.push({ to:toTick, sim:simTick, late:(simTick - toTick),
        lvl:level, ph:phase, ep:(_netSess ? _netSess.epoch : -1), gAt:_gAt, base:_rbBase, now:__now,
        cmds:(at ? at.map(c=> c.t + (c.p!=null ? '/p'+c.p : '') + (c._live ? '*' : '')) : []) });
      return _oRB(toTick); } }
  globalThis.__rbTraceDump = ()=> globalThis.__rbTrace.slice();
  globalThis.__TICK    = TICK_MS;
})();`;

const NET_BASE = 1784500000000;

// The one-time min-RTT anchor a client freezes before a duel (see duel-profile.js). Over a
// jittery/asymmetric wire the (dBA-dAB)/2 residual is the peer's standing pts-delta bias.
function anchor(prof, rnd){
    const N = (prof.clock && prof.clock.samples) || 8;
    const half = prof.base, jit = prof.jit, asym = prof.asym || 0;
    let best = Infinity, e0 = 0;
    for(let i = 0; i < N; i++){
        const dAB = half + asym/2 + (rnd()*2 - 1) * jit;
        const dBA = half - asym/2 + (rnd()*2 - 1) * jit;
        if(dAB + dBA < best){ best = dAB + dBA; e0 = (dBA - dAB) / 2; }
    }
    return e0 + ((prof.clock && prof.clock.err0) || 0);
}

function mk(id, seed, role){ const c = runInGame(HOOKS(id)); c.__p2pStart(seed, role); return c; }

// ---- torus geometry (shared by the autopilot) ----
function torusDelta(a, b, n){ let d = b - a; if(d > n/2) d -= n; if(d < -n/2) d += n; return d; }
function torusDist(ax, ay, bx, by, cols, rows){ return Math.max(Math.abs(torusDelta(ax, bx, cols)), Math.abs(torusDelta(ay, by, rows))); }
const eq = (u, v)=> u.x === v.x && u.y === v.y;
const rev = (u, v)=> u.x === -v.x && u.y === -v.y;

// Default DIRECTOR: an OPPONENT-AWARE autopilot that keeps BOTH snakes busy across many
// levels. Two greedy snakes racing the same shared gem collide head-on and burn all three
// lives in level 1, so the roles split by distance to the gem: the nearer snake commits to
// the gem (EATER), the other ROVES a perimeter circuit (ROVER) -- looping corner to corner,
// turning at each and boosting the long edges. Both sides therefore emit a steady stream of
// turns and boost transitions right next to peer packets (the concurrency the netcode bugs
// lived in), with the straight edges as the natural quiet phases -- dense, never sparse. Each
// steers onto its target closing the larger torus axis first, boosts on straightaways and
// brakes into turns (the real bs/be path), and dodges its own body, the opponent's body, and
// the opponent's predicted next cell.
//  - EATER = smaller torus distance to the gem (ties -> index 0); the role alternates as gems
//    respawn, so both snakes get gem chases over a match.
//  - ROVER = the other snake loops the four corners, advancing to the next once it reaches one.
const _rover = {};   // per-snake circuit progress (index -> corner); input-gen aid only, never touches the sim
function autopilot(view){
    if(!view || view.phase !== 'duel' || !view.alive) return {};
    if(view.gemx < 0) return {};
    const cur = { x:view.dx, y:view.dy };
    const myD = torusDist(view.hx, view.hy, view.gemx, view.gemy, view.cols, view.rows);
    const opD = view.oalive ? torusDist(view.ox, view.oy, view.gemx, view.gemy, view.cols, view.rows) : Infinity;
    const iAmEater = myD < opD || (myD === opD && view.mi === 0);
    let tx, ty;
    if(iAmEater){ tx = view.gemx; ty = view.gemy; }
    else {
        // Perimeter circuit: head to the current corner, advance to the next once reached.
        // Per-snake progress is keyed by index and lives only here -- it feeds input selection,
        // never the sim, so it cannot affect lockstep (inputs are still logged and replayed
        // identically on both clients).
        const TOUR = [[3, 3], [view.cols - 4, 3], [view.cols - 4, view.rows - 4], [3, view.rows - 4]];
        let ci = _rover[view.mi] | 0;
        if(torusDist(view.hx, view.hy, TOUR[ci][0], TOUR[ci][1], view.cols, view.rows) <= 2) ci = (ci + 1) % TOUR.length;
        _rover[view.mi] = ci;
        tx = TOUR[ci][0]; ty = TOUR[ci][1];
    }
    const ddx = torusDelta(view.hx, tx, view.cols);
    const ddy = torusDelta(view.hy, ty, view.rows);
    const cand = [];
    if(ddx !== 0) cand.push({ x:Math.sign(ddx), y:0, mag:Math.abs(ddx) });
    if(ddy !== 0) cand.push({ x:0, y:Math.sign(ddy), mag:Math.abs(ddy) });
    cand.sort((a, b)=> b.mag - a.mag);
    const blocked = new Set(view.body.slice(0, -1).map(c=> c.x + ',' + c.y));   // tail tip moves, so it is safe
    if(view.oalive){
        for(const c of view.obody) blocked.add(c.x + ',' + c.y);
        blocked.add(((view.ox + view.odx + view.cols) % view.cols) + ',' + ((view.oy + view.ody + view.rows) % view.rows));  // predicted opp step: dodge head-on
    }
    const free = (s)=>{ const nx = (view.hx + s.x + view.cols) % view.cols, ny = (view.hy + s.y + view.rows) % view.rows; return !blocked.has(nx + ',' + ny); };
    let want = null;
    for(const c of cand){ if(!rev(c, cur) && free(c)){ want = c; break; } }        // best productive, safe turn
    if(!want && free(cur)) want = cur;                                             // else straight if safe
    if(!want){ for(const s of [{x:cur.y,y:-cur.x},{x:-cur.y,y:cur.x}]) if(free(s)){ want = s; break; } }  // else any safe perpendicular
    if(!want) want = cur;
    const turning = !eq(want, cur);
    const out = {};
    if(turning){
        if(view.boosting) out.boost = 'end';   // brake before the turn
        out.steer = { x:want.x, y:want.y };
    } else if(!view.boosting && want.mag >= 2){
        out.boost = { x:want.x, y:want.y }; out.now = true;   // straightaway: engage fast
    }
    return out;
}

// DEATH-forcing director: both snakes make a beeline for board center, so they meet head-on
// (or ram a body) and DIE -- the respawn path the autopilot deliberately dodges. Over a lossy
// wire the peer's collision-deciding steer often arrives late, so a client mispredicts survival,
// advances (even respawns), then a rollback across the death boundary corrects it -- the exact
// condition bug C (own snake yanked back to its death cell after respawn) lives in. Deterministic
// (a pure function of the view: no state, no rng), so both clients log/replay identical inputs.
function collider(view){
    if(!view || view.phase !== 'duel' || !view.alive) return {};
    const cx = Math.floor(view.cols/2), cy = Math.floor(view.rows/2);
    const ddx = torusDelta(view.hx, cx, view.cols), ddy = torusDelta(view.hy, cy, view.rows);
    const cur = { x:view.dx, y:view.dy };
    const cand = [];
    if(ddx !== 0) cand.push({ x:Math.sign(ddx), y:0, mag:Math.abs(ddx) });
    if(ddy !== 0) cand.push({ x:0, y:Math.sign(ddy), mag:Math.abs(ddy) });
    cand.sort((a, b)=> b.mag - a.mag);
    for(const c of cand){
        if(rev(c, cur)) continue;                       // never author a reverse (the sim would drop it anyway)
        if(c.x !== cur.x || c.y !== cur.y) return { steer:{ x:c.x, y:c.y } };
        return {};                                      // already heading the productive way: hold
    }
    return {};
}

function applyDirective(C, out){
    if(!out) return;
    if(out.boost === 'end') C.__boostEnd();
    else if(out.boost) C.__boost(out.boost, out.now);
    if(out.steer) C.__steer(out.steer);
}

// Run one duel to `secs` simulated seconds and return a rich divergence report.
//   opts.wire  : { base, jit, loss, asym, spike:{p,ms} }   one-way ms / drop / imbalance / heavy tail
//   opts.phase : B's sub-tick schedule offset vs A (ms)     -- the rAF phase gap
//   opts.tjit  : per-tick schedule jitter on both clients   -- makes the gap wobble
//   opts.clock : { drift, err0, samples } | null            -- independent device clocks
//   opts.clockLeadsFire : with a fixed offset (bursts off), err0 also leads B's fire schedule (bPhase)
//   opts.director : (view)=>directive  (defaults to autopilot)
function runMatch(opts){
    const secs = opts.secs || 20, W = opts.wire || {};
    const seed = (opts.seed >>> 0) || 0xD0E1;
    const dir = opts.director || autopilot;
    _rover[0] = 0; _rover[1] = 0;   // fresh circuit each match, so scenarios do not inherit progress
    const A = mk('aaaaaaaa', seed, 'host'), B = mk('bbbbbbbb', seed, 'peer');
    if(opts.noBurst){ A.__disableBurst(); B.__disableBurst(); }   // falsification control (see __disableBurst)
    const TICK = A.__TICK;
    const wire = { AB:[], BA:[] };
    let rndS = (opts.rndSeed || 0x51ED) >>> 0;
    const rnd = ()=> (rndS = (rndS * 1103515245 + 12345) >>> 0) / 4294967296;
    const CK = opts.clock || null;
    // Integer-lag catch-up (sim-worker._step:161-163): a real online-duel client closes gross
    // whole-tick lag from "a stall, a catch-up truncation" by running ONE extra tick per pass
    // toward the shared-clock target, EVERY _dcOn step -- independent of clock drift. The driver
    // gated this behind CK (drifting clocks), which is the only place the general suites ever
    // produce integer lag. A one-sided suspend produces integer lag WITHOUT drift: after a resync
    // re-anchors the frozen side to the sender's ring tick (a tick or two behind the live frontier),
    // this same per-step catch-up closes the final residual. opts.catchup opts a drift-free suite
    // into that faithful modelling; it is a NO-OP whenever the sim already tracks the target (d<=1).
    const CATCHUP = !!(CK || opts.catchup);
    const e0 = CK ? anchor({ base:W.base, jit:W.jit, asym:W.asym, clock:CK }, rnd) : 0;
    const dr = CK ? (CK.drift || 0) * 1e-6 : 0;
    if(CK){ A.__clkInstall(0, 0, NET_BASE); B.__clkInstall(e0, dr, NET_BASE); }
    const FRAME_BUSY = opts.busy || 5, RESIM_MS = 0.6;
    // A clock offset is not only a netPts/target shift. In the real loop _fbSeedPhase (game.js) seeds
    // each client's fixed-timestep tick phase from its OWN wall clock, so a client whose clock sits
    // e0 ms AHEAD also FIRES its tick ~e0 ms earlier -- opening a real simTick lead, which is the
    // source of the one-sided rollback the offset causes. The general suites keep this DECOUPLED (the
    // clock moves only the target) because their bursts re-sync the clock and would also re-seed that
    // fire phase; modelling that correction dynamically is out of scope here. A test that holds a
    // FIXED offset (bursts off) opts into the faithful static coupling with opts.clockLeadsFire, so
    // err0 ALONE drives both the target lead and the fire lead -- no separate phase to keep in step.
    // See test/duel-asym.js. `opts.phase` remains the SEPARATE rAF sub-tick gap.
    const bLead = (CK && opts.clockLeadsFire) ? e0 : 0;
    const bPhase = (opts.phase || 0) - bLead;
    const sch = {
        A:{ c:A, dir:'AB', me:'A', pe:'B', k:0, next:0,      phase:0,      busyUntil:0 },
        B:{ c:B, dir:'BA', me:'B', pe:'A', k:0, next:bPhase, phase:bPhase, busyUntil:0 },
    };
    // Continuous divergence: compare each client's ring snapshot at a settled PAST tick.
    let firstDiverge = null, maxLocalJump = 0, localJumps = 0;
    const localJumpsBy = { A:0, B:0 };   // per-side: a frozen client legitimately snaps its own head ONCE on catch-up; a LIVE client must never
    const lastHead = { A:null, B:null };
    let levelReached = 1, exitReason = null;
    // Compare only an IMMUTABLE tick: an accepted input reaches at most RB_DEPTH ticks back, so a
    // tick that ran RB_DEPTH ago can no longer be rewritten by any late arrival -- a mismatch there
    // is a genuine, unhealed divergence, never the normal in-window rollback lag. A shallower lag
    // (e.g. 16) reads a tick still inside the rewrite window and false-positives when a lossy wire
    // redelivers an input dozens of ticks late (the same stale-read the product's own detector
    // avoids by freezing its 1Hz hash at RB_HASH_LAG). The product guarantees this tick is in-ring.
    const DIVERGE_LAG = opts.settleLag || A.__rbDepth();
    const checkDiverge = ()=>{
        const st = Math.min(A.__simTick(), B.__simTick()) - DIVERGE_LAG;
        const tk = st - (st & 1);   // even tick (ring is thinned to RB_SNAP_EVERY=2)
        if(tk < 2) return;
        const ha = A.__ringHashAt(tk), hb = B.__ringHashAt(tk);
        if(ha == null || hb == null || ha === hb) return;
        if(firstDiverge) return;
        const fa = A.__ringFieldsAt(tk) || {}, fb = B.__ringFieldsAt(tk) || {};
        const fields = Object.keys(fa).filter(k => fa[k] !== fb[k]);
        firstDiverge = { tick: tk, fields };
        if(opts.capture){
            firstDiverge.snaps = { a: A.__ringSnapAt(tk), b: B.__ringSnapAt(tk) };
            firstDiverge.logs = { a: A.__logRange(tk - 24, tk + 2), b: B.__logRange(tk - 24, tk + 2) };
        }
    };
    // Desync attribution: the instant either client's product desync counter ticks up, read
    // the disputed tick it just logged and compare the two clients' LIVE ring hash there. If
    // they AGREE, the verdict was false -- the peer's 1Hz hash was frozen before a rollback
    // rewrote its ring entry (stale), not a real divergence. `stale` counts those.
    // Ring-agreement history: for each settled even tick, record ONCE whether A's and B's
    // ring snapshots agree. Sampled a few ticks behind both sims so it is settled but still
    // in-ring on both. A product desync for tick T is then FALSE (stale frozen peer hash) if
    // the two rings actually agreed at T, REAL if they disagreed.
    const ringAgree = new Map();
    const sampleRingAgree = ()=>{
        const top = Math.min(A.__simTick(), B.__simTick()) - 4;
        // Backfill every settled even tick still in-ring on both sides (min ring reach ~= 2*RB_RING).
        for(let tk = top - (top & 1); tk >= top - 60 && tk >= 2; tk -= 2){
            if(ringAgree.has(tk)) continue;
            const ha = A.__ringHashAt(tk), hb = B.__ringHashAt(tk);
            if(ha == null || hb == null) continue;
            ringAgree.set(tk, ha === hb);
        }
    };
    // A visible LOCAL jump: my own head moved more than one torus cell in a tick -- i.e. a
    // rollback/resync teleported me (the "I see myself jump" symptom), never normal movement.
    // The own snake is a pure function of MY OWN logged inputs, so the ONE legitimate own-head
    // teleport is a rebuild onto the fixed spawn cell (a respawn after a death, or a level-up).
    // Any other >1 jump -- crucially a jump BACK onto a death cell after I had already respawned
    // (bug C: a resync/rollback resurrecting my own dead snake) -- is the artifact. Measured
    // across ALL phases (not just 'duel'), so the death->'dying'->respawn window is covered: the
    // old metric nulled the baseline off 'duel' and was blind to exactly the death-boundary snap.
    const spawnHead = (v)=> v.mi === 0
        ? { x:6, y:Math.floor(v.rows/2) - 4 }              // P0 spawn head (js/sim.js _mkDuelPlayer)
        : { x:v.cols - 7, y:Math.floor(v.rows/2) + 4 };    // P1 spawn head (mirror)
    const noteHead = (S, v)=>{
        if(!v) return;   // no sim view: keep the last head (do NOT null -- a null gap would hide a respawn-boundary snap)
        const prev = lastHead[S.me];
        if(prev){
            const dx = Math.abs(torusDelta(prev.x, v.hx, v.cols)), dy = Math.abs(torusDelta(prev.y, v.hy, v.rows));
            const jump = Math.max(dx, dy);
            if(jump > 1){
                const sp = spawnHead(v);
                const isRespawn = v.hx === sp.x && v.hy === sp.y;   // the sole legit own-head teleport
                if(!isRespawn){ localJumps++; localJumpsBy[S.me]++; maxLocalJump = Math.max(maxLocalJump, jump); }
            }
        }
        lastHead[S.me] = { x:v.hx, y:v.hy };
    };
    const fireOnce = (S)=>{
        S.c.__now = 0 | S.next;
        const v = S.c.__view();
        if(v){ levelReached = Math.max(levelReached, v.level); applyDirective(S.c, dir(v)); }
        const r0 = opts.recv ? S.c.__rbDbg().resim : 0;
        S.c.__tick1();
        if(CATCHUP) S.c.__tickCatchup();
        if(opts.recv) S.busyUntil = (0 | S.next) + FRAME_BUSY + (S.c.__rbDbg().resim - r0) * RESIM_MS;
        noteHead(S, S.c.__view());
        S.k++;
        S.next = S.k * TICK + S.phase + (opts.tjit ? (rnd()*2 - 1) * opts.tjit : 0);
    };
    const emit = (S)=>{
        const out = S.c.__out.splice(0);   // always drain the buffer, even when the link is down
        if(wireDown) return;               // ...but a dead wire carries nothing: authored packets are lost
        for(const txt of out){
            let cls = '?'; try{ cls = (JSON.parse(txt).t) || '?'; }catch(e){}
            if(cls === 'pi') continue;
            if(rnd() < (W.loss || 0)) continue;
            const asym = (W.asym || 0) * (S.dir === 'AB' ? 0.5 : -0.5);
            let d = Math.max(1, (W.base || 3) + asym + (rnd()*2 - 1) * (W.jit || 0));
            if(W.spike && rnd() < W.spike.p) d += W.spike.ms;
            wire[S.dir].push([S.c.__now + d, txt]);
        }
    };
    const drain = (q, C, R)=>{ if(wireDown) return;   // nothing is delivered while the link is down
        for(let j = 0; j < q.length; j++){
        const ready = q[j][0] <= C.__now && (!opts.recv || C.__now >= R.busyUntil);
        if(ready){ C.__recv(q[j][1]); q.splice(j--, 1); }
    } };
    const over = (C)=> C.__phase() === 'duelOver';
    // _rbReset (fired by every level-up's beginOnlineDuelLevel) ZEROES _rbDbg, so the raw
    // per-client counters only ever reflect the CURRENT level. Snapshot + accumulate them
    // across each boundary so rb/resim/live/lost/fix/desync are true match totals (and the
    // fail gate cannot miss a desync that a level-up reset away).
    const DBG_KEYS = ['rb', 'resim', 'live', 'lost', 'fix', 'desync', 'drop'];
    const acc = { A:{}, B:{} }; for(const k of DBG_KEYS){ acc.A[k] = 0; acc.B[k] = 0; }
    const bank = (S, dbg)=>{ for(const k of DBG_KEYS) acc[S][k] += (dbg[k] | 0); };
    // Level-up: when BOTH clients are parked at levelDone/waiting, replay the real online
    // boundary (shared start_pts + bumped epoch -> beginOnlineDuelLevel on both). The wire
    // keeps flowing across it, so any pre-boundary 'in' packet still in flight arrives after
    // simTick has reset to 0 -- the exact stale-epoch condition F2 has to survive.
    let levelEpoch = 1, levelUps = 0, lastBoundaryLevel = 0;
    const maybeLevelUp = (now)=>{
        const va = A.__view(), vb = B.__view();
        if(!(va && vb && va.waiting && vb.waiting)) return;
        if(opts.p2pBoundary){
            // Both parked at levelDone -> drive the REAL boundary over the wire. No injected
            // start_pts: the initiator's client authors/relays it (host rst; joiner reqlvl->host
            // rst) and the joiner aligns its clock in the rst handler, so a lost rst / clock drift
            // / doze is exercised for real -- the atomic __levelUp path could never reproduce it.
            if(va.level === lastBoundaryLevel) return;   // this boundary already fired; wait for it to land
            lastBoundaryLevel = va.level;
            bank('A', A.__rbDbg()); bank('B', B.__rbDbg());
            (opts.initJoiner ? B : A).__reqNextLevel();
            levelUps++;
            return;
        }
        bank('A', A.__rbDbg()); bank('B', B.__rbDbg());   // capture this level's tallies before _rbReset wipes them
        const sp = NET_BASE + now + 40, ep = ++levelEpoch;
        A.__levelUp(sp, ep); B.__levelUp(sp, ep); levelUps++;
    };
    // Optional REMATCH (game restart) at `at` seconds: the SERVER-issued start path (rst lvl:0),
    // the one a level boundary's pure-P2P align does NOT cover. The host authors a fresh start_pts
    // + epoch + seed and ships 'rst' lvl:0 over the wire; the joiner receives it through the real
    // handler -- so whether a lvl:0 start P2P-aligns the joiner's clock is the real code. Fired
    // while both sims are mid-play, so the joiner's align window holds the samples the ongoing
    // match kept warm -- the realistic field condition (the window is consumed only at a start, so
    // it still carries the last level's samples when a match ends). opts.rematch = { at }.
    const rematch = opts.rematch || null;
    const rematchAt = rematch ? Math.round(rematch.at * 1000) : -1;
    let rematchDone = false;
    // Optional DOZE: freeze one client (default the joiner 'B') for `ms`, modelling an iOS
    // WiFi power-save / backgrounded-tab stall. While dozing the client does not tick, send,
    // or receive. On resume it does NOT burst-replay every missed tick -- it drops the backlog
    // exactly as sim-worker._step does (clamped dt -> MAX_CATCHUP -> _acc=0) and catches up one
    // tick per pass via __tickCatchup. So it genuinely falls behind, the peer's inputs for the
    // frozen span age out of its ring, and the host's aged-out-divergence path owes it a FULL
    // resync (duel-core.js:425) that lands on the joiner's HARD-APPLY branch (:381) -- the only
    // path that can leave the own snake yanked to a stale (death) cell. opts.doze = { at, ms, who }.
    const doze = opts.doze || null;
    const dozeWho = doze ? (doze.who || 'B') : null;
    const doze0 = doze ? Math.round(doze.at * 1000) : -1;
    const doze1 = doze ? doze0 + (doze.ms | 0) : -1;
    let dozeResumed = false;
    // Optional WIRE OUTAGE: a total bidirectional blackout for `ms` starting at `at` seconds,
    // modelling a connection interruption (a WiFi drop / a few lost seconds) where BOTH clients
    // keep running -- they tick, author inputs and send as normal, but nothing crosses the wire.
    // On restore the redundant input log + the periodic state/hash recovery must re-converge them
    // WITHOUT a session-end: the design goal is that a brief interruption is survived, not fatal.
    // Distinct from doze (which freezes one client's clock+sim): here neither side sleeps, only
    // the link is dead, so the silence-ladder / RB_PERSIST_KILL_MS deadline is what is on trial.
    // opts.outage = { at, ms }.
    const outage = opts.outage || null;
    const out0 = outage ? Math.round(outage.at * 1000) : -1;
    const out1 = outage ? out0 + (outage.ms | 0) : -1;
    // Optional one-off WALL STEP: at `at` seconds, jump one client's Date.now by `ms` (default the
    // joiner 'B', the phone). The monotonic origin is untouched, so on the fixed code the lockstep
    // timeline must not so much as flinch; duel-drift.js pairs this with a huge inert drift and
    // asserts the rollback counts are byte-identical to an unperturbed run. opts.wallStep={at,ms,who}.
    const wallStep = opts.wallStep || null;
    const wallStepAt = wallStep ? Math.round(wallStep.at * 1000) : -1;
    const wallStepWho = wallStep ? (wallStep.who || 'B') : null;
    let wallStepped = false;
    let sawConnLost = false, maxSilentMs = 0;
    const CL = 'CONNECTION LOST';
    let wireDown = false, nextLive = 0;
    let diedAt = 0;
    for(let now = 0; now <= secs * 1000; now++){
        const dozing = doze && now >= doze0 && now < doze1;
        wireDown = !!(outage && now >= out0 && now < out1);   // total bidirectional blackout window
        if(doze && !dozeResumed && now >= doze1){
            // Resume: skip the frozen span instead of bursting through it (worker _acc drop).
            dozeResumed = true;
            const S = sch[dozeWho];
            S.k = Math.round((now - S.phase) / TICK); S.next = S.k * TICK + S.phase;
        }
        if(wallStep && !wallStepped && now >= wallStepAt){
            wallStepped = true;
            (wallStepWho === 'A' ? A : B).__clkStep(wallStep.ms);
        }
        if(rematch && !rematchDone && now >= rematchAt){
            const va = A.__view(), vb = B.__view();
            if(va && vb){
                rematchDone = true;
                bank('A', A.__rbDbg()); bank('B', B.__rbDbg());   // pre-rematch tallies before _rbReset wipes them
                const ep = ++levelEpoch;    // the host bursts + authors the shared start_pts (server would, in the field)
                A.__rematchHost(ep, (seed ^ 0x9e3779b9) >>> 0);
                levelUps++;
            }
        }
        A.__now = now; B.__now = now;
        if(!(dozing && dozeWho === 'A')) A.__fire();
        if(!(dozing && dozeWho === 'B')) B.__fire();
        // Real liveness pass at production cadence (250ms): the same _netLiveCheck the browser runs
        // on setInterval -- it is what warns, reconnects, keeps-alive and KILLS on the deadline. A
        // dozing client's timers are frozen, so skip its pass while it sleeps.
        if(now >= nextLive){
            if(!(dozing && dozeWho === 'A')) A.__live();
            if(!(dozing && dozeWho === 'B')) B.__live();
            nextLive += 250;
        }
        if(!A.__alive() || !B.__alive()){ exitReason = 'session-end'; diedAt = now/1000; break; }
        if(over(A) || over(B)){ exitReason = 'duelOver'; diedAt = now/1000; break; }
        if(!(dozing && dozeWho === 'A')) while(now >= sch.A.next) fireOnce(sch.A);
        if(!(dozing && dozeWho === 'B')) while(now >= sch.B.next) fireOnce(sch.B);
        if(!(dozing && dozeWho === 'A')) emit(sch.A);
        if(!(dozing && dozeWho === 'B')) emit(sch.B);
        if(!(dozing && dozeWho === 'B')) drain(wire.AB, B, sch.B);
        if(!(dozing && dozeWho === 'A')) drain(wire.BA, A, sch.A);
        maybeLevelUp(now);
        checkDiverge();
        if(opts.desyncProbe) sampleRingAgree();
        // Banner + silence tracking: prove the outage actually surfaced CONNECTION LOST (the fault
        // was exercised, not skated past) and record the worst silence either side saw (must stay
        // under RB_PERSIST_KILL_MS for the match to be recoverable rather than killed).
        if(A.__warn() === CL || B.__warn() === CL) sawConnLost = true;
        maxSilentMs = Math.max(maxSilentMs, A.__silent(), B.__silent());
        if(opts.onSample) opts.onSample(now, A, B);   // diagnostic tap (null in the suite): watch recovery over time
    }
    // Settle: stop authoring, deliver everything in flight losslessly, tick both to a common
    // tick, then judge convergence (two independently-phased loops end up to a tick apart).
    // A session that already ENDED (the liveness kill fired) has no live sim to converge -- the
    // duel is torn down, so ticking it would crash; skip settle and report it as not-converged.
    const ended = exitReason === 'session-end';
    const settleNow = (diedAt ? diedAt * 1000 : secs * 1000) + 1;
    const pump = ()=>{ for(const [S, peer] of [[A, B], [B, A]]) for(const txt of S.__out.splice(0)){
        let t = '?'; try{ t = (JSON.parse(txt).t) || '?'; }catch(e){} if(t === 'pi') continue; peer.__recv(txt); } };
    if(!ended){
        A.__now = settleNow; B.__now = settleNow; pump();
        const target = Math.max(A.__simTick(), B.__simTick()) + 40;
        for(let g = 0; g < 400 && (A.__simTick() < target || B.__simTick() < target); g++){
            if(A.__simTick() < target) A.__tick1();
            if(B.__simTick() < target) B.__tick1();
            pump();
            checkDiverge();
            if(opts.desyncProbe) sampleRingAgree();
        }
    }
    // Classify every product DESYNC verdict (sniffed from each client's sig-log) against the
    // settled ring-agreement history: agreed => the verdict was FALSE (peer's frozen 1Hz hash
    // was stale), disagreed => a REAL divergence, no sample => couldn't tell.
    const classifyDesyncs = ()=>{
        const out = { total:0, stale:0, real:0, unknown:0, samples:[] };
        const scan = (sig, me)=>{ for(const s of sig){ if(typeof s !== 'string' || s.indexOf('! DESYNC @') !== 0) continue;
            const mm = s.match(/@(\d+)/); if(!mm) continue; const tk = +mm[1]; const et = tk - (tk & 1);
            out.total++;
            const ag = ringAgree.get(et);
            if(ag === undefined){ out.unknown++; if(out.samples.length < 10) out.samples.push(me + '@' + et + '?'); }
            else if(ag){ out.stale++; if(out.samples.length < 10) out.samples.push(me + '@' + et + '=stale'); }
            else { out.real++; if(out.samples.length < 10) out.samples.push(me + '@' + et + '=REAL'); }
        } };
        scan(A.__sigDump(), 'A'); scan(B.__sigDump(), 'B');
        return out;
    };
    const converged = !ended && A.__simTick() === B.__simTick() && A.__hashNow() === B.__hashNow();
    bank('A', A.__rbDbg()); bank('B', B.__rbDbg());   // fold the final (post-last-level) tallies in
    const a = acc.A, b = acc.B;
    return {
        converged, firstDiverge, exitReason, diedAt,
        sawConnLost, maxSilentMs, endWarn: A.__warn() || B.__warn() || null,
        levelReached, levelUps, localJumps, localJumpsA: localJumpsBy.A, localJumpsB: localJumpsBy.B, maxLocalJump, rematched: rematchDone,
        desyncA: a.desync, desyncB: b.desync,
        badA: A.__badSince() ? 1 : 0, badB: B.__badSince() ? 1 : 0,
        rb: a.rb + b.rb, rbA: a.rb, rbB: b.rb,
        resim: a.resim + b.resim, live: a.live + b.live, liveA: a.live, liveB: b.live, lost: a.lost + b.lost,
        fix: a.fix + b.fix, drop: a.drop + b.drop, dropA: a.drop, dropB: b.drop,
        desyncProbe: opts.desyncProbe ? classifyDesyncs() : null,
        rbTrace: { A: A.__rbTraceDump(), B: B.__rbTraceDump() },
    };
}

module.exports = { runInGame, HOOKS, mk, anchor, runMatch, autopilot, collider, torusDelta, NET_BASE };
