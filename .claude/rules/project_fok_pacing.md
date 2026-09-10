# Request pacing (client half; server half in FOK-server)

Everything here is shipped on both sides.
Nothing is open. The whole family of fixes is one idea - fewer simultaneous
requests per client - and each half is useless without the other.

## The measurement that drives everything

- Every queue wait over a millisecond in live snapshots was served by an ALREADY
  WARM worker: worker spawn is dead as an explanation. Contention sits
  ABOVE the pool (connection / HTTP2-stream layer, where a static file also
  sits), and the cost is a ~51 ms slice paid PER REQUEST IN FLIGHT, not per
  byte. Coalescing N requests into one saves (N-1) slices; a bytes argument was
  never the case.
- The host serves ~20-21 concurrent requests; a HELD long poll owns a worker
  for its whole wait (one 8-player lobby holds ~8). The steady heartbeat is
  not the problem; bursts on top of it are (a round board wakes 8 clients in the
  same ms).
- Being PAST the gate is not the same as going out together: two exempt calls in
  one tick race each other and BOTH pay the slice. Measured: start.php +
  tournament.php leaving in the same ms from one client, 128 ms each, pool mean
  2.5 ms. Hence the duel path is no longer exempt.

## The lanes (js/net-api.js)

- ONE background gate: every background request queues behind _netGate(); pure
  rule _netGapWait(now, flight) - anything of ours in flight beats any elapsed
  time, otherwise the wait is what is left of the gap.
- ONE AT A TIME (API 4.10): a PARKED HOLD of ours counts as traffic for every
  lane but the exempt one (_netGapFlight). A hold owns a server worker for its
  whole wait, so the request sent beside it is the one that can take the host to
  a concurrency it has not served - and TWO beside it race each other and BOTH
  pay the full wait, which is the thing the second one was sent to avoid. Both
  kinds of hold count: the poll (_netPollHeld) and DEPRECATED(relay)'s held GET
  (_netRelayHeld). A THIRD is never right.
- THREE lanes: `true` = paced background, and it waits a hold out (the beat, the
  roster, a score); NET_BG_IDLE = the same plus priority low, nobody is waiting
  at all (items.php); NET_BG_SOLO = the EXEMPT lane - never beside another
  request of ours, NO spacing, and it may go beside a parked hold because a
  player is waiting on it right now: signal.php, start.php, an unheld poll,
  tournament.php, friend.php `request`/`accept`, match.php seek/cancel.
- THE SLOT: what is due goes out AFTER the poll answers and BEFORE the next one
  is armed - one hold at most. A screen holds its poll for as long as it is
  open, so without the slot the background lane would starve behind it. The poll
  re-arms through _netPollArm, which lets the gate drain first; what it owes is
  the pure rule _netArmHold(gapN, flight), testable without a clock exactly like
  _netGapWait. Bounded on NET_GAP_TRIES: a request that never settles must not
  cost the mailbox its arm.
- Ordering, from the contract: folding a request into the poll beats sending it
  beside the poll, and waiting for the poll to answer beats both.
- An ABORTED held poll is still parked on its server worker until its own
  deadline (the server learns of a gone client only when it writes; the hold
  loop writes nothing). So the client never arms a held poll while the last one
  it aborted may still be parked (_netPollHoldEnd / _netPollNotBefore, set
  on foreground by _netPollResume), and neither the DataChannel opening nor
  a reconnect aborts the poll in flight any more: it returns by itself, and
  a held one wakes on the first re-handshake signal. Two workers for one
  client was the shape a 27 ms queue wait on an empty server had.
- Ungated on purpose: the HELD poll (it IS the parked slot the contract allows)
  and t.txt in _netClockMs. A request that never starts work on the server is
  not a request for the rule at all - the contract says so in as many words -
  and a gate wait there would land inside the measured RTT, hence in the clock
  offset. The probe still COUNTS as flight while it runs, so nothing of ours
  goes out beside it.
- ONE EVENT, ONE CALL: a roles sheet carries the whole match, so it IS a state
  read, and NOTHING reads state on a timer: the server runs its own deadlines on
  the poll every participant sends (server 1.4.16+), so `state` is only ever a
  screen entry, a transition, a shape-changing event, a doubtful sheet, or a
  mailbox that was down and is back (tourneyMailboxLost, off the poll's
  fail-then-succeed edge in _netPollOnce). A `result` is applied to the node
  held and its `rows` (server 1.4.17+) are the standings - no read; only a
  result WITHOUT rows (an older server) is still read back. after_ms is honoured on the CALL, never
  the render (client bound TT_AFTER_MAX 1 s as a wrong-number guard; the server
  serves 400 ms). Entering the 1vs1 screen is one event too: hello and the
  friend list go first, then _netTimeSync - ONE hello, and the sweep measures
  on a wire those two have cleared instead of racing a sample against a hello
  about to dirty it. The latency figure rides the next hello (_netLat.pending).
- PRESENCE is a cursor and deltas (server 4.6): no friend ids on the wire,
  `friends_since` on hello / `fs` on the poll, the answer's `friends_delta` is
  each changed friend's WHOLE state, `friends_at` the next cursor (never our
  clock), `friends_more` = continue at once (unheld, solo lane, bounded by
  NET_FR_PAGES). ONE landing place, _netFrApply, for both endpoints; it also
  takes the counters. Cursor 0 on every presence-screen opening
  (netPresenceOpen + the tick's edge), on foreground and on offline. A 204
  leaves the cursor alone. The lobby and friends screens send no hello of
  their own any more; MY ID shows no friend state and asks for none.
- index.html DNS-prefetches the API origin, so the name is resolved while the
  scripts load and the boot clock sweep does not pay the lookup -- its FIRST
  sample is adopted as the anchor outright. Once per page load, nothing after.
  DNS only, deliberately: a preconnect opens a TLS connection that the OFFLINE
  setting cannot refuse, and no static tag can read that setting -- gating one
  would take an inline script, which the game does not have
  (project_fok_csp.md). The TCP+TLS saving is given up on purpose.
- Self-check: q_ms is stored with the in-flight count at the time of the
  reading, so netSelfStacked() separates the host's load from our own overlap.
- The item queue stands aside ONCE while a duel forms, never in a loop - a
  re-checking wait re-arms forever and strands loss claims. Hello and friend.php
  never share a tick; the roster rides hello's friends_list with friend.php as
  fallback and ONE adoption path.

## ICE batch (js/net-rtc.js)

- NET_ICES_MAX 24, NET_ICES_BYTES 15000, NET_ICES_WINDOW_MS 100. The contract
  names no window, only "a short gather window" plus the 24/16KB caps; the
  number is ours and is settled - not a measured optimum. Field-read after the
  change came back good; do not reopen without a new field report.
- The window is REAL added latency and nothing absorbs it: the peer holds a long
  poll for the whole handshake, answered the millisecond a signal lands. Bounded
  because the timer is ARM-ONCE from the first buffered candidate, never a
  debounce. Every wait in the net-handshake.js batching block is sized to
  outlast the window and one control pins the number.
- TWO gates, both needed: netSrvMinor()>=4 (a 4.3 server REJECTS an unknown
  type) and _netIcesPeerOk(s.peerV) (an old peer silently drops the array). The
  FIRST candidate goes alone (usually the host candidate that connects a LAN
  duel in ~1 ms) UNLESS a request of ours is already in flight, in which case it
  rides the batch. A lost POST is retried with the WHOLE array.
- ROLLOUT HAZARD, asymmetric, live while old clients exist: new-client ->
  old-peer silently drops the whole batch and narrows ICE with no error. Hence a
  NEW signal type (never a reshaped `ice`) and the sender gates on the PEER
  version - the answerer learns it from the offer (may batch at once), the host
  only from the answer (sends singles until then).

## Clock anchor

- REFRESHED BY AGE, never by event: one sweep shape, 3-5 samples a FIXED
  NET_GAP_MS (100 ms) apart, min-RTT kept, exclusive on the wire (the probe
  is counted, a running sweep holds every lane and the mailbox re-arm). Sites:
  boot (set), the multiplayer door - MULTIPLAYER entry, netLobbyEnter,
  tourneyEnter - (nudge, only when the anchor is older than
  NET_ANCHOR_MAX_AGE_MS = 10 min), foreground (set: performance.now() FREEZES
  while suspended, so the error is the sleep itself), a "future pts" refusal
  (set), a first start and a spectator boot (3 samples, nudge, by age or on
  `resync:true`). A rematch NEVER sweeps; nothing sweeps on a heartbeat.
  nudge = move the anchor half the delta, no cap. A sample taken with our own
  requests in flight or a non-trivial q_ms is UNCLEAN: adoptable if nothing
  better exists, never REPORTED as latency (the report is OPTIONAL since
  server 1.4.15 - display only, the start lead is a flat 1000 ms).
  `resync:true` forces the NEXT start's sweep regardless of age, never latched.
- The server sync and the P2P burst write the SAME `_netSync.ofs` at
  different targets (the server's clock vs the pair's midpoint). They never
  overlap in time - the sync refuses during play - but do not add a sync site
  that can run mid-match.
- The burst does NOT stamp `_netSync.at`. That field says when the SERVER was
  last measured, and the burst aligns onto a different clock; stamping it there
  let a match's boundaries postpone the age-based sweep for as long as the
  boundaries kept coming, and a tournament evening is nothing but boundaries.
- An outgoing `pts` is the reading we hold, never backdated. The server allows
  `pts_ahead_max_ms` (200 ms), warns at half of it and refuses past it, and it
  LOGS what it sees - so a backdated stamp would only hide our own anchor drift
  from the one diagnostic that reports it. The 400 on a refusal still forces a
  re-sync (signal.php and the relay envelope both read it).
- ALREADY SAFE, do not "fix": the clock SOURCE is the server's static t.txt
  stamped by the web server itself, so the stamp never queues for a worker. The
  residual risk is only the RTT sample around it.

## The beat is a contract constant

- pace on hello is {hold} ONLY. The beat - heartbeat 60 s (half the 120 s
  online window), poll wait 5 s, gap 100 ms between a client's own requests - is
  a CONTRACT CONSTANT (docs/API.md Pacing on the server side): never on the wire,
  never a setting. Nothing about the beat follows load; interval-stretching
  under load was removed (its ceiling exceeded the online window and made
  presence flicker).
- Client side: _netPace is {hold:true} and nothing else; the three intervals are
  NET_HELLO_MS / NET_POLL_S / NET_GAP_MS. No 30 s fallback for a 4.4 server:
  the client beats 60 s, full stop (decided 2026-09-08). A signal the server
  still delivers after NET_INVITE_STALE_MS (its TTL is the 120 s window) is
  refused on arrival by its created stamp (_netSigStale). hello_ms / poll_ms / gap_ms from an
  older 4.4 server are IGNORED - never adopted, never compensated for locally.
- The heartbeat's PHASE is page load time and nothing else - each beat re-arms
  off the previous, never off Date.now() and never off the server clock;
  arbitrary per session rather than randomised, accepted as good enough.
- `hold` is the one lever, withdrawn in tier order (lobby first, tournament
  next, duel last) against the hold budget, not the raw pool.
- spread_ms is WITHDRAWN - do NOT reintroduce a jitter budget: what separates a
  roomful of clients is the GATE they all queue at, not the sessions.

## Version-string gotcha (the bug that nearly shipped)

APP_VERSION carries a LEADING 'v' (the hook writes the tag minus its prefix)
and goes on the wire that way. A peer gate whose regex demanded a leading DIGIT
never matched - dead in production while every test passed, because tests fed a
literal number. Rule: accept an optional leading v, and pin version tests to
the FORMAT of APP_VERSION (force its major), never to a version NUMBER - the
hook rewrites the number only AFTER checks run. See feedback_fok_version_tag.md.

## NET_API_BUILT_MINOR is a DECLARATION -- bump it with the feature

Implementing a contract minor means bumping `NET_API_BUILT_MINOR` in the same
commit. Shipping the 4.7 fields while the constant still said 6 put a permanent
"UPDATE AVAILABLE - PLEASE RELOAD" in front of every player the moment the 4.7
server went live -- and reloading could not clear it, because they already had
the newest build.

Nothing can catch this for you. The client cannot know what the server offers,
so the constant is a statement of intent, not a derived value. What CAN be
caught is a test that goes stale with it: the gate lane in smoke-net.js now
builds its "built against" and "newer minor" inputs from
`NET_API_BUILT + '.' + NET_API_BUILT_MINOR`, because the old literal `'4.7'`
silently stopped testing anything the moment the constant reached 7. Same
family as the version-string gotcha above: pin a version test to the FORMAT or
derive it, never to a NUMBER.

## How to apply

Feature-detect every optional field (a MINOR is re-released, so a server
answering 4.4 may or may not serve the roster on hello); never gate an optional
feature on the version. But a value the CONTRACT states is not an optional
field: read it from the contract, not off the wire, and when the wire stops
carrying one do not stand something local in its place.

## Rejected - do not re-propose

- SSE/streaming push (the host buffers output; see FOK-server rules).
- A globally synchronised schedule (re-creates the cluster it removes).
- Little's Law over summed .ms (the identity holds, the data does not: poll.php
  books no counters and is exactly what saturates the pool).
- Handing the beat over the wire, or stretching ANY interval under load.
- screen_ms or ANY new or adaptive pace field. The standing direction is LESS
  mechanism, not more.
