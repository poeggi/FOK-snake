// The live harnesses' identity tokens (API 4.20). A live-test id is bound on the server
// from its first hello onwards, and every later request has to carry the token that
// hello minted -- so the token lives OUTSIDE the repo, per environment, in the file the
// server's own live harness keeps its cast in (one line per pair, no parser needed there):
//
//   ~/.fok-server-livetest.tok         <base-url> <id> <tok>      (FOK_LIVETEST_TOK overrides the path)
//
// Used two ways: required from a node harness (tokOf / adopt), or run from a shell one:
//
//   node test/live-tok.js get <base-url> <id>          prints the token, or nothing
//   node test/live-tok.js set <base-url> <id> <tok>    stores it
//
// A first run against a fresh environment finds nothing here, sends tok: null, and stores
// what hello answers. Never generate ids or tokens here: the ids are the fixed cast
// (test/peer-net.sh, items-live.js, hello-live.js), the token is the server's to mint.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = process.env.FOK_LIVETEST_TOK || path.join(os.homedir(), '.fok-server-livetest.tok');
const TOK_RE = /^[0-9a-f]{16,64}$/i;

function lines() {
    try { return fs.readFileSync(FILE, 'utf8').split('\n').filter(l => l.trim()); } catch (e) { return []; }
}
function tokOf(base, id) {
    for (const l of lines()) {
        const [b, i, t] = l.trim().split(/\s+/);
        if (b === base && i === id) return TOK_RE.test(t || '') ? t : null;
    }
    return null;
}
function adopt(base, id, tok) {
    if (typeof tok !== 'string' || !TOK_RE.test(tok)) return false;
    if (tokOf(base, id) === tok) return true;
    const kept = lines().filter(l => { const [b, i] = l.trim().split(/\s+/); return !(b === base && i === id); });
    kept.push(base + ' ' + id + ' ' + tok);
    fs.writeFileSync(FILE, kept.join('\n') + '\n');
    return true;
}

module.exports = { tokOf, adopt, FILE };

if (require.main === module) {
    const [cmd, base, id, tok] = process.argv.slice(2);
    if (cmd === 'get' && base && id) { const t = tokOf(base, id); if (t) process.stdout.write(t); }
    else if (cmd === 'set' && base && id && tok) { if (!adopt(base, id, tok)) { console.error('not a token: ' + tok); process.exit(1); } }
    else { console.error('usage: node test/live-tok.js get <base-url> <id> | set <base-url> <id> <tok>'); process.exit(2); }
}
