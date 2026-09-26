# DEPRECATED: the HTTP server relay (unused)

Status: **unused, deprecated, not loaded.** `net-relay.js` in this folder stays in the
repository for reference only (educational). It is not part of the game.

## What is in the file

An HTTP long-poll duel transport. Every duel datagram goes through `api/relay.php` on
the server. One way takes ~200-400 ms. It has its own handshake (an offer with no sdp,
the `invite-relay` / `accept-relay` signal types) and its own liveness rules.

## Why nothing can start it

- index.html has no script tag for it.
- The service worker does not cache it: the commit hook leaves `deprecated/` out of the
  bundle.
- The sim worker and the test harness do not load it.
- The netcode has no call into it and no fallback to it.
- The `invite-relay` and `accept-relay` signal types are neither sent nor handled.
- An offer without an sdp is logged and ignored.
- Nothing reads `cfg.noP2P`.

## What covers its case

TURN (server API 4.22). `turn.php` hands out short-lived credentials. A pc built on one
has direct, reflexive and relayed paths on the same DataChannel.

A pc that fails to connect ends the attempt and says why:

- built on a TURN credential: `NO PATH - P2P AND TURN FAILED`
- TURN RELAY: FORCED: `NO PATH - TURN FAILED`
- TURN RELAY: DISABLED: `NO PATH - P2P ONLY`
- STUN only, because turn.php answered 503: `NO PATH - P2P FAILED`

## Why the file does not run as it stands

It calls hooks the live code does not have:

- `netP2POnly` and the per-session `p2pOnly` flag
- `_netRelayHeld` in the pacing gate
- the session slots `relay`, `relayAbort`, `relaySeq`, `relayGraceUntil`,
  `relayPending`, `relayBusy`
- `netRelayActive` (the RELAY MODE line on the duel board)
- `cfg.noP2P`

## Server side

`api/relay.php` and the two relay signal types belong to FOK-server. No client of this
build calls them.
