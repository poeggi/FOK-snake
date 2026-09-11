// Verify the AUTO-MANAGED sw.js is internally consistent:
//  - the `// version` comment, the CACHE key and assets.js APP_VERSION name the same version
//    (duplicated precisely so a hand-edit or a bypassed hook is caught; the service worker
//    refuses a bundle whose assets.js disagrees with its CACHE, so a slip here would leave
//    every client on the previous version)
//  - ASSETS lists exactly the tracked asset files (no missing, no stale entry), each with
//    the first 12 hex of its blob id (the incremental precache copies an unchanged id
//    from the previous cache; a wrong id would carry a stale file into the new version)
// Run: node test/check-sw.js   (exit 0 = ok, 1 = mismatch)
const { execSync } = require('child_process');
const fs = require('fs');
const ASSET = /\.(js|css|json|svg|woff2|woff|ttf)$/;

const sw = fs.readFileSync('sw.js', 'utf8');
const cache = (sw.match(/const CACHE = '(snake-v[0-9.]+)'/) || [])[1];
const comment = (sw.match(/\/\/ version (snake-v[0-9.]+)/) || [])[1];
if (!cache || !comment) { console.error('sw.js: could not parse CACHE / version comment'); process.exit(1); }
if (cache !== comment) {
    console.error(`sw.js: CACHE (${cache}) != version comment (${comment})`);
    process.exit(1);
}
const app = (fs.readFileSync('js/assets.js', 'utf8').match(/^const APP_VERSION = '([^']*)';/m) || [])[1];
if (app !== cache.replace(/^snake-/, '')) {
    console.error(`js/assets.js: APP_VERSION (${app}) != sw.js CACHE (${cache})`);
    process.exit(1);
}

const table = (sw.match(/const ASSETS = \{([\s\S]*?)\};/) || [])[1] || '';
const listed = new Map([...table.matchAll(/'\.\/([^']*)': '([0-9a-f]{12})'/g)].map(m => [m[1] || 'index.html', m[2]]));
const tracked = new Map(execSync('git ls-files -s', { encoding: 'utf8' })
    .split('\n').filter(Boolean).map(l => { const [meta, f] = l.split('\t'); return [f, meta.split(' ')[1].slice(0, 12)]; })
    .filter(([f]) => f === 'index.html' || (ASSET.test(f) && f !== 'sw.js' && !/^(test\/|\.github\/)/.test(f))));

const missing = [...tracked.keys()].filter(f => !listed.has(f));
const stale = [...listed.keys()].filter(f => !tracked.has(f));
const moved = [...listed].filter(([f, id]) => tracked.has(f) && tracked.get(f) !== id).map(([f]) => f);
if (missing.length || stale.length || moved.length) {
    console.error('sw.js ASSETS out of sync with tracked files.');
    if (missing.length) console.error('  missing from ASSETS: ' + missing.join(', '));
    if (stale.length) console.error('  stale in ASSETS:      ' + stale.join(', '));
    if (moved.length) console.error('  blob id differs:      ' + moved.join(', '));
    process.exit(1);
}
console.log(`sw.js OK (${cache}, ${listed.size} assets)`);
