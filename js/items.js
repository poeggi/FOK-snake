// ============================================================================
// items.js -- the ITEM REGISTRY client: every cosmetic instance a player owns is
// one server row with a unique id (uid), and this is the only file that talks to
// it (/api/items.php).
//
// WHY a registry at all. Ownership used to be a boolean in cfg.shopItems, and the
// cloud backup could restore it: lose a crown in a duel, reload yesterday's save,
// have the crown back -- while the thief kept theirs too. A uid cannot be
// restored into existence. The server's items row IS ownership; a transfer MOVES
// that row (compare-and-swap on its seq), so the population is conserved and a
// restore can only ever hand back items the server still says are yours.
//
// OFFLINE FIRST is not negotiable: this is a PWA that plays with no network at
// all. So nothing here ever blocks the game. A purchase or a box win lands in
// cfg.shopItems IMMEDIATELY, exactly as before, and the registration is queued
// (cfg.mintQ) to be delivered best-effort whenever a connection next exists. An
// unregistered item has no uid; it is worn, drawn, and stealable like any other,
// it just cannot be attested in a duel until it has one.
//
// Three pieces of local state, all in cfg so they ride the ordinary save:
//   cfg.itemReg  { catalogId: {uid, seq} }  server-CONFIRMED instances I own
//   cfg.mintQ    [{id, origin, at}]         acquisitions still awaiting a uid
//   cfg.claimQ   [{...claim}]               duel transfers still undelivered
//
// SCOPE BOUNDARY (deliberate, see the server spec): minting is still
// client-trusted -- the coin economy is client-side, so a modified client can
// still assert a purchase. What this buys is that items are CONSERVED and
// AUDITABLE: they cannot be duplicated, restored, or stolen without both sides
// attesting. Server-side coin/item generation is the next step, not this one.
// ============================================================================

const ITEM_API = '/api/items.php';
const ITEM_Q_MAX = 64;          // per queue: a backlog this long is a broken client, not an offline one
const ITEM_UID_RE = /^[0-9a-f]{32}$/;
const ITEM_TAG_RE = /^[0-9a-f]{16}$/;
const ITEM_TICK_MAX = 100000000;   // the server's accepted tick range
const ITEM_RETRY_MIN = 20000;   // first retry after a failed drain
const ITEM_RETRY_MAX = 600000;  // ceiling: a long offline stretch costs one attempt every 10 min
const ITEM_HELD_WAIT = 65000;   // re-send a parked gain claim just past claim_grace_ms (60s default)
const ITEM_CLAIM_TRIES = 6;     // held re-sends before a gain claim is given up on
const ITEM_CLAIM_MAX_AGE = 6600000;   // 110 min: inside the server's match_open_max_ms (2h default), past which a claim can only alert an operator
let _itemBusy = false;          // single-flight: one drain at a time, never two racing the same queue
let _itemRetryAt = 0, _itemRetryMs = ITEM_RETRY_MIN, _itemTimer = 0;
let _itemSynced = false;        // reconciled against the server list once this session

// ---- local state helpers ---------------------------------------------------
function _itemReg(){ return cfg.itemReg || (cfg.itemReg = {}); }
function _itemMintQ(){ return cfg.mintQ || (cfg.mintQ = []); }
function _itemClaimQ(){ return cfg.claimQ || (cfg.claimQ = []); }
// The uid of the instance I own of a catalog item, or '' if it has none yet
// (bought offline, or minted before the registry existed and not yet seeded).
function itemUid(id){
    const r = _itemReg()[id];
    return (r && ITEM_UID_RE.test(r.uid || '')) ? r.uid : '';
}
function itemSeq(id){
    const r = _itemReg()[id];
    return (r && Number.isInteger(r.seq)) ? r.seq : 0;
}
// Every catalog item that IS a registry instance. Repeatables (DONATE) are
// consumables, not owned objects, so they never get a uid and never reconcile.
function _itemCatalog(){
    return SHOP_ITEMS.concat(BOX_ITEMS).filter(o => !o.repeatable);
}
function _itemQPush(q, rec){
    q.push(rec);
    while(q.length > ITEM_Q_MAX) q.shift();
}

// ---- the ONE acquisition funnel -------------------------------------------
// Every path that hands a player an item goes through here: a shop purchase, a
// mystery box, the ADMIN box, and a duel pickup. It grants LOCALLY at once (the
// UI must never wait on a network) and queues the registration. Wearing stays
// the caller's business -- the slot rules differ per path.
function itemGrant(id, origin){
    if(!id) return;
    const si = cfg.shopItems || (cfg.shopItems = {});
    si[id] = true;
    // Already carrying a confirmed uid, or already queued: nothing to register.
    // A duplicate box roll never reaches here (it refunds instead), so a second
    // grant of the same id means the first one is simply still in flight.
    if(itemUid(id)) return;
    const q = _itemMintQ();
    if(q.some(m => m.id === id)) return;
    _itemQPush(q, { id, origin: origin || 'shop', at: Date.now() });
    saveCfg();
    itemKick();
}
// A duel transfer, applied locally. The pickup side ADOPTS the instance the peer
// lost -- uid and all, because a uid identifies an instance, not a catalog entry,
// and the thief now holds that exact one. seq is the value the claim will
// compare-and-swap against, so it is recorded pre-bump and corrected by whatever
// the server answers.
function itemAdopt(id, uid, seq){
    if(!id) return;
    const si = cfg.shopItems || (cfg.shopItems = {});
    si[id] = true;
    if(ITEM_UID_RE.test(uid || '')) _itemReg()[id] = { uid, seq: Number.isInteger(seq) ? seq : 0 };
    else {
        // The item had no uid on either side (an offline purchase that never
        // registered). It is still won -- it just stays unregistered, and the
        // next drain mints a fresh instance for the new owner. Best effort is
        // exactly what an offline economy can offer.
        delete _itemReg()[id];
        const q = _itemMintQ();
        if(!q.some(m => m.id === id)) _itemQPush(q, { id, origin: 'shop', at: Date.now() });
    }
}
// The losing side of a transfer: the instance is gone from this inventory. Any
// pending mint for it goes too -- registering an item we no longer hold would
// mint a SECOND instance out of one that was only ever lost.
function itemLose(id){
    if(!id) return;
    delete _itemReg()[id];
    const q = _itemMintQ();
    for(let i = q.length - 1; i >= 0; i--) if(q[i].id === id) q.splice(i, 1);
}

// ---- claims (the duel handover) -------------------------------------------
// duel-core hands us a finished claim: it owns the tick, the digest and the two
// attestation tags, because all three come from the lockstep state at a settled
// tick. Our only job is delivery, and delivery may fail for a while.
function itemClaim(c){
    // Refuse a body the server would only 400: it wants a 32-hex mid and uid, a
    // non-empty digest, a 16-hex self tag and a tick inside its range. A duel with
    // no mid (an old server, or a local match) simply produces no claims.
    if(!c || !ITEM_UID_RE.test(c.uid || '') || !ITEM_UID_RE.test(c.mid || '')
       || !c.from || !c.to || c.from === c.to || !c.digest
       || !ITEM_TAG_RE.test(c.myTag || '')
       || !(c.tick >= 0 && c.tick <= ITEM_TICK_MAX)) return;
    _itemQPush(_itemClaimQ(), {
        mid: c.mid, uid: c.uid, item: c.item || '', from: c.from, to: c.to,
        tick: c.tick|0, seq: c.seq|0, digest: c.digest || '',
        myTag: c.myTag || '', peerTag: c.peerTag || '', at: Date.now() });
    saveCfg();
    itemKick();
}

// ---- delivery --------------------------------------------------------------
function _itemOnline(){
    return typeof _netOk === 'function' && _netOk() && typeof getPlayerId === 'function';
}
// A status the server answers when it simply cannot take this body YET: no
// connection at all, a load-shed 5xx, the hourly mint ceiling, or a server that
// is not on contract 4 (no endpoint -> 404). Those keep the backlog and back
// off. Anything else is a VERDICT on this exact body, and re-posting it forever
// would change nothing.
function _itemSoft(s){ return s === 0 || s === 404 || s === 405 || s === 408 || s === 429 || s >= 500; }
// The seq the server last told us this instance is at, or -1 if we do not hold
// it. Used to repair a claim the server refused as `stale seq`.
function _itemSeqOfUid(uid){
    const reg = _itemReg();
    for(const k in reg) if(reg[k].uid === uid) return reg[k].seq|0;
    return -1;
}
// Ask for a drain soon. Cheap and idempotent: a drain already running, or a
// backoff not yet expired, just leaves the timer alone.
function itemKick(){
    if(_itemBusy || !_itemOnline()) return;
    const wait = Math.max(0, _itemRetryAt - Date.now());
    if(_itemTimer) return;
    _itemTimer = setTimeout(() => { _itemTimer = 0; itemFlush(); }, wait);
}
function _itemFail(){
    _itemRetryMs = Math.min(ITEM_RETRY_MAX, _itemRetryMs * 2);
    _itemRetryAt = Date.now() + _itemRetryMs;
}
function _itemWin(){ _itemRetryMs = ITEM_RETRY_MIN; _itemRetryAt = 0; }

// Drains both queues, oldest first, one request at a time. Stops at the first
// transport failure and leaves the rest queued -- order matters for claims (a
// later transfer of the same uid compare-and-swaps against the earlier one's
// result) and costs nothing for mints.
async function itemFlush(){
    if(_itemBusy || !_itemOnline()) return;
    _itemBusy = true;
    let wake = 0;
    try {
        if(!_itemSynced) await itemSync();
        const mq = _itemMintQ();
        while(mq.length){
            const m = mq[0];
            const r = await _netPostRes(ITEM_API, { action:'mint', id:getPlayerId(),
                                                    item_id:m.id, origin:m.origin });
            if(_itemSoft(r.status)){ _itemFail(); return; }   // incl. 429 over the hourly cap
            if(r.json && ITEM_UID_RE.test(r.json.uid || '')){
                // Only record it if we still hold the item: it may have been lost
                // in a duel while the mint sat in the queue.
                if((cfg.shopItems || {})[m.id]) _itemReg()[m.id] = { uid:r.json.uid, seq:r.json.seq|0 };
            }
            // Anything else is a 4xx verdict on this body (bad id, unknown item):
            // drop it rather than re-post the same rejection forever.
            mq.shift();
            saveCfg();
        }
        const cq = _itemClaimQ();
        // A claim parked as `held` must be RE-SENT, not dropped: the server holds
        // an unwitnessed gain until the peer's tag arrives or the grace passes.
        // While one waits, no later claim for the SAME instance may overtake it --
        // that one's compare-and-swap seq assumes this transfer landed first.
        const held = {};
        for(let i = 0; i < cq.length; ){
            const c = cq[i], now = Date.now();
            // The match row a claim is verified against ages out (match_open_max_ms,
            // 2h by default). Past that a delivery can only raise an operator alert,
            // so an ancient backlog entry is dropped instead of posted.
            if(now - (c.at || 0) > ITEM_CLAIM_MAX_AGE){ cq.splice(i, 1); saveCfg(); continue; }
            if(held[c.uid] || (c.next && now < c.next)){
                held[c.uid] = 1;
                const at = c.next || now;
                wake = wake ? Math.min(wake, at) : at;
                i++; continue;
            }
            // The body is retried IDENTICALLY (the server keys idempotency on
            // mid+uid+tick+from+to), so a lost response never double-moves an item.
            const body = { action:'claim', id:getPlayerId(), mid:c.mid, uid:c.uid,
                           from:c.from, to:c.to, tick:c.tick|0, seq:c.seq|0,
                           ws_digest:c.digest, my_tag:c.myTag };
            if(c.peerTag) body.peer_tag = c.peerTag;
            const r = await _netPostRes(ITEM_API, body);
            if(_itemSoft(r.status)){ _itemFail(); return; }
            if(r.json && Number.isInteger(r.json.seq) && c.item && c.to === getPlayerId()){
                // Settled, confirmed or held, the server's seq is the one a later
                // transfer of this instance must compare against.
                const reg = _itemReg();
                if(reg[c.item] && reg[c.item].uid === c.uid) reg[c.item].seq = r.json.seq|0;
            }
            if(r.json && r.json.state === 'held'){
                c.tries = (c.tries | 0) + 1;
                if(c.tries < ITEM_CLAIM_TRIES){
                    // Not evidence of anything wrong: the peer's tag may still be
                    // in flight, and past the grace the same body settles by itself.
                    c.next = Date.now() + ITEM_HELD_WAIT;
                    held[c.uid] = 1;
                    wake = wake ? Math.min(wake, c.next) : c.next;
                    i++; saveCfg(); continue;
                }
                cq.splice(i, 1); saveCfg(); continue;   // gave it up: the peer never reported either
            }
            // `stale seq` / `lost race` are the only refusals worth another try, and
            // only after a fresh list -- our view of the instance was behind. Once.
            if(!r.json && !c.rr && (r.err.indexOf('stale seq') >= 0 || r.err.indexOf('lost race') >= 0)){
                c.rr = 1;
                _itemSynced = false;
                await itemSync();
                const s = _itemSeqOfUid(c.uid);
                if(s >= 0){ c.seq = s; saveCfg(); continue; }
                // We do not hold the instance, so no seq of ours can be right: the
                // peer's own loss claim is what moves it now.
            }
            // Everything else (counterfeit, frozen, out of match, bad tag) is the
            // server's final word on this transfer. Keep playing; the reconcile
            // below is what repairs the local inventory.
            cq.splice(i, 1);
            saveCfg();
            if(!r.json) _itemSynced = false;
        }
        _itemWin();
        if(wake) _itemRetryAt = wake;
        if(!_itemSynced) await itemSync();
    } catch(e){ _itemFail(); }
    finally { _itemBusy = false; if(_itemRetryAt) itemKick(); }
}
// ---- reconciliation --------------------------------------------------------
// The server list is the truth about what this player owns. Two things come out
// of comparing it with the local inventory:
//   * items the server holds for us that cfg lost (a fresh install restoring a
//     cloud backup that predates them) are ADDED back, uid and all;
//   * items cfg claims that the server has never minted are REMOVED -- that is
//     the whole point: a restored backup cannot re-create an instance, and an
//     item lost in a duel stays lost.
// Pending mints count as legitimate (they are ours, just not registered yet), so
// an offline purchase is never wiped by a sync that happens to land first.
// Gated on itemsSeeded: before the one-time grandfather has run, a legacy
// player's whole wardrobe is legitimately absent from the server.
async function itemSync(){
    if(!_itemOnline()) return;
    const id = getPlayerId();
    if(!cfg.itemsSeeded){
        // ONE-TIME amnesty: register what this player already owned before the
        // registry existed. The server prefers its own vault copy of the list
        // where the player enrolled, and guards the whole thing with a
        // players.items_seeded flag, so a retry after a timeout cannot double-mint.
        const owned = _itemCatalog().filter(o => (cfg.shopItems || {})[o.id]).map(o => o.id);
        const r = await _netPostRes(ITEM_API, { action:'seed', id, items:owned });
        if(!r.json || !Array.isArray(r.json.items)) return;   // stay unseeded and try again later
        cfg.itemsSeeded = 1;
        const reg = _itemReg();
        for(const it of r.json.items) if(ITEM_UID_RE.test(it.uid || '')) reg[it.item_id] = { uid:it.uid, seq:0 };
        saveCfg();
    }
    const r = await _netPostRes(ITEM_API, { action:'list', id });
    if(!r.json || !Array.isArray(r.json.items)) return;
    const si = cfg.shopItems || (cfg.shopItems = {});
    const wi = cfg.wornItems || (cfg.wornItems = {});
    const reg = {}, legit = {};
    for(const it of r.json.items){
        if(!ITEM_UID_RE.test(it.uid || '') || !it.item_id) continue;
        reg[it.item_id] = { uid:it.uid, seq:it.seq|0 };
        legit[it.item_id] = 1;
        si[it.item_id] = true;
    }
    for(const m of _itemMintQ()) legit[m.id] = 1;             // ours, just not registered yet
    for(const o of _itemCatalog()){
        if(!si[o.id] || legit[o.id]) continue;
        delete si[o.id]; delete wi[o.id];                      // never minted, or lost: not owned
    }
    cfg.itemReg = reg;
    _itemSynced = true;
    saveCfg();
}

// ---- the duel's view -------------------------------------------------------
// The {uid: seq} map for a match, from BOTH sides' profiles. duel-core needs it
// to fill in a claim's compare-and-swap seq for an item it is about to GAIN --
// the value belongs to the peer's inventory, so it has to travel with the
// profile. Both clients build the same map from the same two profiles.
function itemMatchSeqs(peerProfile){
    const out = {};
    const reg = _itemReg();
    for(const k in reg) if(ITEM_UID_RE.test(reg[k].uid || '')) out[reg[k].uid] = reg[k].seq|0;
    const pu = (peerProfile && peerProfile.wornUids && typeof peerProfile.wornUids === 'object')
             ? peerProfile.wornUids : {};
    const ps = (peerProfile && peerProfile.wornSeqs && typeof peerProfile.wornSeqs === 'object')
             ? peerProfile.wornSeqs : {};
    for(const k in pu){
        const u = pu[k];
        if(ITEM_UID_RE.test(u || '')) out[u] = ps[k]|0;
    }
    return out;
}
// My worn windswept items' uids and seqs, keyed by catalog id, for the exchanged
// profile. Only WORN items travel: an item in the wardrobe is not in the duel.
function itemWornUids(){
    const u = {}, s = {}, wi = cfg.wornItems || {};
    for(const v of WINDSWEPT_ITEMS){
        if(!wi[v.id]) continue;
        const uid = itemUid(v.id);
        if(!uid) continue;
        u[v.id] = uid; s[v.id] = itemSeq(v.id);
    }
    return { uids:u, seqs:s };
}

// Drop the session's reconciled flag and drain again: the local inventory was
// replaced wholesale (a backup restore), so the server list has to be re-read
// before any of it is believed.
function itemResync(){ _itemSynced = false; itemKick(); }

// A connection coming back is the cheapest possible trigger, and the first drain
// of the session is deferred so every script has finished loading first.
try { addEventListener('online', () => { _itemRetryAt = 0; _itemRetryMs = ITEM_RETRY_MIN; itemKick(); }); } catch(e){}
setTimeout(itemKick, 1500);
