// Bump this string with every deployment to force cache refresh on all clients
<<<<<<< HEAD
// version snake-v1.93, released 2026-06-25 13:31 +0200
const CACHE = 'snake-v1.93';
=======
// version snake-v1.93, released 2026-06-25 13:31 +0200
const CACHE = 'snake-v1.93';
>>>>>>> 7663bd6b95398b707ea8207e9a0e2de50ec931c2
const ASSETS = ['./', './manifest.json', './icon.svg', './fonts/PressStart2P-Regular.woff2', './style.css', './assets.js', './audio.js', './game.js'];

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
