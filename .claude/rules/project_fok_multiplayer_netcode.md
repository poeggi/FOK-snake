# 1:1 duel game rules + score-submission integrity

1:1 online is built as deterministic lockstep: no host authority over the sim, inputs-only JSON on the wire (redundant input log + ~1/s state hash), rollback, WebRTC + HTTP relay fallback. `NET_PKT_MAX=1200` one-datagram cap. Tick model: project_fok_tick_model.md; pairing invariant: project_fok_headroom_shortcut.md; module layout: project_fok_snake.md.

## DUEL RULES (the actual game rules)

Full CLASSIC PROGRESSION played together: start level 1, shared 10-gem goal, level-up regenerates bars + speed from LEVEL_CFG (pinned NORMAL for fairness), READY/GO shows LEVEL n; at level 10 it continues at max difficulty. Gem = level*100 to the eater, +2 growth. Each player has 3 hearts per MATCH; a death costs a heart + restarts the CURRENT level (fresh bars, gems reset); out of hearts ends the match (both out = draw). TWIST: the level-finishing-gem eater earns a heart back (cap 3). Match end = winner banner + PLAY AGAIN? dialog. HUD: 2x2 grid, P1/P2 hearts (player colours) on top, SHARED gems x/10 + level below; landscape is a single column with P2 hearts bottom-most. NO power-ups/coins/achievements in a duel. The quit dialog ducks audio to 50% (persistent `_duckF`).

## Submission integrity (CRITICAL, for the global board)

Only a NEW game result, submitted LIVE at game-over, may reach the central board -- NEVER a stored or historical stat (no "upload my high-score table" path). Blocks retroactive/fabricated injection; pairs with server-side replay validation (seed + tick-stamped inputs).
