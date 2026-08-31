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
  // gameSteer only AUTHORS now (the wire send is rate-limited to one packet/tick, flushed by
  // netTickPre). These routing/determinism tests care about the record and its duel-relative
  // stamp, not the 1-tick send latency, so flush it here at once -- same packet netTickPre would
  // emit. The rate-limit contract itself is covered in smoke-net.
  globalThis.__steer = (d)=>{ gameSteer(0, d); if(_netInDirty){ _netSend({ t:'in', tk:_rbToWire(simTick), l:_rbSent }); _netInDirty = false; } };
  globalThis.__boost = (d)=>{ gameBoostStart(0, d); };   // grace-delayed (keyboard-style, now=false)
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
    __ctlBegins = 0;
    beginOnlineDuel = ()=>{ __ctlBegins++; };   // count begins; probe the wire, not the duel setup
    // EVERY server-authored start -- the first start and a rematch alike -- runs a short paced
    // clock-burst (bsync + a few 'bs') on timers before the host authors and ships its sched/rst.
    // Run those paced pings inline so the deferred start packet is on the wire when we drain, and
    // answer each one with a zero-offset return: there is no peer in this test, and an unanswered
    // burst is retried until the match ends (duel-sync.js owns that path). These tests are about
    // what the start SENDS, so the burst has to converge.
    const realST = setTimeout, realPing = _netBurstPing;
    globalThis.setTimeout = (fn)=>{ fn(); return -1; };
    _netBurstPing = (s)=>{ realPing(s); _netHandleMsg(JSON.stringify({ t:'bs', pts:netPts(), sq:0, mr:0, mn:NET_BURST_MIN })); };
    try { await _realReqStart(_netSess, reason); }
    finally { globalThis.setTimeout = realST; _netBurstPing = realPing; }
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
  // A HOST that has already opened a boundary: it shipped the start for that epoch and moved on.
  // ageMs backdates the ship so the in-flight grace (a boundary is briefly one-sided by design)
  // is past and a peer still behind counts as one that never got it.
  globalThis.__hostAfterStart = (epoch, ageMs)=>{
    _netSess = _netMkSess('ffffffff', 'host'); _netSess.game = true;
    _netSess.dc = { readyState:'open', send:(x)=>__wire.push(x), close(){} };
    _netSync = { ofs:0, rtt:1, at:Date.now() };
    _netSess.epoch = epoch|0;
    _rbEpoch = epoch|0;   // we already BEGAN that level: our tick base carries the new epoch too
    _netShipStart(_netSess, { t:'rst', seed:0xBEEF, startPts:netPts()-500, x10:false,
                              epoch:epoch|0, lvl:1, bth:0 });
    _netSess.lastStartAt -= (ageMs|0);
    __wire.length = 0;   // the original ship is not what these tests are looking for
  };
  globalThis.__peerPkt = (t, ep)=>{ _netHandleMsg(JSON.stringify({ t, ep, tk:0, l:[] })); };
  globalThis.__lastStartPts = ()=> _netSess.lastStart.startPts;
  globalThis.__reshipReset  = ()=>{ _netSess.reshipAt = 0; };
  // Post-suspend hard-snap probes: put the clock target gap ticks ahead of simTick.
  globalThis.__breakSetup = (gap)=>{
    _netSess = _netMkSess('ffffffff', 'host'); _netSess.game = true;
    _netSync = { ofs:0, rtt:1, at:Date.now() };
    inGame = true; simTick = 1000;
    _netSess.startPts = netPts() - (simTick + gap) * TICK_MS;
  };
  globalThis.__breakRecover = ()=> _netBreakRecover(_netSess);
  globalThis.__tickGap = ()=> Math.abs(Math.floor((netPts() - _netSess.startPts) / TICK_MS) - simTick);
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
  // The duel checks below start the two clients on WILDLY different free-running
  // simTick values (one idled in menus for minutes, one just opened the game): a
  // tick stamp is only meaningful relative to each client's own duel start, so every
  // convergence check also proves the stamps are duel-relative -- get that wrong and
  // each input is dropped as out-of-window and the sims diverge.

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
  // engaged on either sim yet, so it applies LIVE (no rewind) -- and both worlds stay
  // identical. This is why boost no longer costs rollbacks.
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
    // The rewind is batched: __recv only records the earliest late tick, and B's next netTickPre
    // does the single rollback (so a burst of packets costs one re-sim). It fires on the tick
    // below, not on delivery -- hence the rb assertion after B ticks, not before.
    A.__tick(60); B.__tick(30);        // both to tick 180; B's next netTickPre flushes the rewind
    if(!B.__rbDbg().rb) throw new Error('B did not rewind for an input that missed its step');
    if(A.__simTick() !== B.__simTick()) throw new Error('drove the two sims to different tick counts: test bug');
    if(A.__hashNow() !== B.__hashNow())
      throw new Error('the two clients diverged after a rewind');
  });

  // With ZERO inputs two sims MUST be bit-identical, so a desync there is the detector
  // lying. The snapshot hauls each device's leftovers from its OWN last single-player
  // game (snake, score, heart, _shimmerThreshold from localStorage...) because it
  // mirrors the sim into the worker, and startDuel never resets what the duel never
  // reads. Hashing those compared two players' single-player HISTORY and called the
  // difference a divergence. Fresh test clients cannot see it: this needs a past.
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

  // ...but a REAL divergence is still caught (the skip list is a scalpel), and the
  // authoritative-state packet REPAIRS it. Each client owns its own snake (its index),
  // so the peer's copy adopts it. Corrupt A's copy of the peer (index 1) snake, let B --
  // its owner -- emit a state packet, and A must re-converge after the settle.
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
    // divergence via A's periodic hash disagreeing with its ring. So A's h packets flow
    // to B; A's own st/rs are discarded, keeping B the clean reference. B's st then
    // reaches A, which adopts B's authoritative snake and rolls forward. Tick finely
    // and deliver promptly, like real 60Hz play.
    let repaired = false;
    for(let i = 0; i < 220 && !repaired; i++){
      B.__tick(1); B.__drain().forEach(p => A.__recv(p));
      A.__tick(1);
      A.__drain().forEach(p => { if(JSON.parse(p).t === 'h') B.__recv(p); });
      if(A.__hashNow() === B.__hashNow()) repaired = true;
    }
    if(!repaired) throw new Error('no re-converge. A.fix=' + A.__rbDbg().fix + ' A.desync=' + A.__rbDbg().desync);
  });

  // A restart that happens WHILE in game (rematch, level) must not be sent as 'sched':
  // the peer refuses that one when inGame, so only the sender would restart. This tests
  // what _netRequestStart SENDS -- the receiver was never the problem.
  await acheck('an in-game restart is sent as rst, not the first-start sched', async () => {
    const A = mk(A_ID);
    A.__duelStart(0xBEEF, 'host', 1000);
    A.__drain();
    await A.__reqStart('rematch', 1);
    const types = A.__drain().map(x => JSON.parse(x).t);
    if(types.includes('sched')) throw new Error('a rematch used sched: the peer ignores it while in game, so only one client restarts');
    if(!types.includes('rst')) throw new Error('a rematch sent no restart at all: ' + JSON.stringify(types));
  });

  await acheck('the FIRST start syncs the clock like any level (host bursts, ships sched+bth, begins once)', async () => {
    const A = mk(A_ID);
    A.__duelStart(0xBEEF, 'host', 1000);
    A.__drain();
    await A.__reqStart('first', 0);
    const pkts = A.__drain().map(x => JSON.parse(x));
    const types = pkts.map(p => p.t);
    if(!types.includes('sched')) throw new Error('the first start must still be sched (refused while inGame): ' + JSON.stringify(types));
    // The load-bearing assertion: the first start now opens the SAME bilateral clock burst every
    // level boundary does, instead of being the one path that shipped on two independent server syncs.
    if(!types.includes('bsync')) throw new Error('the first start must open the boundary burst (bsync), same as every level: ' + JSON.stringify(types));
    const sched = pkts.find(p => p.t === 'sched');
    if(!('bth' in sched)) throw new Error('the first-start sched must carry the burst offset bth (the joiner applies its half): ' + JSON.stringify(sched));
    if(A.__ctlBeginsN() !== 1) throw new Error('the host authors its own begin exactly once on the first start: ' + A.__ctlBeginsN());
  });

  await acheck('the FIRST-start joiner defers its begin to the host sched (no self-start)', async () => {
    const B = mk(B_ID);
    B.__duelStart(0xBEEF, 'peer', 3000);
    B.__drain();
    await B.__reqStart(undefined, 0);   // the joiner's dc.onopen calls _netRequestStart with NO reason
    // A joiner that self-began off its OWN request would skip the sched's bth nudge (the inGame gate
    // swallows it) and only half-apply the burst. It must instead wait for the host's sched/rst.
    if(B.__ctlBeginsN() !== 0) throw new Error('the joiner must NOT self-begin on the first start -- it defers to the host sched: ' + B.__ctlBeginsN());
    const types = B.__drain().map(x => JSON.parse(x).t);
    for(const t of ['sched', 'rst', 'start', 'bsync'])
      if(types.includes(t)) throw new Error('the joiner authored a start packet (' + t + '); only the host authors: ' + JSON.stringify(types));
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

  // A lost start is not a late boundary, it is a permanent split. The joiner's epoch has exactly
  // ONE writer -- the sched/rst handler -- so a start that never lands leaves it on the old epoch
  // for good: our gate refuses every tick packet it sends, its gate refuses every one of ours, and
  // its OK press re-asks with the same stale number forever. Neither warning fires (packets flow,
  // so silence never trips; the hash checks that would say OUT OF SYNC are what the gate drops),
  // so both boards just stop with nothing on screen. The host can SEE the stale epoch on every
  // packet, so it must re-serve the start rather than only drop.
  check('a joiner stuck an epoch behind is re-served the start, not silently dropped', () => {
    const A = mk(A_ID);
    A.__hostAfterStart(1, 3000);
    A.__peerPkt('in', 0);                       // the stuck joiner is still stamping the old epoch
    const rs = A.__drain().map(x => JSON.parse(x)).filter(p => p.t === 'rst');
    if(rs.length !== 1) throw new Error('a behind-epoch tick packet must re-serve the start, got ' + rs.length);
    if(rs[0].epoch !== 1) throw new Error('the re-serve must carry OUR current epoch: ' + JSON.stringify(rs[0]));
    if(rs[0].startPts !== A.__lastStartPts()) throw new Error('the re-serve must carry the ORIGINAL startPts -- a fresh one would put the joiner on a second, private timeline');
    // Rate-limited: the trigger is the peer's own 60/s stream, not a one-shot.
    for(let i = 0; i < 30; i++) A.__peerPkt('in', 0);
    if(A.__drain().length !== 0) throw new Error('the re-serve must be rate-limited, not one per refused packet');
    // The OK press path answers too: a reqlvl below our line is the same stuck joiner asking again.
    A.__reshipReset();
    A.__recv(JSON.stringify({ t:'reqlvl', epoch:0 }));
    if(A.__drain().filter(x => JSON.parse(x).t === 'rst').length !== 1) throw new Error('a behind-epoch reqlvl must re-serve the start');
  });

  // The flip side: a boundary IS legitimately one-sided while it is in flight (we bump the epoch,
  // burst, ship, and only then does the joiner adopt it). Packets from that window must not be
  // read as a loss, or every normal level transition would re-ship.
  check('a boundary still in flight does not re-serve (only a start that never landed does)', () => {
    const A = mk(A_ID);
    A.__hostAfterStart(1, 0);   // shipped just now: the joiner has not had time to adopt it
    for(let i = 0; i < 30; i++) A.__peerPkt('in', 0);
    if(A.__drain().length !== 0) throw new Error('a start still in flight must not be re-served');
  });

  // A sim frozen >600 ticks (~10s) behind the shared clock can never catch up, and the peer heard
  // nothing from us for far longer than RB_PERSIST_KILL_MS -- it dropped the pairing long ago, so
  // there is nothing left to resume against. End the match; a small, catch-up-able gap must NOT
  // fire (that is the normal ladder's job).
  check('a >600-tick timeline break ends the match; a small gap does not', () => {
    const A = mk(A_ID);
    A.__breakSetup(5000);
    if(A.__tickGap() < 600) throw new Error('setup: expected a >600-tick break, got ' + A.__tickGap());
    if(!A.__breakRecover()) throw new Error('a >600-tick break must end the match');
    if(A.__rcDbg().has) throw new Error('the session must be torn down after a >600-tick break');
    A.__breakSetup(120);
    if(A.__breakRecover()) throw new Error('a small gap (120t) must NOT end the match -- the catch-up ladder handles it');
  });

  console.log(results.join('\n'));
  console.log('\nNET-HANDSHAKE PASSED');
} catch (e) {
  console.log(results.join('\n'));
  console.log('\nNET-HANDSHAKE FAIL: ' + (e && e.stack || e));
  process.exit(1);
}
})();
