# Online duel: lockstep, boundaries, recovery (js/duel-core.js, net-session.js)

Deterministic lockstep: no host authority over the sim, inputs-only JSON on
the wire (redundant input log + ~1/s state hash), rollback, WebRTC DataChannel
only (TURN is the relayed path), NET_PKT_MAX=1200 one-datagram cap. Tick model
and dirQueue: sim.md.

## HEADROOM + SHORTCUT (a non-negotiable pair)
- HEADROOM (`netLocalInput`): every local input is authored >= ONE tick in
  the future (dir at `simTick + _gDue`, boost/boostend at `simTick+1`) and
  sent at once; that lead is the transmit window, never widened or
  collapsed. "At once" = leading-edge flush at authoring, capped by
  `_netInFlush` at one flush per tick, plus `_netInRepeat` (the next
  input-free netTickPre repeats the last flush once).
- SHORTCUT (`_netPeerInput`): a peer input with `tk === simTick` is
  live-applied (`simCommand`) instead of rolled back, ONLY if that tick did
  not already consume it (dir -> `!_rbPeerSteppedSince(oP, tk)`; boost ->
  `tk > _gAt`). The only lockstep-safe live-apply; anything older goes
  through ONE batched rollback+replay in netTickPre. A general past-input
  live-apply is unsound (a later rollback drops it).
- The duel-desync `headroom subtick 0rb` lane discriminates only with driver
  opts `postAuthor` (hold the steer to `_gDue==1`) + `doubleEvery`. Do not
  weaken it.

## Rollback asymmetry (guards: duel-asym.js, duel-touch.js)
- Under a clock offset the AHEAD client rolls back, the BEHIND client
  live-applies; rbBehind is a hard zero. Heavy one-sided rollback is a
  smoothness cost, not a correctness failure.
- netLocalInput never PRE-JUDGES an input as redundant (a rollback can change
  dirQueue). The send-side gate is axis-wide: suppress iff BOTH
  `_lastLocalDir` and `players[myP].dir` lie on the press's axis (provably
  discarded on both clients; the live heading guards a respawn/level heading
  reset). `boostend` authors on a separate ungated path.
- Rejected: wire-layer send coalescing; a fixed packets-per-second cap;
  `clockLeadsFire` as the driver default (burst suites rely on the decoupled
  model); a measured before/after claim on the receive-side rollback cap.
- A rig that fakes a duel start MUST arm through `_netArmBegin`, never call
  beginOnlineDuel directly: the catch-up closes only a deficit (`d > 1`), so a
  sim started ahead stays ahead (symptom: rb/rec pinned at 1.00, maxRew = the
  offset).

## Wire transitions
- go {why: match|rematch|level|respawn|resume} is the ONE host-authored
  timeline opener; req {why: level|again|resume} is the joiner's ask,
  epoch-pinned; bye. Nothing else, and never a peer epoch ask: the
  acknowledged go/req exchange re-agrees the epoch from either role.
- Echo-ack from the receive handler (+a:1, duplicates re-echo, effects
  epoch-deduped); ONE pending tx with a retry ladder; an unanswered go kills
  at 4 s, req never.
- The go carries the per-match parameters both sims agree on BEFORE tick 0:
  `hm` (heart cap), `lvl` (opening level), `sk` (item stakes), `sp` (speed
  tournament); each absent-reads-as-default, echoed back byte-exact, and a
  contradiction with a roles-sheet preset ends the match MATCH SETUP
  MISMATCH. Guard: duel-hearts.js demands all four in both go builders.
- The level number rides the wire: the board is a pure function of
  (gameSeed, level). The host owns s.lvl (authored in `_netStartNextLevel`,
  reset to 1 on match/rematch, clamped MAX_LEVELS), ships it as `lvl`; both
  sims adopt it via startDuelLevel's m.level; duplicate begins are
  idempotent. Guard: smoke-level-wire.js.

## Tick 0 IS the boundary's startPts, on both clients
- Every timeline opener names ONE absolute PTS: a match start takes
  `start_pts` from the server (flat 1000 ms lead); a level/respawn/rematch
  boundary takes it from the HOST (`netPts() + NET_BURST_LEAD_MS`, 500, so
  the joiner's `bth` nudge settles before the fire).
- `_netArmBegin` fires on a local timer, so `_netBoundarySettle()`
  (net-session.js; twin `_dcBoundarySettle()` in sim-worker.js) steps exactly
  the ticks already elapsed against startPts at the rebuild, bounded at 120.
  A startPts in the past is not an error; never clamp it.
- PLAYERS ONLY: a spectator boots from a checkpoint and never invents ticks.
- Never widen the `d > 1` gate to `d >= 1`.
- Guard: duel-desync `tickSplit` (the minimum of tickA-tickB over a stretch
  must reach 0; single readings prove nothing; sampled before the fire
  phase; the noburst twin opts out).

## Clock burst
- Every boundary runs the bilateral burst first, symmetric, on the RAW clock
  (`rts` = netRawPts(), the only raw time on the wire); sq 0 pre-warm;
  sanity = finiteness per sample, rttMin in [0,5000] at the verdict.
- HOST low-passes across boundaries (bsPrev), converts to the shared-clock
  residual R, applies -R/2 slew-capped (NET_BURST_SLEW_MS 200), ships
  bth = round(R) on the echoed go; the joiner applies +R/2.
- Gate MIN 5 of 6 per direction, WAIT 200 ms, GAP_TICKS=1 absolute
  deadlines, TRIES 10. A starved burst ships NO bth (both log `! BURST SYNC
  FAILED`) and keeps the prior clock; recovery is never lethal
  (`netPts()==null` -> skip).
- `_netSend` stamps pts/rts LAST and owns the oversize drop. The burst runs
  on MAIN (paced to the tick), never the worker send path.
- Load-bearing guards: duel-sync + duel-rematch (duel-boundary has no
  load-bearing pair and cannot).

## The timeline runs on monotonic _wall(), never Date.now()
`netPts()` and both ofs compute sites use `_wall()` = performance.timeOrigin +
performance.now(); sim-worker.js mirrors it, so OS clock slew never reaches
the timeline. Date.now() stays for `at:` stamps, silence tracking, staleness,
hidden-time. Harness: performance.timeOrigin carries err0 drift-free;
Date.now keeps err0 + drift. Guard: duel-drift.js.

## Epoch mirror (worker-hosted runtime)
- The wire stamps and gates epochs on MAIN (`_netSend` writes `o.ep` from
  `_rbEpoch`, `_netHandleMsg` compares); the worker cannot compute it. Main
  runs `_rbReset()` in BOTH worker branches (beginOnlineDuel/-Level) when the
  worker rebases; `_netTeardown` resets the mirror AFTER nulling `_netSess`.
- Under an epoch split all three detectors are blind (hash gated above
  `_rbCheckHash`; `_netMarkRecv` stamps on receipt; neither sim is frozen).
  Repair: `_netLiveCheck` fires an overdue begin off `netPts() >=
  s.beginAt`, `_netEpochSplit` times the mismatch, `_netEpochRecover` ends
  the match OUT OF SYNC past RB_PERSIST_KILL_MS.
- Guards: smoke-epoch-mirror.js, duel-epoch.js.

## Resume boundary + death halt
- A reconnect or a peer a full ring behind arms a FULL resync burst
  (`_rbArmFullResync`; routine single-rs repair does not). Its settle opens
  an adopt-only clock re-anchor: startPts = round(netPts()-simTick*TICK_MS),
  epoch bump, NO rebuild/tick-reset/ring-clear; the host authors go{resume},
  the joiner sends req{resume}. Guard: smoke-recovery-resume.js.
- Death is a halt: duelHalt -> the host answers ONE go{respawn} (duplicates
  fold via lvlPending), full burst + rebuild at tick 0. The dying hold
  re-announces duelHalt every _HALT_RE=6 ticks until answered, never as a
  one-shot edge (lost under a pending resume boundary or a full-resync
  adoption past the DEATH_DUR crossing). Emits are side effects, never
  hashed. Escape works in 'dying'. Guard: smoke-respawn-halt.js.

## Backgrounding and the recovery band (product choice, leave as is)
Ending the match after a long absence IS the behaviour; no pause mode. The
worker keeps the duel running ~3-4 s after backgrounding, then silence. On the
awake side: banner RB_WARN_MS ~533 ms silence -> transport rebuild
RB_RECONNECT_MS ~1067 ms -> kill RB_PERSIST_KILL_MS 4000 (from the last
RECEIVED packet, unconditional). Independent limits: frozen side >600 ticks,
unanswered go 4 s, unhealed desync 4 s. Keepalives every NET_KEEPALIVE_MS=300
carry the input log. A wire cut with BOTH sides running is unrecoverable by
design (duel-outage's 6 s control).

## Resync ownership: your snake is yours for the ticks you ACTUALLY RAN
`_rbApplyResync` splits on `catchUp = T > simTick + RB_DEPTH`:
- CATCH-UP (we froze while the sender ran): adopt the sender's ENTIRE
  frontier, both snakes, anchor T-1. Role-agnostic. The frozen side snaps its
  own head ONCE here.
- ORDINARY (host-authoritative, only the joiner adopts): KEEP YOUR OWN SNAKE.
  In-ring: keep the ring copy at T, `_rbRollback(T)` replays logged inputs.
  Aged out: keep geometry, take the shared world + lives/alive/score, never
  rewind the tick, push one 'st'. That `_rbSendState` is also the frozen
  client's proof-of-life packet: never make it conditional.
- Never make the ordinary branch adopt; any such design keys on un-acked
  local input, never tick direction.
- Guard: duel-respawn.js, PER-SIDE (live side liveJumps == 0, frozen side at
  most one snap).

## netTickPre repair ordering
All input records apply only via netTickPre's log-feed for t=simTick+1. The
three repair paths (parked-'rs' drain, `_rbHashSettle`, `_rbStateSettle`)
rebuild from a ring entry and replay only up to simTick, so a repair AFTER the
log-feed drops the records just fed and the worlds split unhealably. RULE:
drain + both settles BEFORE `_rbEnsureSnap(t)` + the log-feed, then
`_rbEnsureSnap(t)` again (a settle rollback truncates the ring). Guard: 3
pinned seeds in duel-suspend.js; never chase a seed, pin it.

## Tick schedule + ring
- t mod 64: 0 pinned snapshot, 1 hash freeze+emit (hk = t-65), 2 verdict
  (RB_SETTLE), 17 prune. t mod 16: 5 heartbeat. t mod 4: 0 warm ping (keeps
  the iOS WiFi radio out of power-save; keep it). Only the 0-mod-64 grid has a
  wire contract.
- RB_SNAP_EVERY = LEVEL_CFG[9].normal (3). 64 % 3 != 0, so `_rbEnsureSnap`
  PINS the 64-grid ticks and `_rbRollback`'s re-record uses the same
  condition; the freeze looks its tick up exactly (`_rbRingFind`).
- Ring convention: an entry stamped tk=T holds the state at simTick T-1; a
  resync adopting it anchors T-1, never T.
- An ordinary rs stamped AHEAD of our sim is EARLY: it parks in `_rbResyncQ`
  (newest wins) and drains once `_rbFromWire(tk) <= simTick`. A catch-up
  adoption clears the park.
- Only an AGREEING verdict clears `_rbBadSince`; a quiet wire leaves the OUT
  OF SYNC clock running.

## Five hand-synced duel field lists
RB_HASH_DUEL (also the wire contract, positional), `_rbDuelSnap()`,
`simApplyDuel()`, `_rbFullState()/_rbApplyResync()`, the cloners. Miss one =
desync.
- Every hashed field is JSON-transparent (a Set stringifies to `{}`;
  sim-duel.js asserts it).
- Every field in RB_HASH_DUEL is reset in startDuel/_duelBeginLevel, or two
  devices with different last classic games disagree at tick 0 (the
  determinism lane catches it).
- Cloners (`_rbCloneSnap/_rbClonePlayer/_rbCloneFlat`) serialize
  byte-identical to the source (key ORDER and PRESENCE): pinned snapshots
  feed the hash. Fixed shapes: cells/dir/dirQueue/boostDir/powerPellet/heart
  = {x,y}; players = `_mkDuelPlayer`'s keys in order. SHAPE-VARIANT via
  `_rbCloneFlat`, never a literal: bars and the gem (tier/spawnAt appended).
- FX routing: ONE FX_DEFER set in assets.js feeds drainSimEvents,
  _applyDuelEvents and the worker replay filter; never a per-home list.

## Banners
- CONNECTION LOST = silence (every inbound datagram refreshes
  `_netMarkRecv`; a refused input never warns) OR a wedged peer sim: the
  proof of a live peer is the `tk` every packet stamps MOVING, taken only in
  `_netHandleMsg` (never from forwarded spectator packets). `_netSimStalled`
  suppresses where a sim may sit still (s.tx, lvlPending, reconnecting,
  spectating, no baseline); RB_SIM_STALL_MS = RB_PERSIST_KILL_MS (banner),
  RB_SIM_KILL_MS = 2x; no reconnect rung.
- Amber OUT OF SYNC = unhealed hash divergence; silence outranks it; both
  share RB_PERSIST_KILL_MS. Never debounce the amber banner.
- 'st' carries the WHOLE player (`_rbPackPlayer`).
- Guard: duel-warn.js cases 10-14.
