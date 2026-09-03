# Tournament Mode - client implementation plan

The FOK-server side of this feature is specified separately in
FOK-server/docs/TOURNAMENT-SPEC.md (API 4.0 -> 4.1). This document is the
FOK-snake half: what gets built, in which order, and how each phase is
verified. Companion invariant: the server orchestrates and settles, but never
carries a byte of game traffic.

## What Tournament mode is

A local client creates a tournament; it is announced to clients behind the
same public IP (server-side filter, no LAN protocol needed) and joinable by
code from anywhere. 2..10 players join, the creator starts.

- Round 1 (SPARSE, 2 hearts): everyone plays at most 4 matches. With
  N <= 5 players that is a full round-robin (N-1 matches each); with
  N >= 6 each player meets the neighbors at offsets 1 and 2 on the seeded
  circle - exactly 4 matches each, 2N total (10 players = 20 matches, not
  the 45 of a dense round-robin).
- Stats interstitial: standings by points; the best 50% advance.
- Knockouts (2 hearts): seeded single-elimination bracket, byes for top
  seeds when the advancer count is not a power of two.
- Final: a normal 3-heart duel.

Matches run one at a time. The two players play; every other participant
spectates over a two-tier relay tree (feeder -> 2 primaries -> secondaries)
with warm-standby failover. Item stakes are a creator choice at creation,
default OFF (off = local-duel behavior: no registry claims, no wardrobe
transfer).

IRON RULE preserved throughout: ONE sim implementation for solo, local 1:1,
online 1:1 and spectating. A spectator is the same sim with input authoring
disabled, running ~1.5s behind the live edge so forwarded inputs land in its
future window and no rollback ever triggers.

## Status

- Step 0 (menu restructure): DONE, commit 2eb6c26. Main menu SOLO PLAY /
  MULTIPLAYER; duelMenu phase is the MULTIPLAYER menu with TOURNAMENT greyed
  (COMING SOON); new duel11 phase holds 1:1 ONLINE / 1:1 LOCAL.
- Phases A..F: NOT STARTED. Order: A -> (server 4.1 deployed) -> B -> C ->
  E -> F. B onward is blocked on the server speaking API 4.1.

Every phase is independently shippable and green-gated; each wire-surface
phase is a MINOR bump via annotated tag (hook-managed versions - never
hand-edit sw.js / js/assets.js).

## Phase A - heartsMax + stakes as negotiated match parameters (MINOR)

Tournament round 1 and knockouts run at 2 hearts; the final and ordinary
duels at 3. Stakes must be switchable off per match.

- sim.js: new module global `_duelHeartsMax = START_LIVES`, set only by the
  startDuel command (clamped 1..3). Replace the four duel-side START_LIVES
  reads: init (sim.js:214), contested-heart spawn gate (:377), heart pickup
  cap (:487), level-finisher heart-back cap (:513). Level carry, death and
  match-over read p.lives and need no change.
- net-session.js: session fields `s.hearts` (default 3) + `s.stakes`
  (default true). Both 'go' builders gain `hm` (:498-501 match/rematch,
  :558 boundary); the go receive handler validates and adopts it; a mismatch
  vs a preset expectation ends the match. The _netTxShip/_netTxEcho verifier
  (:320-368) makes `hm` a byte-exact two-party agreement for free.
- game.js: beginOnlineDuel (:1037) passes hearts into both sim homes (worker
  duelStartNet, in-process startDuel); _duelClaimArgs (:1008) returns mid:''
  when stakes are off; _duelWsLists (:582) returns empty lists; one guard
  line at the top of _wsTransfer (:597).
- sim-worker.js: forward `hearts` in duelStartNet (:238); mirror
  _duelHeartsMax into the snapshot so the HUD heart row draws against it
  (check-snapshot enforces the mirror).
- Tests: hearts=2 suite (match ends after 2 deaths, pickup caps at 2).
  EXISTING goldens must NOT move (sim-determinism.js GOLDEN + GOLDEN_DUEL
  unchanged is the proof the refactor preserves default behavior); new
  GOLDEN_DUEL_H2 lockstep golden; duel-driver `opts.hearts` +
  hm-on-every-go + mismatch-kill scenarios.

## Phase B - spectator core + standalone "watch a friend" (MINOR; needs 4.1)

All in the one shared sim/netcode - no second code path.

- Pacing by startPts bias: a spectator sets startPts += SPEC_DELAY_MS
  (1500). Both homes derive tick targets from startPts, so the whole sim
  runs behind with zero new pacing code. Widen the future gate when
  spectating: RB_SPEC_FUTURE = 192 vs RB_FUTURE 32 (duel-core.js:1123).
- Envelope `{t:'sp', g:<feederGen>, n:<seq>, p:0|1, m:<verbatim packet>}` on
  a RELIABLE ordered DataChannel, separate from the unreliable duel channel
  (SPEC_PKT_MAX 16384). Inner packets are the parsed originals, never
  rebuilt - byte-identity is asserted in tests. Forward set: go, in, st,
  rs, bye, h.
- `_netPeerInput(m, srcIdx)`: an explicit author index replaces the
  `oP = 1 - netMyIndex()` hardcode (duel-core.js:1101); peer-seq dedup
  becomes per-author.
- `netSpectating()` predicate in both homes (worker shim beside
  sim-worker.js:43-44). Consumers: _armIndex returns -1 (input.js:478);
  netLocalInput swallows; the rs adoption gate (duel-core.js:645) gains a
  spectator exemption; the outbound tick schedule sends nothing (no
  in/h/st/rs). Hash checking stays on the receive side; a mismatch triggers
  a silent fresh-'rs' request + RE-SYNCING cover, never a repair toward the
  players.
- Bootstrap: on channel open the feeder (= match host, author of every 'go')
  sends `{t:'sctx', seed, startPts, epoch, lvl, hm, names, sv}` then its
  newest 'rs'; the role-agnostic catch-up branch (duel-core.js:665-691)
  rebuilds the whole world including RNG. A late join is the same path.
- UI: netDuelWarn() gains a persistent lowest-priority 'SPECTATING' return
  so _drawDuelWarn renders the banner with zero new draw code; duelOver for
  spectators shows the result without the PLAY AGAIN vote.
- Discovery: WATCH action on friends flagged by the new hello
  `friends_playing` field; `watch` signal round-trip (req -> ok naming the
  feeder / no); the feeder auto-accepts friends and caps direct spectators
  at 3 until Phase C.
- Tests: duel-driver generalized to N clients + named-links wire (the
  2-client suites must pass UNCHANGED first - pure-refactor gate); new
  duel-spec.js: spectate through level-up/respawn/rematch with continuous
  ring-hash byte-equality at settled ticks, late join, mismatch self-heal,
  zero authored records.

## Phase C - two-tier relay tree + failover (MINOR)

- Primaries are spectators that also serve: they keep [sctx, last 'rs', all
  envelopes since] (the feeder emits an enveloped 'rs' every 10s as a
  checkpoint; roughly a 10-15KB buffer) and answer
  `{t:'sreq', from:<n>, g, rs?}` and `{t:'ssub'}` (warm standby, silent).
- Secondaries dual-connect to both primaries; they feed from one and fail
  over locally on 1.5s of envelope silence (the feeder's 16-tick heartbeat
  cadence makes silence unambiguous); records are idempotent by (p,q) so
  overlap during a switch is harmless.
- Backup feeder: the primaries detect 2s of feeder silence; primary 0 asks
  the OTHER player via `watch{kind:'feed-req'}` (lockstep means it holds
  both input streams); generation `g` bumps, fresh sctx+rs, the stream
  resumes.
- Escalations: a primary that is backgrounded sends a proactive `standdown`
  on visibilitychange (the server re-deals); both primaries dead -> an
  `orphan` call, the server promotes replacements and a roles patch fans
  out.
- New js/net-spec.js if the serve/failover logic outgrows ~300 LOC (then:
  index.html tag + harness concat list; sw.js is hook-managed).
- Tests: duel-spec-tree.js with 5 clients: clean run; primary kill
  (failover < 2s, zero divergence); feeder kill (generation bump); late
  join served entirely by a primary (the feeder's byte count is asserted
  unchanged).

## Phase E - tournament flow + UI (MINOR; flips the greyed menu entry)

- New js/tourney.js (orchestration only, no sim code): client tournament
  state, the server-generated 'tourney' signal dispatcher, the auto-pairing
  driver, and the result reporter (retry until acked, idempotent, players
  only).
- Pairing: on a roles sheet where I play, set s.hearts (2, or 3 for the
  final) + s.stakes from the sheet, then the standard offer/answer flow
  with the assigned peer (feeder = players[0] = offer host, invariant);
  epoch lines reset on 'offer' per the existing rule; start.php per pair
  is unchanged. Where I spectate, connect per the sheet using Phase C
  machinery.
- hello: send `tourneys:true` only while tournament screens are open;
  consume `r.tourneys` (open lobbies behind the same public IP) plus
  join-code entry as the fallback.
- Four new phases in UI_INPUT/SCREENS/CONTROLS:
  - tourneyLobby: create (stakes toggle, join code shown big, live match
    math from the sparse schedule: "N PLAYERS - M MATCHES ROUND 1"), join
    by code, member list, host START.
  - tourneyBracket: round-1 standings (points, tie-break columns) with the
    advancing half highlighted; the KO tree.
  - tourneyCeremony: "MATCH 7 OF 20 - KAI vs JO - YOU SPECTATE" / "YOU ARE
    UP - 2 HEARTS"; auto-advances on the next roles signal.
  - tourneyPodium.
  Reuse drawGlass/drawConfirm/full-screen takeover/duelOver ceremony
  styling. The TOURNAMENT row in the MULTIPLAYER menu un-greys, gated at
  runtime on the server reporting API minor >= 1.
- Tests: scripted 'tourney' signal sequences over the harness driving
  lobby -> roles -> report -> ceremony -> podium against a mocked _netPost;
  the result POST fires exactly once per match end per player and never
  from a spectator; screens smoke for the new phases.

## Phase F - end-to-end + live smoke

- tourney-e2e.js (HEAVY tier): 4-6 harness clients + an in-harness scripted
  role/result server (data, not HTTP) running round 1 -> interstitial ->
  KO -> 3-heart final -> podium, with injected feeder death, primary death,
  double primary death, a contradictory result (the freeze surfaces), and a
  backgrounded player.
- items-live-style live probe additions only on request; production DB
  hygiene first.

## Failure matrix

| Failure | Handling |
| --- | --- |
| Feeder's relay duty dies | Primaries pull the backup feeder (the other player); generation bump |
| One primary dies | Local warm-standby failover, no server round-trip |
| Both primaries die | orphan call -> server re-deals roles |
| A player backgrounds | Existing suspend/catch-up machinery; total silence -> result timeout -> walkover |
| Late spectator | sctx + checkpoint rs + envelope tail from a primary |
| Result contradiction | Bracket node frozen + admin alert; admin clears |
| Creator leaves mid-run | Forfeits their matches; the tournament continues (the creator owns the lobby, not the bracket) |

## Verification

- Every phase: `bash test/checks.sh` fast tier green pre-commit; `--full`
  (including the new HEAVY suites) green before any tag.
- Phase A asserts the existing goldens byte-unchanged; new goldens only for
  new behaviors.
- Wire budget: worst-case envelope measured against SPEC_PKT_MAX in
  smoke-net.
- Manual: two devices + one spectator on LAN through a level-up and a
  mid-match phone lock of a primary; then a 4-player tournament dry run.

## Size estimates

A ~250 LOC. B ~900 LOC + driver rework (riskiest, 1.5-2 weeks). C ~700.
E ~1200 (UI-heavy). F ~500 of test code.
