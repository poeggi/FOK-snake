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
const BOOST_GRACE_TICKS=12;   // ~200ms hold before boost engages (was 10/167ms: a tap could trip it)
function clearBoost(){boostDir=null;boosting=false;}

// Sim timing constants (ticks -> ms via T from assets.js). Declared HERE so the sim is
// self-contained: a Web Worker can load assets.js + sim.js without game.js.
const _POWER_DUR=T(360);        // 6s power mode
const EARLY_HEART_TTL=T(600);   // 10s early-heart lifespan
const SPAWN_PROTECT=T(60);      // 1s post-spawn collision immunity
const _SLOW_DUR=T(1800);        // 30s time-warp slow

// ---- SIM STATE (moved out of game.js so the sim owns it and can run in a Worker) ----
// phase is shared with the UI: the sim owns it during gameplay (levelReady..nameEntry);
// the UI sets it for menus. _shimmerThreshold feeds the render-only gown shimmer.
let phase = 'splash';
let _shimmerThreshold = 25000;
let level, lives, score, _levelStartLen = 0;
let snake, dir, dirQueue;
let gem, gemsDone, bars;
let _barsV = 0;   // bumped whenever bars content changes -- lets the worker send bars only then
// simTick = integer source of truth; simNow = its ms projection (simTick * TICK_MS).
let simTick = 0, simNow = 0;
// gPer = engine ticks per game tick (the level's fixed boost period); _gDue counts down to
// the next game tick; _stepAccum accrues movement (normal +1, boost +2) and spends 2 per step.
let gPer, _gDue = 0, _stepAccum = 0, phaseAt = 0, gemAt, deathMsg;
let spawnAt = 0, levelDoneWaiting = false;
let perfectLevel = true, levelWasPerfect = false;
let levelBonusCount = 0, epicLevelCount = 0;
let _gourangaLine=[], _gourangaActive=false, _gourangaEaten=new Set();
let heart=null, heartAt=0, heartIsEarly=false, _earlyHeartUsed=false, _earlyHeartTrigger=-1, _earlyHeartCount=0;
let powerPellet=null, powerPelletAt=0, _powerMode=false, _powerModeAt=0;
let _barMoveTick=0;   // power-mode bar-drift cadence (blocks flee every 2nd game tick)
// DEBUG x10: multiplies every rare-event probability (pellet/crystal/gouranga/gem tiers/
// respawn heart) by 10 for testing. cfg.x10 is persisted config, read at call time like
// cfg.diff/cfg.turbo (the worker receives it via the cfg message; like diff, a replay or
// match must pin it). At the default 1 every threshold is float-identical.
// Classic play scales rare events by the local debug setting; a DUEL pins the
// scale for the whole match (set once at startDuel from the host's setting and
// carried to both clients) -- per-client cfg would make the two sims diverge.
let _duelX10 = false;
const _X10=()=>players?(_duelX10?10:1):(cfg.x10?10:1);
let timeCrystal=null, timeCrystalAt=0, _slowMode=false, _slowModeAt=0;
let perfectCount = 0, luckyCount = 0;
// ---- 1:1 DUEL state. null = classic single-player (that path is untouched). In duel,
// players = [P0, P1]; ALL duel input arrives as commands carrying a player index
// ({t:'dir', p, dir}) -- the same boundary a future remote peer will feed, so going
// online later swaps the input SOURCE, never the sim.
let players = null;
let duelWinner = -1;   // -1 = none yet; 0/1 = winner index; 2 = draw (head-on / double death)

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

function startGame(seed, bestScore) { players = null; duelWinner = -1;   // classic mode: no duel state
    gameSeed = (seed!=null) ? (seed>>>0) : ((Math.random()*0x100000000)>>>0); seedRng(gameSeed);
    level=1; lives=START_LIVES; score=0; perfectCount=0; luckyCount=0; _levelStartLen=0; _earlyHeartUsed=false; _earlyHeartTrigger=Math.floor(rng()*30); _earlyHeartCount=0;
    // bestScore is passed in -- the presentation owns localStorage; the sim stays IO-free.
    _shimmerThreshold=Math.max(bestScore||0,25000);
    beginLevel(); }

// ---- 1:1 DUEL --------------------------------------------------------------
// Same PROGRESSION as single player, played together: start at level 1, shared 10-gem
// goal per level, level-up regenerates barricades and raises the speed (LEVEL_CFG,
// pinned to NORMAL difficulty for fairness regardless of local cfg). Each player has
// 3 hearts for the whole match; a death costs a heart and restarts the CURRENT level
// (fresh bars, gems reset -- classic respawn semantics); out of hearts ends the match
// (both at once = draw). Gem = level*100 to the eater, +2 growth (classic normal).
// TWIST: whoever eats the level-finishing gem earns a heart back (capped at 3).
// Hitting the opponent kills you; head-on / simultaneous gem grab kills both.
// No power-ups, no coins/achievements (economy protection).
// A duel snake's spawn length, and the floor a CHOMP may chew it down to. A snake is
// always a head AND a body: a lone head reads as a broken render, not as a hit taken.
const DUEL_LEN = 3, DUEL_MIN_LEN = 2;
function _mkDuelPlayer(x0, y0, dx) {
    return { snake: Array.from({length:DUEL_LEN},(_,i)=>({x:(x0-dx*i+COLS)%COLS, y:y0})),
             dir: {x:dx, y:0}, dirQueue: [],
             boostDir: null, boostSince: 0, boosting: false, stepAccum: 0,
             score: 0, lives: START_LIVES, alive: true, slowUntil: 0 };
}
// (Re)build the current duel level: fresh symmetric spawns (lives + scores kept),
// level-scaled barricades and speed, gems reset, READY/GO. Used for the match start,
// every level-up, and the level restart after a death.
// SPEED ROUND: a 1-in-20 level that runs at level 10's pace whatever level it is.
// Rolled from the SEEDED rng, so both clients decide it identically without a word
// crossing the wire -- the same property that lets the whole duel run without an
// authority. Never on level 1: it is a twist on a level you just earned.
const _SPEED_ROUND_P = 0.05;
let _speedRound = false;
function _duelBeginLevel() {
    // LEVEL_CFG has 10 entries; a duel is endless, so past level 10 it reuses the last
    // (hardest) config rather than reading off the end and throwing mid-match.
    const li = Math.min(level, LEVEL_CFG.length) - 1;
    _speedRound = level > 1 && rng() < _SPEED_ROUND_P;
    gPer = _speedRound ? LEVEL_CFG[9].normal : LEVEL_CFG[li].normal;
    if(_speedRound) emit({t:'bonus', label:'SPEED ROUND!'});
    for (let i = 0; i < 2; i++) {
        const keep = players[i];
        const fresh = i === 0 ? _mkDuelPlayer(6, Math.floor(ROWS/2)-4, 1)
                              : _mkDuelPlayer(COLS-7, Math.floor(ROWS/2)+4, -1);
        fresh.lives = keep.lives; fresh.score = keep.score;
        players[i] = fresh;
    }
    gemsDone = 0;
    bars = [];
    const blocked = new Set(players[0].snake.concat(players[1].snake).map(ck));
    for (let i = 0; i < 3; i++) {   // clear runway ahead of both spawns
        blocked.add(ck({x:(6+1+i)%COLS, y:Math.floor(ROWS/2)-4}));
        blocked.add(ck({x:(COLS-7-1-i+COLS)%COLS, y:Math.floor(ROWS/2)+4}));
    }
    const numBars = Math.min(28, Math.round(LEVEL_CFG[li].bars * DIFF[1].bm));
    for (let i = 0; i < numBars; i++) {
        const b = freeCell(blocked); blocked.add(ck(b));
        bars.push({x:b.x, y:b.y, fragile:false});
    }
    _barsV++;
    powerPellet = null; _powerMode = false;
    _duelSpawnGem();
    _gDue = 0; spawnAt = 0; phase = 'duelReady'; phaseAt = simNow;
    emit({t:'lvlreset'}); emit({t:'bars'});
}
function startDuel(seed, x10) {
    // Tick zero. simTick free-runs from page load, so without this two online
    // clients would start a duel with wildly different counters -- and every piece
    // of state stamped from simNow (phaseAt, gemAt, spawnAt, boostSince...) would
    // differ by that offset forever. The duel IS the shared timeline: both clients
    // begin it at the same server-issued start_pts, so both begin it at tick 0.
    simTick = 0; simNow = 0;
    gameSeed = (seed!=null) ? (seed>>>0) : ((Math.random()*0x100000000)>>>0); seedRng(gameSeed);
    _duelX10 = !!x10;
    level = 1; duelWinner = -1;
    players = [ _mkDuelPlayer(6, Math.floor(ROWS/2)-4,  1),      // P0 left, heading right
                _mkDuelPlayer(COLS-7, Math.floor(ROWS/2)+4, -1) ];   // P1 right, heading left (mirror)
    _duelBeginLevel();
    emit({t:'munpause'}); emit({t:'showhud',v:true});
}
function _duelSpawnGem() {
    gem = freeCell(new Set(players[0].snake.concat(players[1].snake, bars).map(ck)));
    gem.tier = 0; gemAt = gem.spawnAt = simNow;
    // Power pellet: same rare roll as classic (per gem spawn, level 2+, X10-scaled).
    if (!powerPellet && !_powerMode && rng() < 0.002 * _X10() && level >= 2) {
        const ppB = new Set(players[0].snake.concat(players[1].snake, bars).map(ck));
        ppB.add(ck(gem));
        powerPellet = freeCell(ppB); powerPelletAt = simNow;
    }
}
// One duel game tick: both due snakes move SIMULTANEOUSLY (heads computed first, then
// deaths resolved together) so neither player has a resolution-order advantage.
function duelStep(now) {
    const moves = [null, null];
    for (let i = 0; i < 2; i++) {
        const P = players[i];
        if (!P.alive || P.stepAccum < 2) continue;
        P.stepAccum -= 2;
        while (P.dirQueue.length > 0) { const nd = P.dirQueue.shift(); if (nd.x !== -P.dir.x || nd.y !== -P.dir.y) { P.dir = nd; break; } }
        moves[i] = {x:(P.snake[0].x+P.dir.x+COLS)%COLS, y:(P.snake[0].y+P.dir.y+ROWS)%ROWS};
    }
    if (_powerMode && now - _powerModeAt >= _POWER_DUR) { _powerMode = false; emit({t:'bars'}); }
    if (!moves[0] && !moves[1]) return;
    const protect = now - spawnAt < SPAWN_PROTECT;
    const dead = [false, false];
    const crushK = [null, null], biteK = [null, null];
    const barKeys = new Set(bars.map(ck));
    for (let i = 0; i < 2; i++) {
        if (!moves[i]) continue;
        const hk = ck(moves[i]), other = players[1-i];
        const eats = gem && ck(gem) === hk;
        if (!protect) {
            if (barKeys.has(hk)) {
                if (_powerMode) crushK[i] = hk;   // powered: smash through, classic-style
                else dead[i] = true;
            }
            // own body: tail vacates unless eating (same rule as classic; power does not excuse it)
            else if ((eats ? players[i].snake : players[i].snake.slice(0,-1)).some(s => ck(s) === hk)) dead[i] = true;
            // opponent's snake: lethal normally; POWERED it becomes food -- biting the
            // head kills THEM, biting the body eats their tail off and slows the biter.
            else if (other.alive && other.snake.some(s => ck(s) === hk)) {
                if (!_powerMode) dead[i] = true;
                else if (ck(other.snake[0]) === hk) dead[1-i] = true;
                else biteK[i] = hk;
            }
        }
    }
    // head-on: both moving into the same cell (also covers a simultaneous gem grab)
    if (moves[0] && moves[1] && !protect && ck(moves[0]) === ck(moves[1])) { dead[0] = dead[1] = true; }
    if (dead[0] || dead[1]) {
        if (dead[0]) players[0].lives--;
        if (dead[1]) players[1].lives--;
        emit({t:'sfx',name:'die'});
        const out0 = players[0].lives <= 0, out1 = players[1].lives <= 0;
        if (out0 || out1) {
            players[0].alive = !out0; players[1].alive = !out1;
            duelWinner = (out0 && out1) ? 2 : (out0 ? 1 : 0);
            phase = 'duelOver'; phaseAt = now;
            emit({t:'mpause'});
        } else {
            _duelBeginLevel();   // heart lost, the CURRENT level restarts (classic respawn)
        }
        return;
    }
    // Powered bar crush (no pairs in duel bars; no coin rewards in duel).
    for (let i = 0; i < 2; i++) {
        if (!crushK[i]) continue;
        const cb = bars.find(b => ck(b) === crushK[i]);
        if (cb) {
            emit({t:'crush', x:cb.x, y:cb.y}); emit({t:'sfx',name:'crash'});
            bars = bars.filter(b => ck(b) !== crushK[i]); _barsV++;
        }
    }
    // Apply both moves first; gem consequences afterwards (a level-up rebuilds the
    // players array, so it must not happen while this loop still holds references).
    let eater = -1;
    for (let i = 0; i < 2; i++) {
        if (!moves[i]) continue;
        const P = players[i];
        P.snake.unshift(moves[i]);
        if (powerPellet && ck(powerPellet) === ck(moves[i])) {
            powerPellet = null; _powerMode = true; _powerModeAt = now; _barMoveTick = 0;
            P.score += level * 200; emit({t:'bonus',label:'POWER UP!'});
        }
        if (eater < 0 && gem && ck(gem) === ck(moves[i])) {
            eater = i;
            P.snake.push(Object.assign({}, P.snake[P.snake.length - 1]));   // +2 growth (classic normal)
        } else P.snake.pop();
    }
    // Bites resolve after the moves: the victim's tail is eaten off from the bitten
    // segment back (if it moved away this very tick, it escaped), the biter chews
    // at half speed for 2 seconds. Nobody dies from a body bite.
    for (let i = 0; i < 2; i++) {
        if (!biteK[i]) continue;
        const other = players[1-i];
        const idx = other.snake.findIndex(s => ck(s) === biteK[i]);
        // A bite at the NECK (idx 1) used to leave a head with no body at all, which
        // reads as a broken render rather than a hit taken. The chomp still bites as
        // deep as it can; it just cannot take the last body segment with it.
        if (idx > 0) other.snake.length = Math.max(idx, DUEL_MIN_LEN);
        players[i].slowUntil = now + T(120);
        emit({t:'sfx',name:'crash'}); emit({t:'bonus',label:'CHOMP!'});
    }
    if (eater >= 0) {
        players[eater].score += level * 100;
        gemsDone++;
        if (gemsDone >= GEMS_PER_LEVEL) {
            // Twist: the level-finisher earns a heart back (max 3).
            if (players[eater].lives < START_LIVES) players[eater].lives++;
            emit({t:'sfx',name:'levelUp'});
            if (level < MAX_LEVELS) level++;   // at 10 the duel continues at max difficulty
            _duelBeginLevel();
            return;
        }
        emit({t:'sfx',name:'eat'});
        _duelSpawnGem();
    }
}

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
    perfectLevel=true; levelWasPerfect=false; levelBonusCount=0; epicLevelCount=0;
    _gourangaLine=[]; _gourangaActive=false; _gourangaEaten=new Set();
    heart=null; heartAt=0; heartIsEarly=false;
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
    _barsV++;
    spawnGem();
    if(isRespawn && (((level===7||level===8)&&lives===2)||((level===9||level===10)&&lives===1)) && rng()<Math.min(1,0.10*_X10())){
        const hBlocked=new Set(snake.concat(bars).map(ck));
        heart=freeCell(hBlocked); heartAt=simNow;
    }
    // 'lvlreset' tells the presentation to clear leftover particle arrays (fireworks,
    // crush) -- those are presentation-owned, so the sim emits instead of touching them.
    emit({t:'lvlreset'}); emit({t:'bars'}); emit({t:'munpause'}); emit({t:'showhud',v:true});
}

let gemOptimal=0, gemSteps=0;
function _tryGouranga(blocked) {
    if(rng()>=0.01*_X10()) return;
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
    gem.tier = rv<0.0005*_X10() ? 2 : rv<0.0105*_X10() ? 1 : 0;
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
    // No pellets on level 1 (nothing to smash through yet is worth 5.5s of power).
    // level>=2 sits AFTER the rng() call so the RNG stream is identical either way.
    if(!powerPellet&&!_powerMode&&rng()<0.002*_X10()&&level>=2){
        const ppB=new Set(snake.concat(bars).map(ck)); ppB.add(ck(gem));
        if(heart) ppB.add(ck(heart));
        powerPellet=freeCell(ppB); powerPelletAt=simNow;
    }
    // Time crystal: level 6+, per-gem chance scales 0.1%/level (L6 0.1% .. L10 0.5%)
    if(!timeCrystal&&!_slowMode&&level>=6&&rng()<(level-5)*0.001*_X10()){
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
                bars=bars.filter(b=>ck(b)!==primCk&&(secCk===null||ck(b)!==secCk)); _barsV++;
                const barReward=level*100; emit({t:'coin',n:barReward}); emit({t:'bonus',label:'+'+barReward+' FK!'});
                emit({t:'sfx',name:'crash'});
                if(!_powerMode) emit({t:'bars'});
            } else { die(now); return; }
        }
    }
    if(powerPellet&&ck(powerPellet)===hk){
        powerPellet=null; _powerMode=true; _powerModeAt=now; _barMoveTick=0;
        // The wall panics: pairs dissolve into independent blocks that flee one cell at a
        // time (see _moveBarsGhost) until the power runs out -- then they freeze in place.
        bars.forEach(b=>{ delete b.paired; delete b.pairEnd; });
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
            const mult=tier===2?80:tier===1?10:1;
            const diffMult=(cfg.diff===2&&level>=2)?2:1;
            score+=bonus?base*bonusMult*mult*diffMult:base*mult*diffMult;
            if(tier===2){
                emit({t:'bonus',label:bonus?`EPIC x${80*bonusMult}!`:'EPIC x80!'});
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
                levelWasPerfect=true;   // sim-owned: the levelDone screen shows PERFECT! off this
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

// POWER MODE: barricades flee like frightened ghosts. Each block tries one random step
// per drift tick -- never onto the snake, another block, a pickup, or off the board
// (blocks do not wrap). Seeded rng, consumed ONLY during power mode, so the RNG stream
// of a game without a pellet is untouched.
function _moveBarsGhost(){
    const DIRS=[{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}];
    const blocked=new Set(bars.map(ck));
    (players ? players[0].snake.concat(players[1].snake) : snake).forEach(s=>blocked.add(ck(s)));
    if(gem) blocked.add(ck(gem));
    if(powerPellet) blocked.add(ck(powerPellet));
    if(heart) blocked.add(ck(heart));
    if(timeCrystal) blocked.add(ck(timeCrystal));
    if(_gourangaActive) _gourangaLine.forEach(g=>blocked.add(ck(g)));
    for(const b of bars){
        // Each block holds one heading for 1-2s (60-120 engine ticks) so the flight
        // reads as directed, not jittery; a blocked step bounces into a new heading.
        // (gd/gdUntil live only sim-side: the render transport strips them.)
        if(b.gd==null || simTick>=b.gdUntil){ b.gd=ri(4); b.gdUntil=simTick+60+ri(61); }
        let d=DIRS[b.gd], nx=b.x+d.x, ny=b.y+d.y;
        if(nx<0||nx>=COLS||ny<0||ny>=ROWS||blocked.has(nx+','+ny)){
            b.gd=ri(4); b.gdUntil=simTick+60+ri(61);
            d=DIRS[b.gd]; nx=b.x+d.x; ny=b.y+d.y;
            if(nx<0||nx>=COLS||ny<0||ny>=ROWS||blocked.has(nx+','+ny)) continue;
        }
        blocked.delete(ck(b)); b.x=nx; b.y=ny; blocked.add(nx+','+ny);
    }
    _barsV++;
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
            if(_powerMode && ++_barMoveTick>=2){ _barMoveTick=0; _moveBarsGhost(); }
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
    // ---- 1:1 duel ticking (players non-null only in duel mode)
    if(phase==='duelReady'&&now-phaseAt>=READY_DUR+GO_DUR){
        phase='duel'; _gDue=gPer; spawnAt=now; phaseAt=0;
        players.forEach(P=>{ P.stepAccum=0; });
    }
    if(phase==='duel'){
        for(const P of players){   // per-player boost latch, same grace rule as classic
            if(P.boostDir&&P.boostDir.x===P.dir.x&&P.boostDir.y===P.dir.y&&P.dirQueue.length===0){
                if(!P.boosting&&simTick-P.boostSince>=BOOST_GRACE_TICKS)P.boosting=true;
            }else P.boosting=false;
        }
        if(--_gDue<=0){
            _gDue=gPer;
            for(const P of players){ if(P.alive) P.stepAccum += (P.boosting?2:1)*(now<P.slowUntil?0.5:1); }
            if(_powerMode && ++_barMoveTick>=2){ _barMoveTick=0; _moveBarsGhost(); }
            duelStep(now);
        }
    }
    // NOTE: the splash->menu transition is presentation/UI, not simulation -- it lives on
    // the main thread (see updateSplashExit in game.js), so the sim never touches splash state.
}

// ---- Worker snapshot protocol -------------------------------------------------
// simSnapshot() returns a plain, structured-cloneable copy of the whole sim state; the
// worker posts it each tick and the main thread applies it into its mirror globals (which
// render.js reads). simApply() is the inverse. Both live in sim.js so the field list has a
// single source of truth. _gourangaEaten is a Set (structuredClone handles Sets natively).
function simSnapshot(){
    return {
        phase, _shimmerThreshold, level, lives, score, _levelStartLen,
        snake, dir, dirQueue, gem, gemsDone, bars, _barsV, simTick, simNow,
        gPer, _gDue, _stepAccum, phaseAt, gemAt, deathMsg, spawnAt, levelDoneWaiting,
        perfectLevel, levelWasPerfect, levelBonusCount, epicLevelCount,
        _gourangaLine, _gourangaActive, _gourangaEaten,
        heart, heartAt, heartIsEarly, _earlyHeartUsed, _earlyHeartTrigger, _earlyHeartCount,
        powerPellet, powerPelletAt, _powerMode, _powerModeAt, _barMoveTick,
        timeCrystal, timeCrystalAt, _slowMode, _slowModeAt,
        perfectCount, luckyCount, boostDir, boostSince, boosting, gemOptimal, gemSteps,
        players, duelWinner, _duelX10, _speedRound, _rngState,
    };
}
// Apply one input/control command to the sim state. Single source of truth shared by the
// Web Worker (sim-worker.js onmessage) and the headless path (game.js _wsend when there is
// no Worker -- tests + any browser without Worker support). Pure sim effects only; the
// worker wraps pause/resume/start with its own tick-loop + post handling.
function simCommand(m){
    switch(m.t){
        case 'start': startGame(m.seed, m.bestScore); break;
        case 'startDuel': startDuel(m.seed, m.x10); break;
        // dir/boost carry an optional player index (m.p). In duel mode they route to
        // players[p]; classic mode keeps the original single-snake path untouched.
        // A remote peer's input will arrive as these SAME commands with p = their index.
        case 'dir': {
            if(players){
                const P = players[m.p||0]; if(!P || !P.alive) break;
                const last = P.dirQueue.length>0 ? P.dirQueue[P.dirQueue.length-1] : P.dir;
                if(!(m.dir.x===-last.x&&m.dir.y===-last.y) && !(m.dir.x===last.x&&m.dir.y===last.y) && P.dirQueue.length<3) P.dirQueue.push(m.dir);
                break;
            }
            const last = dirQueue.length>0 ? dirQueue[dirQueue.length-1] : dir;
            if(!(m.dir.x===-last.x&&m.dir.y===-last.y) && !(m.dir.x===last.x&&m.dir.y===last.y) && dirQueue.length<3) dirQueue.push(m.dir);
            break;
        }
        case 'boost':
            if(players){ const P=players[m.p||0]; if(P&&P.alive){ P.boostDir=m.dir; P.boostSince=simTick; P.boosting=!!m.now; } break; }
            boostDir=m.dir; boostSince=simTick; boosting=!!m.now; break;
        case 'boostend':
            if(players){ const P=players[m.p||0]; if(P){ P.boostDir=null; P.boosting=false; } break; }
            boostDir=null; boosting=false; break;
        case 'advance':
            // Guard HERE (authoritative state): the main thread's levelDone gate reads a
            // mirror that an in-flight stale snapshot can re-arm, so a held Enter could
            // send 'advance' twice -- without this check that would skip a level.
            if(phase!=='levelDone' || !levelDoneWaiting) break;
            if(level<MAX_LEVELS){ _levelStartLen = cfg.diff===2?snake.length:0; level++; beginLevel(); }
            else { phase='nameEntry'; emit({t:'gameover', reason:'win'}); }
            break;
        case 'pause':
            if(phase==='playing') phase='paused';
            else if(phase==='duel') phase='duelPaused';   // LOCAL duel only; online will not send 'pause'
            break;
        case 'resume':
            if(phase==='paused'){ phase='playing'; _gDue=gPer; _stepAccum=0; }
            else if(phase==='duelPaused'){ phase='duel'; _gDue=gPer; players.forEach(P=>{ P.stepAccum=0; }); }
            break;
        case 'phase':
            phase=m.phase; phaseAt=simNow;
            if(m.phase==='menu'){ players=null; duelWinner=-1; }   // leaving a duel clears its state
            break;
    }
}
function simApply(s){
    phase=s.phase; _shimmerThreshold=s._shimmerThreshold; level=s.level; lives=s.lives; score=s.score; _levelStartLen=s._levelStartLen;
    snake=s.snake; dir=s.dir; dirQueue=s.dirQueue; gem=s.gem; gemsDone=s.gemsDone; bars=s.bars; _barsV=s._barsV; simTick=s.simTick; simNow=s.simNow;
    gPer=s.gPer; _gDue=s._gDue; _stepAccum=s._stepAccum; phaseAt=s.phaseAt; gemAt=s.gemAt; deathMsg=s.deathMsg; spawnAt=s.spawnAt; levelDoneWaiting=s.levelDoneWaiting;
    perfectLevel=s.perfectLevel; levelWasPerfect=s.levelWasPerfect; levelBonusCount=s.levelBonusCount; epicLevelCount=s.epicLevelCount;
    _gourangaLine=s._gourangaLine; _gourangaActive=s._gourangaActive; _gourangaEaten=s._gourangaEaten;
    heart=s.heart; heartAt=s.heartAt; heartIsEarly=s.heartIsEarly; _earlyHeartUsed=s._earlyHeartUsed; _earlyHeartTrigger=s._earlyHeartTrigger; _earlyHeartCount=s._earlyHeartCount;
    powerPellet=s.powerPellet; powerPelletAt=s.powerPelletAt; _powerMode=s._powerMode; _powerModeAt=s._powerModeAt; _barMoveTick=s._barMoveTick;
    timeCrystal=s.timeCrystal; timeCrystalAt=s.timeCrystalAt; _slowMode=s._slowMode; _slowModeAt=s._slowModeAt;
    perfectCount=s.perfectCount; luckyCount=s.luckyCount; boostDir=s.boostDir; boostSince=s.boostSince; boosting=s.boosting; gemOptimal=s.gemOptimal; gemSteps=s.gemSteps;
    players=s.players; duelWinner=s.duelWinner; _duelX10=s._duelX10; _speedRound=s._speedRound; if(s._rngState!=null) _rngState=s._rngState;
}
