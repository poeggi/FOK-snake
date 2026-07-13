// ================================================================
// CONSTANTS (static data in assets.js)
// ================================================================

function drawPixelIcon(x, y, icon, cs) {
    icon.d.forEach((row, ry) => {
        let rx = 0;
        for (const c of row) {
            if(c !== '.' && icon.p[c]){
                ctx.fillStyle = icon.p[c];
                ctx.fillRect(Math.round(x+rx*cs), Math.round(y+ry*cs), Math.ceil(cs), Math.ceil(cs));
            }
            rx++;
        }
    });
}

// ================================================================
// CANVAS
// ================================================================
const canvas = document.getElementById('c');
canvas.width = CW; canvas.height = CH;
const ctx = canvas.getContext('2d');

// ================================================================
// PERSISTENCE
// ================================================================
const HS_KEY = 'fok-snake-hs';
const FK_KEY = 'fok-snake-coins';
const CFG_KEY = 'fok-snake-cfg';
function getScores() {
    try {
        const raw = localStorage.getItem(HS_KEY);
        if(raw === null) return [{name:'SNAKE PLISSKEN',score:42,level:1,diff:1,color:0,shopItems:{},date:'26.11.97'}];
        const a = JSON.parse(raw);
        return Array.isArray(a) ? a : [];
    } catch { return []; }
}
function getFOKoins() { return parseInt(localStorage.getItem(FK_KEY) || '0', 10) || 0; }
let _cachedFOKoins = getFOKoins();
function addFOKoins(n) {
    _cachedFOKoins += n;
    try { localStorage.setItem(FK_KEY, String(_cachedFOKoins)); } catch {}
    if(_cachedFOKoins >= 5000)    unlockAch('fokoins_1k');
    if(_cachedFOKoins >= 100000)  unlockAch('fokoins_10k');
    if(_cachedFOKoins >= 1000000) unlockAch('fokoins_1m');
    if(_cachedFOKoins >= 5000000) unlockAch('fokoins_100k');
}
function addScore(name, sc, lvl) {
    const s = getScores();
    const now = new Date();
    const date = `${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getFullYear()).slice(-2)}`;
    s.push({ name:name.trim().substring(0,MAX_NAME), score:sc, level:lvl,
             diff:cfg.diff, color:cfg.snakeColor||0, shopItems:{...(cfg.wornItems||{})}, date });
    s.sort((a, b) => b.score - a.score);
    try { localStorage.setItem(HS_KEY, JSON.stringify(s.slice(0, 10))); } catch {}
    addFOKoins(sc);
}
function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {} }
// Fresh default config each call (new objects, so nothing is shared/aliased).
// cfg.offline: when ON, future online features (1v1 dualplay, global online stats)
// must stay disabled -- gate all networking on !cfg.offline.
function defaultCfg() {
    return { music:true, diff:1, musicStyle:0, snakeColor:0, shopItems:{}, wornItems:null,
             handed:0, volume:1, sfxVol:0.5, turbo:true, touchSelect:false, offline:false, fps30:false, disableGlow:false,
             boxPity:0, shopOpens:0, cfgVer:2 };
}
// Clamp/coerce every field so a corrupt, partial, or foreign save can never put
// the game in a bad state (e.g. an out-of-range diff or colour index).
function _sanitizeCfg() {
    const idx = (v,n,d) => (Number.isInteger(v) && v>=0 && v<n) ? v : d;
    const unit = (v,d) => (typeof v==='number' && isFinite(v)) ? Math.max(0,Math.min(1,v)) : d;
    cfg.diff        = idx(cfg.diff, DIFF.length, 1);
    cfg.snakeColor  = idx(cfg.snakeColor, SNAKE_COLORS.length, 0);
    cfg.musicStyle  = idx(cfg.musicStyle, 2, 0);
    cfg.handed      = idx(cfg.handed, 2, 0);
    cfg.volume      = unit(cfg.volume, 1);
    cfg.sfxVol      = unit(cfg.sfxVol, 0.5);
    cfg.music       = cfg.music !== false;
    cfg.turbo       = cfg.turbo !== false;
    cfg.touchSelect = !!cfg.touchSelect;
    cfg.offline     = !!cfg.offline;
    cfg.fps30       = !!cfg.fps30;
    cfg.disableGlow = !!cfg.disableGlow;
    cfg.boxPity     = (Number.isInteger(cfg.boxPity)   && cfg.boxPity>=0)   ? cfg.boxPity   : 0;
    cfg.shopOpens   = (Number.isInteger(cfg.shopOpens) && cfg.shopOpens>=0) ? cfg.shopOpens : 0;
    if(!cfg.shopItems || typeof cfg.shopItems!=='object' || Array.isArray(cfg.shopItems)) cfg.shopItems = {};
    if(cfg.wornItems!==null && (typeof cfg.wornItems!=='object' || Array.isArray(cfg.wornItems))) cfg.wornItems = null;
}
// Error-tolerant load: parse failures fall back to defaults; keys absent from an
// older or partial save (including a restored old backup) keep their defaults;
// every value is sanitized. Reset-to-defaults-then-overlay so restoring an old
// backup clears settings that backup never carried.
function loadCfg() {
    let s = {};
    try { const raw = localStorage.getItem(CFG_KEY); if(raw) s = JSON.parse(raw); } catch {}
    if(!s || typeof s!=='object' || Array.isArray(s)) s = {};
    if(!s.cfgVer || s.cfgVer < 2) delete s.touchSelect;   // v2 migration
    Object.assign(cfg, defaultCfg(), s);
    _sanitizeCfg();
}

const ACH_KEY = 'fok-snake-ach';
let achUnlocked = {};
let achPopups = [];   // {id, at}
let confetti = [];
const CONFETTI_COLS = ['#ff4444','#ff9900','#ffff44','#44ff88','#44ccff','#aa44ff','#ff44cc','#ffffff'];
function spawnConfetti() {
    for(let i=0;i<60;i++){
        confetti.push({
            x: CW*0.65+Math.random()*CW*0.35,
            y: -6-Math.random()*30,
            vx: -0.5-Math.random()*2.5,
            vy: 1.2+Math.random()*2.8,
            rot: Math.random()*Math.PI*2,
            vrot: (Math.random()-0.5)*0.18,
            w: 5+Math.random()*6, h: 3+Math.random()*4,
            color: CONFETTI_COLS[i%CONFETTI_COLS.length],
            life:0, maxLife:100+Math.floor(Math.random()*80),
        });
    }
}
function loadAch() { try { achUnlocked = JSON.parse(localStorage.getItem(ACH_KEY) || '{}'); } catch {} }
function saveAch() { try { localStorage.setItem(ACH_KEY, JSON.stringify(achUnlocked)); } catch {} }
function announceSeen(){ try{ return !ANNOUNCEMENT||localStorage.getItem('seenAnnounce')===ANNOUNCEMENT.id; }catch{ return true; } }
function markAnnounceSeen(){ try{ if(ANNOUNCEMENT)localStorage.setItem('seenAnnounce',ANNOUNCEMENT.id); }catch{} }
const EASY_ACHS = new Set(['first_gem','level1','level5','fokoins_1k','fokoins_10k','fokoins_1m']);
function unlockAch(id) {
    if(achUnlocked[id]) return;
    if(cfg.diff === 0 && !EASY_ACHS.has(id)) return;
    achUnlocked[id] = Date.now(); saveAch();
    addFOKoins(1000);
    achPopups.push({ id, at: simNow });
    spawnConfetti();
}
loadAch();

// ================================================================
// CREDITS DATA
// ================================================================
const CRED = [
    ['gap',50],['title','S N A K E'],['sub','F O K   E D I T I O N'],['gap',60],
    ['hdr','--- CREDITS ---'],['gap',40],
    ['hdr','CONCEPTUAL SUPERVISION'],['txt','Jonas and Kai P.'],['gap',28],
    ['hdr','CREATIVE DIRECTION'],['txt','Jonas P.'],['gap',28],
    ['hdr','CREATIVE ADVISOR'],['txt','Maartje P.'],['gap',28],
    ['hdr','EXECUTIVE PRODUCTION'],['txt','Kai P.'],['gap',28],
    ['hdr','LEAD DEVELOPER'],['txt','Claude P.'],['sml','(types at 10,000 tokens/min)'],['gap',28],
    ['hdr','MUSICAL COMPOSITION'],['txt','Claude M.'],['sml','(self-taught. mostly.)'],['gap',28],
    ['hdr','VISUAL ARTS'],['txt','Claude V.'],['sml','(knows exactly 7 colors)'],['gap',28],
    ['hdr','QUALITY ASSURANCE'],['txt','The Snake'],['sml','(mortality rate: 100%)'],['gap',28],
    ['hdr','LEVEL DESIGN'],['txt','A Random Number Generator'],['sml','(certified barricade placement specialist)'],['gap',28],
    ['hdr','GEM MANAGEMENT'],['txt','The Gems'],['sml','(eaten without consent since 2026)'],['gap',28],
    ['hdr','STRUCTURAL ENGINEERING'],['txt','The Barricades'],['sml','(load-bearing. do not touch.)'],['gap',28],
    ['hdr','SNAKE PSYCHOLOGY'],['txt','Dr. S. Nake, PhD'],['sml','(expert in self-collision trauma)'],['gap',28],
    ['hdr','CATERING'],['txt','The Break Room Snake'],['sml','(she also ate the coffee machine)'],['gap',40],
    ['hdr','SPECIAL THANKS'],
    ['txt','Everyone who played.'],['txt','Everyone who crashed into themselves.'],
    ['txt','The one person who reached Level 10.'],['txt','You know who you are.'],['gap',40],
    ['hdr','IN MEMORIAM'],
    ['txt','All snakes lost in beta testing.'],['txt','They knew the risks.'],['gap',28],
    ['txt','No animals were harmed...'],['sml','(the snakes beg to differ)'],['gap',50],
    ['coins'],['sml','(spend them in the SHOP)'],['gap',50],
    ['sml','(C) 2026 FOK STUDIOS'],['sml','All wrongs reserved.'],
    ['gap',30],['txt','PRESS A TO EXIT'],['gap',280],
    ['gap',420],
    ['secret','No Eastereggs here ;)'],['gap',240],
];
const CRED_H = { title:54, sub:22, hdr:28, txt:26, sml:24, coins:28, secret:28 };
function credTotalH() { let h=0; for(const[t,v] of CRED) h += t==='gap' ? v : (CRED_H[t]||22); return h; }
const CRED_TOTAL_H = credTotalH();

// ================================================================
// APP STATE
// ================================================================
// phases: splash|menu|settings|scores|credits|playing|levelReady|paused|dying|levelDone|nameEntry|quitConfirm|resetConfirm
let phase = 'splash';
let menuSel = 0, settingsSel = 0, shopSel = 0, shopPage = 0, quitConfirmSel = 1, prevPhase = 'playing';
let settingsCat = -1;              // -1 = category list; else index into SETTINGS_CATS
let _dataMsg = '', _dataMsgAt = 0; // transient DATA MANAGEMENT feedback line
let _shimmerThreshold = 25000;
const _splashText = SPLASHES.length ? SPLASHES[Math.floor(Math.random()*SPLASHES.length)] : '';
const MENU_ITEMS     = ['PLAY', 'SETTINGS', 'HIGH SCORES', 'ACHIEVEMENTS', 'SHOP', 'CREDITS'];
let cfg = defaultCfg();
loadCfg();
if(cfg.wornItems === null){ cfg.wornItems = {...(cfg.shopItems||{})}; saveCfg(); }
Snd.musicSetVolume(cfg.volume ?? 1);
Snd.sfxSetVolume(cfg.sfxVol ?? 0.5);
function applyHandedness() { document.body.classList.toggle('lefty', cfg.handed === 1); }
applyHandedness();

let level, lives, score, _levelStartLen = 0;
let snake, dir, dirQueue;
let gem, gemsDone, bars;
// Sim clock: simTick is the integer source of truth; simNow is its ms projection
// (simTick * TICK_MS). All game state reads simNow/simTick, never performance.now().
let simTick = 0, simNow = 0, _acc = 0, _lastRAF = 0;
// gPer = engine ticks per game tick (the level's fixed boost period). _gDue counts
// down to the next game tick; _stepAccum accrues movement (normal +1, boost +2 per
// game tick) and spends 2 per snake step -> normal moves every 2nd game tick, boost
// every game tick, without ever changing gPer.
let gPer, _gDue = 0, _stepAccum = 0, phaseAt = 0, gemAt, deathMsg, pauseAt;
let spawnAt = 0, levelDoneWaiting = false;
let pauseReadyAt = 0, escReadyAt = 0;
let perfectLevel = true, levelWasPerfect = false, fireworks = [];
let levelBonusCount = 0, epicLevelCount = 0;
let _gourangaLine=[], _gourangaActive=false, _gourangaEaten=new Set();
let heart=null, heartAt=0, heartIsEarly=false, _earlyHeartUsed=false, _earlyHeartTrigger=-1, _earlyHeartCount=0, _crushEffects=[];
let powerPellet=null, powerPelletAt=0, _powerMode=false, _powerModeAt=0;
const _POWER_DUR=T(330);   // 5.5s power mode
const EARLY_HEART_TTL=T(600);   // 10s early-heart lifespan
const SPAWN_PROTECT=T(60);      // 1s post-spawn collision immunity
let timeCrystal=null, timeCrystalAt=0, _slowMode=false, _slowModeAt=0;
const _SLOW_DUR=T(1800);   // 30s time-warp slow
let perfectCount = 0, luckyCount = 0;
let achPage = 0;
let nameStr = '', nameCharIdx = 0, nameCursorPos = 0, nameReason = '';
let _nameFlashAt = 0, _nameFlashPos = -1;
let creditsScroll = 0, creditsSpeed = 0.8, _creditsNormal = 0.8;
let purchaseParticles = [], purchaseAnimAt = 0;
let fpsFrames = 0, fpsLast = 0;

function menuTrack() { return cfg.musicStyle === 0 ? 'ambient'     : 'classicMenu'; }
function gameTrack() { return cfg.musicStyle === 0 ? 'game'        : 'classicGame'; }

// ================================================================
// GAME LOGIC
// ================================================================
let bonusAt = -9999, bonusLabel = '';
function showBonus(now, label) { bonusAt = now; bonusLabel = label; }

function spawnFireworks(now) {
    levelWasPerfect = true;
    const palette = ['#ff4040','#ff9000','#ffee00','#40ff80','#00ccff','#cc44ff','#ff44aa','#ffffff'];
    for (let b = 0; b < 8; b++) {
        const delay = b * 310 + Math.random() * 80;
        const x = 55 + Math.random() * (CW - 110);
        const y = 22 + Math.random() * (CH * 0.62);
        const col = palette[b % palette.length];
        for (let i = 0; i < 22; i++) {
            const angle = (i / 22) * Math.PI * 2;
            const spd = 1.7 + Math.random() * 2.4;
            fireworks.push({
                startAt: now + delay,
                x, y,
                vx: Math.cos(angle) * spd,
                vy: Math.sin(angle) * spd - 0.7,
                color: col,
                life: 0,
                maxLife: 52 + Math.floor(Math.random() * 38),
            });
        }
    }
}

// Presentation replays the sim's recorded side-effects. Called once per sim tick
// from loop(), right after update(); simNow is that tick's timestamp.
function drainSimEvents(){
    for(const e of simEvents){
        switch(e.t){
            case 'sfx':      Snd.sfxPlay(e.name, cfg.music); break;
            case 'mpause':   Snd.musicGamePause(); break;
            case 'munpause': Snd.musicGameUnpause(); break;
            case 'mstop':    Snd.musicStop(); break;
            case 'coin':     addFOKoins(e.n); break;
            case 'ach':      unlockAch(e.id); break;
            case 'bonus':    showBonus(simNow, e.label); break;
            case 'fw':       spawnFireworks(simNow); break;
            case 'bars':     renderBarsOffscreen(); break;
            case 'showhud':  showHUD(e.v); break;
            case 'gameover':
                try{ nameStr=(localStorage.getItem('lastSName')||'').substring(0,MAX_NAME); }catch{ nameStr=''; }
                nameCharIdx=nameStr.length>0?NAME_CHARS.indexOf(' '):0; nameCursorPos=nameStr.length; nameReason='over';
                showHUD(false); Snd.musicStop(); break;
            case 'crush':    _crushEffects.push({ x:e.x, y:e.y, at:simNow,
                                 pts:Array.from({length:20},()=>({
                                     ang:Math.random()*Math.PI*2, spd:3+Math.random()*9,
                                     sz:2+Math.random()*4,
                                     col:['#ff6600','#ffaa00','#ffdd44','#cc3300','#ffffff','#886644'][Math.floor(Math.random()*6)]
                                 })) }); break;
        }
    }
    simEvents.length = 0;
}

function togglePause() {
    if(phase==='playing'){
        if(performance.now() < pauseReadyAt) return;
        phase='paused'; pauseAt=simNow; Snd.musicGamePause();
    } else if(phase==='paused'){
        gemAt+=simNow-pauseAt; phase='playing'; _gDue=gPer; _stepAccum=0;
        pauseReadyAt=performance.now()+1000;
        Snd.musicGameUnpause();
    }
}

// ================================================================
// HUD
// ================================================================
const hudEl = document.getElementById('hud');
const _hudLvlEl=document.getElementById('hv-lvl');
const _hudGemsEl=document.getElementById('hv-gems');
const _hudScoreEl=document.getElementById('hv-score');
const _hudLivesCv=document.getElementById('hv-lives-cv');
const _hudLivesCtx=_hudLivesCv.getContext('2d');
let _hudCache={level:-1,gemsDone:-1,score:-1,lives:-1};
function showHUD(v) { hudEl.classList.toggle('hidden',!v); }
function updateHUD() {
    if(level!==_hudCache.level){       _hudLvlEl.textContent=level;      _hudCache.level=level; }
    if(gemsDone!==_hudCache.gemsDone){ _hudGemsEl.textContent=gemsDone;  _hudCache.gemsDone=gemsDone; }
    if(score!==_hudCache.score){       _hudScoreEl.textContent=score;    _hudCache.score=score; }
    if(lives!==_hudCache.lives){
        _hudCache.lives=lives;
        _hudLivesCv.width=lives*16;
        _hudLivesCtx.fillStyle='#7fff7f';
        for(let i=0;i<lives;i++){
            const ox=i*16;
            HEART_PX.forEach((row,ry)=>row.forEach((px,rx)=>{if(px)_hudLivesCtx.fillRect(ox+rx*2,ry*2,2,2);}));
        }
    }
}

// ================================================================
// DRAW HELPERS
// ================================================================
function rr(x,y,w,h,r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
    ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}
function eyeOffsets(d) {
    const E=CS-2;
    if(d.x===1)  return [[E-5,2],[E-5,E-5]]; if(d.x===-1) return [[2,2],[2,E-5]];
    if(d.y===-1) return [[2,2],[E-5,2]];      return [[2,E-5],[E-5,E-5]];
}
const _gridCanvas=document.createElement('canvas'); _gridCanvas.width=CW; _gridCanvas.height=CH;
const _scanCanvas=document.createElement('canvas'); _scanCanvas.width=CW; _scanCanvas.height=CH;
const _barsCanvas=document.createElement('canvas'); _barsCanvas.width=CW; _barsCanvas.height=CH;
const _barsCtx=_barsCanvas.getContext('2d');
// Static background = grid + bars, pre-composited so the board is one blit per frame
// (instead of grid + bars separately). Rebuilt only when bars change (see _composeBg).
const _bgCanvas=document.createElement('canvas'); _bgCanvas.width=CW; _bgCanvas.height=CH;
const _bgCtx=_bgCanvas.getContext('2d');
// Main-menu static cache: everything except the animated splash text + unread badge.
// Rebuilt only when the visible static content changes (selection, version, diff line).
const _menuCanvas=document.createElement('canvas'); _menuCanvas.width=CW; _menuCanvas.height=CH;
const _menuCtx=_menuCanvas.getContext('2d');
let _mc={sel:-1,ver:'',diff:'',glow:null};
// Central glow control: intercept the shadowBlur setter once per context so that
// cfg.disableGlow forces it to 0 EVERYWHERE, with zero changes at the 80+ call sites.
function _glowGuard(c){
    const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c),'shadowBlur');
    if(!d||!d.set) return;   // stub context (headless tests) -- nothing to guard
    Object.defineProperty(c,'shadowBlur',{ configurable:true,
        get(){ return d.get.call(this); },
        set(v){ d.set.call(this, cfg.disableGlow ? 0 : v); } });
}
_glowGuard(ctx); _glowGuard(_menuCtx);
(()=>{
    const g=_gridCanvas.getContext('2d');
    g.fillStyle='#07070e'; g.fillRect(0,0,CW,CH);
    g.strokeStyle='#0d0d1a'; g.lineWidth=0.5; g.beginPath();
    for(let x=0;x<=COLS;x++){g.moveTo(x*CS,0);g.lineTo(x*CS,CH);}
    for(let y=0;y<=ROWS;y++){g.moveTo(0,y*CS);g.lineTo(CW,y*CS);}
    g.stroke();
    const s=_scanCanvas.getContext('2d');
    s.fillStyle='rgba(0,0,0,0.05)';
    for(let y=0;y<CH;y+=3) s.fillRect(0,y,CW,1);
})();
function drawGrid() { ctx.drawImage(_gridCanvas, 0, 0); }
// Recompose the static background (grid is opaque, bars drawn on top). Called whenever
// the bar layout changes, so drawGameBoard can blit it in a single drawImage.
function _composeBg() { _bgCtx.drawImage(_gridCanvas, 0, 0); _bgCtx.drawImage(_barsCanvas, 0, 0); }
_composeBg();
function drawOvBg(a) { ctx.fillStyle=`rgba(7,7,14,${a||0.88})`; ctx.fillRect(0,0,CW,CH); }
function ct(text,x,y,color,size,c=ctx) {
    c.fillStyle=color||'#7fff7f';
    c.font=`${size||10}px "Press Start 2P"`;
    c.textAlign='center'; c.textBaseline='middle'; c.fillText(text,x,y);
}
function menuItem(text,y,sel,c=ctx) {
    c.globalAlpha=sel?1:0.78;
    c.shadowColor=sel?'#7fff7f':'#cccccc'; c.shadowBlur=sel?12:1;
    ct(sel?('> '+text+' <'):text,CW/2,y,sel?'#7fff7f':'#cccccc',14,c);
    c.shadowBlur=0; c.globalAlpha=1;
}

// High-contrast barricades (>4.5:1 on dark bg) - bright amber brick
// Neighbour lookup so touching barricades of the same kind render as one
// continuous wall: shared edges drop the 1px inset and the bevel, so the fills
// meet seamlessly. _prepBars must run before a drawBar pass. allFragile mirrors
// the caller's asFragile override (power mode paints every bar as fragile).
let _barLookup=new Map(), _barAllFragile=false;
function _prepBars(allFragile){ _barAllFragile=allFragile; _barLookup=new Map(); for(const b of bars) _barLookup.set(ck(b),b); }
function _barConn(nx,ny,eff){
    if(nx<0||nx>=COLS||ny<0||ny>=ROWS) return false;   // no wrap -- edges aren't visually adjacent
    const n=_barLookup.get(nx+','+ny);
    if(!n) return false;
    return (_barAllFragile?true:n.fragile)===eff;
}
function drawBar(b, c=ctx, asFragile=b.fragile) {
    const eff=asFragile;
    const cL=_barConn(b.x-1,b.y,eff), cR=_barConn(b.x+1,b.y,eff);
    const cU=_barConn(b.x,b.y-1,eff), cD=_barConn(b.x,b.y+1,eff);
    const x=b.x*CS+(cL?0:1), y=b.y*CS+(cU?0:1);
    const bw=CS-(cL?0:1)-(cR?0:1), bh=CS-(cU?0:1)-(cD?0:1);
    if(eff){
        // Crumbling border block: grey-brown, visibly damaged
        c.fillStyle='#7a6050'; c.fillRect(x,y,bw,bh);
        c.fillStyle='#4a3a2a';
        c.fillRect(x,y+Math.floor(bh/2),bw,1);
        c.fillRect(x+Math.floor(bw/2),y,1,Math.floor(bh/2));
        // Faded bevel -- only on outer (unconnected) edges
        c.fillStyle='#aa9080'; if(!cU)c.fillRect(x,y,bw,2); if(!cL)c.fillRect(x,y,2,bh);
        c.fillStyle='#332820'; if(!cR)c.fillRect(x+bw-2,y,2,bh); if(!cD)c.fillRect(x,y+bh-2,bw,2);
        // Diagonal cracks
        c.strokeStyle='#2a1a0a'; c.lineWidth=1;
        c.beginPath(); c.moveTo(x+3,y+2); c.lineTo(x+bw-4,y+bh-3); c.stroke();
        c.beginPath(); c.moveTo(x+bw-5,y+2); c.lineTo(x+4,y+Math.floor(bh*0.6)); c.stroke();
        return;
    }
    c.fillStyle='#cc4400'; c.fillRect(x,y,bw,bh);
    // mortar lines: T-shape per cell -- tiles into brickwork across a connected wall
    c.fillStyle='#5a1a00';
    c.fillRect(x,y+Math.floor(bh/2),bw,1);
    c.fillRect(x+Math.floor(bw/2),y,1,Math.floor(bh/2));
    // 3D bevel -- only on outer (unconnected) edges
    c.fillStyle='#ff7700'; if(!cU)c.fillRect(x,y,bw,2); if(!cL)c.fillRect(x,y,2,bh);
    c.fillStyle='#661800'; if(!cR)c.fillRect(x+bw-2,y,2,bh); if(!cD)c.fillRect(x,y+bh-2,bw,2);
}
function renderBarsOffscreen() {
    _barsCtx.clearRect(0,0,CW,CH); _prepBars(false); bars.forEach(b=>drawBar(b,_barsCtx));
    _composeBg();
}

function drawGem(g,now) {
    const cx=g.x*CS+CS/2, cy=g.y*CS+CS/2, t=(now-gemAt)/1000;
    const tier=g.tier||0;
    if(tier===2){
        // Epic gem: rainbow, sparkles, spawn burst
        const hue=(now/8)%360;
        const r=(CS/2-1)*(1+0.20*Math.sin(t*9));
        ctx.save(); ctx.translate(cx,cy); ctx.rotate(t*5);
        // Spawn burst rings (1.4s)
        const bAge=now-g.spawnAt;
        if(bAge<1400){
            const bp=bAge/1400;
            [1,2].forEach(n=>{
                ctx.save();
                ctx.globalAlpha=(1-bp)*0.7;
                ctx.strokeStyle=`hsl(${(hue+n*60)%360},100%,70%)`;
                ctx.lineWidth=3; ctx.shadowColor=ctx.strokeStyle; ctx.shadowBlur=10;
                ctx.beginPath(); ctx.arc(0,0,r*(1+n*3*bp),0,Math.PI*2); ctx.stroke();
                ctx.restore();
            });
        }
        // Outer glow
        if(!cfg.disableGlow){
            const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.8);
            grd.addColorStop(0,`hsla(${hue},100%,65%,0.22)`); grd.addColorStop(1,`hsla(${hue},100%,65%,0)`);
            ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.8,0,Math.PI*2); ctx.fill();
        }
        // Diamond
        ctx.shadowColor=`hsl(${hue},100%,70%)`; ctx.shadowBlur=12;
        ctx.fillStyle=`hsl(${hue},100%,65%)`;
        ctx.beginPath(); ctx.moveTo(0,-r*1.1); ctx.lineTo(r*0.7,0); ctx.lineTo(0,r*1.1); ctx.lineTo(-r*0.7,0); ctx.closePath(); ctx.fill();
        ctx.fillStyle='rgba(255,255,255,0.5)';
        ctx.beginPath(); ctx.moveTo(0,-r*1.1); ctx.lineTo(r*0.7,0); ctx.lineTo(0,0); ctx.closePath(); ctx.fill();
        ctx.restore();
        // Orbiting sparkles
        for(let i=0;i<6;i++){
            const a=t*3+(i/6)*Math.PI*2;
            const sx=cx+Math.cos(a)*CS*1.3, sy=cy+Math.sin(a)*CS*1.3;
            ctx.save();
            ctx.fillStyle=`hsl(${(hue+i*60)%360},100%,80%)`;
            ctx.shadowColor=ctx.fillStyle; ctx.shadowBlur=6;
            ctx.beginPath(); ctx.arc(sx,sy,2.2,0,Math.PI*2); ctx.fill();
            ctx.restore();
        }
    } else if(tier===1){
        // Lucky gem: gold, faster spin
        const r=(CS/2-1)*(1+0.15*Math.sin(t*7));
        ctx.save(); ctx.translate(cx,cy); ctx.rotate(t*3.5);
        if(!cfg.disableGlow){
            const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.5);
            grd.addColorStop(0,'rgba(255,215,0,0.32)'); grd.addColorStop(1,'rgba(255,215,0,0)');
            ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.5,0,Math.PI*2); ctx.fill();
        }
        ctx.shadowColor='#ffd700'; ctx.shadowBlur=18;
        ctx.fillStyle='#ffd700';
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,r); ctx.lineTo(-r*0.65,0); ctx.closePath(); ctx.fill();
        ctx.fillStyle='rgba(255,255,255,0.52)';
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,0); ctx.closePath(); ctx.fill();
        ctx.restore();
    } else if(g.gouranga) {
        // Gouranga gem: orange diamond
        const r=(CS/2-2)*(1+0.12*Math.sin(t*5));
        ctx.save(); ctx.translate(cx,cy); ctx.rotate(t*2);
        if(!cfg.disableGlow){
            const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.2);
            grd.addColorStop(0,'rgba(255,140,0,0.25)'); grd.addColorStop(1,'rgba(255,140,0,0)');
            ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.2,0,Math.PI*2); ctx.fill();
        }
        ctx.shadowColor='#ff8800'; ctx.shadowBlur=14;
        const fg=ctx.createLinearGradient(0,-r,0,r);
        fg.addColorStop(0,'#ffee88'); fg.addColorStop(0.35,'#ff8800'); fg.addColorStop(1,'#cc4400');
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,r); ctx.lineTo(-r*0.65,0); ctx.closePath();
        ctx.fillStyle=fg; ctx.fill(); ctx.restore();
    } else {
        // Normal gem: cyan diamond
        const r=(CS/2-2)*(1+0.12*Math.sin(t*5));
        ctx.save(); ctx.translate(cx,cy); ctx.rotate(t*2);
        if(!cfg.disableGlow){
            const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.2);
            grd.addColorStop(0,'rgba(0,255,255,0.25)'); grd.addColorStop(1,'rgba(0,255,255,0)');
            ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.2,0,Math.PI*2); ctx.fill();
        }
        ctx.shadowColor='#00ffff'; ctx.shadowBlur=14;
        const fg=ctx.createLinearGradient(0,-r,0,r);
        fg.addColorStop(0,'#ffffff'); fg.addColorStop(0.35,'#00ffff'); fg.addColorStop(1,'#006688');
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,r); ctx.lineTo(-r*0.65,0); ctx.closePath();
        ctx.fillStyle=fg; ctx.fill(); ctx.restore();
    }
}

function triggerPurchaseAnim() {
    purchaseAnimAt = simNow;
    for(let i=0;i<50;i++){
        const angle=(i/50)*Math.PI*2, spd=1.5+Math.random()*3.5;
        purchaseParticles.push({
            x:CW/2, y:CH*0.5,
            vx:Math.cos(angle)*spd*(0.6+Math.random()),
            vy:Math.sin(angle)*spd-1.2,
            size:3+Math.random()*6,
            color:Math.random()<0.65?'#ffd700':'#ffee88',
            life:0, maxLife:55+Math.floor(Math.random()*45),
            rot:Math.random()*Math.PI*2, vrot:(Math.random()-0.5)*0.2,
        });
    }
}

function drawAccessoryCylinder(hx, hy) {
    ctx.fillStyle='#1a1a1a';
    ctx.fillRect(hx+3,hy-10,12,9);   // body
    ctx.fillRect(hx-2,hy-2,22,3);    // brim
    ctx.fillStyle='#333333';
    ctx.fillRect(hx+3,hy-3,12,1);    // band
    ctx.fillStyle='#2a2a2a';
    ctx.fillRect(hx+3,hy-10,12,1);   // top sheen
}

function drawAccessoryMonocle(hx, hy) {
    const e=eyeOffsets(dir)[0];
    ctx.strokeStyle='#cccccc'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.arc(hx+e[0]+1.5,hy+e[1]+1.5,3.5,0,Math.PI*2); ctx.stroke();
    ctx.strokeStyle='#888888'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(hx+e[0]+4,hy+e[1]+4); ctx.lineTo(hx+e[0]+8,hy+e[1]+9); ctx.stroke();
}

function drawAccessoryShades(hx, hy) {
    const eyes=eyeOffsets(dir);
    ctx.fillStyle='#111111';
    eyes.forEach(([ox,oy])=>{ctx.beginPath();ctx.arc(hx+ox+1.5,hy+oy+1.5,4,0,Math.PI*2);ctx.fill();});
    ctx.fillStyle='#1a3050';
    eyes.forEach(([ox,oy])=>{ctx.beginPath();ctx.arc(hx+ox+1.5,hy+oy+1.5,2.5,0,Math.PI*2);ctx.fill();});
    if(eyes.length>=2){
        const x1=hx+eyes[0][0]+1.5, y1=hy+eyes[0][1]+1.5, x2=hx+eyes[1][0]+1.5, y2=hy+eyes[1][1]+1.5;
        ctx.strokeStyle='#111111'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    }
}

function drawAccessoryCrown(hx, hy) {
    ctx.fillStyle='#ffd700';
    ctx.fillRect(hx+1,hy-12,4,10); ctx.fillRect(hx+7,hy-15,5,13); ctx.fillRect(hx+14,hy-12,4,10);
    ctx.fillRect(hx,hy-5,19,5);
    ctx.fillStyle='#cc8800'; ctx.fillRect(hx,hy-5,19,1);
    ctx.fillStyle='#ff4444'; ctx.fillRect(hx+2,hy-4,2,2);
    ctx.fillStyle='#4488ff'; ctx.fillRect(hx+8,hy-4,3,2);
    ctx.fillStyle='#ff4444'; ctx.fillRect(hx+15,hy-4,2,2);
}

function drawAccessoryBow(hx, hy, facing={x:1,y:0}) {
    ctx.save();
    ctx.translate(hx+9,hy+9); ctx.rotate(Math.atan2(facing.y,facing.x));
    ctx.fillStyle='#cc2222';
    ctx.fillRect(-5,-2,4,5);   // left wing
    ctx.fillRect(2,-2,4,5);    // right wing
    ctx.fillStyle='#ff4444';
    ctx.fillRect(-5,-2,4,2);
    ctx.fillRect(2,-2,4,2);
    ctx.fillStyle='#aa0000';
    ctx.fillRect(-1,-1,3,3);   // knot center
    ctx.restore();
}

function drawAccessoryNecktie(hx, hy, facing={x:1,y:0}) {
    ctx.save();
    ctx.translate(hx+9,hy+9); ctx.rotate(Math.atan2(facing.y,facing.x));
    // Blade trails behind the head (opposite the facing direction)
    ctx.fillStyle='#2a52be';
    ctx.beginPath();
    ctx.moveTo(-1,-3); ctx.lineTo(-1,3); ctx.lineTo(-6,4);
    ctx.lineTo(-9,0); ctx.lineTo(-6,-4); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#5a82ee';            // highlight stripe
    ctx.beginPath();
    ctx.moveTo(-3,-1); ctx.lineTo(-3,1); ctx.lineTo(-7,0); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#1a3a8e';            // knot
    ctx.fillRect(-1,-3,4,5);
    ctx.restore();
}

function drawAccessoryHalo(hx, hy) {
    ctx.save();
    ctx.strokeStyle='#ffe23a'; ctx.lineWidth=2; ctx.shadowColor='#ffe23a'; ctx.shadowBlur=8;
    ctx.beginPath(); ctx.ellipse(hx+9,hy-7,9,3.2,0,0,Math.PI*2); ctx.stroke();
    ctx.restore();
}
// ---- Box-exclusive accessories ----
function drawAccessoryEyepatch(hx, hy) {
    const e=eyeOffsets(dir)[0], cx=hx+e[0]+1.5, cy=hy+e[1]+1.5;
    ctx.strokeStyle='#0a0a0a'; ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.moveTo(hx-1,cy-4.5); ctx.lineTo(hx+19,cy+2.5); ctx.stroke();   // strap
    ctx.fillStyle='#0a0a0a';
    ctx.beginPath(); ctx.ellipse(cx,cy,3.4,3,0,0,Math.PI*2); ctx.fill();                // patch
    ctx.fillStyle='#2a2a2a'; ctx.fillRect(Math.round(cx-2),Math.round(cy-2),1,1);       // sheen
}
function drawAccessoryGlasses3d(hx, hy) {
    const eyes=eyeOffsets(dir), cols=['#ff2a2a','#22e0ff'];
    ctx.fillStyle='#111111';
    eyes.forEach(([ox,oy])=>{ctx.beginPath();ctx.arc(hx+ox+1.5,hy+oy+1.5,4,0,Math.PI*2);ctx.fill();});
    eyes.forEach(([ox,oy],i)=>{ctx.fillStyle=cols[i%2];ctx.beginPath();ctx.arc(hx+ox+1.5,hy+oy+1.5,2.6,0,Math.PI*2);ctx.fill();});
    if(eyes.length>=2){
        ctx.strokeStyle='#111111'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(hx+eyes[0][0]+1.5,hy+eyes[0][1]+1.5); ctx.lineTo(hx+eyes[1][0]+1.5,hy+eyes[1][1]+1.5); ctx.stroke();
    }
}
function drawAccessoryPropeller(hx, hy) {
    ctx.fillStyle='#e03c3c'; ctx.fillRect(hx+4,hy-6,11,6);      // beanie
    ctx.fillStyle='#f5d020'; ctx.fillRect(hx+4,hy-4,11,2);
    ctx.fillStyle='#2aa84a'; ctx.fillRect(hx+4,hy-1,11,1);
    ctx.fillStyle='#888888'; ctx.fillRect(hx+9,hy-9,2,3);       // stalk
    ctx.fillStyle='#4a90d9'; ctx.fillRect(hx+3,hy-10,6,2);      // blade L
    ctx.fillStyle='#e03c3c'; ctx.fillRect(hx+10,hy-10,6,2);     // blade R
    ctx.fillStyle='#ffd700'; ctx.fillRect(hx+8,hy-11,3,3);      // hub
}
function drawAccessoryAdmincrown(hx, hy) {
    ctx.save(); ctx.shadowColor='#00e5ff'; ctx.shadowBlur=6;
    ctx.fillStyle='#ffe860';
    ctx.fillRect(hx+1,hy-13,4,11); ctx.fillRect(hx+7,hy-16,5,14); ctx.fillRect(hx+14,hy-13,4,11);
    ctx.fillRect(hx,hy-5,19,5);
    ctx.shadowBlur=0;
    ctx.fillStyle='#cc9a00'; ctx.fillRect(hx,hy-5,19,1);
    ctx.fillStyle='#00e5ff'; ctx.fillRect(hx+2,hy-15,2,2); ctx.fillRect(hx+8,hy-4,3,2); ctx.fillRect(hx+15,hy-15,2,2);
    ctx.restore();
}

function drawAccessoryMoustache(hx, hy) {
    const eyes=eyeOffsets(dir);
    const ex=(eyes[0][0]+(eyes[1]?eyes[1][0]:eyes[0][0]))/2+1.5;
    const ey=(eyes[0][1]+(eyes[1]?eyes[1][1]:eyes[0][1]))/2+1.5+4;
    ctx.save(); ctx.fillStyle='#2a1a0a';
    ctx.beginPath(); ctx.ellipse(hx+ex-3,hy+ey,3,1.8,0.35,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(hx+ex+3,hy+ey,3,1.8,-0.35,0,Math.PI*2); ctx.fill();
    ctx.restore();
}

function drawAccessoryWizard(hx, hy) {
    ctx.fillStyle='#5a2a9a';                             // cone
    ctx.beginPath(); ctx.moveTo(hx+9,hy-16); ctx.lineTo(hx+2,hy-1); ctx.lineTo(hx+16,hy-1); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#3a1a6a'; ctx.fillRect(hx,hy-2,18,2); // brim
    ctx.fillStyle='#ffe860';                             // star tip + specks
    ctx.fillRect(hx+8,hy-18,2,2); ctx.fillRect(hx+6,hy-8,1,1); ctx.fillRect(hx+11,hy-11,1,1);
}

// Perf: pre-build the segment rounded-rects once (filled translated each frame)
// instead of rebuilding an 8-curve path per segment, and cache body colours so the
// per-segment hsl() strings aren't reallocated every frame. Zero visual change;
// falls back to rr() if Path2D is unavailable.
const _mkSegPath = r => {
    if (typeof Path2D === 'undefined') return null;
    const p = new Path2D(), w = CS-2, h = CS-2;
    p.moveTo(r,0); p.lineTo(w-r,0); p.quadraticCurveTo(w,0,w,r);
    p.lineTo(w,h-r); p.quadraticCurveTo(w,h,w-r,h);
    p.lineTo(r,h); p.quadraticCurveTo(0,h,0,h-r);
    p.lineTo(0,r); p.quadraticCurveTo(0,0,r,0); p.closePath();
    return p;
};
const _segPathBody = _mkSegPath(3), _segPathHead = _mkSegPath(5);
let _bodyColCache = { h:-1, len:-1, cols:null };
function _bodyCols(len, h) {
    if (_bodyColCache.h !== h || _bodyColCache.len !== len) {
        const cols = new Array(len);
        for (let j=0; j<len; j++) { const l = Math.round(41*(0.5+0.5*(1-j/Math.max(len,1)))); cols[j] = `hsl(${h},65%,${l}%)`; }
        _bodyColCache = { h, len, cols };
    }
    return _bodyColCache.cols;
}
function drawSnake(flash) {
    const sc=SNAKE_COLORS[cfg.snakeColor||0];
    const si=cfg.wornItems||{};
    const cols = flash ? null : _bodyCols(snake.length, sc.h);
    const sw=CS-2,sh=CS-2,len=snake.length;
    snake.forEach((seg,i)=>{
        const x=seg.x*CS+1,y=seg.y*CS+1;
        if(i>0){
            // Body: no shadow to set/reset -- just colour + fill.
            ctx.fillStyle=flash?`hsl(0,55%,${Math.round(41*(0.5+0.5*(1-i/Math.max(len,1))))+8}%)`:cols[i];
            if(_segPathBody){ ctx.translate(x,y); ctx.fill(_segPathBody); ctx.translate(-x,-y); }
            else { rr(x,y,sw,sh,3); ctx.fill(); }
            return;
        }
        // Head (glow set + reset only here, once per frame).
        ctx.fillStyle=flash?'#bb2222':sc.head;
        if(!flash){ctx.shadowColor=sc.head;ctx.shadowBlur=10;}
        if(_segPathHead){ ctx.translate(x,y); ctx.fill(_segPathHead); ctx.translate(-x,-y); }
        else { rr(x,y,sw,sh,5); ctx.fill(); }
        if(!flash){
            ctx.shadowBlur=0;
            const eyeDir=dirQueue.length>0?dirQueue[0]:dir;
            ctx.fillStyle='#001500'; eyeOffsets(eyeDir).forEach(([ox,oy])=>ctx.fillRect(x+ox,y+oy,3,3));
            if(dirQueue.length>0&&(dirQueue[0].x!==dir.x||dirQueue[0].y!==dir.y)){
                const qd=dirQueue[0];
                const mx=Math.round(x+sw/2+qd.x*(sw/2-3)), my=Math.round(y+sh/2+qd.y*(sh/2-3));
                ctx.save(); ctx.globalAlpha=0.75; ctx.fillStyle='#aaffaa';
                ctx.shadowColor='#7fff7f'; ctx.shadowBlur=5;
                ctx.fillRect(mx-1,my-1,3,3); ctx.restore();
            }
            if(si.shades)    drawAccessoryShades(x,y);
            if(si.glasses3d) drawAccessoryGlasses3d(x,y);
            if(si.monocle)   drawAccessoryMonocle(x,y);
            if(si.eyepatch)  drawAccessoryEyepatch(x,y);
            if(si.moustache) drawAccessoryMoustache(x,y);
            if(si.bow)       drawAccessoryBow(x,y,eyeDir);
            if(si.necktie)   drawAccessoryNecktie(x,y,eyeDir);
            if(si.cylinder)  drawAccessoryCylinder(x,y);
            if(si.propeller) drawAccessoryPropeller(x,y);
            if(si.wizard)    drawAccessoryWizard(x,y);
            if(si.crown)     drawAccessoryCrown(x,y);
            if(si.admincrown)drawAccessoryAdmincrown(x,y);
            if(si.halo)      drawAccessoryHalo(x,y);
        }
    });
    // Shoes ride the tail segment
    if(si.shoes && !flash && snake.length>0){
        const t=snake[snake.length-1], x=t.x*CS+1, y=t.y*CS+1;
        ctx.fillStyle='#eeeeee'; ctx.fillRect(x+2,y+CS-7,5,3); ctx.fillRect(x+CS-8,y+CS-7,5,3);
        ctx.fillStyle='#cc2222'; ctx.fillRect(x+2,y+CS-5,5,1); ctx.fillRect(x+CS-8,y+CS-5,5,1);
        ctx.fillStyle='#333333'; ctx.fillRect(x+1,y+CS-4,6,2); ctx.fillRect(x+CS-9,y+CS-4,6,2);
    }
    // Invisible gown: only reveals a traveling shimmer while you are outscoring the record
    if(si.gown && !flash && phase==='playing' && score>=_shimmerThreshold){
        const L=snake.length, now=performance.now();
        for(let i=0;i<L;i++){
            const wv=Math.sin(i*0.6-now/160);
            if(wv>0.75){
                const s=snake[i], x=s.x*CS+1, y=s.y*CS+1;
                ctx.save(); ctx.globalAlpha=(wv-0.75)/0.25*0.6; ctx.fillStyle='#ffffff';
                rr(x,y,CS-2,CS-2,i===0?5:3); ctx.fill(); ctx.restore();
            }
        }
    }
}

// ================================================================
// SCREENS
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
    ctx.shadowColor = '#7fff7f'; ctx.shadowBlur = 38;
    ct('S N A K E', CW/2, 78, '#7fff7f', 40);
    ctx.shadowBlur = 0;
    ctx.shadowColor='#4a7a4a'; ctx.shadowBlur=1; ct('F O K   E D I T I O N', CW/2, 122, '#4a7a4a', 8); ctx.shadowBlur=0;

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
        if (t >= T_DROP && t < T_DONE) {
            showCoin = true;
            if (dropT < DROP) {
                const p = dropT / DROP;
                coinY = startY + (slotY - startY - 14) * p * p * p * p * p;
            } else {
                const p = (dropT - DROP) / ENTER;
                coinY = (slotY - 14) + 28 * p;
            }
        }
        slotFlashF = (t >= T_ENTER && t < T_ENTER + 0.4) ? 1 - (t - T_ENTER) / 0.4 : 0;
        coinClipped = t >= T_ENTER;
    }

    // Slot housing always drawn
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(coinX - 32, slotY - 9, 64, 18);
    ctx.fillStyle = '#2a2a2a'; ctx.fillRect(coinX - 26, slotY - 6, 52, 12);
    ctx.fillStyle = '#111'; ctx.fillRect(coinX - 16, slotY - 2, 32, 4);

    // Pixelated sparks burst from slot when coin enters
    // spark speed (spd) >= 90 renders bright white; slower sparks render gold
    if (slotFlashF > 0) {
        const sparkDefs = [
            [-0.55,-1,72,1],    [0,-1,80,1],       [0.55,-1,72,1],
            [-1.1,-0.85,58,1],  [1.1,-0.85,58,1],
            [-0.25,-1,95,1],    [0.25,-1,95,1],
            [-1.4,-0.45,44,1],  [1.4,-0.45,44,1],
            [-0.8,-0.65,65,1],  [0.8,-0.65,65,1],
            [0,-0.75,108,1],
            [-0.4,-0.9,118,0.7],[0.4,-0.9,118,0.7],
            [-1.6,-0.2,38,0.8], [1.6,-0.2,38,0.8],
            [-0.15,-1,135,0.5], [0.15,-1,135,0.5],
            [-1.0,-1.0,50,0.9], [1.0,-1.0,50,0.9],
            [-0.7,-0.3,30,0.7], [0.7,-0.3,30,0.7],
            [-0.75,-0.75,62,1], [0.75,-0.75,62,1],
            [-1.2,-0.5,48,0.9], [1.2,-0.5,48,0.9],
            [-0.35,-0.95,85,1], [0.35,-0.95,85,1],
            [-1.8,0.1,33,0.8],  [1.8,0.1,33,0.8],
            [-1.3,-0.15,40,0.8],[1.3,-0.15,40,0.8],
            [-0.6,-0.5,55,0.9], [0.6,-0.5,55,0.9],
            [-0.1,-1,148,0.4],  [0.1,-1,148,0.4],
            [0,-1,125,0.6],
            [-0.5,-0.85,102,0.7],[0.5,-0.85,102,0.7],
            [-0.2,-0.98,92,0.8], [0.2,-0.98,92,0.8],
        ];
        const sparkCols  = ['#ffd700','#ffcc00','#ffff66','#ff9900','#fff5a0','#ffaa00'];
        const sparkBright = ['#ffffff','#ffffd0','#ffffe8'];
        const grav = 55, sp = 1 - slotFlashF;
        ctx.save();
        sparkDefs.forEach(([dx,dy,spd,fade],i) => {
            const sx = coinX + dx*spd*sp;
            const sy = slotY  + dy*spd*sp + grav*sp*sp;
            ctx.globalAlpha = Math.pow(slotFlashF, fade);
            ctx.fillStyle = spd>=90 ? sparkBright[i%sparkBright.length] : sparkCols[i%sparkCols.length];
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
            ctx.shadowColor = '#ffff00'; ctx.shadowBlur = 12;
            ct('INSERT COIN', CW/2, 344, '#ffff00', 14);
            ctx.shadowBlur = 0;
        }
        ctx.save();
        ctx.font = '10px "Press Start 2P"'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'center';
        ctx.fillStyle = '#888';
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
    c.font='14px "Press Start 2P"'; c.textAlign='right'; c.textBaseline='bottom';
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
    ct('NEW SNAKE TIMES', cx, py+41, '#141410', 18);
    // Masthead crest: the player's own snake flanks the title, facing inward
    const _logoCol=cfg.snakeColor||0, _logoSi=cfg.wornItems||{}, _logoY=py+40, _logoRx=px+pw-52;
    drawScoreHead(px+52, _logoY, _logoCol, _logoSi);
    ctx.save(); ctx.translate(_logoRx,0); ctx.scale(-1,1); ctx.translate(-_logoRx,0);
    drawScoreHead(_logoRx, _logoY, _logoCol, _logoSi); ctx.restore();
    ct('EXTRA * EXTRA * READ ALL ABOUT IT', cx, py+72, '#6a5f4a', 8);
    const pages=(ANNOUNCEMENT&&ANNOUNCEMENT.pages)||[ANNOUNCEMENT||{lines:[]}];
    const a=pages[Math.min(newsPage,pages.length-1)]||{lines:[]};
    ct(a.headline||'', cx, py+108, '#8a1810', 14);                  // headline
    let y=py+146;
    (a.lines||[]).forEach(line=>{ if(line===''){ y+=10; return; } ct(line, cx, y, '#2a281e', 10); y+=22; });
    if(pages.length>1){                                             // page flipper
        ct('< '+(newsPage+1)+' / '+pages.length+' >', cx, py+ph-20, '#6a5f4a', 8);
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
        ct(multi?'L/R:page   A/ESC:back':'A:back  ESC:back', CW/2, CH-12, '#888', 10); }
}
function drawSplashText(now) {
    if(!_splashText) return;
    ctx.save();
    ctx.translate(CW*0.78, 120); ctx.rotate(-0.34);
    ctx.scale(1+0.10*Math.abs(Math.sin(now/300)), 1+0.10*Math.abs(Math.sin(now/300)));
    ctx.font='10px "Press Start 2P"'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='#3a2a00'; ctx.fillText(_splashText, 1.5, 1.5);   // retro drop shadow
    ctx.fillStyle='#ffff00'; ctx.fillText(_splashText, 0, 0);
    ctx.restore();
}
// Static menu -> offscreen cache. Everything here changes only on an event.
function _composeMenu(diffLine){
    const c=_menuCtx;
    c.drawImage(_gridCanvas,0,0);
    c.drawImage(_scanCanvas,0,0);
    c.shadowColor='#7fff7f'; c.shadowBlur=38;
    ct('S N A K E',CW/2,78,'#7fff7f',40,c);
    c.shadowBlur=0;
    ct('F O K   E D I T I O N',CW/2,122,'#4a7a4a',10,c);
    const msp=MENU_ITEMS.length<=5?38:30;
    MENU_ITEMS.forEach((item,i)=>menuItem(item,162+i*msp,i===menuSel,c));
    if(ANNOUNCEMENT) _drawNewspaper(c, menuSel===MENU_ITEMS.length);
    ct(diffLine,CW/2,362,'#4a7a4a',10,c);
    c.save();
    c.font='10px "Press Start 2P"'; c.textBaseline='bottom'; c.shadowBlur=0;
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
    { label:'AUDIO', items:[
        { lbl:()=>'AUDIO: '+(cfg.music?'ON':'OFF'),
          act:()=>{cfg.music=!cfg.music;if(!cfg.music)Snd.musicStop();else{Snd.audioResume();Snd.sfxPlay('select',cfg.music);}updateMuteBtn();} },
        { lbl:()=>'AUDIO STYLE: '+(cfg.musicStyle===0?'NEW':'CLASSIC'),
          act:()=>{cfg.musicStyle=(cfg.musicStyle+1)%2;Snd.musicStop();Snd.sfxPlay('select',cfg.music);} },
        { lbl:()=>'VOLUME: '+Math.round((cfg.volume??1)*100)+'%', bar:'#7fff7f', frac:()=>cfg.volume??1,
          adj:(r)=>{cfg.volume=Math.max(0,Math.min(1,Math.round(((cfg.volume??1)+(r?0.1:-0.1))*10)/10));Snd.musicSetVolume(cfg.volume);} },
        { lbl:()=>'SFX VOL: '+Math.round((cfg.sfxVol??0.5)*100)+'%', bar:'#aaddff', frac:()=>cfg.sfxVol??0.5,
          adj:(r)=>{cfg.sfxVol=Math.max(0,Math.min(1,Math.round(((cfg.sfxVol??0.5)+(r?0.1:-0.1))*10)/10));Snd.sfxSetVolume(cfg.sfxVol);} },
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
    { label:'DATA MANAGEMENT', items:[
        { lbl:()=>'STRICTLY OFFLINE: '+(cfg.offline?'ON':'OFF'),
          act:()=>{cfg.offline=!cfg.offline;Snd.sfxPlay('select',cfg.music);} },
        { lbl:()=>'BACKUP STATS', act:()=>{Snd.sfxPlay('select',cfg.music);backupStats();} },
        { lbl:()=>'RESTORE STATS', act:()=>{Snd.sfxPlay('select',cfg.music);restoreStats();} },
        { lbl:()=>'RESET STATS', act:()=>{quitConfirmSel=1;phase='resetConfirm';} },
    ]},
];
function _settingsList(){ return settingsCat>=0 ? SETTINGS_CATS[settingsCat].items : SETTINGS_CATS; }
function drawSettings() {
    drawGrid(); drawOvBg(0.92);
    const inCat=settingsCat>=0;
    const title=inCat?'SETTINGS/'+SETTINGS_CATS[settingsCat].label:'SETTINGS';
    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=16; ct(title,CW/2,24,'#7fff7f',18); ctx.shadowBlur=0;
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
            ctx.save(); ctx.font='14px "Press Start 2P"';
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
        // Transient backup/restore feedback in DATA MANAGEMENT
        if(SETTINGS_CATS[settingsCat].label==='DATA MANAGEMENT'&&_dataMsg&&simNow-_dataMsgAt<2500)
            ct(_dataMsg,CW/2,CH-32,'#7fff7f',10);
    }
    const hint=inCat?'UP/DN:nav  L/R:change  A:select  ESC:back':'UP/DN:nav  A:open  ESC:back';
    ct(hint,CW/2,CH-10,'#888',10);
}

function drawMiniSnake(x, y, colorIdx) {
    const sc=SNAKE_COLORS[colorIdx||0];
    for(let k=0;k<5;k++){
        const frac=1-k/5, l=Math.round(10+frac*38);
        ctx.fillStyle=k===0?sc.head:`hsl(${sc.h},65%,${l}%)`;
        if(k===0){ctx.shadowColor=sc.head;ctx.shadowBlur=5;}
        else ctx.shadowBlur=0;
        ctx.fillRect(x+k*6,y-3,5,6);
    }
    ctx.shadowBlur=0;
}

function drawScoreHead(cx, cy, colorIdx, si) {
    const sc = SNAKE_COLORS[colorIdx || 0];
    const scale = 1;
    ctx.save();
    ctx.translate(cx - Math.round(CS*scale/2), cy - Math.round(CS*scale/2));
    ctx.scale(scale, scale);
    // Head body
    ctx.fillStyle = sc.head;
    ctx.shadowColor = sc.head; ctx.shadowBlur = 3;
    rr(1, 1, CS-2, CS-2, 5); ctx.fill(); ctx.shadowBlur = 0;
    // Eyes fixed facing right (dir irrelevant in scores screen)
    ctx.fillStyle = '#001500';
    ctx.fillRect(13, 2, 3, 3); ctx.fillRect(13, 16, 3, 3);
    // Accessories (back-to-front; shades/monocle inlined to avoid global dir dependency)
    if(si) {
        if(si.bow)     drawAccessoryBow(0, 0);
        if(si.necktie) drawAccessoryNecktie(0, 0);
        if(si.shades)  { ctx.fillStyle='#111'; [3.5,17.5].forEach(ey=>{ctx.beginPath();ctx.arc(14.5,ey,4,0,Math.PI*2);ctx.fill();}); }
        if(si.glasses3d){ [['#ff2a2a',3.5],['#22e0ff',17.5]].forEach(([c,ey])=>{ctx.fillStyle='#111';ctx.beginPath();ctx.arc(14.5,ey,4,0,Math.PI*2);ctx.fill();ctx.fillStyle=c;ctx.beginPath();ctx.arc(14.5,ey,2.6,0,Math.PI*2);ctx.fill();}); }
        if(si.monocle) { ctx.strokeStyle='#ccc'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.arc(14.5,3.5,3.5,0,Math.PI*2); ctx.stroke(); }
        if(si.eyepatch){ ctx.fillStyle='#0a0a0a'; ctx.beginPath(); ctx.ellipse(14.5,3.5,3.4,3,0,0,Math.PI*2); ctx.fill(); }
        if(si.propeller)drawAccessoryPropeller(0, 0);
        if(si.wizard)   drawAccessoryWizard(0, 0);
        if(si.cylinder) drawAccessoryCylinder(0, 0);
        if(si.crown)    drawAccessoryCrown(0, 0);
        if(si.admincrown)drawAccessoryAdmincrown(0, 0);
        if(si.halo)     drawAccessoryHalo(0, 0);
    }
    ctx.restore();
}

let _scoreboardCache = null;
function drawScores() {
    drawGrid(); drawOvBg(0.92);
    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=16; ct('HIGH SCORES',CW/2,28,'#7fff7f',18); ctx.shadowBlur=0;
    const scores=_scoreboardCache||[];
    if(!scores.length){ ct('No scores yet!',CW/2,CH/2,'#aaa',10); }
    else {
        ctx.font='14px "Press Start 2P"'; ctx.textBaseline='middle';
        scores.slice(0,8).forEach((s,i)=>{
            const y=90+i*28;
            ctx.fillStyle=i===0?'#ffd700':i<3?'#dddddd':'#aaaaaa';
            const diff=['E','N','H'][s.diff??1]??'N';
            ctx.textAlign='left';  ctx.fillText(String(s.name||'???').slice(0,MAX_NAME), 24, y);
            ctx.textAlign='right'; ctx.fillText(String(s.score), 348, y);
            ctx.textAlign='left';  ctx.fillText(`${diff}/${s.level}`, 360, y);
            ctx.textAlign='left';  ctx.fillText(s.date||'--.--.--', 418, y);
            drawScoreHead(568, y, s.color||0, s.shopItems||{});
        });
        ctx.textAlign='center';
    }
    ct('A:back',CW/2,CH-14,'#888',10);
}

function drawAchievements() {
    drawGrid(); drawOvBg(0.92);
    const donated=!!(cfg.shopItems&&cfg.shopItems['donate']);
    const allBase=ACHIEVEMENTS.every(a=>achUnlocked[a.id]);
    const expert=donated&&allBase;
    const onExpert=expert&&achPage===0;
    const list=onExpert?EXPERT_ACHIEVEMENTS:ACHIEVEMENTS;
    const titleColor=onExpert?'#ff8800':'#7fff7f';
    ctx.shadowColor=titleColor; ctx.shadowBlur=16; ct('ACHIEVEMENTS',CW/2,28,titleColor,18); ctx.shadowBlur=0;
    if(expert){
        ct(onExpert?'< EXPERT  1/2 >':'< BASE  2/2 >',CW/2,42,onExpert?'#ffaa44':'#7fff7f',10);
    } else if(allBase&&!donated){
        ct('DONATE in SHOP to unlock EXPERT page',CW/2,42,'#ff4488',10);
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
        ctx.font='10px "Press Start 2P"';
        ctx.fillStyle=got?'#7fff7f':'#888888';
        ctx.fillText(a.name,x+26,y+10);
        ctx.font='10px "Press Start 2P"';
        ctx.fillStyle=got?'#6aaa6a':'#777777';
        const _mw=aw-32; let _d1=a.desc,_d2='';
        if(ctx.measureText(_d1).width>_mw){
            const _ws=a.desc.split(' '); let _l='';
            for(const _w of _ws){const _t=_l?_l+' '+_w:_w;if(ctx.measureText(_t).width<=_mw)_l=_t;else{_d2=a.desc.slice(_l.length+1);break;}}_d1=_l;
        }
        ctx.fillText(_d1,x+26,y+28);
        if(_d2) ctx.fillText(_d2,x+26,y+42);
    });
    ctx.textAlign='center'; ctx.textBaseline='middle';
    const total=list.filter(a=>achUnlocked[a.id]).length;
    ctx.shadowColor='#6aaa6a'; ctx.shadowBlur=6; ct(`${total} / ${list.length} UNLOCKED`,CW/2,CH-26,'#6aaa6a',10); ctx.shadowBlur=0;
    const hint='A:back';
    ct(hint,CW/2,CH-10,'#888',10);
}

function drawAchPopups(now) {
    confetti=confetti.filter(c=>{
        c.life++; c.x+=c.vx; c.y+=c.vy; c.vy+=0.05; c.rot+=c.vrot;
        if(c.life>=c.maxLife||c.y>CH+20) return false;
        const a=c.life<15?c.life/15:c.life>c.maxLife-25?1-(c.life-(c.maxLife-25))/25:1;
        ctx.save(); ctx.globalAlpha=a; ctx.translate(c.x,c.y); ctx.rotate(c.rot);
        ctx.fillStyle=c.color; ctx.fillRect(-c.w/2,-c.h/2,c.w,c.h);
        ctx.restore(); return true;
    });
    const DUR=3800, FADE_IN=280, FADE_OUT=500;
    achPopups=achPopups.filter(p=>now-p.at<DUR);
    achPopups.forEach((p,i)=>{
        const a=ACHIEVEMENTS.find(ac=>ac.id===p.id)||EXPERT_ACHIEVEMENTS.find(ac=>ac.id===p.id); if(!a) return;
        const age=now-p.at;
        const alpha=Math.min(1,age/FADE_IN)*(age>DUR-FADE_OUT?Math.max(0,1-(age-(DUR-FADE_OUT))/FADE_OUT):1);
        const slide=Math.max(0,(1-age/FADE_IN)*70);
        const pw=170,ph=44,px=CW-pw-4+slide,py=8+i*(ph+4);
        ctx.save(); ctx.globalAlpha=alpha;
        ctx.fillStyle='#071407'; rr(px,py,pw,ph,5); ctx.fill();
        ctx.strokeStyle='#4aaa4a'; ctx.lineWidth=1.5; rr(px,py,pw,ph,5); ctx.stroke();
        ctx.shadowColor='#7fff7f'; ctx.shadowBlur=6;
        ctx.fillStyle='#7fff7f'; ctx.font='10px "Press Start 2P"';
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.fillText('ACHIEVEMENT!',px+28,py+7);
        ctx.shadowBlur=0;
        ctx.fillStyle='#aaffaa'; ctx.font='10px "Press Start 2P"';
        ctx.fillText(a.name,px+28,py+20);
        ctx.fillStyle='#ffd700'; ctx.font='10px "Press Start 2P"';
        ctx.fillText('+1,000 FK',px+28,py+31);
        drawPixelIcon(px+5,py+ph/2-8,a.icon,2);
        ctx.restore();
    });
    ctx.textAlign='center'; ctx.textBaseline='middle';
}

// Shop tabs: 0,1 = cosmetics; 2 = BOX GEAR (box-won cosmetics, wearable); 3 = mystery boxes.
const SHOP_PAGES = 4, GEAR_PAGE = 2, BOX_PAGE = 3;
function _gearList(){ const si=cfg.shopItems||{}; return BOX_ITEMS.filter(b=>si[b.id]); }
let _boxOpenAt = 0, _boxReward = null;
// ADMIN box: surfaces on the boxes tab once every ADMIN_BOX_EVERY shop opens, then is
// consumed for the run once claimed. _boxList() appends it only while available.
let _adminAvail = false, _adminConsumed = false;
function _boxList(){ return (_adminAvail && !_adminConsumed) ? BOXES.concat([ADMIN_BOX]) : BOXES; }
// Enter the shop: count the open, decide whether the ADMIN box is up this visit, and
// jump straight to it (boxes tab, selected) when it is so the grand prize is unmissable.
function _enterShop(){
    cfg.shopOpens = (cfg.shopOpens||0) + 1;
    _adminAvail = (cfg.shopOpens % ADMIN_BOX_EVERY === 0);
    _adminConsumed = false;
    phase='shop'; purchaseAnimAt=0;
    shopPage = _adminAvail ? BOX_PAGE : 0;
    shopSel  = _adminAvail ? BOXES.length : 0;
    saveCfg();
}
function _findItem(id){ return SHOP_ITEMS.find(i=>i.id===id) || BOX_ITEMS.find(i=>i.id===id); }
const _RARITY_COL = { common:'#9aa0a6', rare:'#4a90d9', epic:'#9b59b6', legendary:'#f1c40f' };
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
    const coins=_cachedFOKoins, startY=72, rowH=52;
    _boxList().forEach((box,i)=>{
        const y=startY+i*rowH, sel=i===shopSel, isAdmin=box.id==='admin';
        const canAfford=isAdmin||coins>=box.price, bc=isAdmin?'#ffd700':box.color;
        ctx.fillStyle=sel?(isAdmin?'rgba(60,42,10,0.75)':'rgba(45,45,45,0.7)'):(isAdmin?'rgba(40,26,6,0.5)':'rgba(10,10,10,0.35)');
        rr(8,y,CW-16,rowH-6,5); ctx.fill();
        if(isAdmin){ ctx.shadowColor='#ffd700'; ctx.shadowBlur=sel?14:8; }
        ctx.strokeStyle=sel?bc:(isAdmin?'#caa100':'#3a3a3a'); ctx.lineWidth=sel?2:(isAdmin?1.8:1.2); rr(8,y,CW-16,rowH-6,5); ctx.stroke();
        ctx.shadowBlur=0;
        _drawBoxIcon(18,y+8,box,28);
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.font='12px "Press Start 2P"'; ctx.fillStyle=bc; ctx.fillText(box.name+' BOX',60,y+10);
        ctx.font='9px "Press Start 2P"'; ctx.fillStyle=isAdmin?'#ffcf55':'#999999';
        ctx.fillText(isAdmin?'GRAND PRIZE - guaranteed ADMIN CROWN':'Rarer loot at higher tiers',60,y+28);
        ctx.textAlign='right';
        ctx.font='11px "Press Start 2P"'; ctx.fillStyle=isAdmin?'#5aff8a':(canAfford?'#ffd700':'#553322');
        ctx.fillText(isAdmin?'FREE':box.price.toLocaleString()+' FK',CW-18,y+11);
        if(sel){ ctx.font='9px "Press Start 2P"'; ctx.fillStyle=canAfford?'#5aaa5a':'#cc6644';
            ctx.fillText(canAfford?(isAdmin?'ENTER to claim':'ENTER to open'):'Not enough FK',CW-18,y+29); }
    });
}
// Owned box-exclusive cosmetics, wearable here (they don't fit the buyable cosmetics tabs).
function _drawGearPage(){
    const wi=cfg.wornItems||{}, gear=_gearList();
    if(!gear.length){
        ct('NO BOX GEAR YET',CW/2,CH/2-16,'#888888',12);
        ct('Win exclusive cosmetics from Mystery Boxes',CW/2,CH/2+10,'#9b6ad0',8);
        return;
    }
    const startY=72, rowH=44;
    gear.forEach((item,i)=>{
        const y=startY+i*rowH, sel=i===shopSel, worn=!!wi[item.id], rc=_RARITY_COL[item.rarity]||'#7fff7f';
        ctx.fillStyle=worn?(sel?'rgba(40,64,40,0.7)':'rgba(20,48,20,0.5)'):(sel?'rgba(20,40,55,0.7)':'rgba(10,25,40,0.5)');
        rr(8,y,CW-16,rowH-4,5); ctx.fill();
        ctx.strokeStyle=worn?'#7fff7f':rc; ctx.lineWidth=1.5; rr(8,y,CW-16,rowH-4,5); ctx.stroke();
        drawPixelIcon(16,y+(rowH-4)/2-8,item.icon,2);
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.font='10px "Press Start 2P"'; ctx.fillStyle=worn?'#7fff7f':'#dddddd'; ctx.fillText(item.name,46,y+7);
        ctx.font='10px "Press Start 2P"'; ctx.fillStyle=rc; ctx.fillText((item.rarity||'').toUpperCase()+' - BOX EXCLUSIVE',46,y+21);
        ctx.textAlign='right';
        ctx.font='10px "Press Start 2P"'; ctx.fillStyle=worn?'#7fff7f':'#4a7a9a'; ctx.fillText(worn?'WORN':'OWNED',CW-18,y+9);
        if(sel){ ctx.font='10px "Press Start 2P"'; ctx.fillStyle=worn?'#cc5555':'#5aaa5a'; ctx.fillText(worn?'SPACE to remove':'SPACE to wear',CW-18,y+23); }
    });
    ctx.textAlign='center'; ctx.textBaseline='middle';
}
// Buy + open a box: deduct, roll, grant (item / dupe-sell / coins), trigger reveal.
function _openBox(box){
    if(box.id==='admin'){
        const si=cfg.shopItems||(cfg.shopItems={});
        _adminConsumed=true;
        if(si.admincrown){ const refund=Math.round(_boxItemValue('admincrown')*0.5); addFOKoins(refund); _boxReward={kind:'dupe',id:'admincrown',refund}; }
        else { si.admincrown=true; _boxReward={kind:'item',id:'admincrown',rarity:'legendary'}; }
        saveCfg(); _boxOpenAt=simNow; Snd.sfxPlay('perfect',cfg.music); return;
    }
    if(_cachedFOKoins < box.price){ Snd.sfxPlay('fail',cfg.music); return; }
    _cachedFOKoins -= box.price; try{ localStorage.setItem(FK_KEY,String(_cachedFOKoins)); }catch{}
    const res=rollBox(box);
    if(res.type==='coins'){ addFOKoins(res.amount); _boxReward={kind:'coins',amount:res.amount}; }
    else {
        const si=cfg.shopItems||(cfg.shopItems={});
        if(si[res.id]){ const refund=Math.round(_boxItemValue(res.id)*0.5); addFOKoins(refund); _boxReward={kind:'dupe',id:res.id,refund}; }
        else { si[res.id]=true; if(SHOP_ITEMS.filter(s=>!s.repeatable).every(s=>si[s.id])) unlockAch('shop_full'); _boxReward={kind:'item',id:res.id,rarity:res.rarity}; }
    }
    saveCfg();
    _boxOpenAt=simNow;
    Snd.sfxPlay(_boxReward.kind==='item'?'perfect':'bonus',cfg.music);
}
function _drawBoxReveal(){
    const age=simNow-_boxOpenAt;
    if(!(_boxOpenAt>0 && age<2400 && _boxReward)) return;
    if(age<220){ ctx.save(); ctx.globalAlpha=(1-age/220)*0.55; ctx.fillStyle='#ffe860'; ctx.fillRect(0,0,CW,CH); ctx.restore(); }
    const fade=age<150?age/150:age>2000?Math.max(0,1-(age-2000)/400):1;
    ctx.save(); ctx.globalAlpha=fade; drawOvBg(0.55);
    const r=_boxReward;
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=18;
    if(r.kind==='coins'){ ct('YOU GOT',CW/2,CH/2-18,'#aaa',10); ct('+'+r.amount.toLocaleString()+' FK',CW/2,CH/2+8,'#ffd700',18); }
    else if(r.kind==='dupe'){ ct('DUPLICATE - SOLD',CW/2,CH/2-16,'#aaaaaa',11); ct('+'+r.refund.toLocaleString()+' FK',CW/2,CH/2+12,'#ffd700',14); }
    else { const it=_findItem(r.id), rc=_RARITY_COL[r.rarity]||'#fff';
        if(it&&it.icon) drawPixelIcon(CW/2-16,CH/2-46,it.icon,4);
        ct((r.rarity||'').toUpperCase(),CW/2,CH/2+10,rc,10);
        ct(it?it.name:r.id,CW/2,CH/2+30,'#ffffff',12); }
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
        ct(labels[i], tx+tabW/2, tabY+tabH/2+1, active?txt[i]:'#666666', 8);
    }
}
function drawShop() {
    drawGrid(); drawOvBg(0.92);
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=16; ct('SHOP',CW/2,26,'#ffd700',18); ctx.shadowBlur=0;
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
        ctx.font='10px "Press Start 2P"';
        ctx.fillStyle=worn?'#7fff7f':(owned&&isRep)?'#ff66aa':owned?'#5a8aaa':sel?'#dddddd':'#aaaaaa';
        ctx.fillText(item.name,46,y+7);
        ctx.font='10px "Press Start 2P"'; ctx.fillStyle='#999999';
        ctx.fillText(item.desc,46,y+21);
        ctx.textAlign='right';
        if(isRep){
            if(owned){ctx.font='10px "Press Start 2P"';ctx.fillStyle='#ff44aa';ctx.fillText('DONATED',CW-18,y+9);}
            else{ctx.font='10px "Press Start 2P"';ctx.fillStyle=canAfford?'#ffd700':'#553322';ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+9);}
            ctx.font='10px "Press Start 2P"';
            if(sel){ctx.fillStyle=canAfford?'#5aaa5a':'#cc6644';ctx.fillText(canAfford?'ENTER to donate':'Not enough FK',CW-18,y+23);}
            else if(owned){ctx.fillStyle='#555';ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+23);}
        } else if(owned){
            ctx.font='10px "Press Start 2P"';
            ctx.fillStyle=worn?'#7fff7f':'#4a7a9a';
            ctx.fillText(worn?'WORN':'OWNED',CW-18,y+9);
            ctx.font='10px "Press Start 2P"';
            if(sel){ctx.fillStyle=worn?'#cc5555':'#5aaa5a';ctx.fillText(worn?'SPACE to remove':'SPACE to wear',CW-18,y+23);}
            else{ctx.fillStyle='#555';ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+23);}
        } else {
            ctx.font='10px "Press Start 2P"'; ctx.fillStyle=canAfford?'#ffd700':'#553322';
            ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+9);
            if(sel){ctx.font='10px "Press Start 2P"';ctx.fillStyle=canAfford?'#5aaa5a':'#cc6644';
                ctx.fillText(canAfford?'ENTER to buy':'Not enough FK',CW-18,y+23);}
        }
    });
    }
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=6;
    ct(`BALANCE: ${coins.toLocaleString()} FK`,CW/2,CH-30,'#ffd700',10);
    ctx.shadowBlur=0;
    ct(shopPage===BOX_PAGE ? 'UP/DN:nav  L/R:tab  A:open  ESC:back'
       : shopPage===GEAR_PAGE ? 'UP/DN:nav  L/R:tab  A/||:wear  ESC:back'
       : 'UP/DN:nav  L/R:tab  A:buy  ||:wear  ESC:back',CW/2,CH-12,'#888',10);
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
        ctx.shadowColor='#7fff7f';ctx.shadowBlur=16;
        ct('PURCHASED!',CW/2,CH/2+20,'#7fff7f',18);
        ctx.restore();
    }
    _drawBoxReveal();
}

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
                    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=38;
                    ct(val, CW/2, yc, '#7fff7f', 40); ctx.shadowBlur=0; break;
                case 'sub':
                    ct(val, CW/2, yc, '#4a7a4a', 8); break;
                case 'hdr':
                    ctx.shadowColor='#00cccc'; ctx.shadowBlur=6;
                    ct(val, CW/2, yc, '#00cccc', 14); ctx.shadowBlur=0; break;
                case 'txt':
                    ct(val, CW/2, yc, '#aaa', 14); break;
                case 'sml':
                    ct(val, CW/2, yc, '#999', 14); break;
                case 'coins':
                    ctx.shadowColor='#ffd700'; ctx.shadowBlur=6;
                    ct(`YOUR FOKOINS: ${_cachedFOKoins.toLocaleString()}`, CW/2, yc, '#ffd700', 14);
                    ctx.shadowBlur=0; break;
                case 'secret':
                    ctx.shadowColor='#ff4444'; ctx.shadowBlur=14;
                    ct(val, CW/2, yc, '#ff5555', 14);
                    ctx.shadowBlur=0; break;
            }
        }
        y += h;
    }
    ctx.restore();
    creditsScroll -= creditsSpeed;
    if (creditsScroll < -CRED_TOTAL_H) creditsScroll = CH + 40;  // loop
    ct('UP:slow  DN:fast  ||:pause  A:exit', CW/2, CH-12, '#888', 10);
}

function drawNameEntry(now) {
    drawGrid();
    if(bars)  { _prepBars(false); bars.forEach(b=>drawBar(b)); }
    if(_gourangaActive) _drawGourangaPending(now);
    if(gem)   drawGem(gem,now);
    if(snake) drawSnake(false);
    drawOvBg(0.84);
    const isWin=nameReason==='win';
    ctx.shadowColor=isWin?'#ffd700':'#ff5555'; ctx.shadowBlur=24;
    ct(isWin?'YOU WIN!':'GAME OVER',CW/2,36,isWin?'#ffd700':'#ff5555',26); ctx.shadowBlur=0;
    ct(`SCORE: ${score}   LEVEL: ${level}`,CW/2,76,'#aaa',10);
    ct('ENTER YOUR NAME:',CW/2,104,'#7fff7f',10);
    const sw=30,sh=40,gap=5,totalW=MAX_NAME*(sw+gap)-gap,sx0=Math.floor(CW/2-totalW/2),sy=122;
    for(let i=0;i<MAX_NAME;i++){
        const sx=sx0+i*(sw+gap),act=i===nameCursorPos,has=i<nameStr.length&&!act;
        ctx.fillStyle=act?'#142014':'#0d0d18'; ctx.strokeStyle=act?'#7fff7f':'#2a2a3a'; ctx.lineWidth=act?1.5:1;
        rr(sx,sy,sw,sh,3); ctx.fill(); ctx.stroke();
        const flashing=has&&i===_nameFlashPos&&now-_nameFlashAt<350;
        if(has){ ctx.shadowColor='#7fff7f'; ctx.shadowBlur=flashing?14:1; if(nameStr[i]===' '){ctx.shadowBlur=0;ctx.fillStyle=flashing?'#ffffff':'#4a7a4a';ctx.fillRect(sx+8,sy+sh-12,sw-16,2);}else{ct(nameStr[i],sx+sw/2,sy+sh/2,flashing?'#ffffff':'#7fff7f',14);} ctx.shadowBlur=0; }
        else if(act){
            const gc=NAME_CHARS[nameCharIdx]; ctx.globalAlpha=0.42; if(gc===' '){ctx.fillStyle='#7fff7f';ctx.fillRect(sx+8,sy+sh-12,sw-16,2);}else{ct(gc==='\r'?'\u21B5':gc,sx+sw/2,sy+sh/2,'#7fff7f',14);} ctx.globalAlpha=1;
            if(Math.floor(now/400)%2===0){ctx.fillStyle='#7fff7f55';ctx.fillRect(sx+5,sy+sh-6,sw-10,2);}
        }
    }
    const selY=sy+sh+90,ci=nameCharIdx;
    {
        ctx.fillStyle='#0d1e0d'; rr(CW/2-20,selY-12,40,22,3); ctx.fill();
        ctx.strokeStyle='#2a5a2a'; ctx.lineWidth=1; rr(CW/2-20,selY-12,40,22,3); ctx.stroke();
        for(let d=-2;d<=2;d++){
            const raw=NAME_CHARS[(ci+d+NAME_CHARS.length)%NAME_CHARS.length];
            const y=selY+d*22, sz=d===0?14:8;
            const col=d===0?'#7fff7f':Math.abs(d)===1?'#888':'#555';
            const al=d===0?1:Math.abs(d)===2?0.35:0.75;
            if(d===0){ctx.shadowColor='#7fff7f';ctx.shadowBlur=12;}
            ctx.globalAlpha=al;
            if(raw===' '){
                // spacebar visual: horizontal bar
                const bw=d===0?22:14;
                ctx.fillStyle=col;
                ctx.fillRect(Math.round(CW/2-bw/2),Math.round(y+sz*0.35),bw,2);
            } else if(raw==='\r'){
                // enter key: symbol inside a key-shaped box
                const bw=d===0?28:20,bh=d===0?20:14;
                ctx.strokeStyle=col; ctx.lineWidth=1;
                rr(Math.round(CW/2-bw/2),Math.round(y-bh/2),bw,bh,2); ctx.stroke();
                ct('\u21B5',CW/2,y,col,sz);
            } else {
                ct(raw,CW/2,y,col,sz);
            }
            ctx.globalAlpha=1;
            if(d===0){ctx.shadowBlur=0;}
        }
        ctx.fillStyle='rgba(127,255,127,0.45)';
        const ax=CW/2,uay=selY-2*22-18,day=selY+2*22+18;
        ctx.beginPath(); ctx.moveTo(ax,uay-5); ctx.lineTo(ax-6,uay+3); ctx.lineTo(ax+6,uay+3); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(ax,day+5); ctx.lineTo(ax-6,day-3); ctx.lineTo(ax+6,day-3); ctx.closePath(); ctx.fill();
    }
    ct('UP/DN:letter  L/R:move  A:place  RETURN=submit  ESC:del',CW/2,CH-10,'#888',10);
}

function _drawGourangaPending(now) {
    for(let i=0;i<_gourangaLine.length;i++){
        if(_gourangaEaten.has(i)) continue;
        const g=_gourangaLine[i], gx=g.x*CS+CS/2, gy=g.y*CS+CS/2, r=CS/2-3;
        ctx.save(); ctx.translate(gx,gy);
        ctx.shadowColor='#ff8800'; ctx.shadowBlur=8; ctx.fillStyle='#ff8800';
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,r); ctx.lineTo(-r*0.65,0); ctx.closePath(); ctx.fill();
        ctx.restore();
    }
}
function _drawHeart(now) {
    if(heartIsEarly&&now-heartAt>8500&&Math.floor(now/180)%2===0) return;
    const pulse=0.85+0.15*Math.sin((now-heartAt)/220);
    const cx=heart.x*CS+CS/2, cy=heart.y*CS+CS/2;
    const s=pulse*(CS/2-2)/3.5;
    ctx.save(); ctx.translate(cx,cy); ctx.scale(s,s);
    ctx.shadowColor='#ff4499'; ctx.shadowBlur=10; ctx.fillStyle='#ff2266';
    ctx.beginPath();
    ctx.moveTo(0,1); ctx.bezierCurveTo(0,-1,-3.5,-4,-3.5,-2);
    ctx.bezierCurveTo(-3.5,0.5,0,3.5,0,3.5);
    ctx.bezierCurveTo(0,3.5,3.5,0.5,3.5,-2);
    ctx.bezierCurveTo(3.5,-4,0,-1,0,1);
    ctx.fill(); ctx.restore();
}
function _drawCrushEffects(now) {
    _crushEffects=_crushEffects.filter(e=>{
        const age=now-e.at, dur=600;
        if(age>=dur) return false;
        const t=age/dur, cx=e.x*CS+CS/2, cy=e.y*CS+CS/2;
        if(age<110){
            ctx.save(); ctx.globalAlpha=(1-age/110)*0.85;
            ctx.fillStyle='#ffaa44'; ctx.fillRect(e.x*CS,e.y*CS,CS,CS);
            ctx.restore();
        }
        e.pts.forEach(p=>{
            const px=cx+Math.cos(p.ang)*p.spd*t*22;
            const py=cy+Math.sin(p.ang)*p.spd*t*22+220*t*t;
            ctx.globalAlpha=(1-t)*0.92; ctx.fillStyle=p.col;
            const s=p.sz*(1-t*0.45);
            ctx.fillRect(px-s/2,py-s/2,s,s);
        });
        ctx.globalAlpha=1; return true;
    });
}
function _drawPowerPellet(now) {
    const pulse=0.8+0.2*Math.sin((now-powerPelletAt)/220);
    const cx=powerPellet.x*CS+CS/2, cy=powerPellet.y*CS+CS/2, r=(CS/2-2)*pulse;
    const hue=(now/7)%360;
    ctx.save();
    ctx.shadowColor=`hsl(${hue},100%,70%)`; ctx.shadowBlur=14;
    ctx.fillStyle=`hsl(${hue},100%,82%)`;
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
    ctx.restore();
}
function _drawTimeCrystal(now) {
    const cx=timeCrystal.x*CS+CS/2, cy=timeCrystal.y*CS+CS/2, t=(now-timeCrystalAt)/1000;
    const r=(CS/2-2)*(1+0.12*Math.sin(t*4));
    ctx.save(); ctx.translate(cx,cy);
    const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.4);
    grd.addColorStop(0,'rgba(120,220,255,0.30)'); grd.addColorStop(1,'rgba(120,220,255,0)');
    ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.4,0,Math.PI*2); ctx.fill();
    ctx.shadowColor='#88e0ff'; ctx.shadowBlur=14;
    const fg=ctx.createLinearGradient(0,-r,0,r);
    fg.addColorStop(0,'#ffffff'); fg.addColorStop(0.4,'#88ddff'); fg.addColorStop(1,'#3388cc');
    ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.7,0); ctx.lineTo(0,r); ctx.lineTo(-r*0.7,0); ctx.closePath();
    ctx.fillStyle=fg; ctx.fill(); ctx.shadowBlur=0;
    // Sweeping clock hand (one turn per 2s)
    const a=-Math.PI/2+((t%2)/2)*Math.PI*2;
    ctx.strokeStyle='rgba(20,40,70,0.85)'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*r*0.5,Math.sin(a)*r*0.5); ctx.stroke();
    ctx.fillStyle='#12345a'; ctx.beginPath(); ctx.arc(0,0,1.4,0,Math.PI*2); ctx.fill();
    ctx.restore();
}
function drawGameBoard(now) {
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
    const dying=phase==='dying',flash=dying&&Math.floor((now-phaseAt)/85)%2===1;
    const protect=phase==='playing'&&(now-spawnAt<SPAWN_PROTECT);
    if(protect&&Math.floor(now/130)%2===1) ctx.globalAlpha=0.22;
    drawSnake(flash);
    ctx.globalAlpha=1;
    // Fireworks particles (perfect level)
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
    if(phase==='levelDone'){
        const a=Math.min(1,(now-phaseAt)/150);
        ctx.save(); ctx.globalAlpha=a; ctx.shadowColor='#7fff7f'; ctx.shadowBlur=16;
        ct('LEVEL COMPLETE!',CW/2,levelWasPerfect?CH/2-36:CH/2-18,'#7fff7f',18); ctx.restore();
        if(levelWasPerfect){
            const pa=Math.min(1,(now-phaseAt-180)/200);
            if(pa>0){
                ctx.save(); ctx.globalAlpha=pa;
                ctx.shadowColor='#ffd700'; ctx.shadowBlur=12;
                ct('PERFECT LEVEL!',CW/2,CH/2+2,'#ffd700',14);
                ctx.shadowBlur=0;
                ct(`+${(level*1000).toLocaleString()} BONUS`,CW/2,CH/2+22,'#ffaa00',10);
                ctx.restore();
            }
        }
        if(levelDoneWaiting&&Math.floor(now/520)%2===0){
            ctx.save(); ctx.font='10px "Press Start 2P"'; ctx.textBaseline='bottom'; ctx.textAlign='center'; ctx.shadowBlur=0;
            ctx.fillStyle='#888'; ctx.fillText('A:next  TAP:next',CW/2,CH-8); ctx.restore();
        }
    }
    if(phase==='levelReady'){
        const t=now-phaseAt, goPhase=t>=READY_DUR;
        drawOvBg(0.72);
        if(!goPhase){
            ctx.shadowColor='#7fff7f'; ctx.shadowBlur=16;
            ct(`LEVEL ${level}`,CW/2,CH/2-18,'#7fff7f',18); ctx.shadowBlur=0;
            ctx.shadowColor='#aaa'; ctx.shadowBlur=12;
            ct('GET READY',CW/2,CH/2+38,'#aaa',14);
        } else {
            const a=Math.min(1,(t-READY_DUR)/80);
            ctx.save(); ctx.globalAlpha=a; ctx.shadowColor='#ffff44'; ctx.shadowBlur=24;
            ct('GO!',CW/2,CH/2+10,'#ffff44',26); ctx.shadowBlur=0; ctx.restore();
        }
    }
    if(dying){
        const t=(now-phaseAt)/DEATH_DUR;
        ctx.save(); ctx.globalAlpha=Math.min(1,t*2.5); ctx.shadowColor='#ff4444';
        if(lives===0){ctx.shadowBlur=24;ct(deathMsg,CW/2,CH/2,'#ff5555',26);}
        else{ctx.shadowBlur=16;ct(deathMsg,CW/2,CH/2,'#ff5555',18);}
        ctx.restore();
    }
    if(phase==='paused'){
        drawOvBg(0.55);
        ctx.shadowColor='#7fff7f'; ctx.shadowBlur=24;
        ct('PAUSED',CW/2,CH/2+10,'#7fff7f',26); ctx.shadowBlur=0;
        ctx.save(); ctx.font='10px "Press Start 2P"'; ctx.textBaseline='bottom'; ctx.textAlign='center'; ctx.shadowBlur=0;
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
        const sz=isGouranga?32:isEpic?26:14;
        ctx.save(); ctx.globalAlpha=a;
        ctx.shadowColor=col; ctx.shadowBlur=isGouranga?36:isEpic?24:12;
        ct(bonusLabel,CW/2,CH/2-60,col,sz);
        ctx.restore();
    }
    updateHUD();
}

function drawConfirmYesNo(title, sel) {
    const YES_X=CW/2-80, NO_X=CW/2+80;
    ctx.shadowColor='#ff9900'; ctx.shadowBlur=16;
    ct(title,CW/2,CH/2-18,'#ff9900',18); ctx.shadowBlur=0;
    ctx.globalAlpha=sel===0?1:0.35;
    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=sel===0?12:1;
    ct(sel===0?'> YES <':'  YES  ',YES_X,CH/2+38,'#7fff7f',14);
    ctx.globalAlpha=sel===1?1:0.35;
    ctx.shadowColor='#ff5555'; ctx.shadowBlur=sel===1?12:1;
    ct(sel===1?'> NO <':'  NO   ',NO_X,CH/2+38,'#ff5555',14);
    ctx.globalAlpha=1; ctx.shadowBlur=0;
    ctx.save(); ctx.font='10px "Press Start 2P"'; ctx.textBaseline='bottom'; ctx.textAlign='center';
    ctx.fillStyle='#888'; ctx.fillText('L/R:choose  A:ok  ESC:cancel',CW/2,CH-8); ctx.restore();
}
function drawQuitConfirm() {
    drawGrid();
    if(bars)  ctx.drawImage(_barsCanvas, 0, 0);
    if(gem)   drawGem(gem, simNow);
    if(snake) drawSnake(false);
    drawOvBg(0.72);
    drawConfirmYesNo('QUIT TO MENU?', quitConfirmSel);
    showHUD(false);
}
function drawResetConfirm() {
    drawSettings();
    drawOvBg(0.80);
    ctx.shadowColor='#ff5555'; ctx.shadowBlur=12;
    ct('RESET ALL STATS?',CW/2,CH/2-54,'#ff5555',14); ctx.shadowBlur=0;
    ctx.font='10px "Press Start 2P"'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='#888';
    ctx.fillText('scores  fokoins  achievements  shop',CW/2,CH/2-24);
    drawConfirmYesNo('', quitConfirmSel);
}
function resetStats() {
    const keys = [HS_KEY, FK_KEY, ACH_KEY, 'lastSName'];
    keys.forEach(k=>{ try { localStorage.removeItem(k); } catch {} });
    _cachedFOKoins = 0;
    achUnlocked = {}; achPopups = []; _scoreboardCache = null;
    cfg.shopItems = {}; cfg.wornItems = null; saveCfg();
}

// ---- Mystery box loot (META: uses Math.random, NOT the seeded sim RNG -- never
// affects gameplay determinism or leaderboard replay). All loot is cosmetic. ----
function _boxItemValue(id){
    const s=SHOP_ITEMS.find(i=>i.id===id); if(s) return s.price;
    const b=BOX_ITEMS.find(i=>i.id===id); if(b) return b.value;
    return 0;
}
function _boxLootPool(rarity, admin){
    const pool=[];
    for(const it of SHOP_ITEMS) if(!it.repeatable && ITEM_RARITY[it.id]===rarity) pool.push(it.id);
    for(const it of BOX_ITEMS) if(it.rarity===rarity && (admin || !it.admin)) pool.push(it.id);
    return pool;
}
function _boxCoinsAvg(box){ return box.price*0.35; }   // mean of the coins-filler reward
// Expected loot value for a fresh player (no dupes). test/box-odds.js asserts price > EV.
function boxEV(box){
    let ev = box.odds.coins * _boxCoinsAvg(box);
    for(const r of ['common','rare','epic','legendary']){
        const pool=_boxLootPool(r,false);
        if(!pool.length || !box.odds[r]) continue;
        ev += box.odds[r] * (pool.reduce((s,id)=>s+_boxItemValue(id),0)/pool.length);
    }
    return ev;
}
// Roll one outcome. Pity: after BOX_PITY consecutive junk pulls (coins/common) the next
// pull is forced to epic/legendary. Returns {type:'coins',amount} or {type:'item',id,rarity}.
function rollBox(box){
    let outcome;
    if((cfg.boxPity||0) >= BOX_PITY){
        cfg.boxPity = 0;
        outcome = Math.random()<0.25 ? 'legendary' : 'epic';
    } else {
        const r=Math.random(); let acc=0; outcome='coins';
        for(const o of ['coins','common','rare','epic','legendary']){ acc+=box.odds[o]||0; if(r<acc){ outcome=o; break; } }
        cfg.boxPity = (outcome==='coins'||outcome==='common') ? (cfg.boxPity||0)+1 : 0;
    }
    if(outcome==='coins') return { type:'coins', amount: Math.round(box.price*(0.2+Math.random()*0.3)) };
    const pool=_boxLootPool(outcome, box.id==='admin');
    return { type:'item', id: pool[Math.floor(Math.random()*pool.length)], rarity:outcome };
}

// Backup/restore all game data (scores, coins, achievements, shop items, settings)
// as a downloadable JSON file. A backup is a full clone -- restore overwrites.
function _saveSnapshot() {
    return { v:1,
        hs:    localStorage.getItem(HS_KEY),
        coins: localStorage.getItem(FK_KEY),
        ach:   localStorage.getItem(ACH_KEY),
        cfg:   localStorage.getItem(CFG_KEY),
        name:  localStorage.getItem('lastSName') };
}
function backupStats() {
    try {
        const blob=new Blob([JSON.stringify(_saveSnapshot())],{type:'application/json'});
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');
        a.href=url; a.download='snake-fok-backup.json';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        _dataMsg='BACKUP SAVED'; _dataMsgAt=simNow;
    } catch { _dataMsg='BACKUP FAILED'; _dataMsgAt=simNow; }
}
const _restoreInp=document.createElement('input');
_restoreInp.type='file'; _restoreInp.accept='application/json,.json'; _restoreInp.style.display='none';
document.body.appendChild(_restoreInp);
_restoreInp.addEventListener('change',()=>{
    const f=_restoreInp.files&&_restoreInp.files[0]; _restoreInp.value='';
    if(!f) return;
    const rd=new FileReader();
    rd.onload=()=>{
        try {
            const d=JSON.parse(rd.result);
            if(!d||typeof d!=='object') throw 0;
            const set=(k,key)=>{ if(key in d){ const v=d[key]; if(v==null) localStorage.removeItem(k); else localStorage.setItem(k,v); } };
            set(HS_KEY,'hs'); set(FK_KEY,'coins'); set(ACH_KEY,'ach'); set(CFG_KEY,'cfg'); set('lastSName','name');
            _cachedFOKoins=getFOKoins(); loadAch(); loadCfg();
            if(cfg.wornItems===null){ cfg.wornItems={...(cfg.shopItems||{})}; }
            applyHandedness(); updateMuteBtn(); _scoreboardCache=null;
            Snd.musicSetVolume(cfg.volume??1); Snd.sfxSetVolume(cfg.sfxVol??0.5);
            _dataMsg='STATS RESTORED'; _dataMsgAt=simNow;
        } catch { _dataMsg='INVALID FILE'; _dataMsgAt=simNow; }
    };
    rd.onerror=()=>{ _dataMsg='READ FAILED'; _dataMsgAt=simNow; };
    rd.readAsText(f);
});
function restoreStats(){ try{ _restoreInp.click(); }catch{} }

const fpsEl = document.getElementById('fps-el');

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
            if(settingsCat>=0){ settingsSel=settingsCat; settingsCat=-1; } else phase='menu';
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
            else if(menuSel===2){phase='scores';_scoreboardCache=getScores();}
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
                if(inCat){settingsSel=settingsCat;settingsCat=-1;} else phase='menu';
            } else if(!inCat){
                Snd.sfxPlay('select',cfg.music); settingsCat=settingsSel; settingsSel=0;
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
        if(key==='ArrowUp'||key==='ArrowDown'||key==='ArrowLeft'||key==='ArrowRight') return;
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
                    _cachedFOKoins-=item.price; try { localStorage.setItem(FK_KEY,String(_cachedFOKoins)); } catch {}
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
            else{phase='nameEntry';try{nameStr=(localStorage.getItem('lastSName')||'').substring(0,MAX_NAME);}catch{nameStr='';}nameCharIdx=nameStr.length>0?NAME_CHARS.indexOf(' '):0;nameCursorPos=nameStr.length;nameReason='win';showHUD(false);Snd.musicStop();}
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
            try{localStorage.setItem('lastSName',nameStr);}catch{}
            addScore(nameStr,score,level);Snd.sfxPlay('select',cfg.music);
            _scoreboardCache=getScores();phase='scores';showHUD(false);setTimeout(()=>nameInp.blur(),10);
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

canvas.addEventListener('mousemove', ()=>{ canvas.style.cursor=''; });

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
let _swipeBase=null, _swipeLastDir=null, _swipeLastMoveAt=0, _swipeLastMovePos=null, _swipeTouchStartAt=0, _swipedThisTouch=false;
canvas.addEventListener('touchstart',e=>{
    //Snd.audioResume();
    e.preventDefault();
    if(phase==='nameEntry'){ nameInp.focus(); }
    const t=e.touches[0];
    _swipeBase={x:t.clientX,y:t.clientY}; _swipeLastDir=null; _swipeLastMoveAt=performance.now(); _swipeLastMovePos={x:t.clientX,y:t.clientY}; _swipeTouchStartAt=performance.now(); _swipedThisTouch=false;
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
        const t=e.changedTouches[0];
        const isTap=Math.hypot(t.clientX-_swipeBase.x,t.clientY-_swipeBase.y)<SWIPE_1&&!_swipeLastDir&&!_swipedThisTouch&&performance.now()-_swipeTouchStartAt>20;
        if(phase!=='playing'&&phase!=='nameEntry'&&(isTap||cfg.touchSelect)) handleKey('Enter',null);
    }
    _swipeBase=null; _swipeLastDir=null; _swipeLastMovePos=null;
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
    if(phase==='playing') canvas.style.cursor='none';
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

// ================================================================
// MAIN LOOP
// Fixed-timestep architecture: update() is the single tick provider -- it is the
// only place simTick advances, and all game state is a pure function of simTick.
// loop() accumulates real frame time and runs update() a whole number of times per
// frame (with a catch-up cap), then renders once. This decouples the simulation
// from display refresh (60/30 Hz screens, iOS throttling) and is the seam a server
// or peer can later drive instead of the RAF accumulator.
// ================================================================
const _btnPause = document.getElementById('btn-pause');
const _btnStart = document.getElementById('btn-start');
const _btnEsc   = document.getElementById('btn-esc');
let _dimPhase = null;
function _updateBtnDim() {
    if(phase===_dimPhase) return;
    _dimPhase=phase;
    const gameplay=['playing','paused','dying','levelReady','levelDone'].includes(phase);
    const noAction=['settings','scores','achievements','shop','credits'].includes(phase);
    _btnPause.classList.toggle('dim', !['playing','paused','credits','shop','nameEntry'].includes(phase));
    _btnStart.classList.toggle('dim', gameplay || noAction);
    _btnEsc.classList.toggle('dim', phase==='menu');
}

let _uiSplashShown = null;
function _updateNonCanvasUI() {
    const onSplash = phase === 'splash';
    if (_uiSplashShown === onSplash) return;
    _uiSplashShown = onSplash;
    document.getElementById('btn-mute').style.visibility = onSplash ? 'hidden' : '';
    document.getElementById('fps-el').style.visibility = onSplash ? 'hidden' : '';
    document.getElementById('gamepad').classList.toggle('splash', onSplash);
}

// Advance the simulation by exactly one 60 Hz tick. Only caller: loop().

let _lastDraw = 0, _uiDirty = true, _lastPhase = '';
// Per-screen render policy in ONE place; loop() applies it generically (no per-screen
// code in the loop). freeze: static screen, skipped when idle. anim(): optional
// "still animating while idle" predicate that keeps it redrawing. hud: show HUD row.
const SCREENS = {
    splash:       { d:()=>drawSplash(simNow),    hud:false },
    menu:         { d:()=>drawMenu(simNow),      hud:false },
    news:         { d:()=>drawNews(simNow),      hud:false, freeze:true, anim:()=> simNow-_newsAt < 700 },
    settings:     { d:()=>drawSettings(),        hud:false, freeze:true, anim:()=> !!_dataMsg && simNow-_dataMsgAt < 2600 },
    scores:       { d:()=>drawScores(),          hud:false, freeze:true },
    achievements: { d:()=>drawAchievements(),    hud:false, freeze:true },
    shop:         { d:()=>drawShop(),            hud:false },
    credits:      { d:()=>drawCredits(),         hud:false },
    nameEntry:    { d:()=>drawNameEntry(simNow), hud:false },
    quitConfirm:  { d:()=>drawQuitConfirm(),     hud:false, freeze:true },
    resetConfirm: { d:()=>drawResetConfirm(),    hud:false, freeze:true },
    paused:       { d:()=>drawGameBoard(simNow), hud:true,  freeze:true },
};
const _GAME_SCREEN = { d:()=>drawGameBoard(simNow), hud:true };   // playing/dying/levelReady/levelDone
function loop(rafNow) {
    requestAnimationFrame(loop);
    // Optional 30 FPS cap: skip whole frames (the fixed-timestep sim catches up via
    // the _acc accumulator, so gameplay speed is unchanged -- only the draw rate drops).
    if(cfg.fps30 && rafNow-_lastDraw < 32) return;
    _lastDraw = rafNow;
    _updateBtnDim();
    _updateNonCanvasUI();
    fpsFrames++;
    if(rafNow-fpsLast>=500){fpsEl.textContent=`${Math.round(fpsFrames*1000/(rafNow-fpsLast))} FPS`;fpsFrames=0;fpsLast=rafNow;}

    // Music routing (skip splash/paused/quitConfirm states)
    if(phase!=='splash'&&phase!=='paused'&&phase!=='quitConfirm'&&phase!=='resetConfirm'){
        const menuPhase=['menu','settings','scores','credits','nameEntry','achievements','shop','resetConfirm'].includes(phase);
        const gamePhase=['playing','levelReady','dying','levelDone'].includes(phase);
        const wt=menuPhase?menuTrack():gamePhase?gameTrack():null;
        if(cfg.music&&wt) Snd.musicPlay(wt);
        else if(!wt&&!menuPhase&&!gamePhase) Snd.musicStop();
    }
    Snd.musicTick(cfg.music);

    // Fixed-timestep sim: run update() once per elapsed tick, capped so a slow or
    // backgrounded frame catches up a little then drops the backlog (no spiral).
    if(_lastRAF===0) _lastRAF=rafNow;
    let frameMs=rafNow-_lastRAF; _lastRAF=rafNow;
    if(frameMs>250) frameMs=250;
    _acc+=frameMs;
    let ran=0;
    while(_acc>=TICK_MS && ran<MAX_CATCHUP){ _acc-=TICK_MS; update(); drainSimEvents(); ran++; }
    if(ran>=MAX_CATCHUP) _acc=0;
    updateHUD();   // HUD sync moved out of the sim (step) into presentation

    // Generic draw: pick the phase's policy and apply it uniformly. A freezable screen
    // is skipped (last frame kept on the canvas) while nothing changed (_uiDirty) and
    // nothing is animating -- neither a global overlay nor the screen's own anim().
    if(phase!==_lastPhase){ _uiDirty=true; _lastPhase=phase; }
    const s = SCREENS[phase] || _GAME_SCREEN;
    const transient = achPopups.length>0 || confetti.length>0;
    let skip = s.freeze && !_uiDirty && !transient && !(s.anim && s.anim());
    if(!skip){ s.d(); showHUD(s.hud); }
    if(!skip) drawAchPopups(simNow);
    _uiDirty = false;
}

document.fonts.ready.then(() => requestAnimationFrame(loop));

// Align SND button and FPS to the actual canvas top/bottom edges in landscape.
// CSS can't know where the canvas ends up when it's width-constrained, so JS measures it.
const _lsq = window.matchMedia('(pointer: coarse) and (orientation: landscape)');
function syncLandscapePanels() {
    const si = document.getElementById('side-info');
    const fe = document.getElementById('fps-el');
    if(!_lsq.matches) {
        si.style.paddingTop = si.style.paddingBottom = fe.style.bottom = '';
        return;
    }
    const r = canvas.getBoundingClientRect();
    const t = Math.max(0, Math.round(r.top));
    const b = Math.max(0, Math.round(window.innerHeight - r.bottom));
    si.style.paddingTop = t + 'px';
    si.style.paddingBottom = b + 'px';
    fe.style.bottom = b + 'px';
}
window.addEventListener('resize', syncLandscapePanels);
window.addEventListener('orientationchange', () => setTimeout(syncLandscapePanels, 120));
requestAnimationFrame(syncLandscapePanels);

// Scale SND/FPS font to match canvas display size when the canvas is CSS-upscaled beyond its 600px native width
function syncFontScale() {
    const scale = canvas.getBoundingClientRect().width / CW;
    const sz = Math.round(8 * scale) + 'px';
    fpsEl.style.fontSize = sz;
    const iconH=Math.round(16*scale); _muteCv.style.height=iconH+'px'; _muteCv.style.width=(iconH*2)+'px';
    fpsEl.style.height=(iconH+8)+'px'; // match speaker: canvas + 2*padding + 2*border
}
window.addEventListener('resize', syncFontScale);
window.addEventListener('orientationchange', () => setTimeout(syncFontScale, 120));
requestAnimationFrame(syncFontScale);

let _swVersion = '?';
if ('caches' in window) {
    caches.keys().then(keys => {
        const k = keys.find(k => k.startsWith('snake-'));
        if (k) _swVersion = k.replace('snake-', '');
    }).catch(() => {});
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        const wasControlled = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => {
            if (navigator.onLine) reg.update().catch(() => {});
        });
        let _reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (_reloading || !wasControlled) return;
            _reloading = true;
            window.location.reload();
        });
    });
}
