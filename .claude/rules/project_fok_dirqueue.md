# dirQueue: pop-then-judge at the cap (since v2.6.9)

Steering input rule, implemented in `js/sim.js` `_dirEnqueue(q, cur, d)` -- ONE helper shared by classic and duel (feedback_same_code_path.md), called from both `case 'dir'` branches of simCommand:

1. Below the cap (queue < 3): judge d against the LAST REGISTERED direction (queue tail, or live heading when empty); same/reverse of it = not registered.
2. AT the cap (POP-THEN-JUDGE): pop the tail first, then run the same judging vs the new tail -- perpendicular REPLACES the revoked turn, same/reverse just CANCELS it and leaves slot 3 empty. A repeat of the tail direction pops and re-registers identically = stutter-safe.
3. Consume side unchanged: one entry per MOVE, the reverse-of-heading skip stays.

Rationale: the cap used to DROP THE NEWEST intent (field symptom: "snake turned where I didn't want"); newest-wins is the mandated design. Boost-cancel-by-contrary-nudge is ALREADY handled in input.js (_isOpp vs _swipeLastDir) -- do not touch.

Knock-ons, all handled:
- The sim-determinism regolden for this change was deliberate; the sim-events golden did not move.
- test/sim-duel.js section C locks the rule (5 sequences x classic+duel parity).
- test/duel-driver.js gesture decoys are ONLY inert at queue depth <= 1 (at a full queue NOTHING is inert -- even reverse-of-tail revokes/replaces); TRIPLE has a t0.n <= 1 gate, DOUBLE keeps t.n < 2, postTail has no cap clause.
- duel-core.js netLocalInput's intent-change gate stays CORRECT (comment carries the two-leg proof): a full queue implies heading-perpendicular-to-tail, and a same-axis-as-s2 record would itself have emptied slot 3 -- so a suppressed press always hits plain judge-vs-tail.

Versioning: this shipped as a PATCH on the 2.6 line as a deliberate override of the sim-rule-change-means-minor gate; the mixed-version caveat (2.6.8 vs 2.6.9 can matchmake, cap inputs judged differently -> resync repairs until both updated) was surfaced and accepted -- do not re-raise it.

Anti-spiral touch guard (_spiralHold, input.js) is COMPATIBLE: the gesture-anchored run counter outlives move execution; a spiral's 3 turns never hit the cap path; a 4th same-way turn is behind the same 64px hold.

Do NOT re-litigate: judge-vs-tail anchoring, one-consume-per-move, the 3-slot cap itself, and the consume-side reverse skip are all intended and confirmed.
