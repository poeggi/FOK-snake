// Eyelid smoke: the idle blink and the brace-for-impact flinch (js/render.js).
// Both are renderer-only presentation, so nothing here touches the sim, the hash or the
// wire -- what this pins down is the POLICY: which blink character a round gets, that a
// brace beats any blink phase, and that REDUCE MOTION leaves the eyes wide open.
// The harness canvas swallows draw calls, so the assertions run against _eyeLid/_blinkK/
// _braceK directly rather than against pixels. Run: node test/smoke-eyes.js
const { runTest } = require('./harness');

runTest('SMOKE-EYES', `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const log = (m) => R.steps.push(m);
  const SPAN = 60000, STEP = 16;   // a minute of frames at 60fps
  function sweep(fn){
    const v=[]; for(let t=0;t<SPAN;t+=STEP) v.push(fn(t)); return v;
  }
  function blinks(v){   // rising edges: how many times the eyes actually shut
    let n=0; for(let i=1;i<v.length;i++) if(v[i]>0 && v[i-1]===0) n++; return n;
  }
  function shutFrames(v){ let n=0; for(const k of v) if(k>0) n++; return n; }
  try {
    cfg.reduceMotion=false; players=null; boosting=false; level=1; bars=[];
    const HEAD=[{x:5,y:5}], EAST={x:1,y:0};

    // ---- the idle blink ----
    const heavy = sweep(t=>_blinkK(0,false,t));
    const nb = blinks(heavy);
    if(nb<10||nb>20) throw 'a minute should hold 10-20 blinks, got '+nb;
    if(Math.max.apply(null,heavy)<0.9) throw 'a blink must actually close the eye';
    if(!heavy.some(k=>k>0&&k<1)) throw 'the heavy lid needs in-between frames, not a flick';
    const gaps=[]; let last=-1;
    for(let i=1;i<heavy.length;i++) if(heavy[i]>0&&heavy[i-1]===0){ if(last>=0) gaps.push((i-last)*STEP); last=i; }
    if(Math.min.apply(null,gaps)===Math.max.apply(null,gaps)) throw 'a metronome is not a blink: the cadence must jitter';
    log('idle blink: '+nb+' in 60s, gaps '+Math.min.apply(null,gaps)+'-'+Math.max.apply(null,gaps)+'ms, real arc');

    // ---- boosting and the late levels get the flick ----
    const flick = sweep(t=>_blinkK(0,true,t));
    if(flick.some(k=>k!==0&&k!==1)) throw 'the flick must have no in-between frames';
    if(!(shutFrames(flick) < shutFrames(heavy))) throw 'the flick must be briefer than the heavy lid';
    log('flick: no in-between frames, '+shutFrames(flick)+' shut frames vs heavy '+shutFrames(heavy));

    // ---- two snakes never blink in lockstep ----
    const p0=sweep(t=>_blinkK(0,false,t)), p1=sweep(t=>_blinkK(1,false,t));
    let apart=0; for(let i=0;i<p0.length;i++) if((p0[i]>0)!==(p1[i]>0)) apart++;
    if(!apart) throw 'both snakes blink on the same frames';
    let together=0; for(let i=0;i<p0.length;i++) if(p0[i]>0&&p1[i]>0) together++;
    if(together>apart) throw 'the two blink schedules are effectively locked together';
    log('two snakes blink independently ('+apart+' frames apart, '+together+' overlapping)');

    // ---- the brace: what the head is running into ----
    bars=[];
    if(_braceK(HEAD,EAST,-1)!==0) throw 'an open board is nothing to flinch at';
    bars=[{x:6,y:5}];
    if(_braceK(HEAD,EAST,-1)!==1) throw 'a wall one cell ahead must shut the eyes';
    bars=[{x:7,y:5}];
    if(_braceK(HEAD,EAST,-1)!==0.5) throw 'a wall two cells ahead must half-shut them';
    bars=[{x:6,y:5,fragile:true}];
    if(_braceK(HEAD,EAST,-1)!==0) throw 'a fragile bar is smashed through, not braced for';
    bars=[{x:0,y:5}];
    if(_braceK([{x:COLS-1,y:5}],EAST,-1)!==1) throw 'the brace must look across the wrap';
    bars=[];
    const body=[{x:5,y:5},{x:5,y:6},{x:6,y:6},{x:6,y:5},{x:7,y:5}];
    if(_braceK(body,EAST,-1)!==1) throw 'running into your own body must shut the eyes';
    log('brace: walls, the wrap, a fragile bar and your own body all judged');

    // ---- the brace: the pass that costs gear ----
    const mk=(hx,hy,d)=>({snake:[{x:hx,y:hy}],dir:d,alive:true,boosting:false});
    players=[mk(5,5,EAST), mk(5,7,{x:-1,y:0})];
    if(_braceK(players[0].snake,EAST,0)!==0.5) throw 'a rival closing two cells off on another heading is a brace';
    players[1].dir=EAST;
    if(_braceK(players[0].snake,EAST,0)!==0) throw 'a shared heading is a scrape: nothing comes off it, nothing to brace for';
    players=[mk(5,5,EAST), mk(5,6,{x:-1,y:0})];
    if(_braceK(players[0].snake,EAST,0)!==1) throw 'a pass one cell off must shut the eyes';
    log('brace: a pass braces, a scrape does not');

    // ---- the combined policy ----
    players=null; bars=[]; boosting=false; level=1;
    const cruise=sweep(t=>_eyeLid(HEAD,EAST,-1,t));
    if(!cruise.some(k=>k>0&&k<1)) throw 'cruising at level 1 should get the heavy lid';
    level=BLINK_FLICK_LEVEL;
    if(sweep(t=>_eyeLid(HEAD,EAST,-1,t)).some(k=>k!==0&&k!==1)) throw 'level '+BLINK_FLICK_LEVEL+' must be all flick';
    level=1; boosting=true;
    if(sweep(t=>_eyeLid(HEAD,EAST,-1,t)).some(k=>k!==0&&k!==1)) throw 'boosting must be all flick';
    boosting=false;
    players=[mk(5,5,EAST), mk(20,15,EAST)]; players[0].boosting=true;
    if(sweep(t=>_eyeLid(players[0].snake,EAST,0,t)).some(k=>k!==0&&k!==1)) throw 'a boosting duel snake must be all flick';
    if(!sweep(t=>_eyeLid(players[1].snake,EAST,1,t)).some(k=>k>0&&k<1)) throw 'only the booster gets the flick, not the rival';
    log('character follows the pace: heavy while cruising, flick when boosting or from level '+BLINK_FLICK_LEVEL);

    // ---- a brace beats any blink phase ----
    players=null; bars=[{x:6,y:5}]; level=1; boosting=false;
    if(sweep(t=>_eyeLid(HEAD,EAST,-1,t)).some(k=>k!==1)) throw 'a brace must hold the eyes shut through every blink phase';
    log('a brace holds shut regardless of the blink');

    // ---- REDUCE MOTION leaves the eyes alone ----
    cfg.reduceMotion=true;
    if(sweep(t=>_eyeLid(HEAD,EAST,-1,t)).some(k=>k!==0)) throw 'REDUCE MOTION must leave the eyes wide open, brace included';
    cfg.reduceMotion=false;
    log('REDUCE MOTION: no blink, no flinch');

    R.ok=true;
  } catch(e){ R.err = (e && e.stack) || String(e); }
})();
`);
