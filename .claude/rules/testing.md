# Tests, CI, harnesses

## Tiers
- `bash test/checks.sh` = FAST (seconds; the pre-commit hook runs it).
  `--full` (= `--regression`) adds the duel sweeps. A change owes FAST and
  `--full`; report those. Run `--full` after netcode/sim work and before a
  release. Never pipe checks.sh through tail.
- CI (ci.yml): 5-job matrix, `bash test/checks.sh --full --shard k/5` +
  `node test/check-sw.js`; paths-ignore for docs/** and **.md. Pure Node.
  CI is a DETECTOR, not a gate: Pages deploys on the same push regardless.
- ON DEMAND only, never in a tier, lane, CI or the hook: `--live`,
  `--netprofile`, `--profile`, `--tourney`, `--tourney-sim`. Never start one
  unasked (they take long; `--live` hits the live server). Asked "did
  everything pass?": name the tiers that ran and say the on-demand round has
  not.
- When asked: in the background, one script running the modes in order,
  START/PASS/FAIL lines on stdout, one log per mode, never stopping on a
  failure. Watch with a Monitor on the marker lines, relay a short status as
  each mode lands. `--tourney-sim` prints only at the end; in the foreground
  it looks like a hang and the Bash timeout kills it.

## Lanes and shards (test/lanes.js, `LANES` in run-suites.js)
`--shard k/N`; `--list` verifies the partition. Two guards, never remove: a
FALSIFICATION CONTROL in every lane (duel-outage's over-long-outage FATAL);
an EMPTY lane or shard FAILS. No further lane folding; never cut duel-desync's
`headroom burst 0rb` lane. A stale `weight` costs packing, never correctness.

## Harness (test/harness.js)
- Headless vm harness: modules in index.html order, driver string appended so
  it sees top-level let/const. No Worker: every duel suite drives the
  in-process home; smoke-worker, smoke-epoch-mirror and smoke-spec-worker are
  the only guards on the worker path.
- run-suites.js requires a PASSED banner (a bare 'ok' = FAILED) unless the
  table entry ends in false.
- A suite reading a recorded post right after a paced call must use
  settleAsync() (the gate defers by a microtask).
- Driving gameplay: set simTick=BASE and simNow=simTick*TICK_MS together.

## Driver bodies are JS template literals
The suite bodies in test/smoke-net.js, test/net-handshake.js,
test/tourney-world.js and siblings are inserted into a template literal before
evaluation. A backtick anywhere in the body (comments included) ends the
literal early. A backslash escape is eaten silently (`\d` arrives as `d`).
Write `[0-9]`, never `\d`; `[.]`, never an escaped dot; quotes, never
backticks. When an inserted helper "does nothing", print its output first.
Guard: test/check-drivers.js.

## Duel driver (test/duel-driver.js)
KEEP-2 pilot (no move within torus-Chebyshev 2 of the opponent head); decoys
reverse the dirQueue TAIL via __dirTail, inert only at queue depth <= 1;
startPts = Date.now() right after startDuel().

## Goldens (sim-determinism, two lanes)
- CLASSIC runs startGame(SEED). DUEL hashes RB_HASH_DUEL off _rbDuelSnap()
  every tick of 8 scripted matches, so the golden IS the wire contract.
  Update only on deliberate rule changes. sim-events golden excludes
  particles.
- Duel pilot design, do not weaken: KEEP-2 exclusion (only scripted rams
  kill), manual simCommand({t:"advance"}), 8 matches (the heart gate needs
  level>=2 and somebody below cap), pilots WEAR gear (else _ws is empty and
  the windswept steal is uncovered).

## The headroom burst 0rb lane
duel-desync "headroom burst 0rb": seed 0x7002, err0=30ms, base15 jit1, real
first-start burst, |gap0|>25 -> |gap1|<=3, maxRb:0 through the L1->L2
boundary into an L2 speed round, doubleEvery:2; the noburst RED twin minRb:1.
Do not shorten, reseed or relax.

## Live-server harnesses
- ONE hard-coded id set, reused every run, never generated: `1111c1e7`
  (LIVETEST-A), `2222c1e7` (LIVETEST-B), `3333c1e7` (LIVETEST-GH, the
  stale/ghost seeker). Declare them once at the top with a comment saying
  not to generate new ones.
- Server-side setup is idempotent (check `friend.php action=list` before
  `request`; a repeat request feeds the anti-enumeration throttle).
- Every virtual user is named `clnt-CI-<four hex>` from the id
  (`'clnt-CI-' + id.slice(0, 4)`, or `.slice(-4)` where that half differs).
  The marker goes in the NAME; ids stay what the protocol requires.
- Tokens live in ~/.fok-server-livetest.tok via test/live-tok.js, never in
  the repo, never generated: what hello answers is adopted. The harnesses
  refuse a non-https base.
