// The duel board is a pure function of (gameSeed, level) -- _duelBeginLevel re-seeds from
// _duelLevelSeed -- so the two clients build IDENTICAL barricades exactly as long as they
// agree on the level NUMBER. That number must come off the wire: the host owns it (like the
// epoch) and ships it in the go's `lvl` field, and both sims adopt it in startDuelLevel.
// If it were a private local counter advanced by side effect (level+1 per begin), any path
// that runs a begin a different number of times on the two clients -- a duplicate fire, a
// stray press, a version skew -- would silently rebuild two DIFFERENT worlds from one
// boundary. A level boundary's target is never 1, so a go {why:'level'} always carries
// lvl >= 2; match/rematch gos open at lvl:1.
// Run: node test/smoke-level-wire.js
const { runTest } = require('./harness');

runTest('SMOKE-LEVEL-WIRE', `
globalThis.__R = { steps: [], err: null };
try {
    const posts = [];   // main -> worker messages (recording Worker stub, engaged later)
    const sent = [];    // wire datagrams as the peer would receive them
    const ok = (msg)=>{ __R.steps.push('  ok  ' + msg); };
    const fail = (msg)=>{ throw new Error(msg); };
    const dc = { readyState:'open', send:(j)=>sent.push(JSON.parse(j)), close(){} };
    _netSess = { epoch:0, startPts:0, game:true, dc, lastSent:0, iceQ:[], role:'guest' };
    _netSync = { ofs: 100000 - _wall(), rtt: 10, at: Date.now() };   // netPts() ~ 100000

    // Joiner adopts the wire number. Start a duel, then PERTURB the local counter the way
    // any miscounted begin would, and deliver a boundary go carrying level 3: the sim must
    // build level 3, not local+1 -- the wire is the single author of the rebuild input.
    beginOnlineDuel(0xC0FFEE, false);
    if(level !== 1) fail('control: duel start should open level 1, got ' + level);
    level = 7;   // a drifted local counter (the fault class this guard pins)
    _netHandleMsg(JSON.stringify({ t:'go', why:'level', seed:0xC0FFEE, startPts:99000, epoch:1, lvl:3, bth:0 }));
    if(level !== 3) fail('joiner rebuilt level ' + level + ' != wire level 3 (local counter won)');
    ok('joiner builds the level the go names, whatever its local counter says');

    // A duplicate/stray begin with the same wire number is HARMLESS: the reseed from
    // (gameSeed, level) hands back the byte-identical board, so a double-fired boundary
    // can no longer split the pair onto different worlds.
    const barsA = JSON.stringify(bars);
    level = 9;
    beginOnlineDuelLevel(false, 3);
    if(level !== 3) fail('duplicate begin rebuilt level ' + level + ' != wire level 3');
    if(JSON.stringify(bars) !== barsA) fail('duplicate begin built a DIFFERENT board for the same wire level');
    ok('a duplicate begin with the same wire number rebuilds the identical board');

    // Worker home: the number must cross the main->worker seam, or the worker sim would be
    // back on its private counter while main believes the wire value.
    globalThis.Worker = class { constructor(u){ this.url = u; } postMessage(m){ posts.push(m); } terminate(){} };
    _initWorker();
    if(!_useWorker()) fail('worker stub did not engage (_useWorker false)');
    beginOnlineDuelLevel(true, 5);
    const wmsg = posts.find(p=>p.t==='duelLevelNet');
    if(!wmsg) fail('worker home never received the level begin');
    if((wmsg.lvl|0) !== 5) fail('duelLevelNet carried lvl ' + wmsg.lvl + ' != 5');
    ok('the worker begin carries the wire number across the seam');

    // Host side: the session owns the counter (beside the epoch) and ships it on the go.
    // Two boundaries ship 2 then 3 -- authored once, adopted by BOTH sims including the
    // host's own.
    _netBurstThenStart = (s, then)=>then(0);   // the clock burst is proven elsewhere
    _netSess.role = 'host';
    sent.length = 0;
    _netStartNextLevel(_netSess);
    let go = sent.find(m=>m.t==='go');
    if(!go) fail('host boundary shipped no go');
    if(go.why !== 'level') fail('host boundary shipped why ' + go.why + " != 'level'");
    if((go.lvl|0) !== 2) fail('first host boundary shipped lvl ' + go.lvl + ' != 2');
    _netSess.lvlPending = false;   // boundary done (the begin normally clears this)
    sent.length = 0;
    _netStartNextLevel(_netSess);
    go = sent.find(m=>m.t==='go');
    if(!go || (go.lvl|0) !== 3) fail('second host boundary shipped lvl ' + (go && go.lvl) + ' != 3');
    ok('the host authors the level number on the session and ships it on every go');
    _netSess.game = false;   // neuter armed begins + pending-tx retries before the VM winds down
} catch(e){ __R.err = (e && e.stack) || String(e); }
`);
