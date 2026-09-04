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
    if(_dataMsg!=='CONFIG SAVED TO FILE') throw 'backup did not report saved';
    settingsSel=1; press('Enter');                     // restore (no file) must not throw
    settingsSel=SETTINGS_CATS[settingsCat].items.findIndex(it=>it.lbl()==='RESET STATS'); press('Enter');   // reset -> resetConfirm
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
    _netApiOutdated=true; drawMenu(simNow); _netApiNewer=true; drawMenu(simNow);   // update note renders in the overlay
    _netApiOutdated=false; _netApiNewer=false;
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

    // TOURNAMENT screens draw, and the lobby roster reads like the FRIENDS list: an id on
    // EVERY row plus a name column beside it, with a dimmed stand-in where a player never set
    // a name -- which used to leave a blank line where a person was supposed to be.
    {
        const oRow=_drawRowName, oItem=menuItem, oCt=ct;
        let names=[], ids=[], sum=null;
        const cap=()=>{ names=[]; ids=[]; sum=null;
            _drawRowName=(nm,y,sel,col)=>{ names.push({nm:nm,y:y,col:col||''}); };
            menuItem=(t,y)=>{ ids.push({t:t,y:y}); };
            ct=(t,x,y)=>{ if(/PLAYERS? - /.test(String(t))) sum=y; }; };
        const rel=()=>{ _drawRowName=oRow; menuItem=oItem; ct=oCt; };
        phase='tourneyLobby'; _ttUi.sel=0; _ttUi.msg='';
        _tt={ tid:'t1', code:'PQKKSV', state:'open', host:'aaaa0001', max:8, stakes:false,
              players:[{id:'aaaa0001',name:'KAI LAPTOP'},{id:'bbbb0002',name:'KAI MOBIL'},{id:'cccc0003',name:''}] };
        cap(); drawTourneyLobby(); rel();
        if(names.length!==3) throw 'every player needs a name column, the nameless included: '+names.length;
        if(names[2].nm!=='NO NAME' || !names[2].col) throw 'a nameless player must get a DIMMED stand-in, not a blank row';
        if(names[0].col) throw 'a player who HAS a name keeps the ordinary row colour';
        if(ids[0].t!=='AAAA-0001'||ids[1].t!=='BBBB-0002'||ids[2].t!=='CCCC-0003') throw 'every roster row must show its id';
        // A FULL room still fits its band: the roster may tighten its pitch, never overrun the
        // join code above it or the action rows below.
        _tt.max=10; _tt.players=[];
        for(let i=0;i<10;i++) _tt.players.push({id:'0000000'+i,name:'PLAYER'+i});
        cap(); drawTourneyLobby(); rel();
        if(names.length!==10) throw 'a full room must draw every player';
        for(let i=1;i<names.length;i++) if(names[i].y<=names[i-1].y) throw 'roster rows must descend';
        if(names[0].y<88) throw 'the roster must clear the join code: '+names[0].y;
        if(sum===null||sum<=names[9].y||sum>=266) throw 'the summary sits under the last player and above the action rows: '+sum;
        // The other three screens draw at all, which nothing covered before.
        _tt.state='running'; _tt.round=1; _tt.cursor='';
        _tt.standings=[{id:'00000000',pts:2,diff:3,rank:1}];
        _tt.schedule=[{nid:'r1m1',players:['00000000','00000001'],state:'settled',winner:'00000000'}];
        phase='tourneyBracket'; drawTourneyBracket();
        _tt.round=2; _tt.bracket=[{nid:'r2m1',players:['00000000','00000001'],state:'pending'}]; drawTourneyBracket();
        _tt.roles={ round:2, match:1, of:1, nid:'r2m1', hm:2, players:['00000000','00000001'], you:'play', names:{} };
        phase='tourneyCeremony'; drawTourneyCeremony();
        _tt.roles.you='spectate'; drawTourneyCeremony();
        _tt.state='done'; _tt.podium=['00000000','00000001'];
        phase='tourneyPodium'; drawTourneyPodium();
        // A tournament match ends on the SAME duelOver screen as any other duel, and there
        // it must not offer a rematch: the bracket says what comes next, so a vote taken
        // here could never be honoured.
        const oYN=drawConfirmYesNo; let yn=0; drawConfirmYesNo=()=>{ yn++; };
        simCommand({t:'startDuel', seed:0xd0e1});
        phase='duelOver'; duelWinner=0; phaseAt=simNow-10000;
        drawDuelBoard(simNow);
        if(yn) throw 'a tournament match offered a 1:1 rematch vote';
        _tt=null; drawDuelBoard(simNow);
        if(yn!==1) throw 'an ordinary 1:1 lost its PLAY AGAIN vote';
        drawConfirmYesNo=oYN; simCommand({t:'phase',phase:'menu'});
        _tt=null; _ttUi.sel=0; phase='menu';
        log('tournament screens ok: roster rows carry id + name, nameless players get a dimmed stand-in, a full room stays inside its band, and a tournament match ends without a rematch vote');
    }

    // Multi-page newspaper: render and flip pages without error.
    phase='news'; _newsAt=0; newsPage=0; drawNews(1000);
    press('ArrowRight'); if(newsPage!==1) throw 'news: LEFT/RIGHT did not flip pages';
    drawNews(1000); press('ArrowLeft'); if(newsPage!==0) throw 'news: page flip did not wrap back';
    log('multi-page news ok: pages='+((ANNOUNCEMENT&&ANNOUNCEMENT.pages&&ANNOUNCEMENT.pages.length)||1));

    // Achievements paging: expert lands on 2/2, L/R pages with wrap, the hidden egg
    // page (0) opens only once a first egg is found, and reaching it IS an egg. The
    // credits secret line is the other testable egg (the third rides a DOM click).
    const _si0=cfg.shopItems;
    cfg.shopItems={donate:true}; ACHIEVEMENTS.forEach(a=>achUnlocked[a.id]=achUnlocked[a.id]||1);
    phase='menu'; menuSel=MENU_ITEMS.indexOf('ACHIEVEMENTS'); press('Enter');
    if(phase!=='achievements'||achPage!==2) throw 'expert must land on page 2/2 (got '+achPage+')';
    drawAchievements();
    press('ArrowLeft'); if(achPage!==1) throw 'LEFT did not page to base';
    drawAchievements();
    press('ArrowLeft'); if(achPage===0) throw 'no egg found yet: the hidden page must stay unreachable';
    achUnlocked.egg_ringtone=1;                    // a first egg opens the door
    achPage=2; press('ArrowLeft'); press('ArrowLeft');   // 2 -> 1 -> 0
    if(achPage!==0) throw 'a found egg must make page 0 swipeable';
    if(!achUnlocked.egg_page) throw 'reaching the hidden page must unlock its own egg';
    drawAchievements();
    press('ArrowRight'); if(achPage!==1) throw 'RIGHT from the egg page must reach base';
    phase='credits';
    let _cy=0; for(const [t,v] of CRED){ if(t==='secret') break; _cy+=t==='gap'?v:(CRED_H[t]||22); }
    creditsScroll=100-_cy; drawCredits();          // puts the secret line on screen
    if(!achUnlocked.egg_credits) throw 'the on-screen NO EASTEREGGS line must unlock the credits egg';
    achUnlocked={}; cfg.shopItems=_si0; phase='menu';
    log('achievements paging + eggs ok: expert 2/2 default, hidden page 0, credits egg');

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
