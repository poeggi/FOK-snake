# Text sizes come from the named FONT.* scale, never raw px

One scale, declared once in `css/fonts.css` `:root`:
`--fs-display:40 --fs-jumbo:26 --fs-title:18 --fs-menu:14 --fs-hint:10`.

- Canvas text (`ct(text,x,y,color,SIZE)`, any `ctx.font`): use `FONT.DISPLAY /
  JUMBO / TITLE / MENU / HINT` (js/text.js reads the CSS vars at startup, with
  fallbacks for headless tests). Never a bare number.
- Roles: DISPLAY logo/final score; JUMBO big overlays + epic/gouranga bonus;
  TITLE screen headings; MENU menu items/HUD/prompts; HINT hints/body/FPS/buttons.
- DOM chrome (HUD, #fps-el, .sbtn) is CSS `calc(var(--fs-*) * var(--ui-scale))`,
  `--ui-scale = canvasWidth/600`.
- To change a size edit the `--fs-*` value once. To add a tier add a var plus a
  `FONT.*` entry with fallback.

# Rows come from the --ui-* scale, drawn by one painter each, never a number

`css/style.css` `:root`: `--ui-title-y 24`, `--ui-dialog-title-y 116`,
`--ui-overlay-title-y 182`, `--ui-menu-top 90`, `--ui-menu-row 28`,
`--ui-status-y 324`, `--ui-back-y 348`, `--ui-band-y 370`, `--ui-corner-y
382`, `--ui-hint-y 390`, read once into `UI.*` (js/assets.js).
- A row has ONE painter that owns its font, glow and default colour:
  `drawTitle` (every screen headline), `drawDialogTitle` (a modal),
  `drawOverlayTitle` (an in-game overlay, a wall's blank face), `menuItem`,
  `drawStatus`. A screen passes text and, if it is an accent, a colour;
  it never writes the y, the font or the glow.
- `test/check-layout.js` (FAST) refuses a FONT.TITLE draw on a numbered
  row outside the painters and centred text on a scale row as a number.
  Title-sized CONTENT (a code, a name) marks its line `layout-ok: <why>`.
- A new class of content = one `--ui-*` var, one `UI.*` entry with fallback,
  one painter, and its number added to the check's ROWS.
