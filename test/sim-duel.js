// Duel sim rules that must match single player and stay stable across respawns.
// Two regressions guarded here:
//   A) SPEED ROUND is a property of the SPAWN: every spawn takes its own 1-in-10 draw,
//      a new level and a respawn after a death alike, so a level that came up hot cools
//      down again on the next death instead of staying hot until somebody finishes it.
//      Never on level 1; long-run rate stays ~10% whatever the spawn was.
//   B) FRAGILE barricades are crushable in a duel exactly as in single player: a duel
//      snake that ran into a fragile bar used to DIE; it must break through. Solid bars
//      stay lethal. A paired unit breaks as one.
// Section D covers the windswept-item steal: who loses what on a near miss, where it lands,
// who ends up wearing it, and that every bit of that rides the lockstep state.
const { runTest } = require('./harness');

const driver = `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const A = (c,m)=>{ if(!c) throw m; };
  try {
    // ---- A) speed round is re-rolled on every spawn, never on level 1 ----
    startDuel(20260823);
    // level 1 is exempt whatever the spawn
    level=1; for(let k=0;k<200;k++){ _duelBeginLevel(k===0); A(_speedRound===false, 'speed round on LEVEL 1 at spawn '+k); }
    // a respawn re-decides: staying on one level long enough must produce BOTH verdicts
    level=4; _duelBeginLevel(true);
    let sawOn=false, sawOff=false;
    for(let k=0;k<400 && !(sawOn&&sawOff);k++){ _duelBeginLevel(false); if(_speedRound) sawOn=true; else sawOff=true; }
    A(sawOn, 'no speed round in 400 respawns on one level');
    A(sawOff, 'speed round never dropped across 400 respawns on one level');
    R.steps.push('speed round re-rolled per spawn (both verdicts seen on one level)');
    // long-run rate ~10% across spawns of BOTH kinds (guards the roll did not go missing)
    let on=0,n=0;
    for(let L=2; L<=501; L++){ level=L; _duelBeginLevel(true); if(_speedRound) on++; n++;
                               for(let k=0;k<2;k++){ _duelBeginLevel(false); if(_speedRound) on++; n++; } }
    const rate=on/n; A(rate>=0.06 && rate<=0.15, 'speed-round rate off band: '+rate.toFixed(3));
    R.steps.push('speed round rate over '+n+' spawns = '+(rate*100).toFixed(1)+'%');

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

    // ---- D) windswept steal: the roll, the flight, the pickup, the lockstep contract ----
    A(WINDSWEPT_ITEMS.length>0, 'no windswept items registered');
    A(WS['shades'].pct===40 && WS['crown'].pct===10 && WS['admincrown'].pct===5,
      'windswept chance ladder off (trinket 40 / trophy 10 / admin crown 5)');
    // The roll doubles against a boosting rival and is NOT capped, so the top of the ladder
    // is what keeps a pass from ever being a foregone loss. Re-cap it if this ever trips.
    A(Math.max(...WINDSWEPT_ITEMS.map(v=>v.pct))*2 < 100,
      'doubled odds can reach certainty -- the ladder needs its cap back');
    // registration drops ids this build does not know (an older peer wearing newer gear)
    startDuel(4242, [['shades','no_such_item'],['crown']]);
    A(_ws.w[0].join()==='shades' && _ws.w[1].join()==='crown', 'windswept registry: '+JSON.stringify(_ws.w));
    // two bare snakes have nothing to lose
    startDuel(4242, [[],[]]);
    for(let k=0;k<50;k++) _duelStealRoll();
    A(_ws.it===null, 'an item came loose off two bare snakes');
    // a pass in the SAME direction is a scrape and must stay SILENT in the sim -- the sparks
    // and the squeal are the renderer's, judged per frame (see _duelScrapeFx). Opposite
    // headings do all the work: the shake and the blow.
    const pass = (sameDir)=>{
      startDuel(4242, [['shades'],['shades']]);
      phase='duel'; _nmWasAdjacent=false;
      players[1].snake[0]={ x:players[0].snake[0].x, y:(players[0].snake[0].y+1)%ROWS };
      players[1].dir = sameDir ? {x:players[0].dir.x,y:players[0].dir.y} : {x:-players[0].dir.x,y:-players[0].dir.y};
      simEvents.length=0;
      let steals=0;
      for(let k=0;k<200;k++){ _nmWasAdjacent=false; _duelNearMiss(); if(_ws.it){ steals++; _ws.it=null; _ws.w[0]=['shades']; _ws.w[1]=['shades']; } }
      return { steals, kinds:simEvents.map(e=>e.t) };
    };
    const same=pass(true), opp=pass(false);
    A(same.steals===0, 'a side-by-side pass in the same direction knocked gear off');
    A(same.kinds.length===0, 'a same-direction scrape emitted sim events -- it is presentation only: '+same.kinds.join(','));
    A(opp.steals>0, 'no gear came loose in 200 opposite-direction passes');
    A(opp.kinds.indexOf('nearmiss')>=0 && opp.kinds.indexOf('wsblow')>=0, 'an opposite pass is missing its shake/blow events');
    R.steps.push('near miss: same direction is sim-silent, opposite direction shakes and blows gear off');
    // The board EDGE is not a place two snakes can pass each other. The wrap is real for movement
    // and stays real, but to the two people playing, the top row and the bottom row are a whole
    // screen apart: no shake, no gear, nothing.
    const edge = (a0,a1,d1)=>{
      startDuel(4242, [['shades'],['shades']]);
      phase='duel'; _nmWasAdjacent=false; simEvents.length=0;
      players[0].snake[0]=a0; players[0].dir={x:1,y:0};
      players[1].snake[0]=a1; players[1].dir=d1;
      for(let k=0;k<200;k++){ _nmWasAdjacent=false; _duelNearMiss(); }
      return simEvents.map(e=>e.t).join(',') + (_ws.it?'+steal':'');
    };
    A(edge({x:10,y:0},{x:10,y:ROWS-1},{x:-1,y:0})==='', 'the top row passed the bottom row across the wrap');
    A(edge({x:0,y:5},{x:COLS-1,y:5},{x:-1,y:0})==='', 'the left column passed the right column across the wrap');
    R.steps.push('near miss: the board edge is not a pass, in neither axis');
    // ...and gear knocked off at an edge settles against that edge instead of sailing over it.
    {
      startDuel(7, [['shades'],['shades']]);
      bars=[]; gem=null; heart=null; powerPellet=null;
      let rolls=0, far=0;
      for(let k=0;k<300;k++){
        players[0].snake[0]={x:1,y:1}; players[0].dir={x:1,y:0};
        players[1].snake[0]={x:1,y:2}; players[1].dir={x:-1,y:0};
        _ws.it=null; _ws.w[0]=['shades']; _ws.w[1]=['shades'];
        _duelStealRoll();
        if(!_ws.it) continue;
        rolls++;
        const H=players[_ws.it.own].snake[0];
        if(Math.max(Math.abs(_ws.it.x-H.x),Math.abs(_ws.it.y-H.y))>5) far++;
      }
      A(rolls>0 && far===0, 'gear blown off in a corner flew across the board ('+far+'/'+rolls+')');
      R.steps.push('steal: gear lost at an edge lands against it, never a screen away');
    }
    // both snakes wearing: a roll picks ONE victim, never both, and over many passes the
    // draw lands on either of them
    {
      startDuel(9001,[['shades'],['shades']]);
      const lost=[0,0];
      for(let k=0;k<400;k++){
        _duelStealRoll();
        if(_ws.it){ lost[_ws.it.own]++; _ws.w[_ws.it.own].push(_ws.it.id); _ws.it=null; }
        A(_ws.w[0].length===1 && _ws.w[1].length===1, 'one roll took gear off BOTH snakes');
      }
      A(lost[0]>0 && lost[1]>0, 'the victim is not drawn between the two: '+lost.join('/'));
      R.steps.push('both snakes wearing: one victim per roll, drawn between them ('+lost.join('/')+' over 400)');
    }
    // Speed is the ATTACKER's weapon: what doubles your odds of being stripped is the OTHER
    // snake boosting past you, never your own boost. Neither-boosting and both-boosting are
    // therefore symmetric states; exactly one boosting is the asymmetric one, and it is the
    // snake that did NOT boost who pays. The rng stream is untouched either way, so the same
    // seed draws the same values whoever happened to be boosting.
    {
      const rate=(vBoost,oBoost)=>{
        startDuel(31337,[['crown'],[]]);
        players[0].boosting=vBoost; players[1].boosting=oBoost;
        let hits=0;
        for(let k=0;k<3000;k++){ _duelStealRoll(); if(_ws.it){ hits++; _ws.w[0].push(_ws.it.id); _ws.it=null; } }
        return hits/3000*100;
      };
      const none=rate(false,false), mine=rate(true,false), theirs=rate(false,true), both=rate(true,true);
      const shown=[none,mine,theirs,both].map(v=>v.toFixed(1)+'%').join(' / ');
      A(Math.abs(mine-none)<3, 'boosting yourself changed your own odds of being stripped: '+shown);
      A(theirs>none*1.6, 'a boosting rival strips no harder than a slow pass: '+shown);
      A(Math.abs(both-theirs)<4, 'both boosting differs from the rival boosting alone: '+shown);
      A(both<100, 'a boosted pass became a certain loss');
      R.steps.push('crown, by who was boosting (neither / me / rival / both): '+shown);
    }
    // one loose item at a time, landing on the board, reproducible from the seed alone
    const roll = ()=>{ startDuel(4242,[['shades'],['shades']]); let n=0; while(!_ws.it && n<200){ _duelStealRoll(); n++; } return n; };
    const n1 = roll(), s1 = JSON.stringify(_ws);
    A(_ws.it, 'no item came loose in 200 near misses');
    A(n1 === roll() && s1 === JSON.stringify(_ws), 'the steal is not reproducible from the seed alone');
    const it0 = _ws.it;
    A(_ws.w[it0.own].indexOf(it0.id)<0, 'the blown-off item is still worn by its owner');
    A(it0.x>=0 && it0.x<COLS && it0.y>=0 && it0.y<ROWS, 'the item landed off the board');
    A(it0.at === simTick + WS_LAND_TICKS, 'the item skipped its 500ms flight');
    for(let k=0;k<50;k++) _duelStealRoll();
    A(JSON.stringify(_ws)===s1, 'a second item came loose while one was still lying there');
    // finders keepers: first head onto the cell owns it, and it displaces the same slot
    const pickup = (id, own, taker, wornTaker, delay)=>{
      startDuel(777, taker===0 ? [wornTaker,[]] : [[],wornTaker]);
      gem=null; heart=null; powerPellet=null; _powerMode=false;
      phase='duel'; phaseAt=0; spawnAt=0; bars=[]; _barsV++;
      const P=players[taker], H=P.snake[0];
      const tgt={ x:(H.x+P.dir.x+COLS)%COLS, y:(H.y+P.dir.y+ROWS)%ROWS };
      _ws.it={ id, own, x:tgt.x, y:tgt.y, at:simTick+(delay||0) };
      P.stepAccum=2; players[1-taker].stepAccum=0;
      duelStep(100000);
    };
    pickup('crown', 0, 1, []);
    A(_ws.it===null, 'the item stayed on the board after a head walked over it');
    A(_ws.w[1].join()==='crown' && _ws.w[0].length===0, 'the finder did not take the item: '+JSON.stringify(_ws.w));
    pickup('crown', 0, 1, ['cylinder']);
    A(_ws.w[1].join()==='crown', 'a taken crown did not displace the hat already worn: '+_ws.w[1].join());
    pickup('crown', 0, 1, [], WS_LAND_TICKS);
    A(_ws.it && _ws.w[1].length===0, 'an item still in flight was picked up');
    // a rebuild hands an unclaimed item back rather than destroying it
    _ws.it={ id:'crown', own:0, x:1, y:1, at:0 };
    level=3; _duelBeginLevel(false);
    A(_ws.it===null && _ws.w[0].join()==='crown', 'an unclaimed item was lost to a level rebuild');
    // dying never costs gear: a crash hands a loose item straight back, in flight or landed
    const crashWith = (at)=>{
      startDuel(777, [['crown'],[]]);
      gem=null; heart=null; powerPellet=null; _powerMode=false;
      phase='duel'; phaseAt=0; spawnAt=0; bars=[]; _barsV++;
      const P=players[0];
      _ws.w[0]=[]; _ws.it={ id:'crown', own:0, x:1, y:1, at };
      P.snake=[{x:5,y:5},{x:5,y:6},{x:6,y:6},{x:6,y:5}]; P.dir={x:0,y:1}; P.dirQueue=[];
      P.stepAccum=2; players[1].stepAccum=0;
      duelStep(100000);
    };
    crashWith(simTick+WS_LAND_TICKS);
    A(phase==='dying', 'the crash fixture did not actually kill anybody');
    A(_ws.it===null && _ws.w[0].join()==='crown', 'a crash cost the crasher gear still in flight');
    crashWith(0);
    A(_ws.it===null && _ws.w[0].join()==='crown', 'a crash cost gear already lying on the board');
    // ...and an item that comes down INSIDE a snake is that snake's. The landing cell is
    // picked free of both bodies, but the item is in the air for WS_LAND_TICKS and the board
    // it lands on is not the one it left. A body cell is one a head only reaches by dying,
    // so nobody can ever walk over it: without this it just sits there, visibly inside the
    // snake, until the tail moves off it.
    const landedIn = (at, cell)=>{
      startDuel(777, [[],[]]);
      gem=null; heart=null; powerPellet=null; _powerMode=false;
      phase='duel'; phaseAt=0; spawnAt=0; bars=[]; _barsV++;
      const P=players[0];
      P.snake=[{x:5,y:5},{x:4,y:5},{x:3,y:5},{x:2,y:5}]; P.dir={x:1,y:0}; P.dirQueue=[];
      players[1].snake=[{x:20,y:18},{x:19,y:18}]; players[1].dir={x:1,y:0}; players[1].dirQueue=[];
      _ws.w[0]=[]; _ws.w[1]=[]; _ws.u[0]={}; _ws.u[1]={};
      _ws.it={ id:'crown', own:1, uid:'u9', x:cell.x, y:cell.y, at };
      P.stepAccum=2; players[1].stepAccum=0;
      duelStep(100000);
    };
    landedIn(0, {x:4,y:5});
    A(phase==='duel', 'the landed-inside fixture killed somebody');
    A(_ws.it===null && _ws.w[0].join()==='crown',
      'an item that landed inside the snake was left stranded in it: '+JSON.stringify(_ws.w));
    A(_ws.u[0].crown==='u9', 'the instance that landed inside was not the one handed over');
    A(simEvents.some(e=>e.t==='wsget' && e.to===0 && e.from===1),
      'taking an item off your own body announced nothing');
    landedIn(simTick+WS_LAND_TICKS, {x:4,y:5});
    A(_ws.it && _ws.w[0].length===0, 'an item still in flight was taken by the body under it');
    R.steps.push('pickup: finders keepers, same slot displaced, no grab in flight, rebuild returns it');
    R.steps.push('an item landing inside a snake is collected by it on the landing tick');
    R.steps.push('a crash returns any loose item: dying never drops gear');
    // the lockstep contract: both new fields reach the hash, the cloner and the resync wire
    startDuel(4242,[['shades'],['crown']]);
    let g=0; while(!_ws.it && g<200){ _duelStealRoll(); g++; }
    const base=simSnapshot(), hb=_rbHash(base);
    const noVol=simSnapshot(); noVol._ws={ w:[[],[]], it:null };
    A(_rbHash(noVol)!==hb, '_ws never reaches the duel hash -- a steal could desync in silence');
    const flip=simSnapshot(); flip._nmWasAdjacent=!flip._nmWasAdjacent;
    A(_rbHash(flip)!==hb, '_nmWasAdjacent never reaches the duel hash');
    const dsnap=_rbDuelSnap();
    A(JSON.stringify(_rbCloneSnap(dsnap))===JSON.stringify(dsnap), 'the rollback cloner is not byte-identical over the windswept registry');
    const wire=_rbFullState(base, simTick);
    A(wire.ws && wire.ws.it && wire.ws.it.id===_ws.it.id, 'the loose item does not ride the resync wire');
    A(_rbWsItem({id:'no_such_item',own:0,x:1,y:1,at:0})===null, 'an unknown id survived the resync validator');
    A(_rbWsItem({id:_ws.it.id,own:0,x:-1,y:1,at:0})===null, 'an off-board item survived the resync validator');
    R.steps.push('steal state rides the hash, the cloner and the resync wire (all five duel lists)');

    // ---- E) a frontal is MUTUAL whatever the step phase the two snakes met in ----
    // Boosting, or simply being spawned a tick out of phase, means the two do not step on
    // the same ticks. The head-on rule used to need both of them due at once, so an odd-gap
    // frontal was judged on the mover alone: it ran into a snake that was standing still by
    // accident of phase, died on its own, and the other drove off intact.
    const RIGHT={x:1,y:0}, LEFT={x:-1,y:0}, DOWN={x:0,y:1};
    const lay=(x,y,d)=>{ const s=[]; for(let k=0;k<3;k++) s.push({x:(x-d.x*k+COLS)%COLS, y:(y-d.y*k+ROWS)%ROWS}); return s; };
    const stage=(a,b,prot)=>{
      startDuel(7777);
      gem=null; heart=null; powerPellet=null; _powerMode=false; bars=[]; _barsV++;
      phase='duel'; phaseAt=0; spawnAt=prot?100000:0; deathMsg=''; simEvents.length=0;
      const P=players[0], Q=players[1];
      P.snake=lay(a.x,a.y,a.d); P.dir=a.d; P.dirQueue=[]; P.stepAccum=a.acc; P.boosting=false;
      Q.snake=lay(b.x,b.y,b.d); Q.dir=b.d; Q.dirQueue=[]; Q.stepAccum=b.acc; Q.boosting=false;
      return { P, Q, l0:P.lives, l1:Q.lives };
    };
    const crashOf=(p)=>simEvents.filter(e=>e.t==='crash'&&e.p===p)[0]||null;
    const bothPaid=(s,tag)=>{
      A(players[0].lives===s.l0-1 && players[1].lives===s.l1-1,
        tag+': a frontal cost '+(s.l0-players[0].lives)+'/'+(s.l1-players[1].lives)+' lives, not one each');
      A(deathMsg==='BOTH LOSE A LIFE', tag+': the board says "'+deathMsg+'" after a frontal');
      for(let i=0;i<2;i++){ const c=crashOf(i);
        A(c && c.into==='headon', tag+': side '+i+' was not classified as a head-on ('+(c?c.into:'no crash')+')'); }
    };
    const frontal=(a,b)=>{ const s=stage(a,b); duelStep(100000); return s; };
    // even gap, both due: they meet IN a cell -- the case that always worked
    bothPaid(frontal({x:10,y:5,d:RIGHT,acc:2},{x:12,y:5,d:LEFT,acc:2}), 'gap 2, both due');
    // odd gap: they meet on an EDGE, and only one of them is due to take the step
    bothPaid(frontal({x:10,y:5,d:RIGHT,acc:2},{x:11,y:5,d:LEFT,acc:0}), 'gap 1, only P1 due');
    bothPaid(frontal({x:10,y:5,d:RIGHT,acc:0},{x:11,y:5,d:LEFT,acc:2}), 'gap 1, only P2 due');
    // and the same collision arrived at over two ticks: the first mover closes the gap into
    // the empty cell between them, the second walks into the head now waiting there. The
    // first mover must not get away with it for being early.
    {
      const s=stage({x:10,y:5,d:RIGHT,acc:2},{x:12,y:5,d:LEFT,acc:0});
      duelStep(100000);
      A(players[0].lives===s.l0 && players[1].lives===s.l1, 'closing into an empty cell already killed somebody');
      A(s.P.snake[0].x===11, 'the early mover did not advance into the gap');
      s.P.stepAccum=0; s.Q.stepAccum=2; simEvents.length=0;
      duelStep(100100);
      bothPaid(s, 'gap 2 closed over two ticks');
    }
    // the impact each wreck leans toward: the mover's is the cell ahead, and the one that
    // was not due points BACK at the head it is being crushed against. The renderer reads
    // these two to decide which way each wreck folds, so a wrong one leans into open board.
    {
      stage({x:10,y:5,d:RIGHT,acc:2},{x:11,y:5,d:LEFT,acc:0});
      duelStep(100000);
      const a=crashOf(0), b=crashOf(1);
      A(a.hx===10 && a.x===11, 'the mover does not lean into the cell it was entering');
      A(b.hx===11 && b.x===10, 'the snake that was not due leans at '+b.x+', not at the head that hit it');
    }
    R.steps.push('frontal collisions are mutual on an even gap, an odd gap and one closed over two ticks');
    // CONTROLS -- not every touch of an opponent's head is a head-on. Only a CLOSING course
    // is: crossing it or clipping its body stays the mover's own fault, exactly as before.
    {
      const s=stage({x:10,y:5,d:RIGHT,acc:2},{x:11,y:5,d:DOWN,acc:0});
      duelStep(100000);
      A(players[0].lives===s.l0-1 && players[1].lives===s.l1, 'a T-bone into a crossing head was charged to both');
      A(crashOf(0).into==='snake', 'a T-bone was dressed as a head-on');
    }
    {
      // a vertical opponent clipped side-on: the cell entered is its BODY, not its head
      const s=stage({x:10,y:5,d:RIGHT,acc:2},{x:11,y:3,d:{x:0,y:-1},acc:0});
      duelStep(100000);
      A(players[0].lives===s.l0-1 && players[1].lives===s.l1, 'clipping a body was charged to both');
    }
    {
      const s=stage({x:10,y:5,d:RIGHT,acc:2},{x:11,y:5,d:LEFT,acc:0}, true);
      duelStep(100000);
      A(players[0].lives===s.l0 && players[1].lives===s.l1, 'spawn protection stopped covering a frontal');
    }
    R.steps.push('a crossing head, a clipped body and a protected spawn are still not head-ons');

    R.ok=true;
  } catch(e){ R.err=String(e && e.stack || e); }
})();
`;
runTest('SIM-DUEL', driver);
