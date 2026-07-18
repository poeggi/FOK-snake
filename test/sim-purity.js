// Headless-purity + determinism guard: sim.js must stay free of DOM, canvas, audio and
// I/O (so a server can run it without a browser) AND free of every API whose result can
// differ between platforms, JS engines or runs -- a lockstep peer or replay validator
// must reproduce a game bit-identically from (seed + inputs). Run: node test/sim-purity.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'sim.js'), 'utf8');

const FORBIDDEN = [
    // presentation / IO
    /\bSnd\b/, /\bdocument\b/, /\bwindow\b/, /\blocalStorage\b/, /\bcaches\b/,
    /\bcanvas\b/, /\bctx\b/, /\bgetElementById\b/, /\brequestAnimationFrame\b/,
    /\bshowHUD\b/, /\bupdateHUD\b/, /\brenderBarsOffscreen\b/, /\bdrawGameBoard\b/,
    /\baddFOKoins\b/, /\bunlockAch\b/, /\bshowBonus\b/, /\bspawnFireworks\b/,
    /function\s+draw/,
    // nondeterminism: transcendentals are implementation-approximated (results differ
    // between engines/CPUs); wall clocks, timers, locale and Intl differ by environment.
    // Integer ops, +-*/, floor/min/max/abs/imul and IEEE754 comparisons are bit-exact.
    /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|sqrt|cbrt|pow|exp|expm1|log|log2|log10|log1p|hypot)\b/,
    /\bDate\b/, /\bperformance\b/, /\bsetTimeout\b/, /\bsetInterval\b/,
    /\.sort\(/, /toLocale/, /\bIntl\b/, /\bnavigator\b/, /\bscreen\b/,
];
const bad = [];
src.split(/\r?\n/).forEach((raw, i) => {
    const ln = raw.replace(/\/\/.*$/, '');         // ignore comments (full-line and trailing)
    if (!ln.trim()) return;
    // Math.random is allowed in exactly one place: the DEFAULT seed roll in startGame
    // (entropy for a fresh gameSeed, which is then recorded -- replays pass the seed in).
    if (/Math\.random/.test(ln) && !/gameSeed/.test(ln)) { bad.push(`${i + 1}: ${raw.trim().slice(0, 72)}`); return; }
    for (const re of FORBIDDEN) if (re.test(ln)) { bad.push(`${i + 1}: ${raw.trim().slice(0, 72)}`); break; }
});
if (bad.length) {
    console.error('sim.js is not headless/deterministic-clean:\n' + bad.join('\n'));
    process.exit(1);
}
console.log(`sim.js headless + deterministic (${src.split(/\r?\n/).length} lines: no DOM/audio/IO, no engine-varying math, no clocks/locale/sort)`);
