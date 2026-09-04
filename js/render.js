// ============================================================================
// render.js -- the render CORE: particle arrays, HUD, glow guard, offscreen
// background canvases, draw primitives (rr/drawGrid/bars), wearable accessories,
// the snake renderer, board entities (gem/pellet/crystal/heart/crush) and
// loop-drawn overlays (ach popups, snake miniatures). Typography lives in
// text.js (before this file), full-screen scenes in screens.js (after it).
// Shares the global scope (no bundler).
// ============================================================================
// Particle arrays: presentation-owned. game.js drainSimEvents feeds them (fw/crush
// events), the draw code filters them in place, the sim's 'lvlreset' event clears them.
let fireworks = [], _crushEffects = [];
// ================================================================
// HUD
// ================================================================
const hudEl = document.getElementById('hud');
const _hudLvlEl=document.getElementById('hv-lvl');
const _hudGemsEl=document.getElementById('hv-gems');
const _hudScoreEl=document.getElementById('hv-score');
const _hudLivesCv=document.getElementById('hv-lives-cv');
const _hudLivesCtx=_hudLivesCv.getContext('2d');
const _hudLives2Cv=document.getElementById('hv-lives2-cv');
const _hudLives2Ctx=_hudLives2Cv.getContext('2d');
const _hudAL=document.getElementById('hud-a-l'), _hudBL=document.getElementById('hud-b-l');
let _hudCache={mode:'',a:-1,b:-1,c:-1,d:-1};
function showHUD(v) { hudEl.classList.toggle('hidden',!v); }
function _drawHearts(cv, c2, n, color) {
    cv.width=Math.max(1,n*16);
    c2.fillStyle=color;
    for(let i=0;i<n;i++){
        const ox=i*16;
        HEART_PX.forEach((row,ry)=>row.forEach((px,rx)=>{if(px)c2.fillRect(ox+rx*2,ry*2,2,2);}));
    }
}
// One HUD, two contents. Classic: LIVES / SCORE / GEMS / LEVEL. Duel: P1 hearts /
// P2 hearts (replacing SCORE, per design) / P1 score / P2 score, hearts in each
// player's snake colour. Cells keep their positions; only what they SHOW changes.
function updateHUD() {
    // Duel content only while a game/duel session is actually live: the main-thread `players`
    // MIRROR can linger after leaving a 1:1 (the worker may be paused and never post a clearing
    // frame), and a stale mirror must not paint duel names onto the menu HUD.
    const mode = (players && inGame) ? 'duel' : 'classic';
    // duelSideName already caps at MAX_NAME (not 10: a full-length name was losing its tail)
    // and falls back to PLAYER n only where there is genuinely no name to print.
    const la = mode==='duel' ? (duelSideName(0)+' ') : 'LIVES ';
    const lb = mode==='duel' ? (duelSideName(1)+' ') : 'SCORE ';
    if(_hudCache.mode!==mode || _hudCache.la!==la || _hudCache.lb!==lb){
        _hudCache={mode,la,lb,a:-1,b:-1,c:-1,d:-1};
        const d = mode==='duel';
        _hudAL.textContent = la;
        _hudBL.textContent = lb;
        _hudScoreEl.classList.toggle('util-hidden', d);
        _hudLives2Cv.classList.toggle('util-hidden', !d);
    }
    if(mode==='duel'){
        // P1/P2 hearts in the top cells; GEMS + LEVEL below are the SHARED progression.
        const _lk=(typeof netDuelLook==='function')?netDuelLook():null;   // online: both clients agree on the pair
        const c0=_lk?_lk.c0:(cfg.snakeColor||0), c1=_lk?_lk.c1:((cfg.snakeColor||0)+1)%SNAKE_COLORS.length;
        if(players[0].lives!==_hudCache.a){ _hudCache.a=players[0].lives; _drawHearts(_hudLivesCv,_hudLivesCtx,players[0].lives,SNAKE_COLORS[c0].head); }
        if(players[1].lives!==_hudCache.b){ _hudCache.b=players[1].lives; _drawHearts(_hudLives2Cv,_hudLives2Ctx,players[1].lives,SNAKE_COLORS[c1].head); }
        if(gemsDone!==_hudCache.c){ _hudCache.c=gemsDone; _hudGemsEl.textContent=gemsDone; }
        if(level!==_hudCache.d){ _hudCache.d=level; _hudLvlEl.textContent=level; }
        return;
    }
    if(lives!==_hudCache.a){    _hudCache.a=lives;    _drawHearts(_hudLivesCv,_hudLivesCtx,lives,'#7fff7f'); }
    if(score!==_hudCache.b){    _hudCache.b=score;    _hudScoreEl.textContent=score; }
    if(gemsDone!==_hudCache.c){ _hudCache.c=gemsDone; _hudGemsEl.textContent=gemsDone; }
    if(level!==_hudCache.d){    _hudCache.d=level;    _hudLvlEl.textContent=level; }
}

// ================================================================
// NEAR-MISS JUICE (duel): a screen-shake impulse when the two heads pass within 1 cell.
// Presentation-only. DETECTION lives in the sim (see _duelNearMiss) -- judged every game tick
// so it never depends on which tick a RAF happens to sample -- and reaches us as a cosmetic
// 'nearmiss' event that calls armNearMiss(). The HEAVY variant (both snakes boosting through
// the pass) shakes harder and longer. Suppressed under SIMPLE gfx or the REDUCE MOTION toggle.
// ================================================================
let _shakeMag=0, _shakeAt=0, _shakeDur=0;
const _NM_SHAKE=5,  _NM_DECAY=380;    // normal pass: px impulse, ms decay (gentler than the boost pass)
const _NM_SHAKE_HEAVY=12, _NM_DECAY_HEAVY=560;   // both boosting: bigger + longer
function armNearMiss(heavy, now){
    _shakeMag = heavy ? _NM_SHAKE_HEAVY : _NM_SHAKE;
    _shakeDur = heavy ? _NM_DECAY_HEAVY : _NM_DECAY;
    _shakeAt  = now;
}
function shakeOffset(now){
    if(_simpleGfx()||_reduceMotion()||_shakeMag<=0) return null;
    const age=now-_shakeAt; if(age<0||age>=_shakeDur){ _shakeMag=0; return null; }
    const k=_shakeMag*(1-age/_shakeDur);                           // linear decay to zero
    return { x:Math.round(k*Math.sin(age*0.085)), y:Math.round(k*Math.cos(age*0.13)) };
}

// ================================================================
// STOLEN GEAR (duel). Juice hung off deferred, rollback-cancellable sim events. Everything
// that MATTERS is the sim's: whether an item came off, which one, where it lands and the
// tick it becomes takeable (see _ws / _duelStealRoll in sim.js). This file only draws the
// 500ms tumble to the landing cell. Suppressed under SIMPLE gfx or REDUCE MOTION -- the item
// then simply appears where it lands, which is the half a player has to see and act on.
// ================================================================
let _wsFly = null;      // { id, sx, sy, landAt }: the cell the item was knocked off at
let _wsBlow = null;     // { own, at }: WHICH snake it came off; at is stamped on the first frame that draws it
function armWsFly(e){
    _wsBlow = { own:e.own|0, at:null };
    _wsFly = (_simpleGfx()||_reduceMotion()) ? null : { id:e.id, sx:e.hx, sy:e.hy, landAt:null };
}
// The colour BOTH windswept cues are keyed on: the snake the gear came off. it.own / e.own
// is sim state and the pair of colours is derived the same way on both devices, so the two
// screens always agree. One accessor, so the tile and the shock ring can never disagree.
function _wsOwnerHue(own){
    const lk = _duelLook();
    return SNAKE_COLORS[own ? lk.c1 : lk.c0].h;
}
// WHO just lost it. The tile on the board says whose gear is lying there; this says it at
// the moment it happens -- a square shock ring in the victim's colour, snapped to their head
// cell and riding it as they run on, so the loss is pinned to a snake and not just to a spot.
// Same square language as the tile, and armed off the same deferred, rollback-cancellable
// 'wsblow' event as the tumble. Under SIMPLE gfx or REDUCE MOTION the ring holds still and
// only fades: the cue is worth keeping, the expansion is not.
const _WS_BLOW_LIFE = 450;
function _drawWsBlowFx(now){
    if(!_wsBlow || !players) return;
    if(_wsBlow.at===null) _wsBlow.at = now;
    const t = (now-_wsBlow.at)/_WS_BLOW_LIFE;
    if(t<0 || t>=1){ _wsBlow=null; return; }   // t<0: the clock jumped back under it (a level reset)
    const P = players[_wsBlow.own];
    if(!P || !P.snake.length) return;
    const hue = _wsOwnerHue(_wsBlow.own);
    const H = P.snake[0], still = _simpleGfx()||_reduceMotion();
    const g = still ? 3 : 3+t*11;   // blows outward off the head
    ctx.save();
    ctx.strokeStyle=`hsla(${hue},100%,78%,${(1-t)*0.9})`;
    ctx.lineWidth = still ? 2 : 1+2*(1-t);
    ctx.strokeRect(H.x*CS-g+0.5, H.y*CS-g+0.5, CS+g*2-1, CS+g*2-1);
    ctx.restore();
}

// ================================================================
// SIDE-BY-SIDE SCRAPE (duel). Two snakes running the same way with one cell between their
// flanks grind along each other: sparks and a metallic squeal, CONTINUOUSLY, for as long as
// they stay alongside. Nothing here is a sim event and nothing here is lockstep -- no rng,
// no state, nothing hashed, nothing that can change the outcome of a match. It is judged
// fresh every FRAME from the positions already on screen, which is also why it can be
// continuous: an effect that has no rising edge to catch cannot miss one, so a dropped or
// doubled frame of it costs exactly nothing. (The near-miss STEAL is the opposite kind of
// thing and stays in the sim: see _duelNearMiss.)
// Sparks are suppressed under SIMPLE gfx or REDUCE MOTION; the squeal is not -- it is sound,
// not motion, and it is the cue that tells you you are rubbing along the other snake.
// ================================================================
let _scrapePts = [];         // live sparks: { x, y, ang, spd, col, at }
const _SCRAPE_LIFE = 300;    // ms per spark
// The point the two are rubbing at, or null. A scrape needs the same heading and some cell of
// the other snake exactly ONE cell ACROSS that heading from a head -- straight ahead or behind
// is tailgating, not a scrape. Heads level is only the most obvious case; when one snake is
// ahead, what the other rides is its BODY, which is the commoner way to end up alongside.
// One cell means one cell ON SCREEN: the offsets do not wrap, so the top row and the bottom row
// never rub. Nothing is touching there, and sparks arcing across the whole board say otherwise
// (the near-miss judges the same way -- see _duelNearMiss).
function _scrapePoint(){
    if(phase!=='duel' || !players || !players[0].alive || !players[1].alive) return null;
    const d=players[0].dir, e=players[1].dir;
    if(d.x!==e.x || d.y!==e.y) return null;   // different headings: that is a pass, not a scrape
    return _flankPoint(players[0].snake[0], players[1].snake, d)
        || _flankPoint(players[1].snake[0], players[0].snake, d);
}
function _flankPoint(h, other, d){
    for(let i=0;i<other.length;i++){
        const c=other[i];
        const sx=c.x-h.x, sy=c.y-h.y;   // signed, straight across the board: an edge is not a contact
        const across=d.x?sy:sx, along=d.x?sx:sy;
        if(Math.abs(across)===1 && Math.abs(along)<=1)   // sparks fly from BETWEEN the two cells
            return d.x ? { x:h.x*CS+CS/2, y:(h.y+across/2)*CS+CS/2 }
                       : { x:(h.x+across/2)*CS+CS/2, y:h.y*CS+CS/2 };
    }
    return null;
}
function _duelScrapeFx(now){
    const at = _scrapePoint();
    // One sustained voice held for the length of the contact, not a sound retriggered per
    // frame -- Snd.scrapeSet fades it in and out, and repeat calls with the same state are free.
    Snd.scrapeSet(!!at && cfg.music);
    if(at && !(_simpleGfx()||_reduceMotion()))
        for(let i=0;i<3;i++) _scrapePts.push({ x:at.x, y:at.y, at:now,
            ang:-Math.PI/2+(Math.random()-0.5)*2.4, spd:2+Math.random()*5,
            col:['#ffffff','#ffe9a0','#cfd6dd','#ffc24a'][Math.floor(Math.random()*4)] });
    _scrapePts = _scrapePts.filter(p=>{
        const t=(now-p.at)/_SCRAPE_LIFE;
        if(t<0 || t>=1) return false;   // t<0: the clock jumped back (level reset), drop the stragglers
        ctx.globalAlpha=(1-t)*0.95; ctx.fillStyle=p.col;
        ctx.fillRect(p.x+Math.cos(p.ang)*p.spd*t*16-1, p.y+Math.sin(p.ang)*p.spd*t*16+90*t*t-1, 2, 2);
        return true;
    });
    ctx.globalAlpha=1;
}
// The loose item: tumbling through the air, then lying on the board waiting to be taken.
// simTick vs the item's landing tick is the ONLY clock here, so a rollback that cancels or
// re-times the steal corrects the picture for free.
function _drawWsItem(now){
    const it = (typeof _ws!=='undefined' && _ws) ? _ws.it : null;
    if(!it){ _wsFly=null; return; }
    if(_wsFly && _wsFly.id!==it.id) _wsFly=null;
    const item = WS[it.id]; if(!item) return;
    const left = it.at - simTick;
    if(left > 0){
        if(!_wsFly) return;                       // no local flight: stay hidden until it lands
        const t = 1 - left/WS_LAND_TICKS;
        // A straight throw: the landing cell is clamped to the board (see _duelStealRoll), so the
        // item never has an edge to cross and the tumble is always the short way by construction.
        const dx = it.x-_wsFly.sx, dy = it.y-_wsFly.sy;
        // The item is thrown UP as well as across: it grows toward the apex so it reads as
        // near the camera, and shrinks back as it drops. The shadow stays on the ground track
        // and is the only cue that separates "high up" from "further along".
        const gx = (_wsFly.sx+dx*t)*CS+CS/2, gy = (_wsFly.sy+dy*t)*CS+CS/2;
        const hgt = Math.sin(t*Math.PI);
        const py = gy - hgt*CS*2.8;
        const sc = 2*(1+0.9*hgt)*(1-0.05*t);
        const turns = 5.5*(1-(1-t)*(1-t));   // spins hard off the snake, easing as it falls
        ctx.save();
        ctx.globalAlpha=0.30*(1-hgt*0.65); ctx.fillStyle='#000000';
        ctx.beginPath(); ctx.ellipse(gx,gy+5,CS*0.42*(1-hgt*0.4),CS*0.17*(1-hgt*0.4),0,0,Math.PI*2); ctx.fill();
        ctx.restore();
        if(t<0.34){   // the puff at the point of impact, fixed spokes so it does not boil
            const pt=t/0.34, cx0=_wsFly.sx*CS+CS/2, cy0=_wsFly.sy*CS+CS/2;
            ctx.save(); ctx.fillStyle='#e8e0d0';
            for(let k=0;k<6;k++){
                const a=k*(Math.PI/3)+0.4, r=4+pt*16, sz=3*(1-pt*0.6);
                ctx.globalAlpha=(1-pt)*0.5;
                ctx.fillRect(cx0+Math.cos(a)*r-sz/2, cy0+Math.sin(a)*r*0.6-sz/2, sz, sz);
            }
            ctx.restore();
        }
        ctx.save(); ctx.globalAlpha=0.55+0.45*t;
        ctx.translate(gx,py); ctx.rotate(turns*Math.PI*2); ctx.translate(-4*sc,-4*sc);
        drawPixelIcon(0,0,item.icon,sc);
        ctx.restore(); ctx.globalAlpha=1;
        return;
    }
    // Touchdown: only for a client that watched the tumble (_wsFly is null under SIMPLE gfx
    // or REDUCE MOTION, and for anyone who came in late), so the item still just appears there.
    if(_wsFly && _wsFly.landAt===null) _wsFly.landAt = now;
    const lAge = _wsFly ? Math.max(0, now-_wsFly.landAt) : 1e9;   // a rollback can rewind the clock under it
    const cx = it.x*CS+CS/2, cy = it.y*CS+CS/2;
    if(lAge<260){
        const rt=lAge/260;
        ctx.save(); ctx.globalAlpha=(1-rt)*0.4; ctx.strokeStyle='#e8e0d0'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.ellipse(cx,cy+6,5+rt*16,2+rt*6,0,0,Math.PI*2); ctx.stroke();
        ctx.restore();
    }
    const sq = lAge<90 ? 2*(0.86+0.14*(lAge/90)) : 2;   // squats on impact, springs back
    // Loose loot has two jobs on a board that already holds bars, a gem and two snakes: be
    // findable at a glance, and say WHOSE gear it is. One object does both -- a backlit floor
    // TILE filling the cell it landed in, lit in the colour of the player it came off. it.own
    // is sim state and the pair of colours is derived the same way on both devices, so the
    // two screens light the same tile the same colour with nothing crossing the wire.
    // The tile carries no drawn edge at all. A 1px frame reads as a hard line pasted onto
    // the board, and the cell is meant to look BACKLIT rather than outlined, so the edge is
    // FEATHERED instead: squares spilling outward onto the board, and nested squares
    // accumulating inward to a lit core. That still resolves as one square cell -- which is
    // what keeps it in the same visual language as the square shock ring -- without a single
    // hard line anywhere. All of it is plain fills rather than shadowBlur, so SIMPLE gfx only
    // drops the outward spill and DISABLE GLOW (which merely zeroes shadowBlur) leaves the
    // marker intact instead of flattening it to a dim panel. The icon does NOT bob: vertical
    // drift would unstick the tile from its cell, and sitting square in one cell is the whole
    // point of drawing a tile. The BACKLIGHT breathes instead, which is also what a lit panel
    // would actually do.
    const hue = _wsOwnerHue(it.own);
    const pulse = (_simpleGfx()||_reduceMotion()) ? 1 : 0.7+0.3*Math.sin(now/300);   // REDUCE MOTION keeps the backlight, just holds it steady
    const x0 = it.x*CS, y0 = it.y*CS;
    ctx.save();
    ctx.fillStyle='rgba(8,6,2,0.66)'; ctx.fillRect(x0,y0,CS,CS);   // dark seat: lifts the icon off whatever it landed on
    if(!_simpleGfx())
        for(let k=3;k>=1;k--){   // outward feather: the tile's own light spilling onto the board
            ctx.fillStyle=`hsla(${hue},100%,58%,${0.055*pulse})`;
            ctx.fillRect(x0-k*2.5, y0-k*2.5, CS+k*5, CS+k*5);
        }
    for(let i=0;i<6;i++){   // inward feather: nested squares accumulating to a lit core
        const ins=(i/6)*(CS*0.46);
        ctx.fillStyle=`hsla(${hue},100%,${56+(i/6)*10}%,${0.085*pulse})`;
        ctx.fillRect(x0+ins, y0+ins, CS-ins*2, CS-ins*2);
    }
    ctx.shadowColor=`hsl(${hue},100%,70%)`; ctx.shadowBlur=_simpleGfx()?0:GLOW.TEXT;
    drawPixelIcon(cx-4*sq, cy-4*sq, item.icon, sq);
    ctx.restore();
}

// ================================================================
// CRASH IMPACT (single player and duel). A death is staged from the deferred 'crash' sim
// event, so a mispredicted kill that rolls back never wrecks anything on screen. All of it
// is presentation: the dent is painted OVER the cached bars canvas and the tail fold is a
// draw-time pixel offset, so neither the wall nor the snake's real cells ever move.
// Suppressed under SIMPLE gfx or REDUCE MOTION.
// ================================================================
const CRASH_DUR = DEATH_DUR;   // the wreck plays for exactly as long as the sim holds in 'dying'
const FOLD_STOP = 500;         // the buckle wave stops spreading here, well before the respawn
let _crashFx = [];
function armCrash(e, now){
    if(_simpleGfx()||_reduceMotion()) return;
    const dx = ((e.x-e.hx+COLS+COLS/2)%COLS)-COLS/2;   // shortest wrapped heading into the impact
    const dy = ((e.y-e.hy+ROWS+ROWS/2)%ROWS)-ROWS/2;
    _crashFx.push({ at:now, p:e.p, x:e.x, y:e.y,
                    ax:Math.sign(dx), ay:Math.sign(dy),
                    into:e.into, boost:!!e.boost });
}
function _crashFor(p){
    for(const c of _crashFx) if(c.p===p) return c;
    return null;
}
// Per-segment draw offset for a crashed snake: [dx, dy, headW, headH]. A train hitting a
// wall does not shove backwards, it CONCERTINAS: the locomotive stops dead and squashes,
// then a buckle wave runs back down the train, and each carriage in turn shortens its
// coupling and kicks out to the alternate side. So a straight -------O folds into a jagged
// /\/\/\o in about a fifth of a second. Two parts make that read:
//   PILE  -- every link ahead of a carriage has shortened, so the displacement toward the
//            impact ACCUMULATES down the body and the whole snake visibly gets shorter.
//   KICK  -- the length lost axially goes sideways, alternating each carriage, which is what
//            turns compression into a zigzag instead of a heap.
// Both fade out along the body (exp(-i/reach)): the front folds, the tail is still straight.
// And a wreck STAYS wrecked -- the fold holds for the whole beat, only the rattle settles.
// Boosting hits far harder and reaches much further back; the impact itself times the same.
function _crashJolt(p, now){
    const e = _crashFor(p);
    if(!e) return null;
    const age = now-e.at;
    if(age<0 || age>=CRASH_DUR) return null;
    // Timed on a REAL body, not a round number: growth is +2 a gem over 10 gems a level and
    // startLen runs 3/5/7/10 by level band, so a snake caught mid-level averages ~16 carriages
    // (6.2 + 10). 16*7+90 lands the last of them at ~200ms. The wave is not capped: a very long
    // snake simply keeps folding past that, and the beat ending is the only thing that stops it.
    const wave  = 7;                 // ms before the buckle reaches the next carriage back
    const buck  = 90;                // ms that one carriage takes to fold once the wave hits it
    const reach = e.boost?7:3;       // carriages the fold is still violent at
    const comp  = e.boost?0.48:0.18; // link shortening at full fold, as a fraction of a cell
    const amp   = e.boost?0.5:0.2;   // sideways kick at full fold, as a fraction of a cell.
    // 0.5 is the ceiling, not a taste call: neighbouring carriages swing to OPPOSITE sides, so
    // a bigger kick puts more than CS between them and the fold breaks into loose blocks.
    const rattle = Math.exp(-age/200)*Math.cos(age/34);   // the shake, not the fold: this is what settles
    // Hard stop on the wave: past 500ms it recruits no further carriages and whatever it has
    // not reached stays straight, so the fold can never still be creeping down the tail while
    // the respawn is coming. A carriage already buckling finishes its 90ms -- aborting mid-fold
    // would read as a glitch, not a stop. At 7ms a carriage, that reaches back to 71 -- past any
    // real body, since a level caps at startLen+20 = 30 -- so it is a guarantee, not a normal path.
    const k = i => { if(i*wave > FOLD_STOP) return 0; const s = age - i*wave; return s<=0 ? 0 : Math.min(1, s/buck); };
    const pile = [0];                // prefix sum, built once per frame rather than per segment
    const pileTo = i => { while(pile.length<=i){ const j=pile.length; pile.push(pile[j-1]+comp*CS*k(j)*Math.exp(-j/reach)); } return pile[i]; };
    return i=>{
        if(i===0){
            const c = (e.boost?9:5)*(0.55+0.45*Math.exp(-age/180));   // stays squashed: it is a wreck
            const b0 = e.boost?4:2.5, decay = Math.exp(-age/180);
            // A HEAD-ON is the one crash whose impact cell holds NEITHER snake. Every other
            // death leaves the head already against what killed it -- the bar, the body -- so
            // the wreck reads right from the cell the head stands on. Here both heads stopped
            // one cell short of the cell they both tried to enter, which drew them a whole
            // clear block apart under a message saying they had collided. Lean the head half a
            // cell into that shared cell so the two meet on its edge, and run the recoil
            // FORWARD from that contact instead of backward from the cell behind it.
            const push = e.into==='headon' ? CS/2 - b0*(1-decay) : -b0*decay;
            return [ e.ax*push, e.ay*push, e.ax?-c:c*0.8, e.ay?-c:c*0.8 ];
        }
        const kick = amp*CS*Math.exp(-i/reach)*k(i)*(i%2?1:-1)*(1+0.35*rattle);
        const p2 = pileTo(i);
        return [ e.ax*p2 - e.ay*kick, e.ay*p2 + e.ax*kick, 0, 0 ];
    };
}
function _crashDent(e, age){
    const amp = (e.boost?7:3.5)*Math.exp(-age/210)*Math.abs(Math.cos(age/60));
    if(amp<0.6) return;
    const bx = e.x*CS, by = e.y*CS;
    const near = Math.max(1, Math.round(amp)), far = Math.max(1, Math.round(amp*0.6));
    ctx.save();
    ctx.fillStyle = '#4a1000';   // the struck face caves in
    if(e.ax>0)      ctx.fillRect(bx, by, near, CS);
    else if(e.ax<0) ctx.fillRect(bx+CS-near, by, near, CS);
    else if(e.ay>0) ctx.fillRect(bx, by, CS, near);
    else            ctx.fillRect(bx, by+CS-near, CS, near);
    ctx.fillStyle = '#ff9944';   // and bulges out of the far side
    if(e.ax>0)      ctx.fillRect(bx+CS-far, by, far, CS);
    else if(e.ax<0) ctx.fillRect(bx, by, far, CS);
    else if(e.ay>0) ctx.fillRect(bx, by+CS-far, CS, far);
    else            ctx.fillRect(bx, by, CS, far);
    ctx.restore();
}
// Chips thrown back out of the impact: brick off a wall, snake off a snake.
function _crashChips(e, age){
    const t = age/420;
    if(t>=1) return;
    const cx = e.x*CS+CS/2, cy = e.y*CS+CS/2;
    const cols = e.into==='bar' ? ['#cc4400','#ff7700','#5a1a00','#ffbb66']
                                : ['#7fff7f','#3aa03a','#ddffdd','#2a802a'];
    ctx.save();
    for(let k=0;k<10;k++){
        const a = k*0.628+0.3, sp = 30+((k*37)%50);
        const px = cx - e.ax*8 + Math.cos(a)*sp*t;
        const py = cy - e.ay*8 + Math.sin(a)*sp*t + 150*t*t;
        const sz = (2+(k%3))*(1-t*0.5);
        ctx.globalAlpha = (1-t)*0.9; ctx.fillStyle = cols[k%cols.length];
        ctx.fillRect(px-sz/2, py-sz/2, sz, sz);
    }
    ctx.restore();
}
// Normal speed: comic stars ring the head. Boosting: little birds circle it instead, and
// they stay for the whole wreck -- the respawn gap exists so they can be seen.
function _crashStars(age, hx, hy){
    const dur = 700;
    if(age>=dur) return;
    const t = age/dur;
    ctx.save(); ctx.globalAlpha=(1-t)*0.95; ctx.fillStyle='#ffe066';
    for(let k=0;k<5;k++){
        const a = k*(Math.PI*2/5) + age/260;
        const r = 12+t*7;
        const sx = hx+Math.cos(a)*r, sy = hy+Math.sin(a)*r*0.55-t*6;
        ctx.fillRect(sx-3, sy-1, 6, 2);
        ctx.fillRect(sx-1, sy-3, 2, 6);
    }
    ctx.restore();
}
function _crashBirds(age, hx, hy){
    const dur = 1300;
    if(age>=dur) return;
    const fade = age>dur-300 ? (dur-age)/300 : 1;
    ctx.save(); ctx.globalAlpha=fade*0.95; ctx.strokeStyle='#ffffff'; ctx.lineWidth=2;
    for(let k=0;k<3;k++){
        const a = k*(Math.PI*2/3) + age/420;
        const r = 15+Math.sin(age/300+k)*3;
        const bx = hx+Math.cos(a)*r, by = hy+Math.sin(a)*r*0.5-8;
        const flap = Math.sin(age/70+k*2)*4;   // wings beat for as long as they circle
        ctx.beginPath();
        ctx.moveTo(bx-5, by+flap); ctx.lineTo(bx, by-2); ctx.lineTo(bx+5, by+flap);
        ctx.stroke();
    }
    ctx.restore();
}
function _drawCrashFx(now){
    _crashFx = _crashFx.filter(e=>{
        const age = now-e.at;
        if(age<0 || age>=CRASH_DUR) return false;
        const segs = e.p<0 ? snake : (players && players[e.p] ? players[e.p].snake : null);
        if(!segs || segs.length===0) return true;   // no snake to anchor on yet: keep the wreck queued
        const j = _crashJolt(e.p, now);
        const o = j ? j(0) : [0,0,0,0];
        const hx = segs[0].x*CS+CS/2+o[0], hy = segs[0].y*CS+CS/2+o[1];
        if(e.into==='bar') _crashDent(e, age);
        _crashChips(e, age);
        if(e.boost) _crashBirds(age, hx, hy); else _crashStars(age, hx, hy);
        return true;
    });
}

// ================================================================
// DRAW HELPERS
// ================================================================
function rr(x,y,w,h,r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
    ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}
function eyeOffsets(d) {
    if(!d) d={x:1,y:0};   // a snake always has a facing; never let a missing dir abort the frame
    const E=CS-2;
    if(d.x===1)  return [[E-5,2],[E-5,E-5]]; if(d.x===-1) return [[2,2],[2,E-5]];
    if(d.y===-1) return [[2,2],[E-5,2]];      return [[2,E-5],[E-5,E-5]];
}
// EYELIDS. Both of these are renderer-only, the same discipline the scrape follows: they
// read state the sim owns but judge nothing, draw no rng, are never hashed and put nothing on
// the wire, so a rollback cannot disturb them and there is nothing to keep in lockstep.
//
// _blinkK is the idle blink, and it reports the PACE of the round. The cadence is a hash of
// the wall clock and the player index -- no stored state, and the two screens happen to agree
// only because they read the same clock. Cruising gets a heavy lid that falls, lingers and
// lifts; boosting gets a bare flick, because an eye shut for a quarter second at two cells a
// tick is an eye that missed the wall. From BLINK_FLICK_LEVEL on nothing is ever slow again,
// so the flick becomes the whole vocabulary.
const BLINK_CYCLE = 4200;   // nominal ms between blinks
const BLINK_HEAVY = 260;    // cruising: a lid that takes its time
const BLINK_FLICK = 110;    // boosting / late levels: shut and open, no frames in between
const BLINK_FLICK_LEVEL = 5;
function _blinkK(pi, fast, now){
    const t = now + (pi+1)*1637;   // per-snake phase: two snakes must never share a blink grid
    const slot = Math.floor(t/BLINK_CYCLE);
    let dt = Infinity;
    // The jitter carries a blink either side of its slot boundary, so the neighbours are read
    // too -- scanning the current slot alone silently drops every negatively jittered blink.
    for(let k=slot-1;k<=slot+1;k++){
        const h = ((k+(pi+1)*97)*2654435761)>>>0;
        const d = t - (k*BLINK_CYCLE + (h%1600) - 800);
        if(d>=0 && d<dt) dt=d;
    }
    if(fast) return dt<BLINK_FLICK ? 1 : 0;
    if(dt>=BLINK_HEAVY) return 0;
    return Math.pow(Math.sin((dt/BLINK_HEAVY)*Math.PI), 0.6);   // lingers shut at the bottom of the arc
}
// The one place the two are combined, and the one gate over both: shut wins over any blink
// phase (there is no half-bracing), and REDUCE MOTION leaves the eyes wide open -- a plain
// 3x3 eye and nothing else. Split out of drawSnakeG so the policy -- who counts as
// boosting, where the flick takes over, whether a brace beats a blink -- can be tested
// directly; the canvas calls themselves are unobservable in the headless harness.
function _eyeLid(segs, eyeDir, pi, now){
    if(_reduceMotion()) return 0;
    const fast=((players&&pi>=0)?players[pi].boosting:boosting)||level>=BLINK_FLICK_LEVEL;
    return Math.max(_blinkK(pi, fast, now), _braceK(segs, eyeDir, pi));
}
// _braceK is the flinch, and a flinch is anticipation or it is nothing: the eyes are already
// shut when the hit lands, not after. Two things are worth bracing for -- the cells the head is
// about to enter, and the rival's head closing in on a DIFFERENT heading, which is the pass
// that costs gear (a shared heading is a scrape, and nothing ever comes off a scrape). Both
// ramp: half shut two cells out, fully shut one cell out. Written without allocating, because
// it runs per snake per frame on hardware as slow as a TV browser.
function _braceK(segs, eyeDir, pi){
    const h = segs[0], d = eyeDir || {x:1,y:0};
    const duel = !!players && pi>=0;
    let k = 0;
    for(let n=1;n<=2;n++){
        const x=(h.x+d.x*n+COLS)%COLS, y=(h.y+d.y*n+ROWS)%ROWS;
        let solid = false;
        // A fragile bar is smashed through rather than hit, so there is nothing there to fear.
        for(let i=0;i<bars.length;i++) if(bars[i].x===x&&bars[i].y===y&&!bars[i].fragile){ solid=true; break; }
        // Own body, minus the tail cell it is about to vacate.
        if(!solid) for(let i=0;i<segs.length-1;i++) if(segs[i].x===x&&segs[i].y===y){ solid=true; break; }
        if(!solid && duel){
            const o=players[1-pi];
            if(o.alive) for(let i=0;i<o.snake.length;i++) if(o.snake[i].x===x&&o.snake[i].y===y){ solid=true; break; }
        }
        if(solid){ k = n===1 ? 1 : 0.5; break; }
    }
    if(duel && players[0].alive && players[1].alive){
        const o=players[1-pi], od=o.dir, oh=o.snake[0];
        if(!(od.x===d.x && od.y===d.y)){
            // Unwrapped, like the near-miss this braces for: a rival across an edge is a screen
            // away and takes nothing off you. The path lookahead above stays wrapped -- that one
            // is a real collision, and movement really does cross the edge.
            const ch=Math.max(Math.abs(h.x-oh.x),Math.abs(h.y-oh.y));
            if(ch<=1) k=1; else if(ch<=2 && k<0.5) k=0.5;
        }
    }
    return k;
}
const _gridCanvas=document.createElement('canvas'); _gridCanvas.width=CW; _gridCanvas.height=CH;
const _scanCanvas=document.createElement('canvas'); _scanCanvas.width=CW; _scanCanvas.height=CH;
const _barsCanvas=document.createElement('canvas'); _barsCanvas.width=CW; _barsCanvas.height=CH;
const _barsCtx=_barsCanvas.getContext('2d');
// Static background = grid + bars, pre-composited so the board is one blit per frame
// (instead of grid + bars separately). Rebuilt only when bars change (see _composeBg).
const _bgCanvas=document.createElement('canvas'); _bgCanvas.width=CW; _bgCanvas.height=CH;
const _bgCtx=_bgCanvas.getContext('2d');
// Central glow control: intercept the shadowBlur setter once per context so that
// cfg.disableGlow forces it to 0 EVERYWHERE, with zero changes at the 80+ call sites.
function _glowGuard(c){
    const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c),'shadowBlur');
    if(!d||!d.set) return;   // stub context (headless tests) -- nothing to guard
    Object.defineProperty(c,'shadowBlur',{ configurable:true,
        get(){ return d.get.call(this); },
        set(v){ d.set.call(this, cfg.disableGlow ? 0 : v); } });
}
_glowGuard(ctx);
(()=>{
    const g=_gridCanvas.getContext('2d');
    g.fillStyle='#07070e'; g.fillRect(0,0,CW,CH);
    g.strokeStyle='#0d0d1a'; g.lineWidth=0.5; g.beginPath();
    for(let x=0;x<=COLS;x++){g.moveTo(x*CS,0);g.lineTo(x*CS,CH);}
    for(let y=0;y<=ROWS;y++){g.moveTo(0,y*CS);g.lineTo(CW,y*CS);}
    g.stroke();
    const s=_scanCanvas.getContext('2d');
    s.fillStyle='rgba(0,0,0,0.05)';
    for(let y=0;y<CH;y+=3) s.fillRect(0,y,CW,1);
})();
function drawGrid() { ctx.drawImage(_gridCanvas, 0, 0); }
// Recompose the static background (grid is opaque, bars drawn on top). Called whenever
// the bar layout changes, so drawGameBoard can blit it in a single drawImage.
function _composeBg() { _bgCtx.drawImage(_gridCanvas, 0, 0); _bgCtx.drawImage(_barsCanvas, 0, 0); }
_composeBg();
function drawOvBg(a) { ctx.fillStyle=`rgba(7,7,14,${a||0.88})`; ctx.fillRect(0,0,CW,CH); }
// "Black glass": frost the current frame (blur) and lay a heavy dark tint over it, so a
// confirmation dialog stays readable over any busy screen. Canvas is CW x CH with no DPR
// scaling, so it blurs cleanly onto itself; the blur is guarded for contexts without filter.
function drawGlass() {
    try { ctx.save(); ctx.filter='blur(6px)'; ctx.drawImage(ctx.canvas, 0, 0); ctx.filter='none'; ctx.restore(); } catch(e) {}
    ctx.fillStyle='rgba(4,4,9,0.82)'; ctx.fillRect(0,0,CW,CH);
}
// ct()/ctg() live in js/text.js (typography module, loaded before this file).

// High-contrast barricades (>4.5:1 on dark bg) - bright amber brick
// Neighbour lookup so touching barricades of the same kind render as one
// continuous wall: shared edges drop the 1px inset and the bevel, so the fills
// meet seamlessly. _prepBars must run before a drawBar pass. allFragile mirrors
// the caller's asFragile override (power mode paints every bar as fragile).
let _barLookup=new Map(), _barAllFragile=false;
function _prepBars(allFragile){ _barAllFragile=allFragile; _barLookup=new Map(); for(const b of bars) _barLookup.set(ck(b),b); }
function _barConn(nx,ny,eff){
    if(nx<0||nx>=COLS||ny<0||ny>=ROWS) return false;   // no wrap -- edges aren't visually adjacent
    const n=_barLookup.get(nx+','+ny);
    if(!n) return false;
    return (_barAllFragile?true:n.fragile)===eff;
}
function drawBar(b, c=ctx, asFragile=b.fragile) {
    const eff=asFragile;
    const cL=_barConn(b.x-1,b.y,eff), cR=_barConn(b.x+1,b.y,eff);
    const cU=_barConn(b.x,b.y-1,eff), cD=_barConn(b.x,b.y+1,eff);
    const x=b.x*CS+(cL?0:1), y=b.y*CS+(cU?0:1);
    const bw=CS-(cL?0:1)-(cR?0:1), bh=CS-(cU?0:1)-(cD?0:1);
    if(eff){
        // Crumbling border block: grey-brown, visibly damaged
        c.fillStyle='#7a6050'; c.fillRect(x,y,bw,bh);
        c.fillStyle='#4a3a2a';
        c.fillRect(x,y+Math.floor(bh/2),bw,1);
        c.fillRect(x+Math.floor(bw/2),y,1,Math.floor(bh/2));
        // Faded bevel -- only on outer (unconnected) edges
        c.fillStyle='#aa9080'; if(!cU)c.fillRect(x,y,bw,2); if(!cL)c.fillRect(x,y,2,bh);
        c.fillStyle='#332820'; if(!cR)c.fillRect(x+bw-2,y,2,bh); if(!cD)c.fillRect(x,y+bh-2,bw,2);
        // Diagonal cracks
        c.strokeStyle='#2a1a0a'; c.lineWidth=1;
        c.beginPath(); c.moveTo(x+3,y+2); c.lineTo(x+bw-4,y+bh-3); c.stroke();
        c.beginPath(); c.moveTo(x+bw-5,y+2); c.lineTo(x+4,y+Math.floor(bh*0.6)); c.stroke();
        return;
    }
    c.fillStyle='#cc4400'; c.fillRect(x,y,bw,bh);
    // mortar lines: T-shape per cell -- tiles into brickwork across a connected wall
    c.fillStyle='#5a1a00';
    c.fillRect(x,y+Math.floor(bh/2),bw,1);
    c.fillRect(x+Math.floor(bw/2),y,1,Math.floor(bh/2));
    // 3D bevel -- only on outer (unconnected) edges
    c.fillStyle='#ff7700'; if(!cU)c.fillRect(x,y,bw,2); if(!cL)c.fillRect(x,y,2,bh);
    c.fillStyle='#661800'; if(!cR)c.fillRect(x+bw-2,y,2,bh); if(!cD)c.fillRect(x,y+bh-2,bw,2);
}
function renderBarsOffscreen() {
    _barsCtx.clearRect(0,0,CW,CH); _prepBars(false); bars.forEach(b=>drawBar(b,_barsCtx));
    _composeBg();
}

// SIMPLE graphics mode (cfg.gfxMode 0): in-game items render as STATIC elements -- no spin,
// no scale-pulse, no colour cycling. STANDARD (1, default) and FABULOUS (2, not built) animate.
function _simpleGfx(){ return cfg.gfxMode === 0; }
// REDUCE MOTION (accessibility): suppress non-essential animated impulses -- the near-miss
// screen-shake today, other decorative motion as it is added. Orthogonal to SIMPLE gfx (that
// stills item spin/pulse); this one is about vestibular comfort. Seeded from the OS
// prefers-reduced-motion the first time, then user-overridable in SETTINGS > GRAPHICS.
function _reduceMotion(){ return !!cfg.reduceMotion; }
function drawGem(g,now) {
    const cx=g.x*CS+CS/2, cy=g.y*CS+CS/2, t=_simpleGfx()?0:(now-gemAt)/1000;
    const tier=g.tier||0;
    if(tier===2){
        // Epic gem: rainbow, sparkles, spawn burst
        const hue=_simpleGfx()?0:(now/8)%360;
        const r=(CS/2-1)*(1+0.20*Math.sin(t*9));
        ctx.save(); ctx.translate(cx,cy); ctx.rotate(t*5);
        // Spawn burst rings (1.4s) -- an animation, so SIMPLE mode skips them
        const bAge=now-g.spawnAt;
        if(bAge<1400 && !_simpleGfx()){
            const bp=bAge/1400;
            [1,2].forEach(n=>{
                ctx.save();
                ctx.globalAlpha=(1-bp)*0.7;
                ctx.strokeStyle=`hsl(${(hue+n*60)%360},100%,70%)`;
                ctx.lineWidth=3; ctx.shadowColor=ctx.strokeStyle; ctx.shadowBlur=10;
                ctx.beginPath(); ctx.arc(0,0,r*(1+n*3*bp),0,Math.PI*2); ctx.stroke();
                ctx.restore();
            });
        }
        // Outer glow
        if(!cfg.disableGlow){
            const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.8);
            grd.addColorStop(0,`hsla(${hue},100%,65%,0.22)`); grd.addColorStop(1,`hsla(${hue},100%,65%,0)`);
            ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.8,0,Math.PI*2); ctx.fill();
        }
        // Diamond
        ctx.shadowColor=`hsl(${hue},100%,70%)`; ctx.shadowBlur=12;
        ctx.fillStyle=`hsl(${hue},100%,65%)`;
        ctx.beginPath(); ctx.moveTo(0,-r*1.1); ctx.lineTo(r*0.7,0); ctx.lineTo(0,r*1.1); ctx.lineTo(-r*0.7,0); ctx.closePath(); ctx.fill();
        ctx.fillStyle='rgba(255,255,255,0.5)';
        ctx.beginPath(); ctx.moveTo(0,-r*1.1); ctx.lineTo(r*0.7,0); ctx.lineTo(0,0); ctx.closePath(); ctx.fill();
        ctx.restore();
        // Orbiting sparkles
        for(let i=0;i<6;i++){
            const a=t*3+(i/6)*Math.PI*2;
            const sx=cx+Math.cos(a)*CS*1.3, sy=cy+Math.sin(a)*CS*1.3;
            ctx.save();
            ctx.fillStyle=`hsl(${(hue+i*60)%360},100%,80%)`;
            ctx.shadowColor=ctx.fillStyle; ctx.shadowBlur=6;
            ctx.beginPath(); ctx.arc(sx,sy,2.2,0,Math.PI*2); ctx.fill();
            ctx.restore();
        }
    } else if(tier===1){
        // Lucky gem: gold, faster spin
        const r=(CS/2-1)*(1+0.15*Math.sin(t*7));
        ctx.save(); ctx.translate(cx,cy); ctx.rotate(t*3.5);
        if(!cfg.disableGlow){
            const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.5);
            grd.addColorStop(0,'rgba(255,215,0,0.32)'); grd.addColorStop(1,'rgba(255,215,0,0)');
            ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.5,0,Math.PI*2); ctx.fill();
        }
        ctx.shadowColor='#ffd700'; ctx.shadowBlur=18;
        ctx.fillStyle='#ffd700';
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,r); ctx.lineTo(-r*0.65,0); ctx.closePath(); ctx.fill();
        ctx.fillStyle='rgba(255,255,255,0.52)';
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,0); ctx.closePath(); ctx.fill();
        ctx.restore();
    } else if(g.gouranga) {
        // Gouranga gem: orange diamond
        const r=(CS/2-2)*(1+0.12*Math.sin(t*5));
        ctx.save(); ctx.translate(cx,cy); ctx.rotate(t*2);
        if(!cfg.disableGlow){
            const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.2);
            grd.addColorStop(0,'rgba(255,140,0,0.25)'); grd.addColorStop(1,'rgba(255,140,0,0)');
            ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.2,0,Math.PI*2); ctx.fill();
        }
        ctx.shadowColor='#ff8800'; ctx.shadowBlur=14;
        const fg=ctx.createLinearGradient(0,-r,0,r);
        fg.addColorStop(0,'#ffee88'); fg.addColorStop(0.35,'#ff8800'); fg.addColorStop(1,'#cc4400');
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,r); ctx.lineTo(-r*0.65,0); ctx.closePath();
        ctx.fillStyle=fg; ctx.fill(); ctx.restore();
    } else {
        // Normal gem: cyan diamond
        const r=(CS/2-2)*(1+0.12*Math.sin(t*5));
        ctx.save(); ctx.translate(cx,cy); ctx.rotate(t*2);
        if(!cfg.disableGlow){
            const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.2);
            grd.addColorStop(0,'rgba(0,255,255,0.25)'); grd.addColorStop(1,'rgba(0,255,255,0)');
            ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.2,0,Math.PI*2); ctx.fill();
        }
        ctx.shadowColor='#00ffff'; ctx.shadowBlur=14;
        const fg=ctx.createLinearGradient(0,-r,0,r);
        fg.addColorStop(0,'#ffffff'); fg.addColorStop(0.35,'#00ffff'); fg.addColorStop(1,'#006688');
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,r); ctx.lineTo(-r*0.65,0); ctx.closePath();
        ctx.fillStyle=fg; ctx.fill(); ctx.restore();
    }
}

function triggerPurchaseAnim() {
    purchaseAnimAt = simNow;
    for(let i=0;i<50;i++){
        const angle=(i/50)*Math.PI*2, spd=1.5+Math.random()*3.5;
        purchaseParticles.push({
            x:CW/2, y:CH*0.5,
            vx:Math.cos(angle)*spd*(0.6+Math.random()),
            vy:Math.sin(angle)*spd-1.2,
            size:3+Math.random()*6,
            color:Math.random()<0.65?'#ffd700':'#ffee88',
            life:0, maxLife:55+Math.floor(Math.random()*45),
            rot:Math.random()*Math.PI*2, vrot:(Math.random()-0.5)*0.2,
        });
    }
}

function drawAccessoryCylinder(hx, hy) {
    ctx.fillStyle='#1a1a1a';
    ctx.fillRect(hx+3,hy-10,12,9);   // body
    ctx.fillRect(hx-2,hy-2,22,3);    // brim
    ctx.fillStyle='#333333';
    ctx.fillRect(hx+3,hy-3,12,1);    // band
    ctx.fillStyle='#2a2a2a';
    ctx.fillRect(hx+3,hy-10,12,1);   // top sheen
}

function drawAccessoryMonocle(hx, hy, d) {
    const e=eyeOffsets(d)[0];
    ctx.strokeStyle='#cccccc'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.arc(hx+e[0]+1.5,hy+e[1]+1.5,3.5,0,Math.PI*2); ctx.stroke();
    ctx.strokeStyle='#888888'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(hx+e[0]+4,hy+e[1]+4); ctx.lineTo(hx+e[0]+8,hy+e[1]+9); ctx.stroke();
}

function drawAccessoryShades(hx, hy, d) {
    const eyes=eyeOffsets(d);
    ctx.fillStyle='#111111';
    eyes.forEach(([ox,oy])=>{ctx.beginPath();ctx.arc(hx+ox+1.5,hy+oy+1.5,4,0,Math.PI*2);ctx.fill();});
    ctx.fillStyle='#1a3050';
    eyes.forEach(([ox,oy])=>{ctx.beginPath();ctx.arc(hx+ox+1.5,hy+oy+1.5,2.5,0,Math.PI*2);ctx.fill();});
    if(eyes.length>=2){
        const x1=hx+eyes[0][0]+1.5, y1=hy+eyes[0][1]+1.5, x2=hx+eyes[1][0]+1.5, y2=hy+eyes[1][1]+1.5;
        ctx.strokeStyle='#111111'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    }
}

function drawAccessoryCrown(hx, hy) {
    ctx.fillStyle='#ffd700';
    ctx.fillRect(hx+1,hy-12,4,10); ctx.fillRect(hx+7,hy-15,5,13); ctx.fillRect(hx+14,hy-12,4,10);
    ctx.fillRect(hx,hy-5,19,5);
    ctx.fillStyle='#cc8800'; ctx.fillRect(hx,hy-5,19,1);
    ctx.fillStyle='#ff4444'; ctx.fillRect(hx+2,hy-4,2,2);
    ctx.fillStyle='#4488ff'; ctx.fillRect(hx+8,hy-4,3,2);
    ctx.fillStyle='#ff4444'; ctx.fillRect(hx+15,hy-4,2,2);
}

function drawAccessoryBow(hx, hy, facing={x:1,y:0}) {
    ctx.save();
    ctx.translate(hx+9,hy+9); ctx.rotate(Math.atan2(facing.y,facing.x));
    ctx.fillStyle='#cc2222';
    ctx.fillRect(-5,-2,4,5);   // left wing
    ctx.fillRect(2,-2,4,5);    // right wing
    ctx.fillStyle='#ff4444';
    ctx.fillRect(-5,-2,4,2);
    ctx.fillRect(2,-2,4,2);
    ctx.fillStyle='#aa0000';
    ctx.fillRect(-1,-1,3,3);   // knot center
    ctx.restore();
}

function drawAccessoryNecktie(hx, hy, facing={x:1,y:0}) {
    ctx.save();
    ctx.translate(hx+9,hy+9); ctx.rotate(Math.atan2(facing.y,facing.x));
    // Blade trails behind the head (opposite the facing direction)
    ctx.fillStyle='#2a52be';
    ctx.beginPath();
    ctx.moveTo(-1,-3); ctx.lineTo(-1,3); ctx.lineTo(-6,4);
    ctx.lineTo(-9,0); ctx.lineTo(-6,-4); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#5a82ee';            // highlight stripe
    ctx.beginPath();
    ctx.moveTo(-3,-1); ctx.lineTo(-3,1); ctx.lineTo(-7,0); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#1a3a8e';            // knot
    ctx.fillRect(-1,-3,4,5);
    ctx.restore();
}

function drawAccessoryHalo(hx, hy) {
    ctx.save();
    ctx.strokeStyle='#ffe23a'; ctx.lineWidth=2; ctx.shadowColor='#ffe23a'; ctx.shadowBlur=8;
    ctx.beginPath(); ctx.ellipse(hx+9,hy-7,9,3.2,0,0,Math.PI*2); ctx.stroke();
    ctx.restore();
}
// ---- Box-exclusive accessories ----
function drawAccessoryEyepatch(hx, hy, d) {
    const e=eyeOffsets(d)[0], cx=hx+e[0]+1.5, cy=hy+e[1]+1.5;
    ctx.strokeStyle='#0a0a0a'; ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.moveTo(hx-1,cy-4.5); ctx.lineTo(hx+19,cy+2.5); ctx.stroke();   // strap
    ctx.fillStyle='#0a0a0a';
    ctx.beginPath(); ctx.ellipse(cx,cy,3.4,3,0,0,Math.PI*2); ctx.fill();                // patch
    ctx.fillStyle='#2a2a2a'; ctx.fillRect(Math.round(cx-2),Math.round(cy-2),1,1);       // sheen
}
function drawAccessoryGlasses3d(hx, hy, d) {
    const eyes=eyeOffsets(d), cols=['#ff2a2a','#22e0ff'];
    ctx.fillStyle='#111111';
    eyes.forEach(([ox,oy])=>{ctx.beginPath();ctx.arc(hx+ox+1.5,hy+oy+1.5,4,0,Math.PI*2);ctx.fill();});
    eyes.forEach(([ox,oy],i)=>{ctx.fillStyle=cols[i%2];ctx.beginPath();ctx.arc(hx+ox+1.5,hy+oy+1.5,2.6,0,Math.PI*2);ctx.fill();});
    if(eyes.length>=2){
        ctx.strokeStyle='#111111'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(hx+eyes[0][0]+1.5,hy+eyes[0][1]+1.5); ctx.lineTo(hx+eyes[1][0]+1.5,hy+eyes[1][1]+1.5); ctx.stroke();
    }
}
function drawAccessoryPropeller(hx, hy) {
    ctx.fillStyle='#e03c3c'; ctx.fillRect(hx+4,hy-6,11,6);      // beanie
    ctx.fillStyle='#f5d020'; ctx.fillRect(hx+4,hy-4,11,2);
    ctx.fillStyle='#2aa84a'; ctx.fillRect(hx+4,hy-1,11,1);
    ctx.fillStyle='#888888'; ctx.fillRect(hx+9,hy-9,2,3);       // stalk
    ctx.fillStyle='#4a90d9'; ctx.fillRect(hx+3,hy-10,6,2);      // blade L
    ctx.fillStyle='#e03c3c'; ctx.fillRect(hx+10,hy-10,6,2);     // blade R
    ctx.fillStyle='#ffd700'; ctx.fillRect(hx+8,hy-11,3,3);      // hub
}
function drawAccessoryAdmincrown(hx, hy) {
    ctx.save(); ctx.shadowColor='#00e5ff'; ctx.shadowBlur=6;
    ctx.fillStyle='#ffe860';
    ctx.fillRect(hx+1,hy-13,4,11); ctx.fillRect(hx+7,hy-16,5,14); ctx.fillRect(hx+14,hy-13,4,11);
    ctx.fillRect(hx,hy-5,19,5);
    ctx.shadowBlur=0;
    ctx.fillStyle='#cc9a00'; ctx.fillRect(hx,hy-5,19,1);
    ctx.fillStyle='#00e5ff'; ctx.fillRect(hx+2,hy-15,2,2); ctx.fillRect(hx+8,hy-4,3,2); ctx.fillRect(hx+15,hy-15,2,2);
    ctx.restore();
}
// Karate black belt wrapped around a body segment: a band across the cell with a
// centred knot and two short hanging tails.
function drawAccessoryBlackbelt(x, y) {
    const w=CS-2;
    ctx.fillStyle='#111111'; ctx.fillRect(x-1,y+6,w+2,5);          // belt band
    ctx.fillStyle='#333333'; ctx.fillRect(x-1,y+7,w+2,1);          // sheen
    ctx.fillStyle='#111111';
    ctx.fillRect(x+7,y+5,5,4);                                     // knot
    ctx.fillRect(x+7,y+9,2,5); ctx.fillRect(x+10,y+9,2,4);         // two hanging tails
}
function drawAccessoryLasereyes(hx, hy, d) {
    d = d || {x:1,y:0};
    const eyes=eyeOffsets(d);
    ctx.save(); ctx.shadowColor='#ff2020'; ctx.shadowBlur=8;
    eyes.forEach(([ox,oy])=>{
        const ex=hx+ox+1.5, ey=hy+oy+1.5;
        ctx.fillStyle='#ff3030'; ctx.beginPath(); ctx.arc(ex,ey,2.2,0,Math.PI*2); ctx.fill();
        ctx.strokeStyle='rgba(255,40,40,0.85)'; ctx.lineWidth=2;
        ctx.beginPath(); ctx.moveTo(ex,ey); ctx.lineTo(ex+d.x*11,ey+d.y*11); ctx.stroke();
    });
    ctx.restore();
}
function drawAccessoryGoldchain(hx, hy, facing={x:1,y:0}) {
    ctx.save();
    ctx.translate(hx+9,hy+9); ctx.rotate(Math.atan2(facing.y,facing.x));
    // Hangs around the neck: an arc across the BACK of the head (opposite the eyes), so it
    // always trails the facing direction instead of sitting below or to one side of it.
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=5;
    ctx.strokeStyle='#ffd700'; ctx.lineWidth=1.6;
    ctx.beginPath(); ctx.moveTo(-2,-7); ctx.quadraticCurveTo(-9,0,-2,7); ctx.stroke();
    ctx.fillStyle='#fff2a0'; ctx.fillRect(-9,-2,4,4);          // pendant, at the back
    ctx.fillStyle='#b8860b'; ctx.fillRect(-8,-1,2,2);
    ctx.restore();
}

function drawAccessoryMoustache(hx, hy, d) {
    const eyes=eyeOffsets(d);
    const ex=(eyes[0][0]+(eyes[1]?eyes[1][0]:eyes[0][0]))/2+1.5;
    const ey=(eyes[0][1]+(eyes[1]?eyes[1][1]:eyes[0][1]))/2+1.5+4;
    ctx.save(); ctx.fillStyle='#2a1a0a';
    ctx.beginPath(); ctx.ellipse(hx+ex-3,hy+ey,3,1.8,0.35,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(hx+ex+3,hy+ey,3,1.8,-0.35,0,Math.PI*2); ctx.fill();
    ctx.restore();
}

function drawAccessoryWizard(hx, hy) {
    ctx.fillStyle='#5a2a9a';                             // cone
    ctx.beginPath(); ctx.moveTo(hx+9,hy-16); ctx.lineTo(hx+2,hy-1); ctx.lineTo(hx+16,hy-1); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#3a1a6a'; ctx.fillRect(hx,hy-2,18,2); // brim
    ctx.fillStyle='#ffe860';                             // star tip + specks
    ctx.fillRect(hx+8,hy-18,2,2); ctx.fillRect(hx+6,hy-8,1,1); ctx.fillRect(hx+11,hy-11,1,1);
}

// Perf: pre-build the segment rounded-rects once (filled translated each frame)
// instead of rebuilding an 8-curve path per segment, and cache body colours so the
// per-segment hsl() strings aren't reallocated every frame. Zero visual change;
// falls back to rr() if Path2D is unavailable.
const _mkSegPath = r => {
    if (typeof Path2D === 'undefined') return null;
    const p = new Path2D(), w = CS-2, h = CS-2;
    p.moveTo(r,0); p.lineTo(w-r,0); p.quadraticCurveTo(w,0,w,r);
    p.lineTo(w,h-r); p.quadraticCurveTo(w,h,w-r,h);
    p.lineTo(r,h); p.quadraticCurveTo(0,h,0,h-r);
    p.lineTo(0,r); p.quadraticCurveTo(0,0,r,0); p.closePath();
    return p;
};
const _segPathBody = _mkSegPath(3), _segPathHead = _mkSegPath(5);
let _bodyColCache = { h:-1, len:-1, cols:null };
function _bodyCols(len, h) {
    if (_bodyColCache.h !== h || _bodyColCache.len !== len) {
        const cols = new Array(len);
        for (let j=0; j<len; j++) { const l = Math.round(41*(0.5+0.5*(1-j/Math.max(len,1)))); cols[j] = `hsl(${h},65%,${l}%)`; }
        _bodyColCache = { h, len, cols };
    }
    return _bodyColCache.cols;
}
// While the Power Pellet is active the head becomes a chomping Pac-Man (facing
// the travel direction). Cosmetic only -- reverts to the normal head when power ends.
function drawPacHead(x, y, facing) {
    const now=performance.now();
    const cx=x+(CS-2)/2, cy=y+(CS-2)/2, r=(CS-2)/2;
    const open=(0.5+0.5*Math.sin(now/70))*0.30*Math.PI;   // mouth chomps open/closed
    const ang=Math.atan2(facing.y, facing.x);             // right 0, down +PI/2, up -PI/2, left PI
    ctx.save();
    ctx.fillStyle='#ffd11a'; ctx.shadowColor='#ffcc00'; ctx.shadowBlur=10;
    ctx.beginPath(); ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,r, ang+open, ang-open+Math.PI*2); ctx.closePath(); ctx.fill();
    ctx.shadowBlur=0;
    const px=facing.y, py=-facing.x;                       // perpendicular = eye above the mouth
    ctx.fillStyle='#001500';
    ctx.beginPath(); ctx.arc(cx+px*r*0.42+facing.x*r*0.12, cy+py*r*0.42+facing.y*r*0.12, 1.6, 0, Math.PI*2); ctx.fill();
    ctx.restore();
}
// Core snake renderer, parametrized (segments, direction, queue, colour, wardrobe) so the
// Draws ONE snake, whole: colour, head, and the ENTIRE wardrobe. Single player and
// each duel snake go through here, so a snake looks the same wherever it is drawn --
// the belt/shoes/gown used to live in drawSnake() alone, which meant an online
// opponent silently lost half their cosmetics. shimmer = draw the gown's travelling
// sparkle (single player: beating the record; duel: leading -- both clients agree).
function drawSnakeG(segs, sdir, squeue, colorIdx, si, flash, shimmer, jolt, pi) {
    const sc=SNAKE_COLORS[colorIdx||0];
    const cols = flash ? null : _bodyCols(segs.length, sc.h);
    const sw=CS-2,sh=CS-2,len=segs.length;
    segs.forEach((seg,i)=>{
        const j=jolt?jolt(i):null;   // crash fold: a DRAW offset only, the cells themselves never move
        const x=seg.x*CS+1+(j?j[0]:0),y=seg.y*CS+1+(j?j[1]:0);
        if(i>0){
            // Body: no shadow to set/reset -- just colour + fill.
            ctx.fillStyle=flash?`hsl(0,55%,${Math.round(41*(0.5+0.5*(1-i/Math.max(len,1))))+8}%)`:cols[i];
            if(_segPathBody){ ctx.translate(x,y); ctx.fill(_segPathBody); ctx.translate(-x,-y); }
            else { rr(x,y,sw,sh,3); ctx.fill(); }
            return;
        }
        // Head (glow set + reset only here, once per frame).
        // _powerMode is a property of the ROUND, not of one snake: in a duel the pellet
        // arms both players (both crush bars, both can bite), so both wear the Pac head.
        // The old segs===snake test only ever matched the single-player global, so a
        // powered duel showed no power at all.
        if(_powerMode && !flash){
            drawPacHead(x, y, squeue.length>0?squeue[0]:sdir);
            return;
        }
        const gw=j?j[2]:0, gh=j?j[3]:0;   // squashed flat against whatever it hit
        ctx.fillStyle=flash?'#bb2222':sc.head;
        if(!flash){ctx.shadowColor=sc.head;ctx.shadowBlur=10;}
        if(_segPathHead && !gw && !gh){ ctx.translate(x,y); ctx.fill(_segPathHead); ctx.translate(-x,-y); }
        else { rr(x-gw/2,y-gh/2,sw+gw,sh+gh,5); ctx.fill(); }
        if(!flash){
            ctx.shadowBlur=0;
            const eyeDir=squeue.length>0?squeue[0]:sdir;
            const lid=_eyeLid(segs, eyeDir, pi, performance.now());
            const drop=Math.round(lid*2), eh=3-drop;   // the lid comes DOWN: a shut eye is a slit where the bottom of the eye was
            ctx.fillStyle='#001500'; eyeOffsets(eyeDir).forEach(([ox,oy])=>ctx.fillRect(x+ox,y+oy+drop,3,eh));
            if(squeue.length>0&&(squeue[0].x!==sdir.x||squeue[0].y!==sdir.y)){
                const qd=squeue[0];
                const mx=Math.round(x+sw/2+qd.x*(sw/2-3)), my=Math.round(y+sh/2+qd.y*(sh/2-3));
                ctx.save(); ctx.globalAlpha=0.75; ctx.fillStyle='#aaffaa';
                ctx.shadowColor='#7fff7f'; ctx.shadowBlur=5;
                ctx.fillRect(mx-1,my-1,3,3); ctx.restore();
            }
            if(si.goldchain) drawAccessoryGoldchain(x,y,eyeDir);
            if(si.necktie)   drawAccessoryNecktie(x,y,eyeDir);
            if(si.bow)       drawAccessoryBow(x,y,eyeDir);
            if(si.shades)    drawAccessoryShades(x,y,eyeDir);
            if(si.glasses3d) drawAccessoryGlasses3d(x,y,eyeDir);
            if(si.lasereyes) drawAccessoryLasereyes(x,y,eyeDir);
            if(si.monocle)   drawAccessoryMonocle(x,y,eyeDir);
            if(si.eyepatch)  drawAccessoryEyepatch(x,y,eyeDir);
            if(si.moustache) drawAccessoryMoustache(x,y,eyeDir);
            if(si.cylinder)  drawAccessoryCylinder(x,y);
            if(si.propeller) drawAccessoryPropeller(x,y);
            if(si.wizard)    drawAccessoryWizard(x,y);
            if(si.crown)     drawAccessoryCrown(x,y);
            if(si.admincrown)drawAccessoryAdmincrown(x,y);
            if(si.halo)      drawAccessoryHalo(x,y);
        }
    });
    if(flash) return;
    // Black belt wraps a mid-body segment (the snake's "waist")
    if(si.blackbelt && segs.length>=3){
        const bi=Math.floor(segs.length/2), b=segs[bi], jb=jolt?jolt(bi):null;
        drawAccessoryBlackbelt(b.x*CS+1+(jb?jb[0]:0), b.y*CS+1+(jb?jb[1]:0));
    }
    // Shoes ride the tail segment
    if(si.shoes && segs.length>0){
        const ti=segs.length-1, t=segs[ti], jt=jolt?jolt(ti):null;
        const x=t.x*CS+1+(jt?jt[0]:0), y=t.y*CS+1+(jt?jt[1]:0);
        ctx.fillStyle='#eeeeee'; ctx.fillRect(x+2,y+CS-7,5,3); ctx.fillRect(x+CS-8,y+CS-7,5,3);
        ctx.fillStyle='#cc2222'; ctx.fillRect(x+2,y+CS-5,5,1); ctx.fillRect(x+CS-8,y+CS-5,5,1);
        ctx.fillStyle='#333333'; ctx.fillRect(x+1,y+CS-4,6,2); ctx.fillRect(x+CS-9,y+CS-4,6,2);
    }
    // Invisible gown: only reveals a traveling shimmer, and only while its wearer earns it
    if(si.gown && shimmer){
        const L=segs.length, now=performance.now();
        for(let i=0;i<L;i++){
            const wv=Math.sin(i*0.6-now/160);
            if(wv>0.75){
                const s=segs[i], x=s.x*CS+1, y=s.y*CS+1;
                ctx.save(); ctx.globalAlpha=(wv-0.75)/0.25*0.6; ctx.fillStyle='#ffffff';
                rr(x,y,CS-2,CS-2,i===0?5:3); ctx.fill(); ctx.restore();
            }
        }
    }
}
// Classic single-player wrapper: the globals, and the record-chase gown condition.
function drawSnake(flash, now) {
    drawSnakeG(snake, dir, dirQueue, cfg.snakeColor||0, cfg.wornItems||{}, flash,
               phase==='playing' && score>=_shimmerThreshold,
               now===undefined?null:_crashJolt(-1, now), -1);
}


// ================================================================
// ENTITY + OVERLAY DRAWS  (board pickups, ach popups, snake miniatures)
// ================================================================
function drawScoreHead(cx, cy, colorIdx, si) {
    const sc = SNAKE_COLORS[colorIdx || 0];
    ctx.save();
    ctx.translate(cx - Math.round(CS/2), cy - Math.round(CS/2));
    // Head body
    ctx.fillStyle = sc.head;
    ctx.shadowColor = sc.head; ctx.shadowBlur = 3;
    rr(1, 1, CS-2, CS-2, 5); ctx.fill(); ctx.shadowBlur = 0;
    // Eyes fixed facing right (dir irrelevant in scores screen)
    ctx.fillStyle = '#001500';
    ctx.fillRect(13, 2, 3, 3); ctx.fillRect(13, 16, 3, 3);
    // Accessories (back-to-front; shades/monocle inlined to avoid global dir dependency)
    if(si) {
        if(si.goldchain)drawAccessoryGoldchain(0, 0);
        if(si.bow)     drawAccessoryBow(0, 0);
        if(si.necktie) drawAccessoryNecktie(0, 0);
        if(si.shades)  { ctx.fillStyle='#111'; [3.5,17.5].forEach(ey=>{ctx.beginPath();ctx.arc(14.5,ey,4,0,Math.PI*2);ctx.fill();}); }
        if(si.glasses3d){ [['#ff2a2a',3.5],['#22e0ff',17.5]].forEach(([c,ey])=>{ctx.fillStyle='#111';ctx.beginPath();ctx.arc(14.5,ey,4,0,Math.PI*2);ctx.fill();ctx.fillStyle=c;ctx.beginPath();ctx.arc(14.5,ey,2.6,0,Math.PI*2);ctx.fill();}); }
        if(si.lasereyes){ ctx.save(); ctx.shadowColor='#ff2020'; ctx.shadowBlur=6; ctx.fillStyle='#ff3030';
            [3.5,17.5].forEach(ey=>{ctx.beginPath();ctx.arc(14.5,ey,2.2,0,Math.PI*2);ctx.fill();
            ctx.strokeStyle='rgba(255,40,40,0.85)';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(14.5,ey);ctx.lineTo(25,ey);ctx.stroke();}); ctx.restore(); }
        if(si.monocle) { ctx.strokeStyle='#ccc'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.arc(14.5,3.5,3.5,0,Math.PI*2); ctx.stroke(); }
        if(si.eyepatch){ ctx.fillStyle='#0a0a0a'; ctx.beginPath(); ctx.ellipse(14.5,3.5,3.4,3,0,0,Math.PI*2); ctx.fill(); }
        if(si.propeller)drawAccessoryPropeller(0, 0);
        if(si.wizard)   drawAccessoryWizard(0, 0);
        if(si.cylinder) drawAccessoryCylinder(0, 0);
        if(si.crown)    drawAccessoryCrown(0, 0);
        if(si.admincrown)drawAccessoryAdmincrown(0, 0);
        if(si.halo)     drawAccessoryHalo(0, 0);
    }
    ctx.restore();
}

// Compact device-category glyph (pc/mobile/tv/console) for the global score rows and the
// duel ready splash. Built from a uniform coarse pixel grid -- the same blocky convention
// as HEART_PX and drawPixelIcon(cs=2) -- so the badges read as game sprites instead of thin
// vector glyphs. '#' paints in `color`, 'o' is the dark screen/inset, '.' is empty. CENTRED
// on (cx,cy); no glow. An unknown/absent platform draws nothing (the server nulls bad tags).
const _PLAT_PX = {
    pc: ['#######',        // CRT monitor on a stand + base
         '#ooooo#',
         '#ooooo#',
         '#ooooo#',
         '#######',
         '..###..',
         '.#####.'],
    tv: ['#######',        // widescreen on two splayed legs
         '#ooooo#',
         '#ooooo#',
         '#ooooo#',
         '#######',
         '.#...#.'],
    mobile: ['#####',      // upright phone with a home button
             '#ooo#',
             '#ooo#',
             '#ooo#',
             '#ooo#',
             '##o##'],
    console: ['.#####.',   // gamepad: two control dots + two grips
              '#o###o#',
              '#######',
              '##...##'],
};
function drawPlatformIcon(cx, cy, plat, color) {
    const grid = _PLAT_PX[plat]; if(!grid) return;
    const col = color || '#9fb4c4', ink = '#0b1622';   // ink = the dark screen/inset
    const s = 2, cols = grid[0].length, rows = grid.length;
    const ox = Math.round(cx - cols*s/2), oy = Math.round(cy - rows*s/2);
    ctx.save();
    for(let ry=0; ry<rows; ry++){
        const line = grid[ry];
        for(let rx=0; rx<cols; rx++){
            const ch = line[rx];
            if(ch === '.') continue;
            ctx.fillStyle = ch === '#' ? col : ink;
            ctx.fillRect(ox+rx*s, oy+ry*s, s, s);
        }
    }
    ctx.restore();
}

function drawAchPopups(now) {
    confetti=confetti.filter(c=>{
        c.life++;
        if(!_simpleGfx()){ c.x+=c.vx; c.y+=c.vy; c.vy+=0.05; c.rot+=c.vrot; }   // SIMPLE: hold the scatter static, no per-frame physics
        if(c.life>=c.maxLife||c.y>CH+20) return false;
        const a=c.life<15?c.life/15:c.life>c.maxLife-25?1-(c.life-(c.maxLife-25))/25:1;
        ctx.save(); ctx.globalAlpha=a; ctx.translate(c.x,c.y); ctx.rotate(c.rot);
        ctx.fillStyle=c.color; ctx.fillRect(-c.w/2,-c.h/2,c.w,c.h);
        ctx.restore(); return true;
    });
    const DUR=3800, FADE_IN=280, FADE_OUT=500;
    achPopups=achPopups.filter(p=>now-p.at<DUR);
    achPopups.forEach((p,i)=>{
        const a=ACHIEVEMENTS.find(ac=>ac.id===p.id)||EXPERT_ACHIEVEMENTS.find(ac=>ac.id===p.id)||EGG_ACHIEVEMENTS.find(ac=>ac.id===p.id); if(!a) return;
        const age=now-p.at;
        const alpha=Math.min(1,age/FADE_IN)*(age>DUR-FADE_OUT?Math.max(0,1-(age-(DUR-FADE_OUT))/FADE_OUT):1);
        const slide=Math.max(0,(1-age/FADE_IN)*70);
        const pw=170,ph=44,px=CW-pw-4+slide,py=8+i*(ph+4);
        ctx.save(); ctx.globalAlpha=alpha;
        ctx.fillStyle='#071407'; rr(px,py,pw,ph,5); ctx.fill();
        ctx.strokeStyle='#4aaa4a'; ctx.lineWidth=1.5; rr(px,py,pw,ph,5); ctx.stroke();
        ctx.shadowColor='#7fff7f'; ctx.shadowBlur=6;
        ctx.fillStyle='#7fff7f'; ctx.font=`${FONT.HINT}px "Press Start 2P"`;
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.fillText('ACHIEVEMENT!',px+28,py+7);
        ctx.shadowBlur=0;
        ctx.fillStyle='#aaffaa'; ctx.font=`${FONT.HINT}px "Press Start 2P"`;
        ctx.fillText(a.name,px+28,py+20);
        ctx.fillStyle='#ffd700'; ctx.font=`${FONT.HINT}px "Press Start 2P"`;
        ctx.fillText('+1,000 FK',px+28,py+31);
        drawPixelIcon(px+5,py+ph/2-8,a.icon,2);
        ctx.restore();
    });
    ctx.textAlign='center'; ctx.textBaseline='middle';
}

// Shop tabs: 0,1 = cosmetics; 2 = BOX GEAR (box-won cosmetics, wearable); 3 = mystery boxes.
const SHOP_PAGES = 4, GEAR_PAGE = 2, BOX_PAGE = 3;
function _drawGourangaPending(now) {
    for(let i=0;i<_gourangaLine.length;i++){
        if(_gourangaEaten.has(i)) continue;
        const g=_gourangaLine[i], gx=g.x*CS+CS/2, gy=g.y*CS+CS/2, r=CS/2-3;
        ctx.save(); ctx.translate(gx,gy);
        ctx.shadowColor='#ff8800'; ctx.shadowBlur=8; ctx.fillStyle='#ff8800';
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.65,0); ctx.lineTo(0,r); ctx.lineTo(-r*0.65,0); ctx.closePath(); ctx.fill();
        ctx.restore();
    }
}
// Same HEART_PX pixel art the HUD and README use, so every 1UP on the field matches them
// exactly. Square pixels preserve the art's native 7x6 ratio (no stretch); the pulse scales
// it whole. `span` is the target width in px; callers pick full-cell or a small badge.
function _paintHeartPx(cx, cy, span, since, now) {
    const pulse=_simpleGfx()?1:0.9+0.1*Math.sin((now-since)/220);
    const cols=HEART_PX[0].length, rows=HEART_PX.length;
    const px=span/cols, w=px*cols, h=px*rows;
    ctx.save();
    ctx.translate(cx,cy); ctx.scale(pulse,pulse); ctx.translate(-w/2,-h/2);
    ctx.shadowColor='#ff4499'; ctx.shadowBlur=_simpleGfx()?0:10; ctx.fillStyle='#ff2266';
    HEART_PX.forEach((row,ry)=>row.forEach((v,rx)=>{ if(v) ctx.fillRect(rx*px,ry*px,px+0.4,px+0.4); }));
    ctx.restore();
}
// The contested centre heart: full-cell 1UP art at the heart's own cell.
function _drawHeart(now) {
    if(heartIsEarly&&now-heartAt>8500&&Math.floor(now/180)%2===0&&!_simpleGfx()) return;   // the expiry blink is an animation
    _paintHeartPx(heart.x*CS+CS/2, heart.y*CS+CS/2, CS*0.84, heartAt, now);
}
// A small heart badge riding the finisher gem's upper-right on a dark disc. The gem still reads
// as a gem (drawn underneath by drawGem) but is clearly MARKED as the one that gives a heart
// back -- an overlay, not a replacement.
function _drawGemHeartMark(now) {
    const cx=gem.x*CS+CS*0.74, cy=gem.y*CS+CS*0.28, r=CS*0.30;
    ctx.save();
    ctx.fillStyle='rgba(8,5,12,0.72)'; ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
    ctx.restore();
    _paintHeartPx(cx, cy, CS*0.48, gemAt, now);
}
// The level-finisher gem (the one that pushes gemsDone to GEMS_PER_LEVEL) hands its eater a
// heart back, but only if that eater is still under the 3-heart cap. Mark it only when that
// heart-back would actually apply to the viewer: online, that is our own snake; on a shared
// hotseat screen, it is real as long as EITHER player can still gain it. Duel-only.
function _gemIsFinisherHeart() {
    if(!players || gemsDone !== GEMS_PER_LEVEL-1) return false;
    if(typeof netGameActive==='function' && netGameActive()){
        const me=(typeof netMyIndex==='function') ? netMyIndex() : 0;
        return !!(players[me] && players[me].lives < _duelHeartsMax);
    }
    return players.some(p=>p.lives < _duelHeartsMax);
}
// The segments a powered self-bite knocked off, in the colour of the snake that lost them.
// Rides the SAME particle list a crushed bar uses, so it fades and clears with everything
// else; only the hue and the lighter, slower scatter say it was flesh and not masonry.
// The hue comes from the one duel-pair accessor, so the burst can never come out in the
// other snake's colour; single player has no pair and reads the configured one.
function _biteBurst(x, y, p) {
    const hue = players ? _wsOwnerHue(p) : SNAKE_COLORS[cfg.snakeColor||0].h;
    return { x, y, at:simNow, pts:Array.from({length:14},()=>({
        ang:Math.random()*Math.PI*2, spd:2+Math.random()*7, sz:2+Math.random()*3,
        col:'hsl('+hue+',75%,'+Math.round(45+Math.random()*30)+'%)' })) };
}
function _drawCrushEffects(now) {
    _crushEffects=_crushEffects.filter(e=>{
        const age=now-e.at, dur=600;
        if(age>=dur) return false;
        const t=age/dur, cx=e.x*CS+CS/2, cy=e.y*CS+CS/2;
        if(age<110){
            ctx.save(); ctx.globalAlpha=(1-age/110)*0.85;
            ctx.fillStyle='#ffaa44'; ctx.fillRect(e.x*CS,e.y*CS,CS,CS);
            ctx.restore();
        }
        e.pts.forEach(p=>{
            const px=cx+Math.cos(p.ang)*p.spd*t*22;
            const py=cy+Math.sin(p.ang)*p.spd*t*22+220*t*t;
            ctx.globalAlpha=(1-t)*0.92; ctx.fillStyle=p.col;
            const s=p.sz*(1-t*0.45);
            ctx.fillRect(px-s/2,py-s/2,s,s);
        });
        ctx.globalAlpha=1; return true;
    });
}
function _drawPowerPellet(now) {
    const pulse=_simpleGfx()?1:0.85+0.15*Math.sin((now-powerPelletAt)/220);
    const cx=powerPellet.x*CS+CS/2, cy=powerPellet.y*CS+CS/2;
    const w=(CS-3)*pulse, h=(CS*0.56)*pulse, r=h/2;    // capsule (stadium): rounded ends
    const hue=_simpleGfx()?0:(now/7)%360;
    ctx.save();
    ctx.translate(cx,cy); ctx.rotate(-0.5);            // tilt so it reads as a pill, not a blob
    ctx.shadowColor=`hsl(${hue},100%,70%)`; ctx.shadowBlur=14;
    rr(-w/2,-h/2,w,h,r); ctx.save(); ctx.clip();       // two-tone halves clipped to the capsule
    ctx.fillStyle='#ffffff';              ctx.fillRect(-w/2,-h/2,w/2,h);
    ctx.fillStyle=`hsl(${hue},100%,66%)`; ctx.fillRect(0,-h/2,w/2+0.5,h);
    ctx.restore();
    ctx.shadowBlur=0;
    ctx.strokeStyle='rgba(0,0,0,0.30)'; ctx.lineWidth=1;                    // centre seam
    ctx.beginPath(); ctx.moveTo(0,-h/2+1); ctx.lineTo(0,h/2-1); ctx.stroke();
    ctx.strokeStyle=`hsl(${hue},90%,45%)`; rr(-w/2,-h/2,w,h,r); ctx.stroke(); // rim
    ctx.globalAlpha=0.5; ctx.fillStyle='#fff';                             // shine
    ctx.beginPath(); ctx.ellipse(-w*0.2,-h*0.22,w*0.16,h*0.16,-0.4,0,Math.PI*2); ctx.fill();
    ctx.restore();
}
function _drawTimeCrystal(now) {
    const cx=timeCrystal.x*CS+CS/2, cy=timeCrystal.y*CS+CS/2, t=_simpleGfx()?0:(now-timeCrystalAt)/1000;
    const r=(CS/2-2)*(1+0.12*Math.sin(t*4));
    ctx.save(); ctx.translate(cx,cy);
    const grd=ctx.createRadialGradient(0,0,0,0,0,r*2.4);
    grd.addColorStop(0,'rgba(120,220,255,0.30)'); grd.addColorStop(1,'rgba(120,220,255,0)');
    ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(0,0,r*2.4,0,Math.PI*2); ctx.fill();
    ctx.shadowColor='#88e0ff'; ctx.shadowBlur=14;
    const fg=ctx.createLinearGradient(0,-r,0,r);
    fg.addColorStop(0,'#ffffff'); fg.addColorStop(0.4,'#88ddff'); fg.addColorStop(1,'#3388cc');
    ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.7,0); ctx.lineTo(0,r); ctx.lineTo(-r*0.7,0); ctx.closePath();
    ctx.fillStyle=fg; ctx.fill(); ctx.shadowBlur=0;
    // Sweeping clock hand (one turn per 2s)
    const a=-Math.PI/2+((t%2)/2)*Math.PI*2;
    ctx.strokeStyle='rgba(20,40,70,0.85)'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*r*0.5,Math.sin(a)*r*0.5); ctx.stroke();
    ctx.fillStyle='#12345a'; ctx.beginPath(); ctx.arc(0,0,1.4,0,Math.PI*2); ctx.fill();
    ctx.restore();
}
// ================================================================
// PRESENTATION FED BY GAME EVENTS  (pixel icons, confetti, bonus text, fireworks)
// ================================================================
function drawPixelIcon(x, y, icon, cs) {
    icon.d.forEach((row, ry) => {
        let rx = 0;
        for (const c of row) {
            if(c !== '.' && icon.p[c]){
                ctx.fillStyle = icon.p[c];
                ctx.fillRect(Math.round(x+rx*cs), Math.round(y+ry*cs), Math.ceil(cs), Math.ceil(cs));
            }
            rx++;
        }
    });
}

let confetti = [];

function spawnConfetti() {
    if(_simpleGfx()){
        // SIMPLE graphics: no animated particle burst (60 falling/spinning pieces updated every
        // frame). A cheap STATIC scatter instead -- a dozen motionless pieces spread over the
        // board that just hold and fade (the draw loop skips the per-frame physics for them).
        for(let i=0;i<14;i++){
            confetti.push({ x: CW*0.15+Math.random()*CW*0.7, y: CH*0.12+Math.random()*CH*0.4,
                vx:0, vy:0, rot:(i%4)*0.5, vrot:0, w:6, h:4,
                color: CONFETTI_COLS[i%CONFETTI_COLS.length], life:0, maxLife:70 });
        }
        return;
    }
    for(let i=0;i<60;i++){
        confetti.push({
            x: CW*0.65+Math.random()*CW*0.35,
            y: -6-Math.random()*30,
            vx: -0.5-Math.random()*2.5,
            vy: 1.2+Math.random()*2.8,
            rot: Math.random()*Math.PI*2,
            vrot: (Math.random()-0.5)*0.18,
            w: 5+Math.random()*6, h: 3+Math.random()*4,
            color: CONFETTI_COLS[i%CONFETTI_COLS.length],
            life:0, maxLife:100+Math.floor(Math.random()*80),
        });
    }
}

let bonusAt = -9999, bonusLabel = '';
function showBonus(now, label) { bonusAt = now; bonusLabel = label; }

function spawnFireworks(now) {
    for (let b = 0; b < 8; b++) {
        const delay = b * 310 + Math.random() * 80;
        const x = 55 + Math.random() * (CW - 110);
        const y = 22 + Math.random() * (CH * 0.62);
        const col = FIREWORK_COLS[b % FIREWORK_COLS.length];
        for (let i = 0; i < 22; i++) {
            const angle = (i / 22) * Math.PI * 2;
            const spd = 1.7 + Math.random() * 2.4;
            fireworks.push({
                startAt: now + delay,
                x, y,
                vx: Math.cos(angle) * spd,
                vy: Math.sin(angle) * spd - 0.7,
                color: col,
                life: 0,
                maxLife: 52 + Math.floor(Math.random() * 38),
            });
        }
    }
}

// Presentation replays the sim's recorded side-effects. Called once per sim tick
// from loop(), right after update(); simNow is that tick's timestamp.
