# Live-instance test users are named srv-CI-xxxx

Tests that run against a live instance must name every virtual user/player they create or reuse `srv-CI-<something>` (e.g. `srv-CI-alice`), so an operator looking at real data can tell test rows from real ones at a glance.

Rationale: live test data sits next to real users; an unrecognizable name cannot be triaged or cleaned up safely.

How to apply: put the marker in the NAME field. Ids stay whatever the protocol requires -- server player ids are 8 hex chars and keep the fixed set from feedback_live_test_fixed_ids.md -- the name is what carries the label.
