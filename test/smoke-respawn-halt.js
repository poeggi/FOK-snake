// An ONLINE duel death is a negotiated boundary, not a local rebuild: the sim (armed with
// net:true at the online entry, _duelNetHold) HOLDS in 'dying' once the death animation has
// run and emits ONE 'duelHalt'; the host answers by opening a respawn boundary (epoch bump +
// clock burst + go {why:'respawn'}) and BOTH clients rebuild the same level at tick 0 from
// the fresh shared start_pts. If each sim rebuilt on its own (the local-duel path), the two
// boards would re-anchor on unsynchronized clocks -- the exact drift the boundary burst
// exists to cancel. Local duels keep the immediate rebuild (no flag), and a duelHalt fired
// inside a rollback REPLAY must still dispatch: a death introduced by a late input crosses
// DEATH_DUR only in the replay, and swallowing that one-shot would strand both clients in
// 'dying' forever. Run: node test/smoke-respawn-halt.js
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
    // parks in 'dying' with exactly one duelHalt -- no local rebuild, however long the
    // boundary negotiation takes.
    beginOnlineDuel(0xABCD, false);
    if(!_duelNetHold) fail('online entry did not arm the net hold');
    phase = 'dying'; phaseAt = simNow; deathMsg = 'X';   // the duelStep death outcome, minus the collision
    for(let i=0;i<80;i++) update();                      // DEATH_DUR is 54 ticks: well past the crossing
    if(phase !== 'dying') fail('held sim left dying -> ' + phase + ' (rebuilt locally)');
    if(halts() !== 1) fail('crossing emitted ' + halts() + ' duelHalt != 1');
    for(let i=0;i<20;i++) update();
    if(halts() !== 1) fail('held ticks re-emitted duelHalt (' + halts() + ')');
    ok('online death holds in dying and emits exactly one duelHalt');

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

    // Control -- LOCAL duel (no net flag): the death rebuilds immediately, no halt event.
    simCommand({ t:'startDuel', seed:77 });
    if(_duelNetHold) fail('local duel armed the net hold');
    simEvents.length = 0;
    phase = 'dying'; phaseAt = simNow; deathMsg = 'X';
    for(let i=0;i<80;i++) update();
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
