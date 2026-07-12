// Verify the AUTO-MANAGED sw.js is internally consistent:
//  - the `// version` comment and the CACHE key name the same version
//    (they are duplicated precisely so a hand-edit or a bypassed hook is caught)
//  - ASSETS lists exactly the tracked asset files (no missing, no stale entry)
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

const assetsLine = (sw.match(/const ASSETS = \[([\s\S]*?)\];/) || [])[1] || '';
const listed = [...assetsLine.matchAll(/'\.\/([^']*)'/g)]
    .map(m => m[1]).filter(p => ASSET.test(p)).sort();
const tracked = execSync('git ls-files', { encoding: 'utf8' })
    .split('\n').filter(f => ASSET.test(f) && f !== 'sw.js' && !/^(test\/|\.github\/)/.test(f)).sort();

const setL = new Set(listed), setT = new Set(tracked);
const missing = tracked.filter(f => !setL.has(f));
const stale = listed.filter(f => !setT.has(f));
if (missing.length || stale.length) {
    console.error('sw.js ASSETS out of sync with tracked files.');
    if (missing.length) console.error('  missing from ASSETS: ' + missing.join(', '));
    if (stale.length) console.error('  stale in ASSETS:      ' + stale.join(', '));
    process.exit(1);
}
console.log(`sw.js OK (${cache}, ${listed.length} assets)`);
