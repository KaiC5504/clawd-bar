import { describe, expect, test } from 'claude-code/testing'

import { AMBER, GREEN, RED, filledBoxes, levelColor, meters, timeLeft } from '../hooks/usage'

const NOW = Date.parse('2026-10-05T10:00:00Z')
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

describe('usage meters', () => {
  test('the reset countdown is short enough for the band', () => {
    expect(timeLeft(at(42), NOW)).toBe('42m')
    expect(timeLeft(at(62), NOW)).toBe('1h 2m')
    expect(timeLeft(at(84 * 60), NOW)).toBe('3d 12h')
    expect(timeLeft(undefined, NOW)).toBeNull()
  })

  test('context first, then the five-hour and weekly windows, each with its reset countdown', () => {
    const list = meters(
      {
        context: { percent: 61.4 },
        rateLimits: [
          { kind: 'seven_day', percentUsed: 85, resetsAt: at(84 * 60) },
          { kind: 'five_hour', percentUsed: 92, resetsAt: at(62) },
        ],
      },
      NOW,
    )
    expect(list).toEqual([
      { name: 'ctx', percent: 61, color: GREEN },
      { name: '5h', percent: 92, color: RED, resetIn: '1h 2m' },
      { name: 'wk', percent: 85, color: AMBER, resetIn: '3d 12h' },
    ])
  })

  test('green below 80, yellow from 80, red from 90', () => {
    expect(levelColor(79)).toBe(GREEN)
    expect(levelColor(80)).toBe(AMBER)
    expect(levelColor(90)).toBe(RED)
  })

  test('boxes fill by percent, and any use lights at least one', () => {
    expect(filledBoxes(61, 10)).toBe(6)
    expect(filledBoxes(1, 10)).toBe(1)
    expect(filledBoxes(0, 10)).toBe(0)
    expect(filledBoxes(140, 10)).toBe(10)
  })
})
