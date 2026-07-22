// Guard: every top-level sim.js state var must be mirrored by simSnapshot() AND simApply().
// A field forgotten in either means the worker plays correctly while the main thread
// renders stale state -- a silent desync that no other test can see. If a new var
// legitimately must NOT be mirrored, add it to EXCLUDE with a reason.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'sim.js'), 'utf8');

const EXCLUDE = new Set([
    'gameSeed',   // static per game; _rngState DOES travel now: the online peer's prediction must roll the host's dice
    'simEvents',               // events travel next to the snapshot, not inside it
    '_armSlots',               // boost arming is DEVICE-local input authorship: mirroring (or hashing) it would leak one device's keys into the shared state
    '_nmWasAdjacent',          // near-miss edge tracker: presentation-only, re-derived each duel tick, never hashed
]);

const vars = [];
for (const line of src.match(/^let [^\n]*;/gm) || []) {
    for (const part of line.replace(/^let /, '').replace(/;.*$/, '').split(',')) {
        const name = part.trim().split('=')[0].trim();
        if (name) vars.push(name);
    }
}
if (vars.length < 40) { console.error(`only ${vars.length} sim state vars parsed -- check-snapshot.js parser broken?`); process.exit(1); }

const fn = name => (src.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}')) || [''])[0];
const snap = fn('simSnapshot'), apply = fn('simApply');
if (!snap || !apply) { console.error('simSnapshot/simApply not found in sim.js'); process.exit(1); }

const missing = [];
for (const v of vars) {
    if (EXCLUDE.has(v)) continue;
    if (!new RegExp('\\b' + v + '\\b').test(snap))  missing.push(v + ' missing in simSnapshot()');
    if (!new RegExp('\\b' + v + '\\b').test(apply)) missing.push(v + ' missing in simApply()');
}
if (missing.length) {
    console.error('SIM STATE NOT MIRRORED (worker would desync from the renderer):\n  ' + missing.join('\n  '));
    process.exit(1);
}
console.log(`snapshot covers all ${vars.length - EXCLUDE.size} sim state vars (+${EXCLUDE.size} excluded by design)`);
