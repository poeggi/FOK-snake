// ============================================================================
// game.js -- CORE: constants, persistence, app state, game logic, debug tools,
// mystery-box rolls, backup/restore, the main loop and layout/bootstrap.
// Presentation lives in render.js, input handling in input.js -- both loaded
// AFTER this file. All three share one global scope (no bundler).
// ============================================================================
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
// Canvas font sizes: declared in css/fonts.css (:root --fs-*), read once here so the
// canvas and the DOM chrome share one source. Hardcoded fallbacks keep the headless
// tests (no getComputedStyle) working. Use FONT.* at every call site -- never a raw px.
const FONT = (() => {
    let rt = null; try { rt = getComputedStyle(document.documentElement); } catch(_) {}
    const px = (n, def) => { try { return parseInt(rt.getPropertyValue('--fs-' + n)) || def; } catch(_) { return def; } };
    return { DISPLAY: px('display',40), JUMBO: px('jumbo',26), TITLE: px('title',18), MENU: px('menu',14), HINT: px('hint',10) };
})();

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
    } catch (e) { return []; }
}
function getFOKoins() { return parseInt(localStorage.getItem(FK_KEY) || '0', 10) || 0; }
let _cachedFOKoins = getFOKoins();
function addFOKoins(n) {
    _cachedFOKoins += n;
    try { localStorage.setItem(FK_KEY, String(_cachedFOKoins)); } catch (e) {}
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
             diff:cfg.diff, color:cfg.snakeColor||0, shopItems:Object.assign({}, cfg.wornItems||{}), date });
    s.sort((a, b) => b.score - a.score);
    try { localStorage.setItem(HS_KEY, JSON.stringify(s.slice(0, 10))); } catch (e) {}
    addFOKoins(sc);
}
function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }
// Fresh default config each call (new objects, so nothing is shared/aliased).
// cfg.offline: when ON, future online features (1v1 dualplay, global online stats)
// must stay disabled -- gate all networking on !cfg.offline.
function defaultCfg() {
    return { music:true, diff:1, musicStyle:0, snakeColor:0, shopItems:{}, wornItems:null,
             handed:0, volume:1, sfxVol:0.5, turbo:true, touchSelect:false, offline:false, fps30:false, disableGlow:false,
             boxPity:0, shopOpens:0, debug:0, cfgVer:2 };
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
    cfg.debug       = (Number.isInteger(cfg.debug) && cfg.debug>=0 && cfg.debug<=3) ? cfg.debug : 0;
    if(!cfg.shopItems || typeof cfg.shopItems!=='object' || Array.isArray(cfg.shopItems)) cfg.shopItems = {};
    if(cfg.wornItems!==null && (typeof cfg.wornItems!=='object' || Array.isArray(cfg.wornItems))) cfg.wornItems = null;
}
// Error-tolerant load: parse failures fall back to defaults; keys absent from an
// older or partial save (including a restored old backup) keep their defaults;
// every value is sanitized. Reset-to-defaults-then-overlay so restoring an old
// backup clears settings that backup never carried.
function loadCfg() {
    let s = {};
    try { const raw = localStorage.getItem(CFG_KEY); if(raw) s = JSON.parse(raw); } catch (e) {}
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
function loadAch() { try { achUnlocked = JSON.parse(localStorage.getItem(ACH_KEY) || '{}'); } catch (e) {} }
function saveAch() { try { localStorage.setItem(ACH_KEY, JSON.stringify(achUnlocked)); } catch (e) {} }
function announceSeen(){ try{ return !ANNOUNCEMENT||localStorage.getItem('seenAnnounce')===ANNOUNCEMENT.id; }catch (e){ return true; } }
function markAnnounceSeen(){ try{ if(ANNOUNCEMENT)localStorage.setItem('seenAnnounce',ANNOUNCEMENT.id); }catch (e){} }
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
// #debug in the URL is a shortcut to ENABLE debug mode (unlocks the hidden DEBUGGING
// menu) without hand-editing the save file. It only turns it on -- it does not show the
// overlay; use the menu's SHOW CANVAS PROPS for that.
try { if(location.hash === '#debug' && (cfg.debug||0) < 1){ cfg.debug = 1; saveCfg(); } } catch(e){}
if(cfg.wornItems === null){ cfg.wornItems = Object.assign({}, cfg.shopItems||{}); saveCfg(); }
Snd.musicSetVolume((cfg.volume==null?1:cfg.volume));
Snd.sfxSetVolume((cfg.sfxVol==null?0.5:cfg.sfxVol));
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
                try{ nameStr=(localStorage.getItem('lastSName')||'').substring(0,MAX_NAME); }catch (e){ nameStr=''; }
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
// DEBUGGING  (canvas info, JSON exports, worst-frame FPS recorder)
// ================================================================
// DEBUGGING: snapshot every screen/canvas metric that matters for the layout, so a
// broken device can export a file we can read. Downloaded as pretty JSON.
function _canvasInfo(){
    const wrap=canvas.parentElement, cr=canvas.getBoundingClientRect(), wr=wrap.getBoundingClientRect();
    const rs=getComputedStyle(document.documentElement), cv=n=>(rs.getPropertyValue(n)||'').trim();
    return {
        swVersion:_swVersion, debugLevel:cfg.debug||0, userAgent:navigator.userAgent,
        devicePixelRatio:window.devicePixelRatio,
        orientation:(window.screen&&screen.orientation&&screen.orientation.type)||(window.innerWidth>window.innerHeight?'landscape':'portrait'),
        screen:{ width:screen.width, height:screen.height, availWidth:screen.availWidth, availHeight:screen.availHeight },
        window:{ innerWidth:window.innerWidth, innerHeight:window.innerHeight },
        documentElement:{ clientWidth:document.documentElement.clientWidth, clientHeight:document.documentElement.clientHeight },
        canvasNative:{ width:canvas.width, height:canvas.height },
        canvasDisplay:{ width:Math.round(cr.width), height:Math.round(cr.height), left:Math.round(cr.left), top:Math.round(cr.top) },
        wrap:{ clientWidth:wrap.clientWidth, clientHeight:wrap.clientHeight, top:Math.round(wr.top) },
        cssVars:{ uiScale:cv('--ui-scale'), stageW:cv('--stage-w') },
        fontScale:FONT
    };
}
function exportCanvasInfo(){
    try { _downloadJSON('snake-canvas-info.json', _canvasInfo()); _dataMsg='CANVAS INFO SAVED'; _dataMsgAt=simNow; }
    catch (e) { _dataMsg='EXPORT FAILED'; _dataMsgAt=simNow; }
}
// ---- Worst-Frame Recorder (DEBUGGING). Passive: reuses loop()'s frame time; per frame it
// does one compare + one ring-buffer write; a context snapshot is built ONLY on a new worst
// frame (rare). No per-frame DOM/alloc/timing calls, so it can't shift the FPS it measures. --
let _fpsRec=false, _fpsStartAt=0, _fpsWorstDt=0, _fpsWorstAvg=Infinity, _fpsMaxAvg=0, _fpsSnap=null;
const _FPS_RING=new Float32Array(30); let _fpsRingI=0;   // pre-allocated lead-up buffer (frame times)
function _fpsRecReset(){
    _fpsStartAt=0; _fpsWorstDt=0; _fpsWorstAvg=Infinity; _fpsMaxAvg=0; _fpsSnap=null; _fpsRingI=0; _FPS_RING.fill(0);
    try{ fpsEl.style.color='#ff8844'; fpsEl.textContent='REC'; }catch(e){}
}
function _fpsRecordAvg(live, rafNow){   // called at the 500ms tick while recording
    if(_fpsStartAt===0 || rafNow-_fpsStartAt<1500) return;   // warmup
    if(live<_fpsWorstAvg) _fpsWorstAvg=live;
    if(live>_fpsMaxAvg)   _fpsMaxAvg=live;                    // max sustained FPS (recorded, never shown live)
}
function _fpsRecordFrame(dt, rafNow){   // called every frame while recording (raw dt)
    _FPS_RING[_fpsRingI]=dt; _fpsRingI=(_fpsRingI+1)%_FPS_RING.length;
    if(_fpsStartAt===0) _fpsStartAt=rafNow;
    if(rafNow-_fpsStartAt<1500) return;   // ignore JIT/asset warmup
    if(dt>500) return;                    // ignore tab-switch/backgrounding gaps
    if(dt>_fpsWorstDt){                   // new worst hitch -> lock the display + snapshot the context
        _fpsWorstDt=dt;
        try{ fpsEl.textContent='LOW '+Math.round(1000/dt); }catch(e){}
        _fpsSnap=_fpsSnapshot(dt, rafNow);
    }
}
function _fpsSnapshot(dt, rafNow){
    const g=(f,d)=>{ try{ const v=f(); return v==null?d:v; }catch(e){ return d; } };  // tolerate any absent global
    const ring=[]; for(let i=0;i<_FPS_RING.length;i++){ ring.push(Math.round(_FPS_RING[(_fpsRingI+i)%_FPS_RING.length])); }
    const cr=g(()=>canvas.getBoundingClientRect(),null);
    return {
        fps:Math.round(1000/dt), frameMs:Math.round(dt), uptimeS:Math.round((rafNow-_fpsStartAt)/1000),
        phase:phase, level:g(()=>level,0), score:g(()=>score,0), snakeLen:g(()=>snake.length,0),
        effects:{ power:g(()=>!!_powerMode,false), slow:g(()=>!!_slowMode,false), gouranga:g(()=>!!_gourangaActive,false), boosting:g(()=>!!boosting,false), dying:phase==='dying' },
        load:{ particles:g(()=>purchaseParticles.length,0), confetti:g(()=>confetti.length,0), achPopups:g(()=>achPopups.length,0), crush:g(()=>_crushEffects.length,0), bars:g(()=>bars.length,0), gemOnBoard:g(()=>gem?1:0,0) },
        canvas:{ css: cr?(Math.round(cr.width)+'x'+Math.round(cr.height)):'?', uiScale:g(()=>(document.documentElement.style.getPropertyValue('--ui-scale')||'').trim(),''), dpr:window.devicePixelRatio },
        leadUpFrameMs:ring   // the 30 frame times leading up to the worst (oldest first)
    };
}
function exportFpsLog(){
    try {
        _downloadJSON('snake-fps-log.json', { worstFrame:_fpsSnap,
            worstSustainedFps:(_fpsWorstAvg===Infinity?null:_fpsWorstAvg),
            maxSustainedFps:(_fpsMaxAvg||null), recording:_fpsRec, device:_canvasInfo() });
        _dataMsg='FPS LOG SAVED'; _dataMsgAt=simNow;
    } catch (e) { _dataMsg='EXPORT FAILED'; _dataMsgAt=simNow; }
}

// ================================================================
// MYSTERY BOX LOGIC  (loot rolls, odds, pity)
// ================================================================
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
function _boxCoinsAvg(box){ return box.price*0.5; }   // mean of the coins-filler reward (25%-75%)
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
    // Coins consolation: you get back 25%-75% of the price (lose 75% at worst, ~50% on
    // average), rounded to a whole 100. A softer loss than a total bust -- still a lottery.
    if(outcome==='coins') return { type:'coins', amount: Math.round(box.price*(0.25+Math.random()*0.5)/100)*100 };
    const pool=_boxLootPool(outcome, box.id==='admin');
    return { type:'item', id: pool[Math.floor(Math.random()*pool.length)], rarity:outcome };
}

// ================================================================
// BACKUP / RESTORE / INTEGRITY
// ================================================================
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
// FNV-1a over the backup's data fields -- a light integrity check so a hand-edited file is
// rejected on restore. Recomputed the same way on both sides from a fixed key order.
function _sum(s){ let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619)>>>0; } return h; }
function _sumOf(d){ return _sum(JSON.stringify({v:d.v,hs:d.hs,coins:d.coins,ach:d.ach,cfg:d.cfg,name:d.name})); }
// Serialize an object to a downloaded JSON file. Shared by the backup + the debug exports.
function _downloadJSON(filename, obj){
    const blob=new Blob([JSON.stringify(obj, null, 2)], {type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=filename;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function backupStats() {
    try {
        const snap=_saveSnapshot();
        snap.crc=_sumOf(snap);              // integrity checksum, written as the final field
        _downloadJSON('snake-fok-backup.json', snap);
        _dataMsg='BACKUP SAVED'; _dataMsgAt=simNow;
    } catch (e) { _dataMsg='BACKUP FAILED'; _dataMsgAt=simNow; }
}
const _restoreInp=document.createElement('input');
_restoreInp.type='file'; _restoreInp.accept='application/json,.json'; _restoreInp.className='util-hidden';
document.body.appendChild(_restoreInp);
_restoreInp.addEventListener('change',()=>{
    const f=_restoreInp.files&&_restoreInp.files[0]; _restoreInp.value='';
    if(!f) return;
    const rd=new FileReader();
    rd.onload=()=>{
        try {
            const d=JSON.parse(rd.result);
            if(!d||typeof d!=='object') throw 0;
            // Integrity: reject a file whose checksum does not match its data. Files that carry
            // no checksum (older backups predate it) are still accepted for compatibility.
            if(d.crc && d.crc!==_sumOf(d)) throw 0;
            const set=(k,key)=>{ if(key in d){ const v=d[key]; if(v==null) localStorage.removeItem(k); else localStorage.setItem(k,v); } };
            set(HS_KEY,'hs'); set(FK_KEY,'coins'); set(ACH_KEY,'ach'); set(CFG_KEY,'cfg'); set('lastSName','name');
            _cachedFOKoins=getFOKoins(); loadAch(); loadCfg();
            if(cfg.wornItems===null){ cfg.wornItems=Object.assign({}, cfg.shopItems||{}); }
            applyHandedness(); updateMuteBtn(); _scoreboardCache=null;
            Snd.musicSetVolume((cfg.volume==null?1:cfg.volume)); Snd.sfxSetVolume((cfg.sfxVol==null?0.5:cfg.sfxVol));
            _dataMsg='STATS RESTORED'; _dataMsgAt=simNow;
        } catch (e) { _dataMsg='INVALID FILE'; _dataMsgAt=simNow; }
    };
    rd.onerror=()=>{ _dataMsg='READ FAILED'; _dataMsgAt=simNow; };
    rd.readAsText(f);
});
function restoreStats(){ try{ _restoreInp.click(); }catch (e){} }

const fpsEl = document.getElementById('fps-el');

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
const _CTRL_ELS = { esc:_btnEsc, pause:_btnPause, ok:document.getElementById('btn-ok'), start:_btnStart, dpad:document.getElementById('dpad-c') };
// Which on-screen controls are LIVE per phase; every control NOT listed is dimmed. One
// source of truth (mirrors the SCREENS render-policy table) -- read it like a matrix.
//   esc = back/quit   pause = |I (space)   ok = A (enter)   start = quick-start   dpad
const CONTROLS = {
    splash:       ['ok','start'],
    menu:         ['ok','start','dpad'],
    settings:     ['esc','ok','dpad'],
    scores:       ['esc','ok','dpad'],
    achievements: ['esc','ok','dpad'],
    news:         ['esc','ok','dpad'],
    credits:      ['esc','pause','ok','dpad'],
    shop:         ['esc','pause','ok','dpad'],
    nameEntry:    ['esc','pause','ok','start','dpad'],
    playing:      ['esc','pause','ok','dpad'],
    paused:       ['esc','pause','ok','dpad'],
    dying:        ['esc','ok','dpad'],
    levelReady:   ['esc','ok','dpad'],
    levelDone:    ['esc','ok','dpad'],
    quitConfirm:  ['esc','ok','start','dpad'],
    resetConfirm: ['esc','ok','start','dpad'],
    _default:     ['esc','ok','dpad'],
};
let _dimPhase = null;
// One phase-change hook: JS owns the STATE (body[data-phase] + control .dim classes); CSS
// owns all the appearance consequences (e.g. hiding the SND/FPS boxes on splash).
function _updateBtnDim() {
    if(phase===_dimPhase) return;
    _dimPhase=phase;
    document.body.dataset.phase = phase;
    const live = CONTROLS[phase] || CONTROLS._default;
    for(const id in _CTRL_ELS){ const el=_CTRL_ELS[id]; if(el) el.classList.toggle('dim', live.indexOf(id)<0); }
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
    fpsFrames++;
    if(rafNow-fpsLast>=500){ const _live=Math.round(fpsFrames*1000/(rafNow-fpsLast));
        if(_fpsRec) _fpsRecordAvg(_live,rafNow); else fpsEl.textContent=`${_live} FPS`;   // recording: box shows locked worst, not live
        fpsFrames=0; fpsLast=rafNow; }

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
    if(_fpsRec) _fpsRecordFrame(frameMs, rafNow);   // raw dt (before the sim cap); no-op when not recording
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

if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(() => requestAnimationFrame(loop));
else requestAnimationFrame(loop);

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

// layout(): size the canvas to the largest CW:CH box that fits its #wrap region (flex hands
// it whatever the shown chrome leaves), minus a 4px margin -- R1 "fit" + R2 "maximize on the
// binding axis". Then read the result back into the CSS vars that drive the chrome: --ui-scale
// (= displayed/native) sizes the fonts+boxes, --stage-w matches the HUD/topbar to the canvas
// width. A ResizeObserver on #wrap (the input, not the canvas = our output) re-runs it; a
// last-width guard stops the font->reflow->resize feedback from looping.
const CANVAS_MAX_H = 1600;   // cap canvas height (= 4x native 400) so huge screens keep a margin
const _pmq = window.matchMedia ? window.matchMedia('(pointer: coarse) and (orientation: portrait)') : { matches:false };
let _lastCw = -1, _dbgEl = null;
function layout() {
    try {
        const wrap = canvas.parentElement;                 // #wrap
        const vpW = document.documentElement.clientWidth, vpH = document.documentElement.clientHeight;
        let wW, wH, m, scale, mode;
        if (!_lsq.matches) {
            // COLUMN (desktop + portrait touch): #wrap shrink-wraps the JS-sized canvas, so the
            // body groups [HUD + SND/FPS + canvas + gamepad] and centres (desktop) / bottom-
            // aligns (portrait). Measuring #wrap would be circular now, so fit into the viewport
            // width x (viewport height minus the chrome rows, which offsetHeight gives us --
            // display:none counts as 0, opacity:0 keeps its height).
            mode = _pmq.matches ? 'portrait' : 'desktop';
            const hud=document.getElementById('hud'), tb=document.getElementById('topbar'), gp=document.getElementById('gamepad');
            const chromeH = (hud?hud.offsetHeight:0) + (tb?tb.offsetHeight:0) + (gp?gp.offsetHeight:0) + 96; // gaps+padding
            wW = vpW; wH = Math.max(60, vpH - chromeH);
            m = Math.min(48, Math.max(4, Math.round(Math.min(wW, wH) * 0.02)));
            scale = Math.min((wW - 2*m) / CW, (wH - 2*m) / CH, CANVAS_MAX_H / CH);
        } else {
            // LANDSCAPE (touch): largest CW:CH box that fits the flex:1 #wrap between the side
            // panels. Clamp height to the viewport (a wide/short window can report a tall wrap).
            mode = 'fit';
            wW = wrap.clientWidth;
            const wrapTop = wrap.getBoundingClientRect().top;
            wH = Math.min(wrap.clientHeight, Math.max(0, vpH - wrapTop));
            if (wW <= 0 || wH <= 0) return;
            m = Math.min(48, Math.max(4, Math.round(Math.min(wW, wH) * 0.02)));
            scale = Math.min((wW - 2*m) / CW, (wH - 2*m) / CH, CANVAS_MAX_H / CH);
        }
        const cw = CW * scale;
        // On-screen canvas properties overlay: toggled from the DEBUGGING menu (Show Canvas
        // Props). (#debug in the URL only *enables* debug mode, it does not show this.)
        if (_showCanvasProps) {
            if (!_dbgEl) { _dbgEl = document.createElement('div'); _dbgEl.className='debug-overlay'; document.body.appendChild(_dbgEl); }
            _dbgEl.style.display = 'block';
            _dbgEl.textContent =
                'v'+_swVersion+'  dbg'+(cfg.debug||0)+'  dpr'+(window.devicePixelRatio||1)+'  ['+mode+']'+
                '\nscreen '+screen.width+'x'+screen.height+'  '+((window.innerWidth>window.innerHeight)?'landscape':'portrait')+
                '\nvp '+Math.round(vpW)+'x'+Math.round(vpH)+
                '\nused '+Math.round(wW)+'x'+Math.round(wH)+'  m'+m+'  scale '+scale.toFixed(3)+
                '\ncanvas css '+Math.round(cw)+'x'+Math.round(CH*scale)+'  native '+canvas.width+'x'+canvas.height;
        } else if (_dbgEl) { _dbgEl.style.display = 'none'; }
        if (Math.abs(cw - _lastCw) < 0.5) return;          // converged -> stop (breaks RO loops)
        _lastCw = cw;
        canvas.style.width = cw + 'px';
        canvas.style.height = (CH * scale) + 'px';
        const root = document.documentElement.style;
        root.setProperty('--ui-scale', scale);
        root.setProperty('--stage-w', cw + 'px');
        // Chrome font/box sizes rounded to whole px HERE (not with CSS round(), which old
        // browsers lack). CSS consumes these as var(--*-px), each with a base-size fallback.
        const rpx = b => Math.round(b * scale) + 'px';
        root.setProperty('--fs-menu-px',  rpx(FONT.MENU));
        root.setProperty('--fs-hint-px',  rpx(FONT.HINT));
        root.setProperty('--pad-top-px',  rpx(8));
        root.setProperty('--box-w-px',    rpx(92));
        root.setProperty('--box-h-px',    rpx(28));
        root.setProperty('--lives-h-px',  rpx(12));
        root.setProperty('--mute-icon-h', Math.round(16 * scale) + 'px');   // CSS sizes #btn-mute-cv from this
    } catch(_) {}
}
window.addEventListener('resize', () => requestAnimationFrame(layout));
window.addEventListener('orientationchange', () => setTimeout(layout, 120));
if (window.ResizeObserver) new ResizeObserver(layout).observe(canvas.parentElement);
requestAnimationFrame(layout);

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