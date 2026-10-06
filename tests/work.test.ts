import { describe, expect, test } from 'claude-code/testing'

import { classifyCall, settleCall, testCounts } from '../hooks/work'

const T0 = 1_000_000
const call = (tool: string, input: Record<string, unknown>) => classifyCall(tool, input, 'id1', T0)
const shell = (command: string) => call('Bash', { command })

describe('reading a tool call', () => {
  test('an edit counts the lines it takes out and puts in, and knows the file type', () => {
    expect(call('Edit', { file_path: 'D:\\x\\scenes.ts', old_string: 'a\nb\nc', new_string: 'a\nb' })).toEqual({
      id: 'id1',
      kind: 'edit',
      startedAt: T0,
      ext: 'ts',
      removed: 3,
      added: 2,
    })
    expect(call('Edit', { file_path: '/x/main.py', old_string: 'x = 1\n', new_string: '' })).toMatchObject({ ext: 'py', removed: 1, added: 0 })
    expect(call('Edit', { file_path: 'Makefile', old_string: 'a', new_string: 'b' })).toMatchObject({ ext: '', removed: 1, added: 1 })
    const multi = call('MultiEdit', { file_path: 'a.rs', edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: 'd\ne', new_string: '' }] })
    expect(multi).toMatchObject({ kind: 'edit', ext: 'rs', removed: 3, added: 2 })
    expect(call('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'a\nb', edit_mode: 'insert' })).toMatchObject({ kind: 'edit', ext: 'ipynb', removed: 0, added: 2 })
  })

  test('a write counts the lines of the new file', () => {
    expect(call('Write', { file_path: 'README.md', content: '# hi\n\ntext\n' })).toMatchObject({ kind: 'write', ext: 'md', lines: 3 })
  })

  test('a shell call names its program, past cd, env settings and runners', () => {
    expect(shell('git status')).toMatchObject({ kind: 'shell', cmd: 'git' })
    expect(shell('cd /d/Repos/x && git log --oneline | head -5')).toMatchObject({ kind: 'shell', cmd: 'git' })
    expect(shell('FOO=1 BAR=2 node tools/x.mjs')).toMatchObject({ cmd: 'node' })
    expect(shell('npx tsc --noEmit')).toMatchObject({ cmd: 'tsc' })
    expect(shell('uv run python -m build')).toMatchObject({ cmd: 'python' })
    expect(shell('"C:\\Program Files\\nodejs\\node.exe" x.js')).toMatchObject({ cmd: 'node' })
    expect(call('PowerShell', { command: 'Get-ChildItem -Recurse' })).toMatchObject({ kind: 'shell', cmd: 'Get-ChildItem' })
  })

  test('test runs and installs are told apart from other commands, the last part of a chain deciding', () => {
    for (const command of ['npm test', 'pnpm run test', 'npx vitest run', 'uv run pytest -q', 'cargo test', 'go test ./...', 'node --test', 'claude plugin test .', 'cd x && bun test']) {
      expect(shell(command).kind).toBe('tests')
    }
    expect(shell('pnpm add zod')).toMatchObject({ kind: 'install', cmd: 'pnpm' })
    expect(shell('uv sync')).toMatchObject({ kind: 'install', cmd: 'uv' })
    expect(shell('pip install -r requirements.txt')).toMatchObject({ kind: 'install', cmd: 'pip' })
    expect(shell('npm ci && npm test').kind).toBe('tests')
    expect(shell('git commit -m "add the tests"').kind).toBe('shell')
    expect(shell('grep -rn vitest package.json').kind).toBe('shell')
  })

  test('quoted text and heredocs are not commands, wherever their separators fall', () => {
    expect(shell('grep -E "jest|vitest" package.json')).toMatchObject({ kind: 'shell', cmd: 'grep' })
    expect(shell('git commit -m "bump; pnpm install"')).toMatchObject({ kind: 'shell', cmd: 'git' })
    expect(shell("echo 'a && npm test'")).toMatchObject({ kind: 'shell', cmd: 'echo' })
    const heredoc = 'git commit -m "$(cat <<\'EOF\'\nMove the fixtures\n\npytest fixtures moved\nEOF\n)"'
    expect(shell(heredoc)).toMatchObject({ kind: 'shell', cmd: 'git' })
    expect(shell('cat <<EOF > notes.txt\nnpm test\nEOF\nnpm test').kind).toBe('tests')
  })

  test('a command started in the background is a plain command, whatever it runs', () => {
    expect(call('Bash', { command: 'npm test', run_in_background: true })).toMatchObject({ kind: 'shell', cmd: 'npm' })
    expect(call('Bash', { command: 'pnpm install', run_in_background: true }).kind).toBe('shell')
  })

  test('an MCP tool names its server, without the plugin or claude.ai prefix', () => {
    expect(call('mcp__linear__list_issues', {})).toMatchObject({ kind: 'mcp', server: 'linear' })
    expect(call('mcp__claude_ai_Gmail__search_threads', {})).toMatchObject({ kind: 'mcp', server: 'Gmail' })
    expect(call('mcp__plugin_context7_context7__query', {})).toMatchObject({ kind: 'mcp', server: 'context7' })
  })

  test('anything else is other', () => {
    expect(call('Read', { file_path: 'a.ts' })).toEqual({ id: 'id1', kind: 'other', startedAt: T0 })
    expect(call('Skill', {}).kind).toBe('other')
  })
})

describe('settling a call with its result', () => {
  test('a command that ran keeps how long it took', () => {
    const done = settleCall(shell('git status'), { tool_response: { stdout: 'clean', stderr: '', interrupted: false }, duration_ms: 812 }, false, T0 + 900)
    expect(done.result).toEqual({ ok: true, ms: 812 })
    expect(settleCall(shell('ls'), { tool_response: { stdout: '' } }, false, T0 + 300).result).toEqual({ ok: true, ms: 300 })
  })

  test('a failure or an interrupted command is not ok', () => {
    expect(settleCall(shell('tsc'), { error: 'Exit code 2\nerror TS2322' }, true, T0 + 50).result?.ok).toBe(false)
    expect(settleCall(shell('sleep 9'), { tool_response: { stdout: '', interrupted: true } }, false, T0 + 50).result?.ok).toBe(false)
  })

  test('a test run reads its counts from the output, failed or not', () => {
    const failed = settleCall(shell('npx vitest run'), { error: 'Exit code 1\n Test Files  1 failed | 3 passed (4)\n      Tests  7 failed | 41 passed (48)\n' }, true, T0 + 50)
    expect(failed.result).toEqual({ ok: false, ms: 50, passed: 41, failed: 7 })
    const passed = settleCall(shell('pytest'), { tool_response: { stdout: '....\n===== 48 passed in 1.20s =====\n', stderr: '' } }, false, T0 + 50)
    expect(passed.result).toEqual({ ok: true, ms: 50, passed: 48, failed: 0 })
  })

  test('only a test run gets counts', () => {
    expect(settleCall(shell('echo 3 passed'), { tool_response: { stdout: '3 passed' } }, false, T0).result).toEqual({ ok: true, ms: 0 })
  })
})

describe('test counts', () => {
  test('vitest and jest: the Tests line, not the files line', () => {
    expect(testCounts(' Test Files  2 passed (2)\n      Tests  48 passed (48)\n')).toEqual({ passed: 48, failed: 0 })
    expect(testCounts('Test Suites: 1 failed, 3 passed, 4 total\nTests:       2 failed, 30 passed, 32 total\n')).toEqual({ passed: 30, failed: 2 })
  })

  test('pytest counts errors as failures', () => {
    expect(testCounts('=== 3 failed, 10 passed, 1 error in 2.1s ===')).toEqual({ passed: 10, failed: 4 })
  })

  test('cargo sums every crate', () => {
    const out = 'test result: ok. 12 passed; 0 failed; 0 ignored\n\ntest result: FAILED. 4 passed; 2 failed; 0 ignored\n'
    expect(testCounts(out)).toEqual({ passed: 16, failed: 2 })
  })

  test('node --test, bun and claude plugin test, mocha', () => {
    expect(testCounts('# tests 9\n# pass 8\n# fail 1\n')).toEqual({ passed: 8, failed: 1 })
    expect(testCounts('ℹ tests 9\nℹ suites 2\nℹ pass 9\nℹ fail 0\n')).toEqual({ passed: 9, failed: 0 })
    expect(testCounts(' 142 pass\n 0 fail\nRan 142 tests across 17 files. [6.17s]')).toEqual({ passed: 142, failed: 0 })
    expect(testCounts('  41 passing (2s)\n  7 failing\n')).toEqual({ passed: 41, failed: 7 })
  })

  test('colour codes are ignored, and output with no counts gives none', () => {
    expect(testCounts('\u001b[32m      Tests \u001b[39m \u001b[1m\u001b[32m5 passed\u001b[39m (5)')).toEqual({ passed: 5, failed: 0 })
    expect(testCounts('ok  \tgithub.com/x/y\t0.01s')).toBeNull()
  })
})
