// GUARD: the free-touch (swipe) input path must NOT flood the duel wire with redundant
// same-direction steer records -- one held gesture in one direction is one intent, and must
// author no more than the dpad does for the same gesture. A genuine turn must still author.
//
// Field report that motivated this (iPhone client + PC, 1:1 duel): travelling in ONE direction
// and then pressing the SAME direction again --
//   * via the on-screen DPAD  -> a clean 3 applies on the peer (1 steer + boost-start + boost-end)
//   * via a free-touch SWIPE  -> USED TO give "multiple" live/rollback applies for that one gesture
// The swipe touchmove re-bases _swipeBase to the finger position after every commit
// (js/input.js) and re-fires a steer every SWIPE_SAME (48px) of continued travel; the dpad
// (`d!==dpadActive`) and keyboard (`e.repeat`) suppress the repeat, the swipe did not. So a slide
// spanning many ticks authored one same-direction no-op per 48px -- each a wire record the peer
// had to live-apply or roll back, for a snake that never turned.
//
// The fix is the intent-change gate in netLocalInput (js/duel-core.js): a dir is authored only
// when it is NOT provably a no-op -- provably-redundant means it equals BOTH our last authored dir
// and our snake's current heading (so the sim would discard it on both clients). It is source-
// agnostic (keyboard/dpad/swipe all funnel through netLocalInput) and, by also requiring the
// current heading to match, it never mis-suppresses the real turn after a respawn/level heading
// reset. This test boots two real clients in lockstep over a simulated wire, drives BOTH gestures
// through the REAL input code, and counts (a) the records the actor AUTHORS and (b) the live+rb
// applies the peer registers -- the very counter the player was watching.
const { mk, NET_BASE } = require('./duel-driver');

const TICK = mk('x', 1, 'host').__TICK;
const LAT = 3 * TICK;   // ~3-tick one-way latency: realistic, and enough that a late record rolls back

// Two full clients (A = the actor / "iPhone", index 0 heading RIGHT; B = the watcher / "PC")
// in real lockstep at simTick 0, with A's swipe control-mask neutralised (the elStub reports a
// 600x400 rect for every id, which would otherwise mask the whole screen). Returns an `adv`
// that advances both sims one engine tick at a time, carrying the wire both ways with latency.
function boot(seed) {
    const A = mk('aaaaaaaa', seed, 'host'), B = mk('bbbbbbbb', seed, 'peer');
    A.__clkInstall(0, 0, NET_BASE); B.__clkInstall(0, 0, NET_BASE);
    for (const id of ['gamepad', 'btn-mute', 'fps-el'])
        A.document.getElementById(id).getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 });
    let clock = 0; const wAB = [], wBA = [];
    const adv = (n, onTick) => {
        for (let i = 0; i < n; i++) {
            clock += TICK; A.__now = clock; B.__now = clock;
            for (let j = wAB.length - 1; j >= 0; j--) if (wAB[j][0] <= clock) { B.__recv(wAB[j][1]); wAB.splice(j, 1); }
            for (let j = wBA.length - 1; j >= 0; j--) if (wBA[j][0] <= clock) { A.__recv(wBA[j][1]); wBA.splice(j, 1); }
            if (onTick) onTick(clock);
            A.__tick1(); B.__tick1();
            for (const t of A.__out.splice(0)) wAB.push([clock + LAT, t]);
            for (const t of B.__out.splice(0)) wBA.push([clock + LAT, t]);
        }
    };
    adv(120);   // clear the READY+GO countdown into phase 'duel' and settle the pair in lockstep
    return { A, B, adv };
}

// A synthetic DOM touch event carrying every method the document touch listeners call.
const ev = (x, y) => ({
    touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }],
    preventDefault() {}, stopImmediatePropagation() {}, stopPropagation() {},
});

// Count the input records (dir/bs/be) the actor authored across a tick window, split into
// same-direction dir (sim no-ops), other-direction dir (real turns), and boost transitions.
function authored(A, lo, hi, heading) {
    const tag = '(' + heading.x + ',' + heading.y + ')';
    let dir = 0, same = 0, other = 0, boost = 0;
    for (const [, cmds] of A.__logRange(lo, hi)) for (const c of cmds) {
        if (c.startsWith('dir')) { dir++; if (c.includes(tag)) same++; else other++; }
        else boost++;
    }
    return { total: dir + boost, dir, same, other, boost };
}

const steps = [];
const ok = (c, m) => { steps.push((c ? 'ok  ' : 'ERR ') + m); if (!c) throw new Error(m); };

// ---------------------------------------------------------------------------
// DPAD baseline. The dpad handlers (js/input.js) fire, ONCE each: a steer on touchstart, an arm
// on touchstart, an arm-release on touchend -- a held finger in one zone re-fires nothing
// (`if(d!==dpadActive)`) and in-game auto-repeat is suppressed. So the exact three calls below
// ARE the dpad's whole emission for "press the way I'm already going, hold, release": a clean 3.
function runDpad() {
    const { A, B, adv } = boot(0xD0E1);
    const heading = (() => { const v = A.__view(); return { x: v.dx, y: v.dy }; })();
    const t0 = A.__simTick();
    const b0 = B.__rbDbg(); const lr0 = b0.live + b0.rb;
    const y0 = A.__view().hy;
    A.__steer(heading);         // dpad touchstart: handleKey -> gameSteer (one steer, same direction)
    A.__boost(heading, false);  // dpad touchstart: gameBoostStart (one arm)
    adv(20);                    // finger held in-zone: the dpad touchmove path emits nothing
    A.__boostEnd();             // dpad touchend: one gameBoostEnd
    adv(30);                    // drain the wire into B
    const b1 = B.__rbDbg(); const lr1 = b1.live + b1.rb;
    const a = authored(A, t0 - 2, A.__simTick() + 5, heading);
    return { authored: a, applied: lr1 - lr0, turned: A.__view().hy !== y0 };
}

// ---------------------------------------------------------------------------
// SWIPE, same direction: finger down, then a continuous SAME-direction slide, then release --
// driven through the REAL document touch listeners. `moves` 16px steps at one engine tick each
// (~a real finger sliding ~16px/16ms). With the gate in place this must collapse onto the dpad.
function runSwipe(moves) {
    const { A, B, adv } = boot(0xD0E1);
    const heading = (() => { const v = A.__view(); return { x: v.dx, y: v.dy }; })();   // {1,0}: heading RIGHT
    const t0 = A.__simTick();
    const b0 = B.__rbDbg(); const lr0 = b0.live + b0.rb;
    const y0 = A.__view().hy;
    const cx = 300, cy = 200; let px = cx;
    A.__now += 5; A.document.__emit('touchstart', ev(px, cy));
    for (let m = 1; m <= moves; m++) adv(1, () => { px = cx + m * 16; A.document.__emit('touchmove', ev(px, cy)); });
    adv(1, () => A.document.__emit('touchend', ev(px, cy)));
    adv(30);
    const b1 = B.__rbDbg(); const lr1 = b1.live + b1.rb;
    const a = authored(A, t0 - 2, A.__simTick() + 5, heading);
    return { authored: a, applied: lr1 - lr0, turned: A.__view().hy !== y0 };
}

// ---------------------------------------------------------------------------
// SWIPE that TURNS: slide RIGHT (same direction: suppressed) then UP (a real 90-turn: authored),
// each leg `len` 16px steps. Proves the gate is provably-redundant-only, not an fps cap: the real
// turn survives, the snake actually turns, and the count is bounded by the turn (not the slide
// length) -- a couple of same-direction records may straggle through in the headroom window before
// the sim applies the turn, but that is O(1) per turn, never one-per-48px.
function runTurnSwipe(len) {
    const { A, adv } = boot(0xD0E1);
    const t0 = A.__simTick();
    const y0 = A.__view().hy;
    const cx = 300, cy = 200; let px = cx, py = cy;
    A.__now += 5; A.document.__emit('touchstart', ev(px, cy));
    for (let m = 1; m <= len; m++) adv(1, () => { px = cx + m * 16; A.document.__emit('touchmove', ev(px, cy)); });
    for (let k = 1; k <= len; k++) adv(1, () => { py = cy - k * 16; A.document.__emit('touchmove', ev(px, py)); });
    adv(1, () => A.document.__emit('touchend', ev(px, py)));
    adv(30);
    let dir = 0, up = 0;
    for (const [, cmds] of A.__logRange(t0 - 2, A.__simTick() + 5)) for (const c of cmds)
        if (c.startsWith('dir')) { dir++; if (c.includes('(0,-1)')) up++; }   // {0,-1} == UP, the real turn
    return { dir, up, turned: A.__view().hy !== y0 };
}

const dpad = runDpad();
const sw30 = runSwipe(30);
const sw60 = runSwipe(60);
const turn15 = runTurnSwipe(15);
const turn60 = runTurnSwipe(60);

steps.push(`DPAD          : authored ${dpad.authored.total} (dir ${dpad.authored.dir}, boost ${dpad.authored.boost})  -> peer live+rb ${dpad.applied}`);
steps.push(`SWIPE 30 moves: authored ${sw30.authored.total} (dir ${sw30.authored.dir}, boost ${sw30.authored.boost})  -> peer live+rb ${sw30.applied}`);
steps.push(`SWIPE 60 moves: authored ${sw60.authored.total} (dir ${sw60.authored.dir}, boost ${sw60.authored.boost})  -> peer live+rb ${sw60.applied}`);
steps.push(`SWIPE turn 15+15 / 60+60: dir ${turn15.dir} / ${turn60.dir} (real UP turn ${turn15.up} / ${turn60.up}, turned ${turn15.turned}/${turn60.turned})`);

// The clean baseline: dpad's whole gesture is 3 records (1 no-op steer + boost start/end), and
// the peer applies exactly those 3 -- the "3 live applies" the player saw.
ok(dpad.authored.total === 3, `dpad authors exactly 3 records (got ${dpad.authored.total})`);
ok(dpad.applied === 3, `peer registers exactly 3 applies for the dpad (got ${dpad.applied})`);
ok(dpad.authored.boost === 2, `dpad emits one boost-start + one boost-end (got ${dpad.authored.boost})`);

// THE GUARD: a continuous same-direction swipe collapses onto the dpad -- no per-48px flood. The
// gate suppresses every same-direction no-op after the first, so the swipe authors exactly what
// the dpad does (one no-op steer + the two boost transitions), and the peer applies exactly 3.
ok(sw30.authored.total === dpad.authored.total, `swipe collapses onto the dpad count (${sw30.authored.total} == ${dpad.authored.total})`);
ok(sw30.authored.dir === 1, `the swipe authors a single steer, not one per 48px (got ${sw30.authored.dir})`);
ok(sw30.applied === 3, `the peer registers exactly 3 applies for the swipe (got ${sw30.applied})`);
ok(sw30.turned === false, 'the swipe never turned the snake: the one steer is a same-direction no-op');

// It no longer scales with GESTURE LENGTH: a longer hold in the same direction authors the same.
ok(sw60.authored.dir === sw30.authored.dir, `the count is bounded by intent, not slide length (60-move ${sw60.authored.dir} == 30-move ${sw30.authored.dir})`);

// Provably-redundant ONLY: a genuine turn is never dropped. The RIGHT->UP swipe authors the real
// UP turn, the snake turns, and the count stays bounded by the turn (not the slide length).
ok(turn15.up >= 1 && turn15.turned === true, 'a real turn in a swipe is authored and turns the snake');
ok(turn60.up >= 1 && turn60.turned === true, 'the real turn survives at 4x the slide length too');
ok(turn60.dir <= turn15.dir + 1, `turn records are bounded by the turn, not the slide length (60+60 ${turn60.dir} ~ 15+15 ${turn15.dir})`);

console.log(steps.join('\n'));
console.log('\nduel-touch (swipe redundancy suppressed, real turns preserved) PASSED');
