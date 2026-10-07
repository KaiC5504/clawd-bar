export type ClawdSustainedState = 'idle' | 'thinking' | 'working' | 'juggling'

export type ClawdOneShotState = 'attention' | 'error' | 'notification' | 'sweeping' | 'sweating' | 'interrupted'

export type ClawdPet = {
  state: ClawdSustainedState
  oneShot: { state: ClawdOneShotState; until: number } | null
  subagents: string[]
  tool: string | null
  lastActivityAt: number
  wokeAt: number
  isCtxHigh: boolean
  // Set while a usage limit is used up; resetsAt is when the last of them resets.
  outOfUsage: { resetsAt: string | null } | null
  // The tool call he's acting out; hooks/work.ts reads it from the call.
  work: Work | null
}

export type WorkKind = 'edit' | 'write' | 'shell' | 'tests' | 'install' | 'mcp' | 'other'

// `passed` / `failed`: test counts, when the runner's output gave them.
export type WorkResult = { ok: boolean; ms: number; passed?: number; failed?: number }

// `cmd`: the program a shell call runs (or the package manager, for installs).
export type Work = {
  id: string
  kind: WorkKind
  startedAt: number
  ext?: string
  removed?: number
  added?: number
  lines?: number
  cmd?: string
  server?: string
  result?: WorkResult
}

// What a CI step looks like Clawd is doing; hooks/ci/poses.ts maps step names here.
export type CiPose = 'idle' | 'prep' | 'fetch' | 'sign' | 'build' | 'publish' | 'win' | 'fail'

// What the band acts out; each is a scene in hooks/scenes.ts.
export type ClawdAct =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'reading'
  | 'searching'
  | 'browsing'
  | 'editing'
  | 'writing'
  | 'running'
  | 'ran'
  | 'testing'
  | 'tested'
  | 'installing'
  | 'installed'
  | 'linking'
  | 'delegating'
  | 'calling'
  | 'compacting'
  | 'done'
  | 'error'
  | 'interrupted'
  | 'dozing'
  | 'sleeping'
  | 'waking'
  | 'exhausted'
  | 'ciPrep'
  | 'ciFetch'
  | 'ciSign'
  | 'ciBuild'
  | 'ciPublish'
  | 'ciWin'
  | 'ciFail'

// `isSweating`: context is nearly full, drawn over whatever he is doing.
export type ClawdVisual = { act: ClawdAct; label: string; isSweating?: boolean }

export type TaskItem = { id: string; subject: string; activeForm?: string; status: 'pending' | 'in_progress' | 'completed' }

// This session's turn as the band's lines tell it.
export type Activity = {
  doing: string | null
  turnStartedAt: number | null
  tools: number
  files: string[]
  lastTurn: { ms: number; tools: number; files: number } | null
  tasks: TaskItem[]
}

export type Place = { repo: string; branch: string | null }

export type Provider = 'codemagic' | 'actions'
export type StepState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'
export type RunState = 'queued' | 'running' | 'passed' | 'failed' | 'canceled'

export type Step = { name: string; state: StepState; startedAt?: number; finishedAt?: number }

export type Run = {
  provider: Provider
  id: string
  repo: string
  workflow: string
  label: string
  branch: string
  url: string
  state: RunState
  startedAt?: number
  finishedAt?: number
  steps: Step[]
}

export type PendingLookup = { workflow: string; ref?: string; since: number }

export type Watch = {
  provider: Provider
  id: string
  repo: string
  addedAt: number
  errors: number
  pending?: PendingLookup
  run?: Run
  // The session polling this watch, and when it last did; see LEASE in hooks/ci/watcher.ts.
  owner?: string
  beat?: number
  // Claude was told to end its turn and wait for this one, so a pass still has to wake it.
  isPromised?: boolean
}

export type SplitRecord = { label: string; total: number; steps: { name: string; at: number }[] }

export type LastResult = { run: Run; isNewPB: boolean; at: number; isReplay: boolean }

export type Notice = { text: string; at: number }

export type View = {
  watches: Watch[]
  records: Record<string, SplitRecord>
  last: LastResult | null
  notice: Notice | null
}

declare module 'claude-code' {
  interface PluginState {
    'clawd-bar': {
      pet: ClawdPet
      visual: ClawdVisual
      isHidden: boolean
      activity: Activity
      place: Place | null
      view: View | null
      second: number
      demoStep: number
      barFrame: number
    }
  }
}
