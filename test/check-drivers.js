// Fail if a suite DRIVER BODY -- source inserted into a JS template literal before
// being evaluated -- contains something the insertion eats.
// Run: node test/check-drivers.js   (exit 0 = clean, 1 = offenders listed)
//
// See .claude/rules/feedback_fok_driver_template_literal.md. Two things do not
// survive insertion, and they fail very differently:
//
//   A BACKTICK ends the literal early. That is loud -- a SyntaxError naming a
//   word from the middle of a comment -- so it costs minutes rather than hours.
//
//   A BACKSLASH ESCAPE is eaten. `\d` arrives as a literal `d` and matches the
//   letter; `poll\.php` arrives as `poll.php` and matches any character. Neither
//   is a syntax error, so the suite runs, asserts against something it never
//   meant, and PASSES. That is the expensive one, and it is the reason this
//   checker exists at all: nothing else in the tier can see it.
//
// Both are checked against the same rule -- write `[0-9]` for a digit class,
// `[.]` for a literal dot, and quotes rather than backticks.
const { execSync } = require('child_process');
const fs = require('fs');

const BT = String.fromCharCode(96);
const BS = String.fromCharCode(92);
// The escapes a template literal passes through unchanged. Anything else in a
// driver body is being eaten on the way in.
const KEPT = new Set([BT, BS, '$', 'n', 't', 'r', '0', 'u', 'x', "'", '"']);

// Every suite, but never this file: the pattern below is written out here as
// source, so the scanner would match its own definition and report the regex it
// scans with.
const SELF = 'check-drivers.js';
const files = execSync('git ls-files test', { encoding: 'utf8' })
    .split('\n').filter(f => f && /\.js$/.test(f) && f.indexOf(SELF) < 0);
const bad = [];

for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // A driver body is a template literal opened on a line that hands it to the
    // harness -- runTest('NAME', ` / const DRIVER = ` / runInGame(` -- and closed
    // by the first unescaped backtick after it.
    const open = /(?:runTest\([^,]*,\s*|runInGame\(\s*|(?:const|let|var)\s+\w*DRIVER\w*\s*=\s*)`/g;
    let m;
    while ((m = open.exec(src)) !== null) {
        const from = open.lastIndex;
        let i = from, close = -1;
        while (i < src.length) {
            if (src[i] === BS) { i += 2; continue; }
            if (src[i] === BT) { close = i; break; }
            i++;
        }
        const body = src.slice(from, close < 0 ? src.length : close);
        const lineAt = (idx) => src.slice(0, from + idx).split('\n').length;
        if (close < 0) bad.push(f + ':' + lineAt(0) + '  driver body is never closed');
        for (let k = 0; k < body.length; k++) {
            if (body[k] !== BS) continue;
            const nxt = body[k + 1];
            if (!KEPT.has(nxt)) {
                bad.push(f + ':' + lineAt(k) + '  ' + BS + nxt +
                         ' is eaten by the template literal (use a character class)');
            }
            k++;   // the pair is judged once
        }
        open.lastIndex = close < 0 ? src.length : close + 1;
    }
}

if (bad.length) {
    console.error('Driver bodies that do not survive insertion:\n' + bad.join('\n'));
    process.exit(1);
}
console.log('driver bodies OK (' + files.length + ' suites scanned)');
