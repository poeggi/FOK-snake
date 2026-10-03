# FOK-snake: repo, constraints, versioning

Browser snake game, plain JS, no bundler, no deps. GitHub Pages serves main
(https://poeggi.github.io/FOK-snake/) on every push. Release history is git.

## Module layout (ONE shared global scope, load order matters)
assets -> audio -> sim -> storage -> game -> text -> render -> screens -> input,
plus the net/duel modules; js/sim-worker.js runs in the Worker.
- assets.js all static data; audio.js `Snd`; sim.js the headless
  deterministic core (seeded mulberry32, side effects via emit() ->
  game.js drainSimEvents()); storage.js all persistence; game.js app core,
  main loop, worker bridge, economy; render.js + screens.js draw only;
  input.js all input. test/box-odds.js guards the box house edge.
- Netcode: net.js, net-api.js, net-rtc.js, net-session.js, net-spec.js,
  duel-core.js, tourney.js, events.js, items.js, hmac.js.

## Constraints
- ASCII only.
- Compat floor Chrome 55 / Safari 11 / Firefox 52 (async/await, no build
  step). No `??`, no spread, no bare `catch{}`. No grid fallbacks for
  Chromium 55/56, no Tizen keyCode 10009.
- Audio: never change js/audio.js or the audio call sites in js/game.js on
  your own initiative, not even one-liners. Show the exact diff and what it
  changes; implement only after explicit approval.

## CSP: nothing inline
index.html and every module stay clear of what a strict CSP blocks: no inline
`<script>`, no inline event handlers, no `style=` / `<style>` /
`setAttribute('style')`, no eval / new Function / string setTimeout, no
`javascript:` URLs, no `data:` URIs. A blocked inline script fails SILENTLY.
A runtime decision in the page shell goes into a module under js/. The API
origin gets `dns-prefetch`, never a `preconnect` (the OFFLINE setting could
not refuse it without an inline script).

Policy the code satisfies (index.html carries it as a `<meta>`; Pages sends
no CSP header, so frame-ancestors / sandbox / report-uri do not apply):

    default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self';
    font-src 'self'; worker-src 'self'; manifest-src 'self';
    connect-src 'self' https://fok-server.poggensee.it;
    base-uri 'none'; object-src 'none'; form-action 'none'

`blob:` needs no directive (createObjectURL feeds a download and a share sheet
only). CSP does not cover WebRTC; never set Chrome's `webrtc` directive.

## Versioning: the pre-commit hook owns it
- `.githooks/pre-commit` (`core.hooksPath=.githooks`, needs Git Bash on
  Windows) runs the FAST checks, then stamps APP_VERSION into js/assets.js
  and rewrites sw.js (AUTO-MANAGED header, `// version` comment, `const
  CACHE`, `const ASSETS` = path -> first 12 hex of the STAGED blob id, from
  `git ls-files -s` js/css/json/svg/woff2/woff/ttf minus sw.js and
  ^(test/|.github/|deprecated/), './' = index.html), and stages both.
  test/check-sw.js verifies the three stamps agree and every id matches.
- NEVER hand-edit sw.js or any version string. An asset is in ASSETS only
  if tracked/staged.
- Version `snake-vMAJOR.MINOR.PATCH`: MAJOR.MINOR from the latest `v[0-9]*`
  tag; PATCH auto-increments and resets to 0 when MAJOR.MINOR changes vs
  sw.js. The game reads its version at runtime from the cache key.
  APP_VERSION carries a leading `v` on the wire.
- Bump MINOR: annotated tag `vX.Y.0` -> commit (hook resets PATCH) ->
  `git tag -f vX.Y.0 HEAD` -> push branch + tag. Squash into X.Y.0: restore
  the base stamps (`git checkout <base> -- sw.js js/assets.js`), put the
  annotated tag on the base commit BEFORE committing, `git tag -fa` after.
- Version tests pin the FORMAT of APP_VERSION (optional v, its major),
  never a number: the hook rewrites the number after the checks run.

## THE VERSION GATE
Clients matchmake on MAJOR.MINOR only, so patches interop. ANY sim rule change
(one two clients can DISAGREE about mid-match: movement, collision, spawn,
scoring maths) MUST bump MINOR, or old and new clients silently desync. A
change that only alters emitted side effects (achievement thresholds,
cosmetics) does not. Regoldening sim-events is no evidence a minor is owed;
regoldening sim-determinism is.

A sim change shipped as a patch is the user's call: state the cost once, then
ship it. Never retag an existing release.

## Service worker (sw.js): the cached bundle IS the app
- Cache-first from this version's cache, on any link; the network never
  answers a running version's request (a miss = eviction, backfilled; a URL
  outside the bundle passes through; API traffic is never touched).
- The network only delivers the NEXT version: the update check on sw.js
  (`updateViaCache:'none'`, fired at script start on a controlled page) finds
  a new CACHE name; install copies every asset whose blob id is unchanged,
  fetches only the rest (`no-store`, six in flight, each stored as it lands,
  the manifest last as the completion mark), deletes the cache on any failure
  or an assets.js without CACHE's APP_VERSION, then skipWaiting -> activate
  -> old caches deleted -> one auto-reload on the splash.
- Genuine network Responses are stored, never re-wrapped.
- NEVER a per-request network-first race: the worker's serial script loads
  would trip the 3 s first-frame watchdog on a slow link.
- Guard: test/sw-cache.js.

## Rendering and perf (decided, do not reopen)
- LG OLED TV: the canvas plane is 50 Hz; target a steady 50, only dips below
  are load. Canvas-source drawImage is slow there even 1:1; live primitive
  drawing beats sprite/text blits; only opaque full-canvas background/menu
  blits are fast. Main ctx is `getContext('2d',{alpha:false})`. Dip levers:
  blur radii, glow off in events.
- Keep: batched saveCfg thunk; SIMPLE gfx paints black under dialogs instead
  of the self-blur; the spectator fan-out serializes once (_spEnv/_spFan); no
  netNetsRefresh mid-match.
- Leave as is: the one FIFO HTTP gate, full-canvas blur under dialogs,
  shadowBlur/glow, bracket anims every frame, the rollback spike, iOS QR
  decode on main, the seek interval, the script/sw race, the worker seam,
  touch listeners, getStats, sim allocs, the profiler's qrDecodeImage
  `<< watch` line.
