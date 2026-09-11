# Request pacing (client half; server half: FOK-server docs/API.md Pacing)

One idea: fewer simultaneous requests per client. The cost is a ~51 ms slice
paid PER REQUEST IN FLIGHT on the shared host (connection/HTTP2 layer, not
worker spawn, not bytes); a held long poll owns a worker for its whole wait;
bursts on top of the beat are the problem, not the beat. Two exempt calls
leaving in the same ms still both pay the slice.

## The lanes (js/net-api.js)
- ONE background gate: every background request queues behind `_netGate()`;
  `_netGapWait(now, flight)` is pure: anything of ours in flight beats
  elapsed time, else wait what is left of the gap.
- ONE AT A TIME (API 4.10): a parked hold of ours (poll `_netPollHeld`, relay
  `_netRelayHeld`) counts as traffic for every lane but the exempt one. A
  third request beside a hold is never right.
- THREE lanes: `true` = paced background, waits a hold out (beat, roster,
  score); NET_BG_IDLE = same plus low priority (items.php); NET_BG_SOLO =
  EXEMPT: never beside another request of ours, no spacing, may go beside a
  parked hold because a player is waiting (signal.php, start.php, unheld
  poll, tournament.php, friend.php request/accept, match.php seek/cancel).
- THE SLOT: what is due goes out after the poll answers and before the next
  is armed (`_netPollArm`, pure `_netArmHold(gapN, flight)`, bounded by
  NET_GAP_TRIES). Folding into the poll beats sending beside it beats waiting.
- An aborted held poll stays parked on its server worker until its deadline,
  so never arm a held poll while the last aborted one may still be parked
  (`_netPollHoldEnd` / `_netPollNotBefore`); neither DataChannel open nor a
  reconnect aborts the poll in flight.
- Ungated: the HELD poll and t.txt in `_netClockMs` (both still COUNT as flight).
- ONE EVENT, ONE CALL: a roles sheet IS a state read; nothing reads state on a
  timer (the server runs its deadlines on the poll). `state` is only a screen
  entry, a transition, a shape-changing event, a doubtful sheet, or a mailbox
  that was down and is back (`tourneyMailboxLost`). A `result` with `rows` is
  the standings, no read. after_ms is honoured on the CALL (TT_AFTER_MAX 1 s).
  Entering the 1vs1 screen: hello + friend list first, then `_netTimeSync`.
- PRESENCE is a cursor and deltas (server 4.6): `friends_since` on hello /
  `fs` on the poll, `friends_delta` whole states, `friends_at` next cursor,
  `friends_more` continue at once (solo lane, NET_FR_PAGES). One landing
  place `_netFrApply`. Cursor 0 on presence-screen open, foreground, offline.
  A 204 leaves the cursor alone.
- index.html DNS-prefetches the API origin (DNS only; a preconnect cannot
  honour the OFFLINE setting without an inline script).
- q_ms is stored with the in-flight count; `netSelfStacked()` separates host
  load from our own overlap. The item queue stands aside ONCE while a duel
  forms, never in a loop. Hello and friend.php never share a tick.

## ICE batch (js/net-rtc.js)
NET_ICES_MAX 24, NET_ICES_BYTES 15000, NET_ICES_WINDOW_MS 100 (our number,
settled; the window is real latency, arm-once from the first buffered
candidate). Two gates, both needed: `netSrvMinor()>=4` and
`_netIcesPeerOk(s.peerV)` (an old peer silently drops the array). The first
candidate goes alone unless a request is in flight. A lost POST retries the
whole array. A NEW signal type, never a reshaped `ice`; the sender gates on
the PEER version (answerer knows it from the offer, host from the answer).

## Clock anchor
- Refreshed by AGE, never by event: one sweep shape, 3-5 samples NET_GAP_MS
  apart, min-RTT kept, exclusive on the wire. Sites: boot (set), the
  multiplayer door (nudge when older than NET_ANCHOR_MAX_AGE_MS 10 min),
  foreground (set), a "future pts" refusal (set), first start and spectator
  boot (3 samples, nudge by age or `resync:true`). A rematch never sweeps;
  nothing sweeps on a heartbeat. nudge = half the delta. A sample with our
  own requests in flight is UNCLEAN: adoptable, never REPORTED as latency.
- The server sync and the P2P burst write the same `_netSync.ofs` at
  different targets; never add a sync site that can run mid-match. The burst
  does NOT stamp `_netSync.at`.
- An outgoing `pts` is never backdated (the server refuses past
  `pts_ahead_max_ms` 200 ms and logs it; the 400 forces a re-sync).
- The clock SOURCE is static t.txt stamped by the web server; already safe.

## The beat is a contract constant
Heartbeat NET_HELLO_MS 60 s, poll NET_POLL_S 5 s, gap NET_GAP_MS 100 ms:
never on the wire, never a setting, never load-adaptive. `pace` on hello is
{hold} only; hello_ms/poll_ms/gap_ms from an older server are ignored. A
signal older than NET_INVITE_STALE_MS is refused by its created stamp. The
heartbeat's phase is page load time. spread_ms is withdrawn.

## NET_API_BUILT_MINOR is a DECLARATION
Bump it in the same commit that implements a contract minor, or every player
gets a permanent UPDATE AVAILABLE. Version tests derive from
`NET_API_BUILT + '.' + NET_API_BUILT_MINOR`, never a literal.

## How to apply
Feature-detect every optional field; never gate an optional feature on the
version. A value the CONTRACT states is read from the contract, not off the
wire, and nothing local stands in for it.

## Rejected, do not re-propose
SSE/streaming push; a globally synchronised schedule; Little's Law over
summed .ms; the beat over the wire or any interval stretched under load;
screen_ms or any new/adaptive pace field. Less mechanism, not more.
