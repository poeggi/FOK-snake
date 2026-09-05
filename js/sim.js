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
let boostDir=null, boosting=false;
let _gAt=0;   // engine tick of the last accrual boundary: a boost flip authored after it has changed nothing yet
const BOOST_GRACE_TICKS=12;   // ~200ms hold before boost engages (was 10/167ms: a tap could trip it)
function clearBoost(){boostDir=null;boosting=false;}

// Sim timing constants (ticks -> ms via T from assets.js). Declared HERE so the sim is
// self-contained: a Web Worker can load assets.js + sim.js without game.js.
const _POWER_DUR=T(540);        // 9s power mode
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
let _gourangaLine=[], _gourangaActive=false, _gourangaEaten=new Set(), _gourangaSteps=0;
// The GOURANGA payoff (achievement + fanfare) only fires on a near-continuous sweep of
// the 7-gem line: 6 straight moves plus 2 blocks of detour slack. A detoured completion
// still scores the same escalating bonuses but ends as an ordinary run.
const GOURANGA_MAX_MOVES = (7 - 1) + 2;
let heart=null, heartAt=0, heartIsEarly=false, _earlyHeartUsed=false, _earlyHeartTrigger=-1, _earlyHeartCount=0;
let powerPellet=null, powerPelletAt=0, _powerMode=false, _powerModeAt=0;
let _barMoveTick=0;   // power-mode bar-drift cadence counter
let _nmWasAdjacent=false;   // near-miss edge tracker -- REAL sim state, see _duelNearMiss
const _BAR_MOVE_EVERY=6;   // blocks step once every 6th game tick -- ONE cadence for both modes (a calm glide, slower than the snake)
// DEBUG x10: multiplies every rare-event probability (pellet/crystal/gouranga/gem tiers/
// respawn heart) by 10 for testing. cfg.x10 is persisted config, read at call time like
// cfg.diff/cfg.turbo (the worker receives it via the cfg message). CLASSIC ONLY: a duel
// never honors it -- like difficulty, a duel always runs the normal ruleset. That is a
// CONTRACT, not state: no x10 flag exists in duel mode, on the wire, or in the duel
// snapshot/hash lists.
const _X10=()=>players?1:(cfg.x10?10:1);
let timeCrystal=null, timeCrystalAt=0, _slowMode=false, _slowModeAt=0;
let perfectCount = 0, luckyCount = 0;
// ---- 1:1 DUEL state. null = classic single-player (that path is untouched). In duel,
// players = [P0, P1]; ALL duel input arrives as commands carrying a player index
// ({t:'dir', p, dir}) -- the same boundary a future remote peer will feed, so going
// online later swaps the input SOURCE, never the sim.
let players = null;
let duelWinner = -1;   // -1 = none yet; 0/1 = winner index; 2 = draw (head-on / double death)
// WINDSWEPT COSMETICS (duel only; null in classic). w[i] = the windswept item ids player i is
// WEARING right now -- the sim owns this for the length of the match, so the renderer takes
// the windswept half of a duel look from here rather than from either device's config. it =
// the single loose item, knocked off by a near-miss and lying on the board: { id, uid, own
// (who it falls back to), x, y, at (the tick it lands on) }. ONE loose item at a time, which
// is also the steal cooldown. Seeded at startDuel from the two exchanged profiles -- never
// from _duelLook, whose cfg.noRemoteCosmetics view is local and would desync the roll.
//
// u[i] = { itemId: uid } for the same worn items: the SERVER's unique id of the exact
// instance player i is wearing, which is what a transfer has to name for the server to move
// the right row (see items.js). It rides in a map rather than alongside w because both
// players can legitimately wear the same catalog item -- two crowns, two different uids --
// and per-side maps keep those apart with no index bookkeeping to drift. An empty uid is
// normal and means "acquired offline, never registered": still worn, still stealable, just
// not attestable until it has one.
let _ws = null;
const WS_LAND_TICKS = 30;   // 500ms of flight before the item touches down and can be taken

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

// NEAR-MISS (duel): fires on the rising edge of the two heads passing within one cell
// (Chebyshev <=1, measured straight across the board). Adjacency deliberately does NOT wrap:
// a head on the top row and a head on the bottom row are a whole screen apart to the two people
// playing, and gear must not fly off a pass they never saw. Movement still wraps -- an edge is
// only transparent to a snake crossing it, never to a pass alongside it.
// Judged here in the sim -- every game tick, deterministically -- so it never depends on which
// tick a RAF happens to sample; fast/boost levels advance 2 cells/tick and can skip the single
// adjacency frame render-side.
// Only a pass on DIFFERENT headings counts: shake (heavy when both are boosting) plus a roll
// for a windswept item to be knocked off (_duelStealRoll), at odds that double for whoever
// the OTHER snake tore past -- boosting through a pass is the aggressive act. Gear comes
// off HEAD to HEAD only: grinding along somebody's tail must not strip them.
// Running side by side on the SAME heading is a scrape, not a pass -- no shake, nothing comes
// loose, just sparks and a squeal. That one is pure presentation and lives entirely in the
// renderer (_duelScrapeFx in render.js), judged per frame off the positions already on
// screen: it draws no rng and touches no state, so there is nothing about it to keep in
// lockstep and no reason to make a sim event of it.
// _nmWasAdjacent is REAL sim state, hashed and snapshotted: it gates an rng-consuming roll,
// so a rollback that re-armed it would fire a second steal on one client only and desync.
function _duelNearMiss(){
    if(phase!=='duel' || !players || !players[0].alive || !players[1].alive){ _nmWasAdjacent=false; return; }
    const a=players[0].snake[0], b=players[1].snake[0];
    const adj=Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y))<=1;
    const d0=players[0].dir, d1=players[1].dir;
    if(adj && !_nmWasAdjacent && !(d0.x===d1.x && d0.y===d1.y)){
        const boosts = (players[0].boosting?1:0) + (players[1].boosting?1:0);
        emit({t:'nearmiss', heavy: boosts===2});
        _duelStealRoll();
    }
    _nmWasAdjacent=adj;
}
// The steal roll at a pass. Everything here comes off the shared PRNG and hashed state, so
// both clients reach the same verdict with nothing crossing the wire -- the same property
// that lets the whole duel run without an authority.
// Order of draws is fixed (victim, item, chance, side, distance, offset) because the NUMBER
// of rng calls is itself part of the lockstep contract: a client that drew once more would
// take the whole rest of the match from a different stream position.
function _duelStealRoll(){
    if(!_ws || _ws.it) return;   // one loose item at a time: that IS the anti-farming cooldown
    const n0=_ws.w[0].length, n1=_ws.w[1].length;
    if(!n0 && !n1) return;
    const v = (n0 && n1) ? ri(2) : (n0 ? 0 : 1);
    const list = _ws.w[v];
    const id = list[ri(list.length)];
    const uid = _ws.u[v][id] || '';
    // Price-scaled: cheap gear flies off, crowns cling on. What SPEED changes is not how fast
    // the victim was going but how hard the OTHER snake tore past -- a boosting rival doubles
    // the odds; your own boost neither protects you nor costs you. So neither-boosting and
    // both-boosting are symmetric, and exactly one boosting is the asymmetric case, paid for
    // by the one who did NOT boost. Integer, and the same number of draws either way, so the
    // rng stream never depends on who happened to be boosting. The ladder tops out at 40 x2,
    // which is why nothing here needs a cap: no pass is ever a foregone loss.
    const pct = WS[id].pct * (players[1-v].boosting ? 2 : 1);
    if(ri(100) >= pct) return;
    // Where it lands: a few cells off one flank of the victim's heading, give or take a cell
    // fore or aft, and CLAMPED to the board rather than wrapped -- gear knocked off at an edge
    // settles against that edge instead of sailing over it and landing a screen away from the
    // pass that caused it. Blocked cells (snakes, bars, the other collectibles) fall back to the
    // ordinary free-cell scan, which is deterministic too. Clamping moves the cell, never the
    // number of rng draws, so the shared stream stays in step either way.
    const P = players[v], H = P.snake[0], d = P.dir;
    const side = ri(2) ? 1 : -1;
    const dist = 2 + ri(3);       // 2..4 cells out to the side
    const along = ri(3) - 1;      // -1..1 cells along the heading
    const blocked = new Set(players[0].snake.concat(players[1].snake, bars).map(ck));
    if(gem) blocked.add(ck(gem));
    if(heart) blocked.add(ck(heart));
    if(powerPellet) blocked.add(ck(powerPellet));
    const clamp=(n,max)=> n<0 ? 0 : (n>max-1 ? max-1 : n);
    let c = { x:clamp(H.x - d.y*side*dist + d.x*along, COLS),
              y:clamp(H.y + d.x*side*dist + d.y*along, ROWS) };
    if(blocked.has(ck(c))) c = freeCell(blocked);
    list.splice(list.indexOf(id), 1);
    delete _ws.u[v][id];   // the instance travels ON the loose item now, not in the worn map
    _ws.it = { id, uid, own:v, x:c.x, y:c.y, at:simTick + WS_LAND_TICKS };
    emit({t:'wsblow', id, own:v, hx:H.x, hy:H.y, x:c.x, y:c.y});
}
// Taking the loose item, whichever way it was reached. Only one item per wear slot stays
// ON: a won hat pushes off the hat already worn. The displaced one is still OWNED (see
// _wsTransfer) -- just not worn, so it is no longer on this snake to be stolen either.
// uid names the exact instance that changed hands, which is what the server's items row is
// keyed by -- the catalog id alone could be either player's copy.
function _wsTake(i) {
    const g = _ws.it; _ws.it = null;
    const w = _ws.w[i], um = _ws.u[i], cat = WS[g.id].cat;
    if (cat) for (let k = w.length - 1; k >= 0; k--) if (WS[w[k]].cat === cat) { delete um[w[k]]; w.splice(k, 1); }
    w.push(g.id); um[g.id] = g.uid;
    emit({t:'wsget', id:g.id, uid:g.uid, from:g.own, to:i});
}
function freeCell(blocked) {
    let p, tries=0;
    do { p={x:ri(COLS),y:ri(ROWS)}; } while(blocked.has(ck(p)) && ++tries<1000);
    if(tries>=1000) { for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++) { p={x,y}; if(!blocked.has(ck(p))) return p; } }
    return p;
}

function startGame(seed, bestScore) { players = null; duelWinner = -1; _ws = null; _nmWasAdjacent = false;   // classic mode: no duel state
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
// SNAKE_MIN_LEN is the floor EVERY bite respects, in every mode: a bite that would leave a
// head with no body at all reads as a broken render rather than a hit taken, so the chomp
// goes as deep as it can and stops there.
const DUEL_LEN = 3, SNAKE_MIN_LEN = 2;
function _mkDuelPlayer(x0, y0, dx) {
    return { snake: Array.from({length:DUEL_LEN},(_,i)=>({x:(x0-dx*i+COLS)%COLS, y:y0})),
             dir: {x:dx, y:0}, dirQueue: [],
             boostDir: null, boosting: false, stepAccum: 0,
             score: 0, lives: _duelHeartsMax, alive: true, slowUntil: 0 };
}
// ---- POWER BITE: one rule, every mode ----
// With the power pill up, running into your OWN body stops being lethal: the head goes
// through and everything from the bitten segment back falls away. It is the rule a chomp
// already applies to the OTHER snake -- eaten off from the bitten segment back -- turned on
// its owner, so it is written once here and called from step() and duelStep() rather than
// implemented per mode: single player, local 1:1 and online 1:1 shorten identically.
// The SHORTENING is sim state (it rides the snapshot and the duel's lockstep hash, so both
// clients cut the same segments on the same tick); the pieces flying off are the renderer's.
//
// _powerBiteIdx searches the PRE-move body and returns the bitten index, or 0 for none --
// index 0 is the head, which a move can never land on, so 0 doubles as "nowhere". The
// caller passes the same body the lethal check uses, tail tip excluded unless eating, so a
// bite always costs at least one segment (the tip vacates as the head arrives).
function _powerBiteIdx(body, hk) {
    for (let j = 1; j < body.length; j++) if (ck(body[j]) === hk) return j;
    return 0;
}
// ...and _powerBite applies it AFTER the move, where the unshifted head has pushed the
// bitten segment one place along. That segment goes too: the head is standing on it now.
function _powerBite(snk, at) {
    snk.length = Math.max(at + 1, SNAKE_MIN_LEN);
}
// (Re)build the current duel level: fresh symmetric spawns (lives + scores kept),
// level-scaled barricades and speed, gems reset, READY/GO. Used for the match start,
// every level-up, and the level restart after a death.
// SPEED ROUND: a 1-in-10 level that runs at level 10's pace whatever level it is. DUEL ONLY
// -- set in _duelBeginLevel and NOWHERE else; single-player clears it (see beginLevel).
// Rolled from the SEEDED rng, so both clients decide it identically without a word
// crossing the wire -- the same property that lets the whole duel run without an
// authority. Never on level 1: it is a twist on a level you just earned.
const _SPEED_ROUND_P = 0.10;
let _speedRound = false;
// Per-level seed from (gameSeed, level): a level's content is a pure function of the two, so a
// re-seed here re-anchors both clients identically regardless of prior rng consumption.
function _duelLevelSeed(base, lvl){ return (((base >>> 0) + Math.imul(lvl >>> 0, 0x9E3779B1)) >>> 0) || 1; }
// reseed=true only when a genuinely NEW level opens (match start, level-up): re-anchor the
// stream to (gameSeed, level) so both clients build the identical board. A RESPAWN passes
// false and leaves the rng where play left it -- the two sims are already in lockstep on
// _rngState (hashed + rollback-restored), so continuing the stream hands both clients the
// SAME fresh gem/barricade/speed-round variant, exactly like single player. Re-seeding on a
// respawn is what pinned every death to the identical board.
function _duelBeginLevel(reseed) {
    if(reseed === undefined) reseed = true;
    // LEVEL_CFG has 10 entries; a duel is endless, so past level 10 it reuses the last
    // (hardest) config rather than reading off the end and throwing mid-match.
    const li = Math.min(level, LEVEL_CFG.length) - 1;
    if(reseed) seedRng(_duelLevelSeed(gameSeed, level));
    // Roll the speed round HERE and nowhere else, on EVERY spawn: a new level and every
    // respawn after a death each take their own 1-in-10 chance. It used to be rolled only
    // when a level opened, so a level that came up hot STAYED hot through every death on it
    // -- which is exactly what made a speed round so punishing to finish. A death now
    // re-rolls it in either direction. The draw rides the shared PRNG (re-anchored to
    // (gameSeed, level) on a new level, flowing on a respawn; _rngState is hashed and
    // rollback-restored either way), so both clients reach the same verdict.
    _speedRound = level > 1 && rng() < _SPEED_ROUND_P;
    if(_speedRound) emit({t:'bonus', label:'SPEED ROUND!'});
    gPer = _speedRound ? LEVEL_CFG[9].normal : LEVEL_CFG[li].normal;
    // A blown-off item nobody picked up goes back to the snake it came off: the board is
    // about to be rebuilt, and losing gear to a rebuild is not something either player did.
    if(_ws && _ws.it){ _wsWearBack(_ws.it); _ws.it = null; }
    _nmWasAdjacent = false;   // fresh spawns are far apart; never carry a pass across a rebuild
    for (let i = 0; i < 2; i++) {
        const keep = players[i];
        const fresh = i === 0 ? _mkDuelPlayer(6, Math.floor(ROWS/2)-4, 1)
                              : _mkDuelPlayer(COLS-7, Math.floor(ROWS/2)+4, -1);
        fresh.lives = keep.lives; fresh.score = keep.score;
        players[i] = fresh;
    }
    gemsDone = 0;
    const blocked = new Set(players[0].snake.concat(players[1].snake).map(ck));
    for (let i = 0; i < 3; i++) {   // clear runway ahead of both spawns
        blocked.add(ck({x:(6+1+i)%COLS, y:Math.floor(ROWS/2)-4}));
        blocked.add(ck({x:(COLS-7-1-i+COLS)%COLS, y:Math.floor(ROWS/2)+4}));
    }
    const numBars = Math.min(28, Math.round(LEVEL_CFG[li].bars * DIFF[1].bm));
    bars = _placeBars(blocked, numBars);
    _barsV++;
    powerPellet = null; _powerMode = false;
    heart = null; heartAt = 0;   // the contested heart never survives a level rebuild/respawn
    _duelSpawnGem();
    _gDue = 0; spawnAt = 0; levelDoneWaiting = false; phase = 'duelReady'; phaseAt = simNow;
    emit({t:'lvlreset'}); emit({t:'bars'});
}
// ONLINE duels only: a death must not rebuild the board locally -- the respawn is a
// negotiated boundary (fresh start_pts + epoch, exactly like a level-up), so the sim HOLDS
// in 'dying' and emits one 'duelHalt' for the net layer instead of calling _duelBeginLevel.
// CONFIG, not state: set by the online entry path on BOTH clients alike (each peer's own
// entry sets it), constant for the whole match, never hashed and never snapshotted --
// local duels and single player keep the immediate rebuild.
let _duelNetHold = false;
// The duel's heart cap, negotiated PER MATCH and constant for its lifetime: ordinary
// duels and a tournament final run at START_LIVES, tournament round/knockout matches at 2.
// CONFIG like _duelNetHold, not state -- both clients adopt the same number from the 'go'
// before tick 0, so it never varies mid-match and never needs hashing. It IS mirrored
// through the snapshot, because the renderer must draw the heart row against the cap the
// match is actually running rather than the constant.
let _duelHeartsMax = START_LIVES;
// A cap off the wire is untrusted input: anything outside 1..START_LIVES reads as the
// default, so a malformed or absent hm can never hand a player extra lives.
function _duelHearts(h){ h = h|0; return (h >= 1 && h <= START_LIVES) ? h : START_LIVES; }
// The level a match OPENS at, same treatment: negotiated on the 'go', untrusted off the
// wire, anything outside 1..MAX_LEVELS reads as level 1. A tournament round ladder is the
// only thing that ever sets it above 1 -- and it is a PARAMETER of the one shared duel
// start, never a second way to start a duel: the board stays a pure function of
// (seed, level), which is exactly why the two sides must agree on the number.
function _duelLvl(l){ l = l|0; return (l >= 1 && l <= MAX_LEVELS) ? l : 1; }
// Builds one player's worn windswept state from an untrusted list. Ids the cosmetics tables
// do not know are dropped rather than trusted (the list arrives from a peer profile, and an
// unknown id would have no steal chance to roll against), and so is a repeat of an id
// already in the list -- an item can only be worn once, and a duplicate would otherwise sit
// in w twice with one entry in u.
//
// Accepts either bare ids or { id, uid } entries, because a LOCAL duel has no registry
// behind it and passes plain ids (_wsWorn). uid may also arrive separately as a map, which
// is the shape the resync wire uses. Anything that is not a 32-hex uid becomes '' -- an
// unregistered item, which is a valid state, not an error.
const WS_UID_RE = /^[0-9a-f]{32}$/;
const _wsId = v => (v && typeof v === 'object') ? v.id : v;
function _wsSeed(a, um){
    const w = [], u = {};
    if(Array.isArray(a)) for(const v of a){
        const id = _wsId(v);
        if(!WS[id] || u[id] !== undefined) continue;
        w.push(id);
        const q = um ? um[id] : (v && typeof v === 'object' ? v.uid : '');
        u[id] = (typeof q === 'string' && WS_UID_RE.test(q)) ? q : '';
    }
    return { w, u };
}
// A loose item going back on the snake it came off (a board rebuild, a crash): the id and
// the instance return together. Nothing changed hands, so no transfer is claimed.
function _wsWearBack(g){ _ws.w[g.own].push(g.id); _ws.u[g.own][g.id] = g.uid; }
const _HALT_RE = 6;   // held-death re-announce period in engine ticks (100ms) -- see the dying hold in update()
// ws = the two players' worn windswept item ids, [P0, P1], already in the fixed table order
// (_wsWorn on main). Both clients build BOTH lists from the same two exchanged profiles, so
// no list crosses the wire; ids the tables do not know are dropped rather than trusted.
function startDuel(seed, ws, lvl) {
    // Tick zero. simTick free-runs from page load, so without this two online
    // clients would start a duel with wildly different counters -- and every piece
    // of state stamped from simNow (phaseAt, gemAt, spawnAt...) would
    // differ by that offset forever. The duel IS the shared timeline: both clients
    // begin it at the same server-issued start_pts, so both begin it at tick 0.
    simTick = 0; simNow = 0;
    // Classic-mode globals survive from this device's last single-player game and the duel
    // never resets them -- but the duel sim DOES read some (a leftover heart/timeCrystal/
    // gouranga cell blocks a fleeing bar in _moveBarsGhost; a leftover _slowMode expiry
    // rewrites gPer from local cfg.diff) and _gAt is hashed. Two devices with different
    // histories would then desync. Zero them so a duel is a function of seed + inputs only.
    _gAt = 0;
    heart = null; heartAt = 0; heartIsEarly = false; _earlyHeartUsed = false; _earlyHeartTrigger = -1; _earlyHeartCount = 0;
    timeCrystal = null; timeCrystalAt = 0; _slowMode = false; _slowModeAt = 0;
    _gourangaLine = []; _gourangaActive = false; _gourangaEaten = new Set(); _gourangaSteps = 0;
    _nmWasAdjacent = false;
    deathMsg = '';   // hashed on the wire: a message left by this device's last game (single
                     // player or a previous duel) would make tick 0 hash differently on the two
                     // clients and read as a desync until the first death overwrote it.
    // Same trap, three more hashed fields: _duelBeginLevel drops the pellet and the power
    // mode but not their timestamps or the bar-drift counter, and classic play writes all
    // three. Inert while _powerMode is off -- but they are ON THE WIRE HASH, so two devices
    // with different last games would disagree at tick 0 over state neither one is using.
    powerPelletAt = 0; _powerModeAt = 0; _barMoveTick = 0;
    const s0 = _wsSeed(ws && ws[0]), s1 = _wsSeed(ws && ws[1]);
    _ws = { w:[s0.w, s1.w], u:[s0.u, s1.u], it:null };
    gameSeed = (seed!=null) ? (seed>>>0) : ((Math.random()*0x100000000)>>>0); seedRng(gameSeed);
    level = _duelLvl(lvl); duelWinner = -1;
    players = [ _mkDuelPlayer(6, Math.floor(ROWS/2)-4,  1),      // P0 left, heading right
                _mkDuelPlayer(COLS-7, Math.floor(ROWS/2)+4, -1) ];   // P1 right, heading left (mirror)
    _duelBeginLevel();
    emit({t:'munpause'}); emit({t:'showhud',v:true});
}
// A contested-heart cell as close to board center as is free: neutral ground both snakes
// can reach. Scanned center-outward in a fixed order (no rng), so it never moves the shared
// PRNG stream and both clients pick the identical cell.
function _duelHeartCell(blocked) {
    const cx = Math.floor(COLS/2), cy = Math.floor(ROWS/2);
    for (let r = 0; r < Math.max(COLS, ROWS); r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // walk each square ring once
            const c = { x:(cx+dx+COLS)%COLS, y:(cy+dy+ROWS)%ROWS };
            if (!blocked.has(ck(c))) return c;
        }
    }
    return null;
}
function _duelSpawnGem() {
    const gB = new Set(players[0].snake.concat(players[1].snake, bars).map(ck));
    if (heart) gB.add(ck(heart));   // a heart may still be on the board from an earlier gem this level
    gem = freeCell(gB);
    gem.tier = 0; gemAt = gem.spawnAt = simNow;
    // Power pellet: same rare roll as classic (per gem spawn, level 2+, X10-scaled).
    if (!powerPellet && !_powerMode && rng() < 0.002 * _X10() && level >= 2) {
        const ppB = new Set(players[0].snake.concat(players[1].snake, bars).map(ck));
        ppB.add(ck(gem)); if (heart) ppB.add(ck(heart));
        powerPellet = freeCell(ppB); powerPelletAt = simNow;
    }
    // Contested heart: one life-back on neutral ground, rolled per gem spawn but only when it
    // can matter (someone below the cap) and never stacked on another heart. The lives/heart
    // gates are all synced state so both clients take the same branch and consume the rng in
    // lockstep; the cell is chosen without rng (see _duelHeartCell).
    if (!heart && level >= 2 && players.some(p => p.lives < _duelHeartsMax) && rng() < 0.05 * _X10()) {
        const hB = new Set(players[0].snake.concat(players[1].snake, bars).map(ck));
        hB.add(ck(gem)); if (powerPellet) hB.add(ck(powerPellet));
        const hc = _duelHeartCell(hB);
        if (hc) { heart = hc; heartAt = simNow; }
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
    const crushK = [null, null], biteK = [null, null], selfK = [0, 0];
    const into = [null, null], hitAt = [null, null];   // renderer-only: what the death ran into, and where
    const barKeys = new Set(bars.map(ck));
    for (let i = 0; i < 2; i++) {
        if (!moves[i]) continue;
        const hk = ck(moves[i]), other = players[1-i];
        const eats = gem && ck(gem) === hk;
        // Where this move runs into the mover's OWN body (0 = nowhere).
        const selfAt = protect ? 0 : _powerBiteIdx(eats ? players[i].snake : players[i].snake.slice(0,-1), hk);
        if (!protect) {
            if (barKeys.has(hk)) {
                const hb = bars.find(b => ck(b) === hk);
                if (hb && (hb.fragile || _powerMode)) crushK[i] = hk;   // fragile OR powered: smash through, same rule as single player
                else { dead[i] = true; into[i] = 'bar'; hitAt[i] = moves[i]; }   // solid bar: lethal
            }
            // own body: the tail vacates unless eating (same rule as classic). POWERED this is
            // no longer lethal -- the head goes through and the tail falls off (see _powerBite).
            else if (selfAt > 0) {
                if (_powerMode) selfK[i] = selfAt;
                else { dead[i] = true; into[i] = 'self'; hitAt[i] = moves[i]; }
            }
            // opponent's snake: lethal normally; POWERED it becomes food -- biting the
            // head kills THEM, biting the body eats their tail off and slows the biter.
            else if (other.alive && other.snake.some(s => ck(s) === hk)) {
                if (!_powerMode) { dead[i] = true; into[i] = 'snake'; hitAt[i] = moves[i]; }
                else if (ck(other.snake[0]) === hk) { dead[1-i] = true; into[1-i] = 'snake'; hitAt[1-i] = moves[i]; }
                else biteK[i] = hk;
            }
        }
    }
    // A HEAD-ON is mutual, and it stays mutual whatever the step phase the two met in. The
    // two clauses below are ONE collision seen at two offsets: snakes on a closing course
    // meet in a shared CELL when the gap between them is even and both are due, and on a
    // shared EDGE when it is odd, where only one of them is due and it puts its head on the
    // other's. Judging only the mover -- which is all the per-player loop above can do, since
    // a snake that is not due has no move to judge -- charged that crash to whoever happened
    // to be out of step phase and let the other one drive away from it. Boosting alone puts
    // the two out of phase, so the edge case is the ordinary one, not a corner.
    // Only a CLOSING course counts. Running into a head that is crossing or fleeing is a
    // T-bone or a rear-end, and those stay the mover's own fault, exactly as before.
    const closing = (a, b) => a.dir.x === -b.dir.x && a.dir.y === -b.dir.y;
    let headOn = !protect && !!moves[0] && !!moves[1] && ck(moves[0]) === ck(moves[1]);
    if (!headOn && !protect && players[0].alive && players[1].alive)
        for (let i = 0; i < 2; i++)
            if (moves[i] && ck(moves[i]) === ck(players[1-i].snake[0]) && closing(players[i], players[1-i]))
                headOn = true;
    if (headOn) {
        dead[0] = dead[1] = true;
        // The one whose turn it was not has no move to point at, so its impact is the other
        // head: that is the cell it is being crushed against, and the renderer reads this to
        // decide which way the wreck leans.
        for (let i = 0; i < 2; i++) { into[i] = 'headon'; hitAt[i] = moves[i] || players[1-i].snake[0]; }
    }
    if (dead[0] || dead[1]) {
        // A crash NEVER costs gear. The pass that leads into a collision has already rolled
        // its steal a tick or two earlier, so a head-on or a swerve into somebody read as
        // "I hit them and my hat came off" -- and a match-ending death has no rebuild coming
        // to hand it back. Whoever it came off gets it back here, in flight or already lying
        // on the board, the same rule _duelBeginLevel applies to a board rebuild. Nothing is
        // drawn from the rng, so both clients cancel the same drop on the same tick.
        if (_ws && _ws.it) { _wsWearBack(_ws.it); _ws.it = null; }
        if (dead[0]) players[0].lives--;
        if (dead[1]) players[1].lives--;
        for (let i = 0; i < 2; i++) if (dead[i]) {
            const at = hitAt[i] || players[i].snake[0];
            emit({t:'crash',p:i,hx:players[i].snake[0].x,hy:players[i].snake[0].y,
                  x:at.x,y:at.y,into:into[i]||'snake',boost:!!players[i].boosting});
        }
        emit({t:'sfx',name:'die'});
        // EVERY death takes the same beat as single player, the last one included: the sim
        // holds in 'dying' for DEATH_DUR and update() decides afterwards whether that was a
        // respawn or the end of the match. Calling the match here instead put the winner
        // banner over the one wreck most worth seeing -- and the beat outlasts RB_DEPTH, so a
        // mispredicted final kill is still rolled back before it is ever called.
        deathMsg = (dead[0]&&dead[1]) ? 'BOTH LOSE A LIFE' : (dead[0] ? 'P1 LIFE LOST' : 'P2 LIFE LOST');
        phase = 'dying'; phaseAt = now;
        if (players[0].lives <= 0 || players[1].lives <= 0) emit({t:'mpause'});
        return;
    }
    // Bar crush (fragile or powered): the SAME destruction path as single player, so a
    // paired unit breaks as one. No coin/score reward in a duel (its economy is gems + hearts).
    for (let i = 0; i < 2; i++) {
        if (!crushK[i]) continue;
        _crushBarAt(crushK[i]);
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
        // A landed windswept item goes to whoever reaches it first -- including the snake it
        // came off, who can simply take it back. Nothing is collectible in flight (at).
        if (_ws && _ws.it && simTick >= _ws.it.at && ck(_ws.it) === ck(moves[i])) _wsTake(i);
        if (heart && ck(heart) === ck(moves[i])) {   // grabbing it is a life back (capped) -- or, at the cap, denies it to the rival
            heart = null;
            if (P.lives < _duelHeartsMax) { P.lives++; emit({t:'bonus',label:'+1 UP!'}); }
        }
        if (eater < 0 && gem && ck(gem) === ck(moves[i])) {
            eater = i;
            P.snake.push(Object.assign({}, P.snake[P.snake.length - 1]));   // +2 growth (classic normal)
        } else P.snake.pop();
    }
    // A POWERED self-bite resolves with the move applied, so the index has shifted one along
    // with the head. Ahead of the chomps below: a segment this snake has already lost cannot
    // also be chomped off it, and the chomp's findIndex simply comes up empty.
    for (let i = 0; i < 2; i++) {
        if (!selfK[i]) continue;
        const n = players[i].snake.length;
        _powerBite(players[i].snake, selfK[i]);
        emit({t:'bite', p:i, x:moves[i].x, y:moves[i].y, n:n - players[i].snake.length});
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
        if (idx > 0) other.snake.length = Math.max(idx, SNAKE_MIN_LEN);
        players[i].slowUntil = now + T(120);
        emit({t:'sfx',name:'crash'}); emit({t:'bonus',label:'CHOMP!'});
    }
    // ...and a landed item can come down INSIDE a snake. It is thrown at a cell that was
    // free, but it spends WS_LAND_TICKS in the air and the board it touches down on is not
    // the board it left. A cell under a body is one that snake's head can only reach by
    // dying, so the item is not still there to be won: it is stranded, sitting visibly
    // inside the snake for as long as the tail takes to clear it. Whoever it came down
    // inside HAS reached it. After the bites, so a segment already chewed off cannot
    // collect; player 0 first if both cover it, which no rng draw depends on.
    if (_ws && _ws.it && simTick >= _ws.it.at) {
        const k = ck(_ws.it);
        for (let i = 0; i < 2; i++) if (players[i].snake.some(s => ck(s) === k)) { _wsTake(i); break; }
    }
    if (eater >= 0) {
        players[eater].score += level * 100;
        gemsDone++;
        if (gemsDone >= GEMS_PER_LEVEL) {
            // Twist: the level-finisher earns a heart back, capped at the match's cap.
            if (players[eater].lives < _duelHeartsMax) players[eater].lives++;
            emit({t:'sfx',name:'levelUp'});
            // Same "press to continue" gate as single player: wait in 'levelDone' for 'advance'.
            levelWasPerfect = false;   // no perfect-level bonus in a duel
            phase = 'levelDone'; phaseAt = now;
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
// THE barricade placement, shared by single player AND duel -- one code path, never
// mirrored. Both modes get the same fragility rule (the edge ring is always crushable,
// via _barFragile) and the same ~10% 2-cell paired extensions. Duel used to hard-code
// every bar fragile:false, so a bar on the outer ring was solid in a duel but crushable
// in single player: the "solid barricade on the corner" that could never happen solo.
// The caller supplies its own blocked-set (snake(s) + launch runway) and bar count.
function _placeBars(blocked, numBars) {
    const bars = [];
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
                // A pair is one unit sharing one fragility. Any unit touching the outer
                // edge ring must be crushable, so OR in the extension cell's own edge
                // status instead of blindly inheriting the (possibly inner, solid) base.
                const onEdge = nx===0||nx===COLS-1||ny===0||ny===ROWS-1;
                const pairFragile = b.fragile || onEdge;
                b.fragile = pairFragile;
                bars.push({x:nx,y:ny,paired:true,fragile:pairFragile});
                b.pairEnd={x:nx,y:ny}; break;
            }
        }
    }
    return bars;
}
// Crush the fragile/powered bar at cell key hk AND its paired partner (a 2-cell unit shares
// one fate), emit the crush fx + crash sfx, bump the change ticker. Shared by single player
// (step) and duel (duelStep) so the destruction rule is ONE code path: hit either half of a
// pair -> both go. A still (non-powered) crush repaints the bars; powered bars already
// re-render every tick as they flee, so it skips the repaint then.
function _crushBarAt(hk){
    let primCk = hk;
    const hb = bars.find(b => ck(b) === hk);
    if(hb && hb.paired){ const p = bars.find(b => b.pairEnd && ck(b.pairEnd) === primCk); if(p) primCk = ck(p); }
    const primBar = bars.find(b => ck(b) === primCk);
    const secCk = primBar && primBar.pairEnd ? ck(primBar.pairEnd) : null;
    if(hb) emit({t:'crush', x:hb.x, y:hb.y});
    bars = bars.filter(b => ck(b) !== primCk && (secCk === null || ck(b) !== secCk)); _barsV++;
    emit({t:'sfx', name:'crash'});
    if(!_powerMode) emit({t:'bars'});
}
function beginLevel(isRespawn=false) {
    const lcfg=LEVEL_CFG[level-1], d=DIFF[cfg.diff];
    gPer = lcfg[['easy','normal','hard'][cfg.diff]];
    _speedRound = false;   // SPEED ROUND is DUEL-ONLY: clear any leftover so single player never runs one
    const cx=Math.floor(COLS/2), cy=Math.floor(ROWS/2);
    const sl = _levelStartLen > 0 ? _levelStartLen : startLen(level);
    _levelStartLen = sl;
    snake = Array.from({length:sl},(_,i)=>({x:cx-i,y:cy}));
    dir={x:1,y:0}; dirQueue=[]; gem=null; gemsDone=0; bars=[];
    phase='levelReady'; _gDue=0; _stepAccum=0; phaseAt=simNow;
    spawnAt=0; levelDoneWaiting=false;
    perfectLevel=true; levelWasPerfect=false; levelBonusCount=0; epicLevelCount=0;
    _gourangaLine=[]; _gourangaActive=false; _gourangaEaten=new Set(); _gourangaSteps=0;
    heart=null; heartAt=0; heartIsEarly=false;
    powerPellet=null; _powerMode=false;
    timeCrystal=null; _slowMode=false;
    clearBoost();
    const blocked = new Set(snake.concat([{x:cx+1,y:cy},{x:cx+2,y:cy}]).map(ck));
    const numBars = Math.min(28, Math.round(lcfg.bars * d.bm));
    bars = _placeBars(blocked, numBars);
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
        // Gouranga is the only collectible while active: drop any lingering gem (the one
        // just eaten still sits in `gem` here) so it can't be re-collected on the board.
        if(_gourangaActive){ gem=null; return; }
    }
    gem=freeCell(new Set(snake.concat(bars).map(ck)));
    const rv=rng();
    const rareMult=[1,1,2][cfg.diff]||1;   // hard doubles the epic/lucky odds; easy/normal unchanged
    gem.tier = rv<0.0005*_X10()*rareMult ? 2 : rv<0.0105*_X10()*rareMult ? 1 : 0;
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
        // Drop the one early heart at the trigger-th L4-6 gem. If a heart is already on the
        // board that gem, do NOT burn the trigger: >= keeps retrying on each later gem until a
        // slot is free, so the single early heart can never be silently skipped for the game.
        if(_earlyHeartCount>=_earlyHeartTrigger&&!heart){
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
    if(_powerMode && now-_powerModeAt>=_POWER_DUR){ _powerMode=false; gemSteps=0; emit({t:'bars'}); }   // power ends: re-grant the fewest-steps budget so the detour it caused is free
    if(!protect){
        const hitBar=bars.find(b=>ck(b)===hk);
        if(hitBar){
            if(hitBar.fragile||_powerMode){
                _crushBarAt(hk);
                score+=level*100;   // a crush scores like a gem; FOKoins follow from the run score at game over
            } else { die(now, 'bar', head); return; }
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
    // Own body: lethal normally, but POWERED the head goes through and the bitten segment
    // back falls off instead -- applied at the end of the step, once the move is in.
    const selfAt = protect ? 0 : _powerBiteIdx(anyAte?snake:snake.slice(0,-1), hk);
    if(selfAt > 0 && !_powerMode){die(now, 'self', head);return;}
    if(!anyAte) gemSteps++;
    if(_gourangaActive && _gourangaEaten.size>0) _gourangaSteps++;   // count every move once the sweep has begun
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
                if(_gourangaSteps<=GOURANGA_MAX_MOVES){   // clean end-to-end sweep: full GOURANGA payoff
                    emit({t:'ach',id:'gouranga'});
                    emit({t:'bonus',label:'GOURANGA!'}); emit({t:'sfx',name:'perfect'});
                } else {                                  // detoured completion: ordinary finish, no award
                    emit({t:'bonus',label:`x${bonusMult} BONUS!`}); emit({t:'sfx',name:'eat'});
                }
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
            const diffMult=cfg.diff===2?2:1;
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
        if(score>=100000) emit({t:'ach',id:'score_25k'});
        if(score>=200000) emit({t:'ach',id:'score_100k'});
        if(gemsDone>=GEMS_PER_LEVEL){
            gem=null; score+=level*500;
            if(perfectLevel){
                levelWasPerfect=true;   // sim-owned: the levelDone screen shows PERFECT! off this
                score+=level*1000+10000; emit({t:'fw'}); emit({t:'sfx',name:'perfect'});   // the 10k perfect jackpot is score; it banks to FOKoins at game over
                emit({t:'ach',id:'perfect_level'});
                perfectCount++; if(perfectCount>=3) emit({t:'ach',id:'triple_perf'});
            } else emit({t:'sfx',name:'levelUp'});
            if(level>=2)  emit({t:'ach',id:'level1'});
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
    if(selfAt > 0){
        const n = snake.length;
        _powerBite(snake, selfAt);
        // A bite is permanent, death included: the length you come back at drops with it, so
        // a respawn never hands back a tail already lost -- you grow again from where the
        // bite left you. The baseline only ever falls here; the level's own start length
        // still applies to anything longer. (Classic bookkeeping: a duel respawn is a fixed
        // DUEL_LEN by match rule, so there is no carried baseline there to lower. The
        // shortening itself is _powerBite, the one implementation every mode calls.)
        if(_levelStartLen > snake.length) _levelStartLen = snake.length;
        emit({t:'bite', p:0, x:head.x, y:head.y, n:n - snake.length});
    }
}

// into/at describe the impact for the renderer only ('bar' dents, everything else just
// crushes the head). p:-1 marks the classic snake, so one crash handler serves both modes.
function die(now, into, at) {
    lives--; phase='dying'; phaseAt=now;
    deathMsg=lives>0?`LIFE LOST  (${lives} left)`:'GAME OVER!';
    if(into) emit({t:'crash',p:-1,hx:snake[0].x,hy:snake[0].y,x:at.x,y:at.y,into,boost:!!boosting});
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
    const free=(x,y)=>x>=0&&x<COLS&&y>=0&&y<ROWS&&!blocked.has(x+','+y);
    for(const b of bars){
        // Each block holds ONE heading for 4-8s so the flight reads as a calm directed glide.
        // Blocked ahead, it TURNS 90 degrees rather than reversing -- a reversal is exactly what
        // read as jitter -- and if boxed in on both sides it simply holds this step, which is
        // calmer than a random jerk. gd/gdUntil live only sim-side (the render transport strips them).
        if(b.gd==null || simTick>=b.gdUntil){ b.gd=ri(4); b.gdUntil=simTick+240+ri(241); }
        let d=DIRS[b.gd], nx=b.x+d.x, ny=b.y+d.y;
        if(!free(nx,ny)){
            const perp=b.gd<2?2:0, pick=ri(2);   // horizontal(0,1)<->vertical(2,3): the two 90-degree turns
            let turned=false;
            for(const g of [perp+pick, perp+(1-pick)]){
                const dd=DIRS[g], px=b.x+dd.x, py=b.y+dd.y;
                if(free(px,py)){ b.gd=g; b.gdUntil=simTick+240+ri(241); nx=px; ny=py; turned=true; break; }
            }
            if(!turned) continue;   // boxed in on both turns: hold position
        }
        blocked.delete(ck(b)); b.x=nx; b.y=ny; blocked.add(nx+','+ny);
    }
    _barsV++;
}
function update() {
    simTick++;
    simNow = simTick * TICK_MS;
    // This tick's inputs, before anything simulates them. They were authored for exactly this
    // tick by simInputTick and have been waiting since. Online the same records wait in the
    // rollback log and netTickPre feeds them at the same point in the tick order.
    if(_simQ.size){
        const q = _simQ.get(simTick);
        if(q){ _simQ.delete(simTick); for(const c of q) _simExec(c); }
    }
    const now = simNow;
    if(phase==='playing'){
        // boosting is COMMAND-DRIVEN: the arming stage (simArmTick, device-local)
        // issues the real engage/disengage commands; the sim never derives them.
        // Fixed per-level game tick (gPer). Normal steps every 2nd game tick, boost
        // every game tick -- boost changes the accrual, never gPer.
        if(--_gDue<=0){
            _gDue=gPer;
            _gAt = simTick;   // accrual boundary: boost flips only matter from here on
            _stepAccum += boosting?2:1;
            if(_stepAccum>=2){ _stepAccum-=2; step(now); }
            if(_powerMode && ++_barMoveTick>=_BAR_MOVE_EVERY){ _barMoveTick=0; _moveBarsGhost(); }
        }
    }
    if(heart&&heartIsEarly&&now-heartAt>=EARLY_HEART_TTL){heart=null;heartIsEarly=false;}
    if(_slowMode&&now-_slowModeAt>=_SLOW_DUR){_slowMode=false;gPer=_lvlGper(level);}
    if(phase==='levelReady'&&now-phaseAt>=READY_DUR+GO_DUR){
        phase='playing'; _gDue=gPer; _stepAccum=0; spawnAt=now; phaseAt=0;
        simArmRebase();   // a held boost must re-earn its grace this level, never spawn already on
    }
    if(phase==='dying'&&now-phaseAt>=DEATH_DUR){
        if(players){
            const out0 = players[0].lives<=0, out1 = players[1].lives<=0;
            if(out0||out1){   // the beat has played out and somebody is out of hearts: call the match
                players[0].alive = !out0; players[1].alive = !out1;
                duelWinner = (out0&&out1) ? 2 : (out0 ? 1 : 0);
                phase = 'duelOver'; phaseAt = now;
            }
            else if(_duelNetHold){
                // ONLINE: hold in 'dying' and hand the respawn to the net layer as a boundary
                // (the host answers with go {why:'respawn'} -> 'startDuelRespawn'). The halt is
                // LEVEL-triggered, not edge-triggered: the hold re-announces itself every
                // _HALT_RE ticks for as long as it stands -- the same retried-until-answered
                // rule every other 2.6 transition follows. A one-shot emit here wedged BOTH
                // clients in 'dying' for good whenever the host missed the single edge:
                // refused because another boundary (a recovery resume) held the one-boundary
                // guard, or never crossed because a full resync adopted a state already past
                // DEATH_DUR. Repeats are free: netDuelHalt is host-gated and _netStartRespawn
                // folds them into the one open boundary.
                // DEATH_DUR (84 ticks) outlasts RB_DEPTH (64), so the deepest late input cannot
                // reach back past the crossing: a halt, once announced, can no longer be undone by
                // a rollback, and no go {why:'respawn'} arrives for a death that has vanished.
                if(Math.round((now-phaseAt-DEATH_DUR)/TICK_MS)%_HALT_RE===0) emit({t:'duelHalt'});
            }
            else _duelBeginLevel(false);   // local duel: rebuild at once -- keep the rng flowing for a fresh board
        }
        else if(lives>0)beginLevel(true);
        else{phase='nameEntry';emit({t:'gameover'});}   // presentation loads the last name, hides HUD, stops music
    }
    if(phase==='levelDone'&&!levelDoneWaiting&&now-phaseAt>=LEVELDONE_DUR){
        levelDoneWaiting=true;
    }
    // ---- 1:1 duel ticking (players non-null only in duel mode)
    if(phase==='duelReady'&&now-phaseAt>=READY_DUR+GO_DUR){
        phase='duel'; _gDue=gPer; spawnAt=now; phaseAt=0;
        players.forEach(P=>{ P.stepAccum=0; });
        simArmRebase();   // same rule as single player: no respawn (or level) begins mid-boost
    }
    if(phase==='duel'){
        // boosting is COMMAND-DRIVEN (see simArmTick): only real transitions arrive,
        // authored by the owning device -- the sim never re-derives an engage.
        if(--_gDue<=0){
            _gDue=gPer;
            _gAt = simTick;   // accrual boundary: boost flips only matter from here on
            for(const P of players){ if(P.alive) P.stepAccum += (P.boosting?2:1)*(now<P.slowUntil?0.5:1); }
            if(_powerMode && ++_barMoveTick>=_BAR_MOVE_EVERY){ _barMoveTick=0; _moveBarsGhost(); }
            duelStep(now);
            _duelNearMiss();   // after the step resolves deaths/phase; arms shake+sfx on a heads pass
        }
    }
    // NOTE: the splash->menu transition is presentation/UI, not simulation -- it lives on
    // the main thread (see updateSplashExit in game.js), so the sim never touches splash state.
    // Arming ticks WITH the sim (every home, including the headless harness, gets it by
    // driving update()); it self-guards against rollback re-sims and only ISSUES input
    // commands, so the sim itself stays a pure function of its inputs.
    simArmTick();
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
        gPer, _gDue, _gAt, _stepAccum, phaseAt, gemAt, deathMsg, spawnAt, levelDoneWaiting,
        perfectLevel, levelWasPerfect, levelBonusCount, epicLevelCount,
        _gourangaLine, _gourangaActive, _gourangaEaten, _gourangaSteps,
        heart, heartAt, heartIsEarly, _earlyHeartUsed, _earlyHeartTrigger, _earlyHeartCount,
        powerPellet, powerPelletAt, _powerMode, _powerModeAt, _barMoveTick,
        timeCrystal, timeCrystalAt, _slowMode, _slowModeAt,
        perfectCount, luckyCount, boostDir, boosting, gemOptimal, gemSteps,
        players, duelWinner, _speedRound, _nmWasAdjacent, _ws, _rngState, _duelHeartsMax,
    };
}
// Register one steering record into a dirQueue. ONE rule shared by classic (module
// globals) and duel (per-player) -- q is the queue, cur the live heading, d the new
// direction. A record is judged against the LAST REGISTERED direction (the queue tail,
// or the heading when nothing is queued): same or exact reverse of it is not registered.
// The queue holds at most 3 records, and the NEWEST intent always wins: at a full queue
// the new input first REVOKES the not-yet-executed tail, then takes the normal judging
// against the remaining tail -- a perpendicular input replaces the revoked turn, a
// same/reverse input just cancels it and leaves the slot empty. (A repeat of the tail
// direction pops and re-registers it identically, so input stutter stays harmless.)
function _dirEnqueue(q, cur, d){
    if(q.length >= 3) q.pop();
    const last = q.length > 0 ? q[q.length-1] : cur;
    if(!(d.x === -last.x && d.y === -last.y) && !(d.x === last.x && d.y === last.y)) q.push(d);
}
// Apply one input/control command to the sim state. Single source of truth shared by the
// Web Worker (sim-worker.js onmessage) and the headless path (game.js _wsend when there is
// no Worker -- tests + any browser without Worker support). Pure sim effects only; the
// worker wraps pause/resume/start with its own tick-loop + post handling.
// ---- THE AUTHORING CLOCK ------------------------------------------------------
// Every local input and every locally-created event names the tick it must execute on, and
// this is the only place that number is decided -- classic, local 1:1 and online 1:1 alike.
// simTick is the LAST COMPLETED tick, so simTick+1 is the tick already about to run: it can
// be a millisecond away and offers no slack at all. simTick+2 is the first tick with a whole
// TICK_MS in front of it. That gap is what the wire spends carrying the identical record to
// the peer before ITS sim reaches the tick, which is why a duel input is rollback-free in the
// common case. Offline there is nobody to send to and the gap stays regardless: the gap IS
// the mechanic, so a turn and a boost cost exactly the same two ticks in every mode.
const SIM_LEAD = 2;
function simInputTick(kind){
    // A turn is step-granular -- it cannot take effect before the next accrual boundary -- so
    // it is authored AT that boundary, and never nearer than the lead. Everything else
    // executes on the exact tick it names.
    return simTick + ((kind === 'dir' && _gDue > SIM_LEAD) ? _gDue : SIM_LEAD);
}
// Records waiting for their tick. Online the equivalent store is the rollback log, which must
// additionally keep them for re-simulation -- that is the transport's business, not the
// mechanic's; the tick they name and the point at which they execute are the same in both.
const _simQ = new Map();
function simSchedule(tk, cmd){
    let a = _simQ.get(tk);
    if(!a){ a = []; _simQ.set(tk, a); }
    a.push(cmd);
}
// The sim's ONE message entry. An input names a future tick and waits for it; a control
// command rebuilds or steers the world and takes effect at once. Routing it here rather than
// at each home is what keeps the rule from being re-decided per transport: the worker, the
// in-process home and the headless harness all arrive through this function.
const _SIM_INPUT = { dir:1, boost:1, boostend:1 };
function simCommand(m){
    if(_SIM_INPUT[m.t]){ simSchedule(simInputTick(m.t), m); return; }
    _simExec(m);
}
// Execute a command NOW. Called by the tick drain below, and by the duel core when it feeds a
// logged record at its authored tick (netTickPre) or replays the log through a rollback.
// 'arm' stays immediate on purpose: arming is device-local state for the arming stage, not an
// input to the world -- the stage's real transitions are what get authored, through simArmIssue.
function _simExec(m){
    // A world rebuild voids whatever is still scheduled: those records name ticks on a
    // timeline that no longer exists (start/respawn/level all reset simTick to 0).
    if(m.t === 'start' || m.t === 'startDuel' || m.t === 'startDuelLevel' || m.t === 'startDuelRespawn' || m.t === 'phase'){
        _simQ.clear();
        _armPend = [];   // an in-flight arming transition named a tick in the timeline just voided
    }
    switch(m.t){
        case 'start': startGame(m.seed, m.bestScore); break;
        // m.net marks an ONLINE duel: deaths then hold for the negotiated respawn boundary
        // (see _duelNetHold). Local duels send no flag and keep the immediate rebuild.
        // m.hearts is the negotiated cap (absent = START_LIVES). Set BEFORE startDuel:
        // _mkDuelPlayer reads it for the opening life count.
        case 'startDuel': _duelNetHold = !!m.net; _duelHeartsMax = _duelHearts(m.hearts); startDuel(m.seed, m.ws, m.lvl); break;
        // dir/boost carry an optional player index (m.p). In duel mode they route to
        // players[p]; classic mode keeps the original single-snake path untouched.
        // A remote peer's input will arrive as these SAME commands with p = their index.
        case 'dir': {
            if(players){
                const P = players[m.p||0]; if(!P || !P.alive) break;
                _dirEnqueue(P.dirQueue, P.dir, m.dir);
                break;
            }
            _dirEnqueue(dirQueue, dir, m.dir);
            break;
        }
        case 'boost':
            // A 'boost' command IS the engage (real transition, authored by the owner).
            if(players){ const P=players[m.p||0]; if(P&&P.alive){ P.boostDir=m.dir; P.boosting=true; } break; }
            boostDir=m.dir; boosting=true; break;
        case 'arm':   // device-local arming passthrough (never logged/replayed; see simArm)
            simArm(m.p||0, m.dir, m.now); break;
        case 'boostend':
            if(players){ const P=players[m.p||0]; if(P){ P.boostDir=null; P.boosting=false; } break; }
            boostDir=null; boosting=false; break;
        case 'advance':
            // Guard HERE (authoritative state): the main thread's levelDone gate reads a
            // mirror that an in-flight stale snapshot can re-arm, so a held Enter could
            // send 'advance' twice -- without this check that would skip a level.
            if(phase!=='levelDone' || !levelDoneWaiting) break;
            if(players){ if(level<MAX_LEVELS) level++; _duelBeginLevel(); }   // duel is endless: at 10 it re-runs max difficulty
            else if(level<MAX_LEVELS){ _levelStartLen = cfg.diff===2?Math.max(3,snake.length-2):0; level++; beginLevel(); }   // hard carries length over, minus 2 each level to ease it slightly
            else { phase='nameEntry'; emit({t:'gameover', reason:'win'}); }
            break;
        case 'startDuelLevel':
            // Online level-up: re-anchor to the negotiated start_pts and rebuild the next level
            // from (seed, level). The level number is host-authored and rides the go, so both
            // sims adopt it verbatim. Lives/score carry over inside _duelBeginLevel.
            if(!players) break;
            simTick = 0; simNow = 0; _gAt = 0;
            level = m.level|0;
            _duelBeginLevel();
            break;
        case 'startDuelRespawn':
            // Online post-death restart: the death held the sim in 'dying' (_duelNetHold) while
            // the host negotiated a fresh start_pts; both clients rebuild the SAME level at tick
            // 0. reseed=false keeps the rng flowing for a fresh board -- the exact rebuild the
            // local duel runs immediately, just anchored to the new shared timeline.
            if(!players) break;
            simTick = 0; simNow = 0; _gAt = 0;
            _duelBeginLevel(false);
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
            if(m.phase==='menu'){ players=null; duelWinner=-1; _duelNetHold=false; _duelHeartsMax=START_LIVES; _ws=null; _nmWasAdjacent=false; }   // leaving a duel clears its state
            break;
    }
}
function simApply(s){
    phase=s.phase; _shimmerThreshold=s._shimmerThreshold; level=s.level; lives=s.lives; score=s.score; _levelStartLen=s._levelStartLen;
    snake=s.snake; dir=s.dir; dirQueue=s.dirQueue; gem=s.gem; gemsDone=s.gemsDone; bars=s.bars; _barsV=s._barsV; simTick=s.simTick; simNow=s.simNow;
    gPer=s.gPer; _gDue=s._gDue; _gAt=s._gAt|0; _stepAccum=s._stepAccum; phaseAt=s.phaseAt; gemAt=s.gemAt; deathMsg=s.deathMsg; spawnAt=s.spawnAt; levelDoneWaiting=s.levelDoneWaiting;
    perfectLevel=s.perfectLevel; levelWasPerfect=s.levelWasPerfect; levelBonusCount=s.levelBonusCount; epicLevelCount=s.epicLevelCount;
    _gourangaLine=s._gourangaLine; _gourangaActive=s._gourangaActive; _gourangaEaten=s._gourangaEaten; _gourangaSteps=s._gourangaSteps;
    heart=s.heart; heartAt=s.heartAt; heartIsEarly=s.heartIsEarly; _earlyHeartUsed=s._earlyHeartUsed; _earlyHeartTrigger=s._earlyHeartTrigger; _earlyHeartCount=s._earlyHeartCount;
    powerPellet=s.powerPellet; powerPelletAt=s.powerPelletAt; _powerMode=s._powerMode; _powerModeAt=s._powerModeAt; _barMoveTick=s._barMoveTick;
    timeCrystal=s.timeCrystal; timeCrystalAt=s.timeCrystalAt; _slowMode=s._slowMode; _slowModeAt=s._slowModeAt;
    perfectCount=s.perfectCount; luckyCount=s.luckyCount; boostDir=s.boostDir; boosting=s.boosting; gemOptimal=s.gemOptimal; gemSteps=s.gemSteps;
    players=s.players; duelWinner=s.duelWinner; _speedRound=s._speedRound; _nmWasAdjacent=s._nmWasAdjacent; _ws=s._ws; if(s._rngState!=null) _rngState=s._rngState;
    _duelHeartsMax=_duelHearts(s._duelHeartsMax);
}
// ---- Local boost arming (DEVICE-local: never in the snapshot or the hash) ----
// A held direction ARMS a boost; after BOOST_GRACE_TICKS of aligned live ticks the
// REAL engage is issued through simArmIssue, which routes it like any other input.
// Disalignment or release while boosting issues the real end the same way -- so only
// true transitions ever reach the sim or the wire. `instant` (touch double-tap /
// swipe) skips the wait. Ticked once per LIVE engine tick by each sim home; never
// during a rollback re-sim (arming is real input authorship, not replayable state).
let _armSlots = [];   // per LOCAL player index: {dir, since, go} | {off:true} | empty
// The stage is edge-triggered against the sim's boosting flag, but a transition it issues does
// not execute on the tick it is issued: simInputTick names a tick SIM_LEAD ahead, so the flag
// keeps reading the OLD value for the whole lead. Per LOCAL player, the transition still in
// flight -- {tk: the tick it executes on, on: what boosting becomes}. Without it the stage
// re-decides the same engage on every tick of the lead and authors one record per tick, and a
// release landing inside the lead reads boosting as still false and lets the engage stand.
let _armPend = [];
function _armBoosting(p, P){
    const q = _armPend[p];
    if(q){ if(simTick < q.tk) return q.on; _armPend[p] = null; }
    return P.boosting;
}
function _armIssue(p, kind, d){
    _armPend[p] = { tk: simTick + SIM_LEAD, on: kind === 'bs' };
    simArmIssue(p, kind, d);
}
function simArm(p, d, instant){
    _armSlots[p] = d ? { dir:{ x:d.x, y:d.y }, since:simTick, go:!!instant } : { off:true };
}
// A fresh play phase (level start, level-up, or the respawn after a death) must never begin
// already boosting off a key that was held before GO. Each armed slot keeps a `since` from
// when the hold began; left alone across a death it predates the respawn, so the grace reads
// as already satisfied and boost snaps on at spawn. Rebase every armed slot to this tick and
// drop the instant flag, so a still-held direction re-engages through the normal hold. Called
// from BOTH the single-player and duel GO transitions so the two modes behave identically.
function simArmRebase(){
    for(const a of _armSlots){ if(a && !a.off){ a.since = simTick; a.go = false; } }
}
function simArmTick(){
    if(typeof _replaying !== 'undefined' && _replaying) return;   // a re-sim replays the log; it must not author anew
    for(let p = 0; p < 2; p++){
        const a = _armSlots[p]; if(!a) continue;
        const P = players ? players[p] : (p === 0 ? { dir, dirQueue, boosting, alive:true } : null);
        if(!P) { _armSlots[p] = null; continue; }
        // Boosting as of the last decision this stage made -- the live flag once nothing is in
        // flight. Every branch below judges against it, so the lead is never re-decided.
        const bo = _armBoosting(p, P);
        if(a.off){ if(bo) _armIssue(p, 'be'); _armSlots[p] = null; continue; }
        if(P.alive === false) continue;
        const aligned = a.dir.x === P.dir.x && a.dir.y === P.dir.y && P.dirQueue.length === 0;
        if(!aligned){
            a.since = simTick;                        // re-aim: the wait starts over
            if(bo) _armIssue(p, 'be');                // real end: the boost died with the turn
        } else if(!bo && cfg.turbo !== false && (a.go || simTick - a.since >= BOOST_GRACE_TICKS)){
            _armIssue(p, 'bs', a.dir);                // real engage, authored for its tick
        }
    }
}
// THE issue path for an arming transition: one body, every home, no per-home override.
// The stage above decides WHAT transition happens (engage, re-aim end, release end);
// this decides only WHERE the resulting command goes, and that is transport, not mechanic.
// netLocalInput is the online destination AND the test for one: it owns the wire's rules
// (author a tick ahead, log it, apply it from the log on both sides, author nothing at all
// while spectating) and it declines -- returns false -- whenever there is no online duel to
// author into. So single player, local 1:1 and online 1:1 all run this same line, and a
// transition reaches the sim exactly the way every other input does. Its `0` is the LOCAL
// player, not the sim index: online the local snake is netMyIndex(), which netLocalInput
// resolves for itself. Do not fork this hook per home -- two issue bodies is how the modes
// drift apart while the mechanic above them still looks single-sourced.
function simArmIssue(p, kind, d){
    if(typeof netLocalInput === 'function' && netLocalInput(kind, 0, d, true)) return;
    simCommand(kind === 'bs' ? { t:'boost', p, dir:d } : { t:'boostend', p });
    if(players) return;
    // Classic score submissions replay the input log server-side: the ENGAGE (not the
    // keypress) is the input now, so it is what gets logged, at its authored tick.
    // The log lives on the main thread: log directly where net-api.js shares the scope
    // (in-process + headless), ride a tick-stamped event out of the worker otherwise.
    if(typeof netLogBoost === 'function'){ if(kind === 'bs') netLogBoost(d, simTick); else netLogBoostEnd(simTick); }
    else simEvents.push(kind === 'bs' ? { t:'blog', k:'bs', d:{ x:d.x, y:d.y }, tk:simTick } : { t:'blog', k:'be', tk:simTick });
}
// Duel-scoped apply: exactly the globals a duel tick can touch (duel-core.js _rbDuelSnap),
// for rollback restores. simApply assigns EVERY field unconditionally, so feeding it a
// duel-scoped snapshot would wipe the classic-mode globals with undefined; this writes
// only the duel set and leaves the rest alone.
function simApplyDuel(s){
    phase=s.phase; level=s.level; gem=s.gem; gemsDone=s.gemsDone; bars=s.bars; _barsV=s._barsV;
    simTick=s.simTick; simNow=s.simNow; gPer=s.gPer; _gDue=s._gDue; _gAt=s._gAt|0; phaseAt=s.phaseAt; gemAt=s.gemAt;
    deathMsg=s.deathMsg; spawnAt=s.spawnAt; levelDoneWaiting=s.levelDoneWaiting;
    powerPellet=s.powerPellet; powerPelletAt=s.powerPelletAt; _powerMode=s._powerMode; _powerModeAt=s._powerModeAt;
    heart=s.heart; heartAt=s.heartAt;
    _barMoveTick=s._barMoveTick; players=s.players; duelWinner=s.duelWinner;
    _speedRound=s._speedRound; _nmWasAdjacent=s._nmWasAdjacent; _ws=s._ws;
    if(s._rngState!=null) _rngState=s._rngState;
}
