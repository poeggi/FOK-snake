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
// `contAt` is on OUR clock, the same one every other deadline in this file is on: the round
// board's own `at` is a stamp from the server's clock, which this screen has no offset to
// read, while `wait` is a duration and needs none.
var _ttUi = { sel:0, msg:'', msgAt:0, stakes:false, busy:false, contAt:0 };
var _ttPend = null;    // a roles sheet waiting for the previous match to leave the screen
var _ttNid  = '';      // the node we are currently engaged with
var _ttRep  = null;    // the pending result report {body, at, tries}
var _ttRepBusy = false, _ttRepDone = false;
var _ttWant = null;    // the match parameters an inbound answer must be dressed with
// The node whose match is ON THE BOARD, which is NOT _ttNid: the server deals the next node
// the moment a result settles, so from then until the finished match leaves the screen the
// two name different matches. Everything about the match being played -- what a result is
// reported against, whether walking out still owes one -- hangs off this one.
var _ttPlayNid = '';
var _ttOffer = null;   // an offer that landed while the previous match still held the board
var _ttOverAt = 0, _ttCerAt = 0, _ttTry = 0;
var _ttStateAt = 0, _ttT = null;

const _TT_PHASES = { tourneyLobby:1, tourneyBracket:1, tourneyRound:1, tourneyCeremony:1, tourneyPodium:1 };

// ---- small helpers -------------------------------------------------------------------
function tourneyActive(){ return !!_tt; }
function tourneyView(){ return _tt; }
function tourneyUi(){ return _ttUi; }
// The scoreboard between two rounds, or null when no break is open. It is a whole picture
// in itself -- one row per participant, already ordered and already cut -- so it is handed
// to the screen as it arrived rather than folded into the standings it partly repeats.
function tourneyBreak(){ return (_tt && _tt.brk) || null; }
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
    if(_tt.state === 'done') return 'tourneyPodium';
    return _tt.brk ? 'tourneyRound' : 'tourneyBracket';
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
                roles:null, brk:null, you:'idle', podium:null, frozen:'', reason:'' };
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
    // The board is DERIVED on every state read, so an absent key means "this reply does not
    // talk about breaks" (a lobby event) while an explicit null means "no break is open" --
    // and that null is the only thing that ever takes the board down without a roles sheet.
    if(o['break'] !== undefined) _ttSetBreak(o['break'] || null);
    _ttArm(); _uiDirty = true;
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
    if(!same) _ttUi.contAt = _msgNow() + Math.max(0, b.wait | 0);
    // A break we did not already have takes the screen -- from an event or from a state read
    // alike, which is what makes the round screen survive a missed signal or a reload.
    if(!same && !inGame && _TT_PHASES[phase] && phase !== 'tourneyPodium') phase = 'tourneyRound';
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
    _ttPlayNid = ''; _ttOffer = null;
    _ttOverAt = 0; _ttCerAt = 0; _ttTry = 0; _ttRepDone = false;
    if(typeof specNode === 'function') specNode('', '');
    if(typeof specGrant === 'function') specGrant([]);
    _ttDisarm();
    _ttUi.sel = 0; _ttUi.contAt = 0;
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
            // A break may already be up: the two events describe the same moment from
            // different distances, and whichever lands second must not undo the other.
            if(_TT_PHASES[phase] && phase !== 'tourneyPodium' && phase !== 'tourneyRound') phase = 'tourneyBracket';
            _ttSync(true);
            break;
        case 'round':
            // A round ended and the next one waits on the host. The rows arrive one per
            // participant, already ordered as an elimination ladder and already marked with
            // who is through, so they are stored whole and drawn as they stand.
            _ttSetBreak(d);
            if(Array.isArray(d.advancers)) _tt.advancers = d.advancers;
            _tt.round = d.next | 0; _tt.cursor = null;
            _uiDirty = true;
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
            _ttNid = ''; _ttPend = null; _ttOffer = null;
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
    // A sheet is how a break ends: the next match is dealt. Clearing it here rather than
    // waiting for the state read-back is what takes the scoreboard off the screen in time
    // for the ceremony -- and for a player with nothing to do, back to the bracket.
    if(_tt.brk) _ttSetBreak(null);
    if(_tt.state === 'open') _tt.state = 'running';
    // The sheet is the introduction. Everyone on it may connect to us for this node --
    // players, primaries and secondaries alike -- so a spectator link needs no friendship
    // and no invite, exactly as the server's signal gating allows.
    if(typeof specGrant === 'function') specGrant([].concat(d.players || [], d.primaries || [], d.secondaries || []));
    if(typeof specNode === 'function') specNode(_tt.tid, nid);
    _uiDirty = true;
    if(_ttNid === nid) return;   // the same node again (a state re-read, a repeat delivery)
    // _ttRepDone deliberately stays as it is: it belongs to the match on the BOARD, and this
    // sheet is for the next one. Clearing it here hands a player still on the over screen a
    // fresh debt, which leaving that match then pays with a forfeit of the node just dealt.
    _ttNid = nid; _ttTry = 0; _tt.frozen = ''; _ttOffer = null;
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
    _ttPlayNid = '';
    if(you === 'play'){
        const ps = (d.players || []).map(String);
        const peer = ps[0] === me ? ps[1] : ps[0];
        if(!/^[0-9a-f]{8}$/.test(String(peer || ''))){ _ttFail('BAD MATCH SHEET'); return; }
        // The round ladder: round 1 is level 1 and every round after it one deeper, capped
        // at the game's last level. The sheet says which, and _duelLvl refuses anything that
        // is not a level this build has.
        _ttWant = { peer, hearts:_duelHearts(d.hm), stakes:!!d.stakes, lvl:_duelLvl(d.lvl) };
        _ttPlayNid = String(d.nid || ''); _ttRepDone = false;   // this node's match owns the board now
        netP2POnlySet(true);   // a tournament match is direct or nothing
        // _netMkSess is not the only moment a session can need dressing. Engagement is
        // deferred (the previous match has to be off the board first), and the feeder offers
        // the instant IT engages -- so a sheet and the offer it authorises can be handled in
        // the same signal drain, the offer answered and the session minted before this runs.
        // Dress that session here too: the go repairs hearts and stakes on its own, but only
        // a preset can refuse a wrong one, and p2p-only has no wire representation at all.
        if(typeof _netSess !== 'undefined' && _netSess) tourneyDressSession(_netSess);
        // players[0] is the feeder and the feeder is always the offerer, so the two sides
        // never both offer. This is the quick-match path verbatim -- an offer needs no
        // friendship, which is exactly why strangers can be drawn against each other.
        if(String(d.feeder) === me){ _netRtcOffer(peer); return; }
        // The offer may already have been made, and refused, while the previous match was
        // still on our board -- see tourneyParkOffer. Signals are one-shot, so this is the
        // only copy of it there will ever be until the feeder's ladder offers again.
        if(_ttOffer && _ttOffer.peer === peer && typeof _netRtcAnswer === 'function'){
            const o = _ttOffer; _ttOffer = null;
            _netRtcAnswer(peer, o.od);
        }
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
// net-session hands us an offer it is about to refuse because a game is still on. A
// tournament deals the next match the instant the last result settles, and the feeder offers
// the instant IT engages -- while the peer it is offering to may still be looking at the over
// screen of the match before. Refusing that offer loses it for good (signals are one-shot)
// and the answerer then sits out the whole ceremony waiting for one that was already
// delivered. Keep it instead; _ttEngage answers it as soon as the board is clear.
function tourneyParkOffer(from, od){
    const d = _ttPend || (_tt && _tt.roles);
    if(!_tt || !d || String(d.you || 'idle') !== 'play') return false;
    if((d.players || []).map(String).indexOf(String(from)) < 0) return false;
    _ttOffer = { peer:String(from), od };
    return true;
}
function _ttFail(msg){
    _ttPend = null; _ttCerAt = 0; _ttWant = null; _ttPlayNid = ''; _ttOffer = null;
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
    s.stakesWant = _ttWant.stakes;
    s.lvl0 = _ttWant.lvl;
    s.levelWant = _ttWant.lvl;
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
    // _ttPlayNid, not _tt.you: the sheet for the next node may already have landed, and its
    // role says nothing about the match that just ended on our board.
    if(!_ttPlayNid || _ttRepDone) return;
    _ttRepDone = true;
    const my = (typeof netMyIndex === 'function') ? netMyIndex() : 0;
    const ps = (typeof players !== 'undefined' && players) ? players : null;
    const sc = ps ? [ps[my].score | 0, ps[1 - my].score | 0] : [0, 0];
    const w  = (typeof duelWinner !== 'undefined') ? duelWinner : -1;
    _ttReport(_ttPlayNid, w === 2 ? 'draw' : (w === my ? 'win' : 'loss'), sc);
}
// Called when a player walks out of a tournament match before it ended. Leaving is losing,
// and a reported loss settles at once -- far kinder to the eight people waiting than the
// three-minute walkover ladder. Nobody lies to lose.
function tourneyMatchLeft(){
    if(!_tt || !inGame || !_ttPlayNid || _ttRepDone) return;
    _ttRepDone = true;
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
    _ttOverAt = 0; _ttWant = null; _ttPlayNid = '';
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
    // `_ttOverAt` means one thing: A FINISHED MATCH IS STILL ON THE BOARD. Every other way
    // out of a duel -- the player pressing a key on the over screen, a peer's bye, a lost
    // connection -- clears the board without going through _ttClearMatch, and the stamp then
    // outlived the match it was made for. The next match inherited it and was torn down as a
    // finished one seconds after it began: a live game killed and forfeited mid-play.
    if(!inGame && _ttOverAt) _ttOverAt = 0;
    // The ceremony's job ended the moment the match went live. Leaving the stamp up would
    // let the connect ladder below read the quiet after a match that PLAYED as a match that
    // never connected, and forfeit a node nobody was waiting on.
    if(inGame && _ttCerAt){ _ttCerAt = 0; _ttTry = 0; }
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
    // A break that arrived while a match was STILL ON THE BOARD never got to take the
    // screen, and re-reading the same break deliberately does not move it either -- so this
    // is the one moment left to act on it. Without it a player whose match ended by any
    // route that does not run the duel exit (a no-show settled by the server, a peer's bye,
    // a dead connection) is left sitting on a ceremony for a node the tournament has already
    // walked past, with nothing on screen ever changing again.
    if(_tt.brk && !inGame && !_ttPend && _TT_PHASES[phase]
       && phase !== 'tourneyRound' && phase !== 'tourneyPodium'){
        phase = 'tourneyRound'; _uiDirty = true;
    }
    // A ceremony that never became a match: the offer was lost, or the peer is slow to
    // arrive. Re-offer a few times before handing it back to the server's walkover ladder,
    // which is the only thing entitled to decide that somebody did not show up.
    // Deliberately NOT gated on the ceremony being the screen in front of us: ESC steps back
    // to the bracket without cancelling the match, so the recovery has to keep running there
    // as well -- otherwise one keypress silently takes away both the re-offer and the
    // walkover, and the node hangs for everybody in the tournament, not just for the player
    // who pressed it.
    if(!inGame && !_ttPend && _ttCerAt && now - _ttCerAt > TT_CONNECT_MS){
        if(++_ttTry >= TT_CONNECT_TRIES) _ttFail('MATCH DID NOT CONNECT');
        else { _ttCerAt = now; _ttPend = _tt.roles; }
    }
    // The state read-back is the safety net under the signal stream, and the roster needs one
    // as much as the bracket does: nothing but an adopted `players` list ever SHRINKS the
    // lobby, so a single `lobby` event that never arrived left a departed player on screen for
    // good. Poll while the bracket runs (a roles sheet must not be missed) and whenever a
    // tournament screen is actually being looked at; TT_STATE_MS is what keeps that cheap.
    if(!inGame && (_tt.state === 'running' || _TT_PHASES[phase])) _ttSync();
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
        // The label names what the toggle does, so this row takes no note: a note is drawn
        // at a fixed x and a row this long runs straight through that column.
        rows.push({ t:'ITEM STAKES (WINDSWEPPING): ' + (_ttUi.stakes ? 'ON' : 'OFF'), en:ok, lr:true,
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
        // The one row a whole field is waiting on. It belongs to the host and only while a
        // break is open, and it stays dark until the server will accept it: an early press
        // is refused, and a button that refuses looks like a broken one.
        const b = _tt.brk;
        if(b && String(b.host || '') === getPlayerId()){
            const left = Math.max(0, _ttUi.contAt - _msgNow());
            rows.push({ t:'CONTINUE', en:!left && !_ttUi.busy,
                        note:left ? (Math.ceil(left / 1000) + 'S') : '', act:tourneyContinue });
        }
        rows.push({ t:'LEAVE TOURNAMENT', en:true, act:tourneyLeave });
    }
    rows.push({ t:'BACK', en:true, act:() => { phase = 'duelMenu'; Snd.sfxPlay('nav', cfg.music); } });
    return rows;
}
