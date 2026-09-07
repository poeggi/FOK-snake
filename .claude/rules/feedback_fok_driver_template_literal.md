# Suite driver bodies are JS template literals

The suite bodies in `test/smoke-net.js`, `test/net-handshake.js`, `test/tourney-world.js` and their siblings are inserted into a JS TEMPLATE LITERAL before being evaluated. Two things do not survive insertion:

- a backtick anywhere in the inserted body (including inside a comment) ends the literal early -- `SyntaxError: missing ) after argument list`;
- a BACKSLASH ESCAPE is eaten by the literal. A `\d` class arrives as a literal `d` and matches the letter; `poll\.php` arrives as `poll.php`. Neither is a syntax error, so the test silently tests nothing.

The second failure mode is expensive: a helper can appear to run, return its input unchanged, and the assertion it feeds passes for the wrong reason.

Rules: in inserted suite bodies write `[0-9]` instead of a `\d` class and `[.]` instead of an escaped dot, and use quotes, never backticks. When an inserted helper "does nothing", print its output before suspecting its logic.
