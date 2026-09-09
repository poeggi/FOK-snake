# Windswept-item steal in 1vs1 (shipped v2.7.0)

The old "volatile steal" plan is implemented and released; "volatile" was
renamed to windswept everywhere.

## The two effects are DIFFERENT KINDS OF THING

- Near-miss steal = a pass on DIFFERENT headings. Edge-triggered, consumes
  rng, so it is SIM state: _nmWasAdjacent is hashed and snapshotted (a
  rollback that re-armed it would fire a second steal on one client only).
- Side-by-side scrape = same heading, one lane apart. Sparks + squeal,
  CONTINUOUS, judged per FRAME in the renderer (_duelScrapeFx in render.js)
  off the positions already on screen. No rng, no state, nothing hashed, no
  sim event. The rule: an effect with no rising edge cannot miss one, so a
  dropped or doubled frame costs nothing - which is exactly why it must NOT be
  in the sim. Do not re-add it there. _gzWasFlank/armGraze/'graze' are GONE.

## Resolved knobs

- Steal chance is PRICE-dependent (_wsPct(cost) in assets.js): cheap items
  blow off often, dear ones rarely.
- BOOST LADDER on top of price: neither boosting = nominal, one = mild, both =
  double (measured 10.1 / 15.2 / 20.7% for the crown).
- Both snakes wearing windswept gear: ONE pseudo-random victim per pass, not
  both.
- Speed round re-rolled PER SPAWN (not per level), same probability after
  level 1.
- Halo has its own cat:'divine' (it is not headwear).
- Uncollected item reverts to its owner at a level rebuild.
- One loose item at a time; that IS the steal cooldown.

## Hazards that cost real time (do not rediscover)

- FIVE hand-synced duel field lists, not four: RB_HASH_DUEL (also the wire
  contract), _rbDuelSnap(), simApplyDuel(), _rbFullState()/_rbApplyResync(),
  and _rbCloneSnap()/_rbCloneFlat/_rbClonePlayer. Miss one = guaranteed
  desync. _rbCloneWs key ORDER is part of the byte-identity contract.
- Three fx-routing homes had silently drifted: drainSimEvents() (in-process),
  _applyDuelEvents() (worker->main) and sim-worker.js's replay filter. A kind
  can sit in the defer set with a correct handler and still be UNREACHABLE.
  Fixed by hoisting one FX_DEFER set into assets.js that all three derive
  from - keep it that way; a per-home case list is how the bug happened.
- _wsTransfer is ONLINE-ONLY and per-device: each client applies only the half
  of a pickup concerning its own player. A LOCAL duel shares one config, so no
  write-back, and _duelWsLists(null) hands player 2 an EMPTY windswept list -
  locally only player 1's gear can be blown off, and nothing persists. By
  design.
- A won item DISPLACES a same-cat worn item, which stays OWNED but unworn -
  so wornA/wornB can hold ids the sim's worn list no longer has. Not a bug.

## Audio (changed with explicit approval - see feedback_fok_audio_changes.md)

- Snd.scrapeSet(active): ONE sustained voice built once and ridden by its gain
  (LFO wander on a bandpass, four inharmonic saws). Retriggering the 0.2s
  squeeze one-shot sounds machine-gun-like - never go back to that. Released
  from the RAF loop via if(phase!=='duel') Snd.scrapeSet(false) so a
  pause/death/quit mid-scrape cannot strand the voice on.

## Test coverage

- test/duel-desync.js lane "windswept steal 5% loss" (jouster director,
  flushFx) gating on expectWs + wsSame + wsOwnBad. FALSIFIED: re-breaking the
  routing turned it red.
- test/sim-duel.js asserts a same-direction pass is SIM-SILENT; the scrape
  rule itself is tested render-side in test/smoke-game.js (_scrapePoint cases
  plus "still sparking two frames later"). test/README.md documents the lanes.

## Rejected - do not re-propose

- An ITEM STAKES toggle for ordinary online 1vs1 duels. An online duel plays
  for keeps and has no opt-out by design; only a tournament creator chooses,
  and only _netSess.stakes === false suppresses the wardrobe write-back in
  _wsTransfer. Decided explicitly: no toggle. The asymmetry with the local
  duel is not a gap either: one device is one wardrobe, so there is nowhere
  for the gear to move to - the sim runs the identical mechanic regardless.
