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
//   node test/run-suites.js [--full|--regression] [--jobs N] [--shard k/N] [--list]
//
// Jobs default to the core count (JOBS in the environment overrides). Dispatch is
// longest-first from `weight` so the long sweeps start immediately and the short suites
// fill in behind them, which keeps the wall time near the longest single suite rather
// than the sum of all of them.
//
// Two things beat that floor once the cores of one machine run out. LANES split a single
// heavy suite's own cases across several processes (see test/lanes.js), so the longest
// suite stops being a floor at all. --shard k/N then hands one Nth of the work to this
// process, so a CI matrix can spend N machines on it: every shard packs the same table
// the same way and keeps only its own bucket, which needs no coordination between the
// machines and covers the tier exactly once between them.
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
    ['test/tourney-e2e.js',       1900, 'a whole tournament end to end (six clients, a scripted server, lobby to podium)'],
    ['test/duel-spec-tree.js',   57000, 'the relay tree (fan-out cap, warm standby, primary death, whole-tier wipeout)'],
    ['test/duel-spec.js',        77000, 'spectating (a watcher runs the same sim one bias behind the players; relay tree, backup feeder)'],
    ['test/duel-desync.js',      81700, 'boosting duel stays in lockstep (two clients, real match, over a lossy wire)'],
    ['test/duel-suspend.js',     58700, 'one-sided suspend recovery (a backgrounded client re-anchors its tick base; the live side never jumps)'],
    ['test/duel-boundary.js',    58100, 'P2P level boundary holds lockstep (host bursts to the shared midpoint, ships bth on the go)'],
    ['test/duel-outage.js',      44700, 'connection-interruption recovery (a sub-4s wire outage is survived; an over-long one still kills)'],
    ['test/duel-rematch.js',     43400, 'server-path restart (rematch) holds lockstep (host bursts to the shared midpoint on every start)'],
    ['test/duel-epoch.js',       32900, 'a lost boundary begin is repaired, not survived silently (no split onto separate tick bases)'],
    ['test/duel-drift.js',       28900, 'wall-clock drift immunity (the lockstep timeline rides the monotonic clock; an NTP slew/step is inert)'],
    ['test/duel-asym.js',        29600, 'rollback is one-sided under a clock offset (it falls on the AHEAD client; a modest skew is absorbed)'],
    ['test/duel-respawn.js',     25100, 'post-death respawn is clean (a full resync never yanks your own snake back to a death cell)'],
];

// A trailing `false` means the suite asserts by exit code and prints no completion line.
// Every other suite must show PASSED: one whose async body stalls drains the event loop
// and exits 0 having asserted nothing, which once read as a pass and hid a regression.
const FAST = [
    ['test/sim-determinism.js',  12800, 'sim determinism (classic + duel lockstep goldens)'],
    ['test/smoke-input.js',       1700, null],
    ['test/net-handshake.js',     2600, 'two-client handshake (invite / connect over a signal bus)'],
    ['test/smoke-net.js',         1700, null],
    ['test/check-ownership.js',    500, 'no main-thread writes to worker-owned state', false],
    ['test/duel-touch.js',        1900, 'touch input funnel: a same-direction swipe collapses onto the dpad, real turns still author'],
    ['test/sim-duel.js',          1600, 'duel sim rules (speed round re-rolled every spawn; fragile bars crush like single player)'],
    ['test/duel-hearts.js',       3200, 'per-match heart cap + item stakes: negotiated on the wire, one sim, and the 2-heart lockstep golden'],
    ['test/power-bite.js',        1600, 'powered self-bite shortens instead of killing, identically in single player and 1:1'],
    ['test/check-compat.js',       200, 'shipped sources stay on the supported browser floor', false],
    ['test/duel-sync.js',         1700, 'P2P boundary clock burst: both sides agree on the peer offset and nudge to the shared midpoint'],
    ['test/check-ascii.js',        200, 'ASCII-only sources', false],
    ['test/box-odds.js',          1600, 'mystery-box economy'],
    ['test/duel-warn.js',         1700, 'duel banners: CONNECTION LOST is pure silence, OUT OF SYNC tracks a hash divergence'],
    ['test/sim-invariants.js',    1600, 'sim invariants'],
    ['test/sim-events.js',        1600, 'sim side-effect sequence'],
    ['test/sw-cache.js',           100, 'service-worker fetch policy: a slow uplink falls back to cache, API traffic never does'],
    ['test/check-syntax.js',       100, 'JS syntax', false],
    ['test/check-snapshot.js',     100, 'worker snapshot mirrors all sim state', false],
    ['test/sim-purity.js',         100, 'sim headless purity', false],
];

// The smoke tests are discovered rather than listed, so a new one is picked up by
// existing. One that is also named above keeps the weight given there.
const listed = new Set([].concat(HEAVY, FAST).map(r => r[0]));
const smoke = fs.readdirSync('test')
    .filter(f => /^smoke-.*\.js$/.test(f)).sort().map(f => 'test/' + f)
    .filter(f => !listed.has(f))
    .map(f => [f, 1700, null]);

// Suites long enough that one of them would set the floor for the whole run are split
// into lanes: n table entries, each running its own slice of that suite's cases. The
// counts are picked so no lane lands heavier than the heaviest suite that is NOT split --
// splitting past that buys nothing and pays another node startup for it.
const LANES = {
    'test/duel-spec.js':      4,
    'test/duel-desync.js':    3,
    'test/duel-suspend.js':   3,
    'test/duel-boundary.js':  3,
    'test/duel-spec-tree.js': 3,
    'test/duel-outage.js':    2,
};

// One table row becomes one runnable entry, or n of them when the suite is laned. A lane
// carries the suite weight split evenly, which is what dealing the cases round-robin
// makes it; as with any weight here, being off only costs packing.
function expand(r){
    const n = LANES[r[0]] || 1;
    const base = { file: r[0], why: r[2], banner: r[3] !== false };
    const one = (w, args, name) => Object.assign({ weight: w, args: args, name: name }, base);
    if(n === 1) return [one(r[1], [], r[0])];
    const out = [];
    for(let k = 1; k <= n; k++)
        out.push(one(Math.round(r[1] / n), ['--lane', k + '/' + n], r[0] + ' ' + k + '/' + n));
    return out;
}

const argv = process.argv.slice(2);
const full = argv.indexOf('--full') >= 0 || argv.indexOf('--regression') >= 0;
const jobsArg = (argv[argv.indexOf('--jobs') + 1] || '').match(/^[0-9]+$/);
const shardArg = (argv[argv.indexOf('--shard') + 1] || '').match(/^([0-9]+)\/([0-9]+)$/);
const suites = [].concat(FAST, smoke, full ? HEAVY : [])
    .reduce((a, r) => a.concat(expand(r)), []);

// Longest-first, and then -- for a shard -- deal that same order onto N buckets, each
// suite onto the lightest bucket so far (greedy LPT), and keep bucket k. Every shard runs
// the identical deal over the identical table, so the buckets partition the tier with
// nothing agreed between the machines and nothing run twice.
let order = suites.map((s, i) => Object.assign({ i: i }, s)).sort((a, b) => b.weight - a.weight);
if(shardArg){
    const k = +shardArg[1] - 1, n = +shardArg[2];
    if(k < 0 || k >= n) throw new Error('bad --shard "' + shardArg[0] + '", want k/N (1-based)');
    const load = new Array(n).fill(0), mine = [];
    for(const s of order){
        let b = 0;
        for(let j = 1; j < n; j++) if(load[j] < load[b]) b = j;
        load[b] += s.weight;
        if(b === k) mine.push(s);
    }
    // An empty shard is a green run that tested nothing -- the same trap as an empty lane,
    // one level up, and just as invisible in a matrix of otherwise-passing jobs.
    if(!mine.length) throw new Error('SHARD ' + (k + 1) + '/' + n + ' GOT NO SUITES -- a shard that'
        + ' asserts nothing is a failure, not a pass. Reduce the shard count.');
    order = mine;
}
order.forEach((s, k) => { s.i = k; });

const JOBS = Math.max(1, Math.min(order.length,
    Number(jobsArg && jobsArg[0]) || Number(process.env.JOBS) || os.cpus().length));

const listOnly = argv.indexOf('--list') >= 0;
if(listOnly) for(const s of order) console.log(s.name);

const results = new Array(order.length);
let next = 0, running = 0, failed = 0, serialMs = 0;
const t0 = Date.now();

// exitCode rather than process.exit(): a piped stdout can still have buffered writes in
// flight, and exiting outright truncates the very output a failure needs to show.
function done(){
    const wall = (Date.now() - t0) / 1000;
    const bad = results.filter(r => r && !r.ok);
    for(const r of bad) console.log('\n[checks] FAILED ' + r.file + '\n' + r.out.trim());
    console.log('\n[checks] ' + order.length + ' suites on ' + JOBS + ' job(s): ' + wall.toFixed(1)
        + 's wall, ' + (serialMs / 1000).toFixed(1) + 's serial (' + (serialMs / 1000 / wall).toFixed(1)
        + 'x) -- ' + (bad.length ? bad.length + ' FAILED' : 'all green'));
    process.exitCode = bad.length ? 1 : 0;
}

function pump(){
    while(running < JOBS && next < order.length && !failed){
        const s = order[next++];
        running++;
        const started = Date.now();
        const child = spawn(process.execPath, [s.file].concat(s.args), { stdio: ['ignore', 'pipe', 'pipe'] });
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
            results[s.i] = { file: s.name, ok: ok, out: out, ms: ms };
            console.log('[' + (ok ? ' ok ' : 'FAIL') + '] ' + (ms / 1000).toFixed(1).padStart(6) + 's  '
                + s.name.replace('test/', '').padEnd(27) + ' ' + (s.why || ''));
            if(ok && out.trim()) console.log(out.trim());
            running--;
            if(running === 0 && (next >= order.length || failed)) done(); else pump();
        });
    }
}

if(!listOnly){
    console.log('[checks] ' + (full ? 'REGRESSION' : 'FAST') + ' tier'
        + (shardArg ? ', shard ' + shardArg[1] + ' of ' + shardArg[2] : '') + ': ' + order.length
        + ' suites across ' + JOBS + ' job(s)\n');
    pump();
}
