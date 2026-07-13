// Mystery-box economy guards: every box is a LOTTERY (price > expected loot value, a
// real house edge), odds are well-formed, the pity system caps junk streaks, and the
// ADMIN-exclusive item never leaks from a normal box. Run: node test/box-odds.js
const { runTest } = require('./harness');

const driver = `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  try {
    // 1. odds are a valid distribution
    for(const b of BOXES){
      const sum=['coins','common','rare','epic','legendary'].reduce((s,k)=>s+(b.odds[k]||0),0);
      if(Math.abs(sum-1) > 1e-9) throw b.id+' odds sum '+sum+' != 1';
    }
    // 2. house edge: price must exceed expected loot value (a lottery, not a bargain)
    for(const b of BOXES){
      const ev = boxEV(b), edge = (b.price-ev)/b.price;
      R.steps.push(b.id.padEnd(9)+' price='+b.price+'  EV='+Math.round(ev)+'  edge='+(edge*100).toFixed(1)+'%');
      if(ev >= b.price) throw b.id+' has NO house edge (EV '+Math.round(ev)+' >= price '+b.price+')';
      if(edge < 0.10)   throw b.id+' edge '+(edge*100).toFixed(1)+'% < 10% (too generous)';
      if(edge > 0.55)   throw b.id+' edge '+(edge*100).toFixed(1)+'% > 55% (too stingy)';
    }
    // 3. simulate many rolls: no ADMIN leak, pity caps junk streaks
    let s=1234567; Math.random = () => { s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
    cfg.boxPity = 0;
    let sawAdmin=false, streak=0, maxStreak=0, coins=0, items=0;
    for(let i=0;i<40000;i++){
      const res = rollBox(BOXES[i % BOXES.length]);
      if(res.type==='item'){ items++; if(res.id==='admincrown') sawAdmin=true; }
      else { coins++; if(res.amount%100!==0) throw 'coin reward '+res.amount+' is not a multiple of 100'; }
      const junk = res.type==='coins' || (res.type==='item' && res.rarity==='common');
      streak = junk ? streak+1 : 0; if(streak>maxStreak) maxStreak=streak;
    }
    if(sawAdmin) throw 'ADMIN-exclusive item dropped from a normal box';
    if(maxStreak > BOX_PITY) throw 'pity failed: junk streak '+maxStreak+' > BOX_PITY '+BOX_PITY;
    R.steps.push('rolled 40000: '+items+' items / '+coins+' coins; max junk streak '+maxStreak+' (pity '+BOX_PITY+'); no admin leak');
    R.ok = true;
  } catch(e){ R.err = String(e && e.stack || e); }
})();
`;
runTest('BOX-ODDS', driver);
