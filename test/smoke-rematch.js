// A rematch is a NEW match on the server: every start mints a match id and two attestation
// secrets, and a side's secret rides only its own start answer. The host asks when both agreed
// (its ask mints the match); the joiner asks for ITS identity when the rematch go lands, on the
// (epoch, reason) the host settled, with the played identity dropped first. A joiner attesting
// the new match with the previous match's identity is what the server reads as tampering (it
// freezes the instance). Drives both roles through the real handlers against a stubbed
// start.php that mints per (epoch, reason): the early answer (seeded by the begin), the late
// answer (seeded into the running core), and a refused answer (soft: unattested, never ended).
// Run: node test/smoke-rematch.js
const { runInGame } = require('./harness');

const DRIVER = `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const log = m => R.steps.push(m);
  globalThis.__async = (async () => {
    try {
      const settle = () => new Promise(r => setTimeout(r, 0));
      const sent = [];
      const OLD_MID = 'f'.repeat(32), OLD_SEC = 'e'.repeat(32);
      function sess(role){
        _netSess = _netMkSess('00ff00aa', role); _netSess.game = true;
        _netSess.dc = { readyState:'open', send:(x)=>sent.push(x), close(){} };
        _netSess.epoch = 0; _netSess.ctlEpoch = 0; _netSess.mid = OLD_MID; _netSess.secret = OLD_SEC;
        _wsClaimReset(OLD_MID, OLD_SEC, ['00ff00aa', getPlayerId()], {});   // the played match's core identity
        sent.length = 0; return _netSess;
      }
      const sentTypes = () => sent.map(x => { try { const o = JSON.parse(x); return (o.a ? 'echo:' : '') + o.t; } catch (e) { return '?'; } }).join(' ');   // an echo (a:1) is the peer's packet, not ours
      const go = (startPts) => JSON.stringify({ t:'go', why:'rematch', seed:0xBEEF, startPts, epoch:1, lvl:1, sk:1, bth:0 });   // sk: plays for keeps, so the handle is kept
      // The server: one settled start per (epoch, reason), minting a match id and two secrets on
      // the first ask; the caller gets its own side's secret. Answers can be held back (gate) or
      // refused (refuse).
      _netOk = () => true; _netGate = async () => {}; _netSync = { ofs:0, rtt:50, at:Date.now() };
      const posts = [], starts = {}; let mintN = 0, gate = null, refuse = false;
      _netPostRes = async (path, body) => {
        posts.push({ path, body: JSON.parse(JSON.stringify(body)), role: _netSess && _netSess.role });
        if(path !== '/api/start.php') return { status:200, json:{ ok:true } };
        if(refuse) return { status:500, json:null, err:'boom' };
        const k = body.epoch + ':' + body.reason;
        if(!starts[k]){ mintN++; starts[k] = { start_pts: netPts() + 1000, mid: ('m' + mintN).padEnd(32, '0'), sec_a: ('a' + mintN).padEnd(32, '0'), sec_b: ('b' + mintN).padEnd(32, '0') }; }
        const st = starts[k], own = _netSess.role === 'host' ? st.sec_a : st.sec_b;
        const ans = { status:200, json:{ ok:true, start_pts: st.start_pts, now: netPts(), mid: st.mid, secret: own } };
        if(gate) await gate;
        return ans;
      };
      const asks = role => posts.filter(p => p.path === '/api/start.php' && p.role === role);
      phase = 'duelOver'; inGame = true;

      // HOST: PLAY AGAIN on both sides -> one ask with the bumped epoch and reason rematch, the
      // new id and its own secret adopted, the burst runs. Unchanged path, pinned as the anchor.
      let s = sess('host');
      netAgain();
      _netHandleMsg(JSON.stringify({ t:'req', why:'again', epoch:0 }));
      if(s.epoch !== 1) throw 'host epoch after both agreed: ' + s.epoch;
      await settle();
      if(asks('host').length !== 1 || asks('host')[0].body.reason !== 'rematch' || asks('host')[0].body.epoch !== 1) throw 'host ask: ' + JSON.stringify(asks('host').map(p => p.body));
      if(s.mid !== starts['1:rematch'].mid || s.secret !== starts['1:rematch'].sec_a) throw 'host identity after the answer: ' + s.mid + ' / ' + s.secret;
      if(sentTypes().indexOf('bs') < 0) throw 'the host must run the boundary burst after its answer, sent: ' + sentTypes();
      _netTeardown();
      log('host: both agreed -> epoch 1 rematch asked, new id + own secret adopted, burst runs');

      // JOINER, EARLY ANSWER: both agreed does NOT make it ask (the host owns the start); the
      // rematch go does: the played identity is dropped at once, the ask carries the go's epoch
      // and reason rematch, reads the settled start (no second mint), adopts the same id and ITS
      // OWN secret, nudges no clock and ships no go. The begin, still pending, then seeds it.
      s = sess('peer'); simTick = 0; simNow = 0;
      netAgain();
      _netHandleMsg(JSON.stringify({ t:'req', why:'again', epoch:0 }));
      await settle();
      if(asks('peer').length !== 0) throw 'the joiner must not ask on the agreement: ' + JSON.stringify(asks('peer').map(p => p.body));
      if(s.mid !== OLD_MID) throw 'the agreement alone must not touch the identity';
      const ofs0 = _netSync.ofs;
      _netHandleMsg(go(netPts() + 5000));   // tick 0 well ahead: the begin stays armed
      if(s.mid !== '' || s.secret !== '') throw 'the rematch go must drop the played identity at once';
      if(!s.beginFn) throw 'the begin must still be pending';
      await settle();
      if(asks('peer').length !== 1 || asks('peer')[0].body.reason !== 'rematch' || asks('peer')[0].body.epoch !== 1) throw 'joiner ask: ' + JSON.stringify(asks('peer').map(p => p.body));
      if(mintN !== 1) throw 'the joiner must read the settled start, not mint again: mints=' + mintN;
      if(s.mid !== starts['1:rematch'].mid) throw 'joiner must adopt the same match id: ' + s.mid;
      if(s.secret !== starts['1:rematch'].sec_b) throw 'joiner must adopt its OWN secret: ' + s.secret;
      if(_netSync.ofs !== ofs0) throw 'the identity ask must not nudge the clock';
      if(sentTypes().split(' ').indexOf('go') >= 0) throw 'the joiner never authors a go: ' + sentTypes();
      if(_wsMid !== OLD_MID) throw 'before the begin the core still attests the old match: ' + _wsMid;
      _netFireBegin(s);
      if(_wsMid !== starts['1:rematch'].mid || _wsSec !== starts['1:rematch'].sec_b) throw 'the begin must seed the new identity: ' + _wsMid + ' / ' + _wsSec;
      if(_wsIds[0] !== '00ff00aa' || _wsIds[1] !== getPlayerId()) throw 'seeded ids must be in sim index order (host first): ' + _wsIds.join(',');
      if(_netSess !== s) throw 'the joiner session must survive its ask';
      _netTeardown();
      log('joiner, early answer: asks on the go with its epoch + reason, reads the settled start, adopts its own secret, the begin seeds it');

      // JOINER, LATE ANSWER: tick 0 is now, so the begin fires on the go and seeds the empty
      // identity (nothing attests wrongly); the answer then seeds the real one into the running core.
      s = sess('peer'); simTick = 0; simNow = 0;
      let release = null; gate = new Promise(r => { release = r; });
      _netHandleMsg(go(netPts()));
      if(s.beginFn) throw 'a past tick 0 must begin at once';
      if(phase !== 'duelReady' && phase !== 'duel') throw 'the rematch must have begun, phase=' + phase;
      if(_wsMid !== '' || _wsSec !== '') throw 'a begin before the answer must seed an EMPTY identity, got ' + _wsMid + ' / ' + _wsSec;
      await settle();
      if(s.mid !== '') throw 'the held answer must not have landed yet';
      release(); gate = null;
      await settle();
      if(s.mid !== starts['1:rematch'].mid || s.secret !== starts['1:rematch'].sec_b) throw 'late answer not adopted: ' + s.mid;
      if(_wsMid !== starts['1:rematch'].mid || _wsSec !== starts['1:rematch'].sec_b) throw 'the late identity must be seeded into the running core: ' + _wsMid + ' / ' + _wsSec;
      _netTeardown();
      log('joiner, late answer: the begin seeds an empty identity, the answer seeds the real one into the running core');

      // JOINER, REFUSED ANSWER: soft. The match runs unattested on this side; the session lives.
      s = sess('peer'); simTick = 0; simNow = 0; refuse = true;
      _netHandleMsg(go(netPts()));
      await settle();
      if(_netSess !== s) throw 'a refused identity ask must never end the session';
      if(s.mid !== '' || _wsMid !== '') throw 'a refused identity must leave the rematch unattested, got ' + s.mid + ' / ' + _wsMid;
      if(_netDbg.sigLog[0].indexOf('rematch identity not issued') < 0) throw 'the refusal must be logged: ' + _netDbg.sigLog[0];
      refuse = false; _netTeardown(); inGame = false; phase = 'menu';
      log('joiner, refused answer: unattested, logged, the session survives');
      R.ok = true;
    } catch (e) { R.err = String(e && e.stack || e); }
  })();
})();
`;

(async () => {
    const S = runInGame(DRIVER);
    const R = S.__R;
    try { await S.__async; } catch (e) { if (R) R.err = String(e && e.stack || e); }
    if (R && R.steps) console.log(R.steps.join('\n'));
    if (!R || R.err) { console.log('\nSMOKE-REMATCH FAIL: ' + (R ? R.err : 'no result')); process.exit(1); }
    if (!R.ok) { console.log('\nSMOKE-REMATCH FAIL: the block did not finish'); process.exit(1); }
    console.log('\nSMOKE-REMATCH PASSED');
    process.exit(0);
})();
