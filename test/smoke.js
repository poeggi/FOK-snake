// Headless smoke test: load the real game in a stubbed DOM/canvas, drive the
// menus and a few gameplay ticks, and assert no exceptions. This is the repo's
// liveness net -- a syntax error or a broken state transition fails the run.
// Run: node test/smoke.js   (exit 0 = pass, 1 = fail)
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const JS_DIR = path.join(__dirname, '..', 'js');

// ---- Canvas 2D context stub (Proxy: any method is a no-op; a few return values) ----
function ctxStub() {
    const base = {
        measureText: () => ({ width: 60 }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        getImageData: () => ({ data: [] }),
        canvas: { width: 600, height: 400 },
    };
    return new Proxy(base, { get: (t, p) => (p in t ? t[p] : () => {}), set: () => true });
}
// ---- Generic DOM element stub ----
function elStub(id) {
    return {
        id, style: {}, textContent: '', value: '', width: 600, height: 400, files: [],
        getContext: () => ctxStub(),
        addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
        setAttribute() {}, removeAttribute() {}, focus() {}, blur() {}, click() {}, remove() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        querySelector() { return elStub('q'); },
    };
}
const _els = {};
const documentStub = {
    getElementById: id => (_els[id] || (_els[id] = elStub(id))),
    createElement: tag => elStub(tag + '#new'),
    addEventListener() {}, removeEventListener() {},
    body: elStub('body'),
    fonts: { ready: Promise.resolve() },
    hidden: false, visibilityState: 'visible',
};
const _store = {};
const localStorageStub = {
    getItem: k => (k in _store ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: k => { delete _store[k]; },
    clear: () => { for (const k in _store) delete _store[k]; },
};
const sandbox = {
    console, Promise, setTimeout, clearTimeout,
    document: documentStub, localStorage: localStorageStub,
    navigator: { serviceWorker: { addEventListener() {}, register: () => Promise.resolve(), controller: null }, userAgent: 'node' },
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    caches: { keys: () => Promise.resolve([]), match: () => Promise.resolve(null), open: () => Promise.resolve({ addAll() {}, put() {}, match() {} }) },
    Blob: class { constructor() {} }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    FileReader: class { readAsText() {} },
    Image: class { constructor() { this.onload = null; } },
    addEventListener() {}, removeEventListener() {},
};
sandbox.window = sandbox;
sandbox.window.matchMedia = sandbox.matchMedia;
const ctx = vm.createContext(sandbox);

// ---- Load real source + append driver in ONE scope so `let` bindings are visible ----
const src = ['assets.js', 'audio.js', 'game.js']
    .map(f => fs.readFileSync(path.join(JS_DIR, f), 'utf8')).join('\n');
const driver = `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const log = (m) => R.steps.push(m);
  function press(k){ handleKey(k, ()=>{}); }
  try {
    // From splash, force menu. Advance sim clock past the 200ms post-splash input guard.
    simNow=100000; _splashLeftAt=0; _splashKeyHeld=false;
    phase='menu'; menuSel=1; settingsCat=-1; settingsSel=0;

    press('Enter');                                    // open SETTINGS (category list)
    if(phase!=='settings'||settingsCat!==-1) throw 'expected settings category list';

    settingsSel=0; press('Enter');                     // enter AUDIO
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

    settingsSel=SETTINGS_CATS.length-1; press('Enter');// DATA MANAGEMENT
    if(SETTINGS_CATS[settingsCat].label!=='DATA MANAGEMENT') throw 'expected DATA MANAGEMENT';
    settingsSel=0; const off0=cfg.offline; press('Enter');
    if(cfg.offline===off0) throw 'strictly-offline toggle did nothing';
    settingsSel=1; press('Enter');                     // backup
    if(_dataMsg!=='BACKUP SAVED') throw 'backup did not report saved';
    settingsSel=2; press('Enter');                     // restore (no file) must not throw
    settingsSel=3; press('Enter');                     // reset -> resetConfirm
    if(phase!=='resetConfirm') throw 'reset should open resetConfirm';
    press('Escape');
    if(phase!=='settings') throw 'ESC from resetConfirm should return to settings';
    log('settings DATA MANAGEMENT ok');

    // Render every settings screen once to catch draw-time exceptions
    settingsCat=-1; drawSettings();
    for(let c=0;c<SETTINGS_CATS.length;c++){ settingsCat=c;
      for(settingsSel=0; settingsSel<=SETTINGS_CATS[c].items.length; settingsSel++) drawSettings(); }
    log('drawSettings all screens ok');

    // Back out to menu
    settingsCat=-1; settingsSel=SETTINGS_CATS.length; press('Enter');
    if(phase!=='menu') throw 'BACK from category list should return to menu';

    // Config load tolerance: an old/partial save (missing new keys, out-of-range
    // values) and outright garbage must not throw and must fall back to defaults.
    localStorage.setItem(CFG_KEY, JSON.stringify({ music:false, diff:99, snakeColor:-1 }));
    loadCfg();
    if(cfg.diff!==1) throw 'out-of-range diff not clamped to default';
    if(cfg.snakeColor!==0) throw 'out-of-range color not clamped to default';
    if(cfg.offline!==false) throw 'missing offline key should default to false';
    if(cfg.music!==false) throw 'valid saved value (music) was not applied';
    localStorage.setItem(CFG_KEY, 'this is not json {{{');
    loadCfg();
    if(cfg.diff!==1 || cfg.music!==true) throw 'garbage save did not fall back to defaults';
    log('config load tolerance ok');

    // Gameplay smoke: reset the sim clock (the settings phase advanced it past the
    // input guard), start a game, run the fixed-timestep sim through levelReady into
    // playing so step() actually executes, then render the board.
    simTick=0; simNow=0;
    startGame();
    if(phase!=='levelReady'&&phase!=='playing') throw 'startGame did not enter a level';
    for(let i=0;i<400;i++) update();
    drawGameBoard(simNow);
    if(phase==='levelReady') throw 'sim did not advance out of levelReady (step never ran)';
    log('gameplay smoke ok: phase='+phase+' simTick='+simTick+' snakeLen='+(snake?snake.length:0));

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`;
try {
    vm.runInContext(src + driver, ctx, { filename: 'fok-bundle.js' });
} catch (e) {
    console.log('LOAD ERROR:\n' + (e.stack || e));
    process.exit(1);
}
const R = sandbox.__R;
console.log(R.steps.join('\n'));
if (!R || R.err) { console.log('\nSMOKE FAIL: ' + (R ? R.err : 'no result')); process.exit(1); }
console.log('\nSMOKE PASSED');
