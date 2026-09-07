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
