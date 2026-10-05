import { filledBoxes, levelColor } from './usage'
import type { Meter } from './usage'

// The usage bars move only when something happened: a new value fills in or
// drains out a box at a time, crossing 80 or 90 sweeps the new colour across and
// flashes the percent, a window that resets drains away and refills, and from 90
// up the last box beats like a heart.

// One box: a theme colour, dimmed or not; `undefined` colour is the text colour (the glint).
export type Paint = { color: string | undefined; isDim: boolean }
export type BarPaint = { boxes: Paint[]; isFlashing: boolean }

const STEP_MS = 110
const DRAIN_MS = 35
const WAVE_MS = 45
const FLASH_MS = 600
const BEAT_MS = 1600

const GLINT: Paint = { color: undefined, isDim: false }
const EMPTY: Paint = { color: undefined, isDim: true }
const RANK: Record<string, number> = { [levelColor(0)]: 0, [levelColor(80)]: 1, [levelColor(90)]: 2 }

// A bar at rest at its value.
export function stillBar(meter: Meter, boxes: number): BarPaint {
  const n = filledBoxes(meter.percent, boxes)
  return { boxes: Array.from({ length: boxes }, (_, i) => (i < n ? { color: meter.color, isDim: false } : EMPTY)), isFlashing: false }
}

type Motion = { from: number; to: number; at: number; isReset: boolean }

export function barMotion() {
  const seen = new Map<string, number>()
  const motions = new Map<string, Motion>()

  // How long a motion runs at this many boxes, and the moments its phases change.
  const plan = (m: Motion, boxes: number) => {
    const a = filledBoxes(m.from, boxes)
    const b = filledBoxes(m.to, boxes)
    const drain = m.isReset ? a * DRAIN_MS : 0
    const fill = (m.isReset ? b : Math.abs(b - a)) * STEP_MS
    const isRising = RANK[levelColor(m.to)]! > RANK[levelColor(m.from)]!
    const wave = isRising ? Math.max(b * WAVE_MS + WAVE_MS, FLASH_MS) : 0
    return { a, b, drain, fill, isRising, end: drain + fill + wave }
  }

  return {
    // Notes new values; a change starts a motion from whatever the bar shows now.
    see(meters: Meter[], now: number): void {
      for (const m of meters) {
        const last = seen.get(m.name)
        seen.set(m.name, m.percent)
        if (last === undefined || last === m.percent) continue
        // A window's limit only falls when the window resets.
        const isReset = m.resetIn !== undefined && m.percent < last - 20
        motions.set(m.name, { from: last, to: m.percent, at: now, isReset })
      }
    },

    paint(meter: Meter, boxes: number, now: number): BarPaint {
      const color = levelColor(meter.percent)
      const motion = motions.get(meter.name)
      const steady = (n: number, c: string): Paint[] =>
        Array.from({ length: boxes }, (_, i) => (i < n ? { color: c, isDim: false } : EMPTY))

      if (motion) {
        const p = plan(motion, boxes)
        const k = now - motion.at
        if (k < p.end) {
          const old = levelColor(motion.from)
          if (k < p.drain) return { boxes: steady(p.a - Math.floor(k / DRAIN_MS), old), isFlashing: false }
          const f = k - p.drain
          if (f < p.fill) {
            const start = motion.isReset ? 0 : p.a
            const moved = Math.floor(f / STEP_MS) + 1
            const n = p.b >= start ? Math.min(p.b, start + moved) : Math.max(p.b, start - moved)
            const shown = steady(n, motion.isReset || !p.isRising ? color : old)
            if (n > start && n - 1 < boxes) shown[n - 1] = GLINT
            return { boxes: shown, isFlashing: false }
          }
          const w = k - p.drain - p.fill
          const front = w / WAVE_MS + 1
          const shown = steady(p.b, old).map((box, i) => (i >= p.b ? box : i < front - 1 ? { color, isDim: false } : i < front ? GLINT : box))
          return { boxes: shown, isFlashing: w < FLASH_MS && w % 200 < 100 }
        }
        motions.delete(meter.name)
      }

      const shown = steady(filledBoxes(meter.percent, boxes), color)
      const last = filledBoxes(meter.percent, boxes) - 1
      if (meter.percent >= 90 && last >= 0) {
        const k = now % BEAT_MS
        const isBeat = k < 120 || (k >= 240 && k < 360)
        shown[last] = { color, isDim: !isBeat }
      }
      return { boxes: shown, isFlashing: false }
    },

    // Whether any bar is moving at this many boxes, so the band knows to keep redrawing.
    isMoving(meters: Meter[], boxes: number, now: number): boolean {
      for (const [name, m] of motions) if (meters.some(x => x.name === name) && now - m.at < plan(m, boxes).end) return true
      return boxes > 0 && meters.some(m => m.percent >= 90)
    },
  }
}
