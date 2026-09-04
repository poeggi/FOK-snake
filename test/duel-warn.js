// CONNECTION-LOST banner (DEFAULT suite). The banner means ONE thing: we have not heard from the
// peer in a while. It is a pure SILENCE detector -- nothing received on the wire for ~2 heartbeats
// (RB_WARN_MS ~= 533ms) -> "CONNECTION LOST". Every inbound datagram refreshes the timer, the
// minimal 'pi' liveness ping included (dc.onmessage -> _netMarkRecv before dispatch), so a link
// that is still carrying anything at all never flashes.
//
// A refused input is NOT a connection problem: under independent clocks a peer packet occasionally
// lands outside the accept window (jitter / a clock-estimate transient), the redundant resend
// re-delivers it a beat later at a usable tick, and the two worlds never diverge. Refusals do not
// arm the banner AT ALL -- not a lone one, not a sustained burst. Genuine world divergence is a
// different signal entirely, caught by the hash -> DESYNC line and its own match-end, never here.
//
// A hash that disagrees is a DIFFERENT fault -- the link is fine, the worlds diverged. It is
// NOT silence and NOT CONNECTION LOST: it shows its own banner, OUT OF SYNC (amber on screen),
// while duel-core's per-verdict resync runs. It clears the instant a hash agrees again, and if
// silence and divergence coincide, silence wins (you cannot resync a link you cannot hear).
//
// This drives the REAL receive path (_netHandleMsg -> _netPeerInput / the future-pts gate / the
// 'pi' case) and asserts the banner text netDuelWarn() reports:
//   1. one refused input (too far in the future)   -> NO banner   (a refusal is not silence)
//   2. one refused packet (pts beyond our estimate) -> NO banner
//   3. one refused input (too far in the past)      -> NO banner
//   4. a burst of refused inputs (a one-sided stall)-> NO banner   (still receiving = still connected)
//   5. total silence past the warn bar              -> CONNECTION LOST
//   6. a bare 'pi' ping arriving refreshes the timer-> NO banner   (any packet clears silence)
//   7. an unhealed hash divergence                  -> OUT OF SYNC (link fine, worlds not)
//   8. that divergence heals (hash agrees again)    -> NO banner   (resync succeeded)
//   9. divergence AND silence at once               -> CONNECTION LOST (silence outranks it)
//
// SILENCE IS NOT THE ONLY WAY THE OPPONENT STOPS REACHING US. The wall-clock keepalives -- the
// radio-warm beat and the liveness ping -- are TIMERS, not sim work: they exist to chirp when the
// sim is not ticking, so a peer whose sim wedged keeps the silence detector perfectly happy many
// times a second while its world stands still. Silence structurally cannot be the verdict on it.
// The proof of a live sim is the tick every packet stamps MOVING (movement, not increase -- a
// boundary rebases to 0, and a rebase is a sim doing something); frozen, it is the same event to
// a player as a dead link and says the same words:
//  10. keepalives with no tick at all (worker home) -> CONNECTION LOST (a 'pi' proves nothing)
//  11. keepalives carrying a FROZEN tick            -> CONNECTION LOST (a warm wire, a dead world)
//  12. the same cadence with a tick that MOVES      -> NO banner   (that is just a live peer)
//  13. a frozen tick across a pending boundary      -> NO banner   (a sim entitled to sit still)
//  14. frozen past twice the bar                    -> the match ENDS (no reconnect rung exists)
const { mk } = require('./duel-driver');

const CL = 'CONNECTION LOST', OOS = 'OUT OF SYNC';
const steps = [];
let failed = 0;
const check = (name, got, want)=>{
    const bad = got !== want;
    steps.push(name.padEnd(40) + ' warn=' + JSON.stringify(got) + (bad ? '  FAIL (want ' + JSON.stringify(want) + ')' : '  ok'));
    if(bad) failed++;
};

// A fresh in-game host client, its recv clock marked at `t0` so the silence gate is quiet and
// only the path under test moves the banner.
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

// 4. Sustained one-sided stall: a rapid burst of refused inputs. Every packet still ARRIVES, so the
// link is not lost -- refusals never flash. (Real divergence would surface as DESYNC, not here.)
{
    const c = client(5000);
    for(let i = 0; i < 8; i++){ c.__now = 5000 + i * 40; c.__recv(inAt(c, c.__simTick() + 1000)); }
    check('sustained refusals (still connected)', c.__warn(), null);
}

// 5. Honest silence: no packet at all, wall clock past the warn bar -> the sole banner trigger.
{
    const c = client(0);        // recv marked at t0=0 by __p2pStart
    c.__now = 3000;             // 3s of total silence, well past RB_WARN_MS (~533ms)
    check('total silence', c.__warn(), CL);
}

// 6. A minimal liveness ping refreshes the timer: at 3s of silence a bare 'pi' arrives and clears it.
{
    const c = client(0);
    c.__now = 3000;                        // would be CONNECTION LOST...
    c.__recv(JSON.stringify({ t:'pi' }));  // ...but a bare ping arrives now and marks recv
    check('ping refreshes timer', c.__warn(), null);
}

// 7. A hash disagreed and has not healed: link fine (recv fresh at t0), worlds diverged -> OUT OF SYNC.
{
    const c = client(0);
    c.__setBad(100);                       // first unhealed mismatch 100ms ago
    check('unhealed divergence', c.__warn(), OOS);
    // 8. The resync lands and a later hash agrees: _rbBadSince -> 0, banner clears.
    c.__setBad(0);
    check('divergence heals', c.__warn(), null);
}

// 9. Divergence AND silence together: silence outranks it (a link you cannot hear cannot resync).
{
    const c = client(0);
    c.__setBad(100);
    c.__now = 3000;                        // now also silent past the warn bar
    check('divergence + silence -> silence wins', c.__warn(), CL);
}

// A bare liveness ping: the whole packet, carrying no tick -- and so no proof of anything but a
// working radio. This is literally what the worker home's warm beat puts on the wire.
const PI = JSON.stringify({ t:'pi' });

// Drive wall time from `from` to `to` in 250ms steps (the production liveness cadence), delivering
// whatever `pkt()` returns at every step so the SILENCE timer is never the thing under test. With
// `live`, each step also runs one real liveness pass -- the pump that owns the kill.
function keepalive(c, from, to, pkt, live){
    for(let t = from; t <= to; t += 250){
        c.__now = t;
        c.__recv(pkt());
        if(live) c.__live();
    }
}

// 10. Worker home: the warm beat is a bare 'pi' with no tick at all, so after the one stamped
// packet that sets the baseline nothing ever vouches for the peer's sim again.
{
    const c = client(0);
    c.__recv(inAt(c, c.__simTick() + 1000));    // refused (far future) -- but it still stamps a tick
    keepalive(c, 250, 5000, ()=> PI);
    check('wedged sim, bare pings', c.__warn(), CL);
}

// 11. Non-worker home: the keepalive is a real 'in' carrying the sender's own tick -- which is
// frozen, because the sender's sim is. Same verdict; the wire being warm changes nothing.
{
    const c = client(0);
    const tk = c.__simTick() + 1000;
    keepalive(c, 250, 5000, ()=> inAt(c, tk));
    check('wedged sim, frozen tick', c.__warn(), CL);
}

// 12. The control that makes 10 and 11 mean something: identical traffic, identical cadence, one
// difference -- the tick moves. A peer that is merely REFUSED (these are still far-future inputs)
// is not a peer that is gone.
{
    const c = client(0);
    let tk = c.__simTick() + 1000;
    keepalive(c, 250, 5000, ()=> inAt(c, tk++));
    check('moving tick (alive)', c.__warn(), null);
}

// 13. The other control: a boundary is the one place a sim is ENTITLED to sit still. The liveness
// pass carries the baseline forward for as long as one is pending, so the deadline starts at the
// END of a legitimate pause -- a level-up can never read as a death.
{
    const c = client(0);
    const tk = c.__simTick() + 1000;
    c.__recv(inAt(c, tk));
    c.__reqNextLevel();
    check('boundary armed -> lvlPending', c.__lvlPending(), true);
    keepalive(c, 250, 5000, ()=> inAt(c, tk));
    check('frozen tick across a boundary', c.__warn(), null);
    // ...and for as long as one is pending it is not a matter of PATIENCE either: pumped past even
    // the kill bar, a negotiating pair is still a pair. A slow boundary must never end a match.
    keepalive(c, 5250, 12000, ()=> inAt(c, tk), true);
    check('a long boundary never ends it', c.__alive(), true);
}

// 14. Past twice the bar the liveness pass stops waiting. There is no RECONNECT rung on this
// ladder: the transport is healthy, so rebuilding it would repair nothing -- warn, then end.
{
    const c = client(0);
    const tk = c.__simTick() + 1000;
    keepalive(c, 250, 6000, ()=> inAt(c, tk), true);
    check('warned, match still open', c.__alive() && c.__warn(), CL);
    keepalive(c, 6250, 9000, ()=> inAt(c, tk), true);
    check('past the kill bar the match ends', c.__alive(), false);
}

console.log(steps.join('\n'));
if(failed){
    console.log('\nDUEL-WARN FAIL: ' + failed + '/' + steps.length + ' -- the duel banners are not'
        + ' clean: CONNECTION LOST is not reporting exactly the two ways the opponent stops reaching'
        + ' us (a refusal flashed, silence did not, a packet failed to refresh the timer, or a'
        + ' wedged peer sim went uncalled / a live or pausing one was called), or OUT OF SYNC did'
        + ' not track an unhealed hash divergence.');
    process.exit(1);
}
console.log('\nDUEL-WARN PASSED');
