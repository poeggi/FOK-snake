// Shop smoke: mystery-box open + reveal, BOX GEAR tab wear/remove, ADMIN box lifecycle,
// wear slots (one 'head'/'eyes'/'neck'/'masquerade' item at a time + the REMOVE-first
// notice), windswept tags.
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

    // Wear slots: cat groups headwear ('head'), eyewear ('eyes'), neckwear ('neck') and
    // face disguise ('masquerade'); only one item per slot wears at a time, a second
    // attempt is refused with a notice naming the blocker. windswept is a pure data tag
    // (a 1:1 feature consumes it) and must sit on hats/crowns/eyewear/moustache but NOT
    // on the halo or slot-free items.
    const _it=id=>SHOP_ITEMS.concat(BOX_ITEMS).find(s=>s.id===id);
    cfg.shopItems=Object.assign(cfg.shopItems||{},{cylinder:true,crown:true,shades:true,necktie:true,bow:true});
    cfg.wornItems={}; _shopMsg=null;
    _shopToggleWear(_it('cylinder'));
    if(!cfg.wornItems.cylinder) throw 'hat did not wear onto an empty head slot';
    if(!_shopToggleWear(_it('crown'))) throw 'refused wear must still count as handled (buy fall-through)';
    if(cfg.wornItems.crown) throw 'crown worn OVER the hat: head slot not exclusive';
    if(_shopMsg!=='REMOVE CYLINDER HAT FIRST') throw 'refusal notice wrong/missing: '+_shopMsg;
    _shopToggleWear(_it('shades'));
    if(!cfg.wornItems.shades) throw 'eyewear wrongly blocked by the worn HEAD item';
    _shopToggleWear(_it('necktie'));
    if(!cfg.wornItems.necktie) throw 'neck slot wrongly blocked by the worn HEAD item';
    _shopMsg=null; _shopToggleWear(_it('bow'));
    if(cfg.wornItems.bow||_shopMsg!=='REMOVE NECKTIE FIRST') throw 'bow tie ignored the worn necktie';
    _shopToggleWear(_it('cylinder'));   // take the hat off...
    _shopToggleWear(_it('crown'));      // ...now the crown fits
    if(!(cfg.wornItems.crown&&!cfg.wornItems.cylinder)) throw 'remove-then-wear did not free the slot';
    // Buying into an occupied slot: owned, NOT auto-worn, notice queued behind PURCHASED!.
    delete cfg.shopItems.wizard; _cachedFOKoins=5000000; _shopMsg=null;
    shopPage=1; shopSel=SHOP_ITEMS.filter(it=>(it.page||0)===1).findIndex(it=>it.id==='wizard');
    press('Enter');
    if(!cfg.shopItems.wizard) throw 'buy into an occupied slot did not purchase';
    if(cfg.wornItems.wizard) throw 'purchase auto-worn OVER the worn crown';
    if(_shopMsg!=='REMOVE ROYAL CROWN FIRST') throw 'buy refusal notice wrong/missing: '+_shopMsg;
    if(!(_it('crown').windswept&&_it('moustache').windswept&&_it('shades').windswept&&_it('propeller').windswept)) throw 'windswept tag missing';
    if(_it('halo').windswept||_it('gown').windswept||_it('necktie').windswept) throw 'windswept tag on a non-windswept item';
    if(_it('halo').cat!=='divine'||_it('moustache').cat!=='masquerade'||_it('eyepatch').cat!=='eyes'||_it('bow').cat!=='neck'||_it('shoes').cat) throw 'wear-slot cats off';
    log('wear slots + windswept ok');

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
