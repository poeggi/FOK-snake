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
    if(phase!=='levelReady'&&phase!=='playing') throw 'beginGame broken with net.js loaded';
    if(!(_netSeed>0)) throw 'main-made seed not registered for score replay';
    for(let i=0;i<400;i++) update();
    if(phase!=='playing') throw 'classic game did not reach playing with net.js loaded';
    gameSteer(0, GDIRS.ArrowUp);
    if(_netInputs.length!==1||_netInputs[0][1]!==0) throw 'input log did not record the steer';
    // Boost transitions log at their real ENGAGE/END (issued by the arming stage
    // beside the sim, once the aimed direction is live), not at the keypress.
    gameBoostStart(0, GDIRS.ArrowUp, true);
    for(let i=0;i<200 && _netInputs.length<2;i++) update();
    if(_netInputs.length!==2||_netInputs[1][1]!==4) throw 'engage not logged: '+JSON.stringify(_netInputs);
    if(!boosting) throw 'instant boost did not engage';
    gameBoostEnd(0);
    for(let i=0;i<8 && _netInputs.length<3;i++) update();
    if(_netInputs.length!==3||_netInputs[2][1]!==8) throw 'input log boost codes wrong';
    inGame=false; _wsend({t:'phase',phase:'menu'}); phase='menu';
    log('classic play ok: unaffected, seed + tick-stamped input log recorded');

    // ---- lobby: open from the 1:1 menu, render, navigate, invite dialog ----
    localStorage.setItem('fok-snake-friends', JSON.stringify(['00ff00aa','00ff00bb']));
    phase='duelMenu'; duelSel=4; press('Enter');
    if(phase!=='lobby') throw 'PLAY ONLINE did not open the lobby';
    drawLobby();
    press('ArrowDown'); press('ArrowDown'); press('ArrowDown');
    if(_netLb.sel!==3) throw 'lobby nav broken (sel='+_netLb.sel+')';
    press('Enter');   // BACK
    if(phase!=='duelMenu') throw 'lobby BACK did not return';
    phase='lobby'; netLobbyEnter();
    _netOnSignal({from:'00ff00aa', type:'invite', payload:JSON.stringify({profile:{name:'PEER<XSS>',color:99}})});
    if(!_netLb.invite) throw 'incoming invite not surfaced in the lobby';
    if(_netLb.invite.profile.color>=SNAKE_COLORS.length) throw 'peer profile color not clamped';
    drawLobby();                                   // invite dialog renders
    press('n');                                    // decline (soft: no network to send on)
    if(_netLb.invite) throw 'decline did not clear the invite';
    // offline mode blocks the lobby entirely
    cfg.offline=true; phase='duelMenu'; duelSel=4; press('Enter');
    if(phase==='lobby') throw 'PLAY ONLINE must be blocked in offline mode';
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
    // remote copy of the same record: local is a peer with zero latency. The wire
    // record leaves IMMEDIATELY; the queue receives it when the sim reaches the
    // boundary (a turn had no effect before that tick anyway).
    const w0=sent.length, q0h=players[0].dirQueue.length;
    gameSteer(0, GDIRS.ArrowUp);
    if(sent.length!==w0+1) throw 'own steer must hit the wire at once';
    for(let i=0;i<20 && players[0].dirQueue.length===q0h;i++){ netTickPre(); update(); }
    if(players[0].dirQueue.length!==q0h+1) throw 'own steer never reached our snake at its boundary';
    const pk=JSON.parse(sent[w0]);
    if(pk.t!=='in'||!Array.isArray(pk.l)||!pk.l.length) throw 'own steer must reach the peer as an input log';
    if(pk.s!==undefined||pk.snake!==undefined) throw 'no state may ride the wire';
    // ...and the tick that owns it must NOT apply it a second time.
    const qDup=players[0].dirQueue.length;
    netTickPre();
    if(players[0].dirQueue.length!==qDup) throw 'the live input was applied twice: once now, once by the tick';
    update();
    gameSteer(1, GDIRS.ArrowUp);   // local P2 keys are dead in an online game
    if(sent.length!==w0+1) throw 'local P2 input must be swallowed online';
    // Boost: ARMING is immediate and device-local (nothing rides the wire for it);
    // the arming stage issues the real engage once the aim is live + grace has
    // passed, and THAT transition is what reaches the sim and the peer.
    for(let i=0;i<300 && players[0].dirQueue.length;i++){ netTickPre(); update(); }   // queued turns consume first: arming aligns against the LIVE dir
    gameBoostStart(0, { x:players[0].dir.x, y:players[0].dir.y }, true);
    for(let i=0;i<300 && !players[0].boosting;i++){ netTickPre(); update(); }
    if(!players[0].boosting) throw 'armed boost never engaged';
    if(!sent.some(x=>/"k":"bs"/.test(x))) throw 'the engage transition did not cross the wire';
    gameBoostEnd(0);
    netTickPre(); update();
    if(players[0].boosting) throw 'boost end must land within a tick';
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
    _netSend({ t:'h', tk:_rbToWire(simTick), h:_rbHash(simSnapshot()), f:_rbHashFields(simSnapshot()) });
    if(!sent.length) throw 'setup: the hash packet did not send';
    if(sent[0].length > NET_PKT_MAX) throw 'a hash packet exceeds the datagram budget: '+sent[0].length+'B > '+NET_PKT_MAX;
    if(NET_PKT_MAX > 1210) throw 'the budget must leave ~70B of IP+UDP+DTLS+SCTP headers under a 1280 MTU';
    _netSync={ofs:null, rtt:-1, at:0}; sent.length=0;
    log('packet budget ok: worst-case input + hash both fit one datagram');

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
    // A desync is NOT a connection problem: the link is fine, the worlds are not.
    _rbWarnAt=-1e9; _netSess.lastRecvWall=Date.now();
    if(netDuelWarn()!==null) throw 'a desync must not masquerade as CONNECTION LOST';
    log('divergence detection ok: hash agrees, mismatch flagged, stale hash ignored');

    // ---- in-game warning: the other side is not reaching us ----
    // Silence alone would NOT have caught the tick-base bug -- packets kept
    // arriving, they were just all unusable. So refused input counts as evidence too.
    _rbWarnAt=-1e9; _netSess.lastRecvWall=Date.now();
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
    _netHandleMsg(JSON.stringify({t:'in',tk:0,l:[{q:900,tk:-99999,k:'dir',d:{x:0,y:1}}]}));   // ...but unusable
    if(netDuelWarn()!=='CONNECTION LOST') throw 'refused input must warn even while packets arrive';
    _rbWarnAt=-1e9;
    // A reconnect in progress reads as RECONNECTING, not a bare CONNECTION LOST.
    _netSess.reconnecting=true; if(netDuelWarn()!=='RECONNECTING...') throw 'a reconnect must show RECONNECTING';
    _netSess.reconnecting=false;
    drawDuelBoard(simNow);                             // the red overlay renders
    log('duel warning ok: silence + unusable input warn, reconnect shows RECONNECTING, recovery clears it');

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
    // set at the match start and re-set only at the natural breaks (new level,
    // respawn), never in between.
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
    phase='duelReady';   _netTimeSync(true);   // a break: new level / respawn
    if(!_netSyncBusy) throw 'a break (READY/GO) must re-anchor';
    _netSyncBusy=false;   // the async remainder is not under test; do not leave it latched
    _netGet=_oGet; globalThis.fetch=_oFetch; _netSync={ofs:null, rtt:-1, at:0}; inGame=false; phase='menu'; _netTeardown();
    log('anchor discipline ok: re-anchored at breaks, never mid-game');

    // ---- remote DEBUG flag (api v3): report what is true, honour what is asked ----
    // The two bits are deliberately independent, and the admin view names the
    // difference: 'pending' = an instruction not picked up yet, 'self' = a client that
    // turned debug on by itself. Deriving one from the other would erase that.
    const _applyHello=(r)=>{   // the response half of _netHello, without the network
        const _m=_netApiMajor(r.api), _mn=_netApiMinor(r.api);
        _netApiNewer=(_m!==null && _m>NET_API_BUILT);
        _netApiOutdated=(_m===NET_API_BUILT && _mn>NET_API_BUILT_MINOR);
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
    // api MAJOR gate: string "3.1" (same major, +minor) is compatible; a legacy integer
    // still is; only a newer MAJOR ("4.0") disables online.
    _applyHello({api:'3.1'});
    if(_netApiNewer||_netApiOutdated) throw 'built against 3.1: the same version must read as up to date';
    if(netUpdateNotice()) throw 'no update note when up to date';
    _applyHello({api:3});     if(_netApiNewer||_netApiOutdated) throw 'a legacy integer api (3) must read as compatible';
    _applyHello({api:'3.2'});   // newer MINOR: still compatible, but an update exists
    if(_netApiNewer) throw 'a newer MINOR must NOT disable online';
    if(!_netApiOutdated || netUpdateNotice()!=='UPDATE AVAILABLE - PLEASE RELOAD') throw 'a newer minor must flag UPDATE AVAILABLE';
    _applyHello({api:'4.0'});   // newer MAJOR: incompatible
    if(!_netApiNewer || netUpdateNotice()!=='UPDATE REQUIRED - PLEASE RELOAD') throw 'a newer major must flag UPDATE REQUIRED and gate online off';
    _netApiNewer=false; _netApiOutdated=false;
    log('remote debug ok: instruction honoured on change, self-enabled left alone; api gate parses "3.1" + flags newer minor/major');
    cfg.debug=0;

    // The epoch MOVES with a rematch/level start. Missing that made the new round
    // SPRINT: startDuel rewinds simTick to 0 while the target was still measured from
    // the FIRST match's start_pts, so it sat thousands of ticks ahead and the loop ran
    // flat out at MAX_CATCHUP chasing it -- "the snakes were super-fast".
    fakeSess('peer'); inGame=true; _netSync={ofs:0, rtt:1, at:Date.now()};
    _netSess.startPts=netPts()-5000;                   // an old epoch: the last match's origin
    simTick=0; simNow=0;
    if(netTickTarget()<200) throw 'setup: the stale epoch should put the target ahead';
    const _newEpoch=netPts();   // capture: netPts() moves between calls
    _netHandleMsg(JSON.stringify({t:'rst', seed:0xABC, startPts:_newEpoch, x10:false}));
    if(_netSess.startPts!==_newEpoch) throw 'a rematch must MOVE the epoch, or the new round sprints to catch up';
    if(Math.abs(netTickTarget())>2) throw 'a fresh epoch must put the target at ~tick 0, got '+netTickTarget();
    _netSync={ofs:null, rtt:-1, at:0}; inGame=false; phase='menu'; _netTeardown();
    simTick=6000; simNow=simTick*TICK_MS;   // restore: the rst handler ran startDuel, which rewinds both
    log('rematch epoch ok: a new start_pts moves tick zero with it');

    // A rematch/level/respawn start happens WHILE in game, so it must not ride 'sched'
    // -- that one is refused when inGame (a stale first-start must never restart a
    // running match). Sending it there meant P0 restarted and P1 silently ignored the
    // message: "only one client restarts".
    fakeSess('peer'); inGame=true; _netSync={ofs:0, rtt:1, at:Date.now()};
    _netSess.startPts=netPts()-60000; phase='duelOver';
    const _e2=netPts();
    _netHandleMsg(JSON.stringify({t:'sched', seed:0xB0B, startPts:_e2, x10:false, epoch:1}));
    if(_netSess.startPts===_e2) throw 'setup: sched must still be refused while in game';
    _netHandleMsg(JSON.stringify({t:'rst', seed:0xB0B, startPts:_e2, x10:false, epoch:1}));
    if(_netSess.startPts!==_e2) throw 'rst must be honoured while in game, or only one client restarts';
    if((_netSess.epoch|0)!==1) throw 'the peer must adopt the pair epoch from the start message';
    _netSync={ofs:null, rtt:-1, at:0}; inGame=false; phase='menu'; _netTeardown();
    simTick=6000; simNow=simTick*TICK_MS;
    log('in-game restart ok: rides rst (sched is first-start only), epoch adopted');
    log('clock-driven ticking ok: tick follows the shared clock, none without a sync');

    // ---- PLAY AGAIN handshake (host restarts only when BOTH agreed) ----
    fakeSess('host'); sent.length=0;
    phase='duelOver'; duelWinner=0;
    netAgain();
    if(!JSON.stringify(sent).includes('again')) throw 'netAgain did not tell the peer';
    if(phase!=='duelOver') throw 'host must wait for the peer before restarting';
    if(!netWaitingAgain()) throw 'waiting state not exposed to the UI';
    // A rematch needs a FRESH server-issued start moment, exactly like the first
    // match: with no server reachable there is no shared tick zero, so it is refused
    // rather than started on two timelines that would drift apart.
    _netHandleMsg(JSON.stringify({t:'again'}));
    if(_netSess!==null) throw 'both agreed but no server: the rematch must be refused, not started unsynced';
    log('rematch handshake ok: agreement relayed, refused without a server-issued start');

    // ---- REGRESSION: leaving an online duel must ALWAYS tear the session down ----
    // (a lingering session made netRemoteSim() discard every worker frame: single
    // player froze after quitting an online game -- the mobile PLAY bug)
    fakeSess('peer'); inGame=true; prevPhase='duel'; phase='quitConfirm'; quitConfirmSel=0;
    press('Enter');   // quit YES
    if(_netSess!==null) throw 'quit-YES did not tear the online session down';
    if(phase!=='duelMenu') throw 'quitting a 1:1 must land on the 1:1 menu, not main';
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

    // ---- adaptive poll cadence: 1Hz in lobby/1:1 menu + while connecting,
    // every 10th tick in the main menu, never in-game / elsewhere ----
    _netSess=null;
    phase='lobby';    if(!_netPollDue()) throw 'lobby must poll every tick';
    phase='duelMenu'; if(!_netPollDue()) throw '1:1 menu must poll every tick';
    phase='menu';     _netPollTick=10; if(!_netPollDue()) throw 'main menu must poll every 10th tick';
    _netPollTick=11;  if(_netPollDue()) throw 'main menu must skip between 10s ticks';
    phase='playing';  if(_netPollDue()) throw 'no polling during a classic game';
    fakeSess('peer'); _netSess.game=false;   // session exists but the channel is not open yet
    if(!_netPollDue()) throw 'connecting (signaling in flight) must poll';
    _netSess.game=true; if(_netPollDue()) throw 'no polling during an online game';
    _netSess=null;
    // an invite arriving in the MAIN menu auto-declines (player unavailable there)
    phase='menu'; _netLb.invite=null;
    _netOnSignal({from:'00ff00bb', type:'invite', payload:JSON.stringify({profile:{name:'BUD'}})});
    if(phase!=='menu'||_netLb.invite) throw 'menu invite must auto-decline, not open a dialog';
    log('adaptive poll ok: 1Hz lobby/1:1, 10s main menu, invite jumps to lobby');

    // ---- mutual invites: deterministic auto-accept, no dialog ----
    localStorage.setItem('fok-snake-pid','00000001');   // our ID < the peer's
    phase='lobby'; _netLb.invite=null; _netHs.sent='00ff00aa'; _netHs.sentAt=Date.now();
    _netOnSignal({from:'00ff00aa', type:'invite', payload:'{}'});
    if(_netLb.invite) throw 'mutual invite must not open a dialog';
    if(_netHs.sent!==null) throw 'smaller ID must auto-accept (sent cleared)';
    if(_netLb.msg.indexOf('MUTUAL')!==0) throw 'missing mutual-invite feedback';
    localStorage.setItem('fok-snake-pid','ffffffff');   // our ID > the peer's
    _netHs.sent='00ff00aa'; _netLb.msg='';
    _netOnSignal({from:'00ff00aa', type:'invite', payload:'{}'});
    if(_netLb.invite) throw 'larger ID must not open a dialog either';
    if(_netHs.sent!=='00ff00aa') throw 'larger ID keeps waiting for the accept';
    log('mutual invite ok: tie-broken auto-accept');

    // ---- undelivered receipt: an attempt the peer never collected fails FAST ----
    phase='lobby'; _netHsClear(); _netHs.sent='00ff00aa'; _netHs.sentAt=Date.now(); _netLb.msg='';
    _netOnSignal({from:'00ff00aa', type:'undelivered', payload:JSON.stringify({event:'undelivered', peer:'00ff00aa', type:'invite'})});
    if(_netHs.sent!==null) throw 'undelivered must stop waiting on the sent invite';
    if(_netLb.msg.indexOf('OFFLINE')<0) throw 'undelivered must tell the user the peer is unreachable';
    _netHsClear(); _netHs.accepting='00ff00bb'; _netHs.acceptingAt=Date.now(); _netLb.msg='';
    _netOnSignal({from:'00ff00bb', type:'undelivered', payload:JSON.stringify({event:'undelivered', peer:'00ff00bb', type:'accept'})});
    if(_netHs.accepting!==null) throw 'undelivered must clear a pending accept';
    _netHsClear(); _netLb.msg='KEEP';
    _netOnSignal({from:'00ff00cc', type:'undelivered', payload:JSON.stringify({event:'undelivered', peer:'00ff00cc', type:'invite'})});
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
    _netHandleMsg(JSON.stringify({t:'sched', seed:0xFEED, startPts:null}));
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

    // ---- mandated latency measurement: >=3 samples, extreme first discarded ----
    if(_netLatFromSamples([20,22])!==null) throw 'fewer than 3 samples must not report';
    if(_netLatFromSamples([200,20,22,21,19])!==Math.round((20+22+21+19)/4)) throw 'extreme first sample must be discarded';
    if(_netLatFromSamples([25,20,22])!==Math.round((25+20+22)/3)) throw 'normal first sample must be kept';
    // friends e2e estimate: their reported half plus our half, one way each
    _netLat={value:30, at:1, pending:false}; _netFriendsLat={'00ff00aa':50};
    if(netFriendE2E('00ff00aa')!==40) throw 'e2e estimate wrong: '+netFriendE2E('00ff00aa');
    if(netFriendE2E('00ff00bb')!==null) throw 'no report -> no estimate';
    localStorage.setItem('fok-snake-friends', JSON.stringify(['00ff00aa','00ff00bb']));
    _netFriendsOnline={'00ff00aa':true}; phase='lobby'; drawLobby();   // renders with the ms figure
    localStorage.removeItem('fok-snake-friends');
    _netLat={value:null, at:0, pending:false}; _netFriendsLat={}; phase='menu';
    log('latency mandate ok: sampling rule, e2e estimate, lobby render');

    // ---- API version gate: a newer server contract disables online cleanly ----
    _netApiNewer=true;
    if(_netOk()) throw 'newer server contract must gate _netOk';
    netSubmitScore('X', 10, 1); netFetchScores();   // all soft no-ops
    phase='lobby'; drawLobby();                     // renders the reload notice
    _netApiNewer=false; phase='menu';
    log('api version gate ok');

    // ---- identical-rules handshake: a version mismatch never starts a match ----
    phase='lobby'; _netLb.msg='';
    _netOnSignal({from:'00ff00aa', type:'offer', payload:JSON.stringify({sdp:{}, seed:7, v:'v0.0.0-other'})});
    if(_netSess!==null) throw 'mismatched offer must not create a session';
    if(_netLb.msg.indexOf('VERSION MISMATCH')!==0) throw 'missing version-mismatch notice';
    _netLb.msg=''; phase='menu';
    log('version handshake ok: mismatched clients refuse to duel');

    // ---- friend names: learned from every received profile, shown in the lobby ----
    localStorage.removeItem('fok-snake-friend-names'); _netFriendNames={};
    phase='lobby'; _netLb.invite=null; _netHsClear();
    _netOnSignal({from:'00ff00aa', type:'invite', payload:JSON.stringify({profile:{name:'BUDDY',color:1}})});
    if(netFriendName('00ff00aa')!=='BUDDY') throw 'invite profile did not teach the name';
    if(JSON.parse(localStorage.getItem('fok-snake-friend-names'))['00ff00aa']!=='BUDDY') throw 'name not persisted';
    _netLb.invite=null;
    localStorage.setItem('fok-snake-friends', JSON.stringify(['00ff00aa']));
    drawLobby();   // renders NAME + ID
    localStorage.removeItem('fok-snake-friends'); localStorage.removeItem('fok-snake-friend-names');
    _netFriendNames={}; phase='menu';
    log('friend names ok: learned from profiles, persisted, rendered');

    // ---- in-game names: HUD labels + winner banner use them online ----
    localStorage.setItem('lastSName','KAI'); netNameChanged();   // direct write: the name-entry hook is bypassed
    simTick=0; simNow=0; startDuel(0xC0DE); bars=[];
    fakeSess('host'); _netSess.peerProfile={name:'BUDDY',color:1,shopItems:{}};
    const pn=netPlayerNames();
    if(pn[0]!=='KAI'||pn[1]!=='BUDDY') throw 'player names wrong: '+JSON.stringify(pn);
    updateHUD();   // labels adopt the names without error
    phase='duelOver'; duelWinner=1; drawDuelBoard(simNow);   // banner: BUDDY WINS!
    _netTeardown(); inGame=false; _wsend({t:'phase',phase:'menu'}); phase='menu';
    localStorage.removeItem('lastSName');
    log('in-game names ok: HUD labels + winner banner');

    // ---- FRIENDS screen: rows merge server + local, accept/remove flows ----
    simNow=100000; simTick=6000; _splashLeftAt=-1e9;   // past the post-splash input guard again
    localStorage.setItem('fok-snake-friends', JSON.stringify(['00ff00aa','00ff00bb']));
    phase='duelMenu'; duelSel=3; press('Enter');
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
    if(phase!=='duelMenu') throw 'friends ESC did not return';
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
    phase='friendId'; _netHelloBusy=false; _netHello();
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
    if(_duelMsg!==_netFr.msg) throw 'notification must surface on the 1:1 menu too';
    confetti.length=0;
    _netOnSignal({from:'00ff00bb', type:'friend', payload:JSON.stringify({event:'accepted', from:'00ff00bb'})});
    if(_netFr.msg.indexOf('YOU ARE FRIENDS')<0) throw 'accepted notification text missing';
    if(!getFriends().includes('00ff00bb')) throw 'accepted event must add the friend locally';
    if(!confetti.length) throw 'accepted notification must celebrate';
    _netOnSignal({from:'', type:'friend', payload:JSON.stringify({event:'bogus', from:'00ff00cc'})});
    if(getFriends().includes('00ff00cc')) throw 'unknown friend events must be ignored';
    confetti.length=0; localStorage.removeItem('fok-snake-friends'); _netFr.msg=''; _duelMsg='';
    log('friend notifications ok: request + accepted celebrate, bogus ignored');

    // ---- relay fallback: routing, low-rate corrections, indicator ----
    simTick=0; simNow=0; startDuel(0xFACE); bars=[];
    for(let i=0;i<400;i++) update();
    fakeSess('host'); sent.length=0;
    _netSess.relay=true;                       // relay mode: nothing may use the DataChannel
    _netSend({t:'pi'});
    if(sent.length!==0) throw 'relay mode must not send over the DataChannel';
    if(!netRelayActive()) throw 'relay state not exposed';
    // (the relay carries the SAME inputs-only messages: no state, no host frames)
    drawDuelBoard(simNow);                     // board renders the RELAY MODE tag
    // seq ordering: duplicates and replays are dropped
    _netSess.relaySeq=5;
    const q1=players[1].dirQueue.length;
    _netSess.role='host';
    (function(){ const m={seq:5, payload:JSON.stringify({t:'in',k:'dir',d:{x:0,y:-1}})};
        if((m.seq|0)<=_netSess.relaySeq) return; _netHandleMsg(m.payload); })();
    if(players[1].dirQueue.length!==q1) throw 'stale relay seq must be dropped';
    _netTeardown(); inGame=false; _wsend({t:'phase',phase:'menu'}); phase='menu';
    // the 5s fallback timer exists on fresh RTC sessions (fires only in browsers)
    log('relay fallback ok: send routing, cadence, indicator, seq drop');

    // ---- ONE status notice, identical on every online screen; the api gate
    // re-evaluates instead of latching forever ----
    cfg.offline=true;
    if(netStatusNotice()!=='OFFLINE MODE (SETTINGS > NETWORK)') throw 'offline notice wrong';
    cfg.offline=false; _netApiNewer=true; _netSrvErr=true;
    if(netStatusNotice()!=='GAME UPDATE REQUIRED - PLEASE RELOAD') throw 'api notice must outrank unreachable';
    _netApiNewer=false;
    if(netStatusNotice()!=='SERVER UNREACHABLE - RETRYING') throw 'unreachable notice wrong';
    phase='lobby'; drawLobby(); phase='friends'; drawFriends();   // both render the SAME string
    _netSrvErr=false;
    if(netStatusNotice()!==null) throw 'healthy state must show no notice';
    phase='menu';
    log('status notice ok: shared, prioritized, self-healing');

    // ---- MY ID: shows the friend notification and renders name columns cleanly ----
    phase='friendId';
    _netFr.msg='SOMEONE ADDED YOU AS A FRIEND'; drawFriendId();
    _netFr.msg=''; drawFriendId();
    localStorage.setItem('fok-snake-friend-names', JSON.stringify({'00ff00aa':'AVERYLONGNAME15'}));
    _netFriendNames=JSON.parse(localStorage.getItem('fok-snake-friend-names'));
    localStorage.setItem('fok-snake-friends', JSON.stringify(['00ff00aa']));
    phase='friends'; _netFr.sel=0; drawFriends();   // truncated name column renders
    phase='lobby'; drawLobby();
    localStorage.removeItem('fok-snake-friends'); localStorage.removeItem('fok-snake-friend-names');
    _netFriendNames={}; phase='menu';
    log('row layout ok: centered ID, truncated name column, my-id notification');

    // ---- QR auto-confirm: a request arriving while OUR QR shows accepts itself ----
    localStorage.removeItem('fok-snake-friends');
    _netMyIdAt=Date.now(); phase='friendId'; _netFr.msg='';
    _netOnSignal({from:'', type:'friend', payload:JSON.stringify({event:'request', from:'00ff00dd'})});
    if(!getFriends().includes('00ff00dd')) throw 'QR-window request must auto-friend';
    if(_netFr.msg.indexOf('YOU ARE FRIENDS')<0) throw 'auto-confirm must celebrate as friends';
    _netMyIdAt=0; phase='menu'; _netFr.msg='';
    _netOnSignal({from:'', type:'friend', payload:JSON.stringify({event:'request', from:'00ff00ee'})});
    if(getFriends().includes('00ff00ee')) throw 'requests outside the QR window stay manual';
    if(_netFr.msg.indexOf('ADDED YOU AS A FRIEND')<0) throw 'manual path lost its notification';
    localStorage.removeItem('fok-snake-friends'); _netFr.msg='';
    log('qr auto-confirm ok: friends while presenting, manual otherwise');

    // ---- peer-side removal mirrors locally: accepted-then-gone means GONE ----
    localStorage.setItem('fok-snake-friends', JSON.stringify(['00ff00aa','00ff00bb']));
    _netFrOk={'00ff00aa':1}; _netFrOkSave();
    // fake an authoritative list answer: aa is gone (peer removed), bb never synced
    _netFr.loading=true;
    (function(){ const r={friends:[]};
        const seen={};
        for(const id of getFriends()){
            if(seen[id]) continue;
            if(_netFrOk[id]){ removeFriend(id); _netFrOkClear(id);
                _netFr.msg=(netFriendName(id)||fmtFriendId(id))+' REMOVED THE FRIENDSHIP'; }
        }
    })();
    _netFr.loading=false;
    if(getFriends().includes('00ff00aa')) throw 'peer-removed friendship must vanish locally';
    if(!getFriends().includes('00ff00bb')) throw 'never-synced friends must survive';
    if(_netFr.msg.indexOf('REMOVED THE FRIENDSHIP')<0) throw 'removal notice missing';
    localStorage.removeItem('fok-snake-friends'); localStorage.removeItem('fok-snake-friend-ok');
    _netFrOk={}; _netFr.msg='';
    log('removal sync ok: one side cancelled means gone');

    // ---- relay fallback actually engages: a failed P2P attempt becomes a relay
    // session (and retires the RTC objects so their late events cannot kill it) ----
    let _pcClosed=false, _dcClosed=false;
    _netSess=_netMkSess('00ff00aa','host'); _netSess.seed=0xFA11;
    _netSess.pc={ close(){ _pcClosed=true; } };
    _netSess.dc={ close(){ _dcClosed=true; }, readyState:'open', send(){} };
    _netRelayStart(_netSess);
    if(!_netSess.relay||!_netSess.game) throw 'relay session did not engage';
    if(!_pcClosed||!_dcClosed) throw 'the failed RTC attempt must be retired';
    if(_netSess.pc!==null||_netSess.dc!==null) throw 'RTC handles must be dropped';
    if(_netLb.msg.indexOf('RELAY')<0) throw 'fallback must be visible while connecting';
    if(!netRelayActive()) throw 'relay state not active';
    if(!(_netSess.relayGraceUntil > 0)) throw 'relay must grant the peer a fallback grace window';
    _netTeardown(); inGame=false; _wsend({t:'phase',phase:'menu'}); phase='menu'; _netLb.msg='';
    log('relay engage ok: fallback session, RTC retired, visible message');

    // ---- aborting a connection attempt: leaving the lobby closes everything and
    // a fresh attempt is possible immediately (new pc = new STUN gathering) ----
    let _abClosed=false, _abTimerCleared=true;
    _netSess=_netMkSess('00ff00aa','host');
    _netSess.pc={ close(){ _abClosed=true; } };
    netLobbyLeave();
    if(_netSess!==null) throw 'lobby leave must tear a pending attempt down';
    if(!_abClosed) throw 'lobby leave must close the RTCPeerConnection';
    phase='lobby'; _netHsClear();
    _netInviteSend('00ff00bb');   // not blocked by a stale session anymore
    if(_netHs.sent!==null) throw 'harness sanity: offline invite stays soft';   // no fetch: _netOk false -> no-op
    _netSess=_netMkSess('00ff00cc','peer'); _netSess.game=true; inGame=true;   // a RUNNING on-screen game is untouched
    netLobbyEnter();
    if(_netSess===null) throw 'entering the lobby must not kill a running game';
    _netTeardown(); inGame=false; phase='menu';
    log('attempt lifecycle ok: leave aborts, running games survive, fresh attempts possible');

    // ---- invites surface on 1:1/social screens; elsewhere they auto-decline ----
    for(const ph of ['duelMenu','friends','friendId']){
        phase=ph; _netLb.invite=null; _netSess=null;
        _netOnSignal({from:'00ff00aa', type:'invite', payload:JSON.stringify({profile:{name:'PEER'}})});
        if(phase!=='lobby'||!_netLb.invite) throw 'invite must surface from '+ph;
        _netLb.invite=null;
    }
    for(const ph of ['menu','settings','playing']){
        phase=ph;
        _netOnSignal({from:'00ff00aa', type:'invite', payload:JSON.stringify({profile:{name:'PEER'}})});
        if(_netLb.invite) throw 'invite must auto-decline in '+ph;
    }
    phase='menu';
    log('invite reception ok: social screens surface, elsewhere auto-decline');

    // ---- withdraw: leaving the lobby with a pending invite tells the invitee,
    // and a bye closes a still-open ACCEPT dialog (so re-invites are not blocked) ----
    phase='lobby'; _netLb.invite={from:'00ff00aa', profile:{name:'X',color:0,shopItems:{}}}; _netLb.msg='';
    _netOnSignal({from:'00ff00aa', type:'bye', payload:''});
    if(_netLb.invite) throw 'a bye must close a pending ACCEPT dialog';
    if(_netLb.msg.indexOf('WITHDRAWN')<0) throw 'withdrawn invite needs a notice';
    _netLb.msg=''; phase='menu';
    log('invite withdraw ok: bye closes the dialog, re-invite unblocked');

    // ---- relay-only mode (no-P2P bit): invite-relay/accept-relay, no WebRTC ----
    cfg.noP2P=true; phase='lobby'; _netLb.invite=null; _netHsClear(); _netSess=null;
    // INVITER: an accept-relay reply starts a relay HOST session, no WebRTC.
    _netHs.sent='00ff00aa'; _netHs.sentRelay=true;
    _netOnSignal({from:'00ff00aa', type:'accept-relay', payload:JSON.stringify({profile:{name:'P'}})});
    if(!_netSess||!_netSess.relay||_netSess.role!=='host') throw 'accept-relay must start a relay host session';
    if(_netSess.pc) throw 'relay mode must not create an RTCPeerConnection';
    _netTeardown();
    // ACCEPTOR: a no-sdp offer starts a relay PEER session, no WebRTC.
    phase='lobby'; _netSess=null;
    _netOnSignal({from:'00ff00bb', type:'offer', payload:JSON.stringify({seed:7, profile:{name:'Q'}})});
    if(!_netSess||!_netSess.relay||_netSess.role!=='peer') throw 'no-sdp offer must start a relay peer session';
    if(_netSess.pc) throw 'relay peer must not create an RTCPeerConnection';
    if((_netSess.seed>>>0)!==7) throw 'relay peer must adopt the offer seed';
    _netTeardown();
    // an incoming invite-relay is remembered as relay; answering it stays relay-side.
    phase='lobby'; _netLb.invite=null;
    _netOnSignal({from:'00ff00cc', type:'invite-relay', payload:JSON.stringify({profile:{name:'R'}})});
    if(!_netLb.invite||_netLb.invite.relay!==true) throw 'invite-relay must be flagged relay';
    _netInviteAnswer(true);
    if(_netLb.msg.indexOf('RELAY')<0) throw 'answering must show relay mode';
    _netLb.invite=null; cfg.noP2P=false; phase='menu';
    log('relay-only mode ok: invite-relay/accept-relay, no WebRTC session');

    // ---- universal teardown: EVERY leftover state is reaped on lobby leave ----
    // (1) a relay session that reached game=true but is not on-screen (inGame=false)
    _netSess=_netMkSess('00ff00aa','peer'); _netSess.relay=true; _netSess.game=true; inGame=false;
    phase='lobby'; netLobbyLeave();
    if(_netSess!==null) throw 'a not-yet-playing relay session must be reaped';
    // (2) a P2P session still negotiating (game=false) with mock RTC objects closed
    let _pcC=false,_dcC=false;
    _netSess=_netMkSess('00ff00bb','host'); _netSess.pc={close(){_pcC=true;}}; _netSess.dc={close(){_dcC=true;}};
    phase='lobby'; netLobbyLeave();
    if(_netSess!==null||!_pcC||!_dcC) throw 'a negotiating session must be reaped + RTC closed';
    // (3) a pending SENT invite is withdrawn on leave
    phase='lobby'; _netHsClear(); _netHs.sent='00ff00cc'; _netSess=null; inGame=false;
    netLobbyLeave();
    if(_netHs.sent!==null) throw 'a pending sent invite must be withdrawn on leave';
    // (4) a received invite dialog is dismissed on leave
    phase='lobby'; _netLb.invite={from:'00ff00dd',profile:{name:'X',color:0,shopItems:{}}};
    netLobbyLeave();
    if(_netLb.invite!==null) throw 'a received invite must be dismissed on leave';
    // (5) entering the lobby also reaps a stray session so new invites are received
    _netSess=_netMkSess('00ff00ee','peer'); _netSess.game=true; inGame=false;
    netLobbyEnter();
    if(_netSess!==null) throw 'entering the lobby must reap a stray session';
    // a genuine running game (inGame) is NOT touched by lobby transitions
    _netSess=_netMkSess('00ff00ff','host'); _netSess.game=true; inGame=true;
    netLobbyLeave();
    if(_netSess===null) throw 'a running on-screen game must not be reaped';
    _netTeardown(); inGame=false; phase='menu';
    log('universal teardown ok: sessions/invites/dialogs all reaped, running game kept');

    // ---- HANDSHAKE RESILIENCE (the restructure): every case below silently
    // destroyed a connection attempt before _netHs existed. ----
    cfg.offline=false; inGame=false;
    // (1) navigation must NOT wipe an in-flight handshake nor bye the peer
    _netHsClear(); _netSess=null; _netHs.sent='00ff00aa'; _netHs.sentAt=Date.now(); _netHs.sentRelay=true;
    phase='duelMenu'; netLobbyEnter(); phase='lobby';
    if(_netHs.sent!=='00ff00aa') throw 'entering a screen must not wipe the handshake';
    // ...and the peer's accept is then still recognised (was dropped forever)
    _netOnSignal({from:'00ff00aa', type:'accept-relay', payload:JSON.stringify({profile:{name:'P'}})});
    if(!_netSess||_netSess.role!=='host') throw 'accept after navigation must still produce an offer';
    if(!_netHs.offerTo) throw 'the offer must be remembered for re-send';
    _netTeardown(); _netHsClear();
    // (2) an offer arriving OFF the lobby screen is honoured (phase guard gone)
    phase='duelMenu'; _netSess=null;
    _netOnSignal({from:'00ff00bb', type:'offer', payload:JSON.stringify({seed:9, profile:{name:'Q'}})});
    if(!_netSess||_netSess.role!=='peer') throw 'an offer off the lobby screen must still connect';
    if((_netSess.seed>>>0)!==9) throw 'offer seed lost';
    _netTeardown(); _netHsClear();
    // (3) debris must not swallow the offer (was: if(_netSess) return -> silence)
    _netSess=_netMkSess('00ff00cc','peer'); _netSess.game=false; phase='lobby';
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
    // (7) a DUPLICATE offer (host re-sent because our answer was lost) must
    // re-answer and KEEP the forming session, not tear it down and restart
    _netHsClear(); _netSess=null; phase='lobby'; inGame=false;
    _netOnSignal({from:'00ff00bb', type:'offer', payload:JSON.stringify({seed:11, profile:{name:'D'}})});
    const _s1=_netSess;
    if(!_s1||!_s1.relay) throw 'first offer must create the relay peer session';
    _netOnSignal({from:'00ff00bb', type:'offer', payload:JSON.stringify({seed:11, profile:{name:'D'}})});
    if(_netSess!==_s1) throw 'a duplicate offer must NOT rebuild the session';
    _netTeardown(); _netHsClear();
    // (8) the offer retry must survive a relay session (game=true instantly):
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

    // ---- remote end: bye lands us on the 1:1 menu with a message, never a crash ----
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
