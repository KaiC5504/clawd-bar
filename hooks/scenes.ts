import type { ClawdAct, Work } from '../types'
import { BREAKOUT_MS, RUNNER_MS, SNAKE_MS, breakoutAt, runnerAt, snakeAt } from './arcade'
import type { Px } from './arcade'
import { canvas, dot, dots, glyph, mix, rect } from './pixels'
import type { Canvas } from './pixels'
import { wellAt, WELL_SHORT_LOOP_MS } from './well'

// Clawd is the Claude Code logo, 18×5 pixels (9×3 cells). His outline never
// changes: eyes only slide a pixel inside their row, arms only flick out a pixel
// to touch a prop, and everything else he does is carried by the props in the
// 12 pixels to his right.
export const COLS = 15
export const ROWS = 3

export type Scene = ClawdAct

// `work`: the call being acted out; without it a scene draws a sample one.
// `lead`: how long that call had run when this animation started. Only the
// terminal sets it, since the desktop can't tick a clock.
// `game`: the cabinet game this spell starts on.
export type Extras = { sweat?: boolean; planes?: number; work?: Work; lead?: number; game?: number }

const C = {
  body: 0xde886d,
  drained: 0xa98276,
  eye: 0x000000,
  fly: 0xd9f26b,
  glass: 0x5f6368,
  lit: 0xffd54f,
  base: 0x9aa0a6,
  roll: 0x9c6b3e,
  paper: 0xf1e6c8,
  ink: 0x8c8577,
  torch: 0x4a4f5c,
  beam: 0xffe58a,
  spot: 0x6e6e6e,
  found: 0x66bb6a,
  wave: 0x4fc3f7,
  metal: 0x78839a,
  knob: 0xef5350,
  plane: 0xeeeeee,
  gold: 0xe8bd62,
  goldDark: 0x9a7a35,
  case: 0x8d5a3b,
  strap: 0x5d3a26,
  stuff: [0x64b5f6, 0x81c784, 0xffb74d],
  pole: 0xbdbdbd,
  white: 0xf5f5f5,
  grey: 0x5f6368,
  cloud: 0x9aa0a6,
  rain: 0x64b5f6,
  dust: 0xa1887f,
  cap: 0x5c6bc0,
  zzz: 0x90a4ae,
  red: 0xe53935,
  box: 0xe8bd62,
  boxDark: 0xb8862f,
  stamp: 0xc62828,
  anvil: 0x616161,
  spark: 0xffb000,
  rocket: 0xeceff1,
  flame: 0xff7043,
  sweat: 0x7cc4f2,
  panel: 0x263238,
  term: 0x1b1f24,
  code: 0x8c99a6,
  keyword: 0xc792ea,
  del: 0xe57373,
  add: 0x81c784,
  screen: 0x1a1f2b,
} as const

// `peekLeft` / `peekRight`: one eye open, the other shut.
type Look = 'ahead' | 'left' | 'right' | 'closed' | 'peekLeft' | 'peekRight'
type Arm = 'side' | 'out'
type Pose = { look?: Look; left?: Arm; right?: Arm; step?: boolean; dx?: number; color?: number }

const EYES: Record<Look, [number, number][]> = {
  ahead: [[5, 1], [12, 1]],
  left: [[4, 1], [11, 1]],
  right: [[6, 1], [13, 1]],
  closed: [],
  peekLeft: [[5, 1]],
  peekRight: [[12, 1]],
}

function clawd(c: Canvas, { look = 'ahead', left = 'side', right = 'side', step = false, dx = 0, color = C.body }: Pose = {}): void {
  rect(c, 3 + dx, 0, 12, 4, color)
  dots(c, left === 'out' ? [[0, 2], [1, 2], [2, 2]] : [[1, 2], [2, 2]], color, dx)
  dots(c, right === 'out' ? [[15, 2], [16, 2], [17, 2]] : [[15, 2], [16, 2]], color, dx)
  dots(c, step ? [[5, 4], [7, 4], [10, 4], [12, 4]] : [[4, 4], [6, 4], [11, 4], [13, 4]], color, dx)
  dots(c, EYES[look], C.eye, dx)
  // A shut eye is a thin line, finer than a pixel can be, so it's a character in the eye's cell.
  const shut = look === 'closed' ? [2, 6] : look === 'peekLeft' ? [6] : look === 'peekRight' ? [2] : []
  for (const col of shut) glyph(c, col + dx / 2, 0, '▁', C.eye, color)
}

const on = (t: number, period: number, duty = 0.5) => t % period < period * duty
const phase = (t: number, period: number, steps: number) => Math.floor(((t % period) / period) * steps)
const flick = (t: number, period: number): Arm => (on(t, period) ? 'out' : 'side')

// A sparkle grows from a point to a plus and back over 800 ms, then rests.
function twinkle(c: Canvas, x: number, y: number, k: number, color: number): void {
  const step = Math.floor(k / 200)
  if (step > 3) return
  dot(c, x, y, step === 1 || step === 2 ? C.white : color)
  if (step === 1 || step === 2) dots(c, [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]], color)
}

const SPARKLES: [x: number, y: number, delay: number, color: number][] = [
  [20, 1, 0, 0xffd54f],
  [27, 4, 500, 0x80deea],
  [24, 2, 1000, 0xffd54f],
  [29, 0, 1500, 0xf48fb1],
  [1, 5, 1900, 0xffd54f],
]

// What gives off light; the desktop lets these glow on a dark theme.
export const GLOWING: ReadonlySet<number> = new Set([
  C.fly, C.lit, C.beam, C.found, C.wave, C.spark, C.flame, C.red, ...SPARKLES.map(s => s[3]),
])

const CONFETTI: [x: number, delay: number, color: number][] = [
  [19, 0, 0xf48fb1],
  [22, 500, 0x80deea],
  [26, 250, 0xc5e1a5],
  [28, 800, 0xffd54f],
]

function flag(c: Canvas, k: number): void {
  rect(c, 21, 0, 1, 6, C.pole)
  const wave = on(k, 500)
  for (let x = 22; x < 28; x++) {
    for (let y = 0; y < 2; y++) dot(c, x, y + (wave && x >= 25 ? 1 : 0), (x + y) % 2 === 0 ? C.white : C.grey)
  }
}

function write(c: Canvas, col: number, row: number, text: string, fg: number, bg?: number): void {
  ;[...text].forEach((char, i) => glyph(c, col + i, row, char, fg, bg))
}

const count = (n: number) => (n > 9999 ? `${Math.floor(n / 1000)}k` : String(n))
const fit = (text: string) => (text.length <= 5 ? text : text.replace(' ', ''))

function took(ms: number): string {
  const s = Math.floor(ms / 1000)
  return s < 100 ? `${s}s` : s < 6000 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

// The header row holds five characters: `$ git`, or the program alone when it's longer.
function shellTitle(cmd: string): string {
  const full = `$ ${cmd}`
  return full.length <= 5 ? full : cmd.length <= 5 ? cmd : `${cmd.slice(0, 4)}…`
}

const LANGS: Record<string, number> = {}
for (const [color, exts] of [
  [0x5b9bf0, 'ts tsx mts cts'],
  [0xf0db4f, 'js jsx mjs cjs'],
  [0x7ec699, 'py pyi ipynb'],
  [0xf0845a, 'rs'],
  [0x4fd1d9, 'go'],
  [0xf05138, 'swift'],
  [0xb388ff, 'kt kts'],
  [0xe76f51, 'java'],
  [0x9fa8da, 'c h cpp cc hpp cs'],
  [0xe573b5, 'css scss sass'],
  [0xf0a35b, 'html vue svelte'],
  [0xe0e0e0, 'md mdx txt'],
  [0x8bc34a, 'sh bash ps1'],
] as const) {
  for (const ext of exts.split(' ')) LANGS[ext] = color
}
const langColor = (ext = '') => LANGS[ext] ?? 0xb0bec5

const SERVERS: [name: string, color: number][] = [
  ['gmail', 0xd93025],
  ['linear', 0x5e6ad2],
  ['github', 0x8b949e],
  ['slack', 0xe01e5a],
  ['notion', 0xe0e0e0],
  ['figma', 0xa259ff],
  ['calendar', 0x4285f4],
  ['drive', 0x1fa463],
  ['sentry', 0x8d6bc4],
  ['stripe', 0x635bff],
  ['atlassian', 0x2684ff],
  ['jira', 0x2684ff],
  ['supabase', 0x3ecf8e],
]

// A server we don't know gets a hue from its name, the same one every time.
function serverColor(server: string): number {
  const known = SERVERS.find(([name]) => server.toLowerCase().includes(name))
  if (known) return known[1]
  const hue = [...server].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7)
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12
    return Math.round(255 * (0.55 - 0.3 * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return (channel(0) << 16) | (channel(8) << 8) | channel(4)
}

// A line of code is cell-wide words (a keyword, a name, punctuation), so each cell keeps to one colour on the panel.
type Word = [len: number, color: number | null]
type Line = [x: number, words: Word[]]
const ROW_Y = [3, 5]
const lineWidth = (words: Word[]) => words.reduce((n, [len]) => n + len, 0)

function codeLine(c: Canvas, [x, words]: Line, y: number, upTo = Infinity, tint?: number): void {
  let at = 0
  for (const [len, color] of words) {
    for (let i = 0; i < len && at < upTo; i++, at++) if (color !== null) dot(c, x + at, y, tint ?? color)
  }
}

function codeLines(color: number) {
  const dim = mix(color, C.panel, 0.45)
  const old: Line[] = [[22, [[2, C.keyword], [2, null], [4, color]]], [24, [[4, dim], [2, C.code]]]]
  const fresh: Line[] = [[22, [[2, C.keyword], [2, null], [2, color], [2, C.code]]], [24, [[2, C.keyword], [2, null], [2, dim]]]]
  return { old, fresh }
}

// The diff as text: `-2+2`, or its two halves in turn when both don't fit.
function diffHeader(c: Canvas, t: number, removed: number, added: number): void {
  const parts: [string, number][] = []
  if (removed > 0) parts.push([`-${count(removed)}`, C.del])
  if (added > 0 || removed === 0) parts.push([`+${count(added)}`, C.add])
  const isTogether = parts.reduce((n, [text]) => n + text.length, 0) <= 5
  let col = 10
  for (const [text, color] of isTogether ? parts : [parts[Math.floor(t / 700) % parts.length]!]) {
    write(c, col, 0, text, color, C.panel)
    col += text.length
  }
}

// Past 15 s of a command he gets restless, glancing at you and away, until the cabinet comes out at 20.
function waiting(x: Extras, t: number): Look {
  if (x.lead === undefined) return 'right'
  const elapsed = x.lead + t
  return elapsed < 15_000 ? 'right' : on(elapsed, 1400) ? 'ahead' : 'left'
}

const SAMPLE: Record<'edit' | 'write' | 'shell' | 'tests' | 'install' | 'mcp', Work> = {
  edit: { id: '', kind: 'edit', startedAt: 0, ext: 'ts', removed: 2, added: 2 },
  write: { id: '', kind: 'write', startedAt: 0, ext: 'md', lines: 120 },
  shell: { id: '', kind: 'shell', startedAt: 0, cmd: 'git', result: { ok: true, ms: 3000 } },
  tests: { id: '', kind: 'tests', startedAt: 0, cmd: 'vitest', result: { ok: false, ms: 9000, passed: 41, failed: 7 } },
  install: { id: '', kind: 'install', startedAt: 0, cmd: 'pnpm', result: { ok: true, ms: 6000 } },
  mcp: { id: '', kind: 'mcp', startedAt: 0, server: 'linear' },
}

const OUTPUT = [5, 8, 3, 7, 6, 2, 8, 4]
const CRATES: [number, number][] = [[20, 4], [22, 4], [24, 4], [26, 4], [28, 4], [22, 2], [24, 2], [26, 2]]

function crates(c: Canvas, n: number): void {
  CRATES.slice(0, n).forEach(([x, y], i) => rect(c, x, y, 2, 2, i % 2 === 0 ? C.box : C.boxDark))
}

const onScreen = (c: Canvas, px: Px[]) => px.forEach(([x, y, color]) => dot(c, 20 + x, y, color))

type Game = { title: string; color: number; ms: number; draw: (c: Canvas, k: number, t: number) => void }

const GAMES: Game[] = [
  {
    title: 'BLOCK',
    color: 0xbb6bd9,
    ms: WELL_SHORT_LOOP_MS,
    draw(c, k, t) {
      const { blocks, mood } = wellAt(k)
      // He keeps his eyes on the well and works the controls; clears are the well's to show, not his.
      clawd(c, { look: 'right', right: mood === 'steer' || mood === 'twist' ? flick(t, 260) : 'side' })
      for (const [col, row, color] of blocks) rect(c, 20 + col * 2, row, 2, 1, color)
    },
  },
  {
    title: 'SNAKE',
    color: 0x6fcf97,
    ms: SNAKE_MS,
    draw(c, k, t) {
      clawd(c, { look: 'right', right: flick(t, 330) })
      rect(c, 20, 0, 10, 6, C.screen)
      onScreen(c, snakeAt(k))
    },
  },
  {
    title: 'BRICK',
    color: 0xeb5757,
    ms: BREAKOUT_MS,
    draw(c, k, t) {
      clawd(c, { look: 'right', right: flick(t, 300) })
      rect(c, 20, 0, 10, 6, C.screen)
      onScreen(c, breakoutAt(k))
    },
  },
  {
    title: ' RUN!',
    color: 0xf0a080,
    ms: RUNNER_MS,
    draw(c, k) {
      clawd(c, { look: 'right' })
      onScreen(c, runnerAt(k))
    },
  },
]
const TITLE_MS = 1000
const GG_MS = 600
const SPELLS = GAMES.map(g => TITLE_MS + g.ms + GG_MS)
const SPELL_STARTS = SPELLS.map((_, i) => SPELLS.slice(0, i).reduce((a, b) => a + b, 0))
export const CABINET_GAMES = GAMES.length

// Each game opens on its name typed out like an attract screen and ends on GG, then the next one starts.
function cabinet(c: Canvas, t: number, x: Extras): void {
  const total = SPELLS.reduce((a, b) => a + b, 0)
  const k = (SPELL_STARTS[(x.game ?? 0) % GAMES.length]! + t) % total
  let i = GAMES.length - 1
  while (SPELL_STARTS[i]! > k) i--
  const game = GAMES[i]!
  const s = k - SPELL_STARTS[i]!
  if (s < TITLE_MS) {
    clawd(c, { look: 'right' })
    rect(c, 20, 0, 10, 6, C.screen)
    const typed = Math.min(5, Math.floor(s / 90))
    write(c, 10, 1, game.title.slice(0, typed), typed === 5 && !on(s, 200) ? C.white : game.color, C.screen)
  } else if (s >= TITLE_MS + game.ms) {
    clawd(c, { look: 'ahead', right: flick(s, 200) })
    rect(c, 20, 0, 10, 6, C.screen)
    write(c, 11, 1, 'GG!', C.lit, C.screen)
  } else game.draw(c, s - TITLE_MS, t)
}

type Draw = (c: Canvas, t: number, x: Extras) => void

// `svgMs`: a shorter loop for the desktop's Svg, which has a size cap; it must also start and end alike.
// `once`: the scene plays through once and then holds its last frame.
const SCENES: Record<Scene, { ms: number; svgMs?: number | ((x: Extras) => number); once?: true; draw: Draw }> = {
  idle: {
    ms: 7200,
    draw(c, t) {
      const p = (t % 7200) / 7200
      const fx = Math.round(23 + 6 * Math.sin(2 * Math.PI * p))
      const fy = Math.round(2 + 1.6 * Math.sin(6 * Math.PI * p))
      const look: Look = p > 0.55 && p < 0.63 ? 'left' : fx > 24 ? 'right' : 'ahead'
      clawd(c, { look: look })
      if (on(t, 420, 0.75)) dot(c, fx, fy, C.fly)
    },
  },

  thinking: {
    ms: 3600,
    draw(c, t) {
      const k = t % 3600
      const lit = (k > 1500 && k < 1600) || (k > 1750 && k < 1830) || (k > 2100 && k < 2900)
      const steady = k > 2100 && k < 2900
      clawd(c, { look: k > 1400 ? 'right' : 'ahead', right: steady ? 'out' : 'side' })
      rect(c, 20, 0, 3, 2, lit ? C.lit : C.glass)
      dot(c, 21, 2, C.base)
      if (steady) dots(c, [[24, 0], [24, 2]], C.lit)
    },
  },

  working: {
    ms: SPELLS.reduce((a, b) => a + b, 0),
    svgMs: x => SPELLS[(x.game ?? 0) % GAMES.length]!,
    draw: cabinet,
  },

  editing: {
    ms: 4000,
    once: true,
    draw(c, t, x) {
      const work = x.work ?? SAMPLE.edit
      const color = langColor(work.ext)
      const removed = work.removed ?? 0
      const added = work.added ?? 0
      const { old, fresh } = codeLines(color)
      // A one-line change only bites the end off a line and types a new end on.
      const isFix = removed === 1 && added === 1
      const r = Math.min(2, removed)
      const a = Math.min(2, added)
      const wipeAt = 600
      const typeAt = isFix ? 900 : wipeAt + 400 * r
      const heldAt = isFix ? 1300 : typeAt + 700 * a
      const settleAt = heldAt + 900
      const isGlancing = t > heldAt + 200 && t < heldAt + 700
      clawd(c, { look: isGlancing ? 'ahead' : 'right', right: t > wipeAt && t < heldAt ? flick(t, 200) : 'side' })
      rect(c, 20, 0, 10, 6, C.panel)
      if (t > 300 && t < settleAt) diffHeader(c, t, removed, added)
      else if (work.ext) write(c, 10, 0, `.${work.ext}`.slice(0, 5), color, C.panel)

      let active = -1
      if (isFix) {
        codeLine(c, old[0]!, ROW_Y[0]!, 6)
        codeLine(c, old[1]!, ROW_Y[1]!)
        if (t < wipeAt) rect(c, 28, ROW_Y[0]!, 2, 1, on(t, 200) ? C.del : color)
        else if (t >= typeAt) rect(c, 28, ROW_Y[0]!, Math.min(2, Math.floor((t - typeAt) / 200)), 1, t < settleAt ? C.add : color)
        active = t < heldAt ? 0 : -1
      } else if (t < wipeAt) {
        old.forEach((line, i) => codeLine(c, line, ROW_Y[i]!, Infinity, i < r && on(t, 200) ? C.del : undefined))
        active = 0
      } else if (t < typeAt) {
        const wiping = Math.floor((t - wipeAt) / 400)
        active = wiping
        old.forEach((line, i) => {
          if (i >= r) return codeLine(c, line, ROW_Y[i]!)
          if (i < wiping) return
          const width = lineWidth(line[1])
          const left = i === wiping ? Math.round(width * (1 - ((t - wipeAt) % 400) / 400)) : width
          codeLine(c, line, ROW_Y[i]!, left, C.del)
        })
      } else {
        // The new lines take the old ones' place; what's left of the old moves up under them.
        const lines = [...fresh.slice(0, a), ...old.slice(r)].slice(0, 2)
        active = a > 0 ? 0 : -1
        lines.forEach((line, i) => {
          if (i >= a) return codeLine(c, line, ROW_Y[i]!)
          const width = lineWidth(line[1])
          const typed = Math.max(0, Math.min(width, Math.floor((t - typeAt - i * 700) / (600 / width))))
          if (typed > 0) active = i
          codeLine(c, line, ROW_Y[i]!, typed, t < settleAt ? C.add : undefined)
        })
      }
      if (active >= 0 && t < heldAt && on(t, 300, 0.7)) dot(c, 21, ROW_Y[active]!, C.white)
    },
  },

  writing: {
    ms: 2800,
    once: true,
    draw(c, t, x) {
      const work = x.work ?? SAMPLE.write
      const color = langColor(work.ext)
      const { fresh } = codeLines(color)
      clawd(c, { look: t > 1700 && t < 2200 ? 'ahead' : 'right', right: t > 300 && t < 1500 ? flick(t, 200) : 'side' })
      rect(c, 20, 0, 10, 6, C.panel)
      if (t > 300 && t < 2400) write(c, 10, 0, fit(`+${count(work.lines ?? 0)}`), C.add, C.panel)
      else if (work.ext) write(c, 10, 0, `.${work.ext}`.slice(0, 5), color, C.panel)
      fresh.forEach((line, i) => {
        const width = lineWidth(line[1])
        codeLine(c, line, ROW_Y[i]!, Math.max(0, Math.min(width, Math.floor((t - 300 - i * 600) / (500 / width)))))
      })
      if (t > 1600 && (t > 2400 || on(t, 200))) glyph(c, 14, 2, '✓', C.found, C.panel)
    },
  },

  running: {
    ms: 2400,
    draw(c, t, x) {
      const work = x.work ?? SAMPLE.shell
      clawd(c, { look: waiting(x, t) })
      rect(c, 20, 0, 10, 6, C.term)
      write(c, 10, 0, shellTitle(work.cmd ?? ''), C.code, C.term)
      const step = Math.floor(t / 300)
      rect(c, 21, 3, OUTPUT[step % OUTPUT.length]!, 1, C.code)
      const next = OUTPUT[(step + 1) % OUTPUT.length]! >> 1
      if (x.lead === undefined) {
        rect(c, 21, 5, next, 1, C.code)
        if (on(t, 500)) dot(c, 27, 5, C.white)
        return
      }
      rect(c, 21, 5, Math.min(3, next), 1, C.code)
      write(c, 12, 2, took(x.lead + t).padStart(3), mix(C.code, C.term, 0.35), C.term)
    },
  },

  ran: {
    ms: 1400,
    once: true,
    draw(c, t, x) {
      const work = x.work ?? SAMPLE.shell
      const ok = work.result?.ok !== false
      clawd(c, { look: ok || t < 400 ? 'right' : 'ahead' })
      rect(c, 20, 0, 10, 6, C.term)
      write(c, 10, 0, shellTitle(work.cmd ?? ''), C.code, C.term)
      rect(c, 21, 3, 6, 1, C.code)
      if (t < 400) return rect(c, 21, 5, 3, 1, C.code)
      glyph(c, 10, 2, ok ? '✓' : '✗', ok ? C.found : C.red, C.term)
      if (!ok) rect(c, 22, 5, 2, 1, C.del)
      if (work.result) write(c, 12, 2, took(work.result.ms).padStart(3), mix(C.code, C.term, 0.35), C.term)
    },
  },

  testing: {
    ms: 1000,
    draw(c, t, x) {
      clawd(c, { look: waiting(x, t) })
      // Nothing is known until it finishes, so a light only sweeps the dots.
      const scan = Math.floor(t / 100) % 10
      for (let i = 0; i < 10; i++) dot(c, 20 + (i % 5) * 2, i < 5 ? 1 : 4, i === scan ? C.lit : C.grey)
    },
  },

  tested: {
    ms: 2800,
    once: true,
    draw(c, t, x) {
      const result = (x.work ?? SAMPLE.tests).result ?? { ok: true, ms: 0 }
      const { ok } = result
      const passed = result.passed ?? 0
      const failed = result.failed ?? 0
      const isCounted = result.passed !== undefined && result.failed !== undefined
      const share = isCounted && failed > 0 ? Math.max(1, Math.round((10 * failed) / (passed + failed))) : 0
      const reds = ok ? share : Math.max(1, share)
      const isFlashing = t >= 700 && t < 1700
      const isCheering = ok && isFlashing
      clawd(c, {
        look: ok || t < 700 ? 'right' : 'ahead',
        left: isCheering ? flick(t, 300) : 'side',
        right: isCheering ? flick(t + 150, 300) : 'side',
      })
      if (t >= 1700) {
        if (!isCounted) return glyph(c, 12, 1, ok ? '✓' : '✗', ok ? C.found : C.red)
        if (ok) return write(c, 10, 1, fit(`${count(passed)} ✓`), C.add)
        write(c, 10, 0, fit(`${count(passed)} ✓`), C.found)
        write(c, 10, 2, fit(`${count(failed)} ✗`), C.del)
        return
      }
      const settled = Math.floor(t / 70)
      for (let i = 0; i < 10; i++) {
        const isRed = i >= 10 - reds
        let color: number = i < settled ? (isRed ? C.red : C.found) : C.grey
        if (isFlashing && on(t, 400)) color = isRed ? C.del : ok ? C.add : C.found
        dot(c, 20 + (i % 5) * 2, i < 5 ? 1 : 4, color)
      }
    },
  },

  installing: {
    ms: 4000,
    draw(c, t, x) {
      const work = x.work ?? SAMPLE.install
      const landed = Math.floor(t / 400)
      const isTossing = landed < CRATES.length && t % 400 < 120
      clawd(c, { look: waiting(x, t), right: isTossing ? 'out' : 'side' })
      write(c, 10, 0, shellTitle(work.cmd ?? ''), C.code)
      crates(c, Math.min(landed, CRATES.length))
      if (landed < CRATES.length) {
        const [cx, cy] = CRATES[landed]!
        // Still falling, a row above where it lands.
        rect(c, cx, t % 400 < 150 && cy > 2 ? cy - 2 : cy, 2, 2, landed % 2 === 0 ? C.box : C.boxDark)
      }
    },
  },

  installed: {
    ms: 1000,
    once: true,
    draw(c, t, x) {
      const work = x.work ?? SAMPLE.install
      const ok = work.result?.ok !== false
      clawd(c, { look: ok || t < 300 ? 'right' : 'ahead' })
      write(c, 10, 0, shellTitle(work.cmd ?? ''), C.code)
      crates(c, CRATES.length)
      if (t >= 300) glyph(c, 14, 1, ok ? '✓' : '✗', ok ? C.found : C.red)
    },
  },

  linking: {
    ms: 3600,
    draw(c, t, x) {
      const server = (x.work ?? SAMPLE.mcp).server ?? ''
      const color = serverColor(server)
      const plug = Math.min(24, 19 + Math.floor(t / 120))
      clawd(c, { look: 'right', right: 'out' })
      rect(c, 18, 2, plug - 18, 1, C.grey)
      rect(c, plug, 1, 2, 3, C.metal)
      rect(c, 27, 0, 3, 6, mix(color, 0x000000, 0.5))
      // The socket wears the server's initial, so Gmail looks unlike Linear at a glance.
      glyph(c, 14, 1, (server[0] ?? '?').toUpperCase(), C.white, color)
      // Once in, replies pulse back to him; a pulse fills its whole cell, as a cell holds one colour beside empty pixels.
      if (plug === 24) rect(c, 22 - 2 * (Math.floor((t - 600) / 150) % 2), 2, 2, 1, color)
    },
  },


  reading: {
    ms: 5200,
    draw(c, t) {
      const k = t % 5200
      const open = k < 1200 ? k / 1200 : k < 4000 ? 1 : 1 - (k - 4000) / 1200
      const length = 2 * Math.round(4 * open)
      const scanning = k >= 1200 && k < 4000
      const look: Look = scanning ? (phase(k - 1200, 1400, 2) === 0 ? 'ahead' : 'right') : 'right'
      clawd(c, { look: look, right: 'out' })
      rect(c, 18, 0, 2, 6, C.roll)
      if (length > 0) {
        rect(c, 20, 1, length, 4, C.paper)
        for (let x = 20; x < 20 + length; x++) if (x % 2 === 0 || x < 20 + length - 1) dot(c, x, 2, x % 3 === 2 ? C.paper : C.ink)
        for (let x = 20; x < 20 + length - 2; x++) dot(c, x, 3, x % 4 === 3 ? C.paper : C.ink)
      }
      rect(c, 20 + length, 0, 2, 6, C.roll)
    },
  },

  searching: {
    ms: 4000,
    draw(c, t) {
      const SPOTS = [22, 24, 26, 28]
      const k = t % 4000
      const sweep = Math.min(SPOTS.length - 1, Math.floor(k / 600))
      const found = k >= 2400
      const target = found ? 26 : SPOTS[sweep]!
      clawd(c, { look: found ? 'ahead' : 'right', right: 'out' })
      dot(c, 18, 2, C.torch)
      dot(c, 19, 2, C.beam)
      for (const x of SPOTS) dot(c, x, 5, x === target ? (found ? C.found : C.beam) : C.spot)
      if (!found || on(k, 400)) {
        dot(c, Math.round((20 + target) / 2), 3, C.beam)
        dot(c, target, 4, found ? C.found : C.beam)
      }
    },
  },

  browsing: {
    ms: 2800,
    draw(c, t) {
      const k = t % 2800
      const out = k < 1400
      const n = 1 + phase(k, 1400, 3)
      clawd(c, { look: out ? 'right' : 'ahead', right: 'out' })
      rect(c, 18, 0, 1, 6, C.metal)
      dot(c, 18, 0, on(k, 400) ? C.knob : C.metal)
      for (let i = 0; i < n; i++) glyph(c, out ? 10 + i : 13 - i, 0, out ? ')' : '(', C.wave)
    },
  },

  delegating: {
    ms: 2400,
    draw(c, t, x) {
      const k = t % 2400
      const throwing = k < 350
      clawd(c, { look: 'right', right: throwing ? 'out' : 'side', step: throwing })
      const n = Math.max(1, Math.min(3, x.planes ?? 1))
      for (let i = 0; i < n; i++) {
        const age = (k - 350 + (i * 2400) / n + 2400) % 2400
        if (age > 1600) continue
        const px = 18 + Math.round((age / 1600) * 10)
        const py = age < 500 ? 1 : age < 1100 ? 2 : 3
        dots(c, [[0, 0], [1, 0], [2, 0], [1, 1], [2, 1], [3, 1], [4, 1]], C.plane, px, py)
      }
    },
  },

  calling: {
    ms: 1800,
    draw(c, t) {
      const k = t % 1800
      const press = (k > 0 && k < 160) || (k > 320 && k < 480)
      const ringing = k < 1000
      clawd(c, { look: 'ahead', right: press ? 'out' : 'side' })
      rect(c, 19, 5, 6, 1, C.goldDark)
      rect(c, 20, 4, 4, 1, C.gold)
      rect(c, 21, 3, 2, 1, C.gold)
      if (!press) dot(c, 21, 2, C.base)
      if (ringing) glyph(c, 12, 0, on(k, 240) ? '!' : ' ', C.gold)
      if (ringing && on(k, 300)) glyph(c, 13, 1, ')', C.gold)
    },
  },

  compacting: {
    ms: 3600,
    draw(c, t) {
      const k = t % 3600
      const stage = Math.min(2, Math.floor(k / 1000))
      const width = [10, 8, 6][stage]!
      const pushing = k % 1000 > 450 && k < 3000
      const bulge = !pushing && k < 3000
      clawd(c, { look: 'right', right: pushing ? 'out' : 'side', step: pushing })
      const left = 19
      rect(c, left, 3, width, 3, C.case)
      rect(c, left, 4, width, 1, C.strap)
      if (bulge) {
        rect(c, left + 1, 2, width - 2, 1, C.case)
        C.stuff.forEach((color, i) => {
          if (i * 3 + 2 < width) dot(c, left + 2 + i * 3, 1, color)
        })
      }
      if (k >= 3000) dot(c, 21, 4, on(k, 200) ? C.lit : C.goldDark)
    },
  },

  done: {
    ms: 2400,
    draw(c, t) {
      const k = t % 2400
      clawd(c, { left: flick(k, 300), right: flick(k + 150, 300) })
      SPARKLES.forEach(([x, y, delay, color]) => twinkle(c, x, y, (k + 2400 - delay) % 2400, color))
      CONFETTI.forEach(([x, delay, color]) => {
        const y = Math.floor(((k + delay) % 1200) / 200)
        dot(c, x + (y % 2), y, color)
      })
    },
  },

  error: {
    ms: 2000,
    draw(c, t) {
      const k = t % 2000
      clawd(c, { look: 'closed' })
      rect(c, 19, 0, 4, 1, C.cloud)
      rect(c, 18, 1, 6, 1, C.cloud)
      const fall = phase(k, 600, 4)
      for (const [x, delay] of [[19, 0], [21, 2], [23, 1]] as const) dot(c, x, 2 + ((fall + delay) % 4), C.rain)
    },
  },

  interrupted: {
    ms: 2400,
    draw(c, t) {
      const k = t % 2400
      if (k < 600) {
        clawd(c, { look: 'right', step: on(k, 150), dx: Math.floor(k / 200) - 3 })
        return
      }
      const skid = k < 1500
      clawd(c, { look: skid ? 'ahead' : 'left', step: skid })
      if (skid) {
        const puff = phase(k - 600, 900, 3)
        const dust = mix(C.dust, C.glass, puff * 0.3)
        dots(c, [[16, 5], [17, 5], [18, 4 - (puff > 0 ? 1 : 0)]], dust)
        if (puff > 0) dots(c, [[19 + puff, 5], [20 + puff, 3]], dust)
      }
    },
  },

  dozing: {
    ms: 8000,
    draw(c, t) {
      const k = t % 8000
      const look: Look = k > 1800 && k < 2300 ? 'peekLeft' : k > 5800 && k < 6300 ? 'peekRight' : 'closed'
      clawd(c, { look })
      if ((k > 2900 && k < 3900) || (k > 6900 && k < 7900)) glyph(c, 9, 0, 'z', C.zzz)
    },
  },

  sleeping: {
    ms: 3600,
    draw(c, t) {
      const k = t % 3600
      clawd(c, { look: 'closed' })
      rect(c, 6, 0, 6, 1, C.cap)
      const z = phase(k, 3600, 4)
      if (z >= 1) glyph(c, 9, 1, 'z', C.zzz)
      if (z >= 2) glyph(c, 10, 0, 'Z', C.zzz)
      if (z >= 3) glyph(c, 12, 0, 'z', mix(C.zzz, C.glass, 0.4))
    },
  },

  waking: {
    ms: 1600,
    draw(c, t) {
      const k = t % 1600
      const stretch = k < 700
      clawd(c, { look: stretch ? 'ahead' : k < 1150 ? 'left' : 'right', left: stretch ? 'out' : 'side', right: stretch ? 'out' : 'side' })
      if (stretch) glyph(c, 10, 0, '!', C.lit)
    },
  },

  exhausted: {
    ms: 3000,
    draw(c, t) {
      const k = t % 3000
      clawd(c, { color: C.drained })
      rect(c, 20, 1, 8, 1, C.base)
      rect(c, 20, 5, 8, 1, C.base)
      rect(c, 20, 2, 1, 3, C.base)
      rect(c, 27, 2, 1, 3, C.base)
      dots(c, [[28, 2], [28, 3], [28, 4]], C.base)
      if (on(k, 1000)) rect(c, 21, 2, 1, 3, C.red)
    },
  },

  ciPrep: {
    ms: 3200,
    draw(c, t) {
      const k = t % 3200
      const stretch = k > 2200 && k < 2900
      const look: Look = k < 900 ? 'left' : k < 1300 ? 'ahead' : k < 2200 ? 'right' : 'ahead'
      clawd(c, { look: look, left: stretch ? 'out' : 'side', right: stretch ? 'out' : 'side' })
      dots(c, [[20, 5], [23, 5], [26, 5]], C.white)
    },
  },

  ciFetch: {
    ms: 1040,
    draw(c, t) {
      const k = t % 1040
      const step = on(k, 520)
      clawd(c, { look: 'right', right: 'out', step })
      rect(c, 18, step ? 0 : 1, 6, 4, C.box)
      rect(c, 18, step ? 2 : 3, 6, 1, C.boxDark)
      dot(c, 26 + phase(k, 1040, 4), 5, mix(C.dust, C.glass, 0.4))
    },
  },

  ciSign: {
    ms: 1400,
    draw(c, t) {
      const k = t % 1400
      const down = k > 500 && k < 800
      clawd(c, { look: 'right', right: down ? 'out' : 'side' })
      rect(c, 20, 5, 8, 1, C.paper)
      if (k > 600) dots(c, [[23, 5], [24, 5]], C.stamp)
      rect(c, 22, down ? 3 : 1, 4, 1, C.stamp)
      rect(c, 23, down ? 1 : 0, 2, down ? 2 : 1, C.roll)
    },
  },

  ciBuild: {
    ms: 900,
    draw(c, t) {
      const k = t % 900
      const strike = k > 520
      clawd(c, { look: 'right', right: 'out' })
      rect(c, 21, 4, 6, 1, C.anvil)
      rect(c, 22, 5, 4, 1, C.anvil)
      if (strike) {
        rect(c, 18, 2, 2, 1, C.roll)
        rect(c, 20, 2, 2, 2, C.metal)
        dots(c, [[23, 3], [25, 2]], C.spark)
      } else {
        rect(c, 18, 1, 1, 2, C.roll)
        rect(c, 18, 0, 2, 1, C.metal)
      }
    },
  },

  ciPublish: {
    ms: 2000,
    draw(c, t) {
      const k = t % 2000
      const rise = Math.min(4, Math.floor(k / 300))
      clawd(c, { look: 'right', right: k < 300 ? 'out' : 'side' })
      const y = 3 - rise
      rect(c, 22, y, 2, 2, C.rocket)
      dot(c, 22, y - 1, C.knob)
      if (rise < 4) dots(c, [[22, y + 2], [23, y + 2]], on(k, 160) ? C.flame : C.lit)
      if (rise === 0) dots(c, [[21, 5], [24, 5]], mix(C.dust, C.glass, 0.3))
    },
  },

  ciWin: {
    ms: 2400,
    draw(c, t) {
      const k = t % 2400
      clawd(c, { right: flick(k, 300) })
      flag(c, k)
      twinkle(c, 27, 4, k % 1200, C.lit)
    },
  },

  ciFail: {
    ms: 2000,
    draw(c, t, x) {
      SCENES.error.draw(c, t, x)
    },
  },
}

export const SCENE_NAMES = Object.keys(SCENES) as Scene[]

export const loopMs = (scene: Scene) => SCENES[scene].ms
export const isOnce = (scene: Scene) => SCENES[scene].once === true

export function svgLoopMs(scene: Scene, extras: Extras = {}): number {
  const { svgMs, ms } = SCENES[scene]
  return typeof svgMs === 'function' ? svgMs(extras) : (svgMs ?? ms)
}

// Sweat sits on top of any scene: a drop forms by his brow and runs off.
function sweat(c: Canvas, t: number): void {
  const k = phase(t, 1600, 4)
  if (k < 3) dot(c, 0, k === 0 ? 0 : 1, C.sweat)
}

export function frameAt(scene: Scene, t: number, extras: Extras = {}): Canvas {
  const c = canvas(COLS, ROWS)
  const { ms, once, draw } = SCENES[scene]
  draw(c, once ? Math.min(Math.max(0, t), ms - 1) : Math.max(0, t), extras)
  if (extras.sweat && scene !== 'sleeping' && scene !== 'exhausted') sweat(c, t)
  return c
}
