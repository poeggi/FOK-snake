// AUTO-MANAGED: version, CACHE and ASSETS are updated by the pre-commit hook -- do not edit manually
// version snake-v1.3.5, released 2026-07-12 22:42 +0200
const CACHE = 'snake-v1.3.5';
const ASSETS = ['./', './css/fonts.css', './css/style.css', './docs/barricade-fragile.svg', './docs/barricade.svg', './docs/gem-epic.svg', './docs/gem-gouranga.svg', './docs/gem-lucky.svg', './docs/gem.svg', './docs/heart.svg', './docs/power-pellet.svg', './fonts/PressStart2P-Regular.woff2', './icon.svg', './js/assets.js', './js/audio.js', './js/game.js', './manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE)
            .then(c => c.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
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
        fetch(e.request.clone())
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
