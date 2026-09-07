# Duel INVARIANT: the lockstep timeline runs on monotonic _wall(), never Date.now()

Guarded by test/duel-drift.js in the --full tier.

THE INVARIANT: the shared lockstep PTS must run on `_wall()` = `performance.timeOrigin + performance.now()` (monotonic wall captured once, adjustment-immune), NEVER `Date.now()`. `netPts()` and BOTH ofs COMPUTE sites (`_netTimeSync` best.ofs, `_netRequestStart` `_netSync=`) use it, so ofs is computed and applied on the same monotonic base and cannot grow a bias. netTickTarget/F and the boundary burst inherit automatically (they read netPts diffs). sim-worker.js MUST mirror this (`self._wall`, netPts, `_dcSeedPhase`, `_dcTarget`) -- it is a twin of net.js, not a separate implementation.

DELIBERATELY still on Date.now(): every `at:` timestamp, silence tracking (`lastRecvWall`), staleness, hidden-time. Those genuinely want the adjustable wall clock.

WHY (do not relitigate): on a real iOS-vs-PC LAN match the phone's NTP daemon slewed its wall clock ~10ms per 1-2min (~167ppm) and that adjustment leaked straight into the timeline as observed pts/peerLag drift. 167ppm is impossible for quartz, so "crystal drift" is the wrong explanation -- the mechanism is OS wall-clock discipline, not crystal error. Residual real crystal drift (~20-50ppm) is small and the boundary burst handles it.

HARNESS MODEL (test/duel-driver.js), kept split on purpose: `performance.timeOrigin = __NET_BASE + err0` carries the real inter-device anchor error (the offset the burst must correct AND the lead that opens one-sided rollback), drift-free; `Date.now` keeps err0 + drift for wall-only uses. So a large `clock.drift` and a mid-match `__clkStep(ms)` are Date.now-only changes the timeline must ignore.

Related: project_fok_connection_lost_open.md, project_fok_headroom_shortcut.md.
