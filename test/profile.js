// On-demand performance profile -- NOT part of the default check run.
//   node test/profile.js        (or: bash test/checks.sh --profile)
// Walks every screen, every settings category, both game modes and the hot
// helpers, timing each in the headless harness. The canvas is stubbed, so the
// numbers are JS-side cost only (per-frame logic, loops, allocations) -- real
// rasterization needs a browser; the in-game FPS recorder covers that side.
// Items above 8ms (half a 60fps frame budget) are flagged.
const { runInGame } = require('./harness');

let sandbox;
try {
    sandbox = runInGame(`
;(function(){
  const R = globalThis.__R = { rows: [], warns: [], err: null };
  function bench(name, fn, maxIter){
    try {
      for(let i=0;i<10;i++) fn();                       // warmup
      let n=0; const t0=Date.now();
      do { fn(); n++; } while(Date.now()-t0<50 && n<(maxIter||100000));
      R.rows.push({ name, n, avg:(Date.now()-t0)*1000/n });
    } catch(e) { R.warns.push('SKIPPED '+name+': '+e); }
  }
  try {
    simNow=100000; simTick=6000;

    // ---- menus and static screens ----
    phase='splash'; bench('splash', ()=>drawSplash(simNow));
    phase='menu'; menuSel=0; drawMenu(simNow);
    bench('menu (cached blit)', ()=>drawMenu(simNow));
    bench('menu (cache rebuild)', ()=>{ menuSel=1-menuSel; drawMenu(simNow); });
    phase='news'; _newsAt=0; newsPage=0; bench('news', ()=>drawNews(simNow));
    phase='settings'; settingsCat=-1; settingsSel=0;
    bench('settings (category list)', ()=>drawSettings());
    cfg.debug=1;
    for(let c=0;c<_cats().length;c++){
      settingsCat=c; settingsSel=0;
      bench('settings/'+_cats()[c].label, ()=>drawSettings());   // includes NETWORK
    }
    cfg.debug=0; settingsCat=-1;
    phase='scores'; _scoreboardCache=getScores(); scoresTab=0;
    bench('scores LOCAL', ()=>drawScores());
    scoresTab=1; bench('scores GLOBAL', ()=>drawScores()); scoresTab=0;
    phase='achievements'; achPage=0; bench('achievements', ()=>drawAchievements());
    phase='shop'; try{ _enterShop(); }catch(e){}
    bench('shop', ()=>drawShop());
    phase='credits'; creditsScroll=CH-20; bench('credits', ()=>drawCredits());
    phase='duelMenu'; duelSel=0; bench('duel menu', ()=>drawDuelMenu());
    phase='lobby'; bench('online lobby', ()=>drawLobby());
    phase='friends'; bench('friends screen', ()=>drawFriends());
    phase='friendId'; bench('MY ID (QR cached)', ()=>drawFriendId());
    bench('qrMatrix (cold, cache busted)', ()=>{ _qrCache=null; qrMatrix(friendUrl()); }, 2000);
    _inviteFid='00ff00aa'; phase='invite'; inviteSel=0;
    bench('invite', ()=>drawInvite()); _inviteFid=null;
    phase='quitConfirm'; prevPhase='playing'; quitConfirmSel=1;
    bench('quit confirm', ()=>drawQuitConfirm());
    phase='resetConfirm'; bench('reset confirm', ()=>drawResetConfirm());
    phase='nameEntry';
    entryMode='score'; nameReason='over'; nameStr='PLAYER'; nameCursorPos=6; nameCharIdx=0;
    bench('name entry (score)', ()=>drawNameEntry(simNow));
    entryMode='friend'; nameStr='00FF'; nameCursorPos=4;
    bench('name entry (friend + scan panel)', ()=>drawNameEntry(simNow));
    entryMode='score';

    // ---- classic gameplay (sim + board) ----
    simTick=0; simNow=0; startGame();
    for(let i=0;i<400;i++) update();
    if(phase!=='playing') throw 'profile: game did not reach playing';
    bench('sim tick (classic)', ()=>{ update(); if(simEvents.length>500) simEvents.length=0; }, 50000);
    bench('sim tick + steer', ()=>{
      if(simTick%23===0) gameSteer(0, [GDIRS.ArrowUp,GDIRS.ArrowLeft,GDIRS.ArrowDown,GDIRS.ArrowRight][(simTick/23|0)%4]);
      update(); if(simEvents.length>500) simEvents.length=0;
    }, 50000);
    if(phase!=='playing'){ simTick=0; simNow=0; startGame(); for(let i=0;i<400;i++) update(); }
    bench('game board draw', ()=>drawGameBoard(simNow));
    bench('bars offscreen rebuild', ()=>renderBarsOffscreen(), 5000);
    bench('bar ghost drift (power mode)', ()=>_moveBarsGhost(), 20000);
    bench('HUD update', ()=>updateHUD());

    // ---- duel gameplay ----
    simTick=0; simNow=0; startDuel();
    for(let i=0;i<400;i++) update();
    bench('sim tick (duel)', ()=>{ update(); if(simEvents.length>500) simEvents.length=0; }, 50000);
    bench('duel board draw', ()=>drawDuelBoard(simNow));

    // ---- scanner fallback decoder (every 6th frame while scanning on iOS) ----
    const qq=qrMatrix(friendUrl()), qmod=12, qquiet=4, QS=(29+qquiet*2)*qmod;   // 444px ~ the 464px capture
    const qimg={width:QS,height:QS,data:new Uint8ClampedArray(QS*QS*4).fill(255)};
    for(let r=0;r<29;r++)for(let c=0;c<29;c++)if(qq.m[r][c])
      for(let dy=0;dy<qmod;dy++)for(let dx=0;dx<qmod;dx++){
        const p=(((qquiet+r)*qmod+dy)*QS+(qquiet+c)*qmod+dx)*4;
        qimg.data[p]=qimg.data[p+1]=qimg.data[p+2]=0;
      }
    bench('qrDecodeImage 444px (code visible)', ()=>qrDecodeImage(qimg), 500);
    const qblank={width:464,height:464,data:new Uint8ClampedArray(464*464*4).fill(200)};
    bench('qrDecodeImage 464px (no code)', ()=>qrDecodeImage(qblank), 500);

    // Coverage: every SCREENS phase must be profiled here (directly or via the
    // game-board/duel-board draws) -- a new screen missing from this list warns.
    const covered=new Set(['splash','menu','news','settings','scores','achievements','shop',
      'credits','duelMenu','lobby','friends','friendId','invite','quitConfirm','resetConfirm','nameEntry',
      'playing','paused','dying','levelReady','levelDone',
      'duel','duelReady','duelPaused','duelOver']);
    for(const ph of Object.keys(SCREENS))
      if(!covered.has(ph)) R.warns.push('NOT PROFILED (new screen?): '+ph);
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
} catch (e) { console.log('PROFILE LOAD ERROR:\n' + (e.stack || e)); process.exit(1); }

const R = sandbox.__R;
if (!R || R.err) { console.log('PROFILE ERROR: ' + (R ? R.err : 'no result')); process.exit(1); }
R.rows.sort((a, b) => b.avg - a.avg);
const BUDGET = 16667;   // one 60fps frame, in us
console.log('headless profile -- JS-side cost only (canvas stubbed; rasterization excluded)');
console.log('');
console.log('item'.padEnd(38) + 'avg'.padStart(10) + 'runs'.padStart(7) + 'frame%'.padStart(9));
let warned = 0;
for (const r of R.rows) {
    const avgTxt = r.avg >= 1000 ? (r.avg / 1000).toFixed(2) + 'ms' : r.avg.toFixed(1) + 'us';
    const flag = r.avg > 8000 ? '  <<< WARN: >8ms' : (r.avg > 2000 ? '  << watch' : '');
    if (r.avg > 8000) warned++;
    console.log(r.name.padEnd(38) + avgTxt.padStart(10) + String(r.n).padStart(7)
        + ((r.avg / BUDGET * 100).toFixed(1) + '%').padStart(9) + flag);
}
for (const w of R.warns) console.log('WARN: ' + w);
console.log('');
console.log(warned ? 'PROFILE DONE: ' + warned + ' item(s) above 8ms -- investigate'
                   : 'PROFILE DONE: no item above 8ms (half a 60fps frame)');
