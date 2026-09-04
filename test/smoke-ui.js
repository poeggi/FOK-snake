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

    // ---- who a table says you are, and where the podium says it ----------------------
    // A RANKED TABLE IS THE SAME TABLE FOR EVERYONE READING IT. The PLAYER column names
    // every row's player, yours included, and the margin says which row is yours. Putting
    // YOU in the column instead left you the one reader who could not find yourself by the
    // name you played under -- and the only one who could not read the board out to somebody
    // sitting next to you.
    {
        const oCol=_ttCol, oCt=ct, oCtg=ctg, oPid=getPlayerId;
        let cols=[], big=[];
        const cap=()=>{ cols=[]; big=[];
            _ttCol=(t,x,y,c,f)=>{ cols.push({t:String(t),x:x,y:y,f:f}); };
            ct =(t,x,y,c,f)=>{ big.push({t:String(t),x:x,y:y,f:f}); };
            ctg=(t,x,y,c,f)=>{ big.push({t:String(t),x:x,y:y,f:f}); }; };
        const rel=()=>{ _ttCol=oCol; ct=oCt; ctg=oCtg; };
        const at=(l,y)=>l.filter(o=>o.y===y);
        getPlayerId=()=>'aaaa0001';
        const ppl=[{id:'bbbb0002',name:'JO'},{id:'aaaa0001',name:'KAI'},{id:'cccc0003',name:'MO'}];
        _tt={ tid:'t1', code:'PQKKSV', state:'running', host:'bbbb0002', max:8, stakes:true,
              round:1, cursor:'', players:ppl, advancers:['bbbb0002','aaaa0001'],
              standings:[{id:'bbbb0002',pts:4,diff:5,rank:1},
                         {id:'aaaa0001',pts:2,diff:1,rank:2},
                         {id:'cccc0003',pts:0,diff:-6,rank:3}],
              brk:{ next:2, of:2, done:1, matches:3, hm:2, lvl:1, host:'bbbb0002',
                    rows:[{id:'bbbb0002',name:'JO', rank:1,pts:4,diff:5,w:2,l:0,d:0,adv:true},
                          {id:'aaaa0001',name:'KAI',rank:2,pts:2,diff:1,w:1,l:1,d:0,adv:true},
                          {id:'cccc0003',name:'MO', rank:3,pts:0,diff:-6,w:0,l:2,d:0,adv:false}] } };
        // Both tables, the same rule. The standings table reads names off the roster, the
        // round board off the row the server sent -- two different lookups that used to
        // disagree with each other about exactly one player.
        [['STANDINGS',()=>drawTourneyBracket()], ['ROUND BOARD',()=>drawTourneyRound()]].forEach(tc=>{
            cap(); tc[1](); rel();
            const mine=cols.filter(o=>o.t==='YOU');
            if(mine.length!==1) throw tc[0]+': want exactly one YOU marker, got '+mine.length;
            const row=at(cols, mine[0].y).filter(o=>o.t!=='YOU');
            if(!row.length) throw tc[0]+': the YOU marker sits on no row at all';
            if(!row.some(o=>o.t==='KAI')) throw tc[0]+': my row does not carry my name: '+row.map(o=>o.t).join(',');
            // LEFT OF THE LIST, not inside it: the marker has to clear the leftmost column the
            // rows themselves use, or it is a fourth column and the table has to make room.
            const left=Math.min.apply(null, row.map(o=>o.x));
            if(!(mine[0].x<left)) throw tc[0]+': the YOU marker sits at x '+mine[0].x+', not left of the list ('+left+')';
            // Everybody else keeps the name they played under, and nobody else is marked.
            const others=cols.filter(o=>o.t==='JO'||o.t==='MO');
            if(others.length!==2) throw tc[0]+': the other players lost their names: '+others.length;
        });
        log('standings + round board ok: YOU is a margin marker left of the list, every row keeps the name it played under');

        // THE PODIUM is the ceremony screen settling, not a different screen: the same name
        // band at the same three heights and the same verdict line at the same height, with
        // ONE type size for all three places -- first place drawn bigger than the rest made
        // the screen top-heavy and left second and third reading as a footnote to it.
        _tt.state='done'; _tt.roles={ round:2, match:1, of:1, nid:'r2m1', hm:3, lvl:2,
                                      players:['bbbb0002','aaaa0001'], you:'play', names:{} };
        cap(); drawTourneyCeremony(); rel();
        const cer=big.slice(), py=[116,146,176];
        if(py.filter(y=>cer.some(o=>o.y===y)).length!==3)
            throw 'the ceremony name band moved: '+cer.map(o=>o.y).join(',');
        if(!cer.some(o=>o.y===228)) throw 'the ceremony verdict line moved out from under the podium';
        _tt.podium=['bbbb0002','aaaa0001','cccc0003'];
        cap(); drawTourneyPodium(); rel();
        const pod=big.slice(), lbl=['1ST','2ND','3RD'];
        py.forEach((y,i)=>{
            const nm=at(pod,y).filter(o=>lbl.indexOf(o.t)<0);
            if(nm.length!==1) throw 'podium place '+(i+1)+' should draw one name at the ceremony height '+y+', got '+nm.length;
            if(nm[0].f!==FONT.TITLE) throw 'podium place '+(i+1)+' is drawn at size '+nm[0].f
                                          +' -- all three places share one size ('+FONT.TITLE+')';
            if(!at(pod,y).some(o=>o.t===lbl[i])) throw 'podium place '+(i+1)+' lost its '+lbl[i]+' label';
        });
        // Every player gets a verdict, not only the winner: coming third in a field of eight
        // is a result, and a screen that speaks to one player says nothing to the rest.
        const verdict=pod.filter(o=>o.y===228);
        if(!verdict.length) throw 'the podium verdict is not on the ceremony verdict height (228)';
        if(verdict[0].t!=='SECOND PLACE') throw 'a runner-up was told nothing: '+verdict[0].t;
        if(!cols.some(o=>o.t==='YOU')) throw 'the podium does not mark which step is yours';
        getPlayerId=()=>'bbbb0002'; cap(); drawTourneyPodium(); rel();
        if(!big.some(o=>o.y===228&&o.t==='YOU WON IT')) throw 'the winner lost their line';
        getPlayerId=()=>'zzzz9999'; cap(); drawTourneyPodium(); rel();
        const out=big.filter(o=>o.y===228);
        if(!out.length||!/ WON IT$/.test(out[0].t)||out[0].t==='YOU WON IT')
            throw 'a player off the podium must still be told who won: '+(out[0]&&out[0].t);
        if(cols.some(o=>o.t==='YOU')) throw 'a player off the podium was marked as being on it';
        getPlayerId=oPid; _tt=null; _ttUi.sel=0; phase='menu';
        log('podium ok: the ceremony name band and verdict heights reused, one type size for all three places, a line for every player and the YOU marker only on your own step');
    }

    // ---- P2 is a slot number, and a slot number is a FALLBACK -------------------------
    // By the time a duel is running both names are known on both sides, so every place that
    // printed a slot number asks for a name instead: the HUD, the winner banner and the
    // heart-lost line all say the same word for the same person. PLAYER n survives only
    // where it is true -- a local duel on one keyboard, where the second player has no
    // account and so has no name.
    {
        const oNames=netPlayerNames, oCt=ct, oCtg=ctg;
        let said=[];
        const cap=()=>{ said=[]; ct=(t)=>{ said.push(String(t)); }; ctg=(t)=>{ said.push(String(t)); }; };
        const rel=()=>{ ct=oCt; ctg=oCtg; };
        netPlayerNames=()=>['KAI','JO'];
        if(duelSideName(0)!=='KAI'||duelSideName(1)!=='JO') throw 'a named duel still shows slot numbers';
        // Each of the three through its own draw path: a helper that is right and a caller
        // that never asks it is exactly the bug this is here to catch.
        simCommand({t:'startDuel', seed:0xd0e2});
        inGame=true; _hudCache.mode=''; updateHUD();
        if(_hudCache.la!=='KAI '||_hudCache.lb!=='JO ')
            throw 'the duel HUD still labels its rows by slot: '+_hudCache.la+'/'+_hudCache.lb;
        deathMsg='P2 LIFE LOST'; phaseAt=simNow-10000;
        cap(); drawDeathFx(simNow); rel();
        if(said.indexOf('JO LIFE LOST')<0) throw 'the heart-lost line still says P2: '+said.join(',');
        phase='duelOver'; duelWinner=1; _tt=null;
        cap(); drawDuelBoard(simNow); rel();
        if(said.indexOf('JO WINS!')<0) throw 'the winner banner still says PLAYER 2: '+said.join(',');
        // deathMsg is WIRE STATE -- it is hashed and it rides the rs snapshot -- so the sim may
        // only ever write the slot number and the name goes in at draw time. A message the sim
        // did not write passes through untouched.
        if(_duelDeathMsg('LEVEL CLEARED')!=='LEVEL CLEARED') throw 'the death line rewrote a message that was not a slot';
        // PLAYER n survives as the fallback it always should have been: a local duel on one
        // keyboard, where the second player has no account and so has no name.
        netPlayerNames=()=>['',''];
        if(duelSideName(0)!=='PLAYER 1'||duelSideName(1)!=='PLAYER 2') throw 'a nameless side lost its fallback';
        _hudCache.mode=''; updateHUD();
        if(_hudCache.la!=='PLAYER 1 '||_hudCache.lb!=='PLAYER 2 ')
            throw 'a nameless duel HUD lost its fallback: '+_hudCache.la+'/'+_hudCache.lb;
        netPlayerNames=oNames; inGame=false; deathMsg='';
        simCommand({t:'phase',phase:'menu'}); phase='menu';
        log('duel names ok: the HUD rows, the winner banner and the heart-lost line all name the player through their own draw path, PLAYER n only where there is no name');
    }

    // ---- a head-on is the one crash whose impact cell holds NEITHER snake -------------
    // Every other death leaves the head already against what killed it, so the wreck reads
    // right from the cell the head stands on. In a head-on both heads stopped one cell short
    // of the cell they both tried to enter, which drew them a whole clear block apart under
    // a message saying they had collided.
    {
        const oSimple=_simpleGfx, oMotion=_reduceMotion;
        _simpleGfx=()=>false; _reduceMotion=()=>false;
        // Where drawSnakeG puts the middle of the head: the cell, plus the jolt's draw offset.
        // The head also SQUASHES on impact (that is what j[2] is), so its edges are the wrong
        // thing to measure -- a boost wreck flattens 9px and would read as a gap that is not
        // there. Centres are what say whether the two are on the same cell edge.
        const headMid=(p,cx,now)=>{
            const j=_crashJolt(p,now), o=j?j(0):[0,0,0,0];
            return cx*CS+1+o[0]+(CS-2)/2;
        };
        for(const boost of [false,true]){
            _crashFx=[];
            // Cells 5 and 7, both moving into 6: the shared cell neither of them reaches.
            armCrash({p:0,hx:5,hy:5,x:6,y:5,into:'headon',boost:boost}, 1000);
            armCrash({p:1,hx:7,hy:5,x:6,y:5,into:'headon',boost:boost}, 1000);
            if(_crashFx.length!==2) throw 'the head-on wreck was not staged';
            for(const age of [0,40,120,300]){
                const d=headMid(1,7,1000+age)-headMid(0,5,1000+age);
                // Their cells are two apart. Drawn touching, they are ONE apart; anything from
                // one and a half up is the clear block of daylight the bug showed.
                if(d>=CS*1.6) throw 'head-on at '+age+'ms ('+(boost?'boost':'normal')+'): the heads are '
                                    +d.toFixed(1)+'px apart, more than a cell and a half, under a '
                                    +'message saying they collided';
                if(d<=CS*0.5) throw 'head-on at '+age+'ms ('+(boost?'boost':'normal')+'): the heads are '
                                    +d.toFixed(1)+'px apart -- they are through each other, not against';
            }
        }
        // ...and the lean is specific to a head-on: a snake that hit a BAR is already against
        // it, so its wreck still recoils away from the impact rather than into it.
        _crashFx=[]; armCrash({p:0,hx:5,hy:5,x:6,y:5,into:'bar',boost:false}, 1000);
        const bj=_crashJolt(0,1000);
        if(!bj||!(bj(0)[0]<0)) throw 'a bar crash must still recoil backwards, not lean forward';
        _crashFx=[]; _simpleGfx=oSimple; _reduceMotion=oMotion;
        log('head-on wreck ok: both heads lean into the cell they both tried to enter and meet on its edge, bar crashes still recoil');
    }

    // ---- the menu snake is the game's snake, dimmed -----------------------------------
    // The SAME block as a real snake: CS-2 at a one-pixel inset. A smaller square on the same
    // grid reads as a different thing that happens to move like one -- what makes it
    // background is the alpha, not the size.
    {
        const oFill=ctx.fillRect, oRr=rr, oMotion=_reduceMotion, oMode=cfg.gfxMode;
        let rects=[];
        _reduceMotion=()=>false; cfg.gfxMode=1;
        ctx.fillRect=function(x,y,w,h){ rects.push({x:x,y:y,w:w,h:h,a:ctx.globalAlpha}); };
        rr=(x,y,w,h,r)=>{ rects.push({x:x,y:y,w:w,h:h,r:r,a:ctx.globalAlpha}); };
        _mSnake={ dir:{x:1,y:0}, len:3, body:[{x:4,y:4},{x:3,y:4},{x:2,y:4}] };
        _drawMenuSnake(1000);
        ctx.fillRect=oFill; rr=oRr; _reduceMotion=oMotion; cfg.gfxMode=oMode;
        if(rects.length!==3) throw 'the menu snake drew '+rects.length+' shapes for 3 segments';
        const seg=rects.filter(o=>o.w===CS-2&&o.h===CS-2);
        if(seg.length!==3) throw 'the menu snake must draw every segment at the in-game block size: '
                                +rects.map(o=>o.w+'x'+o.h).join(' ');
        if(seg.some(o=>o.x%CS!==1||o.y%CS!==1)) throw 'the menu snake blocks are off the in-game one-pixel inset';
        // The dimming itself is not assertable here -- globalAlpha is canvas STATE and the
        // harness context swallows state writes -- but it is also not what went wrong: the
        // snake was always dim, it was drawn as a 0.72-cell square on a full-cell grid.
        log('menu snake ok: full in-game block on the in-game one-pixel inset, the same shape the real snake draws');
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
