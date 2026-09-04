// Splitting one heavy suite across several processes.
//
// A suite is one node process and a process is one core, so the longest suite sets a floor
// under the whole run however many cores are free: no amount of sharding gets CI below the
// single sweep that takes the longest. A LANE is a slice of a suite's OWN cases --
//
//   node test/duel-desync.js --lane 2/3
//
// runs every third case starting at the second -- so run-suites.js can register that suite
// as three table entries and pack them like any other work.
//
// This is only sound because the cases were already independent: each builds its own clients,
// its own wire and its own sim, asserts on its own result, and shares nothing with the case
// before it. Splitting them changes which process a case runs in and nothing else -- every
// case still runs, whole, on every full-tier run. A case that is a FALSIFICATION CONTROL for
// the others is the exception and must run in every lane, not be dealt into one of them
// (test/duel-outage.js FATAL is the example).
//
// An empty lane is a FAILURE, not a fast pass. A suite that asserts nothing still prints its
// completion banner, and the runner reads that banner as a pass -- the same trap the banner
// rule in run-suites.js exists for.
const arg = (() => {
    const a = process.argv.slice(2), i = a.indexOf('--lane');
    if(i < 0) return null;
    const m = (a[i + 1] || '').match(/^([0-9]+)\/([0-9]+)$/);
    if(!m || +m[1] < 1 || +m[1] > +m[2]) throw new Error('bad --lane "' + a[i + 1] + '", want i/n (1-based)');
    return { i: +m[1] - 1, n: +m[2] };
})();

// Position in the suite's own case sequence, counted across every lane() and lane.step()
// call, so a suite may mix the two forms and still deal each case exactly once.
let seen = 0, taken = 0;

// The list form: `for(const sc of lane(SCEN))`.
function lane(all){
    if(!arg) { taken += all.length; return all; }
    const mine = all.filter((unused, k) => (seen + k) % arg.n === arg.i);
    seen += all.length;
    taken += mine.length;
    return mine;
}

// The block form, for a suite whose cases are written as sequential blocks rather than a
// list: put `if(lane.step())` in front of the block's opening brace.
lane.step = function(){
    if(!arg) { taken++; return true; }
    const mine = (seen++ % arg.n) === arg.i;
    if(mine) taken++;
    return mine;
};

// Neither form can tell on its own that the WHOLE suite came up empty, so the check happens
// once, at exit, for both.
process.on('exit', () => {
    if(arg && !taken && !process.exitCode){
        console.log('\nLANE ' + (arg.i + 1) + '/' + arg.n + ' SELECTED NO CASES -- a lane that asserts'
            + ' nothing is a failure, not a pass. Reduce the lane count for this suite.');
        process.exitCode = 1;
    }
});

module.exports = lane;
