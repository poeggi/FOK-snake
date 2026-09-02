// Duel sim rules that must match single player and stay stable across respawns.
// Two regressions guarded here:
//   A) SPEED ROUND is a property of the LEVEL: rolled once when a new level opens,
//      never re-rolled on a respawn -- a level with several deaths must not get several
//      1-in-10 chances. Long-run rate stays ~10% per NEW level (level > 1).
//   B) FRAGILE barricades are crushable in a duel exactly as in single player: a duel
//      snake that ran into a fragile bar used to DIE; it must break through. Solid bars
//      stay lethal. A paired unit breaks as one.
const { runTest } = require('./harness');

const driver = `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const A = (c,m)=>{ if(!c) throw m; };
  try {
    // ---- A) speed round is per-new-level, stable across respawns ----
    startDuel(20260823);
    let lvlOn=-1, lvlOff=-1;
    for(let L=2; L<=600 && (lvlOn<0||lvlOff<0); L++){
      level=L; _duelBeginLevel(true);
      if(_speedRound){ if(lvlOn<0) lvlOn=L; } else if(lvlOff<0) lvlOff=L;
    }
    A(lvlOn>0, 'no speed-round level found in 2..600');
    A(lvlOff>0, 'no non-speed level found in 2..600');
    // a speed round stays ON across many respawns (reseed=false)
    level=lvlOn; _duelBeginLevel(true); A(_speedRound===true, 'expected speed round on at level '+lvlOn);
    for(let k=0;k<40;k++){ _duelBeginLevel(false); A(_speedRound===true, 'speed round DROPPED on respawn '+k+' (level '+lvlOn+')'); }
    // a normal level stays OFF across many respawns
    level=lvlOff; _duelBeginLevel(true); A(_speedRound===false, 'expected no speed round at level '+lvlOff);
    for(let k=0;k<40;k++){ _duelBeginLevel(false); A(_speedRound===false, 'speed round APPEARED on respawn '+k+' (level '+lvlOff+')'); }
    R.steps.push('speed round stable across respawns (on@L'+lvlOn+', off@L'+lvlOff+')');
    // long-run rate ~10% per NEW level (guards the fix did not disable speed rounds)
    let on=0,n=0; for(let L=2; L<=501; L++){ level=L; _duelBeginLevel(true); if(_speedRound) on++; n++; }
    const rate=on/n; A(rate>=0.04 && rate<=0.18, 'speed-round rate off band: '+rate.toFixed(3));
    R.steps.push('speed round rate over '+n+' new levels = '+(rate*100).toFixed(1)+'%');

    // ---- B) fragile bars crush in a duel (parity with single player); solid stay lethal ----
    const setupHit = (barFields)=>{
      startDuel(777);
      gem=null; heart=null; powerPellet=null; _powerMode=false;
      phase='duel'; phaseAt=0; spawnAt=0;
      const now=100000;
      const P=players[0], H=P.snake[0];
      const tgt={ x:(H.x+P.dir.x+COLS)%COLS, y:(H.y+P.dir.y+ROWS)%ROWS };
      bars=[ Object.assign({x:tgt.x,y:tgt.y}, barFields(tgt)) ]; _barsV++;
      P.stepAccum=2; players[1].stepAccum=0;
      return { P, tgt, now, livesBefore:P.lives };
    };
    // fragile -> crush through and survive
    {
      const s=setupHit(()=>({fragile:true}));
      duelStep(s.now);
      A(players[0].alive!==false, 'duel snake DIED on a fragile bar (bug B)');
      A(players[0].lives===s.livesBefore, 'duel snake lost a life on a fragile bar (bug B)');
      A(phase==='duel', 'phase changed after a fragile crush: '+phase);
      A(!bars.some(b=>b.x===s.tgt.x&&b.y===s.tgt.y), 'fragile bar not removed on crush');
      A(players[0].snake[0].x===s.tgt.x && players[0].snake[0].y===s.tgt.y, 'snake did not advance onto the crushed cell');
    }
    // solid -> lethal (regression: we did not make everything crushable)
    {
      const s=setupHit(()=>({fragile:false}));
      duelStep(s.now);
      A(players[0].lives===s.livesBefore-1 || players[0].alive===false, 'solid bar was NOT lethal in a duel');
    }
    // paired fragile unit breaks as one (both cells removed)
    {
      startDuel(777);
      gem=null; heart=null; powerPellet=null; _powerMode=false;
      phase='duel'; phaseAt=0; spawnAt=0; const now=100000;
      const P=players[0], H=P.snake[0];
      const tgt={ x:(H.x+P.dir.x+COLS)%COLS, y:(H.y+P.dir.y+ROWS)%ROWS };
      const sec={ x:(tgt.x+1)%COLS, y:tgt.y };
      bars=[ {x:tgt.x,y:tgt.y,fragile:true,pairEnd:{x:sec.x,y:sec.y}}, {x:sec.x,y:sec.y,fragile:true,paired:true} ]; _barsV++;
      P.stepAccum=2; players[1].stepAccum=0;
      duelStep(now);
      A(players[0].alive!==false, 'duel snake died on a paired fragile unit');
      A(!bars.some(b=>b.x===tgt.x&&b.y===tgt.y), 'paired base not removed');
      A(!bars.some(b=>b.x===sec.x&&b.y===sec.y), 'paired extension not removed');
    }
    R.steps.push('fragile bars crush in duel (parity), solid lethal, pairs break as one');

    // ---- C) dirQueue registration: judge-vs-tail below the cap, pop-then-judge at it ----
    // The newest intent always wins (_dirEnqueue): at a FULL queue a new input revokes the
    // not-yet-executed tail, then takes the normal judging against the remaining tail --
    // perpendicular replaces it, same/reverse just cancels it. One rule, classic == duel.
    const DIRS={U:{x:0,y:-1},D:{x:0,y:1},L:{x:-1,y:0},R:{x:1,y:0}};
    const qs=(dq)=>dq.map(v=>v.x===1?'R':v.x===-1?'L':v.y===1?'D':'U').join('');
    const run=(mode, seq)=>{   // heading up, empty queue; feed seq, return the queue as a string
      if(mode==='duel'){
        startDuel(777); const P=players[0]; P.dir={x:0,y:-1}; P.dirQueue.length=0;
        for(const k of seq) simCommand({t:'dir', p:0, dir:{x:DIRS[k].x,y:DIRS[k].y}});
        return qs(players[0].dirQueue);
      }
      startGame(777,0); dir={x:0,y:-1}; dirQueue.length=0;
      for(const k of seq) simCommand({t:'dir', dir:{x:DIRS[k].x,y:DIRS[k].y}});
      return qs(dirQueue);
    };
    const CASES=[
      ['UDRRLU','RU', 'below cap: same/reverse-of-anchor rejected, perpendicular queues'],
      ['RURL',  'RUL','full + perpendicular-to-new-tail: tail replaced (Ex3)'],
      ['LDRD',  'LD', 'full + same-as-new-tail: tail revoked, slot empty (Ex2)'],
      ['LDRU',  'LD', 'full + reverse-of-new-tail: tail revoked, slot empty'],
      ['RURR',  'RUR','full + repeat of the tail: harmless (pop + re-register)'],
    ];
    for(const [seq,want,what] of CASES) for(const mode of ['duel','classic']){
      const got=run(mode,seq);
      A(got===want, 'dirQueue ['+mode+'] '+what+': fed '+seq+' want '+want+' got '+got);
    }
    R.steps.push('dirQueue: newest intent wins at the cap (replace/cancel), classic == duel');

    R.ok=true;
  } catch(e){ R.err=String(e && e.stack || e); }
})();
`;
runTest('SIM-DUEL', driver);
