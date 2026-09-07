# CI time: lanes + 5-shard matrix

Target: CI well under 2 minutes. Mechanism: `test/lanes.js` + `--shard k/N` in `test/run-suites.js` + a 5-job matrix in `.github/workflows/ci.yml`.

Why it had to be lanes AND shards: the tier is ~1000 core-seconds of pure deterministic simulation (no real timers, so parallelism scales cleanly), and ubuntu-latest is 4 cores. But a suite is one process and a process is one core, so the longest single suite is a floor no hardware lowers -- duel-desync alone was ~139s on CI. Sharding alone floored at 139s; lanes had to come first.

Measured at 4 jobs (the CI core count), whole tier -> heaviest of five shards: 148.3s -> 36.2s (shards: 25.1 / 36.2 / 29.5 / 31.6 / 31.2). At 24 jobs the whole tier went 81.7s -> 42.4s.

Two guards, both load-bearing -- do not remove:
- A case that is a FALSIFICATION CONTROL runs in EVERY lane, never dealt into one (duel-outage's over-long-outage FATAL). A lane's recovery claims mean nothing without it.
- An EMPTY LANE (and an empty shard) FAILS. A suite that asserts nothing still prints its banner and the runner reads that as a pass -- the same trap the banner rule exists for.

Lane counts live in `LANES` in run-suites.js: duel-spec 4, duel-desync 3, duel-suspend 3, duel-boundary 3, duel-spec-tree 3, duel-outage 2. Two forms: `lane(ARRAY)` for a case list, `if(lane.step()){` for suites written as sequential blocks (the two spec suites). Partition is verified by `--list`: the union of the five shards equals the unsharded tier, entry for entry.

Folding was never the lever and is exhausted. The two scenarios that asserted nothing the others did were removed (~18s serial, ~3%) -- inside run-to-run noise. What is left is either a falsification control or a named invariant; do NOT re-propose cutting duel-desync's `headroom burst 0rb` lane (see project_fok_headroom_shortcut.md).

Also in place: `paths-ignore` for `docs/**` and `**.md` (a docs-only push used to pay the full ~4 minutes), and the `weight` table refreshed to measured values. A stale weight costs packing efficiency, never correctness.
