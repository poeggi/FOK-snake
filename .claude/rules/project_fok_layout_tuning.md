# Responsive-layout architecture

Two rules govern the layout: R1 fit, R2 maximize on the binding axis. See project_fok_snake.md and feedback_fok_font_sizes.md.

## Architecture
`layout()` branches by mode: COLUMN (desktop + portrait-touch) fits the canvas into `viewportWidth x (viewportHeight - measured chromeH)` and #wrap `flex:0 0 auto` shrink-wraps it, so the body groups [HUD+SND/FPS+canvas+gamepad] and centres (desktop) / bottom-aligns (portrait, `justify-content:flex-end`) -- the SND/FPS bar hugs the canvas. LANDSCAPE-touch keeps #wrap `flex:1 1 0` and fits into the flex region between side panels. Detect via `_lsq`=matchMedia('(pointer:coarse) and (orientation:landscape)') and `_pmq`=portrait. chromeH uses offsetHeight (display:none=0, opacity:0 keeps height) so canvas size is stable menu<->game. SND/FPS fade in via opacity (not visibility) to avoid a first-paint border glitch on mobile.

DEBUG MODE: cfg.debug (0-3, in the save file). `#debug` URL or save-edit enables; splash banner shows "DEBUG MODE" (red). Hidden DEBUGGING settings category (guarded entry via _debugEntered) with SHOW CANVAS PROPS overlay, EXPORT CANVAS INFO, MAKE ME RICH, and the Worst-Frame Recorder (LOW-FPS RECORD -> worst/max FPS + context snapshot, EXPORT FPS LOG) -- use it for TV framerate investigations. Legacy-browser parse fixes are in (?? , spread, bare catch{} removed -> floor ~Chromium 49 for parsing).

## Mechanics
- Native canvas 600x400 (CW x CH). CSS-scaled to display size.
- `#wrap` is `flex:1; align-self:stretch` = the region the shown chrome leaves (gamepad is display:none on non-touch, so it frees its space automatically).
- JS `layout()` (game.js, replaced the old syncFontScale): measures `#wrap`, sizes the canvas to the largest 600:400 box that fits -- `scale = min((wW-2m)/CW, (wH-2m)/CH, CANVAS_MAX_H/CH)`. wH is clamped to `min(wrap.clientHeight, vpH - wrapTop)` to avoid bottom overflow on wide/short windows. Publishes `--ui-scale` (chrome fonts/boxes = `round(calc(var(--fs-*) * var(--ui-scale)),1px)`) and `--stage-w` (HUD width). Observed by a ResizeObserver on `#wrap`, guarded by `_lastCw` to stop RO feedback loops.
- `CANVAS_MAX_H = 1600` (=4x native) caps big screens. Adaptive margin `m = clamp(round(min(wW,wH)*0.02),4,48)`. Body has `padding-top: round(calc(8px*--ui-scale),1px)` for HUD breathing room (overridden to 0 in landscape).
- CSS magic (`*1.5` aspect, 600px/800px caps) is all DELETED; aspect is implicit in the JS fit.

Earlier pending UI bugs (iPhone-landscape excess margin, #debug overlay in the installed PWA, tablet FPS/mute overflow) are all CLOSED.

## Do NOT reopen
- ResizeObserver fallback: decided against ("good enough"). game.js guards with `if (window.ResizeObserver)` and there is no equivalent for Safari 11. That is ACCEPTED. layout() still has five other triggers (window resize, orientationchange burst, screen.orientation, initial rAF, fonts.ready, load), so only a #wrap box change with NO window resize is missed -- in practice just the render.js util-hidden SCORE/lives swap on duel entry. Cosmetic, and the next resize or rotation corrects it. Do not add a _reflow call at that toggle site.
