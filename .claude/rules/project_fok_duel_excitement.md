# 1:1 duel excitement: NOTHING IS QUEUED

The entire duel-excitement backlog was discarded. There is no approved, spec'd or parked duel feature. Do NOT start one, and do not treat anything below as a suggestion waiting for a go-ahead -- the list exists so the same ideas are not served up again.

## REJECTED -- do not re-propose (any form, any rewording)

- MAGNET pickup (holder indestructible + pulls the opponent in). Was fully spec'd and once built on a since-deleted branch; the spec was deliberately deleted with it -- do not reconstruct.
- SWAP and GHOST, and the whole collect-then-activate / inventory-slot concept behind them: held items the player activates on demand. Do not re-propose player-activated items in any form.
- Slipstream (speed gain for tailgating in the opponent's trail).
- Duel-only functional effects on shop/box gear (e.g. an item that deflects a steal).
- Sustained-scrape pressure (a long side-by-side contact forcing a steal roll).
- Cleared earlier: gem contest (equidistant final-gem spawn), golden gem, scorch trail, combo streak, escalation, best-of-3, heart steal, sudden-death shrink, scissors, fog, portal pair, quake, combat level.

## ALREADY SHIPPED -- not new, do not offer as an idea

- Near-miss juice (v2.7.0): screen shake on a head-to-head pass, the windswept-item steal it rolls, and the continuous side-by-side scrape. See project_fok_volatile_steal.md.
- Body as a weapon (sim.js duelStep): head into opponent snake = you die; head-on = both die; power mode makes the opponent edible (head-bite kills, body-bite chomps their tail and slows the biter).

## Constraints any future idea must meet (only on an explicit ask)

Deterministic lockstep: seeded spawns, tick-scheduled events only, and anything that consumes rng is sim state on all five hand-synced duel field lists. Shared arena (a TORUS -- shortest-wrapped distance, "away" wraps back). Shared 10-gem progression, 3 hearts per match. Cosmetics belong in the renderer, judged per frame, never in the sim. A sim rule change owes a MINOR bump. Single-player and duel share ONE code path (feedback_same_code_path.md).
