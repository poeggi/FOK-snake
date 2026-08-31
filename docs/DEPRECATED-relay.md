# DEPRECATED: the HTTP server relay

Status: **deprecated, still shipping.** The relay is the live p2p-failed fallback and is
NOT removed. Nothing in this document has been switched off. Treat it as frozen: fix it if
it breaks, but do not extend it, and do not build new netcode that needs a relay equivalent.

## Why

The relay forwards duel datagrams through `api/relay.php` over HTTP long-poll (~200-400ms
one-way). It exists because the shared webhost cannot run a TURN server: `_netRtcInit`
carries STUN only, so a peer behind a symmetric NAT has no other path.

The replacement is coturn in the `iceServers` list. That keeps the IDENTICAL DataChannel --
same unreliable-unordered netcode, one forwarding hop -- and retires `relay.php` entirely.
It is an infrastructure change (a host with open UDP), not a code change.

## What removal looks like

1. `rm js/net-relay.js` -- the whole relay transport and relay-mode handshake.
2. Drop its `<script>` tag from `index.html`, its entry in `test/harness.js` (`src`) and in
   `test/check-ownership.js`.
3. Delete the residual hooks below. Every one carries a `DEPRECATED(relay)` marker, so
   `grep -rn "DEPRECATED(relay)" js/` is the authoritative list -- this file is a summary.
4. Retire the `NETWORK > NO P2P` setting (`cfg.noP2P`) and `api/relay.php` server-side.

## Residual hooks (all marked `DEPRECATED(relay)`)

`js/net-rtc.js`
- `_netMkSess`: the `relay/connT/relayAbort/relaySeq/relayGraceUntil/relayPending/relayBusy`
  session slots.
- `_netRtcInit`: the `s.relay` ownership guard, the `_netRelayStart` call on a failed
  connection, and the 6s fallback timer. Without the relay a failed P2P just ends the attempt.
- `_netRtcDc`: the "P2P completed after the fallback" upgrade branch, and the `!s.relay`
  guard on `dc.onclose`.
- `_netSend`: the warm-ping `s.relay` skip and the `_netRelaySend` transport fork.
- `_netPathProbe`: the relay branch that reports the server RTT; without it the head of the
  function is a plain `if(!s) return`.
- the liveness pass: the whole `if(s.relay)` branch (grace window + silence kill).
- `_netReconnect`: the `s.relay` guard.

`js/net-session.js`
- `_netHs.sentRelay`.
- `netInvite` / the invite-accept path / quick match: the `cfg.noP2P` mode selection and
  the `invite-relay` / `accept-relay` signal types and their handlers.
- the answer path: the `_netRelayAnswer` fork and the `d.relay` "peer answered in relay
  mode, come over" branch.
- `_netHandleMsg`: the doubled warn bar (`RB_WARN_MS * 2`) and the grace-window suppression.
- `_netTeardown`: `s.relay = false` and the `relayAbort` abort.

`js/storage.js` -- the `cfg.noP2P` toggle. `js/screens.js` -- the `netRelayActive()` board tag.

## Test coverage

There is none, by intent. No suite has the relay as its SUBJECT: a frozen transport that is
scheduled for deletion does not earn ~1s of every commit's regression budget, and its known
pathologies were server-side (long-poll batching, store-full) rather than engine bugs.

`test/net-handshake.js` still drives several invite/lobby cases through `__setRelay(true)`,
but only as a VEHICLE -- the relay handshake completes without WebRTC mocks, so it is the
cheapest way to reach a connected pairing. Those cases assert lobby behaviour, not relay
behaviour, and they move to a mocked p2p path when the relay goes.
