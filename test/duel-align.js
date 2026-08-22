// P2P CLOCK-ALIGNMENT primitive test (DEFAULT suite). During a duel the server clock sync is
// gated off (moving the anchor mid-play moves the tick timeline), so the two peers keep their
// clocks in step DIRECTLY: the joiner runs an NTP ping/pong against the host and steps its anchor
// onto the host's timeline at each level boundary. That alignment is what lets the host author ONE
// level-start PTS both sides read as the same instant -- so it has to be right, and the SIGN has
// to be right (a flipped sign DOUBLES the offset instead of cancelling it).
//
// This drives the raw ping/pong over a jittery/asymmetric wire with an injected clock offset and
// asserts two things:
//   1. the measured offset theta tracks the injected offset with the correct sign (min-RTT beats
//      the jitter);
//   2. APPLYING it steps the joiner's clock onto the host's -- their netPts() then agree to well
//      under one engine tick (16.67ms), which is all lockstep needs to start both on the same tick.
// A big-offset case (+120ms) also proves the future-gate bypass: such a pong lands in the joiner's
// "future" and the normal pts gate would drop exactly the samples alignment depends on.
const { mk } = require('./duel-driver');

const NET_BASE = 1784500000000;
const TICK = 1000 / 60;   // 16.67ms

function rng(seed){ let s = seed >>> 0; return ()=> (s = (s * 1103515245 + 12345) >>> 0) / 4294967296; }

// One NTP round trip joiner(B) -> host(A) -> joiner(B) over a wire with mean one-way `half` ms,
// +/-`jit` jitter, and a fixed one-way asymmetry `asym` (the B->A leg longer by asym). The shared
// frame clock is advanced so every stamp is taken at the true instant it happens.
function roundTrip(A, B, now, half, jit, asym, rnd){
    const dAB = Math.max(1, half + asym / 2 + (rnd() * 2 - 1) * jit);   // ping B->A (host-ward)
    const dBA = Math.max(1, half - asym / 2 + (rnd() * 2 - 1) * jit);   // pong A->B (joiner-ward)
    B.__now = now;
    B.__alignPing();
    const ping = B.__out.splice(0).find(j => { try { return JSON.parse(j).t === 'pa'; } catch (e) { return false; } });
    if(!ping) return;
    A.__now = now + dAB;
    A.__recv(ping);                       // host stamps t1, replies pao (t2 auto-stamped)
    const pong = A.__out.splice(0).find(j => { try { return JSON.parse(j).t === 'pao'; } catch (e) { return false; } });
    if(!pong) return;
    B.__now = now + dAB + dBA;
    B.__recv(pong);                       // joiner folds t3 -> theta
}

function measure(sc){
    const half = sc.half, jit = sc.jit, asym = sc.asym || 0, samples = sc.samples || 12;
    const A = mk('aaaaaaaa', 0xD0E1, 'host');
    const B = mk('bbbbbbbb', 0xD0E1, 'peer');
    A.__clkInstall(0, 0, NET_BASE);
    B.__clkInstall(sc.e0, (sc.drift || 0) * 1e-6, NET_BASE);   // joiner carries a frozen offset (+ optional drift)
    const rnd = rng(sc.seed || 0x51ED);
    let now = 0;
    for(let i = 0; i < samples; i++){ roundTrip(A, B, now, half, jit, asym, rnd); now += 40; }
    const theta = B.__alOfs(), n = B.__alN();
    B.__alignApply();                     // step the joiner's clock onto the host's
    A.__now = now; B.__now = now;
    const residual = B.__pts() - A.__pts();   // do the two shared-timeline clocks now agree?
    // Expected: theta ~= -e0 + asym/2 (the irreducible NTP asymmetry bias); residual ~= asym/2.
    return { theta, n, residual, wantTheta: -sc.e0 + asym / 2, wantResid: asym / 2 };
}

const SCEN = [
    { name:'offset +40  sym       ', e0:40,  half:6,  jit:3          },
    { name:'offset -25  jit6      ', e0:-25, half:12, jit:6          },
    { name:'offset +40  drift60   ', e0:40,  half:7,  jit:4, drift:60 },
    { name:'offset +50  asym10    ', e0:50,  half:10, jit:4, asym:10  },
    { name:'offset +120 (doze)    ', e0:120, half:5,  jit:5          },   // proves the future-gate bypass
];

const steps = [];
let failed = 0;
for(const sc of SCEN){
    const r = measure(sc);
    // theta must track the injected offset (sign + magnitude) within the jitter of the min-RTT sample;
    // the aligned clocks must agree to well under one tick (asymmetry bias aside, which is physical).
    const thetaOff = Math.abs(r.theta - r.wantTheta);
    const residOff = Math.abs(r.residual - r.wantResid);
    const okTheta = thetaOff <= sc.jit + 1;
    const okResid = residOff <= sc.jit + 1 && Math.abs(r.residual) < TICK;   // under a tick: same start tick both sides
    const bad = !(okTheta && okResid) || r.n < 1;
    steps.push(sc.name.trim().padEnd(22)
        + ' theta=' + r.theta.toFixed(1) + ' (want ' + r.wantTheta.toFixed(1) + ')'
        + ' resid=' + r.residual.toFixed(1) + ' (want ' + r.wantResid.toFixed(1) + ')'
        + ' n=' + r.n
        + '   ' + (bad ? 'FAIL' : 'ok'));
    if(bad) failed++;
}

console.log(steps.join('\n'));
if(failed){
    console.log('\nDUEL-ALIGN FAIL: ' + failed + '/' + SCEN.length + ' scenario(s) -- the joiner did not recover'
        + '\n  the peer clock offset (wrong sign/magnitude, or the aligned clocks still disagree by >1 tick).');
    process.exit(1);
}
console.log('\nDUEL-ALIGN PASSED');
