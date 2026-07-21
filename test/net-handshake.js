// TWO-CLIENT handshake test: the only test that proves client A's real output is
// exactly what client B needs as input. Every other net test pokes a single
// client with hand-written signals, which is precisely how the protocol bugs
// survived (accept-relay ignored, offers silently skipped, dup offers resetting
// a forming session). Here two full game instances run in separate vm contexts
// and every signal is delivered between them through a bus, exactly like the
// server mailbox does.  Run: node test/net-handshake.js
const { runInGame } = require('./harness');

const A_ID = 'aaaaaaaa', B_ID = 'bbbbbbbb';

// Installs test hooks INSIDE a client. The driver is concatenated onto the game
// source, so it shares scope and can see the module-level bindings.
const HOOKS = (myId) => `
;(function(){
  globalThis.__out = [];
  localStorage.setItem('fok-snake-pid', ${JSON.stringify(myId)});
  localStorage.setItem('lastSName', ${JSON.stringify(myId.toUpperCase().slice(0,4))});
  simNow=100000; simTick=6000; _splashLeftAt=-1e9; inGame=false; phase='lobby';
  cfg.offline=false;
  // Presence only: _netOk() must be true. Real HTTP is stubbed out below.
  globalThis.fetch = ()=>({ then:()=>({ catch:()=>{} }) });
  // Minimal RTCPeerConnection so the P2P code paths are reachable headlessly.
  // (Only presence + the SDP shuffle matter here; no real ICE is performed.)
  globalThis.RTCPeerConnection = function(){
    this.localDescription = { type:'offer', sdp:'stub' };
    this.connectionState = 'new';
    this.createDataChannel = ()=>({ readyState:'connecting', send(){}, close(){} });
    this.createOffer  = async ()=>({ type:'offer',  sdp:'stub' });
    this.createAnswer = async ()=>({ type:'answer', sdp:'stub' });
    this.setLocalDescription  = async ()=>{};
    this.setRemoteDescription = async ()=>{};
    this._ice = [];
    this.addIceCandidate = async (c)=>{ this._ice.push(c); };
    this.close = ()=>{};
  };
  // friend.php: records the request order so a test can prove the invite waited.
  // Stubbed at the _netPostRes layer, not _netPost: the friend path reads the STATUS
  // (429 = request ban), and _netPost is just its .json, so this covers both.
  globalThis.__calls = [];
  globalThis.__frState = 'accepted';
  globalThis.__frStatus = 200;
  _netPostRes = async (path, body)=>{
    __calls.push((body && body.action) ? 'friend:' + body.action : path);
    if(/friend\.php/.test(path))
      return { status:__frStatus, json: __frStatus === 200 ? { ok:true, state:__frState } : null, err:'' };
    return { status:200, json:null, err:'' };
  };
  globalThis.__setFrState  = (s)=>{ __frState = s; };
  globalThis.__setFrStatus = (n)=>{ __frStatus = n|0; };
  _netGet  = async ()=>null;
  _netTimeSync = async ()=>{};
  // start.php is stubbed for the handshake tests, but the RESTART tests need the real
  // one: the bug lives in what it sends, not in what it does.
  const _realReqStart = _netRequestStart;
  _netRequestStart = async ()=>{};
  _netLiveStart = ()=>{};              // no timers in the test
  _netRelayLoop = async ()=>{};        // relay transport: not under test here
  // The friendship gate is stubbed out for the handshake tests, but the invite
  // path RACES it, so that race needs the real one.
  const _realFrRequest = netFriendRequest;
  netFriendRequest = ()=>null;
  globalThis.__useRealFr = ()=>{ netFriendRequest = _realFrRequest; };
  // Capture every outgoing signal instead of POSTing it. Returns the {status,json}
  // shape the real one does -- __sigFail lets a test make the server refuse.
  globalThis.__sigFail = 0;
  // Keep the REAL _netSignal reachable: the PTS it stamps is a server contract.
  const _realSignal = _netSignal;
  globalThis.__setOfs = (o)=>{ _netSync = { ofs:o, rtt:20, at:Date.now() }; };
  globalThis.__realSignalBody = async (to, type)=>{
    let cap = null;
    const orig = _netPostRes;
    _netPostRes = async (p, b)=>{ cap = b; return { status:200, json:{ ok:true }, err:'' }; };
    await _realSignal(to, type, '');
    _netPostRes = orig;
    return cap;
  };
  _netSignal = async function(to, type, payload){
    // frOk = was the friendship already established AT THE MOMENT we sent this?
    // That is the whole question for the invite race.
    __out.push({ from: ${JSON.stringify(myId)}, to, type, payload: payload||'', frOk: !!_netFrOk[to] });
    if(__sigFail) return { status: __sigFail, json: null };
    return { status: 200, json: { ok: true } };
  };
  globalThis.__setSigFail = (s)=>{ __sigFail = s|0; };
  globalThis.__deliver   = (sig)=>{ _netOnSignal(sig); };
  globalThis.__iceAdded  = ()=> (_netSess && _netSess.pc && _netSess.pc._ice) ? _netSess.pc._ice.slice() : [];
  globalThis.__gameSess  = (peer, role)=>{ _netSess = _netMkSess(peer, role); _netSess.seed=0x515ED; _netSess.game=true; _netSess.dc={readyState:'open',send(){},close(){}}; _netSess.lastRecv=performance.now(); _netSess.lastRecvWall=Date.now(); };
  globalThis.__reconnect = ()=>{ _netReconnect(_netSess); };
  globalThis.__rcDbg = ()=>({ has:!!_netSess, rc:!!(_netSess&&_netSess.reconnecting), rcAt:_netSess&&_netSess.reconnectAt, rtc:(typeof _netRtcAvail==='function')?_netRtcAvail():'nofn', relay:!!(_netSess&&_netSess.relay), game:!!(_netSess&&_netSess.game) });
  globalThis.__invite    = (to)=> _netInviteSend(to);   // async: await it to see the server's verdict
  globalThis.__frOk      = (id)=>{ _netFrOkMark(id); };
  globalThis.__isFrOk    = (id)=> !!_netFrOk[id];
  globalThis.__answer    = (ok)=>{ _netInviteAnswer(ok); };
  globalThis.__dialog    = ()=>  _netLb.invite ? _netLb.invite.from : null;
  globalThis.__setRelay  = (on)=>{ cfg.noP2P = !!on; };
  globalThis.__setOffline= (on)=>{ cfg.offline = !!on; };
  globalThis.__setLook   = (col, items)=>{ cfg.snakeColor = col; cfg.wornItems = items||{}; };
  globalThis.__look      = ()=>  netDuelLook();
  globalThis.__hsTick    = ()=>{ _netHsTick(); };
  // Duel driving, for the netcode tests. __duelStart mirrors beginOnlineDuel.
  globalThis.__wire = [];
  globalThis.__duelStart = (seed, role, atTick)=>{
    _netSess = _netMkSess('ffffffff', role); _netSess.game = true;
    _netSess.dc = { readyState:'open', send:(x)=>__wire.push(x), close(){} };
    simTick = atTick; simNow = atTick * TICK_MS;   // a FREE-RUNNING counter: each client is somewhere else
    inGame = true;
    startDuel(seed>>>0, false);   // rewinds simTick to 0: the duel IS the shared timeline
    _rbReset();                   // AFTER startDuel, exactly like beginOnlineDuel
  };
  globalThis.__tick = (n)=>{ for(let i=0;i<n;i++){ netTickPre(); update(); } };
  globalThis.__steer = (d)=>{ gameSteer(0, d); };
  globalThis.__boost = (d)=>{ gameBoostStart(0, d); };   // grace-delayed (keyboard-style, now=false)
  globalThis.__boostEnd = ()=>{ gameBoostEnd(0); };
  globalThis.__recv = (txt)=>{ _netHandleMsg(txt); };
  globalThis.__drain = ()=>{ const o = __wire.splice(0); return o; };
  globalThis.__rbDbg = ()=> Object.assign({}, _rbDbg);
  globalThis.__hashNow = ()=> _rbHash(simSnapshot());
  globalThis.__simTick = ()=> simTick;
  globalThis.__ringHash = (tk)=>{ for(let i=_rbRing.length-1;i>=0;i--) if(_rbRing[i].tk===tk) return _rbHash(_rbRing[i].snap); return null; };
  // A device that has played single player: the classic globals keep ITS history.
  globalThis.__history = ()=>{ score=8123; lives=2; snake=[{x:3,y:4}]; dir={x:1,y:0}; heart={x:9,y:9};
                              _earlyHeartTrigger=17; perfectCount=5; _shimmerThreshold=91234; };
  globalThis.__desync = ()=>{ players[1].snake[0].x = (players[1].snake[0].x + 3) % COLS; };
  // HEAVY corruption of our copy of the PEER (index 1), as if we mispredicted it through a long
  // dropout: a wholly different, longer snake far away, a stale (behind) gem count, wrong RNG.
  globalThis.__corruptPeer = ()=>{
    players[1].snake = Array.from({length:11},(_,i)=>({x:(2+i)%COLS, y:16}));
    gemsDone = Math.max(0, (gemsDone|0) - 4);
    _rngState = ((_rngState ^ 0x9e3779b9) >>> 0) || 1;
  };
  globalThis.__peerSnakeLen = ()=> players ? players[1].snake.length : -1;
  globalThis.__RB = ()=> ({ ring:RB_RING, settle:RB_SETTLE, future:RB_FUTURE });
  globalThis.__level = ()=> level;
  globalThis.__snakeLen = (i)=> players ? players[i].snake.length : -1;
  globalThis.__fullState = ()=> JSON.stringify(_rbFullState(simSnapshot(), simTick));   // the host's authoritative resync packet
  globalThis.__hashFields = ()=> _rbHashFields(simSnapshot());
  globalThis.__field = (k)=> JSON.stringify(simSnapshot()[k]);
  // Corrupt STRUCTURAL state (not our own snake): wrong level, a wrong view of the peer's snake,
  // wrong gem count -- the kind of divergence the 'st' recovery can NEVER heal.
  globalThis.__corruptStructural = ()=>{ level = (level % 9) + 1; players[0].snake = [{x:1,y:1},{x:2,y:1}]; gemsDone = 99; };
  // Drive the real _netRequestStart with a stubbed server, to see what it SENDS.
  globalThis.__reqStart = async (reason, epoch)=>{
    _netSync = { ofs:0, rtt:1, at:Date.now() };
    _netSess.epoch = epoch|0;
    _netTimeSync = async ()=>{};
    _netPostRes = async ()=>({ status:200, err:'',
      json:{ ok:true, start_pts:netPts()+50, epoch:epoch|0, now:netPts() } });
    await _realReqStart(_netSess, reason);
  };
  // Reliable-control dedup + relay-coalesce probes. beginOnlineDuel is stubbed to a
  // counter so a repeated start is OBSERVABLE without running the whole duel setup --
  // and with it stubbed, inGame never flips, so the dedup that fires is the epoch one
  // (s.ctlEpoch), not the incidental inGame guard.
  globalThis.__ctlBegins = 0;
  globalThis.__ctlSetup = ()=>{
    _netSess = _netMkSess('ffffffff', 'peer'); _netSess.game = true;   // a guest processes sched/rst
    _netSync = { ofs:0, rtt:1, at:Date.now() };
    beginOnlineDuel = ()=>{ __ctlBegins++; };
  };
  // startPts just in the past -> the go() runs synchronously (no future wait); no m.pts,
  // so the receive future-gate is skipped.
  globalThis.__deliverCtl = (t, epoch)=>{ _netHandleMsg(JSON.stringify({ t, seed:0xBEEF, startPts:netPts()-10, epoch })); };
  globalThis.__ctlBeginsN = ()=> __ctlBegins;
  // Relay coalesce: a fetch that never resolves keeps the one POST 'in flight'.
  globalThis.__fetchN = 0;
  globalThis.__relaySetup = ()=>{
    _netSess = _netMkSess('ffffffff', 'host'); _netSess.game = true; _netSess.relay = true;
    _netSync = { ofs:0, rtt:1, at:Date.now() };
    globalThis.fetch = ()=>{ __fetchN++; return { then:()=>({ catch:()=>{} }) }; };
  };
  globalThis.__relaySend  = (o)=>{ _netRelaySend(_netSess, o); };
  globalThis.__pendingN   = ()=> (_netSess && _netSess.relayPending) ? _netSess.relayPending.n : null;
  globalThis.__fetchCount = ()=> __fetchN;
  // 'store full, resend' on the FIRST POST, then 200: proves the refused input is re-slotted
  // and resent, not dropped. A resolving fetch (unlike the never-resolving coalesce stub).
  globalThis.__relayFullThenOk = ()=>{
    _netSess = _netMkSess('ffffffff', 'host'); _netSess.game = true; _netSess.relay = true;
    _netSync = { ofs:0, rtt:1, at:Date.now() }; __fetchN = 0;
    globalThis.fetch = async ()=>{ __fetchN++; return (__fetchN === 1)
      ? { status:429, json: async ()=>({ ok:false, error:'relay store full, resend' }) }
      : { status:200, json: async ()=>({ ok:true }) }; };
  };
  // Unload: sendBeacon is the only send that survives page teardown, so capture it.
  globalThis.__beacons = [];
  globalThis.Blob = function(parts, opts){ this.parts = parts; this.type = opts && opts.type; };
  navigator.sendBeacon = (url, blob)=>{
    __beacons.push({ url, body: JSON.parse(blob.parts ? blob.parts[0] : blob) });
    return true;
  };
  globalThis.__unload    = ()=>{ _netUnload(); };
  // Quick match: match.php hands over a stranger id and a role, with NO profile
  // (unlike an invite, whose accept payload carries one).
  globalThis.__qmOffer   = (to)=> cfg.noP2P ? _netRelayOffer(to) : _netRtcOffer(to);   // returns the offer promise: the p2p path is async
  globalThis.__ageOffer  = (ms)=>{ _netHs.offeredAt -= ms; };
  globalThis.__state = ()=>({
    sess: _netSess ? { peer:_netSess.peer, role:_netSess.role, relay:!!_netSess.relay,
                       game:!!_netSess.game, seed:_netSess.seed>>>0 } : null,
    hs:   { sent:_netHs.sent, accepting:_netHs.accepting, offerTo:_netHs.offerTo, tries:_netHs.offerTries },
    msg:  _netLb.msg,
  });
})();
`;

function mk(id){ return runInGame(HOOKS(id)); }
// Deliver everything A queued to B (and vice versa), like the server mailbox.
function pump(from, to){
  const out = from.__out.splice(0);
  for(const sig of out) to.__deliver(sig);
  return out.map(s => s.type);
}

const results = [];
function check(name, fn){
  try { fn(); results.push('  ok  ' + name); }
  catch(e){ results.push('  FAIL ' + name + ': ' + (e && e.message || e)); throw e; }
}
async function acheck(name, fn){
  try { await fn(); results.push('  ok  ' + name); }
  catch(e){ results.push('  FAIL ' + name + ': ' + (e && e.message || e)); throw e; }
}

(async () => {
try {
  // ---------------------------------------------------------------- relay mode
  // (cfg.noP2P default ON): invite-relay -> accept-relay -> offer(no sdp) -> answer
  check('relay: full invite handshake connects both clients', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(true); B.__setRelay(true);

    A.__invite(B_ID);
    if(A.__state().hs.sent !== B_ID) throw new Error('A did not record the sent invite');
    const t1 = pump(A, B);
    if(!t1.includes('invite-relay')) throw new Error('A must send invite-relay, got ' + t1);
    if(B.__dialog() !== A_ID) throw new Error('B did not surface the invite dialog');

    B.__answer(true);
    const t2 = pump(B, A);
    if(!t2.includes('accept-relay')) throw new Error('B must answer accept-relay, got ' + t2);
    if(B.__state().hs.accepting !== A_ID) throw new Error('B must await the offer');

    const t3 = pump(A, B);   // A's offer (seed, no sdp)
    if(!t3.includes('offer')) throw new Error('A must send an offer on accept, got ' + t3);
    const as = A.__state(), bs = B.__state();
    if(!as.sess || as.sess.role !== 'host' || !as.sess.relay) throw new Error('A has no relay host session');
    if(!bs.sess || bs.sess.role !== 'peer' || !bs.sess.relay) throw new Error('B has no relay peer session');
    if(as.sess.seed !== bs.sess.seed) throw new Error('seed mismatch: ' + as.sess.seed + ' vs ' + bs.sess.seed);
    if(bs.hs.accepting !== null) throw new Error('B still waiting after the offer');

    const t4 = pump(B, A);   // B's answer stops A's offer retry
    if(!t4.includes('answer')) throw new Error('B must answer the offer, got ' + t4);
    if(A.__state().hs.offerTo !== null) throw new Error('the answer must end A\s offer retry');
  });

  // ---------------------------------------------------------------- P2P mode
  // No RTCPeerConnection in the harness, so the SIGNALS are what we verify: the
  // relay bit must NOT appear and the invite/accept types must be the plain ones.
  check('p2p mode: plain invite/accept types on the wire', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(false); B.__setRelay(false);
    A.__invite(B_ID);
    const t1 = pump(A, B);
    if(!t1.includes('invite')) throw new Error('expected a plain invite, got ' + t1);
    if(t1.includes('invite-relay')) throw new Error('p2p mode must not declare the relay bit');
    if(B.__dialog() !== A_ID) throw new Error('B did not surface the p2p invite');
    B.__answer(true);
    const t2 = pump(B, A);
    if(!t2.includes('accept')) throw new Error('expected a plain accept, got ' + t2);
    if(t2.includes('accept-relay')) throw new Error('p2p acceptor must not declare relay');
  });

  // peer-net hint: the server's IPv6 for the peer de-obfuscates its mDNS host
  // candidate into a directly-connectable one (real IP + the revealed port). IPv4
  // and non-mDNS candidates are left alone.
  await acheck('peer-net de-obfuscates an mDNS IPv6 candidate to a real one', async () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(false); B.__setRelay(false);
    const flush = () => new Promise(r=>setTimeout(r,0));
    A.__invite(B_ID); pump(A, B);
    B.__answer(true); pump(B, A);     // A gets the accept and kicks off its async offer
    await flush();                    // let A's createOffer/setLocalDescription resolve + push the offer
    pump(A, B);                       // A's offer -> B builds its (answerer) PC synchronously
    if(!B.__state().sess) throw new Error('B has no P2P session to add candidates to');
    // Server drops peer-net into B's mailbox: A's real IPv6, same family.
    B.__deliver({ from:'server', to:B_ID, type:'peer-net',
      payload: JSON.stringify({ peer:A_ID, ip:'2001:db8::a', family:6, self_ip:'2001:db8::b', self_family:6 }) });
    // A's mDNS host candidate arrives in the SAME drained batch as the offer, i.e.
    // while B's setRemoteDescription is still resolving. A real pc REJECTS
    // addIceCandidate before the remote description is set (and delivery is one-shot,
    // so a rejected candidate is lost for good): it must be PARKED now and flushed the
    // moment the description settles -- never fed to the pc early.
    B.__deliver({ from:A_ID, to:B_ID, type:'ice',
      payload: JSON.stringify({ candidate:'candidate:1 1 udp 2113937151 9f3a-4b.local 51234 typ host generation 0', sdpMid:'0', sdpMLineIndex:0 }) });
    if(B.__iceAdded().length) throw new Error('candidates must be parked until the remote description settles');
    await flush();                    // B's setRemoteDescription resolves -> the parked candidates flush
    const added = B.__iceAdded();
    if(!added.some(c=>/\.local /.test(c.candidate||''))) throw new Error('the original mDNS candidate was not added');
    const deob = added.find(c=>/ 2001:db8::a 51234 typ host/.test(c.candidate||''));
    if(!deob) throw new Error('no de-obfuscated real-IPv6 candidate was added');
    if((+deob.candidate.split(' ')[3]) <= 2113937151) throw new Error('the de-obfuscated candidate must outrank its mDNS twin');
    // A server-reflexive candidate (already a real IP) must NOT be grafted again --
    // and a v4 literal waits out the v6 head start before entering the race.
    const n0 = B.__iceAdded().length;
    B.__deliver({ from:A_ID, to:B_ID, type:'ice',
      payload: JSON.stringify({ candidate:'candidate:2 1 udp 1694498815 203.0.113.7 40000 typ srflx raddr 0.0.0.0 rport 0', sdpMid:'0', sdpMLineIndex:0 }) });
    if(B.__iceAdded().length !== n0) throw new Error('a v4 literal must wait out the v6 head start');
    await new Promise(r => setTimeout(r, 250));
    if(B.__iceAdded().length !== n0 + 1) throw new Error('a non-mDNS candidate must add exactly once (no graft)');
  });

  // The REAL test: a structural desync (which the per-owner 'st' can never heal -- it carries no
  // level/bars/phase) must be resynced by the host's full-state 'rs' while BOTH sims keep ticking
  // and exchange packets both ways -- and it must STAY converged, not loop.
  check('a full resync converges two continuously-ticking sims and stays converged', () => {
    const A = mk(A_ID), B = mk(B_ID);                    // A = host (index 0), B = peer (index 1)
    A.__duelStart(0xF00D, 'host', 400);
    B.__duelStart(0xF00D, 'peer', 400);
    const step = (n)=>{ for(let i=0;i<n;i++){ A.__tick(1); B.__tick(1); A.__drain().forEach(p=>B.__recv(p)); B.__drain().forEach(p=>A.__recv(p)); } };
    step(40);
    if(A.__hashNow() !== B.__hashNow()) throw new Error('setup: synced sims must match');
    B.__corruptStructural();                             // structural divergence the 'st' path cannot fix
    if(A.__hashNow() === B.__hashNow()) throw new Error('setup: corruption should differ');
    // Keep both ticking + exchanging: the host must DETECT the desync and ship a full resync that
    // actually converges them (this is what looped before).
    let converged = false;
    for(let i=0;i<160 && !converged;i++){ step(1); if(A.__hashNow() === B.__hashNow()) converged = true; }
    if(!converged){
      const af = A.__hashFields(), bf = B.__hashFields(), diff = [];
      for(const k in af) if(af[k] !== bf[k]) diff.push(k + '[A=' + A.__field(k) + ' B=' + B.__field(k) + ']');
      throw new Error('resync never converged. desync=' + B.__rbDbg().desync + ' fix=' + B.__rbDbg().fix + ' DIFF: ' + diff.join(' | ').slice(0,400));
    }
    // And it holds: no re-divergence, no resync loop.
    step(80);
    if(A.__hashNow() !== B.__hashNow()) throw new Error('sims did not STAY converged after the resync');
  });

  // Mid-game reconnect: a dropped p2p link is rebuilt with an rc offer/answer that keeps
  // the SAME session (epoch, seed, sim) -- it must not restart the match.
  await acheck('a reconnect rebuilds the link (rc offer/answer) without restarting the match', async () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(false); B.__setRelay(false);
    A.__gameSess(B_ID, 'host'); B.__gameSess(A_ID, 'peer');
    const seedBefore = B.__state().sess.seed, epochBefore = B.__state().sess.epoch;
    A.__reconnect();
    if(!A.__rcDbg().rc) throw new Error('host did not enter the reconnecting state');
    await new Promise(r=>setTimeout(r,0));                 // let the async re-offer resolve
    const off = A.__out.find(s=>s.type==='offer');
    if(!off || !JSON.parse(off.payload).rc) throw new Error('host did not send an rc reconnect offer');
    pump(A, B);                                            // deliver the rc offer to B (still in the game with A)
    await new Promise(r=>setTimeout(r,0));                 // let B's async re-answer resolve
    if(B.__state().sess.seed !== seedBefore || B.__state().sess.epoch !== epochBefore)
      throw new Error('reconnect must NOT reset the peer session (seed/epoch changed)');
    const ans = B.__out.find(s=>s.type==='answer');
    if(!ans || !JSON.parse(ans.payload).rc) throw new Error('peer did not send an rc reconnect answer');
  });

  // One side demanding relay drags the other along (contract: honored if EITHER set).
  check('mixed: a relay-only acceptor forces relay on a p2p inviter', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(false);   // inviter wants p2p
    B.__setRelay(true);    // acceptor demands relay
    A.__invite(B_ID); pump(A, B);
    B.__answer(true);
    const t2 = pump(B, A);
    if(!t2.includes('accept-relay')) throw new Error('B must upgrade to accept-relay, got ' + t2);
    pump(A, B);            // A's offer must now be relay-mode (no sdp)
    const as = A.__state(), bs = B.__state();
    if(!as.sess || !as.sess.relay) throw new Error('A must honour the peer relay demand');
    if(!bs.sess || !bs.sess.relay) throw new Error('B must be in relay');
    if(as.sess.seed !== bs.sess.seed) throw new Error('seed mismatch in mixed mode');
  });

  // Quick match has no invite to carry the relay bit, so the answerer's own setting is
  // the only thing that can force relay -- it used to be ignored entirely and the pair
  // played p2p against the acceptor's wishes. Same EITHER-side rule as the invite path.
  await acheck('mixed quick match: a relay-only answerer forces relay on a p2p offerer', async () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(false);   // match.php made A the offerer; A wants p2p, so it sends an sdp offer
    B.__setRelay(true);    // B demands relay
    await A.__qmOffer(B_ID);   // the p2p offer awaits createOffer/setLocalDescription
    const t1 = pump(A, B);
    if(!t1.includes('offer')) throw new Error('A must send an offer, got ' + t1);
    const ans = B.__out.find(s => s.type === 'answer');
    if(!ans) throw new Error('B sent no answer');
    if(!JSON.parse(ans.payload).relay) throw new Error('B must declare relay in the answer');
    pump(B, A);
    const as = A.__state(), bs = B.__state();
    if(!bs.sess || !bs.sess.relay) throw new Error('B must honour its OWN relay setting');
    if(!as.sess || !as.sess.relay) throw new Error('A must switch to relay on the relay answer');
    if(as.sess.seed !== bs.sess.seed) throw new Error('seed mismatch in mixed quick match');
  });

  // ---------------------------------------------------------------- decline
  check('decline: the inviter is told and drops the handshake', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(true); B.__setRelay(true);
    A.__invite(B_ID); pump(A, B);
    B.__answer(false);
    const t = pump(B, A);
    if(!t.includes('decline')) throw new Error('expected a decline, got ' + t);
    if(A.__state().hs.sent !== null) throw new Error('A must drop the handshake on decline');
    if(A.__state().msg !== 'DECLINED') throw new Error('A must show DECLINED, got ' + A.__state().msg);
    if(A.__state().sess) throw new Error('a declined invite must not leave a session');
  });

  // ---------------------------------------------------------------- lost offer
  // The real-world killer: signals are one-shot. Drop A's offer entirely and the
  // retry must re-deliver it and still connect both sides.
  check('lost offer: the retry re-delivers it and the connect still completes', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(true); B.__setRelay(true);
    A.__invite(B_ID); pump(A, B);
    B.__answer(true); pump(B, A);
    A.__out.splice(0);                 // <-- the offer is LOST in transit
    if(B.__state().sess) throw new Error('B must not have a session yet');
    A.__ageOffer(3000); A.__hsTick();  // retry fires
    const t = pump(A, B);
    if(!t.includes('offer')) throw new Error('the lost offer must be re-sent, got ' + t);
    if(A.__state().hs.tries !== 2) throw new Error('retry count not tracked');
    const bs = B.__state();
    if(!bs.sess || !bs.sess.relay) throw new Error('B must connect from the re-sent offer');
    if(bs.sess.seed !== A.__state().sess.seed) throw new Error('re-sent offer carried a different seed');
  });

  // ---------------------------------------------------------------- lost answer
  // A's answer never arrives, so A re-sends the offer. B already has the session:
  // the duplicate must NOT reset it, only re-answer.
  check('lost answer: a duplicate offer re-answers without resetting B', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(true); B.__setRelay(true);
    A.__invite(B_ID); pump(A, B);
    B.__answer(true); pump(B, A);
    pump(A, B);                        // offer delivered, B builds its session
    const seedBefore = B.__state().sess.seed;
    B.__out.splice(0);                 // <-- B's answer is LOST
    A.__ageOffer(3000); A.__hsTick();
    pump(A, B);                        // duplicate offer reaches B
    const bs = B.__state();
    if(!bs.sess) throw new Error('a duplicate offer destroyed B\s session');
    if(bs.sess.seed !== seedBefore) throw new Error('a duplicate offer rebuilt B\s session');
    const t = pump(B, A);
    if(!t.includes('answer')) throw new Error('B must re-answer a duplicate offer, got ' + t);
    if(A.__state().hs.offerTo !== null) throw new Error('the re-answer must end the retry');
  });

  // ---------------------------------------------------------------- navigation
  // The bug that started the review: an invite arriving on another screen used to
  // route through netLobbyEnter and wipe our own in-flight handshake.
  check('navigation: an incoming invite does not kill our outgoing handshake', () => {
    const A = mk(A_ID), B = mk(B_ID), C = mk('cccccccc');
    A.__setRelay(true); B.__setRelay(true);
    A.__invite(B_ID); pump(A, B);      // A is waiting on B
    // ...meanwhile C invites A while A sits on the 1:1 menu
    C.__setRelay(true); C.__invite(A_ID); pump(C, A);
    if(A.__state().hs.sent !== B_ID) throw new Error('C\s invite wiped A\s handshake with B');
    // B's accept must still be honoured
    B.__answer(true); pump(B, A);
    if(!A.__state().sess) throw new Error('A ignored B\s accept after C\s invite arrived');
  });

  // ------------------------------------------------------- snake looks in sync
  // Both clients must derive the SAME colour/cosmetic pair, keyed on player index
  // (P0 = host). Before, each side rendered P0 with its OWN colour, so the two
  // players saw different colours for the same snakes.
  check('duel looks: both clients agree on colours and cosmetics', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(true); B.__setRelay(true);
    A.__setLook(0, { hat: 1 });      // host picks colour 0 + a hat
    B.__setLook(3, { glasses3d: 1 }); // joiner picks colour 3 + glasses
    A.__invite(B_ID); pump(A, B);
    B.__answer(true); pump(B, A);
    pump(A, B); pump(B, A);
    const la = A.__look(), lb = B.__look();
    if(!la || !lb) throw new Error('no duel look on one side');
    if(la.c0 !== lb.c0 || la.c1 !== lb.c1)
      throw new Error('clients disagree on colours: ' + JSON.stringify([la.c0,la.c1]) + ' vs ' + JSON.stringify([lb.c0,lb.c1]));
    if(la.c0 !== 0 || la.c1 !== 3) throw new Error('P0 must be the host colour, P1 the joiner: ' + JSON.stringify(la));
    if(!la.i0.hat || !la.i1.glasses3d) throw new Error('host must render the peer cosmetics: ' + JSON.stringify(la));
    if(!lb.i0.hat || !lb.i1.glasses3d) throw new Error('joiner must render the peer cosmetics: ' + JSON.stringify(lb));
  });

  // Quick match reaches the offer with NO peer profile in hand -- the answer is
  // the only carrier. The invite tests above cannot catch a broken answer path,
  // because there the accept payload supplies the profile first.
  check('duel looks: quick match agrees too (profile arrives via the answer)', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(true); B.__setRelay(true);
    A.__setLook(1, { hat: 1 });
    B.__setLook(4, { glasses3d: 1 });
    A.__qmOffer(B_ID);       // match.php made A the offerer: no profile passed
    pump(A, B);              // A's offer (carries A's profile)
    pump(B, A);              // B's answer (the ONLY place A learns B's look)
    const la = A.__look(), lb = B.__look();
    if(!la || !lb) throw new Error('no duel look on one side');
    if(la.c0 !== lb.c0 || la.c1 !== lb.c1)
      throw new Error('quick-match clients disagree: ' + JSON.stringify([la.c0,la.c1]) + ' vs ' + JSON.stringify([lb.c0,lb.c1]));
    if(la.c0 !== 1 || la.c1 !== 4) throw new Error('P0 = offerer colour, P1 = the stranger: ' + JSON.stringify(la));
    if(!la.i1.glasses3d) throw new Error('the offerer never received the stranger cosmetics: ' + JSON.stringify(la));
  });

  check('duel looks: identical colour picks are nudged the same way on both', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(true); B.__setRelay(true);
    A.__setLook(2, {}); B.__setLook(2, {});   // both picked colour 2
    A.__invite(B_ID); pump(A, B);
    B.__answer(true); pump(B, A);
    pump(A, B); pump(B, A);
    const la = A.__look(), lb = B.__look();
    if(la.c0 === la.c1) throw new Error('identical picks must be nudged apart');
    if(la.c0 !== lb.c0 || la.c1 !== lb.c1)
      throw new Error('the nudge must be identical on both clients: ' + JSON.stringify([la,lb]));
  });

  // ---------------------------------------------------------------- mutual
  check('mutual invites auto-match without a dialog', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(true); B.__setRelay(true);
    A.__invite(B_ID); B.__invite(A_ID);           // crossing invites
    pump(A, B); pump(B, A);
    // The smaller id (aaaaaaaa) accepts; the larger keeps waiting to offer.
    if(A.__dialog() || B.__dialog()) throw new Error('a mutual invite must not open a dialog');
    const all = A.__out.concat(B.__out).map(s => s.type);
    if(!all.includes('accept-relay') && !all.includes('accept')) throw new Error('mutual invite produced no accept: ' + all);
  });

  // ------------------------------------------------------------ leaving abruptly
  // A reload/close kills every JS timer we own, so the ONLY thing that spares the
  // peer its own timeout (3s in-game, 30s mid-handshake) is a goodbye on the way
  // out -- and it must go by sendBeacon, since fetch() is cancelled on unload.
  check('unload: a running match byes its peer and tears down', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(true); B.__setRelay(true);
    A.__invite(B_ID); pump(A, B);
    B.__answer(true); pump(B, A); pump(A, B);
    if(!A.__state().sess) throw new Error('no session to leave');
    A.__unload();
    const bye = A.__beacons.find(b => b.body.type === 'bye' && b.body.to === B_ID);
    if(!bye) throw new Error('no bye beacon: ' + JSON.stringify(A.__beacons));
    if(!/signal\.php$/.test(bye.url)) throw new Error('bye went to the wrong endpoint: ' + bye.url);
    if(A.__state().sess) throw new Error('session survived unload');
  });

  check('unload: an unanswered invite is withdrawn, and the peer is told once', () => {
    const A = mk(A_ID);
    A.__setRelay(true);
    A.__invite(B_ID); A.__out.splice(0);        // invite is out, nobody answered
    if(A.__state().hs.sent !== B_ID) throw new Error('no pending invite to withdraw');
    A.__unload();
    const byes = A.__beacons.filter(b => b.body.to === B_ID && b.body.type === 'bye');
    if(byes.length !== 1) throw new Error('expected exactly one bye, got ' + byes.length);
    if(A.__state().hs.sent) throw new Error('handshake survived unload');
  });

  // Reloading mid-connect: the peer occupies BOTH the forming session and the
  // unanswered-offer slot, and must still hear exactly one goodbye.
  check('unload: mid-connect sends one bye, not one per slot', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(true); B.__setRelay(true);
    A.__invite(B_ID); pump(A, B);
    B.__answer(true); pump(B, A);               // A offers; B's answer is NOT pumped back
    const st = A.__state();
    if(!st.sess || st.hs.offerTo !== B_ID) throw new Error('expected a forming session AND a live offer: ' + JSON.stringify(st));
    A.__unload();
    const byes = A.__beacons.filter(b => b.body.to === B_ID && b.body.type === 'bye');
    if(byes.length !== 1) throw new Error('expected exactly one bye, got ' + byes.length);
  });

  // An invite sitting unanswered on OUR screen: leaving means unavailable, which is
  // a decline -- the same thing we send when an invite arrives outside a duel menu.
  check('unload: an open incoming invite is declined', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(true); B.__setRelay(true);
    A.__invite(B_ID); pump(A, B);
    if(B.__dialog() !== A_ID) throw new Error('no invite dialog to decline');
    B.__unload();
    const d = B.__beacons.find(b => b.body.to === A_ID && b.body.type === 'decline');
    if(!d) throw new Error('no decline beacon: ' + JSON.stringify(B.__beacons));
  });

  check('unload: offline mode says nothing at all', () => {
    const A = mk(A_ID);
    A.__setRelay(true); A.__invite(B_ID);
    A.__setOffline(true);
    A.__unload();
    if(A.__beacons.length) throw new Error('offline client phoned home on unload: ' + JSON.stringify(A.__beacons));
  });

  // ------------------------------------------------- the server refusing a signal
  // Every _netSignal result used to be discarded, so a refused invite was
  // indistinguishable from a delivered one: nothing reached the peer, nothing
  // reached the server's mailbox, and the UI showed WAITING until the 30s timeout.
  await acheck('refused invite: the user is told, not left waiting', async () => {
    const A = mk(A_ID);
    A.__setRelay(true); A.__setSigFail(500);
    await A.__invite(B_ID);
    if(A.__state().hs.sent) throw new Error('still waiting on an invite the server refused');
    if(!/FAILED|TRY AGAIN/.test(A.__state().msg)) throw new Error('no failure shown, msg was: ' + A.__state().msg);
  });

  // The permanent case: our local "we are friends" cache outlives the server's
  // view (they removed us, or the request never completed). netFriendRequest()
  // no-ops while that flag is set, so the friendship is never repaired and EVERY
  // invite 403s -- silently, forever. A 403 must reset the belief.
  await acheck('403 invite: the stale friendship belief is dropped and re-requested', async () => {
    const A = mk(A_ID);
    A.__setRelay(true);
    A.__frOk(B_ID);                       // we believe we are friends...
    if(!A.__isFrOk(B_ID)) throw new Error('setup failed');
    A.__setSigFail(403);                  // ...the server disagrees
    await A.__invite(B_ID);
    if(A.__isFrOk(B_ID)) throw new Error('a 403 left the stale friendship belief in place: invites stay broken forever');
    if(!/FRIENDS/.test(A.__state().msg)) throw new Error('no friendship message, msg was: ' + A.__state().msg);
  });

  // friend.php answers 429 for the 1h request ban. Read through the status-blind
  // _netPost it was indistinguishable from a blip, so the UI promised a retry that
  // could not succeed for an hour, and kept asking on every invite.
  await acheck('429 friend ban: the user is told, and we stop asking', async () => {
    const A = mk(A_ID);
    A.__setRelay(true); A.__useRealFr();
    A.__setSigFail(403);                  // the invite is refused: not friends
    A.__setFrStatus(429);                 // ...and the friend request is banned
    await A.__invite(B_ID);
    if(/RETRY IN A MOMENT/.test(A.__state().msg))
      throw new Error('a banned request still promised an imminent retry: ' + A.__state().msg);
    if(!/TRY LATER/.test(A.__state().msg)) throw new Error('the ban was not surfaced, msg was: ' + A.__state().msg);
    const before = A.__calls.filter(c => c === 'friend:request').length;
    await A.__invite(B_ID);               // a second attempt must not re-ask while banned
    const after = A.__calls.filter(c => c === 'friend:request').length;
    if(after > before) throw new Error('kept asking during the ban: ' + before + ' -> ' + after);
  });

  // The reported symptom: "I send an invite, it does not go out. I wait, send
  // another, it goes out." The invite is friendship-gated, and it was fired in the
  // same breath as the request that establishes the friendship -- so the first one
  // reached the server before the friendship existed and came back 403. By the
  // second attempt the friendship had landed, so that one worked.
  await acheck('invite waits for the friendship instead of racing it', async () => {
    const A = mk(A_ID);
    A.__setRelay(true); A.__useRealFr();
    if(A.__isFrOk(B_ID)) throw new Error('setup: must start as not-yet-friends');
    await A.__invite(B_ID);
    if(A.__calls[0] !== 'friend:request') throw new Error('the friendship must be requested first, got: ' + JSON.stringify(A.__calls));
    const inv = A.__out.find(s => s.type === 'invite-relay');
    if(!inv) throw new Error('no invite reached the wire: ' + JSON.stringify(A.__out));
    // The point: the friendship must already be ESTABLISHED at the instant the
    // invite is sent. Racing it means the server sees the invite first -> 403.
    if(!inv.frOk) throw new Error('the invite raced the friendship: it was sent before the request resolved, so the server 403s it');
  });

  await acheck('accepted invite is not disturbed by the new result check', async () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__setRelay(true); B.__setRelay(true);
    await A.__invite(B_ID);
    if(A.__state().hs.sent !== B_ID) throw new Error('a delivered invite must still be pending');
    pump(A, B);
    if(B.__dialog() !== A_ID) throw new Error('B never saw the invite');
  });

  // ------------------------------------------------------------- the PTS contract
  // pts is unix MILLISECONDS and the server checks it with PHP's strict is_int().
  // The offset is derived from rtt/2, so it carries a fraction: an un-rounded pts
  // serialises as 1784190294971.8 and is rejected 400 'invalid pts' -- silently
  // killing the signal. Intermittent, because rtt/2 sometimes lands whole.
  await acheck('pts is always a whole number, whatever the offset', async () => {
    const A = mk(A_ID);
    for(const ofs of [1.800048828125, -0.5, 21.8, 1234.4999, -7777.123]){
      A.__setOfs(ofs);
      const body = await A.__realSignalBody(B_ID, 'invite');
      if(body.pts === undefined) throw new Error('no pts stamped at all');
      if(!Number.isInteger(body.pts))
        throw new Error('fractional pts (PHP is_int() rejects this with 400): ' + JSON.stringify(body.pts) + ' from offset ' + ofs);
      if(JSON.stringify(body).indexOf('.') >= 0)
        throw new Error('a decimal point reached the wire: ' + JSON.stringify(body));
    }
  });

  // ------------------------------------------------------------ lockstep netcode
  // The two clients enter a duel with WILDLY different simTick values, because
  // simTick free-runs from page load and startDuel never resets it. A tick stamp is
  // only meaningful relative to each client's own duel start -- get that wrong and
  // every input lands outside the accept window and is dropped, which looks exactly
  // like "no directions ever reach the other side". A single-client test cannot see
  // this: it needs two clients whose counters disagree.
  check('input crosses between clients whose tick counters differ wildly', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__duelStart(0xBEEF, 'host', 45000);   // been idling in menus for minutes
    B.__duelStart(0xBEEF, 'peer', 3000);    // just opened the game
    A.__tick(120); B.__tick(120);
    A.__drain(); B.__drain();
    const rx0 = B.__rbDbg(), drop0 = rx0.drop;
    A.__steer({x:0,y:-1});
    const pkts = A.__drain().filter(p => JSON.parse(p).t === 'in');
    if(!pkts.length) throw new Error('A sent no input at all');
    pkts.forEach(p => B.__recv(p));
    const rx1 = B.__rbDbg();
    if(rx1.drop > drop0) throw new Error('B DROPPED the input: the tick stamp was not duel-relative (' + JSON.stringify(rx1) + ')');
  });

  // Both sims must reach the SAME state from the same seed + same inputs -- the whole
  // promise of the architecture. A late DIR only takes effect at the peer's next STEP
  // (every 2*gPer = 12 ticks at L1), so if the peer has not stepped since it was authored,
  // the direction is still pending and B applies it LIVE with no rewind -- and the worlds
  // must still be identical. This is the slack the step interval buys us.
  check('a late dir still pending applies live (no rewind) and converges', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__duelStart(0xBEEF, 'host', 45000);
    B.__duelStart(0xBEEF, 'peer', 3000);
    A.__tick(70); B.__tick(70);        // inside one 64-tick hash block: a straddled boundary forces a rewind by design
    A.__drain(); B.__drain();
    A.__steer({x:0,y:-1});
    const p = A.__drain().filter(x => JSON.parse(x).t === 'in');
    B.__tick(8);                       // AHEAD by fewer than a step period: dir still queued
    p.forEach(x => B.__recv(x));
    if(B.__rbDbg().rb) throw new Error('B rewound for a dir that was still pending (should apply live)');
    A.__tick(50); B.__tick(42);        // both to tick 120
    if(A.__simTick() !== B.__simTick()) throw new Error('drove the two sims to different tick counts: test bug');
    if(A.__hashNow() !== B.__hashNow())
      throw new Error('the two clients diverged: a live-applied dir must match the rollback result');
  });

  // A grace-delayed boost (keyboard/dpad) that lands within its grace window has not
  // engaged on either sim yet, so it applies LIVE (no rewind) -- boostSince anchored to its
  // real tick -- and both worlds stay identical. This is why boost no longer costs rollbacks.
  check('a boost engages via the arming stage, crosses as a real transition, converges', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__duelStart(0xBEEF, 'host', 45000);
    B.__duelStart(0xBEEF, 'peer', 3000);
    A.__tick(120); B.__tick(120);      // snakes moving
    A.__drain(); B.__drain();
    A.__steer({x:0,y:-1});
    A.__tick(30);                      // the turn is consumed: the live dir is known
    A.__boost({x:0,y:-1});             // ARMS only (device-local); the stage authors the REAL engage after grace
    A.__tick(30);
    const p = A.__drain().filter(x => JSON.parse(x).t === 'in');
    if(!p.some(x => /"k":"bs"/.test(x))) throw new Error('no engage transition on the wire');
    B.__tick(60);                      // both at 180
    p.forEach(x => B.__recv(x));
    A.__tick(60); B.__tick(60);        // both to 240: late transitions settle in (live or rewound, per accrual)
    if(A.__simTick() !== B.__simTick()) throw new Error('drove the two sims to different tick counts: test bug');
    if(A.__hashNow() !== B.__hashNow())
      throw new Error('the two clients diverged: a boost transition must replay identically');
    // The ANSWERER's own snake is players[1]: its arming slot must be the SIM index
    // (input maps it), or alignment watches the OPPONENT and boost never fires.
    B.__steer({x:0,y:-1});
    B.__tick(30);
    B.__boost({x:0,y:-1});
    B.__tick(30);
    const q = B.__drain().filter(x => JSON.parse(x).t === 'in');
    if(!q.some(x => /"k":"bs"/.test(x))) throw new Error('answerer boost never engaged / crossed the wire');
    A.__tick(60);
    q.forEach(x => A.__recv(x));
    A.__tick(60); B.__tick(60);
    if(A.__simTick() !== B.__simTick()) throw new Error('drove the two sims to different tick counts: test bug');
    if(A.__hashNow() !== B.__hashNow()) throw new Error('the answerer boost diverged the sims');
  });

  // A realistic wire: BOTH directions delayed by one tick (~17ms >= a 10ms link),
  // both players steering, the periodic hash checks flowing through the same delayed
  // bus -- so alignment is proven continuously (dsy must stay 0), not just at the end.
  check('a 10ms wire with movement from both sides stays perfectly aligned', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__duelStart(0xBEEF, 'host', 45000);
    B.__duelStart(0xBEEF, 'peer', 3000);
    const qA = [], qB = [];                      // in-flight: [deliverAtStep, packet]
    let step = 0;
    const advance = (n) => { for(let i = 0; i < n; i++){
      step++;
      while(qB.length && qB[0][0] <= step) B.__recv(qB.shift()[1]);
      while(qA.length && qA[0][0] <= step) A.__recv(qA.shift()[1]);
      A.__tick(1); B.__tick(1);
      A.__drain().forEach(p => qB.push([step + 1, p]));
      B.__drain().forEach(p => qA.push([step + 1, p]));
    } };
    advance(120);
    // SLOW play first: single strokes about a second apart.
    A.__steer({x:0,y:-1}); advance(60);
    B.__steer({x:0,y:-1}); advance(60);
    A.__steer({x:1,y:0});  advance(60);
    // Then SPAM: rapid 90-degree left/right alternation, pressed faster than steps
    // run, so turns pile into the 3-deep queue and the keyframe filter earns its
    // keep -- the exact pattern that used to shower rollbacks.
    // 12 presses at 1-tick spacing: several land inside one keyframe, so the 3-deep
    // queue CAP trips and the overflow is dropped at authoring -- local and remote
    // must agree exactly on which presses survived.
    for(let i = 0; i < 12; i++){ A.__steer(i & 1 ? { x:1, y:0 } : { x:0, y:-1 }); advance(1); }
    advance(60);
    for(let i = 0; i < 12; i++){ B.__steer(i & 1 ? { x:0, y:1 } : { x:1, y:0 }); advance(1); }
    advance(150);
    if(A.__simTick() !== B.__simTick()) throw new Error('tick counts differ: test bug');
    if(A.__rbDbg().desync || B.__rbDbg().desync)
      throw new Error('hash checks flagged a divergence mid-run: A=' + A.__rbDbg().desync + ' B=' + B.__rbDbg().desync);
    if(A.__hashNow() !== B.__hashNow()) throw new Error('sims diverged under a 10ms wire');
  });

  // The other half: a dir that arrives AFTER the step it belonged to (the peer already
  // moved with the old direction) can only be honoured by rewinding to its tick. That
  // path must still converge too.
  check('a late dir that missed its step rewinds and converges', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__duelStart(0xBEEF, 'host', 45000);
    B.__duelStart(0xBEEF, 'peer', 3000);
    A.__tick(120); B.__tick(120);      // well past READY/GO (78t): snakes are MOVING
    A.__drain(); B.__drain();
    A.__steer({x:0,y:-1});
    const p = A.__drain().filter(x => JSON.parse(x).t === 'in');
    B.__tick(30);                      // AHEAD past several steps (every 12t): old dir consumed
    p.forEach(x => B.__recv(x));
    if(!B.__rbDbg().rb) throw new Error('B did not rewind for an input that missed its step');
    A.__tick(60); B.__tick(30);        // both to tick 180
    if(A.__simTick() !== B.__simTick()) throw new Error('drove the two sims to different tick counts: test bug');
    if(A.__hashNow() !== B.__hashNow())
      throw new Error('the two clients diverged after a rewind');
  });

  // A restart that happens WHILE in game (rematch, level, respawn) must not be sent as
  // 'sched': the peer refuses that one when inGame, so it silently ignores it and only
  // the sender restarts. This tests what _netRequestStart SENDS -- testing the receiver
  // instead would pass against the bug, because the receiver was never the problem.
  // The reported case: "a lot of DESYNC, even though neither player is doing
  // anything". With ZERO inputs two sims MUST be bit-identical, so a desync there is
  // the detector lying. _shimmerThreshold rides in the snapshot but comes from THIS
  // device's best score and only drives a render effect -- two players with different
  // best scores hashed differently forever, having touched nothing.
  // A duel simulates `players`. The snapshot also hauls each device's leftovers from
  // its OWN last single-player game (snake, score, lives, heart, _shimmerThreshold from
  // localStorage...) because it exists to mirror the sim into the worker, and startDuel
  // never resets what the duel never reads. Hashing those compared two players'
  // single-player HISTORY and called the difference a divergence -- every comparison,
  // hash-ok 0, with the sims in perfect lockstep. Fresh test clients cannot see it:
  // this needs one client with a past.
  check('single-player history does not desync a duel', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__history();            // A has played classic; B is a fresh install
    A.__duelStart(0xBEEF, 'host', 1000);
    B.__duelStart(0xBEEF, 'peer', 7000);
    A.__tick(120); B.__tick(120);
    if(A.__hashNow() !== B.__hashNow())
      throw new Error('two idle clients desync purely because their single-player pasts differ');
  });

  // Our own input is applied LIVE, before netTickPre reaches its tick. The ring entry
  // for that tick must still be the state BEFORE the input, or our snapshot bakes it
  // in while the peer -- applying the same input at the same tick, but after ITS
  // snapshot -- hashes without it. Identical sims, different snapshot boundary: a
  // desync on every steer, once per hash.
  check('a locally-applied input does not move the snapshot boundary', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__duelStart(0xBEEF, 'host', 1000);
    B.__duelStart(0xBEEF, 'peer', 1000);
    A.__tick(120); B.__tick(120);
    A.__drain(); B.__drain();
    A.__steer({x:0,y:-1});                       // A applies it live and sends it
    A.__drain().filter(p => JSON.parse(p).t === 'in').forEach(p => B.__recv(p));
    A.__tick(40); B.__tick(40);                  // both run the tick that owns it
    if(A.__hashNow() !== B.__hashNow())
      throw new Error('the two sims diverged on a plain steer');
    // The rollback point for that tick must match on both: that is what the hash
    // compares, and what a rewind would restore.
    if(A.__ringHash(121) !== B.__ringHash(121))
      throw new Error('snapshot boundary differs: our ring entry baked in the live input, the peer one did not');
  });

  // ...but a REAL divergence must still be caught: the skip list is a scalpel.
  check('a real divergence is still detected', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__duelStart(0xBEEF, 'host', 1000);
    B.__duelStart(0xBEEF, 'peer', 1000);
    A.__tick(120); B.__tick(120);
    if(A.__hashNow() !== B.__hashNow()) throw new Error('setup: identical sims must match');
    B.__desync();                       // move one snake: a genuine difference
    if(A.__hashNow() === B.__hashNow()) throw new Error('the hash missed a real divergence');
  });

  // ...and once flagged, the authoritative-state packet REPAIRS it. Each client owns its own
  // snake (its index), so the peer's copy adopts it. Corrupt A's copy of the peer (index 1)
  // snake, let B -- its owner -- emit a state packet, and A must re-converge after the settle.
  check('an authoritative-state packet repairs a peer-snake divergence', () => {
    const A = mk(A_ID), B = mk(B_ID);
    A.__duelStart(0xBEEF, 'host', 1000);
    B.__duelStart(0xBEEF, 'peer', 1000);
    A.__tick(120); B.__tick(120);
    A.__drain(); B.__drain();
    if(A.__hashNow() !== B.__hashNow()) throw new Error('setup: identical sims must match');
    A.__desync();                                  // corrupt A's copy of the peer (index 1) snake
    if(A.__hashNow() === B.__hashNow()) throw new Error('setup: the corruption should differ');
    // The st repair channel is mismatch-gated: B only ships state once it can SEE the
    // divergence -- via A's periodic hash disagreeing with its ring, or A's 'hfr'
    // field-hash request. So A's h/hfr flow to B; A's own st/rs are discarded, keeping
    // B the clean reference. B's st then reaches A, which adopts B's authoritative
    // snake and rolls forward. Tick finely and deliver promptly, like real 60Hz play.
    let repaired = false;
    for(let i = 0; i < 220 && !repaired; i++){
      B.__tick(1); B.__drain().forEach(p => A.__recv(p));
      A.__tick(1);
      A.__drain().forEach(p => { const t = JSON.parse(p).t; if(t === 'h' || t === 'hfr') B.__recv(p); });
      if(A.__hashNow() === B.__hashNow()) repaired = true;
    }
    if(!repaired) throw new Error('no re-converge. A.fix=' + A.__rbDbg().fix + ' A.desync=' + A.__rbDbg().desync);
  });

  await acheck('an in-game restart is sent as rst, not the first-start sched', async () => {
    const A = mk(A_ID);
    A.__duelStart(0xBEEF, 'host', 1000);
    A.__drain();
    await A.__reqStart('rematch', 1);
    const types = A.__drain().map(x => JSON.parse(x).t);
    if(types.includes('sched')) throw new Error('a rematch used sched: the peer ignores it while in game, so only one client restarts');
    if(!types.includes('rst')) throw new Error('a rematch sent no restart at all: ' + JSON.stringify(types));
  });

  await acheck('the FIRST start still uses sched', async () => {
    const A = mk(A_ID);
    A.__duelStart(0xBEEF, 'host', 1000);
    A.__drain();
    await A.__reqStart('first', 0);
    const types = A.__drain().map(x => JSON.parse(x).t);
    if(!types.includes('sched')) throw new Error('the first start must still be sched: ' + JSON.stringify(types));
  });

  // Control transitions (sched/rst) now carry no redundancy of their own AND are repeated
  // 2-3x by the sender (neither transport guarantees delivery), so the receiver MUST act on
  // each epoch exactly once. A second copy re-triggering beginOnlineDuel would reset a level
  // already running -- the very hang/desync the redundancy is meant to prevent.
  check('a repeated sched/rst is deduped by epoch (reliable-control repeats are idempotent)', () => {
    const B = mk(B_ID);
    B.__ctlSetup();
    B.__deliverCtl('sched', 0);
    if(B.__ctlBeginsN() !== 1) throw new Error('first sched did not start: ' + B.__ctlBeginsN());
    B.__deliverCtl('sched', 0);                                   // a repeat of the SAME epoch
    if(B.__ctlBeginsN() !== 1) throw new Error('a duplicate sched restarted the level: ' + B.__ctlBeginsN());
    B.__deliverCtl('rst', 1);                                     // a genuine next-epoch start
    if(B.__ctlBeginsN() !== 2) throw new Error('a new-epoch rst did not start: ' + B.__ctlBeginsN());
    B.__deliverCtl('rst', 1); B.__deliverCtl('rst', 1);           // and ITS repeats
    if(B.__ctlBeginsN() !== 2) throw new Error('a duplicate rst restarted a running level: ' + B.__ctlBeginsN());
  });

  // Relay outbound coalesce: a local steer POSTs an `in` immediately, so on a 200-400ms
  // relay RTT a key burst would pile up as concurrent fetches (and trip the rate cap).
  // Each `in` carries the whole redundant log, so newer strictly supersedes older: keep ONE
  // POST in flight and let the latest win the slot -- nothing is lost, the rate self-limits.
  check('relay outbound coalesces to one in-flight, latest `in` wins the slot', () => {
    const B = mk(B_ID);
    B.__relaySetup();
    B.__relaySend({ t:'in', n:1 });
    B.__relaySend({ t:'in', n:2 });
    B.__relaySend({ t:'in', n:3 });
    if(B.__fetchCount() !== 1) throw new Error('expected exactly one in-flight POST, got ' + B.__fetchCount());
    if(B.__pendingN() !== 3) throw new Error('the latest `in` must win the coalesce slot, got ' + B.__pendingN());
  });

  // The APCu hub answers 429 "store full, resend" when its shared memory is momentarily full:
  // the input was REFUSED, not delivered, and a dropped input is exactly what desyncs relay
  // into the burst. So the pump must re-slot and resend it -- NOT drop it like the back-off
  // 429s (rate limit / backlog full), which would hot-loop against a "slow down".
  await acheck('relay store-full 429 resends the refused input instead of dropping it', async () => {
    const B = mk(B_ID);
    B.__relayFullThenOk();
    B.__relaySend({ t:'in', n:7 });
    await new Promise(r => setTimeout(r, 40));   // let the 20ms-paced resend fire
    if(B.__fetchCount() < 2) throw new Error('the refused input was not resent, fetches=' + B.__fetchCount());
    if(B.__pendingN() !== null) throw new Error('after a successful resend the slot must be empty, got ' + B.__pendingN());
  });

  console.log(results.join('\n'));
  console.log('\nNET-HANDSHAKE PASSED');
} catch (e) {
  console.log(results.join('\n'));
  console.log('\nNET-HANDSHAKE FAIL: ' + (e && e.stack || e));
  process.exit(1);
}
})();
