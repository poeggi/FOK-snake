# Request pacing (client half; server half in FOK-server)

Everything here is shipped on both sides (server 1.4.11 / API 4.4, client 4.0.15).
Nothing is open. The whole family of fixes is one idea - fewer simultaneous
requests per client - and each half is useless without the other.

## The measurement that drives everything

- Every queue wait over a millisecond in live snapshots was served by an ALREADY
  WARM worker: PHP-FPM child spawn is dead as an explanation. Contention sits
  ABOVE the pool (connection / HTTP2-stream layer, where a static file also
  sits), and the cost is a ~51 ms slice paid PER REQUEST IN FLIGHT, not per
  byte. Coalescing N requests into one saves (N-1) slices; a bytes argument was
  never the case.
- The host serves ~20-21 concurrent PHP requests; a HELD long poll owns a worker
  for its whole wait (one 8-player lobby holds ~8). The steady 30 s heartbeat is
  not the problem; bursts on top of it are (a round board wakes 8 clients in the
  same ms).
- Being PAST the gate is not the same as going out together: two exempt calls in
  one tick race each other and BOTH pay the slice. Measured: start.php +
  tournament.php leaving in the same ms from one client, 128 ms each, pool mean
  2.5 ms. Hence the duel path is no longer exempt.

## The lanes (js/net-api.js)

- ONE background gate: every background request queues behind _netGate(); pure
  rule _netGapWait(now, flight) - anything of ours in flight beats any elapsed
  time, otherwise the wait is what is left of the gap. A HELD poll deliberately
  does NOT count (parked server-side; counting it would park every heartbeat
  behind the poll a lobby holds open by design).
- THREE lanes: `true` = paced background; NET_BG_IDLE = also stands aside for a
  held poll, priority low (items.php); NET_BG_SOLO = never beside another
  request of ours, NO spacing (signal.php, an unheld poll - what a player is
  actively waiting for).
- Ungated on purpose: the HELD poll (it IS the parked slot the contract allows)
  and time.php in _netClockMs (a gate wait would land inside the measured RTT,
  hence in the clock offset).
- ONE EVENT, ONE CALL: a roles sheet carries the whole match, so it IS a state
  read (_ttStateAt stamped in _ttRoles) - the housekeeping tick must never ask
  the server to repeat a pushed sheet. after_ms is honoured on the CALL, never
  the render (client bound TT_AFTER_MAX 1 s as a wrong-number guard; the server
  serves 400 ms).
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

- CONNECT FIRST, MEASURE SECOND: _netTimeSync runs from _netRequestStart after
  dc.onopen, never in parallel with the ICE handshake. A sample taken with our
  own requests in flight or a non-trivial q_ms is UNCLEAN: adoptable as an
  anchor if nothing better exists, never REPORTED as latency (start.php works
  the pair's lead out of that figure; an inflated one widens the start for the
  opponent too). Several samples, min-RTT kept. `resync:true` buys the NEXT
  start one full sweep, never latched.
- ALREADY SAFE, do not "fix": the clock SOURCE is the server's static t.txt
  stamped by mod_headers, so the stamp never queues for an FPM worker. The
  residual risk is only the RTT sample around it.

## The beat is a contract constant

- pace on hello is {hold} ONLY. The beat - heartbeat 30 s (half the 60 s online
  window), poll wait 9 s, gap 100 ms between a client's own requests - is a
  CONTRACT CONSTANT (docs/API.md Pacing on the server side): never on the wire,
  never a setting. Nothing about the beat follows load; interval-stretching
  under load was removed (its ceiling exceeded the online window and made
  presence flicker).
- Client side: _netPace is {hold:true} and nothing else; the three intervals are
  NET_HELLO_MS / NET_POLL_S / NET_GAP_MS. hello_ms / poll_ms / gap_ms from an
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

## Open offers (flagged only - need an explicit go)

- POST as text/plain to drop the CORS preflights (server jsonBody() never
  checks Content-Type).
- The double hello on entering the 1:1 screen (net-session.js); also the 5 s
  screen tick on lobby/friends/tourney-lobby screens is not in the contract.
