// The suite table and the runner for it, in one place. Every suite in it is a pure,
// isolated node process -- it reads sources, simulates, asserts, and writes nothing --
// so the only thing that ever forced them to run one after another was the shell loop
// that started them. They run concurrently here instead.
//
// Runtime is almost entirely SIMULATED MATCH TIME: the heavy duel sweeps play minutes of
// lockstep duel between them, and everything else in the suite adds up to seconds.
// Folding processes together would save the node startups (~40ms each) and nothing that
// matters; spreading the sweeps across cores is what actually shortens the wait, and it
// costs no coverage -- every suite still runs, whole, in its own process, and still has
// to show its completion banner.
//
//   node test/run-suites.js [--full|--regression] [--jobs N] [--list]
//
// Jobs default to the core count (JOBS in the environment overrides). Dispatch is
// longest-first from `weight` so the long sweeps start immediately and the short suites
// fill in behind them, which keeps the wall time near the longest single suite rather
// than the sum of all of them.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Every suite loads the shipped sources by relative path, so they all need the repo root
// as the cwd. checks.sh cds there; do it here too, so running the file directly works.
process.chdir(path.join(__dirname, '..'));

// weight = measured milliseconds, used for longest-first dispatch only. A stale number
// costs packing efficiency, never correctness.
const HEAVY = [
    ['test/duel-desync.js',    39500, 'boosting duel stays in lockstep (two clients, real match, over a lossy wire)'],
    ['test/duel-suspend.js',   26900, 'one-sided suspend recovery (a backgrounded client re-anchors its tick base; the live side never jumps)'],
    ['test/duel-boundary.js',  26400, 'P2P level boundary holds lockstep (host bursts to the shared midpoint, ships bth on the go)'],
    ['test/duel-outage.js',    20000, 'connection-interruption recovery (a sub-4s wire outage is survived; an over-long one still kills)'],
    ['test/duel-rematch.js',   19500, 'server-path restart (rematch) holds lockstep (host bursts to the shared midpoint on every start)'],
    ['test/duel-epoch.js',     14400, 'a lost boundary begin is repaired, not survived silently (no split onto separate tick bases)'],
    ['test/duel-drift.js',     12800, 'wall-clock drift immunity (the lockstep timeline rides the monotonic clock; an NTP slew/step is inert)'],
    ['test/duel-asym.js',      12700, 'rollback is one-sided under a clock offset (it falls on the AHEAD client; a modest skew is absorbed)'],
    ['test/duel-respawn.js',   10500, 'post-death respawn is clean (a full resync never yanks your own snake back to a death cell)'],
];

// A trailing `false` means the suite asserts by exit code and prints no completion line.
// Every other suite must show PASSED: one whose async body stalls drains the event loop
// and exits 0 having asserted nothing, which once read as a pass and hid a regression.
const FAST = [
    ['test/sim-determinism.js',  5200, 'sim determinism (classic + duel lockstep goldens)'],
    ['test/smoke-input.js',      1500, null],
    ['test/net-handshake.js',     900, 'two-client handshake (invite / connect over a signal bus)'],
    ['test/smoke-net.js',         900, null],
    ['test/check-ownership.js',   200, 'no main-thread writes to worker-owned state', false],
    ['test/duel-touch.js',        200, 'touch input funnel: a same-direction swipe collapses onto the dpad, real turns still author'],
    ['test/sim-duel.js',          100, 'duel sim rules (speed round re-rolled every spawn; fragile bars crush like single player)'],
    ['test/duel-hearts.js',       900, 'per-match heart cap + item stakes: negotiated on the wire, one sim, and the 2-heart lockstep golden'],
    ['test/power-bite.js',        200, 'powered self-bite shortens instead of killing, identically in single player and 1:1'],
    ['test/check-compat.js',      100, 'shipped sources stay on the supported browser floor', false],
    ['test/duel-sync.js',         100, 'P2P boundary clock burst: both sides agree on the peer offset and nudge to the shared midpoint'],
    ['test/check-ascii.js',       100, 'ASCII-only sources', false],
    ['test/box-odds.js',          100, 'mystery-box economy'],
    ['test/duel-warn.js',         100, 'duel banners: CONNECTION LOST is pure silence, OUT OF SYNC tracks a hash divergence'],
    ['test/sim-invariants.js',    100, 'sim invariants'],
    ['test/sim-events.js',        100, 'sim side-effect sequence'],
    ['test/sw-cache.js',           50, 'service-worker fetch policy: a slow uplink falls back to cache, API traffic never does'],
    ['test/check-syntax.js',       50, 'JS syntax', false],
    ['test/check-snapshot.js',     50, 'worker snapshot mirrors all sim state', false],
    ['test/sim-purity.js',         50, 'sim headless purity', false],
];

// The smoke tests are discovered rather than listed, so a new one is picked up by
// existing. One that is also named above keeps the weight given there.
const listed = new Set([].concat(HEAVY, FAST).map(r => r[0]));
const smoke = fs.readdirSync('test')
    .filter(f => /^smoke-.*\.js$/.test(f)).sort().map(f => 'test/' + f)
    .filter(f => !listed.has(f))
    .map(f => [f, 300, null]);

const row = r => ({ file: r[0], weight: r[1], why: r[2], banner: r[3] !== false });

const argv = process.argv.slice(2);
const full = argv.indexOf('--full') >= 0 || argv.indexOf('--regression') >= 0;
const jobsArg = (argv[argv.indexOf('--jobs') + 1] || '').match(/^[0-9]+$/);
const suites = [].concat(FAST, smoke, full ? HEAVY : []).map(row);
const JOBS = Math.max(1, Math.min(suites.length,
    Number(jobsArg && jobsArg[0]) || Number(process.env.JOBS) || os.cpus().length));

const listOnly = argv.indexOf('--list') >= 0;
if(listOnly) for(const s of suites) console.log(s.file);

const order = suites.map((s, i) => Object.assign({ i: i }, s)).sort((a, b) => b.weight - a.weight);
const results = new Array(suites.length);
let next = 0, running = 0, failed = 0, serialMs = 0;
const t0 = Date.now();

// exitCode rather than process.exit(): a piped stdout can still have buffered writes in
// flight, and exiting outright truncates the very output a failure needs to show.
function done(){
    const wall = (Date.now() - t0) / 1000;
    const bad = results.filter(r => r && !r.ok);
    for(const r of bad) console.log('\n[checks] FAILED ' + r.file + '\n' + r.out.trim());
    console.log('\n[checks] ' + suites.length + ' suites on ' + JOBS + ' job(s): ' + wall.toFixed(1)
        + 's wall, ' + (serialMs / 1000).toFixed(1) + 's serial (' + (serialMs / 1000 / wall).toFixed(1)
        + 'x) -- ' + (bad.length ? bad.length + ' FAILED' : 'all green'));
    process.exitCode = bad.length ? 1 : 0;
}

function pump(){
    while(running < JOBS && next < order.length && !failed){
        const s = order[next++];
        running++;
        const started = Date.now();
        const child = spawn(process.execPath, [s.file], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        // A spawn that never starts emits 'error' and no 'close'; without this the run
        // would die on an unhandled event instead of reporting which suite failed.
        child.on('error', e => { out += 'spawn failed: ' + e.message + '\n'; });
        child.on('close', code => {
            const ms = Date.now() - started;
            serialMs += ms;
            const ok = code === 0 && (!s.banner || out.indexOf('PASSED') >= 0);
            if(!ok) failed++;
            results[s.i] = { file: s.file, ok: ok, out: out, ms: ms };
            console.log('[' + (ok ? ' ok ' : 'FAIL') + '] ' + (ms / 1000).toFixed(1).padStart(6) + 's  '
                + s.file.replace('test/', '').padEnd(23) + ' ' + (s.why || ''));
            if(ok && out.trim()) console.log(out.trim());
            running--;
            if(running === 0 && (next >= order.length || failed)) done(); else pump();
        });
    }
}

if(!listOnly){
    console.log('[checks] ' + (full ? 'REGRESSION' : 'FAST') + ' tier: ' + suites.length
        + ' suites across ' + JOBS + ' job(s)\n');
    pump();
}
