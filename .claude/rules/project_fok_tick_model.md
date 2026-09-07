# Tick architecture invariant - engine tick vs game tick

Two distinct named clocks - keep them separate in code and conversation:
- Engine tick = FIXED 1/60 s. The invariant, the counted unit. Everything
  (durations, accumulator/catch-up, network cadence) is an integer number of
  engine ticks. In code this is simTick.
- Game / move tick = variable, <=30 Hz, and FIXED PER LEVEL. It is a fixed
  divisor of the engine tick, equal to the level's BOOST period G (engine
  ticks per game tick, G>=2). The maximum possible boost ticks control the
  game. Adjustable in 1/60 s (engine-tick) increments.

Boost is a PARITY TOGGLE on the fixed game tick, NOT a re-divisor (the old
max(2,round(k/2)) re-divisor was the bug that got removed):
- Normal movement = snake steps every 2nd game tick (period 2G engine ticks).
- Boost = snake steps every game tick (period G). Exactly 2x normal, always.
- Therefore normal move periods are always EVEN (2G); the speed table is
  quantized to the 2G grid (normal granularity = 1/30 s).

Network sync keys to the FIXED game tick (unaffected by boost state):
netInterval = max(4, G) engine ticks. This is the whole point - boosting must
not change the tick the network is pinned to.

The G table is stored directly as LEVEL_CFG easy/normal/hard values. Normal
move period = 2G, boost = G. Hard L8-10 = G2 = 15 Hz normal / 30 Hz boost
(the ceiling).
- Easy:   7,7,7,6,6,6,5,5,4,4
- Normal: 6,6,6,5,5,5,4,4,3,3
- Hard:   5,5,4,4,3,3,3,2,2,2
Normal Hz = 60/(2G) = 30/G; boost Hz = 60/G. Monotonic down each column,
across each row.

Implemented on main: LEVEL_CFG holds G; movement uses gPer/_gDue game-tick
countdown + _stepAccum (normal +1, boost +2 per game tick, spend 2 per step).
The old re-divisor and _moveDue/speed/_lvlSpeed are gone. Verified numerically
(normal gap=2G, boost gap=G). See project_fok_multiplayer_netcode.md.
