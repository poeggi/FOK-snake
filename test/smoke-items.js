// Item-registry smoke (contract 4.0, docs/API.md "Item registry"): the client half
// of server-owned item ownership. Three things are under test, because each one
// fails silently and expensively:
//   * the attestation tag must be byte-identical to the server's HMAC -- a
//     well-formed tag that does not verify is read as TAMPERING and freezes the
//     instance, so an encoding slip destroys a player's gear rather than erroring;
//   * the OFFLINE backlog must survive every answer that means "not now" (no
//     network, an older server with no endpoint at all, the hourly mint cap) and
//     only drop a body the server has actually judged;
//   * the duel handover must derive exactly ONE claim per transfer, with the
//     direction rules: "I lost it" ships at once, "I took it" waits for the peer's
//     corroboration.
// Run: node test/smoke-items.js
const { runInGame } = require('./harness');
const crypto = require('crypto');

const MID = 'aa'.repeat(16);
const SEC = '11'.repeat(16);      // our own per-match secret
const PSEC = '22'.repeat(16);     // the peer's -- start.php never hands us this one
const UID = 'c'.repeat(32);
const UID2 = 'd'.repeat(32);

// The server's tag, computed independently (Ledger::mac is hash_hmac('sha256') keyed
// on the secret's RAW BYTES, truncated to 16 hex chars, over mid|tick|ws_digest).
function srvTag(secHex, tick, digest) {
    return crypto.createHmac('sha256', Buffer.from(secHex, 'hex'))
        .update(MID + '|' + tick + '|' + digest).digest('hex').slice(0, 16);
}

const HOOKS = `
;(function(){
  // The harness has no fetch, and _netOk() only checks that one exists. Every
  // request in this suite goes through the single function items.js posts with, so
  // the tests replace that and leave fetch as a tripwire.
  globalThis.fetch = ()=>{ throw new Error('stub _netPostRes, not fetch'); };
  cfg.offline = false; _netApiNewer = false;
  // Nothing here may self-schedule: itemKick() bails while a timer is pending, so a
  // permanently "pending" one keeps the drains under the tests' control (and makes
  // the load-time kick items.js queues inert).
  _itemTimer = 1;
  globalThis.__posts = [];
  globalThis.__reply = null;             // (body) -> a _netPostRes result
  _netPostRes = async (path, body)=>{ __posts.push(body); return __reply ? __reply(body) : __ok({}); };
  globalThis.__ok  = (j)=>{ const b = Object.assign({ ok:true }, j); return { status:200, json:b, body:b, err:'' }; };
  globalThis.__bad = (code, msg)=>({ status:code, json:null, body:{ ok:false, error:msg }, err:msg });
  globalThis.__take = ()=>__posts.splice(0);
  globalThis.__me = getPlayerId();
  globalThis.__peer = 'deadbeef';

  globalThis.__reset = (seeded)=>{
      cfg.shopItems = {}; cfg.wornItems = {}; cfg.itemReg = {}; cfg.mintQ = []; cfg.claimQ = [];
      cfg.itemsSeeded = seeded ? 1 : 0;
      _itemSynced = true; _itemRetryAt = 0; _itemRetryMs = ITEM_RETRY_MIN; _itemBusy = false;
      __posts.length = 0; __reply = null; __claims.length = 0;
  };
  globalThis.__unsync = ()=>{ _itemSynced = false; };
  globalThis.__synced = ()=>_itemSynced;
  globalThis.__retryAt = ()=>_itemRetryAt;
  globalThis.__flush = ()=>itemFlush();
  globalThis.__cfg = ()=>cfg;
  globalThis.__sha = (s)=>sha256Hex(s);
  globalThis.__itemTag = (sec, mid, tick, dg)=>itemTag(sec, mid, tick, dg);

  // ---- the duel side (duel-core's attestation block) ----
  globalThis.__claims = [];
  _wsClaimOut = (c)=>{ __claims.push(c); itemClaim(c); };   // the real seam game.js installs
  globalThis.__duel = (seqs)=>{ _netSess = { role:'host' }; _wsClaimReset('${MID}', '${SEC}', [__me, __peer], seqs); };
  // A ring snapshot as _wsAttest reads it: the two worn uid maps plus the loose item.
  globalThis.__snap = (u0, u1, it)=>({ _ws:{ w:[Object.keys(u0), Object.keys(u1)], u:[u0, u1], it: it || null } });
  globalThis.__attest = (hk, sn)=>_wsAttest(hk, sn);
  globalThis.__digest = (sn)=>_wsDigestOf(_wsOwnAt(sn));
  globalThis.__peerTagAdd = (tk, g)=>_wsPeerTagAdd(tk, g);
  globalThis.__drain = (n)=>{ for(let i=0;i<(n||1);i++) _wsDrain(); };
  globalThis.__wait = WS_CLAIM_WAIT;
})();
`;

const S = runInGame(HOOKS);
const results = [];
async function check(name, fn) {
    try { await fn(); results.push('  ok  ' + name); }
    catch (e) { results.push('  FAIL ' + name + ': ' + (e && e.message || e)); throw e; }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(what + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); };

(async () => {
try {
    // ---- the attestation tag is the server's, to the byte -------------------
    await check('sha256Hex and the truncated HMAC match a real implementation', () => {
        for (const s of ['', 'a', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'q'.repeat(200)]) {
            eq(S.__sha(s), crypto.createHash('sha256').update(s).digest('hex'), 'sha256Hex(' + s.length + ' chars)');
        }
        // The three encoding traps the server spells out: the key is the secret's
        // RAW BYTES (not its hex text), the tick joins as plain decimal digits, and
        // the separator is a single pipe.
        for (const tick of [0, 4096, 100000000]) {
            const dg = S.__sha('uid=' + tick);
            eq(S.__itemTag(SEC, MID, tick, dg), srvTag(SEC, tick, dg), 'itemTag at tick ' + tick);
        }
        // A malformed secret yields no tag at all rather than one keyed on garbage:
        // an unverifiable tag is the one outcome that costs a player their item.
        for (const bad of ['', 'nothex', '1'.repeat(31), 'zz'.repeat(16)]) {
            eq(S.__itemTag(bad, MID, 64, 'dg'), '', 'a bad secret must yield no tag');
        }
    });

    // ---- offline first: the game never waits on the registry ----------------
    await check('an offline purchase grants at once and queues its registration', () => {
        S.__reset(1);
        S.__cfg().offline = true;                       // no network at all
        S.itemGrant('crown', 'shop');
        S.itemGrant('shades', 'box');
        S.itemGrant('crown', 'shop');                   // a second grant of one in flight
        const c = S.__cfg();
        if (!c.shopItems.crown || !c.shopItems.shades) throw new Error('the item must be owned immediately');
        eq(c.mintQ.length, 2, 'one queued mint per item, never two for one');
        eq(S.__take().length, 0, 'nothing may be posted while offline');
        c.offline = false;
    });

    await check('the backlog drains once online and records each uid', async () => {
        let n = 0;
        S.__reply = (b) => { eq(b.action, 'mint', 'action'); return S.__ok({ uid: (n++ ? UID2 : UID), seq: 0 }); };
        await S.__flush();
        const c = S.__cfg();
        eq(c.mintQ.length, 0, 'the queue must drain');
        eq(S.itemUid('crown'), UID, 'crown uid');
        eq(S.itemUid('shades'), UID2, 'shades uid');
        const posts = S.__take();
        eq(posts.length, 2, 'one post per queued mint');
        eq(posts[0].origin, 'shop', 'the origin the server accepts is asserted verbatim');
        eq(posts[1].origin, 'box', 'origin');
    });

    await check('a server that cannot take it YET keeps the backlog', async () => {
        // 429 (the hourly mint cap), 404 (a server still on contract 3 -- no
        // endpoint), 503 (load shed). Each one used to drop the mint, which loses
        // the item's instance for good.
        for (const st of [429, 404, 405, 503, 0]) {
            S.__reset(1);
            S.itemGrant('crown', 'shop');
            S.__reply = () => (st === 0 ? { status: 0, json: null, body: null, err: '' } : S.__bad(st, 'nope'));
            await S.__flush();
            eq(S.__cfg().mintQ.length, 1, 'status ' + st + ' must keep the mint queued');
            if (!(S.__retryAt() > 0)) throw new Error('status ' + st + ' must arm the backoff');
        }
    });

    await check('a body the server has JUDGED is dropped, not re-posted forever', async () => {
        S.__reset(1);
        S.itemGrant('crown', 'shop');
        S.__reply = () => S.__bad(400, 'invalid item_id');
        await S.__flush();
        eq(S.__cfg().mintQ.length, 0, 'a 400 verdict on this body must drop it');
    });

    // ---- reconciliation: a restored backup cannot resurrect an instance -----
    await check('the one-time seed runs once, then the list is the truth', async () => {
        S.__reset(0);                                   // a legacy wardrobe, never seeded
        const c = S.__cfg();
        c.shopItems = { crown: true, shades: true, donate: true };
        c.wornItems = { crown: true };
        S.__unsync();
        S.__reply = (b) => (b.action === 'seed'
            ? S.__ok({ items: [{ uid: UID, item_id: 'crown' }, { uid: UID2, item_id: 'shades' }] })
            : S.__ok({ items: [{ uid: UID, item_id: 'crown', seq: 0 }, { uid: UID2, item_id: 'shades', seq: 0 }] }));
        await S.__flush();
        const posts = S.__take();
        eq(posts[0].action, 'seed', 'the seed goes first');
        if (posts[0].items.indexOf('donate') >= 0) throw new Error('a repeatable consumable is not an instance');
        eq(c.itemsSeeded, 1, 'the amnesty is marked done');
        eq(S.itemUid('crown'), UID, 'the seeded uid is recorded');
        // Second pass: the seed must never run again, whatever the local state says.
        S.__unsync();
        await S.__flush();
        eq(S.__take().filter(p => p.action === 'seed').length, 0, 'the seed is one-time');
    });

    await check('an instance the server never minted is removed locally', async () => {
        S.__reset(1);
        const c = S.__cfg();
        c.shopItems = { crown: true, shades: true, donate: true };   // shades: a restored backup
        c.wornItems = { crown: true, shades: true };
        c.itemReg = { shades: { uid: UID2, seq: 4 } };                // ...with its stale uid
        S.itemGrant('hat', 'shop');                                  // an offline purchase, not yet registered
        S.__unsync();
        S.__reply = (b) => (b.action === 'list'
            ? S.__ok({ items: [{ uid: UID, item_id: 'crown', seq: 2 }] })
            : S.__ok({ uid: 'e'.repeat(32), seq: 0 }));
        await S.__flush();
        if (c.shopItems.shades || c.wornItems.shades) throw new Error('a restored item the server does not hold must go');
        eq(S.itemUid('shades'), '', 'and so must its uid');
        if (!c.shopItems.crown) throw new Error('a server-held item stays');
        eq(S.itemSeq('crown'), 2, 'the server seq is adopted');
        if (!c.shopItems.hat) throw new Error('a pending mint is legitimate: it must survive the reconcile');
        if (!c.shopItems.donate) throw new Error('a repeatable is not an instance and is never reconciled');
    });

    // ---- claims: the handover, as the server settles it ---------------------
    await check('a gain parked as `held` is re-sent, not dropped', async () => {
        S.__reset(1);
        const c = S.__cfg();
        c.shopItems = { crown: true }; c.itemReg = { crown: { uid: UID, seq: 3 } };
        S.itemClaim({ mid: MID, uid: UID, item: 'crown', from: S.__peer, to: S.__me,
                      tick: 128, seq: 3, digest: 'dg', myTag: 'a'.repeat(16), peerTag: '' });
        eq(c.claimQ.length, 1, 'the claim is queued');
        S.__reply = () => S.__ok({ seq: 3, state: 'held' });
        await S.__flush();
        eq(c.claimQ.length, 1, 'held means NOT settled: the same body must be re-sent later');
        eq(c.claimQ[0].tries, 1, 'the attempt is counted');
        if (!(c.claimQ[0].next > 0)) throw new Error('a held claim must wait for the grace period');
        eq(S.__take().length, 1, 'and not be hammered inside it');
        // A drain inside the wait leaves it alone; past the wait it goes again, and
        // the second answer settles it.
        await S.__flush();
        eq(S.__take().length, 0, 'nothing is re-posted before the wait expires');
        c.claimQ[0].next = 0;
        S.__reply = () => S.__ok({ seq: 4, state: 'confirmed' });
        await S.__flush();
        eq(c.claimQ.length, 0, 'a confirmed claim leaves the queue');
        eq(S.itemSeq('crown'), 4, 'the settled seq is adopted');
    });

    await check('a gain nobody ever corroborates is given up on', async () => {
        S.__reset(1);
        const c = S.__cfg();
        S.itemClaim({ mid: MID, uid: UID, item: 'crown', from: S.__peer, to: S.__me,
                      tick: 128, seq: 0, digest: 'dg', myTag: 'a'.repeat(16), peerTag: '' });
        S.__reply = () => S.__ok({ seq: 0, state: 'held' });
        for (let i = 0; i < 20 && c.claimQ.length; i++) { if (c.claimQ[0]) c.claimQ[0].next = 0; await S.__flush(); }
        eq(c.claimQ.length, 0, 'the backlog must not grow a permanent resident');
    });

    await check('`stale seq` re-reads the list and retries with the server value', async () => {
        S.__reset(1);
        const c = S.__cfg();
        c.shopItems = { crown: true }; c.itemReg = { crown: { uid: UID, seq: 1 } };
        S.itemClaim({ mid: MID, uid: UID, item: 'crown', from: S.__me, to: S.__peer,
                      tick: 128, seq: 1, digest: 'dg', myTag: 'a'.repeat(16), peerTag: '' });
        let seen = 0;
        S.__reply = (b) => {
            if (b.action === 'list') return S.__ok({ items: [{ uid: UID, item_id: 'crown', seq: 7 }] });
            return (++seen === 1) ? S.__bad(409, 'stale seq, re-read') : S.__ok({ seq: 8, state: 'settled' });
        };
        await S.__flush();
        const posts = S.__take().filter(p => p.action === 'claim');
        eq(posts.length, 2, 'exactly one retry, after the re-read');
        eq(posts[1].seq, 7, 'the retry carries the seq the list gave');
        eq(posts[1].tick, posts[0].tick, 'and is otherwise the IDENTICAL body (the server keys idempotency on it)');
        eq(c.claimQ.length, 0, 'the settled claim leaves the queue');
    });

    await check('a claim older than the match window is dropped unsent', async () => {
        S.__reset(1);
        const c = S.__cfg();
        S.itemClaim({ mid: MID, uid: UID, item: 'crown', from: S.__me, to: S.__peer,
                      tick: 128, seq: 0, digest: 'dg', myTag: 'a'.repeat(16), peerTag: '' });
        c.claimQ[0].at = Date.now() - 8 * 3600 * 1000;   // long past match_open_max_ms
        await S.__flush();
        eq(c.claimQ.length, 0, 'it can only raise an operator alert now');
        eq(S.__take().filter(p => p.action === 'claim').length, 0, 'so it is never posted');
    });

    await check('a malformed claim never reaches the wire', () => {
        S.__reset(1);
        const base = { mid: MID, uid: UID, item: 'crown', from: S.__me, to: S.__peer,
                       tick: 128, seq: 0, digest: 'dg', myTag: 'a'.repeat(16), peerTag: '' };
        const bad = [{ mid: '' }, { mid: 'short' }, { uid: 'nope' }, { digest: '' },
                     { myTag: '' }, { myTag: 'zz' }, { tick: -1 }, { tick: 1e9 }, { to: S.__me, from: S.__me }];
        for (const o of bad) S.itemClaim(Object.assign({}, base, o));
        eq(S.__cfg().claimQ.length, 0, 'the server would only 400 these');
    });

    // ---- the duel handover: one claim per transfer, direction rules ---------
    await check('losing an item reports immediately, with a verifiable tag', () => {
        S.__reset(1);
        S.__duel({ [UID]: 3 });
        const before = S.__snap({ crown: UID }, {});          // index 0 (us) wears it
        const after  = S.__snap({}, { crown: UID });          // index 1 (the peer) does
        const t1 = S.__attest(64, before);
        eq(t1, srvTag(SEC, 64, S.__digest(before)), 'the attested tag must verify server-side');
        eq(S.__claims.length, 0, 'the first attested tick has nothing to diff against');
        const t2 = S.__attest(128, after);
        eq(S.__claims.length, 1, 'exactly one claim per transfer');
        const c = S.__claims[0];
        eq(c.from, S.__me, 'from = the loser');
        eq(c.to, S.__peer, 'to = the gainer');
        eq(c.tick, 128, 'the claim names the attested tick');
        eq(c.seq, 3, 'the compare-and-swap value is the one before the transfer');
        eq(c.peerTag, '', 'a loss needs no corroboration -- the server settles it on our own tag');
        eq(c.myTag, t2, 'and carries the tag for THAT tick');
        eq(c.digest, S.__digest(after), 'over the state at that tick');
        eq(S.__cfg().claimQ.length, 1, 'and it lands in the delivery queue');
        // A third attest with no further change adds nothing.
        S.__attest(192, after);
        eq(S.__claims.length, 1, 'an unchanged owner is not a transfer');
    });

    await check('taking an item waits for the peer tag, then ships confirmed', () => {
        S.__reset(1);
        S.__duel({ [UID]: 5 });
        const before = S.__snap({}, { crown: UID });
        const after  = S.__snap({ crown: UID }, {});
        S.__attest(64, before);
        S.__attest(128, after);
        eq(S.__claims.length, 0, 'a gain is held back: it is the direction that pays');
        S.__drain(2);
        eq(S.__claims.length, 0, 'and stays held while no corroboration exists');
        // The peer's tag for the same tick and the same digest is the joint-observation
        // evidence. Only a tick whose _ws provably agreed gets here (see _rbHashSettle).
        S.__peerTagAdd(128, srvTag(PSEC, 128, S.__digest(after)));
        S.__drain(1);
        eq(S.__claims.length, 1, 'once corroborated it ships');
        eq(S.__claims[0].peerTag, srvTag(PSEC, 128, S.__digest(after)), 'carrying the peer tag verbatim');
        eq(S.__claims[0].seq, 5, 'seq');
    });

    await check('an uncorroborated gain still ships once the wait runs out', () => {
        S.__reset(1);
        S.__duel({});
        S.__attest(64, S.__snap({}, { crown: UID }));
        S.__attest(128, S.__snap({ crown: UID }, {}));
        S.__drain(S.__wait - 1);
        eq(S.__claims.length, 0, 'not before the wait is spent');
        S.__drain(1);
        eq(S.__claims.length, 1, 'then unproven, for the server to hold through its grace');
        eq(S.__claims[0].peerTag, '', 'and explicitly WITHOUT a tag we cannot vouch for');
    });

    await check('a garbled peer tag is refused rather than forwarded', () => {
        S.__reset(1);
        S.__duel({});
        S.__attest(64, S.__snap({}, { crown: UID }));
        S.__attest(128, S.__snap({ crown: UID }, {}));
        S.__peerTagAdd(128, 'not-a-tag');
        S.__peerTagAdd(128, undefined);
        S.__drain(2);
        eq(S.__claims.length, 0, 'a shape-invalid tag is not evidence');
        // The server freezes an instance whose peer tag does not verify, so shipping a
        // wrong-but-well-formed tag would destroy the item: only the real one may pass.
        S.__peerTagAdd(128, 'f'.repeat(16));
        S.__drain(1);
        eq(S.__claims.length, 1, 'a well-formed one is forwarded for the server to judge');
    });

    await check('an unregistered item is stealable but unattestable', () => {
        S.__reset(1);
        S.__duel({});
        S.__attest(64, S.__snap({ crown: '' }, {}));
        S.__attest(128, S.__snap({}, { crown: '' }));
        eq(S.__claims.length, 0, 'no uid, nothing for the server to move');
        eq(S.__cfg().claimQ.length, 0, 'and nothing queued');
    });

    await check('a loose item still counts as its owner', () => {
        S.__reset(1);
        S.__duel({});
        const worn  = S.__snap({ crown: UID }, {});
        const loose = S.__snap({}, {}, { id: 'crown', uid: UID, own: 0, x: 3, y: 4, at: 90 });
        S.__attest(64, worn);
        S.__attest(128, loose);
        eq(S.__claims.length, 0, 'blown off the head is not a transfer -- it is still ours');
        eq(S.__attest(192, worn), srvTag(SEC, 192, S.__digest(worn)), 'and it comes back to the same digest');
        eq(S.__claims.length, 0, 'so the round trip reports nothing');
    });

    await check('a fresh match never signs with the previous key', () => {
        S.__reset(1);
        S.__duel({ [UID]: 1 });
        S.__attest(64, S.__snap({ crown: UID }, {}));
        S.__duel({ [UID]: 1 });                       // start.php issued a new mid + secret
        S.__attest(64, S.__snap({}, { crown: UID }));
        eq(S.__claims.length, 0, 'the previous match ownership is not a transfer in this one');
    });

    console.log(results.join('\n'));
    console.log('\nSMOKE-ITEMS PASSED');
} catch (e) {
    console.log(results.join('\n'));
    console.log('\nSMOKE-ITEMS FAIL: ' + (e && e.stack || e));
    process.exit(1);
}
})();
