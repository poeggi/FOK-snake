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

    // MULTIPLAYER menu: 5 rows + BACK with wrap; ADD FRIEND opens the hex entry (camera denied in
    // the harness -> manual path), hex-only filter, submit adds the friend.
    localStorage.removeItem('fok-snake-friends');
    phase='multiplayer'; multiSel=0;
    press('ArrowUp'); if(multiSel!==5) throw 'duel menu nav did not wrap up';   // 5 = BACK row
    press('Enter'); if(phase!=='menu') throw 'duel menu BACK did not return to main';
    phase='multiplayer'; multiSel=0;
    press('ArrowUp'); press('ArrowDown'); if(multiSel!==0) throw 'duel menu nav did not wrap down';
    multiSel=2; press('Enter'); if(phase!=='myId') throw 'SHOW MY ID did not open';   // MULTIPLAYER order: 0 1vs1 DUEL, 1 TOURNAMENT, 2 MY ID, 3 ADD FRIEND, 4 FRIENDS
    press('Escape'); if(phase!=='multiplayer') throw 'myId ESC did not return';
    // 1vs1 DUEL submenu: opens from row 0; TOURNAMENT (row 1) is greyed and stays put.
    multiSel=0; press('Enter'); if(phase!=='duelMenu') throw '1vs1 DUEL did not open its submenu';
    press('ArrowUp'); if(duelSel!==2) throw 'duelMenu nav did not wrap up';   // 2 = BACK row
    press('Enter'); if(phase!=='multiplayer') throw 'duelMenu BACK did not return';
    multiSel=1; press('Enter'); if(phase!=='multiplayer') throw 'TOURNAMENT must stay put (coming soon)';
    // Same screen from SETTINGS > USER: returns to settings instead.
    phase='settings'; settingsCat=SETTINGS_CATS.findIndex(c=>c.label==='USER'); settingsSel=1;
    press('Enter'); if(phase!=='myId') throw 'SHOW MY ID from settings did not open';
    press('Escape'); if(phase!=='settings') throw 'myId ESC did not return to settings';
    phase='multiplayer';
    multiSel=3; press('Enter');
    if(phase!=='nameEntry'||entryMode!=='friend') throw 'ADD FRIEND did not open the entry (phase='+phase+' mode='+entryMode+')';
    press('g'); if(nameStr!=='') throw 'non-hex char must be ignored in friend mode';
    for(const ch of '00ff00b') press(ch);
    // The SUBMIT button is greyed short of 8 digits and has to be inert, not merely dim:
    // even parked on it, an incomplete ID must not arm it.
    nameCursorPos=_entryMax(); if(_entryOnOk()) throw 'the submit button armed with only 7 digits';
    nameCursorPos=7; press('b');
    if(nameStr!=='00FF00BB') throw 'friend hex entry failed: '+nameStr;
    // The 8th digit lands the cursor on the SUBMIT key past the last slot, and OK there sends
    // the ID: on a TV or a gamepad there is no RETURN key to reach for.
    if(!_entryOnOk()) throw 'the last digit did not move the cursor onto the submit key (pos='+nameCursorPos+')';
    press('NameAdd');
    if(phase!=='multiplayer') throw 'friend submit did not return to the 1vs1 menu';
    if(entryMode!=='score') throw 'entryMode not reset after friend submit';
    if(!getFriends().includes('00ff00bb')) throw 'scanned/typed friend not stored';
    if(_duelMsg.indexOf('FRIEND ADDED')!==0) throw 'missing FRIEND ADDED confirmation';
    // Short/invalid code: submit refuses. Backspace deletes a digit; ESC is BACK --
    // one press leaves ADD FRIEND even with a digit still in the field.
    multiSel=3; press('Enter'); press('a'); press('Enter');
    if(phase!=='nameEntry') throw 'short friend code must not submit';
    press('Backspace'); if(nameStr!=='') throw 'Backspace must delete a friend digit';
    press('a'); press('Escape');
    if(phase!=='multiplayer'||entryMode!=='score') throw 'ESC must leave ADD FRIEND (back)';
    log('friend add flow ok (hex filter, submit gated on 8 digits, back)');

    // A verified scanner hit locks first (field filled, success shown), then submits.
    multiSel=3; press('Enter');
    _scanHit('https://poeggi.github.io/FOK-snake/#friend=00ff00cc');
    if(phase!=='nameEntry'||nameStr!=='00FF00CC') throw 'scan hit did not fill the field';
    if(_scanOk!=='00FF-00CC') throw 'scan hit did not show the success message';
    _scanHit('https://poeggi.github.io/FOK-snake/#friend=00ff00dd');
    if(nameStr!=='00FF00CC') throw 'a second hit during the lock must be ignored';
    press('Enter');   // (the auto-submit timer does the same; harness confirms manually)
    if(phase!=='multiplayer'||!getFriends().includes('00ff00cc')) throw 'locked scan did not add the friend';
    if(_scanOk!=='') throw 'lock state must clear on leaving the entry';
    _scanHit('https://poeggi.github.io/FOK-snake/#friend=00ff00dd');
    if(getFriends().includes('00ff00dd')) throw 'scan hit outside the entry screen must be ignored';
    log('scanner hit path ok (lock message + submit)');

    // Server-checked ADD FRIEND (API 3.5): an id nobody ever registered must NOT leave
    // the screen and must NOT reach the friend list, and a throttled request reports the
    // wait the server asked for. netFriendVerify is stubbed with a SYNCHRONOUS thenable
    // (the real one wraps a fetch) so this driver can see the outcome it resolves with.
    const _oNetOk=_netOk, _oVerify=netFriendVerify;
    _netOk=()=>true; let _vRes=null; netFriendVerify=()=>({ then:f=>f(_vRes) });
    _vRes={ error:'unknown' };
    phase='multiplayer'; multiSel=3; press('Enter');
    for(const ch of '00ff0099') press(ch);
    press('Enter');
    if(phase!=='nameEntry') throw 'an unknown friend id must not leave ADD FRIEND';
    if(getFriends().includes('00ff0099')) throw 'an unknown friend id must not be stored';
    if(!/NO SUCH PLAYER/.test(_duelMsg)) throw 'missing no-such-id status: '+_duelMsg;
    _vRes={ error:'rate', wait:60 };
    press('Enter');
    if(phase!=='nameEntry'||!/WAIT 60S/.test(_duelMsg)) throw 'throttled request must show the wait: '+_duelMsg;
    _vRes={ ok:true, state:'pending' };
    press('Enter');
    if(phase!=='multiplayer'||!getFriends().includes('00ff0099')) throw 'a confirmed id must add and leave';
    _netOk=_oNetOk; netFriendVerify=_oVerify;
    log('friend id check ok (unknown blocks, throttle reported, confirmed adds)');

    // Backspace on a FULL field takes the LAST character. The cursor is a SLOT index, so
    // a full 8/8 friend id leaves it ON the last slot: deleting "the one before the
    // cursor" stranded the final digit and no retyping could correct it (iPad report).
    phase='nameEntry'; entryMode='friend'; nameStr='00FF00BB'; nameCursorPos=7;
    press('Backspace'); if(nameStr!=='00FF00B') throw 'Backspace on a full field must take the last digit: '+nameStr;
    press('Backspace'); if(nameStr!=='00FF00') throw 'Backspace below full must keep deleting: '+nameStr;
    press('Escape'); phase='multiplayer'; entryMode='score';
    log('full-field backspace ok');

    // Viewfinder tap CYCLES the camera on-x1 -> on-x2 -> off -> on-x1; taps elsewhere do not touch it.
    multiSel=3; press('Enter');
    _scanState='live'; _scanVideo=null; _scanZoom=1;   // pretend the camera runs at x1 (no stream in the harness)
    if(_scanTapAt(50,50)) throw 'tap outside the viewfinder must not cycle';
    if(!_scanTapAt(SCAN_VF.x+20,SCAN_VF.y+20)) throw 'viewfinder tap not registered';
    if(_scanState!=='live'||_scanZoom!==2) throw 'first tap must zoom to x2, staying live';
    if(!_scanTapAt(SCAN_VF.x+20,SCAN_VF.y+20)) throw 'second viewfinder tap not registered';
    if(_scanState!=='off'||!_scanManualOff) throw 'second tap must switch the camera off';
    if(!_scanTapAt(SCAN_VF.x+20,SCAN_VF.y+20)) throw 'third viewfinder tap not registered';
    if(_scanManualOff||_scanZoom!==1) throw 'third tap must switch the camera back on at x1';
    press('Escape');   // cancel out (empty field)
    if(_scanManualOff!==false||phase!=='multiplayer') throw 'leave must reset the manual-off state';
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
    _inviteFid='00ff00ee'; phase='duelInvite'; inviteSel=0;
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
    for(const ph of ['menu','multiplayer','duelLobby','settings']){
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

    // RINGTONE PANEL (hold SND) owns the pointer while it is up. The document swipe layer
    // preventDefault()s every touch outside the control mask -- and a prevented touchstart is
    // a click the browser never synthesises, so the panel buttons went dead -- then it
    // answered finger-up with handleKey(Enter), pressing the menu item behind the glass.
    for(const id of ['gamepad','btn-mute','fps-el'])   // the elStub reports 600x400 for every id, which would mask the whole screen
      document.getElementById(id).getBoundingClientRect=()=>({left:0,top:0,width:0,height:0,right:0,bottom:0});
    const touch=(x,y)=>{ const o={touches:[{clientX:x,clientY:y}],changedTouches:[{clientX:x,clientY:y}],
      prevented:false,preventDefault(){o.prevented=true;},stopPropagation(){},stopImmediatePropagation(){}}; return o; };
    phase='menu'; menuSel=0;
    const bare=touch(300,200); document.__emit('touchstart',bare);
    if(!bare.prevented||!_swipeBase) throw 'no panel: the menu swipe layer must still claim the touch';
    _swipeBase=null;   // drop the armed gesture: its touchend would select a menu item
    fetch=()=>Promise.reject(new Error('harness offline'));   // opening the panel prefetches the tone (share sheet needs it in hand)
    ringOfferOpen(); if(!_ringEl) throw 'ringtone panel did not open';
    const over=touch(300,200); document.__emit('touchstart',over);
    if(over.prevented) throw 'panel up: the swipe layer swallowed the tap -- the panel buttons get no click';
    if(_swipeBase) throw 'panel up: the swipe layer armed a gesture behind the panel';
    const ph0=phase, sel0=menuSel;
    document.__emit('touchend',over);
    if(phase!==ph0||menuSel!==sel0) throw 'panel up: finger-up pressed the menu behind the glass';
    ringOfferClose(); if(_ringEl) throw 'ringtone panel did not close';
    log('ringtone panel owns the pointer: no swallowed tap, no menu press behind the glass');

    // A finger lifted DURING THE DEATH ANIMATION must still release the boost arm.
    // The swipe layer's touchend release was gated on _inPlay(), and 'dying' is not
    // in play: the swallowed release left the arm slot held with the finger gone, so
    // the snake respawned boosting on its own and nothing ever ended it. Release is
    // never phase-gated (engage is) -- keyboard keyup and dpad touchend already obey.
    startDuel(0xDEAD, false); phase='duel'; inGame=true;
    document.__emit('touchstart', touch(300,200));       // finger down on the play surface
    if(!_swipeBase) throw 'play touch did not arm the swipe layer';
    gameBoostStart(0,{x:1,y:0});                         // the hold armed a boost
    if(!_armSlots[0]||_armSlots[0].off) throw 'boost hold did not arm the slot';
    phase='dying';                                       // the snake dies under the finger...
    document.__emit('touchend', touch(300,200));         // ...and the finger lifts during the animation
    if(!_armSlots[0]||!_armSlots[0].off) throw 'REGRESSION: finger-up in dying was swallowed -- the snake respawns boosting';
    _swipeBase={x:300,y:200}; gameBoostStart(0,{x:1,y:0});   // same rule for a cancelled touch (iOS system gesture)
    document.__emit('touchcancel', touch(300,200));
    if(!_armSlots[0]||!_armSlots[0].off) throw 'touchcancel in dying was swallowed -- the boost arm leaks';
    players=null; phase='menu'; inGame=false; _armSlots=[];
    log('finger-up during dying still releases the boost arm (no respawn-boosting)');

    // The name / friend-id / join-code DIAL is grabbed, not stepped. drawNameEntry lays the
    // character set out downwards, so a finger dragged UP pulls the character BELOW into the
    // window -- the reel follows the finger. Only the touch path works that way: a keyboard
    // arrow, a d-pad press and the TV remote keep list semantics, ArrowDown for the next one.
    phase='nameEntry'; entryMode='user'; nameStr=''; nameCursorPos=0; nameCharIdx=5;
    document.__emit('touchstart', touch(300,200));
    document.__emit('touchmove',  touch(300,120));   // 80px up, well past MENU_SWIPE_1
    if(nameCharIdx!==6) throw 'a swipe UP must turn the dial to the NEXT character, got idx '+nameCharIdx;
    document.__emit('touchend',   touch(300,120));
    document.__emit('touchstart', touch(300,200));
    document.__emit('touchmove',  touch(300,280));   // 80px down
    if(nameCharIdx!==5) throw 'a swipe DOWN must turn the dial back, got idx '+nameCharIdx;
    document.__emit('touchend',   touch(300,280));
    handleKey('ArrowDown',null);
    if(nameCharIdx!==6) throw 'the keyboard must keep list steps: ArrowDown is the next character';
    handleKey('ArrowUp',null);
    if(nameCharIdx!==5) throw 'the keyboard must keep list steps: ArrowUp is the previous character';
    phase='menu'; entryMode='score'; nameCharIdx=0; _swipeBase=null; _swipeLastDir=null;
    log('entry dial follows the finger (swipe up = next character); keyboard keeps list steps');

    // The tablet keyboard belongs to the FIELD. It used to be raised by ANY touch on the
    // entry screen, so on an iPad it covered the dial the moment a finger went down and the
    // dial could not be turned at all. Only a finger on the character slots focuses now;
    // everything else -- the dial, the SUBMIT pill, a swipe -- puts the keyboard away.
    let kbOn=0, kbOff=0;
    const _realFocus=nameInp.focus, _realBlur=nameInp.blur;
    nameInp.focus=()=>{ kbOn++; }; nameInp.blur=()=>{ kbOff++; };
    const down=(x,y)=>{ document.__emit('touchstart', touch(x,y)); document.__emit('touchend', touch(x,y)); };
    try {
        phase='nameEntry'; entryMode='user'; nameStr=''; nameCursorPos=0;
        down(300,140);                                   // on the slots (y 122..162)
        if(kbOn!==1||kbOff!==0) throw 'a touch on the field must raise the keyboard';
        down(300,300);                                   // on the dial, well below the field
        if(kbOn!==1||kbOff!==1) throw 'a touch on the dial must not raise the keyboard';
        entryMode='friend'; nameStr=''; nameCursorPos=0;
        down(300,140);
        if(kbOn!==2) throw 'the friend-id field must raise the keyboard too';
        down(450,140);                                   // the SUBMIT pill sits beside the slots
        if(kbOn!==2||kbOff!==2) throw 'the SUBMIT pill is a control, not somewhere to type';
    } finally { nameInp.focus=_realFocus; nameInp.blur=_realBlur; }
    phase='menu'; entryMode='score'; _swipeBase=null; _swipeLastDir=null;
    log('the tablet keyboard is raised by the field alone, and dismissed by everything else');

    // THE CEREMONY SCREEN'S ESCAPE IS FOR THE PEOPLE IT IS ASKING TO WAIT. A player it
    // names is about to be put into a duel and must not walk off to the board while the
    // link comes up -- but a match that never comes up must not hold them either, least
    // of all the host: their ESC asks the leave/end question, and NO returns them here.
    const oTt = _tt;
    _tt = { state:'running', round:2, host:getPlayerId(), players:['00000000','00000001'],
            roles:{ round:2, players:['00000000','00000001'], you:'play' } };
    phase='tourneyCeremony'; press('Escape');
    if(phase!=='tourneyQuit') throw 'the host being called up got no way to end the tournament: '+phase;
    if(tourneyUi().from!=='tourneyCeremony') throw 'the end question does not know where it was asked from: '+tourneyUi().from;
    if(quitConfirmSel!==1) throw 'the end question did not offer NO as the safe answer';
    press('Escape');
    if(phase!=='tourneyCeremony') throw 'NO did not return the host to the ceremony: '+phase;
    _tt.host='00000001'; press('Escape');
    if(phase!=='tourneyQuit') throw 'a guest being called up got no way to leave: '+phase;
    press('Escape');
    if(phase!=='tourneyCeremony') throw 'NO did not return the guest to the ceremony: '+phase;
    _tt.roles.you='spectate'; press('Escape');
    if(phase!=='tourneyBracket') throw 'a spectator could not reach the board: '+phase;
    _tt.roles.you='idle'; phase='tourneyCeremony'; press('Escape');
    if(phase!=='tourneyBracket') throw 'a player sitting the round out could not reach the board: '+phase;
    _tt = oTt; phase='menu';
    log('the ceremony asks the player it names before letting them go, and lets everyone else read the board');

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
