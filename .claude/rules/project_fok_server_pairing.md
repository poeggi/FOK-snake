# Client <-> server version pairing, and what only the pair can tell you

FOK-server is a SEPARATE PRODUCTION repo: read it freely, never edit it without
an explicit ask. What follows is what neither repo's code records.

## Which client needs which server

- 4.0.26-28 <-> 1.4.15-1.4.17: clock anchor by age, tournament state poll gone,
  result rows applied locally.
- 4.0.30 <-> 1.4.18 / API 4.5: 60 s heartbeat, stale-invite gate.
- 4.0.31+ <-> 1.5.0 / API 4.6: presence as deltas off the poll, flat beat.
- 4.1.x adds client-side things only (smooth snake, one worker per client, the
  API dns-prefetch). No sim rule changed, so 4.1 matchmakes among itself.

Version rule on the server side: a CONTRACT change bumps the middle digit
(1.4.18 -> 1.5.0), anything else is a patch.

## Server-side facts the client repo cannot show

- Every request keeps its worker after the response for the deferred tail
  (counters, presence fold, housekeeping).
- poll.php's hold loop cannot notice a gone client: PHP only learns on write.
  This is why the client never arms a held poll while an aborted one may still
  be parked (project_fok_pacing.md).
- q_ms = REQUEST_TIME_FLOAT minus Apache's X-Request-Start. The request BODY is
  not inside that window.
- `close()` is the only `result` emitter, so every result carries `rows`.
  Deadlines run on Tournament::pulse from poll.php and hello.php. Signals carry
  `created` in server seconds.
- Server checks: `bash test/checks.sh` there (needs php + apcu in the CLI); its
  remote smoke needs a real Apache for .htaccess.

## Measurements (not in either repo)

- The host offers HTTP/2 (ALPN h2, TLS 1.3). A parked poll is ONE stream, so a
  hello beside it costs what a hello alone costs, 25-33 ms warm. Idle
  connections survive over 60 s. A fresh TLS connection adds ~65-110 ms.
- hello's own PHP work is 3-5 ms. Bare hello 39 B up / 139 B down; the lobby
  shape 126 B / 337 B.
- Tournament cuts: the old 5 s state poll was ~1 KB/s per client, ~20x the push
  stream. Reflex reads went 270 -> 24 over the ladder.
- Presence deltas: the lobby screen went ~21 -> ~8 requests/min and hellos
  14 -> 1/min; presence bytes and DB work are near zero in steady state.
- The tourney harness runs 10 clients but the real cap is 8. Restate any figure
  for 8 before showing it.

## Open, in order -- none blocking, none to start unprompted

1. Never seen on real devices: the live presence pair -- lobby friend state,
   the counters on the poll's 200, a delta on a transition. No harness covers
   presence deltas against the live server.
2. Once server 1.5.1 deploys (Timing-Allow-Origin on the API replies and on
   t.txt): reload in a browser and read the performance resource entries for
   the API origin -- expect nextHopProtocol "h2" and connectEnd-connectStart 0
   on a reused connection. Before 1.5.1 the browser reads "".
3. Server findings handed over: FriendFeed::page() can return cursor 0 on
   friends_more at the stamp-0 tie of never-seen friends (fix = never return
   0); the first delta of every fs poll is unconditional; `tourneys` is not on
   the poll, so the tournament lobby keeps a 5 s hello for the announce list.
4. Queue waits, server side only. The floor is a flat 1 ms measured from
   outside, h2 and h1, fresh and reused. A tens-of-ms row is a real stall in
   the handoff to FPM, narrowed to the shared host (cold .htaccess lookup or a
   CPU slice), not our pool. Levers there: pm.max_children, hold_max_workers
   below the pool minus 2-3, housekeeping off the request tail, the hold loop
   flushing a byte so an aborted hold frees its worker. Client side has
   nothing left.
5. PARKED by the user: held poll 9 s -> 5 s (two-sided, ~1.8x poll requests).

Related: project_fok_pacing.md, project_fok_smooth_motion.md,
project_fok_item_registry.md.
