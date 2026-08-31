// Two-client P2P DUEL profiler -- NOT part of the default check run.
//   node test/duel-profile.js        (or: bash test/checks.sh --netprofile)
// Runs two full clients through the REAL in-process netcode -- the same netTickPre /
// _netSend / _netHandleMsg / rollback path the P2P DataChannel uses -- over a SIMULATED
// wire (one-way delay + jitter). CRUCIALLY, the two clients do NOT tick in lockstep: each
// runs its sim on its OWN 60Hz frame schedule with an independent sub-tick PHASE (and
// optional per-tick jitter), exactly like two real requestAnimationFrame loops that the
// shared clock only STEERS, never phase-locks (see game.js: the accumulator ticks on the
// LOCAL frameMs; the clock corrects integer drift only). That phase is the whole point:
//
//   A remote dir is authored AT a game-step boundary and must arrive before the receiver
//   runs that step, or _rbPeerSteppedSince sees the head already moved and REWINDS. The
//   margin is only _gDue ticks (often 1-2), so even at LAN latency a fraction of a tick of
//   phase makes a fast input land late -> rollback. FAST zigzag input (a turn every few
//   ticks) is one rollback opportunity after another, which is why hard steering visibly
//   corrects the remote snake even on a 2ms link. A lockstep sim (phase 0) hides all of it.
//
// Reports, per link/phase/input-rate:
//   in/s     remote input records received per second (the input pressure)
//   rb/min   rollbacks per minute (each = a visible remote-snake correction)
//   rb/100   rollbacks per 100 remote inputs (rate independent of run length)
//   avgDep   mean rewind depth in ticks (+ its ms); maxDep = deepest single rewind
//   live%    share of remote inputs absorbed with NO rewind (the fast path)
//   lost     inputs that fell outside the redundancy window (a real gap; 0 at 0% loss)
//   conv     did the two sims still hash-agree at the end (rollback must re-converge)
// Deterministic (seeded RNG + mocked clocks), so numbers are stable and comparable.
// Reconnect is out of scope (RTCPeerConnection left undefined): this isolates the
// netcode-under-load, not connection recovery.
const { runInGame } = require('./harness');

const HOOKS = (id) => `
;(function(){
  localStorage.setItem('fok-snake-pid', ${JSON.stringify(id)});
  cfg.offline=false;
  globalThis.fetch = async ()=>({ status:0, json:async()=>null });
  _netPost = async ()=>null; _netGet = async ()=>null; _netTimeSync = async ()=>{};
  _netPollOnce = async ()=>{}; _netRequestStart = async ()=>{}; _netRelayLoop = async ()=>{};
  // Mocked clocks: the driver advances __now (the TRUE shared timeline). performance.now IS that
  // true time -- the frame/rAF domain. Date.now is the client's own WALL clock, which the sync
  // anchor can only ESTIMATE, so it carries a per-client frozen offset error (__clkE0, ms) and a
  // relative crystal drift (__clkDr, fraction of true time). netPts()=Date.now()+ofs, so this is
  // the one place clock-sync error enters both pts-delta and the tick target. Both terms default
  // to 0 (perfect sync == the old behaviour), so every legacy scenario below is unchanged.
  globalThis.__NET_BASE = 1784500000000;
  globalThis.__now = 0; globalThis.__clkE0 = 0; globalThis.__clkDr = 0;
  performance.now = ()=> __now;
  Date.now = ()=> __NET_BASE + __now + __clkE0 + __clkDr * __now;
  // Install a modeled clock: a frozen anchor-offset error + a relative drift, plus the SHARED
  // start origin both clients must agree on (the host's netPts at T=0). Called once before ticking;
  // it re-bases simTick to 0 so tick 0 maps cleanly onto startPts, and re-seeds the rollback ring.
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
  // Mock DataChannel: _netSend routes here when not in relay mode, so every real packet
  // (pts-stamped, size-checked, congestion-guarded) lands on our wire. bufferedAmount stays
  // 0: at this bitrate the congestion guard never trips.
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
  globalThis.__tick1   = ()=>{ netTickPre(); update(); };   // exactly ONE engine tick, real path
  // Clock catch-up, modeled EXACTLY on game.js:809-811: the shared clock STEERS the sim -- when our
  // OWN netPts (skewed by this client's clock error) says we are more than a tick behind the target,
  // run one extra tick this frame. A frozen anchor offset >= one tick thus becomes a standing simTick
  // gap between the two clients, and that gap is what turns clock skew into peer-input rollbacks.
  globalThis.__tickCatchup = ()=>{
    const t = netTickTarget(); if(t === null) return;
    const d = t - simTick;
    if(d > 1 && d <= 120){ netTickPre(); update(); }
  };
  globalThis.__steer   = (d)=>{ gameSteer(0, d); };          // local input -> authored under our index + sent
  globalThis.__alive   = ()=> !!_netSess;
  globalThis.__phase   = ()=> phase;
  globalThis.__warn    = ()=> !!netDuelWarn();
  globalThis.__hashNow = ()=> _rbHash(simSnapshot());
  globalThis.__simTick = ()=> simTick;
  globalThis.__rbDbg   = ()=> Object.assign({}, _rbDbg);
  globalThis.__netDbg  = ()=> Object.assign({}, _netDbg);
  globalThis.__TICK    = TICK_MS;
})();`;

const NET_BASE = 1784500000000;   // the fixed Date.now epoch the HOOKS clock is built on
// The ONE-TIME min-RTT clock anchor a real client takes before a duel (net-api.js _netTimeSync) and then FREEZES
// for the match -- it never re-syncs mid-duel. Over a jittery, possibly asymmetric wire the min-RTT
// sample still leaves the classic NTP (dBA-dAB)/2 residual, so two peers that sync INDEPENDENTLY land
// on different offsets. That frozen residual is the peer's standing pts-delta bias; once it reaches a
// full tick it also opens a standing simTick gap (see __tickCatchup). A rare bad sample -- one jitter
// spike caught by the single min-RTT probe -- makes it worse: model that tail with clock.err0.
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

// Receive-side main-thread model (only when prof.recv is set). These are the two costs that keep
// dc.onmessage from firing the instant a packet lands -- everything else (draw, layout) is off the
// critical path or unmodelled. Deliberately conservative: the real spikes the overlay shows (tens of
// ms) also include GC and HUD reflow stalls this profiler does not model, so treat the gated lagMax
// here as a LOWER bound on the receive-scheduling inflation, not a match to the on-device number.
const FRAME_BUSY = 5;    // ms the main thread is busy per frame (netTickPre + update)
const RESIM_MS   = 0.6;  // extra ms per re-simulated tick when a frame rolls back (rerun update())

// One link/phase/input profile driven for `secs` simulated seconds. Returns the measured row.
//   prof.base/jit/loss : wire one-way delay (ms), +-jitter (ms), drop fraction
//   prof.phase         : B's sub-tick schedule offset vs A (ms) -- the rAF phase gap
//   prof.tjit          : per-tick schedule jitter on BOTH clients (ms) -- makes the gap wobble
//   prof.zig           : issue a fresh 90deg turn every N ticks on both snakes (0 = none)
function run(name, secs, prof){
    const A = mk('aaaaaaaa', 0xBEEF, 'host'), B = mk('bbbbbbbb', 0xBEEF, 'peer');
    const TICK = A.__TICK;
    const wire = { AB:[], BA:[] };           // [deliverAt, txt] -- delivery is by time, so packets reorder
    const tx = { A:0, B:0 };                 // input packets each side put on the wire
    let warnT = 0, diedAt = 0, rndS = 0x51ED;
    const rnd = ()=> (rndS = (rndS*1103515245 + 12345) >>> 0) / 4294967296;
    // Independent device clocks (only when prof.clock is set). The HOST is the timeline reference; the
    // PEER carries the whole relative error: a frozen anchor offset e0 (ms, from anchor()) plus a
    // crystal drift dr (fraction of true time). __clkInstall re-bases BOTH sims to tick 0 on a SHARED
    // start origin -- exactly what adopting the host's start_pts does -- which is ALSO what makes
    // netTickTarget live here: the legacy 45000/3000 origins trip its bad-origin guard, so the clock
    // is inert for GROUPs 1-4 and their numbers are unchanged. Twin control: clock:{drift:0}, asym 0.
    const CK = prof.clock || null;
    const e0 = CK ? anchor(prof, rnd) : 0;
    const dr = CK ? (CK.drift || 0) * 1e-6 : 0;
    if(CK){ A.__clkInstall(0, 0, NET_BASE); B.__clkInstall(e0, dr, NET_BASE); }
    // Each client ticks on its OWN schedule: tick k fires at k*TICK + phase + bounded noise.
    // The k*TICK base means the noise never accumulates into drift -- rate stays exactly 60Hz,
    // only the sub-tick PHASE differs, which is the real rAF relationship between two machines.
    const sch = {
        A:{ c:A, dir:'AB', me:'A', pe:'B', k:0, next:0,          phase:0,             hd:{x:0,y:-1}, busyUntil:0 },
        B:{ c:B, dir:'BA', me:'B', pe:'A', k:0, next:prof.phase||0, phase:prof.phase||0, hd:{x:0,y: 1}, busyUntil:0 },
    };
    const fireOnce = (S)=>{
        S.c.__now = 0 | (S.next);   // read the clock AT this tick's time (integer ms, like a frame stamp)
        if(prof.zig && (S.k % prof.zig) === 0){
            // Rotate the heading 90deg (either way, seeded): always perpendicular, never a
            // self-reverse, so the turn is a valid one the sim accepts -- a real zigzag.
            S.hd = rnd() < 0.5 ? { x:-S.hd.y, y:S.hd.x } : { x:S.hd.y, y:-S.hd.x };
            S.c.__steer(S.hd);
        }
        // TOUCH SPAM: an iOS finger fires touchmove up to ~120Hz, so a fast player authors SEVERAL
        // distinct turns within ONE 60Hz tick. Each one is its own _netSend (duel-core.js:696) and
        // each lands on the peer as a separate packet -> up to one rollback EACH. Model that by
        // authoring `spam` extra perpendicular turns this tick: the wire rate (and the peer's
        // rollback rate) rises above one-per-tick, which is exactly the pressure the overlay showed.
        for(let i = 0; i < (prof.spam || 0); i++){
            S.hd = (i & 1) ? { x:-S.hd.y, y:S.hd.x } : { x:S.hd.y, y:-S.hd.x };
            S.c.__steer(S.hd);
        }
        // Model the MAIN THREAD: a frame occupies it for FRAME_BUSY ms (netTickPre+update; the draw is
        // pushed off the critical path via a MessageChannel in game.js, so it is NOT counted), plus the
        // re-sim work of any rollback this frame ran (each re-simmed tick reruns update()). While the
        // thread is busy, dc.onmessage cannot fire -- the packet has ARRIVED but netPts() is not sampled
        // until the frame yields (net-session.js _netHandleMsg). That deferral, not the wire, is what inflates pts live.
        const r0 = prof.recv ? S.c.__rbDbg().resim : 0;
        S.c.__tick1();
        if(CK) S.c.__tickCatchup();   // clock STEERS the sim (game.js:809): a full-tick anchor gap -> extra tick -> standing simTick offset -> rollbacks
        if(prof.recv) S.busyUntil = (0 | S.next) + (prof.busy || FRAME_BUSY) + (S.c.__rbDbg().resim - r0) * RESIM_MS;
        S.k++;
        S.next = S.k * TICK + S.phase + (prof.tjit ? (rnd()*2 - 1) * prof.tjit : 0);
    };
    const emit = (S)=>{
        for(const txt of S.c.__out.splice(0)){
            let cls='?'; try{ cls = (JSON.parse(txt).t) || '?'; }catch(e){}
            if(cls === 'pi') continue;   // warm ping: irrelevant to this experiment, keep the wire readable
            tx[S.me]++;
            if(rnd() < (prof.loss||0)) continue;
            const asym = (prof.asym || 0) * (S.dir === 'AB' ? 0.5 : -0.5);   // one-way up/down path imbalance -- also what biases the sync anchor
            let d = Math.max(1, prof.base + asym + (rnd()*2 - 1) * prof.jit);
            if(prof.spike && rnd() < prof.spike.p) d += prof.spike.ms;        // heavy-tailed WiFi/radio-wake latency spike
            wire[S.dir].push([S.c.__now + d, txt]);
        }
    };
    // A packet is PROCESSED (onmessage fires, netPts() sampled) only once it has arrived on the wire
    // AND the receiver's main thread is free. With prof.recv off, processing is immediate on arrival
    // (an idealised loop) -- so pts live can only ever read the wire, proving the netcode itself does
    // not inflate it. With prof.recv on, arrivals that land inside a busy frame wait for busyUntil.
    const drain = (q, C, R)=>{ for(let j=0; j<q.length; j++){
        const ready = q[j][0] <= C.__now && (!prof.recv || C.__now >= R.busyUntil);
        if(ready){ C.__recv(q[j][1]); q.splice(j--, 1); }
    } };
    const alive = ()=> A.__alive() && B.__alive() && A.__phase() !== 'duelOver' && B.__phase() !== 'duelOver';
    for(let now=0; now<=secs*1000; now++){
        A.__now = now; B.__now = now; A.__fire(); B.__fire();
        if(!alive()){ diedAt = now/1000; break; }
        while(now >= sch.A.next) fireOnce(sch.A);
        while(now >= sch.B.next) fireOnce(sch.B);
        emit(sch.A); emit(sch.B);
        drain(wire.AB, B, sch.B); drain(wire.BA, A, sch.A);
        if(A.__warn() || B.__warn()) warnT++;
    }
    // Settle before judging convergence: stop authoring turns, deliver everything still in
    // flight (no loss, no delay), then tick BOTH sims up to a common tick with no new input.
    // Two independently-phased loops end the run up to a tick apart, so a raw same-instant
    // hash compare falsely reads as divergence -- equalising the tick count is the honest test
    // of whether the rollbacks actually re-agreed on one world.
    const settleNow = (diedAt ? diedAt * 1000 : secs * 1000) + 1;
    const pump = ()=>{ for(const [S, peer] of [[A, B], [B, A]]) for(const txt of S.__out.splice(0)){
        let t='?'; try{ t = (JSON.parse(txt).t) || '?'; }catch(e){} if(t === 'pi') continue; peer.__recv(txt); } };
    A.__now = settleNow; B.__now = settleNow; pump();
    const target = Math.max(A.__simTick(), B.__simTick()) + 40;
    for(let g=0; g<400 && (A.__simTick() < target || B.__simTick() < target); g++){
        if(A.__simTick() < target) A.__tick1();
        if(B.__simTick() < target) B.__tick1();
        pump();
    }
    const converged = A.__simTick() === B.__simTick() && A.__hashNow() === B.__hashNow();
    const a = A.__rbDbg(), b = B.__rbDbg();
    const na = A.__netDbg(), nb = B.__netDbg();
    const rb = a.rb + b.rb, resim = a.resim + b.resim, live = a.live + b.live;
    const inRx = na.inRx + nb.inRx;               // remote input records received across both
    const secsRun = diedAt ? diedAt : secs;
    return {
        name, died: diedAt,
        inS:    inRx / secsRun,
        txS:    (tx.A + tx.B) / secsRun,   // 'in'+'h' packets put on the wire per second, both clients
        rbMin:  rb / secsRun * 60,
        rb100:  inRx ? rb / inRx * 100 : 0,
        avgDep: rb ? resim / rb : 0,
        depMs:  (rb ? resim / rb : 0) * TICK,
        maxDep: Math.max(a.maxRew, b.maxRew),
        livePc: (live + rb) ? live / (live + rb) * 100 : 100,
        lost:   a.lost + b.lost,
        warnPc: warnT / (secsRun*1000) * 100,
        conv:   converged,
        // pts live, measured EXACTLY as the game does (net-session.js _netHandleMsg) -- mine (netPts at processing) minus
        // the peer send-stamp. avg/max over each client's last-64 window; report the worse of the two.
        ptsAvg: Math.max(na.lagAvg, nb.lagAvg),
        ptsMax: Math.max(na.lagMax, nb.lagMax),
    };
}

// GROUP 1 -- ROLLBACKS. Low LATENCY throughout (base <= 20ms): the variable under test is PHASE and
// input RATE, not the wire. recv OFF (immediate delivery) so pts live can only read the wire here --
// which is the point: it shows the rollbacks are real while the netcode does NOT inflate pts live.
const P = [
    { name:'LAN 3ms  phase0   zig4', s:20, p:{ base:3,  jit:1,  loss:0,    phase:0,  tjit:0, zig:4 } },
    { name:'LAN 3ms  phase4   zig4', s:20, p:{ base:3,  jit:1,  loss:0,    phase:4,  tjit:0, zig:4 } },
    { name:'LAN 3ms  phase8   zig4', s:20, p:{ base:3,  jit:1,  loss:0,    phase:8,  tjit:0, zig:4 } },
    { name:'LAN 3ms  ph8+jit  zig4', s:20, p:{ base:3,  jit:1,  loss:0,    phase:8,  tjit:4, zig:4 } },
    { name:'LAN 3ms  ph8+jit  zig8', s:20, p:{ base:3,  jit:1,  loss:0,    phase:8,  tjit:4, zig:8 } },
    { name:'WiFi 20  ph8+jit  zig4', s:20, p:{ base:20, jit:10, loss:0,    phase:8,  tjit:4, zig:4 } },
];
// GROUP 2 -- PTS LIVE SPIKE. The user's link: p2p ~5ms, moving fast. recv ON models the main thread,
// so an arrived packet waits for the frame to yield before onmessage samples netPts(). Sweeping the
// turn rate (slow -> fast) on the SAME 5ms wire shows pts live max climbing far above the wire -- and
// the recv-OFF twin at the fast rate stays at the wire, isolating the cause to receive scheduling.
const R = [
    { name:'5ms recvON  zig12',      s:20, p:{ base:5,  jit:2,  loss:0,    phase:8,  tjit:4, zig:12, recv:true } },
    { name:'5ms recvON  zig6',       s:20, p:{ base:5,  jit:2,  loss:0,    phase:8,  tjit:4, zig:6,  recv:true } },
    { name:'5ms recvON  zig3',       s:20, p:{ base:5,  jit:2,  loss:0,    phase:8,  tjit:4, zig:3,  recv:true } },
    { name:'5ms recvOFF zig3',       s:20, p:{ base:5,  jit:2,  loss:0,    phase:8,  tjit:4, zig:3 } },
];
// GROUP 3 -- TOUCH-SPAM PACKET STORM. Same 5ms wire, recv ON. `spam` authors N extra turns per tick,
// modelling an iOS finger firing touchmove faster than the tick: today each authored turn is its own
// immediate _netSend (duel-core.js:696), so tx/s -- and with it the peer's rollback rate and the
// receive-scheduling that inflates pts live -- rises with spam. THIS is the engine staller. Once the
// send is batched to one packet per tick (netTickPre), tx/s must stay flat at the tick rate.
const S3 = [
    { name:'5ms spam0',              s:20, p:{ base:5,  jit:2,  loss:0,    phase:8,  tjit:4, zig:0,  spam:0, recv:true } },
    { name:'5ms spam2',              s:20, p:{ base:5,  jit:2,  loss:0,    phase:8,  tjit:4, zig:0,  spam:2, recv:true } },
    { name:'5ms spam4',              s:20, p:{ base:5,  jit:2,  loss:0,    phase:8,  tjit:4, zig:0,  spam:4, recv:true } },
    { name:'5ms spam8',              s:20, p:{ base:5,  jit:2,  loss:0,    phase:8,  tjit:4, zig:0,  spam:8, recv:true } },
];
// GROUP 4 -- ROLLBACK FLOOD (receiver stall). recv ON with a heavy per-frame busy time, so packets
// pile up behind a stall and DRAIN together. Without receive-batching each drained packet triggers
// its own rollback re-sim; with the netTickPre batch the whole burst costs ONE rollback. Fast input
// on a low-latency link maximises how many packets are caught behind each stall.
const S4 = [
    { name:'stall8  zig3',           s:20, p:{ base:3,  jit:1,  loss:0,    phase:8,  tjit:4, zig:3,  recv:true, busy:8  } },
    { name:'stall12 zig3',           s:20, p:{ base:3,  jit:1,  loss:0,    phase:8,  tjit:4, zig:3,  recv:true, busy:12 } },
    { name:'stall12 spam4',          s:20, p:{ base:3,  jit:1,  loss:0,    phase:8,  tjit:4, zig:0,  spam:4, recv:true, busy:12 } },
];
// GROUP 5 -- THE REAL LINK: independent device clocks on a fast 7ms p2p wire (the user's field case).
// Each client now runs on its OWN wall clock: a frozen min-RTT anchor (residual from link asymmetry,
// plus an err0 tail for a bad sample) and a relative crystal drift, exactly like two phones. netPts()
// carries that error, so pts live reads the WIRE PLUS the clock disagreement; and when the anchor is a
// full tick off it also steers the sim (game.js catch-up), rolling back every peer input. Row 0 is the
// live-clock TWIN (well synced, zero drift): same wire, same inputs, so the delta is the clock alone.
const C5 = [
    { name:'7ms sync-ok  zig4',      s:30, p:{ base:7,  jit:3,  loss:0,    phase:8,  tjit:4, zig:4,  recv:true, clock:{ drift:0 } } },
    { name:'7ms drift40  zig4',      s:30, p:{ base:7,  jit:3,  loss:0,    phase:8,  tjit:4, zig:4,  recv:true, asym:6, clock:{ drift:40 } } },
    { name:'7ms badanch  zig4',      s:30, p:{ base:7,  jit:3,  loss:0,    phase:8,  tjit:4, zig:4,  recv:true, asym:6, clock:{ drift:40, err0:18 } } },
    { name:'7ms badanch+spk',        s:30, p:{ base:7,  jit:3,  loss:0,    phase:8,  tjit:4, zig:4,  recv:true, asym:6, clock:{ drift:40, err0:18 }, spike:{ p:0.02, ms:40 } } },
];
const rows = P.map(x => run(x.name, x.s, x.p));
const rrow = R.map(x => run(x.name, x.s, x.p));
const srow = S3.map(x => run(x.name, x.s, x.p));
const s4row = S4.map(x => run(x.name, x.s, x.p));
const c5row = C5.map(x => run(x.name, x.s, x.p));

const pad = (s,n)=> String(s).padStart(n);
const HDR = ['in/s','tx/s','rb/min','rb/100','maxDep','live%','ptsAvg','ptsMax','conv'];
const WID = [7,7,8,8,7,7,7,7,6];
const line = (r)=> r.name.padEnd(22)
    + pad(r.inS.toFixed(1), 7) + pad(r.txS.toFixed(1), 7) + pad(r.rbMin.toFixed(1), 8) + pad(r.rb100.toFixed(1), 8)
    + pad(r.maxDep, 7) + pad(r.livePc.toFixed(1), 7)
    + pad(r.ptsAvg.toFixed(1), 7) + pad(r.ptsMax.toFixed(1), 7) + pad(r.conv ? 'yes' : 'NO', 6)
    + (r.died ? '  (died @'+ r.died.toFixed(0) +'s)' : '');
console.log('two-client P2P duel profile -- INDEPENDENT tick phase, fast zigzag, LOW latency (deterministic)');
console.log('');
console.log('GROUP 1  rollbacks (recv immediate -- pts live reads the wire only):');
console.log('link/phase/rate'.padEnd(22) + HDR.map((h,i)=> pad(h, WID[i])).join(''));
for(const r of rows) console.log(line(r));
console.log('');
console.log('GROUP 2  pts live spike (recv gated on the main thread; 5ms wire, rising turn rate):');
console.log('link/phase/rate'.padEnd(22) + HDR.map((h,i)=> pad(h, WID[i])).join(''));
for(const r of rrow) console.log(line(r));
console.log('');
console.log('GROUP 3  touch-spam packet storm (5ms wire, N extra turns authored per tick):');
console.log('link/spam'.padEnd(22) + HDR.map((h,i)=> pad(h, WID[i])).join(''));
for(const r of srow) console.log(line(r));

console.log('');
const s0 = srow[0], sN = srow[srow.length - 1];
console.log('touch spam -> send rate (the engine staller): one immediate _netSend per authored turn means');
console.log('  packets/sec:    spam0 ' + s0.txS.toFixed(1) + '  ->  spam8 ' + sN.txS.toFixed(1)
    + '     rollbacks/min: ' + s0.rbMin.toFixed(0) + ' -> ' + sN.rbMin.toFixed(0)
    + '     pts max: ' + s0.ptsMax.toFixed(1) + ' -> ' + sN.ptsMax.toFixed(1));
console.log('  batched to one send per tick, packets/sec must stay flat at the tick rate regardless of spam.');

console.log('');
console.log('GROUP 4  rollback flood (recv gated by a per-frame stall; packets pile up then drain together):');
console.log('link/stall'.padEnd(22) + HDR.map((h,i)=> pad(h, WID[i])).join(''));
for(const r of s4row) console.log(line(r));
console.log('  receive-side batch (netTickPre does ONE rollback for the whole drained burst) caps rb/min at the');
console.log('  tick rate no matter how many packets arrive together; conv must stay yes (the batch re-converges).');

console.log('');
console.log('GROUP 5  real link: INDEPENDENT device clocks (frozen min-RTT anchor + relative drift), 7ms p2p:');
console.log('link/clock'.padEnd(22) + HDR.map((h,i)=> pad(h, WID[i])).join(''));
for(const r of c5row) console.log(line(r));
const g5ok = c5row[0], g5bad = c5row[2];
console.log('  well-synced twin vs bad-anchor (same 7ms wire, same inputs -- only the clock differs):');
console.log('    pts max: ' + g5ok.ptsMax.toFixed(1) + 'ms -> ' + g5bad.ptsMax.toFixed(1) + 'ms      rb/min: '
    + g5ok.rbMin.toFixed(0) + ' -> ' + g5bad.rbMin.toFixed(0) + '      maxDep: ' + g5ok.maxDep + ' -> ' + g5bad.maxDep);
console.log('  pts live: a frozen anchor puts pts WELL above the wire and STAYS there -- the field "high pts delta"');
console.log('    is the clock disagreement, not the 7ms link (the twin sits at the wire+recv on the same wire).');
console.log('  rollbacks: already high from the network alone (phase + jitter + fast turns; the twin shows it too);');
console.log('    the >=1-tick anchor gap adds ~20% more, and heavy-tail wire spikes are what deepen them (maxDep up).');

console.log('');
const g1max = Math.max(...rows.map(r => r.ptsMax));    // recv immediate: pts live max stays at the wire
const on  = rrow.filter(r => /recvON/.test(r.name));
const off = rrow.find(r => /recvOFF/.test(r.name));
const fast = on[on.length-1], slow = on[0];
console.log('pts live is a RECEIVE-SCHEDULING number, not a wire number:');
console.log('  recv immediate (netcode only), worst of all GROUP 1 rows: pts live max ' + g1max.toFixed(1) + 'ms (~the wire)');
if(off && fast) console.log('  5ms wire, FAST turns, recv OFF vs ON:  ' + off.ptsMax.toFixed(1) + 'ms  ->  ' + fast.ptsMax.toFixed(1) + 'ms  (same wire, same inputs; only the main-thread model differs)');
if(slow && fast) console.log('  and it scales with movement speed:     slow turns ' + slow.ptsMax.toFixed(1) + 'ms  ->  fast turns ' + fast.ptsMax.toFixed(1) + 'ms');
console.log('');
const bad = [...rows, ...rrow].filter(r => !r.conv);
console.log('RESULT: pts live max is inflated by when onmessage is DISPATCHED (main-thread busy behind the'
    + '\n        frame + rollback re-sim), not by the network -- the input still applies to its authored'
    + '\n        tick, so this is a scheduling artifact. The on-device tens-of-ms tail adds GC + HUD reflow'
    + '\n        stalls not modelled here; the gated max above is a lower bound.');
if(bad.length) console.log('WARNING: ' + bad.length + ' link(s) did NOT re-converge -- ' + bad.map(r=>r.name.trim()).join(', '));
