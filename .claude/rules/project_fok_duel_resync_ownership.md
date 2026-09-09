# Duel INVARIANT: a resync must never move your own head non-causally

The failure mode ("bug C"): after a death, your own snake jumps back to where it died, then clears. A multi-second stall ages out the rollback ring, so the host owes a FULL RESYNC whose tick T is gone from the ring; hard-applying the host's STALE copy of your own snake yanks your head 11-14 cells back onto the death cell.

The distinguishing principle: your snake is yours for the ticks you ACTUALLY RAN.

`_rbApplyResync` splits on `const catchUp = T > simTick + RB_DEPTH`:

- CATCH-UP (T a full ring ahead -- only possible if WE froze while the sender ran on): ADOPT THE SENDER'S ENTIRE FRONTIER, both snakes, and anchor T-1. We authored nothing while frozen, so with no inputs our snake simply ran straight, which is exactly what the sender simulated -- its copy IS the truth and cannot be stale. Role-agnostic (a frozen HOST needs this too). The frozen side legitimately snaps its own head ONCE here.
- ORDINARY (T at/near simTick -- host-authoritative, only the joiner adopts): KEEP YOUR OWN SNAKE. In-ring, keep the ring entry's copy at T then `_rbRollback(T)` replays your logged inputs, re-deriving your snake exactly (renders final-only, so no visible jump). Aged out, keep your geometry and take only the shared world plus authoritative match state (lives/alive/score), never rewinding your tick, and push one 'st' so the host converges to you. This is where bug C lives: here the sender's copy CAN predate your live respawn.

Do NOT try to make the ordinary branch adopt too: it is a measured lateral trade -- it fixes one dozed seed and breaks another that was pristine. The ordinary branch's `_rbSendState` must also stay unconditional; besides pushing our snake to the host it is the frozen client's PROOF-OF-LIFE packet, so suppressing it produces a silence kill rather than a sync fault.

An older formulation ("the joiner keeps its own snake in BOTH branches") is OUT OF DATE; the rule above is current.

GUARD: test/duel-respawn.js (regression tier) -- `doze` knob + head-on `collider` director, 8 dozed matches. The assertion is PER-SIDE, deliberately: the LIVE side must never move its own head (liveJumps == 0), the FROZEN side may snap at most ONCE (the legitimate catch-up snap). A blanket `localJumps == 0` is WRONG and will fail on the legitimate snap.

Related: project_fok_duel_recovery.md, feedback_same_code_path.md.
