# IRON RULE: one sim, one mechanic implementation, all modes

The three modes are single, 1vs1 (local or online) and tournament. A tournament
match is an online 1vs1 with a bracket around it, not a fourth ruleset; nothing
in the sim branches on it.

Every mechanic (steering, boost, items, timing, bar placement, pickups) is ONE
implementation shared by all modes. A mode differs only in INDEX MAPPING (which
snake is mine), transport, the blocked set it hands in and where score is
banked. Never copy single-player logic into the duel path or vice versa;
converge onto one shared routine both call (e.g. `_placeBars`, `_spawnExtras`,
`_takePickups` in sim.js). Never let a shared path read a mode-specific global.

Input entry points that take a player index map input-player -> sim-index at
the SINGLE entry (input.js: `netGameActive() ? netMyIndex() : p`), then run
identical code. Two-client tests must exercise the ANSWERER (index 1), not just
the host.

In-game phase names stay GENERIC (`playing`, `levelReady`, `levelDone`,
`dying`, `paused` and the duel twins). Do not split them per mode: `phase` is
the first field of RB_HASH_DUEL, so renaming one is a wire-contract change
(MINOR bump + duel regolden). Menu phases are never hashed and may be renamed.
