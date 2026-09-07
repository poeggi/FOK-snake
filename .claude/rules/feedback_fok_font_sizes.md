# Text sizes come from the named FONT.* scale, never raw px

NEVER pick an arbitrary px font size. There is one named scale, declared once in `css/fonts.css` `:root`:
`--fs-display:40 --fs-jumbo:26 --fs-title:18 --fs-menu:14 --fs-hint:10` (px).

Rationale: single source of truth; the scale replaced a pile of one-off sizes (8/9/11/12/32).

How to apply:
- Canvas text (game.js `ct(text,x,y,color,SIZE)` and any `ctx.font`): use the JS `FONT` object -- `FONT.DISPLAY / JUMBO / TITLE / MENU / HINT`. Never a bare number. `FONT` is read from the CSS `--fs-*` vars at startup (with hardcoded fallbacks for the headless tests).
- Roles: DISPLAY=logo/final score, JUMBO=big overlays (WIN/OVER/GO/PAUSED) + epic/gouranga bonus, TITLE=screen headings, MENU=menu items/HUD/prompts, HINT=hints/body/FPS/buttons.
- DOM chrome (HUD, #fps-el, .sbtn) is CSS-styled with `calc(var(--fs-*) * var(--ui-scale))`; `--ui-scale = canvasWidth/600` so chrome scales with the CSS-upscaled canvas exactly like canvas text.
- To change a size: edit the `--fs-*` value in fonts.css once. To add a tier: add a `--fs-*` var + a `FONT.*` entry (with fallback). See project_fok_snake.md.
