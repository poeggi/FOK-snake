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

function startLen(lvl) {
    if (lvl <= 2) return 3; if (lvl <= 5) return 5; if (lvl <= 8) return 7; return 10;
}

// ================================================================
// CANVAS
// ================================================================
const canvas = document.getElementById('c');
canvas.width = CW; canvas.height = CH;
const ctx = canvas.getContext('2d');

// ================================================================
// AUDIO
// ================================================================
const Snd = (() => {
    let ac = null, mGain, sGain, _vol = 1, _sfxVol = 0.5, _justInited = false;
    let chState = [], curTrack = null, isPaused = false, _bgSuspended = false;

    const SEQ = {
        // NEW style (3-channel)
        ambient: { bpm: 85, channels: [
            { fn:'tri',  vol:0.26, notes:[
                [659,1],[784,1],[659,1],[523,1],
                [523,1.5],[0,0.5],[440,1],[0,1],
                [440,1],[523,1],[659,1],[523,1],
                [440,1],[0,1],[440,1],[0,1],
            ]},
            { fn:'bass', vol:0.16, notes:[ [131,4],[0,4],[220,4],[0,4] ]},
            { fn:'pad',  vol:0.09, notes:[
                [196,1],[262,1],[330,1],[0,1],
                [196,1],[262,1],[330,1],[0,1],
                [220,1],[262,1],[330,1],[0,1],
                [220,1],[262,1],[330,1],[0,1],
            ]},
        ]},
        game: { bpm: 188, channels: [
            { fn:'fat',  vol:0.28, notes:[
                [440,0.5],[0,0.25],[494,0.25],[523,0.5],[494,0.5],
                [440,1],[0,0.5],[440,0.5],
                [523,0.5],[0,0.25],[587,0.25],[659,0.5],[587,0.5],
                [523,1],[0,1],
                [587,0.5],[659,0.5],[587,0.5],[494,0.5],
                [440,1],[0,0.5],[392,0.5],
                [330,0.5],[392,0.5],[440,0.5],[494,0.5],
                [440,2],
            ]},
            { fn:'bass', vol:0.20, notes:[
                [110,1],[0,1],[110,1],[0,1],[131,1],[0,1],[131,1],[0,1],
                [147,1],[0,1],[147,1],[0,1],[165,1],[0,1],[110,2],
            ]},
            { fn:'stab', vol:0.10, notes:[
                [220,0.5],[0,1.5],[220,0.5],[0,1.5],
                [262,0.5],[0,1.5],[262,0.5],[0,1.5],
                [294,0.5],[0,1.5],[294,0.5],[0,1.5],
                [330,0.5],[0,1.5],[330,0.5],[0,1.5],
            ]},
        ]},
        // CLASSIC style (2-channel, original tracks)
        classicMenu: { bpm: 60, channels: [
            { fn:'square', vol:0.30, notes:[
                [659,0.25],[784,0.25],[659,0.25],[523,0.25],
                [440,0.25],[523,0.25],[659,0.25],[587,0.25],
                [349,0.25],[440,0.25],[523,0.25],[440,0.25],
                [392,0.25],[494,0.25],[587,0.25],[494,0.25],
                [523,0.25],[659,0.25],[784,0.25],[659,0.25],
                [440,0.25],[659,0.25],[523,0.25],[440,0.25],
                [349,0.25],[392,0.25],[440,0.25],[494,0.25],
                [523,0.75],[0,0.25],
            ]},
            { fn:'tri', vol:0.20, notes:[
                [131,0.5],[0,0.5],[220,0.5],[0,0.5],[175,0.5],[0,0.5],
                [196,0.5],[0,0.5],[131,0.5],[0,0.5],[220,0.5],[0,0.5],
                [175,0.5],[0,0.5],[131,1.0],
            ]},
        ]},
        classicGame: { bpm: 80, channels: [
            { fn:'square', vol:0.30, notes:[
                [440,0.25],[0,0.125],[494,0.125],[523,0.25],[494,0.25],
                [440,0.5],[0,0.25],[440,0.25],
                [523,0.25],[0,0.125],[587,0.125],[659,0.25],[587,0.25],
                [523,0.5],[0,0.5],
                [587,0.25],[659,0.25],[587,0.25],[494,0.25],
                [440,0.5],[0,0.25],[392,0.25],
                [330,0.25],[392,0.25],[440,0.25],[494,0.25],
                [440,1.0],
            ]},
            { fn:'tri', vol:0.22, notes:[
                [110,0.5],[0,0.5],[110,0.5],[0,0.5],
                [131,0.5],[0,0.5],[131,0.5],[0,0.5],
                [147,0.5],[0,0.5],[147,0.5],[0,0.5],
                [165,0.5],[0,0.5],[110,1.0],
            ]},
        ]},
    };

    function init() {
        if (ac) return;
        try {
            ac = new (window.AudioContext || window.webkitAudioContext)();
            mGain = ac.createGain(); mGain.gain.value = 0; mGain.connect(ac.destination);
            sGain = ac.createGain(); sGain.gain.value = 0.58 * _sfxVol; sGain.connect(ac.destination);
            _justInited = true;
            // iOS Safari requires audio data to flow through the context during the
            // user gesture. A 1-sample silent buffer satisfies that requirement and
            // causes the context to unlock even before ac.resume() resolves.
            const buf = ac.createBuffer(1, 1, 22050);
            const src = ac.createBufferSource();
            src.buffer = buf; src.connect(ac.destination); src.start(0);
        } catch(e) { ac = null; }
    }

    function tone(freq, when, dur, type, vol, detune, dest) {
        if (!ac || freq <= 0 || when < ac.currentTime - 0.12) return;
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = type || 'square'; o.frequency.value = freq;
        if (detune) o.detune.value = detune;
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(vol, when + Math.max(0.010, Math.min(0.020, dur * 0.15)));
        g.gain.exponentialRampToValueAtTime(0.001, when + Math.max(dur * 0.88, 0.02));
        o.connect(g); g.connect(dest || mGain);
        o.start(when); o.stop(when + dur + 0.02);
        o.onended = () => { o.disconnect(); g.disconnect(); };
    }

    function fatTone(freq, when, dur, vol) {
        if (!ac || freq <= 0 || when < ac.currentTime - 0.12) return;
        tone(freq, when, dur, 'square', vol * 0.50,  0,  mGain);
        tone(freq, when, dur, 'square', vol * 0.28,  8,  mGain);
        tone(freq, when, dur, 'square', vol * 0.22, -8,  mGain);
    }

    function schedNote(ch, freq, when, dur) {
        if (freq <= 0) return;
        if      (ch.fn === 'fat')    fatTone(freq, when, dur, ch.vol);
        else if (ch.fn === 'tri')    tone(freq, when, dur, 'triangle', ch.vol, 0);
        else if (ch.fn === 'square') tone(freq, when, dur, 'square',   ch.vol, 0);
        else if (ch.fn === 'bass' || ch.fn === 'pad') tone(freq, when, dur, 'sine', ch.vol, 0);
        else if (ch.fn === 'stab')   tone(freq, when, dur, 'sawtooth', ch.vol, 0);
    }

    function tick(musicOn) {
        if (!ac || !curTrack || !musicOn || isPaused) return;
        if (ac.state !== 'running') return;
        const seq = SEQ[curTrack], spb = 60 / seq.bpm;
        seq.channels.forEach((ch, ci) => {
            const st = chState[ci];
            if (st.nextNote < ac.currentTime) st.nextNote = ac.currentTime;
            while (st.nextNote < ac.currentTime + 0.40) {
                const [f, b] = ch.notes[st.pos];
                schedNote(ch, f, st.nextNote, b * spb * 0.84);
                st.nextNote += b * spb;
                st.pos = (st.pos + 1) % ch.notes.length;
            }
        });
    }

    function play(t) {
        if (!ac || curTrack === t) return;
        curTrack = t; isPaused = false;
        chState = SEQ[t].channels.map(() => ({ pos: 0, nextNote: ac.currentTime }));
        _justInited = false;
        mGain.gain.cancelScheduledValues(ac.currentTime);
        if (ac.state !== 'running') {
            // AC still suspended; queue a gentle ramp so there is something
            // scheduled when it resumes — resume().then() will cancel and
            // replace this with a fast setTargetAtTime if curTrack is set.
            mGain.gain.setValueAtTime(0, ac.currentTime);
            mGain.gain.linearRampToValueAtTime(0.32 * _vol, ac.currentTime + 1.0);
        } else {
            mGain.gain.setTargetAtTime(0.32 * _vol, ac.currentTime, 0.08);
        }
    }

    function stop() {
        curTrack = null; isPaused = false;
        if (ac && mGain) { mGain.gain.cancelScheduledValues(ac.currentTime); mGain.gain.setTargetAtTime(0, ac.currentTime, 0.04); }
    }

    function pauseMusic() {
        if (!ac || !curTrack) return;
        isPaused = true;
        mGain.gain.cancelScheduledValues(ac.currentTime);
        mGain.gain.setTargetAtTime(0, ac.currentTime, 0.04);
    }

    function resumeMusic() {
        if (!ac || !curTrack) return;
        isPaused = false;
        const now = ac.currentTime;
        chState.forEach(s => { s.nextNote = now + 0.05; });
        mGain.gain.cancelScheduledValues(now);
        mGain.gain.setTargetAtTime(0.32 * _vol, now, 0.10);
    }

    // TODO: iOS Safari cold-start audio init is not fully reliable. On a fresh
    // browser session the first ac.resume() call silently hangs even inside a
    // trusted touchstart gesture; audio only starts on the second user interaction.
    // The controllerchange wasControlled guard (SW registration block) reduces the
    // problem but does not eliminate it for sessions where a SW update fires a
    // programmatic reload. No reliable workaround found yet without a dedicated
    // "tap to enable audio" UI step.
    function resume() {
        if (!ac) { init(); }
        if (ac && ac.state === 'suspended') {
            // Multiple concurrent calls are safe (spec-idempotent). No guard needed —
            // iOS cold-start silently hangs the first call; every subsequent gesture
            // retries freely until one succeeds.
            ac.resume().then(() => {
                const wasBg = _bgSuspended;
                _bgSuspended = false;
                if (curTrack && SEQ[curTrack]) {
                    if (wasBg) {
                        const flush = 0.45;
                        chState = SEQ[curTrack].channels.map(() => ({ pos: 0, nextNote: ac.currentTime + flush }));
                        if (!isPaused) {
                            mGain.gain.cancelScheduledValues(ac.currentTime);
                            mGain.gain.setValueAtTime(0, ac.currentTime);
                            mGain.gain.setTargetAtTime(0.32 * _vol, ac.currentTime + flush, 0.05);
                        }
                    } else {
                        chState = SEQ[curTrack].channels.map(() => ({ pos: 0, nextNote: ac.currentTime + 0.05 }));
                        if (!isPaused) {
                            mGain.gain.cancelScheduledValues(ac.currentTime);
                            mGain.gain.setTargetAtTime(0.32 * _vol, ac.currentTime, 0.08);
                        }
                    }
                } else if (!wasBg && !isPaused && curTrack) {
                    mGain.gain.cancelScheduledValues(ac.currentTime);
                    mGain.gain.setTargetAtTime(0.32 * _vol, ac.currentTime, 0.08);
                }
            }).catch(() => {});
        } else if (_bgSuspended) {
            _bgSuspended = false;
            if (!isPaused && curTrack) {
                mGain.gain.cancelScheduledValues(ac.currentTime);
                mGain.gain.setTargetAtTime(0.32 * _vol, ac.currentTime, 0.08);
            }
        }
    }

    function sfx(type, on) {
        if (!ac || !on) return;
        const now = ac.currentTime;
        const t = (f, w, d, tp) => tone(f, w, d, tp || 'square', 0.42, 0, sGain);
        if (type === 'eat') {
            t(880, now, 0.05); t(1108, now + 0.055, 0.06);
        } else if (type === 'die') {
            for (let i = 0; i < 7; i++) t(300 - i * 26, now + i * 0.07, 0.1, 'sawtooth');
        } else if (type === 'levelUp') {
            [523,659,784,988,1319].forEach((f,i) => t(f, now + i*0.09, 0.13));
        } else if (type === 'nav') {
            t(392, now, 0.03);
        } else if (type === 'select') {
            t(523, now, 0.04); t(659, now + 0.045, 0.08);
        } else if (type === 'bonus') {
            [880,1047,1319,1568].forEach((f,i)=>t(f,now+i*0.055,0.10));
        } else if (type === 'perfect') {
            [523,659,784,1047,1319,1568].forEach((f,i)=>t(f,now+i*0.07,0.22));
            [784,988,1319].forEach(f=>t(f,now+0.50,0.30,'triangle'));
        } else if (type === 'lucky_spawn') {
            [880,1319,1568].forEach((f,i)=>t(f,now+i*0.055,0.13));
        } else if (type === 'lucky_eat') {
            [880,1047,1319,1568,2093].forEach((f,i)=>t(f,now+i*0.045,0.16));
        } else if (type === 'epic_spawn') {
            [440,554,659,880,1047,1319,1568].forEach((f,i)=>t(f,now+i*0.06,0.18));
            t(1568,now+0.46,0.28,'triangle');
        } else if (type === 'epic_eat') {
            [523,659,784,1047,1319,1568,2093].forEach((f,i)=>t(f,now+i*0.055,0.24));
            [784,988,1319,1568].forEach(f=>t(f,now+0.45,0.36,'triangle'));
        }
    }

    function setVol(v) {
        _vol = v;
        if (mGain && curTrack && !isPaused) {
            mGain.gain.cancelScheduledValues(ac.currentTime);
            mGain.gain.setTargetAtTime(0.32 * v, ac.currentTime, 0.04);
        }
    }
    function setSfxVol(v){ _sfxVol=v; if(sGain) sGain.gain.value=0.58*v; }
    function suspend() {
        if (!ac || ac.state !== 'running') return;
        // Fade to silence first so the hard suspension doesn't clip oscillators mid-cycle.
        mGain.gain.cancelScheduledValues(ac.currentTime);
        mGain.gain.setTargetAtTime(0, ac.currentTime, 0.02);
        _bgSuspended = true;
        setTimeout(() => { try { if (ac && ac.state === 'running') ac.suspend(); } catch(e){} }, 120);
    }
    // Like resume() but never creates the AC — safe to call from untrusted events
    // (pointerdown on iOS). Only resumes if the AC already exists and is suspended.
    function tryResume() {
        if (!ac || ac.state !== 'suspended') return;
        ac.resume().then(() => {
            const wasBg = _bgSuspended;
            _bgSuspended = false;
            if (curTrack && SEQ[curTrack]) {
                const flush = wasBg ? 0.45 : 0.05;
                chState = SEQ[curTrack].channels.map(() => ({ pos: 0, nextNote: ac.currentTime + flush }));
                if (!isPaused) {
                    mGain.gain.cancelScheduledValues(ac.currentTime);
                    if (wasBg) {
                        mGain.gain.setValueAtTime(0, ac.currentTime);
                        mGain.gain.setTargetAtTime(0.32 * _vol, ac.currentTime + 0.45, 0.05);
                    } else {
                        mGain.gain.setTargetAtTime(0.32 * _vol, ac.currentTime, 0.08);
                    }
                }
            }
        }).catch(() => {});
    }
    return { init, tick, play, stop, pauseMusic, resumeMusic, resume, tryResume, sfx, setVol, setSfxVol, suspend };
})();

// Audio is initialized from the splash screen interaction, which guarantees a clean
// user gesture context across all browsers (Firefox, iOS Safari, Chrome, etc.).

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
        return JSON.parse(raw) || [];
    } catch { return []; }
}
function getFOKoins() { return parseInt(localStorage.getItem(FK_KEY) || '0', 10) || 0; }
let _cachedFOKoins = getFOKoins();
function addFOKoins(n) {
    _cachedFOKoins += n;
    try { localStorage.setItem(FK_KEY, String(_cachedFOKoins)); } catch {}
    if(_cachedFOKoins >= 5000)    unlockAch('fokoins_1k');
    if(_cachedFOKoins >= 50000)   unlockAch('fokoins_10k');
    if(_cachedFOKoins >= 500000)  unlockAch('fokoins_100k');
    if(_cachedFOKoins >= 1000000) unlockAch('fokoins_1m');
    if(_cachedFOKoins >= 5000000) unlockAch('fokoins_5m');
}
function addScore(name, sc, lvl) {
    const s = getScores();
    const now = new Date();
    const date = `${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getFullYear()).slice(-2)}`;
    s.push({ name:(name.trim()||'SNAKE PLISSKEN').substring(0,MAX_NAME), score:sc, level:lvl,
             diff:cfg.diff, color:cfg.snakeColor||0, shopItems:{...(cfg.wornItems||{})}, date });
    s.sort((a, b) => b.score - a.score);
    try { localStorage.setItem(HS_KEY, JSON.stringify(s.slice(0, 10))); } catch {}
    addFOKoins(sc);
}
function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {} }
function loadCfg() { try { const s=JSON.parse(localStorage.getItem(CFG_KEY)||'{}'); if(!s.cfgVer||s.cfgVer<2){delete s.touchSelect;} Object.assign(cfg,s); } catch {} }

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
const EASY_ACHS = new Set(['first_gem','level1','level5','fokoins_1k','fokoins_10k','fokoins_100k']);
function unlockAch(id) {
    if(achUnlocked[id]) return;
    if(cfg.diff === 0 && !EASY_ACHS.has(id)) return;
    achUnlocked[id] = Date.now(); saveAch();
    addFOKoins(1000);
    achPopups.push({ id, at: performance.now() });
    spawnConfetti();
}
loadAch();

// ================================================================
// CREDITS DATA
// ================================================================
const CRED = [
    ['gap',50],['title','S N A K E'],['sub','FOK EDITION'],['gap',60],
    ['hdr','--- CREDITS ---'],['gap',40],
    ['hdr','CONCEPTUAL SUPERVISION'],['txt','Jonas and Kai P.'],['gap',28],
    ['hdr','CREATIVE DIRECTION'],['txt','Jonas P.'],['gap',28],
    ['hdr','EXECUTIVE PRODUCTION'],['txt','Kai P.'],['gap',28],
    ['hdr','LEAD DEVELOPER'],['txt','Claude P.'],['sml','(types at 10,000 tokens/min)'],['gap',28],
    ['hdr','MUSICAL COMPOSITION'],['txt','Claude M.'],['sml','(self-taught. mostly.)'],['gap',28],
    ['hdr','VISUAL ARTS'],['txt','Claude V.'],['sml','(knows exactly 7 colors)'],['gap',28],
    ['hdr','QUALITY ASSURANCE'],['txt','The Snake'],['sml','(mortality rate: 100%)'],['gap',28],
    ['hdr','LEVEL DESIGN'],['txt','A Random Number Generator'],['sml','(certified barricade placement specialist)'],['gap',28],
    ['hdr','GEM MANAGEMENT'],['txt','The Gems'],['sml','(eaten without consent since 2025)'],['gap',28],
    ['hdr','STRUCTURAL ENGINEERING'],['txt','The Barricades'],['sml','(load-bearing. do not touch.)'],['gap',28],
    ['hdr','SNAKE PSYCHOLOGY'],['txt','Dr. S. Nake, PhD'],['sml','(expert in self-collision trauma)'],['gap',28],
    ['hdr','CATERING'],['txt','The Break Room Snake'],['sml','(she also ate the coffee machine)'],['gap',40],
    ['hdr','SPECIAL THANKS'],
    ['txt','Everyone who played.'],['txt','Everyone who crashed into themselves.'],
    ['txt','The one person who reached Level 10.'],['txt','You know who you are.'],['gap',40],
    ['hdr','IN MEMORIAM'],
    ['txt','All snakes lost in beta testing.'],['txt','They knew the risks.'],['gap',50],
    ['coins'],['sml','(spend them in the SHOP)'],['gap',50],
    ['sml','(C) 2025 FOK STUDIOS'],['sml','All rights reserved to nobody in particular.'],
    ['gap',30],['txt','PRESS OK OR ENTER TO EXIT'],['gap',280],
    ['secret','No Eastereggs here ;)'],['gap',240],
];
const CRED_H = { title:30, sub:16, hdr:20, txt:16, sml:14, coins:20, secret:20 };
function credTotalH() { let h=0; for(const[t,v] of CRED) h += t==='gap' ? v : (CRED_H[t]||22); return h; }
const CRED_TOTAL_H = credTotalH();

// ================================================================
// APP STATE
// ================================================================
// phases: splash|menu|settings|scores|credits|playing|levelReady|paused|dying|levelDone|nameEntry|quitConfirm|resetConfirm
let phase = 'splash';
let menuSel = 0, settingsSel = 0, shopSel = 0, quitConfirmSel = 1, prevPhase = 'playing';
const MENU_ITEMS     = ['PLAY', 'SETTINGS', 'HIGH SCORES', 'ACHIEVEMENTS', 'SHOP', 'CREDITS'];
const SETTINGS_COUNT = 11;
let cfg = { music: true, diff: 1, musicStyle: 0, snakeColor: 0, shopItems: {}, wornItems: null, handed: 0, volume: 1, sfxVol: 0.5, turbo: true, touchSelect: false, cfgVer: 2 };
loadCfg();
if(cfg.wornItems === null){ cfg.wornItems = {...(cfg.shopItems||{})}; saveCfg(); }
Snd.setVol(cfg.volume ?? 1);
Snd.setSfxVol(cfg.sfxVol ?? 0.5);
function applyHandedness() { document.body.classList.toggle('lefty', cfg.handed === 1); }
applyHandedness();

let level, lives, score, _levelStartLen = 0;
let snake, dir, dirQueue;
let gem, gemsDone, bars;
let speed, stepAt, phaseAt = performance.now(), gemAt, deathMsg, pauseAt;
let spawnAt = 0, levelDoneWaiting = false;
let pauseReadyAt = 0, escReadyAt = 0;
let perfectLevel = true, levelWasPerfect = false, fireworks = [];
let levelBonusCount = 0, epicLevelCount = 0;
let boostDir=null, boostSince=0, boosting=false;
const BOOST_GRACE=180;
function clearBoost(){boostDir=null;boosting=false;}
let perfectCount = 0, luckyCount = 0;
let achPage = 0;
let nameStr = '', nameCharIdx = 0, nameReason = '';
let creditsScroll = 0, creditsSpeed = 0.8;
let purchaseParticles = [], purchaseAnimAt = 0;
let fpsFrames = 0, fpsLast = 0;

function menuTrack() { return cfg.musicStyle === 0 ? 'ambient'     : 'classicMenu'; }
function gameTrack() { return cfg.musicStyle === 0 ? 'game'        : 'classicGame'; }

// ================================================================
// GAME LOGIC
// ================================================================
const ck = p => `${p.x},${p.y}`;
const ri = n => Math.floor(Math.random() * n);
function freeCell(blocked) {
    let p, tries=0;
    do { p={x:ri(COLS),y:ri(ROWS)}; } while(blocked.has(ck(p)) && ++tries<1000);
    if(tries>=1000) { for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++) { p={x,y}; if(!blocked.has(ck(p))) return p; } }
    return p;
}

function startGame() { level=1; lives=START_LIVES; score=0; perfectCount=0; luckyCount=0; _levelStartLen=0; beginLevel(); }

function beginLevel() {
    const lcfg=LEVEL_CFG[level-1], d=DIFF[cfg.diff];
    speed = lcfg[['easy','normal','hard'][cfg.diff]];
    const cx=Math.floor(COLS/2), cy=Math.floor(ROWS/2);
    const sl = _levelStartLen > 0 ? _levelStartLen : startLen(level);
    _levelStartLen = sl;
    snake = Array.from({length:sl},(_,i)=>({x:cx-i,y:cy}));
    dir={x:1,y:0}; dirQueue=[]; gem=null; gemsDone=0; bars=[];
    phase='levelReady'; stepAt=0; phaseAt=performance.now();
    spawnAt=0; levelDoneWaiting=false;
    perfectLevel=true; levelWasPerfect=false; fireworks=[]; levelBonusCount=0; epicLevelCount=0;
    clearBoost();
    const blocked = new Set([...snake,{x:cx+1,y:cy},{x:cx+2,y:cy}].map(ck));
    const numBars = Math.min(28, Math.round(lcfg.bars * d.bm));
    for(let i=0;i<numBars;i++){ const b=freeCell(blocked); blocked.add(ck(b)); bars.push(b); }
    // ~10% of bars extend into a 2-cell unit; no wrapping so rendering stays simple
    const _bl=bars.length;
    for(let i=0;i<_bl;i++){
        const b=bars[i];
        if(Math.random()>=0.1) continue;
        const dirs=[{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}];
        for(let i=dirs.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[dirs[i],dirs[j]]=[dirs[j],dirs[i]];}
        for(const d of dirs){
            const nx=b.x+d.x, ny=b.y+d.y;
            if(nx<0||nx>=COLS||ny<0||ny>=ROWS) continue;
            const nk=ck({x:nx,y:ny});
            if(!blocked.has(nk)){
                blocked.add(nk); bars.push({x:nx,y:ny,paired:true});
                b.pairEnd={x:nx,y:ny}; break;
            }
        }
    }
    spawnGem(); renderBarsOffscreen(); Snd.resumeMusic(); showHUD(true);
}

let gemOptimal=0, gemSteps=0;
function spawnGem() {
    gem=freeCell(new Set([...snake,...bars].map(ck))); gemAt=gem.spawnAt=performance.now();
    const rv=Math.random();
    gem.tier = rv<0.0005 ? 2 : rv<0.0105 ? 1 : 0;
    if(gem.tier===2) Snd.sfx('epic_spawn',cfg.music);
    else if(gem.tier===1) Snd.sfx('lucky_spawn',cfg.music);
    const dx=Math.min(Math.abs(gem.x-snake[0].x),COLS-Math.abs(gem.x-snake[0].x));
    const dy=Math.min(Math.abs(gem.y-snake[0].y),ROWS-Math.abs(gem.y-snake[0].y));
    gemOptimal=dx+dy; gemSteps=0;
}

function step(now) {
    while(dirQueue.length>0){ const nd=dirQueue.shift(); if(nd.x!==-dir.x||nd.y!==-dir.y){dir=nd;break;} }
    const head={x:(snake[0].x+dir.x+COLS)%COLS,y:(snake[0].y+dir.y+ROWS)%ROWS};
    const hk=ck(head);
    const protect = now - spawnAt < 1000;
    if(!protect && bars.some(b=>ck(b)===hk)){die(now);return;}
    const ate=gem&&ck(gem)===hk;
    if(!protect && (ate?snake:snake.slice(0,-1)).some(s=>ck(s)===hk)){die(now);return;}
    if(!ate) gemSteps++;
    snake.unshift(head);
    if(ate){
        gemsDone++;
        const base=level*100;
        const bonus=gemOptimal>0&&gemSteps<=gemOptimal;
        if(!bonus) perfectLevel=false;
        const tier=gem.tier||0, mult=tier===2?100:tier===1?10:1;
        const diffMult=(cfg.diff===2&&level>=2)?2:1;
        score+=bonus?base*2*mult*diffMult:base*mult*diffMult;
        if(tier===2){
            showBonus(now,bonus?'EPIC x200!':'EPIC x100!');
            Snd.sfx('epic_eat',cfg.music);
            unlockAch('epic_gem');
            epicLevelCount++; if(epicLevelCount>=2) unlockAch('epic_double');
        } else if(tier===1){
            showBonus(now,bonus?'LUCKY x20!':'LUCKY x10!');
            Snd.sfx('lucky_eat',cfg.music);
            unlockAch('lucky_gem');
            luckyCount++; if(luckyCount>=3) unlockAch('lucky_streak');
        } else if(bonus){
            showBonus(now,'x2 BONUS!');
            Snd.sfx('bonus',cfg.music);
        } else Snd.sfx('eat',cfg.music);
        unlockAch('first_gem');
        if(bonus){ levelBonusCount++; if(levelBonusCount>=5) unlockAch('bonus_3'); }
        if(score>=64000)  unlockAch('score_25k');
        if(score>=100000) unlockAch('score_100k');
        if(gemsDone>=GEMS_PER_LEVEL){
            gem=null; score+=level*500;
            if(perfectLevel){
                score+=level*1000; spawnFireworks(now); Snd.sfx('perfect',cfg.music);
                unlockAch('perfect_level');
                perfectCount++; if(perfectCount>=3) unlockAch('triple_perf');
            } else Snd.sfx('levelUp',cfg.music);
            unlockAch('level1');
            if(level>=5)  unlockAch('level5');
            if(level>=10){
                unlockAch('level10');
                if(cfg.diff===2)               unlockAch('hard_champ');
                if(lives>=START_LIVES)         unlockAch('no_deaths');
            }
            phase='levelDone'; phaseAt=now;
        } else spawnGem();
    } else snake.pop();
    if (ate && cfg.diff > 0) snake.push({...snake[snake.length - 1]});
    updateHUD();
}

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

function die(now) {
    lives--; phase='dying'; phaseAt=now;
    deathMsg=lives>0?`LIFE LOST  (${lives} left)`:'GAME OVER!';
    Snd.sfx('die',cfg.music); Snd.pauseMusic();
}

function togglePause() {
    if(phase==='playing'){
        if(performance.now() < pauseReadyAt) return;
        phase='paused'; pauseAt=performance.now(); Snd.pauseMusic();
    } else if(phase==='paused'){
        gemAt+=performance.now()-pauseAt; phase='playing'; stepAt=performance.now()+speed;
        pauseReadyAt=performance.now()+1000;
        Snd.resumeMusic();
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
        _hudLivesCtx.clearRect(0,0,48,12);
        for(let i=0;i<START_LIVES;i++){
            _hudLivesCtx.fillStyle=i<lives?'#7fff7f':'#1e3a1e';
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
function drawOvBg(a) { ctx.fillStyle=`rgba(7,7,14,${a||0.88})`; ctx.fillRect(0,0,CW,CH); }
function ct(text,x,y,color,size) {
    ctx.fillStyle=color||'#7fff7f';
    ctx.font=`${size||10}px "Press Start 2P"`;
    ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(text,x,y);
}
function menuItem(text,y,sel) {
    ctx.globalAlpha=sel?1:0.78;
    if(sel){ctx.shadowColor='#7fff7f';ctx.shadowBlur=14;}
    ct(sel?('> '+text+' <'):text,CW/2,y,sel?'#7fff7f':'#cccccc',13);
    ctx.shadowBlur=0; ctx.globalAlpha=1;
}

// High-contrast barricades (>4.5:1 on dark bg) - bright amber brick
function drawBar(b, c=ctx) {
    if(b.paired && !b.pairEnd) return; // second cell of a pair — drawn by its partner
    const isPair=!!b.pairEnd;
    const x=isPair?Math.min(b.x,b.pairEnd.x)*CS+1:b.x*CS+1;
    const y=isPair?Math.min(b.y,b.pairEnd.y)*CS+1:b.y*CS+1;
    const bw=(isPair?Math.abs(b.pairEnd.x-b.x)+1:1)*CS-2;
    const bh=(isPair?Math.abs(b.pairEnd.y-b.y)+1:1)*CS-2;
    c.fillStyle='#cc4400'; c.fillRect(x,y,bw,bh);
    // mortar lines: cross for 2-cell (marks the join), T-shape for single
    c.fillStyle='#5a1a00';
    c.fillRect(x,y+Math.floor(bh/2),bw,1);
    c.fillRect(x+Math.floor(bw/2),y,1,isPair?bh:Math.floor(bh/2));
    // 3D bevel
    c.fillStyle='#ff7700'; c.fillRect(x,y,bw,2); c.fillRect(x,y,2,bh);
    c.fillStyle='#661800'; c.fillRect(x+bw-2,y,2,bh); c.fillRect(x,y+bh-2,bw,2);
}
function renderBarsOffscreen() {
    _barsCtx.clearRect(0,0,CW,CH); bars.forEach(b=>drawBar(b,_barsCtx));
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
        const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.8);
        grd.addColorStop(0,`hsla(${hue},100%,65%,0.35)`); grd.addColorStop(1,`hsla(${hue},100%,65%,0)`);
        ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.8,0,Math.PI*2); ctx.fill();
        // Diamond
        ctx.shadowColor=`hsl(${hue},100%,70%)`; ctx.shadowBlur=20;
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
        const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.5);
        grd.addColorStop(0,'rgba(255,215,0,0.32)'); grd.addColorStop(1,'rgba(255,215,0,0)');
        ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.5,0,Math.PI*2); ctx.fill();
        ctx.shadowColor='#ffd700'; ctx.shadowBlur=18;
        ctx.fillStyle='#ffd700';
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,r); ctx.lineTo(-r*0.65,0); ctx.closePath(); ctx.fill();
        ctx.fillStyle='rgba(255,255,255,0.52)';
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,0); ctx.closePath(); ctx.fill();
        ctx.restore();
    } else {
        // Normal gem: cyan diamond
        const r=(CS/2-2)*(1+0.12*Math.sin(t*5));
        ctx.save(); ctx.translate(cx,cy); ctx.rotate(t*2);
        const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.2);
        grd.addColorStop(0,'rgba(0,255,255,0.25)'); grd.addColorStop(1,'rgba(0,255,255,0)');
        ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.2,0,Math.PI*2); ctx.fill();
        ctx.shadowColor='#00ffff'; ctx.shadowBlur=14;
        const fg=ctx.createLinearGradient(0,-r,0,r);
        fg.addColorStop(0,'#ffffff'); fg.addColorStop(0.35,'#00ffff'); fg.addColorStop(1,'#006688');
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,r); ctx.lineTo(-r*0.65,0); ctx.closePath();
        ctx.fillStyle=fg; ctx.fill(); ctx.restore();
    }
}

function triggerPurchaseAnim() {
    purchaseAnimAt = performance.now();
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

function drawAccessoryBow(hx, hy) {
    ctx.fillStyle='#cc2222';
    ctx.fillRect(hx+4,hy+7,4,5);   // left wing
    ctx.fillRect(hx+11,hy+7,4,5);  // right wing
    ctx.fillStyle='#ff4444';
    ctx.fillRect(hx+4,hy+7,4,2);
    ctx.fillRect(hx+11,hy+7,4,2);
    ctx.fillStyle='#aa0000';
    ctx.fillRect(hx+8,hy+8,3,3);   // knot center
}

function drawSnake(flash) {
    const sc=SNAKE_COLORS[cfg.snakeColor||0];
    snake.forEach((seg,i)=>{
        const x=seg.x*CS+1,y=seg.y*CS+1,sw=CS-2,sh=CS-2,frac=1-i/Math.max(snake.length,1);
        if(i===0){
            ctx.fillStyle=flash?'#bb2222':sc.head;
            if(!flash){ctx.shadowColor=sc.head;ctx.shadowBlur=10;}
        } else {
            const l=Math.round(8+frac*33);
            ctx.fillStyle=flash?`hsl(0,55%,${l+8}%)`:`hsl(${sc.h},65%,${l}%)`;
        }
        rr(x,y,sw,sh,i===0?5:3); ctx.fill(); ctx.shadowBlur=0;
        if(i===0&&!flash){
            const eyeDir=dirQueue.length>0?dirQueue[0]:dir;
            ctx.fillStyle='#001500'; eyeOffsets(eyeDir).forEach(([ox,oy])=>ctx.fillRect(x+ox,y+oy,3,3));
            if(dirQueue.length>0&&(dirQueue[0].x!==dir.x||dirQueue[0].y!==dir.y)){
                const qd=dirQueue[0];
                const mx=Math.round(x+sw/2+qd.x*(sw/2-3)), my=Math.round(y+sh/2+qd.y*(sh/2-3));
                ctx.save(); ctx.globalAlpha=0.75; ctx.fillStyle='#aaffaa';
                ctx.shadowColor='#7fff7f'; ctx.shadowBlur=5;
                ctx.fillRect(mx-1,my-1,3,3); ctx.restore();
            }
            const si=cfg.wornItems||{};
            if(si.shades)    drawAccessoryShades(x,y);
            if(si.monocle)   drawAccessoryMonocle(x,y);
            if(si.bow)       drawAccessoryBow(x,y);
            if(si.cylinder)  drawAccessoryCylinder(x,y);
            if(si.crown)     drawAccessoryCrown(x,y);
        }
    });
}

// ================================================================
// SCREENS
// ================================================================
function drawSplash(now) {
    const elapsed = _splashFast
        ? _splashFastBase + (now - _splashFastStart) / 1000 * 2
        : (now - phaseAt) / 1000;

    // Background matches menu: grid + scan line overlay
    drawGrid();
    ctx.drawImage(_scanCanvas, 0, 0);

    // Title block: identical to drawMenu
    ctx.shadowColor = '#7fff7f'; ctx.shadowBlur = 28;
    ct('S N A K E', CW/2, 78, '#7fff7f', 40);
    ctx.shadowBlur = 0;
    ct('F O K   E D I T I O N', CW/2, 122, '#4a7a4a', 8);

    // Coin drop animation
    // Cycle: DROP=1.4s fall, ENTER=0.28s slot entry, rest = pause
    const CYCLE = 3.2, DROP = 1.4, ENTER = 0.28;
    const t = (elapsed + DROP + ENTER) % CYCLE;
    const coinX = CW/2, slotY = 292, startY = 152;

    // Spin: tied to drop progress so entry is always face-on.
    // 1.5 revolutions -> spinAngle ends at 3pi -> |cos(3pi)|=1 -> full face at slot.
    const dropProgress = Math.min(t, DROP) / DROP;
    const spinAngle = dropProgress * 1.5 * Math.PI * 2;
    const scaleX = Math.max(0.08, Math.abs(Math.cos(spinAngle)));

    // Fall: cubic ease-in (slow start, fast end = realistic gravity)
    let coinY = startY, showCoin = true;
    if (t < DROP) {
        const p = t / DROP;
        coinY = startY + (slotY - startY - 18) * p * p * p;
    } else if (t < DROP + ENTER) {
        const p = (t - DROP) / ENTER;
        coinY = (slotY - 18) + 18 * p;
    } else {
        showCoin = false;
    }

    // Slot housing (44px opening, wider than coin face = 36px)
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(coinX - 46, slotY - 9, 92, 18);
    ctx.fillStyle = '#2a2a2a'; ctx.fillRect(coinX - 42, slotY - 6, 84, 12);
    ctx.fillStyle = '#111';    ctx.fillRect(coinX - 22, slotY - 5, 44, 10);

    if (showCoin) {
        ctx.save();
        if (t >= DROP) { ctx.beginPath(); ctx.rect(0, 0, CW, slotY); ctx.clip(); }
        // Shadow in screen coords before applying coin transform
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath(); ctx.ellipse(coinX+3, coinY+5, 18*scaleX, 5, 0, 0, Math.PI*2); ctx.fill();
        // Pixel coin: translate to center, squish x-axis for spin, draw 12x12 grid at 3px/pixel
        ctx.translate(coinX, coinY);
        ctx.scale(scaleX, 1);
        const coinFace = Math.cos(spinAngle) >= 0 ? COIN_ONE : COIN_STAR;
        const hlCol = 5.5 + (Math.cos(spinAngle) < 0 ? -1 : 1) * 5 * Math.sin(spinAngle);
        const faceOn = Math.abs(Math.cos(spinAngle));
        coinFace.forEach((row, ry) => row.forEach((p, rx) => {
            if (!p) return;
            const edgeDark = 1 - 0.32 * Math.hypot((rx-5.5)/5.5, (ry-5.5)/5.5);
            const gd = rx - hlCol;
            const glare = faceOn * 0.7 * Math.exp(-gd*gd / 5);
            let r, g, b;
            if (p === 1) {
                r=(168+55*glare)*edgeDark; g=(118+38*glare)*edgeDark; b=(6+16*glare)*edgeDark;
            } else if (p === 2) {
                r=Math.min(255,(205+50*glare)*edgeDark); g=Math.min(255,(145+70*glare)*edgeDark); b=Math.min(255,(8+22*glare)*edgeDark);
            } else {
                r=Math.min(255,255*edgeDark+8*glare); g=Math.min(255,(220+35*glare)*edgeDark); b=Math.min(255,(52+48*glare)*edgeDark);
            }
            ctx.fillStyle=`rgb(${r|0},${g|0},${b|0})`;
            ctx.fillRect(-18 + rx*3, -18 + ry*3, 3, 3);
        }));
        ctx.restore();
    }

    // Golden flash on insert
    if (t >= DROP && t < DROP + 0.4) {
        const f = 1 - (t - DROP) / 0.4;
        ctx.fillStyle = `rgba(255,215,0,${f * 0.32})`;
        ctx.fillRect(coinX - 46, slotY - 28, 92, 56);
    }

    // INSERT COIN blinking
    if (Math.floor(elapsed * 1.5) % 2 === 0) {
        ctx.shadowColor = '#ffff00'; ctx.shadowBlur = 18;
        ct('INSERT COIN', CW/2, 344, '#ffff00', 14);
        ctx.shadowBlur = 0;
    }

    // Bottom hint: matches menu bottom bar style
    ctx.save();
    ctx.font = '8px "Press Start 2P"'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'center';
    ctx.fillStyle = '#555';
    ctx.fillText('enter  |  tap  |  click', CW/2, CH - 8);
    ctx.restore();
}

function drawMenu() {
    drawGrid();
    ctx.drawImage(_scanCanvas, 0, 0);
    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=28;
    ct('S N A K E',CW/2,78,'#7fff7f',40);
    ctx.shadowBlur=0;
    ct('F O K   E D I T I O N',CW/2,122,'#4a7a4a',8);
    const msp=MENU_ITEMS.length<=5?38:30;
    MENU_ITEMS.forEach((item,i)=>menuItem(item,162+i*msp,i===menuSel));
    ct(`DIFF: ${DIFF[cfg.diff].label}  |  AUDIO: ${cfg.music?'ON':'OFF'}  |  STYLE: ${cfg.musicStyle===0?'NEW':'CLASSIC'}`,CW/2,342,'#555',8);
    // Bottom bar: version left, hint center, FOKoins right — all same font as FOK EDITION
    const coins=_cachedFOKoins;
    ctx.save();
    ctx.font='8px "Press Start 2P"'; ctx.textBaseline='bottom'; ctx.shadowBlur=0;
    ctx.fillStyle='#4a7a4a'; ctx.textAlign='left';
    ctx.fillText(_swVersion, 10, CH-8);
    ctx.textAlign='center';
    ctx.fillText('UP/DOWN  |  ENTER to select', CW/2, CH-8);
    ctx.fillStyle='#ffd700'; ctx.textAlign='right';
    ctx.fillText(`FOKOINS: ${coins.toLocaleString()}`, CW-10, CH-8);
    ctx.restore();
}

function drawSettings() {
    drawGrid(); drawOvBg(0.92);
    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=20; ct('SETTINGS',CW/2,24,'#7fff7f',18); ctx.shadowBlur=0;
    const sc=SNAKE_COLORS[cfg.snakeColor||0];
    const vol=Math.round((cfg.volume??1)*10);
    const sfxv=Math.round((cfg.sfxVol??0.5)*10);
    const items = [
        'AUDIO: '+(cfg.music?'ON':'OFF'),
        'AUDIO STYLE: '+(cfg.musicStyle===0?'NEW':'CLASSIC'),
        'VOLUME: '+Math.round((cfg.volume??1)*100)+'%',
        'SFX VOL: '+Math.round((cfg.sfxVol??0.5)*100)+'%',
        'TURBO BOOST: '+(cfg.turbo!==false?'ON':'OFF'),
        'DIFFICULTY: '+DIFF[cfg.diff].label,
        'SNAKE COLOR: '+sc.name,
        'LAYOUT: '+(cfg.handed?'LEFT':'RIGHT'),
        'TOUCH AUTOSELECT: '+(cfg.touchSelect?'ON':'OFF'),
        'RESET STATS',
        'BACK',
    ];
    const startY=62, rowH=28;
    items.forEach((item,i)=>menuItem(item,startY+i*rowH,i===settingsSel));
    // Volume bars when selected
    if(settingsSel===2){
        const py=startY+2*rowH, bx=CW/2-55, bw=110;
        ctx.fillStyle='#1a2a1a'; ctx.fillRect(bx,py+10,bw,5);
        ctx.fillStyle='#7fff7f'; ctx.fillRect(bx,py+10,Math.round(bw*vol/10),5);
    }
    if(settingsSel===3){
        const py=startY+3*rowH, bx=CW/2-55, bw=110;
        ctx.fillStyle='#1a2a1a'; ctx.fillRect(bx,py+10,bw,5);
        ctx.fillStyle='#aaddff'; ctx.fillRect(bx,py+10,Math.round(bw*sfxv/10),5);
    }
    // Snake color mini-preview when selected
    if(settingsSel===6){
        const py=startY+6*rowH;
        ctx.save();
        ctx.font='13px "Press Start 2P"';
        const tw=ctx.measureText('> SNAKE COLOR: '+sc.name+' <').width;
        const px=Math.round(CW/2+tw/2+12);
        for(let k=0;k<5;k++){
            const frac=1-k/5, l=Math.round(10+frac*40);
            ctx.fillStyle=k===0?sc.head:`hsl(${sc.h},65%,${l}%)`;
            ctx.shadowColor=k===0?sc.head:'transparent'; ctx.shadowBlur=k===0?6:0;
            ctx.fillRect(px+k*7,py-5,6,10);
        }
        ctx.restore();
    }
    ct('LEFT/RIGHT to change   OK/ENTER toggle   ESC back',CW/2,CH-10,'#555',8);
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
    const scale = 0.55;
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
        if(si.shades)  { ctx.fillStyle='#111'; [3.5,17.5].forEach(ey=>{ctx.beginPath();ctx.arc(14.5,ey,4,0,Math.PI*2);ctx.fill();}); }
        if(si.monocle) { ctx.strokeStyle='#ccc'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.arc(14.5,3.5,3.5,0,Math.PI*2); ctx.stroke(); }
        if(si.cylinder) drawAccessoryCylinder(0, 0);
        if(si.crown)    drawAccessoryCrown(0, 0);
    }
    ctx.restore();
}

let _scoreboardCache = null;
function drawScores() {
    drawGrid(); drawOvBg(0.92);
    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=20; ct('HIGH SCORES',CW/2,28,'#7fff7f',18); ctx.shadowBlur=0;
    const scores=_scoreboardCache||[];
    if(!scores.length){ ct('No scores yet!',CW/2,CH/2,'#aaa',8); }
    else {
        ctx.font='8px "Press Start 2P"'; ctx.textAlign='left'; ctx.textBaseline='middle';
        scores.slice(0,8).forEach((s,i)=>{
            const y=94+i*30;
            ctx.fillStyle=i===0?'#ffd700':i<3?'#dddddd':'#aaaaaa';
            const rank=`${i+1}.`.padStart(3);
            const lvl=String(s.level).padStart(2);
            const diff=['E','N','H'][s.diff??1]??'N';
            const line=`${rank}  ${(s.name||'???').padEnd(MAX_NAME)}  ${String(s.score).padStart(7)}  LV${lvl}  ${diff}  ${s.date||'--.--.--'}`;
            const tw=ctx.measureText(line).width;
            const tx=CW/2-tw/2;
            ctx.fillText(line,tx,y);
            drawScoreHead(tx-18, y, s.color||0, s.shopItems||{});
        });
        ctx.textAlign='center';
    }
    const coins=_cachedFOKoins;
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=3;
    ct(`TOTAL FOKOINS: ${coins.toLocaleString()}`,CW/2,CH-36,'#ffd700',8);
    ctx.shadowBlur=0;
    ct('Any key or OK to return',CW/2,CH-14,'#999',8);
}

function drawAchievements() {
    drawGrid(); drawOvBg(0.92);
    const donated=!!(cfg.shopItems&&cfg.shopItems['donate']);
    const allBase=ACHIEVEMENTS.every(a=>achUnlocked[a.id]);
    const expert=donated&&allBase;
    const onExpert=expert&&achPage===0;
    const list=onExpert?EXPERT_ACHIEVEMENTS:ACHIEVEMENTS;
    const titleColor=onExpert?'#ff8800':'#7fff7f';
    ctx.shadowColor=titleColor; ctx.shadowBlur=20; ct('ACHIEVEMENTS',CW/2,28,titleColor,18); ctx.shadowBlur=0;
    if(expert){
        ct(onExpert?'< EXPERT  1/2 >':'< BASE  2/2 >',CW/2,42,onExpert?'#ffaa44':'#7fff7f',8);
    } else if(allBase&&!donated){
        ct('DONATE in SHOP to unlock EXPERT page',CW/2,42,'#ff4488',7);
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
        ctx.font='8px "Press Start 2P"';
        ctx.fillStyle=got?'#7fff7f':'#888888';
        ctx.fillText(a.name,x+26,y+10);
        ctx.font='7px "Press Start 2P"';
        ctx.fillStyle=got?'#6aaa6a':'#777777';
        const _mw=aw-32; let _d1=a.desc,_d2='';
        if(ctx.measureText(_d1).width>_mw){
            const _ws=a.desc.split(' '); let _l='';
            for(const _w of _ws){const _t=_l?_l+' '+_w:_w;if(ctx.measureText(_t).width<=_mw)_l=_t;else{_d2=a.desc.slice(_l.length+1);break;}}_d1=_l;
        }
        ctx.fillText(_d1,x+26,y+24);
        if(_d2) ctx.fillText(_d2,x+26,y+34);
        ctx.font='7px "Press Start 2P"';
        ctx.fillStyle=got?'#5a8a5a':'#666666';
        ctx.fillText(got?'UNLOCKED':'???',x+26,y+50);
    });
    ctx.textAlign='center'; ctx.textBaseline='middle';
    const total=list.filter(a=>achUnlocked[a.id]).length;
    ct(`${total} / ${list.length} UNLOCKED`,CW/2,CH-26,'#6aaa6a',8);
    const hint=expert?'LEFT/RIGHT  SWITCH PAGE   ENTER to return':'Any key or OK to return';
    ct(hint,CW/2,CH-10,'#999',8);
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
        ctx.fillStyle='#7fff7f'; ctx.font='7px "Press Start 2P"';
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.fillText('ACHIEVEMENT!',px+28,py+7);
        ctx.shadowBlur=0;
        ctx.fillStyle='#aaffaa'; ctx.font='7px "Press Start 2P"';
        ctx.fillText(a.name,px+28,py+20);
        ctx.fillStyle='#ffd700'; ctx.font='6px "Press Start 2P"';
        ctx.fillText('+1,000 FK',px+28,py+31);
        drawPixelIcon(px+5,py+ph/2-8,a.icon,1.5);
        ctx.restore();
    });
    ctx.textAlign='center'; ctx.textBaseline='middle';
}

function drawShop() {
    drawGrid(); drawOvBg(0.92);
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=20; ct('SHOP',CW/2,28,'#ffd700',18); ctx.shadowBlur=0;
    const coins=_cachedFOKoins, si=cfg.shopItems||{}, wi=cfg.wornItems||{};
    const startY=50, rowH=44;
    SHOP_ITEMS.forEach((item,i)=>{
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
        ctx.font='8px "Press Start 2P"';
        ctx.fillStyle=worn?'#7fff7f':(owned&&isRep)?'#ff66aa':owned?'#5a8aaa':sel?'#dddddd':'#aaaaaa';
        ctx.fillText(item.name,46,y+7);
        ctx.font='7px "Press Start 2P"'; ctx.fillStyle='#999999';
        ctx.fillText(item.desc,46,y+21);
        ctx.textAlign='right';
        if(isRep){
            if(owned){ctx.font='8px "Press Start 2P"';ctx.fillStyle='#ff44aa';ctx.fillText('DONATED',CW-18,y+9);}
            else{ctx.font='8px "Press Start 2P"';ctx.fillStyle=canAfford?'#ffd700':'#553322';ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+9);}
            ctx.font='7px "Press Start 2P"';
            if(sel){ctx.fillStyle=canAfford?'#5aaa5a':'#cc6644';ctx.fillText(canAfford?'ENTER to donate':'Not enough FK',CW-18,y+23);}
            else if(owned){ctx.fillStyle='#555';ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+23);}
        } else if(owned){
            ctx.font='8px "Press Start 2P"';
            ctx.fillStyle=worn?'#7fff7f':'#4a7a9a';
            ctx.fillText(worn?'WORN':'OWNED',CW-18,y+9);
            ctx.font='7px "Press Start 2P"';
            if(sel){ctx.fillStyle=worn?'#cc5555':'#5aaa5a';ctx.fillText(worn?'SPACE to remove':'SPACE to wear',CW-18,y+23);}
            else{ctx.fillStyle='#555';ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+23);}
        } else {
            ctx.font='8px "Press Start 2P"'; ctx.fillStyle=canAfford?'#ffd700':'#553322';
            ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+9);
            if(sel){ctx.font='7px "Press Start 2P"';ctx.fillStyle=canAfford?'#5aaa5a':'#cc6644';
                ctx.fillText(canAfford?'ENTER to buy':'Not enough FK',CW-18,y+23);}
        }
    });
    // Empty slot placeholder (future item)
    const emptyY=startY+SHOP_ITEMS.length*rowH;
    ctx.fillStyle='rgba(10,10,10,0.15)'; rr(8,emptyY,CW-16,rowH-4,5); ctx.fill();
    ctx.strokeStyle='#1c1c1c'; ctx.lineWidth=1; rr(8,emptyY,CW-16,rowH-4,5); ctx.stroke();
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=2;
    ct(`BALANCE: ${coins.toLocaleString()} FK`,CW/2,CH-30,'#ffd700',8);
    ctx.shadowBlur=0;
    ct('ENTER buy  |  SPACE wear/remove  |  ESC back',CW/2,CH-12,'#888',8);
    // Purchase particles
    const now=performance.now();
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
        ctx.shadowColor='#7fff7f';ctx.shadowBlur=22;
        ct('PURCHASED!',CW/2,CH/2+20,'#7fff7f',30);
        ctx.restore();
    }
}

function drawCredits() {
    drawGrid(); drawOvBg(0.93);
    ctx.save(); ctx.beginPath(); ctx.rect(0,0,CW,CH-24); ctx.clip();
    let y = creditsScroll;
    for (const [type, val] of CRED) {
        if (type === 'gap') { y += val; continue; }
        const h = CRED_H[type] || 22;
        if (y > -50 && y < CH + 20) {
            switch (type) {
                case 'title':
                    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=22;
                    ct(val, CW/2, y+15, '#7fff7f', 20); ctx.shadowBlur=0; break;
                case 'sub':
                    ct(val, CW/2, y+7, '#5a8a5a', 8); break;
                case 'hdr':
                    ctx.shadowColor='#00cccc'; ctx.shadowBlur=6;
                    ct(val, CW/2, y+9, '#00cccc', 8); ctx.shadowBlur=0; break;
                case 'txt':
                    ct(val, CW/2, y+7, '#aaa', 8); break;
                case 'sml':
                    ct(val, CW/2, y+6, '#999', 8); break;
                case 'coins':
                    ctx.shadowColor='#ffd700'; ctx.shadowBlur=3;
                    ct(`YOUR FOKOINS: ${_cachedFOKoins.toLocaleString()}`, CW/2, y+9, '#ffd700', 8);
                    ctx.shadowBlur=0; break;
                case 'secret':
                    ctx.shadowColor='#ff4444'; ctx.shadowBlur=14;
                    ctx.font='8px "Press Start 2P"'; ctx.textAlign='center'; ctx.textBaseline='middle';
                    ctx.fillStyle='#ff5555'; ctx.fillText(val, CW/2, y+9);
                    ctx.shadowBlur=0; break;
            }
        }
        y += h;
    }
    ctx.restore();
    creditsScroll -= creditsSpeed;
    if (creditsScroll < -CRED_TOTAL_H) creditsScroll = CH + 40;  // loop
    ct('HOLD UP slow  HOLD DOWN fast  |  ENTER exit', CW/2, CH-12, '#6a9a6a', 8);
}

function drawNameEntry(now) {
    drawGrid();
    if(bars)  bars.forEach(b=>drawBar(b));
    if(gem)   drawGem(gem,now);
    if(snake) drawSnake(false);
    drawOvBg(0.84);
    const isWin=nameReason==='win';
    ctx.shadowColor=isWin?'#ffd700':'#ff5555'; ctx.shadowBlur=22;
    ct(isWin?'YOU WIN!':'GAME OVER',CW/2,60,isWin?'#ffd700':'#ff5555',26); ctx.shadowBlur=0;
    ct(`SCORE: ${score}   LEVEL: ${level}`,CW/2,100,'#aaa',8);
    ct('ENTER YOUR NAME:',CW/2,128,'#7fff7f',8);
    const sw=30,sh=40,gap=5,totalW=MAX_NAME*(sw+gap)-gap,sx0=Math.floor(CW/2-totalW/2),sy=146;
    for(let i=0;i<MAX_NAME;i++){
        const sx=sx0+i*(sw+gap),act=i===nameStr.length&&nameStr.length<MAX_NAME,has=i<nameStr.length;
        ctx.fillStyle=act?'#142014':'#0d0d18'; ctx.strokeStyle=act?'#7fff7f':'#2a2a3a'; ctx.lineWidth=act?1.5:1;
        rr(sx,sy,sw,sh,3); ctx.fill(); ctx.stroke();
        if(has){ ct(nameStr[i],sx+sw/2,sy+sh/2,'#7fff7f',14); }
        else if(act){
            ctx.globalAlpha=0.42; ct(NAME_CHARS[nameCharIdx]===' '?'_':NAME_CHARS[nameCharIdx],sx+sw/2,sy+sh/2,'#7fff7f',14); ctx.globalAlpha=1;
            if(Math.floor(now/400)%2===0){ctx.fillStyle='#7fff7f55';ctx.fillRect(sx+5,sy+sh-6,sw-10,2);}
        }
    }
    const cy2=sy+sh+20,ci=nameCharIdx,disp=c=>c===' '?'_':c;
    if(nameStr.length<MAX_NAME){
        ct('(^)',CW/2,cy2,'#888',8);
        ct(disp(NAME_CHARS[(ci-1+NAME_CHARS.length)%NAME_CHARS.length]),CW/2,cy2+14,'#999',8);
        ctx.shadowColor='#7fff7f'; ctx.shadowBlur=10;
        ct(disp(NAME_CHARS[ci]),CW/2,cy2+28,'#7fff7f',14); ctx.shadowBlur=0;
        ct(disp(NAME_CHARS[(ci+1)%NAME_CHARS.length]),CW/2,cy2+38,'#999',8);
        ct('(v)',CW/2,cy2+50,'#888',8);
    }
    ct('TAP to type  |  UP/DOWN+RIGHT  |  ENTER',CW/2,CH-10,'#999',8);
}

function drawGameBoard(now) {
    drawGrid(); ctx.drawImage(_barsCanvas, 0, 0);
    if(gem) drawGem(gem,now);
    const dying=phase==='dying',flash=dying&&Math.floor((now-phaseAt)/85)%2===1;
    const protect=phase==='playing'&&(now-spawnAt<1000);
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
            ctx.globalAlpha=a; ctx.fillStyle=p.color; ctx.shadowColor=p.color; ctx.shadowBlur=6;
            ctx.beginPath(); ctx.arc(p.x,p.y,2.5,0,Math.PI*2); ctx.fill();
            return true;
        });
        ctx.globalAlpha=1; ctx.shadowBlur=0;
    }
    if(phase==='levelDone'){
        const a=Math.min(1,(now-phaseAt)/150);
        ctx.save(); ctx.globalAlpha=a; ctx.shadowColor='#7fff7f'; ctx.shadowBlur=30;
        ct('LEVEL COMPLETE!',CW/2,levelWasPerfect?CH/2-36:CH/2-18,'#7fff7f',22); ctx.restore();
        if(levelWasPerfect){
            const pa=Math.min(1,(now-phaseAt-180)/200);
            if(pa>0){
                ctx.save(); ctx.globalAlpha=pa;
                ctx.shadowColor='#ffd700'; ctx.shadowBlur=22;
                ct('PERFECT LEVEL!',CW/2,CH/2+2,'#ffd700',14);
                ctx.shadowBlur=0;
                ct(`+${(level*1000).toLocaleString()} BONUS`,CW/2,CH/2+22,'#ffaa00',8);
                ctx.restore();
            }
        }
        if(levelDoneWaiting&&Math.floor(now/520)%2===0){
            ctx.save(); ctx.font='8px "Press Start 2P"'; ctx.textBaseline='bottom'; ctx.textAlign='center'; ctx.shadowBlur=0;
            ctx.fillStyle='#4a7a4a'; ctx.fillText('TAP OR PRESS ANY KEY',CW/2,CH-8); ctx.restore();
        }
    }
    if(phase==='levelReady'){
        const t=now-phaseAt, goPhase=t>=READY_DUR;
        drawOvBg(0.72);
        if(!goPhase){
            ctx.shadowColor='#7fff7f'; ctx.shadowBlur=20;
            ct(`LEVEL ${level}`,CW/2,CH/2-18,'#7fff7f',18); ctx.shadowBlur=0;
            ct('GET READY',CW/2,CH/2+38,'#aaa',14);
        } else {
            const a=Math.min(1,(t-READY_DUR)/80);
            ctx.save(); ctx.globalAlpha=a; ctx.shadowColor='#ffff44'; ctx.shadowBlur=30;
            ct('GO!',CW/2,CH/2+10,'#ffff44',28); ctx.shadowBlur=0; ctx.restore();
        }
    }
    if(dying){
        const t=(now-phaseAt)/DEATH_DUR;
        ctx.save(); ctx.globalAlpha=Math.min(1,t*2.5); ctx.shadowColor='#ff4444'; ctx.shadowBlur=20;
        ct(deathMsg,CW/2,CH/2,'#ff5555',16); ctx.restore();
    }
    if(phase==='paused'){
        drawOvBg(0.55);
        ctx.shadowColor='#7fff7f'; ctx.shadowBlur=24;
        ct('PAUSED',CW/2,CH/2+10,'#7fff7f',28); ctx.shadowBlur=0;
        ctx.save(); ctx.font='8px "Press Start 2P"'; ctx.textBaseline='bottom'; ctx.textAlign='center'; ctx.shadowBlur=0;
        ctx.fillStyle='#4a7a4a'; ctx.fillText('SPACE / PSE to resume   ESC to quit menu',CW/2,CH-8); ctx.restore();
    }
    // Bonus flash (duration and colour vary by tier)
    const bonusAge=now-bonusAt;
    const flashDur=bonusLabel.startsWith('EPIC')?1500:900;
    if(bonusAge<flashDur&&bonusLabel){
        const a=1-bonusAge/flashDur;
        const isEpic=bonusLabel.startsWith('EPIC'),isLucky=bonusLabel.startsWith('LUCKY');
        const col=isEpic?`hsl(${(now/6)%360},100%,70%)`:'#ffd700';
        const sz=isEpic?22:16;
        ctx.save(); ctx.globalAlpha=a;
        ctx.shadowColor=col; ctx.shadowBlur=isEpic?40:30;
        ct(bonusLabel,CW/2,CH/2-60,col,sz);
        ctx.restore();
    }
    updateHUD();
}

function drawConfirmYesNo(title, sel) {
    const YES_X=CW/2-80, NO_X=CW/2+80;
    ctx.shadowColor='#ff9900'; ctx.shadowBlur=18;
    ct(title,CW/2,CH/2-18,'#ff9900',18); ctx.shadowBlur=0;
    ctx.globalAlpha=sel===0?1:0.35;
    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=sel===0?14:0;
    ct(sel===0?'> YES <':'  YES  ',YES_X,CH/2+38,'#7fff7f',14);
    ctx.globalAlpha=sel===1?1:0.35;
    ctx.shadowColor='#ff5555'; ctx.shadowBlur=sel===1?14:0;
    ct(sel===1?'> NO <':'  NO   ',NO_X,CH/2+38,'#ff5555',14);
    ctx.globalAlpha=1; ctx.shadowBlur=0;
    ctx.save(); ctx.font='8px "Press Start 2P"'; ctx.textBaseline='bottom'; ctx.textAlign='center';
    ctx.fillStyle='#4a7a4a'; ctx.fillText('LEFT/RIGHT to choose   ENTER confirm   ESC cancel',CW/2,CH-8); ctx.restore();
}
function drawQuitConfirm() {
    drawGrid();
    if(bars)  ctx.drawImage(_barsCanvas, 0, 0);
    if(gem)   drawGem(gem, performance.now());
    if(snake) drawSnake(false);
    drawOvBg(0.72);
    drawConfirmYesNo('QUIT TO MENU?', quitConfirmSel);
    showHUD(false);
}
function drawResetConfirm() {
    drawSettings();
    drawOvBg(0.80);
    ct('RESET ALL STATS?',CW/2,CH/2-54,'#ff5555',16);
    ctx.font='8px "Press Start 2P"'; ctx.textAlign='center'; ctx.textBaseline='middle';
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
        {key:'ArrowUp',    pts:[[H,H],[0,0],[S,0]],  lx:H,      ly:H*0.34,  label:'^'},
        {key:'ArrowRight', pts:[[H,H],[S,0],[S,S]],  lx:H*1.65, ly:H,       label:'>'},
        {key:'ArrowDown',  pts:[[H,H],[S,S],[0,S]],  lx:H,      ly:H*1.65,  label:'v'},
        {key:'ArrowLeft',  pts:[[H,H],[0,S],[0,0]],  lx:H*0.35, ly:H,       label:'<'},
    ];
    sectors.forEach(s=>{
        const pressed=s.key===active;
        dpc.save();
        dpc.beginPath(); dpc.moveTo(s.pts[0][0],s.pts[0][1]); dpc.lineTo(s.pts[1][0],s.pts[1][1]); dpc.lineTo(s.pts[2][0],s.pts[2][1]); dpc.closePath(); dpc.clip();
        dpc.fillStyle=pressed?'#1a3a1a':'#0a180a'; dpc.fillRect(0,0,S,S);
        dpc.fillStyle='#7fff7f';
        dpc.shadowColor=pressed?'#7fff7f':'transparent'; dpc.shadowBlur=pressed?10:0;
        dpc.font='bold 20px "Courier New"'; dpc.textAlign='center'; dpc.textBaseline='middle';
        dpc.fillText(s.label,s.lx,s.ly);
        dpc.restore();
    });
    dpc.strokeStyle='#1e321e'; dpc.lineWidth=3;
    dpc.beginPath(); dpc.moveTo(0,0); dpc.lineTo(S,S); dpc.moveTo(S,0); dpc.lineTo(0,S); dpc.stroke();
    dpc.strokeStyle='#2a3a2a'; dpc.lineWidth=1; dpc.strokeRect(0.5,0.5,S-1,S-1);
}

function dpadDir(e, cvs) {
    const rect=cvs.getBoundingClientRect(), sx=cvs.width/rect.width, sy=cvs.height/rect.height;
    const t=e.touches?e.touches[0]||e.changedTouches[0]:e;
    const x=(t.clientX-rect.left)*sx-DSIZE/2, y=(t.clientY-rect.top)*sy-DSIZE/2;
    return Math.abs(x)>Math.abs(y)?(x>0?'ArrowRight':'ArrowLeft'):(y>0?'ArrowDown':'ArrowUp');
}

dpadCanvas.addEventListener('touchstart',e=>{
    Snd.resume(); e.preventDefault();
    dpadActive=dpadDir(e,dpadCanvas); handleKey(dpadActive,null);
    drawDpad(phase==='splash'?null:dpadActive);
    if(phase==='playing'){const d=GDIRS[dpadActive];if(d){boostDir=d;boostSince=performance.now();boosting=false;}}
},{passive:false});
dpadCanvas.addEventListener('touchmove',e=>{
    e.preventDefault();
    const d=dpadDir(e,dpadCanvas);
    if(d!==dpadActive){
        dpadActive=d; handleKey(dpadActive,null);
        drawDpad(phase==='splash'?null:dpadActive);
        if(phase==='playing'){const gd=GDIRS[dpadActive];if(gd){boostDir=gd;boostSince=performance.now();boosting=false;}else{boostDir=null;boosting=false;}}
    }
},{passive:false});
dpadCanvas.addEventListener('touchend',e=>{e.preventDefault();dpadActive=null;drawDpad(null);boostDir=null;boosting=false;},{passive:false});
dpadCanvas.addEventListener('click',e=>{handleKey(dpadDir(e,dpadCanvas),null);});
drawDpad(null);

// ================================================================
// INPUT
// ================================================================
const GDIRS={ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1},ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0}};

let _splashLeftAt = 0, _splashTouchPending = false;
let _splashFast = false, _splashFastStart = 0, _splashFastBase = 0;
function leaveSplash(fromTouch = false) {
    _splashFast = false; _splashFastStart = 0; _splashFastBase = 0;
    Snd.resume();
    _splashLeftAt = performance.now();
    _splashTouchPending = fromTouch;
    phase = 'menu'; phaseAt = performance.now();
    document.getElementById('btn-mute').style.visibility = '';
    document.getElementById('fps-el').style.visibility = '';
    document.getElementById('gamepad').classList.remove('splash');
}

const GAME_KEYS = new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter','Escape','Backspace',' ']);
function handleKey(key, pde) {
    // Let browser handle F-keys (F5 reload, F11 fullscreen, etc.)
    if (key.length > 1 && !GAME_KEYS.has(key)) return;
    if (phase === 'splash') {
        if (key === 'ArrowDown' && !_splashFast) {
            _splashFast = true;
            _splashFastStart = performance.now();
            _splashFastBase = (performance.now() - phaseAt) / 1000;
            return;
        }
        // Only meaningful keys exit splash; F-keys/Escape/modifiers fall through so
        // the browser still handles F5 (refresh), F11 (fullscreen), etc.
        const splashOk = key.length === 1 || key === 'Enter';
        if (!splashOk) return;
        leaveSplash(); if (pde) pde(); return;
    }
    if (performance.now() - _splashLeftAt < 200) return;
    Snd.resume();

    // Global: mute (suppressed during name entry so M is typeable)
    if((key==='m'||key==='M')&&phase!=='nameEntry'){ toggleMute(); return; }

    // Space = pause toggle (playing/paused only)
    if(key===' '){
        if(phase==='playing'||phase==='paused'){ togglePause(); if(pde)pde(); return; }
        if(phase==='menu'){ Snd.sfx('select',cfg.music); startGame(); if(pde)pde(); return; }
    }

    // Escape = quit confirm in-game, or back in menus
    if(key==='Escape'){
        if(phase==='playing'||phase==='paused'){
            if(performance.now() < escReadyAt) return;
            prevPhase=phase; quitConfirmSel=1;
            if(phase==='playing') Snd.pauseMusic();
            phase='quitConfirm'; if(pde)pde(); return;
        }
        if(phase==='quitConfirm'){
            phase=prevPhase; if(prevPhase==='playing')Snd.resumeMusic();
            escReadyAt=performance.now()+1000; if(pde)pde(); return;
        }
        if(phase==='resetConfirm'){ phase='settings'; if(pde)pde(); return; }
        if(phase==='settings'){ phase='menu'; Snd.sfx('nav',cfg.music); if(pde)pde(); return; }
        if(phase==='scores'||phase==='credits'||phase==='shop'){ phase='menu'; Snd.sfx('nav',cfg.music); if(pde)pde(); return; }
        if(phase==='achievements'){ phase='menu'; Snd.sfx('nav',cfg.music); if(pde)pde(); return; }
    }

    if(phase==='menu'){
        if(key==='ArrowUp')  {menuSel=(menuSel-1+MENU_ITEMS.length)%MENU_ITEMS.length;Snd.sfx('nav',cfg.music);}
        if(key==='ArrowDown'){menuSel=(menuSel+1)%MENU_ITEMS.length;Snd.sfx('nav',cfg.music);}
        if(key==='Enter'){
            Snd.sfx('select',cfg.music);
            if(menuSel===0)startGame();
            else if(menuSel===1){phase='settings';settingsSel=0;}
            else if(menuSel===2){phase='scores';_scoreboardCache=getScores();}
            else if(menuSel===3){phase='achievements';achPage=0;}
            else if(menuSel===4){phase='shop';shopSel=0;purchaseAnimAt=0;}
            else{phase='credits';creditsScroll=CH+40;creditsSpeed=0.8;}
            if(pde)pde();
        }
    }
    else if(phase==='settings'){
        if(key==='ArrowUp')  {settingsSel=(settingsSel-1+SETTINGS_COUNT)%SETTINGS_COUNT;Snd.sfx('nav',cfg.music);}
        if(key==='ArrowDown'){settingsSel=(settingsSel+1)%SETTINGS_COUNT;Snd.sfx('nav',cfg.music);}
        if(key==='Enter'){
            Snd.sfx('select',cfg.music);
            if(settingsSel===0){cfg.music=!cfg.music;if(!cfg.music)Snd.stop();updateMuteBtn();}
            else if(settingsSel===1){cfg.musicStyle=(cfg.musicStyle+1)%2;Snd.stop();}
            else if(settingsSel===4){cfg.turbo=cfg.turbo===false?true:false;}
            else if(settingsSel===5)cfg.diff=(cfg.diff+1)%DIFF.length;
            else if(settingsSel===6)cfg.snakeColor=(cfg.snakeColor+1)%SNAKE_COLORS.length;
            else if(settingsSel===7){cfg.handed=(cfg.handed+1)%2;applyHandedness();}
            else if(settingsSel===8){cfg.touchSelect=!cfg.touchSelect;}
            else if(settingsSel===9){quitConfirmSel=1;phase='resetConfirm';return;}
            else phase='menu';
            saveCfg();
        }
        if(key==='ArrowLeft'||key==='ArrowRight'){
            const r=key==='ArrowRight';
            if(settingsSel===2){
                cfg.volume=Math.max(0,Math.min(1,Math.round(((cfg.volume??1)+(r?0.1:-0.1))*10)/10));
                Snd.setVol(cfg.volume); saveCfg(); Snd.sfx('nav',cfg.music);
            } else if(settingsSel===3){
                cfg.sfxVol=Math.max(0,Math.min(1,Math.round(((cfg.sfxVol??0.5)+(r?0.1:-0.1))*10)/10));
                Snd.setSfxVol(cfg.sfxVol); saveCfg(); Snd.sfx('nav',cfg.music);
            } else if(settingsSel===6){
                cfg.snakeColor=(cfg.snakeColor+(r?1:-1)+SNAKE_COLORS.length)%SNAKE_COLORS.length;
                saveCfg(); Snd.sfx('nav',cfg.music);
            } else if(settingsSel===7){
                cfg.handed=r?1:0; applyHandedness(); saveCfg(); Snd.sfx('nav',cfg.music);
            }
        }
        if(pde)pde();
    }
    else if(phase==='credits'){
        if(key==='ArrowDown'){creditsSpeed=3.2;if(pde)pde();}
        else if(key==='ArrowUp'){creditsSpeed=0.4;if(pde)pde();}
        else if(key==='Enter'){phase='menu';creditsSpeed=0.8;if(pde)pde();}
    }
    else if(phase==='scores'){ phase='menu'; if(pde)pde(); }
    else if(phase==='achievements'){
        const _ea=ACHIEVEMENTS.every(a=>achUnlocked[a.id]);
        if(_ea&&(key==='ArrowLeft'||key==='ArrowRight')){achPage=1-achPage;Snd.sfx('nav',cfg.music);if(pde)pde();}
        else{phase='menu';if(pde)pde();}
    }
    else if(phase==='shop'){
        if(key==='ArrowUp'){ shopSel=(shopSel-1+SHOP_ITEMS.length)%SHOP_ITEMS.length; Snd.sfx('nav',cfg.music); }
        else if(key==='ArrowDown'){ shopSel=(shopSel+1)%SHOP_ITEMS.length; Snd.sfx('nav',cfg.music); }
        else if(key==='Enter'){
            const item=SHOP_ITEMS[shopSel];
            const si=cfg.shopItems||(cfg.shopItems={});
            if(item&&_cachedFOKoins>=item.price&&(item.repeatable||!si[item.id])){
                _cachedFOKoins-=item.price; try { localStorage.setItem(FK_KEY,String(_cachedFOKoins)); } catch {}
                si[item.id]=true;
                if(!item.repeatable)(cfg.wornItems||(cfg.wornItems={}))[item.id]=true;
                saveCfg();
                if(SHOP_ITEMS.filter(s=>!s.repeatable).every(s=>si[s.id])) unlockAch('shop_full');
                triggerPurchaseAnim(); Snd.sfx('perfect',cfg.music);
            }
        }
        else if(key===' '){
            const item=SHOP_ITEMS[shopSel];
            const si=cfg.shopItems||{}, wi=cfg.wornItems||(cfg.wornItems={});
            if(item&&!item.repeatable&&si[item.id]){
                if(wi[item.id]) delete wi[item.id]; else wi[item.id]=true;
                saveCfg(); Snd.sfx('nav',cfg.music);
            }
        }
        if(pde)pde();
    }
    else if(phase==='quitConfirm'){
        if(key==='ArrowLeft'){ quitConfirmSel=0; Snd.sfx('nav',cfg.music); }
        if(key==='ArrowRight'){ quitConfirmSel=1; Snd.sfx('nav',cfg.music); }
        if(key==='Enter'||key==='y'||key==='Y'){
            Snd.sfx('select',cfg.music);
            if(quitConfirmSel===0){ phase='menu'; showHUD(false); Snd.stop(); }
            else { phase=prevPhase; if(prevPhase==='playing')Snd.resumeMusic(); escReadyAt=performance.now()+1000; }
        }
        if(pde)pde();
    }
    else if(phase==='resetConfirm'){
        if(key==='ArrowLeft'){ quitConfirmSel=0; Snd.sfx('nav',cfg.music); }
        if(key==='ArrowRight'){ quitConfirmSel=1; Snd.sfx('nav',cfg.music); }
        if(key==='Enter'){
            Snd.sfx('select',cfg.music);
            if(quitConfirmSel===0){ resetStats(); }
            phase='settings'; quitConfirmSel=1;
        }
        if(pde)pde();
    }
    else if(phase==='levelDone'){
        if(levelDoneWaiting){
            levelDoneWaiting=false;
            if(level<MAX_LEVELS){_levelStartLen=cfg.diff===2?snake.length:0;level++;beginLevel();}
            else{phase='nameEntry';try{nameStr=(localStorage.getItem('lastSName')||'').substring(0,MAX_NAME);}catch{nameStr='';}nameCharIdx=0;nameReason='win';showHUD(false);Snd.stop();}
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
        if(key==='ArrowUp')  {nameCharIdx=(nameCharIdx-1+NAME_CHARS.length)%NAME_CHARS.length;Snd.sfx('nav',cfg.music);}
        else if(key==='ArrowDown'){nameCharIdx=(nameCharIdx+1)%NAME_CHARS.length;Snd.sfx('nav',cfg.music);}
        else if(key==='ArrowRight'){if(nameStr.length<MAX_NAME){nameStr+=NAME_CHARS[nameCharIdx];Snd.sfx('nav',cfg.music);}}
        else if(key==='Backspace'||key==='ArrowLeft'){if(nameStr.length>0){nameStr=nameStr.slice(0,-1);Snd.sfx('nav',cfg.music);}if(pde)pde();}
        else if(key.length===1&&/^[a-zA-Z0-9 ]$/.test(key)&&nameStr.length<MAX_NAME){nameStr+=key.toUpperCase();Snd.sfx('nav',cfg.music);}
        else if(key==='Enter'){
            try { localStorage.setItem('lastSName', nameStr.trim()||'SNAKE PLISSKEN'); } catch {}
            addScore(nameStr,score,level); Snd.sfx('select',cfg.music);
            _scoreboardCache=getScores(); phase='scores'; showHUD(false); setTimeout(()=>nameInp.blur(),10);
        }
    }
}

canvas.addEventListener('mousemove', ()=>{ canvas.style.cursor=''; });

// Swipe/gesture control on game canvas.
// Thresholds: first move = 30px; same dir or 90-deg turn = 40px; opposite dir = 30px.
// Dead zone: 40-50 degrees from horizontal — diagonal motion commits nothing until
// the finger clearly enters a direction corridor (0-40 deg = horizontal, 50-90 = vertical).
// In the dead zone the baseline is NOT reset, so displacement keeps accumulating until
// the angle exits into a real corridor.
// Pause cooldown: if finger stops moving for 200ms the higher threshold resets to 30px,
// so deliberate re-moves after a pause feel as responsive as the first direction.
// Splash: any pointer or touch on canvas exits splash and unlocks audio
// Mouse/stylus only: touch devices use the touchstart handler below so that
// leaveSplash() → Snd.resume() → init() plays a silent buffer + ac.resume() inside a trusted element touchstart,
// not inside a pointerdown (which iOS Safari won't honour for AudioContext unlock).
canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    if (phase === 'splash') { leaveSplash(false); }
    else if (phase !== 'playing') { handleKey('Enter', null); }
});
canvas.addEventListener('touchstart',  e => { if (phase === 'splash') { leaveSplash(true); e.preventDefault(); } }, { passive: false });

const nameInp = document.getElementById('name-inp');
const SWIPE_1=20, SWIPE_N=30, SWIPE_SAME=50, DZ_LO=40, DZ_HI=50, SWIPE_COOLDOWN=200;
function _isOpp(a,b){return(a==='ArrowLeft'&&b==='ArrowRight')||(a==='ArrowRight'&&b==='ArrowLeft')||(a==='ArrowUp'&&b==='ArrowDown')||(a==='ArrowDown'&&b==='ArrowUp');}
let _swipeBase=null, _swipeLastDir=null, _swipeLastMoveAt=0, _swipeLastMovePos=null, _swipeTouchStartAt=0, _swipedThisTouch=false;
canvas.addEventListener('touchstart',e=>{
    Snd.resume(); e.preventDefault();
    if(phase==='nameEntry'){ nameInp.focus(); }
    const t=e.touches[0];
    _swipeBase={x:t.clientX,y:t.clientY}; _swipeLastDir=null; _swipeLastMoveAt=performance.now(); _swipeLastMovePos={x:t.clientX,y:t.clientY}; _swipeTouchStartAt=performance.now(); _swipedThisTouch=false;
},{passive:false});
canvas.addEventListener('touchmove',e=>{
    e.preventDefault();
    if(!_swipeBase||_splashTouchPending) return;
    const now=performance.now();
    if(_swipeLastDir&&now-_swipeLastMoveAt>SWIPE_COOLDOWN) _swipeLastDir=null;
    const t=e.touches[0];
    if(!_swipeLastMovePos||Math.hypot(t.clientX-_swipeLastMovePos.x,t.clientY-_swipeLastMovePos.y)>=5){_swipeLastMoveAt=now;_swipeLastMovePos={x:t.clientX,y:t.clientY};}
    const dx=t.clientX-_swipeBase.x, dy=t.clientY-_swipeBase.y;
    const dist=Math.hypot(dx,dy);
    if(dist<SWIPE_1) return;
    const ang=Math.atan2(Math.abs(dy),Math.abs(dx))*180/Math.PI;
    if(ang>=DZ_LO&&ang<=DZ_HI) return;
    const key=ang<DZ_LO?(dx>0?'ArrowRight':'ArrowLeft'):(dy>0?'ArrowDown':'ArrowUp');
    // opposite or first: 20px (30px while boosting); 90-deg turn: 30px; same dir: 50px (boost prevention)
    const thresh=(!_swipeLastDir||_isOpp(key,_swipeLastDir))?(boosting?SWIPE_N:SWIPE_1):key===_swipeLastDir?SWIPE_SAME:SWIPE_N;
    if(dist<thresh) return;
    _swipedThisTouch=true; handleKey(key,null);
    if(phase==='playing'){
        const d=GDIRS[key];
        if(d){
            if(_swipeLastDir&&_isOpp(key,_swipeLastDir)){clearBoost();}
            else if(_swipeLastDir&&key===_swipeLastDir){boostDir=d;boosting=true;boostSince=performance.now();}
            else if(!(boosting&&boostDir&&d.x===boostDir.x&&d.y===boostDir.y)){clearBoost();} // first swipe or 90-deg turn: no boost
        }
    }
    _swipeLastDir=key; _swipeBase={x:t.clientX,y:t.clientY};
},{passive:false});
canvas.addEventListener('touchend',e=>{
    e.preventDefault();
    if(_splashTouchPending){ _splashTouchPending=false; _swipeBase=null; _swipeLastDir=null; return; }
    if(_swipeBase){
        const t=e.changedTouches[0];
        const isTap=Math.hypot(t.clientX-_swipeBase.x,t.clientY-_swipeBase.y)<SWIPE_1&&!_swipeLastDir&&!_swipedThisTouch&&performance.now()-_swipeTouchStartAt>20;
        if(phase!=='playing'&&(isTap||cfg.touchSelect)) handleKey('Enter',null);
    }
    _swipeBase=null; _swipeLastDir=null; _swipeLastMovePos=null;
    if(phase==='playing'){boostDir=null;boosting=false;}
    if(phase==='credits'){creditsSpeed=0.8;}
},{passive:false});

// Restore audio on pointer gestures mid-game (background resume, desktop mouse, etc.).
document.addEventListener('pointerdown', () => Snd.tryResume(), {capture:true, passive:true});
// touchend is a trusted iOS Safari gesture and fires even when touchstart called
// e.preventDefault(). Gives the audio context a second unlock attempt if the
// touchstart-based ac.resume() promise silently hung (iOS WebKit quirk).
document.addEventListener('touchend', () => Snd.tryResume(), {passive:true});
// Pause audio when app goes to background, resume when it returns
function onBgHide() {
    if (phase === 'playing') { phase = 'paused'; pauseAt = performance.now(); Snd.pauseMusic(); }
    Snd.suspend();
}
function onBgShow() { if (cfg.music) Snd.resume(); }
document.addEventListener('visibilitychange', () => { if (document.hidden) onBgHide(); else onBgShow(); });
window.addEventListener('blur', onBgHide);
window.addEventListener('focus', onBgShow);
document.addEventListener('keydown', e=>{
    handleKey(e.key,()=>e.preventDefault());
    if(!e.repeat&&phase==='playing'){const d=GDIRS[e.key];if(d){boostDir=d;boostSince=performance.now();boosting=false;}}
    if(phase==='playing') canvas.style.cursor='none';
});
document.addEventListener('keyup', e=>{
    const d=GDIRS[e.key];
    if(d&&boostDir&&d.x===boostDir.x&&d.y===boostDir.y){boostDir=null;boosting=false;}
    if(phase==='credits'&&(e.key==='ArrowDown'||e.key==='ArrowUp'))creditsSpeed=0.8;
});

// Side buttons
document.getElementById('btn-ok').addEventListener('touchstart',e=>{handleKey('Enter',null);e.preventDefault();},{passive:false});
document.getElementById('btn-ok').addEventListener('click',()=>handleKey('Enter',null));
document.getElementById('btn-pause').addEventListener('touchstart',e=>{handleKey(' ',null);e.preventDefault();},{passive:false});
document.getElementById('btn-pause').addEventListener('click',()=>handleKey(' ',null));
document.getElementById('gamepad').classList.add('splash');
document.getElementById('btn-esc').addEventListener('touchstart',e=>{handleKey('Escape',null);e.preventDefault();},{passive:false});
document.getElementById('btn-esc').addEventListener('click',()=>handleKey('Escape',null));


// Mobile name entry via OS keyboard
nameInp.addEventListener('input', e => {
    if (phase !== 'nameEntry') return;
    if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') {
        if (nameStr.length > 0) { nameStr = nameStr.slice(0,-1); Snd.sfx('nav',cfg.music); }
        nameInp.value = ''; return;
    }
    const val = nameInp.value.toUpperCase();
    for (const ch of val) {
        if (nameStr.length < MAX_NAME && NAME_CHARS.includes(ch)) {
            nameStr += ch; Snd.sfx('nav', cfg.music);
        }
    }
    nameInp.value = '';
});
nameInp.addEventListener('keydown', e => {
    if (phase !== 'nameEntry') return;
    if (e.key === 'Enter') { handleKey('Enter', () => e.preventDefault()); }
    if (e.key === 'Backspace') { e.preventDefault(); if(nameStr.length>0){nameStr=nameStr.slice(0,-1);Snd.sfx('nav',cfg.music);} }
    // Block input event for letter keys — global keydown handler already adds them
    if (e.key.length === 1) e.preventDefault();
});

// Mute button
const muteBtn = document.getElementById('btn-mute');
const _muteCv = document.getElementById('btn-mute-cv');
const _muteCvCtx = _muteCv.getContext('2d');
function updateMuteBtn(){
    const on=cfg.music; muteBtn.classList.toggle('muted',!on);
    const c=_muteCvCtx;
    c.clearRect(0,0,16,16);
    (on?SPEAKER_ON:SPEAKER_OFF).forEach((row,ry)=>row.forEach((p,rx)=>{
        if(!p)return;
        c.fillStyle=(!on&&rx>=5)?'#aa3333':(on?'#7fff7f':'#555555');
        c.fillRect(rx*2,ry*2,2,2);
    }));
}
function toggleMute(){ cfg.music=!cfg.music; if(!cfg.music)Snd.stop(); updateMuteBtn(); saveCfg(); }
muteBtn.addEventListener('click',toggleMute);
muteBtn.addEventListener('touchstart',e=>{e.preventDefault();toggleMute();},{passive:false});
updateMuteBtn();

// ================================================================
// MAIN LOOP
// TODO(multiplayer): game logic (tick check, phase transitions) is coupled to
// RAF/rendering. For multiplayer, decouple into a fixed-timestep logic loop
// (setInterval or manual accumulator) so game state advances independently of
// display refresh rate and can be driven/validated by a server clock.
// ================================================================
function loop(now) {
    requestAnimationFrame(loop);
    fpsFrames++;
    if(now-fpsLast>=500){fpsEl.textContent=`${Math.round(fpsFrames*1000/(now-fpsLast))} FPS`;fpsFrames=0;fpsLast=now;}

    // Music routing (skip splash/paused/quitConfirm states)
    if(phase!=='splash'&&phase!=='paused'&&phase!=='quitConfirm'&&phase!=='resetConfirm'){
        const menuPhase=['menu','settings','scores','credits','nameEntry','achievements','shop','resetConfirm'].includes(phase);
        const gamePhase=['playing','levelReady','dying','levelDone'].includes(phase);
        const wt=menuPhase?menuTrack():gamePhase?gameTrack():null;
        if(cfg.music&&wt) Snd.play(wt);
        else if(!wt&&!menuPhase&&!gamePhase) Snd.stop();
    }
    Snd.tick(cfg.music);

    // Transitions
    if(phase==='playing'){
        if(boostDir&&boostDir.x===dir.x&&boostDir.y===dir.y&&dirQueue.length===0){
            if(!boosting&&now-boostSince>=BOOST_GRACE&&cfg.turbo!==false)boosting=true;
        }else boosting=false;
        if(now>=stepAt){const es=boosting?Math.max(40,Math.round(speed/20)*10):speed;stepAt=now+es;step(now);}
    }
    if(phase==='levelReady'&&now-phaseAt>=READY_DUR+GO_DUR){
        phase='playing'; stepAt=now+speed; spawnAt=now; phaseAt=0;
    }
    if(phase==='dying'&&now-phaseAt>=DEATH_DUR){
        if(lives>0)beginLevel();
        else{phase='nameEntry';try{nameStr=(localStorage.getItem('lastSName')||'').substring(0,MAX_NAME);}catch{nameStr='';}nameCharIdx=0;nameReason='over';showHUD(false);Snd.stop();}
    }
    if(phase==='levelDone'&&!levelDoneWaiting&&now-phaseAt>=LEVELDONE_DUR){
        levelDoneWaiting=true;
    }

    // Draw
    if     (phase==='splash')       {drawSplash(now);      showHUD(false);}
    else if(phase==='menu')         {drawMenu();           showHUD(false);}
    else if(phase==='settings')     {drawSettings();       showHUD(false);}
    else if(phase==='scores')       {drawScores();         showHUD(false);}
    else if(phase==='achievements') {drawAchievements();   showHUD(false);}
    else if(phase==='shop')         {drawShop();           showHUD(false);}
    else if(phase==='credits')      {drawCredits();        showHUD(false);}
    else if(phase==='nameEntry')    {drawNameEntry(now);}
    else if(phase==='quitConfirm')  {drawQuitConfirm();}
    else if(phase==='resetConfirm') {drawResetConfirm();}
    else                            {drawGameBoard(now);   showHUD(true);}
    drawAchPopups(now);
}

document.fonts.ready.then(() => requestAnimationFrame(loop));

// Align SND button and FPS to the actual canvas top/bottom edges in landscape.
// CSS can't know where the canvas ends up when it's width-constrained, so JS measures it.
const _lsq = window.matchMedia('(orientation: landscape) and (max-height: 520px)');
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
    const iconPx=Math.round(16*scale)+'px'; _muteCv.style.width=_muteCv.style.height=iconPx;
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
