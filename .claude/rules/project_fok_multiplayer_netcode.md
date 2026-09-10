# 1vs1 duel game rules + score-submission integrity

1vs1 online is built as deterministic lockstep: no host authority over the sim, inputs-only JSON on the wire (redundant input log + ~1/s state hash), rollback, WebRTC + HTTP relay fallback. `NET_PKT_MAX=1200` one-datagram cap. Tick model: project_fok_tick_model.md; pairing invariant: project_fok_headroom_shortcut.md; module layout: project_fok_snake.md.

## DUEL RULES (the actual game rules)

Full CLASSIC PROGRESSION played together: start level 1, shared 10-gem goal, level-up regenerates bars + speed from LEVEL_CFG (pinned NORMAL for fairness), READY/GO shows LEVEL n; at level 10 it continues at max difficulty. Gem = level*100 to the eater, +2 growth. Each player has 3 hearts per MATCH; a death costs a heart + restarts the CURRENT level (fresh bars, gems reset); out of hearts ends the match (both out = draw). TWIST: the level-finishing-gem eater earns a heart back (cap 3). Match end = winner banner + PLAY AGAIN? dialog. HUD: 2x2 grid, P1/P2 hearts (player colours) on top, SHARED gems x/10 + level below; landscape is a single column with P2 hearts bottom-most. NO coins/achievements in a duel (economy protection), and no lucky/epic gem tiers -- but the
COLLECTIBLES are single player's: the power pellet always was, and since 4.4.0 the GOURANGA
line and the TIME CRYSTAL run in a duel too, on ONE shared implementation rather than a duel
copy (_gourangaMaybe / _spawnExtras / _takePickups / _gourangaTake in sim.js -- the only
difference a mode gets is the blocked set it hands in and where the score is banked). A
gouranga bead counts toward the shared ten and scores the flat level*100 every other gem
does: the classic bonus ladder has no meaning with two scorers. The crystal warps the pace
to level 3's for both snakes, read through _paceNow()/_paceWarp() -- NEVER through the
classic difficulty-reading accessor, which is a per-device setting and would hand two
players two different paces from one agreed state. The quit dialog ducks audio to 50%
(persistent `_duckF`).

SPEED TOURNAMENT (4.4.0, server API 4.10, default off): a tournament created with `speed`
plays EVERY round as a speed round, independent of the start level. The flag rides the
create, the lobby (so it is visible before joining, unlike `lvl`), the roles sheet and the
state read-back; it reaches a match as the go packet's `sp` bit, adopted before tick 0 and
echoed back, exactly like `hm` and `sk` -- a side that disagreed would step its snakes at a
different rate and split at the first move. Absent reads as OFF. In the sim it is
_duelForceSpeed: CONFIG, never hashed and never snapshotted; what IS hashed is _speedRound,
the verdict it produces.

## Submission integrity (CRITICAL, for the global board)

Only a NEW game result, submitted LIVE at game-over, may reach the central board -- NEVER a stored or historical stat (no "upload my high-score table" path). Blocks retroactive/fabricated injection; pairs with server-side replay validation (seed + tick-stamped inputs).
