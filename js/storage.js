// ============================================================================
// storage.js -- ALL persistent save data + meta progress: high scores, FOKoins,
// config (defaults/sanitize/load/save), achievements, announcement flag, reset,
// and the backup/restore file with its integrity checksum. Everything that
// touches localStorage or the save file lives here (and, later, the global
// high-score submit/fetch). Loaded after sim.js, before game.js -- call-time
// references into game state (cfg, _wsend, achPopups, ...) resolve at runtime.
// ============================================================================
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
// Best local score -- passed into startGame() so the sim never touches localStorage itself.
function bestScore(){ let b=0; try{ for(const s of getScores()) if((s.score||0)>b) b=s.score; }catch(e){} return b; }
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
    const p2 = n => ('0' + n).slice(-2);   // ES5 pad: padStart is ES2017, absent on old smart-TV engines (this runs at game over)
    const date = p2(now.getDate()) + '.' + p2(now.getMonth()+1) + '.' + String(now.getFullYear()).slice(-2);
    s.push({ name:name.trim().substring(0,MAX_NAME), score:sc, level:lvl,
             diff:cfg.diff, color:cfg.snakeColor||0, shopItems:Object.assign({}, cfg.wornItems||{}), date });
    s.sort((a, b) => b.score - a.score);
    try { localStorage.setItem(HS_KEY, JSON.stringify(s.slice(0, 10))); } catch (e) {}
    addFOKoins(sc);
}
function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} _wsend({ t:'cfg', cfg:_cfgForWorker() }); }
// Fresh default config each call (new objects, so nothing is shared/aliased).
// cfg.offline: when ON, future online features (1v1 dualplay, global online stats)
// must stay disabled -- gate all networking on !cfg.offline.
// TODO(perf/tv): consider defaulting disableGlow:true on weak devices (smart-TV / coarse-pointer
// + no fine pointer). shadowBlur is the dominant per-frame GPU cost (~2-10 blurred fills/frame);
// off by default on a TV would lift FPS materially. Gate on a device heuristic, keep it on for
// desktop/mobile where the glow reads well and the GPU can afford it.
// Seed REDUCE MOTION from the OS accessibility preference the first time (no saved value yet),
// so a user who asks the system for less motion gets it without touching the menu. Guarded for
// environments without matchMedia (old engines, the sim worker). Still user-overridable after.
function _prefersReducedMotion() {
    try { return typeof matchMedia==='function' && matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
}
function defaultCfg() {
    return { music:true, diff:1, musicStyle:0, snakeColor:0, shopItems:{}, wornItems:null,
             handed:0, volume:1, sfxVol:0.5, turbo:true, touchSelect:false, offline:false, fps30:false, disableGlow:false, deferDraw:true, singleThreaded:false, gfxMode:1, reduceMotion:_prefersReducedMotion(),
             autoCloud:false, boxPity:0, shopOpens:0, debug:0, x10:false, noP2P:false, cfgVer:3 };
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
    cfg.deferDraw   = !!cfg.deferDraw;
    cfg.singleThreaded  = !!cfg.singleThreaded;
    cfg.gfxMode     = idx(cfg.gfxMode, 3, 1);   // 0 SIMPLE / 1 STANDARD (default) / 2 FABULOUS (not yet implemented)
    cfg.reduceMotion = !!cfg.reduceMotion;   // absent -> defaultCfg() already seeded it from the OS pref
    cfg.autoCloud   = !!cfg.autoCloud;   // daily automatic cloud backup
    cfg.x10         = !!cfg.x10;   // DEBUG: x10 rare events (persisted like cfg.debug)
    cfg.noP2P       = !!cfg.noP2P;   // relay-only network toggle
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
    // v3: relay-only was a stop-gap default while the handshake was unreliable.
    // Drop the saved value so P2P (the low-latency path) is used again; anyone who
    // really wants the relay can turn it back on in SETTINGS > NETWORK.
    if(!s.cfgVer || s.cfgVer < 3) delete s.noP2P;
    Object.assign(cfg, defaultCfg(), s);
    // The migrations above key off the STORED version; the live cfg must always carry the
    // current one. Otherwise a stale stored cfgVer overrides the default here and every
    // saveCfg re-persists it, so each one-shot migration re-fires on every load (a set
    // setting silently reverts). Bump this in lockstep whenever a new migration is added.
    cfg.cfgVer = 3;
    _sanitizeCfg();
}

const ACH_KEY = 'fok-snake-ach';
let achUnlocked = {};
let achPopups = [];   // {id, at}
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

function resetStats() {
    const keys = [HS_KEY, FK_KEY, ACH_KEY, 'lastSName'];
    keys.forEach(k=>{ try { localStorage.removeItem(k); } catch (e) {} });
    _cachedFOKoins = 0;
    achUnlocked = {}; achPopups = []; _scoreboardCache = null;
    cfg.shopItems = {}; cfg.wornItems = null; saveCfg();   // NOTE: cfg.debug (+ other settings) intentionally preserved
}
// Reset SETTINGS (preferences) to defaults, keeping stats, owned shop items, the id and
// friends. Distinct from RESET STATS (scores/coins) and RESET ID (identity).
function resetSettings() {
    const d = defaultCfg(), keep = { shopItems:1, wornItems:1, boxPity:1, shopOpens:1, debug:1, x10:1, cfgVer:1 };
    for(const k in d) if(!keep[k]) cfg[k] = d[k];
    saveCfg();
    // Re-apply the reset preferences to the LIVE app -- writing cfg alone leaves everything with
    // a live side-effect on its PRE-reset state. The reported bug: audio resets to ON in cfg, but
    // the engine stays muted and the speaker button keeps its 'muted' look. Same re-apply the
    // restore path (_applyRestoredConfig) does.
    applyHandedness();
    Snd.musicSetVolume(cfg.volume==null?1:cfg.volume); Snd.sfxSetVolume(cfg.sfxVol==null?0.5:cfg.sfxVol);
    if(cfg.music){ Snd.audioResume(); Snd.musicUnmute('mute'); } else Snd.musicMute('mute');
    updateMuteBtn();
}

// ================================================================
// BACKUP / RESTORE / INTEGRITY
// ================================================================
// Backup/restore all game data (scores, coins, achievements, shop items, settings)
// as a downloadable JSON file. A backup is a full clone -- restore overwrites.
// ---- Player ID: this client's stable identity. 64 bits crypto-random, generated
// lazily on first read, persisted next to the save and carried in backups so identity
// travels with them. Shown in SETTINGS > USER; later the key the server uses for
// global scores and 1:1 matchmaking (an unguessable SECRET, if ever needed, would be
// a separate token -- this ID is the public identity).
const PID_KEY = 'fok-snake-pid';
// Mirror the ID into a long-lived first-party cookie as well as localStorage. Firefox clears
// cookies under a DIFFERENT toggle than site data / localStorage (and by last-access, not
// wholesale), so the ID -- our identity anchor for a future cloud restore -- can outlive a
// "clear site data" that wiped the save. ONLY the 8-hex id lives here, never scores or config
// (a cookie rides every request: keep it tiny). Max-Age ~400d is the browser-honoured ceiling.
const PID_COOKIE = 'fok_pid';
function _pidCookieGet(){
    try { const m = document.cookie.match(/(?:^|;\s*)fok_pid=([0-9a-f]{8})(?:;|$)/); return m ? m[1] : null; }
    catch(e){ return null; }
}
function _pidCookieSet(id){
    try { document.cookie = PID_COOKIE + '=' + id + '; Max-Age=34560000; Path=/; SameSite=Lax; Secure'; } catch(e){}
}
// Cookie is the long-lived MASTER reference; localStorage is the backup that can rebuild the
// cookie if it is absent. Read cookie first, fall back to localStorage, mint only if neither
// has it -- then keep both in sync (and refresh the cookie's rolling expiry).
function getPlayerId() {
    let id = _pidCookieGet();                                   // MASTER: the long-lived cookie
    if (!/^[0-9a-f]{8}$/.test(id || '')) {                      // cookie gone: fall back to the localStorage backup
        try { id = localStorage.getItem(PID_KEY); } catch(e) {}
    }
    if (!/^[0-9a-f]{8}$/.test(id || '')) {                      // neither store has it: mint a fresh identity
        let b;
        try { b = crypto.getRandomValues(new Uint8Array(4)); }
        catch(e) { b = Array.from({length:4}, () => Math.floor(Math.random()*256)); }
        id = ''; for (let i = 0; i < 4; i++) id += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    }
    try { if (localStorage.getItem(PID_KEY) !== id) localStorage.setItem(PID_KEY, id); } catch(e) {}   // keep the backup current
    _pidCookieSet(id);                                          // (re)assert the master + refresh its rolling expiry
    return id;
}
// Mint a NEW identity (new cookie + localStorage) while keeping every OTHER save value. This
// is the ID-only reset -- distinct from a full settings/data reset, which is a separate action.
function resetPlayerId() {
    let b;
    try { b = crypto.getRandomValues(new Uint8Array(4)); }
    catch(e) { b = Array.from({length:4}, () => Math.floor(Math.random()*256)); }
    let id = ''; for (let i = 0; i < 4; i++) id += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    try { localStorage.setItem(PID_KEY, id); } catch(e) {}
    _pidCookieSet(id);
    return id;
}
// Cloud-backup token: the server mints a 128-bit token on the first cloud backup and REQUIRES
// it (with the id) for every later backup and every restore. Persist it like the id -- cookie
// (master) + localStorage backup -- so it too survives a site-data wipe, and carry it in the
// file backup so restoring a file re-establishes cloud access.
const TOK_KEY = 'fok-snake-tok';
function _tokCookieGet(){
    try { const m = document.cookie.match(/(?:^|;\s*)fok_tok=([0-9a-f]{16,64})(?:;|$)/i); return m ? m[1] : null; }
    catch(e){ return null; }
}
function _tokCookieSet(t){ try { document.cookie = 'fok_tok=' + t + '; Max-Age=34560000; Path=/; SameSite=Lax; Secure'; } catch(e){} }
function getCloudToken(){
    let t = _tokCookieGet();
    if(!/^[0-9a-f]{16,64}$/i.test(t||'')){ try { t = localStorage.getItem(TOK_KEY); } catch(e){} }
    return /^[0-9a-f]{16,64}$/i.test(t||'') ? t : null;
}
function setCloudToken(t){
    if(!/^[0-9a-f]{16,64}$/i.test(t||'')) return;
    try { localStorage.setItem(TOK_KEY, t); } catch(e){}
    _tokCookieSet(t);
}
try { getPlayerId(); } catch(e){}                              // establish identity + seed both stores at load
function fmtPlayerId() { return fmtFriendId(getPlayerId()); }
// The friend-invite URL this client hands out (QR in SETTINGS > USER): opening it loads
// the game with the friend's ID in the hash -- never sent to any server, PWA/cache-safe.
function friendUrl() { return GAME_URL + '#friend=' + getPlayerId(); }
// ---- Friends: IDs collected from invite links (boot hash parse), the ADD FRIEND
// entry and the QR scan (1:1 menu). A capped list of public player IDs -- the
// future matchmaking server reads it; until then it is display-only.
const FRIENDS_KEY = 'fok-snake-friends';
function getFriends() {
    try {
        const a = JSON.parse(localStorage.getItem(FRIENDS_KEY) || '[]');
        return Array.isArray(a) ? a.filter(x => /^[0-9a-f]{8}$/.test(x)) : [];
    } catch(e) { return []; }
}
function addFriend(id) {
    if (!/^[0-9a-f]{8}$/.test(id || '') || id === getPlayerId()) return false;
    const a = getFriends();
    if (a.indexOf(id) < 0) {   // indexOf: Array.includes is ES2016, absent on old smart-TV engines
        a.push(id);
        try { localStorage.setItem(FRIENDS_KEY, JSON.stringify(a.slice(-64))); } catch(e) {}
    }
    if (typeof netFriendRequest === 'function') netFriendRequest(id);   // server handshake (soft, offline-safe)
    return true;   // already-known counts as success (idempotent add)
}
function removeFriend(id) {
    const a = getFriends().filter(x => x !== id);
    try { localStorage.setItem(FRIENDS_KEY, JSON.stringify(a)); } catch(e) {}
}
function fmtFriendId(id) { return id.toUpperCase().replace(/(.{4})(?=.)/g, '$1-'); }

function _saveSnapshot() {
    return { v:1,
        hs:    localStorage.getItem(HS_KEY),
        coins: localStorage.getItem(FK_KEY),
        ach:   localStorage.getItem(ACH_KEY),
        cfg:   localStorage.getItem(CFG_KEY),
        name:  localStorage.getItem('lastSName'),
        pid:   getPlayerId(),
        friends: getFriends().length ? JSON.stringify(getFriends()) : undefined };
}
// FNV-1a over the backup's data fields -- a light integrity check so a hand-edited file is
// rejected on restore. Recomputed the same way on both sides from a fixed key order.
function _sum(s){ let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619)>>>0; } return h; }
function _sumOf(d){ return _sum(JSON.stringify({v:d.v,hs:d.hs,coins:d.coins,ach:d.ach,cfg:d.cfg,name:d.name,pid:d.pid,friends:d.friends})); }   // old backups lack pid/friends: undefined is dropped by stringify, so their crc still validates
// Serialize an object to a downloaded JSON file. Shared by the backup + the debug exports.
function _downloadJSON(filename, obj){
    const blob=new Blob([JSON.stringify(obj, null, 2)], {type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=filename;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
// Apply a restored config snapshot (from a file OR the cloud) to local storage + the cookie.
// Rejects a snapshot whose checksum does not match (older, checksumless backups still accepted).
// Restores the id into the cookie (master) and the cloud token too. Returns true on success.
function _applyRestoredConfig(d){
    if(!d || typeof d!=='object') return false;
    if(d.crc && d.crc!==_sumOf(d)) return false;
    const set=(k,key)=>{ if(key in d){ const v=d[key]; if(v==null) localStorage.removeItem(k); else localStorage.setItem(k,v); } };
    set(HS_KEY,'hs'); set(FK_KEY,'coins'); set(ACH_KEY,'ach'); set(CFG_KEY,'cfg'); set('lastSName','name'); set(PID_KEY,'pid'); set(FRIENDS_KEY,'friends');
    if(/^[0-9a-f]{8}$/.test(d.pid||'')) _pidCookieSet(d.pid);   // identity into the cookie (master) too
    if(d.tok) setCloudToken(d.tok);                            // and the cloud-restore credential
    _cachedFOKoins=getFOKoins(); loadAch(); loadCfg();
    if(cfg.wornItems===null){ cfg.wornItems=Object.assign({}, cfg.shopItems||{}); }
    applyHandedness(); updateMuteBtn(); _scoreboardCache=null;
    Snd.musicSetVolume((cfg.volume==null?1:cfg.volume)); Snd.sfxSetVolume((cfg.sfxVol==null?0.5:cfg.sfxVol));
    return true;
}
function backupStats() {
    try {
        const snap=_saveSnapshot();
        snap.crc=_sumOf(snap);              // integrity checksum over the manifest fields (crc + tok excluded)
        snap.tok=getCloudToken()||undefined;   // FILE-only client extension: carries the cloud token so a file restore re-establishes cloud access
        _downloadJSON('snake-fok-backup.json', snap);
        _dataMsg='CONFIG SAVED TO FILE'; _dataMsgAt=simNow;
    } catch (e) { _dataMsg='FILE BACKUP FAILED'; _dataMsgAt=simNow; }
}
// Cloud backup: POST the whole config to the vault. First time mints a token (store it in
// both stores + cookie); later backups present it. Payload is opaque to the server.
// TODO(compat): async/await is ES2017. This is a CORE file (loadCfg/getScores run at boot),
// so a pre-2017 engine (a ~10-year-old phone that never updated its browser) throws a
// SyntaxError parsing the WHOLE file -> single-player black-screens. Regressed in v2.2.0
// (cloud config). This + the other 3 async fns below/in game.js are the only ES2017 syntax
// in core. FIX (decide later): ISOLATE these into an optional online-tier file (like net.js,
// which is already async and which single-player survives failing to parse) -- preferred, a
// verbatim move, no logic risk; OR rewrite to .then() chains (touches working, under-tested
// network code). Until then, old engines cannot run the game at all.
async function cloudBackup(silent) {
    if(typeof _netOk!=='function' || !_netOk()){ if(!silent){ _dataMsg='OFFLINE'; _dataMsgAt=simNow; } return false; }
    if(!silent){ _dataMsg='CLOUD BACKUP...'; _dataMsgAt=simNow; }
    let ok=false;
    try {
        const snap=_saveSnapshot(); snap.crc=_sumOf(snap);
        const payload=JSON.stringify(snap);
        const _post=(body)=>fetch(NET_BASE+'/api/backup.php',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const tok=getCloudToken();
        let r=await _post(tok ? { id:getPlayerId(), payload, token:tok } : { id:getPlayerId(), payload });
        let j=await r.json().catch(()=>null);
        // The admin can RESET a backup's token (manual recovery of a tokenless backup). If our
        // stored token is refused, retry once WITHOUT it: a reset backup then mints a FRESH
        // token, which we adopt into the cookie. A genuine conflict 403s again and we keep ours.
        if(r.status===403 && tok){
            r=await _post({ id:getPlayerId(), payload });
            j=await r.json().catch(()=>null);
        }
        if(r.status===200 && j && j.ok){ setCloudToken(j.token); ok=true; if(!silent) _dataMsg='CLOUD BACKUP SAVED'; }
        else if(r.status===403){ if(!silent) _dataMsg='CLOUD: WRONG DEVICE'; }
        else if(r.status===413){ if(!silent) _dataMsg='CLOUD: TOO LARGE'; }
        else { if(!silent) _dataMsg='CLOUD BACKUP FAILED'; }
    } catch(e){ if(!silent) _dataMsg='CLOUD BACKUP FAILED'; }
    if(!silent) _dataMsgAt=simNow;
    return ok;
}
// Daily automatic cloud backup (opt-in via cfg.autoCloud). Called on a timer; the 24h throttle
// lives here, so callers can fire it freely. Silent -- no menu feedback line for the auto path.
const AUTOCLOUD_KEY='fok-snake-autocloud-at';
// TODO(compat): ES2017 async/await in a CORE file -- breaks old-engine parsing (see cloudBackup).
async function _maybeAutoCloudBackup(){
    if(!cfg.autoCloud || typeof _netOk!=='function' || !_netOk()) return;
    let at=0; try{ at=parseInt(localStorage.getItem(AUTOCLOUD_KEY)||'0',10)||0; }catch(e){}
    if(Date.now()-at < 86400000) return;                                   // at most once per day
    if(await cloudBackup(true)){ try{ localStorage.setItem(AUTOCLOUD_KEY, String(Date.now())); }catch(e){} }
}
// Cloud restore: GET the vault with id + token, apply it. Needs the token (from the cookie/
// localStorage, or a prior file restore) -- id alone cannot read someone else's backup.
// TODO(compat): ES2017 async/await in a CORE file -- breaks old-engine parsing (see cloudBackup).
async function cloudRestore() {
    if(typeof _netOk!=='function' || !_netOk()){ _dataMsg='OFFLINE'; _dataMsgAt=simNow; return; }
    const tok=getCloudToken();
    if(!tok){ _dataMsg='NO CLOUD TOKEN'; _dataMsgAt=simNow; return; }
    _dataMsg='CLOUD RESTORE...'; _dataMsgAt=simNow;
    try {
        const r=await fetch(NET_BASE+'/api/backup.php?id='+getPlayerId()+'&token='+encodeURIComponent(tok));
        const j=await r.json().catch(()=>null);
        if(r.status===200 && j && j.ok && typeof j.payload==='string'){
            let d=null; try{ d=JSON.parse(j.payload); }catch(e){}
            _dataMsg=_applyRestoredConfig(d)?'CLOUD RESTORED':'CLOUD: BAD DATA';
        } else if(r.status===404) _dataMsg='CLOUD: NO BACKUP';
        else if(r.status===403) _dataMsg='CLOUD: WRONG TOKEN';
        else _dataMsg='CLOUD RESTORE FAILED';
    } catch(e){ _dataMsg='CLOUD RESTORE FAILED'; }
    _dataMsgAt=simNow;
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
            _dataMsg=_applyRestoredConfig(d)?'CONFIG RESTORED':'INVALID FILE'; _dataMsgAt=simNow;
        } catch (e) { _dataMsg='INVALID FILE'; _dataMsgAt=simNow; }
    };
    rd.onerror=()=>{ _dataMsg='READ FAILED'; _dataMsgAt=simNow; };
    rd.readAsText(f);
});
function restoreStats(){ try{ _restoreInp.click(); }catch (e){} }

const fpsEl = document.getElementById('fps-el');
