// An ONLINE duel death is a negotiated boundary, not a local rebuild: the sim (armed with
// net:true at the online entry, _duelNetHold) HOLDS in 'dying' once the death animation has
// run and emits 'duelHalt' -- LEVEL-triggered, re-announced every _HALT_RE ticks for as
// long as the hold stands, because the host can miss any single edge (a halt landing while
// a recovery-resume boundary held the one-boundary guard was refused once and, one-shot,
// never retried: both clients sat in 'dying' forever -- the field freeze regressed below).
// The host answers by opening a respawn boundary (epoch bump + clock burst +
// go {why:'respawn'}) and BOTH clients rebuild the same level at tick 0 from the fresh
// shared start_pts. If each sim rebuilt on its own (the local-duel path), the two boards
// would re-anchor on unsynchronized clocks -- the exact drift the boundary burst exists to
// cancel. Local duels keep the immediate rebuild (no flag), and a duelHalt fired inside a
// rollback REPLAY must still dispatch: a death introduced by a late input crosses
// DEATH_DUR only in the replay. Run: node test/smoke-respawn-halt.js
const { runTest } = require('./harness');

runTest('SMOKE-RESPAWN-HALT', `
globalThis.__R = { steps: [], err: null };
try {
    const posts = [];   // main -> worker messages (recording Worker stub, engaged later)
    const sent = [];    // wire datagrams as the peer would receive them
    const ok = (msg)=>{ __R.steps.push('  ok  ' + msg); };
    const fail = (msg)=>{ throw new Error(msg); };
    const halts = ()=> simEvents.filter(e=>e.t==='duelHalt').length;
    const dc = { readyState:'open', send:(j)=>sent.push(JSON.parse(j)), close(){} };
    _netSess = { epoch:0, startPts:0, game:true, dc, lastSent:0, iceQ:[], role:'guest' };
    _netSync = { ofs: 100000 - _wall(), rtt: 10, at: Date.now() };   // netPts() ~ 100000

    // JOINER: the online entry arms the hold, a death crosses DEATH_DUR, and the sim
    // parks in 'dying', re-announcing duelHalt every _HALT_RE ticks -- no local
    // rebuild however long the negotiation takes, and no single edge to miss.
    beginOnlineDuel(0xABCD, false);
    if(!_duelNetHold) fail('online entry did not arm the net hold');
    phase = 'dying'; phaseAt = simNow; deathMsg = 'X';   // the duelStep death outcome, minus the collision
    const DT = Math.round(DEATH_DUR/TICK_MS), HELD = 26;
    for(let i=0;i<DT+HELD;i++) update();                  // crossing at DEATH_DUR, held HELD ticks since
    if(phase !== 'dying') fail('held sim left dying -> ' + phase + ' (rebuilt locally)');
    const exp1 = 1 + Math.floor(HELD/_HALT_RE);          // the crossing announce + one per period held
    if(halts() !== exp1) fail('held ' + HELD + ' ticks emitted ' + halts() + ' duelHalt != ' + exp1);
    for(let i=0;i<2*_HALT_RE;i++) update();              // two more full periods
    if(halts() !== exp1+2) fail('re-announce cadence off (halts ' + halts() + ' != ' + (exp1+2) + ')');
    ok('online death holds in dying and re-announces duelHalt every _HALT_RE ticks');

    // The host's go {why:'respawn'} begins the rebuild: same level, tick 0, players kept.
    sent.length = 0; simEvents.length = 0;
    _netHandleMsg(JSON.stringify({ t:'go', why:'respawn', seed:0xABCD, startPts:99000, epoch:1, lvl:1, bth:0 }));
    if(!sent.some(m=>m.t==='go' && m.a===1)) fail('respawn go was not echoed');
    if(simTick !== 0) fail('respawn begin left simTick ' + simTick + ' != 0');
    if(phase !== 'duelReady') fail('respawn begin left phase ' + phase + " != 'duelReady'");
    if(level !== 1 || !players) fail('respawn rebuilt wrong world (level ' + level + ', players ' + !!players + ')');
    if((_netSess.epoch|0) !== 1) fail('respawn go did not adopt epoch 1');
    if(!_duelNetHold) fail('respawn cleared the net hold (the NEXT death would rebuild locally)');
    ok('go {why:respawn} rebuilds the same level at tick 0 and keeps the hold armed');

    // HOST: the duelHalt event (dispatched through the one drainSimEvents switch) opens the
    // boundary -- epoch bump + go {why:'respawn'} carrying the CURRENT level -- and a
    // duplicate halt folds into the one-boundary guard instead of double-bumping.
    _netSess.role = 'host'; _netSess.lvlPending = false;
    _netBurstThenStart = (s, then)=>then(0);   // the clock burst is proven elsewhere
    const ep0 = _netSess.epoch|0;
    sent.length = 0;
    simEvents.push({ t:'duelHalt' }); drainSimEvents();
    let gos = sent.filter(m=>m.t==='go' && !m.a);
    if(gos.length !== 1) fail('host halt shipped ' + gos.length + ' gos != 1');
    if(gos[0].why !== 'respawn') fail('host halt shipped why ' + gos[0].why + " != 'respawn'");
    if((gos[0].epoch|0) !== ep0+1) fail('respawn go epoch ' + gos[0].epoch + ' != ' + (ep0+1));
    if((gos[0].lvl|0) !== 1) fail('respawn go re-ships lvl ' + gos[0].lvl + ' != current level 1');
    if(!_netSess.lvlPending) fail('respawn boundary did not arm the one-boundary guard');
    simEvents.push({ t:'duelHalt' }); drainSimEvents();
    if(sent.filter(m=>m.t==='go' && !m.a).length !== 1) fail('duplicate halt opened a second boundary');
    if((_netSess.epoch|0) !== ep0+1) fail('duplicate halt bumped the epoch again');
    ok('host answers ONE duelHalt with one respawn boundary; duplicates fold');

    // A duelHalt surfacing during a rollback REPLAY still dispatches (the replay filter
    // exempts it): this death exists only because a late input rewrote the past, so the
    // replay emit is the ONLY emit -- swallowed, nobody would ever open the boundary.
    _netSess.lvlPending = false;
    _replaying = true;
    simEvents.push({ t:'duelHalt' }); drainSimEvents();
    _replaying = false;
    if(sent.filter(m=>m.t==='go' && !m.a).length !== 2) fail('replay-borne duelHalt was swallowed (no boundary opened)');
    ok('a duelHalt emitted inside a rollback replay still opens the boundary');

    // THE FIELD FREEZE (regression): a halt landing while ANOTHER boundary holds the
    // one-boundary guard (a recovery resume mid-flight) is refused -- with a one-shot
    // halt that refusal was final and both clients held in 'dying' forever. The
    // re-announced halt must open the respawn as soon as the guard clears.
    _netSess.lvlPending = true;    // a resume boundary is mid-flight
    const epW = _netSess.epoch|0; sent.length = 0;
    simEvents.push({ t:'duelHalt' }); drainSimEvents();
    if(sent.some(m=>m.t==='go' && !m.a)) fail('halt under a pending boundary opened a second one');
    if((_netSess.epoch|0) !== epW) fail('refused halt still bumped the epoch');
    _netSess.lvlPending = false;   // the resume boundary completed
    simEvents.push({ t:'duelHalt' }); drainSimEvents();   // the hold re-announces
    const gW = sent.filter(m=>m.t==='go' && !m.a);
    if(gW.length !== 1 || gW[0].why !== 'respawn') fail('re-announced halt did not open the respawn boundary');
    if((_netSess.epoch|0) !== epW+1) fail('retried respawn epoch ' + _netSess.epoch + ' != ' + (epW+1));
    ok('a halt refused under a pending boundary is retried by the re-announce (field freeze)');

    // Control -- LOCAL duel (no net flag): the death rebuilds immediately, no halt event.
    simCommand({ t:'startDuel', seed:77 });
    if(_duelNetHold) fail('local duel armed the net hold');
    simEvents.length = 0;
    phase = 'dying'; phaseAt = simNow; deathMsg = 'X';
    for(let i=0;i<DT+HELD;i++) update();
    if(phase === 'dying') fail('local duel death never rebuilt (held without a net session)');
    if(halts() !== 0) fail('local duel emitted duelHalt');
    ok('a local duel death still rebuilds immediately (control)');

    // Worker home: the respawn begin must cross the main->worker seam with the fresh anchor.
    globalThis.Worker = class { constructor(u){ this.url = u; } postMessage(m){ posts.push(m); } terminate(){} };
    _initWorker();
    if(!_useWorker()) fail('worker stub did not engage (_useWorker false)');
    _netSess.startPts = 123456;
    beginOnlineDuelRespawn(true);
    const wmsg = posts.find(p=>p.t==='duelRespawnNet');
    if(!wmsg) fail('worker home never received the respawn begin');
    if((wmsg.my|0) !== 0) fail('duelRespawnNet carried my ' + wmsg.my + ' != 0 (host)');
    if(wmsg.startPts !== 123456) fail('duelRespawnNet carried startPts ' + wmsg.startPts + ' != the negotiated anchor');
    ok('the worker begin carries the fresh anchor across the seam');
    _netSess.game = false;   // neuter armed begins + pending-tx retries before the VM winds down
} catch(e){ __R.err = (e && e.stack) || String(e); }
`);
