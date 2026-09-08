# SMOOTH SNAKE - a render-side ramp between cells (settings, default OFF)

The GRAPHICS row SMOOTH SNAKE = cfg.smoothMotion: 0 OFF (default) / 1 LOW
LATENCY (50 ms) / 2 HIGH LATENCY (100 ms). REDUCE MOTION heads that group. All of it lives in js/render.js (_smFrac, _smSub, _smTrack,
_smSegs, _smDuelSegs) and is called from drawSnake and the duel board draw.

INVARIANT: renderer only, the scrape's discipline. It reads sim state, judges
nothing, draws no rng, is never hashed and puts nothing on the wire. The sim
still steps a whole cell at a time; only the DRAWN position moves between
cells. A rollback cannot disturb it and the two clients of a duel owe each
other nothing here. Do not move any of it into sim.js.

How it works, and why it is shaped this way (settled 2026-09-08 on a live
A/B bench against the game's own drawing code):
- The fraction is read off the counters the sim schedules its step with
  (_gDue, the step accumulator, the rate 1/2/halved-under-slow, gPer) plus
  the sub-tick remainder of the frame clock (in-process: _fbAcc; worker
  home: time since the last frame arrived). It is continuous between steps
  and back at 0 exactly when the step lands. A wall-clock timestamp taken
  when the render notices a step was tried first and jittered at every step.
- LATENCY-CAPPED: the ramp completes 3 (or 6) ticks after the step whatever
  the level's period, then the segment holds on its cell. The picture is
  never further behind the sim than the cap. A full-period slide was tried
  and rejected: it trails by a whole period (200 ms at level 1).
- S-curve (smoothstep) only where the cap binds; linear where the ramp
  spans the whole period (level 10 boosting on the 3-tick cap), where an S
  would only delay the start of the move.
- Every segment slides. Head-and-tail-only was tried and rejected.
- Positions snap to whole pixels (1/CS); a jump of more than one cell (a
  wrap, a fresh snake) does not slide; the ramp runs only in 'playing' /
  'duel' with the snake alive, every other phase draws the cells as they
  are; a sim tick running backwards (new level or match) forgets the old
  cells.

Tests: test/smoke-game.js (default, validation, the fraction at full speed
and under the cap, the sub-tick, segment placement, pixel snap, wrap).
