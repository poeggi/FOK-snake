# Live-test harnesses: one fixed id set, marked names

Any harness that hits a LIVE server uses ONE hard-coded id set, reused every
run, never generated ids: `1111c1e7` (LIVETEST-A), `2222c1e7` (LIVETEST-B),
`3333c1e7` (LIVETEST-GH, the stale/ghost seeker). Declare them once at the
top with a comment saying not to generate new ones. Make server-side setup
idempotent (check `friend.php action=list` before `request`; a repeat request
feeds the anti-enumeration throttle).

Every virtual user on a live instance is named `clnt-CI-<four hex>`, built
from the id (`'clnt-CI-' + id.slice(0, 4)`, or `.slice(-4)` where that half
differs), so an operator can spot and triage a test row. The marker goes in
the NAME; ids stay what the protocol requires.
