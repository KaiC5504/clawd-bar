import { describe, expect, test } from 'claude-code/testing'

import { applyEvent, DOZE_AFTER_MS, initialPet, ONE_SHOT_MS, SLEEP_AFTER_MS, visualFor, WAKE_MS, withUsage } from '../hooks/pet-state'

const T0 = 1_000_000

function run(events: [string, Record<string, unknown>][], at = T0) {
  return events.reduce((pet, [event, payload], i) => applyEvent(pet, event, payload, at + i), initialPet(T0))
}

describe('event → act', () => {
  test('a prompt thinks, and each kind of tool has its own scene', () => {
    expect(visualFor(run([['UserPromptSubmit', { prompt: 'hi' }]]), T0 + 10).act).toBe('thinking')

    const working = visualFor(run([['UserPromptSubmit', {}], ['PreToolUse', { tool_name: 'Bash' }]]), T0 + 10)
    expect(working).toEqual({ act: 'working', label: 'Working · Bash', isSweating: false })

    const act = (tool: string) => visualFor(run([['PreToolUse', { tool_name: tool }]]), T0 + 10).act
    expect(act('Edit')).toBe('working')
    expect(act('Write')).toBe('working')
    expect(act('Read')).toBe('reading')
    expect(act('Grep')).toBe('searching')
    expect(act('Glob')).toBe('searching')
    expect(act('WebFetch')).toBe('browsing')
    expect(act('PowerShell')).toBe('working')
    expect(act('mcp__linear__list_issues')).toBe('working')
  })

  test('the Agent tool and subagents juggle, settled by id not by count', () => {
    expect(visualFor(run([['PreToolUse', { tool_name: 'Agent' }]]), T0 + 10).act).toBe('delegating')

    const two = run([['SubagentStart', { agent_id: 'a' }], ['SubagentStart', { agent_id: 'b' }]])
    expect(visualFor(two, T0 + 10).label).toBe('Juggling 2 subagents')

    const strayStop = applyEvent(two, 'SubagentStop', { agent_id: 'zzz' }, T0 + 5)
    expect(strayStop.subagents).toEqual(['a', 'b'])

    const bothDone = applyEvent(applyEvent(two, 'SubagentStop', { agent_id: 'a' }, T0 + 5), 'SubagentStop', { agent_id: 'b' }, T0 + 6)
    expect(visualFor(bothDone, T0 + 10).act).toBe('working')
  })

  test('Stop celebrates, then settles to idle', () => {
    const done = run([['UserPromptSubmit', {}], ['Stop', {}]])
    expect(visualFor(done, T0 + 10).act).toBe('done')
    expect(visualFor(done, T0 + 10 + ONE_SHOT_MS.attention).act).toBe('idle')
  })

  test('failures, compaction and notifications are one-shots', () => {
    expect(visualFor(run([['PostToolUseFailure', {}]]), T0 + 10).act).toBe('error')
    expect(visualFor(run([['StopFailure', {}]]), T0 + 10).act).toBe('error')
    expect(visualFor(run([['PreCompact', {}]]), T0 + 10).act).toBe('compacting')
    expect(visualFor(run([['Notification', {}]]), T0 + 10).label).toBe('Needs you')
    expect(visualFor(run([['SessionStart', { source: 'clear' }]]), T0 + 10).act).toBe('compacting')
  })

  test('an idle session dozes, then sleeps, and wakes on activity', () => {
    const idle = initialPet(T0)
    expect(visualFor(idle, T0 + 1000).act).toBe('idle')
    expect(visualFor(idle, T0 + DOZE_AFTER_MS).act).toBe('dozing')
    expect(visualFor(idle, T0 + SLEEP_AFTER_MS).act).toBe('sleeping')

    const at = T0 + SLEEP_AFTER_MS + 5
    const woken = applyEvent(idle, 'UserPromptSubmit', {}, at)
    expect(visualFor(woken, at + 10).act).toBe('waking')
    expect(visualFor(woken, at + WAKE_MS).act).toBe('thinking')
  })

  test('auto compaction keeps thinking, a manual one goes idle', () => {
    expect(visualFor(run([['PreCompact', {}], ['PostCompact', { trigger: 'auto' }]]), T0 + 10).act).toBe('thinking')
    expect(visualFor(run([['PreCompact', {}], ['PostCompact', { trigger: 'manual' }]]), T0 + 10).act).toBe('idle')
  })

  test('a turn that ends without Stop still settles: interrupted, answered or errored', () => {
    const busy = run([['UserPromptSubmit', {}], ['PreToolUse', { tool_name: 'Bash' }]])
    const stopped = applyEvent(busy, 'TurnEnded', { reason: 'aborted' }, T0 + 5)
    expect(visualFor(stopped, T0 + 10).act).toBe('interrupted')
    expect(visualFor(stopped, T0 + 5 + ONE_SHOT_MS.interrupted).act).toBe('idle')
    // The stuck-turn backstop isn't an interrupt: no skid.
    expect(visualFor(applyEvent(busy, 'TurnEnded', { reason: 'stale' }, T0 + 5), T0 + 10).act).toBe('idle')
    expect(visualFor(applyEvent(busy, 'TurnEnded', { reason: 'answer' }, T0 + 5), T0 + 10).act).toBe('done')
    expect(visualFor(applyEvent(busy, 'TurnEnded', { reason: 'error' }, T0 + 5), T0 + 10).act).toBe('error')

    // After Stop has already settled the turn, its end changes nothing.
    const done = run([['UserPromptSubmit', {}], ['Stop', {}]])
    expect(applyEvent(done, 'TurnEnded', { reason: 'answer' }, T0 + 50)).toBe(done)
  })
})

describe('usage → act', () => {
  const usage = (ctx: number, limits: { percentUsed: number; resetsAt?: string }[] = []) => ({
    context: { percent: ctx },
    rateLimits: limits.map(l => ({ kind: 'five_hour', ...l })),
  })

  test('past 90% context he sweats over whatever he is doing, and says so once', () => {
    const calm = withUsage(initialPet(T0), usage(85), T0)
    expect(visualFor(calm, T0 + 10)).toEqual({ act: 'idle', label: 'Idle', isSweating: false })

    const high = withUsage(calm, usage(91), T0 + 100)
    expect(visualFor(high, T0 + 110)).toEqual({ act: 'idle', label: 'Context almost full', isSweating: true })
    expect(visualFor(high, T0 + 100 + ONE_SHOT_MS.sweating)).toEqual({ act: 'idle', label: 'Idle', isSweating: true })
    const busy = applyEvent(high, 'PreToolUse', { tool_name: 'Edit' }, T0 + 120)
    expect(visualFor(busy, T0 + 130 + ONE_SHOT_MS.sweating)).toEqual({ act: 'working', label: 'Working · Edit', isSweating: true })

    // Still high: nothing changes, and the very same pet comes back.
    expect(withUsage(high, usage(95), T0 + 200)).toBe(high)

    const compacted = withUsage(high, usage(30), T0 + 300)
    expect(compacted.isCtxHigh).toBe(false)
    expect(visualFor(withUsage(compacted, usage(92), T0 + 400), T0 + 410).label).toBe('Context almost full')
  })

  test('a used-up limit leaves him exhausted instead of dozing, with the reset time', () => {
    const resetsAt = new Date(T0 + 18 * 60_000).toISOString()
    const spent = withUsage(initialPet(T0), usage(20, [{ percentUsed: 100, resetsAt }]), T0)
    expect(visualFor(spent, T0 + 10)).toEqual({ act: 'exhausted', label: 'Out of usage · resets in 18m', isSweating: false })
    expect(visualFor(spent, T0 + SLEEP_AFTER_MS).act).toBe('exhausted')

    // A turn still shows the turn, and a one-shot still plays over him.
    expect(visualFor(applyEvent(spent, 'UserPromptSubmit', {}, T0 + 20), T0 + 30).act).toBe('thinking')
    expect(visualFor(applyEvent(spent, 'Notification', {}, T0 + 20), T0 + 30).act).toBe('calling')

    const back = withUsage(spent, usage(20, [{ percentUsed: 3 }]), T0 + 40)
    expect(visualFor(back, T0 + 50).act).toBe('idle')
  })

  test('with several limits used up, the label waits for the last one to reset', () => {
    const soon = new Date(T0 + 30 * 60_000).toISOString()
    const later = new Date(T0 + 3 * 3_600_000).toISOString()
    const spent = withUsage(initialPet(T0), usage(20, [{ percentUsed: 100, resetsAt: soon }, { percentUsed: 100, resetsAt: later }]), T0)
    expect(visualFor(spent, T0).label).toBe('Out of usage · resets in 3h 0m')
    expect(visualFor(withUsage(initialPet(T0), usage(20, [{ percentUsed: 100 }]), T0), T0).label).toBe('Out of usage')
  })

  test('a new session keeps what usage said', () => {
    const high = withUsage(initialPet(T0), usage(93), T0)
    const resumed = applyEvent(high, 'SessionStart', { source: 'resume' }, T0 + 10)
    expect(resumed.isCtxHigh).toBe(true)
    expect(withUsage(resumed, usage(93), T0 + 20)).toBe(resumed)
  })
})
