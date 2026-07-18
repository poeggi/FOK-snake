// ============================================================================
// game.js -- the APPLICATION CORE and nothing else: app state, the sim-event
// drain, pause/quit coordination, the worker bridge (coalescing / watchdog /
// in-process fallback), the shop+box economy, debug tools (which poke loop
// internals), the main loop, layout and bootstrap.
// Persistent data lives in storage.js (before this file); typography in
// text.js, drawing in render.js/screens.js, input in input.js (all after).
// Shared global scope (no bundler); cross-file references bind at call time.
// ============================================================================
// ================================================================
// CONSTANTS (static data in assets.js)
// ================================================================


// ================================================================
// CANVAS
// ================================================================
const canvas = document.getElementById('c');
canvas.width = CW; canvas.height = CH;
// alpha:false = opaque canvas: the compositor can blit instead of alpha-blending it over
// the page every frame -- a real win on weak/embedded GPUs (TVs). Safe because every
// screen paints the full canvas first (grid/bg blit). Old browsers ignore the options arg.
const ctx = canvas.getContext('2d', { alpha: false });
// Canvas typography (FONT sizes + GLOW radii) lives in js/text.js, fed from
// css/fonts.css. Use FONT.* / GLOW.* at every call site -- never raw numbers.

// ================================================================
// APP STATE
// ================================================================
// phase (splash|menu|settings|scores|credits|playing|levelReady|paused|dying|levelDone|
// nameEntry|quitConfirm|resetConfirm) and _shimmerThreshold are declared in sim.js -- the
// sim owns phase during gameplay; the UI sets it for menus.
let menuSel = 0, settingsSel = 0, shopSel = 0, shopPage = 0, quitConfirmSel = 1, prevPhase = 'playing';
let settingsCat = -1;              // -1 = category list; else index into SETTINGS_CATS
let _dataMsg = '', _dataMsgAt = 0; // transient DATA-menu status line (backup/restore/reset)
let _resetKind = 'stats';          // which reset the confirm screen is arming: 'stats'|'settings'|'id'
let _scoreboardCache = null;
let scoresTab = 0;                 // scores screen tab: 0 = LOCAL (this device), 1 = GLOBAL (fetched from FOK-server, see net.js)
const _splashText = SPLASHES.length ? SPLASHES[Math.floor(Math.random()*SPLASHES.length)] : '';
const MENU_ITEMS     = ['PLAY', '1:1', 'HIGH SCORES', 'ACHIEVEMENTS', 'SHOP', 'SETTINGS', 'CREDITS'];
let duelSel = 0;   // 1:1 submenu selection (0 = PLAY LOCAL, 1 = MY ID, 2 = ADD FRIEND, 3 = FRIENDS, 4 = PLAY ONLINE)
// Local 1:1 needs a physical keyboard (P2 = WASD): gate on a fine primary pointer (PC).
const _hasKeyboard = (()=>{ try { return window.matchMedia('(pointer: fine)').matches; } catch(e){ return false; } })();
let cfg = defaultCfg();
let inGame = false, _worker = null;   // Worker state (see the SIM WORKER section near the bootstrap)
loadCfg();
// #debug in the URL is a shortcut to ENABLE debug mode (unlocks the hidden DEBUGGING
// menu) without hand-editing the save file. It only turns it on -- it does not show the
// overlay; the overlays appear at DEBUG LEVEL 2+.
try { if(location.hash === '#debug' && (cfg.debug||0) < 1){ cfg.debug = 1; saveCfg(); } } catch(e){}
// Arrived via a friend link (QR): the inviter goes straight into the friends list.
// On iOS in a BROWSER the installed app can never receive this URL (no link capture,
// and Safari storage is isolated from the home-screen app), so an invite screen after
// the splash hands the code over manually (drawInvite): copy it / type it in the app.
// Installing from THIS page still carries it over automatically (storage is cloned).
let _inviteFid = null;
try {
    const fm = /^#friend=([0-9a-f]{8})$/.exec(location.hash);
    if (fm) {
        addFriend(fm[1]);
        const standalone = (navigator.standalone === true) ||
            (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
        const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
            (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
        if (ios && !standalone) _inviteFid = fm[1];
    }
} catch(e) {}
let inviteSel = 0, _inviteMsg = '', _inviteMsgAt = 0;
let _friendIdBack = 'duelMenu';   // where the MY ID screen returns to (1:1 menu or SETTINGS > USER)
if(cfg.wornItems === null){ cfg.wornItems = Object.assign({}, cfg.shopItems||{}); saveCfg(); }
Snd.musicSetVolume((cfg.volume==null?1:cfg.volume));
Snd.sfxSetVolume((cfg.sfxVol==null?0.5:cfg.sfxVol));
function applyHandedness() { document.body.classList.toggle('lefty', cfg.handed === 1); }
applyHandedness();

// ALL sim state (snake, gem, bars, score, level, lives, the sim clock, power/heart/crystal,
// gouranga, boost, phase, ...) now lives in sim.js so the sim is self-contained and can run
// in a Web Worker. game.js keeps only presentation / main-loop state:
// Splash lifecycle (coin drop / fast-forward / exit): main-owned UI state. Input
// handlers set it, updateSplashExit (called from loop) finishes the transition.
let _splashLeftAt = 0;
let _splashFast = false, _splashFastStart = 0, _splashFastBase = 0;
let _splashExiting = false, _splashExitAt = 0;
function updateSplashExit() {
    if (phase === 'splash' && _splashExiting && simNow - _splashExitAt >= T(30)) {
        _splashExiting = false;
        phase = _inviteFid ? 'invite' : 'menu'; inviteSel = 0; _splashLeftAt = performance.now();   // wall clock: simNow is reset by startGame/startDuel (see input.js debounce)
        // Hold menu music briefly for the clock sync (started during the coin drop), so it
        // opens on the globally-shared bar. Only when online and not yet synced; else no wait.
        if(typeof _netOk === 'function' && _netOk() && (typeof netPts !== 'function' || netPts() == null))
            _musicSyncWaitUntil = performance.now() + MUSIC_SYNC_WAIT_MS;
        _wsend({ t:'phase', phase:'menu' });   // sync the worker: it owns phaseAt
    }
}
let _clkHold = 0;   // frame counter for the clock's hold-back correction (see loop)
let _lastRAF = 0;                           // last RAF timestamp (worst-frame FPS recorder)
let pauseReadyAt = 0;                       // pause input debounce gate
let achPage = 0;
let nameStr = '', nameCharIdx = 0, nameCursorPos = 0, nameReason = '';
// What the name-entry dialog edits: 'score' (game-over high score), 'user' (SETTINGS >
// USER player name), 'friend' (1:1 ADD FRIEND: 8 hex digits + live camera scan).
let entryMode = 'score';
function _entryChars() { return entryMode === 'friend' ? HEX_CHARS : NAME_CHARS; }
function _entryMax()   { return entryMode === 'friend' ? 8 : MAX_NAME; }
// Transient confirmation line on the 1:1 menu. Stamped on the WALL clock, not the
// sim clock: a duel restarts simNow at 0 while the worker's own simNow has been
// free-running since page load, so ending a session swaps a small simNow for a huge
// one -- and any message stamped in sim time instantly reads as ancient and never
// draws. That is precisely the message you most want ("OPPONENT LEFT").
let _duelMsg = '', _duelMsgAt = 0;
function _msgNow(){ return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
let _nameFlashAt = 0, _nameFlashPos = -1;
let creditsScroll = 0, creditsSpeed = 0.8, _creditsNormal = 0.8;
let purchaseParticles = [], purchaseAnimAt = 0;
let fpsFrames = 0, fpsLast = 0;

let _musicHoldUntil = 0;   // routing is held during the quit-confirm leave-fade (0.25s)
// Menu music starts aligned to the shared server clock (all clients on the same audio style
// land on the same bar). At first menu entry we briefly hold it while the clock syncs, but
// NEVER longer than this -- then it plays whether synced or not. Offline/synced: no wait.
const MUSIC_SYNC_WAIT_MS = 2000;
let _musicSyncWaitUntil = 0;
let _wasMenuPhase = false;   // menu-entry edge, so the sync-wait re-arms on EVERY menu entry (splash or in-game)
function menuTrack() { return cfg.musicStyle === 0 ? 'ambient'     : 'classicMenu'; }
function gameTrack() { return cfg.musicStyle === 0 ? 'game'        : 'classicGame'; }
// Let the audio layer re-fetch the live shared-clock seek when the context resumes
// (e.g. a fresh start that pinned the track while still suspended by the autoplay gate).
// It hands us the track id; menu tracks seek to absolute PTS, the game track to its
// start-PTS offset. null when unsynced/offline -> the audio layer leaves it be.
if (typeof Snd !== 'undefined' && Snd.setMusicSeekProvider) Snd.setMusicSeekProvider((trackId) => {
    if (typeof netPts !== 'function' || netPts() == null) return null;
    if (trackId === 'ambient' || trackId === 'classicMenu')
        return (typeof netMenuSeekSec === 'function') ? netMenuSeekSec() : null;
    return (typeof netMusicSeekSec === 'function') ? netMusicSeekSec() : null;
});

// ================================================================
// GAME LOGIC
// ================================================================
// Event-driven cosmetic feedback -- sounds, particle bursts (crush/fireworks) and
// floating labels (bonus) -- plays on a fixed 2-engine-tick (1/30s) delay, in EVERY
// mode. An online correction arriving in that window cancels a wrongly predicted
// effect before it is seen or heard (see _rbRollback, which filters both queues, and
// drainSimEvents, which re-queues on replay). Uniform delay across modes keeps the
// feel identical whether or not a peer is connected. Sound is the more intrusive to
// retract, but a false confetti burst or "+1 UP!" is jarring too.
const _FX_DEFER = new Set(['sfx', 'bonus', 'crush', 'fw']);   // deferred + rollback-cancellable
const FX_SETTLE_MS = 1000 / 30;   // 2 ticks, for phase-derived messages (death, duel winner)
let _sfxQ = [];
let _fxQ  = [];          // visual effects awaiting their 2-tick delay: { tk, e } (raw sim event)
let _sfxAnchor = null;   // { tk, actx }: maps the tick timeline onto AudioContext time
function flushSfxQ(){
    if(!_sfxQ.length) return;
    const ct = Snd.ctxTime();
    if(ct == null){   // no audio context (muted boot, harness): plain tick gate
        while(_sfxQ.length && simTick - _sfxQ[0].tk >= 2) Snd.sfxPlay(_sfxQ.shift().name, cfg.music);
        return;
    }
    // (Re)anchor when tick time and audio time drift apart (pause, menu, seek).
    if(!_sfxAnchor || Math.abs((simTick - _sfxAnchor.tk)/60 - (ct - _sfxAnchor.actx)) > 0.25)
        _sfxAnchor = { tk: simTick, actx: ct };
    while(_sfxQ.length){
        const when = _sfxAnchor.actx + (_sfxQ[0].tk + 2 - _sfxAnchor.tk) / 60;   // the exact 2-ticks-late moment
        if(when > ct + 0.05) break;                    // outside the scheduling lookahead
        Snd.sfxPlay(_sfxQ.shift().name, cfg.music, when);
    }
}
// Fire the deferred visual effects that have now aged their 2 ticks. Uses the
// current simNow (fire time), so the effect's own animation clock starts when it
// actually appears -- the 33ms it waited is imperceptible.
function flushFxQ(){
    while(_fxQ.length && simTick - _fxQ[0].tk >= 2){
        const e = _fxQ.shift().e;
        switch(e.t){
            case 'bonus': showBonus(simNow, e.label); break;
            case 'fw':    spawnFireworks(simNow); break;
            case 'crush': _crushEffects.push({ x:e.x, y:e.y, at:simNow,
                              pts:Array.from({length:20},()=>({
                                  ang:Math.random()*Math.PI*2, spd:3+Math.random()*9,
                                  sz:2+Math.random()*4,
                                  col:['#ff6600','#ffaa00','#ffdd44','#cc3300','#ffffff','#886644'][Math.floor(Math.random()*6)]
                              })) }); break;
        }
    }
}
let _replaying = false;   // reconciliation replay: re-queue the deferred cosmetics only
function drainSimEvents(){
    for(const e of simEvents){
        if(_replaying && !_FX_DEFER.has(e.t)) continue;   // non-cosmetic side effects already ran live during prediction
        switch(e.t){
            case 'sfx':      _sfxQ.push({ tk:simTick, name:e.name }); break;
            case 'bonus':
            case 'fw':
            case 'crush':    _fxQ.push({ tk:simTick, e }); break;   // deferred 2 ticks, cancellable on rollback
            case 'mpause':   Snd.musicMute('pause'); break;
            case 'munpause': Snd.musicUnmute('pause'); break;
            case 'mstop':    Snd.musicStop(); break;
            case 'coin':     addFOKoins(e.n); break;
            case 'ach':      unlockAch(e.id); break;
            case 'bars':     renderBarsOffscreen(); break;
            case 'lvlreset': fireworks=[]; _crushEffects=[]; break;   // clear leftover particles at level begin (sim used to do this directly)
            case 'showhud':  showHUD(e.v); break;
            case 'gameover':
                entryMode = 'score';
                nameReason = e.reason || 'over';   // 'win' when set by the level-10 clear, else death
                try{ nameStr=(localStorage.getItem('lastSName')||'').substring(0,MAX_NAME); }catch (e){ nameStr=''; }
                nameCharIdx=nameStr.length>0?NAME_CHARS.indexOf(' '):0; nameCursorPos=nameStr.length;
                showHUD(false); Snd.musicStop(); break;
        }
    }
    simEvents.length = 0;
}

function togglePause() {
    if(typeof netGameActive==='function' && netGameActive()) return;   // online: no pause (quit via ESC works)
    // Phase (playing<->paused, duel<->duelPaused) and the clock freeze/thaw are handled by
    // the worker; main only gates the input and drives the music. Pause exists in classic
    // and LOCAL duel; a future ONLINE duel disables it (one player must not freeze the peer).
    if(phase==='playing'||phase==='duel'){
        if(performance.now() < pauseReadyAt) return;
        Snd.musicMute('pause'); _wsend({ t:'pause' });
    } else if(phase==='paused'||phase==='duelPaused'){
        pauseReadyAt=performance.now()+1000;
        Snd.musicUnmute('pause'); _wsend({ t:'resume' });
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
// The full debug state (extend freely): canvas/layout, config, fps recorder state, sim
// summary, identity/social counters, the live net stats, and the on-screen overlay text.
// Shared by the file export and the cloud snapshot.
function _debugState(){
    return {
        version: _swVersion, exportedAt: new Date().toISOString(),
        canvas: _canvasInfo(),
        cfg: Object.assign({}, cfg),
        sim: { phase, level, score, lives, simTick, inGame, worker: !!_worker },
        fps: { recording:_fpsRec, worst:_fpsSnap, maxSustained:_fpsMaxAvg||null },
        player: { id: getPlayerId(), friends: getFriends().length },
        net: (typeof netDebugInfo === 'function') ? netDebugInfo() : null,
        overlay: { tl:_dbgTxt.tl, tr:_dbgTxt.tr, bl:_dbgTxt.bl, br:_dbgTxt.br },
    };
}
function exportDebugInfo(){
    try { _downloadJSON('snake-debug-info.json', _debugState()); _dataMsg='DEBUG INFO SAVED'; _dataMsgAt=simNow; }
    catch (e) { _dataMsg='EXPORT FAILED'; _dataMsgAt=simNow; }
}
// Debug snapshot -> the cloud (POST /debug/submit.php): the full state plus a screenshot.
// The debug overlays are HTML elements, so canvas.toDataURL() captures the game WITHOUT them.
// A captured snapshot is held until SEND DEBUG SNAPSHOT posts it and the server returns a PIN.
let _dbgSnap = null, _dbgPin = '', _dbgPinShow = false, _dbgPinCopied = false, _dbgSending = false;   // _dbgPinShow: hold the PIN on screen until the user moves; _dbgSending: upload in flight
function captureDebugSnapshot(){
    try {
        const images = [];
        // 1) The game canvas at its NATIVE resolution, lossless PNG -- pixel-exact for
        //    measurement (webp/quality compression would smear cell edges).
        try { images.push(canvas.toDataURL('image/png')); } catch(_){}
        // 2) Best-effort full-viewport composite at device-pixel resolution: every visible
        //    <canvas> (game board + d-pad) drawn at its on-screen box, so the layout is
        //    measurable as displayed. The HTML chrome (HUD, side buttons) is NOT included --
        //    there is no reliable DOM-to-image in-browser (SVG foreignObject taints the
        //    canvas on iOS Safari; screen capture needs a permission prompt).
        try {
            const dpr = window.devicePixelRatio || 1;
            const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
            const off = document.createElement('canvas');
            off.width = Math.round(vw*dpr); off.height = Math.round(vh*dpr);
            const octx = off.getContext('2d');
            octx.fillStyle = getComputedStyle(document.body).backgroundColor || '#000';
            octx.fillRect(0,0,off.width,off.height);
            document.querySelectorAll('canvas').forEach(el=>{
                const r = el.getBoundingClientRect();
                if(r.width>0 && r.height>0 && el.width>0 && el.height>0)
                    try { octx.drawImage(el, r.left*dpr, r.top*dpr, r.width*dpr, r.height*dpr); } catch(_){}
            });
            images.push(off.toDataURL('image/png'));
        } catch(_){}
        _dbgSnap = { app:_swVersion, id:getPlayerId(), when:Date.now(), state:_debugState(), images };
        _dataMsg = images.length ? 'SNAPSHOT CAPTURED' : 'SNAPSHOT FAILED'; _dataMsgAt=simNow;
        if(typeof Snd !== 'undefined') Snd.sfxPlay('select', cfg.music);
        if(images.length) _flashDbgSnapBtn();   // clear on-button feedback that a shot was taken
    } catch(e){ _dataMsg='SNAPSHOT FAILED'; _dataMsgAt=simNow; }
}
// Flash the overlay SNAP button green with a check when a snapshot is captured, then revert.
let _dbgSnapBtnT = null;
function _flashDbgSnapBtn(){
    if(!_dbgSnapBtn) return;
    _dbgSnapBtn.classList.add('snapped');
    _dbgSnapBtn.textContent = 'SAVED!';
    if(_dbgSnapBtnT) clearTimeout(_dbgSnapBtnT);
    _dbgSnapBtnT = setTimeout(()=>{ if(_dbgSnapBtn){ _dbgSnapBtn.classList.remove('snapped'); _dbgSnapBtn.textContent = 'SNAP'; } }, 900);
}
async function sendDebugSnapshot(){
    if(!_dbgSnap){ _dataMsg='CAPTURE FIRST (DEBUG LVL 3)'; _dataMsgAt=simNow; return; }
    if(typeof _netOk!=='function' || !_netOk()){ _dataMsg='OFFLINE'; _dataMsgAt=simNow; return; }
    _dbgSending=true; _dbgPinShow=false; _dbgPinCopied=false; _dataMsg=''; _uiDirty=true;   // clear old PIN; the persistent UPLOADING indicator takes over
    try {
        const r=await fetch(NET_BASE+'/debug/submit.php',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(_dbgSnap)});
        const j=await r.json().catch(()=>null);
        if(r.status===200 && j && j.ok && j.pin){
            _dbgPin=String(j.pin); _dbgPinShow=true;
            try { if(navigator.clipboard && navigator.clipboard.writeText){ await navigator.clipboard.writeText(_dbgPin); _dbgPinCopied=true; } } catch(e){}   // best-effort; user activation may have lapsed after the POST
            _dataMsg='SNAPSHOT SENT - PIN '+_dbgPin+(_dbgPinCopied?' (COPIED)':'');
        }
        else if(r.status===413) _dataMsg='SNAPSHOT TOO LARGE';
        else _dataMsg='SNAPSHOT SEND FAILED';
    } catch(e){ _dataMsg='SNAPSHOT SEND FAILED'; }
    finally { _dbgSending=false; }
    _dataMsgAt=simNow; _uiDirty=true;
}
// Level-3 clickable SNAP button (top-right, HTML so it is excluded from the screenshot).
let _dbgSnapBtn = null;
function _updateDbgSnapBtn(){
    const on = (cfg.debug||0) >= 3;
    if(on && !_dbgSnapBtn){
        _dbgSnapBtn = document.createElement('div');
        _dbgSnapBtn.className = 'dbg-snap'; _dbgSnapBtn.textContent = 'SNAP';
        _dbgSnapBtn.addEventListener('click', (e)=>{ e.stopPropagation(); captureDebugSnapshot(); });
        document.body.appendChild(_dbgSnapBtn);
    }
    if(_dbgSnapBtn) _dbgSnapBtn.style.display = on ? 'block' : 'none';
}
// Debug overlay (DEBUG LEVEL 2+): four corner docks -- network, timing, graphics,
// sim/game status. Refreshed 4/s, and only when the text actually changed. This is
// a READOUT, not an animation:
// nobody reads 60 updates a second, and it used to do exactly that -- rebuilding the
// whole string and writing textContent every frame, each write forcing a reflow, in a
// tool whose entire job is to not perturb what it measures. The numbers it shows
// (rtt, anchor, rollbacks) move far slower than a frame anyway.
const NET_DBG_MS = 250;
// Four corner debug docks (DEBUG LEVEL 2+): TL=network, TR=timing, BL=graphics,
// BR=sim/game status. Each corner only rewrites when its own text changes, so a
// static quadrant costs no reflow. netDebugQuad() supplies net/timing/sim; the
// graphics quadrant is built here from the cached layout + the live FPS box.
let _netDbgAt = 0, _dbgCorner = null, _dbgTxt = { tl:'', tr:'', bl:'', br:'' }, _dbgShown = false;
function _mkDbgCorner(cls){ const el = document.createElement('div'); el.className = 'debug-overlay ' + cls; document.body.appendChild(el); return el; }
function _gfxDbgText(){
    const L = _layoutDbg;
    return 'v' + _swVersion + ' dbg' + (cfg.debug||0) + ' dpr' + (window.devicePixelRatio||1) + ' [' + (L.mode||'?') + ']' +
        '\nscr ' + screen.width + 'x' + screen.height + ' ' + ((window.innerWidth>window.innerHeight)?'land':'port') +
        '\nvp ' + Math.round(L.vpW||0) + 'x' + Math.round(L.vpH||0) +
        '\nused ' + Math.round(L.wW||0) + 'x' + Math.round(L.wH||0) + ' m' + (L.m||0) + ' s' + (L.scale||0).toFixed(2) +
        '\ncv ' + Math.round(L.cw||0) + 'x' + Math.round(L.ch||0) + ' nat ' + canvas.width + 'x' + canvas.height +
        '\n' + ((fpsEl && fpsEl.textContent) || '-- FPS');
}
function updateNetDebugOverlay(rafNow){
    const on = (cfg.debug||0) >= 2;
    if(!on){
        if(_dbgCorner && _dbgShown){ for(const k in _dbgCorner) _dbgCorner[k].style.display = 'none'; _dbgShown = false; }
        return;
    }
    if(!_dbgCorner){ _dbgCorner = { tl:_mkDbgCorner('dbg-tl'), tr:_mkDbgCorner('dbg-tr'), bl:_mkDbgCorner('dbg-bl'), br:_mkDbgCorner('dbg-br') }; }
    if(!_dbgShown){ for(const k in _dbgCorner) _dbgCorner[k].style.display = 'block'; _dbgShown = true; }   // not every frame
    if(rafNow - _netDbgAt < NET_DBG_MS) return;
    _netDbgAt = rafNow;
    // Online: the full rollback/latency readout. Offline (menus + LOCAL 1:1 + solo): net
    // is meaningless, so timing shows the sim clock -- simTick free-runs from page load and
    // the worker owns it, so a frozen counter is a stalled worker. mseek lets two clients
    // verify menu-music sync on-device (same audio style => same seek, mod the loop length).
    const online = typeof netGameActive === 'function' && netGameActive();
    let net, time, simNet;
    if(typeof netDebugQuad === 'function'){ const q = netDebugQuad(); net = q.net; time = q.time; simNet = q.sim; }
    else { net = 'net: not loaded'; time = 'pts ' + simTick; simNet = ''; }
    if(!online){
        const _synced = (typeof netPts === 'function') && netPts() != null;
        const _mseek = (typeof netMenuSeekSec === 'function') ? netMenuSeekSec() : 0;
        time += '\nsync ' + (_synced ? 'ok mseek ' + _mseek.toFixed(2) + 's' : (cfg.offline ? 'offline' : '...'));
    }
    // Music drift vs the shared clock (read-only probe): + leads, - lags. Two side-by-side
    // clients should both read near 0; a long-up client trending away is the DAC-drift cause.
    if(typeof Snd !== 'undefined' && Snd.musicDriftMs){ const _d = Snd.musicDriftMs(); if(_d != null) time += '\naudio drift ' + (_d>=0?'+':'') + _d.toFixed(0) + 'ms'; }
    // Sim/game quadrant: game state (this file's) then the net rollback health (simNet).
    const sim = ['phase ' + phase, 'worker ' + (_worker?1:0) + ' ingame ' + (inGame?1:0)];
    if(simNet) sim.push(simNet);
    const simTxt = sim.join('\n');
    const gfx = _gfxDbgText();
    if(net    !== _dbgTxt.tl){ _dbgTxt.tl = net;    _dbgCorner.tl.textContent = net; }
    if(time   !== _dbgTxt.tr){ _dbgTxt.tr = time;   _dbgCorner.tr.textContent = time; }
    if(gfx    !== _dbgTxt.bl){ _dbgTxt.bl = gfx;    _dbgCorner.bl.textContent = gfx; }
    if(simTxt !== _dbgTxt.br){ _dbgTxt.br = simTxt; _dbgCorner.br.textContent = simTxt; }
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
// Shop/box behaviours (moved from the screens: they mutate coins/cfg, they do not draw).
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
    _adminAvail = (cfg.shopOpens % (cfg.x10?Math.max(1,Math.round(ADMIN_BOX_EVERY/10)):ADMIN_BOX_EVERY) === 0);
    _adminConsumed = false;
    phase='shop'; purchaseAnimAt=0;
    shopPage = _adminAvail ? BOX_PAGE : 0;
    shopSel  = _adminAvail ? BOXES.length : 0;
    saveCfg();
}
function _findItem(id){ return SHOP_ITEMS.find(i=>i.id===id) || BOX_ITEMS.find(i=>i.id===id); }

function _openBox(box){
    if(box.id==='admin'){
        const si=cfg.shopItems||(cfg.shopItems={});
        _adminConsumed=true;
        if(si.admincrown){ const refund=Math.round(_boxItemValue('admincrown')*0.5); addFOKoins(refund); _boxReward={kind:'dupe',id:'admincrown',rarity:'legendary',refund}; }
        else { si.admincrown=true; _boxReward={kind:'item',id:'admincrown',rarity:'legendary'}; }
        saveCfg(); _boxOpenAt=simNow; Snd.sfxPlay('unbox',cfg.music); return;
    }
    if(_cachedFOKoins < box.price){ Snd.sfxPlay('fail',cfg.music); return; }
    _cachedFOKoins -= box.price; try{ localStorage.setItem(FK_KEY,String(_cachedFOKoins)); }catch (e){}
    const res=rollBox(box);
    if(res.type==='coins'){ addFOKoins(res.amount); _boxReward={kind:'coins',amount:res.amount}; }
    else {
        const si=cfg.shopItems||(cfg.shopItems={});
        if(si[res.id]){ const refund=Math.round(_boxItemValue(res.id)*0.5); addFOKoins(refund); _boxReward={kind:'dupe',id:res.id,rarity:res.rarity,refund}; }
        else { si[res.id]=true; if(SHOP_ITEMS.filter(s=>!s.repeatable).every(s=>si[s.id])) unlockAch('shop_full'); _boxReward={kind:'item',id:res.id,rarity:res.rarity}; }
    }
    saveCfg();
    _boxOpenAt=simNow;
    Snd.sfxPlay('unbox',cfg.music);
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
        // DEBUG x10: rare/epic/legendary weights x10, coins/common absorb via the total.
        const F=cfg.x10?10:1;
        const w={coins:box.odds.coins||0, common:box.odds.common||0,
                 rare:(box.odds.rare||0)*F, epic:(box.odds.epic||0)*F, legendary:(box.odds.legendary||0)*F};
        const total=w.coins+w.common+w.rare+w.epic+w.legendary;
        const r=Math.random()*total; let acc=0; outcome='coins';
        for(const o of ['coins','common','rare','epic','legendary']){ acc+=w[o]; if(r<acc){ outcome=o; break; } }
        cfg.boxPity = (outcome==='coins'||outcome==='common') ? (cfg.boxPity||0)+1 : 0;
    }
    // Coins consolation: you get back 25%-75% of the price (lose 75% at worst, ~50% on
    // average), rounded to a whole 100. A softer loss than a total bust -- still a lottery.
    if(outcome==='coins') return { type:'coins', amount: Math.round(box.price*(0.25+Math.random()*0.5)/100)*100 };
    const pool=_boxLootPool(outcome, box.id==='admin');
    return { type:'item', id: pool[Math.floor(Math.random()*pool.length)], rarity:outcome };
}

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
    duelMenu:     ['esc','ok','dpad'],
    friends:      ['esc','ok','dpad'],
    lobby:        ['esc','ok','dpad'],
    friendId:     ['esc','ok','dpad'],
    invite:       ['esc','ok','dpad'],
    // A duel's local player gets exactly the same controls as a classic player:
    // duel mirrors playing, duelPaused mirrors paused. The dpad was excluded back
    // when a duel was always LOCAL (two players, one keyboard -- beginDuel() still
    // gates that on _hasKeyboard). An ONLINE duel has one local player, so on a
    // phone the dpad is the only steering there is, and .dim is pointer-events:none
    // -- it was dead, not merely dim. (Online also dims 'pause': see _updateBtnDim.)
    duelReady:    ['esc','pause','dpad'],
    duel:         ['esc','pause','ok','dpad'],
    duelPaused:   ['esc','pause','ok','dpad'],
    duelOver:     ['esc','ok','dpad'],
    dying:        ['esc','ok','dpad'],
    levelReady:   ['esc','ok','dpad'],
    levelDone:    ['esc','ok','dpad'],
    quitConfirm:  ['esc','ok','start','dpad'],
    resetConfirm: ['esc','ok','start','dpad'],
    _default:     ['esc','ok','dpad'],
};
let _dimKey = null;
// One phase-change hook: JS owns the STATE (body[data-phase] + control .dim classes); CSS
// owns all the appearance consequences (e.g. hiding the SND/FPS boxes on splash).
function _updateBtnDim() {
    // Keyed on phase AND online-ness: the same duel phase has a different live set
    // online, so phase alone would cache the wrong one.
    const online = typeof netGameActive==='function' && netGameActive();
    const key = phase + (online ? '|net' : '');
    if(key===_dimKey) return;
    _dimKey=key;
    document.body.dataset.phase = phase;
    let live = CONTROLS[phase] || CONTROLS._default;
    // An online duel cannot pause (togglePause refuses: one player must not freeze
    // the peer), so the button is dimmed rather than left live-but-inert.
    if(online) live = live.filter(id => id !== 'pause');
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
    settings:     { d:()=>drawSettings(),        hud:false, freeze:true, anim:()=> _dbgSending || (!!_dataMsg && simNow-_dataMsgAt < 2600) },
    scores:       { d:()=>drawScores(),          hud:false, freeze:true },
    achievements: { d:()=>drawAchievements(),    hud:false, freeze:true },
    shop:         { d:()=>drawShop(),            hud:false },
    credits:      { d:()=>drawCredits(),         hud:false },
    nameEntry:    { d:()=>drawNameEntry(simNow), hud:false },
    // Quit overlay does NOT freeze: the game keeps running behind it (a lone player in a
    // future online match cannot freeze the opponent; local matches the same semantics).
    quitConfirm:  { d:()=>drawQuitConfirm(),     hud:false },
    resetConfirm: { d:()=>drawResetConfirm(),    hud:false, freeze:true },
    paused:       { d:()=>drawGameBoard(simNow), hud:true,  freeze:true },
    duelMenu:     { d:()=>drawDuelMenu(),        hud:false, freeze:true, anim:()=> !!_duelMsg && _msgNow()-_duelMsgAt < 2600 },
    friendId:     { d:()=>drawFriendId(),        hud:false, freeze:true },
    lobby:        { d:()=>drawLobby(),           hud:false },
    friends:      { d:()=>drawFriends(),         hud:false },
    invite:       { d:()=>drawInvite(),          hud:false, freeze:true, anim:()=> !!_inviteMsg && simNow-_inviteMsgAt < 1600 },
    duelReady:    { d:()=>drawDuelBoard(simNow), hud:true },
    duel:         { d:()=>drawDuelBoard(simNow), hud:true },
    duelPaused:   { d:()=>drawDuelBoard(simNow), hud:true, freeze:true },
    duelOver:     { d:()=>drawDuelBoard(simNow), hud:true },
};
const _GAME_SCREEN = { d:()=>drawGameBoard(simNow), hud:true };   // playing/dying/levelReady/levelDone (single)
const _DUEL_SCREEN = { d:()=>drawDuelBoard(simNow), hud:true };   // a duel in a shared game phase (dying/levelDone) draws the duel board, not the single-snake one
function loop(rafNow) {
    requestAnimationFrame(loop);
    // Optional 30 FPS cap: skip whole frames (the sim ticks on in the worker regardless,
    // so gameplay speed is unchanged -- only the draw rate drops).
    if(cfg.fps30 && rafNow-_lastDraw < 32) return;
    _lastDraw = rafNow;
    _updateBtnDim();
    // FPS = frame DELIVERY, not paint count: every loop pass counts, because on a frozen
    // screen skipping the repaint IS keeping up (nothing needed drawing). The box maxes at
    // the display rate and drops only when the main thread cannot serve RAF fast enough.
    // The fps30 cap returns before counting, so capped mode honestly reads ~30.
    fpsFrames++;
    if(rafNow-fpsLast>=500){ const _live=Math.round(fpsFrames*1000/(rafNow-fpsLast));
        if(_fpsRec) _fpsRecordAvg(_live,rafNow); else fpsEl.textContent=`${_live} FPS`;   // recording: box shows locked worst, not live
        fpsFrames=0; fpsLast=rafNow; }

    // Music routing (skip splash/paused/quitConfirm states)
    if(phase!=='splash'&&phase!=='paused'&&phase!=='quitConfirm'&&phase!=='resetConfirm'&&phase!=='levelReady'&&phase!=='duelReady'&&performance.now()>=_musicHoldUntil){   // ready phases are music-NEUTRAL: menu music fades at PLAY, game music starts at playing/duel
        const menuPhase=['menu','settings','scores','credits','nameEntry','achievements','shop','resetConfirm','duelMenu','friendId','invite','lobby','friends'].includes(phase);
        // Re-assert the shared-clock seek on EVERY menu entry (from splash OR from a game), not
        // just at boot: hold the menu track until the clock is synced so it opens on the globally
        // shared bar. Only actually waits when online and not yet synced; otherwise no delay.
        if(menuPhase && !_wasMenuPhase && typeof _netOk==='function' && _netOk() && (typeof netPts!=='function' || netPts()==null))
            _musicSyncWaitUntil = performance.now() + MUSIC_SYNC_WAIT_MS;
        _wasMenuPhase = menuPhase;
        const gamePhase=['playing','dying','levelDone','duel','duelOver'].includes(phase);
        const wt=menuPhase?menuTrack():gamePhase?gameTrack():null;
        // Hold menu music at first entry until the clock syncs (started during the coin drop)
        // or the 2s wall passes -- so it opens on the globally-shared bar. Once playing,
        // musicPlay no-ops, so this only gates the START.
        const holdMenu = menuPhase && performance.now() < _musicSyncWaitUntil && (typeof netPts==='function' && netPts()==null);
        // Menu music fades in 0.5s (splash entry + return from game); the game track punches
        // in at GO. BOTH are seeked to the shared clock -- the duel track to its start PTS,
        // the menu track to absolute PTS -- so clients hear the same bar at the same moment.
        if(cfg.music&&wt&&!holdMenu) Snd.musicPlay(wt, menuPhase?0.5:0,
            menuPhase ? (typeof netMenuSeekSec==='function' ? netMenuSeekSec() : 0)
                      : (typeof netMusicSeekSec==='function' ? netMusicSeekSec() : 0));
        else if(!wt&&!menuPhase&&!gamePhase) Snd.musicStop();
    }
    Snd.musicTick(cfg.music);

    // The sim now runs in js/sim-worker.js; its snapshots are applied in _initWorker()'s
    // onmessage (state mirror + event replay). loop() only presents. Keep the frame dt for
    // the worst-frame FPS recorder.
    if(_lastRAF===0) _lastRAF=rafNow;
    let frameMs=rafNow-_lastRAF; _lastRAF=rafNow;
    if(_fpsRec) _fpsRecordFrame(frameMs, rafNow);
    // No worker (file:// forbids Worker construction; exotic browsers): tick the sim
    // in-process with the classic fixed-timestep accumulator. Input already reaches it via
    // _wsend's simCommand fallback, so this is the only missing piece. Pause freezes
    // ticking exactly like the worker's stopped clock does.
    if(!_worker || (typeof netGameActive==='function' && netGameActive())){
        // Mirror the worker's clock semantics exactly: stopped while paused (including
        // paused behind the quit dialog), running otherwise. The quit dialog must not stop
        // the game -- in worker mode the WORKER's phase stays 'playing' behind the main
        // thread's 'quitConfirm'; in-process there is only ONE shared phase, so tick under
        // the underlying phase and restore the dialog afterwards (terminal phases end it,
        // same rule as applyWorkerFrame).
        const dlg = phase==='quitConfirm';
        const under = dlg ? prevPhase : phase;
        if(under!=='paused' && under!=='duelPaused'){
            if(dlg) phase = under;
            // ONE tick rule for every mode: the fixed-timestep accumulator, exactly what
            // single player does (the worker runs this same clock and NOTHING can stall
            // it). netTickPre snapshots the tick's starting state and feeds it the inputs
            // authored for it -- ours and the peer's through the same door, which is what
            // lets a rollback re-simulate the tick identically.
            let ran=0;
            let fb=frameMs; if(fb>250) fb=250;
            _fbAcc+=fb;
            while(_fbAcc>=TICK_MS && ran<MAX_CATCHUP){ _fbAcc-=TICK_MS; if(typeof netTickPre==='function') netTickPre(); update(); ran++; }
            if(ran>=MAX_CATCHUP) _fbAcc=0;
            // The shared clock STEERS this, it does not gate it. Gating on it -- ticking
            // only while simTick < target -- meant the sim stopped dead the instant the
            // target was not ahead of us: READY/GO frozen, input piling up unapplied, the
            // game dead for seconds at every duel start. A clock that can stop the game is
            // not a clock, it is a switch. Single player never had this because its worker
            // ticks regardless.
            // So: nudge by at most ONE tick per frame toward the target. Behind -> one
            // extra tick; ahead -> hold the accumulator back a tick. Drift is corrected
            // within a frame or two and the sim NEVER stops.
            // BOUNDED. Holding the accumulator back every frame cancels the accumulation
            // exactly, which is the gate again wearing a different hat -- it stalled the
            // sim just as dead. So only correct drift we could plausibly have EARNED
            // (a couple of seconds); a bigger gap means the origin is wrong, and chasing
            // a wrong origin is how the game ends up frozen waiting for a moment that
            // never comes. Run free instead: drifting from the peer is recoverable
            // (rollback), a dead game is not.
            const _tgt = (typeof netTickTarget==='function') ? netTickTarget() : null;
            const _d = _tgt === null ? 0 : _tgt - simTick;
            if(_tgt !== null && Math.abs(_d) <= 120 && ran < MAX_CATCHUP){
                if(_d > 1){ if(typeof netTickPre==='function') netTickPre(); update(); }   // behind: one extra tick
                // AHEAD: hold a tick back, but only every 8th frame. Doing it EVERY frame
                // takes back exactly what the frame just added -- the sim does not slow
                // down, it STOPS, for as long as we are ahead. That is what made the game
                // dead for seconds after the start: startPts a moment in the future pins
                // simTick at a standstill until wall time reaches it, input piling up in
                // dirQueue with nothing to step it. A correction that can zero the tick
                // rate is not a correction. This one converges at ~90% speed.
                else if(_d < -1 && (++_clkHold & 7) === 0) _fbAcc = Math.max(-TICK_MS, _fbAcc - TICK_MS);
            }
            if(simEvents.length) drainSimEvents();
            if(dlg){
                prevPhase = phase;   // the game behind the dialog may have evolved (death, level change)
                if(phase!=='nameEntry' && phase!=='duelOver') phase = 'quitConfirm';
                else Snd.duck(false);   // the game ended behind the dialog: undo the 50% duck
            }
        }
    }
    applyWorkerFrame();   // mirror the newest worker snapshot + replay its events (coalesced)
    flushSfxQ();          // event sfx play 2 ticks late (see drainSimEvents)
    flushFxQ();           // event visuals (bonus/crush/fireworks) play 2 ticks late too
    updateNetDebugOverlay(rafNow);
    _updateDbgSnapBtn();
    checkWorkerStall(rafNow);
    updateSplashExit();   // splash->menu is a UI transition (main-owned)
    updateHUD();          // HUD sync is presentation

    // Generic draw: pick the phase's policy and apply it uniformly. A freezable screen
    // is skipped (last frame kept on the canvas) while nothing changed (_uiDirty) and
    // nothing is animating -- neither a global overlay nor the screen's own anim().
    if(phase!==_lastPhase){
        _uiDirty=true;
        if(phase==='duelOver') quitConfirmSel=0;   // rematch dialog opens with YES pre-selected
        _lastPhase=phase;
    }
    const s = SCREENS[phase] || (players ? _DUEL_SCREEN : _GAME_SCREEN);   // shared game phases (dying/levelDone) pick the board by snake count
    const transient = achPopups.length>0 || confetti.length>0;
    let skip = s.freeze && !_uiDirty && !transient && !(s.anim && s.anim());
    if(!skip){ s.d(); showHUD(s.hud); }
    if(!skip) drawAchPopups(simNow);
    _uiDirty = false;
}

// ================================================================
// SIM WORKER  (the deterministic sim runs off the render thread: js/sim-worker.js)
// The worker ticks the sim continuously and posts {snapshot, events} each frame. We mirror
// the snapshot into the sim globals (render.js reads them) and replay the events. Gameplay
// input and phase changes are forwarded to the worker. `phase` is MAIN-owned in menus and
// the in-game QUIT overlay, WORKER-owned during gameplay (playing/dying/levelDone/...).
// ================================================================
// _wsend forwards a command to the worker; with no worker (headless test harness / any
// browser lacking Worker) it applies the command in-process via simCommand so the sim, which
// is driven directly there, still receives input.
function _wsend(m){
    // Online duels run the sim in-process on BOTH ends (prediction + replay need
    // synchronous access): commands go straight to it, not to the worker (which
    // idles on its menu phase until the session ends).
    if(inGame && typeof netGameActive==='function' && netGameActive() && typeof simCommand==='function'){ simCommand(m); return; }
    if(_worker) _worker.postMessage(m); else if(typeof simCommand==='function') simCommand(m);
}
function _cfgForWorker(){ return { diff: cfg.diff|0, turbo: cfg.turbo!==false, x10: !!cfg.x10 }; }
function beginGame(){
    if(typeof netEndSession==='function') netEndSession();   // a lingering online session must never eat the local game's frames
    inGame = true; Snd.musicFadeOut(0.5);   // menu music fades out; READY/GO runs silent
    const seed = (Math.random()*0x100000000)>>>0;   // main-made so the score submission can carry it
    if(typeof netNoteGameStart === 'function') netNoteGameStart(seed);
    _wsend({ t:'start', seed, bestScore:bestScore() });
}
// Online duel entry (called by net.js when the DataChannel opens on both ends).
// BOTH clients start the same deterministic sim from the shared seed and run it
// locally (in-process). There is no host and no authority: each side sends only
// its own tick-stamped inputs and rolls back to re-simulate when a late one
// arrives (net.js). The shared seed + start_pts keep both timelines in step.
function beginOnlineDuel(seed, hosting){
    inGame = true; Snd.musicFadeOut(0.5);
    _musicHoldUntil = performance.now() + 1500;
    showHUD(true);
    _fbAcc = 0;                                   // fresh in-process tick accumulator
    _sfxQ.length = 0; _fxQ.length = 0;            // queued against the OLD tick counter: startDuel rewinds it to 0
    _wsend({ t:'startDuel', seed:seed>>>0, x10:(typeof netDuelX10==='function')?netDuelX10():!!cfg.x10 });   // routes to the LOCAL sim on both ends
    if(typeof _rbReset === 'function') _rbReset();   // AFTER startDuel: it rewinds simTick, and the base reads it
}
// Local 1:1 entry (one screen, two keyboards): no network and no seed sharing --
// just start the deterministic duel sim in-process.
function beginDuel(){ if(typeof netEndSession==='function') netEndSession(); inGame = true; Snd.musicFadeOut(0.5); _sfxQ.length = 0; _fxQ.length = 0;   // startDuel rewinds simTick to 0: stale queue entries would never flush
    _wsend({ t:'startDuel', seed:null, x10:!!cfg.x10 }); }
function _initWorker(){
    // Headless harness has no Worker: _wsend falls back to simCommand and the tests drive
    // update() directly. In a browser a construction failure (file://, CSP) must not throw
    // here -- that would abort the bootstrap below and leave a black screen instead of at
    // least reaching the console error.
    if(typeof Worker==='undefined') return;
    try { _worker = new Worker('js/sim-worker.js'); }
    catch(err){ console.error('sim worker failed to start -- using the in-process sim', err); return; }
    _worker.onerror = (err)=>{
        console.error('sim worker error', (err&&err.message)||err);
        // Some engines do not throw at construction (e.g. the file:// script load fails
        // ASYNCHRONOUSLY): a worker that errors before delivering a single frame is dead.
        // Demote to the in-process sim instead of hanging forever.
        if(_workerFrames===0) _demoteWorker();
    };
    // Coalesce: keep only the LATEST snapshot (an old one has nothing the new one lacks)
    // but accumulate ALL events (none may be lost). loop() applies once per drawn frame,
    // so main-thread work is bounded by the draw rate, not the worker's post rate.
    _worker.onmessage = (e)=>{
        const m = e.data; if(m.t!=='frame') return;
        _workerFrames++;
        _lastWorkerFrameAt = performance.now();   // watchdog heartbeat
        // bars travel only when changed: when a pending snapshot that carried them is
        // overwritten by one that did not, carry them forward or they would be lost.
        if(_pendingSnap && _pendingSnap.bars != null && m.snap.bars == null) m.snap.bars = _pendingSnap.bars;
        _pendingSnap = m.snap;
        if(m.events && m.events.length) _pendingEvents.push.apply(_pendingEvents, m.events);
    };
    _wsend({ t:'cfg', cfg:_cfgForWorker() });
    _wsend({ t:'run', on:true });
    _lastWorkerFrameAt = performance.now();   // arm the watchdog: a worker that never posts at all is also a stall
}
let _pendingSnap = null, _pendingEvents = [];
let _fbAcc = 0;   // fixed-timestep accumulator for the no-worker in-process fallback
let _lastWorkerFrameAt = 0, _stallLogged = false, _workerFrames = 0;
// Kill a worker that never became functional and let loop()'s !_worker path take over.
function _demoteWorker(){
    console.error('sim worker unusable -- falling back to the in-process sim');
    try { if(_worker) _worker.terminate(); } catch(e) {}
    _worker = null; _pendingSnap = null; _pendingEvents = [];
}
// Inverse of the worker's transport packing (see sim-worker.js _post -- keep in sync).
// The snake unpacks into a pooled object array so 60Hz unpacking does not churn the GC;
// null bars mean "unchanged", so the current mirror array is kept.
const _mirrorSnake = [];
function _unpackSnap(snap){
    const sf = snap.snake;
    if (sf instanceof Int16Array) {
        const n = sf.length / 2;
        if (_mirrorSnake.length > n) _mirrorSnake.length = n;
        for (let i = 0; i < n; i++) {
            const o = _mirrorSnake[i] || (_mirrorSnake[i] = {x:0,y:0});
            o.x = sf[i*2]; o.y = sf[i*2+1];
        }
        snap.snake = _mirrorSnake;
    }
    const bf = snap.bars;
    if (bf == null) snap.bars = bars;   // unchanged since last post: keep the mirror's copy
    else if (bf instanceof Int16Array) {
        const arr = [];
        for (let i = 0; i < bf.length; i += 6) {
            const o = { x: bf[i], y: bf[i+1], fragile: !!bf[i+2] };
            if (bf[i+3]) o.paired = true;
            if (bf[i+4] >= 0) o.pairEnd = { x: bf[i+4], y: bf[i+5] };
            arr.push(o);
        }
        snap.bars = arr;   // rare (level begin / crush): a fresh array is fine
    }
}
function applyWorkerFrame(){
    if(!_pendingSnap) return;
    if(typeof netGameActive === 'function' && netGameActive()){   // online: the in-process sim owns the state
        _pendingSnap = null; _pendingEvents.length = 0; return;
    }
    _unpackSnap(_pendingSnap);
    const snapRef = _pendingSnap;
    const mainOwnsPhase = !inGame || phase==='quitConfirm';   // menus + quit overlay: main keeps its phase
    const keep = phase, snapPhase = _pendingSnap.phase;
    simApply(_pendingSnap); _pendingSnap = null;
    if(mainOwnsPhase){
        // The quit overlay does not freeze the game -- if it ENDS behind the dialog
        // (game over / duel decided), the terminal phase takes precedence and closes it.
        if(keep==='quitConfirm' && (snapPhase==='nameEntry'||snapPhase==='duelOver')){ phase = snapPhase; Snd.duck(false); }
        else phase = keep;
    }
    const evRef = _pendingEvents.length ? _pendingEvents : null;
    if(evRef){ simEvents = evRef; _pendingEvents = []; drainSimEvents(); }
}
// Watchdog: the worker posts continuously except while paused (it freezes the clock then).
// If frames stop arriving anywhere else, the sim thread is dead/stalled -- say so instead
// of silently freezing, so it is debuggable in the field.
function checkWorkerStall(now){
    if(!_worker || phase==='paused' || phase==='duelPaused' || phase==='quitConfirm') { _stallLogged=false; return; }
    if(_lastWorkerFrameAt && now-_lastWorkerFrameAt > 3000){
        // Never delivered a single frame -> the worker is dead (silently blocked script
        // load etc.): demote to the in-process sim rather than stalling forever.
        if(_workerFrames===0){ _demoteWorker(); return; }
        if(!_stallLogged){ console.error('sim worker: no frame for 3s -- simulation stalled'); _stallLogged=true; }
        fpsEl.textContent='SIM STALL';
    } else _stallLogged=false;
}
_initWorker();

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
let _lastCw = -1, _layoutDbg = {};
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
        // Cache the layout numbers for the graphics debug quadrant (bottom-left,
        // built by updateNetDebugOverlay). Layout runs on resize; the overlay reads
        // this + the live FPS. (#debug in the URL only enables debug mode; the
        // DEBUG LEVEL 2+ gate on drawing lives in the overlay.)
        _layoutDbg = { mode, vpW, vpH, wW, wH, m, scale, cw, ch: CH*scale };
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
// Startup can race the web font and the browser's first CSS layout, which occasionally
// locked a too-small canvas on reload: layout() sets the --fs-* vars it also measures, and
// the _lastCw "converged" guard then froze a bad early value (the RO on #wrap never re-fires
// once the canvas has a fixed px size). _relayout forces two passes past that guard -- the
// 2nd pass re-measures the chrome with the vars the 1st set, so the feedback converges.
// Run it now, once the font is ready, and again on full load.
function _relayout(){ _lastCw = -1; layout(); _lastCw = -1; layout(); }
requestAnimationFrame(_relayout);
if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(_relayout);
window.addEventListener('load', _relayout);

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
        // Update checks: once per minute, plus immediately on regaining focus when
        // the last check is over a minute old -- but ONLY on screens where the
        // resulting auto-reload (controllerchange below) cannot kill anything:
        // never during a run, a name entry, or an online lobby/handshake.
        const _updSafe = new Set(['splash']);   // update checks (and their auto-reload) happen ONLY on the splash
        let _lastUpd = Date.now();
        const _updCheck = (reg) => {
            if (Date.now() - _lastUpd < 60000) return;
            if (!navigator.onLine || inGame || !_updSafe.has(phase)) return;
            _lastUpd = Date.now();
            reg.update().catch(() => {});
        };
        navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => {
            if (navigator.onLine) reg.update().catch(() => {});
            if (typeof setInterval === 'function') setInterval(() => _updCheck(reg), 60000);
            document.addEventListener('visibilitychange', () => { if (!document.hidden) _updCheck(reg); });
        });
        let _reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (_reloading || !wasControlled) return;
            _reloading = true;
            window.location.reload();
        });
    });
}