// Worker-path online duel: the sim + rollback core (duel-core.js) runs INSIDE
// sim-worker.js, which is the DEFAULT runtime whenever Worker exists -- yet the other
// suites drive the in-process fallback (they have no Worker). This loads sim-worker.js
// in a vm (importScripts inlined, clock + timers mocked), starts a duel, and exercises
// every message type end to end: the tick loop, phase seed, peer input (live-apply +
// rollback), the 1Hz self-diagnosing hash, one-shot desync repair, resync, local input,
// and the boost arming round trip. Run: node test/smoke-worker.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const JS = p => fs.readFileSync(path.join(__dirname, '..', 'js', p), 'utf8');

let now = 0;                       // mocked clock, ms (the driver advances it)
const posts = [];
let crashed = null;

const sandbox = {
    console,
    performance: { now: () => now },
    Date: { now: () => 1784500000000 + now },
    postMessage: (m) => { posts.push(m); },
    setInterval: () => 0,          // the loop timer is captured but never auto-fires; _step is driven
    clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    structuredClone: globalThis.structuredClone,
    Math, JSON, Map, Set, Int16Array, Number, Infinity, NaN,
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.importScripts = (...files) => { for (const f of files) vm.runInContext(JS(f), ctx, { filename: f }); };
const ctx = vm.createContext(sandbox);

try {
    vm.runInContext(JS('sim-worker.js'), ctx, { filename: 'sim-worker.js' });
    const step = (n) => { for (let i = 0; i < n; i++) { now += 4; vm.runInContext('_step()', ctx); } };
    const send = (obj) => vm.runInContext(`onmessage({ data: ${JSON.stringify(obj)} })`, ctx);
    const g = (expr) => vm.runInContext(expr, ctx);

    send({ t:'cfg', cfg:{ diff:1, turbo:true } });
    send({ t:'duelStartNet', seed:0xBEEF, x10:false, my:0, ofs:-100, startPts:1784500000000 - 100 });

    // The phase is SET once at start, never per tick.
    if (g('_dcSnapN') !== 1) throw new Error('phase should be set exactly once at start, got pset ' + g('_dcSnapN'));

    // Past READY/GO and several 64-tick hash boundaries.
    step(750);
    if (g('simTick') < 100) throw new Error('sim did not advance: ' + g('simTick'));
    if (g('_dcSnapN') !== 1) throw new Error('phase re-set while running (pset ' + g('_dcSnapN') + '): it must only move on an anchor change');

    // Peer inputs: a late dir, a late grace-boost, a boost end.
    const tk = g('simTick');
    send({ t:'peerPkt', m:{ t:'in', tk:tk-3, l:[
        { q:1, tk:tk-3, k:'dir', d:{x:1,y:0} },
        { q:2, tk:tk-2, k:'bs',  d:{x:1,y:0}, n:0 },
        { q:3, tk:tk-1, k:'be' } ] } });
    step(50);

    // Forced hash mismatch for a settled ring tick -> a desync verdict + one repair.
    const ringTk = g('_rbRing[Math.max(0,_rbRing.length-8)].tk');
    send({ t:'peerPkt', m:{ t:'h', tk:ringTk, h:12345, f:{ players:1 } } });
    step(10);

    // Transport-triggered full resync (host) -> a wire 'rs'.
    send({ t:'duelResync' });
    step(20);

    // A resync from the peer must be REFUSED by a host (only the joiner adopts).
    const fixBefore = g('_rbDbg.fix');
    send({ t:'peerPkt', m:{ t:'rs', tk:g('simTick'), p0:{ s:[1,1] }, p1:{ s:[2,2] } } });
    if (g('_rbDbg.fix') !== fixBefore) throw new Error('a host adopted a peer rs (takeover): the receive gate is missing');

    // Local input round trip -> a wire 'in'.
    send({ t:'lin', k:'dir', d:{x:0,y:1}, n:0 });
    step(50);

    // Arming round trip: an aligned instant arm authors a real 'bs'; disarm authors 'be'.
    send({ t:'arm', p:0, dir:g('({x:players[0].dir.x,y:players[0].dir.y})'), now:1 });
    step(30);
    if (!g('players[0].boosting')) throw new Error('armed instant boost never engaged in the worker');
    send({ t:'arm', p:0, dir:null });
    step(10);
    if (g('players[0].boosting')) throw new Error('disarm did not end the boost');
    step(100);
} catch (e) { crashed = e; }

const wires = posts.filter(p => p.t === 'wire').map(w => w.o.t);
const count = (t) => wires.filter(x => x === t).length;
const hf = posts.filter(p => p.t === 'wire' && p.o.t === 'h' && p.o.f).length;
const inLogs = posts.filter(p => p.t === 'wire' && p.o.t === 'in').map(w => JSON.stringify(w.o));

if (crashed) { console.log('worker duel CRASH:', crashed.stack.split('\n').slice(0, 4).join('\n')); process.exit(1); }
const checks = [
    ['1Hz hash sent, every one carrying per-field hashes', count('h') >= 2 && hf === count('h')],
    ['a desync verdict fired one repair (st or rs)', vm.runInContext('_rbDbg.desync', ctx) >= 1 && (count('st') + count('rs')) >= 1],
    ['a host resync was sent', count('rs') >= 1],
    ['local input reached the wire', count('in') >= 1],
    ['the arming stage authored real bs + be transitions', inLogs.some(s => s.includes('"k":"bs"')) && inLogs.some(s => s.includes('"k":"be"'))],
];
const bad = checks.filter(c => !c[1]).map(c => c[0]);
for (const c of checks) console.log('  ' + (c[1] ? 'ok  ' : 'FAIL') + ' ' + c[0]);
if (bad.length) { console.log('SMOKE-WORKER FAIL'); process.exit(1); }
console.log('SMOKE-WORKER PASSED');
