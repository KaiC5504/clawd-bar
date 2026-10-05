import { DEFAULT_COLOR } from './pixels'
import { COLS, GLOWING, ROWS, frameAt, svgLoopMs } from './scenes'
import type { Extras, Scene } from './scenes'
import type { Canvas } from './pixels'

// The desktop draws the terminal's frames as one SVG per scene: one path per
// colour whose outline cuts to each frame's shape (step-end, never tweened).
// Only what changes gets keyframes, so the file grows with how much moves, not
// how long the loop runs: the whole block game fits under the Svg size cap. A
// colour drawn as a single shape also never shows seams inside itself when the
// desktop scales by a fraction.
//
// A pixel is 1×2 user units, the shape it has in a terminal cell.
const SAMPLE_MS = 5
export const SVG_MAX_CHARS = 131_072

const W = COLS * 2
const H = ROWS * 2
const VIEW_H = H * 2

type Track<T> = [t: number, value: T][]
type Rect = { x: number; y: number; w: number; h: number; color: number }

const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// White-ish props (planes, paper, the flag) vanish on a light theme; those get an outline there.
function isPale(color: number): boolean {
  const [r, g, b] = [(color >> 16) & 255, (color >> 8) & 255, color & 255]
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return luma > 0.7 && (Math.max(r, g, b) - Math.min(r, g, b)) / 255 < 0.2
}

function record<K, T>(tracks: Map<K, Track<T>>, key: K, t: number, value: T, empty: T): void {
  const track = tracks.get(key)
  if (!track) {
    if (value !== empty) tracks.set(key, t === 0 ? [[0, value]] : [[0, empty], [t, value]])
  } else if (track.at(-1)![1] !== value) track.push([t, value])
}

// Each colour's pixels as rectangles: runs along a row, stacked while the rows below match.
function outlines(px: (number | undefined)[]): Map<number, string> {
  const open = new Map<string, Rect>()
  const done: Rect[] = []
  for (let y = 0; y < H; y++) {
    const seen = new Set<string>()
    for (let x = 0; x < W; ) {
      const color = px[y * W + x]
      let end = x + 1
      while (end < W && px[y * W + end] === color) end++
      if (color !== undefined) {
        const key = `${x}:${end - x}:${color}`
        const rect = open.get(key)
        if (rect) rect.h++
        else open.set(key, { x, y, w: end - x, h: 1, color })
        seen.add(key)
      }
      x = end
    }
    for (const [key, rect] of open) {
      if (!seen.has(key)) {
        done.push(rect)
        open.delete(key)
      }
    }
  }
  done.push(...open.values())
  const paths = new Map<number, string>()
  for (const { x, y, w, h, color } of done.sort((a, b) => a.y - b.y || a.x - b.x)) {
    paths.set(color, `${paths.get(color) ?? ''}M${x} ${y * 2}h${w}v${h * 2}h-${w}z`)
  }
  return paths
}

function sample(frame: (t: number) => Canvas, total: number) {
  const shapes = new Map<number, Track<string>>()
  const glyphs = new Map<string, Track<boolean>>()
  let drawn = new Set<number>()
  let shown = new Set<string>()
  for (let t = 0; t < total; t += SAMPLE_MS) {
    const c = frame(t)
    const paths = outlines(c.px)
    for (const color of new Set([...drawn, ...paths.keys()])) record(shapes, color, t, paths.get(color) ?? '', '')
    drawn = new Set(paths.keys())
    const now = new Set([...c.glyphs].map(([at, g]) => `${at}:${g.join(':')}`))
    for (const key of new Set([...shown, ...now])) record(glyphs, key, t, now.has(key), false)
    shown = now
  }
  return { shapes, glyphs }
}

// Clawd's animation as the parts of an SVG, its class and filter names under
// `prefix` so several can share one document. A `dark` theme is for a panel that
// stays dark whatever the page (the README's): the glow always on, no outlines.
export type Drawing = { defs: string; styles: string; body: string }

export function drawClawd(frame: (t: number) => Canvas, total: number, { prefix = '', theme = 'auto' }: { prefix?: string; theme?: 'auto' | 'dark' } = {}): Drawing {
  const { shapes, glyphs } = sample(frame, total)
  const styles: string[] = []
  const names = new Map<string, string>()
  const animate = <T>(track: Track<T>, show: (v: T) => string) => {
    const keys = track.map(([t, v]) => `${+((t / total) * 100).toFixed(3)}%{${show(v)}}`).join('')
    let name = names.get(keys)
    if (!name) {
      name = `${prefix}a${names.size}`
      names.set(keys, name)
      styles.push(`@keyframes ${name}{${keys}}.${name}{animation:${name} ${total}ms step-end infinite}`)
    }
    return name
  }

  const pale: string[] = []
  const plain: string[] = []
  for (const [color, track] of shapes) {
    const classes = [track.length > 1 ? animate(track, d => (d ? `d:path("${d}")` : 'd:none')) : '', GLOWING.has(color) ? `${prefix}g` : '']
    const cls = classes.filter(Boolean).join(' ')
    ;(isPale(color) ? pale : plain).push(`<path${cls ? ` class="${cls}"` : ''} fill="${hex(color)}" d="${track[0]![1]}"/>`)
  }

  const letters: string[] = []
  for (const [key, track] of glyphs) {
    const [at, codePoint, fg, bg] = key.split(':').map(Number) as [number, number, number, number]
    const x = (at % COLS) * 2
    const y = Math.floor(at / COLS) * 4
    const char = String.fromCodePoint(codePoint)
    const parts: string[] = []
    if (bg !== DEFAULT_COLOR) parts.push(`<rect x="${x}" y="${y}" width="2" height="4" fill="${hex(bg)}"/>`)
    // The terminal's ▁ sits on the cell's floor; a rect keeps it there whatever the font.
    if (char === '▁') parts.push(`<rect x="${x + 0.2}" y="${y + 3.2}" width="1.6" height="0.6" fill="${hex(fg)}"/>`)
    else if (char.trim()) {
      const fill = fg === DEFAULT_COLOR ? '#9aa0a6' : hex(fg)
      parts.push(`<text x="${x + 1}" y="${y + 3.1}" font-family="ui-monospace,Consolas,monospace" font-weight="700" font-size="3.4" text-anchor="middle" fill="${fill}">${escape(char)}</text>`)
    }
    if (parts.length === 0) continue
    const classes = [track.length > 1 ? animate(track, v => `opacity:${v ? 1 : 0}`) : '', GLOWING.has(fg) ? `${prefix}g` : ''].filter(Boolean)
    const attrs = `${classes.length ? ` class="${classes.join(' ')}"` : ''}${track[0]![1] ? '' : ' opacity="0"'}`
    letters.push(`<g${attrs}>${parts.join('')}</g>`)
  }

  const region = `filterUnits="userSpaceOnUse" x="-2" y="-2" width="${W + 4}" height="${VIEW_H + 4}"`
  const defs =
    `<filter id="${prefix}glow" ${region}><feGaussianBlur stdDeviation="0.8"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    // The outline stands a hair off the shape, so it never darkens the shape's own edge.
    `<filter id="${prefix}edge" ${region}><feMorphology in="SourceAlpha" operator="dilate" radius="0.35" result="outer"/>` +
    `<feMorphology in="SourceAlpha" operator="dilate" radius="0.1" result="inner"/><feFlood flood-color="#7d7d7d"/>` +
    `<feComposite in2="outer" operator="in"/><feComposite in2="inner" operator="out"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
  const glow = `.${prefix}g{filter:url(#${prefix}glow)}`
  styles.push(
    theme === 'dark' ? glow : `@media (prefers-color-scheme:dark){${glow}}`,
    theme === 'dark' ? '' : `@media (prefers-color-scheme:light){.${prefix}pale{filter:url(#${prefix}edge)}}`,
  )
  // Pale shapes go first, so a coloured neighbour covers their outline where they touch.
  const body = (pale.length ? `<g class="${prefix}pale">${pale.join('')}</g>` : '') + plain.join('') + letters.join('')
  return { defs, styles: styles.join(''), body }
}

export function svgFor(scene: Scene, extras: Extras = {}): string {
  const { defs, styles, body } = drawClawd(t => frameAt(scene, t, extras), svgLoopMs(scene))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${VIEW_H}" width="${W * 5}" height="${VIEW_H * 5}" shape-rendering="crispEdges">` +
    // A sandboxed frame whose scheme differs from the page's gets an opaque canvas; following the page keeps it clear.
    `<defs>${defs}</defs><style>:root{color-scheme:light dark;background:transparent}${styles}</style>${body}</svg>`
  )
}
