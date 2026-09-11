# The server contract: name it, build against it, never rename it

## Release notes name the CONTRACT, never a server build
Say "needs server API 4.7", never "needs FOK-server 1.6.1". The API minor is
the only thing this repo implements, declares (`NET_API_BUILT_MINOR`) and can
check; a server patch number cannot be verified from here and goes stale. A
client-and-server pairing may be noted in a dated scratch note, never shipped.

## No backward-compatibility shims
Build against the contract as it WILL be. Client and server deploy as a pair,
so a fallback for an older server is dead code: no fallback constants,
version-keyed cadences or "older server" branches. If deploy ORDER could bite,
say so in one line and let the user decide. Feature-detecting an optional
FIELD is right; standing a local value in for one the contract states is not.

## A rename never touches a wire word
The server's vocabulary is not ours: signal types (`Signals::TYPES` in
FOK-server), tournament event names (docs/API.md Events table), request
actions and fields, localStorage keys. Screen phases, labels and functions
rename freely; a string the wire or the disk carries does not.
- Before a rename lands, list every string literal the diff changed
  (`git show <sha> -- js/ | grep -o "'[a-zA-Z][a-zA-Z0-9 :_.-]*'" | sort | uniq -c`)
  and check each non-phase, non-label one against the server.
- A suite speaks the server's names. A simulated server in a suite
  (tourney-world.js, the signal bus in net-handshake.js) is a copy of the
  CONTRACT; renaming it with the client is how a wire break passes.
- A wire word lives in ONE place per direction: the dispatcher's `case` and
  the sender's literal; grep both when either moves.
