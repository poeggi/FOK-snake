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

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
