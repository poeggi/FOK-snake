// Tournament PACING smoke (docs/API.md "tourney", "after_ms", Pacing; contract 4.4): what
// a client is allowed to have in flight at the one moment it is busiest -- the millisecond a
// match is dealt. The server measured the old behaviour on a live 3-client tournament: ONE
// client had three requests open, tournament.php and start.php left in the SAME millisecond,
// and both waited 128ms for a worker while the pool mean over that window was 2.5ms. The
// host was idle; the client was queueing behind itself.
//
// Three rules come out of that, and every one of them fails SILENTLY -- the match still
// starts, it just starts late, and nothing on the client says why:
//   * ONE EVENT, ONE CALL. A roles sheet carries the whole match, so it IS a state read and
//     nothing may ask the server to repeat it -- least of all the housekeeping tick, which
//     used to ask at exactly that millisecond.
//   * after_ms is this seat's slice of the server's tourney_after_ms, and it applies to the
//     CALL, not to the render: the screen goes up now, the request the sheet provokes waits.
//   * every tournament round trip asks for the paced lane, so the deal burst is one request
//     behind another instead of two side by side.
// Run: node test/smoke-tourney.js
const { runInGame } = require('./harness');

const HOOKS = `
;(function(){
  // The harness has no fetch, and everything under test here goes out through the one
  // function tourney.js posts with -- so that is what the suite replaces, and fetch is left
  // as a tripwire for anything that finds another way to the wire.
  globalThis.fetch = ()=>{ throw new Error('stub _netPostRes, not fetch'); };
  cfg.offline = false;
  globalThis.__posts = [];
  _netPostRes = async (path, body, bg)=>{
      __posts.push({ path:path, action:String((body||{}).action||''), bg:bg });
      const j = { ok:true };
      return { status:200, json:j, body:j, err:'' };
  };
  // The two outbound calls a roles sheet provokes, recorded rather than made: what is under
  // test is WHEN they go, not what they negotiate.
  globalThis.__offers = [];
  globalThis.__watches = [];
  _netRtcOffer = (peer)=>{ __offers.push(String(peer)); };
  specWatch = (peer)=>{ __watches.push(String(peer)); };

  globalThis.__me = getPlayerId();
  globalThis.__peer = 'deadbeef';
  globalThis.__paced = true;            // the lane a tournament round trip must ask for
  globalThis.__take = ()=>__posts.splice(0);
  globalThis.__states = ()=>__posts.filter(p => p.action === 'state');
  globalThis.__tick = ()=>_ttTick();
  globalThis.__doubt = ()=>tourneyMailboxLost();
  // The poll edge, run inside the game scope: a failing poll marks the mailbox DOWN, the next
  // success is it coming BACK, and that hands the tournament its doubt -- once per outage.
  globalThis.__pollEdge = async ()=>{
      let fired = 0; const oTml = tourneyMailboxLost; tourneyMailboxLost = ()=>{ fired++; };
      const oGet = _netGet, oHold = _netPace.hold, oPhase = phase;
      _netPace.hold = false; _netPollTick = 0; _netPollBusy = false; _netPollDown = false; phase = 'duelLobby';
      const seq = [];
      _netGet = async ()=>null;                      await _netPollOnce(); await _netPollOnce(); seq.push(fired);
      _netGet = async ()=>({ ok:true, signals:[] }); await _netPollOnce(); await _netPollOnce(); seq.push(fired);
      _netGet = async ()=>null;                      await _netPollOnce(); seq.push(fired);
      _netGet = async ()=>({ ok:true, signals:[] }); await _netPollOnce(); seq.push(fired);
      _netGet = oGet; _netPace.hold = oHold; tourneyMailboxLost = oTml; _netPollDown = false; phase = oPhase;
      return seq;
  };
  globalThis.__sig = (d)=>_ttOnSignal(d);
  // CREATE while already hosting: the hooks the replace flow is driven through.
  globalThis.__off = ()=>{ _tt = null; _ttHold(''); _ttUi.busy = false; _ttUi.ask = null; _ttUi.msg = ''; _netSrvMin = 8; phase = 'tourneySetup'; };   // where CREATE is actually pressed
  globalThis.__setBack = (o)=>{ _ttBack = o; };
  globalThis.__back = ()=>_ttBack;
  globalThis.__tt = ()=>_tt;
  globalThis.__ui = ()=>_ttUi;
  globalThis.__post = (fn)=>{ _netPostRes = fn; };
  globalThis.__answer = (yes)=>{ quitConfirmSel = yes ? 0 : 1; UI_INPUT.tourneyQuit.confirm(); };
  globalThis.__esc = ()=>{ UI_INPUT.tourneyQuit.back(); };
  globalThis.__cursor = ()=>_tt && _tt.cursor;
  globalThis.__want = ()=>_ttWant;
  globalThis.__phase = ()=>phase;
  globalThis.__owe = ()=>_ttReport('n1', 'win', [1,0]);
  globalThis.__disarm = ()=>_ttDisarm();
  // A tournament this client is already in, as a state read-back leaves it. Everything after
  // this arrives as a PUSHED event, which is the case the server measured.
  globalThis.__reset = ()=>{
      _tt = null; _ttNid = ''; _ttRolesAt = 0; _ttEngAt = 0; _ttDone = ''; _ttWant = null;
      _ttAfter = 0; _ttPlayNid = ''; _ttWatchNid = ''; _ttOverAt = 0;
      _ttRep = null; _ttRepBusy = false;
      if(_ttAfterT){ clearTimeout(_ttAfterT); _ttAfterT = null; }
      inGame = false; phase = 'tourneyBracket';
      _ttAdopt({ tid:'t1', state:'running', round:1, players:[{id:__me},{id:__peer}] });
      __posts.length = 0; __offers.length = 0; __watches.length = 0;
  };
  // The sheet the server pushes when a match is dealt: the whole match, in one event.
  globalThis.__sheet = (o)=>Object.assign({ event:'roles', tid:'t1', nid:'n1', round:1,
      hm:3, lvl:1, stakes:false, players:[__me, __peer], feeder:__me,
      primaries:[], secondaries:[], names:{}, you:'play' }, o || {});
})();
`;

const S = runInGame(HOOKS);
const steps = [];
const eq = (a, b, what) => { if (a !== b) throw new Error(what + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); };
const settle = ms => new Promise(r => setTimeout(r, ms || 0));
async function check(name, fn) {
    try { await fn(); steps.push('  ok   ' + name); }
    catch (e) { steps.push('  FAIL ' + name + ': ' + (e && e.message || e)); throw e; }
}

(async () => {
try {
    // ---- one event, one call ---------------------------------------------------------
    await check('a roles sheet IS the state read, not a reason to ask for one', async () => {
        S.__reset();
        S.__sig(S.__sheet());
        await settle();
        eq(S.__states().length, 0, 'the sheet itself must ask the server for nothing');
        eq(S.__cursor(), 'n1', 'and it must have been adopted whole');
        // The housekeeping tick reads nothing, ever: the server keeps its own deadlines on the
        // poll every participant sends, so a tick has no reason left to ask.
        S.__tick(); S.__tick(); S.__tick();
        await settle();
        eq(S.__states().length, 0, 'the tick must not ask the server to repeat the sheet');
        // ...and it is not a dead client: the mailbox coming back after an outage is the one
        // moment a push may have been lost, and that reads the whole picture once.
        S.__doubt();
        await settle();
        eq(S.__states().length, 1, 'a mailbox that was down and is back must read state once');
    });

    await check('a mailbox outage hands the tournament ONE doubt read, when it comes back', async () => {
        S.__reset();
        const seq = await S.__pollEdge();
        eq(seq.join(','), '0,1,1,2', 'fired after [down,down] [back,back] [down] [back]');
    });

    await check('a doubtful sheet is read back anyway', async () => {
        S.__reset();
        S.__sig(S.__sheet());
        await settle();
        S.__take();
        // An offer from a peer we hold no sheet for, one millisecond after a sheet. A match
        // must never start undressed, so this one asks regardless.
        eq(S.tourneyOfferOk('feedface'), false, 'an offer no sheet authorises is not answered');
        await settle();
        eq(S.__states().length, 1, 'and it forces a read');
    });

    // ---- CREATE while already hosting (server 4.8: create + replace) ------------------
    const createStub = (onReplace)=>async (path, body)=>{
        __posts.push({ path, action:String((body||{}).action||''), replace:!!(body||{}).replace, bg:true });
        if((body||{}).action !== 'create') return { status:200, json:{ ok:true }, body:{ ok:true }, err:'' };
        if(!body.replace) return { status:409, json:null, body:{ ok:false, error:'already hosting' }, err:'already hosting' };
        return onReplace();
    };
    const created = ()=>({ status:200, json:{ ok:true, tid:'t9', code:'NEWONE', stakes:false, max:8 }, body:{ ok:true }, err:'' });
    let __posts;
    await check('CREATE while already hosting asks first, and NO leaves everything as it was', async () => {
        S.__off(); __posts = S.__posts;
        S.__setBack({ tid:'t0', code:'ABCDEF', state:'running', host:S.__me, players:[] });
        S.__post(createStub(created));
        S.__take();
        await S.tourneyCreate(false);
        eq(S.__phase(), 'tourneyQuit', 'the 409 opens the question');
        eq(S.__ui().ask && S.__ui().ask.kind, 'replace', 'and it is the replace question');
        eq(S.__ui().ask.code, 'ABCDEF', 'naming the tournament this device hosts');
        eq(S.__ui().ask.running, true, 'and that it is running');
        eq(S.__take().filter(p => p.action === 'create').map(p => p.replace).join(','), 'false', 'one plain create went out, no replace yet');
        S.__answer(false);
        await settle();
        eq(S.__phase(), 'tourneySetup', 'NO is the settings it was asked from');
        eq(S.__ui().ask, null, 'the question is gone');
        eq(S.__take().length, 0, 'and nothing was sent');
        eq(!!S.__tt(), false, 'nothing was created');
        eq(S.__back() && S.__back().code, 'ABCDEF', 'the way back to the old one stands');
    });

    await check('YES re-sends the create with replace:true, and the new one is adopted', async () => {
        S.__off();
        S.__setBack({ tid:'t0', code:'ABCDEF', state:'open', host:S.__me, players:[] });
        S.__post(createStub(created));
        await S.tourneyCreate(false);
        eq(S.__ui().ask.running, false, 'an open lobby is not a running tournament');
        S.__take();
        S.__answer(true);
        await settle(5);
        const posts = S.__take().filter(p => p.action === 'create');
        eq(posts.map(p => p.replace).join(','), 'true', 'exactly one create, with replace:true');
        eq(S.__tt() && S.__tt().code, 'NEWONE', 'the new tournament is the one held');
        eq(S.__back(), null, 'the old one is no longer a way back');
        eq(S.__ui().ask, null, 'the question is gone');
    });

    await check('a 409 to the replace is an older server: the plain message, nothing ended', async () => {
        S.__off();
        S.__setBack({ tid:'t0', code:'ABCDEF', state:'running', host:S.__me, players:[] });
        S.__post(createStub(()=>({ status:409, json:null, body:{ ok:false, error:'already hosting' }, err:'already hosting' })));
        await S.tourneyCreate(false);
        S.__answer(true);
        await settle(5);
        eq(S.__ui().msg, 'YOU ALREADY HOST ONE', 'the message that was there before');
        eq(S.__phase(), 'tourneySetup', 'no second question');
        eq(!!S.__tt(), false, 'nothing adopted');
        eq(S.__back() && S.__back().code, 'ABCDEF', 'the old one still stands, and is still the way back');
    });

    await check('a 429 to the replace shows the wait and reports nothing as ended', async () => {
        S.__off();
        S.__setBack({ tid:'t0', code:'ABCDEF', state:'running', host:S.__me, players:[] });
        S.__post(createStub(()=>({ status:429, json:null, body:{ ok:false, error:'create cooldown', retry_after:7 }, err:'create cooldown' })));
        await S.tourneyCreate(false);
        S.__answer(true);
        await settle(5);
        eq(S.__ui().msg, 'TOO SOON - WAIT 7S', 'the cooldown, charged before anything is ended');
        eq(!!S.__tt(), false, 'nothing adopted');
        eq(S.__back() && S.__back().code, 'ABCDEF', 'the old one is intact');
    });

    await check('ESC on the question is NO, and a device that does not know the old one asks in general', async () => {
        S.__off();
        S.__setBack(null);
        S.__post(createStub(created));
        await S.tourneyCreate(false);
        eq(S.__ui().ask.code, '', 'no code to name');
        eq(S.__ui().ask.running, null, 'running cannot be ruled out');
        S.__esc();
        eq(S.__phase(), 'tourneySetup', 'ESC is NO');
        eq(S.__ui().ask, null, 'the question is gone');
    });

    await check('the players of the replaced tournament are told why it ended', async () => {
        S.__reset();
        S.__sig({ event:'lobby', tid:'t1', state:'abandoned', reason:'host opened a new one' });
        eq(!!S.__tt(), false, 'dropped');
        eq(S.__ui().msg, 'HOST STARTED A NEW TOURNAMENT', 'in the words of the reason given');
        for(const [why, msg] of [['host left','THE HOST LEFT'], ['host ended it','THE HOST ENDED IT'], ['everyone left','EVERYONE LEFT'], ['ended by the operator','ENDED BY THE OPERATOR']]){
            S.__reset();
            S.__sig({ event:'lobby', tid:'t1', state:'abandoned', reason:why });
            eq(S.__ui().msg, msg, 'reason ' + why);
        }
        S.__reset();
        S.__sig({ event:'lobby', tid:'t1', state:'abandoned' });
        eq(S.__ui().msg, 'TOURNAMENT ABANDONED', 'and the plain case reads as before');
        S.__post(async (path, body)=>{ __posts.push({ path, action:String((body||{}).action||''), bg:true }); const j = { ok:true }; return { status:200, json:j, body:j, err:'' }; });
    });

    // ---- the lane --------------------------------------------------------------------
    await check('every tournament round trip asks for the paced lane', async () => {
        S.__reset();
        S.__owe();                      // a result still owed: the other tournament.php caller
        S.__tick(); S.__doubt();        // the report, and a mailbox-back read
        await settle();
        const posts = S.__take();
        eq(posts.some(p => p.action === 'result'), true, 'the result report went out');
        eq(posts.some(p => p.action === 'state'), true, 'and so did the state read');
        eq(posts.every(p => p.path === '/api/tournament.php'), true, 'both on tournament.php');
        eq(posts.every(p => p.bg === S.__paced), true,
           'a round trip that skips the gate can leave beside start.php: ' + JSON.stringify(posts.map(p => p.bg)));
    });

    // ---- after_ms delays the CALL ----------------------------------------------------
    await check('after_ms delays the offer the sheet provokes, never the sheet', async () => {
        S.__reset();
        S.__sig(S.__sheet({ after_ms: 60 }));
        // Everything local has already happened: the screen, the match parameters, the grant.
        eq(S.__phase(), 'tourneyCeremony', 'the ceremony goes up the moment the news lands');
        eq(!!S.__want(), true, 'and the match is dressed at once, so an early offer is answerable');
        eq(S.__want().peer, S.__peer, 'against the peer the sheet names');
        eq(S.__offers.length, 0, 'but the request it provokes waits out this seat s slice');
        await settle(140);
        eq(S.__offers.length, 1, 'and is then made -- delayed, never dropped');
        eq(S.__offers[0], S.__peer, 'to the peer on the sheet');
        eq(S.__states().length, 0, 'and it is still one event, one call');
    });

    await check('a seat told to wait 0 offers in the same breath', async () => {
        S.__reset();
        S.__sig(S.__sheet({ after_ms: 0 }));
        eq(S.__offers.length, 1, 'seat 0 is the one the spread does not delay');
    });

    await check('a watcher owes the same wait as a player', async () => {
        S.__reset();
        S.__sig(S.__sheet({ you: 'spectate', feeder: S.__peer, after_ms: 60 }));
        eq(S.__watches.length, 0, 'the feed request waits out the slice too');
        await settle(140);
        eq(S.__watches.length, 1, 'and is then asked for');
        eq(S.__watches[0], S.__peer, 'of the feeder the sheet names');
    });

    await check('a delayed call for a node that moved on is dropped, not made late', async () => {
        S.__reset();
        S.__sig(S.__sheet({ after_ms: 60 }));
        eq(S.__offers.length, 0, 'held, as above');
        // The node settles while the offer waits: a walkover, a peer that reported first, a
        // round that ended. Offering into it now would connect to a match nobody is playing.
        S.__sig({ event: 'result', tid: 't1', nid: 'n1', winner: S.__peer });
        await settle(140);
        eq(S.__offers.length, 0, 'a finished node is not engaged by a timer that outlived it');
    });

    S.__disarm();
    console.log(steps.join('\n'));
    console.log('\nSMOKE-TOURNEY PASSED');
    process.exit(0);
} catch (e) {
    S.__disarm();
    console.log(steps.join('\n'));
    console.log('\nSMOKE-TOURNEY FAIL: ' + (e && e.stack || e));
    process.exit(1);
}
})();
