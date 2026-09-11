# UI: layout, smooth snake, PWA, ringtone egg

## Responsive layout (game.js `layout()`)
Native canvas 600x400, CSS-scaled. `layout()` measures `#wrap` and sizes the
canvas to the largest 600:400 box that fits: `scale = min((wW-2m)/CW,
(wH-2m)/CH, CANVAS_MAX_H/CH)`, CANVAS_MAX_H=1600, margin
`m = clamp(round(min(wW,wH)*0.02),4,48)`, wH clamped to
`min(wrap.clientHeight, vpH - wrapTop)`. Publishes `--ui-scale` and
`--stage-w`. Triggers: ResizeObserver on #wrap (guarded by `_lastCw`), window
resize, orientationchange burst, screen.orientation, initial rAF,
fonts.ready, load.
- COLUMN mode (desktop + portrait touch): fits into viewportWidth x
  (viewportHeight - measured chromeH), #wrap `flex:0 0 auto`; desktop
  centres, portrait bottom-aligns. LANDSCAPE touch: #wrap `flex:1 1 0`
  between side panels. `_lsq`/`_pmq` matchMedia detect. chromeH uses
  offsetHeight so the canvas is stable menu<->game; SND/FPS fade via opacity.
- No ResizeObserver fallback (Safari 11): accepted. The only miss is the
  util-hidden SCORE/lives swap on duel entry; cosmetic. Do not add a _reflow.
- DEBUG MODE: cfg.debug 0-3 (`#debug` URL or save edit); red splash banner;
  hidden DEBUGGING settings category (canvas props overlay, export canvas
  info, MAKE ME RICH, worst-frame recorder LOW-FPS RECORD / EXPORT FPS LOG).

## SMOOTH SNAKE (cfg.smoothMotion 0 OFF / 1 LOW LATENCY 50 ms / 2 HIGH 100 ms)
Render-side only, in js/render.js (_smFrac/_smSub/_smTrack/_smSegs/
_smDuelSegs): reads sim state, judges nothing, no rng, never hashed, nothing
on the wire. Do not move any of it into sim.js. The fraction comes off the
sim's own step counters (_gDue, step accumulator, gPer) plus the sub-tick
frame remainder, so it is back at 0 exactly when the step lands.
Latency-capped: the ramp completes 3 (or 6) ticks after the step, then holds.
Smoothstep where the cap binds, linear where the ramp spans the period. Every
segment slides; pixel-snapped; a jump over one cell (wrap, fresh snake) does
not slide; runs only in playing/duel with the snake alive. Tests in
smoke-game.js. Rejected: wall-clock timestamps, full-period slide,
head-and-tail-only.

## PWA install
- apple-touch-icon points at icon.svg and works on real iOS. Do not swap to PNG.
- manifest.json has NO orientation key (landscape is supported). Do not lock.
- Android link capture is automatic via WebAPK scope; a custom scheme was
  rejected. iOS has no link capture and isolated home-screen storage;
  fallback is manual friend-code entry.

## Ringtone easter egg (closed)
Long-press egg in js/input.js hands over docs/snake-theme.m4r (5.000 s) /
docs/snake-theme-classic.m4r (6.000 s), rendered by test/render-theme.js from
the same SEQ table js/audio.js plays, one seamless loop. Both routes are
device-verified (iOS navigator.share -> Files; Android blob download .m4a).
Re-encoding needs `-f ipod`; .m4r and .m4a are the same file.
