# Tournaments, spectators, events (js/tourney.js, net-spec.js, events.js)

## ONE rule drives a node
`_ttDrive(now)`: while the roles sheet names us (`you !== 'idle'`), its nid is
not `_ttDone`, and we are not inGame -> engage (first time: ceremony; then
every TT_CONNECT_MS = 20 s a status line STILL LOOKING FOR A FEED / WAITING
FOR <name>).
- Giving up is NEVER the client's call: the server's walkover verdict
  decides who did not show. No retry counter, no parked offer, no connect
  ladder.
- `tourneyOfferOk(from)`: an offer is answered only from the sheet's peer;
  anything else refuses and re-reads state.
- A finished match gives the board up when the next sheet arrives (`inGame
  && _ttOverAt -> _ttClearMatch()`).
- Tests: tourney-e2e 17-19, duel-spec F/G.

## Spectator: "not yet" is never terminal
An ask arriving BEFORE the match it names is the ORDINARY arrival (the sheet
reaches players and watchers in one drain).
- A node that cannot serve yet PARKS an ask from a peer its grant list names
  (`_spAsk` + `_spAskPump`) and answers when it has a timeline. A FULL
  fan-out redirects via `no`+`alts`.
- The asker re-asks on SPEC_ASK_RETRY_MS=1500 up to SPEC_ASK_TTL_MS=20000
  (`_spWantPump`); a bare `no` or `sno` puts the ask back on the ladder
  (`_spWantKeep`, original deadline).
- Every spectator suite uses `runSpec({playersAt: <s>})` so the watcher asks
  before the duel exists. Regression: duel-spec.js section E.
- A feeder releases its served links on the first tick it is no longer
  servable (`_spServeEnd()` from `_spTick`); parked `_spAsk` entries survive
  that release (tourney-watch.js).
- `_netReconnect` returns for `netSpectating()`; a watcher may rewind to an
  aged-out checkpoint (anchor = (spec || T > simTick) ? T-1 : simTick).
- The flat SPEC_DELAY_MS = 100 origin bias is hop-count-independent so every
  watcher sits on the same tick.

## The checkpoint is minted where the ring lives
A bootstrap is [sctx, checkpoint, tail]. In the default runtime the ring is
the WORKER's; main's ring is never written. Main asks the worker (`spCkpt`),
reserves the checkpoint's number and clears the tail buffer AT THE ASK, holds
the stream, and on landing fans out checkpoint then held tail (a link drops
anything numbered at or below what it has seen). An upstream checkpoint at a
relay outranks the one its worker is minting. The bootstrap context names the
level being PLAYED, read off the sim. Guard: smoke-spec-worker.js (the only
worker-path spectator guard; any change to what main does with the worker's
state owes a check there).

## Events (contract: FOK-server docs/API.md "Events")
An EVENT is a room an operator opens on the server, entered by scanning its QR
(straight in when OPEN, after organizer approval when CLOSED). Inside:
member-only tournaments, an archive, a secret achievement, a 30 s live pass.
All in js/events.js and its screens.

### The server is the roster; nothing here keeps a copy
Every screen reads fresh when it opens, re-reads after every verb, drops what
it held on close. No startup reconciliation, nothing in the vault (not the
friends-list pattern). Being removed = the event gone from `events`. `_ev`,
`_evList`, `_evMem`, `_evPass` are pictures of the last answer; one
outliving its screen is a bug.

### Two codes, ONE budget
    #event=<eid>.<pass>   live pass 4+1+6
    #event=<key>          printed key 11, names its own event
- Both 11 chars -> a 53-byte URL, what the game's fixed QR decoder holds
  (version 3, level L, 53 bytes; 42 are the prefix); the server renders the
  poster at exactly v3/L/mask 0. DO NOT generalise the decoder (too slow per
  frame); an overflowing payload hands the budget back to the server.
- `EVENT_HASH_RE` captures the code as scanned, dot and all; the eid uses
  `A-Z0-9`, the pass and printed key `A-Z2-9` (a shape filter only; the
  server answers a wrong code 404). The scanner answers an event link from
  ANY camera window, before the mode-specific patterns.
- `join` is the one action with no eid: it posts `{id, code}`; the event
  comes back on the answer and `_evAdopt` is the single place that sets
  `_evEid`.

### The monitor is a SPECTATOR
Ordinary `watch` signal, same P2P feed, same renderer; js/events.js holds no
transport. net-spec.js knows one id and one rule: the monitor's slot.
- The sheet names the match in flight; a new feed is asked for only AFTER
  the old one is let go; a standing feed is never re-asked; a finished round
  releases it.
- The holder receives every `tourney` signal of the event's tournament.
  `_ttOnSignal` hands a signal for a tid it does not hold to
  `eventMonitorSignal`: `roles` is adopted and followed at once (its
  `after_ms` is owed); `roles-patch` re-wires the sheet; anything else =
  re-read `monitor`. The 30 s lease is only the lease.
- The sheet's `eid` is the ROUTING KEY: `roles` / `roles-patch` carry it
  (null outside an event); a sheet whose `eid` is not the room on screen is
  dropped. `monitor` ABSENT = nobody holds the slot (never null); the
  monitor's own copy says `you: idle`, `after_ms` 0. The holder is resolved
  when a sheet is built and when a transition flushes, so a slot changing
  hands is followed from the NEXT sheet; a screen claiming the slot after a
  deal is refused by a private feeder until the next deal.
- INVISIBLE: the monitor is its own sheet field `monitor`, outside
  players/primaries/secondaries/names, so no client lists, draws or counts
  it. Every client grants the feed off that field (`specGrant`, so MAKE
  DUELS PRIVATE players still feed it) on a slot of its own (`specMonitor` /
  `_spRoomNow`): never counted against SPEC_MAX_DIRECT, never handed out as
  an alt. When net-spec's ask ladder gives up, the follow asks the OTHER
  player.
- ASKING IS NOT TAKING: `monitor_allowed` on `state` and every `events` row
  says whether a screen is offered (absent = allowed); the `monitor` call
  CLAIMS the slot. 409 `monitor taken` / 403 `no monitor` are said once and
  never retried.

### An event tournament is an ORDINARY tournament
`eid` is a tag and a membership check, nothing else: a field on `_ttUi`, the
`eid` on the create body, an EVENT label; no branch. The create is the normal
dialog carrying the room it was opened from, set on every
`tourneySetupOpen`.

### Units, rows, state, polling
- Every timing value is unix ms EXCEPT `asked`, `joined`, `finished`
  (SECONDS); `eventDay()` converts and is the only place that should.
- `eventRows()` offers only what the server would allow (row state, who the
  organizer is, whether the event runs on a clock): a pending row and a
  reserved monitor get nothing; the organizer cannot leave; a scheduled
  event takes the hand verbs away. No verb adopts its own answer; each
  re-reads. A pending row sees the public face only.
- `eventState()` is DERIVED from `starts`, `ends` and the synced clock (ended
  > schedule > mode; no synced clock -> the server's word). Nothing polls on
  a timer; the four `event` signals mean "something moved, ask".
- `events` rides a poll tick of its own (`NET_EVENTS_MS` on the six screens
  that show it, `NET_EVENTS_DOOR_MS` 15 s on the MULTIPLAYER door; `ev`
  answers at once, so riding every poll would spin a hot loop). Event
  screens poll and hold like the lobby.
- The achievement `ev_<eid>` is server-carried (id, name, desc, icon); only
  the DEFINITION is kept locally (`ACH_EV_KEY`, outside the backup
  manifest); the unlock rides the backup. Renders on the hidden EGGS page.
