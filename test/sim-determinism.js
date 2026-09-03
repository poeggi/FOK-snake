// Determinism lock: a fixed seed + fixed input sequence must always produce the
// exact same simulation state. Proven two ways: (1) run twice, assert identical
// state hash (reproducibility -- the basis for replay validation and lockstep);
// (2) assert that hash equals a recorded GOLDEN so the sim/presentation refactor
// cannot silently change sim output. Run: node test/sim-determinism.js
//
// TWO goldens, because the two modes are two separate timelines: the CLASSIC lane
// runs startGame() and can never see a duel-only rule, so the DUEL lane hashes
// exactly the RB_HASH_DUEL fields off _rbDuelSnap() -- the wire contract itself -- every tick
// of three full matches. Anything that changes what two duel clients must agree on
// (a rule, a spawn roll, the rng draw count, the snapshot's own field set) moves it.
const { runTest } = require('./harness');

// Recorded from the first green run; update ONLY intentionally (a deliberate rule
// change), never to paper over a refactor that shifted sim output.
// Regolden history: 7f2ad170:216 -> cbe587a2:219 (dirQueue pop-then-judge at the cap,
// a deliberate sim rule change: the newest intent revokes/replaces the queue tail)
// -> bb02d65e:216 (DEATH_DUR 54 -> 84 ticks: the crash animation gets half a second
// before the respawn, which shifts every tick after a death).
const GOLDEN = 'bb02d65e:216';
// Duel regolden history: b120bb92:22608 (first record, v2.7.2 -- taken AFTER the contested-heart
// roll went 1.5% -> 5% per gem spawn and after startDuel began zeroing deathMsg,
// powerPelletAt, _powerModeAt and _barMoveTick)
// -> 49f0dfb3:22608 (still v2.7.2: the pilots now WEAR gear, so _ws stops being an empty
// pair of lists and the steal is covered at last, and a crash hands a loose item back.
// Both halves proven by falsification -- disabling the hand-back alone gives 1c664557)
// -> c38ae1e0:31451 (a match-ending crash now takes the same DEATH_DUR beat as every other
// death instead of calling the match on the crash tick, so the last kill lands 84 ticks
// later; the pilots' input LCG runs on ACROSS matches, so every match after the first one
// that ends is re-rolled -- hence a whole-lane move rather than 8x84 ticks).
// -> 94a81a85:31451 (the board EDGE stopped being a place two snakes can pass: near-miss
// adjacency and the loose item's landing cell no longer wrap, so a pass judged across an edge --
// and every steal roll and rng draw behind it -- is gone from the lane)
// -> 2a6bf65:31451 (contract 4.0: _ws carries a per-side {itemId: uid} map alongside the
// worn lists, because a server item INSTANCE is what a steal moves. Hashed bytes only --
// the tick count is untouched, and the pilots wear unregistered gear so every uid is '')
const GOLDEN_DUEL = '2a6bf65:31451';

const driver = `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const GOLDEN = ${JSON.stringify(GOLDEN)}, GOLDEN_DUEL = ${JSON.stringify(GOLDEN_DUEL)};
  const FNV = (h, str)=>{ for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619); } return h; };
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
      return (FNV(2166136261>>>0, str)>>>0).toString(16)+':'+str.length;
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
    // Eight full matches. The pilots chase the gem greedily but never step within
    // Chebyshev 2 of the opponent head, so a head-on cannot happen by accident and the
    // deaths in the run are the SCRIPTED ones -- one ramming window early in each match.
    // That death is what opens the contested-heart gate (level 2+ AND somebody below the
    // life cap), and 'advance' has to be sent by hand because a duel level only ends when
    // a player confirms it. Without all three the run never reaches the duel-only rolls
    // and the golden silently covers nothing: measured 85 eligible gem spawns, 2 hearts.
    // Tick-0 fields of each run. Every duel leak so far (deathMsg, powerPelletAt,
    // _powerModeAt, _barMoveTick) was a hashed field startDuel does not reset, and it shows
    // up here as run 2 starting where run 1 left off -- so name the field, not just a hash.
    const _first = [];
    function runDuelOnce(){
      let h = 2166136261>>>0, n = 0;
      let s = 909; const inp=()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
      const AX = [{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}];
      const cheb = (a,b)=>Math.max(Math.min((a.x-b.x+COLS)%COLS,(b.x-a.x+COLS)%COLS),
                                   Math.min((a.y-b.y+ROWS)%ROWS,(b.y-a.y+ROWS)%ROWS));
      const aimAt = (H,t)=>{
        const dx=((t.x-H.x+COLS+COLS/2)%COLS)-COLS/2, dy=((t.y-H.y+ROWS+ROWS/2)%ROWS)-ROWS/2;
        return (Math.abs(dx)>=Math.abs(dy) ? [{x:Math.sign(dx),y:0},{x:0,y:Math.sign(dy)}]
                                           : [{x:0,y:Math.sign(dy)},{x:Math.sign(dx),y:0}]).filter(d=>d.x||d.y);
      };
      const pilot = (p, ram)=>{
        const P=players[p], H=P.snake[0], foe=players[1-p];
        if(ram) return aimAt(H, foe.snake[0])[0] || null;
        const occ=new Set();
        for(const Q of players) for(const g of Q.snake) occ.add(g.x+','+g.y);
        for(const b of bars) if(!b.fragile) occ.add(b.x+','+b.y);
        let order = gem ? aimAt(H,gem) : [];
        if(inp()<0.02) order=[AX[Math.floor(inp()*4)]].concat(order);   // the odd wrong turn: near misses, dirQueue, bar deaths
        order=order.concat([P.dir],AX);
        for(const d of order){
          if(d.x===-P.dir.x&&d.y===-P.dir.y) continue;
          const t={x:(H.x+d.x+COLS)%COLS,y:(H.y+d.y+ROWS)%ROWS};
          if(occ.has(t.x+','+t.y)) continue;
          if(foe.alive!==false && cheb(t,foe.snake[0])<=2) continue;
          return d;
        }
        return null;
      };
      for(let m=0; m<8; m++){
        // Both pilots wear gear, so _ws is LIVE state rather than an empty pair of lists:
        // the ram window is the only place heads get close enough to roll a steal, and the
        // crash that follows it is what returns the loose item. Cheap and dear on each side,
        // because the roll is price-scaled.
        startDuel((0x0DDBA11 ^ Math.imul(m+1, 0x9E3779B1))>>>0, [['shades','cylinder'],['crown','eyepatch']]);
        let ram=-1;
        for(let i=0; i<4000 && duelWinner<0; i++){
          if(ram<0 && i>=120) ram=i;
          const ramming = i<ram+30;
          for(let p=0; p<2; p++){
            const P = players[p]; if(!P || P.alive===false) continue;
            const d = pilot(p, ramming && p===1); if(d) simCommand({t:'dir', p, dir:d});
            if(inp()<0.03) simCommand(P.boosting ? {t:'boostend', p} : {t:'boost', p, dir:P.dir});
          }
          if(phase==='levelDone' && levelDoneWaiting) simCommand({t:'advance'});
          update();
          // Read through RB_HASH_DUEL so the golden IS the wire contract: a field added to
          // the agreement enters this hash automatically, and the two snapshot fields that are
          // deliberately NOT agreed on (_barsV, levelDoneWaiting) stay out of it.
          const snap = _rbDuelSnap();
          if(m===0 && i===0) _first.push(RB_HASH_DUEL.map(k=>k+'='+(JSON.stringify(snap[k])||'u')).join('~'));
          h = FNV(h, RB_HASH_DUEL.map(k=>JSON.stringify(snap[k]) || "u").join("|"));
          n++;
        }
      }
      return (h>>>0).toString(16)+':'+n;
    }
    const h1=runOnce(), h2=runOnce();
    if(h1!==h2) throw 'NON-DETERMINISTIC: '+h1+' != '+h2;
    if(GOLDEN==='__PENDING__') R.steps.push('deterministic hash='+h1+'  (record this as GOLDEN)');
    else if(h1!==GOLDEN) throw 'sim output changed vs golden: got '+h1+', expected '+GOLDEN;
    else R.steps.push('deterministic + matches golden ('+h1+')');

    const d1=runDuelOnce(), d2=runDuelOnce();
    if(d1!==d2){
      const fa=(_first[0]||'').split('~'), fb=(_first[1]||'').split('~');
      const bad=fa.filter((x,i)=>x!==fb[i]).map(x=>x.split('=')[0]);
      throw 'DUEL NON-DETERMINISTIC: '+d1+' != '+d2+
            (bad.length ? ' -- tick 0 already differs in ['+bad.join(', ')+']: startDuel does not reset it'
                        : ' -- tick 0 agrees, so it diverges mid-match');
    }
    if(GOLDEN_DUEL==='__PENDING__') R.steps.push('duel lockstep hash='+d1+'  (record this as GOLDEN_DUEL)');
    else if(d1!==GOLDEN_DUEL) throw 'duel lockstep changed vs golden: got '+d1+', expected '+GOLDEN_DUEL;
    else R.steps.push('duel lockstep (per-tick RB_HASH_DUEL) matches golden ('+d1+')');
    R.ok=true;
  } catch(e){ R.err=String(e && e.stack || e); }
})();
`;
runTest('SIM-DETERMINISM', driver);
