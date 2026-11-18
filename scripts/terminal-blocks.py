"""Makes the faces that draw the terminal's block and line characters at line heights above 1.0.

A terminal row taller than the font leaves a gap above and below every block, bar and box line, since the font draws
them for its own height. xterm.js draws those characters as shapes only in its WebGL renderer, which the app does not
use, so they stay text: for each line height Settings offers above 1.0 this writes ui/src/fonts/blocks-<height>.woff2,
Hack's own glyphs for U+2500 to U+259F (box drawing and block elements) stretched upright about the middle of the row
by that height and 3 % more, so they reach the row's edges at any size (a row clips what is beyond it). Halves stay
halves, eighths stay eighths of the row, lines keep their places and meet across rows. fonts.css gives each face that
range only; appearance.ts puts the one for the chosen height first.

usage: python3 scripts/terminal-blocks.py   (needs fontTools and brotli)
"""
from pathlib import Path
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

fonts = Path(__file__).resolve().parent.parent / 'ui/src/fonts'
for height in (110, 120, 130):
    font = TTFont(fonts / 'hack-regular.woff2')
    options = Options()
    options.hinting = False
    options.layout_features = []
    options.name_IDs = [1, 2]
    options.notdef_outline = False
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=range(0x2500, 0x25A0))
    subsetter.subset(font)
    # The middle of a row is the middle of the font's own ascent and descent, which the row is centred on.
    middle = (font['hhea'].ascent + font['hhea'].descent) / 2
    by = 1.03 * height / 100
    glyphs = font['glyf']
    for name in font.getGlyphOrder():
        glyph = glyphs[name]
        if glyph.isComposite():
            for part in glyph.components:
                part.y = round(part.y * by)
        elif glyph.numberOfContours > 0:
            glyph.coordinates = type(glyph.coordinates)([(x, round(middle + (y - middle) * by)) for x, y in glyph.coordinates])
        glyph.recalcBounds(glyphs)
    font.flavor = 'woff2'
    out = fonts / f'blocks-{height}.woff2'
    font.save(out)
    print(out.name, out.stat().st_size, 'bytes,', len(font.getGlyphOrder()), 'glyphs')
