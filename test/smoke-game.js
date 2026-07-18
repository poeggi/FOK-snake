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

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
