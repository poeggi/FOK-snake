// CONNECTION-INTERRUPTION recovery test (DEFAULT suite). Design goal: a brief link outage --
// a WiFi drop, a few lost seconds -- must be SURVIVED, not fatal. Both clients keep running
// (they tick, steer, boost and send as normal); only the wire goes dead for a fixed span, so
// each side mispredicts the other for the duration. On restore the redundant input log + the
// periodic state/hash resync must re-converge them, the CONNECTION LOST banner must clear, and
// the match must NOT session-end -- as long as the silence stayed under RB_PERSIST_KILL_MS (4s).
//
// The last row is a FALSIFICATION: an outage LONGER than the deadline MUST end the match. That
// proves the recovery cases pass because the link genuinely came back in time, not because the
// deadline never bites. A test where nothing can ever be fatal would rubber-stamp a broken kill.
//
// A real interruption DOES diverge the settled ring for its duration (peer inputs were lost), so
// firstDiverge is expected non-null here -- it is evidence the outage bit, not a failure. Recovery
// is judged by convergence AT SETTLE (the live state the resync repairs) + no kill + a cleared
// banner, never by "never diverged".
const { runMatch } = require('./duel-driver');

// RECOVER: a <RB_PERSIST_KILL_MS outage the match must ride out. 1.5s is the design floor the
// user named; 2.5s stresses the wider 4s window; each over a distinct adversity so recovery is
// not a single-wire fluke. secs leaves ample post-outage room for the resync to re-converge.
const RECOVER = [
    { name:'1.5s clean       ', secs:20, seed:0x77C0, wire:{ base:5, jit:2, loss:0 },
      phase:8, tjit:4, recv:true, outage:{ at:6, ms:1500 } },
    { name:'1.5s lossy+drift  ', secs:20, seed:0x77C0, wire:{ base:7, jit:3, loss:0.03 },
      phase:8, tjit:4, recv:true, clock:{ drift:1000, err0:40, samples:8 }, outage:{ at:6, ms:1500 } },
    { name:'2.5s clean       ', secs:22, seed:0x77C0, wire:{ base:6, jit:3, loss:0.02 },
      phase:8, tjit:4, recv:true, outage:{ at:6, ms:2500 } },
];

// FATAL control: an outage past the 4s deadline must end the match (the kill is real).
const FATAL = { name:'6s outage (ctrl)', secs:16, seed:0x77C0, wire:{ base:5, jit:2, loss:0 },
    phase:8, tjit:4, recv:true, outage:{ at:5, ms:6000 } };

const steps = [];
let failed = 0;

for(const sc of RECOVER){
    const r = runMatch(sc);
    // Recovered: converged at settle, the CONNECTION LOST banner actually showed during the outage
    // (fault exercised) and is clear at the end, no session-end, no own-head teleport, silence
    // peaked under the deadline. A gameplay duelOver is fine; only a session-end is a failure.
    const bad = !r.converged || r.exitReason === 'session-end' || !r.sawConnLost
        || r.endWarn !== null || r.localJumps > 0 || r.maxSilentMs >= 4000;
    steps.push(sc.name.trim().padEnd(18)
        + ' recovered=' + (r.converged && r.exitReason !== 'session-end' ? 'yes' : 'NO')
        + ' sawCL=' + (r.sawConnLost ? 'yes' : 'no')
        + ' maxSilent=' + Math.round(r.maxSilentMs) + 'ms'
        + ' endWarn=' + (r.endWarn || 'none')
        + ' selfJumps=' + r.localJumps
        + ' healed=' + (r.firstDiverge ? 'diverged->' + (r.converged ? 'yes' : 'NO') : 'never-split')
        + '   ' + (bad ? 'FAIL' : 'ok'));
    if(bad) failed++;
}

// Load-bearing falsification: an over-long outage MUST kill the match. If it does not, the
// deadline is dead and the recovery guard above is meaningless -- fail to force a look.
const f = runMatch(FATAL);
const fatalBad = f.exitReason !== 'session-end';
steps.push(FATAL.name.padEnd(18)
    + ' ended=' + (f.exitReason === 'session-end' ? 'yes' : 'NO')
    + ' at=' + (f.diedAt ? f.diedAt.toFixed(1) + 's' : '-')
    + ' maxSilent=' + Math.round(f.maxSilentMs) + 'ms'
    + '   ' + (fatalBad ? 'FAIL' : 'ok'));
if(fatalBad) failed++;

console.log(steps.join('\n'));
if(failed){
    console.log('\nDUEL-OUTAGE FAIL: ' + failed + ' case(s) -- a survivable interruption did not recover'
        + '\n  (no convergence / a session-end inside the window), or the over-long control did not kill.');
    process.exit(1);
}
console.log('\nDUEL-OUTAGE PASSED');
