// The heart cap and the item stakes are PER-MATCH parameters, negotiated on the wire and
// constant for the match's lifetime. An ordinary duel and a tournament final run at
// START_LIVES; tournament round and knockout matches run at 2. Stakes off means a steal is
// real on the board and nothing leaves the room.
//
// The point of the design, and what this suite pins down:
//   * ONE sim. The cap changes a number the existing rules already read (p.lives against a
//     limit); it does not add a second duel implementation. Stakes off is likewise NOT done
//     by emptying the worn lists -- that would change the SIM, so the mechanic would differ
//     between single player, local 1:1 and online 1:1. It suppresses PERSISTENCE only.
//   * The cap is CONFIG, not agreed state: it rides the go, both sides adopt one
//     host-authored number before tick 0, and it stays out of the lockstep hash -- which is
//     why the recorded duel golden does not move. Section F asserts exactly that, and the
//     H2 lane below then gives the 2-heart rules a golden of their own.
//   * A cap off the wire is untrusted: anything outside 1..START_LIVES reads as the default,
//     so a malformed or absent hm can never hand a player extra lives.
//   * STAKES are the same kind of parameter and ride the same packet: one host-authored bit,
//     adopted before tick 0, absent reading as OFF. They cannot be left to each side to work
//     out for itself -- a disagreement is silent on both screens, and the only place it ever
//     surfaces is the item registry, as gains nobody corroborated.
//   * P2P-ONLY. A tournament match and every spectator link refuse the deprecated server
//     relay, at all three of its entry points.
// Run: node test/duel-hearts.js
const fs = require('fs');
const path = require('path');
const { runTest } = require('./harness');

// Recorded from the first green run; update ONLY intentionally (a deliberate rule change to
// the 2-heart lane), never to paper over a refactor. Its companion GOLDEN_DUEL in
// sim-determinism.js covers the default 3-heart lane and must NOT move when this one does.
const GOLDEN_DUEL_H2 = '78e8513a:7575';

// ---- static guard: the match parameters ride EVERY go -------------------------------
// The go is the one timeline opener, authored in two places (the match/rematch start and the
// boundary opener). The receive handler adopts hm and sk from whichever one arrives, so a
// builder that forgot a field would silently reset a 2-heart match to 3 at the next level
// boundary, or drop a staked match to unstaked halfway through. The boundary builder is
// driven for real in section G; this catches the other one, which sits behind an awaited
// server round trip that a synchronous suite cannot reach.
const NS = fs.readFileSync(path.join(__dirname, '..', 'js', 'net-session.js'), 'utf8');
const GO_FIELDS = ['hm', 'sk'];
const builders = NS.match(/\{\s*t:'go',[^}]*\}/g) || [];
const missing = builders.map(g => [g, GO_FIELDS.filter(f => !new RegExp('\\b' + f + '\\s*:').test(g))])
                        .filter(x => x[1].length);
if (builders.length < 2 || missing.length) {
    console.log('DUEL-HEARTS FAIL: ' + (builders.length < 2
        ? 'expected 2 go builders in net-session.js, found ' + builders.length
        : missing.length + ' go builder(s) are missing a match parameter:\n'
          + missing.map(x => 'no ' + x[1].join('/') + ' in: ' + x[0]).join('\n')));
    process.exit(1);
}
console.log('go builders carrying ' + GO_FIELDS.join(' + ') + ': ' + builders.length + '/' + builders.length);

const driver = `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const GOLDEN_DUEL_H2 = ${JSON.stringify(GOLDEN_DUEL_H2)};
  const A = (c,m)=>{ if(!c) throw m; };
  const FNV = (h, str)=>{ for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619); } return h; };
  try {
    // ---- A) the cap is adopted from the startDuel command, and clamped ----
    const cap = (h)=>{ simCommand(h===undefined ? {t:'startDuel', seed:777, net:true}
                                                : {t:'startDuel', seed:777, net:true, hearts:h});
                       return _duelHeartsMax; };
    A(cap(2)===2, 'a 2-heart match did not adopt its cap');
    A(cap(1)===1, 'a 1-heart match did not adopt its cap');
    A(cap(START_LIVES)===START_LIVES, 'a full-cap match did not adopt its cap');
    // Untrusted input: absent, zero, negative, over the ceiling -- all read as the default.
    for(const bad of [undefined, 0, -1, START_LIVES+1, 99, NaN, null])
      A(cap(bad)===START_LIVES, 'a cap of '+String(bad)+' was not rejected: got '+_duelHeartsMax);
    R.steps.push('cap: adopted 1..'+START_LIVES+' from the startDuel command, anything else reads as '+START_LIVES);

    // ...and it is the number both snakes OPEN on.
    simCommand({t:'startDuel', seed:777, net:true, hearts:2});
    A(players[0].lives===2 && players[1].lives===2, 'a 2-heart match opened on '+players.map(p=>p.lives).join('/'));
    simCommand({t:'startDuel', seed:777, net:true});
    A(players[0].lives===START_LIVES && players[1].lives===START_LIVES, 'an ordinary duel no longer opens on '+START_LIVES);
    R.steps.push('both snakes open on the match cap (2 -> 2/2, ordinary -> '+START_LIVES+'/'+START_LIVES+')');

    // ---- B) the cap governs the heart PICKUP ----
    const grab = (c, lives)=>{
      simCommand({t:'startDuel', seed:777, hearts:c});
      gem=null; powerPellet=null; _powerMode=false; bars=[]; _barsV++;
      phase='duel'; phaseAt=0; spawnAt=0;
      const P=players[0], H=P.snake[0];
      P.lives = lives;
      const tgt={ x:(H.x+P.dir.x+COLS)%COLS, y:(H.y+P.dir.y+ROWS)%ROWS };
      heart={ x:tgt.x, y:tgt.y }; heartAt=0; heartIsEarly=false;
      P.stepAccum=2; players[1].stepAccum=0;
      duelStep(100000);
      A(heart===null, 'the heart fixture was not picked up (cap '+c+', lives '+lives+')');
      return P.lives;
    };
    A(grab(2,1)===2, 'a heart below the 2-heart cap did not hand a life back');
    A(grab(2,2)===2, 'a heart AT the 2-heart cap handed out a third life');
    A(grab(START_LIVES,2)===START_LIVES, 'a heart below the default cap did not hand a life back');
    A(grab(START_LIVES,START_LIVES)===START_LIVES, 'a heart at the default cap went over it');
    R.steps.push('heart pickup: caps at the match cap, at 2 and at '+START_LIVES);

    // ---- C) the contested-heart SPAWN gate reads the cap too ----
    // "Rolled only when it can matter": at the cap for EVERYBODY there is nothing to hand
    // back, so the roll must not even be taken. Reading START_LIVES here would keep spawning
    // hearts nobody in a 2-heart match can use.
    const spawns = (c, lives)=>{
      simCommand({t:'startDuel', seed:4242, hearts:c});
      level=4; players[0].lives=lives; players[1].lives=lives;
      let n=0;
      for(let k=0;k<400;k++){ gem=null; heart=null; powerPellet=null; _duelSpawnGem(); if(heart) n++; }
      return n;
    };
    A(spawns(2,2)===0, 'a contested heart spawned with both players AT the 2-heart cap');
    A(spawns(2,1)>0, 'no contested heart spawned in 400 gem spawns below the 2-heart cap');
    A(spawns(START_LIVES,START_LIVES)===0, 'a contested heart spawned with both players at the default cap');
    A(spawns(START_LIVES,2)>0, 'no contested heart spawned in 400 gem spawns below the default cap');
    R.steps.push('contested-heart spawn gate: silent at the cap, live below it, at 2 and at '+START_LIVES);

    // ---- D) the level-finisher's heart back caps too ----
    const finish = (c, lives)=>{
      simCommand({t:'startDuel', seed:777, hearts:c});
      heart=null; powerPellet=null; _powerMode=false; bars=[]; _barsV++;
      phase='duel'; phaseAt=0; spawnAt=0; gemsDone=GEMS_PER_LEVEL-1;
      const P=players[0], H=P.snake[0];
      P.lives = lives;
      gem={ x:(H.x+P.dir.x+COLS)%COLS, y:(H.y+P.dir.y+ROWS)%ROWS, tier:0 };
      P.stepAccum=2; players[1].stepAccum=0;
      duelStep(100000);
      A(phase==='levelDone', 'the level-finisher fixture did not finish the level: '+phase);
      return P.lives;
    };
    A(finish(2,1)===2, 'the level finisher did not earn a heart back below the 2-heart cap');
    A(finish(2,2)===2, 'the level finisher went over the 2-heart cap');
    A(finish(START_LIVES,START_LIVES)===START_LIVES, 'the level finisher went over the default cap');
    R.steps.push('level-finisher heart back: caps at the match cap, at 2 and at '+START_LIVES);

    // ---- E) the match is over after the cap's worth of deaths ----
    // The rule itself (lives <= 0) is untouched; the cap is what decides when it trips.
    const suicide = ()=>{
      gem=null; heart=null; powerPellet=null; _powerMode=false; bars=[]; _barsV++;
      phase='duel'; phaseAt=0; spawnAt=simNow-SPAWN_PROTECT*2;   // past the post-spawn immunity
      const P=players[0];
      P.snake=[{x:5,y:5},{x:5,y:6},{x:6,y:6},{x:6,y:5}]; P.dir={x:0,y:1}; P.dirQueue=[]; P.alive=true;
      P.stepAccum=2; players[1].stepAccum=0;
      duelStep(simNow);
      A(phase==='dying', 'the suicide fixture did not kill anybody: '+phase);
      phaseAt = simNow - DEATH_DUR;   // let the death beat play out on the next tick
      update();
    };
    const outAfter = (c)=>{
      simCommand({t:'startDuel', seed:0xBEEF, hearts:c});
      for(let d=1; d<=c+1; d++){
        suicide();
        if(duelWinner>=0) return d;
      }
      return -1;
    };
    A(outAfter(2)===2, 'a 2-heart match did not end on the SECOND death (ended after '+outAfter(2)+')');
    A(duelWinner===1, 'the survivor did not win the 2-heart match: winner '+duelWinner);
    A(outAfter(START_LIVES)===START_LIVES, 'an ordinary duel no longer ends on the '+START_LIVES+'rd death');
    R.steps.push('match over: after exactly the cap\\'s worth of deaths (2 and '+START_LIVES+')');

    // ---- F) the cap is CONFIG: mirrored through the snapshot, out of the lockstep hash ----
    // The renderer draws the heart row against the cap the match is running, so the worker
    // home has to see it -- but the two clients adopt it from the same go before tick 0, so
    // it is never in dispute and must stay out of the agreement. That is what keeps the
    // recorded GOLDEN_DUEL byte-identical across this whole change.
    A(RB_HASH_DUEL.indexOf('_duelHeartsMax')<0,
      'the negotiated cap entered the lockstep hash -- the duel golden would move and every ordinary duel would re-agree a constant');
    simCommand({t:'startDuel', seed:777, net:true, hearts:2});
    const snap = simSnapshot();
    A(snap._duelHeartsMax===2, 'the cap does not ride the worker snapshot: the HUD would draw '+START_LIVES+' hearts in a 2-heart match');
    // A snapshot is a wire surface too (the worker boundary and the resync both carry it), so
    // it gets the same clamp as the go.
    snap._duelHeartsMax = 99; simApply(snap);
    A(_duelHeartsMax===START_LIVES, 'a poisoned snapshot cap survived simApply: '+_duelHeartsMax);
    snap._duelHeartsMax = 2; simApply(snap);
    A(_duelHeartsMax===2, 'a valid snapshot cap did not survive simApply');
    R.steps.push('cap rides the snapshot (clamped on the way in) and stays out of RB_HASH_DUEL');

    // Leaving the duel forgets it: the next match negotiates its own, and a local duel that
    // follows a 2-heart tournament match must not inherit the cap.
    simCommand({t:'phase', phase:'menu'});
    A(_duelHeartsMax===START_LIVES, 'the cap outlived the match: '+_duelHeartsMax);
    R.steps.push('leaving the duel resets the cap to '+START_LIVES);

    // ---- G) the wire: hm rides the boundary go, is adopted, and a preset mismatch kills ----
    globalThis.setTimeout = ()=>0;          // no retry/arm timers: this section is synchronous
    _netLiveStart = ()=>{}; _netRelayLoop = async ()=>{}; _netRequestStart = async ()=>{};
    _netArmBegin = ()=>{};                  // the begin is clock-driven; not what is on trial here
    _netTimeSync = async ()=>{};
    const mkSess = (role)=>{
      const out = [];
      _netSync = { ofs:0, rtt:1, at:Date.now() };
      _netSess = _netMkSess('ffffffff', role);
      _netSess.game = true; _netSess.pc = null; _netSess.startPts = Date.now();
      _netSess.dc = { readyState:'open', bufferedAmount:0, send(j){ out.push(JSON.parse(j)); }, close(){} };
      _netMarkRecv(_netSess);
      return out;
    };
    // HOST: every boundary it opens carries the cap it is running.
    _netBurstThenStart = (s, then)=> then(0);
    const hostOut = mkSess('host');
    _netSess.hearts = 2; _netSess.lvl = 4;
    _netOpenBoundary(_netSess, 'level');
    const go = hostOut.filter(m=>m.t==='go').pop();
    A(go, 'the host opened a boundary without shipping a go');
    A(go.hm===2, 'the boundary go does not carry the match cap: hm='+String(go.hm));
    R.steps.push('host: the boundary go carries hm ('+go.hm+')');

    // JOINER: adopts the host's number verbatim, however it got here.
    const joinGo = (hm, want)=>{
      const out = mkSess('peer');
      _netSess.heartsWant = (want===undefined) ? null : want;
      phase='lobby'; _netLb.msg='';   // a roles-sheet preset is applied before the match opens, so a refusal surfaces in the lobby
      const m = { t:'go', why:'level', seed:777, startPts:Date.now()+250, epoch:7, lvl:4, bth:0 };
      if(hm!==undefined) m.hm = hm;
      _netHandleMsg(JSON.stringify(m));
      return { sess:_netSess, echo: out.filter(o=>o.a===1 && o.t==='go').pop() };
    };
    let r = joinGo(2);
    A(r.sess && r.sess.hearts===2, 'the joiner did not adopt the go cap');
    A(r.echo && r.echo.hm===2, 'the echo verifier does not carry hm back, so the agreement is not byte-checked');
    A(joinGo(99).sess.hearts===START_LIVES, 'the joiner adopted an out-of-range cap off the wire');
    A(joinGo(undefined).sess.hearts===START_LIVES, 'a go with no hm did not read as the default cap');
    R.steps.push('joiner: adopts hm verbatim (clamped), and echoes it back for the byte-exact verifier');

    // A PRESET that the go contradicts is a protocol fault, not a difference to absorb: the
    // bracket would otherwise score a match the two clients did not play under the same rules.
    A(joinGo(2, 2).sess.hearts===2, 'a go matching the roles sheet was refused');
    const bad = joinGo(START_LIVES, 2);
    A(bad.sess===null || _netSess===null, 'a go contradicting the roles sheet was accepted');
    A(_netLb.msg==='MATCH SETUP MISMATCH', 'the setup mismatch did not surface: '+String(_netLb.msg));
    R.steps.push('a go that contradicts the roles sheet ends the match (MATCH SETUP MISMATCH)');

    // STAKES ride the same packet and are adopted the same way, and they need it more than the
    // cap does: a wrong cap shows up on both HUDs within one death, while a stakes
    // disagreement is invisible on both screens for the whole match -- the side that believes
    // they are on claims every gain the side that believes they are off will never attest to.
    const joinSk = (sk, want)=>{
      const out = mkSess('peer');
      _netSess.stakesWant = (want===undefined) ? null : want;
      phase='lobby'; _netLb.msg='';
      const m = { t:'go', why:'level', seed:777, startPts:Date.now()+250, epoch:7, lvl:4, bth:0, hm:2 };
      if(sk!==undefined) m.sk = sk;
      _netHandleMsg(JSON.stringify(m));
      return { sess:_netSess, echo: out.filter(o=>o.a===1 && o.t==='go').pop() };
    };
    const skOn = joinSk(1);
    A(skOn.sess && skOn.sess.stakes===true, 'the joiner did not adopt stakes-on from the go');
    A(skOn.echo && skOn.echo.sk===1, 'the echo verifier does not carry sk back, so the agreement is not byte-checked');
    A(joinSk(0).sess.stakes===false, 'the joiner did not adopt stakes-off from the go');
    // A minted session opens with stakes ON, so an ABSENT field is the one case where the go
    // has to overrule what the joiner already believed: an unstated stake is not one to play for.
    A(joinSk(undefined).sess.stakes===false, 'a go with no sk left the joiner on its own guess');
    R.steps.push('joiner: adopts stakes off the go (absent reads as off), and echoes it back');

    A(joinSk(0, false).sess.stakes===false, 'a go matching the roles sheet stakes was refused');
    const badSk = joinSk(1, false);
    A(badSk.sess===null || _netSess===null, 'a go contradicting the roles sheet stakes was accepted');
    A(_netLb.msg==='MATCH SETUP MISMATCH', 'the stakes mismatch did not surface: '+String(_netLb.msg));
    R.steps.push('a go whose stakes contradict the roles sheet ends the match too');

    // ---- H) stakes off: the mechanic plays, nothing leaves the room ----
    mkSess('host');
    _netSess.mid = 'M1'; _netSess.secret = 'S1'; _netSess.peer = 'bbbbbbbb';
    A(_duelClaimArgs(true).mid==='M1', 'an ordinary duel lost its registry match handle');
    _netSess.stakes = false;
    A(_duelClaimArgs(true).mid==='', 'stakes off left the match handle in place: duel-core would still open claims');
    A(_duelClaimArgs(true).sec==='S1', 'stakes off dropped the attestation secret as well as the handle');
    // The other half of persistence: the per-device wardrobe write-back.
    inGame = true;
    cfg.shopItems = { shades:true }; cfg.wornItems = { shades:true };
    const before = JSON.stringify([cfg.shopItems, cfg.wornItems]);
    _wsTransfer({ id:'shades', uid:'', from:0, to:1 });
    A(JSON.stringify([cfg.shopItems, cfg.wornItems])===before, 'stakes off still moved gear out of the wardrobe');
    _netSess.stakes = true;
    _wsTransfer({ id:'shades', uid:'', from:0, to:1 });
    A(!cfg.wornItems.shades, 'the wardrobe write-back stopped working with stakes ON');
    R.steps.push('stakes off: no claim handle, no wardrobe write-back; stakes on unchanged');

    // ---- I) P2P-ONLY: all three ways into the deprecated relay refuse ----
    netP2POnlySet(false);
    mkSess('host'); _netSess.game = false; _netSess.p2pOnly = true;
    _netRelayStart(_netSess);
    A(_netSess===null, 'a P2P-only session fell back to the server relay');
    // The latch covers the window BEFORE a session exists: the relay handshake mints its own,
    // so a per-session flag alone could never stop it.
    netP2POnlySet(true);
    _netSess = null; inGame = false;
    _netRelayOffer('bbbbbbbb', null);
    A(_netSess===null, 'the relay OFFER path built a session in p2p-only mode');
    _netRelayAnswer('bbbbbbbb', { seed:1, profile:null });
    A(_netSess===null, 'the relay ANSWER path built a session in p2p-only mode');
    // ...and with the latch off it still works: this is a refusal, not a removal.
    netP2POnlySet(false);
    mkSess('host'); _netSess.game = false; _netSess.p2pOnly = false;
    _netRelayStart(_netSess);
    A(_netSess && _netSess.relay===true, 'the relay fallback stopped working for an ordinary duel');
    _netSess = null;
    R.steps.push('p2p-only refuses all three relay entry points (offer, answer, fallback); ordinary duels still fall back');

    // ---- J) the 2-HEART LANE GOLDEN ----
    // The default lane's golden lives in sim-determinism.js and must not move for any of the
    // above. This is the same idea for the lane the tournament actually plays: three full
    // 2-heart matches, hashing the wire contract (RB_HASH_DUEL off _rbDuelSnap) every tick.
    const AX = [{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}];
    const cheb = (a,b)=>Math.max(Math.min((a.x-b.x+COLS)%COLS,(b.x-a.x+COLS)%COLS),
                                 Math.min((a.y-b.y+ROWS)%ROWS,(b.y-a.y+ROWS)%ROWS));
    const aimAt = (H,t)=>{
      const dx=((t.x-H.x+COLS+COLS/2)%COLS)-COLS/2, dy=((t.y-H.y+ROWS+ROWS/2)%ROWS)-ROWS/2;
      return (Math.abs(dx)>=Math.abs(dy) ? [{x:Math.sign(dx),y:0},{x:0,y:Math.sign(dy)}]
                                         : [{x:0,y:Math.sign(dy)},{x:Math.sign(dx),y:0}]).filter(d=>d.x||d.y);
    };
    function runH2Once(){
      let h = 2166136261>>>0, n = 0, ended = 0, ups = 0;
      let s = 909; const inp=()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
      const pilot = (p, ram)=>{
        const P=players[p], H=P.snake[0], foe=players[1-p];
        if(ram) return aimAt(H, foe.snake[0])[0] || null;
        const occ=new Set();
        for(const Q of players) for(const g of Q.snake) occ.add(g.x+','+g.y);
        for(const b of bars) if(!b.fragile) occ.add(b.x+','+b.y);
        let order = gem ? aimAt(H,gem) : [];
        if(inp()<0.02) order=[AX[Math.floor(inp()*4)]].concat(order);
        order=order.concat([P.dir],AX);
        for(const d of order){
          if(d.x===-P.dir.x&&d.y===-P.dir.y) continue;
          const t={x:(H.x+d.x+COLS)%COLS,y:(H.y+d.y+ROWS)%ROWS};
          if(occ.has(t.x+','+t.y)) continue;
          if(foe.alive!==false && cheb(t,foe.snake[0])<=2) continue;
          return d;
        }
        return null;
      };
      for(let m=0; m<3; m++){
        simCommand({ t:'startDuel', seed:(0x2EA47 ^ Math.imul(m+1, 0x9E3779B1))>>>0, hearts:2,
                     ws:[['shades','cylinder'],['crown','eyepatch']] });
        let ram=-1;
        for(let i=0; i<4000 && duelWinner<0; i++){
          if(ram<0 && i>=120) ram=i;
          const ramming = i<ram+30;
          for(let p=0; p<2; p++){
            const P = players[p]; if(!P || P.alive===false) continue;
            const d = pilot(p, ramming && p===1); if(d) simCommand({t:'dir', p, dir:d});
            if(inp()<0.03) simCommand(P.boosting ? {t:'boostend', p} : {t:'boost', p, dir:P.dir});
          }
          if(phase==='levelDone' && levelDoneWaiting){ simCommand({t:'advance'}); ups++; }
          update();
          const ds = _rbDuelSnap();
          h = FNV(h, RB_HASH_DUEL.map(k=>JSON.stringify(ds[k]) || "u").join("|"));
          n++;
        }
        if(duelWinner>=0) ended++;
      }
      A(ended===3, 'the 2-heart lane left '+(3-ended)+' match(es) unfinished: the golden would only cover the opening');
      A(ups>=1, 'the 2-heart lane never crossed a level boundary: the golden misses the level rebuild');
      return (h>>>0).toString(16)+':'+n;
    }
    const g1=runH2Once(), g2=runH2Once();
    if(g1!==g2) throw '2-HEART LANE NON-DETERMINISTIC: '+g1+' != '+g2;
    if(GOLDEN_DUEL_H2==='__PENDING__') R.steps.push('2-heart lockstep hash='+g1+'  (record this as GOLDEN_DUEL_H2)');
    else if(g1!==GOLDEN_DUEL_H2) throw '2-heart lane changed vs golden: got '+g1+', expected '+GOLDEN_DUEL_H2;
    else R.steps.push('2-heart lane (per-tick RB_HASH_DUEL over 3 matches) matches golden ('+g1+')');

    R.ok=true;
  } catch(e){ R.err=String(e && e.stack || e); }
})();
`;
runTest('DUEL-HEARTS', driver);
