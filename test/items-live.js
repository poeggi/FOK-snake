// Live contract test for the API 4.0 item registry, against the REAL server.
//
// The offline suites prove the CLIENT half (js/items.js, duel-core's attestation)
// against a stubbed transport. This one proves the other half: that the deployed
// server speaks the contract the client was built against -- the four actions, the
// one-time seed, the direction rule, and above all the attestation tag, which is
// the single place where a client/server disagreement would be silent (a wrong MAC
// reads as tampering, not as a bug).
//
//   node test/items-live.js [base-url]
//
// It uses the project's fixed live-test ids so repeated runs stay idempotent and
// never touch a real player. Deliberate-tampering paths (garbled peer tag, unknown
// item) are NOT exercised: they raise admin alerts and freeze instances by design,
// which is not something to do to production. They are covered in smoke-items.js.

const crypto = require('crypto');

const BASE = process.argv[2] || 'https://fok-server.poggensee.it';
const A = '11117e57';                 // the loser / minter side
const B = '22227e57';                 // the taker side
// WHAT THESE TWO ARE CALLED where somebody might have to look at them. Nothing in
// the item contract reads a display name, but the ids leave rows on a production
// box, and hello is the only place a name is recorded. clnt-CI-<first four of the
// id> so the name points straight back at the row it belongs to.
const ciName = id => 'clnt-CI-' + id.slice(0, 4);
const SEP = '|';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '   ' + extra : '')); }
}

async function post(path, body) {
    let r, txt = '';
    try {
        r = await fetch(BASE + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        txt = await r.text();
    } catch (e) {
        return { status: 0, json: null, text: String(e) };
    }
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { /* keep the raw body for the message */ }
    return { status: r.status, json: j, text: txt.slice(0, 200) };
}

// Exactly the client's _wsAttest / the server's Ledger::mac: the secret's RAW
// bytes as the key, mid|tick|digest as the message, first 16 hex of the MAC.
function tag(secretHex, mid, tick, digest) {
    return crypto.createHmac('sha256', Buffer.from(secretHex, 'hex'))
        .update(mid + SEP + tick + SEP + digest).digest('hex').slice(0, 16);
}

const UID_RE = /^[0-9a-f]{32}$/;
const ITEMS = '/api/items.php';

async function main() {
    console.log('[items-live] ' + BASE + '   as ' + ciName(A) + ' + ' + ciName(B));
    for (const id of [A, B]) await post('/api/hello.php', { id, name: ciName(id) });

    // ---- shape: the wire refuses what it should ---------------------------
    let r = await fetch(BASE + ITEMS).then(x => ({ status: x.status }), () => ({ status: 0 }));
    ok('GET is refused (405)', r.status === 405, 'got ' + r.status);

    r = await post(ITEMS, { id: 'nope', action: 'list' });
    ok('invalid id is refused (400)', r.status === 400 && /invalid id/.test(r.text), r.text);

    r = await post(ITEMS, { id: A, action: 'burn' });
    ok('unknown action is refused (400)', r.status === 400 && /invalid action/.test(r.text), r.text);

    r = await post(ITEMS, { id: A, action: 'mint', item_id: 'NOT VALID', origin: 'shop' });
    ok('invalid item_id is refused (400)', r.status === 400 && /invalid item_id/.test(r.text), r.text);

    r = await post(ITEMS, { id: A, action: 'mint', item_id: 't_live_probe', origin: 'cheat' });
    ok('invalid origin is refused (400)', r.status === 400 && /invalid origin/.test(r.text), r.text);

    // ---- list -------------------------------------------------------------
    r = await post(ITEMS, { id: A, action: 'list' });
    ok('list answers ok with an array', r.status === 200 && r.json && r.json.ok === true
        && Array.isArray(r.json.items), r.text);

    // ---- seed: one-time, idempotent, never double-mints --------------------
    r = await post(ITEMS, { id: A, action: 'seed', items: ['t_seed_probe'] });
    const seed1 = r.json && Array.isArray(r.json.items) ? r.json.items.length : -1;
    ok('seed answers ok with the wardrobe', r.status === 200 && seed1 >= 0, r.text);

    r = await post(ITEMS, { id: A, action: 'seed', items: ['t_seed_probe', 't_seed_probe2'] });
    const seed2 = r.json && Array.isArray(r.json.items) ? r.json.items.length : -2;
    ok('seed is one-time: a second seed mints nothing', seed1 === seed2,
        'first ' + seed1 + ' then ' + seed2);

    // ---- mint -------------------------------------------------------------
    async function mint(who, itemId) {
        const m = await post(ITEMS, { id: who, action: 'mint', item_id: itemId, origin: 'shop' });
        return m.json && UID_RE.test(m.json.uid || '') ? m.json : null;
    }
    const m1 = await mint(A, 't_live_probe');
    ok('mint returns a 32-hex uid at seq 0', m1 !== null && (m1.seq | 0) === 0, JSON.stringify(m1));

    r = await post(ITEMS, { id: A, action: 'list' });
    const ownsA = (r.json && r.json.items || []).some(i => i.uid === (m1 && m1.uid));
    ok('a minted instance shows up in the owner list', ownsA);

    // ---- the match handle: start.php must hand out mid + secret ------------
    // The one silent failure mode: a server that answers a start without them
    // leaves every duel unattested, and nothing else would notice.
    const t = await fetch(BASE + '/api/time.php').then(x => x.json()).catch(() => null);
    ok('time.php answers', t !== null && typeof t.t === 'number');
    const pts = (t && t.t ? t.t : Date.now()) - 300;

    // 'first' mints a fresh match and resets the pair's epoch line, so this
    // never 409s on a repeat run. A must go first; B's identical call reads the
    // same row back and therefore the same mid.
    const sa = await post('/api/start.php', { id: A, peer: B, epoch: 0, reason: 'first', pts });
    const sb = await post('/api/start.php', { id: B, peer: A, epoch: 0, reason: 'first', pts });
    ok('start.php answers both sides', sa.status === 200 && sb.status === 200,
        sa.text + ' | ' + sb.text);
    const mid = sa.json && sa.json.mid, secA = sa.json && sa.json.secret, secB = sb.json && sb.json.secret;
    ok('start.php carries the match id (4.0)', UID_RE.test(mid || ''), String(mid));
    ok('start.php carries a per-side secret', UID_RE.test(secA || '') && UID_RE.test(secB || ''));
    ok('both sides name the same match', mid === (sb.json && sb.json.mid));
    ok('each side gets its OWN secret, never the peer s', secA !== secB);

    if (!UID_RE.test(mid || '')) {
        console.log('\n[items-live] no match handle -- skipping the claim ladder');
        return done();
    }

    const digest = 'a1b2c3d4e5f60718';
    let tick = 64;
    function claim(caller, sec, uid, from, to, tk, seq, peerSec) {
        const body = {
            id: caller, action: 'claim', mid, uid, from, to, tick: tk, seq,
            ws_digest: digest, my_tag: tag(sec, mid, tk, digest)
        };
        if (peerSec) body.peer_tag = tag(peerSec, mid, tk, digest);
        return post(ITEMS, body);
    }

    // ---- the direction rule -----------------------------------------------
    // "I lost it" settles on our own tag alone: nobody lies to lose an item.
    tick += 64;
    r = await claim(A, secA, m1.uid, A, B, tick, 0);
    ok('a LOSS settles at once on the owner s own tag',
        r.status === 200 && r.json && r.json.state === 'settled' && r.json.seq === 1, r.text);

    // A replay of a settled transfer must not read as counterfeit.
    r = await claim(A, secA, m1.uid, A, B, tick, 0);
    ok('replaying a settled claim is idempotent',
        r.status === 200 && r.json && r.json.state === 'confirmed', r.text);

    r = await post(ITEMS, { id: B, action: 'list' });
    ok('the item moved to the taker', (r.json && r.json.items || []).some(i => i.uid === m1.uid));
    r = await post(ITEMS, { id: A, action: 'list' });
    ok('and left the loser', !(r.json && r.json.items || []).some(i => i.uid === m1.uid));

    // A GAIN with the peer's tag is jointly observed: settles as confirmed.
    const m2 = await mint(A, 't_live_probe');
    tick += 64;
    r = await claim(B, secB, m2.uid, A, B, tick, 0, secA);
    ok('a GAIN with the peer s tag is confirmed',
        r.status === 200 && r.json && r.json.state === 'confirmed' && r.json.seq === 1, r.text);

    // A GAIN with no evidence holds through claim_grace_ms instead of settling.
    const m3 = await mint(A, 't_live_probe');
    tick += 64;
    r = await claim(B, secB, m3.uid, A, B, tick, 0);
    ok('an unproven GAIN is held, not settled',
        r.status === 200 && r.json && r.json.state === 'held' && r.json.seq === 0, r.text);

    // ---- compare-and-swap and authentication ------------------------------
    tick += 64;
    r = await claim(B, secB, m2.uid, B, A, tick, 0);   // m2 is at seq 1 now
    ok('a stale seq is refused with re-read (409)',
        r.status === 409 && /stale seq/.test(r.text), r.status + ' ' + r.text);

    tick += 64;
    r = await claim(B, secA, m3.uid, A, B, tick, 0);   // signed with the WRONG key
    ok('a self tag signed with the wrong key is refused (403)',
        r.status === 403 && /bad self tag/.test(r.text), r.status + ' ' + r.text);

    r = await post(ITEMS, {
        id: A, action: 'claim', mid, uid: m3.uid, from: A, to: B, tick: 1,
        seq: 0, my_tag: tag(secA, mid, 1, digest)      // no ws_digest at all
    });
    ok('a malformed claim never reaches the ladder (400)',
        r.status === 400 && /invalid claim/.test(r.text), r.status + ' ' + r.text);

    done();
}

function done() {
    console.log('\n[items-live] ' + pass + ' passed, ' + fail + ' failed');
    if (fail === 0) console.log('PASSED');
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
