// A small canvas for Raster cells. Each terminal cell holds 2×2 pixels drawn
// with quadrant blocks, so a pixel is half a cell wide and half a cell tall.
// A cell can only show two colours (fg and bg), so art keeps colour edges on
// cell boundaries; anything else falls back to the cell's dominant colours.

export const DEFAULT_COLOR = 0x01000000
const QUAD = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'

export type Canvas = {
  cols: number
  rows: number
  px: (number | undefined)[]
  glyphs: Map<number, [codePoint: number, fg: number, bg: number]>
}

export function canvas(cols: number, rows: number): Canvas {
  return { cols, rows, px: new Array(cols * rows * 4), glyphs: new Map() }
}

export function dot(c: Canvas, x: number, y: number, color: number): void {
  if (x >= 0 && x < c.cols * 2 && y >= 0 && y < c.rows * 2) c.px[y * c.cols * 2 + x] = color
}

export function erase(c: Canvas, x: number, y: number): void {
  if (x >= 0 && x < c.cols * 2 && y >= 0 && y < c.rows * 2) c.px[y * c.cols * 2 + x] = undefined
}

export function rect(c: Canvas, x: number, y: number, w: number, h: number, color: number): void {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) dot(c, x + i, y + j, color)
}

export function dots(c: Canvas, at: readonly (readonly [number, number])[], color: number, dx = 0, dy = 0): void {
  for (const [x, y] of at) dot(c, x + dx, y + dy, color)
}

// A text character over a whole cell; it wins over any pixels there.
export function glyph(c: Canvas, col: number, row: number, char: string, fg = DEFAULT_COLOR, bg = DEFAULT_COLOR): void {
  if (col >= 0 && col < c.cols && row >= 0 && row < c.rows) c.glyphs.set(row * c.cols + col, [char.codePointAt(0) ?? 0x20, fg, bg])
}

const channel = (color: number, shift: number) => (color >> shift) & 255
const distance = (a: number, b: number) =>
  [16, 8, 0].reduce((sum, s) => sum + (channel(a, s) - channel(b, s)) ** 2, 0)

export function mix(a: number, b: number, k: number): number {
  return [16, 8, 0].reduce((out, s) => out | (Math.round(channel(a, s) * (1 - k) + channel(b, s) * k) << s), 0)
}

// Raster words: [codePoint, fg, bg] per cell, row by row.
export function pack(c: Canvas): Uint32Array {
  const width = c.cols * 2
  const words = new Uint32Array(c.cols * c.rows * 3)
  for (let row = 0; row < c.rows; row++) {
    for (let col = 0; col < c.cols; col++) {
      const at = row * c.cols + col
      const set = c.glyphs.get(at)
      if (set) {
        words.set(set, at * 3)
        continue
      }
      const top = 2 * row * width + 2 * col
      const quad = [c.px[top], c.px[top + 1], c.px[top + width], c.px[top + width + 1]]
      words.set(cell(quad), at * 3)
    }
  }
  return words
}

function cell(quad: (number | undefined)[]): [number, number, number] {
  const counts = new Map<number, number>()
  for (const q of quad) if (q !== undefined) counts.set(q, (counts.get(q) ?? 0) + 1)
  if (counts.size === 0) return [0x20, DEFAULT_COLOR, DEFAULT_COLOR]
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([color]) => color)
  const major = ranked[0]!
  const isFull = !quad.includes(undefined)
  if (counts.size === 1 || !isFull) {
    // With empty pixels the background must stay the terminal's, so one colour is all we get.
    const mask = quad.reduce<number>((m, q, k) => (q !== undefined ? m | (1 << k) : m), 0)
    return [QUAD.codePointAt(mask)!, major, DEFAULT_COLOR]
  }
  const minor = ranked[1]!
  const mask = quad.reduce<number>((m, q, k) => (q !== major && distance(q!, minor) <= distance(q!, major) ? m | (1 << k) : m), 0)
  return [QUAD.codePointAt(mask)!, minor, major]
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? BASE64[n & 63]! : '='
  }
  return out
}

export const encode = (c: Canvas) => base64(new Uint8Array(pack(c).buffer))
