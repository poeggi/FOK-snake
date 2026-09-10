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

function eventList(){ return _evList; }
function eventView(){ return _ev; }
function eventUi(){ return _evUi; }
// Are we in any event at all? The list is the only answer to that question.
function eventAny(){ return _evList.length > 0; }
function _evMsg(m, bad){
    _evUi.msg = m || ''; _evUi.msgAt = _msgNow(); _evUi.bad = !!bad;
    if(bad && typeof Snd !== 'undefined') Snd.sfxPlay('fail', cfg.music);
    _uiDirty = true;
}
function _evOk(){ return typeof _netOk === 'function' && _netOk() && typeof _netPostRes === 'function'; }

// ---- the endpoint ----------------------------------------------------------
// Every action but `join` needs a row, and a caller with no row is answered 404
// exactly like an eid that does not exist -- so nothing here can enumerate and
// nothing here should try to tell the two apart. NET_BG_SOLO throughout: a
// player is waiting on every one of these right now.
async function _evPost(action, extra){
    const body = Object.assign({ id:getPlayerId(), action, eid:_evEid }, extra || {});
    return await _netPostRes('/api/event.php', body, NET_BG_SOLO);
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
async function eventJoin(eid, code){
    if(_evUi.busy) return false;
    if(!_evOk()){ _evMsg('EVENTS NEED A NETWORK', true); return false; }
    _evEid = String(eid || '').toUpperCase();
    _evUi.busy = true; _evMsg('JOINING...');
    const r = await _evPost('join', { code:String(code || '').toUpperCase() });
    _evUi.busy = false;
    if(!r.json){ _ev = null; _evMsg(_evJoinFail(r), true); return false; }
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
// THE DOOR into events, and the one place a parked deep link is spent. It waits
// for the hello for the same reason the tournament link does: the answer needs a
// network, and an unanswered hello reads exactly like a server with no events.
function eventEnter(){
    _evUi.sel = 0; _evUi.msg = '';
    const spend = () => {
        const l = _eventLink;
        if(!l){ if(_evEid) eventRead(); return; }
        _eventLink = null;
        eventJoin(l.eid, l.code);
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
