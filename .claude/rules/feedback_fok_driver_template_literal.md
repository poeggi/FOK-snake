# Suite driver bodies are JS template literals

The suite bodies in `test/smoke-net.js`, `test/net-handshake.js`,
`test/tourney-world.js` and siblings are inserted into a JS template literal
before evaluation. A backtick anywhere in the body (comments included) ends
the literal early. A backslash escape is eaten: `\d` arrives as `d`,
`poll\.php` as `poll.php`; no error, the test silently tests nothing.

Rules: write `[0-9]` instead of `\d`, `[.]` instead of an escaped dot, quotes
never backticks. When an inserted helper "does nothing", print its output
before suspecting its logic.
