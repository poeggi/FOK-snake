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
    // The camera is a CODE feature, not an ADD FRIEND one: both fixed-length codes are handed
    // round by holding a phone up to a screen, so both entry screens raise the same viewfinder
    // -- and free text, which nobody can scan, must never switch a camera on.
    const oPanel=_drawScanPanel; let vf=0; _drawScanPanel=()=>{ vf++; };
    entryMode='friend'; nameStr='00FF'; nameCursorPos=4; nameCharIdx=0; drawNameEntry(simNow);
    entryMode='tcode'; nameStr='UDN'; nameCursorPos=3; drawNameEntry(simNow);
    if(vf!==2) throw 'ADD FRIEND and JOIN TOURNAMENT must both show the camera panel: '+vf;
    entryMode='user'; nameStr='KAI'; nameCursorPos=3; drawNameEntry(simNow);
    if(vf!==2) throw 'free-text name entry must not open a camera';
    _drawScanPanel=oPanel;
    entryMode='score'; phase='menu';
    log('duel submenu + friend/invite screens render ok');

    // SCREEN FURNITURE. BACK, the status line and the line that says what a screen AMOUNTS
    // to are the same three things wherever you are, and they are only recognisable as the
    // same things if they are at the same height everywhere -- which is what the shared band
    // (css/style.css :root --ui-*, read into UI in js/assets.js) is for. Every screen that
    // parks one is checked against the band, not against its neighbour, so a screen that
    // grows its own private offset is caught the moment it does.
    {
        const oItem=menuItem, oCt=ct, oCtg=ctg;
        const backs=[], bands=[];
        const grab=(t,x,y)=>{ if(/BALANCE:|UNLOCKED|^DIFF:/.test(String(t))) bands.push(String(t)+'@'+y); };
        menuItem=(t,y)=>{ if(t==='BACK') backs.push(y); };
        ct=grab; ctg=grab;
        settingsCat=-1; settingsSel=0; drawSettings();
        phase='duelMenu'; duelSel=0; drawDuelMenu();
        phase='duel11'; duel11Sel=0; drawDuel11();
        phase='friends'; _netFr.sel=0; drawFriends();
        _mc.sel=-1; phase='menu'; menuSel=0; drawMenu(simNow);
        phase='achievements'; achPage=1; drawAchievements();
        menuItem=oItem; ct=oCt; ctg=oCtg;
        if(backs.length<4) throw 'expected a BACK row on every list screen: '+backs.length;
        if(backs.some(y=>y!==BACK_Y)) throw 'BACK sits at one height in this game: '+backs.join(',');
        if(bands.length<2) throw 'expected a summary line on the menu and on achievements: '+bands.join(' ');
        if(bands.some(s=>+s.split('@')[1]!==BAND_Y)) throw 'the summary band is one height: '+bands.join(' ');
        // The band reads DOWNWARD in the order a person meets it -- what the screen is saying,
        // the way out, what it amounts to, then how to work it -- and the hints are the lowest
        // line on the canvas. Ten pixels off the bottom edge is the whole clearance they get,
        // and the four lines above them are sized against it, so it is pinned here rather than
        // left to whichever screen was edited last.
        if(!(STATUS_Y<BACK_Y&&BACK_Y<BAND_Y&&BAND_Y<HINT_Y))
            throw 'the furniture band is out of order: '+[STATUS_Y,BACK_Y,BAND_Y,HINT_Y].join('<');
        if(CH-HINT_Y!==10) throw 'the key hints sit ten pixels off the bottom edge: '+(CH-HINT_Y);
        _mc.sel=-1; phase='menu';
        log('screen furniture ok: BACK at '+BACK_Y+', the summary band at '+BAND_Y+', hints at '+HINT_Y);
    }

    // A scoreboard is a list of TEN -- the number the storage actually keeps -- drawn on the
    // pitch every other list in the game uses, and it still has to end clear of the hints.
    {
        const oSR=_drawScoreRow, ys=[];
        _drawScoreRow=(s,i)=>{ ys.push(SCORE_ROW_Y+i*SCORE_ROW_H); };
        _scoreboardCache=[];
        for(let i=0;i<12;i++) _scoreboardCache.push({name:'P'+i,score:900-i,level:3,diff:1,date:'01.01.26'});
        phase='scores'; scoresTab=0; drawScores();
        _drawScoreRow=oSR; _scoreboardCache=null; phase='menu';
        if(ys.length!==10) throw 'the scoreboard shows the ten the storage keeps: '+ys.length;
        if(ys[0]!==MENU_TOP||ys[1]-ys[0]!==MENU_ROW) throw 'score rows sit on the menu pitch: '+ys.slice(0,2).join(',');
        if(ys[9]>=HINT_Y-14) throw 'ten score rows must still clear the key hints: '+ys[9];
        log('high scores ok: '+ys.length+' rows on the menu pitch');
    }

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
        const top3=names.length?names[0].y:0;
        if(names.length!==3) throw 'every player needs a name column, the nameless included: '+names.length;
        if(names[2].nm!=='NO NAME' || !names[2].col) throw 'a nameless player must get a DIMMED stand-in, not a blank row';
        if(names[0].col) throw 'a player who HAS a name keeps the ordinary row colour';
        // An id row and a name row are the SAME row, so they are matched by their y -- the
        // action rows go through menuItem too, and which end of the screen they sit at is a
        // layout decision this assertion has no business pinning down.
        const rIds=ids.filter(i=>names.some(n=>n.y===i.y)).map(i=>i.t).join(',');
        if(rIds!=='AAAA-0001,BBBB-0002,CCCC-0003') throw 'every roster row must show its id: '+rIds;
        // A FULL room fills the SAME band from the SAME top: the roster grows downward as
        // people arrive, so the row you are on is yours for as long as you are in the room and
        // the host never slides up the screen. The host is the top row of it, whatever order
        // the server hands the players in.
        _tt.max=10; _tt.players=[]; _tt.host='00000005';
        for(let i=0;i<10;i++) _tt.players.push({id:'0000000'+i,name:'PLAYER'+i});
        cap(); drawTourneyLobby(); rel();
        if(names.length!==10) throw 'a full room must draw every player';
        for(let i=1;i<names.length;i++) if(names[i].y<=names[i-1].y) throw 'roster rows must descend';
        if(names[0].y!==top3) throw 'the roster fills from a fixed top, it does not slide: '+top3+' -> '+names[0].y;
        const topId=ids.filter(i=>i.y===names[0].y).map(i=>i.t).join(',');
        if(topId!=='0000-0005') throw 'the host is the top row of its own roster: '+topId;
        const above=ids.filter(i=>!names.some(n=>n.y===i.y)&&i.y<names[0].y).map(i=>i.y);
        if(!above.length||names[0].y-Math.max.apply(null,above)<14)
            throw 'the roster must clear the action rows above it: '+names[0].y+' under '+above.join(',');
        _tt.host='aaaa0001';
        // The summary is the screen's FOOTER, not a caption under the last player: it sits below
        // every player AND below the way out, on the band SHOP keeps its balance on and
        // ACHIEVEMENTS its unlocked count.
        const lastRow=Math.max.apply(null, ids.map(i=>i.y));
        if(sum!==BAND_Y||sum<=names[9].y||sum<=lastRow)
            throw 'the summary belongs on the status band, under the last row: '+sum;
        // One row does BACK and CANCEL, and says which: the host cancels the room, a guest
        // walks out of it. There is no separate CANCEL TOURNAMENT row to press by accident.
        const oPid=getPlayerId, tail=()=>tourneyRows()[tourneyRows().length-1].t;
        getPlayerId=()=>'aaaa0001';
        // START is the top row for the host, and sel starts at 0, so the press the host is
        // waiting to make is the one already under the cursor.
        if(tourneyRows()[0].t!=='START TOURNAMENT') throw 'START must be the pre-selected top row: '+tourneyRows()[0].t;
        if(tourneyRows()[1].t!=='SHOW JOIN CODE') throw 'the join code needs a row of its own, under START';
        if(tail()!=='BACK - CANCEL TOURNAMENT') throw 'the host exit must say what it does: '+tail();
        getPlayerId=()=>'zzzz9999';
        if(tourneyRows()[0].t!=='SHOW JOIN CODE') throw 'a guest has no START, so the code is its top row: '+tourneyRows()[0].t;
        if(tail()!=='BACK - LEAVE TOURNAMENT') throw 'a guest exit must say what it does: '+tail();
        if(tourneyRows().some(r=>/^CANCEL/.test(r.t))) throw 'CANCEL must live in the back row, not beside it';
        getPlayerId=oPid;
        // ...and the code itself has a screen now, reached from that first row.
        phase='tourneyCode'; drawTourneyCode();
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
        log('tournament screens ok: roster rows carry id + name and fill from a fixed top with the host on it, nameless players get a dimmed stand-in, START is the pre-selected row, the summary sits on the status band, BACK carries the cancel, and a tournament match ends without a rematch vote');
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
