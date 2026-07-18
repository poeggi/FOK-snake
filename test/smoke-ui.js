// UI smoke: splash key capture, settings sub-menus, all settings screens render,
// menu cache, multi-page newspaper. Run: node test/smoke-ui.js
const { runTest } = require('./harness');

runTest('SMOKE-UI', `
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
    simNow=100000; _splashExiting=false; _splashLeftAt=-1e9; _splashKeyHeld=false;
    phase='menu'; menuSel=MENU_ITEMS.indexOf('SETTINGS'); settingsCat=-1; settingsSel=0;

    press('Enter');                                    // open SETTINGS (category list)
    if(phase!=='settings'||settingsCat!==-1) throw 'expected settings category list';

    settingsSel=SETTINGS_CATS.findIndex(c=>c.label==='AUDIO'); press('Enter');
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

    settingsCat=-1; settingsSel=SETTINGS_CATS.findIndex(c=>c.label==='NETWORK'); press('Enter');
    if(SETTINGS_CATS[settingsCat].label!=='NETWORK') throw 'expected NETWORK';
    settingsSel=0; const off0=cfg.offline; press('Enter');   // STRICTLY OFFLINE is the first NETWORK item now
    if(cfg.offline===off0) throw 'strictly-offline toggle did nothing';
    cfg.offline=false;                                 // leave the rest of the suite online
    press('Escape'); if(settingsCat!==-1) throw 'ESC should return to category list';
    log('settings NETWORK ok');

    settingsSel=SETTINGS_CATS.findIndex(c=>c.label==='DATA'); press('Enter');
    if(SETTINGS_CATS[settingsCat].label!=='DATA') throw 'expected DATA';
    settingsSel=0; press('Enter');                     // backup
    if(_dataMsg!=='BACKUP SAVED') throw 'backup did not report saved';
    settingsSel=1; press('Enter');                     // restore (no file) must not throw
    settingsSel=2; press('Enter');                     // reset -> resetConfirm
    if(phase!=='resetConfirm') throw 'reset should open resetConfirm';
    press('Escape');
    if(phase!=='settings') throw 'ESC from resetConfirm should return to settings';
    log('settings DATA ok');

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

    // 1:1 submenu renders in all selection states (+ confirmation line), and the
    // MY ID / ADD FRIEND / invite screens draw without error.
    phase='duelMenu'; _duelMsg='FRIEND ADDED: 00FF-00AA'; _duelMsgAt=simNow;
    for(duelSel=0; duelSel<4; duelSel++) drawDuelMenu();
    _duelMsg='';
    phase='friendId'; drawFriendId();
    _inviteFid='00ff00aa'; phase='invite';
    inviteSel=0; drawInvite(); inviteSel=1; _inviteMsg='COPIED!'; _inviteMsgAt=simNow; drawInvite();
    _inviteFid=null; _inviteMsg='';
    phase='nameEntry';
    entryMode='friend'; nameStr='00FF'; nameCursorPos=4; nameCharIdx=0; drawNameEntry(simNow);
    entryMode='user'; nameStr='KAI'; nameCursorPos=3; drawNameEntry(simNow);
    entryMode='score'; phase='menu';
    log('duel submenu + friend/invite screens render ok');

    // Multi-page newspaper: render and flip pages without error.
    phase='news'; _newsAt=0; newsPage=0; drawNews(1000);
    press('ArrowRight'); if(newsPage!==1) throw 'news: LEFT/RIGHT did not flip pages';
    drawNews(1000); press('ArrowLeft'); if(newsPage!==0) throw 'news: page flip did not wrap back';
    log('multi-page news ok: pages='+((ANNOUNCEMENT&&ANNOUNCEMENT.pages&&ANNOUNCEMENT.pages.length)||1));

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
