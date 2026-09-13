// The update check, first thing on the page: register the worker and ask the browser to
// look for a new sw.js NOW. A controlled page boots from its bundle and touches no
// network, so the sooner this leaves the sooner a deploy is on screen -- every script
// behind this one would otherwise be parsed first (index.html preconnects the origin
// meanwhile). An uncontrolled first visit is still downloading: registering then would
// set the precache against the page's own boot, so it waits for load. game.js takes the
// registration from _swReg for the periodic checks and owns the reload.
let _swReg = null;
if ('serviceWorker' in navigator) {
    const go = () => navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
        .then(reg => { if (reg && navigator.onLine) reg.update().catch(() => {}); return reg; });
    if (navigator.serviceWorker.controller) _swReg = go();
    else _swReg = new Promise(res => window.addEventListener('load', () => res(go())));
}
