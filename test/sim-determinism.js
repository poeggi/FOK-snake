// Determinism lock: a fixed seed + fixed input sequence must always produce the
// exact same simulation state. Proven two ways: (1) run twice, assert identical
// state hash (reproducibility -- the basis for replay validation and lockstep);
// (2) assert that hash equals a recorded GOLDEN so the sim/presentation refactor
// cannot silently change sim output. Run: node test/sim-determinism.js
const { runTest } = require('./harness');

// Recorded from the first green run; update ONLY intentionally (a deliberate rule
// change), never to paper over a refactor that shifted sim output.
const GOLDEN = '7f2ad170:216';

const driver = `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const GOLDEN = ${JSON.stringify(GOLDEN)};
  try {
    const SEED = 0x1234ABCD;
    function hashState(){
      const snap = {
        tick:simTick, seed:gameSeed, phase, level, lives, score, gemsDone,
        snake:(snake||[]).map(s=>s.x+','+s.y).join(';'),
        dir: dir?dir.x+','+dir.y:'',
        gem: gem?(gem.x+','+gem.y+','+(gem.tier||0)):'',
        bars:(bars||[]).map(b=>b.x+','+b.y+(b.fragile?'F':'')).join(';'),
        pp: powerPellet?1:0, tc: timeCrystal?1:0, heart: heart?1:0,
        gour:(_gourangaLine?_gourangaLine.length:0)+':'+(_gourangaEaten?_gourangaEaten.size:0),
        bonus:levelBonusCount, perfect:perfectLevel?1:0
      };
      const str=JSON.stringify(snap);
      let h=2166136261>>>0;
      for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619); }
      return (h>>>0).toString(16)+':'+str.length;
    }
    function runOnce(){
      _splashLeftAt=-1e9; _splashKeyHeld=false;   // never block input in this run
      simTick=0; simNow=0;
      startGame(SEED);
      let s=555; const inp=()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
      const DIRS=['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
      for(let i=0;i<2000;i++){
        if(phase==='playing' && inp()<0.1) handleKey(DIRS[Math.floor(inp()*4)], ()=>{});
        update();
        if(phase==='nameEntry') break;
      }
      return hashState();
    }
    const h1=runOnce(), h2=runOnce();
    if(h1!==h2) throw 'NON-DETERMINISTIC: '+h1+' != '+h2;
    if(GOLDEN==='__PENDING__') R.steps.push('deterministic hash='+h1+'  (record this as GOLDEN)');
    else if(h1!==GOLDEN) throw 'sim output changed vs golden: got '+h1+', expected '+GOLDEN;
    else R.steps.push('deterministic + matches golden ('+h1+')');
    R.ok=true;
  } catch(e){ R.err=String(e && e.stack || e); }
})();
`;
runTest('SIM-DETERMINISM', driver);
