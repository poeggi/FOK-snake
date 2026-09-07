# Duel netcode housekeeping invariants

All in js/duel-core.js. See project_fok_snake.md for repo layout, project_fok_connection_lost_open.md for the recovery dossier these serve.

## Tick schedule (a staircase, not a spike)

t mod 64: 0 = pinned snapshot clone, 1 = 1Hz hash freeze+emit (hk = t-65), 2 = typical verdict (RB_SETTLE = RB_HASH_LAG+2), 17 = log/heads prune. t mod 16: 5 = heartbeat. t mod 4: 0 = warm ping, else-if'd behind the heartbeat -- the warm ping IS the radio-warm keepalive that fixed iOS-WiFi-power-save LAN lag; keep it. Every phase is a pure function of the shared simTick. The frozen 0-mod-64 grid is the ONLY phase with a wire contract (both sides freeze/compare the same tick); emit/judge/prune phases are each side's local business, so old-patch peers interop.

## Snapshot grid + pinning

- RB_SNAP_EVERY = LEVEL_CFG[9].normal (= 3, one game step at the fastest duel pace); RB_RING keeps the same ~72-tick span the old step-2 ring had.
- 64 % 3 != 0, so _rbEnsureSnap PINS the 64-grid hash ticks into the ring off the step, and _rbRollback's re-record loop uses the SAME condition (step OR 64-grid). The 1Hz freeze looks its tick up EXACTLY (_rbRingFind) -- an unpinned hash tick = a silently skipped verdict cycle.
- After the settles in netTickPre, _rbEnsureSnap(t) runs AGAIN (idempotent): a settle-path rollback truncates the ring and would otherwise cost a 64-grid tick its pin.

## Resync park (_rbResyncQ)

An ordinary rs stamped AHEAD of our sim is an EARLY packet (the sender's frontier legitimately leads), NOT an aged-out divergence. It parks in _rbResyncQ (newest wins) and drains in netTickPre once `_rbFromWire(tk) <= simTick`, BEFORE the settles. Falling through to the aged-out branch wiped the ring incl. the pinned hash snapshots -- under a running escalation clock that skipped verdict cycle is the difference between healing and OUT OF SYNC. A catch-up adoption clears the park (a parked pre-jump rs is stale).

## Cloner byte-identity CONTRACT

_rbCloneSnap/_rbClonePlayer/_rbCloneFlat replaced the generic _rbClone (6-12x measured). A clone must serialize byte-identical to its source: JSON.stringify of pinned snapshots feeds the duel hash and a rollback replaces live state on ONE side only, so nested key ORDER and key PRESENCE must reproduce exactly or identical logical states hash apart after a repair.
- Fixed shapes: snake cells / dir / dirQueue / boostDir / powerPellet / heart = {x,y}; players = _mkDuelPlayer's 10 keys in order.
- SHAPE-VARIANT, cloned by the flat one-level key walker (_rbCloneFlat), never a literal: bars (three construction sites with different key sets/orders, plus pairEnd/gd/gdUntil appended in play) and the gem ({x,y} from freeCell with tier/spawnAt APPENDED, and shipped verbatim over the rs/st wire). A literal {x,y} gem clone silently strips keys (caught as a full-resync lane diverging on gem[A={x,y,tier,spawnAt} B={x,y}]).
- KEEP IN SYNC with _rbDuelSnap / _mkDuelPlayer when fields change.

## Gotcha: silence never heals _rbBadSince

Only an AGREEING verdict clears _rbBadSince. A quiet wire (no hashes flowing) leaves a past mismatch standing and the OUT OF SYNC escalation clock running -- which is exactly why a wiped ring / skipped verdict cycle (the park + pin bugs above) turned recoverable blips into match-ending banners.

## startDuel must ZERO every hashed field

RB_HASH_DUEL is the wire agreement, so ANY field on it that startDuel (and _duelBeginLevel) leaves alone is a spurious-desync source: classic play writes it, the two devices arrive with different last games, and they disagree at TICK 0 over state neither one is even using. Four found so far -- deathMsg, powerPelletAt, _powerModeAt, _barMoveTick (the pellet and power mode are dropped, their TIMESTAMPS and the bar-drift counter were not). Rule: adding a field to RB_HASH_DUEL obliges a reset in startDuel. The duel determinism lane in test/sim-determinism.js catches this class -- run 2 starts where run 1 left off -- and names the field. See project_fok_snake.md.
