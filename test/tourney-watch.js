// THE WATCH HANDSHAKE, END TO END (HEAVY suite). Three real clients, one scripted server,
// and -- for the first time -- signals that are actually DELIVERED between them.
//
// WHAT THIS SUITE IS FOR. tourney-e2e.js and tourney-full.js drive the same world with
// _netSignal recording into a list nobody reads back, because everything they assert is
// either a POST or a screen. That left exactly one thing untested, and it is the one thing
// a spectator is made of: the watch round trip. Every leg of it -- the ask, the ok, the
// offer and the ICE behind them -- has no carrier but the signal mailbox, and the node
// being asked is BY DEFINITION a node in a match, which is the one client in the game that
// polls that mailbox slowly. A watcher that never gets past CONNECTING is what that costs,
// and nothing anywhere fails: the two players play a perfectly good match, no ladder has
// anything to find, and the tournament walks on to the next node.
//
// So this suite owns the leg between two clients: C asks, the feeder parks it because it is
// still in the ceremony, the match goes live, and the ask is answered. The RTCPeerConnection
// that the 'ok' invites is the one thing this world cannot run -- duel-spec.js owns the
// feed itself -- so the assertions stop at the last signal before it.
//
// Run: node test/tourney-watch.js
const { mkWorld, TT_CONNECT_MS } = require('./tourney-world');

const IDS   = ['aaaa0001', 'aaaa0002', 'aaaa0003'];
// The clnt-CI-<id tail> shape the live probes use: one naming convention for every
// client this project invents, and a name in the log traces back to the id that wore it.
const NAMES = IDS.map(id => 'clnt-CI-' + id.slice(-4));

const rows = [];
let fails = 0;
const A = (c, m) => { if(!c){ rows.push('FAIL: ' + m); fails++; } };

const { srv, C, idx, clock, pump, settleAsync, deliver } = mkWorld(IDS, NAMES);

async function run(){
    // ---- a three-player tournament, up to the first roles sheet ----
    for(const c of C) c.setPhase('tourneyLobby');
    for(const c of C) c.enter();
    await settleAsync();
    await C[0].create(false);
    await settleAsync();
    const code = C[0].tt().code;
    for(let i = 1; i < C.length; i++){ await C[i].join(code); await settleAsync(); }
    await C[0].start();
    await pump(2);

    const sheets = C.map(c => (c.tt() || {}).roles || null);
    A(sheets.every(s => s && s.nid), 'no roles sheet reached the clients');
    const r = sheets[0];
    const feeder = String(r.feeder), fi = idx(feeder);
    const watcher = IDS.find(x => r.players.indexOf(x) < 0), wi = idx(watcher);
    A(fi >= 0 && wi >= 0, 'the sheet named nobody this world knows');
    A(C[wi].tt().you === 'spectate', 'the third player is not a spectator (' + C[wi].tt().you + ')');
    A(C[wi].phase() === 'tourneyCeremony', 'a spectator does not get the ceremony (' + C[wi].phase() + ')');

    // ---- the ask leaves, and lands ----
    const asked = C[wi].rec().watches.map(w => w.peer);
    A(asked.indexOf(feeder) >= 0, 'the only spectator did not ask the feeder (' + asked.join(',') + ')');
    A(C[wi].spWants().indexOf(feeder) >= 0, 'the ask is not on the spectator ladder');
    // A watch that has not started is one of several different situations, and CONNECTING
    // says none of them. Which leg it is stuck on is the whole of what a report about it is
    // worth: an ask nobody answered is not a link that will not open.
    A(C[wi].spStatus() === 'ASKED TO WATCH',
      'an outstanding ask reads as "' + C[wi].spStatus() + '"');
    A(C[fi].spStatus() === 'NO FEEDER YET',
      'a client that never asked for anything reads as "' + C[fi].spStatus() + '"');

    rows.push('1 the ask: the only spectator asked the feeder, and both its own ladder and the '
              + 'status line the ceremony reads agree on where the watch has got to');

    deliver();
    // The feeder is still in its own ceremony: there is no match to hand out yet. That is
    // not a refusal -- the sheet introduced this peer, so the ask is HELD until there is.
    A(C[fi].spAsks().indexOf(watcher) >= 0,
      'the feeder did not park an ask it cannot serve yet (' + C[fi].spAsks().join(',') + ')');
    A(C[fi].spGranted(watcher), 'the sheet did not pre-authorise the watcher');
    // The housekeeping that tears a finished match's served links down runs on this same
    // boundary -- a node between matches has nothing servable, which is what it looks for.
    // A parked ask is not a served link: it is for the match that has not started yet, and
    // the only thing standing between the watcher and never being answered at all.
    C[fi].spServe('dead0001');
    for(let k = 0; k < 4; k++) C[fi].spTick();
    A(C[fi].spOut() === 0, 'a link served out of a finished match survived the boundary');
    A(C[fi].spAsks().indexOf(watcher) >= 0, 'the teardown threw away the ask parked for the NEXT match');

    rows.push('2 the park: a feeder still in its own ceremony holds an ask it cannot serve yet, '
              + 'and the teardown that clears the served links of a finished match leaves it standing');

    // ---- and now the one thing that was never tested: does it get ANSWERED? ----
    // The match goes live, which is the moment a feeder finally has a timeline to hand out.
    const other = r.players.map(String).filter(x => x !== feeder)[0];
    C[fi].goLive(other, 'host');
    A(C[fi].live(), 'the feeder is not in a match');

    // A node in a match polls the mailbox at a fifth of the rate -- but not while it owes
    // somebody a leg of a handshake, because every leg of one is a signal and three of them
    // at that cadence outlive the ask itself.
    A(C[fi].spHs(), 'a parked ask does not read as a handshake in flight');
    A(C[fi].pollDue(), 'a feeder with a parked watch ask does not poll for it');

    C[fi].spTick();
    const sent = C[fi].takeSigs().filter(s => s.type === 'watch' && s.to === watcher);
    A(sent.length === 1, 'the feeder sent ' + sent.length + ' watch replies, not one');
    const k = sent.length ? JSON.parse(sent[0].payload || '{}').k : '';
    A(k === 'ok', 'the feeder answered "' + k + '" to a watcher it had just gone live for');
    A(C[fi].spAsks().length === 0, 'an answered ask is still held');

    // ---- the ok is acted on ----
    C[wi].sigRaw('watch', feeder, { tid:C[wi].tt().tid, nid:r.nid, k:'ok' });
    A(C[wi].spWants().length === 0,
      'an answered ask stays on the spectator ladder (' + C[wi].spWants().join(',') + ')');

    rows.push('3 the answer: going live turns the parked ask into exactly one ok, and the watcher '
              + 'takes it off its ladder rather than asking again');

    // ---- the ladder keeps asking while nothing has answered ----
    // A watcher's ladder never gives up: the match it cannot reach is most likely being
    // played perfectly well by the two people in it, and it owes nobody a result.
    const w2 = IDS.indexOf(watcher);
    C[w2].clrMsg();
    clock(TT_CONNECT_MS + 2000);
    C[w2].tick(); C[w2].tick();
    await settleAsync();
    A(C[w2].rec().watches.length >= 2, 'the spectator ladder stopped asking');
    A(C[w2].phase() === 'tourneyCeremony', 'the ladder took the spectator off the ceremony');
    rows.push('4 the ladder: an ask nobody answers is not an ending -- it is asked again, and the '
              + 'spectator stays on the ceremony waiting for it');
}

// The banner the runner looks for: a suite that exits 0 having asserted nothing would
// otherwise read as a pass, which is exactly the failure test/run-suites.js was taught
// to catch.
run().then(() => {
    rows.forEach(l => console.log(l));
    if(fails){ console.log('\nTOURNEY-WATCH FAIL: ' + fails + ' assertion(s)'); process.exit(1); }
    console.log('\nTOURNEY-WATCH PASSED');
}).catch(e => {
    rows.forEach(l => console.log(l));
    console.log('\nTOURNEY-WATCH FAIL: ' + (e && e.stack || e)); process.exit(1);
});
