// Fail if a SHIPPED source uses a language or platform feature newer than the browser
// floor this game targets. Run: node test/check-compat.js  (exit 0 = clean, 1 = offenders)
//
// The floor is Chrome 55 / Safari 11 / Firefox 52, set by async/await -- which the netcode
// and storage layers are built on and which no amount of care can avoid without a build
// step. There is none: index.html loads the raw sources, so a single unsupported TOKEN is
// a parse error that takes a whole file down (a spread in qr.js means no QR screen at all),
// while an unsupported CALL only fails at its own call site. Both are silent in a way that
// never reaches a developer's machine, which is why they get a test instead of a habit.
//
// Everything below is above the floor and has a plain ES5/ES2017 equivalent that costs
// nothing: Object.assign for object spread, a .catch per promise for allSettled, ('0'+n)
// for padStart. Genuinely modern APIs are not banned -- they are feature-detected at the
// call site (Wake Lock, ResizeObserver, ctx.filter, navigator.share, webkitAudioContext,
// PointerEvent), which is the pattern to follow for anything new.
//
// CSS has one rule this cannot see: `gap` on a FLEX container is Chrome 84 and degrades
// silently. css/style.css carries a .no-flexgap margin fallback, tagged by game.js after a
// live measurement -- a new flex gap needs a line there too.
//
// Escape hatch: end the line with a comment containing "compat-ok" plus the reason it is
// safe (a declaration whose loss is cosmetic, a guarded call site).
const { execSync } = require('child_process');
const fs = require('fs');

// Shipped files only. test/ runs on node, which is not a target.
const SHIPPED = /^(index\.html|sw\.js|js\/[^/]+\.js|css\/[^/]+\.css)$/;

const JS_BANNED = [
    [/\?\.\s*[A-Za-z_$([]/,              'optional chaining ?.',        'Chrome 80'],
    [/\?\?/,                             'nullish coalescing ??',       'Chrome 80'],
    [/(\|\||&&|\?\?)=[^=]/,              'logical assignment ||= &&= ??=', 'Chrome 85'],
    [/\{\s*\.\.\./,                      'object spread { ... }',       'Chrome 60'],
    [/\.at\s*\(/,                        'Array/String .at()',          'Chrome 92'],
    [/\.flat(Map)?\s*\(/,                'Array.flat / .flatMap',       'Chrome 69'],
    [/\.replaceAll\s*\(/,                'String.replaceAll',           'Chrome 85'],
    [/\.matchAll\s*\(/,                  'String.matchAll',             'Chrome 73'],
    [/\.(padStart|padEnd|trimStart|trimEnd)\s*\(/, 'String pad/trim helpers', 'Chrome 57'],
    [/\bstructuredClone\s*\(/,           'structuredClone',             'Chrome 98'],
    [/\bglobalThis\b/,                   'globalThis',                  'Chrome 71'],
    [/\bPromise\.(allSettled|any)\b/,    'Promise.allSettled / .any',   'Chrome 76'],
    [/\bObject\.fromEntries\s*\(/,       'Object.fromEntries',          'Chrome 73'],
    [/\bBigInt\b|\b\d+n\b/,              'BigInt',                      'Chrome 67'],
];
const CSS_BANNED = [
    [/\bclamp\s*\(/,                     'CSS clamp()',                 'Chrome 79'],
    [/(^|[^-\w])(min|max)\s*\(/,         'CSS min() / max()',           'Chrome 79'],
];
const HTML_BANNED = [
    [/type\s*=\s*["']module["']/,        'ES module script',            'Chrome 61'],
];

// Blank out comments and string literals so a pattern cannot match inside one -- the name
// placeholder '???' would otherwise read as a nullish operator. Newlines are kept so the
// reported line numbers stay true.
function strip(src, lineComments) {
    const blank = s => s.replace(/[^\n]/g, ' ');
    let out = '', i = 0;
    while (i < src.length) {
        const c = src[i], d = src[i + 1];
        if (lineComments && c === '/' && d === '/') { const j = src.indexOf('\n', i); const e = j < 0 ? src.length : j; out += blank(src.slice(i, e)); i = e; continue; }
        if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const e = j < 0 ? src.length : j + 2; out += blank(src.slice(i, e)); i = e; continue; }
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
            out += blank(src.slice(i, j + 1)); i = j + 1; continue;
        }
        out += c; i++;
    }
    return out;
}

const files = execSync('git ls-files', { encoding: 'utf8' })
    .split('\n').map(f => f.trim()).filter(f => SHIPPED.test(f));
const bad = [];
for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const css = /\.css$/.test(f), html = /\.html$/.test(f);
    const rules = css ? CSS_BANNED : html ? HTML_BANNED : JS_BANNED;
    const lines = strip(raw, !css).split('\n');
    const rawLines = raw.split('\n');
    lines.forEach((ln, i) => {
        if (/compat-ok/.test(rawLines[i])) return;
        for (const [re, what, since] of rules) if (re.test(ln)) bad.push(`${f}:${i + 1}  ${what}  (${since}, above the floor)`);
    });
}
if (bad.length) {
    console.error('Above the supported browser floor (Chrome 55 / Safari 11 / Firefox 52):\n' + bad.join('\n')
        + '\nUse the ES5/ES2017 equivalent, feature-detect the call site, or mark the line compat-ok with a reason.');
    process.exit(1);
}
console.log(`compat floor OK (${files.length} shipped files)`);
