import type { ClawdAct, ClawdOneShotState, ClawdPet, ClawdVisual } from '../types'
import { timeLeft } from './usage'
import type { Usage } from './usage'

export type HookPayload = Record<string, unknown>

const AGENT_TOOLS = new Set(['Task', 'Agent'])

// How long each one-shot shows before the sustained state comes back.
export const ONE_SHOT_MS: Record<ClawdOneShotState, number> = {
  attention: 4000,
  error: 5000,
  notification: 6000,
  sweeping: 4000,
  sweating: 4000,
  interrupted: 2400,
}
export const DOZE_AFTER_MS = 60_000
export const SLEEP_AFTER_MS = 600_000
export const WAKE_MS = 1500
export const HIGH_CONTEXT = 90

// Sweating has no act of its own: he keeps doing what he was, with the drop on top.
const ONE_SHOT_ACT: Record<Exclude<ClawdOneShotState, 'sweating'>, ClawdAct> = {
  attention: 'done',
  error: 'error',
  notification: 'calling',
  sweeping: 'compacting',
  interrupted: 'interrupted',
}

const LABELS: Partial<Record<ClawdAct, string>> = {
  idle: 'Idle',
  thinking: 'Thinking…',
  delegating: 'Juggling',
  done: 'Done!',
  error: 'Something broke',
  calling: 'Needs you',
  compacting: 'Compacting',
  interrupted: 'Interrupted',
  dozing: 'Dozing',
  sleeping: 'Zzz',
  waking: 'Waking up',
  exhausted: 'Out of usage',
}
const SWEATING_LABEL = 'Context almost full'

const TOOL_ACTS: Record<string, ClawdAct> = {
  Read: 'reading',
  Grep: 'searching',
  Glob: 'searching',
  LS: 'searching',
  WebFetch: 'browsing',
  WebSearch: 'browsing',
}

// What a tool looks like: anything not listed (edits, Bash, PowerShell, MCP tools…) is plain work.
export const toolAct = (tool: string | null): ClawdAct => (tool ? (TOOL_ACTS[tool] ?? 'working') : 'working')

export function initialPet(now: number): ClawdPet {
  return { state: 'idle', oneShot: null, subagents: [], tool: null, lastActivityAt: now, wokeAt: 0, isCtxHigh: false, outOfUsage: null }
}

function oneShot(state: ClawdOneShotState, now: number): ClawdPet['oneShot'] {
  return { state, until: now + ONE_SHOT_MS[state] }
}

function text(payload: HookPayload, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value ? value : null
}

// Same event → state table as Clawd on Desk's hooks/clawd-hook.js, for this one session.
export function applyEvent(pet: ClawdPet, event: string, payload: HookPayload, now: number): ClawdPet {
  const wasAsleep = pet.state === 'idle' && pet.oneShot === null && now - pet.lastActivityAt >= DOZE_AFTER_MS
  const next: ClawdPet = {
    ...pet,
    lastActivityAt: now,
    wokeAt: wasAsleep ? now : pet.wokeAt,
  }
  const busy = (): ClawdPet['state'] => (next.subagents.length > 0 ? 'juggling' : 'working')

  switch (event) {
    case 'SessionStart':
      return {
        ...initialPet(now),
        oneShot: text(payload, 'source') === 'clear' ? oneShot('sweeping', now) : null,
        wokeAt: next.wokeAt,
        isCtxHigh: pet.isCtxHigh,
        outOfUsage: pet.outOfUsage,
      }
    case 'UserPromptSubmit':
      return { ...next, state: 'thinking', tool: null, oneShot: null }
    case 'PreToolUse': {
      const tool = text(payload, 'tool_name')
      return { ...next, tool, state: tool && AGENT_TOOLS.has(tool) ? 'juggling' : busy() }
    }
    case 'PostToolUse':
      return { ...next, state: busy() }
    case 'PostToolUseFailure':
      return { ...next, state: busy(), oneShot: oneShot('error', now) }
    case 'SubagentStart': {
      const id = text(payload, 'agent_id')
      const subagents = id && !next.subagents.includes(id) ? [...next.subagents, id] : next.subagents
      return { ...next, subagents, state: 'juggling' }
    }
    case 'SubagentStop': {
      // SubagentStop is not 1:1 with SubagentStart: settle by id, never by count.
      const id = text(payload, 'agent_id')
      next.subagents = next.subagents.filter(one => one !== id)
      return { ...next, state: busy() }
    }
    case 'Stop':
      return { ...next, state: 'idle', subagents: [], tool: null, oneShot: oneShot('attention', now) }
    case 'StopFailure':
      return { ...next, state: 'idle', subagents: [], tool: null, oneShot: oneShot('error', now) }
    case 'TurnEnded': {
      // Every way a turn ends, Stop or not: an interrupt or an API error fires no Stop hook.
      if (pet.state === 'idle') return pet
      const reason = text(payload, 'reason')
      const ended =
        reason === 'answer'
          ? oneShot('attention', now)
          : reason === 'error' || reason === 'refusal'
            ? oneShot('error', now)
            : reason === 'aborted'
              ? oneShot('interrupted', now)
              : null
      return { ...next, state: 'idle', subagents: [], tool: null, oneShot: ended }
    }
    case 'PreCompact':
      return { ...next, oneShot: oneShot('sweeping', now) }
    case 'PostCompact':
      return { ...next, oneShot: null, state: text(payload, 'trigger') === 'manual' ? 'idle' : 'thinking' }
    case 'Notification':
    case 'Elicitation':
      return { ...next, oneShot: oneShot('notification', now) }
    default:
      return pet
  }
}

// Usage isn't a hook event, so it doesn't count as activity. Returns `pet` itself when
// nothing changed, so callers can skip the write.
export function withUsage(pet: ClawdPet, usage: Usage, now: number): ClawdPet {
  const ctx = usage.context.percent
  const isCtxHigh = ctx !== undefined && ctx >= HIGH_CONTEXT
  const spent = usage.rateLimits.filter(limit => limit.percentUsed >= 100)
  const resets = spent.map(limit => limit.resetsAt).filter((at): at is string => !!at && !Number.isNaN(Date.parse(at)))
  const resetsAt = resets.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null
  const outOfUsage = spent.length > 0 ? { resetsAt } : null
  // A pet from before a hot reload may lack the usage fields.
  const wasCtxHigh = pet.isCtxHigh === true
  const isSameOut = pet.outOfUsage ? pet.outOfUsage.resetsAt === outOfUsage?.resetsAt : outOfUsage === null
  if (isCtxHigh === wasCtxHigh && isSameOut) return pet
  return { ...pet, isCtxHigh, outOfUsage, oneShot: isCtxHigh && !wasCtxHigh ? oneShot('sweating', now) : pet.oneShot }
}

export function visualFor(pet: ClawdPet, now: number): ClawdVisual {
  const seen = sustained(pet, now)
  const isSweating = pet.isCtxHigh === true
  const shot = pet.oneShot && now < pet.oneShot.until ? pet.oneShot.state : null
  if (shot === 'sweating') return { ...seen, label: SWEATING_LABEL, isSweating }
  if (shot) return { act: ONE_SHOT_ACT[shot], label: LABELS[ONE_SHOT_ACT[shot]] ?? shot, isSweating }
  return { ...seen, isSweating }
}

function sustained(pet: ClawdPet, now: number): ClawdVisual {
  const show = (act: ClawdAct, label = LABELS[act] ?? act): ClawdVisual => ({ act, label })

  if (pet.wokeAt > 0 && now - pet.wokeAt < WAKE_MS) return show('waking')

  switch (pet.state) {
    case 'thinking':
      return show('thinking')
    case 'working':
      return show(toolAct(pet.tool), pet.tool ? `Working · ${pet.tool}` : 'Working')
    case 'juggling': {
      const count = Math.max(1, pet.subagents.length)
      return show('delegating', count === 1 ? 'Juggling 1 subagent' : `Juggling ${count} subagents`)
    }
    case 'idle': {
      if (pet.outOfUsage) {
        const left = timeLeft(pet.outOfUsage.resetsAt ?? undefined, now)
        return show('exhausted', left ? `Out of usage · resets in ${left}` : LABELS.exhausted)
      }
      const idleMs = now - pet.lastActivityAt
      if (idleMs >= SLEEP_AFTER_MS) return show('sleeping')
      if (idleMs >= DOZE_AFTER_MS) return show('dozing')
      return show('idle')
    }
  }
}
