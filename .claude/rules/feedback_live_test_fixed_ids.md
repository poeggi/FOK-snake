# Live-server test harnesses reuse ONE fixed id set

Any harness that hits a LIVE server must use ONE defined, hard-coded set of test ids reused across every run -- never `randomBytes`/generated ids per run per scenario.

Fixed server-side cast: `11117e57` (LIVETEST-A), `22227e57` (LIVETEST-B), `33337e57` (LIVETEST-GH, the stale/ghost seeker).

Rationale: random ids leave a growing pile of throwaway rows in the live player table that must be cleaned up by hand. A fixed cast keeps the residue a bounded, known set.

How to apply: declare the ids once at the top of the harness with a comment saying not to generate them again; make any setup with server-side side effects idempotent, because a second run finds the state already there -- e.g. check `friend.php action=list` for an accepted friendship before sending `request`, or the repeat `request` just feeds the per-id anti-enumeration throttle.
