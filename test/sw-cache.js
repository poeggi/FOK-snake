// Service-worker fetch policy: network-first, but never at the cost of a start.
// The handler is driven directly here (a tiny fake FetchEvent + a VIRTUAL clock, so
// the 2s timeout costs the suite nothing) because the interesting cases are all
// timing: a slow-but-alive uplink used to be indistinguishable from a fast one, and
// that is exactly what made a bad connection take minutes to boot.
// Run: node test/sw-cache.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ORIGIN = 'https://poeggi.github.io';
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };
const tick = () => new Promise(r => setImmediate(r));   // let the handler's real microtasks settle

// One isolated service worker with a virtual timer queue and a fetch we resolve by hand.
function boot() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    const timers = [];
    const cache = new Map();
    const pending = [];          // one deferred per fetch() the worker makes
    const put = [];              // urls written back to the cache
    let seq = 1, now = 0, onFetch = null;

    const sandbox = {
        console, Promise, URL,
        self: {
            location: { origin: ORIGIN },
            skipWaiting() {},
            clients: { claim: () => Promise.resolve() },
            addEventListener(type, fn) { if (type === 'fetch') onFetch = fn; },
        },
        caches: {
            open: () => Promise.resolve({ put: (req, res) => { put.push(req.url); cache.set(req.url, res); return Promise.resolve(); }, add: () => Promise.resolve() }),
            match: req => Promise.resolve(cache.get(req.url)),
            keys: () => Promise.resolve([]),
            delete: () => Promise.resolve(true),
        },
        fetch(req) { const d = {}; d.p = new Promise((res, rej) => { d.resolve = res; d.reject = rej; }); d.url = req.url; pending.push(d); return d.p; },
        setTimeout(fn, ms) { const id = seq++; timers.push({ id, at: now + ms, fn }); return id; },
        clearTimeout(id) { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    };
    vm.runInNewContext(src + '\n;globalThis.__NET_TIMEOUT_MS = NET_TIMEOUT_MS;', sandbox);

    return {
        timeout: sandbox.__NET_TIMEOUT_MS,
        cache, pending, put,
        seed(url, tag) { cache.set(url, { ok: true, tag, clone() { return this; } }); },
        // A FetchEvent stub: records whether the worker took the request over at all.
        dispatch(url, method) {
            const req = { url, method: method || 'GET', clone() { return this; } };
            const ev = { request: req, handled: false, response: null, settled: false, waits: [],
                         respondWith(p) { ev.handled = true; ev.response = p; Promise.resolve(p).then(r => { ev.settled = true; ev.value = r; }, () => { ev.settled = true; ev.value = null; }); },
                         waitUntil(p) { ev.waits.push(p); } };
            onFetch(ev);
            return ev;
        },
        advance(ms) { now += ms; for (const t of timers.filter(t => t.at <= now)) { timers.splice(timers.indexOf(t), 1); t.fn(); } },
    };
}

const net = (ok, tag) => ({ ok, tag, clone() { return this; } });

(async () => {
    const T = boot().timeout;
    console.log(`SW fetch policy (NET_TIMEOUT_MS = ${T})`);
    check(T > 0 && T <= 5000, `timeout is a few seconds at most (${T}ms)`);

    // 1. Fast network: the fresh copy wins and refreshes the cache.
    {
        const sw = boot();
        sw.seed(ORIGIN + '/js/game.js', 'cached');
        const ev = sw.dispatch(ORIGIN + '/js/game.js');
        sw.pending[0].resolve(net(true, 'fresh'));
        await tick(); await tick();
        check(ev.value && ev.value.tag === 'fresh', 'quick network answer is served fresh, not from cache');
        check(sw.put.includes(ORIGIN + '/js/game.js'), 'the fresh copy is written back to the cache');
    }

    // 2. THE FIX: a slow-but-alive network must not hold the boot hostage.
    {
        const sw = boot();
        sw.seed(ORIGIN + '/js/sim.js', 'cached');
        const ev = sw.dispatch(ORIGIN + '/js/sim.js');
        await tick();
        sw.advance(T - 1); await tick();
        check(!ev.settled, 'before the timeout the request still waits for the network');
        sw.advance(1); await tick();
        check(ev.value && ev.value.tag === 'cached', 'past the timeout the cached copy is served');
        // The request is not abandoned: it still lands in the cache, so the NEXT start is current.
        sw.pending[0].resolve(net(true, 'fresh'));
        await tick(); await tick();
        check(sw.put.includes(ORIGIN + '/js/sim.js'), 'the slow response still refreshes the cache in the background');
        check(sw.cache.get(ORIGIN + '/js/sim.js').tag === 'fresh', 'the background refresh replaces the stale entry');
    }

    // 3. Nothing cached: the network is the only possible answer, so the timeout must NOT fire.
    {
        const sw = boot();
        const ev = sw.dispatch(ORIGIN + '/js/new-file.js');
        await tick();
        sw.advance(T * 3); await tick();
        check(!ev.settled, 'an uncached asset keeps waiting past the timeout (no empty response)');
        sw.pending[0].resolve(net(true, 'fresh'));
        await tick(); await tick();
        check(ev.value && ev.value.tag === 'fresh', 'an uncached asset is answered by the network');
    }

    // 4. Offline still works: a hard failure falls back to the cache.
    {
        const sw = boot();
        sw.seed(ORIGIN + '/css/style.css', 'cached');
        const ev = sw.dispatch(ORIGIN + '/css/style.css');
        sw.pending[0].reject(new Error('offline'));
        await tick(); await tick();
        check(ev.value && ev.value.tag === 'cached', 'a failed request falls back to the cached copy');
    }

    // 5. API/relay traffic is never cached and never raced -- a stale clock sample or an
    //    ancient long-poll payload served instantly would be worse than no answer.
    {
        const sw = boot();
        const ev = sw.dispatch('https://fok-server.poggensee.it/api/t.txt');
        check(!ev.handled, 'a cross-origin GET is left to the browser (never cache-served)');
        const post = sw.dispatch(ORIGIN + '/api/scores.php', 'POST');
        check(!post.handled, 'a non-GET is left to the browser');
        check(sw.pending.length === 0, 'neither goes through the worker cache path');
    }

    console.log(fails ? `SW-CACHE FAILED (${fails})` : 'SW-CACHE PASSED');
    process.exit(fails ? 1 : 0);
})();
