// AUTO-MANAGED: version, CACHE and ASSETS are updated by the pre-commit hook -- do not edit manually
// version snake-v3.3.4, released 2026-09-04 19:25 +0200
const CACHE = 'snake-v3.3.4';
const ASSETS = ['./', './css/fonts.css', './css/style.css', './docs/barricade-fragile.svg', './docs/barricade.svg', './docs/gem-epic.svg', './docs/gem-gouranga.svg', './docs/gem-lucky.svg', './docs/gem.svg', './docs/heart.svg', './docs/power-pellet.svg', './docs/time-crystal.svg', './fonts/PressStart2P-Regular.woff2', './icon.svg', './js/assets.js', './js/audio.js', './js/duel-core.js', './js/game.js', './js/hmac.js', './js/input.js', './js/items.js', './js/net-api.js', './js/net-relay.js', './js/net-rtc.js', './js/net-session.js', './js/net-spec.js', './js/qr.js', './js/render.js', './js/screens.js', './js/sim-worker.js', './js/sim.js', './js/storage.js', './js/text.js', './js/tourney.js', './manifest.json'];

self.addEventListener('install', e => {
    // Activate as soon as installed -- do NOT gate this on the precache. addAll() rejects
    // atomically if ANY asset fetch fails (a CDN hiccup during the deploy window is enough),
    // and that used to abort the whole install: skipWaiting never ran, the new worker never
    // activated, and the page stayed on the old version until a lucky retry -- the "had to
    // reload several times" symptom. Precache best-effort instead -- a per-asset .catch, NOT
    // Promise.allSettled: allSettled is Chrome 76 / Safari 13, and an engine without it throws
    // right here, inside install, which is the very failure this block exists to prevent.
    // The network-first fetch handler backfills anything skipped on first use.
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE).then(c => Promise.all(ASSETS.map(a => c.add(a).catch(() => {})))));
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// How long a request may spend on the network before the cached copy wins. Network-first
// alone is a trap on a crawling uplink: the .catch() below only fires on a hard failure,
// never on slowness, so every boot asset sat out its full request while a perfectly good
// copy waited in the cache -- a start that takes minutes on a bad connection. Racing the
// fetch against a short timer keeps "fresh when we can" without ever paying more than this
// for it. The request is NOT aborted when the timer wins: it keeps running in the
// background and still refreshes the cache, so the next start is both fast and current.
const NET_TIMEOUT_MS = 2000;

// Network-first with a timeout: serve fresh when the network is quick, cached when it is
// slow or gone. Same-origin app assets only -- API/relay traffic must never be answered
// from a cache (a stale clock sample or an ancient long-poll payload is worse than no
// answer at all), so those are left to the browser's own fetch.
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    if (new URL(e.request.url).origin !== self.location.origin) return;

    const net = fetch(e.request.clone(), { cache: 'no-store' })   // bypass the browser HTTP cache: GitHub Pages sets max-age=600, which otherwise serves stale JS for ~10 min after a push even when online
        .then(res => {
            if (res.ok) {
                const copy = res.clone();
                caches.open(CACHE).then(c => c.put(e.request, copy));
            }
            return res;
        });
    const settled = net.catch(() => null);
    e.waitUntil(settled);   // the background refresh outlives the response we hand back

    e.respondWith(caches.match(e.request).then(hit => {
        if (!hit) return net;   // nothing cached: the network is the only possible answer, wait for it
        return new Promise(resolve => {
            const t = setTimeout(() => resolve(hit), NET_TIMEOUT_MS);
            settled.then(res => { clearTimeout(t); resolve(res || hit); });
        });
    }));
});
