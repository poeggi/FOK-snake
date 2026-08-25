// WALL-CLOCK DRIFT IMMUNITY (REGRESSION suite). The lockstep timeline must ride the MONOTONIC
// clock, never Date.now(). Date.now() is the OS wall clock, and the OS actively disciplines it --
// an NTP slew, or the step a phone takes when it foregrounds -- so anchoring the shared PTS to it
// let those adjustments leak straight into the timeline as drift. The field saw ~10ms in a minute
// (~167ppm), far past any crystal error; the cause was netPts()/the tick target reading Date.now().
// The fix (net.js/sim-worker.js _wall() = performance.timeOrigin + performance.now()) reads a wall
// value captured ONCE at context start and advanced by a monotonic clock that is never adjusted,
// so a later wall slew or step cannot move the timeline. This test proves that immunity two ways.
//
// The harness models it faithfully: performance.now() is the shared monotonic frame clock and the
// anchor error (err0) lives in performance.timeOrigin, while Date.now() carries err0 + a per-client
// DRIFT and can be STEPPED mid-match (__clkStep). So a huge drift and a fat mid-match step are, by
// construction, changes to Date.now() alone -- exactly the adjustments the timeline must ignore.
const { runMatch, mk } = require('./duel-driver');

const steps = [];
const ok = (c, m) => { steps.push((c ? 'ok  ' : 'ERR ') + m); if(!c) throw new Error(m); };

// ---- PART 1: the invariant, at the source. Boot one client into a duel (netPts defined), read the
// timeline and the wall clock, jump the wall by 500ms, and read both again with monotonic time held
// still. The wall must move; the timeline must NOT. On the pre-fix Date.now-anchored netPts, the
// timeline would jump the full 500ms with it -- so this line alone fails the instant the fix reverts.
{
    const C = mk('aaaaaaaa', 0x1234, 'host');
    C.__now = 1000;                                   // hold monotonic time fixed across the step
    const pts0 = C.__pts(), wall0 = C.__wallNow();
    C.__clkStep(500);                                 // an OS wall adjustment: Date.now jumps, timeOrigin does not
    const pts1 = C.__pts(), wall1 = C.__wallNow();
    steps.push(`STEP   wall ${wall0} -> ${wall1} (+${wall1 - wall0})   pts ${pts0} -> ${pts1} (+${pts1 - pts0})`);
    ok(wall1 - wall0 === 500, `the wall clock genuinely jumped 500ms (${wall0} -> ${wall1}) -- the perturbation is real`);
    ok(pts1 === pts0, `the monotonic timeline IGNORED the 500ms wall step (pts ${pts0} -> ${pts1}); it rides _wall(), not Date.now()`);
}

// ---- PART 2: the same immunity across a full match. Run an identical autopilot duel TWICE -- same
// seed, wire, schedule and anchor error -- differing ONLY in the wall clock: the CLEAN run has a
// steady wall, the PERTURBED run drives the joiner's Date.now 3% fast (30000ppm, ~60x any crystal)
// AND steps it +600ms at 12s (an NTP correction / foreground jump). Both are Date.now-only changes,
// so the timeline must be untouched: the rollback tallies must come out BYTE-IDENTICAL, and the
// perturbed run must converge with no divergence, no self-jump, no desync. On the pre-fix code the
// +600ms step alone jumps the joiner's tick target ~36 ticks and detonates a rollback storm / DESYNC.
// A lossy wire (5%) so the baseline actually rolls back -- redelivered-late inputs land in the past
// and re-sim. The drop pattern is a pure function of the seeded wire rng (identical in both runs),
// so the rollbacks it causes are identical too; the only difference on trial is the wall clock.
const base = { secs:32, seed:0x77C0, wire:{ base:10, jit:4, loss:0.05 }, phase:8, tjit:4, recv:true,
               clock:{ err0:12, drift:0, samples:8 } };
const clean = runMatch(base);
const pert  = runMatch({ ...base, clock:{ err0:12, drift:30000, samples:8 }, wallStep:{ at:12, ms:600, who:'B' } });

const fmt = (r)=> `L${r.levelReached} conv=${r.converged?'yes':'NO'} rb A/B=${r.rbA}/${r.rbB} `
    + `selfJumps=${r.localJumps} desync=${r.desyncA}/${r.desyncB}${r.exitReason?' exit='+r.exitReason:''}`
    + (r.firstDiverge?`  1stDiverge @${r.firstDiverge.tick} [${r.firstDiverge.fields.join(',')}]`:'');
steps.push('CLEAN  ' + fmt(clean));
steps.push('PERTURB' + fmt(pert));

ok(clean.levelReached >= 2, `the match is a real multi-level game (clean reached L${clean.levelReached})`);
ok(clean.converged, 'the clean baseline converges');
ok(pert.converged, 'the perturbed run STILL converges under a 3% wall drift + a 600ms wall step');
ok(!pert.firstDiverge, `the perturbed run never diverges (got ${pert.firstDiverge ? '@'+pert.firstDiverge.tick : 'none'})`);
ok(pert.exitReason !== 'session-end', 'the wall perturbation never triggers an OUT OF SYNC session-end');
ok(pert.localJumps === 0, `the perturbed run never teleports the local head (got ${pert.localJumps})`);
ok(pert.desyncA === 0 && pert.desyncB === 0, `no product desync under the perturbation (got ${pert.desyncA}/${pert.desyncB})`);
// The core claim: the timeline is a pure function of the MONOTONIC clock, so a Date.now-only storm
// changes nothing measurable. Identical rollback tallies is the strongest form of "did not flinch".
ok(pert.rbA === clean.rbA && pert.rbB === clean.rbB,
   `rollback tallies are byte-identical with and without the wall storm (clean ${clean.rbA}/${clean.rbB} vs perturbed ${pert.rbA}/${pert.rbB}) -- the wall clock has ZERO timeline influence`);
ok(pert.levelReached === clean.levelReached, `both runs reach the same level (${clean.levelReached} vs ${pert.levelReached})`);

console.log(steps.join('\n'));
console.log('\nduel-drift (the lockstep timeline rides the monotonic clock; wall slew/step is inert) PASSED');
