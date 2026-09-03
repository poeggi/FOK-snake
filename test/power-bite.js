// THE POWER BITE, in every mode. With the power pill up, running into your own body stops
// being lethal: the head goes through and everything from the bitten segment back falls off.
//
// The reason this suite exists is the "one mechanic" rule rather than the rule itself: single
// player, local 1:1 and online 1:1 must shorten the snake IDENTICALLY, so the two modes are
// driven here side by side off the same fixture and checked against the same expectations. A
// second implementation for the duel would pass a duel-only suite and still be a bug.
//
// The shortening is sim state -- it rides the snapshot and the duel's lockstep hash, so both
// clients cut the same segments on the same tick. The pieces flying off are the renderer's,
// and all the sim owes it is the one 'bite' event asserted below.
// Run: node test/power-bite.js
const { runTest } = require('./harness');

const driver = `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const A = (c,m)=>{ if(!c) throw m; };
  try {
    // A coil whose head's next cell is its own index 3. Deliberately not the neck (index 1):
    // no snake can steer into that, the reverse filter drops the turn, so the shallowest bite
    // a real game can produce is deeper -- the floor is unit-tested separately below.
    const COIL = [{x:5,y:5},{x:4,y:5},{x:4,y:6},{x:5,y:6},{x:6,y:6},{x:6,y:5},{x:7,y:5}];
    const BITE_AT = 3, INTO = { x:5, y:6 };
    const cp = ()=>COIL.map(s=>({x:s.x, y:s.y}));

    // ---- single player ----
    const classic = (powered)=>{
      simCommand({t:'start', seed:99});
      phase='playing'; spawnAt=-100000;
      gem=null; heart=null; powerPellet=null; timeCrystal=null; bars=[]; _barsV++;
      _gourangaActive=false;
      _powerMode=powered; _powerModeAt=simNow;
      snake=cp(); dir={x:0,y:1}; dirQueue=[];
      const was=snake.length;
      simEvents.length=0;
      step(simNow);
      return { was, len:snake.length, head:snake[0], phase, ev:simEvents.filter(e=>e.t==='bite') };
    };
    let r = classic(false);
    A(r.phase==='dying', 'an UNPOWERED self-bite stopped being lethal in single player: '+r.phase);
    A(r.ev.length===0, 'a lethal self-bite still announced a bite');
    R.steps.push('single player, no pill: running into your own body still kills');

    r = classic(true);
    A(r.phase==='playing', 'a POWERED self-bite killed in single player: '+r.phase);
    A(r.head.x===INTO.x && r.head.y===INTO.y, 'the powered head did not go through onto the bitten cell');
    A(r.len===BITE_AT+1, 'single player kept '+r.len+' segments, expected '+(BITE_AT+1)+' (head + everything ahead of the bite)');
    A(r.ev.length===1 && r.ev[0].n===r.was-r.len && r.ev[0].p===0,
      'single player did not announce exactly one bite of '+(r.was-r.len)+' segments');
    const CLASSIC_LEN = r.len, CLASSIC_LOST = r.was - r.len;
    R.steps.push('single player, pill up: head goes through, '+CLASSIC_LOST+' segments fall off ('+r.was+' -> '+r.len+')');

    // ---- 1:1, the SAME fixture ----
    const duel = (powered, who)=>{
      simCommand({t:'startDuel', seed:99});
      phase='duel'; phaseAt=0; spawnAt=simNow-SPAWN_PROTECT*2;
      gem=null; heart=null; powerPellet=null; bars=[]; _barsV++;
      _powerMode=powered; _powerModeAt=simNow;
      const P=players[who], Q=players[1-who];
      P.snake=cp(); P.dir={x:0,y:1}; P.dirQueue=[]; P.stepAccum=2;
      // The other snake is parked far away and not stepping: this fixture is about one
      // snake and its own tail, and a stray head-on would mask the result.
      Q.snake=[{x:20,y:2},{x:19,y:2},{x:18,y:2}]; Q.dir={x:1,y:0}; Q.dirQueue=[]; Q.stepAccum=0;
      const was=P.snake.length, lives=P.lives;
      simEvents.length=0;
      duelStep(simNow);
      return { was, lives, len:P.snake.length, head:P.snake[0], now:P.lives, phase,
               ev:simEvents.filter(e=>e.t==='bite') };
    };
    r = duel(false, 0);
    A(r.phase==='dying', 'an UNPOWERED self-bite stopped being lethal in a duel: '+r.phase);
    A(r.now===r.lives-1, 'the unpowered self-bite did not cost a heart');
    R.steps.push('1:1, no pill: running into your own body still costs a heart');

    for(const who of [0,1]){
      r = duel(true, who);
      A(r.phase==='duel', 'a POWERED self-bite killed player '+who+' in a duel: '+r.phase);
      A(r.now===r.lives, 'the powered self-bite cost player '+who+' a heart');
      A(r.head.x===INTO.x && r.head.y===INTO.y, 'the powered head did not go through for player '+who);
      A(r.ev.length===1 && r.ev[0].p===who && r.ev[0].n===r.was-r.len,
        'player '+who+' did not announce exactly one bite of its own');
      // THE POINT OF THIS SUITE: byte-for-byte the single-player outcome.
      A(r.len===CLASSIC_LEN && r.was-r.len===CLASSIC_LOST,
        'the duel shortened player '+who+' to '+r.len+' where single player gives '+CLASSIC_LEN+
        ' -- the two modes are running different code');
    }
    R.steps.push('1:1, pill up: identical outcome to single player for BOTH players ('+CLASSIC_LEN+' left, '+CLASSIC_LOST+' lost)');

    // ---- the floor ----
    // A bite so shallow it would leave a head with no body reads as a broken render rather
    // than a hit taken, so the chomp goes as deep as it can and stops. Unreachable by
    // steering (see above), so it is checked on the rule itself, which is also what proves
    // the chomp and the self-bite share one floor.
    const short=[{x:1,y:1},{x:2,y:1},{x:3,y:1}];
    _powerBite(short, 1);
    A(short.length===SNAKE_MIN_LEN, 'the bite floor let a snake go down to '+short.length);
    R.steps.push('a bite never takes the last body segment (floor '+SNAKE_MIN_LEN+')');

    // ---- and it is only ever the OWN body ----
    // The pill turns the opponent into food by a different rule (the chomp, which also slows
    // the biter). Neither may quietly become the other: a powered run into the RIVAL must
    // still leave the mover's own length alone.
    simCommand({t:'startDuel', seed:99});
    phase='duel'; phaseAt=0; spawnAt=simNow-SPAWN_PROTECT*2;
    gem=null; heart=null; powerPellet=null; bars=[]; _barsV++;
    _powerMode=true; _powerModeAt=simNow;
    const P=players[0], Q=players[1];
    P.snake=[{x:5,y:5},{x:4,y:5},{x:3,y:5}]; P.dir={x:0,y:1}; P.dirQueue=[]; P.stepAccum=2;
    Q.snake=[{x:4,y:6},{x:5,y:6},{x:6,y:6},{x:7,y:6}]; Q.dir={x:1,y:0}; Q.dirQueue=[]; Q.stepAccum=0;
    simEvents.length=0;
    duelStep(simNow);
    A(phase==='duel', 'a powered bite into the rival killed somebody: '+phase);
    A(P.snake.length===3, 'the biter lost length of its own to a CHOMP: '+P.snake.length);
    A(Q.snake.length<4, 'the chomp took nothing off the rival');
    A(simEvents.filter(e=>e.t==='bite').length===0, 'chomping the rival announced a self-bite');
    R.steps.push('a powered bite into the RIVAL is still the chomp: the biter keeps its own length');

    R.ok=true;
  } catch(e){ R.err=String(e && e.stack || e); }
})();
`;
runTest('POWER-BITE', driver);
