// Side-effect sequence lock. Wraps every presentation/audio/persistence sink the
// sim drives (sfx, coins, achievements, bonus text, fireworks, bars re-render,
// music, HUD), runs the deterministic game, and hashes the ordered call sequence.
// Captured BEFORE the event-decoupling refactor, so afterwards it proves the sim
// still produces the exact same effects in the same order -- whether they fire
// inline (old) or via drainSimEvents() (new). Run: node test/sim-events.js
const { runTest } = require('./harness');

const GOLDEN = '77bbd51e:86';   // re-recorded: bonus/fireworks/crush visuals joined sfx on the fixed 2-tick delay queue (same 86 effects, delayed 2 ticks so a rollback can cancel them)

const driver = `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const GOLDEN = ${JSON.stringify(GOLDEN)};
  try {
    const rec = [];
    const W = (label, ai, fn) => function(){
      rec.push(label + (ai!=null && arguments[ai]!==undefined ? (':'+arguments[ai]) : ''));
      return fn.apply(this, arguments);
    };
    Snd.sfxPlay        = W('sfx', 0, Snd.sfxPlay);
    Snd.musicGamePause = W('mpause', null, Snd.musicGamePause);
    Snd.musicGameUnpause = W('munpause', null, Snd.musicGameUnpause);
    Snd.musicStop      = W('mstop', null, Snd.musicStop);
    addFOKoins         = W('coin', 0, addFOKoins);
    unlockAch          = W('ach', 0, unlockAch);
    showBonus          = W('bonus', 1, showBonus);
    spawnFireworks     = W('fw', null, spawnFireworks);
    renderBarsOffscreen= W('bars', null, renderBarsOffscreen);
    showHUD            = W('hud', 0, showHUD);

    // Greedy gem-seeker (wrap-aware): deterministically eats gems and progresses
    // levels, exercising eat/bonus/lucky/epic/gouranga/power/levelUp/fireworks paths.
    function steer(){
      if(!gem || !snake || !snake.length) return;
      const h=snake[0];
      let want=null;
      if(gem.x!==h.x) want = ((gem.x-h.x+COLS)%COLS <= (h.x-gem.x+COLS)%COLS) ? 'ArrowRight' : 'ArrowLeft';
      else if(gem.y!==h.y) want = ((gem.y-h.y+ROWS)%ROWS <= (h.y-gem.y+ROWS)%ROWS) ? 'ArrowDown' : 'ArrowUp';
      if(want) handleKey(want, ()=>{});
    }
    _splashLeftAt=-1e9; _splashKeyHeld=false; simTick=0; simNow=0;
    startGame(0x1234ABCD);
    for(let i=0;i<12000;i++){
      if(phase==='playing') steer();
      update();
      if(typeof drainSimEvents==='function') drainSimEvents();   // new path once it exists
      if(typeof flushSfxQ==='function') flushSfxQ();               // sfx queue: fixed 2-tick delay
      if(typeof flushFxQ==='function') flushFxQ();                 // visual queue (bonus/fw/crush): same 2-tick delay
      if(phase==='nameEntry') break;
    }
    const str = rec.join('|');
    let h=2166136261>>>0;
    for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619); }
    const sig=(h>>>0).toString(16)+':'+rec.length;
    if(GOLDEN==='__PENDING__') R.steps.push('effect-seq '+sig+'  (record as GOLDEN)  sample: '+rec.slice(0,14).join(' '));
    else if(sig!==GOLDEN) throw 'side-effect sequence changed: got '+sig+', expected '+GOLDEN;
    else R.steps.push('side-effect sequence matches golden ('+sig+')');
    R.ok=true;
  } catch(e){ R.err=String(e && e.stack || e); }
})();
`;
runTest('SIM-EVENTS', driver);
