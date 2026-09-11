# Duel recovery + housekeeping invariants (js/duel-core.js, net-session.js)

Every line here was paid for by a field report or a measurement. Do not
relitigate without a new one.

## 2.6 protocol
Wire transitions: go {why: match|rematch|level|respawn|resume} (ONE
host-authored timeline opener), req {why: level|again|resume} (joiner ask,
epoch-pinned), bye. bsync/sched/rst/reship/epq are DELETED; do not
reintroduce the `epq` peer-ask (the acknowledged go/req exchange re-agrees
the epoch from either role). Echo-ack from the receive handler (+a:1,
duplicates re-echo, effects epoch-deduped); ONE pending tx with a retry
ladder; an unanswered go kills at 4 s, req never. Every boundary runs the
bilateral clock burst first; `bth` rides the echoed go; a starved burst ships
NO bth (both log `! BURST SYNC FAILED`) and keeps the prior clock; recovery
is never lethal (`netPts()==null` -> skip).

The go carries the per-match parameters both sims agree on BEFORE tick 0:
`hm` (heart cap), `lvl` (opening level), `sk` (item stakes), `sp` (speed
tournament), each absent-reads-as-default, echoed back byte-exact, and each
ending the match MATCH SETUP MISMATCH when it contradicts a roles-sheet
preset. duel-hearts.js statically demands all four in both go builders.

Level number rides the wire: the board is a pure function of (gameSeed,
level), so `level` is never a private counter. The host owns s.lvl (authored
in `_netStartNextLevel`, reset to 1 on match/rematch, clamped MAX_LEVELS),
ships it as `lvl`, both sims adopt it via startDuelLevel's m.level;
duplicate begins are idempotent. Guard: smoke-level-wire.js.

## Epoch mirror (worker-hosted runtime)
The wire stamps and gates epochs on MAIN (`_netSend` writes `o.ep` from
`_rbEpoch`, `_netHandleMsg` compares); the worker cannot compute it. Main
MUST run `_rbReset()` in BOTH worker branches (beginOnlineDuel/-Level) when
the worker rebases, and `_netTeardown` resets the mirror AFTER nulling
`_netSess`. Under an epoch split all three detectors go blind (hash gated
above `_rbCheckHash`; `_netMarkRecv` stamps on receipt; neither sim is
frozen). Repair: `_netLiveCheck` fires an overdue begin off `netPts() >=
s.beginAt`, `_netEpochSplit` times the mismatch, `_netEpochRecover` ends the
match OUT OF SYNC past RB_PERSIST_KILL_MS. Guards: smoke-epoch-mirror.js,
duel-epoch.js.

## Resume boundary + death halt
- A reconnect or peer-a-full-ring-behind arms a FULL resync burst
  (`_rbArmFullResync`; routine single-rs repair does not). Its settle opens
  an adopt-only clock re-anchor: startPts = round(netPts()-simTick*TICK_MS),
  epoch bump, NO rebuild/tick-reset/ring-clear; host authors go{resume},
  joiner sends req{resume}. Guard: smoke-recovery-resume.js.
- Death is a halt: duelHalt -> host answers ONE go{respawn} (duplicates fold
  via lvlPending), full burst + rebuild at tick 0. The dying hold
  re-announces duelHalt every _HALT_RE=6 ticks until answered (a one-shot
  edge wedged the host under a pending resume boundary, or after a
  full-resync adoption past the DEATH_DUR crossing). Emits are side effects,
  never hashed. Escape works in 'dying'. Guard: smoke-respawn-halt.js.

## Backgrounding / recovery band (product choice, leave as is)
Ending the match after a long absence IS the chosen behaviour; no pause
mode. The worker keeps the duel running ~3-4 s after backgrounding, then
silence. Ladder on the awake side: banner RB_WARN_MS ~533 ms silence ->
transport rebuild RB_RECONNECT_MS ~1067 ms -> kill RB_PERSIST_KILL_MS 4000
(from the last RECEIVED packet, unconditional). Independent limits: frozen
side >600 ticks, unanswered go 4 s, unhealed desync 4 s. Keepalives every
NET_KEEPALIVE_MS=300 carry the input log. A wire cut with BOTH sides running
is unrecoverable by design (duel-outage's 6 s control).

## Resync ownership: your snake is yours for the ticks you ACTUALLY RAN
`_rbApplyResync` splits on `catchUp = T > simTick + RB_DEPTH`:
- CATCH-UP (we froze while the sender ran): adopt the sender's ENTIRE
  frontier, both snakes, anchor T-1. Role-agnostic. The frozen side snaps its
  own head ONCE here, legitimately.
- ORDINARY (host-authoritative, only the joiner adopts): KEEP YOUR OWN SNAKE.
  In-ring: keep the ring copy at T, `_rbRollback(T)` replays logged inputs.
  Aged out: keep geometry, take the shared world + lives/alive/score, never
  rewind the tick, push one 'st'. That `_rbSendState` is DUAL-PURPOSE (also
  the frozen client's proof-of-life packet): never make it conditional.
Do not make the ordinary branch adopt (measured lateral trade); any future
attempt must key on un-acked local input tracking, not tick direction.
Guard: duel-respawn.js, PER-SIDE assertion (live side liveJumps == 0, frozen
side at most one snap).

## netTickPre repair ordering
All input records apply only via netTickPre's log-feed for t=simTick+1. The
three repair paths (parked-'rs' drain, `_rbHashSettle`, `_rbStateSettle`)
rebuild from a ring entry and replay only up to simTick, so a repair AFTER
the log-feed silently drops the records just fed for t and the worlds split
unhealably. RULE: netTickPre runs drain + both settles BEFORE
`_rbEnsureSnap(t)` + the log-feed, then `_rbEnsureSnap(t)` again (a settle
rollback truncates the ring). Guard: 3 pinned seeds in duel-suspend.js;
never chase a seed, pin it.

## Tick schedule + ring
- t mod 64: 0 pinned snapshot, 1 hash freeze+emit (hk = t-65), 2 verdict
  (RB_SETTLE), 17 prune. t mod 16: 5 heartbeat. t mod 4: 0 warm ping (the
  radio-warm keepalive that fixed iOS WiFi power-save lag; keep it). Only the
  0-mod-64 grid has a wire contract.
- RB_SNAP_EVERY = LEVEL_CFG[9].normal (3). 64 % 3 != 0, so `_rbEnsureSnap`
  PINS the 64-grid ticks and `_rbRollback`'s re-record uses the same
  condition; the freeze looks its tick up exactly (`_rbRingFind`).
- Ring convention: an entry stamped tk=T holds the state at simTick T-1; a
  resync adopting it anchors T-1, never T.
- An ordinary rs stamped AHEAD of our sim is an EARLY packet: it parks in
  `_rbResyncQ` (newest wins) and drains once `_rbFromWire(tk) <= simTick`.
  A catch-up adoption clears the park.
- Only an AGREEING verdict clears `_rbBadSince`; a quiet wire leaves the
  OUT OF SYNC clock running.

## Cloner byte-identity contract
`_rbCloneSnap/_rbClonePlayer/_rbCloneFlat` must serialize byte-identical to
the source (key ORDER and PRESENCE): pinned snapshots feed the hash. Fixed
shapes: cells/dir/dirQueue/boostDir/powerPellet/heart = {x,y}; players =
`_mkDuelPlayer`'s keys in order. SHAPE-VARIANT via `_rbCloneFlat`, never a
literal: bars and the gem (tier/spawnAt appended). Keep in sync with
`_rbDuelSnap` / `_mkDuelPlayer`.

## Five hand-synced duel field lists
RB_HASH_DUEL (also the wire contract, positional), `_rbDuelSnap()`,
`simApplyDuel()`, `_rbFullState()/_rbApplyResync()`, the cloners. Miss one =
desync. Every hashed field must be JSON-transparent (a Set stringifies to
`{}`; sim-duel.js asserts this). Adding a field to RB_HASH_DUEL obliges a
reset in startDuel/_duelBeginLevel, or two devices arrive with different
last classic games and disagree at tick 0 (the determinism lane catches it).
FX routing: ONE FX_DEFER set in assets.js feeds drainSimEvents,
_applyDuelEvents and the worker replay filter; never a per-home list.

## Banners + the second CONNECTION LOST trigger
CONNECTION LOST = silence (every inbound datagram refreshes `_netMarkRecv`; a
refused input never warns) OR a wedged peer sim: the proof of a live peer is
the `tk` every packet stamps MOVING, taken only in `_netHandleMsg` (never
from forwarded spectator packets). `_netSimStalled` suppresses where a sim
may sit still (s.tx, lvlPending, reconnecting, relay, spectating, no
baseline); RB_SIM_STALL_MS = RB_PERSIST_KILL_MS (banner), RB_SIM_KILL_MS =
2x; no reconnect rung. Amber OUT OF SYNC = unhealed hash divergence; silence
outranks it; both share RB_PERSIST_KILL_MS. Debouncing the amber banner was
rejected. 'st' carries the WHOLE player (`_rbPackPlayer`). Guard:
duel-warn.js cases 10-14.

## Clock burst
Symmetric per-boundary BURST on the RAW clock (`rts` = netRawPts(), the only
raw time on the wire); sq 0 pre-warm; sanity = finiteness per sample, rttMin
in [0,5000] at the verdict. HOST low-passes across boundaries (bsPrev),
converts to the shared-clock residual R, applies -R/2 slew-capped
(NET_BURST_SLEW_MS 200), ships bth = round(R); joiner applies +R/2. Gate MIN
5 of 6 per direction, WAIT 200 ms, GAP_TICKS=1 absolute deadlines, TRIES 10.
`_netSend` stamps pts/rts LAST and owns the oversize drop. The burst runs on
MAIN (paced to the tick), never the worker send path. duel-boundary has no
load-bearing pair and cannot; the burst's load-bearing-ness is duel-sync +
duel-rematch.
