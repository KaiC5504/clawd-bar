import { test, expect } from 'claude-code/testing'
import { recordKey, toRecord, isNewPB, splitRows, liveDelta, lanes, elapsed } from '../../hooks/ci/splits'
import type { Run } from '../../types'

const T0 = 1_000_000
const run = (finished: number[], state: Run['state'] = 'running', current = true): Run => ({
  provider: 'codemagic', id: 'b1', repo: 'acme/rocket', workflow: 'testflight', label: 'Codemagic #10',
  branch: 'main', url: 'u', state, startedAt: T0,
  finishedAt: state === 'passed' ? T0 + finished[finished.length - 1]! * 1000 : undefined,
  steps: ['A', 'B', 'C'].map((name, i) => ({
    name,
    state: i < finished.length ? 'passed' : i === finished.length && current ? 'running' : 'pending',
    startedAt: i === 0 ? T0 : finished[i - 1] !== undefined ? T0 + finished[i - 1]! * 1000 : undefined,
    finishedAt: finished[i] !== undefined ? T0 + finished[i]! * 1000 : undefined,
  })),
})
const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-9
const PB = { label: 'Codemagic #9', total: 300, steps: [{ name: 'A', at: 60 }, { name: 'B', at: 120 }, { name: 'C', at: 300 }] }

test('record key is repo and workflow', () => {
  expect(recordKey(run([]))).toBe('acme/rocket#testflight')
})

test('a passed run becomes a record of cumulative step times', () => {
  expect(toRecord(run([50, 110, 280], 'passed'))).toEqual({
    label: 'Codemagic #10', total: 280, steps: [{ name: 'A', at: 50 }, { name: 'B', at: 110 }, { name: 'C', at: 280 }],
  })
})

test('PB when there is none, or when faster; never for a failed run', () => {
  expect(isNewPB(undefined, run([50, 110, 280], 'passed'))).toBe(true)
  expect(isNewPB(PB, run([50, 110, 280], 'passed'))).toBe(true)
  expect(isNewPB(PB, run([50, 110, 310], 'passed'))).toBe(false)
  expect(isNewPB(PB, run([50, 110], 'failed', false))).toBe(false)
})

test('rows carry pb, time and delta; the running step is current', () => {
  const rows = splitRows(run([50]), PB, T0 + 90_000)
  expect(rows[0]).toEqual({ name: 'A', pb: 60, at: 50, delta: -10, state: 'passed', isCurrent: false })
  expect(rows[1]).toEqual({ name: 'B', pb: 120, at: undefined, delta: undefined, state: 'running', isCurrent: true })
})

test('live delta keeps the last split delta until the current split runs over', () => {
  expect(liveDelta(run([50]), PB, T0 + 90_000)).toBe(-10)
  expect(liveDelta(run([50]), PB, T0 + 130_000)).toBe(10)
  expect(liveDelta(run([50]), undefined, T0 + 90_000)).toBeUndefined()
})

test('lanes move by time along the PB timeline', () => {
  const l = lanes(run([50]), PB, T0 + 90_000)
  expect(near(l.ghost, 90 / 300)).toBe(true)
  // A done (ends at PB 60) + 40s into B, whose PB length is 60s: 60 + 40 = 100 of 300
  expect(near(l.you, 100 / 300)).toBe(true)
  expect(lanes(run([50]), undefined, T0 + 90_000).ghost).toBeUndefined()
})

test('elapsed stops at the finish time', () => {
  expect(elapsed(run([50, 110, 280], 'passed'), T0 + 999_000)).toBe(280)
})
