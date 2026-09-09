# A client release note names the CONTRACT, never a server build

Say "needs server API 4.7". Never "needs FOK-server 1.6.1". The API minor is the
only thing this repo implements, declares (`NET_API_BUILT_MINOR`) and can check;
the server's own patch digit is invisible to the client and irrelevant to it.

**Why:** naming a build is a false claim -- it reads as "the previous patch will
not work", when the client cannot tell those patches apart at all. It also goes
stale the first time the server patches, and nobody returns to correct a shipped
release note. Concrete case: a 4.2.0 note said "FOK-server 1.6.1" while the
local notes said 1.6.0, and neither number could be checked from this repo.

**How to apply:** if a fact cannot be verified from this repo, it does not go in
this repo's release note, commit message or README. Same family as
project_fok_pacing.md's rule -- read it from the CONTRACT, not off the wire.
Recording a client-and-server pairing in a scratch note is different: that is an
observation with a date on it, not a requirement shipped to players.
