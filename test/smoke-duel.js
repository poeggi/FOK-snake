// 1:1 duel smoke: start, tick into play, per-player steering, deterministic head-on
// draw, screen rendering, state cleanup. Run: node test/smoke-duel.js
const { runTest } = require('./harness');

runTest('SMOKE-DUEL', `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const log = (m) => R.steps.push(m);
  try {
    simTick=1000; simNow=simTick*TICK_MS;
    simCommand({t:'startDuel', seed:0xD0E1});
    if(phase!=='duelReady'||!players||players.length!==2) throw 'startDuel did not set up two players';
    // The rare-event scale is pinned per match, independent of the local setting.
    if(_duelX10!==false) throw 'duel must default to the standard rare-event scale';
    cfg.x10=true; if(_X10()!==1) throw 'a running duel must ignore the local cfg.x10';
    cfg.x10=false;
    simCommand({t:'startDuel', seed:0xD0E1, x10:true});
    if(_duelX10!==true||_X10()!==10) throw 'startDuel must adopt the transported x10 flag';
    simCommand({t:'startDuel', seed:0xD0E1});
    bars=[];   // clear the seeded barricades so straight running is safely collision-free
    for(let i=0;i<400;i++) update();
    if(phase!=='duel') throw 'duel did not leave duelReady';
    const _p0x=players[0].snake[0].x;
    for(let i=0;i<60;i++) update();
    if(players[0].snake[0].x===_p0x) throw 'duel: P0 did not move';
    simCommand({t:'dir', p:1, dir:{x:0,y:-1}});
    const _p1y=players[1].snake[0].y;
    for(let i=0;i<60;i++) update();
    if(players[1].snake[0].y===_p1y) throw 'duel: P1 steering (p:1) did not apply';
    drawDuelBoard(simNow);                       // live board renders (both snakes + scores)

    // Pause freezes ticking state, resume restores it.
    simCommand({t:'pause'});
    if(phase!=='duelPaused') throw 'duel pause did not enter duelPaused';
    drawDuelBoard(simNow);
    simCommand({t:'resume'});
    if(phase!=='duel') throw 'duel resume did not return to duel';

    // Stage a deterministic head-on: facing heads 4 cells apart on one row.
    // With 3 lives each, the first head-on costs a heart and RESTARTS the round.
    const headOn=()=>{
        players[0].snake=[{x:10,y:5},{x:9,y:5},{x:8,y:5}]; players[0].dir={x:1,y:0}; players[0].dirQueue=[]; players[0].stepAccum=0;
        players[1].snake=[{x:14,y:5},{x:15,y:5},{x:16,y:5}]; players[1].dir={x:-1,y:0}; players[1].dirQueue=[]; players[1].stepAccum=0;
        gem={x:0,y:0,tier:0}; spawnAt=-999999; phase='duel';
        for(let i=0;i<200&&(phase==='duel'||phase==='dying');i++) update();
    };
    headOn();
    if(phase!=='duelReady') throw 'duel: first head-on should restart the level, got '+phase;
    if(players[0].lives!==2||players[1].lives!==2) throw 'duel: head-on did not cost both a heart';
    if(level!==1||gemsDone!==0) throw 'duel: death restart must keep the level and reset gems';
    updateHUD();                                  // duel HUD path (P1/P2 hearts + shared gems/level)

    // Level progression + the heart-back twist: P0 eats the 10th gem.
    bars=[]; gemsDone=9; phase='duel'; spawnAt=-999999;
    players[0].snake=[{x:10,y:5},{x:9,y:5},{x:8,y:5}]; players[0].dir={x:1,y:0}; players[0].dirQueue=[]; players[0].stepAccum=0;
    players[1].snake=[{x:5,y:15},{x:6,y:15},{x:7,y:15}]; players[1].dir={x:-1,y:0}; players[1].dirQueue=[]; players[1].stepAccum=0;
    gem={x:11,y:5,tier:0};
    const _s0=players[0].score;
    for(let i=0;i<60&&phase==='duel';i++) update();
    // Finishing a level waits in the shared 'levelDone' -- it does NOT auto-advance.
    if(phase!=='levelDone') throw 'duel: finishing the level should wait in levelDone, got '+phase;
    if(level!==1) throw 'duel: level must not advance before a player continues';
    if(players[0].lives!==3) throw 'duel: level-finisher did not earn a heart back';
    if(players[1].lives!==2) throw 'duel: non-finisher lives changed';
    if(players[0].score<=_s0) throw 'duel: finisher got no score for the gem';
    for(let i=0;i<120&&!levelDoneWaiting;i++) update();
    if(!levelDoneWaiting) throw 'duel: level-done wait never armed';
    simCommand({t:'advance'});                    // a player presses to start the next level
    if(level!==2) throw 'duel: advance did not start the next level';
    if(phase!=='duelReady') throw 'duel: next level should re-enter READY';
    if(gemsDone!==0) throw 'duel: new level did not reset gems';
    // ---- POWER MODE rules ----
    // Pellet pickup: powers up, no death, pellet gone.
    bars=[]; phase='duel'; spawnAt=-999999; _powerMode=false;
    players[0].snake=[{x:10,y:5},{x:9,y:5},{x:8,y:5}]; players[0].dir={x:1,y:0}; players[0].dirQueue=[]; players[0].stepAccum=0;
    players[1].snake=[{x:5,y:15},{x:6,y:15},{x:7,y:15}]; players[1].dir={x:-1,y:0}; players[1].dirQueue=[]; players[1].stepAccum=0;
    gem={x:0,y:0,tier:0}; powerPellet={x:11,y:5}; powerPelletAt=simNow;
    for(let i=0;i<30&&!_powerMode;i++) update();
    if(!_powerMode||powerPellet!==null) throw 'duel: pellet pickup did not start power mode';
    drawDuelBoard(simNow);                        // powered board renders (live bars + shimmer)

    // Body bite while powered: victim loses the tail from the bite, biter survives
    // slowed to 50%; nobody loses a heart.
    _powerModeAt=simNow;                          // fresh 6s window
    players[0].snake=[{x:12,y:6},{x:11,y:6},{x:10,y:6}]; players[0].dir={x:0,y:-1}; players[0].dirQueue=[]; players[0].stepAccum=0;
    players[1].snake=[{x:13,y:5},{x:12,y:5},{x:11,y:5}]; players[1].dir={x:1,y:0}; players[1].dirQueue=[]; players[1].stepAccum=0;
    players[1].boostDir=null;                     // P1 holds still: accumulate nothing
    const _holdP1=players[1]; _holdP1.alive=true;
    gem={x:0,y:0,tier:0};
    const _l0=players[0].lives, _l1=players[1].lives;
    phase='duel'; spawnAt=-999999;
    // one game tick where only P0 is due: P0 head (12,6) -> (12,5) = P1 middle segment
    players[0].stepAccum=2; players[1].stepAccum=-9999;
    duelStep(simNow);
    if(players[0].lives!==_l0||players[1].lives!==_l1) throw 'duel: body bite must not cost hearts';
    // Bitten at the neck: chewed as deep as the rule allows, but never down to a lone
    // head -- a head with no body looks like a rendering fault, not like damage taken.
    if(players[1].snake.length!==2) throw 'duel: bite did not eat the tail off (len='+players[1].snake.length+')';
    if(!(players[0].slowUntil>simNow)) throw 'duel: biter was not slowed';
    if(ck(players[0].snake[0])!=='12,5') throw 'duel: biter head not on the bitten cell';

    // Head bite while powered: the bitten player dies (loses a heart), biter does not.
    players[0].snake=[{x:20,y:10},{x:19,y:10},{x:18,y:10}]; players[0].dir={x:1,y:0}; players[0].dirQueue=[]; players[0].slowUntil=0;
    players[1].snake=[{x:21,y:10},{x:22,y:10},{x:23,y:10}]; players[1].dir={x:1,y:0}; players[1].dirQueue=[];
    players[0].stepAccum=2; players[1].stepAccum=-9999;
    _powerMode=true; _powerModeAt=simNow; phase='duel'; spawnAt=-999999;
    duelStep(simNow);
    if(players[1].lives!==_l1-1) throw 'duel: head bite did not kill the victim';
    if(players[0].lives!==_l0) throw 'duel: head bite must not hurt the biter';
    if(phase!=='dying') throw 'duel: a life-lost should enter the shared dying screen, got '+phase;
    for(let i=0;i<120&&phase==='dying';i++) update();     // hold the death beat, then respawn
    if(phase!=='duelReady') throw 'duel: dying should respawn into the next round';
    if(_powerMode) throw 'duel: level restart must clear power mode';
    log('duel power ok: pellet pickup, tail bite (slow, no death), head bite kills');

    players[0].lives=1; players[1].lives=1;
    headOn();
    if(phase!=='duelOver') throw 'duel: final head-on did not end the match';
    if(duelWinner!==2) throw 'duel: double knockout should be a draw, got winner='+duelWinner;
    drawDuelBoard(simNow);                       // duelOver rematch dialog renders
    simCommand({t:'startDuel', seed:0xD0E2});    // rematch: fresh match state
    if(players[0].lives!==3||duelWinner!==-1) throw 'duel: rematch did not reset the match';
    simCommand({t:'phase', phase:'menu'});
    if(players!==null) throw 'duel: returning to menu did not clear duel state';
    log('duel 1:1 ok: steering, pause/resume, lives rounds, match end, rematch, cleanup');

    // ---- SPEED ROUND: rolled from the SEEDED rng, so both clients agree by
    // construction -- nothing about it crosses the wire. Same seed in, same rounds out.
    function _rounds(seed){
        startDuel(seed>>>0, false);
        const out=[];
        for(let lv=1; lv<=LEVEL_CFG.length; lv++){ level=lv; _duelBeginLevel(); out.push({lv, sp:_speedRound, gPer}); }
        return out;
    }
    const _a=_rounds(0x1234), _b=_rounds(0x1234);
    if(JSON.stringify(_a)!==JSON.stringify(_b)) throw 'speed rounds must be identical for the same seed: the two clients would disagree';
    if(_a[0].sp) throw 'level 1 must never be a speed round';
    for(const r of _a){
        if(r.sp && r.gPer!==LEVEL_CFG[9].normal) throw 'a speed round must run at level 10 pace, got gPer='+r.gPer;
        if(!r.sp && r.gPer!==LEVEL_CFG[r.lv-1].normal) throw 'a normal round must keep its own level pace';
    }
    // It is a 1-in-20 roll, so over many seeds it must actually happen -- and not always.
    let _hit=0, _tot=0;
    for(let s=1; s<=400; s++){ for(const r of _rounds(s)) if(r.lv>1){ _tot++; if(r.sp) _hit++; } }
    if(_hit===0) throw 'a speed round never fired over 400 seeds: the roll is dead';
    if(_hit===_tot) throw 'every round was a speed round: the roll is inverted';
    if(_hit/_tot < 0.02 || _hit/_tot > 0.10) throw 'speed round rate off 5%: '+(100*_hit/_tot).toFixed(1)+'%';
    // It rides in the snapshot: a rollback re-simulation must not silently drop it.
    startDuel(0x77, false); level=5; _duelBeginLevel();
    const _snap=simSnapshot(), _was=_speedRound;
    _speedRound=!_was; simApply(_snap);
    if(_speedRound!==_was) throw 'speed round must survive a snapshot round trip (a rollback would lose it)';
    log('speed round ok: seed-identical on both clients, level-10 pace, ~5%, in the snapshot');

    // ---- THE SIM MUST NEVER STALL, whatever the shared clock says ----
    // The clock STEERS the tick rate; it must never be able to stop it. Holding a tick
    // back every frame takes back exactly what the frame added: the sim does not slow,
    // it STOPS -- dead game, input piling into dirQueue with nothing to step it. This
    // drives the real loop(), because that is where the bug lived; a hand-rolled
    // update() loop cannot see it.
    document.body.dataset = document.body.dataset || {};
    const _ow=_worker; _worker=null;
    cfg.offline=false; globalThis.fetch=()=>({then:()=>({catch:()=>{}})});
    _netTimeSync=async()=>{}; _netRequestStart=async()=>{}; _netLiveStart=()=>{}; _netRelayLoop=async()=>{};
    let _raf=1000;   // MONOTONIC across cases: loop() reads frame deltas, so restarting it goes backwards
    for(const off of [0, 500, 1500, -800]){   // startPts at/ahead/behind our clock
        _netSess=_netMkSess('ffffffff','host'); _netSess.game=true;
        _netSess.dc={readyState:'open',send(){},close(){}};
        _netSync={ofs:0,rtt:1,at:Date.now()};
        _netSess.startPts=netPts()+off;
        beginOnlineDuel(0xBEEF, true); bars=[];
        for(let f=0; f<180; f++){ _raf+=16.7; loop(_raf); }   // ~3s of frames
        if(simTick < 100) throw 'the sim STALLED with startPts '+off+'ms from our clock: '+simTick+' ticks in 3s -- a clock that can stop the game is a switch, not a clock';
        _netTeardown();
    }
    _worker=_ow; _netSync={ofs:null,rtt:-1,at:0}; inGame=false; phase='menu';
    log('tick rate ok: the clock steers the sim, it can never stall it');

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
