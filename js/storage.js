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
    const date = `${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getFullYear()).slice(-2)}`;
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
function defaultCfg() {
    return { music:true, diff:1, musicStyle:0, snakeColor:0, shopItems:{}, wornItems:null,
             handed:0, volume:1, sfxVol:0.5, turbo:true, touchSelect:false, offline:false, fps30:false, disableGlow:false,
             boxPity:0, shopOpens:0, debug:0, x10:false, noP2P:false, cfgVer:3 };
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
    cfg.x10         = !!cfg.x10;   // DEBUG: x10 rare events (persisted like cfg.debug)
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
function getPlayerId() {
    let id = null;
    try { id = localStorage.getItem(PID_KEY); } catch(e) {}
    if (!/^[0-9a-f]{8}$/.test(id || '')) {
        let b;
        try { b = crypto.getRandomValues(new Uint8Array(4)); }
        catch(e) { b = Array.from({length:4}, () => Math.floor(Math.random()*256)); }
        id = ''; for (let i = 0; i < 4; i++) id += (b[i] < 16 ? '0' : '') + b[i].toString(16);
        try { localStorage.setItem(PID_KEY, id); } catch(e) {}
    }
    return id;
}
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
    if (!a.includes(id)) {
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
            set(HS_KEY,'hs'); set(FK_KEY,'coins'); set(ACH_KEY,'ach'); set(CFG_KEY,'cfg'); set('lastSName','name'); set(PID_KEY,'pid'); set(FRIENDS_KEY,'friends');
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
