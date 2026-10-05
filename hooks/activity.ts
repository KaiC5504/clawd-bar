import type { Activity, TaskItem } from '../types'
import type { HookPayload } from './pet-state'

export const NO_ACTIVITY: Activity = { doing: null, turnStartedAt: null, tools: 0, files: [], lastTurn: null, tasks: [] }

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const base = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

function host(url: string): string {
  return /^[a-z]+:\/\/([^/]+)/i.exec(url)?.[1] ?? url
}

// "Editing sprites.ts", "Running npm test": what a tool call is doing, in a few words.
export function describeTool(tool: string, input: Record<string, unknown>): string {
  const path = str(input.file_path) || str(input.notebook_path)
  switch (tool) {
    case 'Read':
      return `Reading ${base(path)}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${base(path)}`
    case 'Write':
      return `Writing ${base(path)}`
    case 'Bash':
    case 'PowerShell': {
      const description = firstLine(str(input.description))
      return description ? clip(description, 60) : `Running ${clip(firstLine(str(input.command)), 48)}`
    }
    case 'Grep':
      return `Searching "${clip(str(input.pattern), 40)}"`
    case 'Glob':
      return `Finding ${clip(str(input.pattern), 40)}`
    case 'WebFetch':
      return `Reading ${host(str(input.url))}`
    case 'WebSearch':
      return `Searching the web for "${clip(str(input.query), 40)}"`
    case 'Agent':
    case 'Task':
      return `Handing off: ${clip(str(input.description) || 'a subagent', 50)}`
    case 'Skill':
      return `Using the ${str(input.skill) || 'a'} skill`
  }
  if (PLAN_TOOLS.has(tool)) return 'Planning the tasks'
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return `${mcp[2]!.replace(/_/g, ' ')} (${mcp[1]!.replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ')})`
  return `Using ${tool}`
}

export function applyActivity(a: Activity, event: string, payload: HookPayload, now: number): Activity {
  switch (event) {
    case 'SessionStart':
      return { ...NO_ACTIVITY }
    case 'UserPromptSubmit':
      return { ...a, doing: null, turnStartedAt: now, tools: 0, files: [] }
    case 'PreToolUse': {
      const tool = str(payload.tool_name)
      const input = (payload.tool_input ?? {}) as Record<string, unknown>
      const path = str(input.file_path) || str(input.notebook_path)
      const files = EDIT_TOOLS.has(tool) && path && !a.files.includes(path) ? [...a.files, path] : a.files
      return { ...a, doing: describeTool(tool, input), tools: a.tools + 1, files, turnStartedAt: a.turnStartedAt ?? now }
    }
    case 'Stop':
    case 'StopFailure':
    case 'TurnEnded':
      return {
        ...a,
        doing: null,
        turnStartedAt: null,
        lastTurn: a.turnStartedAt === null ? a.lastTurn : { ms: now - a.turnStartedAt, tools: a.tools, files: a.files.length },
      }
    default:
      return a
  }
}

type Todo = { content?: unknown; status?: unknown; activeForm?: unknown }

const status = (value: unknown): TaskItem['status'] =>
  value === 'completed' || value === 'in_progress' ? value : 'pending'

// TodoWrite hands over the whole list every time.
export function withTodos(a: Activity, todos: unknown): Activity {
  if (!Array.isArray(todos)) return a
  const tasks = (todos as Todo[]).map((todo, i): TaskItem => ({
    id: `todo-${i}`,
    subject: str(todo.content),
    activeForm: str(todo.activeForm) || undefined,
    status: status(todo.status),
  }))
  return { ...a, tasks }
}

export function withTaskCreated(a: Activity, id: string, subject: string, activeForm?: string): Activity {
  if (!id || a.tasks.some(task => task.id === id)) return a
  return { ...a, tasks: [...a.tasks, { id, subject, activeForm, status: 'pending' }] }
}

export function withTaskUpdated(a: Activity, id: string, patch: { status?: unknown; subject?: unknown; activeForm?: unknown }): Activity {
  if (patch.status === 'deleted') return { ...a, tasks: a.tasks.filter(task => task.id !== id) }
  return {
    ...a,
    tasks: a.tasks.map(task =>
      task.id !== id
        ? task
        : {
            ...task,
            status: patch.status === undefined ? task.status : status(patch.status),
            subject: str(patch.subject) || task.subject,
            activeForm: str(patch.activeForm) || task.activeForm,
          },
    ),
  }
}

export function taskLine(tasks: TaskItem[]): string | null {
  if (tasks.length === 0 || tasks.every(task => task.status === 'completed')) return null
  const done = tasks.filter(task => task.status === 'completed').length
  const current = tasks.find(task => task.status === 'in_progress') ?? tasks.find(task => task.status === 'pending')
  const what = current ? (current.status === 'in_progress' ? current.activeForm || current.subject : current.subject) : ''
  return `Tasks ${done}/${tasks.length}${what ? ` ▶ ${what}` : ''}`
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function turnLine(a: Activity, subagents: number): string | null {
  if (a.turnStartedAt !== null) {
    if (a.tools === 0 && subagents === 0) return null
    const parts = [plural(a.tools, 'tool')]
    if (a.files.length) parts.push(`${plural(a.files.length, 'file')} changed`)
    if (subagents) parts.push(plural(subagents, 'subagent'))
    return parts.join(' · ')
  }
  if (a.lastTurn) {
    const parts = [`Done in ${took(a.lastTurn.ms)}`, plural(a.lastTurn.tools, 'tool')]
    if (a.lastTurn.files) parts.push(plural(a.lastTurn.files, 'file'))
    return parts.join(' · ')
  }
  return null
}
