# Item registry: items are server-minted instances

Item ownership lives off the device (client 3.0.0+ against server API 4.0). The server is a SEPARATE PRODUCTION repo: read it, never edit it without an explicit ask.

Rationale: a boolean in local config meant a cloud backup taken before a duel and restored after it handed the loser their stolen gear back. Ownership cannot live on the device that benefits from it.

## Shape

- `js/items.js` -- registry client for the 4 POST actions on `/api/items.php` (`list|mint|seed|claim`). Two offline backlogs live in cfg (`mintQ`, `claimQ`) plus `itemReg` = {itemId: {uid, seq}} and the one-time `itemsSeeded` flag.
- `js/hmac.js` -- SYNCHRONOUS SHA-256 + HMAC-SHA256, byte-identical to the server's `Ledger::mac`. Synchronous because the sim WORKER emits the packet the tag rides in, so WebCrypto (async) is unusable there.
- `js/duel-core.js` `_ws*` block -- the handover: on every frozen hash tick each client MACs a uid-sorted ownership digest with its own per-match secret and ships the tag as `g` in the existing `h` packet.
- `js/sim.js` -- `_ws.u[i] = {itemId: uid}` per side, and the loose item carries its `uid`.
- `test/smoke-items.js` -- 19 checks: tag vs a real node HMAC, the offline ladder, reconciliation, the claim state machine, the handover direction rules.

## Invariants (do not relitigate)

- Tag = first 16 lowercase hex of HMAC-SHA256(key = the secret's 16 RAW bytes, hex-decoded; msg = `mid + "|" + tick + "|" + ws_digest`), tick as plain unpadded decimal.
- Transfers are DERIVED by diffing consecutive attested hash ticks, never taken from the `wsget` sim event -- that event is in FX_DEFER and re-fires on every rollback re-sim. `hk = 64k - 64` is pinned and identical on both clients, so each transfer is derived once.
- Direction rule: `from == caller` ("I lost it") settles on our own tag alone -- ship at once. A GAIN waits `WS_CLAIM_WAIT` (128 drain ticks) for the peer's tag and ships unproven only when the wait runs out; the server then holds it through its own grace.
- A peer tag is kept only for a tick whose `_ws` provably agreed. An unverifiable peer tag reads as tampering server-side and FREEZES the instance -- a benign desync must never cost somebody their crown. No tag is strictly better than a wrong one.
- 404 is a soft failure, so this client is safe to run against a pre-4.0 server: the backlog just holds. `itemSync` returns early on a failed seed and never marks `itemsSeeded`, so the one-time grandfather cannot be skipped and the reconcile (which DELETES anything the server never minted) never runs unseeded.
- A `held` claim is re-sent past the grace, `stale seq`/`lost race` re-lists and retries ONCE, and a claim older than 110 min is dropped rather than waking an operator (the server's `match_open_max_ms` is 2h).
- An item with no uid (bought offline) is worn, drawn and stealable -- just unattestable.

## Stakes are negotiated on the wire (since 3.2.0)

Root cause of tournament-testing disputes (a `dispute` row immediately followed by a `transfer` row for the same uid/pair/tick): the two sides disagreed about whether the match was played for item stakes. Stakes were never on the wire -- each side worked them out from its own roles sheet -- so a sheet that reached one client late (or a session minted before its sheet was engaged) left one client claiming gains the other would never attest to (an honest, self-healing dispute). Rule: stakes are a HOST-AUTHORED `sk` bit riding every `go` packet, adopted before tick 0, an ABSENT field reading as OFF (an unstated stake is not one to play for), echoed back through `_netTxEcho` so the agreement is byte-exact; a `sk` that contradicts a roles-sheet preset ends the match with MATCH SETUP MISMATCH. `_ttRoles` also dresses a session that already exists when the sheet lands. Regression cover: `test/duel-hearts.js` (the go-builder static guard demands `hm` AND `sk`) + `test/tourney-e2e.js` section 13 (a sheet engaged after the offer it authorises).

## Open (server-side, needs an explicit ask)

- Coin and item GENERATION is still client-side. The client half is done; what remains is server-side minting (or at least server approval) on the server repo. Long-term, not urgent.
- Server-side findings handed over, not fixed here: `seed`'s "prefer the vault" path can never fire (the vault payload is `_saveSnapshot()` = `{v,hs,coins,ach,cfg,name,pid,friends,crc}` -- the top-level `items`/`owned` lookup misses and it always falls back to the client's submitted list; it would have to read `cfg.shopItems`); `docs/API.md`'s profile section does not document the additive `wornUids`/`wornSeqs` the 4.0 client sends; a GAINER that gets `stale seq` cannot repair it (a `list` never shows an instance it does not own yet) -- it relies on the loser's own claim; rename the `held` ledger kind so a held gain does not read as a dispute in the admin card, and show `ipnet` there.

See project_fok_snake.md for the versioning hook and test tiers, project_fok_volatile_steal.md for the windswept steal itself.
