# Single-player and duel share ONE sim code path

Single-player and 1vs1 duel run the SAME engine and MUST go through the SAME code path. Do not "mirror", copy, or re-implement single-player logic into the duel path (or vice versa). Converge, never duplicate.

Rationale: duplicated logic silently drifts and creates duel-only bugs. Concrete case: bar (barricade) placement had two separate blocks. The DUEL block hard-coded every bar `fragile:false`, so a bar on the outer ring was SOLID in a duel while the identical edge cell is always crushable in single player (`_barFragile` makes the edge ring fragile) -- a "solid barricade on the corner" that can never happen solo. The duel block also skipped the ~10% 2-cell paired extensions.

How to apply: CONVERGE both modes onto one shared routine that both call -- e.g. `_placeBars(blocked, numBars)` in sim.js; `beginLevel` (single) and `_duelBeginLevel` (duel) each build their own blocked-set + count and call it. Never fix a divergence by copying the single-player block into the duel block. See project_fok_multiplayer_netcode.md.
