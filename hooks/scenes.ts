import type { ClawdAct } from '../types'
import { canvas, dot, dots, glyph, mix, rect } from './pixels'
import type { Canvas } from './pixels'
import { wellAt, WELL_LOOP_MS, WELL_SHORT_LOOP_MS } from './well'

// Clawd is the Claude Code logo, 18×5 pixels (9×3 cells). His outline never
// changes: eyes only slide a pixel inside their row, arms only flick out a pixel
// to touch a prop, and everything else he does is carried by the props in the
// 12 pixels to his right.
export const COLS = 15
export const ROWS = 3

export type Scene = ClawdAct

export type Extras = { sweat?: boolean; planes?: number }

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

type Draw = (c: Canvas, t: number, x: Extras) => void

// `svgMs`: a shorter loop for the desktop's Svg, which has a size cap; it must also start and end alike.
const SCENES: Record<Scene, { ms: number; svgMs?: number; draw: Draw }> = {
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
    ms: WELL_LOOP_MS,
    svgMs: WELL_SHORT_LOOP_MS,
    draw(c, t) {
      const { blocks, mood } = wellAt(t)
      // He keeps his eyes on the well and works the controls; clears are the well's to show, not his.
      clawd(c, { look: 'right', right: mood === 'steer' || mood === 'twist' ? flick(t, 260) : 'side' })
      for (const [col, row, color] of blocks) rect(c, 20 + col * 2, row, 2, 1, color)
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
export const svgLoopMs = (scene: Scene) => SCENES[scene].svgMs ?? SCENES[scene].ms

// Sweat sits on top of any scene: a drop forms by his brow and runs off.
function sweat(c: Canvas, t: number): void {
  const k = phase(t, 1600, 4)
  if (k < 3) dot(c, 0, k === 0 ? 0 : 1, C.sweat)
}

export function frameAt(scene: Scene, t: number, extras: Extras = {}): Canvas {
  const c = canvas(COLS, ROWS)
  SCENES[scene].draw(c, Math.max(0, t), extras)
  if (extras.sweat && scene !== 'sleeping' && scene !== 'exhausted') sweat(c, t)
  return c
}
