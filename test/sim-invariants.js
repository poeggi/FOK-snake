// Seed-agnostic simulation invariants: play many games with pseudo-random inputs
// and assert rules that must hold no matter what the RNG produces. This guards the
// upcoming sim/presentation refactor -- if movement, collision, spawning, scoring,
// or level flow break, an invariant trips. Run: node test/sim-invariants.js
const { runTest } = require('./harness');

const driver = `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  try {
    // Consistent, large sim clock so handleKey clears the 200ms post-splash guard
    // and phaseAt-based transitions still advance.
    _splashLeftAt=-1e9; _splashKeyHeld=false;
    simTick=20000; simNow=simTick*TICK_MS;

    const inBounds = c => c.x>=0 && c.x<COLS && c.y>=0 && c.y<ROWS;
    const wrapAdj = (a,b) => {
      const dx=Math.abs(a.x-b.x), dy=Math.abs(a.y-b.y);
      const ax=(dx===1||dx===COLS-1), ay=(dy===1||dy===ROWS-1);
      return (ax&&dy===0)||(ay&&dx===0);
    };
    // deterministic input source (test is reproducible; invariants are RNG-agnostic)
    let seed=987654321; const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
    const DIRS=['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
    const VALID=new Set(['playing','levelReady','dying','levelDone','nameEntry','menu','paused']);

    let games=0, ticks=0;
    for(let g=0; g<8; g++){
      phase='menu'; startGame();
      let prevScore=0, prevHead=null;
      for(let i=0; i<1500; i++){
        if(phase==='playing' && rnd()<0.12) handleKey(DIRS[Math.floor(rnd()*4)], ()=>{});
        update(); ticks++;

        if(!VALID.has(phase)) throw 'invalid phase '+phase+' (game '+g+' tick '+i+')';
        if(snake){
          if(snake.length<1) throw 'empty snake';
          for(const c of snake) if(!inBounds(c)) throw 'snake cell OOB '+JSON.stringify(c);
          if(phase==='playing'){
            const h=snake[0];
            if(prevHead && (h.x!==prevHead.x||h.y!==prevHead.y) && !wrapAdj(h,prevHead))
              throw 'head jumped '+JSON.stringify(prevHead)+' -> '+JSON.stringify(h);
            prevHead={x:h.x,y:h.y};
          } else prevHead=null;
        }
        if(gem && snake && snake.some(s=>s.x===gem.x&&s.y===gem.y)) throw 'gem spawned on snake';
        if(lives<0 || lives>START_LIVES+1) throw 'lives out of range: '+lives;
        if(gemsDone<0 || gemsDone>GEMS_PER_LEVEL) throw 'gemsDone out of range: '+gemsDone;
        if(level<1 || level>MAX_LEVELS) throw 'level out of range: '+level;
        if(score<0) throw 'negative score';
        if(score<prevScore) throw 'score decreased within a game: '+prevScore+' -> '+score;
        prevScore=score;

        if(phase==='nameEntry') break;   // game over -- next game
      }
      games++;
    }
    R.steps.push('invariants held over '+games+' games, '+ticks+' ticks');
    R.ok=true;
  } catch(e){ R.err=String(e && e.stack || e); }
})();
`;
runTest('SIM-INVARIANTS', driver);
