# On-demand test modes run only when asked; long runs go to the background

A change owes FAST (the pre-commit hook runs it) and `--full`. Report those.
NEVER start `--live`, `--netprofile`, `--profile`, `--tourney` or
`--tourney-sim` on my own: 15-25 minutes, and `--live` hits the live server
under the fixed test ids. Asked "did everything pass?", say which tiers ran
and that the on-demand round has not.

When asked: always in the background, one script running the modes in order,
START/PASS/FAIL lines on stdout, one log per mode, never stopping on a
failure. Watch with a Monitor on the marker lines and relay a short status as
each mode lands. `--tourney-sim` alone takes 6-15 min and prints only at the
end; a foreground run looks like a hang and the Bash timeout kills it. Never
pipe checks.sh through tail.
