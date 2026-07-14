// ============================================================================
// render.js -- all drawing: HUD, draw helpers + accessories, the snake, and every
// screen (menu / shop / boxes / settings / scores / achievements / credits / news /
// name-entry). Split out of game.js. Shares the global scope: loaded after game.js,
// which defines canvas/ctx/FONT and the game state these functions read at call time.
// ============================================================================
// ================================================================
// HUD
// ================================================================
const hudEl = document.getElementById('hud');
const _hudLvlEl=document.getElementById('hv-lvl');
const _hudGemsEl=document.getElementById('hv-gems');
const _hudScoreEl=document.getElementById('hv-score');
const _hudLivesCv=document.getElementById('hv-lives-cv');
const _hudLivesCtx=_hudLivesCv.getContext('2d');
let _hudCache={level:-1,gemsDone:-1,score:-1,lives:-1};
function showHUD(v) { hudEl.classList.toggle('hidden',!v); }
function updateHUD() {
    if(level!==_hudCache.level){       _hudLvlEl.textContent=level;      _hudCache.level=level; }
    if(gemsDone!==_hudCache.gemsDone){ _hudGemsEl.textContent=gemsDone;  _hudCache.gemsDone=gemsDone; }
    if(score!==_hudCache.score){       _hudScoreEl.textContent=score;    _hudCache.score=score; }
    if(lives!==_hudCache.lives){
        _hudCache.lives=lives;
        _hudLivesCv.width=lives*16;
        _hudLivesCtx.fillStyle='#7fff7f';
        for(let i=0;i<lives;i++){
            const ox=i*16;
            HEART_PX.forEach((row,ry)=>row.forEach((px,rx)=>{if(px)_hudLivesCtx.fillRect(ox+rx*2,ry*2,2,2);}));
        }
    }
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
// Main-menu static cache: everything except the animated splash text + unread badge.
// Rebuilt only when the visible static content changes (selection, version, diff line).
const _menuCanvas=document.createElement('canvas'); _menuCanvas.width=CW; _menuCanvas.height=CH;
const _menuCtx=_menuCanvas.getContext('2d');
let _mc={sel:-1,ver:'',diff:'',glow:null};
// Central glow control: intercept the shadowBlur setter once per context so that
// cfg.disableGlow forces it to 0 EVERYWHERE, with zero changes at the 80+ call sites.
function _glowGuard(c){
    const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c),'shadowBlur');
    if(!d||!d.set) return;   // stub context (headless tests) -- nothing to guard
    Object.defineProperty(c,'shadowBlur',{ configurable:true,
        get(){ return d.get.call(this); },
        set(v){ d.set.call(this, cfg.disableGlow ? 0 : v); } });
}
_glowGuard(ctx); _glowGuard(_menuCtx);
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
function ct(text,x,y,color,size,c=ctx) {
    c.fillStyle=color||'#7fff7f';
    c.font=`${size||FONT.HINT}px "Press Start 2P"`;
    c.textAlign='center'; c.textBaseline='middle'; c.fillText(text,x,y);
}
function menuItem(text,y,sel,c=ctx) {
    c.globalAlpha=sel?1:0.78;
    c.shadowColor=sel?'#7fff7f':'#cccccc'; c.shadowBlur=sel?12:1;
    ct(sel?('> '+text+' <'):text,CW/2,y,sel?'#7fff7f':'#cccccc',FONT.MENU,c);
    c.shadowBlur=0; c.globalAlpha=1;
}

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

function drawGem(g,now) {
    const cx=g.x*CS+CS/2, cy=g.y*CS+CS/2, t=(now-gemAt)/1000;
    const tier=g.tier||0;
    if(tier===2){
        // Epic gem: rainbow, sparkles, spawn burst
        const hue=(now/8)%360;
        const r=(CS/2-1)*(1+0.20*Math.sin(t*9));
        ctx.save(); ctx.translate(cx,cy); ctx.rotate(t*5);
        // Spawn burst rings (1.4s)
        const bAge=now-g.spawnAt;
        if(bAge<1400){
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

function drawAccessoryMonocle(hx, hy) {
    const e=eyeOffsets(dir)[0];
    ctx.strokeStyle='#cccccc'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.arc(hx+e[0]+1.5,hy+e[1]+1.5,3.5,0,Math.PI*2); ctx.stroke();
    ctx.strokeStyle='#888888'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(hx+e[0]+4,hy+e[1]+4); ctx.lineTo(hx+e[0]+8,hy+e[1]+9); ctx.stroke();
}

function drawAccessoryShades(hx, hy) {
    const eyes=eyeOffsets(dir);
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
function drawAccessoryEyepatch(hx, hy) {
    const e=eyeOffsets(dir)[0], cx=hx+e[0]+1.5, cy=hy+e[1]+1.5;
    ctx.strokeStyle='#0a0a0a'; ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.moveTo(hx-1,cy-4.5); ctx.lineTo(hx+19,cy+2.5); ctx.stroke();   // strap
    ctx.fillStyle='#0a0a0a';
    ctx.beginPath(); ctx.ellipse(cx,cy,3.4,3,0,0,Math.PI*2); ctx.fill();                // patch
    ctx.fillStyle='#2a2a2a'; ctx.fillRect(Math.round(cx-2),Math.round(cy-2),1,1);       // sheen
}
function drawAccessoryGlasses3d(hx, hy) {
    const eyes=eyeOffsets(dir), cols=['#ff2a2a','#22e0ff'];
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
function drawAccessoryLasereyes(hx, hy) {
    const eyes=eyeOffsets(dir);
    ctx.save(); ctx.shadowColor='#ff2020'; ctx.shadowBlur=8;
    eyes.forEach(([ox,oy])=>{
        const ex=hx+ox+1.5, ey=hy+oy+1.5;
        ctx.fillStyle='#ff3030'; ctx.beginPath(); ctx.arc(ex,ey,2.2,0,Math.PI*2); ctx.fill();
        ctx.strokeStyle='rgba(255,40,40,0.85)'; ctx.lineWidth=2;
        ctx.beginPath(); ctx.moveTo(ex,ey); ctx.lineTo(ex+dir.x*11,ey+dir.y*11); ctx.stroke();
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

function drawAccessoryMoustache(hx, hy) {
    const eyes=eyeOffsets(dir);
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
function drawSnake(flash) {
    const sc=SNAKE_COLORS[cfg.snakeColor||0];
    const si=cfg.wornItems||{};
    const cols = flash ? null : _bodyCols(snake.length, sc.h);
    const sw=CS-2,sh=CS-2,len=snake.length;
    snake.forEach((seg,i)=>{
        const x=seg.x*CS+1,y=seg.y*CS+1;
        if(i>0){
            // Body: no shadow to set/reset -- just colour + fill.
            ctx.fillStyle=flash?`hsl(0,55%,${Math.round(41*(0.5+0.5*(1-i/Math.max(len,1))))+8}%)`:cols[i];
            if(_segPathBody){ ctx.translate(x,y); ctx.fill(_segPathBody); ctx.translate(-x,-y); }
            else { rr(x,y,sw,sh,3); ctx.fill(); }
            return;
        }
        // Head (glow set + reset only here, once per frame).
        if(_powerMode && !flash){
            drawPacHead(x, y, dirQueue.length>0?dirQueue[0]:dir);
            return;
        }
        ctx.fillStyle=flash?'#bb2222':sc.head;
        if(!flash){ctx.shadowColor=sc.head;ctx.shadowBlur=10;}
        if(_segPathHead){ ctx.translate(x,y); ctx.fill(_segPathHead); ctx.translate(-x,-y); }
        else { rr(x,y,sw,sh,5); ctx.fill(); }
        if(!flash){
            ctx.shadowBlur=0;
            const eyeDir=dirQueue.length>0?dirQueue[0]:dir;
            ctx.fillStyle='#001500'; eyeOffsets(eyeDir).forEach(([ox,oy])=>ctx.fillRect(x+ox,y+oy,3,3));
            if(dirQueue.length>0&&(dirQueue[0].x!==dir.x||dirQueue[0].y!==dir.y)){
                const qd=dirQueue[0];
                const mx=Math.round(x+sw/2+qd.x*(sw/2-3)), my=Math.round(y+sh/2+qd.y*(sh/2-3));
                ctx.save(); ctx.globalAlpha=0.75; ctx.fillStyle='#aaffaa';
                ctx.shadowColor='#7fff7f'; ctx.shadowBlur=5;
                ctx.fillRect(mx-1,my-1,3,3); ctx.restore();
            }
            if(si.goldchain) drawAccessoryGoldchain(x,y);
            if(si.necktie)   drawAccessoryNecktie(x,y,eyeDir);
            if(si.bow)       drawAccessoryBow(x,y,eyeDir);
            if(si.shades)    drawAccessoryShades(x,y);
            if(si.glasses3d) drawAccessoryGlasses3d(x,y);
            if(si.lasereyes) drawAccessoryLasereyes(x,y);
            if(si.monocle)   drawAccessoryMonocle(x,y);
            if(si.eyepatch)  drawAccessoryEyepatch(x,y);
            if(si.moustache) drawAccessoryMoustache(x,y);
            if(si.cylinder)  drawAccessoryCylinder(x,y);
            if(si.propeller) drawAccessoryPropeller(x,y);
            if(si.wizard)    drawAccessoryWizard(x,y);
            if(si.crown)     drawAccessoryCrown(x,y);
            if(si.admincrown)drawAccessoryAdmincrown(x,y);
            if(si.halo)      drawAccessoryHalo(x,y);
        }
    });
    // Black belt wraps a mid-body segment (the snake's "waist")
    if(si.blackbelt && !flash && snake.length>=3){
        const b=snake[Math.floor(snake.length/2)];
        drawAccessoryBlackbelt(b.x*CS+1, b.y*CS+1);
    }
    // Shoes ride the tail segment
    if(si.shoes && !flash && snake.length>0){
        const t=snake[snake.length-1], x=t.x*CS+1, y=t.y*CS+1;
        ctx.fillStyle='#eeeeee'; ctx.fillRect(x+2,y+CS-7,5,3); ctx.fillRect(x+CS-8,y+CS-7,5,3);
        ctx.fillStyle='#cc2222'; ctx.fillRect(x+2,y+CS-5,5,1); ctx.fillRect(x+CS-8,y+CS-5,5,1);
        ctx.fillStyle='#333333'; ctx.fillRect(x+1,y+CS-4,6,2); ctx.fillRect(x+CS-9,y+CS-4,6,2);
    }
    // Invisible gown: only reveals a traveling shimmer while you are outscoring the record
    if(si.gown && !flash && phase==='playing' && score>=_shimmerThreshold){
        const L=snake.length, now=performance.now();
        for(let i=0;i<L;i++){
            const wv=Math.sin(i*0.6-now/160);
            if(wv>0.75){
                const s=snake[i], x=s.x*CS+1, y=s.y*CS+1;
                ctx.save(); ctx.globalAlpha=(wv-0.75)/0.25*0.6; ctx.fillStyle='#ffffff';
                rr(x,y,CS-2,CS-2,i===0?5:3); ctx.fill(); ctx.restore();
            }
        }
    }
}

// ================================================================
// SCREEN RENDERING  (menu / shop / boxes / settings / scores / achievements / credits / news / name-entry)
// ================================================================
function drawSplash(now) {
    // Cycle geometry constants
    const DARK_LEAD = 1.0, DROP = 1.5, ENTER = 0.4, DARK_TAIL = 0.1;
    const CYCLE = DARK_LEAD + DROP + ENTER + 1.0 + DARK_TAIL;
    const T_DROP  = DARK_LEAD;
    const T_ENTER = DARK_LEAD + DROP;
    const T_DONE  = DARK_LEAD + DROP + ENTER;
    const coinX = CW/2, slotY = 292, startY = 162;

    // Background matches menu: grid + scan line overlay
    drawGrid();
    ctx.drawImage(_scanCanvas, 0, 0);

    // Title block: identical to drawMenu
    ctx.shadowColor = '#7fff7f'; ctx.shadowBlur = 38;
    ct('S N A K E', CW/2, 78, '#7fff7f', FONT.DISPLAY);
    ctx.shadowBlur = 0;
    ctx.shadowColor='#4a7a4a'; ctx.shadowBlur=1; ct('F O K   E D I T I O N', CW/2, 122, '#4a7a4a', FONT.HINT); ctx.shadowBlur=0;

    // Per-frame coin/spark state
    let showCoin = false, coinY = startY, scaleX = 1, spinAngle = 0;
    let slotFlashF = 0, coinClipped = false;
    let t = 0; // only valid when !_splashExiting; used for INSERT COIN blink

    if (_splashExiting) {
        const exitMs = now - _splashExitAt;
        // Coin snaps into slot over 80ms then disappears below clip rect
        if (exitMs < 80) {
            showCoin = true;
            coinY = (slotY - 14) + 28 * (exitMs / 80);
            scaleX = 1; spinAngle = 0; coinClipped = true;
        }
        // Sparks: fire at 40ms, fade over 420ms
        if (exitMs >= 40) slotFlashF = Math.max(0, 1 - (exitMs - 40) / 420);
    } else {
        const elapsed = _splashFast
            ? _splashFastBase + (now - _splashFastStart) / 1000 * 2
            : (now - phaseAt) / 1000;
        t = elapsed % CYCLE;
        const dropT = t - T_DROP;
        const dropProgress = Math.min(Math.max(dropT, 0), DROP) / DROP;
        spinAngle = dropProgress * 1.5 * Math.PI * 2;
        scaleX = Math.max(0.08, Math.abs(Math.cos(spinAngle)));
        if (t >= T_DROP && t < T_DONE) {
            showCoin = true;
            if (dropT < DROP) {
                const p = dropT / DROP;
                coinY = startY + (slotY - startY - 14) * p * p * p * p * p;
            } else {
                const p = (dropT - DROP) / ENTER;
                coinY = (slotY - 14) + 28 * p;
            }
        }
        slotFlashF = (t >= T_ENTER && t < T_ENTER + 0.4) ? 1 - (t - T_ENTER) / 0.4 : 0;
        coinClipped = t >= T_ENTER;
    }

    // Slot housing always drawn
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(coinX - 32, slotY - 9, 64, 18);
    ctx.fillStyle = '#2a2a2a'; ctx.fillRect(coinX - 26, slotY - 6, 52, 12);
    ctx.fillStyle = '#111'; ctx.fillRect(coinX - 16, slotY - 2, 32, 4);

    // Pixelated sparks burst from slot when coin enters
    // spark speed (spd) >= 90 renders bright white; slower sparks render gold
    if (slotFlashF > 0) {
        const sparkDefs = [
            [-0.55,-1,72,1],    [0,-1,80,1],       [0.55,-1,72,1],
            [-1.1,-0.85,58,1],  [1.1,-0.85,58,1],
            [-0.25,-1,95,1],    [0.25,-1,95,1],
            [-1.4,-0.45,44,1],  [1.4,-0.45,44,1],
            [-0.8,-0.65,65,1],  [0.8,-0.65,65,1],
            [0,-0.75,108,1],
            [-0.4,-0.9,118,0.7],[0.4,-0.9,118,0.7],
            [-1.6,-0.2,38,0.8], [1.6,-0.2,38,0.8],
            [-0.15,-1,135,0.5], [0.15,-1,135,0.5],
            [-1.0,-1.0,50,0.9], [1.0,-1.0,50,0.9],
            [-0.7,-0.3,30,0.7], [0.7,-0.3,30,0.7],
            [-0.75,-0.75,62,1], [0.75,-0.75,62,1],
            [-1.2,-0.5,48,0.9], [1.2,-0.5,48,0.9],
            [-0.35,-0.95,85,1], [0.35,-0.95,85,1],
            [-1.8,0.1,33,0.8],  [1.8,0.1,33,0.8],
            [-1.3,-0.15,40,0.8],[1.3,-0.15,40,0.8],
            [-0.6,-0.5,55,0.9], [0.6,-0.5,55,0.9],
            [-0.1,-1,148,0.4],  [0.1,-1,148,0.4],
            [0,-1,125,0.6],
            [-0.5,-0.85,102,0.7],[0.5,-0.85,102,0.7],
            [-0.2,-0.98,92,0.8], [0.2,-0.98,92,0.8],
        ];
        const sparkCols  = ['#ffd700','#ffcc00','#ffff66','#ff9900','#fff5a0','#ffaa00'];
        const sparkBright = ['#ffffff','#ffffd0','#ffffe8'];
        const grav = 55, sp = 1 - slotFlashF;
        ctx.save();
        sparkDefs.forEach(([dx,dy,spd,fade],i) => {
            const sx = coinX + dx*spd*sp;
            const sy = slotY  + dy*spd*sp + grav*sp*sp;
            ctx.globalAlpha = Math.pow(slotFlashF, fade);
            ctx.fillStyle = spd>=90 ? sparkBright[i%sparkBright.length] : sparkCols[i%sparkCols.length];
            ctx.fillRect(Math.round(sx/2)*2, Math.round(sy/2)*2, 2, 2);
        });
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    if (showCoin) {
        ctx.save();
        if (coinClipped) { ctx.beginPath(); ctx.rect(0, 0, CW, slotY); ctx.clip(); }
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath(); ctx.ellipse(coinX+2, coinY+4, 14*scaleX, 4, 0, 0, Math.PI*2); ctx.fill();
        ctx.translate(coinX, coinY);
        ctx.scale(scaleX, 1);
        ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI*2);
        ctx.fillStyle = '#FFD000'; ctx.fill();
        ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI*2);
        ctx.fillStyle = '#1C0600'; ctx.fill();
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 11);
        grad.addColorStop(0,   '#FFE870');
        grad.addColorStop(0.5, '#FFB800');
        grad.addColorStop(1,   '#A06000');
        ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI*2);
        ctx.fillStyle = grad; ctx.fill();
        const sym = Math.cos(spinAngle) >= 0 ? SYM_ONE : SYM_YEN;
        ctx.fillStyle = '#1C0600';
        sym.px.forEach(([ix,iy]) => ctx.fillRect(ix*2 - sym.w, iy*2 - sym.h, 2, 2));
        ctx.restore();
    }

    // INSERT COIN blink and bottom hint: suppressed during exit sequence
    if (!_splashExiting) {
        if (Math.floor(t) % 2 === 1) {
            ctx.shadowColor = '#ffff00'; ctx.shadowBlur = 12;
            ct('INSERT COIN', CW/2, 344, '#ffff00', FONT.MENU);
            ctx.shadowBlur = 0;
        }
        ctx.save();
        ctx.font = `${FONT.HINT}px "Press Start 2P"`; ctx.textBaseline = 'bottom'; ctx.textAlign = 'center';
        ctx.fillStyle = '#888';
        ctx.fillText('ENTER:go  TAP:go  CLICK:go', CW/2, CH - 8);
        ctx.restore();
    }
}

const _NP_W=30, _NP_H=26, _NP_X=CW-30-20, _NP_Y=CH-26-30;   // newspaper icon rect
// Static newspaper (icon + NEWS label) drawn into the menu cache. No badge here.
function _drawNewspaper(c, sel) {
    const w=_NP_W, h=_NP_H, x=_NP_X, y=_NP_Y;
    c.save();
    if(sel){ c.shadowColor='#ffe08a'; c.shadowBlur=14; }
    c.fillStyle=sel?'#fff8e0':'#d8d2c0'; c.fillRect(x,y,w,h);       // paper
    c.shadowBlur=0;
    c.fillStyle=sel?'#e8dcb0':'#b8b298'; c.fillRect(x+w-4,y+2,4,h-2); // folded edge
    c.fillStyle='#2a2a2a'; c.fillRect(x+3,y+3,w-9,4);               // masthead
    c.fillStyle=sel?'#555':'#777';
    for(let i=0;i<4;i++) c.fillRect(x+3,y+10+i*4,w-16,2);          // text lines
    c.fillStyle=sel?'#888':'#999'; c.fillRect(x+w-11,y+10,8,8);   // photo box
    c.restore();
    c.save();
    c.globalAlpha=sel?1:0.78; c.shadowColor=sel?'#7fff7f':'#cccccc'; c.shadowBlur=sel?12:1;
    c.font=`${FONT.MENU}px "Press Start 2P"`; c.textAlign='right'; c.textBaseline='bottom';
    c.fillStyle=sel?'#7fff7f':'#cccccc'; c.fillText('NEWS', CW-10, CH-8);
    c.restore();
}
// Animated unread badge -- drawn on the live canvas each frame (overlay).
function _drawNewspaperBadge(now, unread) {
    if(!unread) return;
    ctx.save(); ctx.fillStyle='#ff3355'; ctx.shadowColor='#ff3355'; ctx.shadowBlur=8;
    ctx.beginPath(); ctx.arc(_NP_X+_NP_W-2,_NP_Y+1,3.5+Math.sin(now/220),0,Math.PI*2); ctx.fill(); ctx.restore();
}
function _drawNewspaperPage(now) {
    const pw=CW-64, ph=CH-64, px=(CW-pw)/2, py=(CH-ph)/2, cx=CW/2;
    ctx.fillStyle='#e8e2d0'; ctx.fillRect(px,py,pw,ph);              // paper
    ctx.strokeStyle='#2a2a1e'; ctx.lineWidth=2; ctx.strokeRect(px+3,py+3,pw-6,ph-6);
    ctx.fillStyle='#1a1a14';                                        // masthead rules
    ctx.fillRect(px+16,py+22,pw-32,2); ctx.fillRect(px+16,py+58,pw-32,2);
    ct('NEW SNAKE TIMES', cx, py+41, '#141410', FONT.TITLE);
    // Masthead crest: the player's own snake flanks the title, facing inward
    const _logoCol=cfg.snakeColor||0, _logoSi=cfg.wornItems||{}, _logoY=py+40, _logoRx=px+pw-52;
    drawScoreHead(px+52, _logoY, _logoCol, _logoSi);
    ctx.save(); ctx.translate(_logoRx,0); ctx.scale(-1,1); ctx.translate(-_logoRx,0);
    drawScoreHead(_logoRx, _logoY, _logoCol, _logoSi); ctx.restore();
    ct('EXTRA * EXTRA * READ ALL ABOUT IT', cx, py+72, '#6a5f4a', FONT.HINT);
    const pages=(ANNOUNCEMENT&&ANNOUNCEMENT.pages)||[ANNOUNCEMENT||{lines:[]}];
    const a=pages[Math.min(newsPage,pages.length-1)]||{lines:[]};
    ct(a.headline||'', cx, py+108, '#8a1810', FONT.MENU);                  // headline
    let y=py+146;
    (a.lines||[]).forEach(line=>{ if(line===''){ y+=10; return; } ct(line, cx, y, '#2a281e', FONT.HINT); y+=22; });
    if(pages.length>1){                                             // page flipper
        ct('< '+(newsPage+1)+' / '+pages.length+' >', cx, py+ph-20, '#6a5f4a', FONT.HINT);
    }
}
let _newsAt = 0, newsPage = 0;
function drawNews(now) {
    drawGrid(); drawOvBg(0.92);
    const t=Math.min(1,(now-_newsAt)/650);                          // retro spin-and-grow open
    ctx.save();
    ctx.translate(CW/2,CH/2); ctx.rotate((1-t)*Math.PI*4);
    const s=0.05+0.95*t; ctx.scale(s,s); ctx.translate(-CW/2,-CH/2);
    _drawNewspaperPage(now);
    ctx.restore();
    if(t>=1){ const multi=ANNOUNCEMENT&&ANNOUNCEMENT.pages&&ANNOUNCEMENT.pages.length>1;
        ct(multi?'L/R:page   A/ESC:back':'A:back  ESC:back', CW/2, CH-12, '#888', FONT.HINT); }
}
function drawSplashText(now) {
    const txt = (cfg.debug>0) ? 'DEBUG MODE' : _splashText;   // banner doubles as the debug-on indicator
    if(!txt) return;
    ctx.save();
    ctx.translate(CW*0.78, 120); ctx.rotate(-0.34);
    const s = 1 + 0.05*(1+Math.sin(now/150));   // smooth 1.0..1.10 pulse; abs(sin) gave a cusp that snapped each cycle
    ctx.scale(s, s);
    ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='#3a2a00'; ctx.fillText(txt, 1.5, 1.5);   // retro drop shadow
    ctx.fillStyle= cfg.debug>0 ? '#ff5555' : '#ffff00'; ctx.fillText(txt, 0, 0);
    ctx.restore();
}
// Static menu -> offscreen cache. Everything here changes only on an event.
function _composeMenu(diffLine){
    const c=_menuCtx;
    c.drawImage(_gridCanvas,0,0);
    c.drawImage(_scanCanvas,0,0);
    c.shadowColor='#7fff7f'; c.shadowBlur=38;
    ct('S N A K E',CW/2,78,'#7fff7f',FONT.DISPLAY,c);
    c.shadowBlur=0;
    ct('F O K   E D I T I O N',CW/2,122,'#4a7a4a',FONT.HINT,c);
    const msp=MENU_ITEMS.length<=5?38:30;
    MENU_ITEMS.forEach((item,i)=>menuItem(item,162+i*msp,i===menuSel,c));
    if(ANNOUNCEMENT) _drawNewspaper(c, menuSel===MENU_ITEMS.length);
    ct(diffLine,CW/2,362,'#4a7a4a',FONT.HINT,c);
    c.save();
    c.font=`${FONT.HINT}px "Press Start 2P"`; c.textBaseline='bottom'; c.shadowBlur=0;
    c.fillStyle='#4a7a4a'; c.textAlign='left';
    c.fillText(_swVersion, 10, CH-8);
    c.fillStyle='#888'; c.textAlign='center';
    c.fillText('UP/DN:nav  A:ok  START:quick', CW/2, CH-8);
    c.restore();
}
function drawMenu(now) {
    const diffLine=`DIFF:${DIFF[cfg.diff].label}  AUDIO:${cfg.music?'ON':'OFF'}  STYLE:${cfg.musicStyle===0?'NEW':'CLASSIC'}`;
    if(menuSel!==_mc.sel || _swVersion!==_mc.ver || diffLine!==_mc.diff || cfg.disableGlow!==_mc.glow){
        _composeMenu(diffLine); _mc.sel=menuSel; _mc.ver=_swVersion; _mc.diff=diffLine; _mc.glow=cfg.disableGlow;
    }
    ctx.drawImage(_menuCanvas,0,0);           // static layer (one blit)
    drawSplashText(now);                       // animated overlay
    if(ANNOUNCEMENT) _drawNewspaperBadge(now, !announceSeen());
}

// Settings are grouped into sub-menus. Each leaf carries a live label plus
// optional act() (Enter), adj(right) (Left/Right), and a render hint (bar/preview).
// Audio leaves keep their exact original Snd.* call sequences -- relocated, not changed.
const SETTINGS_CATS = [
    { label:'AUDIO', items:[
        { lbl:()=>'AUDIO: '+(cfg.music?'ON':'OFF'),
          act:()=>{cfg.music=!cfg.music;if(!cfg.music)Snd.musicStop();else{Snd.audioResume();Snd.sfxPlay('select',cfg.music);}updateMuteBtn();} },
        { lbl:()=>'AUDIO STYLE: '+(cfg.musicStyle===0?'NEW':'CLASSIC'),
          act:()=>{cfg.musicStyle=(cfg.musicStyle+1)%2;Snd.musicStop();Snd.sfxPlay('select',cfg.music);} },
        { lbl:()=>'VOLUME: '+Math.round(((cfg.volume==null?1:cfg.volume))*100)+'%', bar:'#7fff7f', frac:()=>(cfg.volume==null?1:cfg.volume),
          adj:(r)=>{cfg.volume=Math.max(0,Math.min(1,Math.round((((cfg.volume==null?1:cfg.volume))+(r?0.1:-0.1))*10)/10));Snd.musicSetVolume(cfg.volume);} },
        { lbl:()=>'SFX VOL: '+Math.round(((cfg.sfxVol==null?0.5:cfg.sfxVol))*100)+'%', bar:'#aaddff', frac:()=>(cfg.sfxVol==null?0.5:cfg.sfxVol),
          adj:(r)=>{cfg.sfxVol=Math.max(0,Math.min(1,Math.round((((cfg.sfxVol==null?0.5:cfg.sfxVol))+(r?0.1:-0.1))*10)/10));Snd.sfxSetVolume(cfg.sfxVol);} },
    ]},
    { label:'CONTROLS', items:[
        { lbl:()=>'TURBO BOOST: '+(cfg.turbo!==false?'ON':'OFF'),
          act:()=>{cfg.turbo=cfg.turbo===false?true:false;Snd.sfxPlay('select',cfg.music);} },
        { lbl:()=>'LAYOUT: '+(cfg.handed?'LEFT':'RIGHT'),
          act:()=>{cfg.handed=(cfg.handed+1)%2;applyHandedness();Snd.sfxPlay('select',cfg.music);},
          adj:(r)=>{cfg.handed=r?1:0;applyHandedness();} },
        { lbl:()=>'TOUCH AUTOSELECT: '+(cfg.touchSelect?'ON':'OFF'),
          act:()=>{cfg.touchSelect=!cfg.touchSelect;Snd.sfxPlay('select',cfg.music);} },
    ]},
    { label:'GAME', items:[
        { lbl:()=>'DIFFICULTY: '+DIFF[cfg.diff].label,
          act:()=>{cfg.diff=(cfg.diff+1)%DIFF.length;Snd.sfxPlay('select',cfg.music);} },
        { lbl:()=>'SNAKE COLOR: '+SNAKE_COLORS[cfg.snakeColor||0].name, preview:'color',
          act:()=>{cfg.snakeColor=(cfg.snakeColor+1)%SNAKE_COLORS.length;Snd.sfxPlay('select',cfg.music);},
          adj:(r)=>{cfg.snakeColor=(cfg.snakeColor+(r?1:-1)+SNAKE_COLORS.length)%SNAKE_COLORS.length;} },
    ]},
    { label:'GRAPHICS', items:[
        { lbl:()=>'LIMIT 30 FPS: '+(cfg.fps30?'ON':'OFF'),
          act:()=>{cfg.fps30=!cfg.fps30;Snd.sfxPlay('select',cfg.music);} },
        { lbl:()=>'DISABLE GLOW: '+(cfg.disableGlow?'ON':'OFF'),
          act:()=>{cfg.disableGlow=!cfg.disableGlow;Snd.sfxPlay('select',cfg.music);} },
    ]},
    { label:'DATA MANAGEMENT', items:[
        { lbl:()=>'STRICTLY OFFLINE: '+(cfg.offline?'ON':'OFF'),
          act:()=>{cfg.offline=!cfg.offline;Snd.sfxPlay('select',cfg.music);} },
        { lbl:()=>'BACKUP STATS', act:()=>{Snd.sfxPlay('select',cfg.music);backupStats();} },
        { lbl:()=>'RESTORE STATS', act:()=>{Snd.sfxPlay('select',cfg.music);restoreStats();} },
        { lbl:()=>'RESET STATS', act:()=>{quitConfirmSel=1;phase='resetConfirm';} },
    ]},
];
// Hidden DEBUGGING category: only present when cfg.debug > 0. cfg.debug is NOT settable
// from the normal menus -- you raise it by hand-editing the save file (it rides in the
// backup). Level: 1 = this menu; 2/3 reserved for in-game debug overlays (later).
let _showCanvasProps = false;
// cfg.debug guards ENTRY to the DEBUGGING menu; _debugEntered keeps it visible while you
// are inside it, so dialling the level to 0 shows 0 but doesn't kick you out -- the 0
// takes effect only when you leave the category (or reload).
let _debugEntered = false;
const DEBUG_CAT = { label:'DEBUGGING', items:[
    { lbl:()=>'DEBUG LEVEL: '+(cfg.debug||0),
      act:()=>{ cfg.debug=((cfg.debug||0)+1)%4; Snd.sfxPlay('select',cfg.music); },
      adj:(r)=>{ cfg.debug=Math.max(0,Math.min(3,(cfg.debug||0)+(r?1:-1))); } },
    { lbl:()=>'SHOW CANVAS PROPS: '+(_showCanvasProps?'ON':'OFF'),
      act:()=>{ _showCanvasProps=!_showCanvasProps; requestAnimationFrame(layout); Snd.sfxPlay('select',cfg.music); } },
    { lbl:()=>'EXPORT CANVAS INFO', act:()=>{ Snd.sfxPlay('select',cfg.music); exportCanvasInfo(); } },
    { lbl:()=>'MAKE ME RICH (+1BN FOK)', act:()=>{ addFOKoins(1000000000); Snd.sfxPlay('perfect',cfg.music); _dataMsg='+1,000,000,000 FK'; _dataMsgAt=simNow; } },
    { lbl:()=>'LOW-FPS RECORD: '+(_fpsRec?'ON':'OFF'),
      act:()=>{ _fpsRec=!_fpsRec; if(_fpsRec) _fpsRecReset(); else { try{ fpsEl.style.color=''; }catch(e){} } Snd.sfxPlay('select',cfg.music); } },
    { lbl:()=>'WORST '+(_fpsSnap?(_fpsSnap.fps+'fps@'+_fpsSnap.phase):'--')+'  MAX '+(_fpsMaxAvg||'--'),
      act:()=>{ Snd.sfxPlay('nav',cfg.music); } },
    { lbl:()=>'EXPORT FPS LOG', act:()=>{ Snd.sfxPlay('select',cfg.music); exportFpsLog(); } },
] };
function _cats(){ return (cfg.debug>0 || _debugEntered) ? SETTINGS_CATS.concat([DEBUG_CAT]) : SETTINGS_CATS; }
function _settingsList(){ return settingsCat>=0 ? _cats()[settingsCat].items : _cats(); }
function drawSettings() {
    drawGrid(); drawOvBg(0.92);
    const inCat=settingsCat>=0;
    const title=inCat?'SETTINGS/'+_cats()[settingsCat].label:'SETTINGS';
    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=16; ct(title,CW/2,24,'#7fff7f',FONT.TITLE); ctx.shadowBlur=0;
    const list=_settingsList();
    const startY=90, rowH=28;   // one empty line below the headline before the first entry
    list.forEach((it,i)=>menuItem(inCat?it.lbl():it.label, startY+i*rowH, i===settingsSel));
    menuItem('BACK', CH-52, settingsSel===list.length);   // BACK aligned toward the bottom
    if(inCat){
        const it=list[settingsSel];
        // Volume bar under the selected slider row
        if(it&&it.bar){
            const py=startY+settingsSel*rowH, bx=CW/2-55, bw=110;
            ctx.fillStyle='#1a2a1a'; ctx.fillRect(bx,py+10,bw,5);
            ctx.fillStyle=it.bar; ctx.fillRect(bx,py+10,Math.round(bw*it.frac()),5);
        }
        // Snake-color mini-preview beside the selected row
        if(it&&it.preview==='color'){
            const sc=SNAKE_COLORS[cfg.snakeColor||0], py=startY+settingsSel*rowH;
            ctx.save(); ctx.font=`${FONT.MENU}px "Press Start 2P"`;
            const tw=ctx.measureText('> '+it.lbl()+' <').width;
            const px=Math.round(CW/2+tw/2+12);
            for(let k=0;k<5;k++){
                const frac=1-k/5, l=Math.round(10+frac*40);
                ctx.fillStyle=k===0?sc.head:`hsl(${sc.h},65%,${l}%)`;
                ctx.shadowColor=k===0?sc.head:'transparent'; ctx.shadowBlur=k===0?6:0;
                ctx.fillRect(px+k*7,py-5,6,10);
            }
            ctx.restore();
        }
        // Transient backup/restore feedback in DATA MANAGEMENT
        const _cl=_cats()[settingsCat] && _cats()[settingsCat].label;
        if((_cl==='DATA MANAGEMENT'||_cl==='DEBUGGING')&&_dataMsg&&simNow-_dataMsgAt<2500){
            ctx.shadowColor='#7fff7f'; ctx.shadowBlur=12; ct(_dataMsg,CW/2,CH-34,'#7fff7f',FONT.MENU); ctx.shadowBlur=0;
        }
    }
    const hint=inCat?'UP/DN:nav  L/R:change  A:select  ESC:back':'UP/DN:nav  A:open  ESC:back';
    ct(hint,CW/2,CH-10,'#888',FONT.HINT);
}

function drawMiniSnake(x, y, colorIdx) {
    const sc=SNAKE_COLORS[colorIdx||0];
    for(let k=0;k<5;k++){
        const frac=1-k/5, l=Math.round(10+frac*38);
        ctx.fillStyle=k===0?sc.head:`hsl(${sc.h},65%,${l}%)`;
        if(k===0){ctx.shadowColor=sc.head;ctx.shadowBlur=5;}
        else ctx.shadowBlur=0;
        ctx.fillRect(x+k*6,y-3,5,6);
    }
    ctx.shadowBlur=0;
}

function drawScoreHead(cx, cy, colorIdx, si) {
    const sc = SNAKE_COLORS[colorIdx || 0];
    const scale = 1;
    ctx.save();
    ctx.translate(cx - Math.round(CS*scale/2), cy - Math.round(CS*scale/2));
    ctx.scale(scale, scale);
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

let _scoreboardCache = null;
function drawScores() {
    drawGrid(); drawOvBg(0.92);
    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=16; ct('HIGH SCORES',CW/2,28,'#7fff7f',FONT.TITLE); ctx.shadowBlur=0;
    const scores=_scoreboardCache||[];
    if(!scores.length){ ct('No scores yet!',CW/2,CH/2,'#aaa',FONT.HINT); }
    else {
        ctx.font=`${FONT.MENU}px "Press Start 2P"`; ctx.textBaseline='middle';
        scores.slice(0,8).forEach((s,i)=>{
            const y=90+i*28;
            ctx.fillStyle=i===0?'#ffd700':i<3?'#dddddd':'#aaaaaa';
            const diff=['E','N','H'][s.diff==null?1:s.diff]||'N';
            ctx.textAlign='left';  ctx.fillText(String(s.name||'???').slice(0,MAX_NAME), 24, y);
            ctx.textAlign='right'; ctx.fillText(String(s.score), 348, y);
            ctx.textAlign='left';  ctx.fillText(`${diff}/${s.level}`, 360, y);
            ctx.textAlign='left';  ctx.fillText(s.date||'--.--.--', 418, y);
            drawScoreHead(568, y, s.color||0, s.shopItems||{});
        });
        ctx.textAlign='center';
    }
    ct('A:back',CW/2,CH-14,'#888',FONT.HINT);
}

function drawAchievements() {
    drawGrid(); drawOvBg(0.92);
    const donated=!!(cfg.shopItems&&cfg.shopItems['donate']);
    const allBase=ACHIEVEMENTS.every(a=>achUnlocked[a.id]);
    const expert=donated&&allBase;
    const onExpert=expert&&achPage===0;
    const list=onExpert?EXPERT_ACHIEVEMENTS:ACHIEVEMENTS;
    const titleColor=onExpert?'#ff8800':'#7fff7f';
    ctx.shadowColor=titleColor; ctx.shadowBlur=16; ct('ACHIEVEMENTS',CW/2,28,titleColor,FONT.TITLE); ctx.shadowBlur=0;
    if(expert){
        ct(onExpert?'< EXPERT  1/2 >':'< BASE  2/2 >',CW/2,42,onExpert?'#ffaa44':'#7fff7f',FONT.HINT);
    } else if(allBase&&!donated){
        ct('DONATE in SHOP to unlock EXPERT page',CW/2,42,'#ff4488',FONT.HINT);
    }
    const cols=3, aw=188, ah=68, gx=4, gy=4;
    const ox=(CW-(cols*aw+(cols-1)*gx))/2;
    const oy=expert?54:64;
    list.forEach((a,i)=>{
        const col=i%cols, row=Math.floor(i/cols);
        const x=ox+col*(aw+gx), y=oy+row*(ah+gy);
        const got=!!achUnlocked[a.id];
        ctx.fillStyle=got?'rgba(0,60,0,0.28)':'rgba(10,10,10,0.28)';
        rr(x,y,aw,ah,4); ctx.fill();
        ctx.strokeStyle=got?'#4a8a4a':'#444444'; ctx.lineWidth=got?2:1;
        rr(x,y,aw,ah,4); ctx.stroke();
        ctx.save();
        if(!got) ctx.globalAlpha=0.35;
        drawPixelIcon(x+5,y+ah/2-9,a.icon,2);
        ctx.restore();
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.font=`${FONT.HINT}px "Press Start 2P"`;
        ctx.fillStyle=got?'#7fff7f':'#888888';
        ctx.fillText(a.name,x+26,y+10);
        ctx.font=`${FONT.HINT}px "Press Start 2P"`;
        ctx.fillStyle=got?'#6aaa6a':'#777777';
        const _mw=aw-32; let _d1=a.desc,_d2='';
        if(ctx.measureText(_d1).width>_mw){
            const _ws=a.desc.split(' '); let _l='';
            for(const _w of _ws){const _t=_l?_l+' '+_w:_w;if(ctx.measureText(_t).width<=_mw)_l=_t;else{_d2=a.desc.slice(_l.length+1);break;}}_d1=_l;
        }
        ctx.fillText(_d1,x+26,y+28);
        if(_d2) ctx.fillText(_d2,x+26,y+42);
    });
    ctx.textAlign='center'; ctx.textBaseline='middle';
    const total=list.filter(a=>achUnlocked[a.id]).length;
    ctx.shadowColor='#6aaa6a'; ctx.shadowBlur=6; ct(`${total} / ${list.length} UNLOCKED`,CW/2,CH-26,'#6aaa6a',FONT.HINT); ctx.shadowBlur=0;
    const hint='A:back';
    ct(hint,CW/2,CH-10,'#888',FONT.HINT);
}

function drawAchPopups(now) {
    confetti=confetti.filter(c=>{
        c.life++; c.x+=c.vx; c.y+=c.vy; c.vy+=0.05; c.rot+=c.vrot;
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
function _gearList(){ const si=cfg.shopItems||{}; return BOX_ITEMS.filter(b=>si[b.id]); }
let _boxOpenAt = 0, _boxReward = null;
// ADMIN box: surfaces on the boxes tab once every ADMIN_BOX_EVERY shop opens, then is
// consumed for the run once claimed. _boxList() appends it only while available.
let _adminAvail = false, _adminConsumed = false;
function _boxList(){ return (_adminAvail && !_adminConsumed) ? BOXES.concat([ADMIN_BOX]) : BOXES; }
// Enter the shop: count the open, decide whether the ADMIN box is up this visit, and
// jump straight to it (boxes tab, selected) when it is so the grand prize is unmissable.
function _enterShop(){
    cfg.shopOpens = (cfg.shopOpens||0) + 1;
    _adminAvail = (cfg.shopOpens % ADMIN_BOX_EVERY === 0);
    _adminConsumed = false;
    phase='shop'; purchaseAnimAt=0;
    shopPage = _adminAvail ? BOX_PAGE : 0;
    shopSel  = _adminAvail ? BOXES.length : 0;
    saveCfg();
}
function _findItem(id){ return SHOP_ITEMS.find(i=>i.id===id) || BOX_ITEMS.find(i=>i.id===id); }
const _RARITY_COL = { common:'#9aa0a6', rare:'#4a90d9', epic:'#9b59b6', legendary:'#f1c40f' };
function _drawBoxIcon(x,y,box,s){
    ctx.save();
    ctx.fillStyle=box.color; ctx.fillRect(x-1,y+s*0.26,s+2,s*0.2);       // lid
    ctx.fillStyle=box.color; ctx.fillRect(x,y+s*0.42,s,s*0.55);          // body
    ctx.fillStyle='rgba(255,255,255,0.28)'; ctx.fillRect(x,y+s*0.26,s+1,s*0.06);
    ctx.strokeStyle='rgba(0,0,0,0.45)'; ctx.lineWidth=1; ctx.strokeRect(x,y+s*0.42,s,s*0.55);
    ctx.fillStyle='#ffd700'; ctx.fillRect(x+s/2-2,y+s*0.5,4,4);          // lock
    ctx.fillStyle='#ffffff'; ctx.font=Math.round(s*0.42)+'px "Press Start 2P"'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('?',x+s/2,y+s*0.72);
    ctx.restore();
}
function _drawBoxesPage(){
    const coins=_cachedFOKoins, startY=72, rowH=52, boxes=_boxList();
    if(shopSel>=boxes.length) shopSel=boxes.length-1;   // keep a row selected after the ADMIN box is claimed
    boxes.forEach((box,i)=>{
        const y=startY+i*rowH, sel=i===shopSel, isAdmin=box.id==='admin';
        const canAfford=isAdmin||coins>=box.price, bc=isAdmin?'#ffd700':box.color;
        ctx.fillStyle=sel?(isAdmin?'rgba(60,42,10,0.75)':'rgba(45,45,45,0.7)'):(isAdmin?'rgba(40,26,6,0.5)':'rgba(10,10,10,0.35)');
        rr(8,y,CW-16,rowH-6,5); ctx.fill();
        if(isAdmin){ ctx.shadowColor='#ffd700'; ctx.shadowBlur=sel?14:8; }
        ctx.strokeStyle=sel?bc:(isAdmin?'#caa100':'#3a3a3a'); ctx.lineWidth=sel?2:(isAdmin?1.8:1.2); rr(8,y,CW-16,rowH-6,5); ctx.stroke();
        ctx.shadowBlur=0;
        _drawBoxIcon(18,y+8,box,28);
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.font=`${FONT.MENU}px "Press Start 2P"`; ctx.fillStyle=bc; ctx.fillText(box.name+' BOX',60,y+10);
        ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=isAdmin?'#ffcf55':'#999999';
        ctx.fillText(isAdmin?'GRAND PRIZE - guaranteed ADMIN CROWN':'Rarer loot at higher tiers',60,y+28);
        ctx.textAlign='right';
        ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=isAdmin?'#5aff8a':(canAfford?'#ffd700':'#553322');
        ctx.fillText(isAdmin?'FREE':box.price.toLocaleString()+' FK',CW-18,y+11);
        if(sel){ ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=canAfford?'#5aaa5a':'#cc6644';
            ctx.fillText(canAfford?(isAdmin?'ENTER to claim':'ENTER to open'):'Not enough FK',CW-18,y+29); }
    });
}
// Owned box-exclusive cosmetics, wearable here (they don't fit the buyable cosmetics tabs).
function _drawGearPage(){
    const wi=cfg.wornItems||{}, gear=_gearList();
    if(!gear.length){
        ct('NO BOX GEAR YET',CW/2,CH/2-16,'#888888',FONT.MENU);
        ct('Win exclusive cosmetics from Mystery Boxes',CW/2,CH/2+10,'#9b6ad0',FONT.HINT);
        return;
    }
    const startY=72, rowH=44;
    gear.forEach((item,i)=>{
        const y=startY+i*rowH, sel=i===shopSel, worn=!!wi[item.id], rc=_RARITY_COL[item.rarity]||'#7fff7f';
        ctx.fillStyle=worn?(sel?'rgba(40,64,40,0.7)':'rgba(20,48,20,0.5)'):(sel?'rgba(20,40,55,0.7)':'rgba(10,25,40,0.5)');
        rr(8,y,CW-16,rowH-4,5); ctx.fill();
        ctx.strokeStyle=worn?'#7fff7f':rc; ctx.lineWidth=1.5; rr(8,y,CW-16,rowH-4,5); ctx.stroke();
        drawPixelIcon(16,y+(rowH-4)/2-8,item.icon,2);
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=worn?'#7fff7f':'#dddddd'; ctx.fillText(item.name,46,y+7);
        ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=rc; ctx.fillText((item.rarity||'').toUpperCase()+' - BOX EXCLUSIVE',46,y+21);
        ctx.textAlign='right';
        ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=worn?'#7fff7f':'#4a7a9a'; ctx.fillText(worn?'WORN':'OWNED',CW-18,y+9);
        if(sel){ ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=worn?'#cc5555':'#5aaa5a'; ctx.fillText(worn?'SPACE to remove':'SPACE to wear',CW-18,y+23); }
    });
    ctx.textAlign='center'; ctx.textBaseline='middle';
}
// Buy + open a box: deduct, roll, grant (item / dupe-sell / coins), trigger reveal.
function _openBox(box){
    if(box.id==='admin'){
        const si=cfg.shopItems||(cfg.shopItems={});
        _adminConsumed=true;
        if(si.admincrown){ const refund=Math.round(_boxItemValue('admincrown')*0.5); addFOKoins(refund); _boxReward={kind:'dupe',id:'admincrown',rarity:'legendary',refund}; }
        else { si.admincrown=true; _boxReward={kind:'item',id:'admincrown',rarity:'legendary'}; }
        saveCfg(); _boxOpenAt=simNow; Snd.sfxPlay('unbox',cfg.music); return;
    }
    if(_cachedFOKoins < box.price){ Snd.sfxPlay('fail',cfg.music); return; }
    _cachedFOKoins -= box.price; try{ localStorage.setItem(FK_KEY,String(_cachedFOKoins)); }catch (e){}
    const res=rollBox(box);
    if(res.type==='coins'){ addFOKoins(res.amount); _boxReward={kind:'coins',amount:res.amount}; }
    else {
        const si=cfg.shopItems||(cfg.shopItems={});
        if(si[res.id]){ const refund=Math.round(_boxItemValue(res.id)*0.5); addFOKoins(refund); _boxReward={kind:'dupe',id:res.id,rarity:res.rarity,refund}; }
        else { si[res.id]=true; if(SHOP_ITEMS.filter(s=>!s.repeatable).every(s=>si[s.id])) unlockAch('shop_full'); _boxReward={kind:'item',id:res.id,rarity:res.rarity}; }
    }
    saveCfg();
    _boxOpenAt=simNow;
    Snd.sfxPlay('unbox',cfg.music);
}
function _drawBoxReveal(){
    const age=simNow-_boxOpenAt;
    if(!(_boxOpenAt>0 && age<2400 && _boxReward)) return;
    if(age<220){ ctx.save(); ctx.globalAlpha=(1-age/220)*0.55; ctx.fillStyle='#ffe860'; ctx.fillRect(0,0,CW,CH); ctx.restore(); }
    const fade=age<150?age/150:age>2000?Math.max(0,1-(age-2000)/400):1;
    ctx.save(); ctx.globalAlpha=fade; drawOvBg(0.55);
    const r=_boxReward;
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=18;
    if(r.kind==='coins'){ ct('YOU GOT',CW/2,CH/2-18,'#aaa',FONT.HINT); ct('+'+r.amount.toLocaleString()+' FK',CW/2,CH/2+8,'#ffd700',FONT.TITLE); }
    else if(r.kind==='dupe'){ const dit=_findItem(r.id), drc=_RARITY_COL[r.rarity]||'#aaaaaa';
        if(dit&&dit.icon) drawPixelIcon(CW/2-16,CH/2-52,dit.icon,4);
        ct(dit?dit.name:r.id,CW/2,CH/2+2,'#ffffff',FONT.MENU);
        ct('DUPLICATE',CW/2,CH/2+22,drc,FONT.HINT);
        ct('SOLD +'+r.refund.toLocaleString()+' FK',CW/2,CH/2+40,'#ffd700',FONT.HINT); }
    else { const it=_findItem(r.id), rc=_RARITY_COL[r.rarity]||'#fff';
        if(it&&it.icon) drawPixelIcon(CW/2-16,CH/2-46,it.icon,4);
        ct((r.rarity||'').toUpperCase(),CW/2,CH/2+10,rc,FONT.HINT);
        ct(it?it.name:r.id,CW/2,CH/2+30,'#ffffff',FONT.MENU); }
    ctx.shadowBlur=0; ctx.restore();
}
// Retro tab strip: all four shop pages visible at once, active one lit.
function _drawShopTabs(){
    const labels=['COSMETICS 1','COSMETICS 2','BOX GEAR','MYSTERY BOXES'];
    const hi   =['#7fff7f','#7fff7f','#4ad0ff','#c48af0'];
    const fill =['rgba(28,60,20,0.85)','rgba(28,60,20,0.85)','rgba(16,44,60,0.85)','rgba(68,40,96,0.85)'];
    const txt  =['#bfffbf','#bfffbf','#bfe8ff','#e6c0ff'];
    const m=6, tabH=20, tabY=42, tabW=(CW-2*m)/labels.length;
    for(let i=0;i<labels.length;i++){
        const tx=m+i*tabW, active=(i===shopPage);
        ctx.fillStyle=active?fill[i]:'rgba(16,16,16,0.6)';
        rr(tx+2,tabY,tabW-4,tabH,4); ctx.fill();
        ctx.lineWidth=active?2:1; ctx.strokeStyle=active?hi[i]:'#3a3a3a';
        if(active){ ctx.shadowColor=hi[i]; ctx.shadowBlur=8; }
        rr(tx+2,tabY,tabW-4,tabH,4); ctx.stroke(); ctx.shadowBlur=0;
        ct(labels[i], tx+tabW/2, tabY+tabH/2+1, active?txt[i]:'#666666', FONT.HINT);
    }
}
function drawShop() {
    drawGrid(); drawOvBg(0.92);
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=16; ct('SHOP',CW/2,26,'#ffd700',FONT.TITLE); ctx.shadowBlur=0;
    _drawShopTabs();
    const coins=_cachedFOKoins;
    if(shopPage===BOX_PAGE){ _drawBoxesPage(); }
    else if(shopPage===GEAR_PAGE){ _drawGearPage(); }
    else {
    const si=cfg.shopItems||{}, wi=cfg.wornItems||{};
    const items=SHOP_ITEMS.filter(it=>(it.page||0)===shopPage);
    const startY=72, rowH=44;
    items.forEach((item,i)=>{
        const y=startY+i*rowH, sel=i===shopSel;
        const isRep=!!item.repeatable;
        const owned=!!si[item.id], worn=!isRep&&owned&&!!wi[item.id], canAfford=coins>=item.price;
        ctx.fillStyle=worn?(sel?'rgba(40,64,40,0.7)':'rgba(20,48,20,0.5)'):
                      (owned&&isRep)?(sel?'rgba(64,10,35,0.7)':'rgba(40,5,20,0.5)'):
                      owned?(sel?'rgba(20,40,55,0.7)':'rgba(10,25,40,0.5)'):
                      (sel?'rgba(40,64,40,0.55)':'rgba(10,10,10,0.3)');
        rr(8,y,CW-16,rowH-4,5); ctx.fill();
        if(worn||owned||sel){ctx.strokeStyle=worn?'#7fff7f':(owned&&isRep)?'#cc4488':owned?'#4a7a9a':'#6aaa6a';ctx.lineWidth=1.5;rr(8,y,CW-16,rowH-4,5);ctx.stroke();}
        drawPixelIcon(16,y+(rowH-4)/2-8,item.icon,2);
        ctx.textAlign='left'; ctx.textBaseline='top';
        ctx.font=`${FONT.HINT}px "Press Start 2P"`;
        ctx.fillStyle=worn?'#7fff7f':(owned&&isRep)?'#ff66aa':owned?'#5a8aaa':sel?'#dddddd':'#aaaaaa';
        ctx.fillText(item.name,46,y+7);
        ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle='#999999';
        ctx.fillText(item.desc,46,y+21);
        ctx.textAlign='right';
        if(isRep){
            if(owned){ctx.font=`${FONT.HINT}px "Press Start 2P"`;ctx.fillStyle='#ff44aa';ctx.fillText('DONATED',CW-18,y+9);}
            else{ctx.font=`${FONT.HINT}px "Press Start 2P"`;ctx.fillStyle=canAfford?'#ffd700':'#553322';ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+9);}
            ctx.font=`${FONT.HINT}px "Press Start 2P"`;
            if(sel){ctx.fillStyle=canAfford?'#5aaa5a':'#cc6644';ctx.fillText(canAfford?'ENTER to donate':'Not enough FK',CW-18,y+23);}
            else if(owned){ctx.fillStyle='#555';ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+23);}
        } else if(owned){
            ctx.font=`${FONT.HINT}px "Press Start 2P"`;
            ctx.fillStyle=worn?'#7fff7f':'#4a7a9a';
            ctx.fillText(worn?'WORN':'OWNED',CW-18,y+9);
            ctx.font=`${FONT.HINT}px "Press Start 2P"`;
            if(sel){ctx.fillStyle=worn?'#cc5555':'#5aaa5a';ctx.fillText(worn?'SPACE to remove':'SPACE to wear',CW-18,y+23);}
            else{ctx.fillStyle='#555';ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+23);}
        } else {
            ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.fillStyle=canAfford?'#ffd700':'#553322';
            ctx.fillText(`${item.price.toLocaleString()} FK`,CW-18,y+9);
            if(sel){ctx.font=`${FONT.HINT}px "Press Start 2P"`;ctx.fillStyle=canAfford?'#5aaa5a':'#cc6644';
                ctx.fillText(canAfford?'ENTER to buy':'Not enough FK',CW-18,y+23);}
        }
    });
    }
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='#ffd700'; ctx.shadowBlur=6;
    ct(`BALANCE: ${coins.toLocaleString()} FK`,CW/2,CH-30,'#ffd700',FONT.HINT);
    ctx.shadowBlur=0;
    ct(shopPage===BOX_PAGE ? 'UP/DN:nav  L/R:tab  A:open  ESC:back'
       : shopPage===GEAR_PAGE ? 'UP/DN:nav  L/R:tab  A/||:wear  ESC:back'
       : 'UP/DN:nav  L/R:tab  A:buy  ||:wear  ESC:back',CW/2,CH-12,'#888',FONT.HINT);
    // Purchase particles
    const now=simNow;
    purchaseParticles=purchaseParticles.filter(p=>{
        p.life++;p.x+=p.vx;p.y+=p.vy;p.vy+=0.09;p.rot+=p.vrot;
        if(p.life>=p.maxLife||p.y>CH+20) return false;
        const a=p.life<10?p.life/10:p.life>p.maxLife-15?1-(p.life-(p.maxLife-15))/15:1;
        ctx.save();ctx.globalAlpha=a;ctx.translate(p.x,p.y);ctx.rotate(p.rot);
        ctx.fillStyle=p.color;ctx.fillRect(-p.size/2,-p.size/2,p.size,p.size);
        ctx.restore();return true;
    });
    // "PURCHASED!" flash
    const buyAge=now-purchaseAnimAt;
    if(purchaseAnimAt>0&&buyAge<1600){
        const a=buyAge<180?buyAge/180:buyAge>1200?1-(buyAge-1200)/400:1;
        ctx.save();ctx.globalAlpha=a;
        ctx.shadowColor='#7fff7f';ctx.shadowBlur=16;
        ct('PURCHASED!',CW/2,CH/2+20,'#7fff7f',FONT.TITLE);
        ctx.restore();
    }
    _drawBoxReveal();
}

function drawCredits() {
    drawGrid(); drawOvBg(0.93);
    ctx.save(); ctx.beginPath(); ctx.rect(0,0,CW,CH-24); ctx.clip();
    let y = creditsScroll;
    for (const [type, val] of CRED) {
        if (type === 'gap') { y += val; continue; }
        const h = CRED_H[type] || 22;
        const yc = y + h/2;
        if (y > -50 && y < CH + 20) {
            switch (type) {
                case 'title':
                    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=38;
                    ct(val, CW/2, yc, '#7fff7f', FONT.DISPLAY); ctx.shadowBlur=0; break;
                case 'sub':
                    ct(val, CW/2, yc, '#4a7a4a', FONT.HINT); break;
                case 'hdr':
                    ctx.shadowColor='#00cccc'; ctx.shadowBlur=6;
                    ct(val, CW/2, yc, '#00cccc', FONT.MENU); ctx.shadowBlur=0; break;
                case 'txt':
                    ct(val, CW/2, yc, '#aaa', FONT.MENU); break;
                case 'sml':
                    ct(val, CW/2, yc, '#999', FONT.MENU); break;
                case 'coins':
                    ctx.shadowColor='#ffd700'; ctx.shadowBlur=6;
                    ct(`YOUR FOKOINS: ${_cachedFOKoins.toLocaleString()}`, CW/2, yc, '#ffd700', FONT.MENU);
                    ctx.shadowBlur=0; break;
                case 'secret':
                    ctx.shadowColor='#ff4444'; ctx.shadowBlur=14;
                    ct(val, CW/2, yc, '#ff5555', FONT.MENU);
                    ctx.shadowBlur=0; break;
            }
        }
        y += h;
    }
    ctx.restore();
    creditsScroll -= creditsSpeed;
    if (creditsScroll < -CRED_TOTAL_H) creditsScroll = CH + 40;  // loop
    ct('UP:slow  DN:fast  ||:pause  A:exit', CW/2, CH-12, '#888', FONT.HINT);
}

function drawNameEntry(now) {
    drawGrid();
    if(bars)  { _prepBars(false); bars.forEach(b=>drawBar(b)); }
    if(_gourangaActive) _drawGourangaPending(now);
    if(gem)   drawGem(gem,now);
    if(snake) drawSnake(false);
    drawOvBg(0.84);
    const isWin=nameReason==='win';
    ctx.shadowColor=isWin?'#ffd700':'#ff5555'; ctx.shadowBlur=24;
    ct(isWin?'YOU WIN!':'GAME OVER',CW/2,36,isWin?'#ffd700':'#ff5555',FONT.JUMBO); ctx.shadowBlur=0;
    ct(`SCORE: ${score}   LEVEL: ${level}`,CW/2,76,'#aaa',FONT.HINT);
    ct('ENTER YOUR NAME:',CW/2,104,'#7fff7f',FONT.HINT);
    const sw=30,sh=40,gap=5,totalW=MAX_NAME*(sw+gap)-gap,sx0=Math.floor(CW/2-totalW/2),sy=122;
    for(let i=0;i<MAX_NAME;i++){
        const sx=sx0+i*(sw+gap),act=i===nameCursorPos,has=i<nameStr.length&&!act;
        ctx.fillStyle=act?'#142014':'#0d0d18'; ctx.strokeStyle=act?'#7fff7f':'#2a2a3a'; ctx.lineWidth=act?1.5:1;
        rr(sx,sy,sw,sh,3); ctx.fill(); ctx.stroke();
        const flashing=has&&i===_nameFlashPos&&now-_nameFlashAt<350;
        if(has){ ctx.shadowColor='#7fff7f'; ctx.shadowBlur=flashing?14:1; if(nameStr[i]===' '){ctx.shadowBlur=0;ctx.fillStyle=flashing?'#ffffff':'#4a7a4a';ctx.fillRect(sx+8,sy+sh-12,sw-16,2);}else{ct(nameStr[i],sx+sw/2,sy+sh/2,flashing?'#ffffff':'#7fff7f',FONT.MENU);} ctx.shadowBlur=0; }
        else if(act){
            const gc=NAME_CHARS[nameCharIdx]; ctx.globalAlpha=0.42; if(gc===' '){ctx.fillStyle='#7fff7f';ctx.fillRect(sx+8,sy+sh-12,sw-16,2);}else{ct(gc==='\r'?'\u21B5':gc,sx+sw/2,sy+sh/2,'#7fff7f',FONT.MENU);} ctx.globalAlpha=1;
            if(Math.floor(now/400)%2===0){ctx.fillStyle='#7fff7f55';ctx.fillRect(sx+5,sy+sh-6,sw-10,2);}
        }
    }
    const selY=sy+sh+90,ci=nameCharIdx;
    {
        ctx.fillStyle='#0d1e0d'; rr(CW/2-20,selY-12,40,22,3); ctx.fill();
        ctx.strokeStyle='#2a5a2a'; ctx.lineWidth=1; rr(CW/2-20,selY-12,40,22,3); ctx.stroke();
        for(let d=-2;d<=2;d++){
            const raw=NAME_CHARS[(ci+d+NAME_CHARS.length)%NAME_CHARS.length];
            const y=selY+d*22, sz=d===0?FONT.MENU:FONT.HINT;
            const col=d===0?'#7fff7f':Math.abs(d)===1?'#888':'#555';
            const al=d===0?1:Math.abs(d)===2?0.35:0.75;
            if(d===0){ctx.shadowColor='#7fff7f';ctx.shadowBlur=12;}
            ctx.globalAlpha=al;
            if(raw===' '){
                // spacebar visual: horizontal bar
                const bw=d===0?22:14;
                ctx.fillStyle=col;
                ctx.fillRect(Math.round(CW/2-bw/2),Math.round(y+sz*0.35),bw,2);
            } else if(raw==='\r'){
                // enter key: symbol inside a key-shaped box
                const bw=d===0?28:20,bh=d===0?20:14;
                ctx.strokeStyle=col; ctx.lineWidth=1;
                rr(Math.round(CW/2-bw/2),Math.round(y-bh/2),bw,bh,2); ctx.stroke();
                ct('\u21B5',CW/2,y,col,sz);
            } else {
                ct(raw,CW/2,y,col,sz);
            }
            ctx.globalAlpha=1;
            if(d===0){ctx.shadowBlur=0;}
        }
        ctx.fillStyle='rgba(127,255,127,0.45)';
        const ax=CW/2,uay=selY-2*22-18,day=selY+2*22+18;
        ctx.beginPath(); ctx.moveTo(ax,uay-5); ctx.lineTo(ax-6,uay+3); ctx.lineTo(ax+6,uay+3); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(ax,day+5); ctx.lineTo(ax-6,day-3); ctx.lineTo(ax+6,day-3); ctx.closePath(); ctx.fill();
    }
    ct('UP/DN:letter  L/R:move  A:place  RETURN=submit  ESC:del',CW/2,CH-10,'#888',FONT.HINT);
}

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
    if(heartIsEarly&&now-heartAt>8500&&Math.floor(now/180)%2===0) return;
    const pulse=0.85+0.15*Math.sin((now-heartAt)/220);
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
    const pulse=0.85+0.15*Math.sin((now-powerPelletAt)/220);
    const cx=powerPellet.x*CS+CS/2, cy=powerPellet.y*CS+CS/2;
    const w=(CS-3)*pulse, h=(CS*0.56)*pulse, r=h/2;    // capsule (stadium): rounded ends
    const hue=(now/7)%360;
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
    const cx=timeCrystal.x*CS+CS/2, cy=timeCrystal.y*CS+CS/2, t=(now-timeCrystalAt)/1000;
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
function drawGameBoard(now) {
    if(_powerMode){
        drawGrid();
        const nearEnd=now-_powerModeAt>_POWER_DUR-1500;
        const blink=nearEnd&&Math.floor(now/180)%2===0;
        _prepBars(!blink); bars.forEach(b=>drawBar(b,ctx,blink?b.fragile:true));
        ctx.save(); ctx.globalAlpha=0.06+0.04*Math.sin(now/200);
        ctx.fillStyle='#2244ff'; ctx.fillRect(0,0,CW,CH); ctx.restore();
    } else {
        ctx.drawImage(_bgCanvas,0,0);   // grid + bars pre-composited: one blit
    }
    if(_slowMode){
        const rem=_SLOW_DUR-(now-_slowModeAt);
        const a=(rem<3000&&Math.floor(now/200)%2===0)?0.02:0.05+0.03*Math.sin(now/300);
        ctx.save(); ctx.globalAlpha=a; ctx.fillStyle='#2a80c0'; ctx.fillRect(0,0,CW,CH); ctx.restore();
    }
    if(_gourangaActive) _drawGourangaPending(now);
    if(gem) drawGem(gem,now);
    if(powerPellet) _drawPowerPellet(now);
    if(timeCrystal) _drawTimeCrystal(now);
    if(heart) _drawHeart(now);
    _drawCrushEffects(now);
    const dying=phase==='dying',flash=dying&&Math.floor((now-phaseAt)/85)%2===1;
    const protect=phase==='playing'&&(now-spawnAt<SPAWN_PROTECT);
    if(protect&&Math.floor(now/130)%2===1) ctx.globalAlpha=0.22;
    drawSnake(flash);
    ctx.globalAlpha=1;
    // Fireworks particles (perfect level)
    if(fireworks.length>0){
        fireworks=fireworks.filter(p=>{
            if(now<p.startAt) return true;
            p.life++; p.x+=p.vx; p.y+=p.vy; p.vy+=0.055; p.vx*=0.97;
            if(p.life>=p.maxLife) return false;
            const a=(1-p.life/p.maxLife)*0.92;
            const px=Math.round(p.x/2)*2, py=Math.round(p.y/2)*2;
            ctx.globalAlpha=a; ctx.fillStyle=p.color;
            ctx.fillRect(px,py,2,2);
            return true;
        });
        ctx.globalAlpha=1; ctx.shadowBlur=0;
    }
    if(phase==='levelDone'){
        const a=Math.min(1,(now-phaseAt)/150);
        ctx.save(); ctx.globalAlpha=a; ctx.shadowColor='#7fff7f'; ctx.shadowBlur=16;
        ct('LEVEL COMPLETE!',CW/2,levelWasPerfect?CH/2-36:CH/2-18,'#7fff7f',FONT.TITLE); ctx.restore();
        if(levelWasPerfect){
            const pa=Math.min(1,(now-phaseAt-180)/200);
            if(pa>0){
                ctx.save(); ctx.globalAlpha=pa;
                ctx.shadowColor='#ffd700'; ctx.shadowBlur=12;
                ct('PERFECT LEVEL!',CW/2,CH/2+2,'#ffd700',FONT.MENU);
                ctx.shadowBlur=0;
                ct(`+${(level*1000).toLocaleString()} BONUS`,CW/2,CH/2+22,'#ffaa00',FONT.HINT);
                ctx.restore();
            }
        }
        if(levelDoneWaiting&&Math.floor(now/520)%2===0){
            ctx.save(); ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.textBaseline='bottom'; ctx.textAlign='center'; ctx.shadowBlur=0;
            ctx.fillStyle='#888'; ctx.fillText('A:next  TAP:next',CW/2,CH-8); ctx.restore();
        }
    }
    if(phase==='levelReady'){
        const t=now-phaseAt, goPhase=t>=READY_DUR;
        drawOvBg(0.72);
        if(!goPhase){
            ctx.shadowColor='#7fff7f'; ctx.shadowBlur=16;
            ct(`LEVEL ${level}`,CW/2,CH/2-18,'#7fff7f',FONT.TITLE); ctx.shadowBlur=0;
            ctx.shadowColor='#aaa'; ctx.shadowBlur=12;
            ct('GET READY',CW/2,CH/2+38,'#aaa',FONT.MENU);
        } else {
            const a=Math.min(1,(t-READY_DUR)/80);
            ctx.save(); ctx.globalAlpha=a; ctx.shadowColor='#ffff44'; ctx.shadowBlur=24;
            ct('GO!',CW/2,CH/2+10,'#ffff44',FONT.JUMBO); ctx.shadowBlur=0; ctx.restore();
        }
    }
    if(dying){
        const t=(now-phaseAt)/DEATH_DUR;
        ctx.save(); ctx.globalAlpha=Math.min(1,t*2.5); ctx.shadowColor='#ff4444';
        if(lives===0){ctx.shadowBlur=24;ct(deathMsg,CW/2,CH/2,'#ff5555',FONT.JUMBO);}
        else{ctx.shadowBlur=16;ct(deathMsg,CW/2,CH/2,'#ff5555',FONT.TITLE);}
        ctx.restore();
    }
    if(phase==='paused'){
        drawOvBg(0.55);
        ctx.shadowColor='#7fff7f'; ctx.shadowBlur=24;
        ct('PAUSED',CW/2,CH/2+10,'#7fff7f',FONT.JUMBO); ctx.shadowBlur=0;
        ctx.save(); ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.textBaseline='bottom'; ctx.textAlign='center'; ctx.shadowBlur=0;
        ctx.fillStyle='#888'; ctx.fillText('||:resume  ESC:quit',CW/2,CH-8); ctx.restore();
    }
    // Bonus flash (duration and colour vary by tier)
    const bonusAge=now-bonusAt;
    const isGouranga=bonusLabel==='GOURANGA!';
    const flashDur=isGouranga?2500:bonusLabel.startsWith('EPIC')?1500:900;
    if(bonusAge<flashDur&&bonusLabel){
        const a=1-bonusAge/flashDur;
        const isEpic=bonusLabel.startsWith('EPIC'),isLucky=bonusLabel.startsWith('LUCKY');
        const col=isGouranga?`hsl(${(now/5)%360},100%,65%)`:isEpic?`hsl(${(now/6)%360},100%,70%)`:'#ffd700';
        const sz=isGouranga?FONT.JUMBO:isEpic?FONT.JUMBO:FONT.MENU;
        ctx.save(); ctx.globalAlpha=a;
        ctx.shadowColor=col; ctx.shadowBlur=isGouranga?36:isEpic?24:12;
        ct(bonusLabel,CW/2,CH/2-60,col,sz);
        ctx.restore();
    }
    updateHUD();
}

function drawConfirmYesNo(title, sel) {
    const YES_X=CW/2-80, NO_X=CW/2+80;
    ctx.shadowColor='#ff9900'; ctx.shadowBlur=16;
    ct(title,CW/2,CH/2-18,'#ff9900',FONT.TITLE); ctx.shadowBlur=0;
    ctx.globalAlpha=sel===0?1:0.35;
    ctx.shadowColor='#7fff7f'; ctx.shadowBlur=sel===0?12:1;
    ct(sel===0?'> YES <':'  YES  ',YES_X,CH/2+38,'#7fff7f',FONT.MENU);
    ctx.globalAlpha=sel===1?1:0.35;
    ctx.shadowColor='#ff5555'; ctx.shadowBlur=sel===1?12:1;
    ct(sel===1?'> NO <':'  NO   ',NO_X,CH/2+38,'#ff5555',FONT.MENU);
    ctx.globalAlpha=1; ctx.shadowBlur=0;
    ctx.save(); ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.textBaseline='bottom'; ctx.textAlign='center';
    ctx.fillStyle='#888'; ctx.fillText('L/R:choose  A:ok  ESC:cancel',CW/2,CH-8); ctx.restore();
}
function drawQuitConfirm() {
    drawGrid();
    if(bars)  ctx.drawImage(_barsCanvas, 0, 0);
    if(gem)   drawGem(gem, simNow);
    if(snake) drawSnake(false);
    drawOvBg(0.72);
    drawConfirmYesNo('QUIT TO MENU?', quitConfirmSel);
    showHUD(false);
}
function drawResetConfirm() {
    drawSettings();
    drawOvBg(0.80);
    ctx.shadowColor='#ff5555'; ctx.shadowBlur=12;
    ct('RESET ALL STATS?',CW/2,CH/2-54,'#ff5555',FONT.MENU); ctx.shadowBlur=0;
    ctx.font=`${FONT.HINT}px "Press Start 2P"`; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='#888';
    ctx.fillText('scores  fokoins  achievements  shop',CW/2,CH/2-24);
    drawConfirmYesNo('', quitConfirmSel);
}
function resetStats() {
    const keys = [HS_KEY, FK_KEY, ACH_KEY, 'lastSName'];
    keys.forEach(k=>{ try { localStorage.removeItem(k); } catch (e) {} });
    _cachedFOKoins = 0;
    achUnlocked = {}; achPopups = []; _scoreboardCache = null;
    cfg.shopItems = {}; cfg.wornItems = null; saveCfg();   // NOTE: cfg.debug (+ other settings) intentionally preserved
}