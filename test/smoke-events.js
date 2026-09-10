// EVENTS smoke (server API 4.11): the deep link and the scanner, the 53-byte QR
// budget, and the derived event state. Everything here is the CLIENT half of
// FOK-server docs/API.md "Events (4.11)".
// Run: node test/smoke-events.js
const { runInGame } = require('./harness');

const DRIVER = `
;(async function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const log = (m) => R.steps.push(m);
  const U = 'https://poeggi.github.io/FOK-snake/';
  try {
    // ---- the third hash pattern -------------------------------------------
    // ONE regex serves both entry points -- the boot hash (game.js) and the
    // camera (input.js _scanHit) -- so this is the parser itself, not a copy of
    // it. The two code lengths are the printed key (16) and the live pass (6),
    // and nothing here has to tell them apart: both go out as \`code\`.
    const hit = (s) => EVENT_HASH_RE.exec(s);
    let m = hit(U + '#event=K7QM.H3KM9P');
    if(!m || m[1]!=='K7QM' || m[2]!=='H3KM9P') throw 'pass link did not parse: '+JSON.stringify(m&&m.slice(1));
    m = hit(U + '#event=K7QM.ABCDEFGHJKMNPQRS');
    if(!m || m[2].length!==16) throw '16-char key link did not parse';
    if(hit(U + '#event=K7QM.H3KM9')) throw 'a 5-char code must not parse';
    if(hit(U + '#event=K7QM.H3KM9PQ')) throw 'a 7-char code must not parse';
    if(hit(U + '#event=K7Q.H3KM9P')) throw 'a 3-char eid must not parse';
    if(hit(U + '#event=K7QMX.H3KM9P')) throw 'a 5-char eid must not parse';
    if(hit(U + '#event=K7QM.H3KM9P&x=1')) throw 'a trailing query must not parse (anchored)';
    if(hit(U + '#event=K0QM.H3KM9P')) throw '0 is outside A-Z2-9';
    if(hit(U + '#event=K1QM.H3KM9P')) throw '1 is outside A-Z2-9';
    if(hit(U + '#event=k7qm.h3km9p')) throw 'lowercase is not a code';
    // THE CLASS IS THE CONTRACT'S, NOT THE ALPHABET'S. A-Z2-9 is what API.md
    // states, and it is one character wider than the codes actually use: the
    // unambiguous alphabet also drops I, L and O. Kept as stated on purpose --
    // this is a SHAPE filter, and what a code really is belongs to the server,
    // which answers a wrong one 404 like every other wrong one. Narrowing it
    // here would make the client the second opinion on somebody else's alphabet.
    if(!hit(U + '#event=KOQM.H3KM9P')) throw 'the shape filter is the contract regex, not the alphabet';
    // The other two hashes are not events, and an event is not one of them.
    if(hit(U + '#friend=00ff00ee')) throw 'a friend link must not read as an event';
    if(hit(U + '#tourney=K7QMX2')) throw 'a tournament link must not read as an event';
    if(EVENT_EID_LEN!==4 || EVENT_PASS_LEN!==6 || EVENT_KEY_LEN!==16) throw 'identifier lengths moved';
    log('hash parser ok: 4+1+(6|16), the contract shape class, anchored, never the other two links');

    // ---- THE 53-BYTE BUDGET ------------------------------------------------
    // The live pass QR is rendered HERE, by a fixed version-3 byte-mode encoder,
    // and the identifiers are the length they are because of it: 42 bytes of
    // URL + 4 + 1 + 6 = 53, with not one byte spare. If this fails, the wire
    // shape has to change, not the encoder.
    const payload = U + '#event=K7QM.H3KM9P';
    if(payload.length !== 53) throw 'pass payload is '+payload.length+' bytes, not 53';
    if(U.length + '#event='.length !== 42) throw 'the URL prefix is not 42 bytes';
    const q = qrMatrix(payload);
    if(!q || q.size !== 29) throw 'the pass payload did not render at version 3';
    // ...and one byte more must be refused rather than silently truncated.
    let over = false;
    try { qrMatrix(payload + 'X'); } catch(e){ over = true; }
    if(!over) throw '54 bytes must not encode: the budget has no spare';
    log('53-byte budget ok: the pass QR renders at version 3, 54 bytes is refused');

    // ---- the state is DERIVED, never read ----------------------------------
    // starts/ends are unix ms on the same clock as now, and nothing is pushed
    // when either moment arrives -- so a scheduled event flips on this function
    // and on nothing else. Ended is terminal and outranks everything; a schedule
    // outranks the mode it was set on.
    const T = 1784182417000;
    globalThis.__evNow = T;
    netPts = () => globalThis.__evNow;
    const st = (o) => eventState(o);
    if(st({state:'active'}) !== 'active') throw 'unscheduled active';
    if(st({state:'paused'}) !== 'paused') throw 'unscheduled paused';
    if(st({state:'upcoming'}) !== 'upcoming') throw 'unscheduled upcoming';
    if(st({state:'ended', starts:T-1000}) !== 'ended') throw 'ended is terminal';
    if(st({state:'active', starts:T+1}) !== 'upcoming') throw 'before starts is upcoming';
    if(st({state:'active', starts:T}) !== 'active') throw 'at starts it is active';
    if(st({state:'active', starts:T-1000, ends:T}) !== 'ended') throw 'at ends it is ended';
    if(st({state:'active', starts:T-1000, ends:T+1}) !== 'active') throw 'before ends it is active';
    // A PAUSE outranks a schedule that says active, and an END outranks the pause.
    if(st({state:'paused', starts:T-1000}) !== 'paused') throw 'a paused scheduled event is paused';
    if(st({state:'paused', starts:T-1000, ends:T}) !== 'ended') throw 'ends outranks paused';
    // No synced clock: there is nothing to derive against, so the server's word stands.
    netPts = () => null;
    if(st({state:'active', ends:T-1}) !== 'active') throw 'without a clock the mode stands';
    log('state derived ok: ended outranks the schedule, the schedule outranks the mode');

    // ---- the achievement is server-carried ---------------------------------
    // \`ev_<eid>\` is not in the shipped table and never could be: the operator
    // names it when they open the event. Only the DEFINITION is kept locally,
    // and deliberately outside the backup manifest.
    achUnlocked = {}; achEvents = {};
    const _d0 = cfg.diff; cfg.diff = 0;   // EASY gates what you earned by PLAYING
    _evGrantAch({ id:'ev_K7QM', name:'NIGHT OWL', desc:'Joined Snake Night' });
    if(!achUnlocked['ev_K7QM']) throw 'an event achievement must not be gated by difficulty';
    const defs = achEventDefs();
    if(!defs['ev_K7QM'] || defs['ev_K7QM'].name !== 'NIGHT OWL') throw 'the definition was not kept';
    cfg.diff = _d0;
    // Garbage never becomes an achievement, and neither does somebody else's id shape.
    _evGrantAch({ id:'ev_lower', name:'X', desc:'X' });
    _evGrantAch({ id:'first_gem', name:'X', desc:'X' });
    _evGrantAch(null);
    if(defs['ev_lower'] || defs['first_gem']) throw 'only ev_<EID> ids may be stored here';
    // The vault carries the UNLOCK and not the DEFINITION, which is the whole
    // design: membership is the server's and comes back through \`events\`, the
    // achievement's own picture through every member's \`state\`.
    const snap = JSON.stringify(_saveSnapshot());
    if(snap.indexOf('ev_K7QM') < 0) throw 'the unlock itself rides the backup like any other';
    if(snap.indexOf('NIGHT OWL') >= 0) throw 'the event achievement DEFINITION must stay out of the backup';
    achUnlocked = {}; achEvents = {};
    log('achievement ok: server-carried, difficulty-free, ev_<EID> only, outside the vault');

    // ---- and it is drawn on the hidden page, only once earned --------------
    // Secret means secret: an event nobody joined leaves no trace anywhere, and
    // the page it lands on is the one that is already only reachable by finding
    // something. Both kinds belong there -- neither is won by playing well.
    achUnlocked = {}; achEvents = {};
    if(achEventList().length) throw 'nothing earned, nothing listed';
    if(achEggFound()) throw 'an empty page must stay unreachable';
    _evGrantAch({ id:'ev_K7QM', name:'NIGHT OWL', desc:'Joined Snake Night' });
    const evl = achEventList();
    if(evl.length !== 1 || evl[0].name !== 'NIGHT OWL') throw 'the earned one is listed: '+JSON.stringify(evl);
    // An operator names no icon and the card still draws: that is the only part of
    // an event achievement the server can leave out.
    if(!evl[0].icon || !evl[0].icon.d) throw 'a card with no icon must fall back to one';
    if(evl[0].icon !== EVENT_ACH_ICON) throw 'the fallback is the shared default';
    _evGrantAch({ id:'ev_ABCD', name:'DAY OWL', desc:'x', icon:{p:{A:'#fff'},d:['A','A','A','A','A','A','A','A']} });
    if(achEventList()[1].icon === EVENT_ACH_ICON) throw 'a named icon must be kept';
    // ...and an event achievement opens the hidden page on its own, without an egg.
    if(!achEggFound()) throw 'an event achievement must make the page reachable';
    // The DEFINITION alone is not an achievement: only the unlock puts a card up.
    achUnlocked = {};
    if(achEventList().length) throw 'a definition without an unlock is not earned';
    // The grid is the limit, not what was earned -- cards past the last row would
    // fall off the canvas silently. Drawing many must not throw and must not grow.
    achEvents = {}; achUnlocked = {};
    for(let i = 0; i < 40; i++){
        const id = 'ev_' + 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[i % 31] + 'AA' + (i % 10);
        achEventPut(id, { name:'E'+i, desc:'d' }); achUnlocked[id] = 1000 + i;
    }
    achPage = 0; drawAchievements();
    achUnlocked = {}; achEvents = {}; achPage = 1;
    log('egg page ok: earned events only, a default icon when none is named, the grid is the cap');

    // ---- the list is the only thing that knows we are in an event ----------
    // Show the entry while it is non-empty, hide it when it is empty. A member
    // who was removed finds the row simply gone -- there is no other notice and
    // there is not meant to be one.
    const rowNames = () => multiRows().map(r => r.t);
    _evList = [];
    if(rowNames().indexOf('EVENTS') >= 0) throw 'no rows means no entry';
    _netEvApply([{ eid:'K7QM', name:'Snake Night', state:'active', you:{state:'member'}, members:14 }]);
    if(rowNames().indexOf('EVENTS') < 0) throw 'a row must put the entry there';
    if(!eventAny()) throw 'eventAny reads the list and nothing else';
    // An answer WITHOUT the key is a server that does not serve events, or a 204
    // that carries nothing -- neither of which is an empty roster.
    _netEvApply(undefined); _netEvApply(null); _netEvApply({});
    if(rowNames().indexOf('EVENTS') < 0) throw 'an absent key must leave the list standing';
    // An EMPTY ARRAY is the real answer, and it is how a removal arrives.
    _netEvApply([]);
    if(rowNames().indexOf('EVENTS') >= 0) throw 'an empty list must take the entry away';
    log('menu entry ok: comes and goes with the list, an absent key is not an empty one');

    // ---- and the indices never drift --------------------------------------
    // The row that comes and goes is exactly why the draw and the input read ONE
    // list: a hard-coded index would send BACK somewhere else the first time it
    // appeared. Walking the menu with and without it must land on the same rows.
    simNow=100000; _splashLeftAt=-1e9;
    const walk = () => {
        const out = [];
        phase='multiplayer'; multiSel=0;
        const rows=multiRows();
        for(let i=0;i<rows.length+1;i++){
            out.push(multiSel<rows.length ? rows[multiSel].go : 'BACK');
            handleKey('ArrowDown',()=>{});
        }
        return out;
    };
    _evList = [];
    const without = walk();
    if(without.join(',') !== 'duel,tourney,myid,addfriend,friends,BACK') throw 'unexpected rows without events: '+without;
    _netEvApply([{ eid:'K7QM', name:'x', state:'active', you:{state:'member'} }]);
    const withEv = walk();
    if(withEv.join(',') !== 'duel,tourney,myid,addfriend,friends,events,BACK') throw 'unexpected rows with events: '+withEv;
    // The row is appended, so nothing that was already there moved -- and BACK is
    // still the row past the end, which is the one an index would have got wrong.
    for(let i=0;i<5;i++) if(without[i] !== withEv[i]) throw 'the existing rows moved: '+withEv;
    _evList = []; phase='menu'; multiSel=0;
    log('menu indices ok: one row list drives the draw and the input, order unchanged');

    // ---- the reserved signal asks, it never applies ------------------------
    // Every one of the four says something moved; not one of them is a state
    // change we may take on its own word. A scheduled event pushes nothing at all.
    let reads = 0;
    const _read0 = eventRead; eventRead = () => { reads++; return Promise.resolve(true); };
    _evEid = 'K7QM'; _ev = { eid:'K7QM', you:{state:'member'} }; phase = 'eventPage';
    _evOnSignal({ event:'state', eid:'K7QM', state:'paused' });
    if(reads !== 1) throw 'a state signal must read the server, not adopt its word';
    if(_ev.state === 'paused') throw 'the signal must not be applied directly';
    _evOnSignal({ event:'tourney', eid:'K7QM', tid:'x', code:'K7QMX2' });
    if(reads !== 2) throw 'a tourney signal refreshes the open page';
    _evOnSignal({ event:'state', eid:'OTHR', state:'ended' });
    if(reads !== 2) throw 'a signal for another event must not refresh this page';
    _evPending = {};
    _evOnSignal({ event:'request', eid:'K7QM', from:'c0ffee42' });
    if(!eventPendingAt('K7QM')) throw 'a request must badge the event it names';
    if(reads !== 2) throw 'a request is a nudge, not a re-read';
    _evOnSignal({ event:'accepted', eid:'K7QM' });
    if(reads !== 3) throw 'an approval must read state -- that is where the achievement is';
    _evOnSignal(null); _evOnSignal({ event:'state' });
    if(reads !== 3) throw 'a payload with no eid is not a signal';
    eventRead = _read0; _evPending = {}; _ev = null; _evEid = ''; phase = 'menu';
    log('event signal ok: four payloads, each an ask, never an adopt');

    // ---- asked for on the screens that show it, and nowhere else -----------
    // The flag rides a request that was going out anyway, so a screen nobody is
    // looking at costs the server nothing. Same rule as the roster and the
    // announce, and the poll and the hello have to agree about it.
    {
        const _oGet=_netGet, _oFetch=globalThis.fetch, _oPost=_netPost;
        const _oPace=_netPace, _oHold=_netPollHoldEnd;
        globalThis.fetch=()=>({});                 // _netOk(): online, or every check below is vacuous
        let _u=null, _body=null;
        _netGet=async (p)=>{ _u=p; return null; };
        _netPost=async (p,b)=>{ _body=b; return null; };
        _netPace={hold:true}; _netFrSince=0; _netFlWant=false; _netTlAt=Date.now(); _netPollHoldEnd=0;
        const due=()=>{ _netEvAt=Date.now()-NET_EVENTS_MS-1; };
        const poll=(ph)=>{ _u=null; _netPollBusy=false; phase=ph; _netPollOnce(); return _u||''; };
        const hello=(ph)=>{ _body=null; _netHelloBusy=false; phase=ph; _netHello(); return _body||{}; };

        for(const ph of ['multiplayer','eventChooser','eventPage','eventMembers','eventQr','eventMonitor']){
            due();
            if(!/[?&]ev=1(&|$)/.test(poll(ph))) throw 'the poll must ask for events on '+ph;
            if(hello(ph).events !== true) throw 'the hello must ask for events on '+ph;
        }
        for(const ph of ['menu','friends','duelLobby','tourneyLobby','settings']){
            due();
            if(/[?&]ev=/.test(poll(ph))) throw 'the poll must NOT ask for events on '+ph;
            if('events' in hello(ph)) throw 'the hello must NOT ask for events on '+ph;
        }
        // ...AND IT RIDES A TICK OF ITS OWN. poll.php never 204s a request that
        // asked for rows (ev ANSWERS AT ONCE, exactly like fl and tl), so on every
        // poll it would cut every hold short and spin an event screen into a hot
        // loop -- the same trap the tournament announce is spaced for.
        _netEvAt = Date.now();
        if(/[?&]ev=/.test(poll('eventPage'))) throw 'the event rows must not ride every poll';
        due();
        if(!/[?&]ev=1(&|$)/.test(poll('eventPage'))) throw 'the event tick must ask once it is due';
        // The tick is spent only when an answer actually came back: a failed poll
        // must not cost the screen its next read.
        _netEvAt=0; _netGet=async(p)=>{ _u=p; return null; };
        poll('eventPage');
        if(_netEvAt !== 0) throw 'a poll that never answered must not spend the tick';
        _netGet=_oGet; _netPost=_oPost; globalThis.fetch=_oFetch;
        _netPace=_oPace; _netPollHoldEnd=_oHold; _netPollBusy=false; _netHelloBusy=false; phase='menu';
    }
    log('request shape ok: events rides the hello, and a poll tick of its own, on the six screens that show it');

    // ---- the page offers only what the server would allow -----------------
    // A screen that offers what the next request will refuse is a screen that
    // lies, so the rows are derived from the same three facts the server checks:
    // the row state, who the organizer is, and whether the event runs on a clock.
    const gos = (o) => { _ev = o; _evEid = o && o.eid || ''; return eventRows().map(r=>r.go); };
    const ME = getPlayerId();
    const mem = (x) => Object.assign({ eid:'K7QM', name:'n', state:'active',
                                       you:{ state:'member', organizer:false } }, x||{});
    // A PENDING row gets nothing at all -- it sees the public face and no more.
    if(gos(mem({ you:{state:'pending'} })).length) throw 'a pending row must be offered nothing';
    // A MONITOR may call state and monitor and NOTHING else, so it is offered nothing else.
    if(gos(mem({ you:{state:'monitor'} })).length) throw 'a monitor must be offered nothing else';
    // An ordinary member: leave, and nothing that is the organizer's.
    if(gos(mem()).join(',') !== 'pass,members,leave') throw 'an active member gets the QR, the roster and leave: '+gos(mem());
    // A live tournament is a way IN for anybody in the room; opening one is the organizer's.
    const TT = { tid:'t1', code:'K7QMX2', state:'open', players:3, max:8 };
    if(gos(mem({tourney:TT})).join(',') !== 'tourney,pass,members,leave') throw 'a member gets a way into the live one: '+gos(mem({tourney:TT}));
    if(gos(mem()).indexOf('newtourney') >= 0) throw 'only the organizer opens one';
    // The organizer of an UNSCHEDULED event drives it by hand -- and cannot leave
    // its own room, because leaving would abandon what it is running.
    const org = (x) => mem(Object.assign({ you:{state:'member',organizer:true} }, x||{}));
    if(gos(org()).join(',') !== 'newtourney,pass,members,pause,end,access') throw 'active organizer rows: '+gos(org());
    // ...and not a SECOND one while the first stands: the cap is the server's, and one
    // live per host is the same cap an ordinary tournament has.
    if(gos(org({tourney:TT})).indexOf('newtourney') >= 0) throw 'no second tournament while one is live';
    if(gos(org({tourney:TT}))[0] !== 'tourney') throw 'the live one leads';
    // A PAUSED event takes no new tournaments, and an ENDED one never will again.
    if(gos(org({state:'paused'})).indexOf('newtourney') >= 0) throw 'a paused event opens no tournament';
    if(gos(org({state:'ended'})).indexOf('newtourney') >= 0) throw 'an ended event opens no tournament';
    // ...but a tournament RUNNING at the moment of the end plays on and is still
    // reachable: it began while the event was live, and a clock must not stop it.
    if(gos(org({state:'ended', tourney:TT})).indexOf('tourney') < 0) throw 'a running tournament survives the end';
    if(gos(org({state:'paused'})).join(',') !== 'members,run,end,access') throw 'a paused event mints no pass: '+gos(org({state:'paused'}));
    if(gos(org()).indexOf('leave') >= 0) throw 'the organizer cannot leave its own event';
    // A SCHEDULED event walks itself: run/pause/end are 409 'scheduled', so they
    // are not offered. The door still is -- it is not on the clock.
    if(gos(org({starts:1})).join(',') !== 'newtourney,pass,members,access') throw 'a scheduled event offers no hand verbs: '+gos(org({starts:1}));
    // ENDED is frozen and terminal. Nothing is offered to anybody but the way out.
    if(gos(org({state:'ended'})).join(',') !== 'members') throw 'an ended event is still readable, and nothing else: '+gos(org({state:'ended'}));
    if(gos(mem({state:'ended'})).join(',') !== 'members,leave') throw 'an ended event mints no pass, and stays readable';
    _ev = null; _evEid = '';
    log('page rows ok: pending and monitor get nothing, the organizer cannot leave, a schedule takes the hand verbs');

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }

  // THE LANES THAT TALK TO THE WIRE. Kept apart and handed to the runner as a
  // promise, because a suite whose async body is not awaited prints its banner
  // before it has asserted anything -- which is the whole reason the runner
  // demands a banner in the first place.
  globalThis.__async = (async function(){
    if(R.err) return;
    try {
      const mem = (x) => Object.assign({ eid:'K7QM', name:'n', state:'active',
                                         you:{ state:'member', organizer:false } }, x||{});
      // _evOk() is the same gate every other online path uses, and the harness is
      // a dead browser: with no fetch at all every verb below would no-op and each
      // assertion would pass by never running. Make it online first.
      const _oFetch=globalThis.fetch, _oOff=cfg.offline;
      globalThis.fetch=()=>({}); cfg.offline=false;
      if(!_evOk()) throw 'the suite must be online or every verb check is vacuous';
      const _oPost=_evPost, _oRead=eventRead;
      let sent=null, reads=0;
      _evPost=async(a,x)=>{ sent={a,x}; return { json:{ok:true}, status:200, body:{ok:true} }; };
      eventRead=async()=>{ reads++; return true; };
      _ev = mem({ closed:false }); _evEid='K7QM'; _evUi.busy=false;
      await eventAccess();
      if(!sent || sent.a!=='access' || sent.x.closed !== true) throw 'the door flips to the OTHER state: '+JSON.stringify(sent);
      if(reads !== 1) throw 'a verb must re-read rather than adopt its own answer';
      _ev = mem({ closed:true }); await eventAccess();
      if(sent.x.closed !== false) throw 'and back again';
      // A refusal names the reason in the event's own words and changes nothing.
      _evPost=async()=>({ json:null, status:409, body:{error:'scheduled'} });
      _ev = mem(); reads=0;
      await eventRun();
      if(reads !== 0) throw 'a refused verb must not re-read';
      if(!/SCHEDULE/.test(_evUi.msg)) throw 'a 409 scheduled must say so: '+_evUi.msg;
      // LEAVING drops the row and the page with it. There is nothing local to
      // clear afterwards, because there was never anything local to begin with.
      _evPost=async()=>({ json:{ok:true}, status:200, body:{ok:true} });
      _netEvApply([{ eid:'K7QM', name:'n', state:'active', you:{state:'member'} }]);
      _ev = mem(); _evEid='K7QM'; _evUi.busy=false;
      await eventLeave();
      if(_ev !== null) throw 'leaving must drop the page';
      if(eventAny()) throw 'leaving must drop the row from the list';
      if(phase !== 'multiplayer') throw 'the last event left lands on MULTIPLAYER, got '+phase;
      // ---- an event tournament is an ORDINARY tournament ------------------
      // eid is a tag on it and a membership check on the way in. There is no
      // second state machine here and there must never be one.
      {
        const _oSetup=tourneySetupOpen, _oPost2=_netPostRes, _oMin=_netSrvMin;
        // netTourneyOk() is the same gate the menu row uses, and it needs a server
        // that answers 4.1 or better. Without it every create below would no-op and
        // each assertion would pass by never running.
        _netSrvMin = NET_API_BUILT_MINOR;
        if(!netTourneyOk()) throw 'the suite must look online to a tournament, or the create checks are vacuous';
        // EVERY post is recorded, not the last one: a create is followed by the reads
        // it provokes, and the last body on the wire is one of those.
        let posts=[];
        const created=()=>posts.filter(x=>String(x.action||'')==='create');
        _netPostRes=async(path,b)=>{ posts.push(b||{}); return { json:{ok:true, tid:'t9', code:'K7QMX2'}, status:200, body:{} }; };
        _evEid='K7QM'; _ev=mem({ you:{state:'member',organizer:true} });
        // The create is the NORMAL dialog, opened with the room it belongs to.
        tourneySetupOpen=(eid)=>{ _ttUi.eid=String(eid||''); };
        eventTourneyNew();
        if(_ttUi.eid !== 'K7QM') throw 'the create must carry the room it was opened from';
        tourneySetupOpen=_oSetup;
        // ...and that eid reaches the wire on the create itself.
        _tt=null; _ttUi.busy=false; _ttUi.eid='K7QM'; posts=[];
        await tourneyCreate(false, 1, false);
        if(created().length !== 1) throw 'exactly one create: '+created().length;
        if(created()[0].eid !== 'K7QM') throw 'create must post the eid: '+JSON.stringify(created()[0]);
        // A create started from the ORDINARY tournament screen inherits no room.
        _tt=null; _ttUi.busy=false; posts=[];
        tourneySetupOpen();
        if(_ttUi.eid !== '') throw 'an ordinary create must carry no eid';
        await tourneyCreate(false, 1, false);
        if(created().length !== 1) throw 'exactly one ordinary create';
        if('eid' in created()[0]) throw 'an ordinary create must not post one: '+JSON.stringify(created()[0]);
        _netPostRes=_oPost2; _netSrvMin=_oMin; _tt=null; _ttUi.busy=false; _ttUi.eid='';
      }
      // A lobby carrying an eid is marked in the announce -- it reached that list at
      // all only because we are in the event, and the room is why it is there.
      {
        const _oList=_netTourneys;
        _netTourneys=[{ tid:'t1', code:'AAAAAA', host_name:'x', players:1, max:8 },
                      { tid:'t2', code:'BBBBBB', host_name:'y', players:1, max:8, eid:'K7QM' }];
        _tt=null; phase='tourneyLobby';
        const notes=tourneyRows().filter(r=>r.name).map(r=>String(r.note));
        if(notes.length !== 2) throw 'both lobbies must be listed: '+notes;
        if(/EVENT/.test(notes[0])) throw 'an ordinary lobby is not marked';
        if(!/EVENT/.test(notes[1])) throw 'an event lobby must say so: '+notes[1];
        _netTourneys=_oList; phase='menu';
      }
      R.steps.push('event tournaments ok: eid rides the create and only that create, the announce marks the room');

      // ---- the pass rotates locally, on the synced clock ------------------
      // ONE call gives six slots -- a minute of QR -- and nothing polls: the
      // codes are already in hand and the screen picks the one that is live.
      // step and valid are ADMIN-CONFIGURABLE and ride the answer, so nothing
      // here may hard-code 10 and 20.
      const T0 = 1784182410000;
      let passReqs = 0;
      _evPost=async(a)=>{ if(a==='pass'){ passReqs++; return { json:{ ok:true, step:10, valid:20,
          slots:[0,1,2,3,4,5].map(i=>({ at:T0+i*10000, code:'SLOT0'+i })) }, status:200, body:{} }; }
          return { json:{ok:true}, status:200, body:{} }; };
      _evEid='K7QM'; _evPass=null; _evPassBusy=false;
      await eventPassRead();
      if(!_evPass || _evPass.slots.length !== 6) throw 'six slots, one call';
      if(_evPassStep() !== 10000 || _evPassValid() !== 20000) throw 'step and valid come off the answer';
      const at = (ms) => { const sl = eventPassSlot(T0+ms); return sl ? sl.code : ''; };
      // THE NEWEST SLOT THAT HAS BEGUN. The windows overlap on purpose -- a code
      // stays good for two slots -- and when two are live the newer one is the
      // one with longer left, so it is the one to show.
      if(at(0) !== 'SLOT00') throw 'at the first slot: '+at(0);
      if(at(9900) !== 'SLOT00') throw 'at 9.9s the first slot still stands: '+at(9900);
      if(at(10000) !== 'SLOT01') throw 'at 10s the second begins: '+at(10000);
      if(at(19900) !== 'SLOT01') throw 'at 19.9s the second still stands: '+at(19900);
      if(at(20000) !== 'SLOT02') throw 'at 20s the third begins: '+at(20000);
      if(at(-1) !== '') throw 'before the first slot there is nothing to show';
      // The last slot dies at its own at+valid, and a dead code is not shown: the
      // door would refuse it, and a QR that cannot be scanned is worse than none.
      if(at(50000) !== 'SLOT05') throw 'the last slot: '+at(50000);
      if(at(69999) !== 'SLOT05') throw 'the last slot lives its full validity: '+at(69999);
      if(at(70000) !== '') throw 'past the last slot nothing is shown';
      // The bar is the life left in the code ON SCREEN, not in the minute.
      if(Math.abs(eventPassLeft(T0) - 1) > 0.001) throw 'a fresh code is full';
      if(Math.abs(eventPassLeft(T0+15000) - 0.75) > 0.001) throw 'five seconds into the second slot leaves three quarters: '+eventPassLeft(T0+15000);
      // ...and the bar empties only on the LAST slot: every earlier one is
      // superseded at full life by the next, which is what the overlap is for.
      if(eventPassLeft(T0+69999) > 0.001) throw 'the last code is spent the instant before it dies: '+eventPassLeft(T0+69999);
      if(eventPassLeft(T0+70000) !== 0) throw 'a dead code has nothing left';
      // A MISSING step/valid falls back rather than dividing by nothing, and an
      // absurd one is bounded -- neither is a second opinion on the server's
      // numbers, both stop a wrong one turning this screen into a request loop.
      _evPass={ slots:_evPass.slots };
      if(_evPassStep() !== EV_STEP_MS_DEF || _evPassValid() !== EV_VALID_MS_DEF) throw 'absent step/valid must fall back';
      _evPass={ step:0, valid:0, slots:[] };
      if(_evPassStep() < EV_STEP_MS_MIN) throw 'a zero step must be bounded';
      // ...and the re-ask happens BEFORE the last slot lapses, never after: a
      // screen that waited for the gap would show nothing across it.
      _evPass={ step:10, valid:20, slots:[0,1,2,3,4,5].map(i=>({ at:T0+i*10000, code:'S'+i })) };
      phase='eventQr'; passReqs=0;
      netPts = () => T0;                // a whole minute in hand
      _evPassTick();
      if(passReqs !== 0) throw 'a fresh minute must not re-ask';
      netPts = () => T0 + 39999;        // still one step clear of the last slot
      _evPassTick();
      if(passReqs !== 0) throw 'the re-ask is due one step before the LAST slot begins, not sooner';
      netPts = () => T0 + 40000;        // one step before the last slot begins
      _evPassTick();
      if(passReqs !== 1) throw 'the next minute is asked for before the last slot lapses';
      // ...which leaves the last slot's whole life as runway, so the screen never
      // shows a gap while the answer is in flight.
      if(T0 + 70000 - (T0 + 40000) < 20000) throw 'the re-ask must have more than one validity of runway';
      // Leaving takes the codes with it: they are minted from the clock and worth
      // nothing to a screen that is closed.
      eventPassLeave();
      if(_evPass !== null) throw 'the codes must not outlive the screen';
      if(phase !== 'eventPage') throw 'the QR screen returns to the page';
      _evPass=null; _evPassBusy=false; _evEid='';
      R.steps.push('pass ok: six slots one call, newest live slot at 9.9/10/19.9/20s, re-asked before the last lapses');

      // ---- the roster is a VIEW, never a list this client keeps -----------
      // Read on every open, re-read after every verb, dropped when the screen
      // closes. Pending rows sort to the top because they are the only ones
      // waiting on a decision.
      const ROSTER = [
        { id:'aaaaaaaa', name:'ANNA',  state:'member',  organizer:true,  friend:'accepted' },
        { id:'bbbbbbbb', name:'BEN',   state:'banned',  organizer:false, friend:'none' },
        { id:'cccccccc', name:'CARA',  state:'member',  organizer:false, friend:'none' },
        { id:'dddddddd', name:'DIRK',  state:'pending', organizer:false, friend:'pending' },
      ];
      let asked=null;
      _evPost=async(a,x)=>{ asked={a,x};
        return a==='members' ? { json:{ok:true, members:ROSTER}, status:200, body:{} }
                             : { json:{ok:true}, status:200, body:{} }; };
      _ev = mem({ you:{state:'member',organizer:true} }); _evEid='K7QM'; _evUi.busy=false;
      _evMem=null;
      await eventMembersRead();
      if(!_evMem || _evMem.length !== 4) throw 'the roster did not land';
      const order = eventMemberRows().map(m=>m.name).join(',');
      if(order !== 'DIRK,ANNA,CARA,BEN') throw 'pending first, banned last: '+order;
      // The row's own 'friend' field picks the label, and disables the button
      // where the server has already answered the question.
      if(eventFriendLabel(ROSTER[0]) !== 'FRIENDS') throw 'an accepted friendship reads FRIENDS';
      if(eventFriendLabel(ROSTER[3]) !== 'REQUEST SENT') throw 'a pending request reads REQUEST SENT';
      if(eventFriendLabel(ROSTER[2]) !== 'ASK TO BE FRIENDS') throw 'a stranger can be asked';
      if(eventFriendCan(ROSTER[0]) || eventFriendCan(ROSTER[3])) throw 'an answered question must not be askable again';
      if(!eventFriendCan(ROSTER[2])) throw 'a stranger must be askable';
      // ...and never ourselves, whatever the field says.
      if(eventFriendCan({ id:getPlayerId(), friend:'none' })) throw 'nobody asks themselves to be friends';
      // ONE verb over a row, and it re-reads rather than patching what it hoped for.
      asked=null; _evUi.busy=false;
      await eventRoster('dddddddd','member');
      if(!asked || asked.a!=='members') throw 'a roster verb must be followed by a re-read, got '+(asked&&asked.a);
      // Leaving the screen drops the view: there is nothing local to go stale.
      eventMembersLeave();
      if(_evMem !== null) throw 'the roster must not outlive its screen';
      if(phase !== 'eventPage') throw 'the roster returns to the page';
      _evMem=null; _evMemSel=0; _evMemAsk=null;
      R.steps.push('roster ok: a view not a copy, pending first, the friend field picks the label, every verb re-reads');

      _evPost=_oPost; eventRead=_oRead; globalThis.fetch=_oFetch; cfg.offline=_oOff;
      _ev=null; _evEid=''; _evUi.busy=false; _evUi.msg=''; _evList=[];
      R.steps.push('page verbs ok: the door flips to the other state, every verb re-reads, a refusal names itself, leaving drops the row');
    } catch(e) { R.err = String(e && e.stack || e); }
  })();
})();
`;

(async () => {
    const S = runInGame(DRIVER);
    const R = S.__R;
    try { await S.__async; } catch (e) { if (R) R.err = String(e && e.stack || e); }
    if (R && R.steps) console.log(R.steps.join('\n'));
    if (!R || R.err) { console.log('\nSMOKE-EVENTS FAIL: ' + (R ? R.err : 'no result')); process.exit(1); }
    console.log('\nSMOKE-EVENTS PASSED');
})();
