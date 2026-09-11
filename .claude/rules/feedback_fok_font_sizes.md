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
