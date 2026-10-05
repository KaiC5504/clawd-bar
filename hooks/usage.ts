// Claude Code's theme keys, so the band follows the user's theme; raw hex was not drawn.
export const AMBER = 'warning'
export const RED = 'error'
export const GREEN = 'success'

// One gauge: `name` over the bar, `resetIn` under it when the window resets.
export type Meter = { name: string; percent: number; color: string; resetIn?: string }

export type Usage = {
  context: { percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

const ORDER = ['five_hour', 'seven_day']
const NAMES: Record<string, string> = { five_hour: '5h', seven_day: 'wk', spend_limit: 'spend' }

export function levelColor(percent: number): string {
  return percent >= 90 ? RED : percent >= 80 ? AMBER : GREEN
}

// The time until a window resets, short enough for the band: "42m", "1h 2m", "3d 12h".
export function timeLeft(resetsAt: string | undefined, now: number): string | null {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at)) return null
  const minutes = Math.max(0, Math.round((at - now) / 60000))
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function meters(usage: Usage, now: number): Meter[] {
  const ctx = usage.context.percent
  const out: Meter[] = ctx === undefined ? [] : [{ name: 'ctx', percent: Math.round(ctx), color: levelColor(ctx) }]
  const limits = [...usage.rateLimits].sort((a, b) => {
    const i = ORDER.indexOf(a.kind)
    const j = ORDER.indexOf(b.kind)
    return (i < 0 ? 99 : i) - (j < 0 ? 99 : j)
  })
  for (const limit of limits) {
    const resetIn = timeLeft(limit.resetsAt, now)
    out.push({
      name: NAMES[limit.kind] ?? limit.kind,
      percent: Math.round(limit.percentUsed),
      color: levelColor(limit.percentUsed),
      ...(resetIn ? { resetIn } : {}),
    })
  }
  return out
}

export const BOX = '▊'

export function filledBoxes(percent: number, boxes: number): number {
  if (percent <= 0) return 0
  return Math.max(1, Math.min(boxes, Math.round((percent / 100) * boxes)))
}
