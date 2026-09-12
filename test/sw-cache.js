// Service-worker policy: the versioned bundle is the app. A cached asset is served at once
// and never raced against the network; the network only delivers the NEXT version, through
// an all-or-nothing install that copies unchanged files from the previous bundle and
// downloads only what differs. The handler is driven directly here on a fake CacheStorage
// and a fetch resolved by hand, because every interesting case is "what did it fetch, what
// did it write, in which order, and what is left when something fails".
// Run: node test/sw-cache.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ORIGIN = 'https://poeggi.github.io';
const SCOPE = ORIGIN + '/FOK-snake/';
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails++; };
const tick = async (n) => { for (let i = 0; i < (n || 8); i++) await new Promise(r => setImmediate(r)); };

// A response as the worker sees it: ok flag, a body for .text()/.json(), a tag for the checks.
function resp(tag, body, ok) {
    const r = { ok: ok !== false, status: ok === false ? 404 : 200, tag, body: body == null ? '' : body };
    r.clone = () => resp(tag, r.body, r.ok);
    r.text = () => Promise.resolve(r.body);
    r.json = () => Promise.resolve(JSON.parse(r.body));
    return r;
}

// One isolated service worker over a fake CacheStorage (name -> url -> response) and a fetch
// queue the test answers by hand. Install/activate/fetch handlers are captured.
function boot() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    const stores = new Map();
    const pending = [];          // one deferred per fetch() the worker makes
    const handlers = {};
    const calls = { skipWaiting: 0, claim: 0 };
    class Request {
        constructor(url, init) { this.url = new URL(url, SCOPE + 'sw.js').href; this.cache = (init && init.cache) || 'default'; this.method = 'GET'; }
        clone() { return this; }
    }
    class Response {
        constructor(body) { Object.assign(this, resp('made', body)); }
    }
    const openStore = (name) => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
    // A Cache object binds to the store it was opened on: after caches.delete(name) it keeps
    // working on a detached map, as a browser's does, and never re-creates the name.
    const cacheOf = (name) => {
        const st = openStore(name);
        return { match: (req) => Promise.resolve(st.get(req.url)), put: (req, res) => { st.set(req.url, res); return Promise.resolve(); } };
    };
    const sandbox = {
        console, Promise, URL, Set, Map, Object, JSON, Error, Array, Math, Request, Response,
        self: {
            location: { origin: ORIGIN, href: SCOPE + 'sw.js' },
            skipWaiting() { calls.skipWaiting++; },
            clients: { claim: () => { calls.claim++; return Promise.resolve(); } },
            addEventListener(type, fn) { handlers[type] = fn; },
        },
        caches: {
            open: (name) => Promise.resolve(cacheOf(name)),
            keys: () => Promise.resolve([...stores.keys()]),
            delete: (name) => Promise.resolve(stores.delete(name)),
        },
        fetch(req, init) {
            const d = {}; d.p = new Promise((res, rej) => { d.resolve = res; d.reject = rej; });
            d.url = req.url; d.cache = (init && init.cache) || req.cache; pending.push(d); return d.p;
        },
        setTimeout, clearTimeout,
    };
    vm.runInNewContext(src + '\n;globalThis.__CACHE = CACHE; globalThis.__ASSETS = ASSETS;', sandbox);
    const CACHE = sandbox.__CACHE, ASSETS = sandbox.__ASSETS;
    const urlOf = (p) => new URL(p, SCOPE + 'sw.js').href;
    const version = CACHE.replace(/^snake-/, '');
    // What the network would hand over for a bundle path of THIS version.
    const fresh = (p) => resp('fresh:' + p, p === './js/assets.js' ? "const APP_VERSION = '" + version + "';" : 'body of ' + p);

    return {
        CACHE, ASSETS, stores, pending, calls, urlOf, version, fresh,
        store: (name) => openStore(name),
        // An older bundle on the device: every asset under its own tag, with the manifest
        // naming the given ids (default: identical to this version's, i.e. nothing changed).
        seedPrev(name, ids) {
            const s = openStore(name);
            const table = Object.assign({}, ASSETS, ids || {});
            for (const p of Object.keys(ASSETS)) s.set(urlOf(p), resp('old:' + p, 'old body of ' + p));
            s.set(urlOf('./__bundle.json'), resp('manifest', JSON.stringify(table)));
            return s;
        },
        // Answer every outstanding fetch with this version's fresh copy (or a failure for `fail`).
        answerAll(fail) {
            for (const d of pending.splice(0)) {
                const p = './' + d.url.slice(SCOPE.length);   // the scope root is './'
                if (fail && fail(p)) d.resolve(resp('bad', '', false)); else d.resolve(this.fresh(p));
            }
        },
        // Keep answering rounds until the worker asks for nothing more (the precache fans out a
        // few at a time). Reports how many it fetched in all and the widest burst.
        async drain(fail) {
            const urls = []; let widest = 0;
            for (let quiet = 0; quiet < 3; ) {
                await tick();
                if (!pending.length) { quiet++; continue; }
                quiet = 0; widest = Math.max(widest, pending.length);
                for (const d of pending) urls.push(d.url);
                this.answerAll(fail);
            }
            return { urls, widest };
        },
        install() { const ev = { waits: [], waitUntil(p) { ev.waits.push(p); } }; handlers.install(ev); return Promise.all(ev.waits).then(() => true, () => false); },
        activate() { const ev = { waits: [], waitUntil(p) { ev.waits.push(p); } }; handlers.activate(ev); return Promise.all(ev.waits); },
        // A FetchEvent stub: records whether the worker took the request over at all.
        dispatch(url, method) {
            const req = { url, method: method || 'GET', cache: 'default', clone() { return this; } };
            const ev = { request: req, handled: false, settled: false, waits: [],
                         respondWith(p) { ev.handled = true; Promise.resolve(p).then(r => { ev.settled = true; ev.value = r; }, () => { ev.settled = true; ev.value = null; }); },
                         waitUntil(p) { ev.waits.push(p); } };
            handlers.fetch(ev);
            return ev;
        },
    };
}

(async () => {
    console.log('SW policy: cache-first from the versioned bundle, incremental all-or-nothing install');

    // 1. A cached asset is served at once, and the network is not asked at all.
    {
        const sw = boot();
        sw.store(sw.CACHE).set(sw.urlOf('./js/sim.js'), resp('cached'));
        const ev = sw.dispatch(sw.urlOf('./js/sim.js'));
        await tick();
        check(ev.settled && ev.value && ev.value.tag === 'cached', 'a cached asset is served from the bundle at once');
        check(sw.pending.length === 0, 'the network is never asked for a cached asset');
    }

    // 2. A miss: the network is the only answer. A bundle path is put back (evicted storage
    //    heals itself); a URL outside the bundle passes through and is never stored.
    {
        const sw = boot();
        const ev = sw.dispatch(sw.urlOf('./js/sim.js'));
        await tick();
        check(!ev.settled && sw.pending.length === 1 && sw.pending[0].cache === 'no-store', 'an evicted asset waits for the network, HTTP cache bypassed');
        sw.pending[0].resolve(resp('fresh'));
        await tick();
        check(ev.value && ev.value.tag === 'fresh', 'the network answer is served');
        await Promise.all(ev.waits);
        check(sw.store(sw.CACHE).get(sw.urlOf('./js/sim.js')), 'an evicted bundle asset is written back');
        const other = sw.dispatch(sw.urlOf('./docs/API.md'));
        await tick();
        sw.pending.pop().resolve(resp('doc'));
        await tick();
        check(other.value && other.value.tag === 'doc' && !sw.store(sw.CACHE).has(sw.urlOf('./docs/API.md')), 'a URL outside the bundle passes through and is not stored');
    }

    // 3. API/relay traffic is never cached: a stale clock sample or an ancient long-poll
    //    payload served from a cache is worse than no answer.
    {
        const sw = boot();
        const ev = sw.dispatch('https://fok-server.poggensee.it/api/t.txt');
        check(!ev.handled, 'a cross-origin GET is left to the browser');
        const post = sw.dispatch(sw.urlOf('./api/scores.php'), 'POST');
        check(!post.handled, 'a non-GET is left to the browser');
        check(sw.pending.length === 0, 'neither goes through the worker');
    }

    // 4. First install on a device: every asset is fetched, a few at a time, HTTP cache
    //    bypassed, and stored as it lands. The manifest goes in last, then skipWaiting.
    {
        const sw = boot();
        const done = sw.install();
        await tick();
        const n = Object.keys(sw.ASSETS).length;
        check(sw.pending.length > 0 && sw.pending.length < n, 'the precache fans out a bounded burst (' + sw.pending.length + ' of ' + n + ')');
        check(sw.pending.every(d => d.cache === 'no-store'), 'each fetch bypasses the HTTP cache');
        const first = sw.pending.map(d => d.url);
        sw.answerAll(); await tick();
        const s = sw.store(sw.CACHE);
        check(s.size > 0 && s.size < n && !s.has(sw.urlOf('./__bundle.json')) && sw.calls.skipWaiting === 0, 'landed assets are stored at once; no manifest and no activation while fetches are out');
        const urls = first.concat((await sw.drain()).urls);
        check(urls.length === n && new Set(urls).size === n, 'every bundle asset is fetched exactly once (' + n + ')');
        check(await done, 'the install succeeds');
        check(s.size === n + 1 && s.has(sw.urlOf('./__bundle.json')), 'all assets plus the manifest are in the new cache');
        check(JSON.parse(s.get(sw.urlOf('./__bundle.json')).body)['./js/sim.js'] === sw.ASSETS['./js/sim.js'], 'the manifest carries this version\'s blob ids');
        check(sw.calls.skipWaiting === 1, 'skipWaiting only after the bundle is complete');
    }

    // 5. All or nothing: one failed asset rejects the install, nothing is written, the
    //    running version stays (the browser retries at its next update check).
    {
        const sw = boot();
        const done = sw.install();
        await tick();
        await sw.drain(p => p === './js/render.js');
        check(!(await done), 'one failed asset rejects the install');
        check(!sw.stores.has(sw.CACHE) && sw.calls.skipWaiting === 0, 'the half-filled cache is deleted, nothing activated');
    }

    // 6. One deploy only: an assets.js that does not carry this version's APP_VERSION is a
    //    file from the other side of the deploy window; the bundle is refused.
    {
        const sw = boot();
        const done = sw.install();
        await tick();
        const skew = sw.fresh;
        sw.fresh = (p) => p === './js/assets.js' ? resp('skew', "const APP_VERSION = 'v0.0.0';") : skew(p);
        await sw.drain();
        check(!(await done), 'a version-skewed assets.js rejects the install');
        check(!sw.stores.has(sw.CACHE), 'the half-filled cache is deleted');
    }

    // 7. THE POINT: an update downloads only what changed. The previous bundle is on the
    //    device; sim.js has a new blob id (and assets.js always has: the hook stamps the
    //    version into it), everything else is copied across, not fetched.
    {
        const sw = boot();
        sw.seedPrev('snake-v0.0.1', { './js/sim.js': '000000000000', './js/assets.js': '000000000000' });
        const done = sw.install();
        await tick();
        const urls = (await sw.drain()).urls.sort();
        check(urls.length === 2 && urls[0] === sw.urlOf('./js/assets.js') && urls[1] === sw.urlOf('./js/sim.js'), 'only the changed assets are fetched');
        check(await done, 'the incremental install succeeds');
        const s = sw.store(sw.CACHE);
        check(s.get(sw.urlOf('./js/sim.js')).tag === 'fresh:./js/sim.js', 'the changed asset is the fresh one');
        check(s.get(sw.urlOf('./js/game.js')).tag === 'old:./js/game.js', 'an unchanged asset is the copy from the previous bundle');
        check(s.size === Object.keys(sw.ASSETS).length + 1, 'the new bundle is complete');
        check(sw.stores.has('snake-v0.0.1'), 'the previous bundle is still there until activation');
        // 8. Activation drops the previous bundles and claims the pages.
        await sw.activate();
        check(!sw.stores.has('snake-v0.0.1') && sw.stores.has(sw.CACHE), 'activate deletes the previous bundle and keeps this one');
        check(sw.calls.claim === 1, 'and claims the open pages');
    }

    // 9. A new version whose assets.js blob is the previous one cannot be a hook-stamped
    //    commit (the version line differs every commit): the copied file fails the version
    //    check and the bundle is refused, rather than a mislabelled version going live.
    {
        const sw = boot();
        sw.seedPrev('snake-v0.0.1', { './js/sim.js': '000000000000' });
        const done = sw.install();
        await tick();
        await sw.drain();
        check(!(await done), 'an unchanged assets.js under a new version is refused');
        check(!sw.stores.has(sw.CACHE) && sw.stores.has('snake-v0.0.1'), 'the new cache is deleted, the previous bundle untouched');
    }

    // 10. This version already installed whole (a re-run under the same CACHE name): nothing
    //     is fetched, nothing is touched, and the install still completes.
    {
        const sw = boot();
        const s = sw.seedPrev(sw.CACHE);
        const done = sw.install();
        await tick();
        check(sw.pending.length === 0, 'an installed bundle is not fetched again');
        check(await done && sw.calls.skipWaiting === 1, 'and the install completes');
        check(s.get(sw.urlOf('./js/game.js')).tag === 'old:./js/game.js' && sw.stores.has(sw.CACHE), 'the bundle in place is left as it is');
    }

    // 11. A previous cache without a manifest (an install that never finished, an older
    //    worker) is not a bundle: nothing is copied from it, everything is fetched.
    {
        const sw = boot();
        const s = sw.store('snake-v0.0.2');
        s.set(sw.urlOf('./js/game.js'), resp('partial'));
        const done = sw.install();
        await tick();
        const got = await sw.drain();
        check(got.urls.length === Object.keys(sw.ASSETS).length, 'a manifest-less cache is ignored, the whole bundle is fetched');
        check(await done, 'and the install succeeds');
    }

    console.log(fails ? `SW-CACHE FAILED (${fails})` : 'SW-CACHE PASSED');
    process.exit(fails ? 1 : 0);
})();
