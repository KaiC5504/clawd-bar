import { describe, expect, test } from 'claude-code/testing'

import { barMotion, stillBar } from '../hooks/bars'
import type { BarPaint } from '../hooks/bars'
import { AMBER, GREEN, RED, levelColor } from '../hooks/usage'
import type { Meter } from '../hooks/usage'

const T = 1_000_000
const meter = (name: string, percent: number, resetIn?: string): Meter => ({ name, percent, color: levelColor(percent), ...(resetIn ? { resetIn } : {}) })

// Each box as a letter: g/a/r lit green, amber or red, lowercase dimmed, * the glint, . empty.
const look = (paint: BarPaint) =>
  paint.boxes
    .map(b => {
      if (b.color === undefined) return b.isDim ? '.' : '*'
      const letter = b.color === GREEN ? 'G' : b.color === AMBER ? 'A' : b.color === RED ? 'R' : '?'
      return b.isDim ? letter.toLowerCase() : letter
    })
    .join('')

describe('usage bars', () => {
  test('a bar seen for the first time stands still at its value', () => {
    const bars = barMotion()
    bars.see([meter('ctx', 40)], T)
    expect(look(bars.paint(meter('ctx', 40), 10, T))).toBe('GGGG......')
    expect(bars.isMoving([meter('ctx', 40)], 10, T)).toBe(false)
    expect(look(stillBar(meter('ctx', 40), 10))).toBe('GGGG......')
  })

  test('a new value fills in a box at a time, the newest glinting as it lands', () => {
    const bars = barMotion()
    bars.see([meter('ctx', 40)], T)
    bars.see([meter('ctx', 70)], T + 10)
    const at = (k: number) => look(bars.paint(meter('ctx', 70), 10, T + 10 + k))
    expect([at(0), at(110), at(220), at(330)]).toEqual(['GGGG*.....', 'GGGGG*....', 'GGGGGG*...', 'GGGGGGG...'])
    expect(bars.isMoving([meter('ctx', 70)], 10, T + 10 + 330)).toBe(false)
  })

  test('a falling value drains out the same way, with no glint', () => {
    const bars = barMotion()
    bars.see([meter('ctx', 70)], T)
    bars.see([meter('ctx', 50)], T)
    expect(look(bars.paint(meter('ctx', 50), 10, T))).toBe('GGGGGG....')
    expect(look(bars.paint(meter('ctx', 50), 10, T + 220))).toBe('GGGGG.....')
  })

  test('crossing 80 sweeps the new colour across behind a glint and flashes the percent', () => {
    const bars = barMotion()
    bars.see([meter('5h', 77, '1h')], T)
    bars.see([meter('5h', 84, '1h')], T)
    const at = (k: number) => bars.paint(meter('5h', 84, '1h'), 10, T + k)
    expect(look(at(0))).toBe('*GGGGGGG..')
    expect(look(at(135))).toBe('AAA*GGGG..')
    expect([at(150).isFlashing, at(250).isFlashing, at(350).isFlashing, at(700).isFlashing]).toEqual([false, true, false, false])
    expect(look(at(2000))).toBe('AAAAAAAA..')
  })

  test('from 90 the last box beats twice and rests, for as long as the bar is that full', () => {
    const bars = barMotion()
    bars.see([meter('wk', 93)], T)
    const at = (k: number) => look(bars.paint(meter('wk', 93), 10, k))
    expect([at(16_000), at(16_200), at(16_300), at(16_800)]).toEqual(['RRRRRRRRR.', 'RRRRRRRRr.', 'RRRRRRRRR.', 'RRRRRRRRr.'])
    expect(bars.isMoving([meter('wk', 93)], 10, T)).toBe(true)
  })

  test('a window that resets drains away in its old colour, then fills back green', () => {
    const bars = barMotion()
    bars.see([meter('5h', 97, '0m')], T)
    bars.see([meter('5h', 3, '4h 59m')], T)
    const at = (k: number) => look(bars.paint(meter('5h', 3, '4h 59m'), 10, T + k))
    expect([at(0), at(175), at(340), at(350), at(460)]).toEqual(['RRRRRRRRRR', 'RRRRR.....', 'R.........', '*.........', 'G.........'])
  })
})
