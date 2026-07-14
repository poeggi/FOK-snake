// Headless smoke test: drive the menus, settings sub-menus, backup/restore,
// config-load tolerance, and a short gameplay run -- asserting no exceptions.
// Run: node test/smoke.js   (exit 0 = pass, 1 = fail)
const { runTest } = require('./harness');

const driver = `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const log = (m) => R.steps.push(m);
  function press(k){ handleKey(k, ()=>{}); }
  try {
    // Splash captures only arrows (fast-forward) + Space/Enter (start); ignores the rest
    // so browser shortcuts (Ctrl+Shift+R) survive.
    phase='splash'; _splashExiting=false; _splashFast=false; _splashKeyHeld=false;
    press('r'); if(phase!=='splash'||_splashExiting) throw 'splash must ignore letter keys (Ctrl+Shift+R safe)';
    press('ArrowLeft'); if(phase!=='splash'||_splashExiting) throw 'arrow must not exit splash';
    if(!_splashFast) throw 'arrow should fast-forward the splash';
    press('Enter'); if(!_splashExiting) throw 'Enter should start the splash exit';
    log('splash key capture ok');

    // From splash, force menu. Advance sim clock past the 200ms post-splash input guard.
    simNow=100000; _splashExiting=false; _splashLeftAt=0; _splashKeyHeld=false;
    phase='menu'; menuSel=1; settingsCat=-1; settingsSel=0;

    press('Enter');                                    // open SETTINGS (category list)
    if(phase!=='settings'||settingsCat!==-1) throw 'expected settings category list';

    settingsSel=0; press('Enter');                     // enter AUDIO
    if(SETTINGS_CATS[settingsCat].label!=='AUDIO') throw 'expected AUDIO submenu';
    const beforeMusic=cfg.music; settingsSel=0; press('Enter');
    if(cfg.music===beforeMusic) throw 'audio toggle did nothing';
    press('Enter');                                    // toggle back
    settingsSel=2; const v0=cfg.volume; press('ArrowLeft');
    if(!(cfg.volume<=v0)) throw 'volume slider did not decrease';
    press('ArrowRight');
    press('Escape');                                   // back to category list
    if(settingsCat!==-1) throw 'ESC should return to category list';
    log('settings AUDIO ok');

    settingsSel=SETTINGS_CATS.length-1; press('Enter');// DATA MANAGEMENT
    if(SETTINGS_CATS[settingsCat].label!=='DATA MANAGEMENT') throw 'expected DATA MANAGEMENT';
    settingsSel=0; const off0=cfg.offline; press('Enter');
    if(cfg.offline===off0) throw 'strictly-offline toggle did nothing';
    settingsSel=1; press('Enter');                     // backup
    if(_dataMsg!=='BACKUP SAVED') throw 'backup did not report saved';
    settingsSel=2; press('Enter');                     // restore (no file) must not throw
    settingsSel=3; press('Enter');                     // reset -> resetConfirm
    if(phase!=='resetConfirm') throw 'reset should open resetConfirm';
    press('Escape');
    if(phase!=='settings') throw 'ESC from resetConfirm should return to settings';
    log('settings DATA MANAGEMENT ok');

    // Render every settings screen once to catch draw-time exceptions
    settingsCat=-1; drawSettings();
    for(let c=0;c<SETTINGS_CATS.length;c++){ settingsCat=c;
      for(settingsSel=0; settingsSel<=SETTINGS_CATS[c].items.length; settingsSel++) drawSettings(); }
    log('drawSettings all screens ok');

    // Back out to menu
    settingsCat=-1; settingsSel=SETTINGS_CATS.length; press('Enter');
    if(phase!=='menu') throw 'BACK from category list should return to menu';

    // Menu static cache: rebuild on selection change, then blit + animated overlay.
    menuSel=0; drawMenu(simNow); menuSel=1; drawMenu(simNow); drawMenu(simNow);
    log('drawMenu (cached) ok');

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

    // Gameplay smoke: reset the sim clock (the settings phase advanced it past the
    // input guard), start a game, run the fixed-timestep sim through levelReady into
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

    // Mystery box shop: render the boxes page and open a box without error.
    phase='shop'; shopPage=BOX_PAGE; shopSel=0; drawShop();
    _cachedFOKoins=5000000; cfg.shopItems={}; _openBox(BOXES[0]); drawShop();
    if(!_boxReward) throw 'opening a box produced no reward';
    log('mystery box shop ok: reward='+_boxReward.kind);

    // Box gear tab: a won box-exclusive cosmetic appears there and is wearable.
    cfg.shopItems=Object.assign(cfg.shopItems||{},{eyepatch:true}); cfg.wornItems={};
    if(!_gearList().some(g=>g.id==='eyepatch')) throw 'won box item missing from BOX GEAR list';
    shopPage=GEAR_PAGE; shopSel=0; drawShop();
    press(' '); if(!cfg.wornItems.eyepatch) throw 'BOX GEAR: SPACE did not wear the item';
    press(' '); if(cfg.wornItems.eyepatch)  throw 'BOX GEAR: SPACE did not remove the item';
    log('box gear tab ok');

    // ADMIN box: offered only when available, grants the guaranteed crown, then is consumed.
    _adminAvail=true; _adminConsumed=false; delete cfg.shopItems.admincrown;
    if(_boxList().length!==BOXES.length+1) throw 'ADMIN box not offered when available';
    _openBox(ADMIN_BOX);
    if(!(cfg.shopItems.admincrown && _adminConsumed)) throw 'ADMIN box did not grant + consume';
    if(_boxList().length!==BOXES.length) throw 'ADMIN box still offered after being claimed';
    log('admin box ok');

    // Multi-page newspaper: render and flip pages without error.
    phase='news'; _newsAt=0; newsPage=0; drawNews(1000);
    press('ArrowRight'); if(newsPage!==1) throw 'news: LEFT/RIGHT did not flip pages';
    drawNews(1000); press('ArrowLeft'); if(newsPage!==0) throw 'news: page flip did not wrap back';
    log('multi-page news ok: pages='+((ANNOUNCEMENT&&ANNOUNCEMENT.pages&&ANNOUNCEMENT.pages.length)||1));

    // Backup integrity checksum: non-zero for real data, and any edit changes it.
    const _snap={v:1,hs:'x',coins:'100',ach:'{}',cfg:'{}',name:'AB'};
    const _good=_sumOf(_snap);
    if(!(_good>0)) throw 'save checksum should be non-zero for real data';
    if(_sumOf({..._snap,coins:'999999'})===_good) throw 'editing data must change the checksum';
    log('save checksum ok');

    // Hidden DEBUGGING category: absent at debug=0, present + rendering at debug>0.
    cfg.debug=0; if(_cats().some(c=>c.label==='DEBUGGING')) throw 'DEBUGGING must be hidden at debug=0';
    cfg.debug=1; if(!_cats().some(c=>c.label==='DEBUGGING')) throw 'DEBUGGING must appear at debug>0';
    phase='settings'; settingsCat=_cats().length-1;
    for(settingsSel=0; settingsSel<=_cats()[settingsCat].items.length; settingsSel++) drawSettings();
    cfg.debug=0; settingsCat=-1; settingsSel=0;
    log('debug menu ok');

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`;
runTest('SMOKE', driver);
