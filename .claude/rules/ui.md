# UI: sizes, rows, layout, smooth snake, PWA

## Text sizes come from the FONT.* scale, never raw px
One scale in `css/fonts.css` `:root`: `--fs-display`, `--fs-jumbo`,
`--fs-title`, `--fs-menu`, `--fs-hint`.
- Canvas text (`ct(text,x,y,color,SIZE)`, any `ctx.font`): `FONT.DISPLAY /
  JUMBO / TITLE / MENU / HINT` (js/text.js reads the CSS vars at startup,
  with fallbacks for headless tests). Never a bare number.
- Roles: DISPLAY logo/final score; JUMBO big overlays + epic/gouranga bonus;
  TITLE screen headings; MENU menu items/HUD/prompts; HINT hints/body/FPS/
  buttons.
- DOM chrome (HUD, #fps-el, .sbtn) is CSS `calc(var(--fs-*) *
  var(--ui-scale))`, `--ui-scale = canvasWidth/600`.
- A size changes in its `--fs-*` value only. A new tier = a var plus a
  `FONT.*` entry with fallback.

## Rows come from the --ui-* scale, one painter each, never a number
`css/style.css` `:root` `--ui-*`, read once into `UI.*` (js/assets.js).
- A row has ONE painter owning its font, glow and default colour:
  `drawTitle` (every screen headline), `drawSubhead` (the one line under it),
  `drawDialogTitle` (a modal), `drawOverlayTitle` (an in-game overlay, a
  wall's blank face), `menuItem`, `drawStatus`. A screen passes text and, for
  an accent, a colour; never the y, the font or the glow. `BODY_Y` is the
  first body line under the subhead, a constant, no painter.
- test/check-layout.js (FAST) refuses a FONT.TITLE draw on a numbered row
  outside the painters and centred text on a scale row as a number.
  Title-sized CONTENT (a code, a name) marks its line `layout-ok: <why>`.
- A new class of content = one `--ui-*` var, one `UI.*` entry with fallback,
  one painter, its number in the check's ROWS.

## Responsive layout (game.js `layout()`)
- Native canvas 600x400, CSS-scaled to the largest 600:400 box in `#wrap`
  (capped at CANVAS_MAX_H). Publishes `--ui-scale` and `--stage-w`.
- Triggers: ResizeObserver on the document root, #wrap and chrome (guarded
  by `_lastCw`), window resize, screen.orientation, initial rAF,
  fonts.ready. No startup orientation gate, forced double passes or timed
  retries. No ResizeObserver fallback for Safari 11; no _reflow.
- COLUMN mode (desktop + portrait touch): viewportWidth x (viewportHeight -
  measured chromeH), #wrap `flex:0 0 auto`; desktop centres, portrait
  bottom-aligns. LANDSCAPE touch: #wrap `flex:1 1 0` between side panels.
  `_lsq`/`_pmq` matchMedia detect. chromeH uses offsetHeight so the canvas is
  stable menu<->game; SND/FPS fade via opacity.

## SMOOTH SNAKE (cfg.smoothMotion 0 OFF / 1 LOW LATENCY 50 ms / 2 HIGH 100 ms)
- Render-side only, in js/render.js (_smFrac/_smSub/_smTrack/_smSegs/
  _smDuelSegs): reads sim state, judges nothing, no rng, never hashed,
  nothing on the wire. Never move any of it into sim.js.
- The fraction comes off the sim's own step counters (_gDue, step
  accumulator, gPer) plus the sub-tick frame remainder, so it is 0 exactly
  when the step lands. Latency-capped: the ramp completes 3 (or 6) ticks
  after the step, then holds. Smoothstep where the cap binds, linear where
  the ramp spans the period. Every segment slides, pixel-snapped; a jump over
  one cell (wrap, fresh snake) does not slide; only in playing/duel with the
  snake alive. Tests in smoke-game.js.
- Rejected: wall-clock timestamps, full-period slide, head-and-tail-only.

## PWA
- apple-touch-icon points at icon.svg; never a PNG.
- manifest.json has NO orientation key (landscape is supported).
- Android link capture is the WebAPK scope; no custom scheme. iOS has no link
  capture and isolated home-screen storage; the fallback is manual
  friend-code entry.

## Ringtone easter egg
docs/snake-theme*.m4r are rendered by test/render-theme.js from the SEQ table
js/audio.js plays, one seamless loop. Re-encoding needs `-f ipod`; .m4r and
.m4a are the same file.
