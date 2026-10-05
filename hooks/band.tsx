import type { Activity, CiPose, ClawdAct, LastResult, Place, Run, View } from '../types'
import { clock, taskLine, turnLine } from './activity'
import { RESULT_MS, fmt, fmtDelta } from './ci/messages'
import { poseForStep } from './ci/poses'
import { elapsed, lanes, liveDelta, recordKey } from './ci/splits'
import { AMBER, BOX, GREEN, RED } from './usage'
import type { Meter } from './usage'
import { stillBar } from './bars'
import type { BarPaint, Paint } from './bars'

// The surface's element table, as $.ui.resolve(e) hands it over.
type Els = { Box: any; Text: any }

const BLUE = 'suggestion'
const STEP_W = 24
// Long enough to read the race; any longer only stretches the dots across a wide terminal.
const LANE_W = 30
const BRANCH = '⎇'

const CI_ACTS: Record<CiPose, ClawdAct> = {
  idle: 'ciPrep',
  prep: 'ciPrep',
  fetch: 'ciFetch',
  sign: 'ciSign',
  build: 'ciBuild',
  publish: 'ciPublish',
  win: 'ciWin',
  fail: 'ciFail',
}

const clip = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s)
const repoName = (slug: string) => slug.split('/').pop() ?? slug

export function placeText(place: Place | null): string {
  if (!place) return ''
  return place.branch ? `${place.repo} · ${BRANCH} ${place.branch}` : place.repo
}

// --- CI race --------------------------------------------------------------

export type CiShown = { pose: CiPose; act: ClawdAct; run?: Run; last?: LastResult }

const freshResult = (view: View | null, now: number) =>
  view?.last && now - view.last.at < RESULT_MS ? view.last : undefined

// What the band shows for CI right now, or nothing when no build is live or just done.
export function ciShown(view: View | null, now: number): CiShown | null {
  const run = view?.watches.find(w => w.run)?.run
  if (run) {
    const pose = poseForStep(run.steps.find(s => s.state === 'running')?.name ?? 'prepar')
    return { pose, act: CI_ACTS[pose], run }
  }
  const last = freshResult(view, now)
  if (!last) return null
  const pose: CiPose = last.isReplay ? 'idle' : last.run.state === 'passed' ? 'win' : last.run.state === 'failed' ? 'fail' : 'idle'
  return { pose, act: CI_ACTS[pose], last }
}

export function ciLines(els: Els, shown: CiShown, view: View | null, now: number, width: number) {
  return shown.run ? live(els, shown.run, view, now, width) : result(els, shown.last!)
}

function live({ Box, Text }: Els, run: Run, view: View | null, now: number, width: number) {
  const rec = view?.records[recordKey(run)]
  const lane = lanes(run, rec, now)
  const delta = liveDelta(run, rec, now)
  const laneW = Math.min(LANE_W, Math.max(8, width - 6 - 2 - STEP_W - 1))
  const track = (p: number, ch: string) => `${'━'.repeat(Math.round(p * laneW))}${ch}`.padEnd(laneW + 1, '·')
  const more = (view?.watches.length ?? 1) - 1
  const cur = run.steps.find(s => s.state === 'running')
  const idx = cur ? run.steps.indexOf(cur) + 1 : run.steps.filter(s => s.state === 'passed').length
  const step = cur ? `${clip(cur.name, STEP_W - 8)} ${idx}/${run.steps.length}` : run.state === 'queued' ? 'queued' : 'starting'

  return [
    // As wide as the lanes, so the clock sits over the end of the race rather than the terminal's edge.
    <Box key="title" flexDirection="row" justifyContent="space-between" width={Math.min(width, 6 + laneW + 1 + 2 + STEP_W)}>
      <Text bold wrap="truncate-end">
        {run.label}
        <Text dimColor>
          {' '}· {repoName(run.repo)} · {BRANCH} {run.branch}
          {more > 0 ? ` · +${more} more` : ''}
        </Text>
      </Text>
      <Text>
        <Text bold>{fmt(elapsed(run, now))}</Text>
        {delta !== undefined ? <Text color={delta <= 0 ? GREEN : RED}> {fmtDelta(delta)}</Text> : ''}
      </Text>
    </Box>,
    <Text key="you" wrap="truncate-end">
      <Text color={AMBER}>you   </Text>
      {track(lane.you, '▶')}  <Text color={BLUE}>● </Text>
      {step}
    </Text>,
    <Text key="ghost" dimColor wrap="truncate-end">
      {lane.ghost !== undefined ? `ghost ${track(lane.ghost, '▷')}` : 'first run · setting the PB'}
    </Text>,
  ]
}

function result({ Text }: Els, last: LastResult) {
  const r = last.run
  const color = r.state === 'passed' ? GREEN : r.state === 'failed' ? RED : undefined
  const mark = r.state === 'passed' ? '✓' : r.state === 'failed' ? '✗' : '–'

  return [
    <Text key="title" bold wrap="truncate-end">
      <Text color={color}>
        {mark} {r.label} {r.state}
      </Text>
      <Text dimColor> · {fmt(elapsed(r, r.finishedAt ?? 0))}</Text>
      {last.isNewPB ? <Text color={AMBER}>  NEW PB</Text> : ''}
    </Text>,
    <Text key="where" dimColor wrap="truncate-end">
      {repoName(r.repo)} · {BRANCH} {r.branch}
    </Text>,
    <Text key="blank"> </Text>,
  ]
}

// --- Session --------------------------------------------------------------

export type SessionShown = {
  act: ClawdAct
  label: string
  activity: Activity
  subagents: number
  place: Place | null
  note?: string
}

const ACT_COLOR: Partial<Record<ClawdAct, string>> = {
  calling: AMBER,
  error: RED,
  interrupted: AMBER,
  done: GREEN,
  compacting: BLUE,
}

const WORKING: ReadonlySet<ClawdAct> = new Set(['working', 'reading', 'searching', 'browsing'])

function headline(shown: SessionShown): string {
  const { act, label, activity } = shown
  if (WORKING.has(act)) return activity.doing ?? label
  if (act === 'idle' && activity.lastTurn) return 'Idle'
  return label
}

// `turnClock` stands in for the clock text where the surface ticks it itself.
export function sessionLines({ Box, Text }: Els, shown: SessionShown, now: number, turnClock?: unknown) {
  const { activity } = shown
  const running = activity.turnStartedAt !== null
  const second = taskLine(activity.tasks) ?? turnLine(activity, shown.subagents)
  const isAsleep = shown.act === 'dozing' || shown.act === 'sleeping'

  return [
    <Box key="title" flexDirection="row" justifyContent="space-between">
      <Text bold color={ACT_COLOR[shown.act]} dimColor={isAsleep} wrap="truncate-end">
        {headline(shown)}
      </Text>
      {running ? (turnClock ?? <Text bold>{clock(now - activity.turnStartedAt!)}</Text>) : <Text bold>{''}</Text>}
    </Box>,
    <Text key="turn" dimColor={!running} wrap="truncate-end">
      {second ?? ' '}
    </Text>,
    <Text key="place" dimColor wrap="truncate-end">
      {[placeText(shown.place), shown.note].filter(Boolean).join(' · ') || ' '}
    </Text>,
  ]
}

// --- Usage gauges -------------------------------------------------------

// How the band fits a width: boxes per bar (0 drops the bars and keeps the
// percents), whether the gauges show at all, whether they stack one meter to a
// row, and the columns they take.
export type Fit = { boxes: number; gauges: boolean; isStacked: boolean; width: number }

const GAP = 2
const MIN_TEXT = 28
const BOX_STEPS = [10, 8, 6, 4]

// `boxCols` is how many columns one ▊ takes: 1 in a terminal, wider in the desktop's font.
const barWidth = (boxes: number, boxCols: number) => (boxes > 0 ? Math.ceil(boxes * boxCols) + 1 : 0)
const reset = (m: Meter) => (m.resetIn ? `↻ ${m.resetIn}` : '')

// Side by side: a column per meter, three rows each.
function columnsWidth(meters: Meter[], boxes: number, boxCols: number): number {
  const one = (m: Meter) => Math.max(m.name.length, barWidth(boxes, boxCols) + `${m.percent}%`.length, reset(m).length)
  return meters.reduce((sum, m) => sum + one(m) + GAP, 0)
}

// Stacked: a row per meter, its name, bar, percent and countdown in columns.
function stackWidth(meters: Meter[], boxes: number, boxCols: number): number {
  const widest = (f: (m: Meter) => string) => Math.max(...meters.map(m => f(m).length))
  const resets = widest(reset)
  return widest(m => m.name) + 1 + barWidth(boxes, boxCols) + widest(m => `${m.percent}%`) + (resets ? 2 + resets : 0) + GAP
}

// Shrink the bars before the text; drop the bars, then the gauges, before Clawd.
// Stacked suits the desktop, whose text runs wide and has no smaller size.
export function fitBand(columns: number, clawd: number, meters: Meter[], maxBoxes = 10, boxCols = 1, isStacked = false): Fit {
  const none = { boxes: 0, gauges: false, isStacked, width: 0 }
  if (meters.length === 0) return none
  for (const boxes of [...BOX_STEPS.filter(n => n <= maxBoxes), 0]) {
    const width = isStacked ? stackWidth(meters, boxes, boxCols) : columnsWidth(meters, boxes, boxCols)
    if (clawd + GAP + width + 2 + MIN_TEXT <= columns) return { boxes, gauges: true, isStacked, width }
  }
  return none
}

// The bar as runs of boxes painted alike, a Text each.
function bar({ Text }: Els, paint: BarPaint) {
  const runs: { box: Paint; n: number }[] = []
  for (const box of paint.boxes) {
    const last = runs.at(-1)
    if (last && last.box.color === box.color && last.box.isDim === box.isDim) last.n++
    else runs.push({ box, n: 1 })
  }
  return runs.map(({ box, n }, i) => (
    <Text key={i} color={box.color} dimColor={box.isDim}>
      {BOX.repeat(n)}
    </Text>
  ))
}

const percent = ({ Text }: Els, m: Meter, isFlashing = false) => (
  <Text bold inverse={isFlashing} color={m.percent >= 80 ? m.color : undefined}>
    {m.percent}%
  </Text>
)

// Side by side: `ctx` over `▊▊▊▊▊▊▊▊▊▊ 34%` over `↻ 2h 0m`. Stacked: `ctx ▊▊▊▊▊ 34% ↻ 2h 0m` a row each.
// `paint` draws a moving bar; left out, each bar stands still at its value.
export function gaugeColumns(els: Els, meters: Meter[], fit: Fit, paint: (m: Meter, boxes: number) => BarPaint = stillBar) {
  const { Box, Text } = els
  if (!fit.gauges) return []
  const paints = meters.map(m => paint(m, fit.boxes))
  if (fit.isStacked) {
    const column = (key: string, cell: (m: Meter, i: number) => unknown, marginRight = 1) => (
      <Box key={key} flexDirection="column" marginRight={marginRight} flexShrink={0}>
        {meters.map(cell)}
      </Box>
    )
    return [
      column('names', (m, i) => <Text key={i} dimColor>{m.name}</Text>),
      fit.boxes > 0 ? column('bars', (_, i) => <Text key={i}>{bar(els, paints[i]!)}</Text>) : null,
      column('percents', (m, i) => <Box key={i} justifyContent="flex-end">{percent(els, m, paints[i]!.isFlashing)}</Box>, meters.some(m => m.resetIn) ? 2 : GAP),
      meters.some(m => m.resetIn) ? column('resets', (m, i) => <Text key={i} dimColor>{reset(m) || ' '}</Text>, GAP) : null,
    ]
  }
  return meters.map((m, i) => (
    <Box key={`g${i}`} flexDirection="column" marginRight={GAP} flexShrink={0}>
      <Text dimColor>{m.name}</Text>
      <Text>
        {fit.boxes > 0 ? bar(els, paints[i]!) : ''}
        {fit.boxes > 0 ? ' ' : ''}
        {percent(els, m, paints[i]!.isFlashing)}
      </Text>
      <Text dimColor>{reset(m) || ' '}</Text>
    </Box>
  ))
}

export const divider = ({ Text }: Els) => (
  <Text key="divider" dimColor>
    {'│\n│\n│'}
  </Text>
)
