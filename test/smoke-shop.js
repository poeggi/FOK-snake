// Shop smoke: mystery-box open + reveal, BOX GEAR tab wear/remove, ADMIN box lifecycle.
// Run: node test/smoke-shop.js
const { runTest } = require('./harness');

runTest('SMOKE-SHOP', `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const log = (m) => R.steps.push(m);
  function press(k){ handleKey(k, ()=>{}); }
  try {
    // Past the post-splash input guard so presses register.
    simNow=100000; _splashExiting=false; _splashLeftAt=-1e9; _splashKeyHeld=false;

    // Mystery box shop: render the boxes page and open a box without error.
    phase='shop'; shopPage=BOX_PAGE; shopSel=0; drawShop();
    _cachedFOKoins=5000000; cfg.shopItems={}; _openBox(BOXES[0]); drawShop();
    if(!_boxReward) throw 'opening a box produced no reward';
    log('mystery box shop ok: reward='+_boxReward.kind);

    // Box gear tab: a won box-exclusive cosmetic appears there and is wearable.
    cfg.shopItems=Object.assign(cfg.shopItems||{},{eyepatch:true}); cfg.wornItems={};
    if(!_gearList().some(g=>g.id==='eyepatch')) throw 'won box item missing from BOX GEAR list';
    shopPage=GEAR_PAGE; shopSel=0; drawShop();
    press(' '); if(!cfg.wornItems.eyepatch) throw 'BOX GEAR: SPACE did not wear the item';
    press(' '); if(cfg.wornItems.eyepatch)  throw 'BOX GEAR: SPACE did not remove the item';
    log('box gear tab ok');

    // ADMIN box: offered only when available, grants the guaranteed crown, then is consumed.
    _adminAvail=true; _adminConsumed=false; delete cfg.shopItems.admincrown;
    if(_boxList().length!==BOXES.length+1) throw 'ADMIN box not offered when available';
    _openBox(ADMIN_BOX);
    if(!(cfg.shopItems.admincrown && _adminConsumed)) throw 'ADMIN box did not grant + consume';
    if(_boxList().length!==BOXES.length) throw 'ADMIN box still offered after being claimed';
    log('admin box ok');

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
