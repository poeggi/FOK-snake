// Shared headless harness: stub the DOM/canvas/audio, load the real game code in
// ONE vm scope, then append a test `driver` (a source string) so it can see the
// game's top-level `let`/`const` bindings. Returns the sandbox; the driver is
// expected to populate globalThis.__R = { steps, err, ok }.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const JS_DIR = path.join(__dirname, '..', 'js');

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

function runInGame(driver) {
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

    const src = ['assets.js', 'audio.js', 'sim.js', 'game.js']
        .map(f => fs.readFileSync(path.join(JS_DIR, f), 'utf8')).join('\n');
    vm.runInContext(src + '\n' + driver, ctx, { filename: 'fok-bundle.js' });
    return sandbox;
}

// Run a driver, print its steps, and exit non-zero on failure. `label` names the test.
function runTest(label, driver) {
    let sandbox;
    try { sandbox = runInGame(driver); }
    catch (e) { console.log('LOAD ERROR:\n' + (e.stack || e)); process.exit(1); }
    const R = sandbox.__R;
    if (R && R.steps) console.log(R.steps.join('\n'));
    if (!R || R.err) { console.log(`\n${label} FAIL: ` + (R ? R.err : 'no result')); process.exit(1); }
    console.log(`\n${label} PASSED`);
}

module.exports = { runInGame, runTest };
