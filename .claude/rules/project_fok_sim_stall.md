# SIM STALL after an online-duel desync - closed

CLOSED after the hardening shipped and the symptom never recurred. Do not
re-open, re-audit or re-propose work on it without a NEW field report.

What it was (one field report, PC, online 1:1): desync -> failed restart ->
kicked -> SIM STALL badge stuck. On PC the worker hosts the sim, and its tick
loop is a self-re-arming setTimeout chain (sim-worker.js _step). ONE uncaught
throw exited before the re-arm, leaving _running TRUE with no timer pending -
and _run(true) early-returns on if (_running), so duelStartNet/duelLevelNet/
duelRespawnNet could not revive it. Board frozen, onmessage still alive, only
F5 healed it. The likeliest source was a half-applied _rbApplyResync in the
onmessage path (throw mid-repair, next tick throws on the half-state) -
code-read only, never confirmed by a stack trace. A busy-hang was RULED OUT:
no unbounded loop is reachable in the worker.

The fix is structural rather than a patch of the unknown throw, which is why
absence of recurrence is adequate proof: a throw can no longer wedge anything.

The hardening: _step wraps the tick in try/catch and ALWAYS re-arms; _timer is
nulled at entry so _run(true) revives a running-but-unscheduled chain; a
caught throw zeroes _acc and posts a throttled {t:'err'} that main logs as
`sim worker error <msg> (xN)` + stack. smoke-worker locks both the fault
survival and the latch, and runs in the FAST tier.

IF IT EVER RETURNS: before reloading, grab the F12 `sim worker error` line -
it names the exception and line directly, which is the one piece of evidence
the original report lacked. Related: project_fok_connection_lost_open.md,
project_fok_duel_resync_ownership.md.
