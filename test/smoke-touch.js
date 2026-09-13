// Swipe readers (js/input.js _swipeRead): the MODERN reader sends the turn the finger made
// however long the stroke before it, sends nothing for a resting finger's creep, and keeps
// the same-direction (boost) cadence of a straight slide; LEGACY is selectable and keeps its
// shape (its overshoot and creep readings are what prove the switch picks the old reader).
// Traces are finger paths in CSS px, sampled every 8 ms at 0.6 px/ms (a brisk thumb, ~120 Hz),
// driven through the REAL document touch handlers in a live classic game.
// Run: node test/smoke-touch.js
const { runTest } = require('./harness');

runTest('SMOKE-TOUCH', `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const log = (m) => R.steps.push(m);
  try {
    let clk = 0;
    performance.now = () => clk;
    for (const id of ['gamepad','btn-mute','fps-el','dbg-snap'])
      document.getElementById(id).getBoundingClientRect = () => ({ left:0, top:0, width:0, height:0, right:0, bottom:0 });
    simNow = 100000; _splashExiting = false; _splashLeftAt = -1e9; _splashKeyHeld = false; cfg.debug = 0;
    let cur = { x:0, y:0 };
    const sent = [];
    const oSteer = gameSteer, oBs = gameBoostStart, oBe = gameBoostEnd;
    gameSteer = function(p, d){ sent.push({ k: d.y<0?'UP':d.y>0?'DOWN':d.x<0?'LEFT':'RIGHT', x: cur.x, y: cur.y }); };
    gameBoostStart = function(){ sent.push({ k:'boost+', x: cur.x, y: cur.y }); };
    gameBoostEnd = function(){ sent.push({ k:'boost-', x: cur.x, y: cur.y }); };
    const ev = (x, y) => ({ touches:[{clientX:x, clientY:y}], changedTouches:[{clientX:x, clientY:y}], preventDefault(){}, stopPropagation(){}, stopImmediatePropagation(){} });
    // A polyline sampled every dt ms at speed px/ms; a third value on a point overrides the speed to it.
    function poly(pts, speed, dt){
      const out = [{ x:pts[0][0], y:pts[0][1], t:0 }];
      let t = 0, x = pts[0][0], y = pts[0][1];
      for (let i = 1; i < pts.length; i++){
        const tx = pts[i][0], ty = pts[i][1], sp = pts[i][2] != null ? pts[i][2] : speed;
        const dx = tx - x, dy = ty - y, len = Math.hypot(dx, dy);
        const n = Math.max(1, Math.round(len / (sp * dt)));
        for (let k = 1; k <= n; k++){ t += dt; out.push({ x: x + dx * k / n, y: y + dy * k / n, t }); }
        x = tx; y = ty;
      }
      return out;
    }
    function arc(lead, r, tail){   // right, a quarter circle of radius r, then up
      const pts = [[0,0],[lead,0]];
      for (let i = 1; i <= 12; i++){ const a = i / 12 * Math.PI / 2; pts.push([lead + r * Math.sin(a), -(r - r * Math.cos(a))]); }
      pts.push([lead + r, -(r + tail)]);
      return poly(pts, 0.6, 8);
    }
    // One finger path through the real handlers, heading right in a live classic game.
    function swipe(trace, o){
      o = o || {};
      players = null; phase = 'playing'; inGame = true; dir = { x:1, y:0 };
      boostDir = o.boost || null; boosting = !!o.boost; snake = [{x:5,y:5},{x:4,y:5}];
      _swipeBase = null; _swipeFollow = null; _swipeLastDir = null; _swipeLastMovePos = null; _turnRun = 0; _turnSense = 0;
      sent.length = 0;
      cur = trace[0]; clk = trace[0].t; document.__emit('touchstart', ev(trace[0].x, trace[0].y));
      for (let i = 1; i < trace.length; i++){ cur = trace[i]; clk = trace[i].t; document.__emit('touchmove', ev(trace[i].x, trace[i].y)); }
      const e = trace[trace.length - 1]; clk = e.t + 8; document.__emit('touchend', ev(e.x, e.y));
      phase = 'menu'; inGame = false;
      return sent.slice();
    }
    const dirs = s => s.filter(e => e.k !== 'boost+' && e.k !== 'boost-').map(e => e.k).join(' ');
    const turns = s => dirs(s).split(' ').filter((k, i, a) => i === 0 || k !== a[i - 1]).join(' ');   // a same-direction repeat (the boost slide) folded away
    const boosted = s => s.some(e => e.k === 'boost+');
    const upAt = s => { const u = s.find(e => e.k === 'UP'); return u ? -u.y : null; };
    const F = 0.6, DT = 8;
    const T_B = () => poly([[0,0],[60,0],[60,-40]], F, DT);             // a long stroke, then up
    const T_D = () => arc(30, 40, 30);                                   // a fast rounded corner
    const T_J = () => poly([[0,0],[20,0],[50,0,0.08],[50,-24]], F, DT);  // a slow drift, then an honest up swipe
    const T_K = () => poly([[0,0],[20,0],[34,18,0.05]], F, DT);          // a resting thumb creeps
    const T_A = () => poly([[0,0],[40,0],[40,-40]], F, DT);              // the textbook corner

    // The setting: MODERN by default, one CONTROLS row flips it.
    if (cfg.touchLegacy !== false) throw 'touchLegacy must default to false (MODERN), got ' + cfg.touchLegacy;
    const row = SETTINGS_CATS.find(c => c.label === 'CONTROLS').items.find(it => it.lbl().indexOf('TOUCH DETECT') === 0);
    if (!row) throw 'CONTROLS has no TOUCH DETECT row';
    if (row.lbl() !== 'TOUCH DETECT: MODERN') throw 'default label: ' + row.lbl();
    row.act(); if (!cfg.touchLegacy || row.lbl() !== 'TOUCH DETECT: LEGACY') throw 'act() did not switch to LEGACY: ' + row.lbl();
    row.act(); if (cfg.touchLegacy) throw 'act() did not switch back to MODERN';
    log('TOUCH DETECT row: MODERN by default, act() toggles LEGACY');

    // MODERN: the turn costs SWIPE_N of across travel, whatever the stroke before it.
    cfg.touchLegacy = false;
    let s = swipe(T_B());
    if (dirs(s) !== 'RIGHT UP' || boosted(s)) throw 'modern, long stroke then up: ' + dirs(s) + (boosted(s) ? ' +boost' : '');
    s = swipe(T_D());
    if (dirs(s) !== 'RIGHT UP' || boosted(s)) throw 'modern, rounded corner: ' + dirs(s) + (boosted(s) ? ' +boost' : '');
    if (upAt(s) > 42) throw 'modern, rounded corner: UP sent only after ' + upAt(s) + ' px of up travel';   // legacy: 45 px, with a false boost
    s = swipe(T_J());
    if (dirs(s) !== 'RIGHT UP') throw 'modern, drift then up: ' + dirs(s);
    s = swipe(T_K());
    if (dirs(s) !== 'RIGHT') throw 'modern, a creeping finger sent: ' + dirs(s);
    s = swipe(T_A());
    if (dirs(s) !== 'RIGHT UP' || boosted(s)) throw 'modern, textbook corner: ' + dirs(s);
    for (let n = 20; n <= 120; n += 10){
      s = swipe(poly([[0,0],[n,0],[n,-40]], F, DT));
      const u = upAt(s);
      if (u == null || u > 32) throw 'modern, right ' + n + ' then up 40: UP at ' + u + ' px';
    }
    log('modern: overshoot, rounded corner, drift and creep read as the finger meant; a turn costs 24 px at every stroke length');

    // A slanted stroke is ONE stroke: its sideways component never piles up into a second turn
    // while the finger still runs within 50 degrees of the sent direction. Below the turn
    // distance nothing turns at all, however many small steps add up.
    s = swipe(poly([[0,0],[50,-87]], F, DT));                       // 100 px at 30 deg off vertical
    if (turns(s) !== 'UP') throw 'modern, 100 px stroke 30 deg off vertical sent: ' + dirs(s);
    s = swipe(poly([[0,0],[40,0],[65,-43]], F, DT));                // right 40, then 50 px at 30 deg off vertical
    if (turns(s) !== 'RIGHT UP') throw 'modern, right then a slanted up sent: ' + dirs(s);
    s = swipe(poly([[0,0],[20,0],[20,-20],[40,-20],[40,-40],[60,-40],[60,-60]], F, DT));   // 20 px staircase
    if (dirs(s) !== 'RIGHT') throw 'modern, 20 px staircase (below the turn distance) sent: ' + dirs(s);
    log('modern: a slanted stroke is one turn, a sub-threshold staircase is none');

    // A straight slide keeps its same-direction cadence (the boost slide) in both readers: the
    // duel wire counts on one same-direction record per SWIPE_SAME, never more.
    const slide = poly([[0,0],[130,0]], F, DT);
    cfg.touchLegacy = false; const sm = swipe(slide);
    cfg.touchLegacy = true;  const sl = swipe(slide);
    if (dirs(sm) !== dirs(sl) || dirs(sm) !== 'RIGHT RIGHT RIGHT') throw 'slide cadence differs: modern ' + dirs(sm) + ' vs legacy ' + dirs(sl);
    if (!boosted(sm) || !boosted(sl)) throw 'a sustained slide must engage boost in both readers';
    log('a straight slide sends the same direction every 48 px and engages boost, identically in both readers');

    // The anti-spiral guard is shared: the third same-way turn in one gesture needs SWIPE_GUARD
    // (64 px); a shorter one is held.
    cfg.touchLegacy = false;
    s = swipe(poly([[0,0],[30,0],[30,-30],[0,-30],[0,0]], F, DT));
    if (dirs(s) !== 'RIGHT UP LEFT') throw 'modern spiral guard, 30 px legs: ' + dirs(s);
    s = swipe(poly([[0,0],[70,0],[70,-70],[0,-70],[0,0]], F, DT));   // a 70 px leg also passes the 48 px same-direction mark
    if (turns(s) !== 'RIGHT UP LEFT DOWN') throw 'modern spiral guard, 70 px legs: ' + dirs(s);
    log('modern: the anti-spiral guard holds a 30 px third turn and lets a 70 px one through');

    // The brake: while boosting right, a slide back from the furthest point ends the boost at
    // SWIPE_1 (the sim refuses the reverse, so it never turns the snake).
    s = swipe(poly([[0,0],[40,0],[20,0]], F, DT), { boost: { x:1, y:0 } });
    const bi = s.findIndex(e => e.k === 'LEFT');
    if (bi < 0 || s[bi + 1] == null || s[bi + 1].k !== 'boost-') throw 'modern brake: ' + s.map(e => e.k).join(' ');
    if (s[bi].x > 24) throw 'modern brake fired late, at x=' + s[bi].x;
    log('modern: a reverse slide is the brake, 16 px back from the furthest point');

    // LEGACY keeps its shape, which is what proves the switch selects the old reader.
    cfg.touchLegacy = true;
    s = swipe(T_B());
    if (dirs(s) !== 'RIGHT RIGHT' || !boosted(s)) throw 'legacy, long stroke then up: ' + dirs(s) + (boosted(s) ? ' +boost' : '');
    s = swipe(T_K());
    if (dirs(s) !== 'RIGHT DOWN') throw 'legacy, creeping finger: ' + dirs(s);
    s = swipe(T_A());
    if (dirs(s) !== 'RIGHT UP') throw 'legacy, textbook corner: ' + dirs(s);
    log('legacy: the overshoot loses the turn and boosts, the creep turns down, the textbook corner works');

    // Menus read the chord whatever the setting: a vertical swipe scrolls one step at
    // MENU_SWIPE_1, the next at MENU_SWIPE_SAME.
    cfg.touchLegacy = false;
    const keys = [];
    const oHandle = handleKey;
    handleKey = function(k, pde){ keys.push(k); return oHandle(k, pde); };
    phase = 'menu'; menuSel = 0; inGame = false;
    _swipeBase = null; _swipeFollow = null; _swipeLastDir = null; _swipeLastMovePos = null;
    clk = 0; document.__emit('touchstart', ev(300, 200));
    for (let i = 1; i <= 12; i++){ clk = i * 8; document.__emit('touchmove', ev(300, 200 - i * 8)); }   // 96 px up in 8 px steps
    clk = 104; document.__emit('touchend', ev(300, 104));
    handleKey = oHandle;
    if (keys.join(' ') !== 'ArrowUp ArrowUp') throw 'menu swipe steps: ' + keys.join(' ');
    log('menus keep the chord reader: one step at 24 px, the next at 48 px');

    gameSteer = oSteer; gameBoostStart = oBs; gameBoostEnd = oBe;
    cfg.touchLegacy = false; phase = 'menu'; inGame = false; players = null;
    R.ok = true;
  } catch (e) { R.err = e && e.stack ? e.stack : String(e); }
})();
`);
