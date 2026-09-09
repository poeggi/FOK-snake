// Online-features smoke: the OFFLINE-FIRST contract (nothing may break local play
// -- with cfg.offline ON, with no fetch/WebRTC at all, or with the server down),
// the lobby flow, the host<->peer duel netcode (state relay + input relay + the
// PLAY AGAIN handshake) driven headlessly over a fake DataChannel.
// Run: node test/smoke-net.js
const { runTest } = require('./harness');

runTest('SMOKE-NET', `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const log = (m) => R.steps.push(m);
  function press(k){ handleKey(k, ()=>{}); }
  try {
    simNow=100000; simTick=6000; _splashLeftAt=-1e9;
    // start.php now REFUSES to start a match without a server-issued start moment
    // (no shared clock, no match) -- correct, but the harness has no fetch, so it
    // would tear down every session under test. The precondition has its own test
    // in the PTS section below; everywhere else, stub it out.
    _netRequestStart=async()=>{};

    // ---- OFFLINE-FIRST: every entry point is a silent no-op without a network ----
    // (the harness has no fetch and no RTCPeerConnection -- exactly a dead browser)
    cfg.offline=true;
    netLobbyEnter(); netLobbyLeave(); _netHello(); netFetchScores();
    netSubmitScore('KAI', 1234, 3); netEndSession(); netAgain();
    if(netGameActive()||netHosting()) throw 'no session must be active';
    cfg.offline=false;   // fetch is still undefined: same soft path
    netLobbyEnter(); _netHello(); netFetchScores(); netSubmitScore('KAI', 1, 1);
    netLobbyLeave();
    log('offline-first ok: all entry points no-op without a network');

    // Classic play must be untouched by the net layer: seed + input log ride along.
    beginGame();
    if(phase!=='levelReady'&&phase!=='playing') throw 'beginGame broken with the net files loaded';
    if(!(_netSeed>0)) throw 'main-made seed not registered for score replay';
    for(let i=0;i<400;i++) update();
    if(phase!=='playing') throw 'classic game did not reach playing with the net files loaded';
    gameSteer(0, GDIRS.ArrowUp);
    if(_netInputs.length!==1||_netInputs[0][1]!==0) throw 'input log did not record the steer';
    // Boost transitions log at their real ENGAGE/END (issued by the arming stage
    // beside the sim, once the aimed direction is live), not at the keypress.
    gameBoostStart(0, GDIRS.ArrowUp, true);
    for(let i=0;i<200 && _netInputs.length<2;i++) update();
    if(_netInputs.length!==2||_netInputs[1][1]!==4) throw 'engage not logged: '+JSON.stringify(_netInputs);
    // A record is LOGGED when the stage issues it and EXECUTES on the tick it names, SIM_LEAD
    // ticks out (js/sim.js simInputTick) -- in every mode, single player included.
    for(let i=0;i<SIM_LEAD;i++) update();
    if(!boosting) throw 'instant boost did not engage';
    gameBoostEnd(0);
    for(let i=0;i<8 && _netInputs.length<3;i++) update();
    if(_netInputs.length!==3||_netInputs[2][1]!==8) throw 'input log boost codes wrong';
    inGame=false; _wsend({t:'phase',phase:'menu'}); phase='menu';
    log('classic play ok: unaffected, seed + tick-stamped input log recorded');

    // ---- lobby: open from the 1vs1 menu, render, navigate, invite dialog ----
    localStorage.setItem('fok-snake-friends', JSON.stringify(['00ff00aa','00ff00bb']));
    phase='duelMenu'; duelSel=0; press('Enter');   // 1vs1 DUEL submenu order: 0 1vs1 ONLINE, 1 1vs1 LOCAL
    if(phase!=='duelLobby') throw '1vs1 ONLINE did not open the lobby';
    drawDuelLobby();
    press('ArrowDown'); press('ArrowDown'); press('ArrowDown');
    if(_netLb.sel!==3) throw 'lobby nav broken (sel='+_netLb.sel+')';
    press('Enter');   // BACK
    if(phase!=='duelMenu') throw 'lobby BACK did not return';
    phase='duelLobby'; netLobbyEnter();
    _netOnSignal({from:'00ff00aa', type:'duelInvite', payload:JSON.stringify({profile:{name:'PEER<XSS>',color:99}})});
    if(!_netLb.invite) throw 'incoming invite not surfaced in the lobby';
    if(_netLb.invite.profile.color>=SNAKE_COLORS.length) throw 'peer profile color not clamped';
    drawDuelLobby();                                   // invite dialog renders
    press('n');                                    // decline (soft: no network to send on)
    if(_netLb.invite) throw 'decline did not clear the invite';
    // offline mode blocks the lobby entirely
    cfg.offline=true; phase='duelMenu'; duelSel=0; press('Enter');
    if(phase==='duelLobby') throw '1vs1 ONLINE must be blocked in offline mode';
    cfg.offline=false; drawDuelMenu();
    log('lobby ok: open, nav, invite surface/clamp/decline, offline block');

    // ---- online duel netcode over a fake wire (host side) ----
    const sent=[];
    function fakeSess(role){
        _netSess=_netMkSess('00ff00aa', role);
        _netSess.game=true;
        _netSess.dc={ readyState:'open', send:(x)=>sent.push(x), close(){}, };
    }
    // Session first, exactly like a real match: beginOnlineDuel has the session in
    // hand before tick 1, so netTickPre records the rollback ring from the start.
    simTick=0; simNow=0; inGame=true;
    fakeSess('host'); _rbReset();
    startDuel(0xBEEF); bars=[];
    for(let i=0;i<400;i++){ netTickPre(); update(); }
    if(phase!=='duel') throw 'duel warmup failed';
    if(_rbRing.length!==RB_RING) throw 'the rollback ring must be full after 400 ticks, got '+_rbRing.length;
    // ---- inputs-only wire: NO state is ever transmitted ----
    // A remote input steers the OTHER index and only that one; the sender's own
    // index in the packet is not even read, so a hostile peer cannot touch us.
    // netTickPre() is the door every input comes through, so assert right there --
    // update() would consume the queue at the next game tick and hide the result.
    const q0=players[1].dirQueue.length;
    _netHandleMsg(JSON.stringify({t:'in',tk:simTick,l:[{q:1,tk:simTick+1,k:'dir',d:{x:0,y:-1}}]}));
    netTickPre();
    if(players[1].dirQueue.length!==q0+1) throw 'peer input did not reach P1';
    update();
    const q0b=players[1].dirQueue.length;
    _netHandleMsg(JSON.stringify({t:'in',tk:simTick,l:[{q:2,tk:simTick+1,k:'dir',d:{x:5,y:5}}]}));
    netTickPre();
    if(players[1].dirQueue.length!==q0b) throw 'malformed peer input must be dropped';
    update();
    // A redundant resend of an already-applied sequence must not double-apply.
    const qd=players[1].dirQueue.length;
    _netHandleMsg(JSON.stringify({t:'in',tk:simTick,l:[{q:1,tk:simTick+1,k:'dir',d:{x:0,y:-1}}]}));
    netTickPre();
    if(players[1].dirQueue.length!==qd) throw 'a repeated sequence must be ignored, not replayed';
    update();
    // OUR OWN steer is authored at its EFFECTIVE moment -- the next game-tick
    // boundary -- and applied from the shared input log there, exactly like the
    // remote copy of the same record: local is a peer with zero latency. The first
    // TWO turns of a tick ship the moment they are authored (leading-edge flush,
    // capped at two: a fast double gesture lands two distinct turns inside one tick,
    // and a deferred second record leaves at the boundary with zero wire budget); any
    // further turn in the same tick only marks the dirty flag and coalesces into the
    // next tick's flush, so a touch burst costs bounded packets, not one per event.
    const w0=sent.length, q0h=players[0].dirQueue.length;
    gameSteer(0, GDIRS.ArrowUp);
    if(sent.length!==w0+1) throw 'the first steer of a tick must ship at once (leading-edge flush)';
    gameSteer(0, GDIRS.ArrowDown);   // second distinct turn, same tick (the sim later drops it as reverse-of-queued)
    if(sent.length!==w0+2) throw 'the second steer of a tick must ship at once too (the cap is two)';
    gameSteer(0, GDIRS.ArrowRight);  // a third distinct turn: past the cap, only marks dirty
    if(sent.length!==w0+2) throw 'a third steer in the same tick must not send -- capped at two input flushes per tick';
    const wCap=sent.length;
    for(let i=0;i<20 && players[0].dirQueue.length===q0h;i++){ netTickPre(); update(); }
    if(players[0].dirQueue.length===q0h) throw 'own steer never reached our snake at its boundary';
    if(sent.length<=wCap) throw 'the tick must flush the capped third steer to the wire';
    const pk=JSON.parse(sent[w0]);
    if(pk.t!=='in'||!Array.isArray(pk.l)||!pk.l.length) throw 'own steer must reach the peer as an input log';
    if(pk.s!==undefined||pk.snake!==undefined) throw 'no state may ride the wire';
    // ...and the tick that owns it must NOT apply it a second time.
    const qDup=players[0].dirQueue.length;
    netTickPre();
    if(players[0].dirQueue.length!==qDup) throw 'the live input was applied twice: once now, once by the tick';
    update();
    const wSwallow=sent.length;    // re-baseline: the tick path emits warm pings between here and the P0 steer
    gameSteer(1, GDIRS.ArrowUp);   // local P2 keys are dead in an online game
    if(sent.length!==wSwallow) throw 'local P2 input must be swallowed online';
    // Boost: ARMING is immediate and device-local (nothing rides the wire for it);
    // the arming stage issues the real engage once the aim is live + grace has
    // passed, and THAT transition is what reaches the sim and the peer.
    for(let i=0;i<300 && players[0].dirQueue.length;i++){ netTickPre(); update(); }   // queued turns consume first: arming aligns against the LIVE dir
    gameBoostStart(0, { x:players[0].dir.x, y:players[0].dir.y }, true);
    for(let i=0;i<300 && !players[0].boosting;i++){ netTickPre(); update(); }
    if(!players[0].boosting) throw 'armed boost never engaged';
    netTickPre();   // the engage was authored mid-tick; its wire send flushes on the next tick (rate-limited)
    if(!sent.some(x=>/"k":"bs"/.test(x))) throw 'the engage transition did not cross the wire';
    gameBoostEnd(0);
    // Boost end is arming too: simArmTick (end of update) issues the real 'be', which -- like
    // every input now -- is LOGGED for its authored tick and applied by netTickPre, never live.
    // So it lands a tick or two out (arm -> log -> apply), not the same instant: the deliberate
    // one-tick local-input deferral that keeps our ring snapshot in step with the peer's.
    for(let i=0;i<8 && players[0].boosting;i++){ netTickPre(); update(); }
    if(players[0].boosting) throw 'boost end never landed at its authored tick';
    // ONE DATAGRAM OR NOTHING. Past the path MTU, SCTP fragments the message and losing
    // any fragment loses all of it -- on a channel that never retransmits, a fragmented
    // packet is one that mostly does not arrive. Measure the WORST case of each type we
    // send, not a typical one.
    for(let i=0;i<40;i++) gameSteer(0, i%2 ? GDIRS.ArrowUp : GDIRS.ArrowRight);   // fill the redundant log
    netTickPre(); update();
    _netSess.startPts=simNow; _netSync={ofs:0, rtt:1, at:Date.now()};
    const _big=Math.max(...sent.map(x=>x.length));
    if(_big > NET_PKT_MAX) throw 'an input packet exceeds the datagram budget: '+_big+'B > '+NET_PKT_MAX;
    sent.length=0;
    const _hb=_rbHashBoth(simSnapshot());
    _netSend({ t:'h', tk:_rbToWire(simTick), h:_hb.h, f:_hb.f });
    if(!sent.length) throw 'setup: the hash packet did not send';
    if(sent[0].length > NET_PKT_MAX) throw 'a hash packet exceeds the datagram budget: '+sent[0].length+'B > '+NET_PKT_MAX;
    // The per-field hashes ride as a positional 16-bit array (RB_HASH_DUEL order) -- the
    // names are shared code and stay off the wire. 300B bounds the whole packet; a
    // keyed-object shape (~575B) fails it.
    const _hp=JSON.parse(sent[0]);
    if(!Array.isArray(_hp.f)||_hp.f.length!==RB_HASH_DUEL.length) throw 'per-field hashes must be a full positional array';
    if(_hp.f.some(x=>x!==(x&0xffff))) throw 'a per-field hash exceeds 16 bits';
    if(sent[0].length > 300) throw 'the hash packet regressed past its array-shape budget: '+sent[0].length+'B > 300B';
    if(NET_PKT_MAX > 1210) throw 'the budget must leave ~70B of IP+UDP+DTLS+SCTP headers under a 1280 MTU';
    _netSync={ofs:null, rtt:-1, at:0};
    log('packet budget ok: worst-case input '+_big+'B + hash '+sent[0].length+'B fit one datagram');
    sent.length=0;

    // ---- version gate: MAJOR.MINOR only ----
    // The patch auto-bumps on EVERY commit, so an exact match meant two devices
    // practically never agreed and refused to duel over a changed pixel. What has to
    // match is the SIMULATION, not the build.
    const _ov=_swVersion; _swVersion='2.0.0';
    if(!_netVerOk('2.0.1')) throw '2.0.0 must play with 2.0.1: the patch does not change the sim';
    if(!_netVerOk('2.0.99')) throw 'any patch on the same minor must play';
    if(!_netVerOk('2.0')) throw 'a 2-part version on the same line must play';
    if(_netVerOk('2.1.0')) throw 'a MINOR bump means the sim moved: it must NOT play';
    if(_netVerOk('1.5.200')) throw 'a MAJOR difference must not play';
    if(!_netVerOk(null)) throw 'a peer that says nothing gives us nothing to refuse over';
    _swVersion=_ov;
    log('version gate ok: major.minor only, patches interop, a minor bump does not');

    log('lockstep wire ok: inputs only, other index only, redundancy deduped');

    // ---- rollback: a LATE remote input rewinds and re-simulates ----
    // This is the whole point of the redesign: the input is honoured at the tick it
    // was AUTHORED on, not the tick it happened to arrive on, so both clients end up
    // in the same world without anyone being the authority.
    const before=_rbDbg.rb, lateTick=simTick-5, tickLeft=simTick;
    const qLate=players[1].dirQueue.length;
    _netHandleMsg(JSON.stringify({t:'in',tk:lateTick,l:[{q:50,tk:lateTick,k:'dir',d:{x:0,y:-1}}]}));
    // The rewind is BATCHED: _netPeerInput only records the earliest late tick; netTickPre does
    // the single rollback for every packet that landed this tick, so many packets draining
    // together cost one re-sim, not one each. So it is netTickPre -- not packet arrival -- that
    // rewinds. It runs before update() advances, so the correction still lands before this tick.
    netTickPre();
    if(_rbDbg.rb!==before+1) throw 'a late input must trigger exactly one rollback';
    if(simTick!==tickLeft) throw 'the re-simulation must land back on the tick we left';
    if(simTick-_rbRing[_rbRing.length-1].tk>=RB_SNAP_EVERY) throw 'the thinned ring must stay within one snap step of the live tick';
    if(players[1].dirQueue.length===qLate && _rbDbg.resim===0) throw 'the rewind re-simulated nothing';
    // Too old to rewind to: refused rather than applied at the wrong tick (a silent desync).
    const drops=_rbDbg.drop;
    _netHandleMsg(JSON.stringify({t:'in',tk:0,l:[{q:51,tk:Math.max(0,simTick-RB_DEPTH-1),k:'dir',d:{x:0,y:1}}]}));
    if(_rbDbg.drop!==drops+1) throw 'an un-rewindable input must be refused, not applied late';
    // Authored in our future: an honest peer stamps its own current tick.
    _netHandleMsg(JSON.stringify({t:'in',tk:0,l:[{q:52,tk:simTick+RB_FUTURE+5,k:'dir',d:{x:0,y:1}}]}));
    if(_rbDbg.drop!==drops+2) throw 'an input from our future must be refused';
    log('rollback ok: late input rewinds, un-rewindable and future inputs refused');

    // ---- divergence detection: identical sims must agree on a state hash ----
    // With no state on the wire there is nothing to fake, so a hash mismatch IS the
    // divergence (and the only tamper signal a cheat could raise).
    const _hTick=_rbRing[_rbRing.length-1].tk, _hMine=_rbHash(_rbRing[_rbRing.length-1].snap);
    const _ok0=_rbDbg.hashOk, _dz0=_rbDbg.desync;
    // A hash must NOT be judged on arrival: our snapshot for that tick is provisional
    // until any in-flight input for it lands and rolls us back. Judging early
    // mismatches every time either player steers -- a false desync, once a second.
    _netHandleMsg(JSON.stringify({t:'h', tk:_hTick, h:_hMine}));
    if(_rbDbg.hashOk!==_ok0||_rbDbg.desync!==_dz0) throw 'a hash must be parked until its tick settles, not judged on arrival';
    for(let i=0;i<RB_SETTLE+2;i++){ netTickPre(); update(); }   // ...now it has settled
    if(_rbDbg.hashOk!==_ok0+1||_rbDbg.desync!==_dz0) throw 'agreeing hashes must not report a desync';
    const _hT2=_rbRing[_rbRing.length-1].tk;
    _netHandleMsg(JSON.stringify({t:'h', tk:_hT2, h:(_rbHash(_rbRing[_rbRing.length-1].snap)^0xdeadbeef)>>>0}));
    for(let i=0;i<RB_SETTLE+2;i++){ netTickPre(); update(); }
    if(_rbDbg.desync!==_dz0+1) throw 'a settled mismatched hash must be reported as a desync';
    // A hash for a tick that has aged out of the ring: nothing to compare, stay quiet.
    _netHandleMsg(JSON.stringify({t:'h', tk:_hTick-10000, h:12345}));
    for(let i=0;i<RB_SETTLE+2;i++){ netTickPre(); update(); }
    if(_rbDbg.desync!==_dz0+1) throw 'an un-comparable hash must not be called a desync';
    // A desync is NOT a connection problem: the link is fine, the worlds are not. It shows
    // its OWN banner, OUT OF SYNC, never CONNECTION LOST, and clears the moment it heals.
    _netSess.lastRecvWall=Date.now();
    if(netDuelWarn()!=='OUT OF SYNC') throw 'an unhealed desync must show OUT OF SYNC';
    _rbBadSince=0;                                   // a later hash agrees -> healed
    if(netDuelWarn()!==null) throw 'a healed desync must clear the banner';
    log('divergence detection ok: hash agrees, mismatch flagged, stale hash ignored, OUT OF SYNC tracks it');

    // ---- a hash that outlives the snapshot ring must still be judged ----
    // The ring spans RB_RING*RB_SNAP_EVERY ticks while the verdict sits RB_HASH_LAG behind it,
    // so deriving our side of the compare from the ring leaves only a handful of ticks of
    // arrival margin -- on any link slower than a LAN the peer's hash lands after the ring
    // dropped its tick. That produced NO verdict at all: no OUT OF SYNC, no 'st'/'rs' repair,
    // no escalation, so a real divergence ran on forever and neither side ever said a word.
    // _rbMyHash is what keeps the tick comparable; hashLost is what makes any remaining
    // un-judgeable hash visible instead of silent.
    const _mh=_rbMyHash[_rbMyHash.length-1];
    if(!_mh) throw 'sending our hash for a tick must cache our own copy of it';
    for(let i=0;i<RB_RING*RB_SNAP_EVERY+8;i++){ netTickPre(); update(); }
    if(_rbRingFind(_mh.tk)) throw 'setup: that tick must have aged out of the ring -- it is the case this guards';
    const _dz1=_rbDbg.desync, _ok1=_rbDbg.hashOk, _hl1=_rbDbg.hashLost|0;
    _netHandleMsg(JSON.stringify({t:'h', tk:_rbToWire(_mh.tk), h:_mh.h}));
    netTickPre(); update();
    if(_rbDbg.hashOk!==_ok1+1||_rbDbg.desync!==_dz1) throw 'an agreeing hash must still be judged after its tick left the ring';
    _netHandleMsg(JSON.stringify({t:'h', tk:_rbToWire(_mh.tk), h:(_mh.h^0xdeadbeef)>>>0}));
    netTickPre(); update();
    if(_rbDbg.desync!==_dz1+1) throw 'a mismatched hash must still be reported after its tick left the ring';
    if((_rbDbg.hashLost|0)!==_hl1) throw 'a comparable hash must not be counted as un-judgeable';
    _rbBadSince=0; _rbResyncSend=0;
    log('late-hash detection ok: a hash outliving the ring is judged, not dropped in silence');

    // ---- in-game warning: CONNECTION LOST is a PURE silence detector ----
    // Nothing on the wire for ~2 heartbeats is the ONLY thing that flashes it. A refused
    // input is not silence (the packet still arrived), so it must NOT warn.
    _netSess.lastRecvWall=Date.now();
    if(netDuelWarn()!==null) throw 'a healthy duel must show no warning';
    // The 16-tick heartbeat (~267ms) must be comfortably faster than the ~533ms warn window
    // it prevents, so a healthy link never flashes.
    if(RB_WARN_MS < NET_KEEPALIVE_MS*1.5) throw 'warn window too tight for the keepalive: it will flash on a healthy link';
    _netSess.reconnecting=false;
    _netSess.lastRecvWall=Date.now()-Math.round(RB_WARN_MS*0.6);   // under the warn window: still fine
    if(netDuelWarn()!==null) throw 'a brief gap must not warn';
    _netSess.lastRecvWall=Date.now()-Math.round(RB_WARN_MS+200);   // silent past the warn window
    if(netDuelWarn()!=='CONNECTION LOST') throw 'silence past the warn window must warn';
    _netSess.lastRecvWall=Date.now();               // packets flowing again...
    if(netDuelWarn()!==null) throw 'a recovered link must clear the warning';
    _netHandleMsg(JSON.stringify({t:'in',tk:0,l:[{q:900,tk:-99999,k:'dir',d:{x:0,y:1}}]}));   // an unusable input, but it ARRIVED
    if(netDuelWarn()!==null) throw 'a refused input must NOT warn -- it still arrived (silence, not refusal)';
    // A reconnect in progress reads as RECONNECTING, not a bare CONNECTION LOST.
    _netSess.reconnecting=true; if(netDuelWarn()!=='RECONNECTING...') throw 'a reconnect must show RECONNECTING';
    _netSess.reconnecting=false;
    drawDuelBoard(simNow);                             // the overlay renders
    log('duel warning ok: only silence warns, a refused input does not, reconnect shows RECONNECTING, recovery clears it');

    // ---- clock-driven ticking: the shared clock owns the tick, not our frame timer ----
    // Pacing from local frame time let the two clients slide apart forever (a dropped
    // frame, a 59.94Hz panel, a GC pause), so corrections grew the longer a match ran.
    // The tick number is now a pure function of the clock both clients already share.
    _netSync={ofs:0, rtt:1, at:Date.now()};
    simTick=0; simNow=0;                               // startDuel rewinds it: a duel tracks the target
    _netSess.startPts=netPts()-1000;                   // the match began 1s ago
    const _ct1=netTickTarget();
    if(_ct1===null) throw 'a synced online duel must have a clock-driven tick target';
    if(Math.abs(_ct1-60)>2) throw '1s after the start must be ~tick 60, got '+_ct1;
    _netSess.startPts=netPts()-2000;                   // ...2s ago: exactly 60 ticks later
    if(Math.abs(netTickTarget()-_ct1-60)>2) throw 'the target must advance with the clock, 60 ticks/s';
    // A target far BEHIND our tick = the clock moved under a fixed startPts. The loop
    // would stop ticking until wall time caught up: a dead game for the length of the
    // jump -- no movement, no dpad, not even the exit button, because nothing simulates.
    // A device clock is seconds off, so this froze duels for ~10s.
    _netSync={ofs:0, rtt:1, at:Date.now()};
    _netSess.startPts=netPts()+9000;        // as if the clock jumped 9s: target far behind
    simTick=500;
    if(netTickTarget()!==null) throw 'a target 9s from our tick means a bad ORIGIN: steer nowhere, do not chase it';
    // No clock, no target: an unsynced client must NOT invent a timeline.
    _netSync={ofs:null, rtt:-1, at:0};
    if(netTickTarget()!==null) throw 'without a synced clock there is no shared tick to aim at';
    // Local play is untouched: no session, no target, the frame accumulator still runs.
    _netSync={ofs:0, rtt:1, at:Date.now()}; _netTeardown();
    if(netTickTarget()!==null) throw 'local play must keep its own frame-paced clock';
    // The anchor must NOT move mid-game: netPts() drives the tick number, so a
    // re-anchor during play steps the whole timeline under the player's feet. It is
    // set at the match start and re-set only at the negotiated breaks (new level,
    // rematch), never in between.
    fakeSess('host'); inGame=true;
    _netSync={ofs:1234, rtt:5, at:1};
    // _netSyncBusy is the synchronous witness that a sync actually STARTED. Counting
    // _netGet calls does not work: the clock now goes through fetch(t.txt) first, so
    // the call lands a microtask later and a sync driver would race it.
    const _oGet=_netGet; _netGet=async()=>({ok:true,t:Date.now()});
    const _oFetch=globalThis.fetch; globalThis.fetch=()=>({});   // _netOk() must be TRUE or every assertion below passes vacuously
    _netSyncBusy=false;
    phase='duel'; _netTimeSync(true);
    if(_netSyncBusy) throw 'the anchor must never be re-measured while a duel is being played';
    phase='duelPaused';  _netTimeSync(true);
    if(_netSyncBusy) throw 'a paused duel is still a duel: no re-anchor';
    phase='duelReady';   _netTimeSync(true);   // outside play: the gate lets a forced sweep through
    if(!_netSyncBusy) throw 'outside play (READY/GO) a forced sweep must run';
    _netSyncBusy=false;   // the async remainder is not under test; do not leave it latched
    _netGet=_oGet; globalThis.fetch=_oFetch; _netSync={ofs:null, rtt:-1, at:0}; inGame=false; phase='menu'; _netTeardown();
    log('anchor discipline ok: a sweep runs outside play, never mid-game');

    // ---- remote DEBUG flag (api v3): report what is true, honour what is asked ----
    // The two bits are deliberately independent, and the admin view names the
    // difference: 'pending' = an instruction not picked up yet, 'self' = a client that
    // turned debug on by itself. Deriving one from the other would erase that.
    const _applyHello=(r)=>{   // the response half of _netHello, without the network
        const _m=_netApiMajor(r.api), _mn=_netApiMinor(r.api);
        _netApiNewer=(_m!==null && _m>NET_API_BUILT);
        _netApiOutdated=(_m===NET_API_BUILT && _mn>NET_API_BUILT_MINOR);
        _netSrvMin=(_m===NET_API_BUILT && _mn!==null)?_mn:-1;
        if(typeof r.debug==='boolean'){
            if(_netDbgSrv!==null && r.debug!==_netDbgSrv){ cfg.debug=r.debug?Math.max(1,cfg.debug|0):0; }
            else if(_netDbgSrv===null && r.debug && !(cfg.debug|0)){ cfg.debug=1; }
            _netDbgSrv=r.debug;
        }
    };
    _netDbgSrv=null; cfg.debug=0;
    _applyHello({api:'3.1', debug:true});             // operator turns it on (server now sends api as "MAJOR.MINOR")
    if((cfg.debug|0)===0) throw 'the server instruction must turn debug ON';
    _applyHello({api:'3.1', debug:false});            // ...and off again
    if((cfg.debug|0)!==0) throw 'the server instruction must turn debug OFF again';
    // A STEADY false must not fight a developer who enabled it locally: that is 'self',
    // and it only exists if a repeated instruction is not re-applied every heartbeat.
    cfg.debug=2;
    _applyHello({api:'3.1', debug:false});
    if((cfg.debug|0)!==2) throw 'a repeated instruction must not stamp on a self-enabled client';
    // The REPORT is what we are actually doing, never what was asked.
    cfg.debug=0; _netDbgSrv=null;
    // api MAJOR gate: the client's own MAJOR.MINOR string is compatible; an OLDER server
    // and a legacy integer still are; a newer MINOR flags an update; only a newer MAJOR
    // disables online. An older server MAJOR (one without the item registry) stays usable:
    // online play is unaffected, item registration simply has nowhere to land.
    _applyHello({api:'4.6'});   // the version this client is built against
    if(_netApiNewer||_netApiOutdated) throw 'built against 4.6: the same version must read as up to date';
    if(netUpdateNotice()) throw 'no update note when up to date';
    // The tournament gate needs a working client AND a 4.1 server, so stub fetch back in:
    // without it _netOk() is false and both halves of the assertion pass vacuously.
    const _oFetchT=globalThis.fetch; globalThis.fetch=()=>({});
    if(netSrvMinor()!==6 || !netTourneyOk()) throw 'a same-major 4.6 server must open the tournament gate';
    // The beat is a contract constant: 60 s, half the 120 s online window.
    if(NET_HELLO_MS!==60000) throw 'the contract beat is 60 s';
    _applyHello({api:'4.4'});
    if(_netApiNewer||_netApiOutdated) throw 'an older MINOR (4.4) must read as up to date';
    if(netSrvMinor()!==4) throw 'a 4.4 server must report minor 4';
    // 4.4 is also what the batched-ICE and pacing features gate on, so the minor a hello
    // reports has to survive an older server rolling back under us.
    _applyHello({api:'4.3'});
    if(_netApiNewer||_netApiOutdated) throw 'an older MINOR (4.3) must read as up to date';
    if(netSrvMinor()!==3) throw 'a 4.3 server must report minor 3 -- the ices gate reads this';
    // The tournament gate is a >= 4.1 gate, not an equality: a server that has tournament.php
    // but not the hello nets field must keep serving tournaments.
    _applyHello({api:'4.1'});
    if(_netApiNewer||_netApiOutdated) throw 'an older MINOR (4.1) must read as up to date';
    if(netSrvMinor()!==1 || !netTourneyOk()) throw 'a 4.1 server must still open the tournament gate';
    _applyHello({api:'3.5'}); if(_netApiNewer||_netApiOutdated) throw 'an OLDER major (server 3.5) must read as up to date';
    _applyHello({api:4});     if(_netApiNewer||_netApiOutdated) throw 'a non-string api must soft-fail with no flags';
    // An OLDER minor still plays: only the features that need 4.1 are shut off, and the
    // menu row that offers them greys out rather than failing at the first POST.
    _applyHello({api:'4.0'}); if(_netApiNewer||_netApiOutdated) throw 'an older MINOR must read as up to date';
    if(netSrvMinor()!==0 || netTourneyOk()) throw 'a 4.0 server must keep the tournament gate shut';
    globalThis.fetch=_oFetchT;
    _applyHello({api:'4.7'});   // newer MINOR: still compatible, but an update exists
    if(_netApiNewer) throw 'a newer MINOR must NOT disable online';
    if(!_netApiOutdated || netUpdateNotice()!=='UPDATE AVAILABLE - PLEASE RELOAD') throw 'a newer minor must flag UPDATE AVAILABLE';
    _applyHello({api:'5.0'});   // newer MAJOR: incompatible
    if(!_netApiNewer || netUpdateNotice()!=='UPDATE REQUIRED - PLEASE RELOAD') throw 'a newer major must flag UPDATE REQUIRED and gate online off';
    _netApiNewer=false; _netApiOutdated=false;
    log('remote debug ok: instruction honoured on change, self-enabled left alone; api gate parses MAJOR.MINOR + flags newer minor/major + gates tournaments on 4.1');
    cfg.debug=0;

    // ---- the hold decision + the queue gauge (hello pace, q_ms; API 4.4) ----
    // What one idle client costs a contended host is dominated by the HELD poll: it owns a
    // PHP worker for its whole duration. That is why hold is a lever of its own and the only
    // thing left in the pace block -- and why withdrawing it has to fall back to reading the mailbox
    // on the tick, never to reading nothing.
    {
        const _oGetP=_netGet, _oFetchP=globalThis.fetch;
        globalThis.fetch=()=>({});                                  // _netOk(): online
        let _url=null, _heldArg=null, _bgP='none';
        _netGet=async (p,sig,held,bg)=>{ _url=p; _heldArg=!!held; _bgP=bg; return null; };
        // _netPollOnce is async, but everything up to the _netGet call is not: the URL is
        // captured by the time it returns. Clear the busy latch by hand since the tail of
        // the previous call has not run yet.
        const poll=()=>{ _url=null; _heldArg=null; _bgP='none'; _netPollBusy=false; phase='duelLobby'; _netPollOnce(); };
        _netPace={hold:true};
        _netFrSince=0; poll();
        if(!/[?&]wait=9(&|$)/.test(_url||'') || !_heldArg) throw 'the default pace must hold a 9s poll, got ' + _url;
        // Presence rides the poll on a presence screen (4.6): the cursor goes as fs, 0 = read
        // it whole. Elsewhere nothing is asked for.
        if(!/[?&]fs=0(&|$)/.test(_url||'')) throw 'a lobby poll must carry the presence cursor, got ' + _url;
        _netFrSince=777; poll();
        if(!/[?&]fs=777(&|$)/.test(_url||'')) throw 'the poll must carry the cursor the server gave, got ' + _url;
        _url=null; _netPollBusy=false; phase='myId'; _netPollOnce();
        if(/fs=/.test(_url||'')) throw 'MY ID shows no friend state and must not ask for it, got ' + _url;
        _netFrSince=0;
        // ...and a HELD poll waits on nothing: it IS the parked slot the gate lets one other
        // request stand beside, so gating it would park the client behind itself for 9s.
        if(_bgP !== undefined) throw 'a held poll must not be sent through the gate, got ' + String(_bgP);
        // FALSIFICATION: the interval fields an earlier 4.4 server still sends beside hold
        // are IGNORED, never adopted. They only ever carried the contract's own constants, so
        // a served one moving anything here would be a second source for a settled number.
        _netPaceOf({pace:{hello_ms:45000, poll_ms:3000, gap_ms:400}});
        poll();
        if(!/[?&]wait=9(&|$)/.test(_url||'')) throw 'a served poll_ms must not move the poll wait, got ' + _url;
        _netPaceOf({pace:{hold:false}});
        poll();
        if(/wait=/.test(_url||'') || _heldArg) throw 'hold:false must withdraw the held poll, got ' + _url;
        if(!/poll[.]php/.test(_url||'')) throw 'hold:false must still read the mailbox, got ' + _url;
        // An UNHELD poll is an ordinary request that returns at once, so it counts against
        // the one-other-request rule like any other -- on the solo lane, since a mailbox read
        // is something the player is waiting for and owes no background spacing.
        if(_bgP !== NET_BG_SOLO) throw 'an unheld poll must take the solo lane, got ' + String(_bgP);
        // ...and an unheld poll must not cost the server MORE requests than the held one it
        // replaced. Nine unheld polls a second apart where one 9s hold used to sit is the
        // opposite of what withdrawing the hold is for, so an idle browsing client reads the
        // mailbox where the hold's answer would have landed instead.
        _netPace={hold:false};
        const _oTick=_netPollTick, _oSess=_netSess, _oSent=_netHs.sent, _oAcc=_netHs.accepting;
        _netSess=null; _netHs.sent=null; _netHs.accepting=null;
        let _hits=0;
        for(let i=0;i<27;i++){ _netPollTick=i; poll(); if(_url) _hits++; }
        if(_hits!==3) throw 'an idle unheld poll must land on the served cadence (3 in 27s), got ' + _hits;
        // But only while merely browsing. The offer ladder retries every 2s and gives up
        // after three, so a handshake in flight keeps the 1s tick whatever the pace says --
        // a mailbox read seconds late would answer an offer already abandoned at the far end.
        _netHs.offerTo='deadbeef';
        _hits=0;
        for(let i=0;i<9;i++){ _netPollTick=i; poll(); if(_url) _hits++; }
        _netHs.offerTo=null; _netPollTick=_oTick;
        _netSess=_oSess; _netHs.sent=_oSent; _netHs.accepting=_oAcc;
        if(_hits!==9) throw 'a handshake in flight must keep the 1s tick, got ' + _hits + ' of 9';
        // A key the server has STOPPED sending is not an error and not a reason to forget
        // what is in force: the contract lets a later server drop an optional field, and it
        // has now dropped every one of them but hold.
        _netPaceOf({pace:{hold:false}});
        _netPaceOf({api:'4.4'});
        if(_netPace.hold!==false) throw 'a hello with no pace block must leave the hold in force alone';
        _netPaceOf({pace:{}});
        if(_netPace.hold!==false) throw 'an empty pace block must leave the hold in force alone';
        _netPaceOf({pace:{hold:true}});
        // q_ms is the server's own report of how long this request queued before PHP ran.
        // Half of that wait lands straight in the clock offset, so a fresh reading over the
        // floor is what marks a sample unclean -- and it must EXPIRE, not latch: a host that
        // recovered would otherwise keep this client on the degraded path for ever.
        _netQNote({q_ms:51});
        if(!netHostBusy()) throw 'a fresh 51ms queue wait must read as a busy host';
        _netQNote({q_ms:0});
        if(netHostBusy()) throw 'an idle queue must not read as busy';
        _netQNote({q_ms:51}); _netQ.at=Date.now()-9000;
        if(netHostBusy()) throw 'a stale queue reading must expire rather than latch';
        if(_netDbg.qMs!==51) throw 'the debug overlay must carry the last queue wait';
        // ...and the reading cannot tell a busy HOST from this client queueing behind itself.
        // The count in flight when it was taken is what does, so it is taken with it: 1 is
        // this request alone, more is our own overlap and a bug in the gate below.
        const _oFlightQ=_netFlight;
        _netFlight=1; _netQNote({q_ms:51});
        if(!netHostBusy()) throw 'a 51ms wait is still a busy reading';
        if(netSelfStacked()) throw 'one request of ours alone is the HOST queueing, not us';
        _netFlight=3; _netQNote({q_ms:51});
        if(!netSelfStacked()) throw 'a queue wait measured with three of ours open is OUR overlap';
        _netFlight=3; _netQNote({q_ms:0});
        if(netSelfStacked()) throw 'no wait at all is nothing to attribute to anybody';
        _netFlight=_oFlightQ; _netQNote({q_ms:51}); _netQ.at=Date.now()-9000;
        // ...and the field readout must carry it out of the device: this whole change is
        // only worth what can be MEASURED afterwards, and that is the one way to read it.
        const _dbg=netDebugInfo();
        if(_dbg.srvQueueMs!==51) throw 'the debug export must carry the server queue wait';
        if(typeof _dbg.iceSignals!=='number' || typeof _dbg.iceBatches!=='number') throw 'the debug export must count ice signals against ice batches';
        if(!_dbg.pace || _dbg.pace.hold!==true || !_dbg.pace.roster) throw 'the debug export must carry the pace in force, got ' + JSON.stringify(_dbg.pace);
        _netQ={ms:0,at:0};
        _netPace={hold:true};
        // An aborted hold is still parked on the server until its own deadline: after a
        // foreground no HELD poll goes out before that moment, an unheld one may, and past
        // it the held poll goes out again.
        _netPace={hold:true}; _netPollNotBefore=0; _netPollHoldEnd=0;
        poll();
        if(!(_netPollHoldEnd>Date.now()+8000)) throw 'a held poll must note when the server lets its worker go, got ' + _netPollHoldEnd;
        _netPollResume();
        poll();
        if(_url) throw 'a held poll must not be re-armed while the aborted one is still parked, sent ' + _url;
        _netPace={hold:false}; _netPollTick=0; poll();
        if(!/poll[.]php/.test(_url||'') || /wait=/.test(_url||'')) throw 'an unheld poll may still go out while the old hold is parked, got ' + _url;
        _netPace={hold:true}; _netPollHoldEnd=Date.now()-1; _netPollResume();
        poll();
        if(!/wait=9/.test(_url||'')) throw 'past the old deadline the held poll goes out again, got ' + _url;
        _netPollNotBefore=0; _netPollHoldEnd=0;
        _netGet=_oGetP; globalThis.fetch=_oFetchP; _netPollBusy=false; phase='menu';
    }
    log('pacing ok: hold alone drives the poll, a retired interval field moves nothing, an unheld poll costs the contract cadence and not 1 Hz (a handshake excepted), q_ms flags a busy host and expires');

    // ---- ONE gate for our own background traffic + the roster on hello (4.4 re-release) ----
    // What the live host charges is a scheduling slice paid PER REQUEST IN FLIGHT, not per
    // byte: two of OUR OWN requests in the same instant pay it twice. Batching the ICE burst
    // only MOVED that cost -- hello and friend.php then arrived together instead. So every
    // background request queues behind one gate, and the duel handshake goes past it.
    {
        const _oPaceG={hold:_netPace.hold};
        const _oSentG=_netSentAt, _oFlightG=_netFlight, _oFetchG=globalThis.fetch;
        // (a) the gap is a CONTRACT CONSTANT, the same for every client, so nothing on the
        // wire can move it: an earlier 4.4 server still naming one must change nothing here.
        _netSentAt=1000;
        _netPaceOf({pace:{gap_ms:400}});
        if(_netGapWait(1000, 0)!==100) throw 'a served gap_ms must not move the spacing, got ' + _netGapWait(1000,0);
        _netPaceOf({api:'4.4'});
        if(_netGapWait(1000, 0)!==100) throw 'a hello with no pace block at all must leave the spacing alone';
        // (b) THE rule, in one place: anything of ours in flight holds the next background
        // request back whatever the clock says; otherwise the wait is what is LEFT of the gap.
        _netSentAt=1000;
        if(_netGapWait(1000, 1)<=0) throw 'a request of ours in flight must hold the next one back';
        if(_netGapWait(1e9, 1)<=0) throw 'in flight must beat any amount of elapsed time';
        if(_netGapWait(1000, 0)!==100) throw 'a request right behind ours must cost the whole gap, got ' + _netGapWait(1000,0);
        if(_netGapWait(1040, 0)!==60) throw 'the wait must be what is left of the gap, got ' + _netGapWait(1040,0);
        if(_netGapWait(1100, 0)!==0) throw 'past the gap on a quiet wire the request goes at once';
        if(_netGapWait(9999, 0)!==0) throw 'a long-quiet wire must never owe a wait';
        // (c) ...but a HELD poll is parked server-side with nothing flowing. It schedules
        // against nothing, and counting it would park every heartbeat behind the poll a lobby
        // holds open by design. The transport decides that, so ask the transport.
        globalThis.fetch=()=>new Promise(()=>{});   // never settles: the flight counter IS the assertion
        _netFlight=0;
        _netGet('/api/poll.php?wait=9', undefined, true);
        if(_netFlight!==0) throw 'a held poll must not make the wire busy, got ' + _netFlight;
        _netGet('/api/poll.php', undefined, false);
        if(_netFlight!==1) throw 'an unheld request must count as in flight, got ' + _netFlight;
        if(!(_netFlightMax>=1)) throw 'the field readout must keep the high-water mark of our own concurrency';
        // (c2) ...for the HEARTBEAT tier. The idle tier -- items, the cloud backup, the traffic
        // nobody is waiting for -- stands aside for that held poll anyway: parked in PHP or not,
        // it holds a connection open the whole time, and the slice is paid per request in flight
        // up there. Bounded by the same count as every other wait here, so the drain is delayed
        // and never dropped.
        const _oHeldG=_netPollHeld;
        _netFlight=0; _netPollHeld=true;
        if(_netGapFlight(NET_BG_IDLE)!==1) throw 'the idle tier must stand aside for a held poll, got ' + _netGapFlight(NET_BG_IDLE);
        if(_netGapFlight(true)!==0) throw 'the heartbeat must NOT be parked behind the poll a lobby holds open by design';
        _netPollHeld=false;
        if(_netGapFlight(NET_BG_IDLE)!==0) throw 'with no poll open the idle tier owes nothing extra';
        _netFlight=1;
        if(_netGapFlight(true)!==1) throw 'a real request of ours in flight counts for every tier';
        _netPollHeld=_oHeldG; _netFlight=_oFlightG;
        // (c3) the SOLO lane, for the traffic a player is waiting for that must not be SPACED
        // -- the signalling burst of a forming duel, and an unheld poll. The server measured
        // what the old blanket exemption costs: two exempt calls in one tick race each other
        // and BOTH pay the queue wait. So solo owes the first half of the rule and not the
        // second: never beside another of ours, nothing once the wire is clear.
        _netSentAt=1000;
        if(_netGapWait(1000, 1, NET_BG_SOLO)<=0) throw 'the solo lane must still stand behind a request of ours';
        if(_netGapWait(1000, 0, NET_BG_SOLO)!==0) throw 'but must owe no spacing on a clear wire, got ' + _netGapWait(1000,0,NET_BG_SOLO);
        if(_netGapWait(1000, 0)!==100) throw 'while the background lane still pays the whole gap';
        if(NET_BG_SOLO===NET_BG_IDLE || NET_BG_SOLO===true) throw 'the three lanes must be distinguishable from one another';
        _netFlight=0; _netPollHeld=true;
        if(_netGapFlight(NET_BG_SOLO)!==0) throw 'solo is not the idle tier: the parked poll IS the slot it is allowed beside';
        _netPollHeld=_oHeldG; _netFlight=_oFlightG;
        // (c4) ...and a lane nothing opts into is not a lane. The deal moment is made of
        // signals, so ask the transport which one a signal actually asks for.
        const _oPostS=_netPostRes; let _bgS='none';
        _netPostRes=async (p,b,bg)=>{ _bgS=bg; return {status:200,json:{ok:true},body:null,err:''}; };
        _netSignal('deadbeef','ice','x');
        if(_bgS!==NET_BG_SOLO) throw 'a signal must go out on the solo lane, got ' + String(_bgS);
        _netPostRes=_oPostS;
        // (d) the roster now rides the heartbeat wherever the server serves it: one request
        // instead of two. Asked for only where the list is actually on screen.
        globalThis.fetch=()=>({ then:()=>({ catch:()=>{} }) });
        const _oPostG=_netPost, _oPhaseG=phase, _oBusyG=_netHelloBusy;
        let _hb=null;
        _netPost=async (p,b)=>{ if(p.indexOf('hello')>=0) _hb=b; return null; };
        phase='friends'; _netHelloBusy=false; _netFrSince=42; _netHello();
        if(!_hb || _hb.friends_list!==true) throw 'the friends screen must ask for the roster on the hello it already sends';
        // ...and presence by CURSOR, never by id list (4.6): the server knows the roster.
        if(_hb.friends_since!==42 || 'friends' in _hb) throw 'the friends screen must ask for the presence delta by cursor, no ids: ' + JSON.stringify(_hb);
        _hb=null; phase='duelLobby'; _netHelloBusy=false; _netHello();
        if(_hb && _hb.friends_list) throw 'the roster must not be asked for where it is not shown';
        if(!_hb || _hb.friends_since!==42) throw 'the lobby must ask for the presence delta too';
        _hb=null; phase='menu'; _netHelloBusy=false; _netHello();
        if(!_hb || 'friends_since' in _hb || 'friends' in _hb) throw 'the main menu shows no friend state and must ask for none: ' + JSON.stringify(_hb);
        _netFrSince=0;
        _netPost=_oPostG; phase=_oPhaseG; _netHelloBusy=_oBusyG;
        // (d2) MAKE DUELS PRIVATE. It rides BOTH requests that tell the server a duel
        // exists, and is enforced locally too: privacy only the server applies is privacy
        // one server bug wide.
        const _oPostP=_netPost, _oBusyP=_netHelloBusy, _oSessP=_netSess, _oPrivP=cfg.privateDuels;
        let _hp=null;
        _netPost=async (p,b)=>{ if(p.indexOf('hello')>=0) _hp=b; return null; };
        _netSess={ peer:'deadbeef', game:true };
        cfg.privateDuels=false; _hp=null; _netHelloBusy=false; _netHello();
        if(!_hp || _hp.duel_with!=='deadbeef') throw 'a running duel must be announced on the beat';
        if('duel_private' in _hp) throw 'an ordinary duel must not claim privacy';
        cfg.privateDuels=true; _hp=null; _netHelloBusy=false; _netHello();
        if(!_hp || _hp.duel_private!==true) throw 'a private duel must say so on EVERY beat -- an absent flag reads as public';
        _netSess=null; _hp=null; _netHelloBusy=false; _netHello();
        if(_hp && ('duel_with' in _hp || 'duel_private' in _hp)) throw 'no duel, nothing to announce: ' + JSON.stringify(_hp);
        _netPost=_oPostP; _netHelloBusy=_oBusyP; _netSess=_oSessP;
        // ...and the ask itself. A BARE no: the alts of an ordinary refusal name the very
        // nodes serving the match being hidden, which would route the asker right back in.
        // ...including the ask lists: a fall-through PARKS the ask, and a parked ask reads as
        // a duel forming, which is a state the later item-queue lane is entitled to find clean.
        const _oSigW=_spWatchSig, _oGrantW=_spGrant, _oAskW=_spAsk.slice(), _oWantW=_spWant.slice();   // COPIES: _spOnWatch pushes into the live arrays
        let _wl=[];
        _spWatchSig=(to,k,d)=>{ _wl.push({to,k,d}); };
        const _bare = () => _wl.length===1 && _wl[0].k==='no' && _wl[0].d===undefined;
        _spGrant={}; cfg.privateDuels=true;
        _wl=[]; _spOnWatch('feedfeed',{k:'req'});
        if(!_bare()) throw 'a private duel must refuse a plain watch ask with a bare no: ' + JSON.stringify(_wl);
        specGrant(['feedfeed']);   // the roles sheet introduced this one: a bracket must stay watchable
        _wl=[]; _spOnWatch('feedfeed',{k:'req'});
        if(_bare()) throw 'a granted tournament spectator must not be refused by the privacy setting';
        _spGrant={}; cfg.privateDuels=false;
        _wl=[]; _spOnWatch('feedfeed',{k:'req'});
        if(_bare()) throw 'without the setting an ordinary ask must never hit the privacy refusal';
        _spWatchSig=_oSigW; _spGrant=_oGrantW; _spAsk=_oAskW; _spWant=_oWantW; cfg.privateDuels=_oPrivP;
        // ...and the teardown edge. Absence clears NOTHING server-side -- a client closed
        // mid-match never sends again -- so the end has to be STATED, and a bye that went over
        // the DataChannel is the one end the server cannot see for itself.
        _netDuelEnd=''; _hp=null; _netHelloBusy=false;
        _netPost=async (p,b)=>{ if(p.indexOf('hello')>=0) _hp=b; return null; };
        _netSess={ peer:'deadbeef', game:true };
        _netTeardown();
        if(_netDuelEnd!=='deadbeef') throw 'a finished duel must state its end, got ' + JSON.stringify(_netDuelEnd);
        // ...on the NEXT beat, never from teardown itself: a hello from there gathers ICE at
        // the moment the next match is forming, which costs a tournament spectator its feed.
        if(_hp) throw 'teardown must send no request of its own: ' + JSON.stringify(_hp);
        _netHelloBusy=false; _netHello();
        if(!_hp || _hp.duel_end!=='deadbeef') throw 'the next beat must carry the end: ' + JSON.stringify(_hp);
        // A handshake that never reached play was never announced, so it has no end to state.
        _netDuelEnd=''; _netSess={ peer:'deadbeef', game:false }; _netHelloBusy=false;
        _netTeardown();
        if(_netDuelEnd!=='') throw 'a duel that never began must not announce an end';
        // A SPECTATOR is game:true with a deliberately EMPTY peer. An empty duel_with is not an
        // absent one: the server validates the id and refuses the whole heartbeat over it.
        _netSess={ peer:'', game:true }; _hp=null; _netHelloBusy=false; _netHello();
        if(!_hp || 'duel_with' in _hp) throw 'a spectator has no duel to announce: ' + JSON.stringify(_hp);
        _netSess=null; _netDuelEnd=''; _netPost=_oPostP; _netHelloBusy=_oBusyP;
        log('private duels ok: the flag rides the beat and the start, the end is stated at teardown, a spectator announces none, an ordinary ask is refused bare, a roles-sheet spectator is not');
        // (e) ONE adoption path, whichever request paid for the list: names learned, accepted
        // friendships marked, and a screen that never has to know which route it came by.
        localStorage.removeItem('fok-snake-friends');
        const _oListG=_netFr.list;
        _netFrAdopt([{id:'00ff00dd',state:'accepted',outgoing:false,name:'ROS',online:true,latency:9}], false);
        if(!_netFr.list || _netFr.list.length!==1) throw 'the adopted roster must become the list the screen draws';
        if(netFriendName('00ff00dd')!=='ROS') throw 'adoption must learn the names the roster carries';
        if(!_netFrOk['00ff00dd']) throw 'an accepted friendship must be marked on adoption';
        _netFrOkClear('00ff00dd'); _netFr.list=_oListG; _netFr.at=0;
        localStorage.removeItem('fok-snake-friends');
        // ...and which route it was is a property of the SERVER, not of one response, so the
        // field readout names it: a 4.4 without the re-release still pays for friend.php.
        const _oFrHelloG=_netFrHello;
        _netFrHello=true;
        if(netDebugInfo().pace.roster!=='hello') throw 'a roster served on hello must read as such';
        _netFrHello=false;
        if(netDebugInfo().pace.roster!=='friend') throw 'without it the fallback route must be named';
        // ...and the screen entry follows the same route: where the roster rides the
        // heartbeat, entering asks for a heartbeat rather than a second request beside it.
        const _oRefG=_netFrRefresh, _oHelloG=_netHello, _oPh2=phase;
        let _refs=0, _hellos=0;
        _netFrRefresh=()=>{ _refs++; }; _netHello=()=>{ _hellos++; };
        phase='friends';
        _netFrHello=false; netFriendsEnter();
        if(_refs!==1 || _hellos!==0) throw 'without the roster on hello the screen must read friend.php';
        _netFrHello=true; _refs=0; _hellos=0; netFriendsEnter();
        if(_hellos!==1 || _refs!==0) throw 'with the roster on hello the screen must ask for the heartbeat, not a second request';
        _netFrRefresh=_oRefG; _netHello=_oHelloG; phase=_oPh2;
        _netFrHello=_oFrHelloG;
        // (f) 'a duel is being set up' is ONE predicate, because three schedulers ask it: the
        // poll cadence, the item queue and the ICE batcher. They must all mean the same thing.
        const _oOfferG=_netHs.offerTo, _oSentHsG=_netHs.sent, _oAccG=_netHs.accepting, _oSessG=_netSess, _oSpecG=specHandshaking;
        specHandshaking=()=>false;
        _netHs.offerTo=null; _netHs.sent=null; _netHs.accepting=null; _netSess=null;
        if(netForming()) throw 'an idle client is not forming a duel';
        _netHs.offerTo='00ff00aa'; if(!netForming()) throw 'an offer going out is a duel forming';
        _netHs.offerTo=null; _netHs.sent={to:'00ff00aa'}; if(!netForming()) throw 'an offer already sent is a duel forming';
        _netHs.sent=null; _netHs.accepting='00ff00aa'; if(!netForming()) throw 'accepting an offer is a duel forming';
        _netHs.accepting=null; _netSess={game:false}; if(!netForming()) throw 'a session with no game yet is a duel forming';
        _netSess={game:true}; if(netForming()) throw 'a duel under way is no longer being SET UP';
        specHandshaking=()=>true; if(!netForming()) throw 'a spectator handshake is a setup too -- same predicate';
        specHandshaking=_oSpecG;
        // (g) the item queue is background traffic as well, and a mint landing in the same
        // instant as an offer is precisely the collision this pays for: while a duel is being
        // set up the queue looks again instead of sending. Its own retry ladder loses nothing.
        const _oSetT=globalThis.setTimeout, _oITimer=_itemTimer, _oIBusy=_itemBusy, _oIRetry=_itemRetryAt;
        let _stMs=-1, _stFn=null;
        globalThis.setTimeout=(fn,ms)=>{ _stMs=ms; _stFn=fn; return 1; };
        _netHs.offerTo=null; _netSess=null; _itemTimer=0; _itemBusy=false; _itemRetryAt=0;
        itemKick();
        if(_stMs!==0) throw 'an idle client must drain the item queue at once, got ' + _stMs;
        _itemTimer=0; _stMs=-1; _netHs.offerTo='00ff00aa';
        itemKick();
        if(_stMs!==ITEM_FORM_MS) throw 'a duel being set up must stand the item queue aside, got ' + _stMs;
        // FALSIFICATION: ONE wait, never a loop. Re-asking on the way out re-arms itself for
        // as long as the answer stays yes -- and a session parked before its game says yes
        // indefinitely, which strands the queue instead of delaying it.
        const _oFlushG=itemFlush; let _drains=0;
        itemFlush=async ()=>{ _drains++; };
        _stFn();
        if(_itemTimer) throw 'the stand-aside must not re-arm itself while the duel is still forming';
        if(_drains!==1) throw 'once the wait is over the drain must go out whatever the handshake is doing, got ' + _drains;
        itemFlush=_oFlushG;
        globalThis.setTimeout=_oSetT; _itemTimer=_oITimer; _itemBusy=_oIBusy; _itemRetryAt=_oIRetry;
        _netHs.offerTo=_oOfferG; _netHs.sent=_oSentHsG; _netHs.accepting=_oAccG; _netSess=_oSessG;
        _netPace=_oPaceG; _netSentAt=_oSentG; globalThis.fetch=_oFetchG;
    }
    log('background gate ok: the 100ms gap is a constant no served field can move, our own request in flight holds the next one back while a held poll does not, the roster rides hello where served and falls back to friend.php, one forming predicate parks the item queue');

    // ---- our own public addresses (hello nets, server 4.2) ----------------------
    // The server sees us on ONE family per request; ICE can see both, so we gather them
    // and report them. What must hold: only addresses the world could reach us on, at
    // most one per family, a server-reflexive answer beating a host guess, and ONE
    // RTCPeerConnection every few minutes rather than one per 30s heartbeat.
    {
        // Every address ICE hands out in the wild, each with the reason it is or is not
        // ours to report. The mDNS name is Chrome's default for host candidates.
        for(const bad of ['','10.0.0.5','172.16.4.9','172.31.255.254','192.168.1.7','127.0.0.1',
                          '169.254.11.2','100.64.0.1','100.127.255.1','0.0.0.0','224.0.0.1',
                          '9d8e1f2a-1234.local','fe80::1c2d','fd12:3456::1','fc00::9','::1',
                          '2a02:1:2:3:4:5:6:7%eth0','256.1.1.1','1.2.3','1.2.3.4.5',
                          '2001:0db8:0000:0000:0000:0000:0000:0001:0002:0003'])   // longer than the server's 45-char cap
            if(_netAddrPublic(bad)) throw 'reported an address nobody outside this device can use: '+bad;
        for(const good of ['198.51.100.7','172.15.0.1','172.32.0.1','100.128.0.1','9.9.9.9',
                           '2a02:1:2:3:4:5:6:7','2001:db8::1','3ffe::1'])
            if(!_netAddrPublic(good)) throw 'dropped a genuinely public address: '+good;
        // A fake RTCPeerConnection that gathers exactly the candidates we hand it.
        let _pcN=0, _pc=null;
        const _oRtc=globalThis.RTCPeerConnection;
        globalThis.RTCPeerConnection=function(c){
            _pcN++; _pc=this; this.cfgArg=c; this.closed=false; this.chans=[]; this.onicecandidate=null;
            this.createDataChannel=(n)=>{ this.chans.push(n); return {}; };
            this.createOffer=()=>Promise.resolve({type:'offer',sdp:''});
            this.setLocalDescription=()=>Promise.resolve();
            this.close=()=>{ this.closed=true; };
            // onicecandidate is assigned before the offer, so a candidate can arrive at once
            this.emit=(addr,typ)=>this.onicecandidate({candidate:{ candidate:'candidate:1 1 udp 1 '+addr+' 5000 typ '+typ, address:addr }});
            this.end=()=>this.onicecandidate({candidate:null});
        };
        const _reset=()=>{ _netNets=[]; _netNetsAt=0; _netNetsBusy=false; _pcN=0; _pc=null; };
        _reset();
        netNetsRefresh();
        if(_pcN!==1) throw 'the first refresh must open exactly one RTCPeerConnection';
        if(_pc.chans.length!==1) throw 'no m-line means nothing to gather for';
        if(JSON.stringify(_pc.cfgArg)!==JSON.stringify({iceServers:[{urls:NET_STUN_URL}]})) throw 'the gather must use the one shared STUN host';
        if(netPublicNets().length) throw 'nothing may be reported before the gather finishes';
        _pc.emit('a1b2c3d4-0001.local','host');   // mDNS placeholder: not an address
        _pc.emit('192.168.1.31','host');          // the LAN side of our own NAT
        _pc.emit('198.51.100.7','host');          // a public v4 HOST candidate (no NAT): usable, but a guess
        _pc.emit('2a02:1:2:3::42','host');        // routine on v6: a global-unicast host candidate IS public
        _pc.emit('203.0.113.9','srflx');          // what the STUN server actually saw: the authority
        _pc.end();
        const nets=netPublicNets();
        if(nets.length!==2) throw 'exactly one address per family, no more: '+JSON.stringify(nets);
        if(nets[0]!=='203.0.113.9') throw 'a server-reflexive answer must beat a host guess';
        if(nets[1]!=='2a02:1:2:3::42') throw 'the v6 address must survive: v6 rarely produces a srflx at all';
        if(nets.length>NET_NETS_MAX||nets.some(a=>a.length>NET_NETS_ADDR_MAX)) throw 'the server caps the list at 4 short strings';
        if(!_pc.closed||_netNetsBusy) throw 'end-of-candidates must close the pc and release the gather';
        // ONE pc every few minutes: the 30s heartbeat calls refresh every time, and the TTL
        // is the whole reason that is cheap. A network change is what overrides it.
        const _seen=_pcN;
        netNetsRefresh(); netNetsRefresh(); netNetsRefresh();
        if(_pcN!==_seen) throw 'a fresh gather inside the TTL: one pc per hello is exactly what must not happen';
        netNetsRefresh(true);
        if(_pcN!==_seen+1) throw 'a network change must re-gather regardless of the TTL';
        _pc.emit('203.0.113.9','srflx'); _pc.emit('2a02:1:2:3::42','host'); _pc.end();
        // ...and a hello carries what was found, with no version gate: a 4.1 server ignores it.
        let _body=null; const _oPost2=_netPost, _oFetch2=globalThis.fetch, _oSync=_netTimeSync;
        globalThis.fetch=()=>({}); _netTimeSync=async()=>{};
        _netPost=async(p,b)=>{ if(p==='/api/hello.php') _body=JSON.parse(JSON.stringify(b)); return null; };
        _netHelloBusy=false; _netHello();
        if(!_body||JSON.stringify(_body.nets)!==JSON.stringify(nets)) throw 'hello did not carry the addresses we found';
        _reset(); _body=null; _netHelloBusy=false; _netHello();
        _pc.end();   // release the gather the hello started, so no 2.5s timer outlives the suite
        if(!_body||'nets' in _body) throw 'an empty gather must omit the field, never send []';
        _netPost=_oPost2; globalThis.fetch=_oFetch2; _netTimeSync=_oSync; _netHelloBusy=false;
        // Offline is offline: no STUN traffic from a client that opted out of the network.
        _reset(); cfg.offline=true; netNetsRefresh(true); cfg.offline=false;
        if(_pcN) throw 'an offline client must not open a peer connection';
        _reset();
        if(_oRtc===undefined) delete globalThis.RTCPeerConnection; else globalThis.RTCPeerConnection=_oRtc;
        log('public nets ok: private/mDNS/CGNAT dropped, one per family, srflx over host, TTL throttles the gather, hello carries or omits');
    }

    // The epoch MOVES with a rematch/level start. Missing that made the new round
    // SPRINT: startDuel rewinds simTick to 0 while the target was still measured from
    // the FIRST match's start_pts, so it sat thousands of ticks ahead and the loop ran
    // flat out at MAX_CATCHUP chasing it -- "the snakes were super-fast".
    fakeSess('peer'); inGame=true; _netSync={ofs:0, rtt:1, at:Date.now()};
    _netSess.startPts=netPts()-5000;                   // an old epoch: the last match's origin
    simTick=0; simNow=0;
    if(netTickTarget()<200) throw 'setup: the stale epoch should put the target ahead';
    const _newEpoch=netPts();   // capture: netPts() moves between calls
    _netHandleMsg(JSON.stringify({t:'go', why:'rematch', seed:0xABC, startPts:_newEpoch, epoch:1, lvl:1, bth:0}));
    if(_netSess.startPts!==_newEpoch) throw 'a rematch must MOVE the epoch, or the new round sprints to catch up';
    if(Math.abs(netTickTarget())>2) throw 'a fresh epoch must put the target at ~tick 0, got '+netTickTarget();
    _netSync={ofs:null, rtt:-1, at:0}; inGame=false; phase='menu'; _netTeardown();
    simTick=6000; simNow=simTick*TICK_MS;   // restore: the go handler ran startDuel, which rewinds both
    log('rematch epoch ok: a new start_pts moves tick zero with it');

    // A first-start go (why 'match') is refused while inGame -- a stale first-start must
    // never restart a running match. Sending a restart there meant P0 restarted and P1
    // silently ignored the message: "only one client restarts". A rematch go IS honoured
    // in game -- and the refusal must not consume the epoch, or the honoured boundary
    // that follows on the same epoch would read as a dedup repeat.
    fakeSess('peer'); inGame=true; _netSync={ofs:0, rtt:1, at:Date.now()};
    _netSess.startPts=netPts()-60000; phase='duelOver';
    const _e2=netPts();
    _netHandleMsg(JSON.stringify({t:'go', why:'match', seed:0xB0B, startPts:_e2, epoch:1, lvl:1, bth:0}));
    if(_netSess.startPts===_e2) throw 'setup: a why-match go must still be refused while in game';
    _netHandleMsg(JSON.stringify({t:'go', why:'rematch', seed:0xB0B, startPts:_e2, epoch:1, lvl:1, bth:0}));
    if(_netSess.startPts!==_e2) throw 'a rematch go must be honoured while in game, or only one client restarts';
    if((_netSess.epoch|0)!==1) throw 'the peer must adopt the pair epoch from the go';
    _netSync={ofs:null, rtt:-1, at:0}; inGame=false; phase='menu'; _netTeardown();
    simTick=6000; simNow=simTick*TICK_MS;
    log('in-game restart ok: rides go why:rematch (why:match is first-start only, refusal spends no epoch)');
    log('clock-driven ticking ok: tick follows the shared clock, none without a sync');

    // ---- ONLINE LEVEL-UP: a level boundary is a freshly negotiated start, like a rematch ----
    // Joiner nudges P0 (epoch-pinned req why:'level'); P0 owns the epoch bump + one start per
    // boundary (lvlPending). A go why:'level' carries the target level and score/lives roll on;
    // a go why:'rematch' is a full restart.
    const _oFetchL=globalThis.fetch; globalThis.fetch=()=>({});   // _netOk() must be TRUE or the host start no-ops

    // joiner press: raises the cover, nudges P0, does NOT start locally
    fakeSess('peer'); inGame=true; _netSync={ofs:0, rtt:1, at:Date.now()};
    sent.length=0; _netSess.epoch=2; _lvlCover=false;
    netRequestNextLevel();
    if(!_lvlCover) throw 'the presser must raise the get-ready cover at once';
    if(_netSess.lvlPending) throw 'a joiner must not start the level itself';
    { const _rq=JSON.parse(sent[sent.length-1]);
      if(_rq.t!=='req' || _rq.why!=='level' || (_rq.epoch|0)!==2) throw 'joiner must nudge P0 with an epoch-pinned req why:level'; }

    // host: acts on a matching-epoch req, ignores a stale one, folds repeats into one start
    fakeSess('host'); inGame=true; _netSync={ofs:0, rtt:1, at:Date.now()};
    _netSess.epoch=5; _netSess.lvlPending=false; _lvlCover=false;
    _netHandleMsg(JSON.stringify({t:'req', why:'level', epoch:4}));
    if(_netSess.lvlPending||_lvlCover) throw 'a stale-epoch req must be ignored';
    _netHandleMsg(JSON.stringify({t:'req', why:'level', epoch:5}));
    if(!_netSess.lvlPending) throw 'host must open the level on a matching-epoch req';
    if((_netSess.epoch|0)!==6) throw 'a level boundary must bump the epoch like a rematch';
    if(!_lvlCover) throw 'the host cover must rise when it opens the level';
    _netHandleMsg(JSON.stringify({t:'req', why:'level', epoch:6}));   // repeat, same boundary
    if((_netSess.epoch|0)!==6) throw 'lvlPending must fold a repeat start (no second epoch bump)';

    // joiner receives a level go: target level adopted, score + lives carry, lands on the get-ready
    fakeSess('peer'); inGame=true; _netSync={ofs:0, rtt:1, at:Date.now()};
    simTick=0; simNow=0; beginOnlineDuel(0xBEEF, false); bars=[];
    for(let i=0;i<80;i++){ netTickPre(); update(); }
    level=1; players[0].score=777; players[0].lives=2; players[1].score=123; players[1].lives=3;
    _netSess.epoch=0; _netSess.ctlEpoch=-1;
    _netHandleMsg(JSON.stringify({t:'go', why:'level', seed:0xBEEF, startPts:netPts(), epoch:1, lvl:2, bth:0}));
    if(level!==2) throw 'a level go must build the level it names, got '+level;
    if(players[0].score!==777||players[0].lives!==2) throw 'level-up must carry P0 score+lives';
    if(players[1].score!==123||players[1].lives!==3) throw 'level-up must carry P1 score+lives';
    if(phase!=='duelReady') throw 'level-up lands on the shared get-ready, got '+phase;

    // a rematch go is a FULL restart: level 1, score zeroed
    fakeSess('peer'); inGame=true; _netSync={ofs:0, rtt:1, at:Date.now()};
    simTick=0; simNow=0; beginOnlineDuel(0xBEEF, false); bars=[];
    for(let i=0;i<40;i++){ netTickPre(); update(); }
    level=3; players[0].score=999;
    _netSess.epoch=0; _netSess.ctlEpoch=-1;
    _netHandleMsg(JSON.stringify({t:'go', why:'rematch', seed:0xBEEF, startPts:netPts(), epoch:2, lvl:1, bth:0}));
    if(level!==1) throw 'a rematch go is a full restart: level resets to 1, got '+level;
    if(players[0].score!==0) throw 'a full restart must zero the score';
    globalThis.fetch=_oFetchL;
    _netSync={ofs:null, rtt:-1, at:0}; inGame=false; phase='menu'; _netTeardown();
    simTick=6000; simNow=simTick*TICK_MS; _lvlCover=false;
    log('online level-up ok: joiner nudges (epoch-pinned req), host owns one start/boundary, cover raised, level go carries score/lives vs rematch go full restart');

    // ---- PLAY AGAIN handshake (host restarts only when BOTH agreed) ----
    fakeSess('host'); sent.length=0;
    phase='duelOver'; duelWinner=0;
    netAgain();
    { const _ag=JSON.parse(sent[sent.length-1]);
      if(_ag.t!=='req' || _ag.why!=='again') throw 'netAgain must ship req why:again to the peer'; }
    if(phase!=='duelOver') throw 'host must wait for the peer before restarting';
    if(!netWaitingAgain()) throw 'waiting state not exposed to the UI';
    // A rematch needs a FRESH server-issued start moment, exactly like the first
    // match: with no server reachable there is no shared tick zero, so it is refused
    // rather than started on two timelines that would drift apart.
    _netHandleMsg(JSON.stringify({t:'req', why:'again', epoch:0}));
    if(_netSess!==null) throw 'both agreed but no server: the rematch must be refused, not started unsynced';
    log('rematch handshake ok: agreement relayed, refused without a server-issued start');

    // ---- REGRESSION: leaving an online duel must ALWAYS tear the session down ----
    // (a lingering session made netRemoteSim() discard every worker frame: single
    // player froze after quitting an online game -- the mobile PLAY bug)
    fakeSess('peer'); inGame=true; prevPhase='duel'; phase='quitConfirm'; quitConfirmSel=0;
    press('Enter');   // quit YES
    if(_netSess!==null) throw 'quit-YES did not tear the online session down';
    if(phase!=='duelMenu') throw 'quitting a 1vs1 must land on the 1vs1 menu, not main';
    if(netGameActive()) throw 'session queries stuck after quit';
    fakeSess('peer'); inGame=false; phase='menu';
    beginGame();      // starting any local game clears leftovers too
    if(_netSess!==null||netGameActive()) throw 'beginGame did not clear a lingering session';
    inGame=false; _wsend({t:'phase',phase:'menu'}); phase='menu';
    // and a remote end AFTER leaving must not hijack the UI
    fakeSess('peer'); inGame=false; phase='menu';
    _netHandleMsg(JSON.stringify({t:'bye'}));
    if(phase!=='menu') throw 'late bye must not yank the user out of the menu';
    if(_netSess!==null) throw 'late bye must still tear down';
    log('session lifecycle ok: quit/new-game/late-bye all clean');

    // ---- adaptive poll cadence: 1Hz in lobby/1vs1 menu + while connecting,
    // every 10th tick in the main menu, never in-game / elsewhere ----
    _netSess=null;
    phase='duelLobby';    if(!_netPollDue()) throw 'lobby must poll every tick';
    phase='multiplayer'; if(!_netPollDue()) throw 'multiplayer menu must poll every tick';
    phase='duelMenu';   if(!_netPollDue()) throw '1vs1 submenu must poll every tick';
    phase='menu';     _netPollTick=10; if(!_netPollDue()) throw 'main menu must poll every 10th tick';
    _netPollTick=11;  if(_netPollDue()) throw 'main menu must skip between 10s ticks';
    phase='playing';  if(_netPollDue()) throw 'no polling during a classic game';
    fakeSess('peer'); _netSess.game=false;   // session exists but the channel is not open yet
    if(!_netPollDue()) throw 'connecting (signaling in flight) must poll';
    _netSess.game=true; if(_netPollDue()) throw 'no polling during an online game';
    // ...UNLESS somebody is trying to WATCH it. Every leg of the watch handshake is a signal
    // and the node being asked is always a node in a match, so the slow cadence lands on
    // exactly the client that has to answer fastest: three legs at a fifth of the rate
    // outlive the ask itself, the feed never starts, and the watcher sits on CONNECTING for
    // the whole match with nothing wrong at either end for any ladder to find.
    phase='duel'; const oTt=_tt; _tt={tid:'t1',state:'running',players:[]}; _netPollTick=1;
    if(_netPollDue()) throw 'a tournament match polls every 5th tick, not every one';
    _spAsk.push({from:'00ff00aa', at:_spNow()});
    if(!specHandshaking()) throw 'a parked watch ask is a handshake in flight';
    if(!_netPollDue()) throw 'a parked watch ask must put the mailbox back to 1Hz';
    _spAsk.length=0;
    // The gap between answering ok and the offer it invites: no link, no ask, no want to
    // point at -- and the one leg a slow mailbox stretches furthest.
    _spOkAt=_spNow();
    if(!_netPollDue()) throw 'the wait for an invited offer must poll at 1Hz';
    _spOkAt=0;
    if(_netPollDue()) throw 'nothing outstanding: back to the slow tournament cadence';
    _tt=oTt;
    _spAsk.push({from:'00ff00aa', at:_spNow()});
    if(!_netPollDue()) throw 'a watched 1vs1 must poll for the handshake it owes';
    _spAsk.length=0;
    // ...and an ORDINARY duel keeps the slow cadence for the same reason the tournament one
    // does: the ask that starts a watch has nowhere to arrive but this mailbox, so a match
    // that never polls is a match nobody can ever begin watching.
    if(_netPollDue()) throw 'a duel polls every 5th tick, not every one';
    _netPollTick=5;
    if(!_netPollDue()) throw 'a duel that never polls can never be asked to be watched';
    _netSess=null; phase='menu';
    log('adaptive poll ok: 1Hz lobby/1vs1 + connecting, 10s main menu, never in-game -- except while somebody is trying to watch');

    // ---- a spectator boot with no shared clock WAITS for one ----
    // The context is good while we wait: match constants, plus a tick base quoted on that
    // very clock. Dropping it cost the whole feed -- the link stayed open and subscribed, the
    // feeder went on serving it, and every envelope was discarded one layer up.
    const oOfs=_netSync.ofs; _netSync.ofs=null;
    _spCtx={t:'sctx',g:0,hops:1,pids:['00000001','00000002'],seed:1,startPts:0,ep:0,hm:3,lvl:1};
    _spBootTry=0; _spBoot();
    if(!_spCtx) throw 'a boot with no shared clock must keep the context, not throw the feed away';
    if(_spBootT==null) throw 'a boot with no shared clock must arm a retry';
    clearTimeout(_spBootT); _spBootT=null; _spCtx=null; _spQ=[]; _spBootTry=0; _netSync.ofs=oOfs;
    // ...and the housekeeping that drives that retry must outlive an unbooted link.
    window.setInterval=(f,ms)=>({f:f,ms:ms}); window.clearInterval=()=>{};   // the sandbox has none
    _spArm(); _spIn.push({peer:'00ff00aa', pc:null, dc:null, dead:false, sub:true, iceQ:[]});
    _spTick();
    if(_spT==null) throw 'housekeeping must not stop under a link that has not booted yet';
    _spIn.length=0; _spTick();
    if(_spT!=null) throw 'with nothing in flight at all the housekeeping must stop';
    delete window.setInterval; delete window.clearInterval;
    log('spectator reach ok: a watched match polls for the handshake it owes, and a boot waiting on the clock keeps its feed');

    // ---- mutual invites: deterministic auto-accept, no dialog ----
    localStorage.setItem('fok-snake-pid','00000001');   // our ID < the peer's
    phase='duelLobby'; _netLb.invite=null; _netHs.sent='00ff00aa'; _netHs.sentAt=Date.now();
    _netOnSignal({from:'00ff00aa', type:'duelInvite', payload:'{}'});
    if(_netLb.invite) throw 'mutual invite must not open a dialog';
    if(_netHs.sent!==null) throw 'smaller ID must auto-accept (sent cleared)';
    if(_netLb.msg.indexOf('MUTUAL')!==0) throw 'missing mutual-invite feedback';
    localStorage.setItem('fok-snake-pid','ffffffff');   // our ID > the peer's
    _netHs.sent='00ff00aa'; _netLb.msg='';
    _netOnSignal({from:'00ff00aa', type:'duelInvite', payload:'{}'});
    if(_netLb.invite) throw 'larger ID must not open a dialog either';
    if(_netHs.sent!=='00ff00aa') throw 'larger ID keeps waiting for the accept';
    log('mutual invite ok: tie-broken auto-accept');

    // ---- presence deltas (4.6): one landing place, a cursor, a cap that continues at once ----
    {
        const _oGetD=_netGet; let _urls=[], _bgD=[];
        _netGet=async (p,sig,held,bg)=>{ _urls.push(p); _bgD.push(bg); return null; };
        _netFriendsOnline={}; _netFriendsLat={}; _netFriendsPlaying={}; _netFrSince=0; _netFrPages=0;
        _netFr.list=[{id:'00ff00aa', state:'accepted', online:false, latency:null}];
        // A delta entry is the friend's whole state: online, latency, playing and name land
        // in the maps AND on the roster row the friends screen draws; counters ride along.
        _netFrApply({ok:true, online:5, playing:2, friends_at:1000,
                     friends_delta:{'00ff00aa':{online:true, playing:true, latency:31, name:'KAI'},
                                    '00ff00bb':{online:false, playing:false, latency:null, name:'BOB'}}});
        if(_netFriendsOnline['00ff00aa']!==true || _netFriendsLat['00ff00aa']!==31 || !netFriendPlaying('00ff00aa')) throw 'an online delta must land whole in the maps';
        if(_netFriendsOnline['00ff00bb']!==false || _netFriendsLat['00ff00bb']!==null || netFriendPlaying('00ff00bb')) throw 'an offline delta must land whole in the maps';
        if(_netFr.list[0].online!==true || _netFr.list[0].latency!==31) throw 'the roster row must carry the delta too';
        if(netFriendName('00ff00aa')!=='KAI') throw 'a delta name must be learned';
        if(_netCounts.online!==5 || _netCounts.playing!==2) throw 'the counters must ride the same answer';
        if(_netFrSince!==1000) throw 'the cursor must be the server friends_at, got ' + _netFrSince;
        if(_urls.length) throw 'friends_more false must not ask for more';
        // A 204 (or a poll with no delta) changes nothing: the cursor stands.
        _netFrApply({ok:true, signals:[]}); _netFrApply(null);
        if(_netFrSince!==1000 || _netFriendsOnline['00ff00aa']!==true) throw 'an empty answer must leave the cursor and the maps alone';
        // A later delta for the same friend overrides blind: offline wins over the stale online.
        _netFrApply({ok:true, friends_at:2000, friends_delta:{'00ff00aa':{online:false, playing:true, latency:5, name:'KAI'}}});
        if(_netFriendsOnline['00ff00aa']!==false || _netFriendsLat['00ff00aa']!==null || netFriendPlaying('00ff00aa')) throw 'a newer delta must override the older state whole';
        if(_netFrSince!==2000) throw 'the cursor must advance';
        // friends_more: the cap cut the page. The continuation goes out AT ONCE with the new
        // cursor, unheld, on the solo lane -- never beside another request of ours.
        _netFrApply({ok:true, friends_at:3000, friends_more:true, friends_delta:{}});
        if(_urls.length!==1 || !/poll[.]php[?]id=[0-9a-f]{8}&fs=3000$/.test(_urls[0])) throw 'friends_more must continue at once from the new cursor, got ' + JSON.stringify(_urls);
        if(_bgD[0]!==NET_BG_SOLO) throw 'the continuation must take the solo lane, got ' + String(_bgD[0]);
        // ...bounded: a server that never stops saying more gets the next tick, not a hot loop.
        _urls=[]; _netFrPages=0;
        for(let i=0;i<20;i++) _netFrApply({ok:true, friends_at:4000+i, friends_more:true, friends_delta:{}});
        if(_urls.length!==NET_FR_PAGES) throw 'the continuation must be bounded at ' + NET_FR_PAGES + ' pages, sent ' + _urls.length;
        _netFrApply({ok:true, friends_at:9000, friends_more:false, friends_delta:{}});
        if(_netFrPages!==0) throw 'a page that fits must reset the continuation budget';
        // A presence screen opening forgets the cursor: the first read is the whole roster.
        netPresenceOpen();
        if(_netFrSince!==0) throw 'opening a presence screen must reset the cursor to 0';
        _netFrSince=5; netOfflineClear();
        if(_netFrSince!==0) throw 'going offline must reset the cursor';
        _netGet=_oGetD; _netFr.list=null; _netFriendsOnline={}; _netFriendsLat={}; _netFriendsPlaying={}; _netFrSince=0; _netFrPages=0;
        log('presence deltas ok: whole-state entries land in the maps and the roster, cursor follows friends_at, more continues at once on the solo lane, bounded');
    }

    // ---- a stale invite: delivered after its sender gave up, refused on arrival ----
    // The server keeps a signal for its whole online window (120 s from 4.5); the inviter
    // stops waiting at NET_INVITE_STALE_MS. What arrives after that is answered by nobody:
    // no dialog, and no decline either -- the sender stopped listening long ago.
    phase='duelLobby'; _netHsClear(); _netLb.invite=null; _netLb.msg='';
    _netSync={ofs:null, rtt:-1, at:0}; _netDbg.srvOfs=0;   // no server clock: the wall clock reads the stamp
    const _nowS=Math.floor(Date.now()/1000);
    if(!_netSigStale({created:_nowS-1000})) throw 'a signal stamped 1000 s ago must read as stale';
    if(_netSigStale({created:_nowS}) || _netSigStale({}) || _netSigStale({created:0})) throw 'a fresh, unstamped or zero-stamped signal must never read as stale';
    const _oSigS=_netSignal; let _declined=0;
    _netSignal=(to,type)=>{ if(type==='decline') _declined++; return Promise.resolve({json:null}); };
    _netOnSignal({from:'00ff00aa', type:'duelInvite', payload:'{}', created:_nowS-1000});
    if(_netLb.invite) throw 'a stale invite must not open a dialog';
    if(_declined) throw 'a stale invite must not be declined either';
    _netOnSignal({from:'00ff00aa', type:'duelInvite', payload:'{}', created:_nowS});
    if(!_netLb.invite) throw 'a fresh stamped invite must still open the dialog';
    _netLb.invite=null; _netSignal=_oSigS;
    log('stale invite ok: refused on arrival by its stamp, fresh and unstamped ones unaffected');

    // ---- undelivered receipt: an attempt the peer never collected fails FAST ----
    phase='duelLobby'; _netHsClear(); _netHs.sent='00ff00aa'; _netHs.sentAt=Date.now(); _netLb.msg='';
    _netOnSignal({from:'00ff00aa', type:'undelivered', payload:JSON.stringify({event:'undelivered', peer:'00ff00aa', type:'duelInvite'})});
    if(_netHs.sent!==null) throw 'undelivered must stop waiting on the sent invite';
    if(_netLb.msg.indexOf('OFFLINE')<0) throw 'undelivered must tell the user the peer is unreachable';
    _netHsClear(); _netHs.accepting='00ff00bb'; _netHs.acceptingAt=Date.now(); _netLb.msg='';
    _netOnSignal({from:'00ff00bb', type:'undelivered', payload:JSON.stringify({event:'undelivered', peer:'00ff00bb', type:'accept'})});
    if(_netHs.accepting!==null) throw 'undelivered must clear a pending accept';
    _netHsClear(); _netLb.msg='KEEP';
    _netOnSignal({from:'00ff00cc', type:'undelivered', payload:JSON.stringify({event:'undelivered', peer:'00ff00cc', type:'duelInvite'})});
    if(_netLb.msg!=='KEEP') throw 'undelivered for an unrelated peer must not touch the UI';
    log('undelivered receipt ok: sent invite/accept fail fast, unrelated ignored');

    // ---- event sfx are queued 2 engine ticks, corrections cancel predicted ones ----
    _sfxQ.length=0; simTick=1000;
    simEvents=[{t:'sfx',name:'eat'}]; drainSimEvents();
    if(_sfxQ.length!==1) throw 'sfx not queued';
    flushSfxQ(); if(_sfxQ.length!==1) throw 'sfx played too early (needs 2 ticks)';
    simTick=1002; flushSfxQ();
    if(_sfxQ.length!==0) throw 'sfx not played after 2 ticks';
    log('delayed sfx ok: 2-tick queue');

    // ---- PTS layer: a shared clock is a PRECONDITION of the match, not a nicety ----
    // Both sims live on one tick timeline (start_pts + tick count). Starting without
    // a verified sync does not mean "slightly off" -- it means the two clients are
    // simulating different games. So there is no unsynced fallback: it refuses.
    if(netPts()!==null) throw 'netPts must be null before any sync';
    fakeSess('peer'); sent.length=0; inGame=false;
    _netHandleMsg(JSON.stringify({t:'go', why:'match', seed:0xFEED, startPts:null, epoch:0, lvl:1, bth:0}));
    if(inGame) throw 'a start without a shared clock must be refused, not begun';
    if(_netSess!==null) throw 'refusing must end the attempt, not leave it half-open';
    fakeSess('peer'); sent.length=0; inGame=true;
    _netSync={ofs:0, rtt:1, at:Date.now()};   // fake a perfect sync
    _netSend({ t:'pi' });                     // any peer message: every one stamps PTS
    const _pk=JSON.parse(sent[sent.length-1]);
    if(typeof _pk.pts!=='number') throw 'synced peers must stamp PTS on every message';
    if(!Number.isInteger(_pk.pts)) throw 'pts must be whole ms: PHP is_int() rejects a fraction';
    _netHandleMsg(JSON.stringify({t:'pi', pts:netPts()-42}));
    if(Math.round(_netDbg.lag)<40||Math.round(_netDbg.lag)>50) throw 'lag estimate broken: '+_netDbg.lag;
    // The peer PTS delta, averaged: a separate figure from the server-RTT latency we
    // report. One sample is noise; the average over the window is the honest number.
    _netLagN.length=0;
    _netHandleMsg(JSON.stringify({t:'pi', pts:netPts()-20}));
    _netHandleMsg(JSON.stringify({t:'pi', pts:netPts()-60}));
    if(_netDbg.lagN!==2) throw 'both samples must enter the window';
    if(Math.abs(_netDbg.lagAvg-40)>2) throw 'pts delta average wrong: '+_netDbg.lagAvg;
    if(Math.abs(_netDbg.lagMin-20)>2||Math.abs(_netDbg.lagMax-60)>2) throw 'pts delta min/max wrong';
    if(typeof netDebugInfo().peerPtsDeltaAvgMs!=='number') throw 'pts delta missing from the debug export';
    // A new match is a new path: the old one must not pollute the average.
    _rbReset();
    if(_netDbg.lagN!==0 && _netLagN.length!==0) throw 'the window must reset with the match';
    // Future-dated beyond the tolerance: impossible for an honest peer -> dropped.
    // But it must still be MEASURED: a delta negative enough to be rejected IS the
    // broken anchor, and a statistic that hides its own worst evidence reads healthy
    // while the thing it exists to catch is happening.
    const _d0=_rbDbg.drop; _netLagN.length=0;
    _netHandleMsg(JSON.stringify({t:'pi', pts:netPts()+NET_PTS_TOL+500}));
    if(_rbDbg.drop!==_d0+1) throw 'a future-dated packet must be dropped';
    if(_netDbg.lagN!==1) throw 'a rejected packet must still enter the pts-delta window, or the average is survivorship-biased';
    if(!(_netDbg.lagAvg < 0)) throw 'a future-dated packet must show as a NEGATIVE delta, not vanish';
    _netLagN.length=0;
    // ...but a stamp inside the tolerance is honest jitter and must NOT be dropped.
    _netHandleMsg(JSON.stringify({t:'pi', pts:netPts()+Math.round(NET_PTS_TOL/2)}));
    if(_rbDbg.drop!==_d0+1) throw 'a stamp within tolerance must be accepted: we compare against an ESTIMATE';
    _netSync={ofs:null, rtt:-1, at:0};
    inGame=false; _wsend({t:'phase',phase:'menu'}); phase='menu'; _netTeardown();
    log('pts layer ok: sync required to start, whole-ms stamping, future drops, tolerance honoured');

    // ---- latency figure (optional, display-only): >=3 samples, extreme first discarded ----
    if(_netLatFromSamples([20,22])!==null) throw 'fewer than 3 samples must not report';
    if(_netLatFromSamples([200,20,22,21,19])!==Math.round((20+22+21+19)/4)) throw 'extreme first sample must be discarded';
    if(_netLatFromSamples([25,20,22])!==Math.round((25+20+22)/3)) throw 'normal first sample must be kept';
    // friends e2e estimate: their reported half plus our half, one way each
    _netLat={value:30, at:1, pending:false}; _netFriendsLat={'00ff00aa':50};
    if(netFriendE2E('00ff00aa')!==40) throw 'e2e estimate wrong: '+netFriendE2E('00ff00aa');
    if(netFriendE2E('00ff00bb')!==null) throw 'no report -> no estimate';
    localStorage.setItem('fok-snake-friends', JSON.stringify(['00ff00aa','00ff00bb']));
    _netFriendsOnline={'00ff00aa':true}; phase='duelLobby'; drawDuelLobby();   // renders with the ms figure
    localStorage.removeItem('fok-snake-friends');
    _netLat={value:null, at:0, pending:false}; _netFriendsLat={}; phase='menu';
    log('latency figure ok: sampling rule, e2e estimate, lobby render');

    // ---- API version gate: a newer server contract disables online cleanly ----
    _netApiNewer=true;
    if(_netOk()) throw 'newer server contract must gate _netOk';
    netSubmitScore('X', 10, 1); netFetchScores();   // all soft no-ops
    phase='duelLobby'; drawDuelLobby();                     // renders the reload notice
    _netApiNewer=false; phase='menu';
    log('api version gate ok');

    // ---- identical-rules handshake: a version mismatch never starts a match ----
    phase='duelLobby'; _netLb.msg='';
    _netOnSignal({from:'00ff00aa', type:'offer', payload:JSON.stringify({sdp:{}, seed:7, v:'v0.0.0-other'})});
    if(_netSess!==null) throw 'mismatched offer must not create a session';
    if(_netLb.msg.indexOf('VERSION MISMATCH')!==0) throw 'missing version-mismatch notice';
    _netLb.msg=''; phase='menu';
    log('version handshake ok: mismatched clients refuse to duel');

    // ---- friend names: learned from every received profile, shown in the lobby ----
    localStorage.removeItem('fok-snake-friend-names'); _netFriendNames={};
    phase='duelLobby'; _netLb.invite=null; _netHsClear();
    _netOnSignal({from:'00ff00aa', type:'duelInvite', payload:JSON.stringify({profile:{name:'BUDDY',color:1}})});
    if(netFriendName('00ff00aa')!=='BUDDY') throw 'invite profile did not teach the name';
    if(JSON.parse(localStorage.getItem('fok-snake-friend-names'))['00ff00aa']!=='BUDDY') throw 'name not persisted';
    _netLb.invite=null;
    localStorage.setItem('fok-snake-friends', JSON.stringify(['00ff00aa']));
    drawDuelLobby();   // renders NAME + ID
    localStorage.removeItem('fok-snake-friends'); localStorage.removeItem('fok-snake-friend-names');
    _netFriendNames={}; phase='menu';
    log('friend names ok: learned from profiles, persisted, rendered');

    // ---- in-game names: HUD labels + winner banner use them online ----
    localStorage.setItem('lastSName','KAI'); netNameChanged();   // direct write: the name-entry hook is bypassed
    simTick=0; simNow=0; startDuel(0xC0DE); bars=[];
    fakeSess('host'); _netSess.peerProfile={name:'BUDDY',color:1,shopItems:{}};
    const pn=netPlayerNames();
    if(pn[0]!=='KAI'||pn[1]!=='BUDDY') throw 'player names wrong: '+JSON.stringify(pn);
    inGame=true; updateHUD(); inGame=false;   // labels adopt the names without error (inGame gates duel content)
    phase='duelOver'; duelWinner=1; drawDuelBoard(simNow);   // banner: BUDDY WINS!
    _netTeardown(); inGame=false; _wsend({t:'phase',phase:'menu'}); phase='menu';
    localStorage.removeItem('lastSName');
    log('in-game names ok: HUD labels + winner banner');

    // ---- HUD clears on leaving a 1vs1 (regression): a stale players mirror must not paint duel names on a menu ----
    simTick=0; simNow=0; startDuel(0xBEEF); bars=[];
    inGame=true; updateHUD();
    if(_hudAL.textContent==='LIVES ') throw 'in a live duel the HUD must show a name, not LIVES';
    inGame=false; phase='menu'; updateHUD();   // left to the menu (mirror may still be set); HUD must revert to classic
    if(_hudAL.textContent!=='LIVES ') throw 'HUD stuck in duel mode on the menu: '+_hudAL.textContent;
    _wsend({t:'phase',phase:'menu'});          // harness has no worker -> simCommand clears the mirror
    log('hud clears on menu: duel content needs a live session, not just a stale players mirror');

    // ---- platform tag (API 3.4): device category on the global board + duel profile ----
    // Best-effort detect (server whitelists pc/mobile/tv/console, nulls anything else),
    // so it must always yield one of the four and ride both the score submit and the
    // exchanged duel profile. A peer that sends none is a null badge, never invented.
    const _PLATS=['pc','mobile','tv','console'];
    if(_PLATS.indexOf(_detectPlatform())<0) throw 'platform must be one of pc/mobile/tv/console, got '+_detectPlatform();
    if(_netProfile().platform!==_detectPlatform()) throw 'the exchanged profile must carry the detected platform';
    if(_netClampProfile({platform:'tv'}).platform!=='tv') throw 'clamp must keep a string platform';
    if(_netClampProfile({platform:42}).platform!==null) throw 'clamp must null a non-string platform';
    if(_netClampProfile({}).platform!==null) throw 'clamp must null a missing platform';
    let _scoreBody=null; const _oPost2=_netPost, _oFetch2=globalThis.fetch;
    globalThis.fetch=()=>({ then:()=>({ catch:()=>{} }) });
    _netPost=async(path,body)=>{ if(path.indexOf('scores')>=0) _scoreBody=body; return null; };
    cfg.offline=false; _netApiNewer=false;
    netSubmitScore('KAI', 500, 3, false);
    if(!_scoreBody || _PLATS.indexOf(_scoreBody.platform)<0) throw 'score submit must tag a valid platform: '+(_scoreBody&&_scoreBody.platform);
    _netPost=_oPost2; globalThis.fetch=_oFetch2;
    // That stub is a thenable that never settles, so any request it swallowed is still
    // counted as in flight. Nothing in a browser behaves that way -- fetch rejects on a
    // dead link -- so clear the fiction rather than let it make the wire look busy for
    // every clock sample the rest of this suite takes.
    _netFlight=0;
    simTick=0; simNow=0; startDuel(0xF00D); bars=[];
    fakeSess('host'); _netSess.peerProfile={name:'BUD',color:1,shopItems:{},platform:'mobile'};
    const _dp=netDuelPlatforms();
    if(!_dp||_dp[0]!==_detectPlatform()||_dp[1]!=='mobile') throw 'duel platforms wrong (host order): '+JSON.stringify(_dp);
    phase='duelReady'; phaseAt=simNow; drawDuelBoard(simNow);   // the ready-splash badges render
    _netSess.peerProfile={name:'BUD',color:1,shopItems:{}};      // an older peer sends no platform
    if(netDuelPlatforms()[1]!==null) throw 'a peer without a platform must be null, not invented';
    drawDuelBoard(simNow);                                       // one blank side still renders
    _netTeardown(); inGame=false; _wsend({t:'phase',phase:'menu'}); phase='menu';
    log('platform tag ok: detect->one of four, profile + score wire, clamp whitelist, duel host/joiner order');

    // ---- FRIENDS screen: rows merge server + local, accept/remove flows ----
    simNow=100000; simTick=6000; _splashLeftAt=-1e9;   // past the post-splash input guard again
    localStorage.setItem('fok-snake-friends', JSON.stringify(['00ff00aa','00ff00bb']));
    phase='multiplayer'; multiSel=4; press('Enter');
    if(phase!=='friends') throw 'FRIENDS entry did not open the screen';
    let rows=_netFrRows();
    if(rows.length!==2||rows[0].state!=='local') throw 'offline rows must show the local list';
    drawFriends();
    // remove: local safety confirm (server removal itself is auto-confirmed)
    localStorage.removeItem('fok-snake-friend-rm');
    _netFr.sel=0; press('Enter');
    if(_netFr.confirm!=='00ff00aa') throw 'remove must open the local confirm';
    drawFriends();                        // confirm dialog renders
    press('ArrowLeft'); press('Enter');   // YES
    if(getFriends().includes('00ff00aa')) throw 'friend not removed after YES';
    // server list drives states incl. incoming requests
    _netFr.list=[{id:'00ff00bb',state:'accepted',outgoing:false,name:'BUD',online:true,latency:12},
                 {id:'00ff00cc',state:'pending',outgoing:false,name:'NEW',online:true,latency:5}];
    rows=_netFrRows();
    if(rows.length!==2||rows[1].state!=='pending'||rows[1].outgoing) throw 'server rows wrong';
    drawFriends();
    press('Escape');
    if(phase!=='multiplayer') throw 'friends ESC did not return';
    _netFr.list=null; localStorage.removeItem('fok-snake-friends'); localStorage.removeItem('fok-snake-friend-rm');
    phase='menu';
    log('friends screen ok: merge, remove confirm, states, nav');

    // ---- API compliance: auto_accept flag, friend expired event ----
    // (a) auto_accept present in the hello body only on the QR / add-friend surfaces
    localStorage.setItem('lastSName','KAI');
    let _helloBody=null; const _origPost=_netPost, _origFetch=globalThis.fetch;
    globalThis.fetch = ()=>({ then:()=>({ catch:()=>{} }) });   // presence check only (typeof fetch === function)
    _netPost = async (path, body)=>{ if(path.indexOf('hello')>=0) _helloBody=body; return null; };
    cfg.offline=false; _netMyIdAt=0;
    phase='myId'; _netHelloBusy=false; _netHello();
    if(!_helloBody || _helloBody.auto_accept!==true) throw 'auto_accept must be set on the MY ID screen';
    _helloBody=null; phase='menu'; _netHelloBusy=false; _netHello();
    if(_helloBody && _helloBody.auto_accept) throw 'auto_accept must NOT be set in the main menu';
    _netPost=_origPost; globalThis.fetch=_origFetch;
    // (b) a friend 'expired' event removes the friend locally, no celebration
    localStorage.setItem('fok-snake-friends', JSON.stringify(['00ff00aa'])); confetti.length=0; _netFr.msg='';
    _netOnSignal({from:'', type:'friend', payload:JSON.stringify({event:'expired', from:'00ff00aa'})});
    if(getFriends().includes('00ff00aa')) throw 'expired friend must be removed locally';
    if(confetti.length) throw 'expired must NOT celebrate';
    if(_netFr.msg.indexOf('NO LONGER')<0) throw 'expired needs a plain notice';
    localStorage.removeItem('fok-snake-friends'); localStorage.removeItem('lastSName'); _netFr.msg=''; phase='menu';
    log('compliance ok: auto_accept flag scoped, friend expired handled');

    // ---- friendship notifications: QR-style celebration on both sides ----
    localStorage.removeItem('fok-snake-friends');
    confetti.length=0; _netFr.msg=''; _duelMsg=''; phase='menu';
    _netOnSignal({from:'', type:'friend', payload:JSON.stringify({event:'request', from:'00ff00aa'})});
    if(_netFr.msg.indexOf('ADDED YOU AS A FRIEND')<0) throw 'request notification text missing';
    if(!confetti.length) throw 'request notification must celebrate (confetti)';
    if(_duelMsg!==_netFr.msg) throw 'notification must surface on the 1vs1 menu too';
    confetti.length=0;
    _netOnSignal({from:'00ff00bb', type:'friend', payload:JSON.stringify({event:'accepted', from:'00ff00bb'})});
    if(_netFr.msg.indexOf('YOU ARE FRIENDS')<0) throw 'accepted notification text missing';
    if(!getFriends().includes('00ff00bb')) throw 'accepted event must add the friend locally';
    if(!confetti.length) throw 'accepted notification must celebrate';
    _netOnSignal({from:'', type:'friend', payload:JSON.stringify({event:'bogus', from:'00ff00cc'})});
    if(getFriends().includes('00ff00cc')) throw 'unknown friend events must be ignored';
    confetti.length=0; localStorage.removeItem('fok-snake-friends'); _netFr.msg=''; _duelMsg='';
    log('friend notifications ok: request + accepted celebrate, bogus ignored');

    // ---- ONE status notice, identical on every online screen; the api gate
    // re-evaluates instead of latching forever ----
    cfg.offline=true;
    if(netStatusNotice()!=='OFFLINE MODE (SETTINGS > NETWORK)') throw 'offline notice wrong';
    cfg.offline=false; _netApiNewer=true; _netSrvErr=true;
    if(netStatusNotice()!=='GAME UPDATE REQUIRED - PLEASE RELOAD') throw 'api notice must outrank unreachable';
    _netApiNewer=false;
    if(netStatusNotice()!=='SERVER UNREACHABLE - RETRYING') throw 'unreachable notice wrong';
    phase='duelLobby'; drawDuelLobby(); phase='friends'; drawFriends();   // both render the SAME string
    _netSrvErr=false;
    if(netStatusNotice()!==null) throw 'healthy state must show no notice';
    phase='menu';
    log('status notice ok: shared, prioritized, self-healing');

    // ---- MY ID: shows the friend notification and renders name columns cleanly ----
    phase='myId';
    _netFr.msg='SOMEONE ADDED YOU AS A FRIEND'; drawMyId();
    _netFr.msg=''; drawMyId();
    localStorage.setItem('fok-snake-friend-names', JSON.stringify({'00ff00aa':'AVERYLONGNAME15'}));
    _netFriendNames=JSON.parse(localStorage.getItem('fok-snake-friend-names'));
    localStorage.setItem('fok-snake-friends', JSON.stringify(['00ff00aa']));
    phase='friends'; _netFr.sel=0; drawFriends();   // truncated name column renders
    phase='duelLobby'; drawDuelLobby();
    localStorage.removeItem('fok-snake-friends'); localStorage.removeItem('fok-snake-friend-names');
    _netFriendNames={}; phase='menu';
    log('row layout ok: centered ID, truncated name column, my-id notification');

    // ---- QR auto-confirm: a request arriving while OUR QR shows accepts itself ----
    localStorage.removeItem('fok-snake-friends');
    _netMyIdAt=Date.now(); phase='myId'; _netFr.msg='';
    _netOnSignal({from:'', type:'friend', payload:JSON.stringify({event:'request', from:'00ff00dd'})});
    if(!getFriends().includes('00ff00dd')) throw 'QR-window request must auto-friend';
    if(_netFr.msg.indexOf('YOU ARE FRIENDS')<0) throw 'auto-confirm must celebrate as friends';
    _netMyIdAt=0; phase='menu'; _netFr.msg='';
    _netOnSignal({from:'', type:'friend', payload:JSON.stringify({event:'request', from:'00ff00ee'})});
    if(getFriends().includes('00ff00ee')) throw 'requests outside the QR window stay manual';
    if(_netFr.msg.indexOf('ADDED YOU AS A FRIEND')<0) throw 'manual path lost its notification';
    localStorage.removeItem('fok-snake-friends'); _netFr.msg='';
    log('qr auto-confirm ok: friends while presenting, manual otherwise');

    // ---- invites surface on 1vs1/social screens; elsewhere they auto-decline ----
    for(const ph of ['multiplayer','duelMenu','friends','myId']){
        phase=ph; _netLb.invite=null; _netSess=null;
        _netOnSignal({from:'00ff00aa', type:'duelInvite', payload:JSON.stringify({profile:{name:'PEER'}})});
        if(phase!=='duelLobby'||!_netLb.invite) throw 'invite must surface from '+ph;
        _netLb.invite=null;
    }
    for(const ph of ['menu','settings','playing']){
        phase=ph;
        _netOnSignal({from:'00ff00aa', type:'duelInvite', payload:JSON.stringify({profile:{name:'PEER'}})});
        if(_netLb.invite) throw 'invite must auto-decline in '+ph;
    }
    phase='menu';
    log('invite reception ok: social screens surface, elsewhere auto-decline');

    // ---- withdraw: leaving the lobby with a pending invite tells the invitee,
    // and a bye closes a still-open ACCEPT dialog (so re-invites are not blocked) ----
    phase='duelLobby'; _netLb.invite={from:'00ff00aa', profile:{name:'X',color:0,shopItems:{}}}; _netLb.msg='';
    _netOnSignal({from:'00ff00aa', type:'bye', payload:''});
    if(_netLb.invite) throw 'a bye must close a pending ACCEPT dialog';
    if(_netLb.msg.indexOf('WITHDRAWN')<0) throw 'withdrawn invite needs a notice';
    _netLb.msg=''; phase='menu';
    log('invite withdraw ok: bye closes the dialog, re-invite unblocked');

    // ---- universal teardown: EVERY leftover state is reaped on lobby transitions ----
    // (1) a relay session that reached game=true but is not on-screen (inGame=false)
    _netSess=_netMkSess('00ff00aa','peer'); _netSess.relay=true; _netSess.game=true; inGame=false;
    phase='duelLobby'; netLobbyLeave();
    if(_netSess!==null) throw 'a not-yet-playing relay session must be reaped';
    // (2) a P2P session still negotiating (game=false) with mock RTC objects closed
    let _pcC=false,_dcC=false;
    _netSess=_netMkSess('00ff00bb','host'); _netSess.pc={close(){_pcC=true;}}; _netSess.dc={close(){_dcC=true;}};
    phase='duelLobby'; netLobbyLeave();
    if(_netSess!==null||!_pcC||!_dcC) throw 'a negotiating session must be reaped + RTC closed';
    // (3) a pending SENT invite is withdrawn on leave
    phase='duelLobby'; _netHsClear(); _netHs.sent='00ff00cc'; _netSess=null; inGame=false;
    netLobbyLeave();
    if(_netHs.sent!==null) throw 'a pending sent invite must be withdrawn on leave';
    // (4) a received invite dialog is dismissed on leave
    phase='duelLobby'; _netLb.invite={from:'00ff00dd',profile:{name:'X',color:0,shopItems:{}}};
    netLobbyLeave();
    if(_netLb.invite!==null) throw 'a received invite must be dismissed on leave';
    // (5) entering the lobby also reaps a stray session so new invites are received
    _netSess=_netMkSess('00ff00ee','peer'); _netSess.game=true; inGame=false;
    netLobbyEnter();
    if(_netSess!==null) throw 'entering the lobby must reap a stray session';
    // a genuine running game (inGame) is NOT touched by lobby transitions
    _netSess=_netMkSess('00ff00ff','host'); _netSess.game=true; inGame=true;
    netLobbyEnter(); netLobbyLeave();
    if(_netSess===null) throw 'a running on-screen game must not be reaped';
    _netTeardown(); inGame=false; phase='menu';
    log('universal teardown ok: sessions/invites/dialogs all reaped, running game kept');

    // ---- HANDSHAKE RESILIENCE (the restructure): every case below silently
    // destroyed a connection attempt before _netHs existed. ----
    cfg.offline=false; inGame=false;
    // (1) navigation must NOT wipe an in-flight handshake nor bye the peer
    _netHsClear(); _netSess=null; _netHs.sent='00ff00aa'; _netHs.sentAt=Date.now(); _netHs.sentRelay=true;
    phase='multiplayer'; netLobbyEnter(); phase='duelLobby';
    if(_netHs.sent!=='00ff00aa') throw 'entering a screen must not wipe the handshake';
    // ...and the peer's accept is then still recognised (was dropped forever)
    _netOnSignal({from:'00ff00aa', type:'accept-relay', payload:JSON.stringify({profile:{name:'P'}})});
    if(!_netSess||_netSess.role!=='host') throw 'accept after navigation must still produce an offer';
    if(!_netHs.offerTo) throw 'the offer must be remembered for re-send';
    _netTeardown(); _netHsClear();
    // (2) an offer arriving OFF the lobby screen is honoured (phase guard gone)
    phase='multiplayer'; _netSess=null;
    _netOnSignal({from:'00ff00bb', type:'offer', payload:JSON.stringify({seed:9, profile:{name:'Q'}})});
    if(!_netSess||_netSess.role!=='peer') throw 'an offer off the lobby screen must still connect';
    if((_netSess.seed>>>0)!==9) throw 'offer seed lost';
    _netTeardown(); _netHsClear();
    // (3) debris must not swallow the offer (was: if(_netSess) return -> silence)
    _netSess=_netMkSess('00ff00cc','peer'); _netSess.game=false; phase='duelLobby';
    _netHs.sent='00ff00cc'; _netHs.sentAt=Date.now(); _netHs.sentRelay=true;
    _netOnSignal({from:'00ff00cc', type:'accept-relay', payload:JSON.stringify({profile:{name:'R'}})});
    if(!_netSess||_netSess.role!=='host'||!_netSess.relay) throw 'debris must be replaced, offer still sent';
    _netTeardown(); _netHsClear();
    // (4) unanswered offers re-send (max 3), then give up loudly
    const _ofetch=globalThis.fetch;
    globalThis.fetch = ()=>({ then:()=>({ catch:()=>{} }) });   // presence only: _netOk() true
    _netHs.offerTo='00ff00dd'; _netHs.offerPayload='{}'; _netHs.offeredAt=Date.now()-3000; _netHs.offerTries=1;
    _netHsTick();
    if(_netHs.offerTries!==2) throw 'a stale offer must be re-sent';
    _netHs.offeredAt=Date.now()-3000; _netHsTick();
    if(_netHs.offerTries!==3) throw 'second re-send missing';
    _netHs.offeredAt=Date.now()-3000; _netHsTick();
    if(_netHs.offerTo!==null||_netLb.msg!=='NO RESPONSE') throw 'must give up after 3 tries, loudly';
    _netHsClear(); _netLb.msg='';
    // (5) friend requests retry over time (were latched once per session forever)
    localStorage.removeItem('fok-snake-friend-ok'); _netFrOk={};
    delete _netFrRequested['00ff00ee'];
    netFriendRequest('00ff00ee');                       // soft (no fetch) but stamps the attempt
    const t1=_netFrRequested['00ff00ee'];
    netFriendRequest('00ff00ee');
    if(_netFrRequested['00ff00ee']!==t1) throw 'requests must be throttled within 30s';
    _netFrRequested['00ff00ee']=Date.now()-31000;
    netFriendRequest('00ff00ee');
    if(_netFrRequested['00ff00ee']===Date.now()-31000) throw 'a request must retry after 30s';
    delete _netFrRequested['00ff00ee']; globalThis.fetch=_ofetch; phase='menu';
    // (6) focus loss must not latch the poll loop: the zombie watchdog frees it
    _netPollBusy=true; _netPollBusyAt=Date.now()-20000; _netPollAbort=null;
    _netPollAbortNow();
    if(_netPollBusy) throw 'a zombie held poll must be cut loose';
    let _aborted=false;
    _netPollBusy=true; _netPollAbort={ abort(){ _aborted=true; } };
    _netPollAbortNow();
    if(!_aborted||_netPollBusy||_netPollAbort!==null) throw 'abort must cancel the held poll and clear the latch';
    // (7) the offer retry must survive a relay session (game=true instantly):
    // only the peer's ANSWER stops it
    const _of2=globalThis.fetch;
    globalThis.fetch = ()=>({ then:()=>({ catch:()=>{} }) });
    _netSess=_netMkSess('00ff00dd','host'); _netSess.relay=true; _netSess.game=true;
    _netHs.offerTo='00ff00dd'; _netHs.offerPayload='{}'; _netHs.offeredAt=Date.now()-3000; _netHs.offerTries=1;
    _netHsTick();
    if(_netHs.offerTries!==2) throw 'a relay offer must still re-send (game=true must not cancel it)';
    _netOnSignal({from:'00ff00dd', type:'answer', payload:JSON.stringify({profile:{name:'D'}})});
    if(_netHs.offerTo!==null) throw 'the answer must stop the offer retry';
    globalThis.fetch=_of2; _netTeardown(); _netHsClear(); _netLb.msg='';
    log('handshake resilience ok: survives navigation, no phase guard, debris replaced, offer re-sends, friend retry');

    // ---- PRNG rides the frames: after reconciliation both sims roll the same dice ----
    simTick=0; simNow=0; startDuel(0xD1CE); bars=[];
    for(let i=0;i<200;i++) update();
    const snapR=simSnapshot();
    if(typeof snapR._rngState!=='number') throw 'snapshot must carry the PRNG state';
    const want=snapR._rngState;
    rng(); rng(); rng();              // local stream walks ahead (the misprediction)
    if(_rngState===want) throw 'sanity: stream should have moved';
    simApply(snapR);
    if(_rngState!==want) throw 'reconciliation must re-align the PRNG';
    inGame=false; _wsend({t:'phase',phase:'menu'}); phase='menu';
    log('prng sync ok: state frames align the dice');

    // ---- remote end: bye lands us on the 1vs1 menu with a message, never a crash ----
    fakeSess('host'); inGame=true; phase='duel';
    _netHandleMsg(JSON.stringify({t:'bye'}));
    if(phase!=='duelMenu'||inGame) throw 'peer bye did not exit cleanly';
    if(_duelMsg!=='OPPONENT LEFT') throw 'missing OPPONENT LEFT message';
    if(_netSess!==null) throw 'session not torn down';
    // and the local quit path tells the peer
    fakeSess('host'); sent.length=0; _duelExit();
    if(!JSON.stringify(sent).includes('bye')) throw 'local exit did not send bye';
    if(_netSess!==null) throw 'local exit did not tear the session down';
    phase='menu';
    log('session end ok: remote bye + local exit');

    // ---- global scores tab renders every state (offline / no data / with data) ----
    phase='scores'; scoresTab=1;
    cfg.offline=true; drawScores();
    cfg.offline=false; drawScores();               // no fetch available: SERVER UNREACHABLE path
    _netScores=[{rank:1,player_id:'00ff00aa',name:'PEER',score:999,level:5,diff:2,color:1,shopItems:{},date:'16.07.26'}];
    _netScoresAt=Date.now(); drawScores();         // with data
    _netScores=null; scoresTab=0; phase='menu';
    log('global scores tab ok: offline, unreachable and data states render');

    localStorage.removeItem('fok-snake-friends');
    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
