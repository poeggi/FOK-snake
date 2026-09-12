// TOURNAMENT MODE -- the client half of the server's schedule.
//
// The server owns the bracket. It decides who plays whom, in what order, at how many
// hearts, and who watches; it settles results and it publishes standings. This file never
// computes a pairing, a ranking or a winner of its own: it holds the last picture the
// server sent, it drives the machinery that turns a ROLES SHEET into a live connection,
// and it reports the one thing only a player can know -- how their own match ended.
//
// There is no sim code here, and there must never be. A tournament match IS an ordinary
// online duel (net-session.js) with two parameters preset from the sheet; a tournament
// spectator IS an ordinary spectator (net-spec.js) pointed at an assigned source. That is
// the whole design: the tournament is scheduling, not a second game.
//
// THE ONE RULE THE SERVER STATES OUTRIGHT: a client must not act on a `tourney` signal it
// did not expect to the extent of playing a match it cannot see in `state`. When anything
// looks off we call state() and render THAT, rather than believing a stray event.
const TT_MAX        = 8;       // hard player cap (mirrors tournament_max_players)
const TT_TICK_MS    = 1000;    // housekeeping cadence while a tournament is held
const TT_REPORT_MS  = 2500;    // result-report retry spacing (the POST is idempotent)
const TT_REPORT_MAX = 24;      // ~1 minute of retries, well inside the 3-min walkover ladder
// A pushed event may name a delay the server wants before the requests that event provokes
// (`after_ms`, API 4.4). A broadcast reaches the whole field in the same instant, so every
// recipient reacts in the same instant too, and their read-backs arrive as one burst -- on
// a shared host that burst is the thing that queues. Bounded here as well as server-side:
// a delay long enough to be a stall is not a delay we would honour. The server's own budget
// (`tourney_after_ms`) is bounded well under a second, so this ceiling is a guard against a
// wrong number and not a wait anybody is meant to reach.
const TT_AFTER_MAX  = 1000;
const TT_OVER_MS    = 4000;    // how long the duelOver banner holds before the next match
const TT_CONNECT_MS = 20000;   // a sheet that has not become a match by now is engaged again
const TT_WALK_GRACE_MS = 10000; // no walkover clock for the first 10 s of a deal: a peer still connecting is not a no-show
const TT_MSG_MS     = 6000;
// The floor under a break's own wait. A round board is not a button with a table
// behind it: it is the standings the whole field is reading, and the host's press ends
// it for everybody at once. The server's `wait` is there to stop a host wedging an
// evening, so it is free to be short or absent; how long a table needs to be READ is
// this client's business and not the server's. Two seconds is long enough that nobody
// loses the board to a press they were already making when it arrived.
const TT_READ_MS    = 2000;

// The whole client-side picture, or null when we hold no tournament. Every field in it
// came from the server; nothing here is derived except the match-count arithmetic the
// lobby shows, which is the server's own formula quoted back at the player.
var _tt = null;
// `contAt` is on OUR clock, the same one every other deadline in this file is on: the round
// board's own `at` is a stamp from the server's clock, which this screen has no offset to
// read, while `wait` is a duration and needs none.
var _ttUi = { sel:-1, msg:'', msgAt:0, stakes:false, lvl:1, speed:false, eid:'', home:'', busy:false, contAt:0, from:'', to:'', ask:null };
// stakes and lvl are what the CREATE screen collects before there is a tournament to put
// them on. They live here rather than in cfg because they describe one tournament, not
// this device: the next one is configured from its own screen.
// ask: the question the quit dialog is asking when it is not the leave/end one. Today one
// shape -- { kind:'replace', stakes, lvl, code, running } -- CREATE while already hosting.
// It carries the WHOLE setup the refused call was made with, because YES re-sends that call.
// The read-back of a tournament this device is still in but is not currently looking at --
// what the REJOIN row is made of. Null until _ttProbe finds one.
var _ttBack = null;
var _ttNid  = '';      // the node the current sheet names
var _ttRolesAt = 0;    // when that sheet arrived
var _ttEngAt = 0;      // when it was last turned into a connection; 0 = not yet
// The node that is FINISHED on our side -- reported, settled by the server, or watched
// to its end. The one thing that stops a sheet from being engaged again (_ttDrive).
var _ttDone = '';
var _ttRep  = null;    // the pending result report {body, at, tries}
var _ttRepBusy = false;
var _ttWant = null;    // the match parameters an inbound answer must be dressed with
// The node whose match is ON THE BOARD, which is NOT _ttNid: the server deals the next node
// the moment a result settles, so from then until the finished match leaves the screen the
// two name different matches. Everything about the match being played -- what a result is
// reported against, whether walking out still owes one -- hangs off this one.
var _ttPlayNid = '', _ttWatchNid = '';
var _ttOverAt = 0;
var _ttT = null;
var _ttAfter = 0, _ttAfterT = null;   // when the server's stagger lets us ask again, and the one-shot that does

// tourneyQuit is one of them: the leave dialog is a tournament screen like any other, so
// a tournament that ends underneath it takes it down with the rest rather than leaving a
// question about a tournament nobody is in any more.
const _TT_PHASES = { tourneyLobby:1, tourneyBracket:1, tourneyRound:1, tourneyCeremony:1,
                     tourneyPodium:1, tourneyQuit:1 };

// Where a re-point actually lands. The tournament screens follow the tournament as it moves,
// but tourneyQuit is a QUESTION, and taking it off the screen ANSWERS it for the player --
// which is what an ordinary state poll landing a moment after the press did, with no press
// of theirs in between. So while it is up, a re-point moves the screen BEHIND it instead:
// that is the one drawTourneyQuit paints as its backdrop and the one NO returns to, so the
// tournament carries on moving and the question carries on standing. The only routes that
// bypass this are the ones that leave nothing to ask -- _ttDrop, and reaching 'done'.
// A screen the tournament moves us to opens on its OWN default row (see tourneySel), so the
// selection is dropped on the way in: a screen arrives while the player is reading another
// one, and inheriting a row index across that is inheriting a press.
function _ttGo(p){
    if(phase === 'tourneyQuit'){ if(_ttUi.from !== p){ _ttUi.from = p; _ttUi.sel = -1; } }
    else if(phase !== p){ phase = p; _ttUi.sel = -1; }
    _uiDirty = true;
}
// The tournament screen on SHOW, which is the backdrop while the quit dialog is up: a
// re-point has to reason about the screen it is moving, not about the question over it.
function _ttFace(){ return phase === 'tourneyQuit' ? (_ttUi.from || 'tourneyLobby') : phase; }

// ---- small helpers -------------------------------------------------------------------
function tourneyActive(){ return !!_tt; }
function tourneyView(){ return _tt; }
function tourneyUi(){ return _ttUi; }
// The selection, resolved against the list as it stands -- it changes shape under the screen
// and the input alike as the server talks. -1 is UNARMED, not "row zero": on most lists that
// IS the top row, but a list whose first row is an exit that costs other people something
// opens with NOTHING selected, so the A that ended a match cannot also end the evening. One
// press of a direction (or of A) arms it, and from there it is an ordinary list.
function tourneySel(rows){
    rows = rows || tourneyRows();
    if(!rows.length) return -1;
    if(_ttUi.sel < 0) return rows[0].nosel ? -1 : 0;
    return Math.min(_ttUi.sel, rows.length - 1);
}
// The scoreboard between two rounds, or null when no break is open. It is a whole picture
// in itself -- one row per participant, already ordered and already cut -- so it is handed
// to the screen as it arrived rather than folded into the standings it partly repeats.
function tourneyBreak(){ return (_tt && _tt.brk) || null; }
// AM I THE ONE ABOUT TO PLAY? True only between the roles sheet naming me and the duel
// taking the screen. It is the one moment in a tournament where a player has nowhere to be
// but here: the board is for people with time to read it, and a player who wandered onto it
// while their opponent is waiting on a connection is a player who is late for their match.
function tourneyUp(){ return !!(_tt && _tt.roles && String(_tt.roles.you || '') === 'play'); }
function tourneyMax(){ return _tt && _tt.max ? (_tt.max|0) : TT_MAX; }
// Round 1 is SPARSE above four players: every pair up to 4, then the two circulant
// offsets, which is 2N matches. The lobby quotes this so nobody starts an eight-player
// tournament expecting 28 games.
function _ttMatches(n){ n = n|0; return n < 2 ? 0 : (n <= 4 ? n * (n - 1) / 2 : 2 * n); }
// What picking a START LEVEL actually buys, on the line every screen keeps for what it
// AMOUNTS TO. The number in the label is only round 1: the ladder climbs one level per round
// and stops at the last board the game has, so from the top there is nowhere left to climb.
// It is a sentence rather than a note beside the row because a note is drawn at a fixed x
// and this row, selected, already reaches it.
function _ttLvlLine(){
    const l = _duelLvl(_ttUi.lvl);
    // Speed is the LOUDER of the two settings -- it changes how the game feels at every level
    // -- so it leads the line when it is on, and the ladder follows it.
    const lad = l >= MAX_LEVELS ? 'EVERY ROUND AT LEVEL ' + MAX_LEVELS + ' - THERE IS NO DEEPER BOARD'
                                : 'ROUND 1 AT LEVEL ' + l + ' - ONE DEEPER EACH ROUND, UP TO ' + MAX_LEVELS;
    return _ttUi.speed ? 'EVERY ROUND AT SPEED - ' + lad : lad;
}
// How many rounds this tournament HAS, so a board can say where in it you are rather than
// only which round is up. Round 1 is the group stage; the knockout halves the field every
// round after it. Same standing as _ttMatches: the client works out what the field SHAPE
// implies purely to say it out loud, and decides nothing by it -- and a bracket the server
// has already dealt overrides the arithmetic outright, because its own nodes are the truth
// about how deep this tournament actually goes.
function _ttRounds(t){
    let deep = 0;
    for(const nd of [].concat((t && t.bracket) || [], (t && t.schedule) || []))
        if(nd && (nd.round | 0) > deep) deep = nd.round | 0;
    let a = Math.ceil(((t && t.players) || []).length / 2), est = 1;
    while(a > 1){ a = Math.ceil(a / 2); est++; }
    return Math.max(deep, est, t ? (t.round | 0) : 0);
}
// The gate on the whole feature: tournaments need a 4.1 server. An older one answers 404
// to tournament.php and never sends a roles sheet, so the menu row stays grey.
function netTourneyOk(){
    return _netOk() && typeof netSrvMinor === 'function' && netSrvMinor() >= 1;
}
function _ttMsg(m, bad){ uiMsg(_ttUi, m, bad ? 'fail' : 'select'); }
// A LINE about a match reads better with YOU in it -- "KAI vs YOU" -- so that is what
// _ttName answers a person's own id with. A TABLE is the other case entirely: a row is a
// person, and the column that says who everybody is has to say who YOU are too, or the
// board you are reading is not the board the others are reading. Those rows take
// _ttRealName and mark the row as yours in the margin instead.
function _ttName(id){
    id = String(id || '');
    if(!id) return '';
    if(id === getPlayerId()) return 'YOU';
    return _ttRealName(id);
}
function _ttRealName(id){
    id = String(id || '');
    if(!id) return '';
    if(_tt){
        for(const p of (_tt.players || [])) if(p && p.id === id) return String(p.name || '').toUpperCase() || fmtFriendId(id);
        const nm = _tt.roles && _tt.roles.names;
        if(nm && nm[id]) return String(nm[id]).toUpperCase();
    }
    // Our own name is not on any list we were handed until the server has sent one back:
    // a create is answered before the roster it creates, and a row drawn in between must
    // still be able to say whose it is.
    if(id === getPlayerId() && typeof _netMyName === 'function'){
        const mine = String(_netMyName() || '').toUpperCase();
        if(mine) return mine;
    }
    return (typeof netFriendName === 'function' && netFriendName(id)) ? String(netFriendName(id)).toUpperCase() : fmtFriendId(id);
}
// Where _duelExit / _netSessionEnd should land while a tournament is held: back to the
// picture, never to the 1vs1 menu. '' means "not ours, keep your default".
// WHERE STEPPING OFF THE TOURNAMENT SCREENS LANDS -- the door we came in by. A
// tournament reached from an EVENT belongs to that event's page, and that is the screen
// to give back; one reached through the multiplayer door gives back what the caller
// names. The fallback is the caller's because the two exits are at different heights:
// off the boards is off tournaments altogether (MULTIPLAYER), off a running one is back
// to the list of rooms, where there is something else to do.
function tourneyHome(fallback){ return _ttUi.home || fallback || 'multiplayer'; }
// ...and LANDING there. An event page hands over to these screens holding a picture that
// names the tournament as open or running, and the signal that ends it reaches a tournament
// screen, which is no event screen, and is dropped there. So the way back is that page's
// OPEN, and an open reads fresh: the row goes dark, or names the next one. Standing on the
// page already (DONE drops the tournament, which lands, and then goes home) is not a
// return and reads nothing.
function tourneyLand(to){
    if(to === 'eventPage' && phase !== to && typeof eventReturn === 'function') eventReturn();
    else phase = to;
}
function tourneyGoHome(fallback){ tourneyLand(tourneyHome(fallback)); }
// THE WALKOVER CLOCK. The sheet carries `walkover_at` (server API 4.15, unix ms on the
// shared clock): the instant the server may first hand the node to whoever is still there.
// Everybody waiting on a dealt match -- the player called up, the watchers, the event's
// screen -- reads it off the same field, so everybody sees the same clock ticking. Seconds
// left (0 once due), or -1 for nothing to show: no field (an older server), no synced
// clock, or a sheet younger than the grace -- a peer that is merely connecting must not
// be shown a clock running against it. `sinceMs` is when the sheet landed HERE.
function tourneyWalkoverLeft(roles, sinceMs){
    const at = roles ? +roles.walkover_at : 0;
    if(!(at > 0)) return -1;
    if(!sinceMs || _msgNow() - sinceMs < TT_WALK_GRACE_MS) return -1;
    const now = (typeof netPts === 'function') ? netPts() : null;
    if(now == null) return -1;
    return Math.max(0, Math.ceil((at - now) / 1000));
}
function tourneyRolesAt(){ return _ttRolesAt; }
function tourneyExitPhase(){
    if(!_tt) return '';
    if(_tt.state === 'done') return 'tourneyPodium';
    return _tt.brk ? 'tourneyRound' : 'tourneyBracket';
}
// Through the pacing gate, like every other server round trip of ours. A tournament call is
// not background -- somebody is looking at the screen it fills -- but the cost the gate
// exists for is paid per request IN FLIGHT, and what the server measured was this endpoint
// and start.php leaving in the same millisecond and both waiting 128ms for a worker on an
// idle host. Second in line costs one wait; side by side costs two.
async function _ttPost(action, extra){
    return await netActionPost('/api/tournament.php', action, extra);
}
function _ttArm(){ if(!_ttT && typeof setInterval === 'function') _ttT = setInterval(_ttTick, TT_TICK_MS); }
function _ttDisarm(){ if(_ttT){ clearInterval(_ttT); _ttT = null; } }

// ---- holding the server's picture ----------------------------------------------------
// Every response and every event is the same shape seen from a different distance, so one
// merge takes all of them. Absent keys are left alone: a lobby event says nothing about a
// bracket and must not erase one.
// THE TOURNAMENT THIS DEVICE IS IN, remembered across a reload. A tournament is an hour of
// other people's evening, and the picture of it lived only in memory: a refresh, a crash or
// a phone that killed the tab left a player sitting in a bracket with no way back to it,
// while the rest of the field waited out their walkovers. Only the id is kept -- everything
// else is re-read from the server, which is the only thing that knows what has happened
// since -- and it is dropped the moment the server says we are no longer in it.
const TT_HELD = 'ttHeld';
function _ttHold(tid){ try{ tid ? localStorage.setItem(TT_HELD, String(tid)) : localStorage.removeItem(TT_HELD); }catch(e){} }
function _ttHeld(){ try{ return localStorage.getItem(TT_HELD) || ''; }catch(e){ return ''; } }
function _ttAdopt(o){
    if(!o || !o.tid) return;
    const tid = String(o.tid);
    _ttHold(tid);
    if(!_tt || _tt.tid !== tid)
        _tt = { tid, code:'', host:'', state:'open', stakes:false, speed:false, max:TT_MAX, players:[],
                round:0, cursor:null, schedule:[], bracket:[], standings:[], advancers:[],
                roles:null, brk:null, you:'idle', podium:null, frozen:'', reason:'' };
    const t = _tt;
    if(o.code   != null) t.code   = String(o.code).toUpperCase();
    if(o.host   != null) t.host   = String(o.host);
    if(o.state  != null) t.state  = String(o.state);
    if(o.stakes != null) t.stakes = !!o.stakes;
    // Unlike the start level, `speed` rides the LOBBY as well as the roles sheet, so a
    // player can read it before joining. Absent reads as off: an unstated rule is not one
    // to play by, and that is the shape a server that does not serve it has.
    if(o.speed != null) t.speed = !!o.speed;
    if(o.max    != null) t.max    = o.max | 0;
    if(o.round  != null) t.round  = o.round | 0;
    if(o.reason != null) t.reason = String(o.reason);
    if(o.cursor !== undefined) t.cursor = o.cursor ? String(o.cursor) : null;
    if(Array.isArray(o.players))   t.players   = o.players;
    if(Array.isArray(o.schedule))  t.schedule  = o.schedule;
    if(Array.isArray(o.bracket))   t.bracket   = o.bracket;
    if(Array.isArray(o.standings)) t.standings = o.standings;
    // A podium the reply KNOWS about. Never the other way round: an absent key is a reply
    // that does not talk about podiums (every reply before the last one), and letting that
    // clear a podium we already hold would take the result off the screen it just arrived on.
    if(Array.isArray(o.podium)) t.podium = o.podium;
    // The board is DERIVED on every state read, so an absent key means "this reply does not
    // talk about breaks" (a lobby event) while an explicit null means "no break is open" --
    // and that null is the only thing that ever takes the board down without a roles sheet.
    if(o['break'] !== undefined) _ttSetBreak(o['break'] || null);
    _ttArm(); _uiDirty = true;
}
// The podium as this client can work it out, for the client that never saw the 'over' event.
// Signals are one-shot and expire, and the state read-back is the safety net under all of
// them -- but a server build need not name a podium in it, and a single lost signal then
// ended an entire evening on NO PODIUM - THE BRACKET VOIDED, which is a real verdict for a
// bracket that ran out of players and a lie for one that was won. Everything needed to tell
// the two apart is in the bracket the read-back does carry: the final names the top two, and
// third place is the better-ranked loser of the round that feeds it (the server's rule, and the standings it is
// read off are in the same reply). An unfinished or absent final gives null -- NOT an empty
// list, which is the one thing that legitimately means the bracket voided.
function _ttDerivePodium(t){
    const brk = Array.isArray(t.bracket) ? t.bracket : [];
    let fin = null;
    for(const n of brk) if(String(n.nid || '') === 'final') fin = n;
    if(!fin || !fin.winner) return null;
    const win = String(fin.winner), ps = (fin.players || []).map(v => v == null ? '' : String(v));
    const out = [win];
    const up = ps[0] === win ? ps[1] : ps[0];
    if(up) out.push(up);
    // The nodes that feed the final are the deepest ones below it, whatever they are called.
    let deep = -1;
    for(const n of brk) if((n.round | 0) < (fin.round | 0) && (n.round | 0) > deep) deep = n.round | 0;
    const semis = [];
    for(const n of brk){
        if((n.round | 0) !== deep || !n.winner) continue;
        const q = (n.players || []).map(v => v == null ? '' : String(v));
        const l = q[0] === String(n.winner) ? q[1] : q[0];
        if(l) semis.push(l);
    }
    if(semis.length === 1) out.push(semis[0]);
    else if(semis.length > 1)
        for(const row of (t.standings || [])) if(semis.indexOf(String(row.id)) >= 0){ out.push(String(row.id)); break; }
    return out;
}
// A round ends on a scoreboard, and the next one starts when the HOST clears it. That makes
// the board a deadline as well as a picture: the server refuses `continue` until `wait` ms
// after the break opened, and drops the break itself `auto` ms after that, so a host who
// closed their browser cannot wedge an evening everybody else is still in.
function _ttSetBreak(b){
    const same = !!(_tt.brk && b && (_tt.brk.done | 0) === (b.done | 0));
    _tt.brk = b || null;
    if(!b){
        _ttUi.contAt = 0;
        if(phase === 'tourneyRound') phase = _tt.state === 'done' ? 'tourneyPodium' : 'tourneyBracket';
        return;
    }
    // The wait runs from the moment WE first saw the board rather than from the moment the
    // server opened it. Seeing it late costs a second; reading a foreign clock costs a button
    // that is either dark forever or live immediately. And re-reading the SAME break must not
    // wind the deadline back, or a press refused a moment ago walks into the same refusal.
    if(!same) _ttUi.contAt = _msgNow() + Math.max(TT_READ_MS, b.wait | 0);
    // A break we did not already have takes the screen -- from an event or from a state read
    // alike, which is what makes the round screen survive a missed signal or a reload.
    if(!same && !inGame && _TT_PHASES[_ttFace()] && _ttFace() !== 'tourneyPodium') _ttGo('tourneyRound');
}
// The delay applies to what an event MAKES US ASK FOR, never to the event itself: the
// screen is redrawn the moment the news lands, exactly as before.
function _ttAfterNote(d){
    const a = (d && d.after_ms | 0) || 0;
    if(a > 0) _ttAfter = Math.max(_ttAfter, _msgNow() + Math.min(a, TT_AFTER_MAX));
}
// ...and the delay has to be applied to the CALL, not only to the state read-back that used
// to be the only thing an event provoked. A sheet provokes an offer, and the offer provokes
// the pair's two start.php calls, so a stagger that stops at _ttSync leaves the whole field
// dealing itself into the same millisecond anyway. Everything local -- the ceremony, the
// match parameters, the session dressing -- has already happened by the time this is
// reached; only what goes on the wire waits, and only for this node.
function _ttAfterDo(nid, fn){
    const w = _ttAfter - _msgNow();
    if(!(w > 0) || typeof setTimeout !== 'function'){ fn(); return; }
    const n = String(nid || '');
    setTimeout(()=>{ if(_tt && _ttNid === n && _ttDone !== n) fn(); }, Math.min(w, TT_AFTER_MAX));
}
// The full read-back. Every call has a reason -- a screen entered, a transition made, an
// event that changed the shape, a sheet in doubt, a mailbox that was down and is back --
// and nothing calls it on a timer: the server evaluates its own deadlines on the poll every
// participant already sends, so `state` is for a reload, a rejoin and doubt, exactly as the
// contract says, never for keeping time.
async function _ttSync(){
    if(!_tt) return;
    const now = _msgNow();
    // Wait the server's stagger out rather than adding to the burst: the caller needs the
    // answer, not this millisecond -- so the read is deferred and then made, never dropped.
    if(_ttAfter > now){
        if(typeof setTimeout === 'function' && !_ttAfterT)
            _ttAfterT = setTimeout(()=>{ _ttAfterT = null; _ttAfter = 0; _ttSync(); }, _ttAfter - now);
        return;
    }
    const tid = _tt.tid;
    const r = await _ttPost('state', { tid });
    if(!_tt || _tt.tid !== tid) return;            // we left while it was in flight
    if(!r.json){
        if(r.status === 404) _ttDrop('TOURNAMENT GONE');
        return;
    }
    _ttAdopt(r.json);
    // A tournament can end without us: the host walks out and every client is dropped. The
    // event says so, but a client that missed it would otherwise poll a dead tournament for
    // ever, so the read-back is allowed to deliver the same verdict.
    if(_tt.state === 'abandoned'){ _ttDrop(_ttGoneWhy()); return; }
    if(r.json.roles){
        const sheet = r.json.roles;
        if(!sheet.tid) sheet.tid = tid;
        _ttRoles(sheet);
    } else if(!r.json.cursor && _ttRolesAt < now){
        // Between nodes: the node we hold is finished. Believed only from a read-back
        // REQUESTED after the sheet arrived -- one sent before the deal and answered after
        // it would finish a node that was just dealt, and nobody would ever engage it.
        _ttDone = _ttNid;
    }
    // The read-back is what puts a client on the podium screen when the 'over' event never
    // reached it -- so it has to be what fills that screen in, too. Only when we hold no
    // podium at all: one the server named outranks anything worked out from a bracket.
    if(_tt.state === 'done' && !Array.isArray(_tt.podium)) _tt.podium = _ttDerivePodium(_tt);
    // Straight at `phase`, quit dialog included: a tournament that is over is not one
    // anybody can still be asked about leaving.
    if(_tt.state === 'done' && _TT_PHASES[phase] && phase !== 'tourneyPodium') phase = 'tourneyPodium';
}
function _ttDrop(msg){
    // Every route into here is terminal -- we left, it ended, it is gone, we are not in it
    // any more -- so the way back is dropped with the picture. Stepping OUT of the screens
    // is not one of these routes: that keeps both.
    _ttHold('');
    _tt = null; _ttNid = ''; _ttRolesAt = 0; _ttEngAt = 0; _ttDone = ''; _ttRep = null; _ttWant = null;
    _ttPlayNid = ''; _ttWatchNid = ''; _ttOverAt = 0;
    if(typeof specNode === 'function') specNode('', '');
    if(typeof specGrant === 'function') specGrant([]);
    if(typeof specMonitor === 'function') specMonitor('');
    _ttDisarm();
    _ttUi.sel = -1; _ttUi.contAt = 0;
    if(_TT_PHASES[phase]) tourneyGoHome('tourneyLobby');
    if(msg) _ttMsg(msg, true); else _uiDirty = true;
}

// ---- the signal dispatcher -----------------------------------------------------------
// `tourney` is a RESERVED server-generated signal type: the sender is the server itself,
// so these arrive without a player id and are the only signals we trust unauthenticated.
function _ttOnSignal(d){
    if(!d || typeof d !== 'object') return;
    const ev = String(d.event || ''), tid = String(d.tid || '');
    if(!ev || !tid) return;
    // Not our tournament to PLAY. An event's MONITOR is dealt the sheets of the event's
    // tournament like any spectator (server API 4.14) without ever holding it here, so
    // the signal goes to its screen; anything else is an echo from one we left or a
    // mix-up, and we render what state() says about the one we hold.
    if(!_tt || _tt.tid !== tid){
        if(typeof eventMonitorSignal === 'function') eventMonitorSignal(d);
        return;
    }
    _ttAfterNote(d);
    switch(ev){
        case 'lobby':
            _ttAdopt(d);
            if(_tt.state === 'abandoned') _ttDrop(_ttGoneWhy());
            break;
        case 'roles':       _ttRoles(d); break;
        case 'roles-patch': _ttPatch(d); break;
        case 'standings':
            _tt.standings = d.rows || [];
            _tt.advancers = d.advancers || [];
            // A break may already be up: the two events describe the same moment from
            // different distances, and whichever lands second must not undo the other.
            if(_TT_PHASES[_ttFace()] && _ttFace() !== 'tourneyPodium' && _ttFace() !== 'tourneyRound') _ttGo('tourneyBracket');
            _ttSync();
            break;
        case 'round':
            // A round ended and the next one waits on the host. The rows arrive one per
            // participant, already ordered as an elimination ladder and already marked with
            // who is through, so they are stored whole and drawn as they stand.
            _ttSetBreak(d);
            if(Array.isArray(d.advancers)) _tt.advancers = d.advancers;
            _tt.round = d.next | 0; _tt.cursor = null;
            _ttDone = _ttNid;   // whatever we held is over with the round
            _uiDirty = true;
            break;
        case 'result':
            // The node is settled: whatever we still owed on it is owed no longer.
            if(_ttRep && _ttRep.body.nid === String(d.nid || '')) _ttRep = null;
            if(String(d.nid || '') === _ttNid) _ttDone = _ttNid;   // ...and it is not played again
            // `why` rides a result that closed a node WITHOUT it being played. It has
            // to be carried, because such a node closes as a formal DRAW -- that is
            // what makes the bracket advance an empty slot instead of replaying an
            // unplayable pairing for ever -- and a draw is the one thing it must not
            // be shown as. Absent on every ordinary result.
            _tt.last = { nid:String(d.nid || ''), winner:d.winner || null, draw:!!d.draw,
                         score:d.score || null, why:String(d.why || '') };
            // The event IS the change. The node it names is settled in the picture we hold,
            // and a server that sends the standings with it (rows, 1.4.17) has said everything
            // the bracket screen draws -- eight clients re-reading 5 KB each on every settle was
            // the fattest part of a tournament's one traffic peak. Only an older server, whose
            // result carries no rows, still makes this a read.
            _ttNodeSettle(_tt.last);
            if(Array.isArray(d.rows)){ _tt.standings = d.rows; _uiDirty = true; }
            else _ttSync();
            break;
        case 'freeze':
            _tt.frozen = String(d.nid || '');
            _ttMsg('MATCH FROZEN - RESULTS DISAGREED', true);
            _ttSync();
            break;
        case 'over':
            _tt.state = 'done'; _tt.podium = d.podium || [];
            _ttDone = _ttNid;
            if(!inGame) phase = 'tourneyPodium';
            _uiDirty = true;
            break;
        default: _ttSync();   // an event a newer server knows and we do not
    }
}

// A result applied to the node we hold -- the fields state() would carry for it -- so the
// picture stays the server's without asking for it again. A node we do not hold (a knockout
// node before the read that draws the bracket) is simply not here; NOW PLAYING falls back to
// the roles sheet for that.
function _ttNodeSettle(r){
    if(!_tt) return;
    for(const nd of [].concat(_tt.schedule || [], _tt.bracket || [])){
        if(!nd || String(nd.nid) !== r.nid) continue;
        nd.state = 'settled'; nd.winner = r.winner; nd.draw = r.draw; nd.score = r.score;
        nd.why = r.why || '';
    }
}

// ---- roles: the sheet that starts a match --------------------------------------------
function _ttRoles(d){
    if(!_tt) return;
    const nid = String(d.nid || '');
    if(!nid) return;
    _tt.roles  = d;
    _tt.round  = d.round | 0;
    _tt.cursor = nid;
    _tt.you    = String(d.you || 'idle');
    // A sheet is how a break ends: the next match is dealt. Clearing it here rather than
    // waiting for the state read-back is what takes the scoreboard off the screen in time
    // for the ceremony -- and for a player with nothing to do, back to the bracket.
    if(_tt.brk) _ttSetBreak(null);
    if(_tt.state === 'open') _tt.state = 'running';
    // The sheet is the introduction. Everyone on it may connect to us for this node --
    // players, primaries and secondaries alike -- so a spectator link needs no friendship
    // and no invite, exactly as the server's signal gating allows.
    if(typeof specGrant === 'function') specGrant([].concat(d.players || [], d.primaries || [], d.secondaries || [], d.monitor || []));
    if(typeof specNode === 'function') specNode(_tt.tid, nid);
    // The event's screen, a spectator in no list: granted like the rest, served beside the
    // tree rather than in it (net-spec.js specMonitor), drawn nowhere.
    if(typeof specMonitor === 'function') specMonitor(d.monitor);
    // ONE EVENT, ONE CALL. The sheet carries everything a match needs -- nid, hm, lvl,
    // stakes, players, feeder, primaries, secondaries, names and `you` -- so it IS a state
    // read: nothing asks the server to repeat what it just pushed, least of all beside the
    // start.php the same sheet provokes. A doubtful sheet is the exception -- an offer we
    // hold no sheet for still forces a read (tourneyOfferOk).
    _uiDirty = true;
    if(_ttNid === nid) return;   // the same node again (a state re-read, a repeat delivery)
    _ttNid = nid; _ttRolesAt = _msgNow(); _ttEngAt = 0; _tt.frozen = '';
    // A FINISHED match still on the board gives way at once: the feeder offers the instant
    // it engages, so this sheet and the offer it authorises can share one signal drain, and
    // that offer -- with its candidates trickling behind it -- needs a clear board and a
    // session to land in, or it is lost until the feeder's next try. A LIVE match keeps the
    // board; the sheet waits in _tt.roles and _ttDrive engages it from the tick once the
    // match is off the screen, so nobody is dropped into a duel cold.
    if(inGame && _ttOverAt) _ttClearMatch();
    _ttDrive(_msgNow());
    _ttArm();
}
// A re-deal of the CURRENT node's tree (a primary stood down, a secondary was orphaned).
// Roles patches never move the bracket, so they only ever touch the spectator wiring.
function _ttPatch(d){
    if(!_tt || !_tt.roles || String(d.nid || '') !== _ttNid) return;
    const r = _tt.roles;
    r.primaries   = d.primaries   || [];
    r.secondaries = d.secondaries || [];
    if(d.monitor !== undefined) r.monitor = d.monitor;
    if(typeof specGrant === 'function') specGrant([].concat(r.players || [], r.primaries, r.secondaries, r.monitor || []));
    if(typeof specMonitor === 'function') specMonitor(r.monitor);
    // Re-source only if the tree moved US. net-spec repairs a dead link on its own and a
    // patch must never yank a healthy feed out from under a running sim.
    if(_tt.you === 'spectate' && typeof netSpectating === 'function' && netSpectating()
       && typeof netSpecFeedAge === 'function' && netSpecFeedAge() > SPEC_SILENCE_MS)
        _ttEngage(r);
    _uiDirty = true;
}
// Turn the sheet into a connection. Idempotent: _ttDrive calls it again for as long as the
// sheet stands and the node is not finished, and every call is the same thing -- set the
// match parameters, then offer (feeder) or wait for the offer (answerer) or ask for the
// feed (watcher).
function _ttEngage(d){
    const me = getPlayerId(), you = String(d.you || 'idle');
    _ttPlayNid = '';
    if(you === 'play'){
        const ps = (d.players || []).map(String);
        const peer = ps[0] === me ? ps[1] : ps[0];
        if(!/^[0-9a-f]{8}$/.test(String(peer || ''))){ _ttFail('BAD MATCH SHEET'); return; }
        // The round ladder: round 1 is level 1 and every round after it one deeper, capped
        // at the game's last level. The sheet says which, and _duelLvl refuses anything that
        // is not a level this build has.
        _ttWant = { peer, hearts:_duelHearts(d.hm), stakes:!!d.stakes, lvl:_duelLvl(d.lvl), speed:!!d.speed };
        _ttPlayNid = String(d.nid || '');   // this node's match owns the board now
        netP2POnlySet(true);   // a tournament match is direct or nothing
        // _netMkSess is not the only moment a session can need dressing: a state re-read can
        // deliver the sheet after the feeder's offer was answered and the session minted.
        // Dress that session here too: the go repairs hearts and stakes on its own, but only
        // a preset can refuse a wrong one, and p2p-only has no wire representation at all.
        if(typeof _netSess !== 'undefined' && _netSess) tourneyDressSession(_netSess);
        // players[0] is the feeder and the feeder is always the offerer, so the two sides
        // never both offer. This is the quick-match path verbatim -- an offer needs no
        // friendship, which is exactly why strangers can be drawn against each other.
        if(String(d.feeder) === me) _ttAfterDo(d.nid, ()=>_netRtcOffer(peer));
        return;
    }
    if(you === 'spectate'){
        if(typeof specWatch !== 'function') return;
        const pr = (d.primaries || []).map(String);
        _ttWatchNid = String(d.nid || '');
        if(pr.indexOf(me) >= 0){ _ttAfterDo(d.nid, ()=>specWatch(String(d.feeder), _tt.tid, d.nid)); return; }
        // A secondary asks BOTH primaries: one answers with the feed, the other is held
        // open and silent, so a failover costs a flag instead of a connect (net-spec.js).
        const src = pr.length ? pr : [String(d.feeder)];
        for(const p of src.slice(0, SPEC_MAX_DIRECT)) _ttAfterDo(d.nid, ()=>specWatch(p, _tt.tid, d.nid));
    }
}
// net-session asks before it answers an offer. In a tournament the sheet says who may
// offer us and for what, and _ttEngage has set _ttWant from it before the feeder's offer
// can arrive (a sheet precedes the offer it authorises, in the same drain or an earlier
// one). Anything else -- a stranger, a peer we hold no sheet for, an offer that outran a
// sheet we never received -- is not answered, and the sheet is re-read: a match must never
// start undressed, because a match that starts undressed is one nobody reports.
function tourneyOfferOk(from){
    if(!_tt) return true;
    if(_ttWant && _ttWant.peer === String(from)) return true;
    _ttSync();
    return false;
}
function _ttFail(msg){
    _ttDone = _ttNid; _ttWant = null; _ttPlayNid = ''; _ttWatchNid = '';
    netP2POnlySet(false);
    if(_TT_PHASES[_ttFace()]) _ttGo(_tt ? tourneyExitPhase() : 'tourneyLobby');
    _ttMsg(msg, true);
}
// The answerer never sees the roles sheet at offer time -- the offer carries no match
// parameters -- so the session it mints is dressed here instead, before the first 'go'.
// A go that disagrees with heartsWant then ends the match rather than starting a wrong one.
function tourneyDressSession(s){
    if(!s || !_ttWant || s.peer !== _ttWant.peer) return;
    s.hearts = _ttWant.hearts;
    s.heartsWant = _ttWant.hearts;
    s.stakes = _ttWant.stakes;
    s.stakesWant = _ttWant.stakes;
    s.lvl0 = _ttWant.lvl;
    s.levelWant = _ttWant.lvl;
    s.speed = _ttWant.speed;
    s.speedWant = _ttWant.speed;
    s.p2pOnly = true;
}

// ---- reporting a result --------------------------------------------------------------
// Only the two players may report, and each reports once per node. A loss settles the node
// immediately; a lone win or draw is held until the peer agrees or the server's timer runs
// out. Contradicting each other freezes the node, so we report what the sim says and
// nothing else.
function _ttReport(nid, outcome, score){
    if(!_tt) return;
    const body = { id:getPlayerId(), action:'result', tid:_tt.tid, nid, outcome, score };
    const mid = (typeof _netSess !== 'undefined' && _netSess && _netSess.mid) || '';
    if(mid) body.mid = mid;
    _ttRep = { body, at:0, tries:0 };
    _ttArm();
    _ttFlushRep();
}
async function _ttFlushRep(){
    if(!_ttRep || _ttRepBusy || !_tt) return;
    const now = _msgNow();
    if(_ttRep.at && now - _ttRep.at < TT_REPORT_MS) return;
    if(_ttRep.tries >= TT_REPORT_MAX){ _ttRep = null; return; }   // the walkover ladder has it from here
    _ttRep.at = now; _ttRep.tries++;
    _ttRepBusy = true;
    const r = await _netPostRes('/api/tournament.php', _ttRep.body, NET_BG_SOLO);
    _ttRepBusy = false;
    if(!_ttRep) return;
    // 403/404/409 are all terminal: not our match, no such node, or a node that has moved
    // on. Retrying any of them forever would be noise, and a replay of an accepted report
    // is a no-op anyway, so an ok clears it too.
    if(r.json || r.status === 403 || r.status === 404 || r.status === 409) _ttRep = null;
}
// Called from the phase-change hook the instant the sim declares a duel over.
function tourneyMatchOver(){
    if(!_tt || !_ttNid) return;
    if(!_ttOverAt) _ttOverAt = _msgNow();
    // _ttPlayNid, not _tt.you: the sheet for the next node may already have landed, and its
    // role says nothing about the match that just ended on our board.
    // A watcher owes nobody a result, but the node is finished for it all the same.
    if(!_ttPlayNid){ if(_ttWatchNid) _ttDone = _ttWatchNid; return; }
    if(_ttDone === _ttPlayNid) return;
    _ttDone = _ttPlayNid;
    const my = (typeof netMyIndex === 'function') ? netMyIndex() : 0;
    const ps = (typeof players !== 'undefined' && players) ? players : null;
    const sc = ps ? [ps[my].score | 0, ps[1 - my].score | 0] : [0, 0];
    const w  = (typeof duelWinner !== 'undefined') ? duelWinner : -1;
    _ttReport(_ttPlayNid, w === 2 ? 'draw' : (w === my ? 'win' : 'loss'), sc);
}
// True while walking out would cost us the match: a node of ours is on the board and no
// result has gone in for it yet. The quit dialog warns off this same predicate, so what the
// warning promises and what leaving does cannot drift apart. A watcher owes no result, so
// it is never at stake for one.
function tourneyMatchAtStake(){
    return !!(_tt && inGame && _ttPlayNid && _ttDone !== _ttPlayNid);
}
// Called when a player walks out of a tournament match before it ended. Leaving is losing,
// and a reported loss settles at once -- far kinder to the eight people waiting than the
// three-minute walkover ladder. Nobody lies to lose.
function tourneyMatchLeft(){
    if(!tourneyMatchAtStake()) return;
    _ttDone = _ttPlayNid;
    const my = (typeof netMyIndex === 'function') ? netMyIndex() : 0;
    const ps = (typeof players !== 'undefined' && players) ? players : null;
    _ttReport(_ttPlayNid, 'loss', ps ? [ps[my].score | 0, ps[1 - my].score | 0] : [0, 0]);
}
// net-spec.js calls these: a primary about to be backgrounded stands down, and a secondary
// that lost every source asks for a new one. Both are role re-deals for the CURRENT node
// and answer with nothing -- the new tree arrives as a roles-patch.
function tourneyStandDown(tid, nid){
    if(!_tt || _tt.tid !== String(tid || '') || !nid) return;
    _ttPost('standdown', { tid:_tt.tid, nid:String(nid) });
}
function tourneyOrphan(tid, nid){
    if(!_tt || _tt.tid !== String(tid || '') || !nid) return;
    _ttPost('orphan', { tid:_tt.tid, nid:String(nid) });
}

// ---- housekeeping --------------------------------------------------------------------
function _ttClearMatch(){
    _ttOverAt = 0; _ttWant = null; _ttPlayNid = ''; _ttWatchNid = '';
    netP2POnlySet(false);
    if(typeof netSpectating === 'function' && netSpectating() && typeof specStop === 'function') specStop('');
    if(typeof _duelExit === 'function') _duelExit();   // lands on tourneyExitPhase()
    else if(_tt) phase = tourneyExitPhase();
}
// THE RULE that runs a node on this client. The sheet is the truth: for as long as one
// stands that names us, and the node it names is not finished on our side, it is turned
// into a connection -- and turned into one AGAIN every TT_CONNECT_MS for as long as that
// stays true. That sentence is the whole recovery: an offer lost in the mailbox, a peer
// slow to arrive, a link that died mid-match with nothing reported yet (the pair replays
// the node from a fresh seed; there is no result to protect), a feed gone quiet on a
// watcher. What ends it is the node finishing (_ttDone) or the server moving on (a new
// sheet, a round, the podium). Giving up is not this client's call: who did not show up is
// the server's verdict (its walkover ladder), and a watcher owes nobody anything.
// The screen: the FIRST engagement of a sheet is the ceremony. A later one leaves the
// screen alone -- ESC to the bracket is not a way out of the match, so the rule keeps
// running there and says what it is doing instead of taking the screen back.
function _ttDrive(now){
    const d = _tt && _tt.roles;
    if(inGame || !d || String(d.you || 'idle') === 'idle' || _ttDone === String(d.nid || '')) return;
    const again = _ttEngAt > 0;
    if(again && now - _ttEngAt < TT_CONNECT_MS) return;
    _ttEngAt = now;
    if(!again) _ttGo('tourneyCeremony');
    else _ttMsg(d.you === 'spectate' ? 'STILL LOOKING FOR A FEED'
                                     : 'WAITING FOR ' + _ttName(_ttWant ? _ttWant.peer : ''), true);
    _ttEngage(d);
}
function _ttTick(){
    if(!_tt){ _ttDisarm(); return; }
    const now = _msgNow();
    _ttFlushRep();
    if(_ttUi.msg && now - _ttUi.msgAt > TT_MSG_MS){ _ttUi.msg = ''; _uiDirty = true; }
    // `_ttOverAt` means one thing: A FINISHED MATCH IS STILL ON THE BOARD. Every other way
    // out of a duel -- the player pressing a key on the over screen, a peer's bye, a lost
    // connection -- clears the board without going through _ttClearMatch, and the stamp then
    // outlived the match it was made for. The next match inherited it and was torn down as a
    // finished one seconds after it began: a live game killed and forfeited mid-play.
    if(!inGame && _ttOverAt) _ttOverAt = 0;
    // A finished match must be OFF the board before the next one can be set up. The banner
    // gets its moment; a sheet that arrives sooner takes it down itself (_ttRoles).
    if(inGame && _ttOverAt && now - _ttOverAt > TT_OVER_MS) _ttClearMatch();
    // A break that arrived while a match was STILL ON THE BOARD never got to take the
    // screen, and re-reading the same break deliberately does not move it either -- so this
    // is the one moment left to act on it. Without it a player whose match ended by any
    // route that does not run the duel exit (a no-show settled by the server, a peer's bye,
    // a dead connection) is left sitting on a ceremony for a node the tournament has already
    // walked past, with nothing on screen ever changing again.
    if(_tt.brk && !inGame && _TT_PHASES[_ttFace()]
       && _ttFace() !== 'tourneyRound' && _ttFace() !== 'tourneyPodium'){
        _ttGo('tourneyRound');
    }
    _ttDrive(now);
}
// The mailbox was down and is back (net-api.js _netPollOnce: a poll failed, then one
// succeeded -- a backgrounded tab, a zombie hold cut loose, a network blip). A push may have
// died in between: the server drops an undelivered signal after 30s, and nothing but the
// adopted picture ever SHRINKS a roster or takes a cleared board down. One whole read, then.
function tourneyMailboxLost(){
    if(!_tt) return;
    _ttSync();
}

// ---- lobby actions -------------------------------------------------------------------
function tourneyEnter(){
    _ttUi.sel = -1; _ttUi.msg = '';
    _ttUi.home = '';   // the multiplayer door: this is the room to give back
    // A tournament link parked a code at boot and this is the first screen that can spend it.
    // It waits for the hello, because the join is gated on the server's minor version and an
    // unanswered hello reads exactly like an old server. Unspent, it STAYS parked: a code is
    // only worth burning against a server that could have taken it.
    const spend = () => {
        if(!_tourneyLink || _tt || !netTourneyOk()) return;
        const c = _tourneyLink; _tourneyLink = ''; tourneyJoin(c);
    };
    if(typeof _netHello === 'function' && _netOk()){
        const h = _netHello();   // picks up the tourneys list
        if(h && typeof h.then === 'function') h.then(spend, spend); else spend();
    }
    // A tournament link is a multiplayer door too: the same age-gated anchor refresh as the 1vs1 one.
    if(typeof _netAnchorRefresh === 'function') _netAnchorRefresh({ nudge:true });
    if(_tt) _ttSync(); else _ttProbe();
    _uiDirty = true;
}
function tourneyLobbyList(){ return (typeof _netTourneys !== 'undefined' && _netTourneys) ? _netTourneys : []; }
// A tournament we are in but not in front of. The announce list cannot carry it -- that only
// ever names OPEN lobbies on this network, and by the time you have dropped out of one it is
// usually running -- so the way back is asked for directly, by the id this device kept.
// Anything the server answers other than "you are in it and it is live" forgets the id: a
// tournament you have been removed from must not keep offering you a door.
async function _ttProbe(){
    const tid = _ttHeld();
    if(_tt || !tid || !netTourneyOk()){ if(_tt) _ttBack = null; return; }
    const r = await _ttPost('state', { tid });
    if(_tt) return;                                   // we joined something else meanwhile
    if(!r.json){
        if(r.status === 404 || r.status === 403) _ttHold('');
        return;
    }
    const st = String(r.json.state || '');
    if(st === 'done' || st === 'abandoned'){ _ttHold(''); _ttBack = null; }
    else { r.json.tid = r.json.tid || tid; _ttBack = r.json; }
    _uiDirty = true;
}
function tourneyRejoin(){
    if(_tt || !_ttBack) return;
    const back = _ttBack; _ttBack = null;
    _ttAdopt(back);
    _ttUi.sel = -1; _ttMsg('BACK IN');
    Snd.sfxPlay('select', cfg.music);
    _ttSync();
}
// THE WAY BACK BY ID, for a door that names the tournament rather than holding it:
// an event's page knows its running tournament's tid and nothing else. `join` is
// answered 409 once a tournament runs, so a participant who closed the app and
// comes back through the room gets in the way the probe above does -- by reading
// the tournament -- and the server says whether we are in it: `state` is 403 to
// anybody who is not a participant, so nothing here has to judge that.
async function tourneyResume(tid){
    if(_tt || _ttUi.busy) return false;
    if(!netTourneyOk()){ _ttMsg('TOURNAMENTS NEED A NEWER SERVER', true); return false; }
    tid = String(tid || '');
    _ttUi.busy = true; _ttMsg('REJOINING...');
    const r = await _ttPost('state', { tid });
    _ttUi.busy = false;
    if(_tt) return true;                              // we joined something else meanwhile
    if(!r.json){
        if(r.status === 404)      _ttMsg('NO SUCH TOURNAMENT', true);
        else if(r.status === 403) _ttMsg('ALREADY STARTED', true);
        else _ttMsg('COULD NOT REJOIN', true);
        return false;
    }
    const st = String(r.json.state || '');
    if(st === 'done' || st === 'abandoned'){ _ttHold(''); _ttMsg('TOURNAMENT IS OVER', true); return false; }
    r.json.tid = r.json.tid || tid;
    _ttBack = null;
    _ttAdopt(r.json);
    _ttUi.sel = -1; _ttMsg('BACK IN');
    _ttSync();
    return true;
}
// A host holds one tournament at a time: a create while hosting is answered 409. Since
// server 4.8 the same create sent again with replace:true ends the one we host -- exactly
// as our own leave would -- and opens the new one in the same call, so we can never end
// up holding neither. Feature-detected by behaviour, never by version: replace goes out
// only after a 409, and a 409 to THAT is an older server, which gets the plain message.
// The player is asked first (_ttAskReplace): a running tournament ends for everyone.
// CREATE is two presses, not one: the screen that collects what a tournament is played FOR
// comes first, and the row on it that says CREATE is the one that talks to the server. The
// settings are read off _ttUi there, so nothing is passed in and nothing can be half-passed.
function tourneySetupOpen(eid){
    // The event the create belongs to, or none. Set on every open rather than left
    // standing: a create started from the ordinary tournament screen after one
    // started from an event page must not inherit the room.
    _ttUi.eid = String(eid || '');
    // ...and it is the same fact that says where the exits lead: a create carrying an
    // event was started from that event's page and belongs back on it.
    _ttUi.home = _ttUi.eid ? 'eventPage' : '';
    _ttUi.sel = 0;   // an ordinary list, top row armed -- and the top row is CREATE, which is what this screen is for
    phase = 'tourneySetup';
    Snd.sfxPlay('select', cfg.music);
    _uiDirty = true;
}
async function tourneyCreate(stakes, lvl, speed, replace){
    if(_tt || _ttUi.busy) return;
    if(!netTourneyOk()){ _ttMsg('TOURNAMENTS NEED A NEWER SERVER', true); return; }
    _ttUi.busy = true; _ttMsg('CREATING...');
    const body = { stakes: !!stakes, lvl: _duelLvl(lvl), speed: !!speed };
    // AN EVENT TOURNAMENT IS AN ORDINARY TOURNAMENT. `eid` is a tag on it and a
    // membership check on the way in, and that is the entire difference: no second
    // state machine, no event branch in the bracket, nothing else on this side.
    // The one place it is set is the create the event page opened.
    if(_ttUi.eid) body.eid = _ttUi.eid;
    if(replace) body.replace = true;
    const r = await _ttPost('create', body);
    _ttUi.busy = false;
    if(!r.json){
        // The cooldown is charged BEFORE anything is ended, so on a 429 the tournament we
        // host is still standing: show the wait, never report it as ended.
        if(r.status === 429) _ttMsg('TOO SOON - WAIT ' + Math.max(1, Math.ceil(+((r.body && r.body.retry_after) || 60))) + 'S', true);
        else if(r.status === 409 && !replace) _ttAskReplace(stakes, lvl, speed);
        else if(r.status === 409) _ttMsg('YOU ALREADY HOST ONE', true);
        else _ttMsg('COULD NOT CREATE', true);
        return;
    }
    _ttBack = null;   // the one we could have gone back to is the one this replaced
    _ttAdopt(Object.assign({ host:getPlayerId(), state:'open' }, r.json));
    _ttUi.sel = -1;
    phase = 'tourneyLobby';   // the setup screen is spent the moment the room it describes exists
    _uiDirty = true;
    _ttMsg('CODE ' + (_tt ? _tt.code : ''));
    _ttSync();
}
// The question behind a 409 on create. The 409 names nothing, so what the dialog can say
// about the tournament we host is what this device still knows of it: the way back
// (_ttBack) names it when this is the device that hosted it. Elsewhere the question is
// asked in the general form, with the running case spelled out since it cannot be excluded.
function _ttAskReplace(stakes, lvl, speed){
    const b = _ttBack;
    const mine = !!(b && String(b.host || '') === getPlayerId());
    _ttUi.ask = { kind:'replace', stakes:!!stakes, lvl:_duelLvl(lvl), speed:!!speed,
                  code:mine ? String(b.code || '') : '',
                  running:mine ? String(b.state || '') === 'running' : null };
    _ttUi.from = 'tourneySetup'; _ttUi.to = '';   // NO returns to the settings the question was asked from
    quitConfirmSel = 1;                                // NO: the safe answer is the offered one
    phase = 'tourneyQuit';
    Snd.sfxPlay('nav', cfg.music);
    _uiDirty = true;
}
// The dialog's answer. YES re-sends the create with replace:true; NO is the lobby again.
function tourneyAskAnswer(yes){
    const a = _ttUi.ask; _ttUi.ask = null;
    phase = _ttUi.from || 'tourneyLobby'; _uiDirty = true;
    if(yes && a && a.kind === 'replace') tourneyCreate(a.stakes, a.lvl, a.speed, true);
}
// Why a tournament we were in is gone, in the words of the reason the server gave (the
// lobby event carries it; the read-back does too). The server's vocabulary: the host left
// the lobby, ended a running one, or opened a new one over it; everyone stopped beating;
// an operator pulled it. Anything else reads as the plain abandon.
function _ttGoneWhy(){
    const why = _tt ? String(_tt.reason || '').toLowerCase() : '';
    if(why.indexOf('opened a new one') >= 0) return 'HOST STARTED A NEW TOURNAMENT';
    if(why.indexOf('host left') >= 0)        return 'THE HOST LEFT';
    if(why.indexOf('host ended') >= 0)       return 'THE HOST ENDED IT';
    if(why.indexOf('everyone left') >= 0)    return 'EVERYONE LEFT';
    if(why.indexOf('operator') >= 0)         return 'ENDED BY THE OPERATOR';
    return 'TOURNAMENT ABANDONED';
}
async function tourneyJoin(arg){
    if(_tt || _ttUi.busy) return;
    if(!netTourneyOk()){ _ttMsg('TOURNAMENTS NEED A NEWER SERVER', true); return; }
    const by = /^[0-9a-f]{32}$/i.test(String(arg)) ? { tid:String(arg) } : { code:String(arg).toUpperCase() };
    _ttUi.busy = true; _ttMsg('JOINING...');
    const r = await _ttPost('join', by);
    _ttUi.busy = false;
    if(!r.json){
        if(r.status === 404)      _ttMsg('NO SUCH TOURNAMENT', true);
        else if(r.status === 409) _ttMsg(/full/i.test(r.err || '') ? 'TOURNAMENT IS FULL' : 'ALREADY STARTED', true);
        else _ttMsg('COULD NOT JOIN', true);
        return;
    }
    _ttAdopt(r.json);
    _ttUi.sel = -1; _ttMsg('JOINED');
    _ttSync();
}
async function tourneyStart(){
    if(!_tt || _ttUi.busy || _tt.host !== getPlayerId()) return;
    _ttUi.busy = true; _ttMsg('STARTING...');
    const r = await _ttPost('start', { tid:_tt.tid });
    _ttUi.busy = false;
    if(!r.json){
        if(r.status === 409) _ttMsg(/need/i.test(r.err || '') ? 'NEED 2 PLAYERS' : 'ALREADY STARTED', true);
        else _ttMsg('COULD NOT START', true);
        return;
    }
    _ttSync();
}
// The break between rounds ends when the HOST says so, and only then: everybody else reads
// the board until a roles sheet or the server's own deadline takes it away. That is why a
// client which never implements this still works -- it simply waits the deadline out.
async function tourneyContinue(){
    if(!_tt || !_tt.brk || _ttUi.busy) return;
    if(String(_tt.brk.host || '') !== getPlayerId()) return;
    if(_msgNow() < _ttUi.contAt) return;
    _ttUi.busy = true;
    const r = await _ttPost('continue', { tid:_tt.tid });
    _ttUi.busy = false;
    if(!_tt || !_tt.brk) return;                 // the deadline cleared it while we asked
    if(!r.json){
        // Too early is not a mistake anybody made -- the board has simply not been up long
        // enough yet -- so it re-arms the wait and says nothing. An error message for
        // pressing too soon reads as a broken button.
        if(r.status === 409){
            _ttUi.contAt = _msgNow() + Math.max(250, (+((r.body && r.body.retry_ms) || 0)) || 500);
            _uiDirty = true; return;
        }
        _ttMsg(r.status === 403 ? 'THE HOST STARTS THE NEXT ROUND' : 'COULD NOT CONTINUE', true);
        return;
    }
    _ttSetBreak(null);   // what happens now is an ordinary roles sheet
    Snd.sfxPlay('select', cfg.music);
    _ttSync();
}
// Leaving mid-tournament drops back to the lobby list, where there is something else to do;
// leaving the lobby ITSELF has nothing to stay for, so that caller names where it goes.
async function tourneyLeave(to){
    if(!_tt) return;
    const tid = _tt.tid;
    _ttDrop('');
    tourneyLand(to || tourneyHome('tourneyLobby')); _ttUi.sel = -1;
    Snd.sfxPlay('nav', cfg.music);
    await _ttPost('leave', { tid });
}

// Leaving is only ever free for a guest in a lobby that has not started: nobody else has
// spent anything on it yet. Every other exit takes something off other people -- the host's
// takes the entire tournament, a player's mid-run hands away matches that were going to be
// played -- and an exit that costs other people something is asked about first.
function tourneyAsk(to){
    if(!_tt) return;
    if(_tt.host !== getPlayerId() && _tt.state === 'open'){ tourneyLeave(to); return; }
    _ttUi.from = _TT_PHASES[_ttFace()] ? _ttFace() : 'tourneyLobby';
    _ttUi.to = to || '';
    quitConfirmSel = 1;                                // NO: the safe answer is the offered one
    phase = 'tourneyQuit';
    Snd.sfxPlay('nav', cfg.music);
    _uiDirty = true;
}

// ---- the row model the lobby screen and its input share ------------------------------
// A row that is a VALUE rather than a command, in the shape every multi-value SETTINGS row
// already has: A cycles it forward, LEFT and RIGHT dial it either way. cur is the current
// choice as an index into n of them, put() takes the new one. gap asks the screen for a
// blank line above the row -- a break in the list, never a row of its own.
function _ttDial(t, cur, n, put, gap){
    return { t:t, en:true, gap:!!gap,
             adj:(right) => { put(((cur | 0) + (right ? 1 : n - 1)) % n); _uiDirty = true; },
             act:() => { put(((cur | 0) + 1) % n); Snd.sfxPlay('select', cfg.music); _uiDirty = true; } };
}
// One list, two readers: drawTourneyLobby paints it and UI_INPUT.tourneyLobby dispatches
// it, so a row can never be drawn in one place and acted on in another.
function tourneyRows(){
    const rows = [];
    if(phase === 'tourneySetup'){
        // The press this screen exists for, on the row the screen opens on: every setting
        // under it has a working default, so a host who wants an ordinary tournament presses
        // A twice and is in a room. The blank line below it is what keeps the settings from
        // reading as more of the command -- and the command from being fallen into while
        // dialling one. The label names what the row does, so it takes no note: a note is
        // drawn at a fixed x and a row this long runs straight through that column.
        rows.push({ t:'CREATE TOURNAMENT', en:netTourneyOk() && !_ttUi.busy,
                    act:() => tourneyCreate(_ttUi.stakes, _ttUi.lvl, _ttUi.speed) });
        // What a tournament is played FOR, before there is one.
        rows.push(_ttDial('ITEM STAKES (WINDSWEPPING): ' + (_ttUi.stakes ? 'ON' : 'OFF'),
                          _ttUi.stakes ? 1 : 0, 2, v => { _ttUi.stakes = !!v; }, true));
        // The level round 1 is played at. Every round after it is one deeper, so this is the
        // floor of the whole ladder, not just of the first match -- which is what the summary
        // band under the rows spells out.
        rows.push(_ttDial('START LEVEL: ' + _duelLvl(_ttUi.lvl),
                          _duelLvl(_ttUi.lvl) - 1, MAX_LEVELS, v => { _ttUi.lvl = v + 1; }));
        // Speed and the start level are independent on purpose: a speed tournament runs every
        // round at the top pace whatever level it is played on, so the two dials combine
        // freely. Fixed at create, like the stakes -- there is no turning it on later.
        rows.push(_ttDial('SPEED TOURNAMENT: ' + (_ttUi.speed ? 'ON' : 'OFF'),
                          _ttUi.speed ? 1 : 0, 2, v => { _ttUi.speed = !!v; }));
        rows.push({ t:'BACK', en:true, act:() => { tourneyGoHome('tourneyLobby'); Snd.sfxPlay('nav', cfg.music); _uiDirty = true; } });
        return rows;
    }
    if(!_tt){
        const ok = netTourneyOk();
        // The way back is the FIRST row when there is one: a player who dropped out of a
        // running bracket is not here to start a second tournament, and their opponents are
        // waiting on a walkover clock while they read the list.
        if(_ttBack) rows.push({ t:'REJOIN TOURNAMENT', en:ok,
                                note:String(_ttBack.code || ''), act:tourneyRejoin });
        rows.push({ t:'CREATE TOURNAMENT', en:ok, act:tourneySetupOpen });
        // scanStart() rides the keypress/tap: a camera permission prompt is only allowed to
        // appear inside a user gesture, exactly as ADD FRIEND opens its own.
        rows.push({ t:'JOIN BY CODE', en:ok, act:() => { _entryOpen('tcode'); scanStart(); } });
        // A lobby is a ROOM SOMEBODY IS IN, not a command: it carries the same three things a
        // roster row does -- who, which id, how many -- in the same three columns, so the list
        // of rooms below reads as a different KIND of thing from the actions above it. The
        // name is the column that does that work, which is why it is a field of its own rather
        // than more text in the label.
        for(const l of tourneyLobbyList().slice(0, 6)){
            const n = l.players | 0, mx = l.max | 0;
            // A lobby carrying an eid is an EVENT's, and it reached this list at all
            // only because we are in that event -- the server serves it to members
            // regardless of network and to nobody else. Marked rather than hidden:
            // the room it belongs to is why it is here.
            rows.push({ t:String(l.code || ''), name:String(l.host_name || '?').toUpperCase(),
                        note:(l.eid ? 'EVENT  ' : '') + n + '/' + mx,
                        en:ok && n < mx, act:() => tourneyJoin(l.tid || l.code) });
        }
    } else if(_tt.state === 'open'){
        const host = _tt.host === getPlayerId(), n = (_tt.players || []).length;
        // START is the top row and therefore the pre-selected one for the HOST (sel is 0 on
        // entry): it is the thing they are waiting to do, and the one press that should never
        // need a journey down a list. Showing the code is what you do WHILE waiting for it.
        // A guest sees the same row, dark, saying whose press the room is waiting on -- one
        // lobby screen instead of two, with SHOW JOIN CODE in the one place on both. `nosel`
        // is what keeps a guest's lobby from opening under the cursor: the row it would open
        // on is the one row on the screen that is not theirs to press.
        rows.push({ t:'START TOURNAMENT', en:host && n >= 2, nosel:!host,
                    note:host ? (n < 2 ? '(NEED 2)' : '') : 'HOST ONLY', act:tourneyStart });
        // Anyone in the room can hand the code on, not just the host: the person standing
        // next to the newcomer is the one who ends up showing it to them.
        rows.push({ t:'SHOW JOIN CODE', en:true,
                    act:() => { phase = 'tourneyCode'; Snd.sfxPlay('select', cfg.music); _uiDirty = true; } });
    } else if(_tt.state === 'done'){
        // Nothing to leave: the tournament is over and the row just lets go of the picture.
        // Acknowledging it and stepping off it are the same press, so they are one row -- and
        // it is the one exit that IS pre-selected, because there is nothing left to lose by
        // pressing it and nobody still playing behind it.
        rows.push({ t:'DONE', en:true, act:() => { _ttDrop(''); tourneyGoHome(); Snd.sfxPlay('nav', cfg.music); } });
    } else {
        // A board opened from a ceremony has to lead back to it. ESC off the ceremony is how
        // a spectator gets here -- reading the standings while the match they are watching is
        // being set up -- and without this row the only way off the board again is the one
        // that leaves the tournament. It is the FIRST row and so the pre-selected one: it is
        // the only row here that costs nobody anything, and it is the press the person who
        // just pressed ESC is going to make next. It exists only while there IS a ceremony
        // behind it: a sheet naming this device, for a node not finished on this side.
        if(!inGame && _tt.roles && String(_tt.roles.you || 'idle') !== 'idle'
           && _ttDone !== String(_tt.roles.nid || ''))
            rows.push({ t:_tt.roles.you === 'spectate' ? 'WATCH THE MATCH' : 'GO TO YOUR MATCH',
                        en:true, act:() => { _ttGo('tourneyCeremony'); Snd.sfxPlay('nav', cfg.music); } });
        // The one row a whole field is waiting on. It belongs to the host and only while a
        // break is open, and it stays dark until the server will accept it: an early press
        // is refused, and a button that refuses looks like a broken one.
        const b = _tt.brk;
        if(b && String(b.host || '') === getPlayerId()){
            const left = Math.max(0, _ttUi.contAt - _msgNow());
            rows.push({ t:'CONTINUE', en:!left && !_ttUi.busy,
                        note:left ? (Math.ceil(left / 1000) + 'S') : '', act:tourneyContinue });
        }
        // While a bracket is RUNNING there is no such thing as stepping off it and staying in
        // it, so the exit and the way back are one row, at the height every screen keeps its
        // way out. The host's exit is not a leave either, it is an ending, and the row says
        // the whole of it. `nosel` is what keeps it from opening under the cursor: this row
        // arrives the instant a match ends, which is the instant a player is still pressing A.
        rows.push(_tt.host === getPlayerId()
            ? { t:'BACK - END TOURNAMENT FOR ALL', en:true, nosel:true, act:() => tourneyAsk() }
            : { t:'BACK - LEAVE TOURNAMENT', en:true, nosel:true, act:() => tourneyAsk() });
    }
    // Every tournament screen ends on ONE way out, drawn at the height BACK is drawn at
    // everywhere else -- the two screens above have already pushed theirs. On an OPEN lobby it
    // says what leaving actually costs: a lobby you walk away from is a lobby other people are
    // still sitting in, waiting for a start that is never coming, so walking away IS cancelling
    // it. Off a tournament altogether, BACK is just BACK.
    if(!_tt) rows.push({ t:'BACK', en:true, act:() => { tourneyGoHome(); Snd.sfxPlay('nav', cfg.music); } });
    else if(_tt.state === 'open')
        rows.push({ t:_tt.host === getPlayerId() ? 'BACK - CANCEL TOURNAMENT' : 'BACK - LEAVE TOURNAMENT',
                    en:true, act:() => tourneyAsk(tourneyHome()) });
    return rows;
}
