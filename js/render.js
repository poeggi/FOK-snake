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
const _hudCL=document.getElementById('hud-c-l'), _hudDL=document.getElementById('hud-d-l');
const _hudGmax=document.getElementById('hv-gmax');
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
    const mode = players ? 'duel' : 'classic';
    const nms = (typeof netPlayerNames==='function') ? netPlayerNames() : null;   // online: real names
    const la = mode==='duel' ? ((nms?nms[0].slice(0,MAX_NAME):'P1')+' ') : 'LIVES ';   // MAX_NAME, not 10: a full-length name was losing its tail
    const lb = mode==='duel' ? ((nms?nms[1].slice(0,MAX_NAME):'P2')+' ') : 'SCORE ';
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
// Presentation-only, derived from the converged sim state -- it never touches sim/netcode,
// so each client shakes off its own copy and it can never desync. Suppressed under SIMPLE
// gfx or the REDUCE MOTION accessibility toggle (see _reduceMotion).
// ================================================================
let _nmClose=false, _shakeMag=0, _shakeAt=0;
const _NM_SHAKE=6, _NM_DECAY=280;   // px impulse, ms decay
function duelNearMiss(now){
    if(!players || phase!=='duel' || !players[0].alive || !players[1].alive){ _nmClose=false; return; }
    const a=players[0].snake[0], b=players[1].snake[0];
    const dx=Math.min((a.x-b.x+COLS)%COLS,(b.x-a.x+COLS)%COLS);   // wrapped (torus) gap per axis
    const dy=Math.min((a.y-b.y+ROWS)%ROWS,(b.y-a.y+ROWS)%ROWS);
    const close=Math.max(dx,dy)<=1;                                // Chebyshev <=1 == adjacent/overlapping
    if(close && !_nmClose){ _shakeMag=_NM_SHAKE; _shakeAt=now; }   // edge-trigger on ENTERING the danger zone
    _nmClose=close;
}
function shakeOffset(now){
    if(_simpleGfx()||_reduceMotion()||_shakeMag<=0) return null;
    const age=now-_shakeAt; if(age<0||age>=_NM_DECAY){ _shakeMag=0; return null; }
    const k=_shakeMag*(1-age/_NM_DECAY);                           // linear decay to zero
    return { x:Math.round(k*Math.sin(age*0.085)), y:Math.round(k*Math.cos(age*0.13)) };
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
function drawAccessoryGoldchain(hx, hy) {
    ctx.save(); ctx.shadowColor='#ffd700'; ctx.shadowBlur=5;
    ctx.strokeStyle='#ffd700'; ctx.lineWidth=1.6;
    ctx.beginPath(); ctx.moveTo(hx+2,hy+12); ctx.quadraticCurveTo(hx+9,hy+21,hx+16,hy+12); ctx.stroke();
    ctx.fillStyle='#fff2a0'; ctx.fillRect(hx+7,hy+16,4,4);          // pendant
    ctx.fillStyle='#b8860b'; ctx.fillRect(hx+8,hy+17,2,2);
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
function drawSnakeG(segs, sdir, squeue, colorIdx, si, flash, shimmer) {
    const sc=SNAKE_COLORS[colorIdx||0];
    const cols = flash ? null : _bodyCols(segs.length, sc.h);
    const sw=CS-2,sh=CS-2,len=segs.length;
    segs.forEach((seg,i)=>{
        const x=seg.x*CS+1,y=seg.y*CS+1;
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
        ctx.fillStyle=flash?'#bb2222':sc.head;
        if(!flash){ctx.shadowColor=sc.head;ctx.shadowBlur=10;}
        if(_segPathHead){ ctx.translate(x,y); ctx.fill(_segPathHead); ctx.translate(-x,-y); }
        else { rr(x,y,sw,sh,5); ctx.fill(); }
        if(!flash){
            ctx.shadowBlur=0;
            const eyeDir=squeue.length>0?squeue[0]:sdir;
            ctx.fillStyle='#001500'; eyeOffsets(eyeDir).forEach(([ox,oy])=>ctx.fillRect(x+ox,y+oy,3,3));
            if(squeue.length>0&&(squeue[0].x!==sdir.x||squeue[0].y!==sdir.y)){
                const qd=squeue[0];
                const mx=Math.round(x+sw/2+qd.x*(sw/2-3)), my=Math.round(y+sh/2+qd.y*(sh/2-3));
                ctx.save(); ctx.globalAlpha=0.75; ctx.fillStyle='#aaffaa';
                ctx.shadowColor='#7fff7f'; ctx.shadowBlur=5;
                ctx.fillRect(mx-1,my-1,3,3); ctx.restore();
            }
            if(si.goldchain) drawAccessoryGoldchain(x,y);
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
        const b=segs[Math.floor(segs.length/2)];
        drawAccessoryBlackbelt(b.x*CS+1, b.y*CS+1);
    }
    // Shoes ride the tail segment
    if(si.shoes && segs.length>0){
        const t=segs[segs.length-1], x=t.x*CS+1, y=t.y*CS+1;
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
function drawSnake(flash) {
    drawSnakeG(snake, dir, dirQueue, cfg.snakeColor||0, cfg.wornItems||{}, flash,
               phase==='playing' && score>=_shimmerThreshold);
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
        const a=ACHIEVEMENTS.find(ac=>ac.id===p.id)||EXPERT_ACHIEVEMENTS.find(ac=>ac.id===p.id); if(!a) return;
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
function _drawHeart(now) {
    if(heartIsEarly&&now-heartAt>8500&&Math.floor(now/180)%2===0&&!_simpleGfx()) return;   // the expiry blink is an animation
    const pulse=_simpleGfx()?1:0.85+0.15*Math.sin((now-heartAt)/220);
    const cx=heart.x*CS+CS/2, cy=heart.y*CS+CS/2;
    const s=pulse*(CS/2-2)/3.5;
    ctx.save(); ctx.translate(cx,cy); ctx.scale(s,s);
    ctx.shadowColor='#ff4499'; ctx.shadowBlur=10; ctx.fillStyle='#ff2266';
    ctx.beginPath();
    ctx.moveTo(0,1); ctx.bezierCurveTo(0,-1,-3.5,-4,-3.5,-2);
    ctx.bezierCurveTo(-3.5,0.5,0,3.5,0,3.5);
    ctx.bezierCurveTo(0,3.5,3.5,0.5,3.5,-2);
    ctx.bezierCurveTo(3.5,-4,0,-1,0,1);
    ctx.fill(); ctx.restore();
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
