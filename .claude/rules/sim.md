# Sim: one path, tick model, dirQueue, duel rules

## IRON RULE: one sim, one mechanic implementation, all modes
- Modes: single, 1vs1 (local or online), tournament. A tournament match is an
  online 1vs1 with a bracket around it; nothing in the sim branches on it.
- Every mechanic (steering, boost, items, timing, bar placement, pickups) is
  ONE implementation shared by all modes. A mode differs only in INDEX
  MAPPING (which snake is mine), transport, the blocked set it hands in and
  where score is banked. Converge onto one shared routine (`_placeBars`,
  `_spawnExtras`, `_takePickups` in sim.js); never copy logic between the
  single and duel paths; never let a shared path read a mode-specific global.
- Input entry points map input-player -> sim-index at the SINGLE entry
  (input.js: `netGameActive() ? netMyIndex() : p`), then run identical code.
  Two-client tests exercise the ANSWERER (index 1), not just the host.
- In-game phase names stay GENERIC (`playing`, `levelReady`, `levelDone`,
  `dying`, `paused` and the duel twins). `phase` is the first field of
  RB_HASH_DUEL: renaming one is a wire change (MINOR bump + duel regolden).
  Menu phases are never hashed and may be renamed.

## Tick model
- ENGINE tick = fixed 1/60 s (`simTick`); every duration, catch-up and
  network cadence is an integer number of them.
- GAME tick = G engine ticks, fixed per level (LEVEL_CFG easy/normal/hard).
  Normal movement steps every 2nd game tick (period 2G), boost every game
  tick (period G): boost is a PARITY TOGGLE, exactly 2x, never a re-divisor.
  Implemented as gPer/_gDue countdown + _stepAccum (normal +1, boost +2 per
  game tick, spend 2 per step). netInterval = max(4, G), unaffected by
  boost.

## dirQueue: pop-then-judge at the cap (`_dirEnqueue` in sim.js)
1. Below the cap (queue < 3): judge d against the LAST REGISTERED direction
   (tail, or live heading when empty); same/reverse = not registered.
2. AT the cap: pop the tail, then judge vs the new tail; perpendicular
   REPLACES the revoked turn, same/reverse just cancels it.
3. Consume side: one entry per MOVE, the reverse-of-heading skip stays.
Newest-wins is the design. Boost-cancel-by-contrary-nudge lives in input.js
(_isOpp). Fixed, do not reopen: the judge-vs-tail anchor, one consume per
move, the 3-slot cap, the reverse skip. Guard: sim-duel.js section C.

## Duel rules
- Full classic progression together: level 1, shared 10-gem goal, level-up
  regenerates bars + speed from LEVEL_CFG (pinned NORMAL), READY/GO shows
  LEVEL n, level 10 continues at max. Gem = level*100 to the eater, +2
  growth.
- 3 hearts per MATCH; a death costs a heart and restarts the CURRENT level;
  out of hearts ends the match (both out = draw); the level-finishing eater
  earns a heart back (cap 3). Winner banner + PLAY AGAIN?.
- HUD 2x2 (hearts top, shared gems + level below; landscape single column).
  The quit dialog ducks audio 50%.
- No coins/achievements, no lucky/epic tiers. The collectibles (power pellet,
  GOURANGA line, TIME CRYSTAL) run on the single-player implementation. A
  gouranga bead counts toward the ten and scores level*100. The crystal warps
  pace to level 3's via _paceNow()/_paceWarp(), never the per-device
  difficulty accessor.
- x10: a duel never honours x10; no flag exists in duel mode, on the wire or
  in the hash; `_X10()` is 1 when players is set. Guard: smoke-duel.js.
- SPEED TOURNAMENT (`speed` on create, lobby, roles sheet, state; go packet
  `sp`, absent = OFF): every round is a speed round. In the sim it is
  _duelForceSpeed (config, never hashed); the hashed verdict is _speedRound.
- A duel is a function of seed + inputs only: startDuel zeroes every
  classic-mode global the duel reads (see the field-list rule in duel.md).
- Submission integrity: only a NEW result, submitted LIVE at game-over,
  reaches the central board; never a stored stat (server-side replay
  validation checks seed + tick-stamped inputs).

## Windswept steal
- Near-miss steal = a pass on DIFFERENT headings: edge-triggered, consumes
  rng, SIM state (`_nmWasAdjacent` hashed + snapshotted).
- Side-by-side scrape = same heading, one lane apart: sparks + squeal, judged
  per FRAME in the renderer (`_duelScrapeFx`): no rng, no state, no sim
  event, never in the sim. Audio: `Snd.scrapeSet(active)` is one sustained
  voice ridden by gain, released via `if(phase!=='duel')
  Snd.scrapeSet(false)` in the RAF loop; never a retriggered one-shot.
- Knobs: the chance is price-dependent (`_wsPct(cost)`), boost ladder on top
  (neither/one/both boosting = nominal/mild/double); both wearing = ONE
  victim per pass; speed round re-rolled per spawn; the halo is cat
  'divine'; an uncollected item reverts at a level rebuild; one loose item at
  a time (the cooldown).
- `_wsTransfer` is ONLINE-ONLY and per-device (each client applies its own
  half); a LOCAL duel hands player 2 an empty windswept list and persists
  nothing. A won item DISPLACES a same-cat worn item (owned, unworn).
- Ordinary online duels play for keeps (no ITEM STAKES toggle); only a
  tournament creator chooses (`_netSess.stakes === false` suppresses the
  write-back).
- Guards: duel-desync lane "windswept steal 5% loss"; sim-duel.js (a
  same-direction pass is sim-silent); smoke-game.js `_scrapePoint`.
