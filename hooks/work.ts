import type { Work, WorkResult } from '../types'

// What a tool call is, read from its input, so the band can act out that very
// call: the file type and lines an edit touches, the program a command runs, the
// MCP server a tool belongs to. settleCall adds how it ended.

type Input = Record<string, unknown>

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const lines = (text: string) => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length)
const base = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path

function extOf(path: string): string {
  const name = base(path)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

const words = (segment: string) => (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^["']|["']$/g, ''))

const SETUP = new Set(['cd', 'pushd', 'popd', 'set', 'export', 'source', '.', 'Set-Location', 'sl'])
const WRAPPERS = new Set(['sudo', 'time', 'nohup', 'env', 'command', 'npx', 'bunx', 'pnpx'])
// Two-word runners that hand off to the program after them.
const RUNS: Record<string, string> = { uv: 'run', poetry: 'run', pnpm: 'exec', npm: 'exec', yarn: 'dlx' }

// The program and its arguments, past env settings and the runners that only launch it.
function unwrap(segment: string): string[] {
  const out = words(segment)
  while (out.length > 0) {
    const first = out[0]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || WRAPPERS.has(first)) out.shift()
    else if (RUNS[first] !== undefined && out[1] === RUNS[first]) out.splice(0, 2)
    else break
  }
  if (out.length > 0) out[0] = base(out[0]!).replace(/\.(exe|cmd|bat|ps1)$/i, '')
  return out
}

const TEST_RUNNERS = new Set(['vitest', 'jest', 'pytest', 'mocha', 'ava', 'phpunit', 'rspec', 'ctest'])
const NODE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

function isTests([program = '', a = '', b = '', c = '']: string[]): boolean {
  if (TEST_RUNNERS.has(program)) return true
  if (NODE_MANAGERS.has(program)) return a === 'test' || a === 't' || (a === 'run' && /^test(:|$)/.test(b))
  if (program === 'python' || program === 'python3' || program === 'py') return a === '-m' && (b === 'pytest' || b === 'unittest')
  if (program === 'node') return a === '--test'
  if (program === 'claude') return a === 'plugin' && b === 'test'
  if (['cargo', 'go', 'deno', 'dotnet'].includes(program)) return a === 'test' || (program === 'cargo' && a === 'nextest' && b === 'run')
  if (/^(mvn|gradlew?|\.\/gradlew)$/.test(program)) return [a, b, c].includes('test')
  return false
}

function isInstall([program = '', a = '', b = '']: string[]): boolean {
  if (NODE_MANAGERS.has(program)) return ['i', 'install', 'add', 'ci'].includes(a)
  if (program === 'uv') return a === 'add' || a === 'sync' || (a === 'pip' && b === 'install')
  if (program === 'pip' || program === 'pip3') return a === 'install'
  if (['cargo', 'poetry'].includes(program)) return a === 'add' || a === 'install'
  if (['brew', 'winget', 'choco', 'apt', 'apt-get', 'gem', 'scoop'].includes(program)) return a === 'install'
  return program === 'composer' && (a === 'install' || a === 'require')
}

// A heredoc's body and a quoted string are text, not commands: `git commit -m "bump; pnpm i"`
// must not read as an install. Their separators go before the command line is split.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\b/g
const QUOTED = /"(?:\\.|[^"\\])*"|'[^']*'/g

function shellCall(command: string, isBackground: boolean): Pick<Work, 'kind' | 'cmd'> {
  const text = command.replace(HEREDOC, '').replace(QUOTED, quoted => quoted.replace(/[;|&\n]/g, ' '))
  const segments = text.split(/&&|\|\||[;|\n]/).map(unwrap).filter(w => w.length > 0)
  const main = segments.find(argv => !SETUP.has(argv[0]!)) ?? segments[0]
  // Started in the background, it ends at once with nothing to show: no result to act out yet.
  if (isBackground) return { kind: 'shell', cmd: main?.[0] ?? '' }
  // In a chain, the last test run or install is what it's for: `npm ci && npm test` tests.
  for (const argv of [...segments].reverse()) {
    if (isTests(argv)) return { kind: 'tests', cmd: argv[0]! }
    if (isInstall(argv)) return { kind: 'install', cmd: argv[0]! }
  }
  return { kind: 'shell', cmd: main?.[0] ?? '' }
}

export function classifyCall(tool: string, input: Input, id: string, now: number): Work {
  const call = { id, startedAt: now }
  const path = str(input.file_path) || str(input.notebook_path)
  switch (tool) {
    case 'Edit':
      return { ...call, kind: 'edit', ext: extOf(path), removed: lines(str(input.old_string)), added: lines(str(input.new_string)) }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : []
      const sum = (key: string) => edits.reduce((n, e) => n + lines(str(e[key])), 0)
      return { ...call, kind: 'edit', ext: extOf(path), removed: sum('old_string'), added: sum('new_string') }
    }
    case 'NotebookEdit': {
      const mode = str(input.edit_mode)
      return { ...call, kind: 'edit', ext: extOf(path), removed: mode === 'insert' ? 0 : 1, added: mode === 'delete' ? 0 : lines(str(input.new_source)) }
    }
    case 'Write':
      return { ...call, kind: 'write', ext: extOf(path), lines: lines(str(input.content)) }
    case 'Bash':
    case 'PowerShell':
      return { ...call, ...shellCall(str(input.command), input.run_in_background === true) }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return { ...call, kind: 'mcp', server: mcp[1]!.replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/, '') }
  return { ...call, kind: 'other' }
}

const ANSI = /\u001b\[[0-9;]*m/g

// Passed and failed counts from a test runner's output, or null when it gave none.
export function testCounts(output: string): { passed: number; failed: number } | null {
  const text = output.replace(ANSI, '')
  const num = (re: RegExp) => Number(re.exec(text)?.[1] ?? 0)

  const crates = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)]
  if (crates.length > 0) return crates.reduce((sum, m) => ({ passed: sum.passed + Number(m[1]), failed: sum.failed + Number(m[2]) }), { passed: 0, failed: 0 })
  // node --test: TAP's `# pass 8`, or `ℹ pass 8` from the newer default reporter.
  if (/^(#|ℹ) pass \d+/m.test(text)) return { passed: num(/^(?:#|ℹ) pass (\d+)/m), failed: num(/^(?:#|ℹ) fail (\d+)/m) }
  if (/^\s*\d+ pass\s*$/m.test(text)) return { passed: num(/^\s*(\d+) pass\s*$/m), failed: num(/^\s*(\d+) fail\s*$/m) }
  if (/\d+ passing/.test(text)) return { passed: num(/(\d+) passing/), failed: num(/(\d+) failing/) }

  // vitest and jest also print a files or suites line first; the Tests line is the one that counts.
  const summaries = text.split('\n').filter(line => /\d+ (passed|failed)/.test(line))
  const line = summaries.filter(l => /^\s*Tests:?\s/.test(l)).at(-1) ?? summaries.filter(l => !/^\s*Test (Files|Suites)/.test(l)).at(-1)
  if (!line) return null
  const count = (re: RegExp) => Number(re.exec(line)?.[1] ?? 0)
  return { passed: count(/(\d+) passed/), failed: count(/(\d+) failed/) + count(/(\d+) errors?\b/) }
}

// How the call ended: from PostToolUse (`failed` false) or PostToolUseFailure (true).
export function settleCall(work: Work, payload: Input, failed: boolean, now: number): Work {
  const response = payload.tool_response
  const fields = typeof response === 'object' && response !== null ? (response as Input) : {}
  const output = failed ? str(payload.error) : typeof response === 'string' ? response : `${str(fields.stdout)}\n${str(fields.stderr)}`
  const ms = typeof payload.duration_ms === 'number' ? payload.duration_ms : now - work.startedAt
  const result: WorkResult = { ok: !failed && fields.interrupted !== true, ms }
  const counts = work.kind === 'tests' ? testCounts(output) : null
  return { ...work, result: counts ? { ...result, ...counts } : result }
}
