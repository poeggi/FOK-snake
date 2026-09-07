// Tournament PACING smoke (docs/API.md "tourney", "after_ms", Pacing; contract 4.4): what
// a client is allowed to have in flight at the one moment it is busiest -- the millisecond a
// match is dealt. The server measured the old behaviour on a live 3-client tournament: ONE
// client had three requests open, tournament.php and start.php left in the SAME millisecond,
// and both waited 128ms for a PHP worker while the pool mean over that window was 2.5ms. The
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
  globalThis.__sig = (d)=>_ttOnSignal(d);
  globalThis.__floor = TT_STATE_MS;
  globalThis.__stateAt = (v)=>{ if(v !== undefined) _ttStateAt = v; return _ttStateAt; };
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
      // The safety-net read starts out DUE, so the only thing that can silence the next tick
      // is the sheet's own stamp -- a client that never stamps is not quietly passed here.
      _ttStateAt = -(TT_STATE_MS + 1);
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
        // The housekeeping tick is the safety net under the signal stream, and it is what
        // used to repeat the question -- at the one moment the client is busiest, beside the
        // start.php the very same sheet provokes.
        S.__tick();
        await settle();
        eq(S.__states().length, 0, 'the tick must not ask the server to repeat the sheet');
        // ...and it is the SHEET that bought that silence, not a dead tick: age the floor out
        // and the same tick asks again, exactly as it must when no sheet has landed.
        S.__stateAt(S.__stateAt() - S.__floor - 1);
        S.__tick();
        await settle();
        eq(S.__states().length, 1, 'past the floor the safety net still reads state back');
    });

    await check('a doubtful sheet is read back anyway: the floor is not a gag', async () => {
        S.__reset();
        S.__sig(S.__sheet());
        await settle();
        S.__take();
        // An offer from a peer we hold no sheet for, one millisecond after a sheet that put
        // the floor down. A match must never start undressed, so this one asks regardless.
        eq(S.tourneyOfferOk('feedface'), false, 'an offer no sheet authorises is not answered');
        await settle();
        eq(S.__states().length, 1, 'and it forces the read the floor would otherwise hold back');
    });

    // ---- the lane --------------------------------------------------------------------
    await check('every tournament round trip asks for the paced lane', async () => {
        S.__reset();
        S.__owe();                      // a result still owed: the other tournament.php caller
        S.__tick();
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
