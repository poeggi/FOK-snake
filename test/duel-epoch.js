// EPOCH-SPLIT test: a lost boundary BEGIN must not strand the two clients on separate timelines.
//
// The field failure this guards (PC vs iPhone, level 1 -> 2, v2.5.33): the host bumps the session
// epoch, ships the go, and arms its own begin -- but that begin is a one-shot timer, and a
// throttled tab can defer or drop it. The peer begins, the timer-less side does not, and from then
// on the two hold different TICK BASES while both keep simulating happily. Every detector goes
// blind at the same instant, which is why it read as "nothing happens":
//   * the hash never reaches the comparator -- the epoch gate drops 'h' one layer above it;
//   * CONNECTION LOST never fires -- the link is fine, packets arrive and are stamped received
//     before they are discarded;
//   * the >600t timeline-break abort never fires -- neither sim is frozen; each is perfectly
//     consistent against its own clock.
// So the pair plays two independent games, one player dies in a match the other cannot see, and
// no banner ever appears. The split is survivable; not noticing it is not.
//
// The knob (opts.eatBegin) swallows exactly that one-shot on one client at the first boundary.
// Both roles are driven: losing the HOST's begin and losing the JOINER's are different repairs
// (the host re-serves starts; the joiner can only ask), and the one-directional recovery this
// replaced covered just one of the four role/direction combinations.
const { runMatch } = require('./duel-driver');

// The repair budget. A boundary is legitimately one-sided while the start is in flight
// (NET_BURST_LEAD_MS) and the clock-driven begin runs on the 250ms liveness pass, so a healthy
// split is a few hundred ms. Anything past this is the pair genuinely coming apart, and well
// short of RB_PERSIST_KILL_MS -- the match must be REPAIRED here, not ended.
const SPLIT_MAX = 1500;

const CASES = [
    { name:'host loses begin  ', secs:26, seed:0x77C0, p2pBoundary:true, eatBegin:{ who:'A' },
      wire:{ base:5, jit:2, loss:0 }, phase:8, tjit:4, recv:true },
    { name:'joiner loses begin', secs:26, seed:0x77C0, p2pBoundary:true, eatBegin:{ who:'B' },
      wire:{ base:6, jit:3, loss:0.02 }, phase:8, tjit:4, recv:true, clock:{ drift:1000, err0:40, samples:8 } },
];

const steps = [];
let failed = 0;

for(const sc of CASES){
    const r = runMatch(sc);
    // The bar: the split is repaired inside the budget, the two sims are back on one base and
    // converge, a boundary was actually crossed, and the match was never silently split (a run
    // past the ask deadline with no banner up is the field bug regardless of what follows).
    const bad = r.maxSplitMs > SPLIT_MAX || r.splitBlind || r.epA !== r.epB
        || !r.converged || !!r.firstDiverge || r.exitReason === 'session-end' || r.levelReached < 2;
    steps.push(sc.name.trim().padEnd(20)
        + ' L' + r.levelReached + ' ups=' + r.levelUps
        + ' split=' + r.maxSplitMs + 'ms'
        + ' base=' + r.epA + '/' + r.epB
        + ' blind=' + (r.splitBlind ? 'YES' : 'no')
        + ' conv=' + (r.converged ? 'yes' : 'NO')
        + (r.exitReason ? ' exit=' + r.exitReason : '')
        + '   ' + (bad ? 'FAIL' : 'ok'));
    if(bad) failed++;
}

console.log(steps.join('\n'));
if(failed){
    console.log('\nDUEL-EPOCH FAIL: ' + failed + ' case(s) -- a lost begin left the clients on separate'
        + '\n  tick bases (split > ' + SPLIT_MAX + 'ms, or undetected while it lasted).');
    process.exit(1);
}
console.log('\nDUEL-EPOCH PASSED');
