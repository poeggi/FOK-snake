// An outage (a reconnect, or a peer found a whole ring behind) heals over a FULL resync
// burst -- but the pair is then still ticking on the clock anchor from BEFORE the outage,
// carrying whatever drift the outage accumulated. The burst settling therefore opens a
// RESUME boundary (go {why:'resume'}): a fresh clock burst, a startPts that maps the
// CURRENT tick onto the verified clock, and an epoch bump -- and NOTHING else. No rebuild,
// no tick reset, no ring clear: the sims never stopped, so what they hold IS the state.
// The routine single-rs desync repair must NOT open this boundary (a re-anchor storm under
// jitter), and only the host authors boundaries -- a joiner settle asks with req{why:
// 'resume'}. Run: node test/smoke-recovery-resume.js
const { runTest } = require('./harness');

runTest('SMOKE-RECOVERY-RESUME', `
globalThis.__R = { steps: [], err: null };
try {
    const posts = [];   // main -> worker messages (recording Worker stub, engaged last)
    const sent = [];    // wire datagrams as the peer would receive them
    const ok = (msg)=>{ __R.steps.push('  ok  ' + msg); };
    const fail = (msg)=>{ throw new Error(msg); };
    const reqs = ()=> sent.filter(m=>m.t==='req' && m.why==='resume' && !m.a);
    const gos  = ()=> sent.filter(m=>m.t==='go'  && m.why==='resume' && !m.a);
    const dc = { readyState:'open', send:(j)=>sent.push(JSON.parse(j)), close(){} };
    _netSess = { epoch:0, startPts:0, game:true, dc, lastSent:0, iceQ:[], role:'guest' };
    _netSync = { ofs: 100000 - _wall(), rtt: 10, at: Date.now() };   // netPts() ~ 100000
    _netBurstThenStart = (s, then)=>then(0);   // the clock burst is proven elsewhere

    // Boot a joiner and run the real tick path until the rollback ring holds a frontier
    // (netTickPre snapshots every RB_SNAP_EVERY ticks; the resync sender reads the ring).
    beginOnlineDuel(0xBEEF, false);
    for(let i=0;i<70;i++){ netTickPre(); update(); }
    if(!_rbRing.length) fail('tick path never filled the rollback ring');

    // CONTROL -- the routine single-rs desync repair (send=1, full flag untouched, exactly
    // what the repair sites arm): the burst settles without opening anything.
    sent.length = 0;
    _rbResyncSend = 1;
    netTickPre(); update();
    if(!sent.some(m=>m.t==='rs')) fail('single-rs repair never sent its rs');
    if(reqs().length || gos().length) fail('a single-rs repair opened a resume boundary');
    ok('a routine single-rs repair settles without a resume boundary (control)');

    // JOINER settle: a FULL burst (armed only by reconnect / peer-a-ring-behind) drains over
    // the real decrement site and the settle asks the host for the re-anchor -- once.
    sent.length = 0;
    _rbArmFullResync();
    for(let i=0;i<6;i++){ netTickPre(); update(); }
    if(sent.filter(m=>m.t==='rs').length < 4) fail('full burst sent fewer rs than RB_RESYNC_BURST');
    if(reqs().length !== 1) fail('joiner settle shipped ' + reqs().length + ' req{resume} != 1');
    if((reqs()[0].epoch|0) !== (_netSess.epoch|0)) fail('req{resume} epoch ' + reqs()[0].epoch + ' != session epoch');
    ok('a full burst settling as joiner asks req{why:resume} exactly once');
    _netSess.tx = null;   // the pending ask: answered out-of-band in this harness

    // A transition already in flight is itself a re-anchoring boundary: the settle stays quiet.
    sent.length = 0;
    _netSess.tx = { pkt:{ t:'req', why:'level' }, since:_wall(), lastAt:_wall(), tries:1 };
    _rbArmFullResync();
    for(let i=0;i<6;i++){ netTickPre(); update(); }
    if(reqs().length || gos().length) fail('a settle under a pending transition still opened a boundary');
    ok('a settle while a transition is in flight is suppressed');
    _netSess.tx = null;

    // HOST settle: the same drain opens the resume boundary itself -- epoch bump, startPts
    // mapping the CURRENT tick onto the clock (in the past: the armed begin fires at once,
    // nobody rewinds), and the adopt touches neither the sim nor the ring.
    _netSess.role = 'host'; _netSess.lvlPending = false;
    const ep0 = _netSess.epoch|0;
    const ring0 = _rbRing.length;
    sent.length = 0;
    _rbArmFullResync();
    const tick0 = simTick;
    for(let i=0;i<6;i++){ netTickPre(); update(); }
    if(gos().length !== 1) fail('host settle shipped ' + gos().length + ' go{resume} != 1');
    const g = gos()[0];
    if((g.epoch|0) !== ep0+1) fail('resume go epoch ' + g.epoch + ' != ' + (ep0+1));
    if(g.startPts > netPts()) fail('resume startPts lands in the future (would stall the begin)');
    const mapped = (netPts() - g.startPts) / TICK_MS;
    if(Math.abs(mapped - simTick) > 8) fail('resume startPts maps tick ' + mapped.toFixed(1) + ', sim is at ' + simTick);
    if(simTick !== tick0 + 6) fail('resume boundary moved simTick (' + tick0 + '+6 -> ' + simTick + ')');
    if(_rbRing.length < ring0) fail('resume boundary shrank the ring (' + ring0 + ' -> ' + _rbRing.length + ')');
    if(_netSess.lvlPending) fail('armed begin never fired (startPts was not in the past)');
    if(_netSess.startPts !== g.startPts) fail('session startPts diverged from the shipped go');
    if((_rbEpoch|0) !== ep0+1) fail('resume begin did not adopt the epoch mirror (' + _rbEpoch + ')');
    ok('host settle opens ONE resume boundary: epoch+1, current-tick startPts, sim untouched');
    _netSess.tx = null;   // the pending go: echoed out-of-band in this harness

    // JOINER receives the go {why:'resume'}: echo, adopt anchor + epoch -- and nothing else.
    _netSess.role = 'guest';
    const pre = { tk: simTick, ph: phase, lv: level, pl: players, ring: _rbRing.length };
    const ep2 = (_netSess.epoch|0) + 5;
    const anchor = Math.round(netPts() - simTick * TICK_MS);
    sent.length = 0;
    _netHandleMsg(JSON.stringify({ t:'go', why:'resume', seed:0xBEEF, startPts:anchor, epoch:ep2, lvl:1, bth:0 }));
    if(!sent.some(m=>m.t==='go' && m.a===1)) fail('resume go was not echoed');
    if(_netSess.startPts !== anchor) fail('joiner did not adopt the resume anchor');
    if((_netSess.epoch|0) !== ep2 || (_rbEpoch|0) !== ep2) fail('joiner did not adopt the resume epoch (' + _netSess.epoch + '/' + _rbEpoch + ')');
    if(simTick !== pre.tk) fail('resume adopt moved simTick (' + pre.tk + ' -> ' + simTick + ')');
    if(phase !== pre.ph) fail('resume adopt changed phase (' + pre.ph + ' -> ' + phase + ')');
    if(level !== pre.lv || players !== pre.pl) fail('resume adopt rebuilt the world');
    if(_rbRing.length !== pre.ring) fail('resume adopt touched the ring');
    ok('go {why:resume} adopts anchor+epoch only: no rebuild, no rewind, ring intact');

    // HOST req routing: a matching-epoch ask opens the boundary; a stale one is refused
    // (that peer is behind a boundary already opened -- its pending go re-serves it).
    _netSess.role = 'host'; _netSess.lvlPending = false; _netSess.tx = null;
    const ep3 = _netSess.epoch|0;
    sent.length = 0;
    _netHandleMsg(JSON.stringify({ t:'req', why:'resume', epoch:ep3 }));
    if(gos().length !== 1) fail('matching-epoch req{resume} opened ' + gos().length + ' boundaries != 1');
    _netSess.tx = null; _netSess.lvlPending = false;
    _netHandleMsg(JSON.stringify({ t:'req', why:'resume', epoch:ep3 }));   // now one epoch behind the bump above
    if(gos().length !== 1) fail('a stale-epoch req{resume} opened another boundary');
    if(!sent.some(m=>m.t==='req' && m.a===1)) fail('the refused req was not echoed');
    ok('host opens on a matching-epoch req{resume}; a stale one is echoed but refused');
    _netSess.tx = null;

    // The worker home's settle crosses the seam as a duelRecovered duel event and lands in
    // the same _netResyncSettled (here: joiner -> the ask).
    _netSess.role = 'guest';
    sent.length = 0;
    simEvents.push({ t:'duelRecovered' }); drainSimEvents(); simEvents.length = 0;
    if(reqs().length !== 1) fail('duelRecovered dispatched ' + reqs().length + ' req{resume} != 1');
    ok('a duelRecovered event lands in _netResyncSettled through the one event switch');
    _netSess.tx = null;

    // Worker home of the adopt: resumeOnlineDuel pushes the fresh anchor over the ordinary
    // duelClock message -- the worker core adopts ofs+startPts with no reset of its own.
    globalThis.Worker = class { constructor(u){ this.url = u; } postMessage(m){ posts.push(m); } terminate(){} };
    _initWorker();
    if(!_useWorker()) fail('worker stub did not engage (_useWorker false)');
    _wDuel = true;
    _netSess.startPts = 424242;
    resumeOnlineDuel();
    const wmsg = posts.find(p=>p.t==='duelClock');
    if(!wmsg) fail('worker home never received the resume clock push');
    if(wmsg.startPts !== 424242) fail('duelClock carried startPts ' + wmsg.startPts + ' != the resume anchor');
    if(typeof wmsg.ofs !== 'number') fail('duelClock carried no clock offset');
    ok('the worker adopt rides the ordinary duelClock push with the resume anchor');
    _netSess.game = false;   // neuter armed begins + pending-tx retries before the VM winds down
} catch(e){ __R.err = (e && e.stack) || String(e); }
`);
