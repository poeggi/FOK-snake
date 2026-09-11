# Events - the client half (server API 4.14)

An EVENT is a room an operator opens on the server: a LAN party, a club night, a
stand at a fair. You get in by scanning its QR, straight in when it is OPEN and
after the organizer approves you when it is CLOSED. Inside, the organizer runs
tournaments only members can see, past ones are archived, joining grants a secret
achievement, and any member can pass the event on with a QR that lives 20 s.

Everything lives in `js/events.js` plus the screens around it. The contract is
FOK-server `docs/API.md` section "Events".

## THE SERVER IS THE ROSTER, and nothing here keeps a copy

Membership is rows on the server and nothing else. Every screen reads fresh when
it opens, re-reads after every verb, and drops what it held when it closes. There
is no reconciliation at startup and nothing in the vault.

This is deliberately NOT the friends-list pattern: its local copy plus its
startup reconciliation is what fires a burst of requests after a config restore.
A member learns it was removed by the event being gone from the `events` list --
that is the whole notification and there is not meant to be another.

`_ev`, `_evList`, `_evMem` and `_evPass` are pictures of the last answer. If a
future change makes one of them outlive its screen, that is the bug.

## Two codes, ONE budget, and the dot is what tells them apart

    #event=<eid>.<pass>   a live pass: 4 + 1 + 6
    #event=<key>          a printed key: 11, and it NAMES ITS OWN EVENT

Both are 11 characters, so both URLs are 53 bytes. ELEVEN IS THE WHOLE BUDGET:
every QR an event shows has to be readable by this game's own scanner, which is a
fixed QR version 3 at level L holding 53 text bytes, and 42 of those are the URL
prefix. The server renders the poster at exactly version 3 / level L / mask 0 for
that reason.

That budget is why a pass names no issuer and why the key carries no eid. API
4.11 shipped a 16-character key in a 63-byte URL, which no version 3 code holds,
so the poster could not be scanned in the app at all -- the whole point of
printing one. 4.12 fixed it on the SERVER side by shortening the key.

DO NOT "fix" a future overflow by generalising the decoder. It was tried
(versions 1-6, both ECC levels, block de-interleaving) and thrown away: it took
`qrDecodeImage` from 4.8 ms to 13 ms a frame on a path the profiler already
flags, and the right answer was a shorter code. If a payload stops fitting, the
budget is the thing to hand back to the server.

`EVENT_HASH_RE` captures ONE thing -- the code exactly as scanned, dot and all --
because that is what `join` posts. The client never has to know which of the two
it is holding.

## join is the one action with no eid

Every other action names its `eid`; `join` cannot, because a printed key has none
to send. It posts `{id, code}` and the server reads the event out of the code.
Which event it was comes back on the ANSWER, adopted in `_evAdopt` -- the single
place that sets `_evEid`. Do not add a second.

## The monitor is a SPECTATOR, and that is not negotiable

It goes through the path that already exists: the ordinary `watch` signal, the
same P2P feed a tournament spectator gets, the same renderer. `js/events.js`
contains no part of the feed -- no RTCPeerConnection, no signalling, no envelope
handling -- and `js/net-spec.js` was not touched to build it. The only new thing
is the screen. Never write a second transport here.

Following the bracket is one rule: the sheet names the match in flight, and a
new one is asked for only AFTER the old feed is let go, because the two are
different timelines and a watcher boots from a checkpoint off the feed. A
standing feed is never re-asked; a finished round releases it.

THE MONITOR IS DEALT THE SHEET (server API 4.14). The event's monitor holder
receives every `tourney` signal of the event's tournament, in the same drain as
the players. `_ttOnSignal` hands a signal for a tid it does not hold to
`eventMonitorSignal`: `roles` is adopted and followed at once, exactly as a
participant treats it (a sheet IS the state read, and its `after_ms` is owed by
a watcher too); `roles-patch` re-wires the sheet held; everything else is a hint
to re-read `monitor`. The 30 s lease is now only the lease. Before 4.14 the
monitor learned of a match at its next lease read, so it joined every round up
to 30 s late.

INVISIBLE MEANS IT COSTS NOBODY ANYTHING. The sheet names the monitor in a field
of its own, `monitor`, outside `players`, `primaries`, `secondaries` and `names`,
so no client lists, draws or counts it. Every client grants the feed off that
field (`specGrant`), which is what lets a MAKE DUELS PRIVATE player feed it, and
the feeder serves it on a slot of its own beside the two primaries
(`specMonitor` / `_spRoomNow` in net-spec.js): the two direct slots are counted
over everyone but the monitor, it always has room, and it is never handed out as
an alt because it feeds nobody. A monitor hangs off the feeder directly and has
no primary to fall back on, so when net-spec's own ask ladder gives up the
follow asks the OTHER player, who holds both input streams in lockstep.

ASKING IS NOT TAKING. Whether an event offers a screen is `monitor_allowed` on
`state` and on every `events` row. The `monitor` call CLAIMS the slot -- never
use it to find out, or opening a page takes the screen off a TV that is merely
switched off. An absent field reads as allowed.

A refusal is said once and then STOPS. Neither 409 `monitor taken` nor 403
`no monitor` becomes true by being asked again, and a screen nobody attends must
not sit retrying.

## An event tournament is an ORDINARY tournament

Same lifecycle, same bracket, same deadlines, same caps, same screens. `eid` is a
tag on it and a membership check on the way in, and that is the entire difference.
`js/tourney.js` gained three things and no branch: a field on `_ttUi`, the `eid`
on the create body, and an EVENT label in the announce. Keep it that way.

The create is the NORMAL dialog carrying the room it was opened from, and ONLY
that create -- one started from the ordinary tournament screen inherits nothing,
which is why the room is set on every `tourneySetupOpen` rather than left
standing.

## MILLISECONDS, except three fields that are SECONDS

Every timing value in this API is unix milliseconds -- `starts`, `ends`, `now`, a
pass slot's `at` -- EXCEPT the three that are only ever displayed as calendar
dates, which are SECONDS: `asked`, `joined`, `finished`.

Feeding one of those to `Date()` unmultiplied renders 1970 and NOTHING THROWS.
`eventDay()` does the conversion and is the only place that should.

## The rows offer only what the server would allow

`eventRows()` is derived from the same three facts the server checks -- the row
state, who the organizer is, and whether the event runs on a clock -- because a
screen that offers what the next request will refuse is a screen that lies. A
pending row and a reserved monitor are offered nothing; the organizer cannot
leave the room it runs; a scheduled event takes the hand verbs away and keeps the
door.

No verb adopts its own answer. Each asks and then RE-READS, so one that
half-worked cannot leave the page saying it fully did.

## The state is DERIVED, never read

`eventState()` computes it from `starts`, `ends` and the synced clock, so a
scheduled event flips with nothing pushed. Ended outranks the schedule, the
schedule outranks the mode, and with no synced clock the server's word stands.

Nothing here polls on a timer. The four `event` signals say something MOVED and
the server is asked what; not one of them is a state change to apply on its own
word.

## `events` rides a poll tick of its own

`ev` ANSWERS AT ONCE -- `poll.php` never 204s a request that asked for rows -- so
riding every poll cuts every hold short and spins an event screen into a hot
loop. It gets `NET_EVENTS_MS` spacing for the same reason the tournament announce
does. The tick is spent only on an answer that came back.

Asked for on the six screens that show it and nowhere else. Event screens poll
and HOLD like the lobby: the four signals arrive in the ordinary mailbox, and a
monitor's watch handshake has nowhere else to land.

## The achievement is server-carried

`ev_<eid>` is named when the event is opened and could never be in the shipped
table, so the server sends id, name, desc and an optional icon. Only the
DEFINITION is kept locally (`ACH_EV_KEY`), deliberately OUTSIDE the backup
manifest: membership is the server's, so a member's `state` read carries it back.
The unlock itself rides the backup like any other.

It renders on the hidden EGGS page, because it is the same kind of thing --
secret, never listed before it is earned, found by being somewhere rather than by
playing well. What the GRID holds is the cap, not what was earned.

## Do not relitigate

- The scanner answers an event link from ANY camera window, tested before the
  mode-specific patterns. Somebody holding up a phone cannot know which of our
  screens is showing.
- `EVENT_HASH_RE`'s class is the CONTRACT'S (`A-Z2-9`), one character wider than
  the code alphabet, which also drops I, L and O. It is a SHAPE filter; what a
  code really is belongs to the server, which answers a wrong one 404.
- A pending row sees the public face and nothing else. The server enforces it and
  so does the page.

Related: project_fok_multiplayer_netcode.md, project_fok_spectator.md,
project_fok_pacing.md, feedback_fok_wire_words.md,
feedback_fok_no_compat_shims.md.
