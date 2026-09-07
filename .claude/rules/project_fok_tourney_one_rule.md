# Tournament client - ONE rule drives a node

- _ttDrive(now) in js/tourney.js is THE rule: while the roles sheet names us
  (you !== 'idle'), its nid is not _ttDone, and we are not inGame -> engage
  (first time: ceremony; afterwards every TT_CONNECT_MS = 20 s a status line
  STILL LOOKING FOR A FEED / WAITING FOR <name>, screen unchanged). Giving up
  is NEVER the client's call: who did not show up is the server's walkover
  verdict.
- Deleted for good: _ttPend, _ttOffer, _ttCerAt, _ttTry, _ttRepDone,
  TT_CONNECT_TRIES, tourneyParkOffer, the connect ladder, 'MATCH DID NOT
  CONNECT'. Do not re-propose a retry counter or a parked offer.
- tourneyOfferOk(from): an offer is answered only from the sheet's peer;
  anything else refuses and re-reads state.
- A finished match gives the board up when the next sheet arrives
  (inGame && _ttOverAt -> _ttClearMatch()), so the offer behind the sheet
  lands in a live session with its trickled ICE.
- Spectators: _netReconnect returns for netSpectating(); a watcher may rewind
  to an aged-out checkpoint (anchor = (spec || T > simTick) ? T-1 : simTick).
  Measured on a 3 s watcher blackout: 69 wrong settled ticks before, 36 after.
- Tests: tourney-e2e 17-19, duel-spec F (reconnect) + G (blackout, bound
  G_MAX_WRONG 50), all with old-code falsification controls. --tourney-sim is
  on-demand only, never in a tier/lane/CI/hook.

Why: the ladder was the client second-guessing the server. The standing
direction is simple logic - rather simplify than complicate.

How to apply: any tournament connect/spectate change must stay inside the one
rule; see project_fok_spectator.md.
