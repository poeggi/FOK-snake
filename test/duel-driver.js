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
  globalThis.__NET_BASE = 1784500000000;
  globalThis.__now = 0; globalThis.__clkE0 = 0; globalThis.__clkDr = 0;
  performance.now = ()=> __now;
  Date.now = ()=> __NET_BASE + __now + __clkE0 + __clkDr * __now;
  globalThis.__clkInstall = (e0, dr, startPts)=>{
    __clkE0 = e0; __clkDr = dr;
    simTick = 0; simNow = 0;
    if(_netSess) _netSess.startPts = startPts;
    _rbReset();
  };
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
  // ---- P2P clock alignment hooks (JOINER measures its offset onto the HOST's timeline) ----
  globalThis.__alignPing = ()=> _netAlignPing(_netSess);       // joiner: send one align ping
  globalThis.__alignApply= ()=> _netAlignApply(_netSess);      // joiner: step our anchor onto the host's clock (returns applied ms)
  globalThis.__alOfs     = ()=> _netSess ? _netSess.alOfs : null;   // current best theta (host lead, ms)
  globalThis.__alN       = ()=> _netSess ? _netSess.alN : 0;        // samples in the min-RTT window
  globalThis.__pts       = ()=> netPts();                      // this client's shared-timeline PTS right now
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
  // Falsification knob: neuter the boundary clock-alignment so a test can PROVE it is load-
  // bearing (RED without it, GREEN with it) rather than merely tolerating a small offset.
  globalThis.__disableAlign = ()=>{ _netAlignApply = ()=>0; _netAlignTick = ()=>{}; };
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
  globalThis.__phase   = ()=> phase;
  globalThis.__hashNow = ()=> _rbHash(simSnapshot());
  globalThis.__simTick = ()=> simTick;
  globalThis.__rbBase  = ()=> _rbBase;
  globalThis.__rbDepth = ()=> RB_DEPTH;   // immutability horizon: a tick this far back can no longer be rewritten by any accepted input
  globalThis.__rbDbg   = ()=> Object.assign({}, _rbDbg);
  globalThis.__netDbg  = ()=> Object.assign({}, _netDbg);
  globalThis.__badSince= ()=> _rbBadSince;                      // 0 = healthy; else wall clock of the first unhealed mismatch
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
//   opts.director : (view)=>directive  (defaults to autopilot)
function runMatch(opts){
    const secs = opts.secs || 20, W = opts.wire || {};
    const seed = (opts.seed >>> 0) || 0xD0E1;
    const dir = opts.director || autopilot;
    _rover[0] = 0; _rover[1] = 0;   // fresh circuit each match, so scenarios do not inherit progress
    const A = mk('aaaaaaaa', seed, 'host'), B = mk('bbbbbbbb', seed, 'peer');
    if(opts.noAlign){ A.__disableAlign(); B.__disableAlign(); }   // falsification control (see __disableAlign)
    const TICK = A.__TICK;
    const wire = { AB:[], BA:[] };
    let rndS = (opts.rndSeed || 0x51ED) >>> 0;
    const rnd = ()=> (rndS = (rndS * 1103515245 + 12345) >>> 0) / 4294967296;
    const CK = opts.clock || null;
    const e0 = CK ? anchor({ base:W.base, jit:W.jit, asym:W.asym, clock:CK }, rnd) : 0;
    const dr = CK ? (CK.drift || 0) * 1e-6 : 0;
    if(CK){ A.__clkInstall(0, 0, NET_BASE); B.__clkInstall(e0, dr, NET_BASE); }
    const FRAME_BUSY = opts.busy || 5, RESIM_MS = 0.6;
    const sch = {
        A:{ c:A, dir:'AB', me:'A', pe:'B', k:0, next:0,               phase:0,             busyUntil:0 },
        B:{ c:B, dir:'BA', me:'B', pe:'A', k:0, next:opts.phase || 0, phase:opts.phase || 0, busyUntil:0 },
    };
    // Continuous divergence: compare each client's ring snapshot at a settled PAST tick.
    let firstDiverge = null, maxLocalJump = 0, localJumps = 0;
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
    const noteHead = (S, v)=>{
        if(!v || v.phase !== 'duel'){ lastHead[S.me] = null; return; }
        const prev = lastHead[S.me];
        if(prev){
            const dx = Math.abs(torusDelta(prev.x, v.hx, v.cols)), dy = Math.abs(torusDelta(prev.y, v.hy, v.rows));
            const jump = Math.max(dx, dy);
            if(jump > 1){ localJumps++; maxLocalJump = Math.max(maxLocalJump, jump); }
        }
        lastHead[S.me] = { x:v.hx, y:v.hy };
    };
    const fireOnce = (S)=>{
        S.c.__now = 0 | S.next;
        const v = S.c.__view();
        if(v){ levelReached = Math.max(levelReached, v.level); applyDirective(S.c, dir(v)); }
        const r0 = opts.recv ? S.c.__rbDbg().resim : 0;
        S.c.__tick1();
        if(CK) S.c.__tickCatchup();
        if(opts.recv) S.busyUntil = (0 | S.next) + FRAME_BUSY + (S.c.__rbDbg().resim - r0) * RESIM_MS;
        noteHead(S, S.c.__view());
        S.k++;
        S.next = S.k * TICK + S.phase + (opts.tjit ? (rnd()*2 - 1) * opts.tjit : 0);
    };
    const emit = (S)=>{
        for(const txt of S.c.__out.splice(0)){
            let cls = '?'; try{ cls = (JSON.parse(txt).t) || '?'; }catch(e){}
            if(cls === 'pi') continue;
            if(rnd() < (W.loss || 0)) continue;
            const asym = (W.asym || 0) * (S.dir === 'AB' ? 0.5 : -0.5);
            let d = Math.max(1, (W.base || 3) + asym + (rnd()*2 - 1) * (W.jit || 0));
            if(W.spike && rnd() < W.spike.p) d += W.spike.ms;
            wire[S.dir].push([S.c.__now + d, txt]);
        }
    };
    const drain = (q, C, R)=>{ for(let j = 0; j < q.length; j++){
        const ready = q[j][0] <= C.__now && (!opts.recv || C.__now >= R.busyUntil);
        if(ready){ C.__recv(q[j][1]); q.splice(j--, 1); }
    } };
    const over = (C)=> C.__phase() === 'duelOver';
    // _rbReset (fired by every level-up's beginOnlineDuelLevel) ZEROES _rbDbg, so the raw
    // per-client counters only ever reflect the CURRENT level. Snapshot + accumulate them
    // across each boundary so rb/resim/live/lost/fix/desync are true match totals (and the
    // fail gate cannot miss a desync that a level-up reset away).
    const DBG_KEYS = ['rb', 'resim', 'live', 'lost', 'fix', 'desync'];
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
    let diedAt = 0;
    for(let now = 0; now <= secs * 1000; now++){
        A.__now = now; B.__now = now; A.__fire(); B.__fire();
        if(!A.__alive() || !B.__alive()){ exitReason = 'session-end'; diedAt = now/1000; break; }
        if(over(A) || over(B)){ exitReason = 'duelOver'; diedAt = now/1000; break; }
        while(now >= sch.A.next) fireOnce(sch.A);
        while(now >= sch.B.next) fireOnce(sch.B);
        emit(sch.A); emit(sch.B);
        drain(wire.AB, B, sch.B); drain(wire.BA, A, sch.A);
        maybeLevelUp(now);
        checkDiverge();
        if(opts.desyncProbe) sampleRingAgree();
    }
    // Settle: stop authoring, deliver everything in flight losslessly, tick both to a common
    // tick, then judge convergence (two independently-phased loops end up to a tick apart).
    const settleNow = (diedAt ? diedAt * 1000 : secs * 1000) + 1;
    const pump = ()=>{ for(const [S, peer] of [[A, B], [B, A]]) for(const txt of S.__out.splice(0)){
        let t = '?'; try{ t = (JSON.parse(txt).t) || '?'; }catch(e){} if(t === 'pi') continue; peer.__recv(txt); } };
    A.__now = settleNow; B.__now = settleNow; pump();
    const target = Math.max(A.__simTick(), B.__simTick()) + 40;
    for(let g = 0; g < 400 && (A.__simTick() < target || B.__simTick() < target); g++){
        if(A.__simTick() < target) A.__tick1();
        if(B.__simTick() < target) B.__tick1();
        pump();
        checkDiverge();
        if(opts.desyncProbe) sampleRingAgree();
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
    const converged = A.__simTick() === B.__simTick() && A.__hashNow() === B.__hashNow();
    bank('A', A.__rbDbg()); bank('B', B.__rbDbg());   // fold the final (post-last-level) tallies in
    const a = acc.A, b = acc.B;
    return {
        converged, firstDiverge, exitReason, diedAt,
        levelReached, levelUps, localJumps, maxLocalJump,
        desyncA: a.desync, desyncB: b.desync,
        badA: A.__badSince() ? 1 : 0, badB: B.__badSince() ? 1 : 0,
        rb: a.rb + b.rb, resim: a.resim + b.resim, live: a.live + b.live, lost: a.lost + b.lost,
        fix: a.fix + b.fix,
        desyncProbe: opts.desyncProbe ? classifyDesyncs() : null,
        rbTrace: { A: A.__rbTraceDump(), B: B.__rbTraceDump() },
    };
}

module.exports = { runInGame, HOOKS, mk, anchor, runMatch, autopilot, torusDelta, NET_BASE };
