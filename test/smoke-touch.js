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

    // The first swipe is judged by its portion along the chosen axis: a 60 px stroke 38 degrees
    // off vertical sends UP only once it has 16 px of UP in it (the 5th 4.8 px sample); LEGACY
    // fires on the 16 px chord, one sample earlier, with 15 px of UP in it.
    s = swipe(poly([[0,0],[37,-47]], F, DT));
    let u = s.find(e => e.k === 'UP');
    if (!u || -u.y < 16) throw 'modern, slanted first swipe: UP after ' + (u ? -u.y : 'never') + ' px of up travel';
    if (turns(s) !== 'UP') throw 'modern, slanted first swipe sent: ' + dirs(s);
    cfg.touchLegacy = true; s = swipe(poly([[0,0],[37,-47]], F, DT)); cfg.touchLegacy = false;
    u = s.find(e => e.k === 'UP');
    if (!u || -u.y >= 16) throw 'legacy, slanted first swipe must fire on the chord, got UP after ' + (u ? -u.y : 'never') + ' px of up travel';
    log('modern: the first swipe fires on 16 px along its axis, legacy on 16 px of chord');

    // A thumb that drifts one way while waiting (too fast to count as resting, too slanted to
    // count as the sent direction) never has to undo the drift: the across reference re-anchors
    // where the across motion reverses, so the next move the other way is a turn at SWIPE_N.
    s = swipe(poly([[0,0],[30,0],[44.4,19.2,0.08],[44.4,-20.8]], F, DT));   // right 30, 300 ms creep down-right at 80 px/s, up 40
    u = s.find(e => e.k === 'UP');
    if (!u || 19.2 - u.y > 32) throw 'modern, drift then flick: UP after ' + (u ? Math.round(19.2 - u.y) : 'never') + ' px of up travel';
    if (s.some(e => e.k === 'DOWN')) throw 'modern, an 80 px/s drift of 19 px across sent DOWN';
    log('modern: a drifting hold does not tax the next move the other way');

    // REST is a state: a slow drift (under the 60 px/s floor) is read exactly like a still
    // finger. The state holds through the drift, the anchor follows it, and the next move is a
    // first swipe at 16 px from where it starts; the state ends when the finger moves again.
    s = swipe(poly([[0,0],[30,0],[37.2,9.6,0.04],[37.2,-30.4]], F, DT));   // right 30, 300 ms drift down-right at 40 px/s, up 40
    u = s.find(e => e.k === 'UP');
    if (!u || 9.6 - u.y > 21) throw 'modern, a move after a slow drift must be a first swipe (16 px), UP after ' + (u ? Math.round(9.6 - u.y) : 'never') + ' px';
    if (s.some(e => e.k === 'DOWN' || e.k === 'RIGHT' && s.indexOf(e) > 1)) throw 'modern, a slow drift sent: ' + dirs(s);
    if (_swipeResting) throw 'rest must end once the finger moves again';
    // ...and holds while the drift lasts (checked mid-drift, before the flick).
    const drift = poly([[0,0],[30,0],[37.2,9.6,0.04]], F, DT);
    players = null; phase = 'playing'; inGame = true; dir = { x:1, y:0 }; _swipeEnd(); sent.length = 0;
    cur = drift[0]; clk = drift[0].t; document.__emit('touchstart', ev(drift[0].x, drift[0].y));
    for (let i = 1; i < drift.length; i++){ cur = drift[i]; clk = drift[i].t; document.__emit('touchmove', ev(drift[i].x, drift[i].y)); }
    if (!_swipeResting) throw 'rest must hold while the finger drifts under the floor';
    if (_swipeLastDir !== null) throw 'the direction must stay forgotten through a drift';
    if (Math.hypot(_swipeBase.x - 37.2, _swipeBase.y - 9.6) > 6) throw 'the anchor must follow a drifting finger, it is ' + Math.round(Math.hypot(_swipeBase.x - 37.2, _swipeBase.y - 9.6)) + ' px behind';
    clk += 8; document.__emit('touchend', ev(37.2, 9.6)); phase = 'menu'; inGame = false;
    log('modern: a slow drift is a resting finger, the state holds and the next move is a first swipe');

    // LOW sensitivity lengthens the time gates and the anti-spiral guard by the distance factor
    // (1.33); HIGH leaves them at their MED values, never shorter. Legs of 70 px: held on LOW
    // (guard 85), sent on MED and HIGH (guard 64). A hold whose next sample lands 64 ms after
    // the last checkpoint: a rest on MED and HIGH (window 50 ms), still a slide on LOW (67 ms).
    const spiral70 = () => poly([[0,0],[70,0],[70,-70],[0,-70],[0,0]], F, DT);
    cfg.touchSens = 0; s = swipe(spiral70());
    if (turns(s) !== 'RIGHT UP LEFT') throw 'LOW: a 70 px third turn must be held by the 85 px guard, sent: ' + dirs(s);
    cfg.touchSens = 2; s = swipe(spiral70());
    if (turns(s) !== 'RIGHT UP LEFT DOWN') throw 'HIGH: the guard must stay at 64 px, sent: ' + dirs(s);
    const hold56 = () => poly([[0,0],[30,0],[30,0.5,0.5/56],[30,-40]], F, DT);   // right 30, hold 56 ms, up 40
    cfg.touchSens = 0; s = swipe(hold56()); u = s.find(e => e.k === 'UP');
    if (!u || -u.y < 30) throw 'LOW: a 64 ms gap must not count as rest (window 67 ms), UP after ' + (u ? -u.y : 'never') + ' px';
    cfg.touchSens = 2; s = swipe(hold56()); u = s.find(e => e.k === 'UP');
    if (!u || -u.y > 15) throw 'HIGH: a 64 ms gap must count as rest (window 50 ms), UP after ' + (u ? -u.y : 'never') + ' px';
    cfg.touchSens = 1;
    log('LOW lengthens the resting window and the guard by 1.33, HIGH keeps the MED values');

    // THE STEERING FINGER is named by its identifier; the newest finger to land takes over.
    // A holding thumb that landed first neither steers with its wobble nor ends the gesture
    // by lifting; a takeover releases the old finger's boost; a finger that vanishes from the
    // touch list without an end event ends the gesture like a lift.
    const T = (id, x, y) => ({ identifier: id, clientX: x, clientY: y });
    const mev = (touches, changed) => ({ touches, changedTouches: changed, preventDefault(){}, stopPropagation(){}, stopImmediatePropagation(){} });
    function reset(){ players = null; phase = 'playing'; inGame = true; dir = { x:1, y:0 }; boostDir = null; boosting = false; _swipeEnd(); _turnRun = 0; _turnSense = 0; sent.length = 0; clk = 0; }
    const holding = T(1, 60, 300);                      // a thumb resting low on the glass
    let f2 = T(2, 300, 200);                            // the steering thumb
    reset();
    document.__emit('touchstart', mev([holding], [holding]));
    clk = 20; document.__emit('touchstart', mev([holding, f2], [f2]));
    for (let i = 1; i <= 10; i++){ clk = 20 + i * 8; f2 = T(2, 300 + i * 4.8, 200); cur = f2; document.__emit('touchmove', mev([holding, f2], [f2])); }
    for (let i = 1; i <= 10; i++){ clk = 100 + i * 8; f2 = T(2, 348, 200 - i * 4.8); cur = f2; document.__emit('touchmove', mev([holding, f2], [f2])); }
    if (dirs(sent) !== 'RIGHT UP') throw 'newest finger must steer while a thumb rests: ' + dirs(sent);
    let before = sent.length;
    for (let i = 1; i <= 8; i++){ clk = 180 + i * 8; const h = T(1, 60 + i * 4.8, 300 + i * 2); document.__emit('touchmove', mev([h, f2], [h])); }   // the resting thumb wobbles 40 px
    if (sent.length !== before) throw 'a resting thumb wobble must not steer: ' + sent.slice(before).map(e => e.k).join(' ');
    clk = 260; document.__emit('touchend', mev([f2], [T(1, 98, 316)]));   // the resting thumb lifts
    if (sent.length !== before) throw 'a resting thumb lifting must end nothing: ' + sent.slice(before).map(e => e.k).join(' ');
    for (let i = 1; i <= 10; i++){ clk = 260 + i * 8; f2 = T(2, 348 - i * 4.8, 152); cur = f2; document.__emit('touchmove', mev([f2], [f2])); }
    if (dirs(sent) !== 'RIGHT UP LEFT') throw 'the gesture must survive the other thumb lifting: ' + dirs(sent);
    before = sent.length;
    clk = 350; document.__emit('touchend', mev([], [f2]));
    if (sent[sent.length - 1].k !== 'boost-' || _swipeBase) throw 'the steering finger lifting must end the gesture';
    log('steering finger: newest lands and steers, a resting thumb neither steers nor ends the gesture');

    // A takeover mid-boost: the boost of the sliding finger is released when a new finger
    // lands, further moves of the old finger are ignored, the new finger steers.
    reset();
    f2 = T(2, 100, 200);
    document.__emit('touchstart', mev([f2], [f2]));
    for (let i = 1; i <= 28; i++){ clk = i * 8; f2 = T(2, 100 + i * 4.8, 200); cur = f2; document.__emit('touchmove', mev([f2], [f2])); }   // 134 px slide
    if (!boosted(sent)) throw 'a 134 px slide must engage boost';
    before = sent.length;
    let f3 = T(3, 400, 300);
    clk = 240; document.__emit('touchstart', mev([f2, f3], [f3]));
    if (sent[sent.length - 1].k !== 'boost-') throw 'a takeover must release the boost of the old finger: ' + sent.slice(before).map(e => e.k).join(' ');
    before = sent.length;
    for (let i = 1; i <= 10; i++){ clk = 240 + i * 8; f2 = T(2, 234 + i * 4.8, 200); document.__emit('touchmove', mev([f2, f3], [f2])); }   // the old finger keeps sliding
    if (sent.length !== before) throw 'the old finger must be ignored after a takeover: ' + sent.slice(before).map(e => e.k).join(' ');
    for (let i = 1; i <= 10; i++){ clk = 320 + i * 8; f3 = T(3, 400, 300 - i * 4.8); cur = f3; document.__emit('touchmove', mev([f2, f3], [f3])); }
    if (dirs(sent.slice(before)) !== 'UP') throw 'the new finger must steer after a takeover: ' + dirs(sent.slice(before));
    // The steering finger vanishes from the touch list without an end event: the gesture ends.
    before = sent.length;
    clk = 420; document.__emit('touchmove', mev([f2], [f2]));
    if (sent[sent.length - 1].k !== 'boost-' || _swipeBase) throw 'a vanished steering finger must end the gesture';
    reset(); phase = 'menu'; inGame = false;
    log('steering finger: a takeover releases the boost and hands over, a vanished finger ends the gesture');

    // A touchstart with the SAME identifier while a gesture is armed (an end the browser never
    // delivered) releases the boost too.
    reset(); f2 = T(2, 100, 200);
    document.__emit('touchstart', mev([f2], [f2]));
    for (let i = 1; i <= 28; i++){ clk = i * 8; f2 = T(2, 100 + i * 4.8, 200); cur = f2; document.__emit('touchmove', mev([f2], [f2])); }
    if (!boosted(sent)) throw 'a 134 px slide must engage boost';
    clk = 240; document.__emit('touchstart', mev([f2], [f2]));
    if (sent[sent.length - 1].k !== 'boost-') throw 'a touchstart with the same identifier while armed must release the boost';
    log('steering finger: the same identifier landing again releases the boost');

    // A dialog that opens under a finger planted in play must not take the lift as its answer,
    // with or without TOUCH AUTOSELECT; a tap that begins and ends on the same screen still does.
    const keys2 = []; const oH2 = handleKey; handleKey = function(k, pde){ keys2.push(k); return oH2(k, pde); };
    reset(); f2 = T(2, 300, 200); clk = 0;
    document.__emit('touchstart', mev([f2], [f2]));
    cfg.touchSelect = true; prevPhase = 'playing'; quitConfirmSel = 1; phase = 'quitConfirm';
    clk = 100; document.__emit('touchend', mev([], [T(2, 302, 201)]));
    if (keys2.indexOf('Enter') >= 0) throw 'a lift on a dialog that opened under a planted finger pressed Enter';
    cfg.touchSelect = false;
    phase = 'scores'; inGame = false; scoresTab = 0; keys2.length = 0; clk = 0;
    document.__emit('touchstart', mev([f2], [f2])); clk = 60; document.__emit('touchend', mev([], [f2]));
    if (keys2.indexOf('Enter') < 0) throw 'a tap that begins and ends on the same screen must still press Enter';
    handleKey = oH2; phase = 'menu';
    log('a lift answers only the screen the touch began on');

    // A slide carried from GET READY into play is a fresh first swipe after GO, never an instant
    // boost: the gesture re-anchors at the finger and forgets its direction on the flip.
    reset(); phase = 'levelReady'; inGame = true; f2 = T(2, 300, 300); clk = 0;
    document.__emit('touchstart', mev([f2], [f2]));
    for (let i = 1; i <= 20; i++){ clk = i * 8; f2 = T(2, 300, 300 - i * 4.8); cur = f2; document.__emit('touchmove', mev([f2], [f2])); }   // 96 px up before GO
    phase = 'playing';
    for (let i = 21; i <= 30; i++){ clk = i * 8; f2 = T(2, 300, 300 - i * 4.8); cur = f2; document.__emit('touchmove', mev([f2], [f2])); }  // 48 px more after GO
    if (boosted(sent)) throw 'a slide carried from GET READY into play boosted at once';
    if (dirs(sent) !== 'UP') throw 'the slide after GO must be read as a first swipe: ' + dirs(sent);
    reset(); phase = 'menu'; inGame = false;
    log('a touch running from GET READY into play carries nothing over');

    // A thumb curling back-and-up (mostly up) is a turn, not a brake.
    s = swipe(poly([[0,0],[60,0],[40,-34.6]], F, DT));
    if (turns(s) !== 'RIGHT UP') throw 'a thumb curling back-and-up must turn, sent: ' + dirs(s);
    log('modern: a thumb curling back-and-up turns rather than brakes');

    // A slide along a BRAKE direction re-anchors like any slide (the reverse is re-sent every
    // SWIPE_SAME, refused by the sim) but never arms a boost: the snake will not take that
    // heading. A slide along a direction that was a real turn still arms, and a brake as the
    // first key of a touch (judged against the heading) arms nothing either.
    s = swipe(poly([[0,0],[40,0],[-80,0],[-80,-40]], F, DT), { boost: { x:1, y:0 } });   // boosting right: pull back 120, up 40
    let li = s.findIndex(e => e.k === 'LEFT');
    if (li < 0 || !s[li + 1] || s[li + 1].k !== 'boost-') throw 'a pull-back must brake: ' + s.map(e => e.k).join(' ');
    if (s.filter(e => e.k === 'LEFT').length < 2) throw 'a continued pull-back must keep re-anchoring (the reverse re-sent every 48 px): ' + dirs(s);
    if (s.some((e, i) => e.k === 'boost+')) throw 'a slide along the brake direction armed a boost: ' + s.map(e => e.k).join(' ');
    u = s.find(e => e.k === 'UP');
    if (!u || -u.y > 30) throw 'a turn out of a pull-back must cost the turn distance from the finger, UP after ' + (u ? -u.y : 'never') + ' px';
    s = swipe(poly([[0,0],[40,0],[40,-40],[-60,-40]], F, DT));   // right, up, then a long slide left: a real turn, then its slide
    if (!boosted(s)) throw 'a slide along a real turn must still arm the boost: ' + s.map(e => e.k).join(' ');
    s = swipe(poly([[0,0],[-70,0]], F, DT));   // first key of the touch is the reverse of the heading
    if (dirs(s).indexOf('LEFT') < 0) throw 'a first-swipe brake must be sent: ' + dirs(s);
    if (boosted(s)) throw 'a slide along a first-swipe brake armed a boost: ' + s.map(e => e.k).join(' ');
    log('a slide along a brake direction re-anchors and never arms a boost; a slide along a real turn still does');

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

    // A held turn must not shadow the brake: right, up, left, a 40 px down the guard holds, then
    // the finger pulls back right 50 px. Back outgrows the held across, so the reverse of LEFT
    // is sent as the brake (the sim refuses it) and the held DOWN never fires.
    s = swipe(poly([[0,0],[30,0],[30,-30],[0,-30],[0,10],[50,10]], F, DT));
    if (turns(s) !== 'RIGHT UP LEFT RIGHT') throw 'modern, brake under a held turn sent: ' + dirs(s);
    log('modern: pulling back under a held spiral turn still brakes');

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
