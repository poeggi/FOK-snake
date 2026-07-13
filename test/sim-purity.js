// Headless-purity guard: sim.js must stay free of DOM, canvas, audio and I/O so a
// server can run the simulation without a browser. Fails if any presentation or
// persistence reference creeps back in. Run: node test/sim-purity.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'sim.js'), 'utf8');

const FORBIDDEN = [
    /\bSnd\b/, /\bdocument\b/, /\bwindow\b/, /\blocalStorage\b/, /\bcaches\b/,
    /\bcanvas\b/, /\bctx\b/, /\bgetElementById\b/, /\brequestAnimationFrame\b/,
    /\bshowHUD\b/, /\bupdateHUD\b/, /\brenderBarsOffscreen\b/, /\bdrawGameBoard\b/,
    /\baddFOKoins\b/, /\bunlockAch\b/, /\bshowBonus\b/, /\bspawnFireworks\b/,
    /function\s+draw/,
];
const bad = [];
src.split(/\r?\n/).forEach((ln, i) => {
    if (/^\s*\/\//.test(ln)) return;               // skip comment lines
    for (const re of FORBIDDEN) if (re.test(ln)) { bad.push(`${i + 1}: ${ln.trim().slice(0, 72)}`); break; }
});
if (bad.length) {
    console.error('sim.js is not headless-clean -- presentation/IO references found:\n' + bad.join('\n'));
    process.exit(1);
}
console.log(`sim.js headless-clean (${src.split(/\r?\n/).length} lines, no DOM/audio/IO)`);
