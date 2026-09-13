// Gameplay smoke: config-load tolerance, a short classic run through levelReady into
// playing, board + accessory rendering. Run: node test/smoke-game.js
const { runTest } = require('./harness');

runTest('SMOKE-GAME', `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const log = (m) => R.steps.push(m);
  try {
    // Config load tolerance: an old/partial save (missing new keys, out-of-range
    // values) and outright garbage must not throw and must fall back to defaults.
    localStorage.setItem(CFG_KEY, JSON.stringify({ music:false, diff:99, snakeColor:-1 }));
    loadCfg();
    if(cfg.diff!==1) throw 'out-of-range diff not clamped to default';
    if(cfg.snakeColor!==0) throw 'out-of-range color not clamped to default';
    if(cfg.offline!==false) throw 'missing offline key should default to false';
    if(cfg.music!==false) throw 'valid saved value (music) was not applied';
    localStorage.setItem(CFG_KEY, 'this is not json {{{');
    loadCfg();
    if(cfg.diff!==1 || cfg.music!==true) throw 'garbage save did not fall back to defaults';
    log('config load tolerance ok');

    // THE SPLASH HOLD: frame 0 (dark, no coin) holds SPLASH_HOLD_S after the splash comes
    // up, then the 4 s cycle runs as before, its first drop at 1.5 s. drawSplash and the
    // fast-forward read the same clock, so a press inside the hold starts the 2x replay
    // at frame 0, not half a second in.
    {
      const _oPh = phase, _oAt = phaseAt, _oNow = simNow, _oFast = _splashFast;
      phase = 'splash'; phaseAt = 10000; _splashFast = false;
      if(SPLASH_HOLD_S !== 0.5) throw 'the hold is half a second, got ' + SPLASH_HOLD_S;
      if(splashClock(10000) !== 0 || splashClock(10499) !== 0 || splashClock(10500) !== 0) throw 'frame 0 through the hold';
      if(Math.abs(splashClock(11500) - 1.0) > 1e-9) throw 'the first drop (T_DROP = 1.0 on the cycle clock) begins 1.5 s in';
      if(Math.abs(splashClock(14500) - 4.0) > 1e-9) throw 'the cycle is still 4 s long';
      if(String(drawSplash).indexOf('splashClock(now)') < 0) throw 'drawSplash runs on the splash clock';
      simNow = 10300; _canvasDown({ pointerType:'mouse', clientX:0, clientY:0, preventDefault(){} });
      if(!_splashFast || _splashFastStart !== 10300 || _splashFastBase !== 0) throw 'a press in the hold fast-forwards from frame 0: ' + JSON.stringify([_splashFast, _splashFastStart, _splashFastBase]);
      _splashFast = false; simNow = 11700; splashFastStart();
      if(Math.abs(_splashFastBase - 1.2) > 1e-9) throw 'a press after the hold carries the clock, minus the hold: ' + _splashFastBase;
      // The frame is FROZEN through the hold and the dark lead (nothing on it moves), and
      // redrawn once the coin is due, the fast-forward is on or the exit plays.
      const sp = SCREENS.splash; _splashFast = false; _splashExiting = false;
      if(!sp.freeze || typeof sp.anim !== 'function') throw 'the splash is a freezable screen';
      simNow = 10000; if(sp.anim()) throw 'static at frame 0';
      simNow = 11499; if(sp.anim()) throw 'static through the dark lead';
      simNow = 11500; if(!sp.anim()) throw 'animating from the first drop';
      simNow = 10200; _splashFast = true; if(!sp.anim()) throw 'a fast-forward animates'; _splashFast = false;
      _splashExiting = true; if(!sp.anim()) throw 'the exit animates'; _splashExiting = false;
      phase = _oPh; phaseAt = _oAt; simNow = _oNow; _splashFast = _oFast; _splashFastStart = 0; _splashFastBase = 0;
    }
    log('splash hold ok: frame 0 for half a second, then the 4 s cycle, fast-forward on the same clock, the frame frozen until the coin is due');

    // SMOOTH MOTION, the render-side ramp between cells: off by default, the fraction read
    // off the sim's counters, linear where the ramp spans the period and an S where the cap
    // binds, segments part-way between their cells on whole pixels, no slide across a wrap.
    if(cfg.smoothMotion!==0) throw 'smooth motion must default to OFF';
    localStorage.setItem(CFG_KEY, JSON.stringify({ smoothMotion:7 })); loadCfg();
    if(cfg.smoothMotion!==0) throw 'an out-of-range smooth motion value must fall back to OFF';
    if(_smFrac(6, 0, 1, 6, 0.5, 0)!==1) throw 'cap 0 (OFF) must hand the cells back as they are';
    if(_smFrac(6, 0, 1, 6, 0, 3)!==0) throw 'right after a step the ramp must be at 0';
    // Level 10 boosting on the 3-tick cap: the ramp spans the whole period, so it stays linear.
    const lin=[_smFrac(3,0,2,3,0,3), _smFrac(2,0,2,3,0,3), _smFrac(1,0,2,3,0,3)];
    if(Math.abs(lin[0])>1e-9 || Math.abs(lin[1]-1/3)>1e-9 || Math.abs(lin[2]-2/3)>1e-9) throw 'the full-speed ramp must be linear thirds, got '+JSON.stringify(lin);
    // Level 4 (gPer 5, a step every 10 ticks) on the 3-tick cap: an S over the ramp, then a hold at 1.
    const s1=_smFrac(4,0,1,5,0,3), s2=_smFrac(3,0,1,5,0,3), s3=_smFrac(2,0,1,5,0,3), hold=_smFrac(5,1,1,5,0,3);
    if(!(s1>0.2&&s1<0.3) || !(s2>0.7&&s2<0.8) || s3!==1 || hold!==1) throw 'a capped ramp must be an S (0.26, 0.74, 1) and then hold, got '+[s1,s2,s3,hold].join(',');
    const mid=_smFrac(4,0,1,5,0.5,3);
    if(mid<=s1 || mid>=s2) throw 'the sub-tick remainder must move the ramp between two ticks, got '+mid;
    // Segments: nothing slides before a step; half-way after one; a jump of more than a cell does not slide.
    const c0=[{x:5,y:5},{x:4,y:5},{x:3,y:5}];
    let g=_smSegs('t', c0, 0.5);
    if(g[0].x!==5||g[2].x!==3) throw 'with no previous cells the segments must sit on their cells';
    const c1=[{x:6,y:5},{x:5,y:5},{x:4,y:5}];
    g=_smSegs('t', c1, 0.5);
    if(g[0].x!==5.5||g[1].x!==4.5||g[2].x!==3.5) throw 'half-way through the ramp every segment must sit between its two cells, got '+JSON.stringify(g);
    g=_smSegs('t', c1, 0.26);
    if(Math.abs(g[0].x-5.25)>1e-9) throw 'positions must snap to whole pixels, got '+g[0].x;
    g=_smSegs('t', c1, 1);
    if(g!==c1) throw 'a finished ramp must hand the cells back untouched';
    const c2=[{x:0,y:5},{x:6,y:5},{x:5,y:5}];
    g=_smSegs('t', c2, 0.5);
    if(g[0].x!==0) throw 'a head that wrapped must not slide across the board, got '+g[0].x;
    if(g[1].x!==5.5) throw 'the segments behind a wrap still slide, got '+g[1].x;
    log('smooth motion ok: default off, fraction off the counters, linear at full speed, S under the cap, half-way segments on whole pixels, no slide across a wrap');

    // Gameplay smoke: start a game, run the fixed-timestep sim through levelReady into
    // playing so step() actually executes, then render the board.
    simTick=0; simNow=0;
    startGame();
    if(phase!=='levelReady'&&phase!=='playing') throw 'startGame did not enter a level';
    for(let i=0;i<400;i++) update();
    drawGameBoard(simNow);
    if(phase==='levelReady') throw 'sim did not advance out of levelReady (step never ran)';
    log('gameplay smoke ok: phase='+phase+' simTick='+simTick+' snakeLen='+(snake?snake.length:0));

    // Box-exclusive accessories render (snake head + score head) without error.
    cfg.wornItems={eyepatch:1,glasses3d:1,propeller:1,admincrown:1,blackbelt:1,lasereyes:1,goldchain:1};
    drawGameBoard(simNow); drawScoreHead(100,100,0,cfg.wornItems);
    log('box accessories render ok');

    // REGRESSION (head-only duel snake): startDuel never sets the single-player global
    // dir, so in a duel it is undefined. Accessories that read dir (shades, monocle,
    // eyepatch, glasses3d, lasereyes, moustache) threw -> drawSnakeG aborted right after
    // the head -> a head-only snake AND everything drawn later in the frame (the quit
    // dialog) was lost. Any snake wearing one -- local player or online peer -- hit it.
    cfg.wornItems={eyepatch:1,shades:1,monocle:1,glasses3d:1,lasereyes:1,moustache:1};
    simCommand({t:'startDuel', seed:0xC05});
    dir=undefined; snake=undefined;   // a real duel leaves the single-player globals unset
    phase='duel';
    drawDuelBoard(simNow);
    if(!players||players[0].snake.length<2) throw 'duel snake collapsed to a head';
    log('duel accessories render with no single-player dir ok');

    // Windswept steal, render side: the tumbling item and the landed item both draw inside a
    // duel frame, and the duel look follows the SIM's wardrobe rather than this device's
    // config -- a blown-off crown leaves the snake, a won one appears on it.
    simCommand({t:'startDuel', seed:0xC05, ws:[['crown'],['shades']]});
    dir=undefined; snake=undefined; phase='duel';
    _ws.w[0]=[]; _ws.it={ id:'crown', own:0, x:3, y:3, at:simTick+WS_LAND_TICKS };
    armWsFly({ id:'crown', hx:players[0].snake[0].x, hy:players[0].snake[0].y });
    drawDuelBoard(simNow);              // in flight
    _ws.it.at=simTick; drawDuelBoard(simNow);   // landed
    if(!_duelLook().i1.shades) throw 'the duel look dropped a windswept item the sim still has';
    if(_duelLook().i0.crown) throw 'a blown-off item is still worn in the duel look';
    // The landed item is a backlit TILE and the shock ring at the loser's head is its twin:
    // both are lit by _wsOwnerHue, so the board says WHOSE gear is loose, not just where it
    // fell. One colour per victim, and the two victims must not look alike.
    if(_wsOwnerHue(0)!==SNAKE_COLORS[_duelLook().c0].h) throw 'the loose item is not lit in its owner colour';
    if(_wsOwnerHue(0)===_wsOwnerHue(1)) throw 'the two players lose gear in the same colour -- the tile names nobody';
    _ws.it={ id:'crown', own:1, x:7, y:4, at:simTick };
    armWsFly({ id:'crown', own:1, hx:players[1].snake[0].x, hy:players[1].snake[0].y });
    drawDuelBoard(simNow);   // the other victim draws too: tile + shock ring, no throw
    log('windswept steal renders (flight, landed tile, victim colour, shock ring) ok');

    // HIDE REMOTE COSMETICS covers the WINDSWEPT half too. Zeroing the peer profile in the
    // look is not enough on its own: _wsLook paints the SIM's worn list straight back on,
    // and that list is the crowns and hats. The look names the hidden slot; the draw skips
    // the overlay for it and for it only.
    const _realDuelLook = netDuelLook;
    const _stubLook = (hid) => ({ c0:0, c1:1, i0:{necktie:1}, i1:{shoes:1}, hid });   // necktie is not windswept: _wsLook keeps it
    try {
        netDuelLook = () => _stubLook(-1);
        if(!_duelLook().i1.shades) throw 'nobody hidden: the peer windswept gear must still draw';
        netDuelLook = () => _stubLook(1);
        const hl = _duelLook();
        if(Object.keys(hl.i1).length) throw 'the hidden peer still wears gear: ' + JSON.stringify(hl.i1);
        if(!hl.i0.necktie) throw 'hiding the peer stripped our own cosmetics too';
        netDuelLook = () => _stubLook(0);
        const hl0 = _duelLook();
        if(Object.keys(hl0.i0).length) throw 'the hidden peer at P0 still wears gear: ' + JSON.stringify(hl0.i0);
        if(!hl0.i1.shades) throw 'hiding P0 took P1 windswept gear with it';
        netDuelLook = () => ({ c0:0, c1:1, i0:{}, i1:{} });   // an older feeder ships no hid
        if(!_duelLook().i1.shades) throw 'a look with no hid must hide nobody';
    } finally { netDuelLook = _realDuelLook; }
    log('hide remote cosmetics ok: the hidden slot loses its windswept gear too');

    // Side-by-side scrape: presentation only, so the whole rule lives here. Running the same
    // way one lane apart rubs (heads level OR one snake ahead, riding the other's body);
    // tailgating in the SAME lane and any other heading do not. It must keep sparking for as
    // long as the contact lasts -- that is the whole point of judging it per frame.
    _ws.it=null;
    const lane=(hx,y,len)=>Array.from({length:len},(_,i)=>({x:(hx-i+COLS)%COLS,y}));
    const put=(p0,p1,d1)=>{ players[0].snake=p0; players[1].snake=p1;
        players[0].dir={x:1,y:0}; players[1].dir=d1||{x:1,y:0}; };
    put(lane(10,5,6), lane(16,6,8));
    if(!_scrapePoint()) throw 'a head riding the other snake body one lane over did not scrape';
    put(lane(10,5,6), lane(10,6,6));
    if(!_scrapePoint()) throw 'two heads level one lane apart did not scrape';
    put(lane(10,5,6), lane(13,5,3));
    if(_scrapePoint()) throw 'tailgating in the SAME lane scraped';
    put(lane(10,5,6), lane(16,6,8), {x:-1,y:0});
    if(_scrapePoint()) throw 'opposite headings scraped -- that is a pass, not a scrape';
    // The edge is not a contact: nothing is rubbing between the top row and the bottom row, and
    // sparks arcing across the whole board would say otherwise (the sim judges a pass the same).
    put(lane(10,0,6), lane(10,ROWS-1,6));
    if(_scrapePoint()) throw 'the top row scraped against the bottom row across the wrap';
    const col=(x,hy,len)=>Array.from({length:len},(_,i)=>({x,y:(hy+i+ROWS)%ROWS}));
    put(col(0,5,6), col(COLS-1,5,6), {x:0,y:-1}); players[0].dir={x:0,y:-1};
    if(_scrapePoint()) throw 'the left column scraped against the right column across the wrap';
    put(lane(10,5,6), lane(16,6,8));
    _scrapePts.length=0;
    drawDuelBoard(simNow); const one=_scrapePts.length;
    drawDuelBoard(simNow+8);
    if(!(one>0 && _scrapePts.length>one)) throw 'the scrape stopped sparking while the two stayed alongside: '+one+' -> '+_scrapePts.length;
    log('side-by-side scrape: continuous while alongside, quiet when tailgating or passing ok');

    // Blow-off tumble: the item is thrown UP, so it grows toward the apex and shrinks back
    // to its resting size as it drops. drawPixelIcon's size argument is the only place that
    // lands, so sample it there at three points of the flight.
    const sizes=[]; const _dpi=drawPixelIcon;
    drawPixelIcon=(x,y,ic,cs)=>{ sizes.push(cs); return _dpi(x,y,ic,cs); };
    _ws.it={ id:'crown', own:0, x:9, y:3, at:simTick+WS_LAND_TICKS };
    armWsFly({ id:'crown', hx:3, hy:3 });
    const flightSize=(t)=>{ sizes.length=0;
        _ws.it.at=simTick+Math.max(1,Math.round(WS_LAND_TICKS*(1-t)));
        drawDuelBoard(simNow); return Math.max.apply(null, sizes); };
    const sUp=flightSize(0.05), sApex=flightSize(0.5), sDown=flightSize(0.97);
    drawPixelIcon=_dpi;
    if(!(sApex>sUp*1.5 && sApex>sDown*1.5)) throw 'the blown-off item does not rise and grow mid-flight: '+[sUp,sApex,sDown];
    log('blow-off tumble: rises and grows to the apex, falls back to resting size ok');

    // Crash wreck: staged from the DEFERRED 'crash' event, so a rolled-back death never
    // wrecks the board; dropped whole under SIMPLE gfx or REDUCE MOTION. The 0.5s added to
    // DEATH_DUR is what it all plays in, so guard that too.
    if(!FX_DEFER.has('crash')) throw 'crash fx is not deferred -- a rolled-back death would wreck the board';
    if(Math.round(DEATH_DUR-T(54))!==500) throw 'the 0.5s gap the crash animation plays in is gone';
    _ws.it=null; _wsFly=null;
    // The wreck is a COMPACTION FRONT: it starts at the head and walks back down the body,
    // shutting each carriage's gap as it arrives. Depth and travel are both read off the
    // speed the impact happened at, which is why the event carries the level's game tick
    // (gp). So every sample below names an age late enough for the front to have got there.
    // 16 carriages is a real mid-level body: startLen 3..10 plus 2 a gem over 10 gems.
    const straight16=lane(10,5,16);
    put(straight16, lane(16,8,6));
    const hit={ t:'crash', p:0, hx:9, hy:5, x:10, y:5, into:'bar', boost:false, gp:2 };
    _crashFx.length=0;
    cfg.gfxMode=0; armCrash(hit, simNow);
    cfg.gfxMode=1; cfg.reduceMotion=true; armCrash(hit, simNow);
    cfg.reduceMotion=false;
    if(_crashFx.length!==0) throw 'SIMPLE gfx / REDUCE MOTION still staged a crash';
    const fold=(ev,age)=>{ _crashFx.length=0; armCrash(ev, simNow); return _crashJolt(0, simNow+age); };
    const jn=fold(hit, 40);
    if(!jn) throw 'no crash jolt while the wreck is still fresh';
    if(!(jn(0)[0]<0)) throw 'the head did not recoil back off what it hit';
    if(!(jn(0)[2]<0 && jn(0)[3]>0)) throw 'the head did not squash flat against the wall';
    // Depth follows the impact speed rather than a boost flag: boosting arrives at twice the
    // cells per second, and the gentlest crash the game can produce has to leave the body
    // near enough intact next to the hardest one.
    const jc=fold(hit, 300);
    const jb=fold(Object.assign({}, hit, {boost:true}), 300);
    const jsl=fold(Object.assign({}, hit, {gp:7}), 300);
    if(!(jb(5)[0] > jc(5)[0]*1.3)) throw 'boosting did not fold the tail visibly harder: '+[jc(5)[0],jb(5)[0]];
    // 2.5x, not more: with promptness no longer tied to the impact, this compares FINAL depth
    // rather than depth plus the slow crash's late arrival, and final depth is what the crush
    // budget sets.
    if(!(jb(5)[0] > jsl(5)[0]*2.5)) throw 'the gentlest crash folds nearly as hard as the hardest: '+[jsl(5)[0],jb(5)[0]];
    // The front runs at a rate of its OWN -- a buckle wave is a property of the body, not of
    // the impact -- so a gentle crash folds as promptly as a hard one and only less deeply.
    // Carriage 3 is reached at the same age whichever speed the snake arrived at.
    const preS=fold(Object.assign({}, hit, {gp:7}), 2*WAVE_MS-10);
    const preF=fold(Object.assign({}, hit, {boost:true}), 2*WAVE_MS-10);
    if(preS(3)[1]!==0 || preF(3)[1]!==0) throw 'the front reached carriage 3 before its wave was due';
    const onS=fold(Object.assign({}, hit, {gp:7}), 2*WAVE_MS+42);
    const onF=fold(Object.assign({}, hit, {boost:true}), 2*WAVE_MS+42);
    if(onS(3)[1]===0 || onF(3)[1]===0) throw 'the front had not reached carriage 3 at the same age in both crashes';
    // What ENDS the fold is the crush budget, not the clock: past it a carriage keeps its gap
    // and stays unkicked, rather than still creeping down the tail while the respawn is coming.
    const jse=fold(Object.assign({}, hit, {gp:7}), CRASH_DUR-30);
    if(jse(12)[1]!==0) throw 'the front kept kicking carriages past the crush budget';
    if(jse(13)[0]!==jse(12)[0]) throw 'the front kept closing gaps past the crush budget';
    // The fold has a SHAPE, not just a size: neighbouring carriages sit on opposite sides
    // (the zigzag) and the pile-up toward the impact grows down the body (the snake is
    // visibly shorter). Both are still there at the end of the beat -- a wreck stays wrecked.
    const jf=fold(Object.assign({}, hit, {boost:true}), CRASH_DUR-30);
    for(let i=1;i<6;i++){
        if(!(jf(i)[1]*jf(i+1)[1] < 0)) throw 'the crash fold is not a zigzag: carriages '+i+'/'+(i+1)+' kick the same way';
        if(!(jf(i+1)[0] > jf(i)[0])) throw 'the crash fold does not pile up: carriage '+(i+1)+' did not close on the impact';
        // Sign alone is not the test: a kick that rings out to nothing still alternates. Most
        // of it has to be STILL THERE at the end of the beat, which is what a wreck looks like.
        if(!(Math.abs(jf(i)[1]) > CS*0.15)) throw 'the zigzag rang out instead of holding: carriage '+i+' sits '+jf(i)[1]+'px off';
    }
    // A gap shuts by at most all of itself, so carriage i travels at most i cells and stops
    // dead on the head's own cell. That is what keeps the wreck out of the wall it just hit.
    for(let i=1;i<16;i++) if(jf(i)[0] > i*CS) throw 'carriage '+i+' was driven past the head into the wall';
    // Every corner absorbs part of the front, so the more the body is folded back on itself
    // the less of the wreck reaches its tail. Same impact, same length, four shapes.
    // All three bodies put every corner in the first few carriages and then run straight to
    // the tail, so carriage 15 travels along a single leg and the offset vector's LENGTH is
    // the distance the front actually pushed it. Comparing a folded body's chord against a
    // straight one would not do: a bent walk is shorter than a straight one whatever the
    // damping does, so that comparison holds up even with the damping switched off.
    const corner1=[{x:10,y:5},{x:9,y:5}].concat(Array.from({length:14},(_,i)=>({x:9,y:6+i})));
    const corner3=[{x:10,y:5},{x:9,y:5},{x:9,y:6},{x:8,y:6}].concat(Array.from({length:12},(_,i)=>({x:8,y:7+i})));
    // legCells is how many carriages of unbroken straight body sit between the tail and the
    // last corner; the reading is only a distance while the push stays inside that.
    const reach=(segs, legCells)=>{ put(segs, lane(16,8,6));
        const j=fold(Object.assign({}, hit, {boost:true}), CRASH_DUR-30);
        const o=j(15), leg=Math.hypot(o[0], o[1]);
        if(leg > legCells*CS) throw 'the damping probe ran off its straight leg -- the reading is a chord, not a distance';
        return leg; };
    const r0=reach(straight16, 15), r1=reach(corner1, 14), r3=reach(corner3, 12);
    if(!(r1 < r0*0.85)) throw 'one corner did not damp the compaction front: '+[r0,r1];
    if(!(r3 < r1*0.85)) throw 'the extra corners did not damp the front any further: '+[r1,r3];
    put(straight16, lane(16,8,6));
    if(_crashJolt(0, simNow+CRASH_DUR)) throw 'the wreck never settles';
    _crashFx.length=0; armCrash(hit, simNow);
    drawDuelBoard(simNow); drawDuelBoard(simNow+600);
    if(_crashFx.length!==1) throw 'the wreck was dropped while it was still playing';
    drawDuelBoard(simNow+CRASH_DUR);
    if(_crashFx.length!==0) throw 'the wreck outlived CRASH_DUR';
    log('crash wreck: deferred, gated on gfx mode, a compaction front that zigzags and holds, scales in depth with impact speed at a front speed of its own, stops at the crush budget, damps at every corner and never reaches past the head ok');

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
