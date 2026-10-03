# The server contract: naming, pacing, clock, identity, items

FOK-server is a separate production repo with its contract in docs/API.md:
read it, never edit it unprompted.

## Name the contract, build against it
- Release notes name the CONTRACT ("needs server API 4.7"), never a server
  build: the API minor is the only thing this repo implements, declares and
  can check. A client/server pairing goes in a dated scratch note, never in
  the repo.
- NET_API_BUILT_MINOR is a DECLARATION: bump it in the commit that
  implements a contract minor, or every player gets a permanent UPDATE
  AVAILABLE. Version tests derive from `NET_API_BUILT + '.' +
  NET_API_BUILT_MINOR`, never a literal.
- No backward-compatibility shims: client and server deploy as a pair, so a
  fallback for an older server is dead code (no fallback constants,
  version-keyed cadences, "older server" branches). If deploy ORDER could
  bite, say so in one line and let the user decide.
- Feature-detect every optional FIELD; never gate an optional feature on the
  version. A value the contract states is read from the contract; nothing
  local stands in for it.

## A rename never touches a wire word
- The server's vocabulary is not ours: signal types (`Signals::TYPES` in
  FOK-server), tournament event names (docs/API.md Events table), request
  actions and fields, localStorage keys. Screen phases, labels and functions
  rename freely.
- Before a rename lands, list every string literal the diff changed (`git
  show <sha> -- js/ | grep -o "'[a-zA-Z][a-zA-Z0-9 :_.-]*'" | sort | uniq -c`)
  and check each non-phase, non-label one against the server.
- A simulated server in a suite (tourney-world.js, the signal bus in
  net-handshake.js) is a copy of the CONTRACT; it never renames with the
  client.
- A wire word lives in ONE place per direction: the dispatcher's `case` and
  the sender's literal; grep both when either moves.

## Request pacing (js/net-api.js; server half: docs/API.md Pacing)
The server has a LOW WORKER LIMIT. The budget is concurrent connections per
client, never bytes: every request in flight pays a slice on the shared host,
and a held poll owns a worker for its whole wait. Bursts on top of the beat
are the problem. Weigh every new request site and cadence against it.
- ONE background gate: every background request queues behind
  `_netGate()`; `_netGapWait(now, flight)` is pure: anything of ours in
  flight beats elapsed time, else wait what is left of the gap.
- ONE AT A TIME: a parked hold of ours (`_netPollHeld`) counts as traffic
  for every lane but the exempt one. Never a third request beside a hold.
- THREE lanes: `true` = paced background, waits a hold out (beat, roster,
  score); NET_BG_IDLE = same plus low priority (items.php); NET_BG_SOLO =
  EXEMPT: never beside another request of ours, no spacing, may go beside a
  parked hold because a player is waiting (signal.php, start.php, unheld
  poll, tournament.php, friend.php request/accept, match.php seek/cancel).
- THE SLOT: what is due goes out after the poll answers and before the next
  is armed (`_netPollArm`, pure `_netArmHold(gapN, flight)`, bounded by
  NET_GAP_TRIES). Folding into the poll beats sending beside it beats
  waiting.
- An aborted held poll stays parked on its worker until its deadline: never
  arm a held poll while the last aborted one may still be parked
  (`_netPollHoldEnd` / `_netPollNotBefore`). Neither DataChannel open, a
  reconnect nor hiding the tab aborts the poll in flight. Past
  NET_HIDE_HOLD_MS (30 s) a hidden, merely browsing tab reads unheld on
  NET_UNHELD_EVERY; a seek, a forming handshake or a held tournament keeps
  the hold.
- Ungated, but still counted as flight: the HELD poll and t.txt in
  `_netClockMs`.
- ONE EVENT, ONE CALL: a roles sheet IS a state read; nothing reads state on
  a timer. `state` is read only on screen entry, a transition, a
  shape-changing event, a doubtful sheet, or a mailbox back from down
  (`tourneyMailboxLost`). A `result` with `rows` is the standings. after_ms
  is honoured on the CALL (TT_AFTER_MAX 1 s).
- Entering the 1vs1 screen: hello first, the roster on the lobby's own poll
  (`fl`; friend.php only until the poll has served it once), then
  `_netTimeSync`. Hello and friend.php never share a tick.
- PRESENCE is a cursor and deltas: `friends_since` on hello / `fs` on the
  poll, `friends_delta` whole states, `friends_at` next cursor,
  `friends_more` continue at once (solo lane, NET_FR_PAGES). One landing
  place `_netFrApply`. Cursor 0 on presence-screen open, foreground,
  offline. A 204 leaves the cursor alone.
- q_ms is stored with the in-flight count; `netSelfStacked()` separates host
  load from our own overlap. The item queue stands aside ONCE while a duel
  forms, never in a loop.
- The beat is a contract constant: NET_HELLO_MS 60 s, NET_POLL_S 5 s,
  NET_GAP_MS 100 ms; never on the wire, never a setting, never
  load-adaptive. `pace` on hello is {hold} only. The heartbeat's phase is
  page load time. A signal older than NET_INVITE_STALE_MS is refused by its
  created stamp.
- Rejected: SSE/streaming push; a globally synchronised schedule; Little's
  Law over summed .ms; the beat over the wire or stretched under load;
  screen_ms or any new/adaptive pace field.

## ICE batch (js/net-rtc.js)
NET_ICES_MAX 24, NET_ICES_BYTES 15000, NET_ICES_WINDOW_MS 100 (arm-once from
the first buffered candidate). The first candidate goes alone unless a
request is in flight. A lost POST retries the whole array. A NEW signal type,
never a reshaped `ice`.

## Clock anchor
- ONE source: the `X-Fok-T` header on the static t.txt (never `now` off a
  worker answer: it carries the queue wait on the way in). The stamp is taken
  as the request lands, so every bad sample reads AHEAD, and the cold first
  request carries the most.
- One sweep shape (`_netTimeSync`), no caller options: request 0 warms the
  socket and is never a candidate; then NET_SYNC_N = 3 samples NET_GAP_MS
  apart; the lowest-RTT one wins; the latency report is their average. No
  cleanliness flag (no q_ms, no own-flight gate).
- Adopt (`_netAnchorAdopt`): within the sample's own RTT of the current
  anchor = noise, move halfway; further = a wrong anchor, take it outright.
- Refreshed by AGE at quiet moments, never by event: boot, foreground, a
  "future pts" refusal, the server's `resync` hint (forced); the multiplayer
  door, a game over (before the score goes out), a return to the main menu,
  a first start, a spectator boot (only when older than
  NET_ANCHOR_MAX_AGE_MS 10 min). A rematch never sweeps; nothing sweeps on a
  heartbeat.
- The server sync and the P2P burst write the same `_netSync.ofs` at
  different targets; never add a sync site that can run mid-match. The burst
  does NOT stamp `_netSync.at`.
- An outgoing `pts` is never backdated (the server refuses past
  `pts_ahead_max_ms` 200 ms; the 400 forces a re-sync).

## Identity token (contract: docs/API.md "Identity token")
The id is public. `tok` proves it: 32 hex the server mints on the first hello
of an unbound id and answers ONCE; only the operator's reset makes the next
hello mint again.
- ONE stamp site: `_netTokBody` on every POST body that names an id (the
  beacon too). Every request naming the id IS a POST (the poll and the vault
  restore carry their members as a JSON body through `_netRead`); nothing
  names the id on a request line. The bare GET is only the score board.
  `tok` is sent as null until a hello has minted one; never omitted.
- ONE rule for the answer: whatever a hello answers as `tok` is stored
  (`setCloudToken`). The cloud vault checks the same token, so `cloudBackup`
  REQUIRES one and never retries without it.
- 401 = `_netTokRefused`: the wire stops (`_netOk()` false, no beat, no
  retry), `netStatusNotice()` says ID BOUND TO ANOTHER DEVICE, the MY ID
  screen adds RESTORE YOUR BACKUP OR RESET YOUR ID. Ahead of the first
  answered hello of a session only hello's own 401 counts. An answered hello
  clears the latch.
- A 429 `too many attempts` (a wrong token past the per-address cap) is the
  same refusal (`_netTokNo`); the latch is the back-off, never a retry loop.
  event.php answers the same words for wrong event codes: a 429 there is the
  join's own.
- The identity moves as one: RESET ID clears the token; a restored file
  brings its `tok`, and one without it that names ANOTHER id clears ours;
  one naming this device's id leaves ours standing. Both call
  `netIdentityChanged()` (unlatch + hello). The cloud payload never carries
  `tok`; the file backup does (outside the crc).
- HTTPS ONLY: `netOffline()` is forced on any non-https: page
  (`_runInsecure`, js/game.js); NET_BASE and GAME_URL are https;
  smoke-ident.js refuses any `http://` literal in shipped sources.
- Guard: test/smoke-ident.js.

## Item registry (js/items.js, /api/items.php)
Ownership lives on the server, never in a local flag (a backup restore would
hand a duel loser their stolen gear back).
- The 4 POST actions `list|mint|seed|claim`; offline backlogs in cfg
  (`mintQ`, `claimQ`), `itemReg` = {itemId: {uid, seq}}, one-time
  `itemsSeeded`.
- js/hmac.js is SYNCHRONOUS SHA-256/HMAC (the sim WORKER emits the packet the
  tag rides in, so WebCrypto is unusable).
- Handover (`_ws*` in duel-core.js): on every frozen hash tick each client
  MACs a uid-sorted ownership digest with its per-match secret and ships it
  as `g` in the `h` packet. Tag = first 16 hex of HMAC-SHA256(key = the
  secret's 16 raw bytes; msg = `mid|tick|ws_digest`, tick unpadded decimal).
- Transfers are DERIVED by diffing consecutive attested hash ticks, never
  from the `wsget` event (it re-fires on rollback). hk = 64k-64 is pinned.
- A LOSS settles on our own tag, ship at once. A GAIN waits WS_CLAIM_WAIT
  (128 drain ticks) for the peer's tag, then ships unproven. A peer tag is
  kept only for a tick whose `_ws` provably agreed: an unverifiable tag
  FREEZES the instance server-side, so no tag beats a wrong one.
- 404 is soft. `itemSync` never marks `itemsSeeded` on a failed seed, so the
  reconcile (which deletes what the server never minted) never runs
  unseeded. `held` re-sends past grace; `stale seq` / `lost race` re-list
  and retry once; a claim older than 110 min is dropped. An item with no uid
  is worn and stealable, just unattestable.
- Stakes ride the wire: host-authored `sk` on every go, absent = OFF, echoed
  byte-exact; `_ttRoles` dresses a session that exists when the sheet lands.
- Guards: duel-hearts.js, tourney-e2e.js section 13, smoke-items.js.
