// A spectator's bootstrap is [sctx, checkpoint, tail]. The checkpoint is minted off the
// rollback ring -- and in the DEFAULT runtime that ring lives in sim-worker.js, while the
// spectator wire (net-spec.js) lives on main, whose own ring is never written in that home.
// So the mint is a round trip: main reserves the checkpoint's number and clears the tail
// buffer when it asks, holds the stream while the worker answers, and on landing fans out
// the checkpoint and then everything held behind it. Every spectator suite drives the
// in-process home (the harness has no Worker), so this is the only guard on that path.
// Run: node test/smoke-spec-worker.js
const { runTest } = require('./harness');

runTest('SMOKE-SPEC-WORKER', `
globalThis.__R = { steps: [], err: null };
try {
    const posts = [];   // main -> worker messages (the recording Worker stub below)
    const ok = (msg)=>{ __R.steps.push('  ok  ' + msg); };
    const fail = (msg)=>{ throw new Error(msg); };
    const link = (peer)=>{ const rx = []; return { peer, rx, dc:{ readyState:'open', send:(j)=>rx.push(JSON.parse(j)), close(){} },
                                                  pc:{ close(){} }, sub:false, kind:'out', dead:false, iceQ:[], rdOk:true }; };
    const types = (l)=>l.rx.map(e => e.t === 'sp' ? 'sp:' + e.m.t : e.t).join(' ');

    // A player feeder, hosting, on level 3 of a match its session says opened on level 1.
    _netSess = _netMkSess('2222c1e7', 'host');
    _netSess.game = true; _netSess.seed = 0xBEEF; _netSess.startPts = 0; _netSess.hearts = 3; _netSess.stakes = false; _netSess.lvl = 1;
    inGame = true;
    beginOnlineDuel(0xBEEF, true);
    for(let i = 0; i < 12; i++){ netTickPre(); update(); netTickPost(); }
    level = 3;

    // The bootstrap context names the level being PLAYED, read off the sim: a joiner's
    // session never learns a level boundary, and neither does a relay's booted context.
    if(_spCtxBuild().lvl !== 3) fail('player ctx names level ' + _spCtxBuild().lvl + ', the sim is on 3 (s.lvl is the level the match OPENED on)');
    _spOn = true; _spCtx = { t:'sctx', g:0, hops:1, pids:['1111c1e7','2222c1e7'], seed:0xBEEF, startPts:0, ep:0, hm:3, stakes:false, lvl:1, ws:null, names:null, look:null };
    const relayLvl = _spCtxBuild().lvl;
    _spOn = false; _spCtx = null;
    if(relayLvl !== 3) fail('relay ctx re-sent its booted level ' + relayLvl + ', the sim is on 3');
    ok('the bootstrap context names the level being played, from a player and from a relay');

    // In-process home (control): serve-open mints synchronously and the link leaves subscribed.
    const a = link('3333c1e7'); _spOut.push(a);
    _spServeOpen(a);
    if(types(a) !== 'sctx sp:rs') fail('in-process bootstrap: ' + types(a));
    if(a.sub !== true || a.tail) fail('in-process link not subscribed after its bootstrap');
    ok('in-process home: [sctx, rs] in one call, link subscribed (control)');

    // Worker home: the same feeder, now hosting its sim in the worker. Main's ring is empty
    // there (beginOnlineDuel only posts the start and resets the mirror), which is the bug
    // this suite exists for: the old code read it and minted nothing, silently.
    globalThis.Worker = class { constructor(u){ this.url = u; } postMessage(m){ posts.push(m); } terminate(){} };
    _initWorker();
    if(!_useWorker()) fail('worker stub did not engage');
    beginOnlineDuel(0xBEEF, true);
    if(!netWorkerDuelOn()) fail('worker duel not on');
    if(_rbRing.length) fail('main ring is not empty in the worker home: the control below would not be a control');
    a.rx.length = 0; a.sub = true;                // already subscribed from the in-process phase
    const b = link('4444c1e7'); _spOut.push(b);
    posts.length = 0;
    _spServeOpen(b);
    if(types(b) !== 'sctx') fail('worker-home bootstrap sent ' + types(b) + ' before the checkpoint landed');
    if(!posts.some(p => p.t === 'spCkpt')) fail('no checkpoint asked of the worker');
    if(b.sub || !b.tail) fail('a link waiting for its checkpoint must not be subscribed yet');
    if(!_spCkptReq) fail('no request pending');
    ok('worker home: the checkpoint is asked of the worker, the link waits unsubscribed');

    // While the worker answers, the stream is HELD: nothing reaches the subscribed link, and
    // the pushed envelope sits in the tail buffer behind the checkpoint being minted.
    _spTapOut({ t:'in', tk:12, l:[] });
    if(a.rx.length) fail('a subscribed link received an envelope while the checkpoint was in flight (it would outrank the checkpoint)');
    if(_spBuf.length !== 1) fail('held envelope not in the tail buffer: ' + _spBuf.length);
    ok('the stream is held behind the checkpoint being minted');

    // Landing: [rs, held tail] to everyone, the waiting link subscribed in between, and the
    // numbers in the order the dedup rule needs -- the checkpoint below everything after it.
    const rs = _rbFullState(_rbCloneSnap(_rbDuelSnap()), simTick + 1); rs.ep = _rbEpoch | 0;
    _spCkptLand(rs);
    if(types(b) !== 'sctx sp:rs sp:in') fail('waiting link got ' + types(b));
    if(types(a) !== 'sp:rs sp:in') fail('subscribed link got ' + types(a));
    if(!b.sub || b.tail) fail('waiting link not subscribed on landing');
    if(!(b.rx[1].n < b.rx[2].n)) fail('checkpoint n ' + b.rx[1].n + ' does not precede the tail n ' + b.rx[2].n);
    if(b.rx[1].m.lv !== 3 || !Array.isArray(b.rx[1].m.bars)) fail('checkpoint does not carry the level and the bars');
    if(b.rx[1].o !== getPlayerId()) fail('checkpoint does not name its line owner');
    if(_spCkptReq) fail('request still pending after landing');
    if(_spBuf.length !== 1) fail('the held envelope is the tail behind the checkpoint, got ' + _spBuf.length);
    ok('on landing: [rs, tail] to the waiting and the subscribed link alike, numbered in order');

    // An empty answer (the ring was just cleared by a boundary) releases the hold, leaves the
    // waiting link waiting, and the housekeeping tick asks again on its behalf.
    const c = link('5555c1e7'); _spOut.push(c);
    posts.length = 0; a.rx.length = 0;
    _spServeOpen(c);
    _spTapOut({ t:'in', tk:13, l:[] });
    _spCkptLand(null);
    if(!c.tail || c.sub) fail('an empty answer subscribed the waiting link');
    if(types(a) !== 'sp:in') fail('an empty answer did not release the held stream: ' + types(a));
    if(_spCkptAt !== 0) fail('an empty answer must clear the throttle so the next ask is not held back');
    posts.length = 0;
    _spTick();
    if(!posts.some(p => p.t === 'spCkpt')) fail('the tick did not ask again for the waiting link');
    _spCkptLand(rs);
    if(types(c) !== 'sctx sp:rs') fail('waiting link after the re-ask got ' + types(c));
    ok('an empty answer releases the hold, the tick asks again, the waiting link is served');

    // A stale answer (nothing asked) changes nothing.
    a.rx.length = 0;
    _spCkptLand(rs);
    if(a.rx.length) fail('a stale answer was fanned out');
    ok('an answer nobody asked for is dropped');

    // A relay whose UPSTREAM checkpoint arrives while its worker is still minting: the
    // upstream one is newer and outranks it -- waiting links take it, the answer is dropped.
    const d = link('6666c1e7'); _spOut.push(d);
    _spCtx = _spCtxBuild(); _spOn = true; _spGen = 0; _spSeen = 40; _spLine = '1111c1e7';   // a primary: booted on a player's context, serving on
    posts.length = 0;
    _spServeOpen(d);
    if(!_spCkptReq || _spCkptReq.n !== 40) fail('relay reserved n ' + (_spCkptReq && _spCkptReq.n) + ', expected its consumed high-water mark 40');
    const up = { t:'sp', g:0, n:41, o:'1111c1e7', p:0, m:rs };
    _spBootT = null; _spOn = true;
    const feed = { peer:'1111c1e7', sub:true, dc:{ readyState:'open' } };
    _spOnFeedMsg(feed, JSON.stringify(up));
    if(_spCkptReq) fail('an upstream checkpoint did not cancel the mint in flight');
    if(types(d) !== 'sctx sp:rs' || d.rx[1].n !== 41) fail('waiting link did not take the upstream checkpoint: ' + types(d));
    if(!d.sub || d.tail) fail('waiting link not subscribed by the upstream checkpoint');
    ok('a relay serves an upstream checkpoint that lands first, and drops the answer behind it');

    specStop('');
    _spDisarm();
} catch(e){ __R.err = (e && e.stack) || String(e); }
`);
