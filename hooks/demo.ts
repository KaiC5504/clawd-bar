import type { Activity, ClawdAct, Run, SplitRecord, View, Work } from '../types'
import { NO_ACTIVITY } from './activity'
import type { SessionShown } from './band'
import type { Meter } from './usage'
import { levelColor } from './usage'

// `/clawd demo`: every state the band can show, one after another, with
// made-up numbers, so the whole look can be checked in a real terminal.
export const DEMO_SCENE_MS = 6000

export type DemoScene = {
  meters: Meter[]
  session?: SessionShown
  sweat?: boolean
  work?: Work
  ci?: View
}

const meter = (name: string, percent: number, resetIn?: string): Meter => ({ name, percent, color: levelColor(percent), ...(resetIn ? { resetIn } : {}) })

const METERS: Meter[] = [meter('ctx', 61), meter('5h', 38, '1h 2m'), meter('wk', 22, '3d 12h')]
const FULL: Meter[] = [meter('ctx', 92), meter('5h', 84, '18m'), meter('wk', 22, '3d 12h')]
const SPENT: Meter[] = [meter('ctx', 34), meter('5h', 100, '18m'), meter('wk', 41, '3d 12h')]
const PLACE = { repo: 'clawd-bar', branch: 'main' }

type SessionSpec = {
  act: ClawdAct
  label: string
  activity?: Partial<Activity>
  subagents?: number
  meters?: Meter[]
  sweat?: boolean
  work?: Omit<Work, 'id' | 'startedAt'>
}

const TASKS: Activity['tasks'] = [
  { id: '1', subject: 'Read ci-watch', status: 'completed' },
  { id: '2', subject: 'Port the watcher', status: 'completed' },
  { id: '3', subject: 'Draw the CI poses', status: 'completed' },
  { id: '4', subject: 'Write the tests', activeForm: 'Writing the tests', status: 'in_progress' },
  { id: '5', subject: 'Update the README', status: 'pending' },
  { id: '6', subject: 'Commit', status: 'pending' },
  { id: '7', subject: 'Ship it', status: 'pending' },
]

const STEPS = ['Preparing runner', 'Fetching sources', 'Install packages', 'Sign the release', 'Build and test', 'Publish release']

const RECORD: SplitRecord = {
  label: 'Actions release',
  total: 430,
  steps: [26, 44, 98, 121, 380, 430].map((at, i) => ({ name: STEPS[i]!, at })),
}

function race(now: number, running: number): Run {
  const startedAt = now - [20, 50, 110, 140, 260, 410][running]! * 1000
  return {
    provider: 'actions',
    id: 'demo',
    repo: 'KaiC5504/clawd-bar',
    workflow: 'release',
    label: 'Actions release',
    branch: 'main',
    url: '',
    state: 'running',
    startedAt,
    steps: STEPS.map((name, i) => ({
      name,
      state: i < running ? 'passed' : i === running ? 'running' : 'pending',
      startedAt: i <= running ? startedAt + (RECORD.steps[i - 1]?.at ?? 0) * 1000 : undefined,
      finishedAt: i < running ? startedAt + RECORD.steps[i]!.at * 1000 : undefined,
    })),
  }
}

function ciView(now: number, running: number | 'passed' | 'failed'): View {
  const base = { records: { 'KaiC5504/clawd-bar#release': RECORD }, notice: null }
  if (typeof running === 'number') {
    return { ...base, watches: [{ provider: 'actions', id: 'demo', repo: 'KaiC5504/clawd-bar', addedAt: now, errors: 0, run: race(now, running) }], last: null }
  }
  const run: Run = {
    ...race(now, 5),
    state: running,
    finishedAt: now - 2000,
    steps: STEPS.map((name, i) => ({ name, state: running === 'failed' && i === 4 ? 'failed' : running === 'failed' && i > 4 ? 'pending' : 'passed' })),
  }
  return { ...base, watches: [], last: { run, isNewPB: running === 'passed', at: now - 1000, isReplay: false } }
}

function session(spec: SessionSpec, now: number, index: number, total: number, sceneAt: number): DemoScene {
  const activity: Activity = { ...NO_ACTIVITY, ...spec.activity }
  if (spec.activity?.turnStartedAt !== undefined && spec.activity.turnStartedAt !== null) activity.turnStartedAt = now - spec.activity.turnStartedAt
  return {
    meters: spec.meters ?? METERS,
    ...(spec.sweat ? { sweat: true } : {}),
    // Each scene is a call of its own, begun when the scene came up.
    ...(spec.work ? { work: { ...spec.work, id: `demo${index}`, startedAt: sceneAt } } : {}),
    session: {
      act: spec.act,
      label: spec.label,
      activity,
      subagents: spec.subagents ?? 0,
      place: PLACE,
      note: `demo ${index + 1}/${total} · /clawd demo to stop`,
    },
  }
}

const RUNNING = { turnStartedAt: 102_000 }

// turnStartedAt in a spec is how long ago the turn began.
const SESSION_SCENES: SessionSpec[] = [
  { act: 'idle', label: 'Idle' },
  { act: 'thinking', label: 'Thinking…', activity: { turnStartedAt: 4000 } },
  { act: 'editing', label: 'Working · Edit', work: { kind: 'edit', ext: 'ts', removed: 2, added: 2 }, activity: { ...RUNNING, doing: 'Editing scenes.ts', tools: 14, files: ['a', 'b', 'c'], tasks: TASKS } },
  { act: 'writing', label: 'Working · Write', work: { kind: 'write', ext: 'md', lines: 120 }, activity: { ...RUNNING, doing: 'Writing CHANGELOG.md', tools: 15, files: ['a', 'b', 'c', 'd'] } },
  { act: 'running', label: 'Working · Bash', work: { kind: 'shell', cmd: 'git' }, activity: { ...RUNNING, doing: 'Running git status', tools: 16, files: ['a', 'b', 'c', 'd'] } },
  { act: 'ran', label: 'Working · Bash', work: { kind: 'shell', cmd: 'tsc', result: { ok: false, ms: 12_000 } }, activity: { ...RUNNING, doing: 'Running tsc --noEmit', tools: 17, files: ['a', 'b', 'c', 'd'] } },
  { act: 'testing', label: 'Working · Bash', work: { kind: 'tests', cmd: 'vitest' }, activity: { ...RUNNING, doing: 'Running npm test', tools: 18, files: ['a', 'b', 'c', 'd'] } },
  { act: 'tested', label: 'Working · Bash', work: { kind: 'tests', cmd: 'vitest', result: { ok: false, ms: 9000, passed: 41, failed: 7 } }, activity: { ...RUNNING, doing: 'Running npm test', tools: 18, files: ['a', 'b', 'c', 'd'] } },
  { act: 'tested', label: 'Working · Bash', work: { kind: 'tests', cmd: 'vitest', result: { ok: true, ms: 8000, passed: 48, failed: 0 } }, activity: { ...RUNNING, doing: 'Running npm test', tools: 20, files: ['a', 'b', 'c', 'd'] } },
  { act: 'installing', label: 'Working · Bash', work: { kind: 'install', cmd: 'pnpm' }, activity: { ...RUNNING, doing: 'Running pnpm add zod', tools: 21, files: ['a', 'b', 'c', 'd'] } },
  { act: 'linking', label: 'Working · mcp__linear__list_issues', work: { kind: 'mcp', server: 'linear' }, activity: { ...RUNNING, doing: 'list issues (linear)', tools: 22, files: ['a', 'b', 'c', 'd'] } },
  { act: 'working', label: 'Working · Bash', activity: { ...RUNNING, doing: 'Running npm run build', tools: 23, files: ['a', 'b', 'c', 'd'] } },
  { act: 'reading', label: 'Working · Read', activity: { ...RUNNING, doing: 'Reading band.tsx', tools: 15, files: ['a', 'b', 'c'] } },
  { act: 'searching', label: 'Working · Grep', activity: { ...RUNNING, doing: 'Searching for blit', tools: 16, files: ['a', 'b', 'c'] } },
  { act: 'browsing', label: 'Working · WebFetch', activity: { ...RUNNING, doing: 'Fetching the changelog', tools: 17, files: ['a', 'b', 'c'] } },
  { act: 'delegating', label: 'Juggling 2 subagents', subagents: 2, activity: { ...RUNNING, doing: 'Handing off: Explore the repo', tools: 4 } },
  { act: 'calling', label: 'Needs you', activity: { ...RUNNING, tools: 3 } },
  { act: 'done', label: 'Done!', activity: { lastTurn: { ms: 134_000, tools: 23, files: 5 } } },
  { act: 'error', label: 'Something broke', activity: { ...RUNNING, tools: 6 } },
  { act: 'interrupted', label: 'Interrupted', activity: { lastTurn: { ms: 41_000, tools: 7, files: 1 } } },
  { act: 'working', label: 'Context almost full', meters: FULL, sweat: true, activity: { ...RUNNING, tools: 38, files: ['a', 'b', 'c', 'd'] } },
  { act: 'compacting', label: 'Compacting', meters: FULL, activity: { ...RUNNING, tools: 41, files: ['a', 'b', 'c', 'd'] } },
  { act: 'dozing', label: 'Dozing', activity: { lastTurn: { ms: 134_000, tools: 23, files: 5 } } },
  { act: 'sleeping', label: 'Zzz', activity: { lastTurn: { ms: 134_000, tools: 23, files: 5 } } },
  { act: 'exhausted', label: 'Out of usage · resets in 18m', meters: SPENT, activity: { lastTurn: { ms: 134_000, tools: 23, files: 5 } } },
  { act: 'waking', label: 'Waking up', activity: { turnStartedAt: 1000 } },
]

// A build at each pose, by the step running (prep, fetch, sign, build, publish), then both endings.
const CI: (number | 'passed' | 'failed')[] = [0, 2, 3, 4, 5, 'passed', 'failed']

export const DEMO_SCENES = SESSION_SCENES.length + CI.length

export function demoScene(elapsedMs: number, now: number): DemoScene {
  const index = Math.floor(elapsedMs / DEMO_SCENE_MS) % DEMO_SCENES
  const spec = SESSION_SCENES[index]
  if (spec) return session(spec, now, index, DEMO_SCENES, now - (elapsedMs % DEMO_SCENE_MS))
  return { meters: METERS, ci: ciView(now, CI[index - SESSION_SCENES.length]!) }
}
