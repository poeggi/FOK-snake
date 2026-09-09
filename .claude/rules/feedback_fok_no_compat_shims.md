# No backward-compatibility shims for the server contract

Build against the contract as it WILL be, not as it was. Client and server are
deployed as a pair, so a fallback for an older server is dead code the moment
the pair is live.

Concrete case: a version-keyed heartbeat (30 s against a 4.4 server, 60 s from
4.5) shipped because the contract text named both cadences. It was removed --
the client beats 60 s, full stop.

**Why:** the same repo history says it already ("the 2.6 protocol kept no 2.5
interop"). A shim doubles the paths a bug can hide in and never earns it.

**How to apply:** do not add fallback constants, version-keyed cadences or
"older server" branches unprompted. If the DEPLOY ORDER could bite, say so in
one line and let the user decide. Feature-detecting an optional FIELD stays
right (project_fok_pacing.md asks for it); standing a local value in for one
the contract states, or keeping a whole legacy BEHAVIOUR, does not.

Related: project_fok_pacing.md.
