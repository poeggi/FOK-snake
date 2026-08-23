// CONNECTION-LOST banner debounce (DEFAULT suite). Field report: during SMOOTH duel play the
// "CONNECTION LOST" banner flashes for a moment and then self-heals -- with no stall, no level
// change, and the match continuing fine. Under independent device clocks a lone peer packet
// occasionally lands outside the accept window (a jitter/clock-estimate transient) and is
// refused; the redundant resend re-delivers that same input a beat later at a usable tick, so
// the two worlds never actually diverge. But refusing ONE packet used to arm the banner for a
// full NET_WARN_FLASH_MS (3s) -- a scary, meaningless flash on an otherwise healthy link.
//
// The rule (js/duel-core.js _rbRefused): a LONE refusal is jitter and must NOT flash; only a
// SUSTAINED refusal (every packet unusable -- the real tick-base / clock-residual fault) is a
// genuine "connection lost". A leaky counter draws that line. Real world divergence is caught
// separately by the hash -> DESYNC, never by this banner, so debouncing it drops no real signal.
//
// This drives the REAL receive path (_netHandleMsg -> _netPeerInput / the future-pts gate) with
// crafted refused packets and asserts the banner text netDuelWarn() reports:
//   1. one refused input (too far in the future)      -> NO banner        (was: CONNECTION LOST)
//   2. one refused packet (pts beyond our estimate)   -> NO banner        (was: CONNECTION LOST)
//   3. one refused input (too far in the past)        -> NO banner        (was: CONNECTION LOST)
//   4. a burst of refused inputs (a one-sided stall)  -> CONNECTION LOST   (still flags the real fault)
//   5. total silence past the warn bar                -> CONNECTION LOST   (the honest-silence path is untouched)
const { mk } = require('./duel-driver');

const CL = 'CONNECTION LOST';
const steps = [];
let failed = 0;
const check = (name, got, want)=>{
    const bad = got !== want;
    steps.push(name.padEnd(40) + ' warn=' + JSON.stringify(got) + (bad ? '  FAIL (want ' + JSON.stringify(want) + ')' : '  ok'));
    if(bad) failed++;
};

// A fresh in-game host client, its recv clock marked at `t0` so the silence gate is quiet and
// only the refusal path is under test.
function client(t0){ const c = mk('aaaaaaaa', 0xD0E1, 'host'); c.__now = t0; return c; }

// One 'in' packet carrying a single dir record authored at duel-relative tick `tk` (our counter),
// optionally stamped with a send-pts. The tick rides on the RECORD (wire-encoded), exactly as the
// real sender builds it. No `ep`, so the epoch gate lets it through to the real refuse path.
function inAt(c, tk, pts){
    const wtk = tk - c.__rbBase();
    const o = { t:'in', tk: wtk, l:[ { q:0, tk: wtk, k:'dir', d:{ x:1, y:0 } } ] };
    if(pts != null) o.pts = pts;
    return JSON.stringify(o);
}

// 1. Lone future input: authored 1000 ticks ahead of us -> refused (> simTick + RB_FUTURE).
{
    const c = client(5000);
    c.__recv(inAt(c, c.__simTick() + 1000));    // __recv marks recv (silence quiet) then refuses
    check('lone future input', c.__warn(), null);
}

// 2. Lone future pts: a packet whose send stamp is 300ms beyond our clock estimate (> NET_PTS_TOL).
{
    const c = client(5000);
    c.__recv(inAt(c, c.__simTick() + 1000, c.__pts() + 300));
    check('lone future pts', c.__warn(), null);
}

// 3. Lone stale input: authored 1000 ticks behind us -> refused (<= simTick - RB_DEPTH).
{
    const c = client(5000);
    c.__recv(inAt(c, c.__simTick() - 1000));
    check('lone stale input', c.__warn(), null);
}

// 4. Sustained one-sided stall: a rapid burst of refused inputs corroborates a real break -> flash.
{
    const c = client(5000);
    for(let i = 0; i < 8; i++){ c.__now = 5000 + i * 40; c.__recv(inAt(c, c.__simTick() + 1000)); }
    check('sustained refusals (real stall)', c.__warn(), CL);
}

// 5. Honest silence: no packet at all, wall clock past the warn bar -> the silence path still warns.
{
    const c = client(0);        // recv marked at t0=0 by __p2pStart
    c.__now = 3000;             // 3s of total silence, well past RB_WARN_MS (~533ms)
    check('total silence (unchanged)', c.__warn(), CL);
}

console.log(steps.join('\n'));
if(failed){
    console.log('\nDUEL-WARN FAIL: ' + failed + '/5 -- a lone refused packet still flashes CONNECTION LOST'
        + ' (or a real stall / silence stopped flashing). See js/duel-core.js _rbRefused.');
    process.exit(1);
}
console.log('\nDUEL-WARN PASSED');
