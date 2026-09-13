// Screen furniture sits on the rows css/style.css declares (--ui-*), read once into the UI
// object (js/assets.js) and drawn by one painter per row (js/screens.js: drawTitle,
// drawDialogTitle, drawOverlayTitle, menuItem, drawStatus). A row written as a number is
// how two screens drift apart by a few pixels and stay that way; this refuses it in the
// draw modules. Run: node test/check-layout.js
//
// Two rules over every ct()/ctg()/menuItem() call:
//  1. A FONT.TITLE draw outside the three painters may not sit on a numbered row: a bare
//     integer y, the raw dialog/overlay rows (CH/2-84, CH/2-18) or a title-row constant
//     used directly. Content that happens to be title-sized (a code, a name) marks its
//     line layout-ok with a reason.
//  2. Centred text (x = CW/2) never names a scale row as a number: 24, 50, 72, 90, 116,
//     182, 324, 348, 370, 382, 390 are TITLE_Y, SUBHEAD_Y, BODY_Y, MENU_TOP, DLG_TITLE_Y,
//     OVL_TITLE_Y, STATUS_Y, BACK_Y, BAND_Y, CORNER_Y, HINT_Y.
const fs = require('fs'), path = require('path');
const JS = path.join(__dirname, '..', 'js');
const FILES = ['screens.js', 'tourney.js', 'events.js', 'render.js', 'input.js', 'game.js'];
const PAINTERS = /^function draw(Title|DialogTitle|OverlayTitle|Subhead)\(/;
const ROWS = /\b(24|50|72|90|116|182|324|348|370|382|390)\b/;
const bad = [];
for (const f of FILES) {
    const lines = fs.readFileSync(path.join(JS, f), 'utf8').split('\n');
    lines.forEach((ln, i) => {
        if (/layout-ok/.test(ln) || PAINTERS.test(ln)) return;
        const code = ln.replace(/\/\/.*$/, '');
        if (!/\b(ct|ctg|menuItem)\(/.test(code)) return;
        const where = f + ':' + (i + 1);
        if (/FONT\.TITLE/.test(code)) {
            if (/,\s*\d+\s*,/.test(code)) bad.push(where + '  a FONT.TITLE draw on a numbered row: use drawTitle / drawDialogTitle / drawOverlayTitle');
            else if (/,\s*CH\s*\/\s*2\s*-\s*(84|18)\s*,/.test(code)) bad.push(where + '  a raw dialog/overlay title row: use drawDialogTitle / drawOverlayTitle');
            else if (/\b(TITLE_Y|DLG_TITLE_Y|OVL_TITLE_Y)\b/.test(code)) bad.push(where + '  a title row drawn at directly: the painter is the API, not the constant');
        }
        const m = code.match(/CW\s*\/\s*2\s*,\s*(\d+)\s*,/);
        if (m && ROWS.test(m[1])) bad.push(where + '  centred text on scale row ' + m[1] + ': use its constant');
    });
}
if (bad.length) {
    console.error('Screen furniture off the shared rows (css/style.css --ui-*, one painter per row):\n' + bad.join('\n')
        + '\nDraw through the row\'s painter or constant, or mark the line layout-ok with a reason.');
    process.exit(1);
}
console.log('layout rows OK (' + FILES.length + ' draw modules)');
