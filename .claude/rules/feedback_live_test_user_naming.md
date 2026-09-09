# Live-test user naming

Every virtual user/player a test creates or reuses on a LIVE instance is named
`clnt-CI-<four hex>` -- the marker plus the four hex digits that tell the fixed
ids apart (e.g. `clnt-CI-1111`). An operator looking at real data can then spot
a test row at a glance, and tell WHICH probe left it.

**Why:** live test data sits next to real users; an unrecognizable name cannot
be triaged or cleaned up safely. `clnt-` names the side that made the row --
this repo is the client.

**How to apply:** the marker goes in the NAME field. Ids stay whatever the
protocol requires - server player ids are 8 hex chars and come from the fixed
set in feedback_live_test_fixed_ids.md; the name is what carries the label.
Build it from the id rather than writing a literal, the way every harness here
already does: `'clnt-CI-' + id.slice(0, 4)` (peer-net.sh, items-live.js,
hello-live.js) or `.slice(-4)` where that is the half that differs (the tourney
harnesses, duel-driver.js, profile.js).

Related: [[feedback_live_test_fixed_ids]]
