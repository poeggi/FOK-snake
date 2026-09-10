// EVENTS smoke (server API 4.11): the deep link and the scanner, the 53-byte QR
// budget, and the derived event state. Everything here is the CLIENT half of
// FOK-server docs/API.md "Events (4.11)".
// Run: node test/smoke-events.js
const { runTest } = require('./harness');

runTest('SMOKE-EVENTS', `
;(function(){
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
        const poll=(ph)=>{ _u=null; _netPollBusy=false; phase=ph; _netPollOnce(); return _u||''; };
        const hello=(ph)=>{ _body=null; _netHelloBusy=false; phase=ph; _netHello(); return _body||{}; };

        for(const ph of ['multiplayer','eventChooser','eventPage','eventMembers','eventQr','eventMonitor']){
            if(!/[?&]ev=1(&|$)/.test(poll(ph))) throw 'the poll must ask for events on '+ph;
            if(hello(ph).events !== true) throw 'the hello must ask for events on '+ph;
        }
        for(const ph of ['menu','friends','duelLobby','tourneyLobby','settings']){
            if(/[?&]ev=/.test(poll(ph))) throw 'the poll must NOT ask for events on '+ph;
            if('events' in hello(ph)) throw 'the hello must NOT ask for events on '+ph;
        }
        _netGet=_oGet; _netPost=_oPost; globalThis.fetch=_oFetch;
        _netPace=_oPace; _netPollHoldEnd=_oHold; _netPollBusy=false; _netHelloBusy=false; phase='menu';
    }
    log('request shape ok: events rides the hello and the poll on the six screens that show it');

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
