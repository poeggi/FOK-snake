# On-demand modes run only when asked; long runs go to the background

## What a change owes

FAST (the pre-commit hook runs it) and `--full`. Report those. NEVER start
`--live`, `--netprofile`, `--profile`, `--tourney` or `--tourney-sim` on my own
after a change -- the round takes 15-25 minutes and `--live` hits the live
server under the fixed test ids. That is the user's call, not an automatism.

Asked "did everything pass?", say which tiers ran and that the on-demand round
has not, then stop.

## Running them when asked

- ALWAYS in the background with one log per mode, never in the foreground.
  `--tourney-sim` alone takes 6-15 minutes and prints only at its end, so a
  foreground run looks like a hang and a default Bash timeout kills it
  (exit 124).
- One script running the modes in order, START/PASS/FAIL lines on stdout, one
  log file each, and it must NOT stop on a failure -- otherwise the first red
  mode hides the other four.
- Watch it with a Monitor on those marker lines and relay a short status as
  each mode lands. Do not sit silent until the completion notification.
- Never pipe checks.sh through tail (project_fok_snake.md says why).

Related: project_fok_ci_time.md, project_fok_snake.md.
