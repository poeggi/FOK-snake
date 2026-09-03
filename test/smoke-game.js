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
    // wrecks the board; dropped whole under SIMPLE gfx or REDUCE MOTION; and boosting has to
    // fold the tail visibly harder than normal speed. The 0.5s added to DEATH_DUR is what it
    // all plays in, so guard that too.
    if(!FX_DEFER.has('crash')) throw 'crash fx is not deferred -- a rolled-back death would wreck the board';
    if(Math.round(DEATH_DUR-T(54))!==500) throw 'the 0.5s gap the crash animation plays in is gone';
    _ws.it=null; _wsFly=null;
    const hit={ t:'crash', p:0, hx:9, hy:5, x:10, y:5, into:'bar', boost:false };
    _crashFx.length=0;
    cfg.gfxMode=0; armCrash(hit, simNow);
    cfg.gfxMode=1; cfg.reduceMotion=true; armCrash(hit, simNow);
    cfg.reduceMotion=false;
    if(_crashFx.length!==0) throw 'SIMPLE gfx / REDUCE MOTION still staged a crash';
    armCrash(hit, simNow);
    const jn=_crashJolt(0, simNow+40);
    _crashFx.length=0; armCrash(Object.assign({}, hit, {boost:true}), simNow);
    const jb=_crashJolt(0, simNow+40);
    if(!jn || !jb) throw 'no crash jolt while the wreck is still fresh';
    if(!(jn(0)[0]<0)) throw 'the head did not recoil back off what it hit';
    if(!(jn(0)[2]<0 && jn(0)[3]>0)) throw 'the head did not squash flat against the wall';
    if(!(Math.abs(jb(5)[0]) > Math.abs(jn(5)[0])*2)) throw 'boosting did not fold the tail visibly harder';
    // The fold has a SHAPE, not just a size: once the buckle wave has run the length of the
    // body, neighbouring carriages sit on opposite sides (the zigzag) and the pile-up toward
    // the impact grows monotonically down the body (the snake is visibly shorter). Both are
    // still there at the end of the beat -- a wreck stays wrecked.
    const jf=_crashJolt(0, simNow+CRASH_DUR-30);
    for(let i=1;i<6;i++){
        if(!(jf(i)[1]*jf(i+1)[1] < 0)) throw 'the crash fold is not a zigzag: carriages '+i+'/'+(i+1)+' kick the same way';
        if(!(jf(i+1)[0] > jf(i)[0])) throw 'the crash fold does not pile up: carriage '+(i+1)+' did not close on the impact';
    }
    if(jf(Math.ceil(FOLD_STOP/7)+1)[1]!==0) throw 'the buckle wave kept spreading past FOLD_STOP';
    if(_crashJolt(0, simNow+CRASH_DUR)) throw 'the wreck never settles';
    _crashFx.length=0; armCrash(hit, simNow);
    drawDuelBoard(simNow); drawDuelBoard(simNow+600);
    if(_crashFx.length!==1) throw 'the wreck was dropped while it was still playing';
    drawDuelBoard(simNow+CRASH_DUR);
    if(_crashFx.length!==0) throw 'the wreck outlived CRASH_DUR';
    log('crash wreck: deferred, gated on gfx mode, concertinas into a zigzag that holds, folds harder at boost, settles ok');

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
