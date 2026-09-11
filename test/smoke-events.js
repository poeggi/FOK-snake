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
    // ...AND THE CAMERA READS THEM BACK. Rendering is only half of it: the printed
    // poster is rendered by the SERVER, at version 3 / level L / mask 0 -- the one
    // shape this decoder reads -- and its encoder is unit-pinned to this one, so a
    // round trip through OUR encoder covers the same matrix without needing a
    // fixture from the other repo.
    //
    // This is what the 4.11 poster could not do: 63 bytes is version 5, and the
    // decoder is fixed at 3. The whole point of printing a poster is scanning it in
    // the app, so if this lane goes red the poster is decoration.
    const paint = (q, mod) => {
        const quiet = 4, W = (q.size + quiet*2) * mod;
        const data = new Uint8ClampedArray(W*W*4).fill(255);
        for(let r = 0; r < q.size; r++) for(let c = 0; c < q.size; c++) if(q.m[r][c])
            for(let y = 0; y < mod; y++) for(let x = 0; x < mod; x++){
                const px = ((quiet+r)*mod + y)*W + ((quiet+c)*mod + x);
                data[px*4] = 0; data[px*4+1] = 0; data[px*4+2] = 0;
            }
        return { data, width:W, height:W };
    };
    for(const url of [payload, keyload]){
        for(const mod of [3, 5, 8]){
            const got = qrDecodeImage(paint(qrMatrix(url), mod));
            if(got !== url) throw 'the camera cannot read our own '+mod+'px QR: '+JSON.stringify(got);
        }
        // ...and what it reads has to reach the scanner as the code to join with,
        // from any camera window. A decode nobody acts on is not a scan.
        const m2 = EVENT_HASH_RE.exec(url);
        if(!m2) throw 'a decoded event URL must parse: '+url;
    }
    log('53-byte budget ok: both codes render at version 3 AND read back, 54 bytes is refused');

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
    // ALWAYS THE LIST, even for one room. Which events you are in is itself worth
    // seeing -- when the next one starts, what is over -- and a door that sometimes
    // opens a list and sometimes a page is two doors.
    _netEvApply([{ eid:'K7QM', name:'Snake Night', state:'active', you:{state:'member'}, members:14 }]);
    toEvents();
    if(phase !== 'eventChooser') throw 'EVENTS must open the list, landed on '+phase;
    // ...and the cursor opens on a ROOM, never on the heading above it.
    const one = eventChooserRows();
    if(!one[_evUi.sel] || !one[_evUi.sel].eid) throw 'the list must open on a room, not a heading';
    press('Enter');
    if(phase !== 'eventPage') throw 'a list row must open its page, landed on '+phase;
    if(_evEid !== 'K7QM') throw 'and the one that was picked: '+_evEid;
    // SEVERAL, and the list is the same list.
    _netEvApply([{ eid:'K7QM', name:'A', state:'active', you:{state:'member'} },
                 { eid:'M2PQ', name:'B', state:'active', you:{state:'pending'} }]);
    toEvents();
    if(phase !== 'eventChooser') throw 'several events must open the list, landed on '+phase;
    press('Enter');
    if(phase !== 'eventPage') throw 'a list row must open its page, landed on '+phase;
    // Every event screen must be somewhere the input router can reach, or the same
    // class of dead end comes back on the screen after this one.
    for(const ph of ['eventChooser','eventPage','eventMembers','eventQr','eventMonitor','eventStats','eventConfirm']){
        if(!UI_INPUT[ph]) throw 'no input row for '+ph+': that screen would be a dead end';
        if(!SCREENS[ph]) throw 'no draw for '+ph;
    }
    _evList=[]; _ev=null; _evEid=''; phase='menu'; multiSel=0;
    log('menu row ok: EVENTS always opens the list, a row opens its page, every screen has an input row');

    // ---- THE LIST IS ORDERED, AND THE ORDER IS THE GROUPING ---------------
    // Live first: that is the room you are standing in and the only one with
    // anything to press tonight. Then what is coming, soonest first. Then what is
    // over, freshest first -- a record rather than a door. NO HEADINGS: every row
    // already says what it is in its right-hand column, so a heading would say it
    // twice and cost a row of screen each time.
    {
        // _evNow() reads the synced clock; without one eventState takes the server's
        // word, which is what the state field carries here.
        const E = (eid, name, st, x) => Object.assign({ eid:eid, name:name, state:st,
                                                        you:{state:'member'} }, x||{});
        _netEvApply([ E('E1','ZED','ended',{ends:1000}), E('U1','LATER','upcoming',{starts:9000}),
                      E('A1','ZOO','active'),            E('U2','SOONER','upcoming',{starts:5000}),
                      E('P1','HELD','paused'),           E('E2','FRESH','ended',{ends:8000}),
                      E('A2','ARENA','active') ]);
        const rows = eventChooserRows();
        const shape = rows.map(r => r.eid).join(',');
        if(shape !== 'A2,P1,A1,U2,U1,E2,E1')
            throw 'the order the groups are laid out in, or the order inside one, moved: '+shape;
        // EVERY room is in it. A list that quietly drops one is the bug this screen
        // exists to fix, and the catch-all for a state we do not know is what keeps
        // a future word from making a room disappear.
        if(rows.length !== _evList.length) throw 'a room fell out of the list';
        // ...and it is a PLAIN list: every stop is a room, and one walk round reaches
        // all of them plus the way out.
        _evUi.sel = 0;
        if(rows[0].eid !== 'A2') throw 'the list opens on the first live room, got '+rows[0].eid;
        const seenSel = {};
        for(let k = 0; k < rows.length + 4; k++){
            UI_INPUT.eventChooser.nav('ArrowDown');
            seenSel[_evUi.sel] = 1;
        }
        const reach = Object.keys(seenSel).length;
        if(reach !== _evList.length + 1) throw 'a walk down the list reaches '+reach+' stops, not every room plus BACK';
        for(let k = 0; k < rows.length + 4; k++) UI_INPUT.eventChooser.nav('ArrowUp');
        if(_evUi.sel < 0 || _evUi.sel > rows.length) throw 'walking back up left the cursor off the list: '+_evUi.sel;
        // A list longer than the screen scrolls rather than drawing off the bottom.
        const fits = eventChooserFits();
        if(fits < 6) throw 'the list window is too small to be useful: '+fits;
        if(EV_CHOOSE.TOP + (fits - 1) * EV_CHOOSE.ROW + FONT.MENU/2 > STATUS_Y)
            throw 'the last row of a full window reaches the status band';
        // The three columns clear each other at their widest, the roster's problem
        // exactly: the name is CENTRED and a selected one is drawn as > NAME <.
        const w = (n) => n * FONT.MENU;                   // the same square-monospace rule the roster lane uses
        const half = w(EV_CHOOSE.NAME_MAX + 4) / 2;
        if(CW/2 - half < EV_CHOOSE.ID_R) throw 'a selected name runs into the id column';
        if(EV_CHOOSE.ID_R - 4*FONT.HINT < 8) throw 'the id column runs off the left edge';
        // EVERY tag the list can actually produce, not a made-up width: the page can
        // afford NOT STARTED YET across its whole width and a column cannot, which is
        // why the list has short words of its own. A guard checking one invented
        // length is a guard that agrees with itself.
        const now2 = 1789000000000;
        const TAGS2 = [ eventListTag({ state:'active', you:{state:'pending'} })[0],
                        eventListTag({ state:'active' })[0],
                        eventListTag({ state:'paused' })[0],
                        eventListTag({ state:'ended' })[0],
                        eventListTag({ state:'upcoming', starts:now2 })[0],
                        eventListTag({ state:'upcoming' })[0] ];
        if(TAGS2.indexOf('WAITING') < 0 || TAGS2.indexOf('LIVE') < 0) throw 'the tag set is not what the list draws';
        for(const t2 of TAGS2){
            const tw = String(t2).length * FONT.HINT;
            if(EV_CHOOSE.TAG_C - tw/2 < CW/2 + half + 2) throw 'the tag '+t2+' runs into the name';
            if(EV_CHOOSE.TAG_C + tw/2 > CW) throw 'the tag '+t2+' runs off the right edge';
        }
        _evList=[]; _evUi.sel=0; phase='menu';
    }
    log('event list ok: live first then coming then finished, ordered inside each, and the cursor never lands on a heading');

    // ---- A ROOM YOU CANNOT WALK INTO YET IS SHOWN, NOT HIDDEN -------------
    // Scanning the poster of an event that has not started is answered 409 by the
    // server today, so no row is made and the event is invisible until the night --
    // which makes scanning a poster feel like it failed. The row is what is wanted
    // instead: readable, saying when it opens, and refusing the press. Every field
    // this needs is one the events list already carries, so the client half stands
    // on its own and simply has nothing to show until the server makes the row.
    {
        const now3 = (typeof netPts === 'function' && netPts() != null) ? netPts() : Date.now();
        const up = (x) => Object.assign({ eid:'U1', name:'NEXT WEEK', state:'upcoming',
                                          starts:now3 + 9e8, you:{state:'member', organizer:false} }, x||{});
        _netEvApply([up(), { eid:'A1', name:'TONIGHT', state:'active', you:{state:'member'} }]);
        const rows = eventChooserRows();
        const upRow = rows.filter(r => r.eid === 'U1')[0];
        const onRow = rows.filter(r => r.eid === 'A1')[0];
        if(!upRow) throw 'an upcoming event must be IN the list, not dropped from it';
        if(eventChooserOk(upRow)) throw 'and it must not be openable yet';
        if(!eventChooserOk(onRow)) throw 'while a live one still opens';
        if(!/STARTS /.test(upRow.note || '')) throw 'a dark row must say when it opens, got '+JSON.stringify(upRow.note);
        // ...and the note is a TIME, not the word: eventClock renders milliseconds,
        // and starts is milliseconds, so a row that reads 1970 means somebody fed it
        // the seconds path.
        if(/19[67][0-9]/.test(upRow.note || '')) throw 'starts is MILLISECONDS and was read as seconds: '+upRow.note;
        // THE CURSOR STILL LANDS ON IT. A row nobody can arm is a row whose reason
        // nobody can read -- dark is not the same as absent, and that is the whole
        // point of showing it.
        // A DARK ROW STILL TAKES THE CURSOR -- that is how its note gets read. Being
        // unpressable is not the same as being unreachable.
        _evUi.sel = 0;
        const want = rows.indexOf(upRow);
        for(let k = 0; k < rows.length + 2 && _evUi.sel !== want; k++) UI_INPUT.eventChooser.nav('ArrowDown');
        if(_evUi.sel !== want) throw 'the cursor cannot reach the dark row at all';
        // Pressing it refuses, says why, and goes nowhere.
        _evUi.sel = rows.indexOf(upRow); _evUi.msg = ''; phase = 'eventChooser';
        UI_INPUT.eventChooser.confirm();
        if(phase !== 'eventChooser') throw 'pressing a dark row must not open anything, landed on '+phase;
        if(!/STARTS /.test(_evUi.msg || '')) throw 'and it must say when it opens, got '+JSON.stringify(_evUi.msg);
        // ...while the live one next to it opens exactly as before.
        _evUi.sel = rows.indexOf(onRow); _evUi.msg = '';
        UI_INPUT.eventChooser.confirm();
        if(phase !== 'eventPage' || _evEid !== 'A1') throw 'a live row must still open its page: '+phase+'/'+_evEid;
        phase = 'eventChooser';
        // THE ORGANIZER IS THE EXCEPTION, and not as a courtesy: a scheduled event
        // runs on its own clock, so its organizer cannot start it early and has every
        // reason to be inside beforehand -- the door, the roster, the queue at it.
        _netEvApply([up({ you:{state:'member', organizer:true} })]);
        const mine = eventChooserRows().filter(r => r.eid === 'U1')[0];
        if(!eventChooserOk(mine)) throw 'an organizer must be able to open its own upcoming event';
        // A PENDING row is a different wait and keeps its own: it is not upcoming,
        // it is unapproved, and its page is where that is explained.
        _netEvApply([{ eid:'P1', name:'ASKED', state:'active', you:{state:'pending'} }]);
        const pend = eventChooserRows().filter(r => r.eid === 'P1')[0];
        if(!eventChooserOk(pend)) throw 'a pending row still opens -- the page is where the wait is explained';
        // ...and the two other groups are untouched by any of this.
        _netEvApply([{ eid:'E1', name:'OVER', state:'ended', ends:now3 - 9e8, you:{state:'member'} }]);
        const done = eventChooserRows().filter(r => r.eid === 'E1')[0];
        if(!eventChooserOk(done)) throw 'a finished event is still readable';
        _evList = []; _evUi.sel = 0; _evUi.msg = ''; _ev = null; _evEid = ''; phase = 'menu';
    }
    log('upcoming rows ok: shown and dark with the time it opens, the cursor still reads it, the organizer still gets in');

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
    // ...AND THE SCREEN ON SHOW DECIDES WHICH READ ANSWERS IT. A monitor's picture
    // is its own call: handed a state read it would freshen a page nobody is
    // looking at and leave the TV showing the old room. The server sends the
    // tourney payload to the event's whole AUDIENCE, monitor included, so this is
    // the path a screen on a wall actually takes now.
    {
        const _mread0 = eventMonitorRead;
        let mreads = 0;
        eventMonitorRead = () => { mreads++; return Promise.resolve(true); };
        phase = 'eventMonitor';
        _evOnSignal({ event:'tourney', eid:'K7QM', tid:'y', code:'K7QMY3' });
        if(mreads !== 1) throw 'a monitor must answer the news with ITS own call, got '+mreads;
        if(reads !== 3) throw 'and never with the page read, got '+reads;
        // The ENDING is the same signal and the same answer: over:true carries no
        // more authority than a tid does, and neither is adopted.
        _evOnSignal({ event:'tourney', eid:'K7QM', tid:'y', over:true });
        if(mreads !== 2) throw 'the ending edge refreshes the screen too, got '+mreads;
        // Back on the page, the page read answers again.
        phase = 'eventPage';
        _evOnSignal({ event:'tourney', eid:'K7QM', tid:'z', code:'K7QMZ4' });
        if(reads !== 4 || mreads !== 2) throw 'the page must answer with the page read: '+reads+'/'+mreads;
        eventMonitorRead = _mread0;
    }
    eventRead = _read0; _evPending = {}; _ev = null; _evEid = ''; phase = 'menu';
    log('event signal ok: four payloads, each an ask, never an adopt, and the screen on show picks the read');

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
        const due=(ph)=>{ _netEvAt=Date.now()-(ph==='multiplayer'?NET_EVENTS_DOOR_MS:NET_EVENTS_MS)-1; };
        const poll=(ph)=>{ _u=null; _netPollBusy=false; phase=ph; _netPollOnce(); return _u||''; };
        const hello=(ph)=>{ _body=null; _netHelloBusy=false; phase=ph; _netHello(); return _body||{}; };

        for(const ph of ['multiplayer','eventChooser','eventPage','eventMembers','eventQr','eventMonitor','eventStats']){
            due(ph);
            if(!/[?&]ev=1(&|$)/.test(poll(ph))) throw 'the poll must ask for events on '+ph;
            if(hello(ph).events !== true) throw 'the hello must ask for events on '+ph;
        }
        for(const ph of ['menu','friends','duelLobby','tourneyLobby','settings']){
            due(ph);
            if(/[?&]ev=/.test(poll(ph))) throw 'the poll must NOT ask for events on '+ph;
            if('events' in hello(ph)) throw 'the hello must NOT ask for events on '+ph;
        }
        // ...AND IT RIDES A TICK OF ITS OWN. poll.php never 204s a request that
        // asked for rows (ev ANSWERS AT ONCE, exactly like fl and tl), so on every
        // poll it would cut every hold short and spin an event screen into a hot
        // loop -- the same trap the tournament announce is spaced for.
        _netEvAt = Date.now();
        if(/[?&]ev=/.test(poll('eventPage'))) throw 'the event rows must not ride every poll';
        due('eventPage');
        if(!/[?&]ev=1(&|$)/.test(poll('eventPage'))) throw 'the event tick must ask once it is due';
        // ...and the DOOR reads it slower still: it only needs to know there is an event
        // at all, and every ev cuts the hold it rides short.
        _netEvAt=Date.now()-NET_EVENTS_MS-1;
        if(/[?&]ev=/.test(poll('multiplayer'))) throw "the door must not read on the screens' cadence";
        if(!/[?&]ev=1(&|$)/.test(poll('eventPage'))) throw 'a screen reads at its own cadence';
        due('multiplayer');
        if(!/[?&]ev=1(&|$)/.test(poll('multiplayer'))) throw 'the door reads once its own cadence is due';
        // The tick is spent only when an answer actually came back: a failed poll
        // must not cost the screen its next read.
        _netEvAt=0; _netGet=async(p)=>{ _u=p; return null; };
        poll('eventPage');
        if(_netEvAt !== 0) throw 'a poll that never answered must not spend the tick';
        _netGet=_oGet; _netPost=_oPost; globalThis.fetch=_oFetch;
        _netPace=_oPace; _netPollHoldEnd=_oHold; _netPollBusy=false; _netHelloBusy=false; phase='menu';
    }
    // ...AND THE ANNOUNCE RIDES THE PAGE. The contract's {event:'tourney'} signal is
    // what should say a lobby opened, and the live server does not send that payload,
    // so a page already on screen never heard. An event's open lobbies reach its
    // members through the ordinary announce, which is why the page asks for it -- on
    // the poll it is already sending for 'ev', so it costs no request of its own.
    {
        const _oGet=_netGet, _oFetch=globalThis.fetch, _oPace=_netPace, _oHold=_netPollHoldEnd;
        globalThis.fetch=()=>({});
        let _u=null; _netGet=async(pth)=>{ _u=pth; return null; };
        _netPace={hold:true}; _netFrSince=0; _netFlWant=false; _netPollHoldEnd=0;
        const poll=(ph)=>{ _u=null; _netPollBusy=false; _netTlAt=0; _netEvAt=Date.now(); phase=ph; _netPollOnce(); return _u||''; };
        _evEid='K7QM';
        if(!/[?&]tl=1(&|$)/.test(poll('eventPage'))) throw 'the event page must ask for the announce';
        if(!/[?&]tl=1(&|$)/.test(poll('tourneyLobby'))) throw 'the tournament lobby still asks for it';
        if(!/[?&]tl=1(&|$)/.test(poll('eventMonitor'))) throw 'the monitor must hear the announce too';
        if(/[?&]tl=/.test(poll('eventMembers'))) throw 'a screen that cannot show a tournament asks for none';
        _evEid='';
        if(/[?&]tl=/.test(poll('eventPage'))) throw 'with no event open there is nothing to watch for';
        _netGet=_oGet; globalThis.fetch=_oFetch; _netPace=_oPace; _netPollHoldEnd=_oHold;
        _netPollBusy=false; phase='menu';
    }
    log('request shape ok: events rides the hello, a poll tick of its own on the seven screens that show it, and the announce rides the page');

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
    if(gos(mem()).join(',') !== 'tourney,monitor,pass,members,stats,leave')
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
    if(gos(org()).join(',') !== 'newtourney,monitor,pass,members,stats,pause,end,access')
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
    if(gos(org({starts:1})).join(',') !== 'newtourney,monitor,pass,members,stats,access')
        throw 'a scheduled event offers no hand verbs: '+gos(org({starts:1}));
    if(gos(org({state:'paused'})).join(',') !== 'newtourney,monitor,members,stats,run,end,access')
        throw 'a paused event mints no pass: '+gos(org({state:'paused'}));
    if(gos(org({state:'ended'})).join(',') !== 'newtourney,monitor,members,stats')
        throw 'an ended event is still readable and still screenable: '+gos(org({state:'ended'}));
    if(gos(mem({state:'ended'})).join(',') !== 'tourney,monitor,members,stats,leave')
        throw 'an ended event mints no pass, and stays readable: '+gos(mem({state:'ended'}));
    _ev = null; _evEid = '';
    log('page rows ok: a member gets JOIN and never CREATE, a reserved monitor gets its screen, the organizer cannot leave');

    // ---- AND THE PAGE HAS TO FIT VERTICALLY TOO ---------------------------
    // Found on an iPad: the archive was drawn on top of the last row AND of the
    // status line, and the note under the selected row landed on the row below it.
    // Rows are a pitch apart -- there is no gap between them to put a line in,
    // which is why every other menu puts the note in the STATUS BAND. The archive
    // has its own screen now, and what is left has to fit on its own: the organizer
    // carries EIGHT rows, and the menu pitch does not hold eight in that room.
    {
        const src = String(drawEventPage);
        if(src.indexOf('EV_PAGE.ROWS_TOP') < 0) throw 'the page draw does not use EV_PAGE.ROWS_TOP, so this lane checks nothing';
        if(src.indexOf('_evRowH(') < 0) throw 'the page draw does not use the pitch this lane checks';
        // The note is in the band, not under the row: nothing may be drawn at a y
        // derived from the selected row's own position.
        if(src.indexOf('ui.sel*MENU_ROW') >= 0) throw 'a line is still placed under the selected row, where the next row is';
        if(src.indexOf('drawStatus(') < 0) throw 'the page must put its note in the status band';
        // The archive belongs to the statistics screen now, and to nothing else.
        // The reference, not the word: the page's own comment names the archive as
        // one of the things a pending row may not see, and always will.
        if(/e[.]archive|eventArchiveLine|PLAYED HERE/.test(src)) throw 'the page still draws the archive';
        if(!/PLAYED HERE/.test(String(drawEventStats))) throw 'the statistics screen must be the one that draws it';

        // The widest row set the page can actually produce, measured rather than
        // assumed -- a row added later has to be counted by this lane too.
        let widest = 0;
        for(const o of [org(), org({state:'paused'}), org({state:'ended'}), org({starts:1}),
                        org({tourney:TT}), mem(), mem({tourney:TT}), mem({state:'paused'})])
            widest = Math.max(widest, gos(o).length);
        if(widest < 8) throw 'expected the organizer row set to be the widest, got '+widest;

        // Rows must clear the status band and BACK at EVERY count the page produces,
        // and the pitch is what pays for that -- so it is read from the draw's own
        // rule rather than restated here.
        for(let n = 1; n <= widest; n++){
            const last = EV_PAGE.ROWS_TOP + (n - 1) * _evRowH(n);
            if(last + FONT.MENU/2 > STATUS_Y) throw n+' rows reach the status band: last row at '+last;
            if(last >= BACK_Y) throw n+' rows reach BACK';
            // ...and a shrunk pitch still has to be readable: glyphs may not touch.
            if(_evRowH(n) < FONT.MENU + 4) throw 'the pitch at '+n+' rows is '+_evRowH(n)+', which stacks the glyphs';
        }
        // A SMALL SET IS NOT COMPRESSED. The pitch only yields where it has to, or
        // every page in the game would quietly stop matching every other menu.
        if(_evRowH(4) !== MENU_ROW) throw 'a four-row page must keep the menu pitch, got '+_evRowH(4);
    }
    log('page rows fit ok: every row set clears the status band, and the pitch yields only where it must');

    // ---- THE STATISTICS SCREEN --------------------------------------------
    // What the room knows about itself, all of it DERIVED from the state answer the
    // page already holds. The archive used to be three clipped lines squeezed under
    // the page's rows; here it is a board with the standings the room has produced
    // over its whole life, which is what an archive is actually for.
    {
        const P = (id, name) => ({ id:id, name:name });
        const A = (fin, seats, played, pod) => ({ tid:'t'+fin, finished:fin, seats:seats, played:played, podium:pod });
        // KAI wins two, JO wins one and is second twice, MAX is third once.
        const ev = { eid:'K7QM', name:'n', state:'active', members:14,
                     you:{ state:'member', organizer:false },
                     archive:[ A(1780000000, 8, 7, [P('c0ffee42','KAI'), P('dddddddd','JO'), P('eeeeeeee','MAX')]),
                               A(1770000000, 4, 3, [P('dddddddd','JO'), P('c0ffee42','KAI')]),
                               A(1760000000, 6, 5, [P('c0ffee42','KAI'), P('dddddddd','JO')]) ] };
        const st = eventStatsView(ev);
        if(st.tourneys !== 3) throw 'three archived tournaments, got '+st.tourneys;
        if(st.played !== 15) throw 'the matches are summed, got '+st.played;
        if(st.seats !== 8) throw 'the biggest field is the biggest, not the last, got '+st.seats;
        if(st.last !== 1780000000) throw 'the last night is the newest, got '+st.last;
        if(st.members !== 14) throw 'the member count rides the same answer';
        if(st.live) throw 'nothing is running in this one';
        // WINS FIRST, then podiums. JO never wins a night and is still second best,
        // which is the whole reason both are counted.
        const nm = st.top.map(x=>x.name).join(',');
        if(nm !== 'KAI,JO,MAX') throw 'wins then podiums then name: '+nm;
        if(st.top[0].wins !== 2 || st.top[0].podiums !== 3) throw 'KAI: 2 wins of 3 podiums, got '+JSON.stringify(st.top[0]);
        if(st.top[1].wins !== 1 || st.top[1].podiums !== 3) throw 'JO: 1 win of 3 podiums, got '+JSON.stringify(st.top[1]);
        if(st.top[2].wins !== 0 || st.top[2].podiums !== 1) throw 'MAX: a single third place, got '+JSON.stringify(st.top[2]);
        // A TIE IS ORDERED, not left to the object: two players level on both counts
        // must not swap places between two draws of the same screen.
        const tie = eventStatsView({ archive:[ A(1, 2, 1, [P('bbbbbbbb','BEA')]), A(2, 2, 1, [P('aaaaaaaa','ABE')]) ] });
        if(tie.top.map(x=>x.name).join(',') !== 'ABE,BEA') throw 'a tie breaks on the name: '+tie.top.map(x=>x.name);
        // An empty room reads as empty rather than throwing on the way in.
        const none = eventStatsView({ eid:'K7QM' });
        if(none.tourneys || none.played || none.top.length) throw 'a room that has played nothing has no numbers';
        // One archived row, in columns rather than one long centred line.
        const row = eventStatsRow(ev.archive[0]);
        if(row.field !== '7/8') throw 'the field reads played of seats, got '+row.field;
        if(row.won !== 'KAI') throw 'the winner is the top of the podium, got '+row.won;
        if(!row.day) throw 'the date is rendered from SECONDS, and this one is a date';
        // ...and that date is the seconds trap: eventDay is the only converter, and a
        // value fed to Date() unmultiplied renders 1970 without throwing.
        if(/19[67][0-9]/.test(row.day)) throw 'finished is SECONDS and was read as milliseconds: '+row.day;

        // THE SCREEN'S GEOMETRY, from the draw's own numbers. The standings are capped
        // and the archive takes what is left -- and what is left has to end above the
        // status band at every count, or this repeats the iPad bug on a new screen.
        const sSrc = String(drawEventStats);
        for(const k of ['EV_STATS.ROW0','EV_STATS.ROW_H','EV_STATS.TOP_MAX','eventStatsFits('])
            if(sSrc.indexOf(k) < 0) throw 'the statistics draw does not use '+k+', so this lane checks nothing';
        _ev = ev; _evEid = 'K7QM';
        const fits = eventStatsFits();
        if(fits < 1) throw 'a three-row archive must have somewhere to go, got '+fits;
        const bottom = _evStatsArchTop(Math.min(st.top.length, EV_STATS.TOP_MAX)) + (fits + 1) * EV_STATS.ARCH_ROW;
        if(bottom > STATUS_Y) throw 'the archive block runs into the status band: '+bottom;
        const lastTop = EV_STATS.ROW0 + (EV_STATS.TOP_MAX - 1) * EV_STATS.ROW_H;
        if(lastTop + FONT.HINT >= _evStatsArchTop(EV_STATS.TOP_MAX)) throw 'the standings run into the archive head';
        // THE COLUMNS HAVE TO CLEAR EACH OTHER AT THEIR WIDEST, and EVERY adjacent
        // pair of them -- both tables, headers included. Checking three pairs of four
        // is how the winner ended up drawn through the field beside it: the lane
        // agreed with itself and the screen did not.
        const w = (n) => n * FONT.HINT;                   // Press Start 2P: one glyph advances one font size
        // left-anchored cell, right-anchored cell, and what each holds at its widest
        const L = (x, n) => ({ from:x, to:x + w(n) });
        const Rc = (x, n) => ({ from:x - w(n), to:x });
        const clear = (a, b, what) => { if(a.to > b.from) throw what+': '+Math.round(a.to)+' runs past '+Math.round(b.from); };
        // the standings, header row and widest data row alike
        for(const cells of [[L(EV_STATS.NAME_X, 6), Rc(EV_STATS.WIN_R, 4), Rc(EV_STATS.POD_R, 7)],
                            [Rc(EV_STATS.RANK_X, 1), L(EV_STATS.NAME_X, EV_STATS.NAME_MAX), Rc(EV_STATS.WIN_R, 3), Rc(EV_STATS.POD_R, 3)]])
            for(let i = 0; i + 1 < cells.length; i++) clear(cells[i], cells[i+1], 'standings column '+i);
        // ...and the archive, whose head line IS its column header
        for(const cells of [[L(EV_STATS.DATE_X, 11), L(EV_STATS.FIELD_X, 5), Rc(EV_STATS.WON_R, 6)],
                            [L(EV_STATS.DATE_X, 8), L(EV_STATS.FIELD_X, 5), Rc(EV_STATS.WON_R, EV_STATS.NAME_MAX)]])
            for(let i = 0; i + 1 < cells.length; i++) clear(cells[i], cells[i+1], 'archive column '+i);
        if(EV_STATS.POD_R > CW - 8 || EV_STATS.WON_R > CW - 8) throw 'a right column falls off the screen';
        if(EV_STATS.RANK_X - w(1) < 8 || EV_STATS.DATE_X < 8) throw 'a left column falls off the screen';

        // SCROLLING IS BOUNDED BY WHAT IS DRAWN -- one number, read by both, so a
        // list can never be scrolled past its own last page.
        const many = { eid:'K7QM', name:'n', state:'active', members:2, you:{state:'member'},
                       archive:[] };
        for(let i = 0; i < 30; i++) many.archive.push(A(1700000000 + i, 4, 3, [P('c0ffee42','KAI')]));
        _ev = many;
        const f2 = eventStatsFits();
        _evStatsTop = 0;
        for(let i = 0; i < 60; i++) eventStatsScroll(1);
        if(eventStatsTop() !== 30 - f2) throw 'the scroll stops on the last page, got '+eventStatsTop()+' of '+(30-f2);
        for(let i = 0; i < 60; i++) eventStatsScroll(-1);
        if(eventStatsTop() !== 0) throw 'and it comes back to the top, got '+eventStatsTop();
        if(eventStatsScroll(-1)) throw 'a scroll that moves nothing must report so, or it sounds a key that did nothing';
        _ev = null; _evEid = ''; _evStatsTop = 0;
    }
    log('statistics ok: wins and podiums derived from the podiums, columns clear, and the scroll stops where the draw does');

    // ---- A TOURNAMENT THAT OPENS WHILE THE PAGE IS UP ---------------------
    // The contract signals it -- {event:'tourney'} to every member -- and the live
    // server does not send that payload, so the row stayed dark until the player left
    // the screen and came back. The ANNOUNCE carries the same news and needs no
    // server change: an event's open lobbies are served to its members regardless of
    // network. Noticing is not adopting: the page re-reads state, which is the one
    // place the tournament it shows comes from.
    {
        const _oRead = eventRead;
        let reads = 0;
        eventRead = async () => { reads++; return true; };
        _evEid = 'K7QM'; phase = 'eventPage';
        _ev = { eid:'K7QM', name:'n', state:'active', members:2, you:{state:'member'} };
        // Somebody else's lobby is somebody else's business.
        if(eventTourneySeen([{ tid:'x1', code:'AAA', eid:'ZZZZ' }])) throw 'a lobby from another event is not our news';
        if(eventTourneySeen([{ tid:'x1', code:'AAA' }])) throw 'an ordinary lobby carries no eid and is not our news';
        if(reads) throw 'and neither of those may cost a read';
        // Ours, and we are not showing it: read.
        if(!eventTourneySeen([{ tid:'x1', code:'AAA', eid:'K7QM' }])) throw 'an event lobby we do not show is news';
        if(reads !== 1) throw 'and it is answered by ONE re-read, got '+reads;
        // The one we already show is not news, however often it is announced.
        _ev.tourney = { tid:'x1', code:'AAA', state:'open' };
        if(eventTourneySeen([{ tid:'x1', code:'AAA', eid:'K7QM' }])) throw 'the tournament already on the page is not news';
        if(reads !== 1) throw 'and it must not re-read on every announce, got '+reads;
        // A DIFFERENT one is: the first ended and the organizer opened another.
        if(!eventTourneySeen([{ tid:'x2', code:'BBB', eid:'K7QM' }])) throw 'a second tournament is news again';
        if(reads !== 2) throw 'and that one reads once too, got '+reads;
        // Nowhere near the screen: nothing to refresh and nothing to spend.
        phase = 'menu'; reads = 0;
        if(eventTourneySeen([{ tid:'x3', code:'CCC', eid:'K7QM' }])) throw 'a page nobody is looking at reads nothing';
        if(reads) throw 'and it costs nothing either';
        // ...and the announce has to be ASKED for, which is what makes the rest of
        // this reachable at all.
        phase = 'eventPage';
        if(!eventTlWant()) throw 'the page must ask for the announce';
        // THE MONITOR IS ON THE SAME NEWS, and for the same money: its own call is a
        // 30 s tick because that is its LEASE, and one of those builds the whole
        // tournament projection. The announce is a flag on a poll the screen already
        // holds, so it takes the wait from the lease tick to the announce tick and
        // costs nothing -- and what the monitor DOES with it is still its own call.
        const _oMonRead = eventMonitorRead;
        let monReads = 0;
        eventMonitorRead = async () => { monReads++; return true; };
        phase = 'eventMonitor';
        if(!eventTlWant()) throw 'the monitor must hear the announce too, or a new tournament waits out its lease';
        _evMon = { eid:'K7QM', tourney:null };
        if(!eventTourneySeen([{ tid:'m1', code:'AAA', eid:'K7QM' }])) throw 'a tournament the TV is not showing is news to it';
        if(monReads !== 1 || reads !== 0) throw 'and the monitor answers with ITS call, not the page read: '+monReads+'/'+reads;
        _evMon.tourney = { tid:'m1' };
        if(eventTourneySeen([{ tid:'m1', code:'AAA', eid:'K7QM' }])) throw 'the one already on the TV is not news';
        if(monReads !== 1) throw 'and it must not re-read on every announce, got '+monReads;
        eventMonitorRead = _oMonRead; _evMon = null;
        eventRead = _oRead; _ev = null; _evEid = ''; phase = 'eventPage';
    }
    log('new tournament ok: the announce is the second way it arrives, one read per tournament rather than per announce');



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

      // ---- THE DOOR YOU CAME IN BY IS THE DOOR YOU LEAVE BY ---------------
      // An event tournament is an ORDINARY tournament, so it runs on the ordinary
      // screens -- and those were wired to one fixed exit, the multiplayer menu. A
      // player who joined from an event page and then left was put two rooms away
      // from where they had been standing. tourneyHome is the whole of the fix, and
      // every exit off the boards asks it, so this lane presses each of them from
      // BOTH doors: a rule that only ever answers 'eventPage' is not a rule.
      {
        const _oJoin=tourneyJoin, _oTtPost=_ttPost, _oAnch=_netAnchorRefresh;
        _netAnchorRefresh=()=>{};
        _ttPost=async()=>({ json:{ok:true}, status:200, body:{ok:true} });
        // Pressing the LAST row is what ESC and BACK both do on every one of them.
        const press=()=>{ const r=tourneyRows(); r[r.length-1].act(); return phase; };
        const HOST='ffffffff';   // somebody else's room, so leaving it is a real leave
        if(getPlayerId()===HOST) throw 'the guest cases need a host that is not us';

        for(const c of [{ home:'', want:'multiplayer' }, { home:'eventPage', want:'eventPage' }]){
          const say=' with home '+JSON.stringify(c.home)+', got ';
          // off the room list, which is off tournaments altogether
          _tt=null; _ttUi.home=c.home; phase='tourneyLobby';
          if(press() !== c.want) throw 'BACK off the room list'+say+phase;
          // ...off one that is OVER, which is a different row on a different screen
          _tt={ tid:'t1', state:'done', host:HOST, players:[] };
          _ttUi.home=c.home; phase='tourneyPodium';
          if(press() !== c.want) throw 'DONE off the podium'+say+phase;
          // ...and out of a lobby somebody else is hosting, which leaves for real
          _tt={ tid:'t1', state:'open', host:HOST, players:[] };
          _ttUi.home=c.home; phase='tourneyLobby';
          if(press() !== c.want) throw 'LEAVE off an open lobby'+say+phase;
        }

        // The CREATE dialog carries the same fact: the event it was opened from is
        // both the room its tournament belongs to and the screen its BACK gives back.
        _tt=null;
        tourneySetupOpen('K7QM');
        if(_ttUi.home !== 'eventPage') throw 'a create started from an event page belongs back on it';
        if(press() !== 'eventPage') throw 'BACK off the event create dialog went to '+phase;
        // ...and the room survives the create itself: the tournament that comes out of
        // this dialog is the event's, and it is the exit off ITS screens that has to
        // lead back. Nothing between the dialog and the lobby may quietly clear it.
        tourneySetupOpen('K7QM');
        _tt = { tid:'t1', state:'open', host:HOST, players:[] };
        if(_ttUi.home !== 'eventPage') throw 'a created event tournament must still know its room';
        if(press() !== 'eventPage') throw 'and leaving the room it made must land there, got '+phase;
        _tt = null;
        tourneySetupOpen();
        if(_ttUi.home !== '') throw 'an ordinary create must not inherit the room';
        if(press() !== 'tourneyLobby') throw 'BACK off the ordinary create dialog went to '+phase;

        // JOINING FROM THE PAGE DOES NOT FLASH THE ROOM-PICKING SCREEN. Moving to the
        // tournament screen before the join lands puts CREATE TOURNAMENT and JOIN BY
        // CODE in front of somebody who is already in the room they want, for as long
        // as the request takes -- and every row on it is pressable while it stands.
        let seen=[];
        _tt=null; _ttUi.home=''; _ttUi.msg=''; phase='eventPage';
        tourneyJoin=async(tid)=>{ seen.push(phase); _tt={ tid:String(tid), state:'open', host:HOST, players:[] }; };
        _ev={ eid:'K7QM', name:'n', state:'active', you:{state:'member'}, tourney:{ tid:'t9' } };
        _evEid='K7QM'; _evUi.busy=false;
        if(await eventTourneyGo() !== true) throw 'a join that lands must report true';
        if(seen[0] !== 'eventPage') throw 'the page must still be up while the join is in flight, was '+seen[0];
        if(phase !== 'tourneyLobby') throw 'a joined lobby lands on the lobby screen, got '+phase;
        if(_ttUi.home !== 'eventPage') throw 'a tournament joined from an event page must give that page back';
        if(press() !== 'eventPage') throw 'and leaving it must land there, got '+phase;
        // A join that does not land leaves the player where they were standing, with
        // the reason the join worked out -- not a second opinion on it.
        _tt=null; _ttUi.home=''; phase='eventPage'; _evUi.msg=''; _evUi.busy=false;
        tourneyJoin=async()=>{ _ttUi.msg='TOURNAMENT IS FULL'; };
        if(await eventTourneyGo() !== false) throw 'a join that fails must report false';
        if(phase !== 'eventPage') throw 'a failed join must not move the screen, got '+phase;
        if(_evUi.msg !== 'TOURNAMENT IS FULL') throw 'the page must say what the join said, got '+_evUi.msg;
        if(_evUi.busy) throw 'a failed join must give the page back';

        // A RUNNING TOURNAMENT IS A DOOR BACK. The server answers a join 409 once a
        // tournament runs, so the row reads the tournament instead (state, which is
        // 403 to anybody not in it): a participant who closed the app and comes back
        // through the room lands on its boards, exactly as the tournament menu's
        // REJOIN does; anybody else is told it has started.
        {
          const _oSrv=netSrvMinor, _oNetOk=_netOk;
          netSrvMinor=()=>99; _netOk=()=>true;
          const posts=[];
          let joins=0;
          tourneyJoin=async()=>{ joins++; };
          _ev={ eid:'K7QM', name:'n', state:'active', you:{state:'member'}, tourney:{ tid:'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', state:'running', players:2 } };
          _evEid='K7QM';
          const rows=eventRows();
          if(!rows[0] || rows[0].t !== 'REJOIN TOURNAMENT' || rows[0].go !== 'tourney')
              throw 'a running event tournament must offer REJOIN, got '+JSON.stringify(rows[0]);
          _tt=null; _ttUi.home=''; _ttUi.msg=''; _ttUi.busy=false; phase='eventPage'; _evUi.msg=''; _evUi.busy=false;
          _ttPost=async(a,b)=>{ posts.push(a); return { json:{ ok:true, tid:b.tid, state:'running', host:HOST, players:[{id:HOST},{id:getPlayerId()}], round:1, cursor:'r1.1', schedule:[], bracket:[], standings:[] }, status:200, body:{ok:true} }; };
          if(await eventTourneyGo() !== true) throw 'a rejoin that lands must report true';
          if(joins) throw 'a running tournament must not be JOINED';
          if(posts[0] !== 'state') throw 'the way back is the state read, sent '+posts.join(',');
          if(!_tt || _tt.tid !== 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4') throw 'the state answer must be adopted';
          if(phase !== 'tourneyBracket') throw 'a running tournament lands on its board, got '+phase;
          if(_ttUi.home !== 'eventPage') throw 'a tournament rejoined from an event page must give that page back';
          // ...and the refusal: not a participant.
          _tt=null; _ttUi.home=''; _ttUi.msg=''; _ttUi.busy=false; phase='eventPage'; _evUi.msg=''; _evUi.busy=false;
          _ttPost=async()=>({ json:null, status:403, body:{ok:false, error:'not a participant'} });
          if(await eventTourneyGo() !== false) throw 'a refused rejoin must report false';
          if(phase !== 'eventPage') throw 'a refused rejoin must not move the screen, got '+phase;
          if(_evUi.msg !== 'ALREADY STARTED') throw 'a non-participant is told it has started, got '+_evUi.msg;
          if(_tt) throw 'a refusal adopts nothing';
          netSrvMinor=_oSrv; _netOk=_oNetOk;
        }

        tourneyJoin=_oJoin; _ttPost=_oTtPost; _netAnchorRefresh=_oAnch;
        _tt=null; _ttUi.home=''; _ttUi.msg=''; _ev=null; _evEid=''; phase='eventPage';
      }
      R.steps.push('tournament exits ok: every exit gives back the door it came in by, and a join holds the page until it lands');

      // ---- KEEPING A TV AWAKE ----------------------------------------------
      // Nothing is ever pressed on the monitor, so the platform blanks the panel. The
      // Screen Wake Lock API is the only thing a page can do about that -- held ONLY
      // while that screen is up, re-taken when the page comes back, and absent without
      // complaint on a TV whose browser predates it.
      {
          const _oNav = globalThis.navigator, _oDoc = globalThis.document;
          const tick = async () => { for(let i = 0; i < 6; i++) await Promise.resolve(); };
          let asked = 0, released = 0, listeners = {}, lock = null;
          globalThis.navigator = { wakeLock: { request: async (kind) => {
              if(kind !== 'screen') throw new Error('wrong lock kind: '+kind);
              asked++;
              lock = { release(){ released++; }, addEventListener(k, fn){ this['on_'+k] = fn; } };
              return lock;
          } } };
          globalThis.document = { hidden:false, addEventListener:(k, fn)=>{ listeners[k] = fn; } };
          // Entering the screen takes one.
          eventWakeSet(true); await tick();
          if(asked !== 1) throw 'exactly one lock is asked for, got '+asked;
          if(!eventWakeHeld()) throw 'and it has to be HELD, not merely asked for';
          if(!listeners.visibilitychange) throw 'a lock that is not re-taken on visibilitychange is gone the first time the TV switches input';
          // A second arm while one stands asks for nothing: a screen redraw is not a reason.
          eventWakeSet(true); await tick();
          if(asked !== 1) throw 'a standing lock is not re-asked, got '+asked;
          // Leaving gives it back. A lock outliving its screen is a promise nobody asked for.
          eventWakeSet(false);
          if(released !== 1) throw 'leaving the screen must release the lock, got '+released;
          if(eventWakeHeld()) throw 'and nothing may still read as held';
          // THE BROWSER DROPS IT BY ITSELF when the page hides, and never returns it.
          // That re-take is the half a naive implementation leaves out, and the half
          // that matters on a device switched between inputs.
          eventWakeSet(true); await tick();
          lock.on_release();                                  // the browser let go
          if(eventWakeHeld()) throw 'a released lock must not still read as held';
          globalThis.document.hidden = true; listeners.visibilitychange(); await tick();
          if(asked !== 2) throw 'a hidden page cannot take one, got '+asked+' asks';
          globalThis.document.hidden = false; listeners.visibilitychange(); await tick();
          if(asked !== 3 || !eventWakeHeld()) throw 'coming back has to take it again, got '+asked+' asks';
          eventWakeSet(false);
          // A TV WITHOUT THE API is the ordinary case, not an error: nothing throws,
          // nothing is held, and the screen works exactly as it does today.
          globalThis.navigator = {};
          eventWakeSet(true); await tick();
          if(eventWakeHeld()) throw 'an absent API must leave nothing held';
          eventWakeSet(false);
          // ...and one that REFUSES is the same thing: refused is not crashed.
          globalThis.navigator = { wakeLock: { request: async () => { throw new Error('denied'); } } };
          eventWakeSet(true); await tick();
          if(eventWakeHeld()) throw 'a refusal must leave nothing held';
          eventWakeSet(false);
          globalThis.navigator = _oNav; globalThis.document = _oDoc;
      }
      log('wake lock ok: held only while the monitor is up, re-taken after a hidden page, and absent without complaint');
      // ---- A MONITOR THAT IS WATCHING IS NOT A MONITOR THAT LEFT ----------
      // Field report from a TV: the feed died mid-match and the screen landed on the
      // 1vs1 DUEL menu. One cause for both halves. While a monitor is ATTACHED it is
      // drawing the duel, so the phase is not 'eventMonitor' -- and the tick read that
      // as "the screen is gone" and tore the whole thing down. With it went the
      // lease, the re-ask ladder, and the answer eventExitPhase gives the duel-end
      // path, which then fell through to its 1vs1 default.
      {
        const _oRead2 = eventMonitorRead, _oSpec = netSpectating, _oWatch = specWatch, _oStop2 = specStop;
        let reads2 = 0, on2 = false;
        eventMonitorRead = async () => { reads2++; return true; };
        netSpectating = () => on2;
        specWatch = () => { on2 = true; };
        specStop = () => { on2 = false; };
        _evEid = 'K7QM'; _evMonT = 1;                    // as if the interval were armed
        // Watching a match: the tick must leave everything standing.
        phase = 'duel'; on2 = true; _evMonAt = _msgNow();
        _evMonTick();
        if(_evMonT !== 1) throw 'a monitor watching a match must not be torn down';
        if(eventExitPhase() !== 'eventMonitor') throw 'and the way back must still be its own screen';
        // ...and off both, it IS gone: a screen nobody is looking at and nothing is
        // feeding has no business holding a slot.
        on2 = false; phase = 'menu';
        _evMonTick();
        if(_evMonT != null) throw 'a monitor that is neither shown nor watching must let go';
        if(eventExitPhase() !== '') throw 'and it must stop claiming the way back';
        // THE 4 s RE-ASK HAS TO BE REACHABLE. It was not: _evMonFollow was only ever
        // called by the 30 s lease read, so the constant that says four could only
        // ever happen every thirty. The tick renews the lease when it is due and
        // follows the feed on every other pass.
        _evMonT = 1; phase = 'eventMonitor'; reads2 = 0;
        _evMonAt = _msgNow();                            // lease fresh
        _evMonTick();
        if(reads2 !== 0) throw 'a lease that is not due must not be renewed, got '+reads2;
        _evMonAt = _msgNow() - EV_MON_MS - 1;            // lease due
        _evMonTick();
        if(reads2 !== 1) throw 'a lease that IS due must be renewed once, got '+reads2;
        if(EV_MON_WATCH_MS >= EV_MON_MS) throw 'the re-ask must be faster than the lease or it is the lease';
        // ...and the follow is what a non-lease pass does: a lost feed is asked for
        // again rather than waited out.
        _evMon = { eid:'K7QM', tourney:{ tid:'t1', roles:{ nid:'n1', players:['c0ffee42','dddddddd'] } } };
        _evMonNid = 'n1'; _evMonAskAt = 0; on2 = false;
        _evMonAt = _msgNow();
        _evMonTick();
        if(!on2) throw 'a non-lease pass must re-ask for a feed it does not have';
        _evMonT = null; _evMon = null; _evMonNid = ''; _evMonAskAt = 0; _evMonAt = 0; _evEid = '';
        eventMonitorRead = _oRead2; netSpectating = _oSpec; specWatch = _oWatch; specStop = _oStop2;
        phase = 'eventPage';
      }
      log('monitor feed ok: watching is not leaving, the lease and the re-ask keep their own rates, and the way back stays its own screen');

      // ---- A WATCHER IS NOT OFFERED THE NEXT LEVEL, AND CANNOT OPEN IT --------
      // Field report from the monitor: LEVEL COMPLETE showed 'A:next  TAP:next' to a
      // screen that is not in the duel, and the press was TAKEN -- a RE-SYNCING cover
      // over a board that had not moved, and a req parked in a tx slot that nothing
      // would ever echo. The players open the next level; the watcher's only key is
      // the way out, which LEVEL COMPLETE did not have either.
      {
        const _oSpec3 = netSpectating, _oCt = ct, _oSess3 = _netSess, _oIn3 = inGame, _oPh3 = phase, _oLdw = levelDoneWaiting, _oPa = phaseAt;
        let on3 = true; netSpectating = () => on3;
        _netSess = _netMkSess('', 'peer'); _netSess.game = true; inGame = true;
        phase = 'levelDone'; levelDoneWaiting = true; phaseAt = 0; _lvlCover = false;
        const drawn = []; ct = (t) => { drawn.push(String(t)); };
        const BLINK_ON = 1040;                      // an instant the player's hint is lit
        drawLevelDoneFx(BLINK_ON);
        if(drawn.some(t => /next/.test(t))) throw 'a watcher was offered the advance: ' + JSON.stringify(drawn);
        if(!drawn.some(t => t === 'ESC:back')) throw 'and its way out must be said: ' + JSON.stringify(drawn);
        handleKey('Enter', () => {});
        if(_lvlCover) throw 'the press covered the watcher board';
        if(_netSess.tx) throw 'the press parked a req nothing will echo';
        if(phase !== 'levelDone') throw 'the press moved the watcher off the board, to ' + phase;
        handleKey('Escape', () => {});
        if(phase !== 'quitConfirm' || prevPhase !== 'levelDone') throw 'ESC on LEVEL COMPLETE must ask a watcher whether to leave, got ' + phase;
        Snd.duck(false); phase = 'levelDone';
        // THE CONTROL: a player on the same screen keeps both the hint and the ask.
        on3 = false; drawn.length = 0;
        drawLevelDoneFx(BLINK_ON);
        if(!drawn.some(t => /A:next/.test(t))) throw 'a player must still be offered the advance: ' + JSON.stringify(drawn);
        handleKey('Enter', () => {});
        if(!_lvlCover || !_netSess.tx || _netSess.tx.pkt.why !== 'level') throw 'a player pressing A must still ask for the level';
        _netSess.tx = null; _lvlCover = false;
        ct = _oCt; netSpectating = _oSpec3; _netSess = _oSess3; inGame = _oIn3; phase = _oPh3; levelDoneWaiting = _oLdw; phaseAt = _oPa;
      }
      log('watcher level-done ok: no advance offered or taken, ESC is the way out, a player keeps both');

      // ---- THE MONITOR IS DEALT THE SHEET (server API 4.14) ---------------
      // Field report from a TV: the monitor joined every round up to 30 s late and
      // showed a lobby long after it opened. It was on no participant list, so the
      // tournament pushed it nothing; its own 30 s lease read was the only thing that
      // ever told it a match was in flight. Now the server deals it the same signals
      // the participants get, and tourney.js hands them to the screen when the tid is
      // not one it holds. A sheet IS the state read: adopted and followed at once.
      {
        const _oSpec4 = netSpectating, _oWatch4 = specWatch, _oStop4 = specStop, _oRead4 = eventMonitorRead, _oTt = _tt, _oAsk = specAsking;
        let on4 = false, asked = [], reads4 = 0, asking = false;
        netSpectating = () => on4;
        specWatch = (peer, tid, nid) => { asked.push(peer + '/' + tid + '/' + nid); };
        specStop = () => { on4 = false; };
        specAsking = () => asking;
        eventMonitorRead = async () => { reads4++; return true; };
        _tt = null;
        _evEid = 'K7QM'; _evMonT = 1; _evMon = { eid:'K7QM', tourney:null }; _evMonNid = ''; _evMonAskAt = 0; _evMonTry = 0; _evMonAfter = 0;
        const sheet = (extra) => Object.assign({ event:'roles', tid:'t1', eid:'K7QM', nid:'n1', round:1, players:['c0ffee42','dddddddd'], feeder:'c0ffee42', primaries:[], secondaries:[], names:{}, monitor:getPlayerId(), you:'idle' }, extra || {});
        // A sheet for the monitored event, for a tid this client does not hold: the feed
        // is asked for the instant it lands, of the feeder, naming the node.
        _ttOnSignal(sheet());
        if(asked.length !== 1 || asked[0] !== 'c0ffee42/t1/n1') throw 'the sheet must ask the feeder for the feed at once, got ' + JSON.stringify(asked);
        if(!_evMon.tourney || !_evMon.tourney.roles || _evMon.tourney.roles.nid !== 'n1') throw 'the sheet is the state read: it must be adopted';
        if(reads4 !== 0) throw 'a sheet is not a reason to ask for a read, got ' + reads4;
        // The sheet's stagger is owed by a watcher too: nothing goes on the wire before
        // after_ms, and the one-shot that waits it out is not the 4 s tick.
        asked.length = 0; _evMonNid = ''; _evMonAskAt = 0;
        _ttOnSignal(sheet({ nid:'n2', after_ms:300 }));
        if(asked.length) throw 'a sheet with after_ms must not be asked on at once: ' + JSON.stringify(asked);
        if(!(_evMonAfter > _msgNow())) throw 'the stagger must be recorded';
        _evMonAfter = 0; _evMonFollow();
        if(asked.length !== 1 || asked[0] !== 'c0ffee42/t1/n2') throw 'and asked on once it has passed, got ' + JSON.stringify(asked);
        // While net-spec's own ladder is still re-sending the ask, the follow stays out
        // of it. The ladder giving up is what makes the follow ask again -- of the OTHER
        // player, because a monitor hangs off the feeder directly and has no primary to
        // fall back on.
        asked.length = 0; asking = true; _evMonAskAt = _msgNow() - EV_MON_WATCH_MS - 1;
        _evMonFollow();
        if(asked.length) throw 'an ask still on the ladder must not be repeated: ' + JSON.stringify(asked);
        asking = false; _evMonFollow();
        if(asked.length !== 1 || asked[0] !== 'dddddddd/t1/n2') throw 'the re-ask goes to the other player, got ' + JSON.stringify(asked);
        asked.length = 0; _evMonAskAt = _msgNow() - EV_MON_WATCH_MS - 1; _evMonFollow();
        if(asked.length !== 1 || asked[0] !== 'c0ffee42/t1/n2') throw 'and back to the feeder, got ' + JSON.stringify(asked);
        // A patch re-wires the tree and asks for nothing; every other transition is a
        // hint that the picture moved, answered by the monitor's own read.
        asked.length = 0; on4 = true;
        _ttOnSignal({ event:'roles-patch', tid:'t1', eid:'K7QM', nid:'n2', primaries:['eeeeeeee'], secondaries:[] });
        if(asked.length || reads4) throw 'a patch asks for nothing';
        if(_evMon.tourney.roles.primaries[0] !== 'eeeeeeee') throw 'a patch re-wires the sheet held';
        for(const ev of ['result', 'round', 'standings', 'over', 'lobby']) _ttOnSignal({ event:ev, tid:'t1', eid:'K7QM', nid:'n2' });
        if(reads4 !== 5) throw 'every other transition re-reads the monitor, got ' + reads4;
        // Not the monitored event, or the monitor not up: nothing.
        reads4 = 0; asked.length = 0; on4 = false; _evMonNid = ''; _evMonAskAt = 0;
        _ttOnSignal(sheet({ eid:'ZZZZ', nid:'n3' }));
        _evMonT = null; _ttOnSignal(sheet({ nid:'n4' }));
        if(asked.length || reads4) throw 'a sheet for another event, or with no monitor up, is not ours: ' + JSON.stringify(asked) + ' ' + reads4;
        // ...and a read asked for while one is in flight is not dropped.
        eventMonitorRead = _oRead4;
        const _oPost4 = _evPost; let posts4 = 0, release = null;
        _evPost = () => { posts4++; return new Promise(res => { release = () => res({ json:{ ok:true, tourney:null } }); }); };
        _evMonT = 1; _evMonBusy = false; _evMonAgain = false;
        const p1 = eventMonitorRead(); const p2 = eventMonitorRead();
        if(posts4 !== 1) throw 'one read in flight, got ' + posts4;
        release(); await p1; await p2; await new Promise(r => setTimeout(r, 0));
        if(posts4 !== 2) throw 'the read asked for during a read must follow it, got ' + posts4;
        if(release) release();
        await new Promise(r => setTimeout(r, 0));
        _evPost = _oPost4; _evMonT = null; _evMon = null; _evMonNid = ''; _evMonAskAt = 0; _evMonTry = 0; _evMonAfter = 0; _evMonAgain = false; _evMonBusy = false; _evEid = '';
        netSpectating = _oSpec4; specWatch = _oWatch4; specStop = _oStop4; specAsking = _oAsk; _tt = _oTt;
      }
      log('monitor sheet ok: dealt like a spectator, followed at once, the stagger owed, the re-ask goes to the other player, every other transition re-reads');

      // ---- AND THE FEEDER SERVES IT ON A SLOT OF ITS OWN --------------------
      // Invisible means it costs nobody anything: the two direct slots are counted
      // over everyone but the monitor, it always has room, and it is never handed out
      // as an alt -- it feeds nobody. Granted off the sheet's own field, which is what
      // lets a MAKE DUELS PRIVATE player feed it at all.
      {
        const _oOut = _spOut, _oAsk5 = _spAsk, _oGrant = _spGrant, _oTt5 = _tt, _oNid = _ttNid;
        _spGrant = {}; _spAsk = [];
        specMonitor('abcdef01');
        _spOut = [{ peer:'11111111' }, { peer:'22222222' }];
        if(!_spRoomNow('abcdef01')) throw 'the monitor has room beside two primaries';
        if(_spRoomNow('33333333')) throw 'a third person does not';
        _spOut = [{ peer:'abcdef01' }, { peer:'11111111' }];
        if(!_spRoomNow('22222222')) throw 'the monitor costs nobody a slot';
        if(!_spRoomLater('22222222')) throw 'nor a parked ask';
        _spAsk = [{ from:'22222222', at:0 }];
        if(_spRoomLater('33333333')) throw 'two people held is full';
        if(!_spRoomLater('abcdef01')) throw 'the monitor may always be held';
        const alts = _spAlts();
        if(alts.length !== 1 || alts[0] !== '11111111') throw 'the monitor is never an alt: ' + JSON.stringify(alts);
        specMonitor('');
        if(_spRoomNow('abcdef01')) throw 'with no monitor named it is a third person again';
        // The grant comes off the sheet, on the sheet and on a patch, and goes with the tournament.
        _tt = { tid:'t9', schedule:[], bracket:[], roles:null, state:'running' }; _ttNid = '';
        _ttRoles({ event:'roles', tid:'t9', nid:'n9', players:['11111111','22222222'], feeder:'11111111', primaries:[], secondaries:[], names:{}, monitor:'abcdef01', you:'idle' });
        if(!_spGrantOk('abcdef01')) throw 'the sheet grants the monitor';
        if(_spMonitor !== 'abcdef01') throw 'and names it to the serving side';
        _spGrant = {};
        _ttPatch({ event:'roles-patch', tid:'t9', nid:'n9', primaries:['33333333'], secondaries:[] });
        if(!_spGrantOk('abcdef01')) throw 'a patch keeps the grant';
        _ttDrop('');
        if(_spMonitor) throw 'dropping the tournament forgets the monitor';
        _spOut = _oOut; _spAsk = _oAsk5; _spGrant = _oGrant; _tt = _oTt5; _ttNid = _oNid;
      }
      log('monitor slot ok: room beside two primaries, costs nobody a slot, never an alt, granted off the sheet and the patch, forgotten with the tournament');


      // ---- AND SCANNING A POSTER EARLY LANDS ON THE LIST --------------------
      // Server 4.13: a printed KEY admits while the event is upcoming (a live pass
      // does not -- there is no clock to mint one from before it starts). The scan is
      // a deliberate act with a result, and the result the user asked for is the ROW:
      // opening a page that the same scan cannot reopen a moment later would say the
      // opposite of what the dark row says.
      {
          const _oPostJoin = _evPostJoin, _oHello = _netHello;
          let hellos = 0;
          _netHello = () => { hellos++; return null; };
          const now4 = (typeof netPts === 'function' && netPts() != null) ? netPts() : Date.now();
          const answer = (x) => ({ json:Object.assign({ ok:true, eid:'U9QM', name:'NEXT WEEK',
                                     state:'upcoming', starts:now4 + 9e8, now:now4,
                                     you:{ state:'member', organizer:false } }, x||{}),
                                   status:200, body:{} });
          _evPostJoin = async () => answer();
          _evList = []; _ev = null; _evEid = ''; _evUi.busy = false; phase = 'eventPage';
          if(await eventJoin('ABCDEFGHJKM') !== true) throw 'a key must admit before the start';
          if(phase !== 'eventChooser') throw 'an early join lands on the LIST, got '+phase;
          if(!/YOU ARE IN/.test(_evUi.msg || '')) throw 'and it says the scan worked, got '+JSON.stringify(_evUi.msg);
          if(!hellos) throw 'the list must be re-asked for, or the new row never appears';
          if(_evEid !== 'U9QM') throw 'the answer still says which event it was';
        // ...and the LIST has its own way out. It cannot read _eventBack at the time
        // -- that is the PAGE's, and a row opening one overwrites it with
        // 'eventChooser', which would make BACK from the list return to the list.
        UI_INPUT.eventChooser.back();
        if(phase !== 'multiplayer') throw 'a scan from the multiplayer camera goes back there, got '+phase;
        // A deep link spent at BOOT walked through no submenu, so it owes none.
        _eventBack = 'menu'; _evUi.busy = false; _ev = null; _evEid = ''; phase = 'eventPage';
        await eventJoin('ABCDEFGHJKM');
        if(phase !== 'eventChooser') throw 'a boot link to an upcoming event still lands on the list';
        UI_INPUT.eventChooser.back();
        if(phase !== 'menu') throw 'and its BACK owes the menu, not a submenu nobody walked through, got '+phase;
        _eventBack = 'multiplayer';
          // THE ACHIEVEMENT IS NOT GRANTED EARLY. The server omits ach while the
          // event is upcoming and sends it on the first answer after it starts, so the
          // only thing owed here is that an absent one is a no-op -- and that the
          // unlock is not faked from anything else in the answer.
          if(achEventDefs()['ev_U9QM']) throw 'an upcoming event must grant nothing yet';
          // ...and once it HAS started, the ordinary read grants it exactly as before.
          _evPostJoin = async () => answer({ state:'active', starts:now4 - 1000,
                                             ach:{ id:'ev_U9QM', name:'EARLY BIRD', desc:'Joined NEXT WEEK' } });
          _ev = null; _evEid = ''; _evUi.busy = false; phase = 'eventPage';
          if(await eventJoin('ABCDEFGHJKM') !== true) throw 'and a live event still joins';
          if(phase !== 'eventPage') throw 'a join into a RUNNING event still opens its page, got '+phase;
          if(!achEventDefs()['ev_U9QM']) throw 'a started event grants the achievement on the way in';
          // A PENDING row is neither: it waits, wherever the event is in its schedule.
          _evPostJoin = async () => answer({ you:{ state:'pending' } });
          _ev = null; _evEid = ''; _evUi.busy = false; phase = 'eventPage';
          await eventJoin('ABCDEFGHJKM');
          if(!/APPROVAL/.test(_evUi.msg || '')) throw 'a pending row still says it is waiting';
          _evPostJoin = _oPostJoin; _netHello = _oHello;
          _evList = []; _ev = null; _evEid = ''; _evUi.msg = ''; phase = 'eventPage';
      }
      log('early join ok: a key admits before the start, lands on the list, and grants nothing until the night');

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
    // THE FIRST DRIVER BLOCK IS SYNCHRONOUS BY CONSTRUCTION -- the runner reads
    // __async off the end of it -- so an await placed in there defers everything
    // after it, the second block included, while the banner still reads PASSED.
    // R.ok is set on that block's last line, so a missing one names the mistake.
    if (!R.ok) { console.log('\nSMOKE-EVENTS FAIL: the synchronous block did not finish -- an await in it defers the rest'); process.exit(1); }
    console.log('\nSMOKE-EVENTS PASSED');
})();
