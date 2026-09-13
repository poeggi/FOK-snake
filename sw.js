// AUTO-MANAGED: version, CACHE and ASSETS are updated by the pre-commit hook -- do not edit manually
// version snake-v4.4.51, released 2026-09-13 10:01 +0200
const CACHE = 'snake-v4.4.51';
const ASSETS = {'./': '6c697d5a5924', './css/fonts.css': '1b96ff9d0895', './css/style.css': 'cad94759fb96', './docs/barricade-fragile.svg': 'daae9e47b6e1', './docs/barricade.svg': 'b7b8b6ee6e04', './docs/gem-epic.svg': 'f92ed6b94963', './docs/gem-gouranga.svg': '36df1893198a', './docs/gem-lucky.svg': 'b4072f7a10a9', './docs/gem.svg': 'b7577f814b55', './docs/heart.svg': '7ef1bc16acde', './docs/power-pellet.svg': '734a331dd3b7', './docs/time-crystal.svg': '24f2ac8c76c7', './fonts/PressStart2P-Regular.woff2': '947a9792df96', './icon.svg': '62446247c96b', './js/assets.js': 'ba9748e02ed4', './js/audio.js': '1c1cdfebad2b', './js/duel-core.js': '2044dc691032', './js/events.js': '274233e35087', './js/game.js': 'f74ca76b4571', './js/hmac.js': '11b484d9ba32', './js/input.js': '58bd71705c4d', './js/items.js': '413deee41908', './js/net-api.js': 'dce95e195d11', './js/net-relay.js': 'afd2dc746e6e', './js/net-rtc.js': 'ba8c4f4cbbf7', './js/net-session.js': 'c8a460fc669c', './js/net-spec.js': '8db1ea3cefc6', './js/qr.js': '23f34cd594a7', './js/render.js': '27c8e88b62cf', './js/screens.js': '221f632266f1', './js/sim-worker.js': 'd458b3956e04', './js/sim.js': '5d78ce1601a6', './js/storage.js': 'e422cedf6ae9', './js/sw-update.js': '8d8fb52619d8', './js/text.js': 'a9f7ac447b99', './js/tourney.js': 'c46977d1cfe2', './manifest.json': '57520bb0d337'};

// The bundle above IS the app. Every asset is served from this version's cache, at once, on
// any link; the network never answers a running version's request. It only ever delivers
// the NEXT version: the browser's update check on this file finds a new CACHE name, the
// install below brings that bundle in, and the page reloads on the splash once it is live.
// Never a per-request network race: the sim worker's five serial script loads would each
// pay the wait, and the 3 s first-frame watchdog would kill a healthy worker on a slow link.

const MANIFEST = './__bundle.json';   // cache-only key: this version's path -> blob id table

// Every network fetch bypasses the HTTP cache: GitHub Pages sets max-age=600, and a copy
// that old would be the previous deploy's file filed under this version's name.
function _fresh(url) { return new Request(url, { cache: 'no-store' }); }
function _key(url) { return new Request(url); }
const _MATCH = { ignoreVary: true };   // our own keys on both sides; Vary has nothing to say

// The previous bundles on this device: every other snake-* cache that carries a manifest.
// An asset whose blob id has not changed is copied from there instead of fetched, so an
// update costs only the files that really differ.
async function _prevBundles() {
    const names = (await caches.keys()).filter(k => k !== CACHE && k.indexOf('snake-') === 0);
    const out = [];
    for (const name of names) {
        const cache = await caches.open(name);
        const m = await cache.match(_key(MANIFEST), _MATCH);
        if (!m) continue;
        try { out.push({ cache, ids: await m.json() }); } catch (e) {}
    }
    return out;
}
async function _reuse(prev, path) {
    for (const b of prev) {
        if (b.ids[path] !== ASSETS[path]) continue;
        const r = await b.cache.match(_key(path), _MATCH);
        if (r) return r;
    }
    return null;
}

// Precache: all or nothing. Every asset goes into this version's cache as it lands (the
// Cache API's put reads the body at once: a burst of responses left unread wedges the fetch
// pool of an installing worker in Chromium) and the MANIFEST goes in last, as the mark of a
// complete bundle. One failed asset, or an assets.js that does not carry the APP_VERSION the
// hook stamped beside this file's CACHE (a file from the other side of the deploy window),
// throws: the half-filled cache is deleted, the install fails, the browser keeps the running
// version and retries at its next update check. A best-effort precache cannot be right
// here: the cache is the only source, so a hole would sit for the whole version. A cache
// without the manifest is never read as a bundle, so a worker killed mid-install leaves
// nothing a later install could mistake for one.
const PRECACHE_PAR = 6;   // fetches in flight at once
async function _pool(items, fn) {
    let i = 0, stop = false;
    await Promise.all(Array.from({ length: Math.min(PRECACHE_PAR, items.length) }, async () => {
        while (i < items.length && !stop) {
            const k = i++;
            try { await fn(items[k]); } catch (err) { stop = true; throw err; }
        }
    }));
}
async function _precache() {
    const paths = Object.keys(ASSETS);
    const want = "APP_VERSION = '" + CACHE.replace(/^snake-/, '') + "'";
    const c = await caches.open(CACHE);
    // A manifest already here is this version installed whole: a re-run (a worker restarted
    // mid-install, a sw.js that changed under the same CACHE name) has nothing to do, and must
    // not touch a cache a page may be running from.
    if (await c.match(_key(MANIFEST), _MATCH)) return;
    try {
        const prev = await _prevBundles();
        await _pool(paths, async p => {
            let res = await _reuse(prev, p);
            if (!res) {
                res = await fetch(_fresh(p));
                if (!res.ok) throw new Error('precache ' + p + ': ' + res.status);
            }
            if (p === './js/assets.js' && (await res.clone().text()).indexOf(want) < 0) throw new Error('precache: assets.js is not ' + CACHE);
            await c.put(_key(p), res);
        });
        await c.put(_key(MANIFEST), new Response(JSON.stringify(ASSETS), { headers: { 'Content-Type': 'application/json' } }));
    } catch (err) {
        await caches.delete(CACHE);
        throw err;
    }
}

self.addEventListener('install', e => {
    e.waitUntil(_precache().then(() => self.skipWaiting()));
});

// The new bundle is complete by now (install succeeded), so the old ones can go.
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Same-origin app assets only. API/relay traffic is left to the browser's own fetch: a
// stale clock sample or an ancient long-poll payload from a cache is worse than no answer.
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    if (new URL(e.request.url).origin !== self.location.origin) return;
    e.respondWith(caches.open(CACHE).then(c => c.match(e.request, _MATCH)).then(hit => hit || _miss(e)));
});
// The bundle's URLs, absolute, so a miss can tell "evicted" from "not ours".
const _bundled = new Set(Object.keys(ASSETS).map(p => _key(p).url));
// Nothing cached for a same-origin GET: a URL outside the bundle, or a bundle the browser
// evicted. The network is the only possible answer. An evicted asset is put back so the
// next start has it again; anything else passes through untouched.
function _miss(e) {
    return fetch(e.request.clone(), { cache: 'no-store' }).then(res => {
        if (res.ok && _bundled.has(e.request.url)) {
            const copy = res.clone();
            const put = caches.open(CACHE).then(c => c.put(e.request, copy));
            try { e.waitUntil(put); } catch (err) {}   // an engine that refuses a late waitUntil still gets the response
        }
        return res;
    });
}
