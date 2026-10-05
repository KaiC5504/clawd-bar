import * as fontkit from 'fontkit'

// Text as glyph outlines rather than a font, so the art looks the same on every
// machine and ships no font file. Cascadia Mono (Windows) is the terminal's
// look; Segoe UI Symbol fills the few glyphs it lacks (⎇ ↻ ✗).
const FONTS = 'C:/Windows/Fonts'
const mono = fontkit.openSync(`${FONTS}/CascadiaMono.ttf`)
const weights = { 400: mono.getVariation({ wght: 400 }), 700: mono.getVariation({ wght: 700 }) }
const symbols = fontkit.openSync(`${FONTS}/seguisym.ttf`)

export function glyphs(size) {
  const cell = (mono.layout('M').glyphs[0].advanceWidth / mono.unitsPerEm) * size
  const defs = new Map()

  const id = (ch, bold) => {
    const cp = ch.codePointAt(0)
    const key = `${bold ? 'b' : 'r'}${cp.toString(16)}`
    if (!defs.has(key)) {
      const isMono = mono.hasGlyphForCodePoint(cp)
      const font = isMono ? weights[bold ? 700 : 400] : symbols
      const glyph = font.glyphForCodePoint(cp)
      const s = size / font.unitsPerEm
      // A fallback glyph is centred in the cell it borrows.
      const dx = isMono ? 0 : (cell - glyph.advanceWidth * s) / 2
      const d = glyph.path.scale(s, -s).translate(dx, 0).toSVG()
      defs.set(key, d ? `<path id="${key}" d="${d}"/>` : '')
    }
    return defs.get(key) ? key : null
  }

  return {
    cell,
    // One run of text from a column on a baseline: a <use> per glyph.
    run(text, x, baseline, bold = false) {
      let out = ''
      ;[...text].forEach((ch, i) => {
        const key = ch.trim() ? id(ch, bold) : null
        if (key) out += `<use href="#${key}" x="${+(x + i * cell).toFixed(2)}" y="${+baseline.toFixed(2)}"/>`
      })
      return out
    },
    defs: () => [...defs.values()].join(''),
  }
}
