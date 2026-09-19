// Identity smoke (API 4.20, FOK-server docs/API.md "Identity token"): the id is public,
// the token proves it. Four things are under test, because each one fails silently on
// the wire:
//   * every request that names our id is a POST whose body carries `tok` (the poll, the
//     relay and the vault restore included, the unload beacon too), null until a hello has
//     minted one; nothing names the id on a request line;
//   * a hello answer carrying `tok` is stored, and a 401 stops the wire with no retry loop:
//     ahead of the first answered hello only the hello's own refusal counts, because a poll
//     can leave first on a never-bound id and it is the hello that then binds it;
//   * RESET ID and a restored file move the token with the id and re-open the wire;
//   * the client speaks HTTPS only: the API origin, the game URL, and the page it runs on.
// Run: node test/smoke-ident.js
const { runInGame } = require('./harness');
const fs = require('fs');
const path = require('path');

const TOK = 'ab'.repeat(16);
const TOK2 = 'cd'.repeat(16);

const HOOKS = `
;(function(){
  cfg.offline = false; _netApiNewer = false;
  _netGate = async ()=>{};                        // the pacing gate is not under test
  _itemTimer = 1;                                 // the item drain rides the first answered hello: parked, it is not under test either
  globalThis.Blob = undefined;                    // the beacon falls back to a string body the test can read
  globalThis.__reqs = [];                         // every request: { method, path, body }
  globalThis.__reply = null;                      // (path, body) -> { status, json }
  const answer = (rep)=>({ status: rep.status, json: async ()=>rep.json });
  globalThis.fetch = async (url, opt)=>{
      const p = String(url).replace(NET_BASE, '');
      const body = (opt && opt.body) ? JSON.parse(opt.body) : null;
      __reqs.push({ method: (opt && opt.method) || 'GET', path: p, body });
      return answer(await (__reply ? __reply(p, body) : { status:200, json:{ ok:true } }));   // a reply may be a promise: a slow wire
  };
  navigator.sendBeacon = (url, data)=>{ __reqs.push({ method:'BEACON', path:String(url).replace(NET_BASE, ''), body:JSON.parse(data) }); return true; };
  globalThis.__take = ()=>__reqs.splice(0);
  globalThis.__hello = ()=>_netHello();
  globalThis.__post = (p, b)=>_netPostRes(p, b, true);
  globalThis.__read = (p, b)=>_netRead(p, undefined, false, NET_BG_SOLO, b);
  globalThis.__poll = ()=>_netPollOnce();
  globalThis.__beacon = (p, b)=>_netBeacon(p, b);
  globalThis.__relay = (o)=>_netRelayPost({ peer:'deadbeef' }, o);
  globalThis.__relayRead = async ()=>{ const s = { peer:'deadbeef', game:true, relay:true }; _netSess = s; s.relay = false; return _netRead('/api/relay.php', undefined, true, undefined, { id:getPlayerId(), peer:s.peer, wait:NET_POLL_S }); };
  globalThis.__ok = ()=>_netOk();
  globalThis.__notice = ()=>netStatusNotice();
  globalThis.__refused = ()=>netIdRefused();
  globalThis.__seen = ()=>_netHelloSeen;
  globalThis.__fresh = ()=>{ _netIdRefused = false; _netHelloSeen = false; _netHelloBusy = false; _netSrvErr = false; };
  globalThis.__tok = ()=>getCloudToken();
  globalThis.__setTok = (t)=>setCloudToken(t);
  globalThis.__clearTok = ()=>clearCloudToken();
  globalThis.__me = ()=>getPlayerId();
  globalThis.__resetId = ()=>resetPlayerId();
  globalThis.__restore = (d)=>_applyRestoredConfig(d);
  globalThis.__snap = ()=>{ const s = _saveSnapshot(); s.crc = _sumOf(s); return s; };
  globalThis.__backup = ()=>cloudBackup(false);
  globalThis.__cloudRestore = ()=>cloudRestore();
  globalThis.__dataMsg = ()=>_dataMsg;
  globalThis.__offline = ()=>netOffline();
  globalThis.__setLoc = (proto)=>{ if(proto == null) delete globalThis.location; else globalThis.location = { protocol: proto }; };
  globalThis.__base = ()=>NET_BASE;
  globalThis.__pollS = ()=>NET_POLL_S;
  globalThis.__gameUrl = ()=>GAME_URL;
  globalThis.__unlatch = ()=>{ _netIdRefused = false; };
  globalThis.__latch = ()=>{ _netIdRefused = true; };
  globalThis.__sumOf = (d)=>_sumOf(d);
  globalThis.__delete = ()=>deleteAccount();
  globalThis.__upgrade = ()=>_netUpgrade;
  globalThis.__updNote = ()=>netUpdateNotice();
  globalThis.__ver = ()=>APP_VERSION;
  globalThis.__setShell = (v)=>{ if(v == null) delete globalThis.FOK_SHELL; else globalThis.FOK_SHELL = v; };
  phase = 'menu'; inGame = false;
})();
`;

const S = runInGame(HOOKS);
const results = [];
async function check(name, fn) {
    try { await fn(); results.push('  ok  ' + name); }
    catch (e) { results.push('  FAIL ' + name + ': ' + (e && e.message || e)); throw e; }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(what + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); };
const one = (reqs, what) => { if (reqs.length !== 1) throw new Error(what + ': expected one request, saw ' + JSON.stringify(reqs)); return reqs[0]; };

(async () => {
try {
    // ---- HTTPS only, statically: the two origins, and no other scheme anywhere shipped ----
    await check('the API origin and the game URL are https, and nothing shipped names an http: URL', () => {
        const root = path.join(__dirname, '..');
        eq(/^https:\/\//.test(S.__base()), true, 'NET_BASE');
        eq(/^https:\/\//.test(S.__gameUrl()), true, 'GAME_URL');
        const files = fs.readdirSync(path.join(root, 'js')).map(f => 'js/' + f).concat(['index.html', 'sw.js']);
        const hits = [];
        for (const f of files) {
            fs.readFileSync(path.join(root, f), 'utf8').split('\n').forEach((line, i) => {
                if (/http:\/\//.test(line) && !/www\.w3\.org/.test(line)) hits.push(f + ':' + (i + 1));
            });
        }
        eq(hits.join(' '), '', 'http: URLs in shipped sources');
    });

    // ---- HTTPS only, at run time: any other page scheme is offline, the toggle greyed ----
    await check('a page that is not https is offline; an https page is not', () => {
        eq(S.__offline(), false, 'the harness (no location) reads as online');
        S.__setLoc('http:');
        eq(S.__offline(), true, 'a plain-http page is offline');
        eq(S.__ok(), false, 'and the wire is closed there');
        S.__setLoc('file:');
        eq(S.__offline(), true, 'a file:// page is offline');
        S.__setLoc('https:');
        eq(S.__offline(), false, 'an https page is online');
        S.__setLoc(null);
    });

    // ---- every request that names the id carries tok ----------------------------
    await check('a POST body that names the id carries tok: null before a hello minted one', async () => {
        S.__clearTok(); S.__fresh(); S.__take();
        await S.__post('/api/scores.php', { id: S.__me(), score: 1 });
        const r = one(S.__take(), 'scores post');
        eq(r.body.id, S.__me(), 'the id');
        eq('tok' in r.body, true, 'tok is present');
        eq(r.body.tok, null, 'tok is null');
        eq(r.body.score, 1, 'the rest of the body is intact');
    });

    await check('a hello answer carrying tok is stored, and every later request carries it', async () => {
        S.__clearTok(); S.__fresh(); S.__take();
        S.__reply = (p) => (p === '/api/hello.php' ? { status:200, json:{ ok:true, api:'4.20', tok: TOK } } : { status:200, json:{ ok:true } });
        await S.__hello();
        const h = one(S.__take(), 'hello');
        eq(h.body.tok, null, 'the first hello carries tok: null');
        eq(S.__tok(), TOK, 'the answer was stored');
        eq(S.__seen(), true, 'the hello counts as answered');
        await S.__post('/api/items.php', { id: S.__me(), action:'list' });
        eq(one(S.__take(), 'items post').body.tok, TOK, 'a later POST carries it');
        await S.__read('/api/poll.php', { id: S.__me(), fs: 0 });
        const pr = one(S.__take(), 'poll read');
        eq(pr.method + ' ' + pr.path, 'POST /api/poll.php', 'a read that names the id is a POST');
        eq(pr.body.tok, TOK, 'and carries it in the body');
        eq(pr.body.fs, 0, 'with the rest of its members');
        await S.__read('/api/scores.php?limit=10');
        const sr = one(S.__take(), 'scores read');
        eq(sr.method + ' ' + sr.path, 'GET /api/scores.php?limit=10', 'a read naming no id is the bare GET');
        eq(sr.body, null, 'and carries no body');
        S.__beacon('/api/signal.php', { id: S.__me(), to:'deadbeef', type:'bye', payload:'' });
        eq(one(S.__take(), 'beacon').body.tok, TOK, 'the unload beacon carries it');
        await S.__relay({ t:'in', pts: 1 });
        const rl = one(S.__take(), 'relay post');
        eq(rl.path, '/api/relay.php', 'the relay POST');
        eq(rl.body.tok, TOK, 'carries it too');
        await S.__relayRead();
        const rd = one(S.__take(), 'relay read');
        eq(rd.method + ' ' + rd.path, 'POST /api/relay.php', 'the relay held read is a POST');
        eq('payload' in rd.body, false, 'with no payload member');
        eq(rd.body.tok + ' ' + rd.body.wait, TOK + ' ' + S.__pollS(), 'carrying the token and the wait');
        S.__reply = null;
    });

    await check('the poll goes out as the real client sends it: a POST naming the id and the token, nothing on the line', async () => {
        S.__setTok(TOK); S.__fresh(); S.__take();
        await S.__poll();                             // the main menu's unheld read: no re-arm, one request
        const p = one(S.__take(), 'poll');
        eq(p.method + ' ' + p.path, 'POST /api/poll.php', 'one fixed URL, nothing in the query');
        eq(p.body.id, S.__me(), 'names the id');
        eq(p.body.tok, TOK, 'and carries the token');
        eq('wait' in p.body, false, 'the main menu read is unheld');
    });

    // ---- 401: the wire stops, once, and says why ---------------------------------
    await check('a 401 on a request after an answered hello stops the wire and names the way out', async () => {
        S.__setTok(TOK); S.__fresh(); S.__take();
        S.__reply = () => ({ status:200, json:{ ok:true, api:'4.20' } });
        await S.__hello();
        S.__take();
        S.__reply = () => ({ status:401, json:{ ok:false, error:'bad token' } });
        const res = await S.__post('/api/friend.php', { id: S.__me(), action:'list' });
        eq(res.status, 401, 'the status is reported');
        eq(S.__refused(), true, 'the refusal is latched');
        eq(S.__ok(), false, 'the wire is closed');
        eq(S.__notice(), 'ID BOUND TO ANOTHER DEVICE', 'every online screen says so');
        S.__take();
        await S.__post('/api/scores.php', { id: S.__me(), score: 1 });
        await S.__hello();
        eq(S.__take().length, 0, 'nothing else leaves: no retry, no beat');
        S.__reply = null;
    });

    await check('ahead of the first answered hello, a refused poll is not the verdict; a refused hello is', async () => {
        S.__clearTok(); S.__fresh(); S.__take();
        S.__reply = () => ({ status:401, json:{ ok:false, error:'bad token' } });
        await S.__read('/api/poll.php', { id: S.__me() });
        eq(S.__refused(), false, 'a poll leaving before the hello may be refused on a never-bound id');
        eq(S.__ok(), true, 'and the hello is still free to bind it');
        await S.__hello();
        eq(S.__refused(), true, 'the hello being refused is the verdict');
        eq(S.__ok(), false, 'the wire is closed');
        eq(S.__notice(), 'ID BOUND TO ANOTHER DEVICE', 'and says so');
        S.__reply = null;
    });

    await check('an answered hello re-opens the wire', async () => {
        S.__setTok(TOK); S.__fresh(); S.__take();
        S.__reply = () => ({ status:401, json:{ ok:false, error:'bad token' } });
        await S.__hello();
        eq(S.__refused(), true, 'refused');
        S.__reply = () => ({ status:200, json:{ ok:true, api:'4.20', tok: TOK2 } });
        S.__unlatch();                                // as an identity change does, before its hello
        await S.__hello();
        eq(S.__refused(), false, 'open again');
        eq(S.__tok(), TOK2, 'and the re-bound token was taken');
        S.__reply = null;
    });

    // ---- the identity moves as one: id and token -----------------------------------
    await check('RESET ID drops the token with the id and sends the new id to hello at once', async () => {
        S.__setTok(TOK); S.__fresh(); S.__take();
        S.__latch();
        const was = S.__me();
        S.__reply = (p) => (p === '/api/hello.php' ? { status:200, json:{ ok:true, api:'4.20', tok: TOK2 } } : { status:200, json:{ ok:true } });
        const id = S.__resetId();
        eq(id === was, false, 'a new id');
        eq(S.__refused(), false, 'the refusal is cleared');
        await new Promise(res => setTimeout(res, 0));
        const h = one(S.__take(), 'the hello');
        eq(h.path, '/api/hello.php', 'a hello went out');
        eq(h.body.id, id, 'for the new id');
        eq(h.body.tok, null, 'with no token');
        eq(S.__tok(), TOK2, 'and the minted one was stored');
        S.__reply = null;
    });

    // ---- the build on every hello, the operator's word on it (API 4.23) --------------
    await check('every hello names the build (no v) and where it runs; a shell names itself', async () => {
        S.__setTok(TOK); S.__fresh(); S.__take();
        S.__reply = () => ({ status:200, json:{ ok:true, api:'4.23' } });
        await S.__hello();
        let h = one(S.__take(), 'the hello');
        eq(h.body.client, S.__ver().replace(/^v/, ''), 'client is APP_VERSION without the v');
        eq(/^[0-9]{1,4}(\.[0-9]{1,4}){1,3}$/.test(h.body.client), true, 'in the shape the server reads');
        eq(h.body.platform, 'web', 'the web build says web');
        S.__setShell('ios');
        await S.__hello();
        h = one(S.__take(), 'the hello');
        eq(h.body.platform, 'ios', 'a shell says which');
        S.__setShell('tv');
        await S.__hello();
        eq(one(S.__take(), 'the hello').body.platform, 'web', 'an unknown shell word reads as web');
        S.__setShell(null); S.__reply = null;
    });

    await check('upgrade: required closes online until a hello answers without it; advised is a note', async () => {
        S.__setTok(TOK); S.__fresh(); S.__take();
        S.__reply = () => ({ status:200, json:{ ok:true, api:'4.23', upgrade:'required' } });
        await S.__hello(); S.__take();
        eq(S.__upgrade(), 'required', 'latched');
        eq(S.__ok(), false, 'the wire is closed');
        eq(S.__notice(), 'GAME UPDATE REQUIRED - PLEASE RELOAD', 'the notice');
        eq(S.__updNote(), 'UPDATE REQUIRED - PLEASE RELOAD', 'the menu note');
        await S.__post('/api/scores.php', { id: S.__me(), score: 1 });
        eq(S.__take().length, 0, 'nothing else leaves');
        S.__setShell('android');
        eq(S.__notice(), 'GAME UPDATE REQUIRED - UPDATE THE APP', 'a store build is sent to its store');
        S.__setShell(null);
        S.__reply = () => ({ status:200, json:{ ok:true, api:'4.23', upgrade:'advised' } });
        await S.__hello(); S.__take();                // the beat is not gated: a lowered floor re-opens
        eq(S.__upgrade(), 'advised', 're-read');
        eq(S.__ok(), true, 'open');
        eq(S.__notice(), 'UPDATE AVAILABLE - PLEASE RELOAD', 'a note');
        S.__reply = () => ({ status:200, json:{ ok:true, api:'4.23' } });
        await S.__hello(); S.__take();
        eq(S.__upgrade(), null, 'absent = nothing to do');
        eq(S.__notice(), null, 'no notice');
        S.__reply = null;
    });

    // ---- DELETE MY DATA: the server forgets the id, then this device starts over ------
    await check('DELETE MY DATA posts account.php delete under tok, then mints a new id; a refusal keeps it', async () => {
        S.__clearTok(); S.__fresh(); S.__take();
        eq(await S.__delete(), false, 'no delete without a token');
        eq(S.__take().length, 0, 'nothing sent');
        eq(S.__dataMsg(), 'NO CLOUD TOKEN', 'said so');
        S.__setTok(TOK); S.__fresh();
        S.__reply = (p) => (p === '/api/account.php' ? { status:500, json:{ ok:false, error:'busy' } } : { status:200, json:{ ok:true, api:'4.23' } });
        const was = S.__me();
        eq(await S.__delete(), false, 'a failed delete');
        let d = one(S.__take().filter(r => r.path === '/api/account.php'), 'the delete');
        eq(d.body.id + ' ' + d.body.tok + ' ' + d.body.action, was + ' ' + TOK + ' delete', 'the body');
        eq(S.__me(), was, 'keeps the id');
        eq(S.__tok(), TOK, 'and the token');
        eq(S.__dataMsg(), 'DELETE FAILED', 'said so');
        S.__reply = (p) => (p === '/api/account.php' ? { status:401, json:{ ok:false, error:'bad token' } } : { status:200, json:{ ok:true, api:'4.23' } });
        await S.__hello(); S.__take();                // an answered hello: from here a 401 is the verdict
        eq(await S.__delete(), false, 'refused');
        S.__take();
        eq(S.__refused(), true, 'the same latch as everywhere');
        eq(S.__dataMsg(), 'ID BOUND TO ANOTHER DEVICE', 'the same message');
        S.__fresh();
        S.__reply = (p) => (p === '/api/account.php' ? { status:200, json:{ ok:true } } : { status:200, json:{ ok:true, api:'4.23', tok: TOK2 } });
        eq(await S.__delete(), true, 'deleted');
        await new Promise(res => setTimeout(res, 0));
        const reqs = S.__take();
        d = one(reqs.filter(r => r.path === '/api/account.php'), 'the delete');
        eq(d.body.id, was, 'for the old id');
        eq(S.__me() === was, false, 'a new id');
        const h = one(reqs.filter(r => r.path === '/api/hello.php'), 'the hello that follows');
        eq(h.body.id + ' ' + h.body.tok, S.__me() + ' null', 'for the new id, with no token');
        eq(S.__tok(), TOK2, 'and the minted one was stored');
        eq(S.__dataMsg().indexOf('DATA DELETED'), 0, 'said so');
        S.__reply = null;
    });

    await check('a hello answer minted for an id that was reset while it was in flight is not kept', async () => {
        S.__clearTok(); S.__fresh(); S.__take();
        let release = null;
        const slow = new Promise(res => { release = res; });
        S.__reply = (p) => (p === '/api/hello.php' ? slow.then(() => ({ status:200, json:{ ok:true, api:'4.20', tok: TOK } })) : { status:200, json:{ ok:true } });
        const h = S.__hello();                        // in flight for the old id
        await new Promise(res => setTimeout(res, 0));
        S.__reply = () => ({ status:200, json:{ ok:true, api:'4.20' } });
        const id = S.__resetId();                     // the identity moves while the answer is on its way
        release(); await h;
        eq(S.__tok(), null, 'the old id token must not land on the new id');
        eq(S.__me(), id, 'the new id stands');
        S.__reply = null;
    });

    await check('a restored file carries its token; one without it clears ours only when it moves the id', async () => {
        S.__setTok(TOK); S.__fresh();
        const mine = S.__me();
        const d = S.__snap(); d.tok = TOK2;
        eq(S.__restore(d), true, 'restore with tok');
        eq(S.__tok(), TOK2, 'the file token is taken');
        eq(S.__refused(), false, 'the wire is open');
        const d2 = S.__snap(); d2.pid = '00c0ffee'; d2.crc = S.__sumOf(d2);   // another identity, no token (a file from before the binding)
        eq(S.__restore(d2), true, 'restore without tok');
        eq(S.__me(), '00c0ffee', 'the id moved');
        eq(S.__tok(), null, 'the token did not follow: null binds a free id and is refused on a bound one');
        const d3 = S.__snap(); delete d3.tok;         // the id this device holds, no token: what it holds stands
        S.__setTok(TOK);
        eq(S.__restore(d3), true, 'restore of our own id without tok');
        eq(S.__tok(), TOK, 'the token here stands');
        const d4 = { v:1, hs:'[]' };                  // a file from before ids: names none, moves none
        eq(S.__restore(d4), true, 'restore of a file naming no id');
        eq(S.__me(), '00c0ffee', 'the id stays');
        eq(S.__tok(), TOK, 'and so does the token');
        const back = S.__snap(); back.pid = mine; back.crc = S.__sumOf(back); back.tok = TOK;
        S.__restore(back);
        eq(S.__me(), mine, 'restored');
    });

    // ---- the vault speaks the same token ------------------------------------------
    await check('the cloud backup and restore carry tok, need it, and a 401 there is the same refusal', async () => {
        S.__setTok(TOK); S.__fresh(); S.__take();
        S.__reply = () => ({ status:200, json:{ ok:true, api:'4.20' } });
        await S.__hello(); S.__take();
        S.__reply = () => ({ status:200, json:{ ok:true, updated: 1 } });
        eq(await S.__backup(), true, 'backup ok');
        const b = one(S.__take(), 'backup post');
        eq(b.path, '/api/backup.php', 'the vault');
        eq(b.body.tok, TOK, 'carries tok');
        eq('token' in b.body, false, 'and nothing under the old name');
        eq(JSON.parse(b.body.payload).tok, undefined, 'the payload never carries the token');
        S.__reply = () => ({ status:200, json:{ ok:true, payload: JSON.stringify(S.__snap()) } });
        await S.__cloudRestore();
        const rs = S.__take().filter(r => r.path === '/api/backup.php');   // the restore re-hellos beside it
        const rr = one(rs, 'restore read');
        eq(rr.method, 'POST', 'the restore is a POST');
        eq(rr.body.tok + ' ' + rr.body.restore, TOK + ' true', 'carrying tok and the restore flag');
        eq(S.__dataMsg(), 'CLOUD RESTORED', 'restored');
        S.__clearTok(); S.__fresh(); S.__take();
        eq(await S.__backup(), false, 'no backup without a token');
        eq(S.__take().length, 0, 'nothing left');
        eq(S.__dataMsg(), 'NO CLOUD TOKEN', 'said so');
        S.__setTok(TOK); S.__fresh();
        S.__reply = () => ({ status:200, json:{ ok:true, api:'4.20' } });
        await S.__hello(); S.__take();
        S.__reply = () => ({ status:401, json:{ ok:false, error:'bad token' } });
        eq(await S.__backup(), false, 'refused');
        eq(S.__dataMsg(), 'ID BOUND TO ANOTHER DEVICE', 'the same message');
        eq(S.__refused(), true, 'the same latch');
        S.__reply = null; S.__fresh();
    });

    console.log(results.join('\n'));
    console.log('\nSMOKE-IDENT PASSED');
} catch (e) {
    console.log(results.join('\n'));
    console.log('\nSMOKE-IDENT FAIL: ' + (e && e.stack || e));
    process.exit(1);
}
})();
