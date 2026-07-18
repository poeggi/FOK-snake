// Guard: main-thread files must never WRITE worker-owned (snapshot-mirrored) sim state.
// Such writes are futile -- the next worker snapshot silently clobbers them (the class of
// bug behind the background-pause and level-skip regressions). Route all sim changes
// through _wsend() commands instead. 'phase' is exempt: main owns it in menus by design
// (see the SIM WORKER section in game.js).
const fs = require('fs'), path = require('path');
const J = f => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');

const snap = (J('sim.js').match(/function simSnapshot\(\)\{[\s\S]*?\n\}/) || [''])[0];
const fields = (snap.match(/return \{([\s\S]*?)\};/) || ['', ''])[1]
    .split(/[,\n]/).map(s => s.trim()).filter(s => /^[A-Za-z_$][\w$]*$/.test(s));
if (fields.length < 40) { console.error(`only ${fields.length} snapshot fields parsed -- check-ownership.js parser broken?`); process.exit(1); }

const SHARED = new Set(['phase']);   // main sets phase for menu navigation by design
const violations = [];
for (const file of ['storage.js', 'game.js', 'text.js', 'qr.js', 'render.js', 'screens.js', 'input.js', 'net.js']) {
    J(file).split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');   // ignore line comments
        for (const v of fields) {
            if (SHARED.has(v)) continue;
            const re = new RegExp('(?<![.\\w$])' + v +
                '\\s*(=(?![=>])|\\+\\+|--|[+\\-*/%&|^]=|\\.(push|pop|shift|unshift|splice)\\()');
            if (re.test(code)) violations.push(`${file}:${i + 1}  [${v}]  ${line.trim()}`);
        }
    });
}
if (violations.length) {
    console.error('MAIN-THREAD WRITES TO WORKER-OWNED SIM STATE (use a _wsend command instead):\n  ' + violations.join('\n  '));
    process.exit(1);
}
console.log(`ownership clean: ${fields.length - SHARED.size} worker-owned vars, zero main-thread writes (game/render/input)`);
