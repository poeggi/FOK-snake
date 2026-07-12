# FOK Snake — Server Implementation Prompt

> Paste this as the task brief for the agent/session that builds the server.
> It is a spec, not a to-do; confirm the OPEN DECISIONS before writing code.

## Context

FOK Snake is an offline-first browser game (client repo at `D:\repos\FOK`,
GitHub `poeggi/FOK`, work branch `multiplayer`). The client sim was refactored
onto a deterministic fixed 60 Hz tick clock (commit a5844f7): `simTick` is the
single source of truth, `LEVEL_CFG` holds ticks-per-move, and all game state is
a pure function of `simTick`. This determinism is the foundation the server
should exploit (see Anti-cheat).

Build a small, single-deploy backend that serves the FOK client. It must never
break the offline single-player experience: every server feature is additive and
degrades gracefully when the server is unreachable.

## Functional requirements

1. **Global highscores**
   - Store and serve a global leaderboard (name, score, level, timestamp).
   - Submissions must be **validated as real play**, not just accepted (see
     Anti-cheat). Reject/flag implausible or unverifiable scores.
   - Serve the list on demand (paginated). The client shows local scores on
     page 1 and online scores on page 2, loaded lazily.

2. **1:1 multiplayer coordinator**
   - Matchmaking: pair two waiting players into a duel session.
   - Facilitate real-time state exchange between the two peers during a duel.
   - Honor the client's netcode constraints: tick-based sync, dynamic cadence
     `netInterval = max(4, ticksPerMove)` (4-15 Hz), **binary bit-packed**
     payloads, and a hard **1280-byte** per-update cap (one un-fragmented
     IPv6-MTU datagram). See OPEN DECISION on P2P vs relay.

3. **FOK transfer (in-game currency)**
   - Each player has a unique, stable ID. Allow player A to send FOK to player B.
   - Server-authoritative ledger; authenticated sender; no double-spend; audit
     trail. A transfer must be impossible to spoof as another sender.

4. **Game news / announcements**
   - Server supplies the current announcement; clients poll for it.
   - Must match the existing client `ANNOUNCEMENT` shape in `js/assets.js`
     (`{ id, headline, lines[] }`) so the client fetches instead of hardcoding.
   - Empty/absent announcement = client shows no newspaper badge.

5. **Admin web interface**
   - Login-gated. Dashboard with usage statistics (players, duels, submissions,
     active sessions over time).
   - Manage announcements (the news feed pushed to clients).
   - View/moderate the leaderboard (remove flagged/cheated entries).

## Anti-cheat (highscore integrity)

Leverage the deterministic sim: a score submission carries the **RNG seed + the
full input timeline** (tick-stamped direction/boost events), not just a number.
The server **re-simulates the run headlessly** with the same tick engine and
verifies the resulting score/level. Reject on mismatch.

- This requires the pure sim (movement, gems, bars, scoring, RNG) to be
  extracted into an **isomorphic module** shared by browser client and server.
  Prerequisite already flagged: replace `Math.random()` in the sim with a
  **seeded PRNG** stepped in lockstep with `simTick`.
- Layer defense in depth: signed session tokens (HMAC), server-issued seeds,
  rate limiting, input-length/duration sanity bounds, and replay-cost caps.
- Note honestly: replay validation proves the score is achievable by *some*
  input sequence (defeats naive POST-a-number cheating); it does not by itself
  stop a play-bot. Bots are a separate, later concern.

## Non-functional

- **Offline-safe**: client works fully without the server; online features fail
  soft.
- **Realtime budget**: 1280 bytes/update including all overhead; binary, not JSON.
- **Scale**: modest (hobby scale); prefer operational simplicity over horizontal
  scale. Single binary + single-file DB is fine to start.
- **Portability of the sim**: server and client run the identical sim code.

## Recommended stack (confirm in OPEN DECISIONS)

- **Node.js + TypeScript** — lets the deterministic sim be shared verbatim
  between the plain-JS client and the server for replay validation. Biggest
  architectural lever here.
- HTTP API: Fastify (or Express). Realtime signaling: WebSocket.
- Persistence: SQLite to start (single file, sufficient), Postgres if it grows.
- Realtime duel transport: **WebRTC DataChannel** (unreliable+unordered) with
  the server as **matchmaking + signaling broker**; keeps true P2P and maps the
  1280-byte cap to one UDP datagram. Server-relay fallback for NAT failures.
- Admin UI: server-rendered or a tiny SPA; session-cookie auth; bcrypt/argon2
  password hashing; no third-party auth needed at this scale.

## Suggested API surface (sketch)

- `GET  /api/news` -> current announcement (ANNOUNCEMENT shape) or 204.
- `GET  /api/scores?page=&limit=` -> leaderboard page.
- `POST /api/scores` -> `{ seed, inputs[], claimedScore, token }`; server
  re-simulates, then stores or rejects.
- `POST /api/session` -> issue player identity + signed token + seed.
- `POST /api/fok/transfer` -> `{ toId, amount }` (authenticated).
- `GET  /api/fok/balance`.
- `WS   /rt` -> matchmaking, duel signaling, in-duel relay fallback.
- `*    /admin/**` -> login-gated admin app + stats + news/leaderboard mgmt.

## Deliverables

1. Extracted isomorphic sim module + seeded PRNG (client refactor + server import).
2. Server with the endpoints above, SQLite schema, and replay validator.
3. Admin interface (login, stats, news editor, leaderboard moderation).
4. Client integration points (news fetch, online scores page, duel client,
   FOK send UI) — may be a follow-up milestone.
5. Deploy story: single command, env-configured, plus how the client points at it.

## OPEN DECISIONS (answer before building)

- Language/stack: Node+TS as recommended, or something else?
- Duel transport: P2P WebRTC DataChannel (server = signaling) vs fully
  server-relayed authoritative exchange?
- Player identity: anonymous device-generated ID, or accounts/login for players?
- Hosting target (VPS, container, serverless) and domain — informs auth/session
  and deploy shape.
- Repo: new standalone repo, or a `server/` dir in the FOK monorepo (sharing the
  sim module is easier in a monorepo)?
