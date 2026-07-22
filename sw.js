// AUTO-MANAGED: version, CACHE and ASSETS are updated by the pre-commit hook -- do not edit manually
// version snake-v2.4.5, released 2026-07-22 19:23 +0200
const CACHE = 'snake-v2.4.5';
const ASSETS = ['./', './css/fonts.css', './css/style.css', './docs/barricade-fragile.svg', './docs/barricade.svg', './docs/gem-epic.svg', './docs/gem-gouranga.svg', './docs/gem-lucky.svg', './docs/gem.svg', './docs/heart.svg', './docs/power-pellet.svg', './docs/time-crystal.svg', './fonts/PressStart2P-Regular.woff2', './icon.svg', './js/assets.js', './js/audio.js', './js/duel-core.js', './js/game.js', './js/input.js', './js/net.js', './js/qr.js', './js/render.js', './js/screens.js', './js/sim-worker.js', './js/sim.js', './js/storage.js', './js/text.js', './manifest.json'];

self.addEventListener('install', e => {
    // Activate as soon as installed -- do NOT gate this on the precache. addAll() rejects
    // atomically if ANY asset fetch fails (a CDN hiccup during the deploy window is enough),
    // and that used to abort the whole install: skipWaiting never ran, the new worker never
    // activated, and the page stayed on the old version until a lucky retry -- the "had to
    // reload several times" symptom. Precache best-effort instead (allSettled tolerates a
    // miss); the network-first fetch handler backfills anything skipped on first use.
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(ASSETS.map(a => c.add(a)))));
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Network-first: serve fresh when online, cached version when offline
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        fetch(e.request.clone(), { cache: 'no-store' })   // bypass the browser HTTP cache: GitHub Pages sets max-age=600, which otherwise serves stale JS for ~10 min after a push even when online
            .then(res => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE).then(c => c.put(e.request, copy));
                }
                return res;
            })
            .catch(() => caches.match(e.request))
    );
});
