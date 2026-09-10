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
    // ONE capture: the code exactly as scanned, dot and all, because that is what
    // join posts. The two shapes spend the same 11 characters differently.
    let m = hit(U + '#event=K7QM.H3KM9P');
    if(!m || m[1] !== 'K7QM.H3KM9P') throw 'a PASS keeps its dot and its eid: '+JSON.stringify(m&&m[1]);
    m = hit(U + '#event=ABCDEFGHJKM');
    if(!m || m[1] !== 'ABCDEFGHJKM') throw 'a KEY is 11 characters and no dot: '+JSON.stringify(m&&m[1]);
    // THE DOT IS THE ONLY THING that tells them apart, and the lengths are exact.
    if(hit(U + '#event=K7QM.H3KM9')) throw 'a 5-char pass must not parse';
    if(hit(U + '#event=K7QM.H3KM9PQ')) throw 'a 7-char pass must not parse';
    if(hit(U + '#event=K7Q.H3KM9P')) throw 'a 3-char eid must not parse';
    if(hit(U + '#event=ABCDEFGHJK')) throw 'a 10-char key must not parse';
    if(hit(U + '#event=ABCDEFGHJKMN')) throw 'a 12-char key must not parse';
    // ...and 4.11's 16-character key is gone: it was 63 bytes, which no version 3
    // code holds, which is the whole reason the key was shortened.
    if(hit(U + '#event=K7QM.ABCDEFGHJKMNPQRS')) throw 'the 4.11 key shape must no longer parse';
    if(hit(U + '#event=K7QM.H3KM9P&x=1')) throw 'a trailing query must not parse (anchored)';
    if(hit(U + '#event=k7qm.h3km9p')) throw 'lowercase is not a code';
    // The class is the CONTRACT'S (A-Z2-9), one character wider than the alphabet,
    // which also drops I, L and O. Deliberate: this is a SHAPE filter, and what a
    // code really is belongs to the server, which answers a wrong one 404.
    if(!hit(U + '#event=KOQM.H3KM9P')) throw 'the shape filter is the contract regex, not the alphabet';
    // The other two hashes are not events, and an event is not one of them.
    if(hit(U + '#friend=00ff00ee')) throw 'a friend link must not read as an event';
    if(hit(U + '#tourney=K7QMX2')) throw 'a tournament link must not read as an event';
    if(EVENT_EID_LEN!==4 || EVENT_PASS_LEN!==6 || EVENT_KEY_LEN!==11) throw 'identifier lengths moved';
    if(EVENT_EID_LEN + 1 + EVENT_PASS_LEN !== EVENT_CODE_LEN) throw 'a dotted pass must spend the whole budget';
    if(EVENT_KEY_LEN !== EVENT_CODE_LEN) throw 'a key must spend the same budget';
    log('hash parser ok: one 11-char budget, the dot tells a pass from a key, never the other two links');

    // ---- THE 53-BYTE BUDGET ------------------------------------------------
    // The live pass QR is rendered HERE, by a fixed version-3 byte-mode encoder,
    // and the identifiers are the length they are because of it: 42 bytes of
    // URL + 4 + 1 + 6 = 53, with not one byte spare. If this fails, the wire
    // shape has to change, not the encoder.
    if(U.length + '#event='.length !== 42) throw 'the URL prefix is not 42 bytes';
    // BOTH shapes, because the server now renders the poster at this same version 3
    // too -- level L, mask 0, the one shape this client's decoder reads. A poster
    // nobody can scan in the app is the wrong poster, and 4.11's 63-byte key was
    // exactly that.
    const payload = U + '#event=K7QM.H3KM9P';
    const keyload = U + '#event=ABCDEFGHJKM';
    if(payload.length !== 53) throw 'pass payload is '+payload.length+' bytes, not 53';
    if(keyload.length !== 53) throw 'key payload is '+keyload.length+' bytes, not 53';
    const q = qrMatrix(payload);
    if(!q || q.size !== 29) throw 'the pass payload did not render at version 3';
    const qk = qrMatrix(keyload);
    if(!qk || qk.size !== 29) throw 'the key payload did not render at version 3';
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

    // ---- MILLISECONDS vs SECONDS, which is the trap in this contract -------
    // Every timing value in this API is unix MILLISECONDS -- starts, ends, now, a
    // pass slot's at -- EXCEPT the three that are only ever displayed as calendar
    // dates, which are SECONDS: asked, joined, finished. Feeding one of those to
    // Date() unmultiplied renders 1970 and NOTHING THROWS, so both halves are
    // pinned here against one instant expressed both ways.
    const SEC = 1784100000, MS = SEC * 1000;
    const yr = String(new Date(MS).getFullYear()).slice(-2);
    if(eventDay(SEC).slice(-2) !== yr) throw 'a SECONDS stamp must render its own year, got '+eventDay(SEC);
    if(eventDay(SEC).slice(-2) === '70') throw 'a SECONDS stamp rendered as 1970: the x1000 is missing';
    if(eventDay(null) !== '' || eventDay(undefined) !== '') throw 'an absent date is no date, not a 1970 one';
    // ...and the MILLISECONDS half, on the same instant: the schedule line reads
    // starts/ends straight, so feeding it seconds would be the mirror mistake.
    netPts = () => MS;
    const w = eventWhen({ starts:MS });
    if(!/^FROM /.test(w)) throw 'a start-only schedule reads FROM: '+w;
    if(eventWhen({ starts:SEC }).slice(-2) === w.slice(-2)) throw 'ms and seconds must not render alike';
    if(eventWhen({}) !== '') throw 'no schedule, no line';
    if(!/ - /.test(eventWhen({ starts:MS, ends:MS+3600000 }))) throw 'both ends read as a range';
    // The archive line carries all four fields the server sends for a row.
    const line = eventArchiveLine({ finished:SEC, seats:8, played:7, podium:[{id:'c0ffee42', name:'KAI'}] });
    if(line.indexOf('8 SEATS') < 0) throw 'the archive says what it seated: '+line;
    if(line.indexOf('7 PLAYED') < 0) throw 'and how much was played: '+line;
    if(line.indexOf('KAI') < 0) throw 'and who was on the podium: '+line;
    if(line.slice(0,2) !== eventDay(SEC).slice(0,2)) throw 'and when it finished: '+line;
    // A podium id with no name falls back to the id rather than printing nothing.
    if(eventArchiveLine({ podium:[{id:'c0ffee42'}] }).indexOf('C0FF') < 0) throw 'a nameless id is still somebody';
    if(eventArchiveLine(null) !== '') throw 'no row, no line';
    netPts = () => null;
    log('units ok: seconds for the three calendar dates, milliseconds for everything timed');

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

    // ---- AND THE ROW ACTUALLY GOES SOMEWHERE ------------------------------
    // The lane above proves the row is in the right PLACE. It does not prove
    // pressing it does anything, and it did not: eventEnter set no phase, so from
    // the menu the whole function ran and the screen never moved. The boot path
    // hid it, because the splash exit picks its own destination and sets the phase
    // before calling in. On a device that reads as a dead entry.
    //
    // So this walks what a PLAYER walks: select EVENTS, press it, and land.
    const press = (k) => handleKey(k, ()=>{});
    const toEvents = () => {
        phase='multiplayer'; multiSel=0;
        const rows=multiRows();
        for(let i=0;i<rows.length;i++){ if(rows[i].go==='events') { multiSel=i; break; } }
        if(multiRows()[multiSel].go !== 'events') throw 'the EVENTS row is not on the menu at all';
        press('Enter');
    };
    // ONE event: straight to its page. This is the common case and the dead one.
    _netEvApply([{ eid:'K7QM', name:'Snake Night', state:'active', you:{state:'member'}, members:14 }]);
    toEvents();
    if(phase !== 'eventPage') throw 'one event must open its page, landed on '+phase;
    // SEVERAL: a chooser, because picking between rooms is a choice.
    _netEvApply([{ eid:'K7QM', name:'A', state:'active', you:{state:'member'} },
                 { eid:'M2PQ', name:'B', state:'active', you:{state:'pending'} }]);
    toEvents();
    if(phase !== 'eventChooser') throw 'several events must open the chooser, landed on '+phase;
    // ...and the chooser's own rows open a page too.
    _evUi.sel = 0; press('Enter');
    if(phase !== 'eventPage') throw 'a chooser row must open its page, landed on '+phase;
    if(_evEid !== 'K7QM') throw 'and the one that was picked: '+_evEid;
    // Every event screen must be somewhere the input router can reach, or the same
    // class of dead end comes back on the screen after this one.
    for(const ph of ['eventChooser','eventPage','eventMembers','eventQr','eventMonitor','eventConfirm']){
        if(!UI_INPUT[ph]) throw 'no input row for '+ph+': that screen would be a dead end';
        if(!SCREENS[ph]) throw 'no draw for '+ph;
    }
    _evList=[]; _ev=null; _evEid=''; phase='menu'; multiSel=0;
    log('menu row ok: one event opens its page, several open the chooser, every screen has an input row');

    // ---- THE ROSTER IS THREE COLUMNS AND THEY MUST CLEAR EACH OTHER -------
    // The numbers come from EV_ROSTER, which is what the DRAW uses -- a guard that
    // re-declares them proves only that the test agrees with itself. (It did, the
    // first time I wrote it: widening the name to 15 in screens.js left this lane
    // green, because the width it checked was its own constant.)
    //
    // Press Start 2P is a square monospace: one character advances one font size.
    const W = (txt, size) => String(txt).length * size;
    // Widest name a row can draw: clipped to NAME_MAX, selected, so '> ' and ' <'.
    const nameW = W('> ' + 'X'.repeat(EV_ROSTER.NAME_MAX) + ' <', FONT.MENU);
    const nameL = CW/2 - nameW/2, nameR = CW/2 + nameW/2;
    const dateW = W('09.09.26', FONT.HINT);
    if(EV_ROSTER.DATE_R > nameL - 2) throw 'the date column runs into the name: ends '+EV_ROSTER.DATE_R+', name starts '+nameL;
    if(EV_ROSTER.DATE_R - dateW < 0) throw 'the date column runs off the left edge';
    const TAGS = ['WAITING','BANNED','ORGANIZER','YOU','FRIENDS','ASKED','ADD FRIEND'];
    for(const t of TAGS){
        const w = W(t, FONT.HINT), l = EV_ROSTER.TAG_C - w/2, r = EV_ROSTER.TAG_C + w/2;
        if(l < nameR + 2) throw 'tag '+t+' runs into the name: starts '+l+', name ends '+nameR;
        if(r > CW) throw 'tag '+t+' runs off the right edge: '+r;
    }
    // ...and every label the roster can actually produce is in that set, so the
    // check above cannot be passed by a label nobody draws.
    for(const f of ['none','pending','accepted']){
        const lbl = eventFriendLabel({ friend:f, id:'aaaaaaaa' });
        if(TAGS.indexOf(lbl) < 0) throw 'friend label '+lbl+' is not one the column was checked for';
    }
    // THE DRAW HAS TO USE THEM. Numbers that only the guard reads guard nothing:
    // this is what makes widening the name in screens.js fail here.
    {
        const src = String(drawEventMembers);
        for(const k of ['EV_ROSTER.NAME_MAX','EV_ROSTER.DATE_R','EV_ROSTER.TAG_C'])
            if(src.indexOf(k) < 0) throw 'the roster draw does not use '+k+', so this lane checks nothing';
    }
    // A long name is CLIPPED rather than allowed to grow, and says it was.
    if(clipName('ABCDEFGHIJKLMNO', EV_ROSTER.NAME_MAX).length > EV_ROSTER.NAME_MAX) throw 'a long name must be clipped';
    if(clipName('ABCDEFGHIJKLMNO', EV_ROSTER.NAME_MAX).slice(-2) !== '..') throw 'a clipped name must show it was cut';
    if(clipName('SHORT', EV_ROSTER.NAME_MAX) !== 'SHORT') throw 'a short name is left alone';
    log('roster columns ok: date, centred name and tag all clear each other at their widest');

    // ---- THE QR SCREENS ALL LOOK THE SAME, AND NONE DRAWS A BACK ROW ------
    // BACK_Y sits INSIDE the card on a screen whose picture is that tall, so a BACK
    // row lands on top of the QR. The other two have always used the hint line, and
    // all three are the same gesture: hold this up to a phone.
    {
        // The CALL, not the word: a comment saying there is no BACK row is not one.
        const src = String(drawEventQr) + String(drawMyId) + String(drawTourneyCode);
        const backs = src.split('menuItem(').length - 1;
        if(backs) throw 'a QR screen draws a menu row, which lands on the card ('+backs+' found)';
        const card = drawQrCard('https://poeggi.github.io/FOK-snake/#event=K7QM.H3KM9P', 58);
        if(card.bottom <= BACK_Y) throw 'the card no longer reaches BACK_Y -- re-check why this rule exists';
    }
    log('QR screens ok: one card painter, no BACK row on any of the three');

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
    // What is PRESSABLE, which is now a different question from what is shown.
    const live = (o) => { _ev = o; _evEid = o && o.eid || ''; return eventRows().filter(eventRowOk).map(r=>r.go); };
    const rowOf = (o, go) => { _ev = o; _evEid = o && o.eid || ''; return eventRows().filter(r=>r.go===go)[0]; };
    const ME = getPlayerId();
    const mem = (x) => Object.assign({ eid:'K7QM', name:'n', state:'active',
                                       you:{ state:'member', organizer:false } }, x||{});
    // The same event seen by the ORGANIZER, which is the only thing about the
    // caller the rows are allowed to read besides its row state.
    const org = (x) => mem(Object.assign({ you:{ state:'member', organizer:true } }, x||{}));
    // A PENDING row gets nothing at all -- it sees the public face and no more.
    if(gos(mem({ you:{state:'pending'} })).length) throw 'a pending row must be offered nothing, not even a dark row';
    // A RESERVED MONITOR gets EXACTLY ONE ROW: the screen it exists to be. It is not
    // a member -- no pass, no roster, no leaving -- but an empty page is not that
    // rule, it is the one account that most needs the row unable to reach it. An
    // operator names a TV, the TV opens the event, and there has to be a way in.
    if(gos(mem({ you:{state:'monitor'} })).join(',') !== 'monitor')
        throw 'a reserved monitor gets the screen row and nothing else: '+gos(mem({ you:{state:'monitor'} }));
    if(!live(mem({ you:{state:'monitor'} })).length) throw 'and it must be pressable';
    // ...unless the event offers no screen at all, and then it has nothing to do.
    if(gos(mem({ you:{state:'monitor'}, monitor_allowed:false })).length)
        throw 'an event with no screen offers a monitor nothing';
    // An ordinary member: leave, and nothing that is the organizer's.
    // ONE ROW ABOUT THE TOURNAMENT, and which one depends on what you can do about
    // it. A MEMBER is never offered CREATE -- a permanently dark row they can never
    // press teaches them only that there is something they may not do. They get the
    // way IN instead, dark while there is nothing to join.
    if(gos(mem()).join(',') !== 'tourney,monitor,pass,members,leave')
        throw 'a member gets the JOIN row, never the create: '+gos(mem());
    if(live(mem()).indexOf('tourney') >= 0) throw 'with nothing running it cannot be pressed';
    if(!/NO TOURNAMENT/.test(rowOf(mem(),'tourney').note||'')) throw 'and it says why';
    if(gos(mem()).indexOf('newtourney') >= 0) throw 'a member must never see CREATE TOURNAMENT';
    // ...and once one IS running, everybody gets a live way in, organizer included.
    const TT = { tid:'t1', code:'K7QMX2', state:'open', players:3, max:8 };
    if(live(mem({tourney:TT})).indexOf('tourney') < 0) throw 'a running tournament is joinable';
    if(gos(mem({tourney:TT})).indexOf('newtourney') >= 0) throw 'still no create for a member';
    if(live(org({tourney:TT})).indexOf('tourney') < 0) throw 'the organizer joins its own too';
    if(gos(org({tourney:TT})).indexOf('newtourney') >= 0) throw 'no second tournament while one is live';
    // THE ORGANIZER gets CREATE while there is none, dark where the event is not
    // active -- that reason IS temporary, which is why this one is shown dark
    // rather than hidden.
    if(gos(org()).join(',') !== 'newtourney,monitor,pass,members,pause,end,access')
        throw 'active organizer rows: '+gos(org());
    if(live(org()).indexOf('newtourney') < 0) throw 'the organizer of an active event CAN press it';
    if(live(org({state:'paused'})).indexOf('newtourney') >= 0) throw 'a paused event opens no tournament';
    if(!/PAUSED/.test(rowOf(org({state:'paused'}),'newtourney').note||'')) throw 'and it says so';
    if(live(org({state:'ended'})).indexOf('newtourney') >= 0) throw 'an ended event opens no tournament';
    // ...but one RUNNING at the moment of the end plays on and stays reachable.
    if(live(org({state:'ended', tourney:TT})).indexOf('tourney') < 0) throw 'a running tournament survives the end';
    // A PENDING row and a RESERVED MONITOR are the two that get no tournament row
    // at all -- one is not in the event yet, the other is not a participant.
    if(gos(mem({ you:{state:'pending'} })).length) throw 'a pending row must be offered nothing, not even a dark row';
    if(gos(mem({ you:{state:'monitor'} })).join(',') !== 'monitor')
        throw 'a reserved monitor gets the screen row and nothing else: '+gos(mem({ you:{state:'monitor'} }));
    if(!live(mem({ you:{state:'monitor'} })).length) throw 'and it must be pressable';
    if(gos(mem({ you:{state:'monitor'}, monitor_allowed:false })).length)
        throw 'an event with no screen offers a monitor nothing';
    // The screen row itself is decided on monitor_allowed, never by calling monitor
    // to find out -- that call CLAIMS the slot.
    if(gos(mem({monitor_allowed:false})).indexOf('monitor') >= 0) throw 'an event that offers no screen must not offer the row';
    if(gos(mem()).indexOf('monitor') < 0) throw 'an absent monitor_allowed is not a refusal';
    // The organizer cannot leave the room it runs; a scheduled event takes the hand
    // verbs and keeps the door; an ended one is still readable.
    if(gos(org()).indexOf('leave') >= 0) throw 'the organizer cannot leave its own event';
    if(gos(org({starts:1})).join(',') !== 'newtourney,monitor,pass,members,access')
        throw 'a scheduled event offers no hand verbs: '+gos(org({starts:1}));
    if(gos(org({state:'paused'})).join(',') !== 'newtourney,monitor,members,run,end,access')
        throw 'a paused event mints no pass: '+gos(org({state:'paused'}));
    if(gos(org({state:'ended'})).join(',') !== 'newtourney,monitor,members')
        throw 'an ended event is still readable and still screenable: '+gos(org({state:'ended'}));
    if(gos(mem({state:'ended'})).join(',') !== 'tourney,monitor,members,leave')
        throw 'an ended event mints no pass, and stays readable: '+gos(mem({state:'ended'}));
    _ev = null; _evEid = '';
    log('page rows ok: a member gets JOIN and never CREATE, a reserved monitor gets its screen, the organizer cannot leave');

    // ---- AND THE PAGE HAS TO FIT VERTICALLY TOO ---------------------------
    // Found on an iPad: with the full organizer row set the archive was drawn on
    // top of the last row AND of the status line, and the note under the selected
    // row landed on the row below it. Rows are MENU_ROW apart -- there is no gap
    // between them to put a line in, which is why every other menu puts the note
    // in the STATUS BAND (drawMenuRows). These numbers are EV_PAGE, what the draw
    // uses.
    {
        const src = String(drawEventPage);
        for(const k of ['EV_PAGE.ROWS_TOP','EV_PAGE.ARCH_GAP','EV_PAGE.ARCH_ROW','EV_PAGE.ARCH_KEEP'])
            if(src.indexOf(k) < 0) throw 'the page draw does not use '+k+', so this lane checks nothing';
        // The note is in the band, not under the row: nothing may be drawn at a y
        // derived from the selected row's own position.
        if(src.indexOf('ui.sel*MENU_ROW') >= 0) throw 'a line is still placed under the selected row, where the next row is';
        if(src.indexOf('drawStatus(') < 0) throw 'the page must put its note in the status band';

        // The widest row set the page can actually produce, measured rather than
        // assumed -- a row added later has to be counted by this lane too.
        let widest = 0;
        for(const o of [org(), org({state:'paused'}), org({state:'ended'}), org({starts:1}),
                        org({tourney:TT}), mem(), mem({tourney:TT}), mem({state:'paused'})])
            widest = Math.max(widest, gos(o).length);
        if(widest < 7) throw 'expected the organizer row set to be the widest, got '+widest;

        // Rows must not reach the status band, at any count the page can produce.
        const lastRow = EV_PAGE.ROWS_TOP + (widest - 1) * MENU_ROW;
        if(lastRow + 10 > STATUS_Y) throw 'the row block reaches the status band: last row at '+lastRow;
        if(lastRow >= BACK_Y) throw 'the row block reaches BACK';

        // ...and the archive takes only what is left, which at the widest is none.
        const roomAt = (n) => (STATUS_Y - EV_PAGE.ARCH_KEEP) - (EV_PAGE.ROWS_TOP + (n-1)*MENU_ROW + EV_PAGE.ARCH_GAP);
        const fitsAt = (n) => Math.max(0, Math.floor(roomAt(n) / EV_PAGE.ARCH_ROW) - 1);
        if(fitsAt(widest) !== 0) throw 'the widest row set must leave no room for the archive, got '+fitsAt(widest);
        if(fitsAt(5) < 1) throw 'a member row set should still show some archive';
        // ...and it has to START clear of the last ROW, not just end above the band.
        // Both are centred text, so the gap has to hold half of each glyph.
        const need = FONT.MENU/2 + FONT.HINT/2 + 2;
        if(EV_PAGE.ARCH_GAP < need) throw 'the archive starts on top of the last row: gap '+EV_PAGE.ARCH_GAP+' needs '+need;
        // Whatever it draws has to end above the band.
        for(const n of [1,3,5,7]){
            const f = fitsAt(n);
            if(!f) continue;
            const bottom = EV_PAGE.ROWS_TOP + (n-1)*MENU_ROW + EV_PAGE.ARCH_GAP + f*EV_PAGE.ARCH_ROW;
            if(bottom > STATUS_Y - EV_PAGE.ARCH_KEEP) throw 'archive at '+n+' rows runs into the status band: '+bottom;
        }
    }
    log('page rows fit ok: the block clears the status band, and the archive takes only what is left');


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
      // ---- THE MONITOR IS A SPECTATOR -------------------------------------
      // It goes through the spectator path that already exists: the ordinary
      // 'watch' signal, the same P2P feed, the same renderer. What this lane
      // guards is that nothing else was invented -- every follow below has to
      // come out as a specWatch and nothing more.
      {
        const _oWatch=specWatch, _oStop=specStop, _oSpec=netSpectating;
        let watches=[], stops=0, on=false;
        specWatch=(peer,tid,nid)=>{ watches.push(peer+'/'+tid+'/'+nid); on=true; };
        specStop=()=>{ stops++; on=false; };
        netSpectating=()=>on;
        const roles=(nid,feeder)=>({ nid, feeder, players:[feeder,'22222222'], names:{} });
        _evEid='K7QM'; _evMonNid=''; _evMonAskAt=0;
        // NOTHING RUNNING: nothing is asked for, and nothing is held.
        _evMon={ tourney:null }; _evMonFollow();
        if(watches.length) throw 'no match, no ask';
        // A MATCH IN FLIGHT: one ask, to the feeder the projection names.
        _evMon={ tourney:{ tid:'t1', roles:roles('n1','11111111') } }; _evMonFollow();
        if(watches.join(',') !== '11111111/t1/n1') throw 'one watch to the feeder: '+watches;
        // ...and not a second one while it stands.
        _evMonFollow(); _evMonFollow();
        if(watches.length !== 1) throw 'a standing feed is not re-asked: '+watches.length;
        // THE CURSOR MOVES: let the old feed go before asking for the next, because
        // the two are different timelines and a watcher boots off a checkpoint.
        _evMon={ tourney:{ tid:'t1', roles:roles('n2','22222222') } }; _evMonFollow();
        if(stops !== 1) throw 'the old feed must be let go first: '+stops;
        if(watches.length !== 2 || watches[1] !== '22222222/t1/n2') throw 'follow the cursor: '+watches;
        // THE ROUND ENDS: the feed is let go and nothing is asked for.
        _evMon={ tourney:{ tid:'t1', roles:null } }; _evMonFollow();
        if(stops !== 2) throw 'a finished match releases the feed';
        if(watches.length !== 2) throw 'nothing is asked for when nothing is played';
        if(_evMonNid !== '') throw 'and no match is held';
        // A refusal is said once and then STOPS: a screen nobody attends must not
        // sit retrying forever.
        const _oPost3=_evPost;
        _evPost=async()=>({ json:null, status:409, body:{error:'monitor taken'} });
        _evMonBusy=false; _evMonErr='';
        _evMonT = 1;                                   // as if the tick were armed
        await eventMonitorRead();
        if(eventMonitorErr() !== 'monitor taken') throw 'a 409 must say the screen is taken';
        if(_evMonT !== null) throw 'a refusal must stop the asking';
        _evPost=async()=>({ json:null, status:403, body:{error:'no monitor'} });
        _evMonBusy=false; _evMonErr=''; _evMonT = 1;
        await eventMonitorRead();
        if(eventMonitorErr() !== 'no monitor') throw 'a 403 must say there is no screen';
        if(_evMonT !== null) throw 'and must stop too';
        // A feed ending under a monitor returns to the SCREEN, not the 1vs1 menu --
        // the match finished, the screen did not.
        _evMonT = 1;
        if(eventExitPhase() !== 'eventMonitor') throw 'a running monitor owns the way back';
        eventMonitorStop();
        if(eventExitPhase() !== '') throw 'a stopped one owns nothing';
        _evPost=_oPost3; specWatch=_oWatch; specStop=_oStop; netSpectating=_oSpec;
        _evMon=null; _evMonErr=''; _evMonNid=''; _evMonBusy=false;
      }
      R.steps.push('monitor ok: one specWatch per match, the cursor followed, a refusal said once and then stopped');

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

      // ---- JOIN posts the code and NOTHING ELSE ---------------------------
      // It is the one action asked by somebody with no row yet, so there is no
      // eid to name -- and a printed KEY has none to send in the first place.
      // Which event it was is the ANSWER's to say.
      {
        let sent = null;
        _evPost = async () => { throw 'join must not go through the eid-stamping post'; };
        netActionPost = async (path, action, extra) => {
            sent = { path, action, extra };
            return { json:{ ok:true, eid:'K7QM', name:'Snake Night',
                            you:{ state:'member', organizer:false } }, status:200, body:{} };
        };
        _ev = null; _evEid = ''; _evUi.busy = false;
        await eventJoin('ABCDEFGHJKM');                 // a printed key: no eid anywhere
        if(!sent || sent.action !== 'join') throw 'join did not go out';
        if('eid' in sent.extra) throw 'join must post NO eid: ' + JSON.stringify(sent.extra);
        if(sent.extra.code !== 'ABCDEFGHJKM') throw 'the code goes exactly as scanned: ' + sent.extra.code;
        if(_evEid !== 'K7QM') throw 'the eid is read back off the answer, got ' + _evEid;
        // A pass goes the same way, dot and all -- the client never has to know
        // which of the two it is holding.
        _ev = null; _evEid = ''; _evUi.busy = false;
        await eventJoin('k7qm.h3km9p');
        if('eid' in sent.extra) throw 'a pass posts no eid either';
        if(sent.extra.code !== 'K7QM.H3KM9P') throw 'the code is upper-cased, dot kept: ' + sent.extra.code;
        _evEid = ''; _ev = null;
      }
      R.steps.push('join ok: the code alone, dot and all, and the eid comes back on the answer');

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
      if(eventFriendLabel(ROSTER[3]) !== 'ASKED') throw 'a pending request reads ASKED';
      if(eventFriendLabel(ROSTER[2]) !== 'ADD FRIEND') throw 'a stranger can be asked';
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
