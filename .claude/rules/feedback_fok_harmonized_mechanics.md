# IRON RULE: one mechanic implementation across all three modes

Every gameplay mechanic (steering, boost, items, timing) must be ONE implementation shared by single-player, local 1:1 and online 1:1. Differences between modes are limited to INDEX MAPPING (which snake is mine) and transport. Never implement a mode-specific variant of a mechanic, and never let a shared path read a mode-specific global.

Rationale (concrete failure): a boost-redesign arming stage watched players[0] online while the answerer's own snake is players[1], so engage was tested against the OPPONENT's direction -- boosts stuck or never fired, online only. Same failure class as duel code reading single-player globals (see feedback_same_code_path.md).

How to apply: any input entry point that takes a player index must map input-player -> sim-index at the SINGLE entry (input.js pattern: `netGameActive() ? netMyIndex() : p`), then run identical shared code. When adding a mechanic, trace all three modes before calling it done; two-client tests must exercise the ANSWERER (index 1) side, not just the host.
