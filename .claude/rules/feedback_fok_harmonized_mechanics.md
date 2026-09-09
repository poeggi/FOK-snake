# IRON RULE: one mechanic implementation across all three modes

Every gameplay mechanic (steering, boost, items, timing) must be ONE implementation shared by single-player, local 1vs1 and online 1vs1. Differences between modes are limited to INDEX MAPPING (which snake is mine) and transport. Never implement a mode-specific variant of a mechanic, and never let a shared path read a mode-specific global.

Rationale (concrete failure): a boost-redesign arming stage watched players[0] online while the answerer's own snake is players[1], so engage was tested against the OPPONENT's direction -- boosts stuck or never fired, online only. Same failure class as duel code reading single-player globals (see feedback_same_code_path.md).

How to apply: any input entry point that takes a player index must map input-player -> sim-index at the SINGLE entry (input.js pattern: `netGameActive() ? netMyIndex() : p`), then run identical shared code. When adding a mechanic, trace all three modes before calling it done; two-client tests must exercise the ANSWERER (index 1) side, not just the host.

## The three modes are single, 1vs1 and tournament

Name them that way. A tournament match is an online 1vs1 with a bracket around
it -- it is NOT a fourth ruleset, and nothing about the sim may branch on it.

## In-game state names stay GENERIC

The gameplay phases (`playing`, `levelReady`, `levelDone`, `dying`, `paused`
and the duel twins) describe what the GAME is doing, not which mode is doing
it. Do not split them per mode, and do not "harmonize" them into `solo*` /
`duel*` pairs: a mode-specific state name is an invitation to write
mode-specific logic behind it, which is the thing this rule exists to stop.

Two hard reasons on top of that:
- `phase` is the FIRST field of RB_HASH_DUEL, so it is wire-contract state.
  Renaming any phase a duel can be in makes two versions disagree at every
  tick -- a sim rule change, owing a MINOR bump and a duel-golden regolden for
  no behaviour at all.
- MENU phases are different: they are never hashed and are free to rename.
  That is why the multiplayer/duel menu names were fixed and the in-game ones
  were deliberately left alone.
