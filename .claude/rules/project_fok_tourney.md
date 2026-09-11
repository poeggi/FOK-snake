# Tournament + spectator invariants (js/tourney.js, js/net-spec.js)

## ONE rule drives a node
`_ttDrive(now)`: while the roles sheet names us (`you !== 'idle'`), its nid is
not `_ttDone`, and we are not inGame -> engage (first time: ceremony;
afterwards every TT_CONNECT_MS = 20 s a status line STILL LOOKING FOR A FEED /
WAITING FOR <name>). Giving up is NEVER the client's call: the server's
walkover verdict decides who did not show. No retry counter, no parked offer,
no connect ladder. `tourneyOfferOk(from)`: an offer is answered only from the
sheet's peer; anything else refuses and re-reads state. A finished match
gives the board up when the next sheet arrives (`inGame && _ttOverAt ->
_ttClearMatch()`). Tests: tourney-e2e 17-19, duel-spec F/G.

## Spectator: "not yet" is never terminal
An ask arriving BEFORE the match it names is the ORDINARY arrival (the sheet
reaches players and watchers in one drain).
- A node that cannot serve yet PARKS an ask from a peer its grant list names
  (`_spAsk` + `_spAskPump`) and answers when it has a timeline. A FULL
  fan-out redirects via `no`+`alts`.
- The asker re-asks on SPEC_ASK_RETRY_MS=1500 up to SPEC_ASK_TTL_MS=20000
  (`_spWantPump`); a bare `no` or `sno` puts the ask back on the ladder
  (`_spWantKeep`, original deadline).
- Every new spectator suite MUST use `runSpec({playersAt: <s>})` so the
  watcher asks before the duel exists. Regression: duel-spec.js section E.
- A feeder releases its served links on the first tick it is no longer
  servable (`_spServeEnd()` from `_spTick`); parked `_spAsk` entries survive
  that release (tourney-watch.js asserts it).
- `_netReconnect` returns for `netSpectating()`; a watcher may rewind to an
  aged-out checkpoint (anchor = (spec || T > simTick) ? T-1 : simTick).
- The spectator's flat SPEC_DELAY_MS = 100 origin bias is deliberately
  hop-count-independent so every watcher sits on the same tick.

## The checkpoint is minted where the ring lives
A bootstrap is [sctx, checkpoint, tail]. In the default runtime the ring is
the WORKER's; main's ring is never written. Main asks the worker (`spCkpt`),
reserves the checkpoint's number and clears the tail buffer AT THE ASK, holds
the stream, and on landing fans out checkpoint then held tail (a link drops
anything numbered at or below what it has seen). An upstream checkpoint at a
relay outranks the one its worker is minting. The bootstrap context names the
level being PLAYED, read off the sim. Guard: smoke-spec-worker.js, the only
worker-path spectator guard; any change to what main does with the worker's
state owes a check there.
