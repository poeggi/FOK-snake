// ================================================================
// SIMULATION CORE (deterministic, presentation-free)
// Advances the game from (seed + inputs). Records side-effects as events
// (see emit / simEvents) instead of performing them; game.js replays them via
// drainSimEvents(). Loaded after assets.js, before game.js. Shares global scope.
// ================================================================

function startLen(lvl) {
    if (lvl <= 2) return 3; if (lvl <= 5) return 5; if (lvl <= 8) return 7; return 10;
}

function _lvlGper(l){ return LEVEL_CFG[l-1][['easy','normal','hard'][cfg.diff]]; }
let boostDir=null, boostSince=0, boosting=false;   // boostSince is a simTick stamp
const BOOST_GRACE_TICKS=10;
function clearBoost(){boostDir=null;boosting=false;}

const ck = p => `${p.x},${p.y}`;
// Seeded PRNG (mulberry32) drives ALL simulation randomness so a game is fully
// reproducible from (seed + inputs) -- the basis for replay-validated high scores
// and lockstep 1v1. Seed the RNG per game in startGame(); cosmetic-only randomness
// (particles, splash text) stays on Math.random and never touches sim state.
let _rngState = 1, gameSeed = 0;
function seedRng(s){ _rngState = (s >>> 0) || 1; }
function rng(){
    _rngState = (_rngState + 0x6D2B79F5) | 0;
    let t = Math.imul(_rngState ^ (_rngState >>> 15), 1 | _rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = n => Math.floor(rng() * n);
// The simulation records side-effects (audio, coins, achievements, bonus text,
// fireworks, HUD, particles) as events instead of performing them; the presentation
// layer replays them in drainSimEvents(). This keeps the sim free of DOM/audio so a
// server can replay it headlessly.
let simEvents = [];
function emit(e){ simEvents.push(e); }
function freeCell(blocked) {
    let p, tries=0;
    do { p={x:ri(COLS),y:ri(ROWS)}; } while(blocked.has(ck(p)) && ++tries<1000);
    if(tries>=1000) { for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++) { p={x,y}; if(!blocked.has(ck(p))) return p; } }
    return p;
}

function startGame(seed) { gameSeed = (seed!=null) ? (seed>>>0) : ((Math.random()*0x100000000)>>>0); seedRng(gameSeed);
    level=1; lives=START_LIVES; score=0; perfectCount=0; luckyCount=0; _levelStartLen=0; _earlyHeartUsed=false; _earlyHeartTrigger=Math.floor(rng()*30); _earlyHeartCount=0;
    let best=0; try{ for(const s of getScores()) if((s.score||0)>best) best=s.score; }catch{}
    _shimmerThreshold=Math.max(best,25000);
    beginLevel(); }

// Edge ring is always fragile; the ring one cell inward is fragile 25% of the time.
function _barFragile(x,y) {
    if(x===0||x===COLS-1||y===0||y===ROWS-1) return true;
    if(x===1||x===COLS-2||y===1||y===ROWS-2) return rng()<0.25;
    return false;
}
function beginLevel(isRespawn=false) {
    const lcfg=LEVEL_CFG[level-1], d=DIFF[cfg.diff];
    gPer = lcfg[['easy','normal','hard'][cfg.diff]];
    const cx=Math.floor(COLS/2), cy=Math.floor(ROWS/2);
    const sl = _levelStartLen > 0 ? _levelStartLen : startLen(level);
    _levelStartLen = sl;
    snake = Array.from({length:sl},(_,i)=>({x:cx-i,y:cy}));
    dir={x:1,y:0}; dirQueue=[]; gem=null; gemsDone=0; bars=[];
    phase='levelReady'; _gDue=0; _stepAccum=0; phaseAt=simNow;
    spawnAt=0; levelDoneWaiting=false;
    perfectLevel=true; levelWasPerfect=false; fireworks=[]; levelBonusCount=0; epicLevelCount=0;
    _gourangaLine=[]; _gourangaActive=false; _gourangaEaten=new Set();
    heart=null; heartAt=0; heartIsEarly=false; _crushEffects=[];
    powerPellet=null; _powerMode=false;
    timeCrystal=null; _slowMode=false;
    clearBoost();
    const blocked = new Set(snake.concat([{x:cx+1,y:cy},{x:cx+2,y:cy}]).map(ck));
    const numBars = Math.min(28, Math.round(lcfg.bars * d.bm));
    for(let i=0;i<numBars;i++){
        const b=freeCell(blocked); blocked.add(ck(b));
        bars.push(Object.assign({}, b, {fragile:_barFragile(b.x,b.y)}));
    }
    // ~10% of bars extend into a 2-cell unit; no wrapping so rendering stays simple
    const _bl=bars.length;
    for(let i=0;i<_bl;i++){
        const b=bars[i];
        if(rng()>=0.1) continue;
        const dirs=[{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}];
        for(let i=dirs.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[dirs[i],dirs[j]]=[dirs[j],dirs[i]];}
        for(const d of dirs){
            const nx=b.x+d.x, ny=b.y+d.y;
            if(nx<0||nx>=COLS||ny<0||ny>=ROWS) continue;
            const nk=ck({x:nx,y:ny});
            if(!blocked.has(nk)){
                blocked.add(nk);
                bars.push({x:nx,y:ny,paired:true,fragile:b.fragile});
                b.pairEnd={x:nx,y:ny}; break;
            }
        }
    }
    spawnGem();
    if(isRespawn && (((level===7||level===8)&&lives===2)||((level===9||level===10)&&lives===1)) && rng()<0.10){
        const hBlocked=new Set(snake.concat(bars).map(ck));
        heart=freeCell(hBlocked); heartAt=simNow;
    }
    emit({t:'bars'}); emit({t:'munpause'}); emit({t:'showhud',v:true});
}

let gemOptimal=0, gemSteps=0;
function _tryGouranga(blocked) {
    if(rng()>=0.01) return;
    // Diagonals are rarer (20% combined) than the orthogonal lines
    const {dx,dy}=rng()<0.2
        ? (rng()<0.5?{dx:1,dy:1}:{dx:1,dy:-1})
        : (rng()<0.5?{dx:1,dy:0}:{dx:0,dy:1});
    for(let tries=0;tries<30;tries++){
        const sx=ri(dx?COLS-6:COLS);
        const sy=dy>0?ri(ROWS-6):dy<0?6+ri(ROWS-6):ri(ROWS);
        const line=[]; let ok=true;
        for(let i=0;i<7;i++){
            const p={x:sx+dx*i,y:sy+dy*i};
            if(blocked.has(ck(p))){ok=false;break;}
            line.push(p);
        }
        if(ok){_gourangaLine=line;_gourangaActive=true;return;}
    }
}
// Fewest walkable moves from head to goal on the wrap-around board. Blocked = the
// snake's own body (minus the tail tip, which vacates as it moves, and thus matches
// the in-game collision rule) plus solid barricades; fragile barricades are passable
// since the snake can smash through them. Returns Infinity if the goal is walled off.
function _pathDist(start, goal) {
    const gk = ck(goal);
    if (ck(start) === gk) return 0;
    const blocked = new Set(snake.slice(1, -1).concat(bars.filter(b => !b.fragile)).map(ck));
    const STEP = [{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}];
    let frontier = [start], seen = new Set([ck(start)]), dist = 0;
    while (frontier.length) {
        dist++;
        const next = [];
        for (const c of frontier) {
            for (const d of STEP) {
                const nx = (c.x + d.x + COLS) % COLS, ny = (c.y + d.y + ROWS) % ROWS;
                const nk = nx + ',' + ny;
                if (nk === gk) return dist;
                if (seen.has(nk) || blocked.has(nk)) continue;
                seen.add(nk); next.push({x:nx, y:ny});
            }
        }
        frontier = next;
    }
    return Infinity;
}
function spawnGem() {
    if(!_gourangaActive && level>=2 && (gemsDone===1||gemsDone===2)){
        _tryGouranga(new Set(snake.concat(bars).map(ck)));
        if(_gourangaActive) return;
    }
    gem=freeCell(new Set(snake.concat(bars).map(ck)));
    const rv=rng();
    gem.tier = rv<0.0005 ? 2 : rv<0.0105 ? 1 : 0;
    if(gem.tier===2) emit({t:'sfx',name:'epic_spawn'});
    else if(gem.tier===1) emit({t:'sfx',name:'lucky_spawn'});
    gemAt=gem.spawnAt=simNow;
    // Fewest actual moves to the gem, routing around the snake's own body and solid
    // barricades. Manhattan distance ignored those, making the "fewest steps" x2 bonus
    // unfairly hard whenever the body blocked the direct line. +2 preserves the original
    // slack; if the gem is walled off, fall back to the wrapped Manhattan estimate.
    const pd=_pathDist(snake[0], gem);
    if(pd===Infinity){
        let dgx=gem.x-snake[0].x, dgy=gem.y-snake[0].y;
        if(dgx>COLS/2) dgx-=COLS; if(dgx<-COLS/2) dgx+=COLS;
        if(dgy>ROWS/2) dgy-=ROWS; if(dgy<-ROWS/2) dgy+=ROWS;
        const turnPenalty=(dgx*dir.x+dgy*dir.y<0&&Math.abs(dgx*dir.y-dgy*dir.x)===0)?2:0;
        gemOptimal=Math.abs(dgx)+Math.abs(dgy)+turnPenalty+2;
    } else {
        gemOptimal=pd+2;
    }
    gemSteps=0;
    if(!powerPellet&&!_powerMode&&rng()<0.002){
        const ppB=new Set(snake.concat(bars).map(ck)); ppB.add(ck(gem));
        if(heart) ppB.add(ck(heart));
        powerPellet=freeCell(ppB); powerPelletAt=simNow;
    }
    // Time crystal: level 6+, per-gem chance scales 0.1%/level (L6 0.1% .. L10 0.5%)
    if(!timeCrystal&&!_slowMode&&level>=6&&rng()<(level-5)*0.001){
        const tcB=new Set(snake.concat(bars).map(ck)); tcB.add(ck(gem));
        if(powerPellet) tcB.add(ck(powerPellet));
        if(heart) tcB.add(ck(heart));
        timeCrystal=freeCell(tcB); timeCrystalAt=simNow;
    }
    if(!_earlyHeartUsed&&level>=4&&level<=6){
        if(_earlyHeartCount===_earlyHeartTrigger&&!heart){
            const hB=new Set(snake.concat(bars).map(ck)); hB.add(ck(gem));
            if(powerPellet) hB.add(ck(powerPellet));
            heart=freeCell(hB); heartAt=simNow; heartIsEarly=true; _earlyHeartUsed=true;
        }
        _earlyHeartCount++;
    }
}

function step(now) {
    while(dirQueue.length>0){ const nd=dirQueue.shift(); if(nd.x!==-dir.x||nd.y!==-dir.y){dir=nd;break;} }
    const head={x:(snake[0].x+dir.x+COLS)%COLS,y:(snake[0].y+dir.y+ROWS)%ROWS};
    const hk=ck(head);
    const protect = now - spawnAt < SPAWN_PROTECT;
    if(_powerMode && now-_powerModeAt>=_POWER_DUR){ _powerMode=false; emit({t:'bars'}); }
    if(!protect){
        const hitBar=bars.find(b=>ck(b)===hk);
        if(hitBar){
            if(hitBar.fragile||_powerMode){
                let primCk=ck(hitBar);
                if(hitBar.paired){const p=bars.find(b=>b.pairEnd&&ck(b.pairEnd)===primCk);if(p)primCk=ck(p);}
                const primBar=bars.find(b=>ck(b)===primCk);
                const secCk=primBar&&primBar.pairEnd?ck(primBar.pairEnd):null;
                emit({t:'crush', x:hitBar.x, y:hitBar.y});
                bars=bars.filter(b=>ck(b)!==primCk&&(secCk===null||ck(b)!==secCk));
                const barReward=level*100; emit({t:'coin',n:barReward}); emit({t:'bonus',label:'+'+barReward+' FK!'});
                emit({t:'sfx',name:'crash'});
                if(!_powerMode) emit({t:'bars'});
            } else { die(now); return; }
        }
    }
    if(powerPellet&&ck(powerPellet)===hk){
        powerPellet=null; _powerMode=true; _powerModeAt=now;
        score+=level*200; emit({t:'bonus',label:'POWER UP!'});
    }
    if(heart&&ck(heart)===hk){lives=Math.min(lives+1,START_LIVES+1);heart=null;emit({t:'bonus',label:'+1 UP!'});}
    if(timeCrystal&&ck(timeCrystal)===hk){timeCrystal=null;_slowMode=true;_slowModeAt=now;gPer=_lvlGper(3);emit({t:'bonus',label:'TIME WARP!'});}
    const ate=gem&&ck(gem)===hk;
    const ateGourangaIdx=_gourangaActive?_gourangaLine.findIndex((g,i)=>!_gourangaEaten.has(i)&&ck(g)===hk):-1;
    const anyAte=ate||ateGourangaIdx>=0;
    if(!protect && (anyAte?snake:snake.slice(0,-1)).some(s=>ck(s)===hk)){die(now);return;}
    if(!anyAte) gemSteps++;
    snake.unshift(head);
    if(anyAte){
        gemsDone++;
        if(ateGourangaIdx>=0){
            _gourangaEaten.add(ateGourangaIdx);
            const bonusMult=(levelBonusCount+1)*2;
            score+=level*100*bonusMult;
            levelBonusCount++;
            if(levelBonusCount>=5) emit({t:'ach',id:'bonus_3'});
            if(_gourangaEaten.size>=7){
                _gourangaActive=false;
                emit({t:'ach',id:'gouranga'});
                emit({t:'bonus',label:'GOURANGA!'}); emit({t:'sfx',name:'perfect'});
            } else {
                emit({t:'bonus',label:`x${bonusMult} BONUS!`});
                emit({t:'sfx',name:'eat'});
            }
            emit({t:'ach',id:'first_gem'});
        }
        if(ate){
            const base=level*100;
            const tier=gem.tier||0;
            const bonus=gemOptimal>0&&gemSteps<=gemOptimal;
            if(!bonus && tier===0) perfectLevel=false;
            const bonusMult=(levelBonusCount+1)*2;
            const mult=tier===2?100:tier===1?10:1;
            const diffMult=(cfg.diff===2&&level>=2)?2:1;
            score+=bonus?base*bonusMult*mult*diffMult:base*mult*diffMult;
            if(tier===2){
                emit({t:'bonus',label:bonus?`EPIC x${100*bonusMult}!`:'EPIC x100!'});
                emit({t:'sfx',name:'epic_eat'});
                emit({t:'ach',id:'epic_gem'});
                epicLevelCount++; if(epicLevelCount>=2) emit({t:'ach',id:'epic_double'});
            } else if(tier===1){
                emit({t:'bonus',label:bonus?`LUCKY x${10*bonusMult}!`:'LUCKY x10!'});
                emit({t:'sfx',name:'lucky_eat'});
                emit({t:'ach',id:'lucky_gem'});
                luckyCount++; if(luckyCount>=3) emit({t:'ach',id:'lucky_streak'});
            } else if(bonus){
                emit({t:'bonus',label:`x${bonusMult} BONUS!`});
                emit({t:'sfx',name:'bonus'});
            } else emit({t:'sfx',name:'eat'});
            emit({t:'ach',id:'first_gem'});
            if(bonus){ levelBonusCount++; if(levelBonusCount>=5) emit({t:'ach',id:'bonus_3'}); } else levelBonusCount=0;
        }
        if(score>=64000)  emit({t:'ach',id:'score_25k'});
        if(score>=100000) emit({t:'ach',id:'score_100k'});
        if(gemsDone>=GEMS_PER_LEVEL){
            gem=null; score+=level*500;
            if(perfectLevel){
                score+=level*1000; emit({t:'fw'}); emit({t:'sfx',name:'perfect'});
                emit({t:'coin',n:10000});
                emit({t:'ach',id:'perfect_level'});
                perfectCount++; if(perfectCount>=3) emit({t:'ach',id:'triple_perf'});
            } else emit({t:'sfx',name:'levelUp'});
            emit({t:'ach',id:'level1'});
            if(level>=5)  emit({t:'ach',id:'level5'});
            if(level>=10){
                emit({t:'ach',id:'level10'});
                if(cfg.diff===2)               emit({t:'ach',id:'hard_champ'});
                if(lives>=START_LIVES)         emit({t:'ach',id:'no_deaths'});
            }
            phase='levelDone'; phaseAt=now;
        } else {
            if(!_gourangaActive) spawnGem();
        }
    } else snake.pop();
    if(anyAte && cfg.diff > 0) snake.push(Object.assign({}, snake[snake.length - 1]));
}

function die(now) {
    lives--; phase='dying'; phaseAt=now;
    deathMsg=lives>0?`LIFE LOST  (${lives} left)`:'GAME OVER!';
    emit({t:'sfx',name:'die'}); emit({t:'mpause'});
}

function update() {
    simTick++;
    simNow = simTick * TICK_MS;
    const now = simNow;
    if(phase==='playing'){
        if(boostDir&&boostDir.x===dir.x&&boostDir.y===dir.y&&dirQueue.length===0){
            if(!boosting&&simTick-boostSince>=BOOST_GRACE_TICKS&&cfg.turbo!==false)boosting=true;
        }else boosting=false;
        // Fixed per-level game tick (gPer). Normal steps every 2nd game tick, boost
        // every game tick -- boost changes the accrual, never gPer.
        if(--_gDue<=0){
            _gDue=gPer;
            _stepAccum += boosting?2:1;
            if(_stepAccum>=2){ _stepAccum-=2; step(now); }
        }
    }
    if(heart&&heartIsEarly&&now-heartAt>=EARLY_HEART_TTL){heart=null;heartIsEarly=false;}
    if(_slowMode&&now-_slowModeAt>=_SLOW_DUR){_slowMode=false;gPer=_lvlGper(level);}
    if(phase==='levelReady'&&now-phaseAt>=READY_DUR+GO_DUR){
        phase='playing'; _gDue=gPer; _stepAccum=0; spawnAt=now; phaseAt=0;
    }
    if(phase==='dying'&&now-phaseAt>=DEATH_DUR){
        if(lives>0)beginLevel(true);
        else{phase='nameEntry';emit({t:'gameover'});}   // presentation loads the last name, hides HUD, stops music
    }
    if(phase==='levelDone'&&!levelDoneWaiting&&now-phaseAt>=LEVELDONE_DUR){
        levelDoneWaiting=true;
    }
    if(phase==='splash'&&_splashExiting&&now-_splashExitAt>=T(30)){
        _splashExiting=false;
        phase='menu'; phaseAt=now; _splashLeftAt=now;
    }
}
