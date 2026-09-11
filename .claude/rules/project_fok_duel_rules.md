# 1vs1 duel rules, windswept steal, item registry

## DUEL RULES
Full classic progression together: level 1, shared 10-gem goal, level-up
regenerates bars + speed from LEVEL_CFG (pinned NORMAL), READY/GO shows
LEVEL n, level 10 continues at max. Gem = level*100 to the eater, +2 growth.
3 hearts per MATCH; a death costs a heart and restarts the CURRENT level; out
of hearts ends the match (both out = draw); the level-finishing eater earns
a heart back (cap 3). Winner banner + PLAY AGAIN?. HUD 2x2 (hearts top,
shared gems + level below; landscape single column). No coins/achievements,
no lucky/epic tiers; the collectibles (power pellet, GOURANGA line, TIME
CRYSTAL) run on the single-player implementation. A gouranga bead counts
toward the ten and scores level*100. The crystal warps pace to level 3's via
_paceNow()/_paceWarp(), never the per-device difficulty accessor. The quit
dialog ducks audio 50%.

x10 CONTRACT: a duel never honours x10; no flag exists in duel mode, on the
wire or in the hash; `_X10()` is 1 when players is set. Guard: smoke-duel.js.

SPEED TOURNAMENT (`speed` on create, lobby, roles sheet, state; go packet
`sp`, absent = OFF): every round is a speed round. In the sim it is
_duelForceSpeed (config, never hashed); the hashed verdict is _speedRound.

Submission integrity: only a NEW result, submitted LIVE at game-over, reaches
the central board; never a stored stat. Pairs with server-side replay
validation (seed + tick-stamped inputs).

## Windswept steal (v2.7.0; "volatile" is renamed windswept everywhere)
- Near-miss steal = a pass on DIFFERENT headings: edge-triggered, consumes
  rng, SIM state (`_nmWasAdjacent` hashed + snapshotted).
- Side-by-side scrape = same heading, one lane apart: sparks + squeal, judged
  per FRAME in the renderer (`_duelScrapeFx`), no rng, no state, no sim
  event. Do not re-add it to the sim. Audio: `Snd.scrapeSet(active)` is one
  sustained voice ridden by gain, released via `if(phase!=='duel')
  Snd.scrapeSet(false)` in the RAF loop; never a retriggered one-shot.
- Knobs: chance is price-dependent (`_wsPct(cost)`), boost ladder on top
  (neither/one/both boosting = nominal/mild/double); both wearing = ONE
  victim per pass; speed round re-rolled per spawn; halo is cat 'divine'; an
  uncollected item reverts at a level rebuild; one loose item at a time (the
  cooldown).
- `_wsTransfer` is ONLINE-ONLY and per-device (each client applies its own
  half); a LOCAL duel hands player 2 an empty windswept list and persists
  nothing. A won item DISPLACES a same-cat worn item (owned, unworn).
- No ITEM STAKES toggle for ordinary online duels (plays for keeps); only a
  tournament creator chooses (`_netSess.stakes === false` suppresses the
  write-back).
- Guards: duel-desync lane "windswept steal 5% loss"; sim-duel.js (a
  same-direction pass is sim-silent); smoke-game.js `_scrapePoint`.

## Item registry (client 3.0.0+, server API 4.0)
The server is a separate production repo: read it, never edit it unprompted.
Ownership lives off the device (a local boolean handed a duel loser their
stolen gear back via backup restore).
- js/items.js: the 4 POST actions on `/api/items.php` (`list|mint|seed|
  claim`); offline backlogs in cfg (`mintQ`, `claimQ`), `itemReg` =
  {itemId: {uid, seq}}, one-time `itemsSeeded`.
- js/hmac.js: SYNCHRONOUS SHA-256/HMAC (the sim WORKER emits the packet the
  tag rides in, so WebCrypto is unusable).
- Handover (`_ws*` in duel-core.js): on every frozen hash tick each client
  MACs a uid-sorted ownership digest with its per-match secret and ships it
  as `g` in the `h` packet. Tag = first 16 hex of HMAC-SHA256(key = the
  secret's 16 raw bytes; msg = `mid|tick|ws_digest`, tick unpadded decimal).
- Transfers are DERIVED by diffing consecutive attested hash ticks, never
  from the `wsget` event (it re-fires on rollback). hk = 64k-64 is pinned.
- Direction: a LOSS settles on our own tag, ship at once. A GAIN waits
  WS_CLAIM_WAIT (128 drain ticks) for the peer's tag, then ships unproven. A
  peer tag is kept only for a tick whose `_ws` provably agreed (an
  unverifiable tag FREEZES the instance server-side; no tag beats a wrong one).
- 404 is soft (safe against a pre-4.0 server); `itemSync` never marks
  `itemsSeeded` on a failed seed, so the reconcile (which deletes what the
  server never minted) never runs unseeded. `held` re-sends past grace;
  `stale seq` / `lost race` re-list and retry once; a claim older than 110
  min is dropped. An item with no uid is worn and stealable, just unattestable.
- Stakes are negotiated on the wire (3.2.0): host-authored `sk` on every go,
  absent = OFF, echoed byte-exact; `_ttRoles` dresses a session that exists
  when the sheet lands. Guards: duel-hearts.js, tourney-e2e.js section 13,
  smoke-items.js.
