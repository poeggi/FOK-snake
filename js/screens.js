// ============================================================================
// screens.js -- every full-screen SCENE: splash, menu, news, settings (incl. the
// settings/debug item tables that define that screen), scores, achievements,
// shop + mystery-box pages, credits (incl. its text), name entry, the game
// board, the 1:1 duel screens and the confirm dialogs -- plus the menu cache
// and the menuItem widget they share. Draw-only: shop/box BEHAVIOUR lives in
// game.js, entities/overlays/primitives in render.js, typography in text.js.
// Loaded after render.js, before input.js. Shares the global scope.
// ============================================================================
// Shared screen widgets + the main-menu static cache.
// Main-menu static cache: everything except the animated splash text + unread badge.
// Rebuilt only when the visible static content changes (selection, version, diff line).
const _menuCanvas=document.createElement('canvas'); _menuCanvas.width=CW; _menuCanvas.height=CH;
const _menuCtx=_menuCanvas.getContext('2d');
let _mc={sel:-1,ver:'',diff:'',glow:null};
_glowGuard(_menuCtx);
function menuItem(text,y,sel,c=ctx) {
    c.globalAlpha=sel?1:0.78;
    ctg(sel?('> '+text+' <'):text,CW/2,y,sel?'#7fff7f':'#cccccc',FONT.MENU,sel?GLOW.TEXT:GLOW.FAINT,c);
    c.globalAlpha=1;
}
// The ONE in-menu status toaster. Every menu message (matchmaking, invites, cloud backup /
// restore, ...) renders here: a single reserved line one row above BACK (which sits at CH-52),
// the small FONT.HINT, coloured by kind -- red on failure, green on success, amber otherwise.
// The slot stays blank when there is nothing to say, so it reads identically across menus.
const STATUS_Y = CH - 76;
function drawStatus(msg){
    if(!msg) return;
    const col = /FAIL|INVALID|OFFLINE|WRONG|TOO LARGE|NO CLOUD|NO BACKUP|BAD|MISMATCH|BUSY|DESYNC|UNREACHABLE|NOT SUPPORTED|CANNOT|LOST|DECLINE|EXPIRED/i.test(msg) ? '#ff5555'
              : /SAVED|RESTORED|ADDED|ACCEPTED|CONNECTED|READY/i.test(msg) ? '#7fff7f'
              : '#ffaa44';
    ct(msg, CW/2, STATUS_Y, col, FONT.HINT);
}

// ================================================================
// SCREEN RENDERING  (menu / shop / boxes / settings / scores / achievements / credits / news / name-entry)
// ================================================================
function drawSplash(now) {
    // Cycle geometry constants
    const DARK_LEAD = 1.0, DROP = 1.5, ENTER = 0.4, DARK_TAIL = 0.1;
    const CYCLE = DARK_LEAD + DROP + ENTER + 1.0 + DARK_TAIL;
    const T_DROP  = DARK_LEAD;
    const T_ENTER = DARK_LEAD + DROP;
    const T_DONE  = DARK_LEAD + DROP + ENTER;
    const coinX = CW/2, slotY = 292, startY = 162;

    // Background matches menu: grid + scan line overlay
    drawGrid();
    ctx.drawImage(_scanCanvas, 0, 0);

    // Title block: identical to drawMenu
    ctx.shadowColor = '#7fff7f'; ctx.shadowBlur = GLOW.HERO;
    ct('S N A K E', CW/2, 66, '#7fff7f', FONT.DISPLAY);
    ctx.shadowBlur = 0;
    ctg('F O K   E D I T I O N', CW/2, 106, '#4a7a4a', FONT.HINT, GLOW.FAINT);

    // Per-frame coin/spark state
    let showCoin = false, coinY = startY, scaleX = 1, spinAngle = 0;
    let slotFlashF = 0, coinClipped = false;
    let t = 0; // only valid when !_splashExiting; used for INSERT COIN blink

    if (_splashExiting) {
        const exitMs = now - _splashExitAt;
        // Coin snaps into slot over 80ms then disappears below clip rect
        if (exitMs < 80) {
            showCoin = true;
            coinY = (slotY - 14) + 28 * (exitMs / 80);
            scaleX = 1; spinAngle = 0; coinClipped = true;
        }
        // Sparks: fire at 40ms, fade over 420ms
        if (exitMs >= 40) slotFlashF = Math.max(0, 1 - (exitMs - 40) / 420);
    } else {
        const elapsed = _splashFast
            ? _splashFastBase + (now - _splashFastStart) / 1000 * 2
            : (now - phaseAt) / 1000;
        t = elapsed % CYCLE;
        const dropT = t - T_DROP;
        const dropProgress = Math.min(Math.max(dropT, 0), DROP) / DROP;
        spinAngle = dropProgress * 1.5 * Math.PI * 2;
        scaleX = Math.max(0.08, Math.abs(Math.cos(spinAngle)));
        // The idle loop only DROPS the coin; it comes to rest ON the slot. The real
        // insert (snap-in + spark burst) happens exclusively on the button press --
        // see the _splashExiting branch above.
        if (t >= T_DROP) {
            showCoin = true;
            coinY = dropT < DROP
                ? startY + (slotY - startY - 14) * Math.pow(dropT / DROP, 5)
                : slotY - 14;   // resting, waiting for the press
        }
    }

    // Slot housing always drawn
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(coinX - 32, slotY - 9, 64, 18);
    ctx.fillStyle = '#2a2a2a'; ctx.fillRect(coinX - 26, slotY - 6, 52, 12);
    ctx.fillStyle = '#111'; ctx.fillRect(coinX - 16, slotY - 2, 32, 4);

    // Pixelated sparks burst from slot when coin enters
    // spark speed (spd) >= 90 renders bright white; slower sparks render gold
    if (slotFlashF > 0) {
        
        const grav = 55, sp = 1 - slotFlashF;
        ctx.save();
        SPARK_DEFS.forEach(([dx,dy,spd,fade],i) => {
            const sx = coinX + dx*spd*sp;
            const sy = slotY  + dy*spd*sp + grav*sp*sp;
            ctx.globalAlpha = Math.pow(slotFlashF, fade);
            ctx.fillStyle = spd>=90 ? SPARK_BRIGHT[i%SPARK_BRIGHT.length] : SPARK_COLS[i%SPARK_COLS.length];
            ctx.fillRect(Math.round(sx/2)*2, Math.round(sy/2)*2, 2, 2);
        });
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    if (showCoin) {
        ctx.save();
        if (coinClipped) { ctx.beginPath(); ctx.rect(0, 0, CW, slotY); ctx.clip(); }
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath(); ctx.ellipse(coinX+2, coinY+4, 14*scaleX, 4, 0, 0, Math.PI*2); ctx.fill();
        ctx.translate(coinX, coinY);
        ctx.scale(scaleX, 1);
        ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI*2);
        ctx.fillStyle = '#FFD000'; ctx.fill();
        ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI*2);
        ctx.fillStyle = '#1C0600'; ctx.fill();
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 11);
        grad.addColorStop(0,   '#FFE870');
        grad.addColorStop(0.5, '#FFB800');
        grad.addColorStop(1,   '#A06000');
        ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI*2);
        ctx.fillStyle = grad; ctx.fill();
        const sym = Math.cos(spinAngle) >= 0 ? SYM_ONE : SYM_YEN;
        ctx.fillStyle = '#1C0600';
        sym.px.forEach(([ix,iy]) => ctx.fillRect(ix*2 - sym.w, iy*2 - sym.h, 2, 2));
        ctx.restore();
    }

    // INSERT COIN blink and bottom hint: suppressed during exit sequence
    if (!_splashExiting) {
        if (Math.floor(t) % 2 === 1) {
            ctx.shadowColor = '#ffff00'; ctx.shadowBlur = GLOW.TEXT;
            ct('INSERT COIN', CW/2, 344, '#ffff00', FONT.MENU);
            ctx.shadowBlur = 0;
        }
        ctx.save();
        ctx.font = `${FONT.HINT}px "Press Start 2P"`; ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left'; ctx.fillStyle = '#4a7a4a';   // version bottom-left, same spot/style as the menu
        ctx.fillText(_swVersion, 10, CH - 8);
        ctx.textAlign = 'center'; ctx.fillStyle = '#888';
        ctx.fillText('ENTER:go  TAP:go  CLICK:go', CW/2, CH - 8);
        ctx.restore();
    }
}

const _NP_W=30, _NP_H=26, _NP_X=CW-30-20, _NP_Y=CH-26-30;   // newspaper icon rect
// Static newspaper (icon + NEWS label) drawn into the menu cache. No badge here.
function _drawNewspaper(c, sel) {
    const w=_NP_W, h=_NP_H, x=_NP_X, y=_NP_Y;
    c.save();
    if(sel){ c.shadowColor='#ffe08a'; c.shadowBlur=14; }
    c.fillStyle=sel?'#fff8e0':'#d8d2c0'; c.fillRect(x,y,w,h);       // paper
    c.shadowBlur=0;
    c.fillStyle=sel?'#e8dcb0':'#b8b298'; c.fillRect(x+w-4,y+2,4,h-2); // folded edge
    c.fillStyle='#2a2a2a'; c.fillRect(x+3,y+3,w-9,4);               // masthead
    c.fillStyle=sel?'#555':'#777';
    for(let i=0;i<4;i++) c.fillRect(x+3,y+10+i*4,w-16,2);          // text lines
    c.fillStyle=sel?'#888':'#999'; c.fillRect(x+w-11,y+10,8,8);   // photo box
    c.restore();
    c.save();
    c.globalAlpha=sel?1:0.78; c.shadowColor=sel?'#7fff7f':'#cccccc'; c.shadowBlur=sel?12:1;
    c.font=`${FONT.MENU}px "Press Start 2P"`; c.textAlign='right'; c.textBaseline='bottom';
    c.fillStyle=sel?'#7fff7f':'#cccccc'; c.fillText('NEWS', CW-10, CH-8);
    c.restore();
}
// Animated unread badge -- drawn on the live canvas each frame (overlay).
function _drawNewspaperBadge(now, unread) {
    if(!unread) return;
    ctx.save(); ctx.fillStyle='#ff3355'; ctx.shadowColor='#ff3355'; ctx.shadowBlur=8;
    ctx.beginPath(); ctx.arc(_NP_X+_NP_W-2,_NP_Y+1,3.5+Math.sin(now/220),0,Math.PI*2); ctx.fill(); ctx.restore();
}
function _drawNewspaperPage(now) {
    const pw=CW-64, ph=CH-64, px=(CW-pw)/2, py=(CH-ph)/2, cx=CW/2;
    ctx.fillStyle='#e8e2d0'; ctx.fillRect(px,py,pw,ph);              // paper
    ctx.strokeStyle='#2a2a1e'; ctx.lineWidth=2; ctx.strokeRect(px+3,py+3,pw-6,ph-6);
    ctx.fillStyle='#1a1a14';                                        // masthead rules
    ctx.fillRect(px+16,py+22,pw-32,2); ctx.fillRect(px+16,py+58,pw-32,2);
    ct('NEW SNAKE TIMES', cx, py+41, '#141410', FONT.TITLE);
    // Masthead crest: the player's own snake flanks the title, facing inward
    const _logoCol=cfg.snakeColor||0, _logoSi=cfg.wornItems||{}, _logoY=py+40, _logoRx=px+pw-52;
    drawScoreHead(px+52, _logoY, _logoCol, _logoSi);
    ctx.save(); ctx.translate(_logoRx,0); ctx.scale(-1,1); ctx.translate(-_logoRx,0);
    drawScoreHead(_logoRx, _logoY, _logoCol, _logoSi); ctx.restore();
    ct('EXTRA * EXTRA * READ ALL ABOUT IT', cx, py+72, '#6a5f4a', FONT.HINT);
    const pages=(ANNOUNCEMENT&&ANNOUNCEMENT.pages)||[ANNOUNCEMENT||{lines:[]}];
    const a=pages[Math.min(newsPage,pages.length-1)]||{lines:[]};
    ct(a.headline||'', cx, py+108, '#8a1810', FONT.MENU);                  // headline
    let y=py+146;
    (a.lines||[]).forEach(line=>{ if(line===''){ y+=10; return; } ct(line, cx, y, '#2a281e', FONT.HINT); y+=22; });
    if(pages.length>1){                                             // page flipper
        ct('< '+(newsPage+1)+' / '+pages.length+' >', cx, py+ph-20, '#6a5f4a', FONT.HINT);
    }
}
let _newsAt = 0, newsPage = 0;
function drawNews(now) {
    drawGrid(); drawOvBg(0.92);
    const t=Math.min(1,(now-_newsAt)/650);                          // retro spin-and-grow open
    ctx.save();
    ctx.translate(CW/2,CH/2); ctx.rotate((1-t)*Math.PI*4);
    const s=0.05+0.95*t; ctx.scale(s,s); ctx.translate(-CW/2,-CH/2);
    _drawNewspaperPage(now);
    ctx.restore();
    if(t>=1){ const multi=ANNOUNCEMENT&&ANNOUNCEMENT.pages&&ANNOUNCEMENT.pages.length>1;
        ct(multi?'L/R:page   A/ESC:back':'A:back  ESC:back', CW/2, CH-12, '#888', FONT.HINT); }
}
function drawSplashText(now) {
    const txt = (cfg.debug>0) ? 'DEBUG MODE' : _splashText;   // banner doubles as the debug-on indicator
    if(!txt) return;
    ctx.save();
    ctx.translate(CW*0.78, 120); ctx.rotate(-0.34);
    // Pulse off the real frame clock (performance.now), NOT the passed simNow: simNow is
    // quantized to 60Hz sim ticks and the fixed-timestep loop runs 0/1/2 ticks per drawn
    // frame, so it stalls one frame then jumps the next -> visible stutter. Wall-clock is
    // continuous and matches the display cadence, so the pulse is fluent.
    const t = (typeof performance!=='undefined' && performance.now) ? performance.now() : now;
    const s = 1 + 0.04*(1+Math.sin(t/300));   // slow, gentle 1.0..1.08 breathing (pure sine: no cusp, no jump)
    ctx.scale(s, s);
    ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='#3a2a00'; ctx.fillText(txt, 1.5, 1.5);   // retro drop shadow
    ctx.fillStyle= cfg.debug>0 ? '#ff5555' : '#ffff00'; ctx.fillText(txt, 0, 0);
    ctx.restore();
}
// Static menu -> offscreen cache. Everything here changes only on an event.
function _composeMenu(diffLine){
    const c=_menuCtx;
    c.drawImage(_gridCanvas,0,0);
    c.drawImage(_scanCanvas,0,0);
    c.shadowColor='#7fff7f'; c.shadowBlur=GLOW.HERO;
    ct('S N A K E',CW/2,66,'#7fff7f',FONT.DISPLAY,c);
    c.shadowBlur=0;
    ct('F O K   E D I T I O N',CW/2,106,'#4a7a4a',FONT.HINT,c);
    const msp=MENU_ITEMS.length<=5?38:30;
    MENU_ITEMS.forEach((item,i)=>menuItem(item,144+i*msp,i===menuSel,c));
    if(ANNOUNCEMENT) _drawNewspaper(c, menuSel===MENU_ITEMS.length);
    ct(diffLine,CW/2,362,'#4a7a4a',FONT.HINT,c);
    c.save();
    c.font=`${FONT.HINT}px "Press Start 2P"`; c.textBaseline='bottom'; c.shadowBlur=0;
    c.fillStyle='#4a7a4a'; c.textAlign='left';
    c.fillText(_swVersion, 10, CH-8);
    c.fillStyle='#888'; c.textAlign='center';
    c.fillText('UP/DN:nav  A:ok  START:quick', CW/2, CH-8);
    c.restore();
}
function drawMenu(now) {
    const diffLine=`DIFF:${DIFF[cfg.diff].label}  AUDIO:${cfg.music?'ON':'OFF'}  STYLE:${cfg.musicStyle===0?'NEW':'CLASSIC'}`;
    if(menuSel!==_mc.sel || _swVersion!==_mc.ver || diffLine!==_mc.diff || cfg.disableGlow!==_mc.glow){
        _composeMenu(diffLine); _mc.sel=menuSel; _mc.ver=_swVersion; _mc.diff=diffLine; _mc.glow=cfg.disableGlow;
    }
    ctx.drawImage(_menuCanvas,0,0);           // static layer (one blit)
    drawSplashText(now);                       // animated overlay
    if(ANNOUNCEMENT) _drawNewspaperBadge(now, !announceSeen());
}

// Settings are grouped into sub-menus. Each leaf carries a live label plus
// optional act() (Enter), adj(right) (Left/Right), and a render hint (bar/preview).
// Audio leaves keep their exact original Snd.* call sequences -- relocated, not changed.
const SETTINGS_CATS = [
    { label:'USER', items:[
        { lbl:()=>{ let n=''; try{ n=localStorage.getItem('lastSName')||''; }catch(e){} return 'NAME: '+(n||'---'); },
          act:()=>{ let n=''; try{ n=localStorage.getItem('lastSName')||''; }catch(e){} Snd.sfxPlay('select',cfg.music); _entryOpen('user', n); } },
        { lbl:()=>'SHOW MY ID', act:()=>{ Snd.sfxPlay('select',cfg.music); _friendIdBack='settings'; phase='friendId'; } },
    ]},
    { label:'AUDIO', items:[
        { lbl:()=>'AUDIO: '+(cfg.music?'ON':'OFF'),
          act:()=>{cfg.music=!cfg.music;if(!cfg.music)Snd.musicMute('mute');else{Snd.audioResume();Snd.musicUnmute('mute');Snd.sfxPlay('select',cfg.music);}updateMuteBtn();} },
        { lbl:()=>'AUDIO STYLE: '+(cfg.musicStyle===0?'NEW':'CLASSIC'),
          act:()=>{cfg.musicStyle=(cfg.musicStyle+1)%2;Snd.musicStop();Snd.sfxPlay('select',cfg.music);} },
        { lbl:()=>'VOLUME: '+Math.round(((cfg.volume==null?1:cfg.volume))*100)+'%', bar:'#7fff7f', frac:()=>(cfg.volume==null?1:cfg.volume),
          adj:(r)=>{cfg.volume=Math.max(0,Math.min(1,Math.round((((cfg.volume==null?1:cfg.volume))+(r?0.1:-0.1))*10)/10));Snd.musicSetVolume(cfg.volume);} },
        { lbl:()=>'SFX VOL: '+Math.round(((cfg.sfxVol==null?0.5:cfg.sfxVol))*100)+'%', bar:'#aaddff', frac:()=>(cfg.sfxVol==null?0.5:cfg.sfxVol),
          adj:(r)=>{cfg.sfxVol=Math.max(0,Math.min(1,Math.round((((cfg.sfxVol==null?0.5:cfg.sfxVol))+(r?0.1:-0.1))*10)/10));Snd.sfxSetVolume(cfg.sfxVol);} },
    ]},
    { label:'CONTROLS', items:[
        { lbl:()=>'TURBO BOOST: '+(cfg.turbo!==false?'ON':'OFF'),
          act:()=>{cfg.turbo=cfg.turbo===false?true:false;Snd.sfxPlay('select',cfg.music);} },
        { lbl:()=>'LAYOUT: '+(cfg.handed?'LEFT':'RIGHT'),
          act:()=>{cfg.handed=(cfg.handed+1)%2;applyHandedness();Snd.sfxPlay('select',cfg.music);},
          adj:(r)=>{cfg.handed=r?1:0;applyHandedness();} },
        { lbl:()=>'TOUCH AUTOSELECT: '+(cfg.touchSelect?'ON':'OFF'),
          act:()=>{cfg.touchSelect=!cfg.touchSelect;Snd.sfxPlay('select',cfg.music);} },
    ]},
    { label:'GAME', items:[
        { lbl:()=>'DIFFICULTY: '+DIFF[cfg.diff].label,
          act:()=>{cfg.diff=(cfg.diff+1)%DIFF.length;Snd.sfxPlay('select',cfg.music);} },
        { lbl:()=>'SNAKE COLOR: '+SNAKE_COLORS[cfg.snakeColor||0].name, preview:'color',
          act:()=>{cfg.snakeColor=(cfg.snakeColor+1)%SNAKE_COLORS.length;Snd.sfxPlay('select',cfg.music);},
          adj:(r)=>{cfg.snakeColor=(cfg.snakeColor+(r?1:-1)+SNAKE_COLORS.length)%SNAKE_COLORS.length;} },
    ]},
    { label:'GRAPHICS', items:[
        { lbl:()=>'LIMIT 30 FPS: '+(cfg.fps30?'ON':'OFF'),
          act:()=>{cfg.fps30=!cfg.fps30;Snd.sfxPlay('select',cfg.music);} },
        { lbl:()=>'DISABLE GLOW: '+(cfg.disableGlow?'ON':'OFF'),
          act:()=>{cfg.disableGlow=!cfg.disableGlow;Snd.sfxPlay('select',cfg.music);} },
    ]},
    { label:'NETWORK', items:[
        { lbl:()=>'STRICTLY OFFLINE: '+(cfg.offline?'ON':'OFF'),
          act:()=>{cfg.offline=!cfg.offline;Snd.sfxPlay('select',cfg.music);if(cfg.offline&&typeof netOfflineClear==='function')netOfflineClear();} },
        { lbl:()=>'RELAY ONLY (NO P2P): '+(cfg.noP2P?'ON':'OFF'),
          act:()=>{cfg.noP2P=!cfg.noP2P;Snd.sfxPlay('select',cfg.music);} },
        { lbl:()=>'HIDE REMOTE COSMETICS: '+(cfg.noRemoteCosmetics?'ON':'OFF'),
          act:()=>{cfg.noRemoteCosmetics=!cfg.noRemoteCosmetics;Snd.sfxPlay('select',cfg.music);} },
    ]},
    { label:'DATA', items:[
        { lbl:()=>'BACKUP CONFIG TO FILE', act:()=>{Snd.sfxPlay('select',cfg.music);backupStats();} },
        { lbl:()=>'RESTORE CONFIG FROM FILE', act:()=>{Snd.sfxPlay('select',cfg.music);restoreStats();} },
        { lbl:()=>'BACKUP CONFIG TO CLOUD', act:()=>{Snd.sfxPlay('select',cfg.music);cloudBackup();} },
        { lbl:()=>'RESTORE CONFIG FROM CLOUD', act:()=>{Snd.sfxPlay('select',cfg.music);cloudRestore();} },
        { lbl:()=>'AUTO CLOUD BACKUP: '+(cfg.autoCloud?'ON':'OFF'),
          act:()=>{cfg.autoCloud=!cfg.autoCloud;saveCfg();Snd.sfxPlay('select',cfg.music);if(cfg.autoCloud&&typeof _maybeAutoCloudBackup==='function')_maybeAutoCloudBackup();} },
        { lbl:()=>'RESET STATS', act:()=>{_resetKind='stats';quitConfirmSel=1;phase='resetConfirm';} },
        { lbl:()=>'RESET SETTINGS', act:()=>{_resetKind='settings';quitConfirmSel=1;phase='resetConfirm';} },
        { lbl:()=>'RESET ID', act:()=>{_resetKind='id';quitConfirmSel=1;phase='resetConfirm';} },
    ]},
];
// Hidden DEBUGGING category: only present when cfg.debug > 0. cfg.debug is NOT settable
// from the normal menus -- you raise it by hand-editing the save file (it rides in the
// backup). Level: 1 = this menu; 2 = in-game corner overlays; 3 = the clickable snapshot capture.
// cfg.debug guards ENTRY to the DEBUGGING menu; _debugEntered keeps it visible while you
// are inside it, so dialling the level to 0 shows 0 but doesn't kick you out -- the 0
// takes effect only when you leave the category (or reload).
let _debugEntered = false;
const DEBUG_CAT = { label:'DEBUGGING', items:[
    { lbl:()=>'DEBUG LEVEL: '+(cfg.debug||0),
      act:()=>{ cfg.debug=((cfg.debug||0)+1)%4; requestAnimationFrame(layout); Snd.sfxPlay('select',cfg.music); },   // level 2+ shows the on-canvas overlays
      adj:(r)=>{ cfg.debug=Math.max(0,Math.min(3,(cfg.debug||0)+(r?1:-1))); requestAnimationFrame(layout); } },
    { lbl:()=>'EXPORT DEBUG INFO', act:()=>{ Snd.sfxPlay('select',cfg.music); exportDebugInfo(); } },
    { lbl:()=>'X10 RARE EVENTS: '+(cfg.x10?'ON':'OFF'),
      act:()=>{ cfg.x10=!cfg.x10; Snd.sfxPlay('select',cfg.music); } },   // persisted: the settings handler saveCfg()s after act (also resends the worker cfg)
    { lbl:()=>'SEND DEBUG SNAPSHOT'+(_dbgSnap?(_dbgPin?' (PIN '+_dbgPin+')':''):' (CAPTURE FIRST)'),
      act:()=>{ Snd.sfxPlay('select',cfg.music); sendDebugSnapshot(); } },
    { lbl:()=>'MAKE ME RICH (+1BN FOK)', act:()=>{ addFOKoins(1000000000); Snd.sfxPlay('perfect',cfg.music); _dataMsg='+1,000,000,000 FK'; _dataMsgAt=simNow; } },
    { lbl:()=>'LOW-FPS RECORD: '+(_fpsRec?'ON':'OFF'),
      act:()=>{ _fpsRec=!_fpsRec; if(_fpsRec) _fpsRecReset(); else { try{ fpsEl.style.color=''; }catch(e){} } Snd.sfxPlay('select',cfg.music); } },
    { lbl:()=>'WORST '+(_fpsSnap?(_fpsSnap.fps+'fps@'+_fpsSnap.phase):'--')+'  MAX '+(_fpsMaxAvg||'--'),
      act:()=>{ Snd.sfxPlay('nav',cfg.music); } },
    { lbl:()=>'EXPORT FPS LOG', act:()=>{ Snd.sfxPlay('select',cfg.music); exportFpsLog(); } },
] };
function _cats(){ return (cfg.debug>0 || _debugEntered) ? SETTINGS_CATS.concat([DEBUG_CAT]) : SETTINGS_CATS; }
function _settingsList(){ return settingsCat>=0 ? _cats()[settingsCat].items : _cats(); }
function drawSettings() {
    drawGrid(); drawOvBg(0.92);
    const inCat=settingsCat>=0;
    const title=inCat?'SETTINGS/'+_cats()[settingsCat].label:'SETTINGS';
    ctg(title,CW/2,24,'#7fff7f',FONT.TITLE, GLOW.TITLE);
    const list=_settingsList();
    const startY=90, rowH=28;   // one empty line below the headline before the first entry
    list.forEach((it,i)=>menuItem(inCat?it.lbl():it.label, startY+i*rowH, i===settingsSel));
    menuItem('BACK', CH-52, settingsSel===list.length);   // BACK aligned toward the bottom
    if(inCat){
        const it=list[settingsSel];
        // Volume bar under the selected slider row
        if(it&&it.bar){
            const py=startY+settingsSel*rowH, bx=CW/2-55, bw=110;
            ctx.fillStyle='#1a2a1a'; ctx.fillRect(bx,py+10,bw,5);
            ctx.fillStyle=it.bar; ctx.fillRect(bx,py+10,Math.round(bw*it.frac()),5);
        }
        // Snake-color mini-preview beside the selected row
        if(it&&it.preview==='color'){
            const sc=SNAKE_COLORS[cfg.snakeColor||0], py=startY+settingsSel*rowH;
            ctx.save(); ctx.font=`${FONT.MENU}px "Press Start 2P"`;
            const tw=ctx.measureText('> '+it.lbl()+' <').width;
            const px=Math.round(CW/2+tw/2+12);
            for(let k=0;k<5;k++){
                const frac=1-k/5, l=Math.round(10+frac*40);
                ctx.fillStyle=k===0?sc.head:`hsl(${sc.h},65%,${l}%)`;
                ctx.shadowColor=k===0?sc.head:'transparent'; ctx.shadowBlur=k===0?6:0;
                ctx.fillRect(px+k*7,py-5,6,10);
            }
            ctx.restore();
        }
        // Transient status line in the DATA / DEBUGGING menus (via the shared toaster)
        const _cl=_cats()[settingsCat] && _cats()[settingsCat].label;
        if(_cl==='DATA'||_cl==='DEBUGGING'){
            if(_dbgPinShow && _dbgPin) drawStatus('DEBUG PIN '+_dbgPin);   // held until the user moves (see settings nav)
            else if(_dataMsg && simNow-_dataMsgAt<2500) drawStatus(_dataMsg);
        }
    }
    const hint=inCat?'UP/DN:nav  L/R:change  A:select  ESC:back':'UP/DN:nav  A:open  ESC:back';
    ct(hint,CW/2,CH-10,'#888',FONT.HINT);
}

function _drawScoreTabs(){
    const labels=['LOCAL','GLOBAL'];
    const hi=['#7fff7f','#ffd24a'], fill=['rgba(28,60,20,0.85)','rgba(60,48,16,0.85)'], txt=['#bfffbf','#ffe9b0'];
    const m=6, tabH=20, tabY=44, tabW=(CW-2*m)/labels.length;
    for(let i=0;i<labels.length;i++){
        const tx=m+i*tabW, active=(i===scoresTab);
        ctx.fillStyle=active?fill[i]:'rgba(16,16,16,0.6)';
        rr(tx+2,tabY,tabW-4,tabH,4); ctx.fill();
        ctx.lineWidth=active?2:1; ctx.strokeStyle=active?hi[i]:'#3a3a3a';
        if(active){ ctx.shadowColor=hi[i]; ctx.shadowBlur=8; }
        rr(tx+2,tabY,tabW-4,tabH,4); ctx.stroke(); ctx.shadowBlur=0;
        ct(labels[i], tx+tabW/2, tabY+tabH/2+1, active?txt[i]:'#666666', FONT.HINT);
    }
}
function drawScores() {
    drawGrid(); drawOvBg(0.92);
    ctg('HIGH SCORES',CW/2,28,'#7fff7f',FONT.TITLE, GLOW.TITLE);
    _drawScoreTabs();
    if(scoresTab===1){
        if(cfg.offline){
            ct('GLOBAL SCORES',CW/2,CH/2-14,'#ffd24a',FONT.MENU);
            ct('DISABLED IN OFFLINE MODE (SETTINGS > NETWORK)',CW/2,CH/2+12,'#aaa',FONT.HINT);
        } else {
            if(typeof netFetchScores==='function') netFetchScores();   // cached 60s, single-flight
            const gs=(typeof _netScores!=='undefined')?_netScores:null;
            if(!gs && typeof _netScoresLoading!=='undefined' && _netScoresLoading){
                ct('LOADING GLOBAL SCORES...',CW/2,CH/2,'#aaa',FONT.HINT);
            } else if(!gs){
                ct('SERVER UNREACHABLE',CW/2,CH/2-14,'#ff8888',FONT.MENU);
                ct('GLOBAL SCORES NEED A CONNECTION',CW/2,CH/2+12,'#aaa',FONT.HINT);
            } else if(!gs.length){
                ct('NO GLOBAL SCORES YET - BE THE FIRST!',CW/2,CH/2,'#aaa',FONT.HINT);
            } else {
                ctx.font=`${FONT.MENU}px "Press Start 2P"`; ctx.textBaseline='middle';
                gs.slice(0,8).forEach((s,i)=>{
                    const y=90+i*28;
                    ctx.fillStyle=i===0?'#ffd700':i<3?'#dddddd':'#aaaaaa';
                    const diff=['E','N','H'][s.diff==null?1:s.diff]||'N';
                    ctx.textAlign='left';  ctx.fillText(String(s.name||'???').slice(0,MAX_NAME), 24, y);
                    ctx.textAlign='right'; ctx.fillText(String(s.score|0), 348, y);
                    ctx.textAlign='left';  ctx.fillText(`${diff}/${s.level|0}`, 360, y);
                    ctx.textAlign='left';  ctx.fillText(String(s.date||'--.--.--').slice(0,8), 418, y);
                    drawScoreHead(568, y, (s.color|0)%SNAKE_COLORS.length, (s.shopItems&&typeof s.shopItems==='object')?s.shopItems:{});
                });
                ctx.textAlign='center';
            }
        }
        ct('L/R:tab   A/ESC:back',CW/2,CH-14,'#888',FONT.HINT);
        return;
    }
    const scores=_scoreboardCache||[];
    if(!scores.length){ ct('No scores yet!',CW/2,CH/2,'#aaa',FONT.HINT); }
    else {
        ctx.font=`${FONT.MENU}px "Press Start 2P"`; ctx.textBaseline='middle';
        scores.slice(0,8).forEach((s,i)=>{
            const y=90+i*28;
            ctx.fillStyle=i===0?'#ffd700':i<3?'#dddddd':'#aaaaaa';
            const diff=['E','N','H'][s.diff==null?1:s.diff]||'N';
            ctx.textAlign='left';  ctx.fillText(String(s.name||'???').slice(0,MAX_NAME), 24, y);
            ctx.textAlign='right'; ctx.fillText(String(s.score), 348, y);
            ctx.textAlign='left';  ctx.fillText(`${diff}/${s.level}`, 360, y);
            ctx.textAlign='left';  ctx.fillText(s.date||'--.--.--', 418, y);
            drawScoreHead(568, y, s.color||0, s.shopItems||{});
        });
        ctx.textAlign='center';
    }
    ct('L/R:tab   A/ESC:back',CW/2,CH-14,'#888',FONT.HINT);
}

const _achWrap={};   // per-achievement wrapped desc lines (static text, fixed font)
function drawAchievements() {
    drawGrid(); drawOvBg(0.92);
    const donated=!!(cfg.shopItems&&cfg.shopItems['donate']);
    const allBase=ACHIEVEMENTS.every(a=>achUnlocked[a.id]);
    const expert=donated&&allBase;
    const onExpert=expert&&achPage===0;
    const list=onExpert?EXPERT_ACHIEVEMENTS:ACHIEVEMENTS;
    const titleColor=onExpert?'#ff8800':'#7fff7f';
    ctg('ACHIEVEMENTS',CW/2,28,titleColor,FONT.TITLE, GLOW.TITLE);
    if(expert){
        ct(onExpert?'< EXPERT  1/2 >':'< BASE  2/2 >',CW/2,42,onExpert?'#ffaa44':'#7fff7f',FONT.HINT);
    } else if(allBase&&!donated){
        ct('DONATE in SHOP to unlock EXPERT page',CW/2,42,'#ff4488',FONT.HINT);
    }
    const cols=3, aw=188, ah=68, gx=4, gy=4;
    const ox=(CW-(cols*aw+(cols-1)*gx))/2;
    const oy=expert?54:64;
    list.forEach((a,i)=>{
        const col=i%cols, row=Math.floor(i/cols);
        const x=ox+col*(aw+gx), y=oy+row*(ah+gy);
        const got=!!achUnlocked[a.id];
        ctx.fillStyle=got?'rgba(0,60,0,0.28)':'rgba(10,10,10,0.28)';
        rr(x,y,aw,ah,4); ctx.fill();
        ctx.strokeStyle=got?'#4a8a4a':'#444444'; ctx.lineWidth=got?2:1;
        rr(x,y,aw,ah,4); ctx.stroke();
        ctx.save();
        if(!got) ctx.globalAlpha=0.35;
        drawPixelIcon(x+5,y+ah/2-9,a.icon,2);
        ctx.restore();
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.font=`${FONT.HINT}px "Press Start 2P"`;
        ctx.fillStyle=got?'#7fff7f':'#888888';
        ctx.fillText(a.name,x+26,y+10);
        ctx.font=`${FONT.HINT}px "Press Start 2P"`;
        ctx.fillStyle=got?'#6aaa6a':'#777777';
        // Descriptions are static strings in a fixed font: wrap once, not per draw.
        let _wr=_achWrap[a.id];
        if(!_wr){
            const _mw=aw-32; let _d1=a.desc,_d2='';
            if(ctx.measureText(_d1).width>_mw){
                const _ws=a.desc.split(' '); let _l='';
                for(const _w of _ws){const _t=_l?_l+' '+_w:_w;if(ctx.measureText(_t).width<=_mw)_l=_t;else{_d2=a.desc.slice(_l.length+1);break;}}_d1=_l;
            }
            _achWrap[a.id]=_wr=[_d1,_d2];
        }
        ctx.fillText(_wr[0],x+26,y+28);
        if(_wr[1]) ctx.fillText(_wr[1],x+26,y+42);
    });
    ctx.textAlign='center'; ctx.textBaseline='middle';
    const total=list.filter(a=>achUnlocked[a.id]).length;
    ctg(`${total} / ${list.length} UNLOCKED`,CW/2,CH-26,'#6aaa6a',FONT.HINT, GLOW.FAINT);
    const hint='A:back';
    ct(hint,CW/2,CH-10,'#888',FONT.HINT);
}

function _drawBoxIcon(x,y,box,s){
    ctx.save();
    ctx.fillStyle=box.color; ctx.fillRect(x-1,y+s*0.26,s+2,s*0.2);       // lid
    ctx.fillStyle=box.color; ctx.fillRect(x,y+s*0.42,s,s*0.55);          // body
    ctx.fillStyle='rgba(255,255,255,0.28)'; ctx.fillRect(x,y+s*0.26,s+1,s*0.06);
    ctx.strokeStyle='rgba(0,0,0,0.45)'; ctx.lineWidth=1; ctx.strokeRect(x,y+s*0.42,s,s*0.55);
    ctx.fillStyle='#ffd700'; ctx.fillRect(x+s/2-2,y+s*0.5,4,4);          // lock
    ctx.fillStyle='#ffffff'; ctx.font=Math.round(s*0.42)+'px "Press Start 2P"'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('?',x+s/2,y+s*0.72);
    ctx.restore();
}
function _drawBoxesPage(){
    const coins=_cachedFOKoins, startY=72, rowH=52, boxes=_boxList();
    if(shopSel>=boxes.length) shopSel=boxes.length-1;   // keep a row selected after the ADMIN box is claimed
    boxes.forEach((box,i)=>{
        const y=startY+i*rowH, sel=i===shopSel, isAdmin=box.id==='admin';
        const canAfford=isAdmin||coins>=box.price, bc=isAdmin?'#ffd700':box.color;
        ctx.fillStyle=sel?(isAdmin?'rgba(60,42,10,0.75)':'rgba(45,45,45,0.7)'):(isAdmin?'rgba(40,26,6,0.5)':'rgba(10,10,10,0.35)');
        rr(8,y,CW-16,rowH-6,5); ctx.fill();
        if(isAdmin){ ctx.shadowColor='#ffd700'; ctx.shadowBlur=sel?14:8; }
        ctx.strokeStyle=sel?bc:(isAdmin?'#caa100':'#3a3a3a'); ctx.lineWidth=sel?2:(isAdmin?1.8:1.2); rr(8,y,CW-16,rowH-6,5); ctx.stroke();
        ctx.shadowBlur=0;
        _drawBoxIcon(18,y+8,box,28);
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.font=`${FONT.MENU}px "Press Start 2P"`; ctx.fillStyle=bc; ctx.fillText(box.name+' BOX',60,y+10);
        ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=isAdmin?'#ffcf55':'#999999';
        ctx.fillText(isAdmin?'GRAND PRIZE - guaranteed ADMIN CROWN':'Rarer loot at higher tiers',60,y+28);
        ctx.textAlign='right';
        ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=isAdmin?'#5aff8a':(canAfford?'#ffd700':'#553322');
        ctx.fillText(isAdmin?'FREE':box.price.toLocaleString()+' FK',CW-18,y+11);
        if(sel){ ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=canAfford?'#5aaa5a':'#cc6644';
            ctx.fillText(canAfford?(isAdmin?'ENTER to claim':'ENTER to open'):'Not enough FK',CW-18,y+29); }
    });
}
// Owned box-exclusive cosmetics, wearable here (they don't fit the buyable cosmetics tabs).
function _drawGearPage(){
    const wi=cfg.wornItems||{}, gear=_gearList();
    if(!gear.length){
        ct('NO BOX GEAR YET',CW/2,CH/2-16,'#888888',FONT.MENU);
        ct('Win exclusive cosmetics from Mystery Boxes',CW/2,CH/2+10,'#9b6ad0',FONT.HINT);
        return;
    }
    const startY=72, rowH=44;
    gear.forEach((item,i)=>{
        const y=startY+i*rowH, sel=i===shopSel, worn=!!wi[item.id], rc=RARITY_COLS[item.rarity]||'#7fff7f';
        ctx.fillStyle=worn?(sel?'rgba(40,64,40,0.7)':'rgba(20,48,20,0.5)'):(sel?'rgba(20,40,55,0.7)':'rgba(10,25,40,0.5)');
        rr(8,y,CW-16,rowH-4,5); ctx.fill();
        ctx.strokeStyle=worn?'#7fff7f':rc; ctx.lineWidth=1.5; rr(8,y,CW-16,rowH-4,5); ctx.stroke();
        drawPixelIcon(16,y+(rowH-4)/2-8,item.icon,2);
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=worn?'#7fff7f':'#dddddd'; ctx.fillText(item.name,46,y+7);
        ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=rc; ctx.fillText((item.rarity||'').toUpperCase()+' - BOX EXCLUSIVE',46,y+21);
        ctx.textAlign='right';
        ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=worn?'#7fff7f':'#4a7a9a'; ctx.fillText(worn?'WORN':'OWNED',CW-18,y+9);
        if(sel){ ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=worn?'#cc5555':'#5aaa5a'; ctx.fillText(worn?'SPACE to remove':'SPACE to wear',CW-18,y+23); }
    });
    ctx.textAlign='center'; ctx.textBaseline='middle';
}
// Buy + open a box: deduct, roll, grant (item / dupe-sell / coins), trigger reveal.
function _drawBoxReveal(){
    const age=simNow-_boxOpenAt;
    if(!(_boxOpenAt>0 && age<2400 && _boxReward)) return;
    if(age<220){ ctx.save(); ctx.globalAlpha=(1-age/220)*0.55; ctx.fillStyle='#ffe860'; ctx.fillRect(0,0,CW,CH); ctx.restore(); }
    const fade=age<150?age/150:age>2000?Math.max(0,1-(age-2000)/400):1;
    ctx.save(); ctx.globalAlpha=fade; drawOvBg(0.55);
    const r=_boxReward;
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=GLOW.TITLE;
    if(r.kind==='coins'){ ct('YOU GOT',CW/2,CH/2-18,'#aaa',FONT.HINT); ct('+'+r.amount.toLocaleString()+' FK',CW/2,CH/2+8,'#ffd700',FONT.TITLE); }
    else if(r.kind==='dupe'){ const dit=_findItem(r.id), drc=RARITY_COLS[r.rarity]||'#aaaaaa';
        if(dit&&dit.icon) drawPixelIcon(CW/2-16,CH/2-52,dit.icon,4);
        ct(dit?dit.name:r.id,CW/2,CH/2+2,'#ffffff',FONT.MENU);
        ct('DUPLICATE',CW/2,CH/2+22,drc,FONT.HINT);
        ct('SOLD +'+r.refund.toLocaleString()+' FK',CW/2,CH/2+40,'#ffd700',FONT.HINT); }
    else { const it=_findItem(r.id), rc=RARITY_COLS[r.rarity]||'#fff';
        if(it&&it.icon) drawPixelIcon(CW/2-16,CH/2-46,it.icon,4);
        ct((r.rarity||'').toUpperCase(),CW/2,CH/2+10,rc,FONT.HINT);
        ct(it?it.name:r.id,CW/2,CH/2+30,'#ffffff',FONT.MENU); }
    ctx.shadowBlur=0; ctx.restore();
}
// Retro tab strip: all four shop pages visible at once, active one lit.
function _drawShopTabs(){
    const labels=['COSMETICS 1','COSMETICS 2','BOX GEAR','MYSTERY BOXES'];
    const hi   =['#7fff7f','#7fff7f','#4ad0ff','#c48af0'];
    const fill =['rgba(28,60,20,0.85)','rgba(28,60,20,0.85)','rgba(16,44,60,0.85)','rgba(68,40,96,0.85)'];
    const txt  =['#bfffbf','#bfffbf','#bfe8ff','#e6c0ff'];
    const m=6, tabH=20, tabY=42, tabW=(CW-2*m)/labels.length;
    for(let i=0;i<labels.length;i++){
        const tx=m+i*tabW, active=(i===shopPage);
        ctx.fillStyle=active?fill[i]:'rgba(16,16,16,0.6)';
        rr(tx+2,tabY,tabW-4,tabH,4); ctx.fill();
        ctx.lineWidth=active?2:1; ctx.strokeStyle=active?hi[i]:'#3a3a3a';
        if(active){ ctx.shadowColor=hi[i]; ctx.shadowBlur=8; }
        rr(tx+2,tabY,tabW-4,tabH,4); ctx.stroke(); ctx.shadowBlur=0;
        ct(labels[i], tx+tabW/2, tabY+tabH/2+1, active?txt[i]:'#666666', FONT.HINT);
    }
}
function drawShop() {
    drawGrid(); drawOvBg(0.92);
    ctg('SHOP',CW/2,26,'#ffd700',FONT.TITLE, GLOW.TITLE);
    _drawShopTabs();
    const coins=_cachedFOKoins;
    if(shopPage===BOX_PAGE){ _drawBoxesPage(); }
    else if(shopPage===GEAR_PAGE){ _drawGearPage(); }
    else {
    const si=cfg.shopItems||{}, wi=cfg.wornItems||{};
    const items=SHOP_ITEMS.filter(it=>(it.page||0)===shopPage);
    const startY=72, rowH=44;
    items.forEach((item,i)=>{
        const y=startY+i*rowH, sel=i===shopSel;
        const isRep=!!item.repeatable;
        const owned=!!si[item.id], worn=!isRep&&owned&&!!wi[item.id], canAfford=coins>=item.price;
        ctx.fillStyle=worn?(sel?'rgba(40,64,40,0.7)':'rgba(20,48,20,0.5)'):
                      (owned&&isRep)?(sel?'rgba(64,10,35,0.7)':'rgba(40,5,20,0.5)'):
                      owned?(sel?'rgba(20,40,55,0.7)':'rgba(10,25,40,0.5)'):
                      (sel?'rgba(40,64,40,0.55)':'rgba(10,10,10,0.3)');
        rr(8,y,CW-16,rowH-4,5); ctx.fill();
        if(worn||owned||sel){ctx.strokeStyle=worn?'#7fff7f':(owned&&isRep)?'#cc4488':owned?'#4a7a9a':'#6aaa6a';ctx.lineWidth=1.5;rr(8,y,CW-16,rowH-4,5);ctx.stroke();}
        drawPixelIcon(16,y+(rowH-4)/2-8,item.icon,2);
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.font=`${FONT.HINT}px "Press Start 2P"`;
        ctx.fillStyle=worn?'#7fff7f':(owned&&isRep)?'#ff66aa':owned?'#5a8aaa':sel?'#dddddd':'#aaaaaa';
        ctx.fillText(item.name,46,y+7);
        ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle='#999999';
        ctx.fillText(item.desc,46,y+21);
        ctx.textAlign='right';
        if(isRep){
            if(owned){ctx.font=`${FONT.HINT}px "Press Start 2P"`;ctx.fillStyle='#ff44aa';ctx.fillText('DONATED',CW-18,y+9);}
            else{ctx.font=`${FONT.HINT}px "Press Start 2P"`;ctx.fillStyle=canAfford?'#ffd700':'#553322';ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+9);}
            ctx.font=`${FONT.HINT}px "Press Start 2P"`;
            if(sel){ctx.fillStyle=canAfford?'#5aaa5a':'#cc6644';ctx.fillText(canAfford?'ENTER to donate':'Not enough FK',CW-18,y+23);}
            else if(owned){ctx.fillStyle='#555';ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+23);}
        } else if(owned){
            ctx.font=`${FONT.HINT}px "Press Start 2P"`;
            ctx.fillStyle=worn?'#7fff7f':'#4a7a9a';
            ctx.fillText(worn?'WORN':'OWNED',CW-18,y+9);
            ctx.font=`${FONT.HINT}px "Press Start 2P"`;
            if(sel){ctx.fillStyle=worn?'#cc5555':'#5aaa5a';ctx.fillText(worn?'SPACE to remove':'SPACE to wear',CW-18,y+23);}
            else{ctx.fillStyle='#555';ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+23);}
        } else {
            ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=canAfford?'#ffd700':'#553322';
            ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+9);
            if(sel){ctx.font=`${FONT.HINT}px "Press Start 2P"`;ctx.fillStyle=canAfford?'#5aaa5a':'#cc6644';
                ctx.fillText(canAfford?'ENTER to buy':'Not enough FK',CW-18,y+23);}
        }
    });
    }
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=6;
    ct(`BALANCE: ${coins.toLocaleString()} FK`,CW/2,CH-30,'#ffd700',FONT.HINT);
    ctx.shadowBlur=0;
    ct(shopPage===BOX_PAGE ? 'UP/DN:nav  L/R:tab  A:open  ESC:back'
       : shopPage===GEAR_PAGE ? 'UP/DN:nav  L/R:tab  A/||:wear  ESC:back'
       : 'UP/DN:nav  L/R:tab  A:buy  ||:wear  ESC:back',CW/2,CH-12,'#888',FONT.HINT);
    // Purchase particles
    const now=simNow;
    purchaseParticles=purchaseParticles.filter(p=>{
        p.life++;p.x+=p.vx;p.y+=p.vy;p.vy+=0.09;p.rot+=p.vrot;
        if(p.life>=p.maxLife||p.y>CH+20) return false;
        const a=p.life<10?p.life/10:p.life>p.maxLife-15?1-(p.life-(p.maxLife-15))/15:1;
        ctx.save();ctx.globalAlpha=a;ctx.translate(p.x,p.y);ctx.rotate(p.rot);
        ctx.fillStyle=p.color;ctx.fillRect(-p.size/2,-p.size/2,p.size,p.size);
        ctx.restore();return true;
    });
    // "PURCHASED!" flash
    const buyAge=now-purchaseAnimAt;
    if(purchaseAnimAt>0&&buyAge<1600){
        const a=buyAge<180?buyAge/180:buyAge>1200?1-(buyAge-1200)/400:1;
        ctx.save();ctx.globalAlpha=a;
        ctx.shadowColor='#7fff7f';ctx.shadowBlur=GLOW.TITLE;
        ct('PURCHASED!',CW/2,CH/2+20,'#7fff7f',FONT.TITLE);
        ctx.restore();
    }
    _drawBoxReveal();
}

// ================================================================
// CREDITS DATA
// ================================================================

function credTotalH() { let h=0; for(const[t,v] of CRED) h += t==='gap' ? v : (CRED_H[t]||22); return h; }
const CRED_TOTAL_H = credTotalH();

function drawCredits() {
    drawGrid(); drawOvBg(0.93);
    ctx.save(); ctx.beginPath(); ctx.rect(0,0,CW,CH-24); ctx.clip();
    let y = creditsScroll;
    for (const [type, val] of CRED) {
        if (type === 'gap') { y += val; continue; }
        const h = CRED_H[type] || 22;
        const yc = y + h/2;
        if (y > -50 && y < CH + 20) {
            switch (type) {
                case 'title':
                                        ctg(val, CW/2, yc, '#7fff7f', FONT.DISPLAY, GLOW.HERO); break;
                case 'sub':
                    ct(val, CW/2, yc, '#4a7a4a', FONT.HINT); break;
                case 'hdr':
                                        ctg(val, CW/2, yc, '#00cccc', FONT.MENU, GLOW.FAINT); break;
                case 'txt':
                    ct(val, CW/2, yc, '#aaa', FONT.MENU); break;
                case 'sml':
                    ct(val, CW/2, yc, '#999', FONT.MENU); break;
                case 'coins':
                    ctx.shadowColor='#ffd700'; ctx.shadowBlur=6;
                    ct(`YOUR FOKOINS: ${_cachedFOKoins.toLocaleString()}`, CW/2, yc, '#ffd700', FONT.MENU);
                    ctx.shadowBlur=0; break;
                case 'secret':
                    ctx.shadowColor='#ff4444'; ctx.shadowBlur=14;
                    ct(val, CW/2, yc, '#ff5555', FONT.MENU);
                    ctx.shadowBlur=0; break;
            }
        }
        y += h;
    }
    ctx.restore();
    creditsScroll -= creditsSpeed;
    if (creditsScroll < -CRED_TOTAL_H) creditsScroll = CH + 40;  // loop
    ct('UP:slow  DN:fast  ||:pause  A:exit', CW/2, CH-12, '#888', FONT.HINT);
}

function drawNameEntry(now) {
    const chars=_entryChars(), max=_entryMax();
    if(entryMode==='score'){
        drawGrid();
        if(bars)  { _prepBars(false); bars.forEach(b=>drawBar(b)); }
        if(_gourangaActive) _drawGourangaPending(now);
        if(gem)   drawGem(gem,now);
        if(snake) drawSnake(false);
        drawOvBg(0.84);
        const isWin=nameReason==='win';
        ctg(isWin?'YOU WIN!':'GAME OVER',CW/2,36,isWin?'#ffd700':'#ff5555',FONT.JUMBO, GLOW.BIG);
        ct(`SCORE: ${score}   LEVEL: ${level}`,CW/2,76,'#aaa',FONT.HINT);
        ct('ENTER YOUR NAME:',CW/2,104,'#7fff7f',FONT.HINT);
    } else {
        drawGrid(); drawOvBg(0.92);
        ctg(entryMode==='friend'?'ADD FRIEND':'YOUR NAME',CW/2,24,'#7fff7f',FONT.TITLE, GLOW.TITLE);
        ct(entryMode==='friend'?'FRIEND ID (8 HEX DIGITS):':'ENTER YOUR NAME:',CW/2,104,'#7fff7f',FONT.HINT);
    }
    const sw=30,sh=40,gap=5,totalW=max*(sw+gap)-gap,sx0=Math.floor(CW/2-totalW/2),sy=122;
    for(let i=0;i<max;i++){
        const sx=sx0+i*(sw+gap),act=i===nameCursorPos,has=i<nameStr.length&&!act;
        ctx.fillStyle=act?'#142014':'#0d0d18'; ctx.strokeStyle=act?'#7fff7f':'#2a2a3a'; ctx.lineWidth=act?1.5:1;
        rr(sx,sy,sw,sh,3); ctx.fill(); ctx.stroke();
        const flashing=has&&i===_nameFlashPos&&now-_nameFlashAt<350;
        if(has){ ctx.shadowColor='#7fff7f'; ctx.shadowBlur=flashing?14:1; if(nameStr[i]===' '){ctx.shadowBlur=0;ctx.fillStyle=flashing?'#ffffff':'#4a7a4a';ctx.fillRect(sx+8,sy+sh-12,sw-16,2);}else{ct(nameStr[i],sx+sw/2,sy+sh/2,flashing?'#ffffff':'#7fff7f',FONT.MENU);} ctx.shadowBlur=0; }
        else if(act){
            const gc=chars[nameCharIdx]; ctx.globalAlpha=0.42; if(gc===' '){ctx.fillStyle='#7fff7f';ctx.fillRect(sx+8,sy+sh-12,sw-16,2);}else{ct(gc==='\r'?'\u21B5':gc,sx+sw/2,sy+sh/2,'#7fff7f',FONT.MENU);} ctx.globalAlpha=1;
            if(Math.floor(now/400)%2===0){ctx.fillStyle='#7fff7f55';ctx.fillRect(sx+5,sy+sh-6,sw-10,2);}
        }
    }
    const selY=sy+sh+90,ci=nameCharIdx;
    const dialX=entryMode==='friend'?190:CW/2;   // friend mode: dial left, camera right -> pair centered
    {
        ctx.fillStyle='#0d1e0d'; rr(dialX-20,selY-12,40,22,3); ctx.fill();
        ctx.strokeStyle='#2a5a2a'; ctx.lineWidth=1; rr(dialX-20,selY-12,40,22,3); ctx.stroke();
        for(let d=-2;d<=2;d++){
            const raw=chars[(ci+d+chars.length)%chars.length];
            const y=selY+d*22, sz=d===0?FONT.MENU:FONT.HINT;
            const col=d===0?'#7fff7f':Math.abs(d)===1?'#888':'#555';
            const al=d===0?1:Math.abs(d)===2?0.35:0.75;
            if(d===0){ctx.shadowColor='#7fff7f';ctx.shadowBlur=GLOW.TEXT;}
            ctx.globalAlpha=al;
            if(raw===' '){
                // spacebar visual: horizontal bar
                const bw=d===0?22:14;
                ctx.fillStyle=col;
                ctx.fillRect(Math.round(dialX-bw/2),Math.round(y+sz*0.35),bw,2);
            } else if(raw==='\r'){
                // enter key: symbol inside a key-shaped box; the selected key gets a
                // bigger box + TITLE-size arrow so the glyph reads clearly
                const bw=d===0?32:20,bh=d===0?24:14;
                ctx.strokeStyle=col; ctx.lineWidth=1;
                rr(Math.round(dialX-bw/2),Math.round(y-bh/2),bw,bh,2); ctx.stroke();
                ct('\u21B5',dialX,y,col,d===0?FONT.TITLE:sz);
            } else {
                ct(raw,dialX,y,col,sz);
            }
            ctx.globalAlpha=1;
            if(d===0){ctx.shadowBlur=0;}
        }
        ctx.fillStyle='rgba(127,255,127,0.45)';
        const ax=dialX,uay=selY-2*22-18,day=selY+2*22+18;
        ctx.beginPath(); ctx.moveTo(ax,uay-5); ctx.lineTo(ax-6,uay+3); ctx.lineTo(ax+6,uay+3); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(ax,day+5); ctx.lineTo(ax-6,day-3); ctx.lineTo(ax+6,day-3); ctx.closePath(); ctx.fill();
    }
    if(entryMode==='friend') _drawScanPanel();
    ct('UP/DN:letter  L/R:move  A:place  RETURN=submit  ESC:del',CW/2,CH-10,'#888',FONT.HINT);
}
// Camera viewfinder (ADD FRIEND, right side): live preview while scanning; a
// verified read auto-fills and submits (see the QR SCANNER source in input.js).
const SCAN_VF={ s:150, x:270, y:180 };   // viewfinder rect (draw + tap hit-test); pairs with the dial at x=190
function _drawScanPanel(){
    const vs=SCAN_VF.s, vx=SCAN_VF.x, vy=SCAN_VF.y;
    if(_scanOk){
        // Locked: green frame + the read code, visible for a beat before the auto-submit.
        ctx.strokeStyle='#7fff7f'; ctx.lineWidth=2; rr(vx-4,vy-4,vs+8,vs+8,4); ctx.stroke();
        ctg('QR OK',vx+vs/2,vy+vs/2-16,'#7fff7f',FONT.MENU, GLOW.TEXT);
        ct(_scanOk,vx+vs/2,vy+vs/2+8,'#ffd700',FONT.HINT);
        ct('ADDING...',vx+vs/2,vy+vs/2+28,'#4a7a4a',FONT.HINT);
        return;
    }
    scanTick();
    ctx.strokeStyle='#2a5a2a'; ctx.lineWidth=2; rr(vx-4,vy-4,vs+8,vs+8,4); ctx.stroke();
    if(_scanState==='live'&&_scanVideo&&_scanVideo.videoWidth){
        const vw=_scanVideo.videoWidth,vh=_scanVideo.videoHeight,s=Math.min(vw,vh)*0.7;
        try{ ctx.drawImage(_scanVideo,(vw-s)/2,(vh-s)/2,s,s,vx,vy,vs,vs); }catch(e){}
        ct('POINT AT FRIEND QR',vx+vs/2,vy+vs+14,'#4a7a4a',FONT.HINT);
    } else if(_scanState==='starting'){
        ct('CAMERA...',vx+vs/2,vy+vs/2,'#555',FONT.HINT);
    } else if(_scanManualOff){
        ct('CAMERA OFF',vx+vs/2,vy+vs/2-9,'#555',FONT.HINT);
        ct('TAP TO SCAN',vx+vs/2,vy+vs/2+9,'#555',FONT.HINT);
    } else {
        ct('NO CAMERA',vx+vs/2,vy+vs/2-9,'#555',FONT.HINT);
        ct('TYPE THE CODE',vx+vs/2,vy+vs/2+9,'#555',FONT.HINT);
    }
}

// The shared world layer for EVERY mode: single player, 1:1 local, 1:1 online. Background,
// collectibles, world FX and the snake(s) all draw here, so a duel and a solo game go through
// the exact same code -- the split that used to let cosmetics/power/state diverge is gone.
// A duel maintains only gem + powerPellet, so the other collectibles guard on globals it never
// sets and simply no-op; players and snake are mutually exclusive (startDuel sets players,
// startGame nulls it), so only one snake branch ever fires.
function drawWorld(now) {
    if(_powerMode){
        drawGrid();
        const nearEnd=now-_powerModeAt>_POWER_DUR-1500;
        const blink=nearEnd&&Math.floor(now/180)%2===0;
        _prepBars(!blink); bars.forEach(b=>drawBar(b,ctx,blink?b.fragile:true));
        ctx.save(); ctx.globalAlpha=0.06+0.04*Math.sin(now/200);
        ctx.fillStyle='#2244ff'; ctx.fillRect(0,0,CW,CH); ctx.restore();
    } else {
        ctx.drawImage(_bgCanvas,0,0);   // grid + bars pre-composited: one blit
    }
    if(_slowMode){
        const rem=_SLOW_DUR-(now-_slowModeAt);
        const a=(rem<3000&&Math.floor(now/200)%2===0)?0.02:0.05+0.03*Math.sin(now/300);
        ctx.save(); ctx.globalAlpha=a; ctx.fillStyle='#2a80c0'; ctx.fillRect(0,0,CW,CH); ctx.restore();
    }
    if(_gourangaActive) _drawGourangaPending(now);
    if(gem) drawGem(gem,now);
    if(powerPellet) _drawPowerPellet(now);
    if(timeCrystal) _drawTimeCrystal(now);
    if(heart) _drawHeart(now);
    _drawCrushEffects(now);
    if(players){
        const protect=phase==='duel'&&(now-spawnAt<SPAWN_PROTECT);
        if(protect&&Math.floor(now/130)%2===1) ctx.globalAlpha=0.22;
        const lk=_duelLook();
        // The gown reveals on whoever LEADS -- a duel has no record to chase, and the local
        // best score is device-local, so it is the one condition both clients can agree on.
        const _sh0=players[0].score>players[1].score, _sh1=players[1].score>players[0].score;
        drawSnakeG(players[0].snake, players[0].dir, players[0].dirQueue, lk.c0, lk.i0, !players[0].alive, _sh0);
        drawSnakeG(players[1].snake, players[1].dir, players[1].dirQueue, lk.c1, lk.i1, !players[1].alive, _sh1);
        ctx.globalAlpha=1;
    } else if(snake){
        const dying=phase==='dying',flash=dying&&Math.floor((now-phaseAt)/85)%2===1;
        const protect=phase==='playing'&&(now-spawnAt<SPAWN_PROTECT);
        if(protect&&Math.floor(now/130)%2===1) ctx.globalAlpha=0.22;
        drawSnake(flash);
        ctx.globalAlpha=1;
    }
    // Fireworks particles (perfect level); the array stays empty in a duel, so this no-ops.
    if(fireworks.length>0){
        fireworks=fireworks.filter(p=>{
            if(now<p.startAt) return true;
            p.life++; p.x+=p.vx; p.y+=p.vy; p.vy+=0.055; p.vx*=0.97;
            if(p.life>=p.maxLife) return false;
            const a=(1-p.life/p.maxLife)*0.92;
            const px=Math.round(p.x/2)*2, py=Math.round(p.y/2)*2;
            ctx.globalAlpha=a; ctx.fillStyle=p.color;
            ctx.fillRect(px,py,2,2);
            return true;
        });
        ctx.globalAlpha=1; ctx.shadowBlur=0;
    }
}
// Duel colours/cosmetics. Online: both clients derive the SAME pair from the exchanged
// profiles. Local duel (one screen, one config): my colour + the next index.
function _duelLook(){
    const lk=(typeof netDuelLook==='function')?netDuelLook():null;
    return {
        c0: lk?lk.c0:(cfg.snakeColor||0),
        c1: lk?lk.c1:((cfg.snakeColor||0)+1)%SNAKE_COLORS.length,
        i0: lk?lk.i0:(cfg.wornItems||{}),
        i1: lk?lk.i1:{}
    };
}
// The per-player controls line under the 1:1 DUEL title. Local 1:1 shows both schemes
// (P1 arrows, P2 WASD, one keyboard). An ONLINE duel drives ONE snake from this device --
// always arrows or the d-pad, whichever the device has (net.js swallows WASD, remaps arrows
// to netMyIndex) -- so it shows only the local player's scheme, in that player's colour.
function _drawDuelControls(lk){
    ctx.save(); ctx.font=`${FONT.MENU}px "Press Start 2P"`; ctx.textBaseline='middle';
    if(typeof netGameActive==='function' && netGameActive()){
        const me=(typeof netMyIndex==='function')?netMyIndex():0;
        ctx.textAlign='center'; ctx.fillStyle=SNAKE_COLORS[me===0?lk.c0:lk.c1].head;
        ctx.fillText(_hasKeyboard?'ARROWS TO MOVE':'SWIPE / D-PAD', CW/2, CH/2+38);
    } else {
        ctx.textAlign='right'; ctx.fillStyle=SNAKE_COLORS[lk.c0].head; ctx.fillText('P1: ARROWS   ', CW/2, CH/2+38);
        ctx.textAlign='left';  ctx.fillStyle=SNAKE_COLORS[lk.c1].head; ctx.fillText('P2: W A S D', CW/2, CH/2+38);
    }
    ctx.restore();
}
// The pre-round "TITLE / subhead ... GO!" splash, shared by solo levelReady and duel
// duelReady: same timing (READY_DUR, then the GO! fade-in) and geometry for both. Only the
// title and the secondary headline differ, so the caller passes the title and a subhead fn.
function drawReadyGo(now, title, subhead){
    const t=now-phaseAt, goPhase=t>=READY_DUR;
    drawOvBg(0.72);
    if(!goPhase){
        ctg(title, CW/2, CH/2-18, '#7fff7f', FONT.TITLE, GLOW.TITLE);
        subhead();
    } else {
        const a=Math.min(1,(t-READY_DUR)/80);
        ctx.save(); ctx.globalAlpha=a; ctg('GO!', CW/2, CH/2+10, '#ffff44', FONT.JUMBO, GLOW.BIG); ctx.restore();
    }
}
function drawGameBoard(now) {
    drawWorld(now);
    const dying=phase==='dying';
    if(phase==='levelDone'){
        const a=Math.min(1,(now-phaseAt)/150);
        ctx.save(); ctx.globalAlpha=a; ctx.shadowColor='#7fff7f'; ctx.shadowBlur=GLOW.TITLE;
        ct('LEVEL COMPLETE!',CW/2,levelWasPerfect?CH/2-36:CH/2-18,'#7fff7f',FONT.TITLE); ctx.restore();
        if(levelWasPerfect){
            const pa=Math.min(1,(now-phaseAt-180)/200);
            if(pa>0){
                ctx.save(); ctx.globalAlpha=pa;
                ctx.shadowColor='#ffd700'; ctx.shadowBlur=GLOW.TEXT;
                ct('PERFECT LEVEL!',CW/2,CH/2+2,'#ffd700',FONT.MENU);
                ctx.shadowBlur=0;
                ct(`+${(level*1000).toLocaleString()} BONUS`,CW/2,CH/2+22,'#ffaa00',FONT.HINT);
                ctx.restore();
            }
        }
        if(levelDoneWaiting&&Math.floor(now/520)%2===0){
            ctx.save(); ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.textBaseline='bottom'; ctx.textAlign='center'; ctx.shadowBlur=0;
            ctx.fillStyle='#888'; ctx.fillText('A:next  TAP:next',CW/2,CH-8); ctx.restore();
        }
    }
    if(phase==='levelReady') drawReadyGo(now, `LEVEL ${level}`, ()=>{
        ctx.shadowColor='#aaa'; ctx.shadowBlur=GLOW.TEXT;
        ct('GET READY',CW/2,CH/2+38,'#aaa',FONT.MENU);
    });
    if(dying && now-phaseAt >= FX_SETTLE_MS){   // hold the death message 2 ticks: a mispredicted death rolled back inside that window never flashes it
        const t=(now-phaseAt)/DEATH_DUR;
        ctx.save(); ctx.globalAlpha=Math.min(1,t*2.5); ctx.shadowColor='#ff4444';
        if(lives===0){ctx.shadowBlur=GLOW.BIG;ct(deathMsg,CW/2,CH/2,'#ff5555',FONT.JUMBO);}
        else{ctx.shadowBlur=GLOW.TITLE;ct(deathMsg,CW/2,CH/2,'#ff5555',FONT.TITLE);}
        ctx.restore();
    }
    if(phase==='paused'){
        drawOvBg(0.55);
                ctg('PAUSED',CW/2,CH/2+10,'#7fff7f',FONT.JUMBO, GLOW.BIG);
        ctx.save(); ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.textBaseline='bottom'; ctx.textAlign='center'; ctx.shadowBlur=0;
        ctx.fillStyle='#888'; ctx.fillText('||:resume  ESC:quit',CW/2,CH-8); ctx.restore();
    }
    // Bonus flash (duration and colour vary by tier)
    const bonusAge=now-bonusAt;
    const isGouranga=bonusLabel==='GOURANGA!';
    const flashDur=isGouranga?2500:bonusLabel.startsWith('EPIC')?1500:900;
    if(bonusAge<flashDur&&bonusLabel){
        const a=1-bonusAge/flashDur;
        const isEpic=bonusLabel.startsWith('EPIC'),isLucky=bonusLabel.startsWith('LUCKY');
        const col=isGouranga?`hsl(${(now/5)%360},100%,65%)`:isEpic?`hsl(${(now/6)%360},100%,70%)`:'#ffd700';
        const sz=isGouranga?FONT.JUMBO:isEpic?FONT.JUMBO:FONT.MENU;
        ctx.save(); ctx.globalAlpha=a;
        ctx.shadowColor=col; ctx.shadowBlur=isGouranga?36:isEpic?24:12;
        ct(bonusLabel,CW/2,CH/2-60,col,sz);
        ctx.restore();
    }
    updateHUD();
}

// The ONE confirmation-dialog renderer: draw the live screen behind, frost it to black glass,
// then a (danger=red / otherwise amber) question, an optional explanation line, and YES/NO.
function drawConfirm(o) {
    if(o.behind) o.behind();
    drawGlass();
    ctg(o.title, CW/2, CH/2 - (o.note?54:18), o.danger?'#ff5555':'#ff9900', FONT.MENU, GLOW.TEXT);
    if(o.note){
        ctx.save(); ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillStyle='#aaa'; ctx.fillText(o.note, CW/2, CH/2-24); ctx.restore();
    }
    drawConfirmYesNo('', o.sel);
}
function drawConfirmYesNo(title, sel) {
    const YES_X=CW/2-80, NO_X=CW/2+80;
        ctg(title,CW/2,CH/2-18,'#ff9900',FONT.TITLE, GLOW.TITLE);
    ctx.globalAlpha=sel===0?1:0.35;
    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=sel===0?12:1;
    ct(sel===0?'> YES <':'  YES  ',YES_X,CH/2+38,'#7fff7f',FONT.MENU);
    ctx.globalAlpha=sel===1?1:0.35;
    ctx.shadowColor='#ff5555'; ctx.shadowBlur=sel===1?12:1;
    ct(sel===1?'> NO <':'  NO   ',NO_X,CH/2+38,'#ff5555',FONT.MENU);
    ctx.globalAlpha=1; ctx.shadowBlur=0;
    ctx.save(); ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.textBaseline='bottom'; ctx.textAlign='center';
    ctx.fillStyle='#888'; ctx.fillText('L/R:choose  A:ok  ESC:cancel',CW/2,CH-8); ctx.restore();
}
function drawQuitConfirm() {
    // LIVE board behind the dialog -- the game keeps running while the player decides
    // (an online duel cannot freeze the opponent; local matches the same semantics).
    drawConfirm({ title:'QUIT TO MENU?', sel:quitConfirmSel, behind:()=>{
        if(players) drawDuelBoard(simNow);
        else if(snake) drawGameBoard(simNow);
        else drawGrid();
    }});
    showHUD(false);
}

// ================================================================
// 1:1 DUEL SCREENS
// ================================================================
function drawDuelMenu() {
    // Same skeleton as the other submenus (drawSettings): grid + overlay, TITLE headline
    // at y=24 with glow 16, items from startY=90 in rowH steps, #888 hint at CH-14.
    drawGrid(); drawOvBg(0.92);
    ctg('1:1 DUEL',CW/2,24,'#7fff7f',FONT.TITLE, GLOW.TITLE);
    const startY=90, rowH=28;
    const items=[
        {t:'PLAY LOCAL',  en:_hasKeyboard, note:_hasKeyboard?null:'(PC + KEYBOARD ONLY)'},
        {t:'MY ID',       en:true},
        {t:'ADD FRIEND',  en:true},
        {t:'FRIENDS',     en:true},
        {t:'PLAY ONLINE', en:!cfg.offline, note:cfg.offline?'(OFFLINE MODE - SEE SETTINGS/NETWORK)':null},
    ];
    items.forEach((it,i)=>{
        const y=startY+i*rowH, sel=duelSel===i;
        if(it.en) menuItem(it.t,y,sel);
        else ct(sel?('> '+it.t+' <'):it.t, CW/2, y, sel?'#777':'#555', FONT.MENU);
    });
    menuItem('BACK', CH-52, duelSel===items.length);   // BACK toward the bottom, like drawSettings
    if(items[duelSel] && items[duelSel].note) ct(items[duelSel].note, CW/2, startY+4.6*rowH, '#555', FONT.HINT);
    if(_duelMsg && _msgNow()-_duelMsgAt<2600) drawStatus(_duelMsg);
    ct('UP/DN:nav  A:ok  ESC:back', CW/2, CH-14, '#888', FONT.HINT);
}
// MY ID: this player's identity + the friend-link QR (moved here from SETTINGS).
function drawFriendId() {
    _netMyIdAt = Date.now();   // an incoming request while our QR shows auto-accepts (see net.js)
    drawGrid(); drawOvBg(0.92);
    ctg('MY ID',CW/2,24,'#7fff7f',FONT.TITLE, GLOW.TITLE);
    ct(fmtPlayerId()+'   FRIENDS: '+getFriends().length, CW/2, 50, '#ffd700', FONT.MENU);
    // Friend-link QR: white card (spec quiet zone = 4 modules), black modules.
    // Scanning opens the game with #friend=<this player's ID> in the hash.
    const q=qrMatrix(friendUrl());
    const mod=8, quiet=4, card=(q.size+quiet*2)*mod;
    const qx=Math.round((CW-card)/2), qy=64;
    ctx.fillStyle='#ffffff'; ctx.fillRect(qx,qy,card,card);
    ctx.fillStyle='#000000';
    for(let r=0;r<q.size;r++) for(let c=0;c<q.size;c++)
        if(q.m[r][c]) ctx.fillRect(qx+(quiet+c)*mod, qy+(quiet+r)*mod, mod, mod);
    if(_netFr.msg) ct(_netFr.msg, CW/2, qy+card+12, '#ffd700', FONT.HINT);   // e.g. X ADDED YOU AS A FRIEND (see _netFrCelebrate)
    else ct('SCAN TO ADD ME AS A FRIEND', CW/2, qy+card+12, '#4a7a4a', FONT.HINT);
    ct('A/ESC:back', CW/2, CH-10, '#888', FONT.HINT);
}
// ONLINE 1:1 lobby: quick match, friends with online status, incoming invites.
// All state lives in net.js (_netLb / _netCounts / _netFriendsOnline).
function drawLobby(){
    drawGrid(); drawOvBg(0.92);
    ctg('ONLINE 1:1',CW/2,24,'#7fff7f',FONT.TITLE, GLOW.TITLE);
    let stat, statCol='#4a7a4a';
    const notice=(typeof netStatusNotice==='function')?netStatusNotice():null;
    if(notice){ stat=notice; statCol='#ff8888'; }
    else if(typeof RTCPeerConnection!=='function'){ stat='WEBRTC NOT SUPPORTED ON THIS DEVICE'; statCol='#ff8888'; }
    else stat='ONLINE: '+_netCounts.online+'   IN 1:1: '+_netCounts.playing;
    ct(stat, CW/2, 50, statCol, FONT.HINT);
    const fr=getFriends();
    const rowH=26;
    // QUICK MATCH leads and is the default selection (sel 0): the common case is "just
    // find me a game". Friends follow it; BACK stays at the bottom.
    menuItem(_netLb.seeking?'SEEKING... (A: CANCEL)':'QUICK MATCH', 84, _netLb.sel===0);
    const startY=84+rowH;
    fr.forEach((id,i)=>{
        const on=_netFriendsOnline[id]===true;
        const y=startY+i*rowH;
        menuItem(fmtFriendId(id), y, _netLb.sel===i+1);   // the ID stays centered + selected
        _drawRowName((typeof netFriendName==='function')?netFriendName(id):null, y, _netLb.sel===i+1);
        // The ms figure is the estimated one-way path THEIR update travels to
        // reach us (their reported latency/2 + ours/2), not an RTT.
        const e2e=on&&typeof netFriendE2E==='function'?netFriendE2E(id):null;
        ct(on?('ONLINE'+(e2e!=null?' ~'+e2e+'ms':'')):'OFF', CW/2+170, y, on?'#7fff7f':'#555', FONT.HINT);
    });
    if(!fr.length) ct('NO FRIENDS YET - SEE ADD FRIEND', CW/2, startY, '#555', FONT.HINT);
    menuItem('BACK', CH-52, _netLb.sel===fr.length+1);   // BACK toward the bottom, like drawSettings
    // Connecting feedback: one dot grows every 200ms while something is pending.
    const dots='.'.repeat(1+Math.floor(((typeof performance!=='undefined')?performance.now():0)/200)%5);
    if(_netLb.msg) drawStatus(_netLb.msg.replace(/\.\.\.$/,dots));
    else if(_netHs.sent) drawStatus('INVITED '+fmtFriendId(_netHs.sent)+' - WAITING'+dots);
    if(_netLb.invite){
        // Incoming invite: full-screen modal on a SOLID background (a transparent
        // layer over the lobby read as a mess). Its own YES/NO row -- NOT
        // drawConfirmYesNo, whose fixed geometry collided with the text above.
        // Profile fields are untrusted (clamped in net.js, canvas text only).
        ctx.fillStyle='#07070e'; ctx.fillRect(0,0,CW,CH);
        drawGrid(); drawOvBg(0.92);
        ctg('INVITE',CW/2,CH/2-84,'#ffd700',FONT.TITLE, GLOW.TITLE);
        ct(_netLb.invite.profile.name+'  ('+fmtFriendId(_netLb.invite.from)+')', CW/2, CH/2-48, '#aaa', FONT.MENU);
        ct('WANTS TO PLAY 1:1', CW/2, CH/2-22, '#7fff7f', FONT.HINT);
        const s0=_netLb.inviteSel===0, s1=_netLb.inviteSel===1;
        ctx.save();
        ctx.globalAlpha=s0?1:0.35; ctx.shadowColor='#7fff7f'; ctx.shadowBlur=s0?12:1;
        ct(s0?'> YES <':'  YES  ', CW/2-80, CH/2+28, '#7fff7f', FONT.MENU);
        ctx.globalAlpha=s1?1:0.35; ctx.shadowColor='#ff5555'; ctx.shadowBlur=s1?12:1;
        ct(s1?'> NO <':'  NO   ', CW/2+80, CH/2+28, '#ff5555', FONT.MENU);
        ctx.restore();
        ct('L/R:choose  A:ok  ESC:decline', CW/2, CH-14, '#888', FONT.HINT);
        return;
    }
    ct('UP/DN:nav  A:ok  ESC:back', CW/2, CH-14, '#888', FONT.HINT);
}

// Friend-row name column: right-aligned so it ends left of the centered ID;
// long names truncate to 8 chars plus '..' and can never touch the columns.
function _drawRowName(nm, y, sel){
    if(!nm) return;
    const disp = nm.length > 10 ? nm.slice(0,8)+'..' : nm;
    // Right edge well CLEAR of the selection marker: the centered ID renders as
    // '> XXXX-XXXX <' whose '>' begins around CW/2-91 (9 id chars + marker).
    ctx.font=`${FONT.MENU}px "Press Start 2P"`; ctx.textBaseline='middle';
    ctx.textAlign='right'; ctx.fillStyle = sel ? '#7fff7f' : '#888';
    ctx.fillText(disp, CW/2-112, y);
    ctx.textAlign='center';
}

// FRIENDS management: the server-recorded relations (accepted / pending both
// ways) merged with local-only ids, accept incoming requests, remove with a
// confirm. Friendships live on the SERVER; removals are pushed there too.
function drawFriends(){
    drawGrid(); drawOvBg(0.92);
    ctg('FRIENDS',CW/2,24,'#7fff7f',FONT.TITLE, GLOW.TITLE);
    let stat, statCol='#4a7a4a';
    const notice=(typeof netStatusNotice==='function')?netStatusNotice():null;
    if(notice){ stat=notice; statCol='#ff8888'; }
    else if(_netFr.loading && !_netFr.list){ stat='LOADING...'; }
    else stat='A: ACCEPT REQUEST / REMOVE   ESC: BACK';
    ct(stat, CW/2, 50, statCol, FONT.HINT);
    const rows=_netFrRows();
    const startY=80, rowH=26;
    rows.forEach((r,i)=>{
        const y=startY+i*rowH;
        menuItem(fmtFriendId(r.id), y, _netFr.sel===i);   // the ID stays centered + selected
        _drawRowName((typeof netFriendName==='function')?netFriendName(r.id):null, y, _netFr.sel===i);
        let st, col='#555';
        if(r.state==='accepted'){ st=r.online?('ONLINE'+(r.latency!=null?' '+r.latency+'ms':'')):'OFF'; col=r.online?'#7fff7f':'#555'; }
        else if(r.state==='pending' && !r.outgoing){ st='WANTS TO JOIN'; col='#ffd700'; }
        else if(r.state==='pending'){ st='REQUEST SENT'; col='#888'; }
        else { st='NOT SYNCED'; col='#888'; }
        ct(st, CW/2+180, y, col, FONT.HINT);
    });
    if(!rows.length) ct('NO FRIENDS YET - SEE ADD FRIEND', CW/2, startY+rowH, '#555', FONT.HINT);
    if(_netFr.msg) drawStatus(_netFr.msg);
    menuItem('BACK', CH-52, _netFr.sel===rows.length);   // BACK toward the bottom, like drawSettings
    if(_netFr.confirm){
        // Local safety confirm before removing a friend (the SERVER removal itself
        // is silent/auto-confirmed, but the UI still guards an accidental delete).
        ctx.fillStyle='#07070e'; ctx.fillRect(0,0,CW,CH);
        drawGrid(); drawOvBg(0.92);
        ctg('REMOVE FRIEND',CW/2,CH/2-84,'#ff8888',FONT.TITLE, GLOW.TITLE);
        const nm=(typeof netFriendName==='function')?netFriendName(_netFr.confirm):null;
        ct((nm?nm+'  ':'')+fmtFriendId(_netFr.confirm), CW/2, CH/2-48, '#aaa', FONT.MENU);
        ct('THE SERVER FORGETS THE RELATION TOO', CW/2, CH/2-22, '#888', FONT.HINT);
        const s0=_netFr.confirmSel===0, s1=_netFr.confirmSel===1;
        ctx.save();
        ctx.globalAlpha=s0?1:0.35; ctx.shadowColor='#7fff7f'; ctx.shadowBlur=s0?12:1;
        ct(s0?'> YES <':'  YES  ', CW/2-80, CH/2+28, '#7fff7f', FONT.MENU);
        ctx.globalAlpha=s1?1:0.35; ctx.shadowColor='#ff5555'; ctx.shadowBlur=s1?12:1;
        ct(s1?'> NO <':'  NO   ', CW/2+80, CH/2+28, '#ff5555', FONT.MENU);
        ctx.restore();
        ct('L/R:choose  A:ok  ESC:cancel', CW/2, CH-14, '#888', FONT.HINT);
        return;
    }
    ct('UP/DN:nav  A:ok  ESC:back', CW/2, CH-14, '#888', FONT.HINT);
}

// Invite landing (iOS Safari only, see the boot hash parse): the scanned friend code
// cannot reach an already-installed home-screen app, so hand it over manually.
function drawInvite() {
    drawGrid(); drawOvBg(0.92);
    ctg('FRIEND INVITE',CW/2,24,'#7fff7f',FONT.TITLE, GLOW.TITLE);
    ct("YOUR FRIEND'S CODE:", CW/2, 74, '#aaa', FONT.HINT);
    ctg(fmtFriendId(_inviteFid||''), CW/2, 102, '#ffd700', FONT.TITLE, GLOW.TEXT);
    ct('GOT THE GAME ON YOUR HOME SCREEN?', CW/2, 148, '#7fff7f', FONT.HINT);
    ct('OPEN IT: 1:1 DUEL > ADD FRIEND', CW/2, 166, '#aaa', FONT.HINT);
    ct('AND ENTER (OR SCAN) THIS CODE', CW/2, 184, '#aaa', FONT.HINT);
    ct('NO APP YET? SHARE > ADD TO HOME SCREEN', CW/2, 214, '#7fff7f', FONT.HINT);
    ct('THE CODE TRAVELS ALONG AUTOMATICALLY', CW/2, 232, '#aaa', FONT.HINT);
    menuItem('COPY CODE', 272, inviteSel===0);
    menuItem('CONTINUE', 300, inviteSel===1);
    if(_inviteMsg && simNow-_inviteMsgAt<1600) ct(_inviteMsg, CW/2, 330, '#ffd700', FONT.HINT);
    ct('UP/DN:nav  A:ok', CW/2, CH-14, '#888', FONT.HINT);
}
// The other side is not reaching us: either nothing has arrived for a second, or
// what arrives is unusable (refused inputs, a hash that disagrees). Both mean the
// two clients have stopped playing the same game, so say so on the board rather
// than let it look like the opponent is standing still.
function _drawDuelWarn(){
    const w = (typeof netDuelWarn==='function') ? netDuelWarn() : null;
    if(!w) return;
    ctx.save();
    ctx.globalAlpha = 0.10 + 0.05*Math.sin(simNow/150);   // a live pulse: never mistaken for the board
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0,0,CW,CH);
    ctx.restore();
    ctg(w, CW/2, 22, '#ff6666', FONT.HINT, GLOW.TEXT);
}
function drawDuelBoard(now) {
    if(typeof netRelayActive==='function' && netRelayActive())
        ct('RELAY MODE', CW/2, 8, '#ffd24a', FONT.HINT);   // latency self-explains
    drawWorld(now);           // background + collectibles + both snakes: the shared layer
    const lk=_duelLook();     // colours reused by the duelReady controls and the winner banner
    if(phase==='duelReady') drawReadyGo(now, (typeof netGameActive==='function'&&netGameActive())?'1:1 DUEL':'LOCAL 1:1', ()=>_drawDuelControls(lk));
    if(phase==='duelPaused'){
        // Identical to the classic paused overlay, incl. the bottom hint.
        drawOvBg(0.55);
                ctg('PAUSED', CW/2, CH/2+10, '#7fff7f', FONT.JUMBO, GLOW.BIG);
        ctx.save(); ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.textBaseline='bottom'; ctx.textAlign='center'; ctx.shadowBlur=0;
        ctx.fillStyle='#888'; ctx.fillText('||:resume  ESC:quit',CW/2,CH-8); ctx.restore();
    }
    if(phase==='duelOver' && now-phaseAt >= FX_SETTLE_MS){   // hold the winner banner 2 ticks, same as the death message: a mispredicted final kill rolled back never flashes "X WINS!"
        // Match over: winner banner + final score, then a PLAY AGAIN? dialog in the
        // quit-dialog skeleton (YES pre-selected via the loop's phase-change hook).
        drawGlass();
        const win=duelWinner;
        const col=win===2?'#cccccc':SNAKE_COLORS[win===0?lk.c0:lk.c1].head;
        const _wn=(typeof netPlayerNames==='function')?netPlayerNames():null;
        ctg(win===2?'DRAW!':((_wn?_wn[win]:'PLAYER '+(win+1))+' WINS!'), CW/2, CH/2-70, col, FONT.JUMBO, GLOW.BIG);
        if(players) ct(players[0].score+'  :  '+players[1].score, CW/2, CH/2-40, '#cccccc', FONT.MENU);
        drawConfirmYesNo('PLAY AGAIN?', quitConfirmSel);
        if(typeof netWaitingAgain==='function' && netWaitingAgain())
            ct('WAITING FOR OPPONENT...', CW/2, CH/2+64, '#ffd700', FONT.HINT);
    }
    _drawDuelWarn();   // last: it must sit over the board, not under it
}
function drawResetConfirm() {
    const K = _resetKind;
    const title = K==='settings' ? 'RESET ALL SETTINGS?' : K==='id' ? 'RESET PLAYER ID?' : 'RESET ALL STATS?';
    const note  = K==='settings' ? 'audio  controls  display  network   (stats + id kept)'
                : K==='id'       ? 'NEW ID -- your old friends can no longer invite you'
                :                  'scores  fokoins  achievements  shop';
    drawConfirm({ title, note, sel:quitConfirmSel, behind:drawSettings, danger:true });
}
