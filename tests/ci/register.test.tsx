import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const STARTED = { stdout: 'started b77 on main\n', stderr: '', interrupted: false }
const REMOTE = { exitCode: 0, stdout: 'https://github.com/acme/rocket.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

// The kit's `$` has no store noun, so the store lives here where tests can read it.
function memStore(on: On, init: Record<string, unknown> = {}) {
  const mem: Record<string, unknown> = JSON.parse(JSON.stringify(init))
  on('store.get', (_$, e) => ({ value: mem[(e as { key: string }).key] }))
  on('store.set', (_$, e) => { const { key, value } = e as { key: string; value: unknown }; mem[key] = JSON.parse(JSON.stringify(value)); return { value: undefined } })
  on('store.delete', (_$, e) => { delete mem[(e as { key: string }).key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(mem) }))
  return mem
}

type RunAnswer = { exitCode: number; stdout: string; stderr: string }

// Every hook test needs these answered: the store, the clock, the UI calls, the token,
// the session id, and `git remote` (the mod asks which repo it is in).
function quiet(on: On, init?: Record<string, unknown>, opts: { run?: (argv: string[]) => RunAnswer } = {}) {
  const mem = memStore(on, init)
  mock.clock(on, { now: Date.parse('2026-10-05T10:00:00Z') })
  const env: Record<string, string> = { CODEMAGIC_API_TOKEN: 'tok' }
  on('env.get', (_$, e) => ({ value: env[(e as { name: string }).name] }))
  on('session.id', () => ({ value: 's1' }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    const argv = [...(e as { argv: string[] }).argv]
    const r = argv[0] === 'git' ? REMOTE : opts.run?.(argv) ?? { exitCode: 0, stdout: '', stderr: '' }
    return { value: { isStdoutTruncated: false, isStderrTruncated: false, ...r } }
  })
  return mem
}

test('a foreground watch is denied with the reason', async ($, on) => {
  const mem = quiet(on)
  const r = await $.tool.call({ tool: 'Bash', command: 'gh run watch 5 -R o/r --exit-status' })
  expect(r.deny).toContain('already watching this run in the background')
})

test(
  "with continuing off, a foreground watch runs, since no new turn would come",
  { options: { continueAfterBuilds: false } },
  async ($, on) => {
    quiet(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
    const r = await $.tool.call({ tool: 'Bash', command: 'gh run watch 5 -R o/r --exit-status' })
    expect(r.deny).toBeUndefined()
  },
)

test('a background watch is allowed', async ($, on) => {
  const mem = quiet(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const r = await $.tool.call({ tool: 'Bash', command: 'gh run watch 5 -R o/r', run_in_background: true })
  expect(r.deny).toBeUndefined()
})

test('starting a Codemagic build adds a watch from the script output', async ($, on) => {
  const mem = quiet(on)
  on('tool.call', { tool: 'PowerShell' }, () => ({ result: STARTED }))
  await $.tool.call({ tool: 'PowerShell', command: 'python scripts/codemagic.py start main' })
  const watches = mem.watches as { id: string; repo: string; provider: string }[]
  expect(watches.map(w => `${w.provider}:${w.id}:${w.repo}`)).toEqual(['codemagic:b77:acme/rocket'])
})

test('a failed start command adds nothing', async ($, on) => {
  const mem = quiet(on)
  on('tool.call', { tool: 'Bash' }, () => ({ isError: true, result: null, text: 'No token.' }))
  await $.tool.call({ tool: 'Bash', command: 'python scripts/codemagic.py start main' })
  expect(mem.watches ?? []).toEqual([])
})

test('starting a workflow adds a pending Actions watch for the named repo', async ($, on) => {
  const mem = quiet(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'gh workflow run pr.yaml -R acme/rocket --ref dev' })
  const watches = mem.watches as { repo: string; pending: { workflow: string; ref: string } }[]
  expect(watches[0]!.repo).toBe('acme/rocket')
  expect(watches[0]!.pending.workflow).toBe('pr.yaml')
  expect(watches[0]!.pending.ref).toBe('dev')
})

test('/ci on a finished build shows it without alerts or a Claude turn', async ($, on) => {
  const mem = quiet(on)
  const prompts: string[] = []
  on('prompt.submit', ((_$: unknown, e: { text: string }) => { prompts.push(e.text); return { value: { text: e.text } } }) as never)
  on('http.fetch', (_$, e) => {
    const body = e.url.endsWith('/apps')
      ? { applications: [{ _id: 'app1', appName: 'rocket', repository: { htmlUrl: 'https://github.com/acme/rocket' } }] }
      : e.url.includes('/builds?') ? { builds: [{ _id: 'b9' }] }
      : { build: { _id: 'b9', appId: 'app1', index: 9, status: 'finished', branch: 'main', startedAt: '2026-10-04T07:24:13Z', finishedAt: '2026-10-04T07:31:01Z', fileWorkflowId: 'testflight', buildActions: [] } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  const r = await $.command.run({ command: 'ci', args: '' } as never)
  expect(r.text).toContain('Codemagic #9')
  expect(prompts).toEqual([])
  expect(mem.watches ?? []).toEqual([])
  expect((mem.last as { isReplay: boolean }).isReplay).toBe(true)
})

test('/ci stop clears every watch', async ($, on) => {
  const mem = quiet(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'gh workflow run pr.yaml -R o/r' })
  const r = await $.command.run({ command: 'ci', args: 'stop' } as never)
  expect(r.text).toBe('Stopped watching 1 run.')
  expect(mem.watches).toEqual([])
})

const RUNNING = { watches: [{ provider: 'codemagic', id: 'b1', repo: 'o/r', addedAt: 0, errors: 0, run: {
  provider: 'codemagic', id: 'b1', repo: 'o/r', workflow: 'w', label: 'Codemagic #3', branch: 'main', url: 'u',
  state: 'running', startedAt: 0, steps: [{ name: 'Build IPA', state: 'running', startedAt: 0 }] } }] }
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80 } as never } as const

test('the band above the prompt races the running build', async ($, on) => {
  memStore(on, RUNNING)
  mock.clock(on, { now: 60_000 })
  const band = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  expect((await band.find({ text: /Codemagic #3/ })) !== undefined).toBe(true)
  expect((await band.find({ text: /Build IPA 1\/1/ })) !== undefined).toBe(true)
  expect((await band.find({ text: /⎇ main/ })) !== undefined).toBe(true)
})

test('with nothing watched the band shows the session instead', async ($, on) => {
  memStore(on)
  mock.clock(on, { now: 60_000 })
  const band = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Raster' })).toBeDefined()
  expect(await band.find({ text: /first run|ghost / })).toBeUndefined()
})

test('the band shows a finished build, then goes away', async ($, on) => {
  const run = { ...RUNNING.watches[0]!.run, state: 'passed', finishedAt: 120_000, steps: [{ name: 'Build IPA', state: 'passed', startedAt: 0, finishedAt: 120_000 }] }
  memStore(on, { last: { run, isNewPB: true, at: 120_000, isReplay: false } })
  mock.clock(on, { now: 130_000 })
  const band = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  expect((await band.find({ text: /Codemagic #3 passed/ })) !== undefined).toBe(true)
  expect((await band.find({ text: /NEW PB/ })) !== undefined).toBe(true)
})

test('a dispatch chained with a watch runs instead of being denied', async ($, on) => {
  const mem = quiet(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const r = await $.tool.call({ tool: 'Bash', command: 'gh workflow run pr.yaml -R o/r --ref dev && sleep 5 && gh run watch 5 -R o/r' })
  expect(r.deny).toBeUndefined()
  expect((mem.watches as { pending: unknown }[])[0]!.pending !== undefined).toBe(true)
})

test('watching a named run adds it, so the deny is true', async ($, on) => {
  const mem = quiet(on)
  const r = await $.tool.call({ tool: 'Bash', command: 'gh run watch 77 -R o/r --exit-status' })
  expect(r.deny).toContain('already watching')
  expect((mem.watches as { id: string; repo: string }[]).map(w => `${w.id}@${w.repo}`)).toEqual(['77@o/r'])
})

test('a Codemagic watch with nothing being watched is allowed to run', async ($, on) => {
  quiet(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'finished', stderr: '', interrupted: false } }))
  const r = await $.tool.call({ tool: 'Bash', command: 'python scripts/codemagic.py watch' })
  expect(r.deny).toBeUndefined()
})

test('/ci watches a running Actions check even when Codemagic has an older finished build', async ($, on) => {
  const mem = quiet(on, undefined, { run: argv => {
    const out = argv[2] === 'list' ? [{ databaseId: 42 }]
      : { databaseId: 42, number: 3, status: 'in_progress', conclusion: '', workflowName: 'PR check', headBranch: 'dev', url: 'u', createdAt: '2026-10-05T09:59:00Z', updatedAt: '2026-10-05T10:00:00Z', jobs: [] }
    return { exitCode: 0, stdout: JSON.stringify(out), stderr: '' }
  } })
  on('http.fetch', (_$, e) => {
    const url = (e as { url: string }).url
    const body = url.endsWith('/apps')
      ? { applications: [{ _id: 'app1', appName: 'rocket', repository: { htmlUrl: 'https://github.com/acme/rocket' } }] }
      : url.includes('/builds?') ? { builds: [{ _id: 'b9' }] }
      : { build: { _id: 'b9', appId: 'app1', index: 9, status: 'finished', branch: 'main', startedAt: '2026-10-04T07:24:13Z', finishedAt: '2026-10-04T07:31:01Z', fileWorkflowId: 'testflight', buildActions: [] } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  const r = await $.command.run({ command: 'ci', args: '' } as never)
  expect(r.text).toBe('Watching Actions PR check.')
  expect((mem.watches as { id: string }[]).map(w => w.id)).toEqual(['42'])
})

test('/ci says when gh is not logged in', async ($, on) => {
  quiet(on, undefined, { run: () => ({ exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }) })
  const r = await $.command.run({ command: 'ci', args: '' } as never)
  expect(r.text).toContain('gh auth login')
})
