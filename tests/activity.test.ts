import { describe, expect, test } from 'claude-code/testing'

import {
  NO_ACTIVITY, applyActivity, clock, describeTool, taskLine, took, turnLine, withTaskCreated, withTaskUpdated, withTodos,
} from '../hooks/activity'

describe('what a tool call is doing', () => {
  test('files by name, commands by their description, searches by pattern', () => {
    expect(describeTool('Edit', { file_path: 'C:\\src\\clawd-bar\\hooks\\sprites.ts' })).toBe('Editing sprites.ts')
    expect(describeTool('Read', { file_path: '/home/me/README.md' })).toBe('Reading README.md')
    expect(describeTool('Write', { file_path: 'a/b.txt' })).toBe('Writing b.txt')
    expect(describeTool('Bash', { command: 'npm test', description: 'Run the test suite' })).toBe('Run the test suite')
    expect(describeTool('PowerShell', { command: 'npm test\nmore' })).toBe('Running npm test')
    expect(describeTool('Grep', { pattern: 'applyEvent' })).toBe('Searching "applyEvent"')
    expect(describeTool('WebFetch', { url: 'https://docs.example.com/x' })).toBe('Reading docs.example.com')
    expect(describeTool('Agent', { description: 'Explore the repo' })).toBe('Handing off: Explore the repo')
    expect(describeTool('TaskUpdate', { taskId: '1' })).toBe('Planning the tasks')
    expect(describeTool('mcp__notes__sync_now', {})).toBe('sync now (notes)')
    expect(describeTool('Mystery', {})).toBe('Using Mystery')
  })
})

describe('a turn', () => {
  test('counts tools and the files it changed, then sums up when it ends', () => {
    let a = applyActivity(NO_ACTIVITY, 'UserPromptSubmit', {}, 1000)
    expect(turnLine(a, 0)).toBeNull()
    a = applyActivity(a, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'x.ts' } }, 2000)
    a = applyActivity(a, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'x.ts' } }, 3000)
    a = applyActivity(a, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'x.ts' } }, 4000)
    expect(a.doing).toBe('Editing x.ts')
    expect(turnLine(a, 2)).toBe('3 tools · 1 file changed · 2 subagents')

    a = applyActivity(a, 'Stop', {}, 135_000)
    expect(a.turnStartedAt).toBeNull()
    expect(turnLine(a, 0)).toBe('Done in 2m 14s · 3 tools · 1 file')
  })

  test('clocks and durations read like a person would say them', () => {
    expect(clock(102_000)).toBe('1:42')
    expect(clock(3_725_000)).toBe('1:02:05')
    expect(took(42_000)).toBe('42s')
    expect(took(3_900_000)).toBe('1h 5m')
  })
})

describe('the task list', () => {
  test('TodoWrite replaces the list; the line names the task in progress', () => {
    const a = withTodos(NO_ACTIVITY, [
      { content: 'Write the tests', status: 'completed', activeForm: 'Writing the tests' },
      { content: 'Fix the band', status: 'in_progress', activeForm: 'Fixing the band' },
      { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' },
    ])
    expect(taskLine(a.tasks)).toBe('Tasks 1/3 ▶ Fixing the band')
  })

  test('TaskCreate and TaskUpdate follow tasks by id, and a finished list goes quiet', () => {
    let a = withTaskCreated(NO_ACTIVITY, '1', 'Plan', 'Planning')
    a = withTaskCreated(a, '2', 'Build')
    a = withTaskUpdated(a, '1', { status: 'in_progress' })
    expect(taskLine(a.tasks)).toBe('Tasks 0/2 ▶ Planning')
    a = withTaskUpdated(a, '1', { status: 'completed' })
    expect(taskLine(a.tasks)).toBe('Tasks 1/2 ▶ Build')
    a = withTaskUpdated(a, '2', { status: 'deleted' })
    expect(taskLine(a.tasks)).toBeNull()
  })
})
