// DUEL respawn integrity (DEFAULT suite). After a death, a level must start CLEAN: a resync must
// never move a snake NON-CAUSALLY. The dangerous artifact (bug C) is a LIVE client -- one that
// never froze and owns its snake through its own inputs -- having its own head yanked to an old
// (death) cell by a resync it should have ignored ("I jumped back to where I died, then it
// cleared"). The driver's per-side selfJumps metric counts an own-head teleport onto a non-spawn
// cell; the LIVE side's count MUST be zero.
//
// The FROZEN side is different: a client that backgrounded for seconds produced no inputs, so the
// LIVE peer's dead-reckoning of its snake is the authoritative continuation. As it catches its tick
// base forward it legitimately snaps its own head ONCE onto that authoritative copy (verified to
// equal the peer's head, never a stale cell) -- exactly the liveJumps==0 && frozeJumps<=1 rule
// duel-suspend.js codifies. So the frozen side is allowed its single catch-up snap; > 1, or ANY
// live-side jump, or a lasting desync/session-end, is the failure.
//
// The catch-up resync (T a full ring ahead) adopts the sender's ENTIRE frontier -- both snakes --
// because the frozen side has no input-derived truth of its own; the ORDINARY aged-out path still
// keeps our own snake ours (there we WERE live and own it). Reproducing needs the aged-out path,
// which only a real STALL reaches: the `doze` knob freezes the joiner for seconds (an iOS WiFi
// power-save / backgrounded tab). The `collider` director drives both snakes into head-on deaths so
// the resync lands across a death/respawn boundary -- the exact bug-C setup.
const { runMatch, collider } = require('./duel-driver');

const WIRE = { base:20, jit:10, loss:0.08, asym:8, spike:{ p:0.04, ms:60 } };
const SEEDS = [0x51E0D000, 0x33AA7719, 0x9E3779B1, 0xC0FFEE01].map(x => x >>> 0);
// doze at two moments, 2s (the aged-out window that yanked the own head pre-fix) and 3.5s.
const DOZES = [{ at:3.5, ms:2000 }, { at:5.0, ms:2000 }];

const rows = [];
// B is the dozed (frozen) side, A stays live. Track their jumps SEPARATELY: the live side's own
// head must never move (liveJumps==0); the frozen side may snap its own head at most once onto the
// authoritative copy as it catches up (maxFroze<=1).
let liveJumps = 0, maxFroze = 0, maxJump = 0, sessionEnds = 0, resyncTotal = 0, resyncStorms = 0, sawResync = 0;
for(const seed of SEEDS){
    for(const dz of DOZES){
        const r = runMatch({ seed, secs:12, wire:WIRE, phase:8, tjit:4, recv:true,
            director: collider, doze:{ at:dz.at, ms:dz.ms, who:'B' } });
        if(r.fix > 0) sawResync++;                 // the aged-out resync actually fired (the path under test)
        resyncTotal += r.fix;
        if(r.fix > 15) resyncStorms++;             // adopting the frontier must NOT trigger a resync-every-second storm
        if(r.exitReason === 'session-end') sessionEnds++;
        liveJumps += r.localJumpsA;
        maxFroze = Math.max(maxFroze, r.localJumpsB);
        maxJump = Math.max(maxJump, r.maxLocalJump);
        if(r.localJumpsA > 0 || r.localJumpsB > 1 || r.exitReason === 'session-end'){
            rows.push('seed ' + seed.toString(16) + ' doze@' + dz.at + '/' + dz.ms + 'ms: liveJumps='
                + r.localJumpsA + ' frozeJumps=' + r.localJumpsB + '(max' + r.maxLocalJump + ') fix=' + r.fix
                + ' desync=' + r.desyncA + '/' + r.desyncB + ' exit=' + (r.exitReason || '-'));
        }
    }
}

console.log('swept ' + (SEEDS.length * DOZES.length) + ' dozed collider matches: liveJumps=' + liveJumps
    + ' maxFrozeJumps=' + maxFroze + ' (max' + maxJump + ' cells) resyncsFired=' + sawResync
    + ' resyncTotal=' + resyncTotal + ' storms=' + resyncStorms + ' sessionEnds=' + sessionEnds);
if(rows.length) console.log(rows.join('\n'));

// The scenario is only meaningful if it actually drove the sim down the aged-out resync path.
if(sawResync === 0){
    console.log('\nDUEL-RESPAWN INCONCLUSIVE: no resync ever fired -- the doze no longer ages out the ring.');
    process.exit(1);
}
if(liveJumps > 0 || maxFroze > 1 || resyncStorms > 0 || sessionEnds > 0){
    console.log('\nDUEL-RESPAWN FAIL: '
        + (liveJumps > 0 ? 'the LIVE side own head was moved non-causally (bug C); ' : '')
        + (maxFroze > 1 ? 'the frozen side snapped its own head more than once (not a clean catch-up); ' : '')
        + (resyncStorms > 0 ? 'a resync storm (state never converged); ' : '')
        + (sessionEnds > 0 ? 'a DESYNC match-end fired; ' : '')
        + '\n  a level did not start clean. liveJumps=' + liveJumps + ' maxFrozeJumps=' + maxFroze
        + ' storms=' + resyncStorms + '.');
    process.exit(1);
}
console.log('\nDUEL-RESPAWN PASSED');
