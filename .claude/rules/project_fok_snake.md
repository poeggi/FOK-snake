# FOK-snake - repo dossier

Browser snake game, plain JS, no bundler, no dependencies. GitHub Pages serves
main (https://poeggi.github.io/FOK-snake/). Release history lives in git;
this file keeps only the load-bearing rules.

## Module layout

index.html loads scripts in ONE shared global scope (no bundler), order
matters: assets -> audio -> sim -> storage -> game -> text -> render ->
screens -> input (+ net/duel code for online 1:1; sim-worker runs in the
Worker). Roles:
- js/assets.js ALL static data (SIM_HZ=60, LEVEL_CFG with per-level G,
  SHOP/BOX items, presentation tables)
- js/audio.js Web Audio IIFE Snd, two-tier model (context suspend vs gain
  mute). NEVER touch without exact diff + approval
  (feedback_fok_audio_changes.md)
- js/sim.js HEADLESS deterministic core (zero DOM/canvas/audio/IO); seeded
  mulberry32 PRNG; side effects via emit() -> game.js drainSimEvents()
- js/storage.js ALL persistence (scores, FOKoins, cfg, achievements,
  backup/restore)
- js/game.js app core: state, main loop (fixed-timestep accumulator), worker
  bridge, economy
- js/text.js FONT.*/GLOW.* read from css/fonts.css --fs-*/--glow-*
  (feedback_fok_font_sizes.md)
- js/render.js render core; js/screens.js full-screen scenes (draw-only);
  js/input.js all input funnels
- Duel/netcode: js/net.js, js/duel-core.js ("HEADROOM here"/"SHORTCUT here"
  annotations - project_fok_headroom_shortcut.md)

Mystery boxes/shop economy: BOXES + pity in assets.js; test/box-odds.js
guards the house edge.

## Versioning + THE VERSION GATE

- Semantic snake-vMAJOR.MINOR.PATCH. The tracked pre-commit hook
  .githooks/pre-commit (core.hooksPath=.githooks) rewrites sw.js
  version/CACHE/ASSETS on EVERY commit; MAJOR.MINOR comes from the latest
  v[0-9]* tag, PATCH auto-increments. The in-game version is read from the
  cache key. DO NOT hand-edit sw.js or any version string
  (feedback_fok_version_tag.md).
- The version gate is LOAD-BEARING: clients matchmake on MAJOR.MINOR only, so
  patches interop. ANY sim rule change MUST bump MINOR, or old+new clients
  pass the gate and silently desync.
- Forcing a minor: tag ANNOTATED vX.Y.0 (beats a lightweight same-commit tag)
  -> commit (hook resets PATCH to 0) -> git tag -f vX.Y.0 HEAD -> push
  branch+tag.
- Squash gotcha (hook mechanics): the hook resets PATCH to 0 only when sw.js's
  stamped MAJOR.MINOR differs from the nearest tag's, so a fold-into-X.Y.0
  needs (a) git checkout <base> -- sw.js js/assets.js to restore the base
  stamps and (b) an annotated vX.Y.0 tag on the base commit BEFORE committing,
  then git tag -fa vX.Y.0 HEAD after.
- "Sim rule change" means a change two clients can DISAGREE about mid-match
  (movement, collision, spawn, scoring maths). It is NOT triggered by a change
  that merely alters emitted side effects: achievement thresholds move the
  sim-events golden but are per-client cosmetics that cannot desync a duel.
  Regoldening sim-events is therefore NOT by itself evidence that a minor is
  owed; regoldening sim-determinism is.
- DELIBERATE OVERRIDES exist in the 2.7 line: two lockstep-affecting changes
  (a death-duration change and a heart-spawn-probability change) shipped as
  PATCHES by explicit decision. Accepted consequence: those adjacent 2.7.x
  clients pass the gate and can desync at the affected moment. Do not
  re-litigate and do not "fix" it by retagging. When an override is asked
  for: state the cost once, then ship what was asked.

## Duel protocol + contracts

- Fixed 60 Hz engine tick; boost is a parity toggle - project_fok_tick_model.md.
- Online 1:1 is deterministic lockstep, inputs-only, rollback - rules + wire
  in project_fok_multiplayer_netcode.md.
- 2.6 protocol (no legacy compat kept): three wire transitions - go
  {why: match|rematch|level|respawn|resume} (ONE host-authored timeline
  opener), req {why: level|again|resume} (joiner ask, epoch-pinned), bye.
  Echo-ack (receiver answers verbatim +a:1 from the receive handler;
  duplicates re-echo, effects epoch-deduped); ONE pending tx with retry
  ladder; an unanswered go kills at 4s, req never. Every boundary runs the
  bilateral clock burst first; bth rides the echoed go. Death is a halt
  (duelHalt -> host go{respawn}; the dying hold re-announces every _HALT_RE=6
  ticks until answered); an outage recovery ends in a resume boundary
  (adopt-only clock re-anchor, no rebuild - see
  project_fok_connection_lost_open.md). bsync/sched/rst/reship/epq are DELETED
  vocabulary. Guards: smoke-recovery-resume, smoke-respawn-halt,
  smoke-level-wire, net-handshake protocol lanes.
- x10 CONTRACT: a duel NEVER honors x10 - like difficulty, a duel always runs
  the normal ruleset. Not negotiated state: no x10 flag exists in duel mode,
  on the wire, or in the duel hash/snapshot/resync lists; _X10() is hardwired
  to 1 when players is set. Classic-mode cfg.x10 (debug toggle + not-ranked
  taint) untouched. Guard: smoke-duel.js asserts both cfg.x10=true and a wire
  x10:true are ignored.
- Spectator serving: a feeder must release its served links on the first tick
  it is no longer servable (_spServeEnd() from _spTick) - holding them across
  a match boundary strands both SPEC_MAX_DIRECT slots on a dead timeline.
  Parked _spAsk entries MUST survive that release (an ask is for the NEXT
  match, which is that same boundary); clearing them re-breaks the bug, and
  test/tourney-watch.js asserts it.

## CI + tests

- .github/workflows/ci.yml: a 5-JOB MATRIX, each running
  bash test/checks.sh --full --shard k/5 + node test/check-sw.js, skipped for
  docs-only pushes (paths-ignore). Pure Node, no deps.
- checks.sh is ONE script, two tiers: bare = FAST (~seconds), what the
  pre-commit hook runs; --full (= --regression, implied by
  --profile/--netprofile) adds the heavy duel sweeps (runtime scales with
  simulated match-seconds; see project_fok_ci_time.md for lanes + sharding).
  CI runs --full, so the regression tier GATES the auto-deploy to Pages.
  RULE: run --full locally after any netcode/sim rework and before a release.
  Tiers documented in test/README.md + the checks.sh header.
- On-demand modes (never in a tier/lane/CI/hook): --profile, --netprofile,
  --tourney, --live, --tourney-sim, and bash test/checks.sh --tourney for the
  full-bracket world.
- test/harness.js: headless vm harness, loads modules in index.html order,
  driver string appended so it sees top-level let/const.
- The CRUCIAL duel-desync "headroom burst 0rb" lane: seed 0x7002, clocks start
  err0=30ms apart on a 30ms-RTT wire (base15 jit1 - jit1 is the provable max:
  16ms transit vs the 16.67ms one-tick budget; jit2's 17ms is over budget by
  physics), REAL first-start burst pre-play (joiner applies host-computed bth
  residual - own samples starve at this RTT), asserts |gap0|>25 -> |gap1|<=3
  then maxRb:0 THROUGH the real L1->L2 req->go boundary into an L2 speed round
  both clients must see (expectLevel:2 + expectSpeed), doubleEvery:2 multi
  gestures on; noburst RED twin minRb:1. Do not shorten/reseed/relax it.
- Driver rules: KEEP-2 pilot rule (no move lands within torus-Chebyshev 2 of
  the opponent head, head-ons impossible by construction); tail-aware
  multi-gesture decoys via __dirTail hook - decoys MUST reverse the dirQueue
  TAIL, never the live heading, and are only inert at queue depth <= 1 (see
  project_fok_dirqueue.md); burst bth hand-off fidelity; __speedRound/__dirTail
  hooks + speedRoundA/B report fields.
- GOLDEN hashes: TWO lanes in sim-determinism because there are two timelines.
  The CLASSIC lane runs startGame(SEED) and can NEVER see a duel-only rule.
  The DUEL lane hashes exactly RB_HASH_DUEL read off _rbDuelSnap() every tick
  of 8 scripted matches, so the golden IS the wire contract: a field added to
  the agreement enters it automatically, and the snapshot fields deliberately
  not agreed on (_barsV, levelDoneWaiting) stay out. Update goldens ONLY on
  deliberate rule changes. Pilot design (do not weaken - each part earns
  coverage): KEEP-2 exclusion so only the scripted rams kill;
  simCommand({t:"advance"}) by hand (a duel level ends only when a player
  confirms it); 8 matches, because the heart gate needs level>=2 AND somebody
  below the life cap. The duel pilots must WEAR gear - without it _ws is a
  hashed but permanently EMPTY pair of lists and the entire windswept steal
  (incl. the crash hand-back) is uncovered. Coverage is PROVEN by
  falsification (different probabilities give different hashes); a tick-0
  field record names the field when two runs disagree.
- sim-events golden excludes cosmetic particles.
- Suite gotchas: test/run-suites.js requires a PASSED banner unless the table
  entry ends in false - a suite printing only 'ok' counts as FAILED. Never
  pipe checks.sh through tail - the pipe returns tail's exit code and hides
  the failure. Any suite that reads a recorded post synchronously after a
  paced call is wrong by construction (the gate defers sends by a microtask) -
  use the suite's settleAsync().
- Driving gameplay in a test driver: set a consistent large sim clock
  (simTick=BASE; simNow=simTick*TICK_MS) - setting simNow alone gets
  overwritten by update() and poisons phaseAt.
- The hook runs checks BEFORE the version bump; hook ASSETS + check-sw both
  exclude ^(test/|\.github/).

## LG OLED TV render rules (hard-won, twice confirmed - do not relitigate)

- The TV's canvas presentation plane is 50 Hz: anything that draws pins at
  exactly 50 even with near-zero paint (PAINT PROBE in the DEBUG menu proved
  it). Target a STEADY 50 on TV; only dips below 50 are real render load.
- Canvas-source drawImage compositing is SLOW on the LG even 1:1 - live
  primitive drawing beats sprite blits (confirmed by BOTH the gem-sprite
  revert and the glow-text cache revert: cached text made levelDone WORSE).
  Only the opaque full-canvas background/menu blits are fast. DO NOT
  reintroduce sprite/text blitting.
- Main ctx uses getContext('2d',{alpha:false}) (kept). Dip levers if needed:
  reduce blur radii / disable glow during events.

## Open items (do not start unprompted)

- Platform badge - DEFERRED, discuss before building. Two halves: (a) DUEL
  badge = client-only (add platform to the handshake profile payload, each
  player renders it); (b) GLOBAL highscore platform = needs an additive field
  on the FOK-server score submit/return + API bump - a SEPARATE PRODUCTION
  repo, never touch it without an explicit ask. Tentative taxonomy: 3 buckets
  MOBILE/DESKTOP/TV (touch + UA + screen).
- Server side (needs an explicit ask): FOK-server Tournament::project() does
  not put podium in the state read-back although its docs/API.md says it does.

## Key constraints

- Single-player, local 1:1 and online 1:1 share ONE sim code path - converge,
  never duplicate (feedback_same_code_path.md, feedback_fok_harmonized_mechanics.md).
- ASCII only in source/README; always run the full tier before a release.
