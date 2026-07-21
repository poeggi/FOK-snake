// RELAY-MODE simulation: two full clients over a SIMULATED relay wire with
// controllable one-way delay, jitter, batching and loss, on a mocked clock that
// drives the REAL liveness interval (warn bars, silence kill). Separates "our
// engine misbehaves at relay latencies" from "the relay server misbehaves":
// scenario A is a relay behaving to spec -- any warn there is OUR bug; B and C
// are server pathologies (starved batching, loss) -- warns there are external.
// Run: node test/relay-sim.js
const { runInGame } = require('./harness');

const HOOKS = (id) => `
;(function(){
  localStorage.setItem('fok-snake-pid', ${JSON.stringify(id)});
  cfg.offline=false;
  globalThis.fetch = async ()=>({ status:0, json:async()=>null });
  _netPost = async ()=>null; _netGet = async ()=>null; _netTimeSync = async ()=>{};
  _netPollOnce = async ()=>{};
  // Mocked clocks: the driver advances __now; real Date/performance are never read.
  globalThis.__now = 0;
  performance.now = ()=> __now;
  Date.now = ()=> 1784500000000 + __now;
  // Timers under driver control: capture intervals, fire the due ones on demand.
  globalThis.__ivals = [];
  globalThis.setInterval = (fn, ms)=>{ __ivals.push({ fn, ms, next: __now + ms }); return __ivals.length; };
  globalThis.clearInterval = ()=>{};
  globalThis.setTimeout = (fn, ms)=>{ __ivals.push({ fn, ms:0, next: __now + ms, once:true }); return -1; };
  globalThis.__fire = ()=>{ for(const iv of __ivals){ if(iv.done) continue;
      while(__now >= iv.next){ iv.fn(); if(iv.once){ iv.done=true; break; } iv.next += iv.ms; } } };
  // The relay transport, replaced by the driver's bus: sends surface in __out.
  globalThis.__out = [];
  _netRelaySend = async (s, o)=>{ s.lastSent = performance.now(); __out.push(JSON.stringify(o)); };
  _netRelayLoop = async ()=>{};
  _netRequestStart = async ()=>{};
  globalThis.__relayStart = (seed, role)=>{
    _netSync = { ofs:0, rtt:1, at:Date.now() };
    simTick = role==='host' ? 45000 : 3000; simNow = simTick*TICK_MS; inGame = true;
    _netSess = _netMkSess('ffffffff', role);
    _netSess.seed = seed>>>0; _netSess.relay = true; _netSess.game = true;
    _netMarkRecv(_netSess);
    _netSess.relayGraceUntil = performance.now() + 12000;
    _netLiveStart();
    startDuel(seed>>>0, false);
    _rbReset();
    _netSess.startPts = Date.now();
  };
  globalThis.__recvRelay = (txt)=>{ if(_netSess){ _netMarkRecv(_netSess); _netHandleMsg(txt); } };
  globalThis.__tick1 = ()=>{ netTickPre(); update(); };
  globalThis.__warn = ()=> netDuelWarn();
  globalThis.__alive = ()=> !!_netSess;
  globalThis.__hashNow = ()=> _rbHash(simSnapshot());
  globalThis.__rbDbg = ()=> Object.assign({}, _rbDbg);
  globalThis.__steer = (d)=>{ gameSteer(0, d); };
})();`;

function mk(id, seed, role){
    const c = runInGame(HOOKS(id));
    c.__relayStart(seed, role);
    return c;
}

// One scenario: drive both clients tick-locked for `secs` simulated seconds while the
// bus delivers with the given profile. Returns observed health.
function run(name, secs, profile){
    const A = mk('aaaaaaaa', 0xBEEF, 'host'), B = mk('bbbbbbbb', 0xBEEF, 'peer');
    const busAB = [], busBA = [];  // [deliverAt, txt]
    let warnTicks = 0, warnAfterGrace = 0, kills = 0, rndS = 12345;
    const rnd = () => (rndS = (rndS * 1103515245 + 12345) >>> 0) / 4294967296;
    const steps = secs * 60;
    for(let i = 0; i < steps; i++){
        const now = i * (1000/60);
        A.__now = now; B.__now = now;
        A.__fire(); B.__fire();
        if(!A.__alive() || !B.__alive()){ kills++; break; }
        A.__tick1(); B.__tick1();
        if(i % 90 === 40) A.__steer({x:0, y:(i % 180 < 90) ? -1 : 1});
        if(i % 100 === 60) B.__steer({x:0, y:(i % 200 < 100) ? -1 : 1});
        for(const p of A.__out.splice(0)) if(rnd() >= profile.loss) busAB.push([now + profile.delay(rnd), p]);
        for(const p of B.__out.splice(0)) if(rnd() >= profile.loss) busBA.push([now + profile.delay(rnd), p]);
        const due = (bus, C) => { for(let j = 0; j < bus.length; j++){
            if(bus[j][0] <= now && (!profile.batchMs || (now % profile.batchMs) < 17)){ C.__recvRelay(bus[j][1]); bus.splice(j--, 1); } } };
        due(busAB, B); due(busBA, A);
        if(A.__warn() || B.__warn()){ warnTicks++; if(now > 13000) warnAfterGrace++; }
    }
    const conv = A.__hashNow() === B.__hashNow();
    const out = { name, warnTicks, warnAfterGrace, kills, conv,
                  dsyA: A.__rbDbg().desync, dsyB: B.__rbDbg().desync };
    console.log(name + ': warn ' + warnTicks + 't (post-grace ' + warnAfterGrace + 't), kills ' + kills
        + ', converged ' + conv + ', dsy ' + out.dsyA + '/' + out.dsyB);
    return out;
}

// A: a relay BEHAVING TO SPEC -- 300ms +-100ms one-way, no loss, no batching.
const a = run('A spec-relay 300ms+-100', 30, { delay: r => 200 + r() * 200, loss: 0 });
// B: a STARVED relay -- correct delivery but flushed in ~2s batches (PHP contention).
const b = run('B starved 2s-batches   ', 30, { delay: r => 250, loss: 0, batchMs: 2000 });
// C: a LOSSY relay -- 30% of POSTs vanish (5xx class), otherwise spec timing.
const c = run('C lossy 30%            ', 30, { delay: r => 200 + r() * 200, loss: 0.3 });

let verdict;
if(a.warnAfterGrace > 60 || a.kills || !a.conv) verdict = 'ENGINE: warns/breaks on a spec-behaved relay -- our thresholds or lockstep misbehave at relay latency';
else if(b.warnAfterGrace > 60 || c.warnAfterGrace > 60) verdict = 'EXTERNAL: engine is clean on a spec relay; warns appear only under server pathologies (starved batching / loss) -- relay.php delivery is the suspect';
else verdict = 'ALL CLEAN: neither engine nor simulated pathologies reproduce it -- instrument the live relay path next';
console.log('VERDICT: ' + verdict);
if(a.warnAfterGrace > 60 || a.kills || !a.conv){ console.log('RELAY-SIM FAIL'); process.exit(1); }
console.log('RELAY-SIM PASSED');
