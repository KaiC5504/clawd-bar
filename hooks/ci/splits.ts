import type { Run, SplitRecord, StepState } from '../../types'

export type SplitRow = { name: string; pb?: number; at?: number; delta?: number; state: StepState; isCurrent: boolean }

const secs = (run: Run, t: number | undefined) =>
  t === undefined || run.startedAt === undefined ? undefined : Math.round((t - run.startedAt) / 1000)

export const recordKey = (run: Run) => `${run.repo}#${run.workflow}`

export function elapsed(run: Run, now: number) {
  if (run.startedAt === undefined) return 0
  return Math.max(0, Math.round(((run.finishedAt ?? now) - run.startedAt) / 1000))
}

export function toRecord(run: Run): SplitRecord {
  return {
    label: run.label,
    total: elapsed(run, run.finishedAt ?? run.startedAt ?? 0),
    steps: run.steps.flatMap(s => {
      const at = secs(run, s.finishedAt)
      return at === undefined ? [] : [{ name: s.name, at }]
    }),
  }
}

export function isNewPB(prev: SplitRecord | undefined, run: Run) {
  if (run.state !== 'passed') return false
  return prev === undefined || toRecord(run).total < prev.total
}

export function splitRows(run: Run, rec: SplitRecord | undefined, now: number): SplitRow[] {
  void now
  return run.steps.map(s => {
    const pb = rec?.steps.find(p => p.name === s.name)?.at
    const at = s.state === 'passed' ? secs(run, s.finishedAt) : undefined
    return {
      name: s.name,
      pb,
      at,
      delta: at !== undefined && pb !== undefined ? at - pb : undefined,
      state: s.state,
      isCurrent: s.state === 'running',
    }
  })
}

export function liveDelta(run: Run, rec: SplitRecord | undefined, now: number) {
  if (!rec) return undefined
  const rows = splitRows(run, rec, now)
  const done = rows.filter(r => r.delta !== undefined)
  const last = done.length ? done[done.length - 1]!.delta! : 0
  const cur = rows.find(r => r.isCurrent)
  if (cur?.pb === undefined) return last
  return Math.max(last, elapsed(run, now) - cur.pb)
}

export function lanes(run: Run, rec: SplitRecord | undefined, now: number): { you: number; ghost?: number } {
  const t = elapsed(run, now)
  if (!rec || rec.total <= 0) {
    const done = run.steps.filter(s => s.state === 'passed').length
    return { you: run.steps.length ? done / run.steps.length : 0 }
  }
  const ghost = Math.min(1, t / rec.total)
  if (run.state === 'passed') return { you: 1, ghost }
  let pbEnd = 0
  for (const s of run.steps) {
    const pbAt = rec.steps.find(p => p.name === s.name)?.at
    if (s.state === 'passed') {
      if (pbAt !== undefined) pbEnd = pbAt
      continue
    }
    if (s.state === 'running' && pbAt !== undefined) {
      const into = s.startedAt !== undefined ? (now - s.startedAt) / 1000 : 0
      const len = Math.max(1, pbAt - pbEnd)
      return { you: Math.min(1, (pbEnd + Math.min(len, into)) / rec.total), ghost }
    }
    break
  }
  return { you: Math.min(1, pbEnd / rec.total), ghost }
}
