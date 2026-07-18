// ============================================================================
// text.js -- canvas TYPOGRAPHY: the named font-size scale (FONT) and text-glow
// scale (GLOW), both read from css/fonts.css (:root --fs-* / --glow-*) so sizes
// and glow radii have ONE source of truth, plus the text draw helpers ct()/ctg().
// Glow COLOUR always follows the text colour -- callers keep full colour freedom;
// only sizes and radii are standardized. Text is always drawn LIVE (never cached
// to sprites: canvas-source blits measured slower than live draws on the LG TV).
// Loaded after game.js (which creates ctx), before render.js/screens.js.
// ============================================================================
const [FONT, GLOW] = (() => {
    let rt = null; try { rt = getComputedStyle(document.documentElement); } catch(_) {}
    const v = (n, def) => { try { return parseInt(rt.getPropertyValue(n)) || def; } catch(_) { return def; } };
    return [
        { DISPLAY: v('--fs-display',40), JUMBO: v('--fs-jumbo',26), TITLE: v('--fs-title',18), MENU: v('--fs-menu',14), HINT: v('--fs-hint',10) },
        { FAINT: v('--glow-faint',1), TEXT: v('--glow-text',12), TITLE: v('--glow-title',16), BIG: v('--glow-big',24), HERO: v('--glow-hero',38) },
    ];
})();
// Centered text, no glow.
function ct(text,x,y,color,size,c=ctx) {
    c.fillStyle=color||'#7fff7f';
    c.font=`${size||FONT.HINT}px "Press Start 2P"`;
    c.textAlign='center'; c.textBaseline='middle'; c.fillText(text,x,y);
}
// Centered GLOWING text: glow colour = text colour, radius from the GLOW scale.
// (cfg.disableGlow is honoured globally by the shadowBlur setter guard in render.js.)
function ctg(text,x,y,color,size,glow,c=ctx) {
    c.shadowColor=color||'#7fff7f'; c.shadowBlur=glow;
    ct(text,x,y,color,size,c);
    c.shadowBlur=0;
}
