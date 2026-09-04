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
const TT_STATE_MS   = 5000;    // floor between unforced state() read-backs
const TT_OVER_MS    = 4000;    // how long the duelOver banner holds before the next match
const TT_CONNECT_MS = 20000;   // a ceremony that has not become a match by now re-offers
const TT_CONNECT_TRIES = 4;
const TT_MSG_MS     = 6000;

// The whole client-side picture, or null when we hold no tournament. Every field in it
// came from the server; nothing here is derived except the match-count arithmetic the
// lobby shows, which is the server's own formula quoted back at the player.
var _tt = null;
var _ttUi = { sel:0, msg:'', msgAt:0, stakes:false, busy:false };
var _ttPend = null;    // a roles sheet waiting for the previous match to leave the screen
var _ttNid  = '';      // the node we are currently engaged with
var _ttRep  = null;    // the pending result report {body, at, tries}
var _ttRepBusy = false, _ttRepDone = false;
var _ttWant = null;    // the match parameters an inbound answer must be dressed with
var _ttOverAt = 0, _ttCerAt = 0, _ttTry = 0;
var _ttStateAt = 0, _ttT = null;

const _TT_PHASES = { tourneyLobby:1, tourneyBracket:1, tourneyCeremony:1, tourneyPodium:1 };

// ---- small helpers -------------------------------------------------------------------
function tourneyActive(){ return !!_tt; }
function tourneyView(){ return _tt; }
function tourneyUi(){ return _ttUi; }
function tourneyMax(){ return _tt && _tt.max ? (_tt.max|0) : TT_MAX; }
// Round 1 is SPARSE above four players: every pair up to 4, then the two circulant
// offsets, which is 2N matches. The lobby quotes this so nobody starts an eight-player
// tournament expecting 28 games.
function _ttMatches(n){ n = n|0; return n < 2 ? 0 : (n <= 4 ? n * (n - 1) / 2 : 2 * n); }
// The gate on the whole feature: tournaments need a 4.1 server. An older one answers 404
// to tournament.php and never sends a roles sheet, so the menu row stays grey.
function netTourneyOk(){
    return _netOk() && typeof netSrvMinor === 'function' && netSrvMinor() >= 1;
}
function _ttMsg(m, bad){
    _ttUi.msg = m || ''; _ttUi.msgAt = _msgNow(); _uiDirty = true;
    if(m) Snd.sfxPlay(bad ? 'fail' : 'select', cfg.music);
}
function _ttName(id){
    id = String(id || '');
    if(!id) return '';
    if(id === getPlayerId()) return 'YOU';
    if(_tt){
        for(const p of (_tt.players || [])) if(p && p.id === id) return String(p.name || '').toUpperCase() || fmtFriendId(id);
        const nm = _tt.roles && _tt.roles.names;
        if(nm && nm[id]) return String(nm[id]).toUpperCase();
    }
    return (typeof netFriendName === 'function' && netFriendName(id)) ? String(netFriendName(id)).toUpperCase() : fmtFriendId(id);
}
// Where _duelExit / _netSessionEnd should land while a tournament is held: back to the
// picture, never to the 1:1 menu. '' means "not ours, keep your default".
function tourneyExitPhase(){
    if(!_tt) return '';
    return _tt.state === 'done' ? 'tourneyPodium' : 'tourneyBracket';
}
async function _ttPost(action, extra){
    const body = Object.assign({ id: getPlayerId(), action }, extra || {});
    return await _netPostRes('/api/tournament.php', body);
}
function _ttArm(){ if(!_ttT && typeof setInterval === 'function') _ttT = setInterval(_ttTick, TT_TICK_MS); }
function _ttDisarm(){ if(_ttT){ clearInterval(_ttT); _ttT = null; } }

// ---- holding the server's picture ----------------------------------------------------
// Every response and every event is the same shape seen from a different distance, so one
// merge takes all of them. Absent keys are left alone: a lobby event says nothing about a
// bracket and must not erase one.
function _ttAdopt(o){
    if(!o || !o.tid) return;
    const tid = String(o.tid);
    if(!_tt || _tt.tid !== tid)
        _tt = { tid, code:'', host:'', state:'open', stakes:false, max:TT_MAX, players:[],
                round:0, cursor:null, schedule:[], bracket:[], standings:[], advancers:[],
                roles:null, you:'idle', podium:null, frozen:'', reason:'' };
    const t = _tt;
    if(o.code   != null) t.code   = String(o.code).toUpperCase();
    if(o.host   != null) t.host   = String(o.host);
    if(o.state  != null) t.state  = String(o.state);
    if(o.stakes != null) t.stakes = !!o.stakes;
    if(o.max    != null) t.max    = o.max | 0;
    if(o.round  != null) t.round  = o.round | 0;
    if(o.reason != null) t.reason = String(o.reason);
    if(o.cursor !== undefined) t.cursor = o.cursor ? String(o.cursor) : null;
    if(Array.isArray(o.players))   t.players   = o.players;
    if(Array.isArray(o.schedule))  t.schedule  = o.schedule;
    if(Array.isArray(o.bracket))   t.bracket   = o.bracket;
    if(Array.isArray(o.standings)) t.standings = o.standings;
    _ttArm(); _uiDirty = true;
}
async function _ttSync(force){
    if(!_tt) return;
    const now = _msgNow();
    if(!force && now - _ttStateAt < TT_STATE_MS) return;
    _ttStateAt = now;
    const tid = _tt.tid;
    const r = await _ttPost('state', { tid });
    if(!_tt || _tt.tid !== tid) return;            // we left while it was in flight
    if(!r.json){
        if(r.status === 404) _ttDrop('TOURNAMENT GONE');
        return;
    }
    _ttAdopt(r.json);
    if(r.json.roles){
        const sheet = r.json.roles;
        if(!sheet.tid) sheet.tid = tid;
        _ttRoles(sheet);
    } else if(!r.json.cursor){
        _ttNid = ''; _ttPend = null;               // between nodes: nothing to be engaged with
    }
    if(_tt.state === 'done' && _TT_PHASES[phase] && phase !== 'tourneyPodium') phase = 'tourneyPodium';
}
function _ttDrop(msg){
    _tt = null; _ttPend = null; _ttNid = ''; _ttRep = null; _ttWant = null;
    _ttOverAt = 0; _ttCerAt = 0; _ttTry = 0; _ttRepDone = false;
    if(typeof specNode === 'function') specNode('', '');
    if(typeof specGrant === 'function') specGrant([]);
    _ttDisarm();
    _ttUi.sel = 0;
    if(_TT_PHASES[phase]) phase = 'tourneyLobby';
    if(msg) _ttMsg(msg, true); else _uiDirty = true;
}

// ---- the signal dispatcher -----------------------------------------------------------
// `tourney` is a RESERVED server-generated signal type: the sender is the server itself,
// so these arrive without a player id and are the only signals we trust unauthenticated.
function _ttOnSignal(d){
    if(!d || typeof d !== 'object') return;
    const ev = String(d.event || ''), tid = String(d.tid || '');
    if(!ev || !tid) return;
    // Not our tournament: it is either an echo from one we left or a mix-up. Either way we
    // render what state() says, and state() is only worth asking about the one we hold.
    if(!_tt || _tt.tid !== tid) return;
    switch(ev){
        case 'lobby':
            _ttAdopt(d);
            if(_tt.state === 'abandoned') _ttDrop('TOURNAMENT ABANDONED');
            break;
        case 'roles':       _ttRoles(d); break;
        case 'roles-patch': _ttPatch(d); break;
        case 'standings':
            _tt.standings = d.rows || [];
            _tt.advancers = d.advancers || [];
            if(_TT_PHASES[phase] && phase !== 'tourneyPodium') phase = 'tourneyBracket';
            _ttSync(true);
            break;
        case 'result':
            // The node is settled: whatever we still owed on it is owed no longer.
            if(_ttRep && _ttRep.body.nid === String(d.nid || '')) _ttRep = null;
            _tt.last = { nid:String(d.nid || ''), winner:d.winner || null, draw:!!d.draw, score:d.score || null };
            _ttSync(true);
            break;
        case 'freeze':
            _tt.frozen = String(d.nid || '');
            _ttMsg('MATCH FROZEN - RESULTS DISAGREED', true);
            _ttSync(true);
            break;
        case 'over':
            _tt.state = 'done'; _tt.podium = d.podium || [];
            _ttNid = ''; _ttPend = null;
            if(!inGame) phase = 'tourneyPodium';
            _uiDirty = true;
            break;
        default: _ttSync(true);   // an event a newer server knows and we do not
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
    if(_tt.state === 'open') _tt.state = 'running';
    // The sheet is the introduction. Everyone on it may connect to us for this node --
    // players, primaries and secondaries alike -- so a spectator link needs no friendship
    // and no invite, exactly as the server's signal gating allows.
    if(typeof specGrant === 'function') specGrant([].concat(d.players || [], d.primaries || [], d.secondaries || []));
    if(typeof specNode === 'function') specNode(_tt.tid, nid);
    _uiDirty = true;
    if(_ttNid === nid) return;   // the same node again (a state re-read, a repeat delivery)
    _ttNid = nid; _ttRepDone = false; _ttTry = 0; _tt.frozen = '';
    _ttPend = d;                 // engaged by _ttTick, once the previous match is off the board
    if(_tt.you !== 'idle' && !inGame){ phase = 'tourneyCeremony'; _ttCerAt = _msgNow(); }
    _ttArm();
}
// A re-deal of the CURRENT node's tree (a primary stood down, a secondary was orphaned).
// Roles patches never move the bracket, so they only ever touch the spectator wiring.
function _ttPatch(d){
    if(!_tt || !_tt.roles || String(d.nid || '') !== _ttNid) return;
    const r = _tt.roles;
    r.primaries   = d.primaries   || [];
    r.secondaries = d.secondaries || [];
    if(typeof specGrant === 'function') specGrant([].concat(r.players || [], r.primaries, r.secondaries));
    // Re-source only if the tree moved US. net-spec repairs a dead link on its own and a
    // patch must never yank a healthy feed out from under a running sim.
    if(_tt.you === 'spectate' && typeof netSpectating === 'function' && netSpectating()
       && typeof netSpecFeedAge === 'function' && netSpecFeedAge() > SPEC_SILENCE_MS)
        _ttEngage(r);
    _uiDirty = true;
}
// Turn the sheet into a connection. Deferred out of _ttRoles because _netRtcOffer refuses
// while a game is on: the previous match has to be off the board first.
function _ttEngage(d){
    const me = getPlayerId(), you = String(d.you || 'idle');
    if(you === 'play'){
        const ps = (d.players || []).map(String);
        const peer = ps[0] === me ? ps[1] : ps[0];
        if(!/^[0-9a-f]{8}$/.test(String(peer || ''))){ _ttFail('BAD MATCH SHEET'); return; }
        _ttWant = { peer, hearts:_duelHearts(d.hm), stakes:!!d.stakes };
        netP2POnlySet(true);   // a tournament match is direct or nothing
        // players[0] is the feeder and the feeder is always the offerer, so the two sides
        // never both offer. This is the quick-match path verbatim -- an offer needs no
        // friendship, which is exactly why strangers can be drawn against each other.
        if(String(d.feeder) === me) _netRtcOffer(peer);
        return;
    }
    if(you === 'spectate'){
        if(typeof specWatch !== 'function') return;
        const pr = (d.primaries || []).map(String);
        if(pr.indexOf(me) >= 0){ specWatch(String(d.feeder), _tt.tid, d.nid); return; }
        // A secondary asks BOTH primaries: one answers with the feed, the other is held
        // open and silent, so a failover costs a flag instead of a connect (net-spec.js).
        const src = pr.length ? pr : [String(d.feeder)];
        for(const p of src.slice(0, SPEC_MAX_DIRECT)) specWatch(p, _tt.tid, d.nid);
    }
}
function _ttFail(msg){
    _ttPend = null; _ttCerAt = 0; _ttWant = null;
    netP2POnlySet(false);
    if(_TT_PHASES[phase]) phase = _tt ? tourneyExitPhase() : 'tourneyLobby';
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
    const r = await _netPostRes('/api/tournament.php', _ttRep.body);
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
    if(_tt.you !== 'play' || _ttRepDone) return;
    _ttRepDone = true;
    const my = (typeof netMyIndex === 'function') ? netMyIndex() : 0;
    const ps = (typeof players !== 'undefined' && players) ? players : null;
    const sc = ps ? [ps[my].score | 0, ps[1 - my].score | 0] : [0, 0];
    const w  = (typeof duelWinner !== 'undefined') ? duelWinner : -1;
    _ttReport(_ttNid, w === 2 ? 'draw' : (w === my ? 'win' : 'loss'), sc);
}
// Called when a player walks out of a tournament match before it ended. Leaving is losing,
// and a reported loss settles at once -- far kinder to the eight people waiting than the
// three-minute walkover ladder. Nobody lies to lose.
function tourneyMatchLeft(){
    if(!_tt || !inGame || _tt.you !== 'play' || _ttRepDone || !_ttNid) return;
    _ttRepDone = true;
    const my = (typeof netMyIndex === 'function') ? netMyIndex() : 0;
    const ps = (typeof players !== 'undefined' && players) ? players : null;
    _ttReport(_ttNid, 'loss', ps ? [ps[my].score | 0, ps[1 - my].score | 0] : [0, 0]);
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
    _ttOverAt = 0; _ttWant = null;
    netP2POnlySet(false);
    if(typeof netSpectating === 'function' && netSpectating() && typeof specStop === 'function') specStop('');
    if(typeof _duelExit === 'function') _duelExit();   // lands on tourneyExitPhase()
    else if(_tt) phase = tourneyExitPhase();
}
function _ttTick(){
    if(!_tt){ _ttDisarm(); return; }
    const now = _msgNow();
    _ttFlushRep();
    if(_ttUi.msg && now - _ttUi.msgAt > TT_MSG_MS){ _ttUi.msg = ''; _uiDirty = true; }
    // A finished match must be OFF the board before the next one can be set up. The banner
    // still gets its moment -- unless the next sheet is already waiting, in which case the
    // tournament is what the player wants to be looking at.
    if(inGame && _ttOverAt && (_ttPend || now - _ttOverAt > TT_OVER_MS)) _ttClearMatch();
    if(_ttPend && !inGame){
        const d = _ttPend; _ttPend = null;
        // A sheet that landed while the last match was still on screen never got its
        // ceremony -- _ttRoles will not take the screen away from a live game. The board is
        // clear now, so it gets one here instead: nobody is dropped into a duel cold.
        if(String(d.you || 'idle') !== 'idle' && phase !== 'tourneyCeremony'){
            phase = 'tourneyCeremony'; _ttCerAt = now; _uiDirty = true;
        }
        _ttEngage(d);
    }
    // A ceremony that never became a match: the offer was lost, or the peer is slow to
    // arrive. Re-offer a few times before handing it back to the server's walkover ladder,
    // which is the only thing entitled to decide that somebody did not show up.
    if(phase === 'tourneyCeremony' && !inGame && !_ttPend && _ttCerAt && now - _ttCerAt > TT_CONNECT_MS){
        if(++_ttTry >= TT_CONNECT_TRIES) _ttFail('MATCH DID NOT CONNECT');
        else { _ttCerAt = now; _ttPend = _tt.roles; }
    }
    if(_tt.state === 'running' && !inGame) _ttSync();
}

// ---- lobby actions -------------------------------------------------------------------
function tourneyEnter(){
    _ttUi.sel = 0; _ttUi.msg = '';
    if(typeof _netHello === 'function' && _netOk()) _netHello();   // picks up the tourneys list
    if(_tt) _ttSync(true);
    _uiDirty = true;
}
function tourneyLobbyList(){ return (typeof _netTourneys !== 'undefined' && _netTourneys) ? _netTourneys : []; }
async function tourneyCreate(stakes){
    if(_tt || _ttUi.busy) return;
    if(!netTourneyOk()){ _ttMsg('TOURNAMENTS NEED A NEWER SERVER', true); return; }
    _ttUi.busy = true; _ttMsg('CREATING...');
    const r = await _ttPost('create', { stakes: !!stakes });
    _ttUi.busy = false;
    if(!r.json){
        if(r.status === 429) _ttMsg('TOO SOON - WAIT ' + Math.max(1, Math.ceil(+((r.body && r.body.retry_after) || 60))) + 'S', true);
        else if(r.status === 409) _ttMsg('YOU ALREADY HOST ONE', true);
        else _ttMsg('COULD NOT CREATE', true);
        return;
    }
    _ttAdopt(Object.assign({ host:getPlayerId(), state:'open' }, r.json));
    _ttUi.sel = 0;
    _ttMsg('CODE ' + (_tt ? _tt.code : ''));
    _ttSync(true);
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
    _ttUi.sel = 0; _ttMsg('JOINED');
    _ttSync(true);
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
    _ttSync(true);
}
async function tourneyLeave(){
    if(!_tt) return;
    const tid = _tt.tid;
    _ttDrop('');
    phase = 'tourneyLobby'; _ttUi.sel = 0;
    Snd.sfxPlay('nav', cfg.music);
    await _ttPost('leave', { tid });
}

// ---- the row model the lobby screen and its input share ------------------------------
// One list, two readers: drawTourneyLobby paints it and UI_INPUT.tourneyLobby dispatches
// it, so a row can never be drawn in one place and acted on in another.
function tourneyRows(){
    const rows = [];
    if(!_tt){
        const ok = netTourneyOk();
        rows.push({ t:'CREATE TOURNAMENT', en:ok, act:() => tourneyCreate(_ttUi.stakes) });
        rows.push({ t:'ITEM STAKES: ' + (_ttUi.stakes ? 'ON' : 'OFF'), en:ok, lr:true,
                    note:_ttUi.stakes ? '(ITEMS CHANGE HANDS)' : '(FOR FUN)',
                    act:() => { _ttUi.stakes = !_ttUi.stakes; Snd.sfxPlay('nav', cfg.music); _uiDirty = true; } });
        rows.push({ t:'JOIN BY CODE', en:ok, act:() => _entryOpen('tcode') });
        for(const l of tourneyLobbyList().slice(0, 6)){
            const n = l.players | 0, mx = l.max | 0;
            rows.push({ t:String(l.code || '') + '  ' + String(l.host_name || '?').toUpperCase(),
                        note:n + '/' + mx, en:ok && n < mx, act:() => tourneyJoin(l.tid || l.code) });
        }
    } else if(_tt.state === 'open'){
        const host = _tt.host === getPlayerId(), n = (_tt.players || []).length;
        if(host) rows.push({ t:'START TOURNAMENT', en:n >= 2, note:n < 2 ? '(NEED 2)' : '', act:tourneyStart });
        rows.push({ t:host ? 'CANCEL TOURNAMENT' : 'LEAVE TOURNAMENT', en:true, act:tourneyLeave });
    } else if(_tt.state === 'done'){
        // Nothing to leave: the tournament is over and the row just lets go of the picture.
        rows.push({ t:'DONE', en:true, act:() => { _ttDrop(''); phase = 'duelMenu'; Snd.sfxPlay('nav', cfg.music); } });
    } else {
        rows.push({ t:'LEAVE TOURNAMENT', en:true, act:tourneyLeave });
    }
    rows.push({ t:'BACK', en:true, act:() => { phase = 'duelMenu'; Snd.sfxPlay('nav', cfg.music); } });
    return rows;
}
