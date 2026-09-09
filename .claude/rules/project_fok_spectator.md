# Spectator invariant - "not yet" is never terminal

FOK-snake spectating (js/net-spec.js): an ask that arrives BEFORE the match it
names is the ORDINARY arrival, not an edge case. A tournament deals the roles
sheet to players and spectators in ONE signal drain, so the spectator always
asks while the feeder still has offer/answer/ICE/go ahead of it and nothing to
serve. Field symptoms of getting this wrong: a spectator stuck on CONNECTING
that only attaches after the first death, or one that never attaches and just
lists who is playing.

INVARIANT: neither end may treat "not yet" as terminal.
- A node that cannot serve yet PARKS an ask from a peer its own grant list
  names (_spAsk + _spAskPump) and answers when it has a timeline. A FULL
  fan-out is a different answer and still redirects via `no`+`alts` - room is
  a different shortage from time.
- The asker re-asks on SPEC_ASK_RETRY_MS=1500 up to SPEC_ASK_TTL_MS=20000
  (_spWantPump). 'watch' is NOT in the receipt set, so a lost ask was already
  indistinguishable from a refusal.
- A bare `no` (no alts) and an `sno` both put the ask BACK on the ladder
  (_spWantKeep, which preserves the original deadline - a retry must not buy
  itself more time).

Why: the old code refused outright and both ends gave up; the only retry left
was tourney.js's ceremony ladder at TT_CONNECT_MS=20000 x 4, then _ttFail ->
bracket screen.

How to apply: any new spectator suite MUST use runSpec({playersAt: <s>}) so
the watcher asks before the duel exists - suites that attach to a running duel
structurally cannot catch this class of bug. Section E of test/duel-spec.js is
the regression. Related: project_fok_netcode_housekeeping.md.

## The checkpoint is minted where the ring lives

A spectator bootstrap is [sctx, checkpoint, tail]. The checkpoint comes off the
rollback ring, and in the DEFAULT runtime that ring is the WORKER's: main's own
ring is never written there (netTickPre runs in-process or in the worker, never
on a main that hosts a worker). Reading main's ring from net-spec.js minted
nothing, silently, on every device -- a watcher joining after the start booted a
fresh sim from the seed at the level its feeder's SESSION named and was never
corrected. Fixed in 4.3.0 as a round trip: main asks the worker (spCkpt),
reserves the checkpoint's number and clears the tail buffer AT THE ASK, holds the
stream while the worker answers, and on landing fans out the checkpoint and then
the held tail -- the same [rs, tail] order the in-process mint produces in one
call. The dedup rule is why the number is reserved early: a link drops anything
numbered at or below what it has seen, so the checkpoint must sit below
everything sent after it and above everything before it. An upstream checkpoint
landing at a relay outranks the one its worker is minting.

The bootstrap context names the level being PLAYED, read off the sim: only the
host's session ever learns a level boundary (s.lvl is authored in
_netStartNextLevel), so a joiner or a relay quoting its session names the level
the match OPENED on.

Every other spectator suite drives the in-process home (the harness has no
Worker). test/smoke-spec-worker.js is the only guard on the worker path -- the
same blind spot as the epoch mirror in project_fok_duel_recovery.md. Any
spectator change that touches what main does with the worker's state owes a
check there, not only in duel-spec.
