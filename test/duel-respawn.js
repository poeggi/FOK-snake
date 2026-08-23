// DUEL respawn integrity (DEFAULT suite). After a death, a level must start CLEAN: your own
// snake must never be yanked back to an old (death) cell. That "I jumped back to where I died,
// then it cleared" flash (bug C) is an own-head teleport onto a NON-spawn cell -- the driver's
// selfJumps metric counts exactly it (a legit respawn lands on the fixed spawn cell; a
// resurrection lands back on a death cell).
//
// The trigger is a FULL RESYNC whose tick has aged out of the joiner's rollback ring, so there
// is no log to replay and the host's authoritative snapshot is HARD-APPLIED. Before the fix that
// hard-apply adopted the host's (stale) copy of the JOINER'S OWN snake -- the one path that moves
// your own snake non-causally -- yanking it 10+ cells. The fix keeps our own snake ours in BOTH
// resync branches (we own it; the host owns only the shared world + its own snake), so the resync
// never teleports our head; the shared spawnAt still respawns both sides in lockstep.
//
// Reproducing it needs the aged-out path, which only a real STALL reaches: the `doze` knob freezes
// the joiner for seconds (an iOS WiFi power-save / backgrounded tab), so the peer's inputs age out
// of its ring and the host owes it a full resync. The `collider` director drives both snakes into
// head-on deaths so the resync lands across a death/respawn boundary -- the exact bug-C setup.
const { runMatch, collider } = require('./duel-driver');

const WIRE = { base:20, jit:10, loss:0.08, asym:8, spike:{ p:0.04, ms:60 } };
const SEEDS = [0x51E0D000, 0x33AA7719, 0x9E3779B1, 0xC0FFEE01].map(x => x >>> 0);
// doze at two moments, 2s (the aged-out window that yanked the own head pre-fix) and 3.5s.
const DOZES = [{ at:3.5, ms:2000 }, { at:5.0, ms:2000 }];

const rows = [];
let jumps = 0, maxJump = 0, sessionEnds = 0, resyncTotal = 0, resyncStorms = 0, sawResync = 0;
for(const seed of SEEDS){
    for(const dz of DOZES){
        const r = runMatch({ seed, secs:12, wire:WIRE, phase:8, tjit:4, recv:true,
            director: collider, doze:{ at:dz.at, ms:dz.ms, who:'B' } });
        if(r.fix > 0) sawResync++;                 // the aged-out resync actually fired (the path under test)
        resyncTotal += r.fix;
        if(r.fix > 15) resyncStorms++;             // keeping our own snake must NOT trigger a resync-every-second storm
        if(r.exitReason === 'session-end') sessionEnds++;
        if(r.localJumps > 0){
            jumps += r.localJumps; maxJump = Math.max(maxJump, r.maxLocalJump);
            rows.push('seed ' + seed.toString(16) + ' doze@' + dz.at + '/' + dz.ms + 'ms: selfJumps='
                + r.localJumps + '(max' + r.maxLocalJump + ') fix=' + r.fix
                + ' desync=' + r.desyncA + '/' + r.desyncB + ' exit=' + (r.exitReason || '-'));
        }
    }
}

console.log('swept ' + (SEEDS.length * DOZES.length) + ' dozed collider matches: selfJumps=' + jumps
    + ' (max' + maxJump + ') resyncsFired=' + sawResync + ' resyncTotal=' + resyncTotal
    + ' storms=' + resyncStorms + ' sessionEnds=' + sessionEnds);
if(rows.length) console.log(rows.join('\n'));

// The scenario is only meaningful if it actually drove the sim down the aged-out resync path.
if(sawResync === 0){
    console.log('\nDUEL-RESPAWN INCONCLUSIVE: no resync ever fired -- the doze no longer ages out the ring.');
    process.exit(1);
}
if(jumps > 0 || resyncStorms > 0 || sessionEnds > 0){
    console.log('\nDUEL-RESPAWN FAIL: '
        + (jumps > 0 ? 'own snake yanked back to a non-spawn cell after a resync (bug C); ' : '')
        + (resyncStorms > 0 ? 'a resync storm (keeping our own snake never converged); ' : '')
        + (sessionEnds > 0 ? 'a DESYNC match-end fired; ' : '')
        + '\n  a level did not start clean. selfJumps=' + jumps + ' storms=' + resyncStorms + '.');
    process.exit(1);
}
console.log('\nDUEL-RESPAWN PASSED');
