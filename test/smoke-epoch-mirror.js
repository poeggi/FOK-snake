// The duel wire stamps + gates epochs on MAIN: _netSend writes o.ep from _rbEpoch and
// _netHandleMsg compares m.ep against it -- while the DEFAULT runtime hosts duel-core
// (and its _rbReset) in sim-worker.js, where netEpoch() does not exist. So main's
// dormant core must mirror the base epoch at every begin, in BOTH homes. If the mirror
// freezes, a worker-mode client stamps and gates a stale epoch forever: against a peer
// whose epoch advances (the FORCE SINGLE THREADED toggle, file://, a demoted worker),
// the pair splits onto separate tick bases at the FIRST level boundary and every tick
// packet is epoch-gated in both directions. Run: node test/smoke-epoch-mirror.js
const { runTest } = require('./harness');

runTest('SMOKE-EPOCH-MIRROR', `
globalThis.__R = { steps: [], err: null };
try {
    const posts = [];   // main -> worker messages (the recording Worker stub below)
    const sent = [];    // wire datagrams as the peer would receive them
    const ok = (msg)=>{ __R.steps.push('  ok  ' + msg); };
    const fail = (msg)=>{ throw new Error(msg); };
    const dc = { readyState:'open', send:(j)=>sent.push(JSON.parse(j)), close(){} };
    _netSess = { epoch:0, startPts:0, game:true, dc, lastSent:0, iceQ:[] };

    // In-process home (control): the mirror follows the session line at every begin.
    beginOnlineDuel(0xBEEF, true);
    if(_netMyEpoch() !== 0) fail('in-process start: mirror ' + _netMyEpoch() + ' != epoch 0');
    _netSess.epoch = 1;
    beginOnlineDuelLevel(true);
    if(_netMyEpoch() !== 1) fail('in-process boundary: mirror ' + _netMyEpoch() + ' != epoch 1');
    ok('in-process home: the epoch mirror follows every begin (control)');

    // Worker home: same client, same session, next boundary. The begin posts the rebase
    // to the worker -- main must adopt the same base epoch at the same instant.
    globalThis.Worker = class { constructor(u){ this.url = u; } postMessage(m){ posts.push(m); } terminate(){} };
    _initWorker();
    if(!_useWorker()) fail('worker stub did not engage (_useWorker false)');
    _netSess.epoch = 2;
    beginOnlineDuelLevel(true);
    if(!posts.some(p=>p.t==='duelLevelNet')) fail('worker home never received the level begin');
    if(_netMyEpoch() !== 2) fail('worker-home boundary: mirror ' + _netMyEpoch() + ' != epoch 2 (this client would stamp/gate a stale epoch)');
    ok('worker home: the epoch mirror follows the begin that rebases the worker');

    // The stamp itself, exactly what the peer's gate compares.
    sent.length = 0;
    _netSend({ t:'in', tk:0, l:[] });
    if(sent.length !== 1) fail('wire send not captured');
    if((sent[0].ep|0) !== 2) fail('outbound tick packet stamped ep ' + sent[0].ep + ' != base epoch 2');
    ok('outbound tick packets carry the current base epoch');

    // Teardown: a fresh pair opens on epoch 0, so the mirror must not retain the dead
    // session's final epoch -- that would gate the next match's packets from tick one.
    _netSess.epoch = 5;
    _netTeardown();
    if(_netMyEpoch() !== 0) fail('after teardown: mirror ' + _netMyEpoch() + ' != 0 (the dead session\\'s epoch would leak into the next match)');
    ok('teardown clears the mirror to 0 (nothing leaks into the next pairing)');
} catch(e){ __R.err = (e && e.stack) || String(e); }
`);
