// ============================================================================
// input.js -- all input: the D-pad canvas plus the keyboard / touch / pointer /
// TV-remote handlers and handleKey(). Split out of game.js. Loaded LAST (after
// game.js + render.js), so every symbol it references is already defined.
// ============================================================================
// ================================================================
// D-PAD
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
const _DPAD_GAME=new Set(['playing','paused','dying','levelReady','levelDone']);
let _dpadRepeatTimer=null;
function _clearDpadRepeat(){if(_dpadRepeatTimer){clearTimeout(_dpadRepeatTimer);_dpadRepeatTimer=null;}}
function _startDpadRepeat(dir){
    _clearDpadRepeat();
    if(_DPAD_GAME.has(phase)) return;
    function fire(){if(_DPAD_GAME.has(phase)){_clearDpadRepeat();return;}handleKey(dir,null);_dpadRepeatTimer=setTimeout(fire,_DPAD_RATE);}
    _dpadRepeatTimer=setTimeout(fire,_DPAD_DELAY);
}

dpadCanvas.addEventListener('touchstart',e=>{
    Snd.audioResume(); e.preventDefault();
    if(phase==='nameEntry') nameInp.blur();
    dpadActive=dpadDir(e,dpadCanvas); handleKey(dpadActive,null);
    drawDpad(phase==='splash'?null:dpadActive);
    if(phase==='playing'){const d=GDIRS[dpadActive];if(d){boostDir=d;boostSince=simTick;boosting=false;}}
    _startDpadRepeat(dpadActive);
},{passive:false});
dpadCanvas.addEventListener('touchmove',e=>{
    e.preventDefault();
    const d=dpadDir(e,dpadCanvas);
    if(d!==dpadActive){
        dpadActive=d; handleKey(dpadActive,null);
        drawDpad(phase==='splash'?null:dpadActive);
        if(phase==='playing'){const gd=GDIRS[dpadActive];if(gd){boostDir=gd;boostSince=simTick;boosting=false;}else{boostDir=null;boosting=false;}}
        _startDpadRepeat(dpadActive);
    }
},{passive:false});
dpadCanvas.addEventListener('touchend',e=>{e.preventDefault();dpadActive=null;drawDpad(null);boostDir=null;boosting=false;_clearDpadRepeat();if(phase==='credits')creditsSpeed=_creditsNormal;},{passive:false});
dpadCanvas.addEventListener('touchcancel',e=>{dpadActive=null;drawDpad(null);boostDir=null;boosting=false;_clearDpadRepeat();if(phase==='credits')creditsSpeed=_creditsNormal;});
dpadCanvas.addEventListener('click',e=>{handleKey(dpadDir(e,dpadCanvas),null);});
drawDpad(null);

// ================================================================
// INPUT
// ================================================================
const GDIRS={ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1},ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0}};

let _splashLeftAt = 0, _splashKeyHeld = false;
let _splashFast = false, _splashFastStart = 0, _splashFastBase = 0;
let _splashExiting = false, _splashExitAt = 0;
function triggerSplashExit() {
    if (phase !== 'splash' || _splashExiting) return;
    _splashFast = false; _splashFastStart = 0; _splashFastBase = 0;
    _splashExiting = true;
    _splashExitAt = simNow;
    Snd.sfxPlay('coin'); Snd.audioResume();
}

const GAME_KEYS = new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter','Escape','Backspace',' ','NameAdd']);
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
    if (simNow - _splashLeftAt < 200) return;
    Snd.audioResume();

    // Global: mute (suppressed during name entry so M is typeable)
    if((key==='m'||key==='M')&&phase!=='nameEntry'){ toggleMute(); return; }

    // Space = pause toggle (playing/paused), credits speed toggle, or space char in nameEntry
    if(key===' '){
        if(phase==='nameEntry'){ nameCharIdx=NAME_CHARS.indexOf(' '); handleKey('NameAdd',pde); return; }
        if(phase==='playing'||phase==='paused'){ togglePause(); if(pde)pde(); return; }
        if(phase==='credits'){ _creditsNormal=_creditsNormal>0?0:0.8; creditsSpeed=_creditsNormal; if(pde)pde(); return; }
    }

    // In settings/shop, Backspace goes back like Escape (not advertised in the hint text).
    if(key==='Backspace' && (phase==='settings'||phase==='shop')) key='Escape';

    // Escape = quit confirm in-game, or back in menus
    // Backspace deletes a character in name entry (physical keyboard), same as ESC.
    if(key==='Backspace' && phase==='nameEntry'){
        if(nameCursorPos>0){nameStr=nameStr.slice(0,nameCursorPos-1)+nameStr.slice(nameCursorPos);nameCursorPos--;if(nameCursorPos<nameStr.length){const ci=NAME_CHARS.indexOf(nameStr[nameCursorPos]);if(ci>=0)nameCharIdx=ci;}Snd.sfxPlay('nav',cfg.music);}
        if(pde)pde(); return;
    }
    if(key==='Escape'){
        if(phase==='nameEntry'){
            if(nameCursorPos>0){nameStr=nameStr.slice(0,nameCursorPos-1)+nameStr.slice(nameCursorPos);nameCursorPos--;if(nameCursorPos<nameStr.length){const ci=NAME_CHARS.indexOf(nameStr[nameCursorPos]);if(ci>=0)nameCharIdx=ci;}Snd.sfxPlay('nav',cfg.music);}
            if(pde)pde(); return;
        }
        if(phase==='playing'||phase==='paused'){
            if(performance.now() < escReadyAt) return;
            prevPhase=phase; quitConfirmSel=1;
            if(phase==='playing') Snd.musicGamePause();
            phase='quitConfirm'; if(pde)pde(); return;
        }
        if(phase==='quitConfirm'){
            phase=prevPhase; if(prevPhase==='playing')Snd.musicGameUnpause();
            escReadyAt=performance.now()+1000; if(pde)pde(); return;
        }
        if(phase==='resetConfirm'){ phase='settings'; if(pde)pde(); return; }
        if(phase==='settings'){
            if(settingsCat>=0){ settingsSel=settingsCat; settingsCat=-1; _debugEntered=false; } else phase='menu';
            Snd.sfxPlay('nav',cfg.music); if(pde)pde(); return;
        }
        if(phase==='scores'||phase==='credits'||phase==='shop'||phase==='news'){ phase='menu'; Snd.sfxPlay('nav',cfg.music); if(pde)pde(); return; }
        if(phase==='achievements'){ phase='menu'; Snd.sfxPlay('nav',cfg.music); if(pde)pde(); return; }
    }

    if(phase==='menu'){
        const menuCount=MENU_ITEMS.length+(ANNOUNCEMENT?1:0);
        if(key==='ArrowUp')  {menuSel=(menuSel-1+menuCount)%menuCount;Snd.sfxPlay('nav',cfg.music);}
        if(key==='ArrowDown'){menuSel=(menuSel+1)%menuCount;Snd.sfxPlay('nav',cfg.music);}
        if(key==='Enter'){
            Snd.sfxPlay('select',cfg.music);
            if(menuSel===0)startGame();
            else if(menuSel===1){phase='settings';settingsCat=-1;settingsSel=0;}
            else if(menuSel===2){phase='scores';_scoreboardCache=getScores();scoresTab=0;}
            else if(menuSel===3){phase='achievements';achPage=0;}
            else if(menuSel===4){_enterShop();}
            else if(menuSel===5){phase='credits';creditsScroll=CH-20;creditsSpeed=0.8;_creditsNormal=0.8;}
            else if(ANNOUNCEMENT){markAnnounceSeen();phase='news';_newsAt=simNow;newsPage=0;}
            if(pde)pde();
        }
    }
    else if(phase==='settings'){
        const inCat=settingsCat>=0, list=_settingsList(), count=list.length+1;   // +1 for BACK
        const onBack=settingsSel===list.length;
        if(key==='ArrowUp')  {settingsSel=(settingsSel-1+count)%count;Snd.sfxPlay('nav',cfg.music);}
        if(key==='ArrowDown'){settingsSel=(settingsSel+1)%count;Snd.sfxPlay('nav',cfg.music);}
        if(key==='Enter'){
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
        }
        if((key==='ArrowLeft'||key==='ArrowRight') && inCat && !onBack){
            const it=list[settingsSel];
            if(it.adj){ it.adj(key==='ArrowRight'); Snd.sfxPlay('nav',cfg.music); saveCfg(); }
        }
        if(pde)pde();
    }
    else if(phase==='credits'){
        if(key==='ArrowDown'){creditsSpeed=3.5;if(pde)pde();}
        else if(key==='ArrowUp'){creditsSpeed=0.15;if(pde)pde();}
        else if(key==='Enter'){Snd.sfxPlay('nav',cfg.music);phase='menu';creditsSpeed=0.8;_creditsNormal=0.8;if(pde)pde();}
    }
    else if(phase==='scores'){
        if(key==='ArrowLeft'||key==='ArrowRight'){
            const nt = key==='ArrowRight' ? 1 : 0;   // LOCAL left, GLOBAL right
            if(nt!==scoresTab){ scoresTab=nt; Snd.sfxPlay('nav',cfg.music); if(pde)pde(); }
            return;
        }
        if(key==='ArrowUp'||key==='ArrowDown') return;
        Snd.sfxPlay('nav',cfg.music); phase='menu'; if(pde)pde();
    }
    else if(phase==='achievements'){
        if(key==='ArrowUp'||key==='ArrowDown'||key==='ArrowLeft'||key==='ArrowRight') return;
        Snd.sfxPlay('nav',cfg.music); phase='menu'; if(pde)pde();
    }
    else if(phase==='news'){
        const pages=(ANNOUNCEMENT&&ANNOUNCEMENT.pages)||[];
        if(key==='ArrowLeft'||key==='ArrowRight'){
            if(pages.length>1){ newsPage=(newsPage+(key==='ArrowRight'?1:-1)+pages.length)%pages.length; Snd.sfxPlay('nav',cfg.music); if(pde)pde(); }
            return;
        }
        if(key==='ArrowUp'||key==='ArrowDown') return;
        Snd.sfxPlay('nav',cfg.music); phase='menu'; if(pde)pde();
    }
    else if(phase==='shop'){
        const onBoxes = shopPage===BOX_PAGE, onGear = shopPage===GEAR_PAGE;
        const items = onBoxes ? _boxList() : onGear ? _gearList() : SHOP_ITEMS.filter(it=>(it.page||0)===shopPage);
        if(key==='ArrowUp'){ if(items.length){ shopSel=(shopSel-1+items.length)%items.length; Snd.sfxPlay('nav',cfg.music); } }
        else if(key==='ArrowDown'){ if(items.length){ shopSel=(shopSel+1)%items.length; Snd.sfxPlay('nav',cfg.music); } }
        else if(key==='ArrowLeft'){ shopPage=(shopPage-1+SHOP_PAGES)%SHOP_PAGES; shopSel=0; Snd.sfxPlay('nav',cfg.music); }
        else if(key==='ArrowRight'){ shopPage=(shopPage+1)%SHOP_PAGES; shopSel=0; Snd.sfxPlay('nav',cfg.music); }
        else if(key==='Enter'){
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
        }
        else if(key===' ' && !onBoxes){
            const item=items[shopSel];
            const si=cfg.shopItems||{}, wi=cfg.wornItems||(cfg.wornItems={});
            if(item&&!item.repeatable&&si[item.id]){
                if(wi[item.id]) delete wi[item.id]; else wi[item.id]=true;
                saveCfg(); Snd.sfxPlay('nav',cfg.music);
            } else if(item&&!si[item.id]){ Snd.sfxPlay('fail',cfg.music); }
        }
        if(pde)pde();
    }
    else if(phase==='quitConfirm'){
        if(key==='ArrowLeft'){ quitConfirmSel=0; Snd.sfxPlay('nav',cfg.music); }
        if(key==='ArrowRight'){ quitConfirmSel=1; Snd.sfxPlay('nav',cfg.music); }
        if(key==='Enter'||key==='y'||key==='Y'){
            Snd.sfxPlay('select',cfg.music);
            if(quitConfirmSel===0){ phase='menu'; showHUD(false); Snd.musicStop(); }
            else { phase=prevPhase; if(prevPhase==='playing')Snd.musicGameUnpause(); escReadyAt=performance.now()+1000; }
        }
        if(pde)pde();
    }
    else if(phase==='resetConfirm'){
        if(key==='ArrowLeft'){ quitConfirmSel=0; Snd.sfxPlay('nav',cfg.music); }
        if(key==='ArrowRight'){ quitConfirmSel=1; Snd.sfxPlay('nav',cfg.music); }
        if(key==='Enter'){
            Snd.sfxPlay('select',cfg.music);
            if(quitConfirmSel===0){ resetStats(); }
            phase='settings'; quitConfirmSel=1;
        }
        if(pde)pde();
    }
    else if(phase==='levelDone'){
        if(levelDoneWaiting){
            levelDoneWaiting=false;
            if(level<MAX_LEVELS){_levelStartLen=cfg.diff===2?snake.length:0;level++;beginLevel();}
            else{phase='nameEntry';try{nameStr=(localStorage.getItem('lastSName')||'').substring(0,MAX_NAME);}catch (e){nameStr='';}nameCharIdx=nameStr.length>0?NAME_CHARS.indexOf(' '):0;nameCursorPos=nameStr.length;nameReason='win';showHUD(false);Snd.musicStop();}
            if(pde)pde();
        }
    }
    else if(phase==='playing'){
        const d=GDIRS[key];
        if(d){
            if(pde)pde();
            const last=dirQueue.length>0?dirQueue[dirQueue.length-1]:dir;
            if(!(d.x===-last.x&&d.y===-last.y)&&!(d.x===last.x&&d.y===last.y)){if(dirQueue.length<3)dirQueue.push(d);}
        }
    }
    else if(phase==='nameEntry'){
        if(GDIRS[key]&&pde)pde();
        // The dialed letter belongs to the cursor slot: it is written into the name when
        // you move off it or confirm, so it is never lost. OK/Enter place-and-advance;
        // the name is submitted only by selecting the return glyph on the dial.
        const _placeName=()=>{
            const c=NAME_CHARS[nameCharIdx];
            if(c==='\r') return;
            if(nameCursorPos<nameStr.length) nameStr=nameStr.slice(0,nameCursorPos)+c+nameStr.slice(nameCursorPos+1);
            else if(nameStr.length<MAX_NAME) nameStr+=c;
            _nameFlashPos=nameCursorPos; _nameFlashAt=simNow;
        };
        const _syncDial=()=>{ if(nameCursorPos<nameStr.length){const ci=NAME_CHARS.indexOf(nameStr[nameCursorPos]);if(ci>=0)nameCharIdx=ci;} };
        const _submitName=()=>{
            if(!nameStr.trim()) return;
            try{localStorage.setItem('lastSName',nameStr);}catch (e){}
            addScore(nameStr,score,level);Snd.sfxPlay('select',cfg.music);
            _scoreboardCache=getScores();scoresTab=0;phase='scores';showHUD(false);setTimeout(()=>nameInp.blur(),10);
        };
        if(key==='ArrowUp')  {nameCharIdx=(nameCharIdx-1+NAME_CHARS.length)%NAME_CHARS.length;Snd.sfxPlay('nav',cfg.music);}
        else if(key==='ArrowDown'){nameCharIdx=(nameCharIdx+1)%NAME_CHARS.length;Snd.sfxPlay('nav',cfg.music);}
        else if(key==='ArrowLeft'){ _placeName(); if(nameCursorPos>0)nameCursorPos--; _syncDial(); Snd.sfxPlay('nav',cfg.music); }
        else if(key==='ArrowRight'){ _placeName(); if(nameCursorPos<MAX_NAME-1)nameCursorPos++; _syncDial(); Snd.sfxPlay('nav',cfg.music); }
        else if(key==='NameAdd'||key==='Enter'){
            if(NAME_CHARS[nameCharIdx]==='\r'){ _submitName(); }
            else { _placeName(); if(nameCursorPos<MAX_NAME-1)nameCursorPos++; _syncDial(); Snd.sfxPlay('nav',cfg.music); }
        }
        else if(key.length===1&&NAME_CHARS.includes(key.toUpperCase())){
            const ch=key.toUpperCase();
            if(nameCursorPos<nameStr.length) nameStr=nameStr.slice(0,nameCursorPos)+ch+nameStr.slice(nameCursorPos+1);
            else if(nameStr.length<MAX_NAME) nameStr+=ch;
            if(nameCursorPos<MAX_NAME-1)nameCursorPos++; _syncDial(); Snd.sfxPlay('nav',cfg.music);
        }
    }
}

canvas.addEventListener('mousemove', ()=>{ document.body.classList.remove('cursor-hidden'); });

// Swipe/gesture control on game canvas.
// Thresholds (px of finger travel): first move or reverse = SWIPE_1 (16), or SWIPE_N
// (24) while boosting; 90-deg turn = SWIPE_N (24); continue same direction = SWIPE_SAME
// (50), which suppresses accidental boosts.
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
    else if (phase !== 'playing') { handleKey('Enter', null); }
});
canvas.addEventListener('pointerup', e => {
    if (e.pointerType === 'touch') return;
    if (phase === 'splash') { triggerSplashExit(); }
});
canvas.addEventListener('touchstart',  e => { if (phase === 'splash') { _splashFast = true; _splashFastStart = simNow; _splashFastBase = (simNow - phaseAt) / 1000; e.preventDefault(); } }, { passive: false });

const nameInp = document.getElementById('name-inp');
const SWIPE_1=16, SWIPE_N=24, SWIPE_SAME=50, DZ_LO=40, DZ_HI=50, SWIPE_COOLDOWN=40;
function _isOpp(a,b){return(a==='ArrowLeft'&&b==='ArrowRight')||(a==='ArrowRight'&&b==='ArrowLeft')||(a==='ArrowUp'&&b==='ArrowDown')||(a==='ArrowDown'&&b==='ArrowUp');}
let _swipeBase=null, _swipeLastDir=null, _swipeLastMoveAt=0, _swipeLastMovePos=null, _swipeTouchStartAt=0, _swipedThisTouch=false, _menuHDir=null;
canvas.addEventListener('touchstart',e=>{
    //Snd.audioResume();
    e.preventDefault();
    if(phase==='nameEntry'){ nameInp.focus(); }
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
    const thresh=(!_swipeLastDir||_isOpp(key,_swipeLastDir))?(boosting?SWIPE_N:SWIPE_1):key===_swipeLastDir?SWIPE_SAME:SWIPE_N;
    if(dist<thresh) return;
    // Menu (not playing/credits): a LEFT/RIGHT swipe is one full gesture -- remember it and
    // fire a single key on touchend (no repeat while dragging). UP/DOWN falls through and
    // fires live, immediately, as before. _swipeBase is left un-reset so the gesture holds.
    if(phase!=='playing'&&phase!=='credits'&&(key==='ArrowLeft'||key==='ArrowRight')){ _menuHDir=key; return; }
    _swipedThisTouch=true; handleKey(key,null);
    if(phase==='playing'){
        const d=GDIRS[key];
        if(d){
            if(_swipeLastDir&&_isOpp(key,_swipeLastDir)){clearBoost();}
            else if(_swipeLastDir&&key===_swipeLastDir){boostDir=d;boosting=true;boostSince=simTick;}
            else if(!(boosting&&boostDir&&d.x===boostDir.x&&d.y===boostDir.y)){clearBoost();} // first swipe or 90-deg turn: no boost
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
        if(phase!=='playing'&&phase!=='credits'&&phase!=='nameEntry'&&_menuHDir){
            handleKey(_menuHDir,null);
        } else {
            const t=e.changedTouches[0];
            const isTap=Math.hypot(t.clientX-_swipeBase.x,t.clientY-_swipeBase.y)<SWIPE_1&&!_swipeLastDir&&!_swipedThisTouch&&performance.now()-_swipeTouchStartAt>20;
            if(phase!=='playing'&&phase!=='nameEntry'&&(isTap||cfg.touchSelect)) handleKey('Enter',null);
        }
    }
    _swipeBase=null; _swipeLastDir=null; _swipeLastMovePos=null; _menuHDir=null;
    if(phase==='playing'){boostDir=null;boosting=false;}
    if(phase==='credits'){creditsSpeed=_creditsNormal;}
},{passive:false});

// Restore audio on pointer gestures mid-game (background resume, desktop mouse, etc.).
document.addEventListener('pointerdown', () => Snd.audioResume(), {capture:true, passive:true});
document.addEventListener('touchend', () => Snd.audioResume(), {passive:true});
// Pause audio when app goes to background, resume when it returns
function onBgHide() {
    if (phase === 'playing') { phase = 'paused'; pauseAt = simNow; Snd.musicGamePause(); }
    Snd.audioBgSuspend();
}
function onBgShow() { if (cfg.music) Snd.audioResume(); }
document.addEventListener('visibilitychange', () => { if (document.hidden) onBgHide(); else onBgShow(); });
window.addEventListener('blur', onBgHide);
window.addEventListener('focus', onBgShow);
document.addEventListener('keydown', e=>{
    // TV remotes: the "Back" key (webOS 461) AND the RED colour button (403) both act
    // as the in-game Escape (exit shop / back / quit-to-menu), instead of navigating
    // the browser away. RED is the reliable exit when a remote has no usable Back.
    if(e.keyCode===461||e.keyCode===403||e.key==='BrowserBack'||e.key==='GoBack'||e.key==='XF86Back'||e.key==='ColorF0Red'||e.key==='Red'){ e.preventDefault(); handleKey('Escape',null); return; }
    // The BLUE colour button (webOS 406) acts as Space (pause / credits speed / name space).
    if(e.keyCode===406||e.key==='ColorF3Blue'||e.key==='Blue'){ e.preventDefault(); handleKey(' ',null); return; }
    if(e.ctrlKey||e.metaKey||e.altKey) return;   // let browser/OS shortcuts (Ctrl+Shift+R etc.) through
    if(phase==='splash'&&!_splashExiting) _splashKeyHeld = true;
    handleKey(e.key,()=>e.preventDefault());
    if(!e.repeat&&phase==='playing'){const d=GDIRS[e.key];if(d){boostDir=d;boostSince=simTick;boosting=false;}}
    if(phase==='playing') document.body.classList.add('cursor-hidden');   // CSS hides #c cursor; mousemove clears it
});
document.addEventListener('keyup', e=>{
    _splashKeyHeld = false;
    const d=GDIRS[e.key];
    if(d&&boostDir&&d.x===boostDir.x&&d.y===boostDir.y){boostDir=null;boosting=false;}
    if(phase==='credits'&&(e.key==='ArrowDown'||e.key==='ArrowUp'))creditsSpeed=_creditsNormal;
});

// Side buttons
document.getElementById('btn-ok').addEventListener('touchstart',e=>{if(phase==='nameEntry')nameInp.blur();handleKey(phase==='nameEntry'?'NameAdd':'Enter',null);e.preventDefault();},{passive:false});
document.getElementById('btn-ok').addEventListener('click',()=>handleKey(phase==='nameEntry'?'NameAdd':'Enter',null));
document.getElementById('btn-pause').addEventListener('touchstart',e=>{handleKey(' ',null);e.preventDefault();},{passive:false});
document.getElementById('btn-pause').addEventListener('click',()=>handleKey(' ',null));
document.getElementById('btn-start').addEventListener('touchstart',e=>{if(phase==='menu')startGame();else handleKey('Enter',null);e.preventDefault();},{passive:false});
document.getElementById('btn-start').addEventListener('click',()=>{if(phase==='menu')startGame();else handleKey('Enter',null);});
document.getElementById('gamepad').classList.add('splash');
document.getElementById('btn-esc').addEventListener('touchstart',e=>{handleKey('Escape',null);e.preventDefault();},{passive:false});
document.getElementById('btn-esc').addEventListener('click',()=>handleKey('Escape',null));

// Mobile name entry via OS keyboard
nameInp.addEventListener('input', e => {
    if (phase !== 'nameEntry') return;
    if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') {
        handleKey('Escape', null);
        nameInp.value = ''; return;
    }
    const val = nameInp.value.toUpperCase();
    for (const ch of val) {
        if (NAME_CHARS.includes(ch)) { handleKey(ch, null); }
    }
    nameInp.value = '';
});
nameInp.addEventListener('keydown', e => {
    if (phase !== 'nameEntry') return;
    if (e.key === 'Enter') { handleKey('Enter', () => e.preventDefault()); }
    if (e.key === 'Backspace') { e.preventDefault(); handleKey('Escape', null); }
    if (e.key.length === 1) e.preventDefault();
});

// Mute button
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
function toggleMute(){ cfg.music=!cfg.music; if(!cfg.music)Snd.musicStop(); else{Snd.audioResume();Snd.sfxPlay('nav',cfg.music);} updateMuteBtn(); saveCfg(); _uiDirty=true; }
muteBtn.addEventListener('click',toggleMute);
muteBtn.addEventListener('touchstart',e=>{e.preventDefault();toggleMute();},{passive:false});
updateMuteBtn();
