// ============================================================================
// input.js -- ALL input, structured as SOURCES -> ROUTER -> SINKS:
//   sinks   : UI_INPUT (declarative per-screen menu semantics) and the
//             GameControls funnel (player-indexed sim commands -- a future
//             ONLINE peer is just another caller of these with its index).
//   router  : handleKey() -- normalizes to a small key vocabulary, applies the
//             global rules (splash/space/mute/escape), then dispatches.
//   sources : keyboard (+TV-remote maps), touch swipe, pointer, d-pad, side
//             buttons, the hidden name field, mute button, background/blur.
// Device quirks (iOS audio unlock in touchstart, preventDefault/{passive}
// placements, swipe thresholds) live INSIDE their source and nowhere else.
// Loaded last; shared global scope, cross-file references bind at call time.
// ============================================================================

// ================================================================
// SHARED VOCABULARY + SPLASH ACTION
// ================================================================
const GDIRS={ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1},ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0}};
const WASD={w:{x:0,y:-1},s:{x:0,y:1},a:{x:-1,y:0},d:{x:1,y:0}};   // duel P2 controls
// "A snake of ours is live, steer/boost it" -- the touch layer's counterpart to the
// keyboard's (phase==='playing'||phase==='duel') gates. NOT a menu: a swipe must
// steer immediately instead of deferring to touchend, and a tap must not press A.
function _inPlay(){ return phase==='playing'||phase==='duel'; }
// OUR snake's boost state. The classic globals (boosting/boostDir) belong to the
// SINGLE-PLAYER snake and a duel never writes them -- it lives in players[]. Reading
// them in a duel meant `boosting` was permanently false, so the swipe path's "am I
// already boosting this way?" test could never pass and every swipe move called
// gameBoostEnd: boost engaged, then died on the next finger movement. The dpad path
// never read them, which is exactly why it worked and this did not.
// In a duel our snake is P0 locally, or our own index online -- never the opponent's.
function _myBoost(){
    if(!players) return { dir: boostDir, on: boosting };
    const i = (typeof netGameActive === 'function' && netGameActive()) ? netMyIndex() : 0;
    const P = players[i] || players[0];
    return { dir: P.boostDir, on: P.boosting };
}
let _kbBoostDir=null;   // last keydown boost dir (arrows / P0), tracked locally so keyup doesn't race the worker mirror
let _kbBoostW=null;     // same for WASD / duel P2
let _splashKeyHeld = false;   // splash key-repeat guard (pure input debounce)

function triggerSplashExit() {
    if (phase !== 'splash' || _splashExiting) return;
    _splashFast = false; _splashFastStart = 0; _splashFastBase = 0;
    _splashExiting = true;
    _splashExitAt = simNow;
    Snd.sfxPlay('coin', true, null, cfg.music ? 1 : 0.1);   // muted: 10% so it still primes the pipeline, barely audible
}

const GAME_KEYS = new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter','Escape','Backspace',' ','NameAdd']);
// ================================================================
// UI INPUT TABLE  (discrete menu-control semantics -- one row per UI screen)
// nav(key): any arrow.  confirm: Enter.  add: NameAdd (OK button / tap).
// back: Escape.  space: ' '.  text(key): printable name characters.
// other(key): any remaining key -- return true if consumed.
// The router in handleKey() dispatches these rows; GAMEPLAY phases are handled
// after it as continuous controls emitting player-indexed sim commands. A future
// remote peer is just another SOURCE feeding those same commands (p:1).
// ================================================================
// Name-entry helpers (hoisted: the dialed letter belongs to the cursor slot and is
// written when you move off it or confirm; submit only via RETURN/START or the dial glyph).
function _placeName(){
    const c=_entryChars()[nameCharIdx];
    if(c==='\r') return;
    if(nameCursorPos<nameStr.length) nameStr=nameStr.slice(0,nameCursorPos)+c+nameStr.slice(nameCursorPos+1);
    else if(nameStr.length<_entryMax()) nameStr+=c;
    _nameFlashPos=nameCursorPos; _nameFlashAt=simNow;
}
function _syncDial(){ if(nameCursorPos<nameStr.length){const ci=_entryChars().indexOf(nameStr[nameCursorPos]);if(ci>=0)nameCharIdx=ci;} }
// Open/close the shared entry dialog. Leaving always resets to 'score': that is the
// only mode entered without _entryOpen (the sim's gameover event drives it).
function _entryOpen(mode, prefill){
    entryMode=mode; nameStr=(prefill||'').substring(0,_entryMax());
    nameCharIdx=nameStr.length>0?Math.max(0,_entryChars().indexOf(nameStr[0])):0;
    nameCursorPos=nameStr.length; phase='nameEntry';
}
function _entryLeave(to){ scanStop(); _scanOk=''; _scanManualOff=false; entryMode='score'; phase=to; setTimeout(()=>nameInp.blur(),10); }
function _submitName(){
    if(entryMode==='friend'){
        const id=nameStr.toLowerCase();
        if(id.length!==8||!addFriend(id)){ Snd.sfxPlay('fail',cfg.music); return; }   // malformed or own ID
        _duelMsg='FRIEND ADDED: '+fmtFriendId(id); _duelMsgAt=_msgNow();
        _entryLeave('duelMenu'); Snd.sfxPlay('select',cfg.music); return;
    }
    if(!nameStr.trim()) return;
    try{localStorage.setItem('lastSName',nameStr);}catch (e){}
    if(typeof netNameChanged==='function') netNameChanged();
    if(entryMode==='user'){ _entryLeave('settings'); Snd.sfxPlay('select',cfg.music); return; }
    addScore(nameStr,score,level);Snd.sfxPlay('select',cfg.music);
    if(typeof netSubmitScore==='function') netSubmitScore(nameStr,score,level);   // global board (no-op in offline mode)
    inGame=false; _wsend({t:'phase',phase:'menu'});   // leave the gameplay session; main owns phase again
    _scoreboardCache=getScores();scoresTab=0;phase='scores';showHUD(false);setTimeout(()=>nameInp.blur(),10);
}
function _nameDelete(){
    if(nameCursorPos>0){nameStr=nameStr.slice(0,nameCursorPos-1)+nameStr.slice(nameCursorPos);nameCursorPos--;if(nameCursorPos<nameStr.length){const ci=NAME_CHARS.indexOf(nameStr[nameCursorPos]);if(ci>=0)nameCharIdx=ci;}Snd.sfxPlay('nav',cfg.music);}
}
function _duelExit(){
    if(typeof netEndSession === 'function') netEndSession();
    inGame=false; _wsend({t:'phase',phase:'menu'});
    // Leaving on purpose says nothing. _duelMsg is never cleared, only overwritten, so
    // an in-game line (DESYNC DETECTED, RELAY MODE) stamped in the last 2.6s would
    // follow us out and render on the menu as if it had just happened there.
    _duelMsg=''; _duelMsgAt=0;
    phase='duelMenu';   // back to where the match was started from, not the main menu
    showHUD(false); Snd.musicStop(); Snd.sfxPlay('nav',cfg.music);
}
function _backToMenu(){ phase='menu'; Snd.sfxPlay('nav',cfg.music); }
const UI_INPUT = {
    menu: {
        nav(key){
            const menuCount=MENU_ITEMS.length+(ANNOUNCEMENT?1:0);
            if(key==='ArrowUp')  {menuSel=(menuSel-1+menuCount)%menuCount;Snd.sfxPlay('nav',cfg.music);}
            if(key==='ArrowDown'){menuSel=(menuSel+1)%menuCount;Snd.sfxPlay('nav',cfg.music);}
        },
        confirm(){
            Snd.sfxPlay('select',cfg.music);
            switch(MENU_ITEMS[menuSel]){   // dispatch by label so MENU_ITEMS can be reordered freely
                case 'PLAY':         beginGame(); break;
                case '1:1':          phase='duelMenu'; duelSel=0; break;
                case 'HIGH SCORES':  phase='scores'; _scoreboardCache=getScores(); scoresTab=0; break;
                case 'ACHIEVEMENTS': phase='achievements'; achPage=0; break;
                case 'SHOP':         _enterShop(); break;
                case 'SETTINGS':     phase='settings'; settingsCat=-1; settingsSel=0; break;
                case 'CREDITS':      phase='credits'; creditsScroll=CH-20; creditsSpeed=0.8; _creditsNormal=0.8; break;
                default: if(ANNOUNCEMENT){ markAnnounceSeen(); phase='news'; _newsAt=simNow; newsPage=0; }   // the virtual newspaper item past the list
            }
        },
    },
    duelMenu: {
        nav(key){
            if(key==='ArrowUp')  {duelSel=(duelSel+5)%6;Snd.sfxPlay('nav',cfg.music);}
            if(key==='ArrowDown'){duelSel=(duelSel+1)%6;Snd.sfxPlay('nav',cfg.music);}
        },
        confirm(){
            if(duelSel===0){ if(_hasKeyboard){Snd.sfxPlay('select',cfg.music);beginDuel();} else Snd.sfxPlay('fail',cfg.music); }   // LOCAL needs a keyboard (PC)
            else if(duelSel===1){ Snd.sfxPlay('select',cfg.music); _friendIdBack='duelMenu'; _netFr.msg=''; phase='friendId'; }
            else if(duelSel===2){ Snd.sfxPlay('select',cfg.music); _entryOpen('friend'); scanStart(); }   // in-gesture: camera permission prompt allowed
            else if(duelSel===3){ Snd.sfxPlay('select',cfg.music); phase='friends'; if(typeof netFriendsEnter==='function') netFriendsEnter(); }
            else if(duelSel===4){
                if(cfg.offline || typeof netLobbyEnter!=='function'){ Snd.sfxPlay('fail',cfg.music); _duelMsg='OFFLINE MODE (SETTINGS > NETWORK)'; _duelMsgAt=_msgNow(); }
                else { Snd.sfxPlay('select',cfg.music); phase='lobby'; netLobbyEnter(); }
            }
            else this.back();   // BACK row (like drawSettings)
        },
        back: _backToMenu,
    },
    friendId: {
        confirm(){ phase=_friendIdBack; Snd.sfxPlay('nav',cfg.music); },
        back(){ phase=_friendIdBack; Snd.sfxPlay('nav',cfg.music); },
    },
    friends: {
        nav(key){
            if(_netFr.confirm){
                if(key==='ArrowLeft'){ _netFr.confirmSel=0; Snd.sfxPlay('nav',cfg.music); }
                if(key==='ArrowRight'){ _netFr.confirmSel=1; Snd.sfxPlay('nav',cfg.music); }
                return;
            }
            const count=_netFrRows().length+1;   // rows + BACK
            if(key==='ArrowUp')  { _netFr.sel=(_netFr.sel+count-1)%count; Snd.sfxPlay('nav',cfg.music); }
            if(key==='ArrowDown'){ _netFr.sel=(_netFr.sel+1)%count; Snd.sfxPlay('nav',cfg.music); }
        },
        confirm(){
            if(_netFr.confirm){
                Snd.sfxPlay(_netFr.confirmSel===0?'select':'nav',cfg.music);
                if(_netFr.confirmSel===0) _netFrRemove(_netFr.confirm);   // server removal auto-confirms; this is the local safety prompt
                _netFr.confirm=null; return;
            }
            const rows=_netFrRows();
            if(_netFr.sel>=rows.length){ phase='duelMenu'; Snd.sfxPlay('nav',cfg.music); return; }
            const r=rows[_netFr.sel];
            if(r.state==='pending' && !r.outgoing){ Snd.sfxPlay('select',cfg.music); _netFrAccept(r.id); }   // incoming request: accept
            else { Snd.sfxPlay('nav',cfg.music); _netFr.confirm=r.id; _netFr.confirmSel=1; }                  // remove: local confirm (NO preselected)
        },
        back(){
            if(_netFr.confirm){ _netFr.confirm=null; Snd.sfxPlay('nav',cfg.music); }
            else { phase='duelMenu'; Snd.sfxPlay('nav',cfg.music); }
        },
        other(key){
            if(!_netFr.confirm) return false;
            if(key==='y'||key==='Y'){ Snd.sfxPlay('select',cfg.music); _netFrRemove(_netFr.confirm); _netFr.confirm=null; return true; }
            if(key==='n'||key==='N'){ Snd.sfxPlay('nav',cfg.music); _netFr.confirm=null; return true; }
            return false;
        },
    },
    lobby: {
        nav(key){
            if(_netLb.invite){
                if(key==='ArrowLeft'){ _netLb.inviteSel=0; Snd.sfxPlay('nav',cfg.music); }
                if(key==='ArrowRight'){ _netLb.inviteSel=1; Snd.sfxPlay('nav',cfg.music); }
                return;
            }
            const count=getFriends().length+2;   // QUICK MATCH + friends + BACK
            if(key==='ArrowUp')  { _netLb.sel=(_netLb.sel+count-1)%count; Snd.sfxPlay('nav',cfg.music); }
            if(key==='ArrowDown'){ _netLb.sel=(_netLb.sel+1)%count; Snd.sfxPlay('nav',cfg.music); }
        },
        confirm(){
            if(_netLb.invite){ Snd.sfxPlay('select',cfg.music); _netInviteAnswer(_netLb.inviteSel===0); return; }
            const fr=getFriends();
            if(_netLb.sel===0){ Snd.sfxPlay('select',cfg.music); _netLb.seeking ? _netSeekStop() : _netSeekStart(); }   // QUICK MATCH: the top entry
            else if(_netLb.sel<=fr.length){ Snd.sfxPlay('select',cfg.music); _netInviteSend(fr[_netLb.sel-1]); }
            else this.back();
        },
        back(){ netLobbyLeave(); phase='duelMenu'; Snd.sfxPlay('nav',cfg.music); },
        other(key){
            if(!_netLb.invite) return false;
            if(key==='y'||key==='Y'){ Snd.sfxPlay('select',cfg.music); _netInviteAnswer(true); return true; }
            if(key==='n'||key==='N'){ Snd.sfxPlay('nav',cfg.music); _netInviteAnswer(false); return true; }
            return false;
        },
    },
    invite: {
        nav(key){ if(key==='ArrowUp'||key==='ArrowDown'){ inviteSel=1-inviteSel; Snd.sfxPlay('nav',cfg.music); } },
        confirm(){
            if(inviteSel===0){
                let ok=false;
                try{ navigator.clipboard.writeText(fmtFriendId(_inviteFid||'')).catch(()=>{}); ok=true; }catch(e){}
                _inviteMsg=ok?'COPIED!':'COPY FAILED'; _inviteMsgAt=simNow; Snd.sfxPlay(ok?'select':'fail',cfg.music);
            } else { _inviteFid=null; phase='menu'; Snd.sfxPlay('select',cfg.music); }
        },
        back(){ _inviteFid=null; phase='menu'; Snd.sfxPlay('nav',cfg.music); },
    },
    settings: {
        nav(key){
            _dbgPinShow=false;   // any movement dismisses a held debug PIN
            const inCat=settingsCat>=0, list=_settingsList(), count=list.length+1;   // +1 for BACK
            const onBack=settingsSel===list.length;
            if(key==='ArrowUp')  {settingsSel=(settingsSel-1+count)%count;Snd.sfxPlay('nav',cfg.music);}
            if(key==='ArrowDown'){settingsSel=(settingsSel+1)%count;Snd.sfxPlay('nav',cfg.music);}
            if((key==='ArrowLeft'||key==='ArrowRight') && inCat && !onBack){
                const it=list[settingsSel];
                if(it.adj){ it.adj(key==='ArrowRight'); Snd.sfxPlay('nav',cfg.music); saveCfg(); }
            }
        },
        confirm(){
            _dbgPinShow=false;   // a fresh action dismisses a held debug PIN (SEND re-sets it on success)
            const inCat=settingsCat>=0, list=_settingsList();
            const onBack=settingsSel===list.length;
            if(onBack){
                Snd.sfxPlay('nav',cfg.music);
                if(inCat){settingsSel=settingsCat;settingsCat=-1;_debugEntered=false;} else phase='menu';
            } else if(!inCat){
                Snd.sfxPlay('select',cfg.music); settingsCat=settingsSel; settingsSel=0;
                _debugEntered = !!(_cats()[settingsCat] && _cats()[settingsCat].label==='DEBUGGING');
            } else {
                const it=list[settingsSel];
                if(it.act) it.act();
                saveCfg();
            }
        },
        back(){
            _dbgPinShow=false;
            if(settingsCat>=0){ settingsSel=settingsCat; settingsCat=-1; _debugEntered=false; } else phase='menu';
            Snd.sfxPlay('nav',cfg.music);
        },
    },
    credits: {
        nav(key){
            if(key==='ArrowDown')     creditsSpeed=3.5;
            else if(key==='ArrowUp')  creditsSpeed=0.15;
        },
        confirm(){ Snd.sfxPlay('nav',cfg.music); phase='menu'; creditsSpeed=0.8; _creditsNormal=0.8; },
        back: _backToMenu,
    },
    scores: {
        nav(key){
            if(key==='ArrowLeft'||key==='ArrowRight'){
                scoresTab=(scoresTab+(key==='ArrowRight'?1:-1)+2)%2;   // 2 tabs (LOCAL/GLOBAL): wrap like the shop
                Snd.sfxPlay('nav',cfg.music);
            }
        },
        back: _backToMenu,
        other(){ _backToMenu(); return true; },   // any other key leaves the board
    },
    achievements: {
        nav(){},                                   // arrows are consumed, not acted on
        back: _backToMenu,
        other(){ _backToMenu(); return true; },
    },
    news: {
        nav(key){
            const pages=(ANNOUNCEMENT&&ANNOUNCEMENT.pages)||[];
            if((key==='ArrowLeft'||key==='ArrowRight')&&pages.length>1){
                newsPage=(newsPage+(key==='ArrowRight'?1:-1)+pages.length)%pages.length; Snd.sfxPlay('nav',cfg.music);
            }
        },
        back: _backToMenu,
        other(){ _backToMenu(); return true; },
    },
    shop: {
        nav(key){
            const onBoxes = shopPage===BOX_PAGE, onGear = shopPage===GEAR_PAGE;
            const items = onBoxes ? _boxList() : onGear ? _gearList() : SHOP_ITEMS.filter(it=>(it.page||0)===shopPage);
            if(key==='ArrowUp'){ if(items.length){ shopSel=(shopSel-1+items.length)%items.length; Snd.sfxPlay('nav',cfg.music); } }
            else if(key==='ArrowDown'){ if(items.length){ shopSel=(shopSel+1)%items.length; Snd.sfxPlay('nav',cfg.music); } }
            else if(key==='ArrowLeft'){ shopPage=(shopPage-1+SHOP_PAGES)%SHOP_PAGES; shopSel=0; Snd.sfxPlay('nav',cfg.music); }
            else if(key==='ArrowRight'){ shopPage=(shopPage+1)%SHOP_PAGES; shopSel=0; Snd.sfxPlay('nav',cfg.music); }
        },
        confirm(){
            const onBoxes = shopPage===BOX_PAGE, onGear = shopPage===GEAR_PAGE;
            const items = onBoxes ? _boxList() : onGear ? _gearList() : SHOP_ITEMS.filter(it=>(it.page||0)===shopPage);
            if(onBoxes){ const b=_boxList()[shopSel]; if(b) _openBox(b); }
            else if(onGear){ const item=items[shopSel], wi=cfg.wornItems||(cfg.wornItems={});
                if(item){ if(wi[item.id]) delete wi[item.id]; else wi[item.id]=true; saveCfg(); Snd.sfxPlay('nav',cfg.music); } }
            else {
                const item=items[shopSel];
                const si=cfg.shopItems||(cfg.shopItems={});
                if(item&&_cachedFOKoins>=item.price&&(item.repeatable||!si[item.id])){
                    _cachedFOKoins-=item.price; try { localStorage.setItem(FK_KEY,String(_cachedFOKoins)); } catch (e) {}
                    si[item.id]=true;
                    if(!item.repeatable)(cfg.wornItems||(cfg.wornItems={}))[item.id]=true;
                    saveCfg();
                    if(SHOP_ITEMS.filter(s=>!s.repeatable).every(s=>si[s.id])) unlockAch('shop_full');
                    triggerPurchaseAnim(); Snd.sfxPlay('perfect',cfg.music);
                } else if(item&&(_cachedFOKoins<item.price)){ Snd.sfxPlay('fail',cfg.music); }
            }
        },
        space(){
            const onBoxes = shopPage===BOX_PAGE, onGear = shopPage===GEAR_PAGE;
            if(onBoxes) return;
            const items = onGear ? _gearList() : SHOP_ITEMS.filter(it=>(it.page||0)===shopPage);
            const item=items[shopSel];
            const si=cfg.shopItems||{}, wi=cfg.wornItems||(cfg.wornItems={});
            if(item&&!item.repeatable&&si[item.id]){
                if(wi[item.id]) delete wi[item.id]; else wi[item.id]=true;
                saveCfg(); Snd.sfxPlay('nav',cfg.music);
            } else if(item&&!si[item.id]){ Snd.sfxPlay('fail',cfg.music); }
        },
        back: _backToMenu,
    },
    quitConfirm: {
        nav(key){
            if(key==='ArrowLeft'){ quitConfirmSel=0; Snd.sfxPlay('nav',cfg.music); }
            if(key==='ArrowRight'){ quitConfirmSel=1; Snd.sfxPlay('nav',cfg.music); }
        },
        confirm(){
            Snd.sfxPlay('select',cfg.music);
            if(quitConfirmSel===0){
                if(typeof netEndSession==='function') netEndSession();   // online duel: bye + teardown (no-op otherwise)
                const wasDuel = prevPhase && prevPhase.indexOf('duel')===0;   // quitting a 1:1 returns to the 1:1 menu, not main
                inGame=false; showHUD(false);
                Snd.musicFadeOut(0.25); Snd.duck(false);   // leave: fade the game track 0.25s, sfx back to normal (fadeOut cleared the track, so duck skips music)
                _musicHoldUntil = performance.now()+250;   // menu music starts after the fade
                _wsend({t:'run',on:true}); _wsend({t:'phase',phase:'menu'});   // worker has no duelMenu phase: send it to menu
                // Quitting on purpose says nothing: _duelMsg is never cleared, only
                // overwritten, so an in-game line from the last 2.6s would follow us out
                // and draw on the menu as if it had happened there. (_duelExit does the
                // same -- these are the TWO ways out of a duel.)
                _duelMsg=''; _duelMsgAt=0;
                phase = wasDuel ? 'duelMenu' : 'menu';   // set AFTER the worker sync (in-process simCommand would clobber it otherwise)
            }   // quit: leave gameplay, keep the worker clock running for menu animations
            else { phase=prevPhase; Snd.duck(false); }   // back to the game at full volume
        },
        back(){ phase=prevPhase; Snd.duck(false); },
        other(key){ if(key==='y'||key==='Y'){ this.confirm(); return true; } return false; },
    },
    resetConfirm: {
        nav(key){
            if(key==='ArrowLeft'){ quitConfirmSel=0; Snd.sfxPlay('nav',cfg.music); }
            if(key==='ArrowRight'){ quitConfirmSel=1; Snd.sfxPlay('nav',cfg.music); }
        },
        confirm(){
            Snd.sfxPlay('select',cfg.music);
            if(quitConfirmSel===0){
                if(_resetKind==='settings') resetSettings();
                else if(_resetKind==='id'){ resetPlayerId(); _dataMsg='NEW ID '+fmtPlayerId(); _dataMsgAt=simNow; }
                else resetStats();
            }
            phase='settings'; quitConfirmSel=1;
        },
        back(){ phase='settings'; },
    },
    duelOver: {   // PLAY AGAIN? dialog -- YES pre-selected (see the phase-change hook)
        nav(key){
            if(key==='ArrowLeft'){ quitConfirmSel=0; Snd.sfxPlay('nav',cfg.music); }
            if(key==='ArrowRight'){ quitConfirmSel=1; Snd.sfxPlay('nav',cfg.music); }
        },
        confirm(){
            Snd.sfxPlay('select',cfg.music);
            if(quitConfirmSel===0){
                if(typeof netGameActive==='function' && netGameActive()) netAgain();   // online: agree first
                else beginDuel();   // local rematch: fresh match, lives + scores reset
            }
            else _duelExit();
        },
        back: _duelExit,
        other(key){ if(key==='y'||key==='Y'){ this.confirm(); return true; } return false; },
    },
    nameEntry: {
        nav(key){
            if(key==='ArrowUp')  {nameCharIdx=(nameCharIdx-1+_entryChars().length)%_entryChars().length;Snd.sfxPlay('nav',cfg.music);}
            else if(key==='ArrowDown'){nameCharIdx=(nameCharIdx+1)%_entryChars().length;Snd.sfxPlay('nav',cfg.music);}
            else if(key==='ArrowLeft'){ _placeName(); if(nameCursorPos>0)nameCursorPos--; _syncDial(); Snd.sfxPlay('nav',cfg.music); }
            else if(key==='ArrowRight'){ _placeName(); if(nameCursorPos<_entryMax()-1)nameCursorPos++; _syncDial(); Snd.sfxPlay('nav',cfg.music); }
        },
        // Hardware RETURN, the iPad keyboard's return key and the START button submit
        // directly (no-op while empty); OK/tap keeps the dial semantics via add().
        confirm(){ _submitName(); },
        add(){
            if(_entryChars()[nameCharIdx]==='\r'){ _submitName(); }
            else { _placeName(); if(nameCursorPos<_entryMax()-1)nameCursorPos++; _syncDial(); Snd.sfxPlay('nav',cfg.music); }
        },
        back(key){
            // Delete one character. Only a real ESC on an EMPTY field cancels out of the
            // menu-opened modes -- held/repeated Backspace must never fall through and
            // exit (score mode has no cancel at all: a run always ends in a submit).
            if(key!=='Backspace' && entryMode!=='score' && nameStr.length===0){ _entryLeave(entryMode==='friend'?'duelMenu':'settings'); Snd.sfxPlay('nav',cfg.music); }
            else _nameDelete();
        },
        text(key){
            const ch=key.toUpperCase();
            if(!_entryChars().includes(ch)) return;   // friend mode: hex digits only
            if(nameCursorPos<nameStr.length) nameStr=nameStr.slice(0,nameCursorPos)+ch+nameStr.slice(nameCursorPos+1);
            else if(nameStr.length<_entryMax()) nameStr+=ch;
            if(nameCursorPos<_entryMax()-1)nameCursorPos++; _syncDial(); Snd.sfxPlay('nav',cfg.music);
        },
    },
};
// ================================================================
// GAME CONTROLS  (the ONLY funnel for continuous gameplay input)
// Every source (keyboard, dpad, swipe) steers through these; a future ONLINE
// peer is simply another caller with p = its player index.
// ================================================================
function gameSteer(p, d){
    if(typeof netLocalInput === 'function' && netLocalInput('dir', p, d)) return;   // online: predict locally + send
    if(typeof netLogDir === 'function') netLogDir(d);          // classic: replay material for score submits
    _wsend({t:'dir', p, dir:d});
}
// Boost input ARMS (device-local, rides to whichever home runs the sim); the real
// engage/end transitions are issued by simArmTick there -- those are what reach the
// sim, the wire and the replay log. Nothing here is a transition itself.
function gameBoostStart(p, d, now){ _wsend({ t:'arm', p, dir:{ x:d.x, y:d.y }, now:!!now }); }
function gameBoostEnd(p){ _wsend({ t:'arm', p, dir:null }); }
// ================================================================
// ROUTER
// ================================================================
function handleKey(key, pde) {
    // Let browser handle F-keys (F5 reload, F11 fullscreen, etc.)
    if (key.length > 1 && !GAME_KEYS.has(key)) return;
    _uiDirty = true;   // any input redraws the frozen/static screens next frame
    if (phase === 'splash') {
        // Capture only the meaningful keys: arrows fast-forward the coin drop,
        // Space/Enter start the game. Everything else is ignored (no preventDefault)
        // so browser/OS shortcuts keep working on the splash screen.
        if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
            if (!_splashFast && !_splashExiting) {
                _splashFast = true;
                _splashFastStart = simNow;
                _splashFastBase = (simNow - phaseAt) / 1000;
            }
            return;
        }
        if (key === 'Enter' || key === ' ') { triggerSplashExit(); if (pde) pde(); return; }
        return;
    }
    if (_splashKeyHeld) return;
    if (performance.now() - _splashLeftAt < 200) return;   // 200ms post-splash debounce, on the WALL clock (simNow gets reset by a game start)

    // Global: mute (suppressed during name entry so M is typeable)
    if((key==='m'||key==='M')&&phase!=='nameEntry'){ toggleMute(); return; }

    // Space = pause toggle in gameplay, space char in name entry; UI screens get space()
    if(key===' '){
        if(phase==='nameEntry'){ const sp=_entryChars().indexOf(' '); if(sp>=0){ nameCharIdx=sp; handleKey('NameAdd',pde); } return; }
        if(phase==='playing'||phase==='paused'||phase==='duel'||phase==='duelPaused'){ togglePause(); if(pde)pde(); return; }
        if(phase==='credits'){ _creditsNormal=_creditsNormal>0?0:0.8; creditsSpeed=_creditsNormal; if(pde)pde(); return; }
    }

    // Backspace alias: back-out in settings/shop. In the name entry it stays
    // Backspace (delete only -- it must never fall through to the cancel).
    if(key==='Backspace' && (phase==='settings'||phase==='shop')) key='Escape';

    // Escape during live gameplay opens the quit overlay; the game keeps RUNNING behind
    // it (a paused game stays paused) -- only confirming YES terminates. Online duels
    // will need exactly this. All UI screens handle Escape via their table row instead.
    if(key==='Escape' && (phase==='playing'||phase==='paused'||phase==='duel'||phase==='duelReady'||phase==='duelPaused')){
        prevPhase=phase; quitConfirmSel=1;
        Snd.duck(true);   // dialog up: music + sfx at 50% while the game runs behind it
        phase='quitConfirm'; if(pde)pde(); return;
    }

    // ---- UI screens: table dispatch --------------------------------------------
    const ui = UI_INPUT[phase];
    if(ui){
        let handled = false;
        if(GDIRS[key])                { if(ui.nav)    { ui.nav(key);  handled=true; } }
        else if(key==='Enter')        { if(ui.confirm){ ui.confirm(); handled=true; } }
        else if(key==='NameAdd')      { if(ui.add)    { ui.add();     handled=true; } }
        else if(key==='Escape')       { if(ui.back)   { ui.back(key); handled=true; } }
        else if(key==='Backspace')    { if(ui.back)   { ui.back(key); handled=true; } }
        else if(key===' ')            { if(ui.space)  { ui.space();   handled=true; } }
        else if(ui.text && key.length===1 && NAME_CHARS.includes(key.toUpperCase())){ ui.text(key); handled=true; }
        if(!handled && ui.other) handled = !!ui.other(key);
        if(handled && pde) pde();
        return;
    }

    // ---- gameplay phases: continuous controls -> player-indexed sim commands ----
    if(phase==='levelDone'){
        if(levelDoneWaiting){
            // Start the next level. Single player + local duel: straight to the sim. Online
            // duel: synced over the wire (netLocalInput sends 'adv' -> the same 'advance'
            // command at an agreed tick; either player may press, the guard makes the later
            // press a no-op). simCommand's levelDone+waiting guard makes duplicates safe.
            if(!(typeof netLocalInput==='function' && netLocalInput('adv',0))) _wsend({t:'advance'});
            if(pde)pde();
        }
    }
    else if(phase==='playing'){
        const d=GDIRS[key];
        if(d){
            if(pde)pde();
            gameSteer(0, d);   // the worker applies the same steering guard
        }
    }
    else if(phase==='duel'||phase==='duelReady'){
        // P0 = arrows, P2 = WASD. Both enter the sim as player-indexed commands -- the
        // exact boundary a remote peer will feed later (their input arrives as p:1).
        const d0=GDIRS[key];
        if(d0){ if(pde)pde(); gameSteer(0, d0); }
        else { const d1=WASD[key.toLowerCase&&key.toLowerCase()]; if(d1){ if(pde)pde(); gameSteer(1, d1); } }
    }
}
// ================================================================
// SOURCE: KEYBOARD  (hardware keys + webOS TV remote)
// ================================================================
// TV remotes as data: Back + the RED colour button map to Escape (exit shop / back /
// quit-to-menu -- RED is the reliable exit when a remote has no usable Back), the BLUE
// colour button to Space (pause / credits speed / name space). webOS keyCodes + names.
const TV_CODES={461:'Escape',403:'Escape',406:' '};
const TV_NAMES={BrowserBack:'Escape',GoBack:'Escape',XF86Back:'Escape',ColorF0Red:'Escape',Red:'Escape',ColorF3Blue:' ',Blue:' '};
document.addEventListener('keydown', e=>{
    const tv=TV_CODES[e.keyCode]||TV_NAMES[e.key];
    if(tv){ e.preventDefault(); handleKey(tv,null); return; }
    if(e.ctrlKey||e.metaKey||e.altKey) return;   // let browser/OS shortcuts (Ctrl+Shift+R etc.) through
    // Held-key auto-repeat is NOISE during play: steering is a one-shot (the dpad
    // suppresses its own repeat for the same reason, see the dpad notes), and online
    // every repeated same-dir steer would go down the wire as a fresh record -- a sim
    // no-op that still inflates the packet stream and, landing just after a step
    // boundary, forces a rollback that changes nothing. Menus keep their repeats.
    if(e.repeat&&(phase==='playing'||phase==='duel'||phase==='duelReady')){ e.preventDefault(); return; }
    if(phase==='splash'&&!_splashExiting) _splashKeyHeld = true;
    handleKey(e.key,()=>e.preventDefault());
    if(!e.repeat&&(phase==='playing'||phase==='duel')){
        const d=GDIRS[e.key];
        if(d){_kbBoostDir=d;gameBoostStart(0,d);}
        else if(phase==='duel'){ const w=WASD[e.key.toLowerCase&&e.key.toLowerCase()]; if(w){_kbBoostW=w;gameBoostStart(1,w);} }
    }
    if(phase==='playing'||phase==='duel') document.body.classList.add('cursor-hidden');   // CSS hides #c cursor; mousemove clears it
});
document.addEventListener('keyup', e=>{
    _splashKeyHeld = false;
    const d=GDIRS[e.key];
    // Compare against the locally-tracked keydown dir, NOT the mirrored boostDir: the
    // mirror lags a frame, so a quick tap would release before it reflects the boost and
    // the boostend would never be sent (leaving the worker boosting on its own).
    if(d&&_kbBoostDir&&d.x===_kbBoostDir.x&&d.y===_kbBoostDir.y){_kbBoostDir=null;gameBoostEnd(0);}
    const w=WASD[e.key.toLowerCase&&e.key.toLowerCase()];
    if(w&&_kbBoostW&&w.x===_kbBoostW.x&&w.y===_kbBoostW.y){_kbBoostW=null;gameBoostEnd(1);}
    if(phase==='credits'&&(e.key==='ArrowDown'||e.key==='ArrowUp'))creditsSpeed=_creditsNormal;
});
// ================================================================
// SOURCE: POINTER + TOUCH SWIPE  (canvas gestures)
// ================================================================
canvas.addEventListener('mousemove', ()=>{ document.body.classList.remove('cursor-hidden'); });

// Swipe/gesture control on game canvas.
// Thresholds (px of finger travel): first move or reverse = SWIPE_1 (16), or SWIPE_N
// (24) while boosting; 90-deg turn = SWIPE_N (24); continue same direction = SWIPE_SAME
// (48), which suppresses accidental boosts.
// Dead zone: 40-50 degrees from horizontal -- diagonal motion commits nothing until
// the finger clearly enters a direction corridor (0-40 deg = horizontal, 50-90 = vertical).
// In the dead zone the baseline is NOT reset, so displacement keeps accumulating until
// the angle exits into a real corridor.
// Move cooldown: if the finger pauses longer than SWIPE_COOLDOWN (40ms) the last
// direction is cleared, so the next move uses the first-move threshold and re-moves
// after a pause feel as responsive as the first direction.
// Splash: any pointer or touch on canvas exits splash and unlocks audio
// Mouse/stylus only: touch devices use the touchstart handler below so that
// triggerSplashExit() calls Snd.audioResume() inside a touchstart, not a pointerdown
// (iOS Safari only honours AudioContext unlock from touchstart, not pointerdown).
canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    // A pointer click (mouse / TV remote) acts as OK: start on splash, add-a-letter
    // in name entry, confirm/select in every other menu. Not during gameplay.
    if (phase === 'splash') { _splashFast = true; _splashFastStart = simNow; _splashFastBase = (simNow - phaseAt) / 1000; }
    else if (phase === 'nameEntry') { handleKey('NameAdd', null); }
    else if (!_inPlay()) { handleKey('Enter', null); }
});
canvas.addEventListener('pointerup', e => {
    if (e.pointerType === 'touch') return;
    if (phase === 'nameEntry' && entryMode === 'friend' && _scanTapAt(e.clientX, e.clientY)) return;
    if (phase === 'splash') { triggerSplashExit(); }
});
canvas.addEventListener('touchstart',  e => { if (phase === 'splash') { _splashFast = true; _splashFastStart = simNow; _splashFastBase = (simNow - phaseAt) / 1000; e.preventDefault(); } }, { passive: false });
const SWIPE_1=16, SWIPE_N=24, SWIPE_SAME=48, DZ_LO=40, DZ_HI=50, SWIPE_COOLDOWN=40;
function _isOpp(a,b){return(a==='ArrowLeft'&&b==='ArrowRight')||(a==='ArrowRight'&&b==='ArrowLeft')||(a==='ArrowUp'&&b==='ArrowDown')||(a==='ArrowDown'&&b==='ArrowUp');}
let _swipeBase=null, _swipeLastDir=null, _swipeLastMoveAt=0, _swipeLastMovePos=null, _swipeTouchStartAt=0, _swipedThisTouch=false, _menuHDir=null;
canvas.addEventListener('touchstart',e=>{
    e.preventDefault();
    if(phase==='nameEntry'){
        const t0=e.touches[0];
        if(!(entryMode==='friend' && _scanTapAt(t0.clientX, t0.clientY))) nameInp.focus();
    }
    const t=e.touches[0];
    _swipeBase={x:t.clientX,y:t.clientY}; _swipeLastDir=null; _swipeLastMoveAt=performance.now(); _swipeLastMovePos={x:t.clientX,y:t.clientY}; _swipeTouchStartAt=performance.now(); _swipedThisTouch=false; _menuHDir=null;
},{passive:false});
canvas.addEventListener('touchmove',e=>{
    e.preventDefault();
    if(!_swipeBase||phase==='splash') return;
    const now=performance.now();
    if(_swipeLastDir&&now-_swipeLastMoveAt>SWIPE_COOLDOWN) _swipeLastDir=null;
    const t=e.touches[0];
    if(!_swipeLastMovePos||Math.hypot(t.clientX-_swipeLastMovePos.x,t.clientY-_swipeLastMovePos.y)>=5){_swipeLastMoveAt=now;_swipeLastMovePos={x:t.clientX,y:t.clientY};}
    const dx=t.clientX-_swipeBase.x, dy=t.clientY-_swipeBase.y;
    const dist=Math.hypot(dx,dy);
    if(dist<SWIPE_1) return;
    const ang=Math.atan2(Math.abs(dy),Math.abs(dx))*180/Math.PI;
    const isH=_swipeLastDir==='ArrowLeft'||_swipeLastDir==='ArrowRight';
    const isV=_swipeLastDir==='ArrowUp'||_swipeLastDir==='ArrowDown';
    const dzLo=isH?DZ_LO+5:DZ_LO, dzHi=isV?DZ_HI-5:DZ_HI;
    if(ang>=dzLo&&ang<=dzHi) return;
    const key=ang<dzLo?(dx>0?'ArrowRight':'ArrowLeft'):(dy>0?'ArrowDown':'ArrowUp');
    // first or reverse: SWIPE_1 (SWIPE_N while boosting); 90-deg turn: SWIPE_N; same dir: SWIPE_SAME (boost prevention)
    const thresh=(!_swipeLastDir||_isOpp(key,_swipeLastDir))?(_myBoost().on?SWIPE_N:SWIPE_1):key===_swipeLastDir?SWIPE_SAME:SWIPE_N;
    if(dist<thresh) return;
    // Menu (not playing/credits): a LEFT/RIGHT swipe is one full gesture -- remember it and
    // fire a single key on touchend (no repeat while dragging). UP/DOWN falls through and
    // fires live, immediately, as before. _swipeBase is left un-reset so the gesture holds.
    if(!_inPlay()&&phase!=='credits'&&(key==='ArrowLeft'||key==='ArrowRight')){ _menuHDir=key; return; }
    _swipedThisTouch=true; handleKey(key,null);
    if(_inPlay()){
        const d=GDIRS[key];
        if(d){
            // clearBoost() writes the classic globals directly, which does nothing for a
            // duel snake -- gameBoostEnd routes to the right player in both modes.
            const _mb=_myBoost();
            if(_swipeLastDir&&_isOpp(key,_swipeLastDir)){gameBoostEnd(0);}
            else if(_swipeLastDir&&key===_swipeLastDir){gameBoostStart(0,d,true);}
            else if(!(_mb.on&&_mb.dir&&d.x===_mb.dir.x&&d.y===_mb.dir.y)){gameBoostEnd(0);} // first swipe or 90-deg turn: no boost
        }
    }
    _swipeLastDir=key; _swipeBase={x:t.clientX,y:t.clientY};
},{passive:false});
canvas.addEventListener('touchend',e=>{
    e.preventDefault();
    if(phase==='splash'){
        _swipeBase=null; _swipeLastDir=null;
        triggerSplashExit();
        return;
    }
    if(_swipeBase){
        // Menu left/right gesture: fire ONE key now, on finger-up. Otherwise, tap -> select.
        if(!_inPlay()&&phase!=='credits'&&phase!=='nameEntry'&&_menuHDir){
            handleKey(_menuHDir,null);
        } else {
            const t=e.changedTouches[0];
            const isTap=Math.hypot(t.clientX-_swipeBase.x,t.clientY-_swipeBase.y)<SWIPE_1&&!_swipeLastDir&&!_swipedThisTouch&&performance.now()-_swipeTouchStartAt>20;
            if(!_inPlay()&&phase!=='nameEntry'&&(isTap||cfg.touchSelect)) handleKey('Enter',null);
        }
    }
    _swipeBase=null; _swipeLastDir=null; _swipeLastMovePos=null; _menuHDir=null;
    if(_inPlay()){gameBoostEnd(0);}
    if(phase==='credits'){creditsSpeed=_creditsNormal;}
},{passive:false});

// ================================================================
// SOURCE: D-PAD  (touch gamepad cross)
// ================================================================
const dpadCanvas = document.getElementById('dpad-c');
const dpc = dpadCanvas.getContext('2d');
const DSIZE = 150;
let dpadActive = null;

function drawDpad(active) {
    const S=DSIZE, H=S/2;
    dpc.clearRect(0,0,S,S);
    const sectors=[
        {key:'ArrowUp',    pts:[[H,H],[0,0],[S,0]],  lx:H,      ly:H*0.34,  dir:'u'},
        {key:'ArrowRight', pts:[[H,H],[S,0],[S,S]],  lx:H*1.65, ly:H,       dir:'r'},
        {key:'ArrowDown',  pts:[[H,H],[S,S],[0,S]],  lx:H,      ly:H*1.65,  dir:'d'},
        {key:'ArrowLeft',  pts:[[H,H],[0,S],[0,0]],  lx:H*0.35, ly:H,       dir:'l'},
    ];
    const bh=16, bw=13; // arrow triangle half-height and half-base
    sectors.forEach(s=>{
        const pressed=s.key===active;
        dpc.save();
        dpc.beginPath(); dpc.moveTo(s.pts[0][0],s.pts[0][1]); dpc.lineTo(s.pts[1][0],s.pts[1][1]); dpc.lineTo(s.pts[2][0],s.pts[2][1]); dpc.closePath(); dpc.clip();
        dpc.fillStyle=pressed?'#1a3a1a':'#0a180a'; dpc.fillRect(0,0,S,S);
        dpc.fillStyle='#7fff7f';
        dpc.shadowColor=pressed?'#7fff7f':'transparent'; dpc.shadowBlur=pressed?10:0;
        const cx=s.lx, cy=s.ly;
        dpc.beginPath();
        if(s.dir==='u'){dpc.moveTo(cx,cy-bh);dpc.lineTo(cx+bw,cy+bh);dpc.lineTo(cx-bw,cy+bh);}
        if(s.dir==='r'){dpc.moveTo(cx+bh,cy);dpc.lineTo(cx-bh,cy-bw);dpc.lineTo(cx-bh,cy+bw);}
        if(s.dir==='d'){dpc.moveTo(cx,cy+bh);dpc.lineTo(cx+bw,cy-bh);dpc.lineTo(cx-bw,cy-bh);}
        if(s.dir==='l'){dpc.moveTo(cx-bh,cy);dpc.lineTo(cx+bh,cy-bw);dpc.lineTo(cx+bh,cy+bw);}
        dpc.closePath(); dpc.fill();
        dpc.restore();
    });
    dpc.strokeStyle='#1e321e'; dpc.lineWidth=3;
    dpc.beginPath(); dpc.moveTo(0,0); dpc.lineTo(S,S); dpc.moveTo(S,0); dpc.lineTo(0,S); dpc.stroke();
}

function dpadDir(e, cvs) {
    const rect=cvs.getBoundingClientRect(), sx=cvs.width/rect.width, sy=cvs.height/rect.height;
    const t=e.touches?e.touches[0]||e.changedTouches[0]:e;
    const x=(t.clientX-rect.left)*sx-DSIZE/2, y=(t.clientY-rect.top)*sy-DSIZE/2;
    return Math.abs(x)>Math.abs(y)?(x>0?'ArrowRight':'ArrowLeft'):(y>0?'ArrowDown':'ArrowUp');
}

const _DPAD_DELAY=400, _DPAD_RATE=150;
// Phases where a held dpad must NOT auto-repeat: steering is a one-shot, and in a
// duel a repeat would also re-send the same direction down the wire every 150ms.
const _DPAD_GAME=new Set(['playing','paused','dying','levelReady','levelDone','duel','duelReady','duelPaused']);
let _dpadRepeatTimer=null;
function _clearDpadRepeat(){if(_dpadRepeatTimer){clearTimeout(_dpadRepeatTimer);_dpadRepeatTimer=null;}}
function _startDpadRepeat(dir){
    _clearDpadRepeat();
    if(_DPAD_GAME.has(phase)) return;
    function fire(){if(_DPAD_GAME.has(phase)){_clearDpadRepeat();return;}handleKey(dir,null);_dpadRepeatTimer=setTimeout(fire,_DPAD_RATE);}
    _dpadRepeatTimer=setTimeout(fire,_DPAD_DELAY);
}

dpadCanvas.addEventListener('touchstart',e=>{
    e.preventDefault();
    if(phase==='nameEntry') nameInp.blur();
    dpadActive=dpadDir(e,dpadCanvas); handleKey(dpadActive,null);
    drawDpad(phase==='splash'?null:dpadActive);
    if(_inPlay()){const d=GDIRS[dpadActive];if(d){gameBoostStart(0,d);}}
    _startDpadRepeat(dpadActive);
},{passive:false});
dpadCanvas.addEventListener('touchmove',e=>{
    e.preventDefault();
    const d=dpadDir(e,dpadCanvas);
    if(d!==dpadActive){
        dpadActive=d; handleKey(dpadActive,null);
        drawDpad(phase==='splash'?null:dpadActive);
        if(_inPlay()){const gd=GDIRS[dpadActive];if(gd){gameBoostStart(0,gd);}else{gameBoostEnd(0);}}
        _startDpadRepeat(dpadActive);
    }
},{passive:false});
dpadCanvas.addEventListener('touchend',e=>{e.preventDefault();dpadActive=null;drawDpad(null);gameBoostEnd(0);_clearDpadRepeat();if(phase==='credits')creditsSpeed=_creditsNormal;},{passive:false});
dpadCanvas.addEventListener('touchcancel',e=>{dpadActive=null;drawDpad(null);gameBoostEnd(0);_clearDpadRepeat();if(phase==='credits')creditsSpeed=_creditsNormal;});
dpadCanvas.addEventListener('click',e=>{handleKey(dpadDir(e,dpadCanvas),null);});
drawDpad(null);
// ================================================================
// SOURCE: SIDE BUTTONS
// ================================================================
// Side buttons
document.getElementById('btn-ok').addEventListener('touchstart',e=>{if(phase==='nameEntry')nameInp.blur();handleKey(phase==='nameEntry'?'NameAdd':'Enter',null);e.preventDefault();},{passive:false});
document.getElementById('btn-ok').addEventListener('click',()=>handleKey(phase==='nameEntry'?'NameAdd':'Enter',null));
document.getElementById('btn-pause').addEventListener('touchstart',e=>{handleKey(' ',null);e.preventDefault();},{passive:false});
document.getElementById('btn-pause').addEventListener('click',()=>handleKey(' ',null));
document.getElementById('btn-start').addEventListener('touchstart',e=>{if(phase==='menu')beginGame();else handleKey('Enter',null);e.preventDefault();},{passive:false});
document.getElementById('btn-start').addEventListener('click',()=>{if(phase==='menu')beginGame();else handleKey('Enter',null);});
document.getElementById('gamepad').classList.add('splash');
document.getElementById('btn-esc').addEventListener('touchstart',e=>{handleKey('Escape',null);e.preventDefault();},{passive:false});
document.getElementById('btn-esc').addEventListener('click',()=>handleKey('Escape',null));

// Mobile name entry via OS keyboard
// ================================================================
// SOURCE: NAME FIELD  (hidden input = on-screen keyboard bridge)
// ================================================================
const nameInp = document.getElementById('name-inp');
nameInp.addEventListener('input', e => {
    if (phase !== 'nameEntry') { nameInp.value = ''; return; }   // discard stray text typed while silently focused
    if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') {
        handleKey('Backspace', null);
        nameInp.value = ''; return;
    }
    const val = nameInp.value.toUpperCase();
    for (const ch of val) {
        if (_entryChars().includes(ch)) { handleKey(ch, null); }
    }
    nameInp.value = '';
});
nameInp.addEventListener('keydown', e => {
    if (phase !== 'nameEntry') return;
    // This handler owns keystrokes while the (focused) input drives name entry. Without
    // stopPropagation the same event bubbles to the document keydown listener and is
    // handled AGAIN -- on iPad the on-screen return key then submitted (-> scores) and
    // immediately confirmed out of the scores screen (-> menu) in one press.
    e.stopPropagation();   // the document keydown listener must not ALSO handle this
    if (e.key === 'Enter') { handleKey('Enter', () => e.preventDefault()); }
    if (e.key === 'Backspace') { e.preventDefault(); handleKey('Backspace', null); }
    // Do NOT preventDefault a character key: that cancels its insertion into the field,
    // so the 'input' event never fires and the letter is lost. The 'input' handler is the
    // one that records characters; let the key land. (iPad hardware/soft keyboard both hit
    // this path once the field is focused.)
});

// ================================================================
// SOURCE: QR SCANNER  (ADD FRIEND: camera auto-starts, a verified read submits)
// Heavy resources are strictly on-demand: getUserMedia runs only while the ADD
// FRIEND screen is open and every track is stopped on leave. Detection prefers
// the browser-native BarcodeDetector (Android/Chrome); otherwise frames go
// through our own decoder in qr.js (iOS has no BarcodeDetector).
// ================================================================
let _scanStream=null, _scanVideo=null, _scanState='off';   // off|starting|live|denied
let _scanOk='', _scanOkAt=0;   // successful read: shown briefly before the auto-submit
let _scanManualOff=false;      // user tapped the viewfinder to switch the camera off
let _scanBusy=false, _scanCv=null, _scanCtx=null, _scanFrame=0;
const _scanDetector=(()=>{ try{ return ('BarcodeDetector' in window)?new BarcodeDetector({formats:['qr_code']}):null; }catch(e){ return null; } })();
function scanStart(){
    if(_scanState==='starting'||_scanState==='live') return;   // 'denied' may retry on a fresh gesture
    _scanState='starting';
    try{
        navigator.mediaDevices.getUserMedia({video:{facingMode:'environment',width:{ideal:1280},height:{ideal:720}},audio:false}).then(s=>{
            if(phase!=='nameEntry'||entryMode!=='friend'){ s.getTracks().forEach(t=>t.stop()); _scanState='off'; return; }
            _scanStream=s;
            const v=document.createElement('video');
            v.setAttribute('playsinline',''); v.muted=true; v.srcObject=s;
            v.play().then(()=>{ _scanVideo=v; _scanState='live'; }).catch(()=>scanStop());
        }).catch(()=>{ _scanState='denied'; });
    }catch(e){ _scanState='denied'; }
}
function scanStop(){
    if(_scanStream){ try{ _scanStream.getTracks().forEach(t=>t.stop()); }catch(e){} }
    _scanStream=null; _scanVideo=null; _scanBusy=false; _scanState='off';
}
// Called per frame by the ADD FRIEND screen; decodes roughly 10x per second.
function scanTick(){
    if(_scanState!=='live'||_scanBusy||!_scanVideo||!_scanVideo.videoWidth) return;
    if((_scanFrame++%6)!==0) return;
    if(_scanDetector){
        _scanBusy=true;
        _scanDetector.detect(_scanVideo).then(rs=>{ _scanBusy=false; for(const r of rs||[]) _scanHit(r.rawValue); }).catch(()=>{ _scanBusy=false; });
        return;
    }
    const vw=_scanVideo.videoWidth, vh=_scanVideo.videoHeight, s=Math.min(vw,vh)*0.7;
    if(!_scanCv){ _scanCv=document.createElement('canvas'); _scanCv.width=464; _scanCv.height=464; _scanCtx=_scanCv.getContext('2d',{willReadFrequently:true}); }
    _scanCtx.drawImage(_scanVideo,(vw-s)/2,(vh-s)/2,s,s,0,0,464,464);
    try{ const hit=qrDecodeImage(_scanCtx.getImageData(0,0,464,464)); if(hit) _scanHit(hit); }catch(e){}
}
// Tap/click on the viewfinder toggles the camera (default: on when entering).
function _scanTapAt(cx,cy){
    if(_scanOk) return false;   // locked: the submit is already on its way
    const r=canvas.getBoundingClientRect();
    if(!r.width||!r.height) return false;
    const x=(cx-r.left)*CW/r.width, y=(cy-r.top)*CH/r.height;
    if(x<SCAN_VF.x-8||x>SCAN_VF.x+SCAN_VF.s+8||y<SCAN_VF.y-8||y>SCAN_VF.y+SCAN_VF.s+8) return false;
    if(_scanState==='starting'||_scanState==='live'){ scanStop(); _scanManualOff=true; }
    else { _scanManualOff=false; scanStart(); }
    Snd.sfxPlay('nav',cfg.music); _uiDirty=true;
    return true;
}
function _scanHit(str){
    const m=/#friend=([0-9a-f]{8})$/.exec(String(str||'').trim());
    if(!m||phase!=='nameEntry'||entryMode!=='friend'||_scanOk) return;
    nameStr=m[1].toUpperCase(); nameCursorPos=8;
    _scanOk=fmtFriendId(m[1]); _scanOkAt=simNow;   // show the lock on-screen first...
    scanStop(); Snd.sfxPlay('achievement',cfg.music); spawnConfetti();   // celebrate like an achievement
    setTimeout(()=>{ if(phase==='nameEntry'&&entryMode==='friend') _submitName(); },1400);   // ...then submit
}

// Mute button
// ================================================================
// SOURCE: MUTE BUTTON
// ================================================================
const muteBtn = document.getElementById('btn-mute');
const _muteCv = document.getElementById('btn-mute-cv');
const _muteCvCtx = _muteCv.getContext('2d');
function updateMuteBtn(){
    const on=cfg.music; muteBtn.classList.toggle('muted',!on);
    const c=_muteCvCtx;
    c.clearRect(0,0,32,16);
    const spkHi  = ['#ccffcc','#ccffcc','#bbffbb','#7fff7f','#7fff7f','#55cc55','#3a993a','#3a993a'];
    const spkLo  = ['#888888','#888888','#7a7a7a','#555555','#555555','#404040','#2a2a2a','#2a2a2a'];
    SPEAKER_BODY.forEach((row,ry)=>row.forEach((p,rx)=>{
        if(!p)return;
        c.fillStyle=on?spkHi[ry]:spkLo[ry];
        c.fillRect(rx*2,ry*2,2,2);
    }));
    const sigil=on?SPEAKER_WAVES:SPEAKER_X;
    sigil.forEach((row,ry)=>row.forEach((p,rx)=>{
        if(!p)return;
        c.fillStyle=on?spkHi[ry]:'#aa3333';
        c.fillRect(rx*2+16,ry*2,2,2);
    }));
}
function toggleMute(){ cfg.music=!cfg.music; if(!cfg.music)Snd.musicMute('mute'); else{Snd.audioResume();Snd.musicUnmute('mute');Snd.sfxPlay('nav',cfg.music);} updateMuteBtn(); saveCfg(); _uiDirty=true; }
muteBtn.addEventListener('click',toggleMute);
muteBtn.addEventListener('touchstart',e=>{e.preventDefault();toggleMute();},{passive:false});
updateMuteBtn();
// ================================================================
// SOURCE: SPLASH INPUT + AUDIO UNLOCK + BACKGROUND
// ================================================================
// Single-use splash owner. While the coin-drop splash is up, THIS is the only handler that
// acts on input: it is attached in the CAPTURE phase so it intercepts every gesture before
// any game handler and swallows it there (stopImmediatePropagation) -- the game handlers stay
// registered but never see splash input. iOS only unlocks the AudioContext from inside a user
// gesture, and the first gesture IS the splash exit, so we own both: resume() on the gesture
// DOWN (which fast-forwards the coin drop but does NOT exit -- we let the gesture finish), and
// resume() again on UP -- where we leave splash ONLY inside that resume's continuation, so we
// never transition to the menu before audio is actually unlocked. iOS can hang the first
// resume() (worse on a long hold, where DOWN was that first call); if it never completes we
// simply stay on splash and the next gesture retries.
let _splashHandledUp = false;
function _splashResumeFF(){                 // gesture DOWN: unlock + fast-forward, do NOT exit yet
    if(phase !== 'splash') return;
    Snd.audioResume();
    // Anchor the fast-forward base ONCE: key auto-repeat re-fires this dozens of times a
    // second, and re-anchoring every time jerks the coin drop.
    if(!_splashFast && !_splashExiting){ _splashFast = true; _splashFastStart = simNow; _splashFastBase = (simNow - phaseAt) / 1000; }
}
function _splashCommit(){                    // gesture UP: leave splash ONLY once the resume completes
    if(phase !== 'splash' || _splashHandledUp) return;
    Snd.audioResume().then(() => {
        if(phase !== 'splash' || _splashHandledUp) return;   // an earlier gesture's resume already left
        _splashHandledUp = true;
        triggerSplashExit();                 // coin sfx + start the transition, now that audio is live
        _splashDetach();
    });
}
function _splashDown(e){ e.stopImmediatePropagation(); if(e.type === 'touchstart') e.preventDefault(); _splashResumeFF(); }
function _splashUp(e){   e.stopImmediatePropagation(); if(e.type === 'touchend')   e.preventDefault(); _splashCommit(); }
function _splashKey(e){
    if(e.ctrlKey || e.metaKey || e.altKey) return;     // let OS shortcuts through, unswallowed
    const k = e.key;
    if(k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight'){ e.stopImmediatePropagation(); _splashResumeFF(); }
    else if(k === 'Enter' || k === ' '){ e.stopImmediatePropagation(); e.preventDefault(); _splashKeyHeld = true; _splashCommit(); }
    // any other key falls through so browser/OS shortcuts keep working on the splash
}
function _splashDetach(){
    document.removeEventListener('touchstart', _splashDown, true);
    document.removeEventListener('touchend',   _splashUp,   true);
    document.removeEventListener('pointerdown',_splashDown, true);
    document.removeEventListener('pointerup',  _splashUp,   true);
    document.removeEventListener('keydown',    _splashKey,  true);
}
document.addEventListener('touchstart', _splashDown, {capture:true, passive:false});
document.addEventListener('touchend',   _splashUp,   {capture:true, passive:false});
document.addEventListener('pointerdown',_splashDown, {capture:true, passive:false});
document.addEventListener('pointerup',  _splashUp,   {capture:true, passive:false});
document.addEventListener('keydown',    _splashKey,  {capture:true});
// Pause audio when app goes to background, resume when it returns
function onBgHide() {
    // Pause via the worker -- writing phase on the main-thread mirror would be clobbered
    // by the next snapshot and the worker (whose timers keep running in a hidden tab,
    // unlike RAF) would play on unseen. The worker ignores 'pause' unless playing.
    // A LOCAL duel backgrounds exactly like a classic game. An ONLINE one must not:
    // freezing our sim while the peer plays on is a guaranteed desync, which is why
    // togglePause() refuses online too.
    const netLive = typeof netGameActive === 'function' && netGameActive();
    if (phase === 'playing' || (phase === 'duel' && !netLive)) { _wsend({t:'pause'}); Snd.musicMute('pause'); }
    Snd.audioSuspend();
}
function onBgShow() { if (cfg.music) Snd.audioResume(); }
document.addEventListener('visibilitychange', () => { if (document.hidden) onBgHide(); else onBgShow(); });
window.addEventListener('pagehide', onBgHide);
