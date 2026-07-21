// Input-table smoke: every UI phase in SCREENS has a UI_INPUT row (no screen can be
// added without deciding its input semantics), plus behavioral spot-checks of the
// dispatch: nav wrap, any-key-exit, y-confirm, and the full name-entry submit flow.
// Run: node test/smoke-input.js
const { runTest } = require('./harness');

runTest('SMOKE-INPUT', `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const log = (m) => R.steps.push(m);
  function press(k){ handleKey(k, ()=>{}); }
  try {
    simNow=100000; _splashExiting=false; _splashLeftAt=-1e9; _splashKeyHeld=false;

    // Coverage: every SCREENS phase is either a UI_INPUT row or a known gameplay/
    // special phase handled outside the table. A new screen missing both = red.
    const NON_TABLE = new Set(['splash','playing','levelReady','dying','levelDone',
                               'paused','duel','duelReady','duelPaused']);
    for(const ph of Object.keys(SCREENS)){
      if(NON_TABLE.has(ph)) continue;
      if(!UI_INPUT[ph]) throw 'UI phase without an input row: '+ph;
    }
    log('input table covers all UI screens');

    // Menu nav wraps in both directions.
    phase='menu'; menuSel=0; press('ArrowUp');
    if(menuSel!==MENU_ITEMS.length+(ANNOUNCEMENT?1:0)-1) throw 'menu nav did not wrap up';
    press('ArrowDown'); if(menuSel!==0) throw 'menu nav did not wrap back down';

    // Scores: L/R switches tabs, any other key exits to the menu.
    phase='scores'; scoresTab=0; press('ArrowRight');
    if(scoresTab!==1) throw 'scores tab did not switch';
    press('x'); if(phase!=='menu') throw 'scores any-key did not exit to menu';

    // quitConfirm: y confirms the selected option (default NO -> back to prevPhase).
    prevPhase='playing'; phase='quitConfirm'; quitConfirmSel=1; press('y');
    if(phase!=='playing') throw 'quitConfirm y did not act on the NO selection';

    // Name entry: type via text(), delete via Escape alias, submit via Enter.
    phase='nameEntry'; nameStr=''; nameCursorPos=0; nameCharIdx=0; score=1234; level=3;
    press('k'); press('i'); if(nameStr!=='KI') throw 'name text input failed: '+nameStr;
    press('Backspace'); if(nameStr!=='K') throw 'name Backspace delete failed: '+nameStr;
    entryMode='user';   // menu-opened mode: held Backspace on empty must NOT exit
    press('Backspace'); press('Backspace'); press('Backspace');
    if(phase!=='nameEntry') throw 'repeated Backspace must never exit the name entry';
    press('Escape');    // the real ESC on the empty field cancels
    if(phase!=='settings') throw 'ESC on the empty field should cancel to settings';
    phase='nameEntry'; entryMode='score'; nameStr='K'; nameCursorPos=1;
    press('a'); press('Enter');
    if(phase!=='scores') throw 'Enter did not submit the name (phase='+phase+')';
    if(!getScores().some(s=>s.name==='KA'&&s.score===1234)) throw 'submitted score not recorded';
    log('nav wrap, any-key exit, y-confirm, name-entry submit ok');

    // 1:1 menu: 4 entries with wrap; ADD FRIEND opens the hex entry (camera denied in
    // the harness -> manual path), hex-only filter, submit adds the friend.
    localStorage.removeItem('fok-snake-friends');
    phase='duelMenu'; duelSel=0;
    press('ArrowUp'); if(duelSel!==5) throw 'duel menu nav did not wrap up';   // 5 = BACK row
    press('Enter'); if(phase!=='menu') throw 'duel menu BACK did not return to main';
    phase='duelMenu'; duelSel=0;
    press('ArrowUp'); press('ArrowDown'); if(duelSel!==0) throw 'duel menu nav did not wrap down';
    duelSel=1; press('Enter'); if(phase!=='friendId') throw 'SHOW MY ID did not open';
    press('Escape'); if(phase!=='duelMenu') throw 'friendId ESC did not return';
    // Same screen from SETTINGS > USER: returns to settings instead.
    phase='settings'; settingsCat=SETTINGS_CATS.findIndex(c=>c.label==='USER'); settingsSel=1;
    press('Enter'); if(phase!=='friendId') throw 'SHOW MY ID from settings did not open';
    press('Escape'); if(phase!=='settings') throw 'friendId ESC did not return to settings';
    phase='duelMenu';
    duelSel=2; press('Enter');
    if(phase!=='nameEntry'||entryMode!=='friend') throw 'ADD FRIEND did not open the entry (phase='+phase+' mode='+entryMode+')';
    press('g'); if(nameStr!=='') throw 'non-hex char must be ignored in friend mode';
    for(const ch of '00ff00bb') press(ch);
    if(nameStr!=='00FF00BB') throw 'friend hex entry failed: '+nameStr;
    press('Enter');
    if(phase!=='duelMenu') throw 'friend submit did not return to the 1:1 menu';
    if(entryMode!=='score') throw 'entryMode not reset after friend submit';
    if(!getFriends().includes('00ff00bb')) throw 'scanned/typed friend not stored';
    if(_duelMsg.indexOf('FRIEND ADDED')!==0) throw 'missing FRIEND ADDED confirmation';
    // Short/invalid code: submit refuses; ESC on the emptied field cancels out.
    duelSel=2; press('Enter'); press('a'); press('Enter');
    if(phase!=='nameEntry') throw 'short friend code must not submit';
    press('Escape'); press('Escape');
    if(phase!=='duelMenu'||entryMode!=='score') throw 'ESC on empty friend field must cancel';
    log('friend add flow ok (hex filter, submit, cancel)');

    // A verified scanner hit locks first (field filled, success shown), then submits.
    duelSel=2; press('Enter');
    _scanHit('https://poeggi.github.io/FOK-snake/#friend=00ff00cc');
    if(phase!=='nameEntry'||nameStr!=='00FF00CC') throw 'scan hit did not fill the field';
    if(_scanOk!=='00FF-00CC') throw 'scan hit did not show the success message';
    _scanHit('https://poeggi.github.io/FOK-snake/#friend=00ff00dd');
    if(nameStr!=='00FF00CC') throw 'a second hit during the lock must be ignored';
    press('Enter');   // (the auto-submit timer does the same; harness confirms manually)
    if(phase!=='duelMenu'||!getFriends().includes('00ff00cc')) throw 'locked scan did not add the friend';
    if(_scanOk!=='') throw 'lock state must clear on leaving the entry';
    _scanHit('https://poeggi.github.io/FOK-snake/#friend=00ff00dd');
    if(getFriends().includes('00ff00dd')) throw 'scan hit outside the entry screen must be ignored';
    log('scanner hit path ok (lock message + submit)');

    // Viewfinder tap CYCLES the camera on-x1 -> on-x2 -> off -> on-x1; taps elsewhere do not touch it.
    duelSel=2; press('Enter');
    _scanState='live'; _scanVideo=null; _scanZoom=1;   // pretend the camera runs at x1 (no stream in the harness)
    if(_scanTapAt(50,50)) throw 'tap outside the viewfinder must not cycle';
    if(!_scanTapAt(SCAN_VF.x+20,SCAN_VF.y+20)) throw 'viewfinder tap not registered';
    if(_scanState!=='live'||_scanZoom!==2) throw 'first tap must zoom to x2, staying live';
    if(!_scanTapAt(SCAN_VF.x+20,SCAN_VF.y+20)) throw 'second viewfinder tap not registered';
    if(_scanState!=='off'||!_scanManualOff) throw 'second tap must switch the camera off';
    if(!_scanTapAt(SCAN_VF.x+20,SCAN_VF.y+20)) throw 'third viewfinder tap not registered';
    if(_scanManualOff||_scanZoom!==1) throw 'third tap must switch the camera back on at x1';
    press('Escape');   // cancel out (empty field)
    if(_scanManualOff!==false||phase!=='duelMenu') throw 'leave must reset the manual-off state';
    log('viewfinder tap cycle ok (x1 -> x2 -> off -> x1)');

    // SETTINGS > USER: opens the shared dialog in user mode; submit persists the name.
    localStorage.removeItem('lastSName');
    phase='settings'; settingsCat=SETTINGS_CATS.findIndex(c=>c.label==='USER'); settingsSel=0;
    press('Enter');
    if(phase!=='nameEntry'||entryMode!=='user') throw 'USER name entry did not open';
    press('k'); press('a'); press('i'); press('Enter');
    if(phase!=='settings') throw 'user-name submit did not return to settings';
    if(localStorage.getItem('lastSName')!=='KAI') throw 'player name not persisted';
    if(entryMode!=='score') throw 'entryMode not reset after user submit';
    log('settings user-name entry ok');

    // Invite screen: COPY reports (clipboard missing in the harness -> COPY FAILED),
    // CONTINUE and ESC leave to the menu and clear the pending invite.
    _inviteFid='00ff00ee'; phase='invite'; inviteSel=0;
    press('Enter'); if(!_inviteMsg) throw 'invite COPY gave no feedback';
    press('ArrowDown'); if(inviteSel!==1) throw 'invite nav failed';
    press('Enter');
    if(phase!=='menu'||_inviteFid!==null) throw 'invite CONTINUE did not clear + exit';
    log('invite screen flow ok');

    // Touch controls in a live game. The dpad was dead in a duel: CONTROLS omitted
    // it, and .dim is pointer-events:none -- so on a phone (where an online duel has
    // no keyboard) there was no way to steer at all, and boost was gated on
    // phase==='playing' alone. Whatever the keyboard can boost, touch must too.
    for(const ph of ['playing','duel']){
      phase = ph;
      if(!_inPlay()) throw 'touch layer treats a live game as a menu: '+ph;
      if((CONTROLS[ph]||CONTROLS._default).indexOf('dpad') < 0) throw 'dpad dimmed (pointer-events:none) while playing: '+ph;
      if(!_DPAD_GAME.has(ph)) throw 'dpad would auto-repeat steering in: '+ph;
    }
    // ...and a menu must stay a menu: swipes defer to touchend, taps press A.
    for(const ph of ['menu','duelMenu','lobby','settings']){
      phase = ph;
      if(_inPlay()) throw 'menu treated as a live game: '+ph;
    }
    log('touch in-play gates ok: dpad live + boostable in duel, menus unaffected');

    // A duel's local player must get the SAME control surface as a classic player.
    // duel mirrors playing, duelPaused mirrors paused -- offline. (Online drops
    // 'pause' on purpose: togglePause refuses, so a live button would be a lie.)
    const same = (a,b) => a.length===b.length && a.every(x => b.indexOf(x)>=0);
    if(!same(CONTROLS.duel, CONTROLS.playing))
      throw 'duel controls differ from playing: '+CONTROLS.duel+' vs '+CONTROLS.playing;
    if(!same(CONTROLS.duelPaused, CONTROLS.paused))
      throw 'duelPaused controls differ from paused: '+CONTROLS.duelPaused+' vs '+CONTROLS.paused;
    log('duel control surface matches single player');

    // The swipe path asks "am I already boosting this way?" before deciding to end the
    // boost. It read the CLASSIC globals (boosting/boostDir) -- the single-player
    // snake's, which a duel never writes -- so in a duel the answer was always "no" and
    // every swipe movement called gameBoostEnd: boost engaged, then died under the
    // finger. The dpad never read them, which is why only swipe was broken.
    simTick=1000; simNow=simTick*TICK_MS;
    startDuel(0xB005, false); phase='duel';
    players[0].boostDir={x:1,y:0}; players[0].boosting=true;
    players[1].boostDir={x:-1,y:0}; players[1].boosting=false;
    let mb=_myBoost();
    if(!mb.on||mb.dir.x!==1) throw 'duel: _myBoost must read OUR duel snake, not the classic globals';
    // Online as P1, it must read OUR index -- never the opponent's.
    _netSess=_netMkSess('00ff00aa','peer'); _netSess.game=true;
    mb=_myBoost();
    if(mb.on!==false||mb.dir.x!==-1) throw 'online: _myBoost read the OPPONENT boost instead of ours';
    _netSess=null;
    // Classic keeps the globals.
    players=null; boostDir={x:0,y:-1}; boosting=true;
    mb=_myBoost();
    if(!mb.on||mb.dir.y!==-1) throw 'classic: _myBoost must still read the single-player globals';
    boostDir=null; boosting=false; phase='menu'; inGame=false;
    log('swipe boost reads our own snake in every mode (classic, local duel, online)');

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
