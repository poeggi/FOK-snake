// ============================================================================
// EVENTS (server API 4.11) -- a room an operator opens on the server.
//
// A player gets in by scanning its QR: straight in when the event is OPEN, after
// the organizer approves them when it is CLOSED. Inside, the organizer runs
// tournaments only members can see or join, past tournaments are archived on the
// event, joining grants a secret achievement, and any member can pass the event
// on with a QR that lives 20 seconds.
//
// THE SERVER IS THE ROSTER, and that is the one rule this file is built around.
// Membership is rows on the server and nothing else: every screen reads fresh,
// this file keeps no copy past the screen showing it, nothing reconciles at
// startup and nothing goes in the vault. It is deliberately NOT the friends-list
// pattern -- a local copy plus a startup reconciliation is what makes a restored
// config fire a burst of requests. A member learns it was removed by the event
// no longer being in the `events` list.
//
// FEATURE-DETECTED, never version-gated: we ask for the field and use it if the
// answer carries it. Against a server with no events at all every call 404s and
// the menu entry simply never appears, which is the same thing as not being in
// an event.
//
// An event TOURNAMENT is an ordinary tournament (tourney.js, unchanged): `eid`
// is a tag on it and a membership check on the way in, nothing more. The event
// MONITOR is an ordinary SPECTATOR (net-spec.js, unchanged): it asks a player
// for a feed with the ordinary 'watch' signal and the feed is peer to peer.
// Neither has a second implementation here and neither may grow one.
// ============================================================================

// ---- constants -------------------------------------------------------------
// The pass answer states its own step and validity (they are admin-configurable
// server-side), so nothing here hard-codes 10 and 20. These are the fallbacks
// for an answer that omits them, and the bounds that keep a wrong number from
// turning the QR screen into a request loop.
const EV_STEP_MS_DEF = 10000, EV_VALID_MS_DEF = 20000;
const EV_STEP_MS_MIN = 2000, EV_STEP_MS_MAX = 120000;

// ---- state -----------------------------------------------------------------
// THE WHOLE OF IT, and all of it is a picture of the last answer rather than a
// record of anything. _evList is what the `events` flag on hello/poll last said;
// _ev is the event page's own read. Both are dropped when the screen closes.
var _ev = null;          // the open event page's `state` answer
var _evList = [];        // the caller's rows, from hello/poll -- the menu entry reads this
var _evEid = '';         // which event the page is showing
var _evUi = { sel:0, msg:'', msgAt:0, bad:false, busy:false };
// _eventLink -- the parked deep link -- is declared in game.js, where the boot
// hash is read before any of this exists. It is spent by eventEnter().
// Where the page's BACK goes. MULTIPLAYER for a page opened from the menu, the MENU
// itself for one a deep link opened at boot -- nobody walked through a submenu to get
// there, so sending them back to one would be inventing a step they never took.
var _eventBack = 'multiplayer';

// ---- the list, and the only way we know we are in an event ------------------
// Asked for on the screens that show it and nowhere else -- the same rule the
// roster and the tournament announce follow, and for the same reason: the flag
// rides a request that was going out anyway, so a screen nobody is looking at
// costs the server nothing.
const _EV_SCREENS = { eventChooser:1, eventPage:1, eventMembers:1, eventQr:1, eventMonitor:1, eventStats:1 };
// An event screen is open. It is a MATCHMAKING screen like the lobby and the tournament
// ones: the four `event` signals arrive in the ordinary mailbox, and the monitor's watch
// handshake has nowhere else to land -- so net-api.js polls and HOLDS on these too.
function eventScreen(){ return !!_EV_SCREENS[phase]; }
// ...and MULTIPLAYER wants the list without being one, because that is the screen the
// entry appears on.
function _netEvWant(){ return phase === 'multiplayer' || eventScreen(); }
// THE one landing place, whichever request brought it. An answer WITHOUT the key
// is a server that does not serve events, or a 204 that carries nothing at all --
// neither is an empty roster, so the list stands. An EMPTY ARRAY is the real
// answer for "you are in none", and that is how a removed member finds out.
function _netEvApply(v){
    if(!Array.isArray(v)) return;
    _evList = v;
    // The page is a member's view of a room. Losing the row means losing the room:
    // there is nothing left to read and nothing left to show.
    if(_evEid && !_evRow(_evEid) && _ev){ _ev = null; _evMsg('YOU ARE NOT IN THIS EVENT', true); }
    _uiDirty = true;
}
function _evRow(eid){ for(const e of _evList) if(String(e.eid) === String(eid)) return e; return null; }

function eventList(){ return _evList; }
function eventView(){ return _ev; }
function eventUi(){ return _evUi; }
// Are we in any event at all? The list is the only answer to that question.
function eventAny(){ return _evList.length > 0; }
// The transient status line, shared with the tournament screens (uiMsg, game.js):
// same stamp, same sound, same band on screen. All this adds is `bad`, which the
// event page reads to colour it.
function _evMsg(m, bad){ uiMsg(_evUi, m, bad ? 'fail' : ''); _evUi.bad = !!bad; }
function _evOk(){ return typeof _netOk === 'function' && _netOk() && typeof _netPostRes === 'function'; }

// ---- the endpoint ----------------------------------------------------------
// event.php is the same shape of endpoint as tournament.php and goes out through
// the same wrapper (netActionPost, net-api.js) on the same lane. All this adds is
// the eid, which every action requires.
//
// Every action but `join` needs a ROW, and a caller with no row is answered 404
// exactly like an eid that does not exist -- so nothing here can enumerate, and
// nothing here should try to tell the two apart.
async function _evPost(action, extra){
    return await netActionPost('/api/event.php', action,
                               Object.assign({ eid:_evEid }, extra || {}));
}
// ...except JOIN, which is the one action asked by somebody who has no row yet
// and therefore no eid to name. It posts THE CODE EXACTLY AS SCANNED and the
// server reads the event out of it: a pass carries the eid in front of its own
// dot, a printed key names its own event and has no dot at all. Sending an eid
// here would be the client guessing at something it cannot know from a key.
async function _evPostJoin(code){
    return await netActionPost('/api/event.php', 'join', { code:code });
}

// ---- getting in ------------------------------------------------------------
// The seven answers a join can give, each in its own words. A 404 is a wrong
// code AND an expired one AND an eid that does not exist, on purpose: one answer
// for all of them is what stops an eid being worth guessing.
function _evJoinFail(r){
    const j = r.body || {};
    const err = String(j.error || '');
    if(r.status === 429){
        const w = Math.max(1, Math.ceil(+(j.retry_after || 60)));
        return 'TOO MANY TRIES - WAIT ' + (w >= 120 ? Math.ceil(w/60) + ' MIN' : w + 'S');
    }
    if(r.status === 403) return err === 'banned' ? 'YOU CANNOT JOIN THIS EVENT' : 'NOT ALLOWED';
    if(r.status === 409){
        if(err === 'not started') return 'THIS EVENT HAS NOT STARTED YET';
        if(err === 'paused')      return 'THIS EVENT IS PAUSED';
        if(err === 'ended')       return 'THIS EVENT HAS ENDED';
        return 'NOT RIGHT NOW';
    }
    if(r.status === 404) return 'NO SUCH EVENT - WRONG OR EXPIRED CODE';
    return 'COULD NOT REACH THE EVENT';
}
// Scan -> row. Idempotent at the server, so a lost answer costs nothing: asking
// again answers what the first one did, achievement included.
async function eventJoin(code){
    if(_evUi.busy) return false;
    if(!_evOk()){ _evMsg('EVENTS NEED A NETWORK', true); return false; }
    _evUi.busy = true; _evMsg('JOINING...');
    const r = await _evPostJoin(String(code || '').toUpperCase());
    _evUi.busy = false;
    if(!r.json){ _ev = null; _evMsg(_evJoinFail(r), true); return false; }
    // WHICH EVENT this was is the ANSWER's to say, not the code's. A pass shows
    // its eid and a key does not, so there is exactly one way to learn it that
    // works for both: read it back off the state the join returns -- which is
    // what _evAdopt already does with every eid it is handed, so it does it here.
    _evAdopt(r.json);
    const pending = _evYou() === 'pending';
    _evMsg(pending ? 'WAITING FOR APPROVAL' : 'YOU ARE IN');
    if(!pending){
        Snd.sfxPlay('select', cfg.music);
        _evGrantAch(r.json.ach);
    }
    return true;
}

// ---- the page --------------------------------------------------------------
// Every answer is the same picture from a different distance, so one landing
// place takes all of them. Absent keys are LEFT ALONE for the same reason the
// tournament merge leaves them: a monitor answer says nothing about an archive
// a state answer already delivered.
function _evAdopt(o){
    if(!o || typeof o !== 'object') return;
    if(!_ev || _ev.eid !== o.eid) _ev = {};
    for(const k in o) if(k !== 'ok') _ev[k] = o[k];
    if(_ev.eid) _evEid = String(_ev.eid);
    _uiDirty = true;
}
// What WE are in this event: 'member', 'pending', 'monitor', or '' when we are
// not in it at all. `you.state` is the only thing that tells the two waits apart
// -- an event before its start is `upcoming`, a member row before approval is
// `pending`, and they meet in one answer.
function _evYou(){ return (_ev && _ev.you && String(_ev.you.state)) || ''; }
function eventYou(){ return _evYou(); }
function eventIsOrganizer(){ return !!(_ev && _ev.you && _ev.you.organizer); }
function eventIsMember(){ return _evYou() === 'member'; }

// The state, DERIVED rather than read. `starts` and `ends` are unix ms on the
// same clock as `now`, and nothing is pushed when either moment arrives, so a
// scheduled event flips on this function and on nothing else. Ended is terminal
// and outranks everything, then a schedule outranks the mode it was set on.
function eventState(e){
    e = e || _ev;
    if(!e) return '';
    const mode = String(e.state || '');
    if(mode === 'ended') return 'ended';
    const now = _evNow();
    if(now == null) return mode;                        // no synced clock: take the server's word
    if(e.ends != null && now >= +e.ends) return 'ended';
    if(mode === 'paused') return 'paused';
    if(e.starts != null && now < +e.starts) return 'upcoming';
    if(e.starts != null) return 'active';
    return mode;
}
// The schedule, in the reader's OWN time. starts/ends are unix milliseconds on
// the server clock; a person in the room reads a wall clock, so the conversion
// is the whole job. An event with no schedule has no line -- its organizer drives
// it by hand and there is nothing to announce.
// One scheduled moment in the reader's own time. starts/ends are unix
// MILLISECONDS -- not the seconds eventDay takes -- and this is the only place
// that renders one, so the page and the list cannot drift apart about it.
function eventClock(ms){
    const d = new Date(+ms);
    return pad2(d.getDate()) + '.' + pad2(d.getMonth()+1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function eventWhen(e){
    e = e || _ev;
    if(!e || (e.starts == null && e.ends == null)) return '';
    if(e.starts != null && e.ends != null) return eventClock(e.starts) + ' - ' + eventClock(e.ends);
    return e.starts != null ? 'FROM ' + eventClock(e.starts) : 'UNTIL ' + eventClock(e.ends);
}
// WHAT A LIST ROW SAYS ON THE RIGHT, and it is a COLUMN, not a line: the page can
// afford 'NOT STARTED YET' across its whole width, a row cannot. An event that has
// not started says WHEN instead, which is what a reader wants from a list of what
// is coming and is shorter into the bargain. Waiting to be let in outranks the
// event's own word -- it is the part that concerns this reader.
function eventListTag(e){
    if(!e) return ['', '#888'];
    if(((e.you && String(e.you.state)) || '') === 'pending') return ['WAITING', '#ffd700'];
    const st = eventState(e);
    if(st === 'upcoming') return [e.starts != null ? eventClock(e.starts) : 'SOON', '#ffd700'];
    if(st === 'paused')   return ['PAUSED', '#ffd700'];
    if(st === 'ended')    return ['ENDED', '#888'];
    if(st === 'active')   return ['LIVE', '#7fff7f'];
    return ['', '#888'];
}
// The server clock, which is what starts/ends are stated against. netPts() is
// the synced reading; without one there is nothing to derive against and the
// mode the server named stands.
function _evNow(){
    if(typeof netPts === 'function'){ const p = netPts(); if(p != null) return p; }
    return null;
}

// ---- reading it ------------------------------------------------------------
// The page's own read, and the ONLY place the page's picture comes from. Called
// on every open and on every `event` signal that says something moved -- never
// on a timer, because nothing here changes without something happening.
async function eventRead(){
    if(!_evEid || !_evOk()) return false;
    const r = await _evPost('state');
    if(!r.json){
        // Gone means gone: removed, banned, or an event that was purged. Drop the
        // page rather than leave a picture of a room we are not in any more.
        if(r.status === 404 || r.status === 403){ _ev = null; _evMsg('YOU ARE NOT IN THIS EVENT', true); }
        return false;
    }
    _evAdopt(r.json);
    // A member's state re-carries the achievement on every read, so a reinstall
    // or a restored config gets it back here without anybody noticing.
    _evGrantAch(r.json.ach);
    return true;
}
// Opening the page for one event. The eid is all that is kept between screens;
// everything else is asked for again.
function eventOpen(eid){
    const id = String(eid || '').toUpperCase();
    if(id !== _evEid){ _ev = null; _evEid = id; }
    _evUi.sel = 0; _evUi.msg = '';
    phase = 'eventPage';
    eventRead();
    _uiDirty = true;
}
// THE ROOMS YOU ARE IN, grouped by what is happening in them. LIVE first --
// that is the room you are standing in and the only one with anything to press
// tonight -- then what is coming, then what is over, which is a record rather
// than a door.
//
// ONE FLAT LIST, headings and rows together, because the draw and the input have
// to agree about what is where: a heading the cursor can land on is a row that
// can be pressed on nothing. A heading is an entry with `head` and no `eid`.
const _EV_GROUPS = [
    { t:'LIVE NOW',  has:st => st === 'active' || st === 'paused' },
    { t:'COMING UP', has:st => st === 'upcoming' },
    { t:'FINISHED',  has:st => st === 'ended' },
];
function eventChooserRows(){
    const out = [], left = _evList.slice();
    for(const g of _EV_GROUPS){
        const rows = left.filter(e => g.has(eventState(e)));
        if(!rows.length) continue;
        // Inside a group, the one you want first: what starts soonest is next, what
        // finished last is the freshest record, and a live room is sorted by name
        // because they are all happening now and nothing else separates them.
        rows.sort((a, b) => {
            const st = eventState(a);
            if(st === 'upcoming') return (+a.starts || 0) - (+b.starts || 0);
            if(st === 'ended')    return (+b.ends || 0) - (+a.ends || 0);
            const an = String(a.name || a.eid), bn = String(b.name || b.eid);
            return an < bn ? -1 : an > bn ? 1 : 0;
        });
        out.push({ head:g.t });
        for(const e of rows) out.push({ eid:String(e.eid || ''), e:e });
    }
    // An event whose state is a word we do not know still has to be reachable: it
    // is a room somebody is in, and a screen that silently drops it is worse than
    // one that shows it under a plain heading.
    const seen = {};
    for(const r of out) if(r.eid) seen[r.eid] = 1;
    const rest = left.filter(e => !seen[String(e.eid || '')]);
    if(rest.length){
        out.push({ head:'EVENTS' });
        for(const e of rest) out.push({ eid:String(e.eid || ''), e:e });
    }
    return out;
}
// Where the cursor may sit: never a heading, and BACK (the index past the end)
// when there is nothing else at all.
function eventChooserPickable(rows, i){
    rows = rows || eventChooserRows();
    return i >= rows.length || !!(rows[i] && rows[i].eid);
}
function eventChooserFirst(){
    const rows = eventChooserRows();
    for(let i = 0; i < rows.length; i++) if(rows[i].eid) return i;
    return rows.length;                                  // nothing to pick: BACK
}
// THE MENU ENTRY. It always opens the LIST, even for one room: which events you
// are in is itself worth seeing -- when the next one starts, what is over -- and
// a door that sometimes opens a list and sometimes a page is two doors.
function eventsEnter(){
    _evUi.msg = '';
    phase = 'eventChooser';
    _evUi.sel = eventChooserFirst();
    // The list is a picture of the last answer, so freshen it on the way in: a row
    // that has gone is a room we have been removed from, and the chooser is where
    // that shows.
    if(typeof _netHello === 'function' && _netOk()) _netHello();
    _uiDirty = true;
}
// THE DOOR into events, and the one place a parked deep link is spent. It waits
// for the hello for the same reason the tournament link does: the answer needs a
// network, and an unanswered hello reads exactly like a server with no events.
function eventEnter(){
    _evUi.sel = 0; _evUi.msg = '';
    // THE PHASE IS SET HERE, and it has to be: this is reached from the menu as
    // well as from the boot hash. The boot path happens to set it first (the
    // splash exit picks its own destination), which is exactly what hid this --
    // from the MULTIPLAYER row the whole function ran and the screen never moved,
    // so the entry looked dead on every device.
    phase = 'eventPage';
    const spend = () => {
        const l = _eventLink;
        if(!l){ if(_evEid) eventRead(); return; }
        _eventLink = null;
        eventJoin(l);
    };
    if(typeof _netHello === 'function' && _netOk()){
        const h = _netHello();
        if(h && typeof h.then === 'function') h.then(spend, spend); else spend();
    } else spend();
    // An event link is a multiplayer door like any other: the same age-gated
    // anchor refresh, so the schedule is derived against a clock worth deriving
    // against.
    if(typeof _netAnchorRefresh === 'function') _netAnchorRefresh({ nudge:true });
    _uiDirty = true;
}
// Leaving the page. The picture goes with it -- the next open reads again.
function eventPageLeave(to){
    _ev = null; _evUi.msg = ''; _evUi.busy = false;
    phase = to || 'multiplayer';
    _uiDirty = true;
}

// ---- what the page can do --------------------------------------------------
// THE ROWS, in one place because most of them come and go -- with the door, the
// schedule, the state and who we are. The draw and the input both read this, for
// the same reason the multiplayer menu does: a list whose length changes is
// exactly what makes two hard-coded index sets drift apart.
//
// A PENDING row gets none of them. It sees the public face and nothing else, and
// the server would refuse every one of these anyway -- but a screen that offers
// what it knows will be refused is a screen that lies.
// Rows carry `en` and `note` like the other menus do (drawMenuRows): a row that
// is shown but not pressable is dark and says why, rather than vanishing.
// Anything that does not set `en` is enabled.
function eventRowOk(r){ return !r || r.en !== false; }
function eventRows(){
    const e = _ev, rows = [];
    if(!e || _evYou() === 'pending') return rows;
    const st = eventState(e), org = eventIsOrganizer(), scheduled = e.starts != null || e.ends != null;
    // A RESERVED MONITOR may call state and monitor and NOTHING else, so it is
    // offered exactly one row -- the screen it exists to be. It is not a member: no
    // pass, no roster, no leaving, and the server refuses all of it with
    // `monitor only`.
    //
    // Returning an EMPTY list here, which is what this did first, left the one
    // account that most needs the row unable to reach it: an operator names a TV as
    // the monitor, the TV opens the event, and the page has nothing on it at all.
    if(_evYou() === 'monitor'){
        if(eventMonitorOffered(e)) rows.push({ t:'EVENT MONITOR', go:'monitor' });
        return rows;
    }
    // ONE ROW ABOUT THE TOURNAMENT, and which one depends on what you can do
    // about it. Everybody gets a way IN while one is running. Only the organizer
    // is offered the CREATE, because it is the only one who can press it -- a
    // member seeing a permanently dark CREATE learns nothing except that there is
    // something they may not do.
    const live = !!(e.tourney && e.tourney.tid);
    if(live){
        rows.push({ t:'JOIN EVENT TOURNAMENT', go:'tourney' });
    } else if(org){
        // Dark rather than absent HERE, because this row is the organizer's own and
        // the reason it cannot be pressed is temporary: the event is paused, or has
        // not started, or has ended.
        rows.push({ t:'CREATE TOURNAMENT', go:'newtourney',
                    en: st === 'active',
                    note: st === 'paused' ? 'NOT WHILE THE EVENT IS PAUSED'
                        : st === 'ended' ? 'THIS EVENT HAS ENDED'
                        : 'NOT STARTED YET' });
    } else {
        rows.push({ t:'JOIN EVENT TOURNAMENT', go:'tourney',
                    en: false, note:'NO TOURNAMENT RIGHT NOW' });
    }
    // THE SCREEN FOR A TV. Offered only where the event says it has one -- asking
    // is not taking, and `monitor_allowed` exists so this row can be decided
    // without claiming the slot off a TV that is merely switched off.
    if(eventMonitorOffered(e)) rows.push({ t:'EVENT MONITOR', go:'monitor' });
    // Any member may pass the event on while it is ACTIVE -- that is what makes it
    // spread in a room. Not before it starts, not while it is paused, and never
    // once it has ended: the server mints no pass then, so nothing here offers one.
    if(st === 'active') rows.push({ t:'SHOW EVENT QR', go:'pass' });
    // The roster, read fresh every time it is opened. A member sees who is in the
    // room; the organizer sees the door as well.
    rows.push({ t:'MEMBERS', go:'members' });
    // WHAT THE ROOM HAS DONE, on a screen of its own. It used to be three archive
    // lines squeezed under the rows on the page, which is where they were least
    // readable and most in the way -- a date, two counts and a run of clipped names
    // with no room to say what any of it meant.
    rows.push({ t:'EVENT STATISTICS', go:'stats' });
    if(org && !scheduled && st !== 'ended'){
        // RUN and PAUSE are the same row wearing the state it would move to. END
        // is its own, and it is behind a confirm because it is terminal for
        // everybody, not just for the organizer.
        rows.push(st === 'active' ? { t:'PAUSE THE EVENT', go:'pause' } : { t:'START THE EVENT', go:'run' });
        rows.push({ t:'END THE EVENT', go:'end' });
    }
    if(org && st !== 'ended') rows.push({ t:e.closed ? 'DOOR: CLOSED' : 'DOOR: OPEN', go:'access' });
    // The organizer cannot leave its own event: leaving would abandon the room it
    // is running, and the server refuses it. Nobody else is kept.
    if(!org) rows.push({ t:'LEAVE EVENT', go:'leave' });
    return rows;
}
// One shape for every organizer verb: ask, then re-read. Nothing here adopts its
// own optimistic answer -- the server is the truth about the room, and a verb
// that half-worked would otherwise leave the page saying it fully did.
async function _evVerb(action, extra, working){
    if(_evUi.busy || !_evOk()) return false;
    _evUi.busy = true; _evMsg(working || 'WORKING...');
    const r = await _evPost(action, extra);
    _evUi.busy = false;
    if(!r.json){
        const err = String((r.body && r.body.error) || '');
        _evMsg(err === 'scheduled' ? 'THIS EVENT RUNS ON ITS SCHEDULE'
             : err === 'not the organizer' ? 'ONLY THE ORGANIZER CAN DO THAT'
             : err === 'ended' ? 'THIS EVENT HAS ENDED'
             : 'THAT DID NOT WORK', true);
        return false;
    }
    _evMsg('');
    await eventRead();
    return true;
}
function eventRun(){ return _evVerb('run', null, 'STARTING...'); }
function eventPause(){ return _evVerb('pause', null, 'PAUSING...'); }
function eventEnd(){ return _evVerb('end', null, 'ENDING...'); }
// The door decides what a scanned code does and nothing else about the event
// changes with it. Flipping a closed event open does NOT approve what is already
// pending -- the organizer still decides those, and new scans go straight in.
function eventAccess(){
    if(!_ev) return false;
    return _evVerb('access', { closed: !_ev.closed }, 'CHANGING THE DOOR...');
}
// A member removes its own row, and a pending caller withdraws the same way. The
// row goes and the person may scan again -- leaving is not a resignation somebody
// processes. The list carries the disappearance; there is nothing local to clear.
async function eventLeave(){
    if(_evUi.busy || !_evOk()) return false;
    _evUi.busy = true; _evMsg('LEAVING...');
    const r = await _evPost('leave');
    _evUi.busy = false;
    if(!r.json){ _evMsg('COULD NOT LEAVE', true); return false; }
    const gone = _evEid;
    _ev = null; _evEid = '';
    _evList = _evList.filter(x => String(x.eid) !== String(gone));
    if(typeof _netHello === 'function' && _netOk()) _netHello();   // the list is the record: read it again
    phase = eventAny() ? 'eventChooser' : 'multiplayer';
    _evUi.sel = 0; _evMsg('YOU HAVE LEFT');
    _uiDirty = true;
    return true;
}

// ---- the members screen ----------------------------------------------------
// A VIEW OF THE SERVER'S ROWS, never a list this client keeps. Read on every
// open, re-read after every verb, and dropped when the screen closes. The
// friends list is the model for the LOOK and for nothing else -- its local copy
// plus its startup reconciliation is precisely what this must not have.
//
// NO ONLINE STATE, and none is asked for: presence is friendship-gated in this
// API and being in the same room does not make two people friends.
var _evMem = null;       // the last `members` answer, or null before the first
var _evMemSel = 0;
var _evMemAsk = null;    // the roster verb awaiting a confirm: {peer, set, label}
function eventMembers(){ return _evMem || []; }
function eventMemberSel(){ return _evMemSel; }
function eventMemberAsk(){ return _evMemAsk; }
// Pending rows FIRST, because they are the only ones that need a decision -- and
// they reach us at all only when we are the organizer. Everything else keeps the
// server's order.
function eventMemberRows(){
    const all = _evMem || [];
    const pend = [], rest = [], banned = [];
    for(const m of all){
        const st = String(m.state || 'member');
        if(st === 'pending') pend.push(m);
        else if(st === 'banned') banned.push(m);
        else rest.push(m);
    }
    return pend.concat(rest, banned);
}
async function eventMembersEnter(){
    _evMemSel = 0; _evMemAsk = null;
    phase = 'eventMembers';
    _uiDirty = true;
    return eventMembersRead();
}
async function eventMembersRead(){
    if(!_evEid || !_evOk()) return false;
    const r = await _evPost('members');
    if(!r.json){
        if(r.status === 403 || r.status === 404){ _evMem = []; _evMsg('YOU CANNOT SEE THIS ROSTER', true); }
        return false;
    }
    _evMem = Array.isArray(r.json.members) ? r.json.members : [];
    if(_evMemSel >= eventMemberRows().length + 1) _evMemSel = 0;
    _uiDirty = true;
    return true;
}
function eventMembersLeave(){
    _evMem = null; _evMemAsk = null; _evMemSel = 0;
    phase = 'eventPage';
    _uiDirty = true;
}
// The organizer's ONE verb over a row. 'none' is decline, remove and unban all
// at once: the row is dropped and the person may scan again. The organizer
// APPROVES, never adds -- a peer with no row is a 404, and there is no screen
// here that could produce one.
async function eventRoster(peer, set){
    if(_evUi.busy || !_evOk()) return false;
    _evUi.busy = true; _evMsg('...');
    const r = await _evPost('roster', { peer:String(peer), set:String(set) });
    _evUi.busy = false;
    if(!r.json){
        const err = String((r.body && r.body.error) || '');
        _evMsg(err === 'not the organizer' ? 'ONLY THE ORGANIZER CAN DO THAT' : 'THAT DID NOT WORK', true);
        return false;
    }
    _evMsg('');
    // Re-read rather than patch: the roster is the server's, and a verb that
    // half-worked would otherwise leave this screen showing what we hoped for.
    await eventMembersRead();
    return true;
}
// ASK TO BE FRIENDS is the ordinary friend.php request, unchanged. The row's own
// `friend` field picks the label and disables the button where a request is
// already out or the friendship exists -- the server has already answered the
// question, so nothing here has to guess at it.
// The row's tag, and it shares a narrow column with the name beside it -- so it
// says the SHORT form and the header line above the list carries the sentence.
// 'ASK TO BE FRIENDS' is 17 characters and ran into the name.
function eventFriendLabel(m){
    const f = String((m && m.friend) || 'none');
    if(f === 'accepted') return 'FRIENDS';
    if(f === 'pending') return 'ASKED';
    return 'ADD FRIEND';
}
function eventFriendCan(m){ return String((m && m.friend) || 'none') === 'none'
                                && String(m.id) !== getPlayerId(); }
async function eventAskFriend(m){
    if(!eventFriendCan(m) || _evUi.busy) return false;
    if(typeof netFriendRequest !== 'function'){ _evMsg('NOT RIGHT NOW', true); return false; }
    _evUi.busy = true; _evMsg('ASKING...');
    // netFriendRequest declines with null where it already holds the answer -- a
    // request out, a friendship, a ban, its own 30 s retry gap. That is not a
    // failure and must not be reported as one; the re-read below says what is true.
    const r = await netFriendRequest(String(m.id));
    _evUi.busy = false;
    _evMsg(r && r.state === 'accepted' ? 'YOU ARE FRIENDS' : 'REQUEST SENT');
    // The roster carries the `friend` field, so the answer to "did that land"
    // is the same read as everything else on this screen.
    await eventMembersRead();
    return true;
}

// ---- the event's tournaments -----------------------------------------------
// AN EVENT TOURNAMENT IS AN ORDINARY TOURNAMENT: same lifecycle, same bracket,
// same deadlines, same caps, same screens. `eid` is a tag on it and a membership
// check on the way in, and that is the whole of the difference. Nothing here is a
// second implementation of anything -- both of these hand over to tourney.js.
async function eventTourneyGo(){
    const t = _ev && _ev.tourney;
    if(!t || !t.tid || typeof tourneyJoin !== 'function'){ _evMsg('NO TOURNAMENT RIGHT NOW', true); return false; }
    if(_evUi.busy) return false;
    // THE PAGE HOLDS UNTIL THE JOIN LANDS. Moving to the tournament screen first shows
    // the room-PICKING screen -- CREATE TOURNAMENT, JOIN BY CODE, the list of open
    // lobbies -- for as long as the request takes: a menu nobody asked for, in front of
    // a player who is already in the room they wanted, and pressable while it stands.
    // The join says what happened; until it does, this page says JOINING.
    _ttUi.home = 'eventPage';   // ...and this is the room the tournament gives back
    if(typeof _netAnchorRefresh === 'function') _netAnchorRefresh({ nudge:true });   // a tournament door like any other
    _evUi.busy = true; _evMsg('JOINING...');
    // By tid, which is what the state answer names it by. A non-member is refused
    // 403 by the server -- that refusal IS the secrecy, and it is the server's to
    // make, not this screen's to anticipate.
    await tourneyJoin(t.tid);
    _evUi.busy = false;
    if(typeof tourneyActive !== 'function' || !tourneyActive()){
        // tourneyJoin has already worked out what went wrong and sounded it. This puts
        // the same words where the player is actually looking, without a second sound.
        uiMsg(_evUi, (tourneyUi() && tourneyUi().msg) || 'COULD NOT JOIN', ''); _evUi.bad = true;
        return false;
    }
    // Whatever it turned out to be: a lobby waiting to start, or a bracket already
    // moving. tourneyExitPhase answers the second, and an open lobby is the first.
    const v = tourneyView();
    phase = (v && v.state !== 'open' && tourneyExitPhase()) || 'tourneyLobby';
    _uiDirty = true;
    return true;
}
// The NORMAL create dialog, carrying the room it was opened from. The event page
// is where an organizer stands when they decide to run one, so it is where the
// dialog opens -- but the dialog is the same one, and the settings on it are the
// same settings.
function eventTourneyNew(){
    if(typeof tourneySetupOpen !== 'function'){ _evMsg('NOT RIGHT NOW', true); return false; }
    tourneySetupOpen(_evEid);
    return true;
}

// ---- passing the event on --------------------------------------------------
// ANY MEMBER may show the pass QR, and that is what makes an event spread in a
// room: one person scans in and hands it on. The pass carries NO ISSUER -- there
// is no room for one in 53 bytes -- so the server never learns who passed it on
// and could not be made to.
//
// ONE CALL gives six 10-second slots, a minute of QR, and the screen rotates
// LOCALLY on the synced clock. Nothing here polls: the codes for the next minute
// are already in hand, and the only request is the one that fetches the next
// minute before this one runs out.
var _evPass = null;      // { step, valid, slots:[{at, code}] }
var _evPassT = null;     // the 1 Hz tick that re-asks before the last slot lapses
var _evPassBusy = false;
function eventPassView(){ return _evPass; }
// step and valid are ADMIN-CONFIGURABLE and ride the answer, so nothing here
// hard-codes 10 and 20. The bounds are not a second opinion on the server's
// numbers -- they are what stops a wrong or missing one turning this screen into
// a request loop.
function _evPassStep(){
    const ms = _evPass && _evPass.step != null ? +_evPass.step * 1000 : EV_STEP_MS_DEF;
    return Math.max(EV_STEP_MS_MIN, Math.min(EV_STEP_MS_MAX, ms || EV_STEP_MS_DEF));
}
function _evPassValid(){
    const ms = _evPass && _evPass.valid != null ? +_evPass.valid * 1000 : EV_VALID_MS_DEF;
    return Math.max(_evPassStep(), Math.min(EV_STEP_MS_MAX * 2, ms || EV_VALID_MS_DEF));
}
// THE SLOT ON SCREEN: the NEWEST one that has begun. The windows overlap on
// purpose -- a code stays valid for two slots, so one already read off a screen
// still opens the door while the screen has moved on -- and when two are valid
// the newer is the one with longer left to live.
function eventPassSlot(now){
    if(!_evPass || !_evPass.slots || !_evPass.slots.length) return null;
    if(now == null) now = _evNow();
    if(now == null) return null;
    let best = null;
    for(const s of _evPass.slots) if(+s.at <= now && (!best || +s.at > +best.at)) best = s;
    // Every slot still in the future, or every one already dead: show nothing
    // rather than a code the door will refuse.
    if(!best || now >= +best.at + _evPassValid()) return null;
    return best;
}
// How much of the shown code's life is left, 0..1 -- the wiping bar under the QR.
function eventPassLeft(now){
    const s = eventPassSlot(now);
    if(!s) return 0;
    if(now == null) now = _evNow();
    return Math.max(0, Math.min(1, 1 - (now - +s.at) / _evPassValid()));
}
async function eventPassRead(){
    if(_evPassBusy || !_evEid || !_evOk()) return false;
    _evPassBusy = true;
    const r = await _evPost('pass');
    _evPassBusy = false;
    if(!r.json){
        const err = String((r.body && r.body.error) || '');
        _evMsg(err === 'not started' ? 'THIS EVENT HAS NOT STARTED YET'
             : err === 'paused' ? 'THIS EVENT IS PAUSED'
             : err === 'ended' ? 'THIS EVENT HAS ENDED'
             : 'NO CODE RIGHT NOW', true);
        return false;
    }
    const slots = Array.isArray(r.json.slots) ? r.json.slots : [];
    _evPass = { step:r.json.step, valid:r.json.valid, slots:slots };
    _evMsg('');
    return true;
}
// Ask again BEFORE the last slot lapses, never after: a screen that waited for
// the gap would show nothing across it. One request a minute, which is what six
// slots were handed out for.
function _evPassTick(){
    if(phase !== 'eventQr'){ eventPassLeave(); return; }
    const now = _evNow();
    if(now == null || _evPassBusy) return;
    const slots = (_evPass && _evPass.slots) || [];
    if(!slots.length){ eventPassRead(); return; }
    let last = slots[0];
    for(const s of slots) if(+s.at > +last.at) last = s;
    if(now >= +last.at - _evPassStep()) eventPassRead();
    _uiDirty = true;
}
function eventPassEnter(){
    _evPass = null;
    phase = 'eventQr';
    eventPassRead();
    if(_evPassT == null && typeof setInterval === 'function') _evPassT = setInterval(_evPassTick, 1000);
    _uiDirty = true;
}
// The codes go with the screen. They are minted from the server's clock and
// nothing here is worth keeping for a screen that is closed.
function eventPassLeave(){
    if(_evPassT != null){ if(typeof clearInterval === 'function') clearInterval(_evPassT); _evPassT = null; }
    _evPass = null;
    if(phase === 'eventQr'){ phase = 'eventPage'; _uiDirty = true; }
}

// A DATE somebody reads, from a stamp the API states in SECONDS.
//
// THE UNIT IS THE TRAP, and the contract is explicit about it: every timing value
// is unix MILLISECONDS -- starts, ends, now, a pass slot's `at` -- EXCEPT the three
// that are only ever displayed as calendar dates, which are SECONDS: `asked`,
// `joined` and `finished`. Feeding one of those to Date() unmultiplied renders 1970
// and nothing throws, so the conversion lives here rather than at each call site.
function eventDay(secs){
    if(secs == null) return '';
    const d = new Date(+secs * 1000);
    return pad2(d.getDate()) + '.' + pad2(d.getMonth()+1) + '.' + String(d.getFullYear()).slice(-2);
}
// One archived tournament as a line: when it finished, what it seated, how much of
// it was played, and who stood on the podium. The page and the monitor both show the
// archive, so they show it the same way -- and podium ids carry their names, so an
// id is only ever the fallback.
// ---- what the event knows about itself -------------------------------------
// ALL OF IT IS DERIVED from the `state` answer already in hand -- the archive rows
// and the member count -- so the statistics screen costs no request of its own
// beyond the ordinary re-read on the way in. There is no per-player event table on
// the server and this does not ask for one: what a room knows about its players is
// who stood on its podiums, and that is what the archive carries.
function eventStatsView(e){
    e = e || _ev;
    const arch = (e && Array.isArray(e.archive)) ? e.archive : [];
    let played = 0, seats = 0, last = 0;
    const by = Object.create(null);
    for(const a of arch){
        played += a.played | 0;
        if((a.seats | 0) > seats) seats = a.seats | 0;
        const f = +a.finished || 0;
        if(f > last) last = f;
        // The podium is in FINISHING ORDER, so index 0 is the win and being on it at
        // all is the second thing worth counting: a player who is always second never
        // wins a night and is still the best player in the room.
        const pod = Array.isArray(a.podium) ? a.podium : [];
        for(let i = 0; i < pod.length; i++){
            const id = String((pod[i] && pod[i].id) || '');
            if(!id) continue;
            const r = by[id] || (by[id] = { id:id, name:'', wins:0, podiums:0 });
            if(pod[i].name) r.name = String(pod[i].name);
            r.podiums++;
            if(i === 0) r.wins++;
        }
    }
    const top = [];
    for(const k in by) top.push(by[k]);
    // Wins, then podiums, then the name -- a TOTAL order, so two players who are level
    // do not swap places under a reader every time the screen redraws.
    top.sort((a, b) => (b.wins - a.wins) || (b.podiums - a.podiums)
                    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { tourneys:arch.length, played:played, seats:seats, last:last,
             members:(e && e.members != null) ? (e.members | 0) : null,
             live:!!(e && e.tourney && e.tourney.tid), top:top, archive:arch };
}
// One archived tournament as a row: when, how much of the field turned up, and who
// won it. The three podium names the page used to print ran off both sides of the
// screen at this font; the standings above the list are where the rest of the
// podium is answered now.
function eventStatsRow(a){
    if(!a) return { day:'', field:'', won:'' };
    const pod = Array.isArray(a.podium) ? a.podium : [];
    const w = pod[0];
    return { day:eventDay(a.finished),
             field:(a.played | 0) + (a.seats ? '/' + (a.seats | 0) : ''),
             won:w ? String(w.name || fmtFriendId(String(w.id))) : '' };
}
// The archive is however long the room has been running, so it is the part that
// scrolls. The window is what the SCREEN says it can show -- one number, read by
// the draw and by the scroll alike, so a list cannot be scrolled past what is drawn.
var _evStatsTop = 0;
function eventStatsTop(){ return _evStatsTop; }
async function eventStatsEnter(){
    _evStatsTop = 0;
    phase = 'eventStats';
    _uiDirty = true;
    // Fresh on the way in like every other event screen: the archive grows a row
    // every time a tournament in this room finishes.
    return eventRead();
}
function eventStatsLeave(){ _evStatsTop = 0; phase = 'eventPage'; _uiDirty = true; }
function eventStatsScroll(d){
    const n = eventStatsView().archive.length;
    const fits = (typeof eventStatsFits === 'function') ? eventStatsFits() : n;
    const max = Math.max(0, n - Math.max(1, fits));
    const was = _evStatsTop;
    _evStatsTop = Math.min(max, Math.max(0, _evStatsTop + d));
    if(_evStatsTop !== was) _uiDirty = true;
    return _evStatsTop !== was;
}
function eventArchiveLine(a){
    if(!a) return '';
    const pod = (a.podium || []).slice(0, 3)
        .map(x => String(x.name || fmtFriendId(String(x.id))).substring(0, 8));
    const day = eventDay(a.finished);
    const seats = (a.seats|0) ? (a.seats|0) + ' SEATS  ' : '';
    return (day ? day + '   ' : '') + seats + (a.played|0) + ' PLAYED   ' + (pod.join(', ') || '-');
}

// ---- the monitor: a screen for a TV ----------------------------------------
// THE MONITOR IS A SPECTATOR. It goes through the spectator path this client
// already has -- the ordinary 'watch' signal, the same P2P feed a tournament
// spectator gets, the same renderer. There is NO second transport here, no
// second feed format and no monitor-only netcode branch, and there must never
// be one. The only new thing is the screen.
//
// It is meant to be left alone: nothing on it is ever pressed, it never times
// out, and it always shows whatever is interesting at that moment. ONE request
// does everything -- `monitor` takes or renews the slot AND answers the whole
// screen -- so it polls that and nothing else.
//
// The lease lapses within the online window (120 s, a contract constant), so it
// is renewed at the same half-of-the-window rule the heartbeat uses: a missed
// renewal never reads as an unplugged TV.
const EV_MON_MS = 30000;         // renew well inside the window, and follow the bracket
const EV_MON_WATCH_MS = 4000;    // how often an unanswered watch ask is put out again
var _evMon = null;               // the last `monitor` answer -- the whole screen
var _evMonT = null;
var _evMonBusy = false;
var _evMonErr = '';              // 'no monitor' | 'monitor taken' | '' -- said, then stopped
var _evMonNid = '';              // the match we are watching, so a moved cursor is noticed
var _evMonAskAt = 0;
function eventMonitorView(){ return _evMon; }
function eventMonitorErr(){ return _evMonErr; }
// Does this event offer a screen at all? Server API 4.11 puts `monitor_allowed`
// on `state` and on every `events` row precisely so this can be asked without
// touching the slot -- the `monitor` call is the one that CLAIMS it, and using
// it to find out would take the screen off a TV that is merely switched off.
// ABSENT reads as allowed: an older server that never says is not saying no,
// and the 403 settles it in that case.
function eventMonitorOffered(e){
    e = e || _ev;
    return !!e && e.monitor_allowed !== false;
}
async function eventMonitorRead(){
    if(_evMonBusy || !_evEid || !_evOk()) return false;
    _evMonBusy = true;
    const r = await _evPost('monitor');
    _evMonBusy = false;
    if(!r.json){
        const err = String((r.body && r.body.error) || '');
        // Two refusals, and they mean different things: somebody else has the
        // screen, or this event does not offer one. Say which, and STOP -- a
        // screen nobody attends must not sit retrying a refusal forever.
        if(r.status === 409 || err === 'monitor taken'){ _evMonErr = 'monitor taken'; eventMonitorStop(true); }
        else if(err === 'no monitor'){ _evMonErr = 'no monitor'; eventMonitorStop(true); }
        return false;
    }
    _evMonErr = '';
    _evMon = r.json;
    _evMonFollow();
    _uiDirty = true;
    return true;
}
// FOLLOW THE CURSOR. `tourney` is the whole projection a participant reads, so
// `roles` names the two players of the match in flight and `roles.you` is idle,
// because a monitor has no seat. Ask one of them to watch, exactly as a
// tournament spectator does -- and when the cursor moves, follow it to the next
// pair. Every line of this hands over to net-spec.js.
function _evMonFollow(){
    if(typeof specWatch !== 'function' || typeof netSpectating !== 'function') return;
    const t = _evMon && _evMon.tourney, roles = t && t.roles;
    const nid = roles ? String(roles.nid || '') : '';
    if(!nid){
        // Nothing is being played. Let go of a feed for a match that has ended,
        // so the next one starts clean.
        if(_evMonNid && typeof specStop === 'function' && netSpectating()) specStop('');
        _evMonNid = ''; _evMonAskAt = 0;
        return;
    }
    if(nid !== _evMonNid){
        // A NEW match. Drop the old feed before asking for the next: the two are
        // different timelines and a spectator boots from a checkpoint off the feed.
        if(_evMonNid && typeof specStop === 'function' && netSpectating()) specStop('');
        _evMonNid = nid; _evMonAskAt = 0;
    }
    if(netSpectating()) return;                       // already watching this one
    const now = _msgNow();
    if(_evMonAskAt && now - _evMonAskAt < EV_MON_WATCH_MS) return;
    _evMonAskAt = now;
    // players[0] is the feeder, exactly as it is for a tournament spectator.
    const feeder = String(roles.feeder || (roles.players || [])[0] || '');
    if(/^[0-9a-f]{8}$/.test(feeder)) specWatch(feeder, String(t.tid || ''), nid);
}
function _evMonTick(){
    if(phase !== 'eventMonitor'){ eventMonitorStop(); return; }
    eventMonitorRead();
}
function eventMonitorEnter(){
    _evMon = null; _evMonErr = ''; _evMonNid = ''; _evMonAskAt = 0;
    phase = 'eventMonitor';
    eventWakeSet(true);
    eventMonitorRead();
    if(_evMonT == null && typeof setInterval === 'function') _evMonT = setInterval(_evMonTick, EV_MON_MS);
    _uiDirty = true;
}
// Stop asking and the slot frees itself -- there is nothing to give back and
// nobody to tell. `keep` holds the screen up to show a refusal that has just
// been read; everything else walks off it.
function eventMonitorStop(keep){
    eventWakeSet(false);
    if(_evMonT != null){ if(typeof clearInterval === 'function') clearInterval(_evMonT); _evMonT = null; }
    if(_evMonNid && typeof specStop === 'function' && typeof netSpectating === 'function' && netSpectating())
        specStop('');
    _evMonNid = ''; _evMonAskAt = 0;
    if(!keep){ _evMon = null; _evMonErr = ''; if(phase === 'eventMonitor') phase = 'eventPage'; }
    _uiDirty = true;
}
// Where a feed that ends puts us back. net-session.js asks this the same way it
// asks tourneyExitPhase, so a match ending under a monitor returns to the screen
// rather than to the 1vs1 menu.
function eventExitPhase(){ return _evMonT != null ? 'eventMonitor' : ''; }

// ---- the reserved 'event' signal -------------------------------------------
// Four payloads, and NOT ONE of them is a state change to apply on its own word.
// Each says something moved and the server is asked what -- the same discipline
// the tournament sheet keeps. Nothing is signalled for a join into an open
// event, a decline or a removal (the friend logic: what did not happen is not
// announced), and a scheduled event's own moments push nothing at all, because
// they are derived.
//
// _evPending is the ONE thing kept between screens, and it is a nudge rather
// than a record: somebody is waiting at a closed door of an event we run. It is
// re-derived from the roster the moment that screen is opened.
var _evPending = {};
function eventPendingAt(eid){ return !!_evPending[String(eid || '')]; }
function _evOnSignal(d){
    if(!d || typeof d !== 'object') return;
    const eid = String(d.eid || ''), what = String(d.event || '');
    if(!eid) return;
    if(what === 'request'){
        // To the organizer: a closed event has somebody at the door. A badge on the
        // entry, and a line when the page it concerns is the one on screen.
        _evPending[eid] = true;
        if(_evEid === eid && phase === 'eventPage') _evMsg('SOMEBODY IS WAITING TO JOIN');
        _uiDirty = true;
        return;
    }
    if(what === 'accepted'){
        // The wait is over. state now carries the achievement, so read it and let
        // the ordinary unlock moment play.
        if(_evEid === eid) eventRead();
        else { _evEid = eid; eventRead(); }
        return;
    }
    // 'state' (the organizer ran, paused or ended it) and 'tourney' (a lobby
    // opened, or the live one stopped being live) both mean the same thing to us:
    // the screen we are looking at is out of date. Refresh it where it is showing,
    // and let the `events` list carry the rest -- there is nothing to hold on to
    // for a room we are not in front of.
    //
    // NEITHER PAYLOAD IS ADOPTED. `tourney` carries the tid and the join code on a
    // create and `over` on an ending, and none of that is read here: what a screen
    // shows still comes from its own read, so a signal that is late, doubled or
    // lost costs at most a slower refresh and never a wrong picture.
    if(what === 'state' || what === 'tourney'){
        if(_evEid === eid && eventScreen()) eventNewsRead();
        _uiDirty = true;
    }
}

// A TOURNAMENT THAT OPENED WHILE THE PAGE WAS UP. The contract has a signal for
// exactly this -- {event:'tourney'} to every member -- and _evOnSignal takes it.
// The live server does not send that payload today (only the 'state' one), so a
// member standing on the page never heard, and the row stayed dark until they left
// the screen and came back.
//
// The ANNOUNCE is the second way the same news arrives, and it needs no server
// change: an event's open lobbies are served to its MEMBERS regardless of network,
// so a row carrying our eid IS the tournament. Noticing is not adopting -- the page
// re-reads `state`, which is the one place the tournament it shows comes from.
// THE MONITOR IS ON THE SAME NEWS. Its own call is a 30 s tick because that is its
// LEASE, and the lease is the expensive half: one `monitor` builds the whole
// tournament projection. The announce is a FLAG on a poll the screen is already
// holding, so hearing it there costs nothing and takes the wait from the lease tick
// down to the announce tick. What it does with the news is unchanged -- it re-reads
// its own call, which is the one place its screen comes from.
// WHICH READ ANSWERS THE NEWS is decided by the screen on show, and there are two
// of them: a page is made of `state` and a monitor is made of its own call. A
// monitor handed a `state` read freshens a page nobody is looking at and leaves the
// TV showing the old room -- which is the whole failure this exists to avoid, and
// it is one line in two places if it is not written down once.
function eventNewsRead(){
    return phase === 'eventMonitor' ? eventMonitorRead() : eventRead();
}
function eventTourneySeen(list){
    if(!_evEid) return false;
    const mon = phase === 'eventMonitor';
    if(!mon && (!_ev || !eventScreen())) return false;
    const t = mon ? (_evMon && _evMon.tourney) : (_ev && _ev.tourney);
    const held = String((t && t.tid) || '');
    for(const l of (list || [])){
        if(String((l && l.eid) || '') !== _evEid) continue;
        if(String(l.tid || '') === held) return false;   // the one we are already showing
        eventNewsRead();
        return true;
    }
    return false;
}
// ...which means the announce has to be ASKED for while the screen is up. It rides
// the poll those screens already send for `ev`, so it costs no request of its own.
// A RESERVED monitor row may well be served no announce at all -- the contract
// promises an event's lobbies to its MEMBERS -- and asking is still right: the flag
// is free, and a TV signed in as an ordinary member is the common case.
function eventTlWant(){
    return !!_evEid && (phase === 'eventPage' || phase === 'eventStats' || phase === 'eventMonitor');
}

// ---- keeping a TV awake ----------------------------------------------------
// NOTHING IS EVER PRESSED ON THE MONITOR -- that is the point of it -- so the
// platform sees an idle input and blanks the panel. The Screen Wake Lock API is
// the one thing a page can do about that, and it is FEATURE DETECTED rather than
// assumed: a TV browser is pinned to whatever engine its firmware shipped with,
// and the older ones predate the API entirely. A lock that cannot be taken is a
// TV that dims, which is what happens today, so nothing here fails loudly.
//
// HELD ONLY WHILE THE MONITOR IS UP. A wake lock on a menu is a promise nobody
// asked for. The browser also drops it whenever the page is hidden and never
// returns it by itself, which is why it is re-taken on visibilitychange -- that
// is the half a naive implementation leaves out, and it is the half that matters
// on a device that is switched between inputs.
var _evWake = null, _evWakeOn = false, _evWakeBound = false;
function _evWakeApi(){
    try { return (typeof navigator !== 'undefined' && navigator.wakeLock) || null; }
    catch(e){ return null; }
}
function _evHidden(){ return typeof document !== 'undefined' && !!document.hidden; }
async function _evWakeTake(){
    const api = _evWakeApi();
    if(!api || !_evWakeOn || _evWake || _evHidden()) return false;
    try {
        const w = await api.request('screen');
        // A lock we no longer want: the screen was left while the request was in
        // flight. Give it straight back rather than leaving it standing.
        if(!_evWakeOn){ try { w.release(); } catch(e){} return false; }
        _evWake = w;
        // The browser releases it on its own (a hidden page, a system decision), so
        // drop our handle when it does or the re-take believes it still holds one.
        if(w && typeof w.addEventListener === 'function')
            w.addEventListener('release', () => { if(_evWake === w) _evWake = null; });
        return true;
    } catch(e){ _evWake = null; return false; }
}
function _evWakeDrop(){
    const w = _evWake; _evWake = null;
    if(w && typeof w.release === 'function'){ try { w.release(); } catch(e){} }
}
function _evWakeVis(){ if(_evWakeOn && !_evHidden()) _evWakeTake(); }
function eventWakeSet(on){
    _evWakeOn = !!on;
    if(!_evWakeOn){ _evWakeDrop(); return false; }
    if(!_evWakeBound && typeof document !== 'undefined' && document.addEventListener){
        document.addEventListener('visibilitychange', _evWakeVis);
        _evWakeBound = true;
    }
    _evWakeTake();
    return true;
}
// Whether a lock is actually STANDING, not whether one was asked for: on a TV that
// has no such API the answer is false for ever, and that is a fact worth being able
// to read rather than assume.
function eventWakeHeld(){ return !!_evWake; }

// ---- the achievement -------------------------------------------------------
// Server-carried: the id, name, description and (optionally) the 8x8 icon all
// ride the answer, because `ev_<eid>` is not in the shipped ACHIEVEMENTS table
// and never could be. Granting is the ordinary unlockAch moment; what is extra
// is that the DEFINITION has to be kept too, or the achievements screen has
// nothing to draw. That store is deliberately outside the backup manifest: the
// server re-carries `ach` on every member's `state`, so a reinstall or a
// restored config re-grants it silently instead of losing it.
function _evGrantAch(a){
    if(!a || typeof a !== 'object') return;
    const id = String(a.id || '');
    if(!/^ev_[A-Z2-9]{4}$/.test(id)) return;
    if(typeof achEventPut === 'function') achEventPut(id, a);
    if(typeof unlockAch === 'function') unlockAch(id);
}
