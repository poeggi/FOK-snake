# FOK-snake - repo dossier

Browser snake game, plain JS, no bundler, no deps. GitHub Pages serves main
(https://poeggi.github.io/FOK-snake/). Release history is git.

## Module layout (ONE shared global scope, load order matters)
assets -> audio -> sim -> storage -> game -> text -> render -> screens -> input
(+ net/duel code for online 1vs1; sim-worker.js runs in the Worker).
- js/assets.js all static data (SIM_HZ=60, LEVEL_CFG, SHOP/BOX items, FX_DEFER)
- js/audio.js Web Audio IIFE Snd (feedback_fok_audio_changes.md)
- js/sim.js headless deterministic core, seeded mulberry32, side effects via
  emit() -> game.js drainSimEvents()
- js/storage.js all persistence; js/game.js app core, main loop, worker
  bridge, economy; js/text.js FONT/GLOW; js/render.js + js/screens.js draw
  only; js/input.js all input
- Netcode: js/net.js, net-api.js, net-rtc.js, net-session.js, net-spec.js,
  duel-core.js, tourney.js, events.js, items.js, hmac.js
- Boxes/shop: BOXES + pity in assets.js; test/box-odds.js guards the house edge.

## CI + tests
- ci.yml: 5-job matrix, `bash test/checks.sh --full --shard k/5` + `node
  test/check-sw.js`; paths-ignore for docs/** and **.md. Pure Node.
- checks.sh: bare = FAST (seconds, the hook); `--full` (= --regression) adds
  the duel sweeps. CI is a DETECTOR, not a gate: Pages deploys on the same
  push regardless. Run --full locally after netcode/sim work and before a
  release. On-demand only, never in a tier/lane/CI/hook: --profile,
  --netprofile, --tourney, --live, --tourney-sim.
- Lanes + shards (test/lanes.js, `--shard k/N`, `LANES` in run-suites.js:
  duel-spec 4, duel-desync 3, duel-suspend 3, duel-boundary 3, duel-spec-tree
  3, duel-outage 2). Two guards, do not remove: a FALSIFICATION CONTROL runs
  in every lane (duel-outage's over-long-outage FATAL); an EMPTY lane or
  shard FAILS. `--list` verifies the partition. Folding is exhausted; do not
  propose cutting duel-desync's `headroom burst 0rb` lane. A stale `weight`
  costs packing, never correctness.
- test/harness.js: headless vm harness, modules in index.html order, driver
  string appended so it sees top-level let/const. No Worker: every duel suite
  drives the in-process home; smoke-worker, smoke-epoch-mirror and
  smoke-spec-worker are the only guards on the worker path.
- Suite gotchas: run-suites.js requires a PASSED banner (a bare 'ok' =
  FAILED) unless the table entry ends in false. Never pipe checks.sh through
  tail. A suite reading a recorded post synchronously after a paced call is
  wrong (the gate defers by a microtask): use settleAsync(). Driving
  gameplay: set simTick=BASE and simNow=simTick*TICK_MS together.
- GOLDENS: two lanes in sim-determinism. CLASSIC runs startGame(SEED). DUEL
  hashes RB_HASH_DUEL off _rbDuelSnap() every tick of 8 scripted matches, so
  the golden IS the wire contract. Update only on deliberate rule changes.
  Duel pilot design, do not weaken: KEEP-2 exclusion (only scripted rams
  kill), manual simCommand({t:"advance"}), 8 matches (the heart gate needs
  level>=2 and somebody below cap), pilots WEAR gear (else _ws is empty and
  the windswept steal is uncovered). sim-events golden excludes particles.
- Driver rules (test/duel-driver.js): KEEP-2 pilot (no move within
  torus-Chebyshev 2 of the opponent head); decoys reverse the dirQueue TAIL
  via __dirTail, inert only at queue depth <= 1; startPts = Date.now() right
  after startDuel().
- The crucial duel-desync "headroom burst 0rb" lane (seed 0x7002, err0=30ms,
  base15 jit1, real first-start burst, |gap0|>25 -> |gap1|<=3, maxRb:0
  through the L1->L2 boundary into an L2 speed round, doubleEvery:2; noburst
  RED twin minRb:1): do not shorten, reseed or relax.

## LG OLED TV render rules (do not relitigate)
- The TV's canvas plane is 50 Hz; anything that draws pins at 50. Target a
  steady 50; only dips below are real load.
- Canvas-source drawImage compositing is slow on the LG even 1:1; live
  primitive drawing beats sprite/text blits (both reverted). Only opaque
  full-canvas background/menu blits are fast. Main ctx uses
  getContext('2d',{alpha:false}). Dip levers: blur radii, glow off in events.

## Perf + compat (decided, do not reopen)
- Shipped: batched saveCfg thunk, SIMPLE gfx paints black under dialogs
  instead of the self-blur, spectator fan-out serializes once (_spEnv/_spFan),
  no netNetsRefresh mid-match.
- LEAVE as is: the one FIFO HTTP gate, full-canvas blur under dialogs,
  shadowBlur/glow, bracket anims every frame, rollback spike, iOS QR decode
  on main, seek interval, script/sw race, worker seam, touch listeners,
  getStats, sim allocs, the profiler's qrDecodeImage `<< watch` line (~4.8 ms).
- Compat floor Chrome 55 / Safari 11 / Firefox 52 (async/await, no build
  step). No grid fallbacks for Chromium 55/56, no Tizen keyCode 10009. No
  `??`, spread or bare `catch{}`.

## Constraints
ASCII only. One sim path for all modes (feedback_one_sim_path.md). Nothing
inline (project_fok_csp.md).
