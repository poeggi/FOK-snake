# A rename never touches a wire word

The server's vocabulary is not ours to rename: signal types (`Signals::TYPES`
in FOK-server), tournament event names (the `Events` table in docs/API.md),
request actions and fields, localStorage keys. A screen phase, a menu label or
a function may be renamed freely; a string the wire or the disk carries may
not, whatever it happens to be called next to.

**Why:** 0c3308f renamed the `lobby` screen to `duelLobby` and the `invite`
screen to `duelInvite` -- and swept the tournament's `lobby` EVENT and the
`invite` SIGNAL TYPE along with them, on both ends of the client. Both suites
were renamed with the code and went on passing against themselves (the
simulated server in tourney-world.js sent the renamed event). Shipped as 4.2.0:
no join, leave or abandon reached a tournament lobby, and every friend invite
was refused by the server's type whitelist. Found two releases later, by
reading the server.

**How to apply:**
- Before a rename lands, list every string literal the diff changed
  (`git show <sha> -- js/ | grep -o "'[a-zA-Z][a-zA-Z0-9 :_.-]*'" | sort | uniq -c`)
  and check each one that is not a phase or a label against the server:
  `Signals::TYPES`, the events table, the request table.
- A suite speaks the server's names, never the client's. A simulated server
  in a suite (tourney-world.js, the signal bus in net-handshake.js) is a copy
  of the CONTRACT; renaming it with the client is how a wire break passes.
- A wire word lives in ONE place per direction. The dispatcher's `case` and
  the sender's literal are the two ends of one string; grep both when either
  moves.

Related: feedback_fok_release_notes.md (the contract, not the build),
project_fok_pacing.md (feature-detect a field, never rename one).
