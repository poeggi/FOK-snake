# Identity - the client half (server API 4.21; contract: FOK-server docs/API.md "Identity token")

The id is public (friend code, rosters, sheets). `tok` proves it: 32 hex the
server mints on the first hello of an unbound id and answers ONCE. It never
changes for an id; only the operator's reset makes the next hello mint again.

- ONE stamp site (js/net-api.js): `_netTokBody` on every POST body that
  names an id (the beacon and the relay POST go through it too). Every
  request that names the id IS a POST (4.21: the poll, the relay's held
  read and the vault restore carry their members as a JSON body through
  `_netRead`); nothing names the id on a request line, which the web
  server's access log records. The bare GET is only the score board.
  `tok` is sent as null until a hello has minted one; never omitted.
- ONE rule for the answer: whatever a hello answers as `tok` is stored
  (`setCloudToken`). Nothing else mints; the cloud vault checks the same
  token, so `cloudBackup` REQUIRES one and never retries without it.
- 401 = `_netTokRefused`: the wire stops (`_netOk()` false, no beat, no
  retry), `netStatusNotice()` says ID BOUND TO ANOTHER DEVICE, the MY ID
  screen adds RESTORE YOUR BACKUP OR RESET YOUR ID. Ahead of the first
  answered hello of a session only hello's own 401 counts (a poll can leave
  first on a never-bound id; the hello then binds it). An answered hello
  clears the latch.
- The identity moves as one: RESET ID clears the token; a restored file
  brings its `tok`, and one without it that names ANOTHER id clears ours
  (null binds a free id, is refused on a bound one); one naming the id this
  device holds leaves the copy standing. Both call `netIdentityChanged()`,
  which unlatches and sends the hello. The cloud payload never carries `tok`;
  the file backup does (outside the crc).
- The live harnesses (test/peer-net.sh, items-live.js, hello-live.js) keep
  the c1e7 cast's tokens in ~/.fok-server-livetest.tok via test/live-tok.js,
  never in the repo, never generated: what hello answers is adopted.
- HTTPS ONLY: `netOffline()` is forced on any page whose protocol is not
  https: (`_runInsecure`, js/game.js); NET_BASE and GAME_URL are https and
  smoke-ident.js refuses any `http://` literal in shipped sources; the live
  harnesses refuse a non-https base.

Guard: test/smoke-ident.js.
