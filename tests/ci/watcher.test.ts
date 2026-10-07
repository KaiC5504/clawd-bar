import { test, expect } from 'claude-code/testing'
import { addWatch, pollOnce, loadView, stopAll, showReplay } from '../../hooks/ci/watcher'
import { fakeHost } from './fake-host'
import type { HttpOptions } from '../../hooks/ci/host'

const build = (status: string) => ({ build: {
  _id: 'b1', appId: 'app1', index: 10, status, branch: 'main',
  startedAt: '2026-10-05T10:00:00Z', finishedAt: status === 'building' ? null : '2026-10-05T10:07:00Z',
  fileWorkflowId: 'testflight', message: status === 'failed' ? 'boom' : '',
  buildActions: [{ name: 'Build IPA', status: status === 'building' ? null : status === 'failed' ? 'failed' : 'success', startedAt: '2026-10-05T10:00:00Z', finishedAt: status === 'building' ? null : '2026-10-05T10:07:00Z' }],
} })

function world(status: () => string, store?: Record<string, unknown>) {
  let pushes = 0
  const h = fakeHost({
    env: { CODEMAGIC_API_TOKEN: 'tok', OS: 'Windows_NT' },
    now: Date.parse('2026-10-05T10:03:00Z'),
    store,
    fetch: (url: string, _init?: HttpOptions) => {
      if (url.startsWith('https://ntfy.sh')) { pushes++; return { status: 200, ok: true, text: '{}' } }
      return { status: 200, ok: true, text: JSON.stringify(build(status())) }
    },
  })
  return { h, pushes: () => pushes }
}

test('a running build is tracked, then finishing alerts once and records the PB', async () => {
  let status = 'building'
  const { h, pushes } = world(() => status)
  await addWatch(h, { provider: 'codemagic', id: 'b1', repo: 'acme/rocket' })
  await pollOnce(h, { ntfyTopic: 'topic' })
  expect(h.prompts).toEqual([])
  expect((await loadView(h)).watches[0]!.run!.state).toBe('running')

  status = 'finished'
  await pollOnce(h, { ntfyTopic: 'topic' })
  await pollOnce(h, { ntfyTopic: 'topic' })
  expect(h.prompts).toEqual([])
  expect(pushes()).toBe(1)
  expect(h.runs.filter(a => a[0] === 'powershell.exe').length).toBe(1)
  const view = await loadView(h)
  expect(view.watches).toEqual([])
  expect(view.last!.isNewPB).toBe(true)
  expect(view.records['acme/rocket#testflight']!.total).toBe(420)
  expect(h.views.length > 0).toBe(true)
})

test('a pass wakes Claude only when it was told to wait for the build', async () => {
  const { h } = world(() => 'finished')
  await addWatch(h, { provider: 'codemagic', id: 'b1', repo: 'acme/rocket' })
  await addWatch(h, { provider: 'codemagic', id: 'b1', repo: 'acme/rocket', isPromised: true })
  await pollOnce(h, { ntfyTopic: '' })
  expect(h.prompts.length).toBe(1)
  expect(h.prompts[0]).toContain('passed in 7:00')
})

test('with continuing off, a finished build still alerts but never hands Claude a turn', async () => {
  const { h, pushes } = world(() => 'failed')
  await addWatch(h, { provider: 'codemagic', id: 'b1', repo: 'acme/rocket' })
  await pollOnce(h, { ntfyTopic: 'topic', canContinue: false })
  expect(h.prompts).toEqual([])
  expect(pushes()).toBe(1)
  expect((await loadView(h)).last!.run.state).toBe('failed')
})

test('adding the same run twice keeps one watch', async () => {
  const { h } = world(() => 'building')
  await addWatch(h, { provider: 'codemagic', id: 'b1', repo: 'r' })
  await addWatch(h, { provider: 'codemagic', id: 'b1', repo: 'r' })
  expect((await loadView(h)).watches.length).toBe(1)
})

test('a build that finished while Claude Code was closed is alerted on the next poll', async () => {
  const { h, pushes } = world(() => 'failed', {
    watches: [{ provider: 'codemagic', id: 'b1', repo: 'acme/rocket', addedAt: 0, errors: 0 }],
  })
  await pollOnce(h, { ntfyTopic: '' })
  expect(h.prompts.length).toBe(1)
  expect(h.prompts[0]).toContain('failed at Build IPA')
  expect(h.prompts[0]).toContain('boom')
  expect(pushes()).toBe(0)
  expect((await loadView(h)).last!.run.state).toBe('failed')
})

test('a canceled run alerts but asks Claude nothing and records nothing', async () => {
  const { h } = world(() => 'canceled', { watches: [{ provider: 'codemagic', id: 'b1', repo: 'r', addedAt: 0, errors: 0 }] })
  await pollOnce(h, { ntfyTopic: '' })
  expect(h.prompts).toEqual([])
  expect(h.toasts.some(t => t.includes('canceled'))).toBe(true)
  expect((await loadView(h)).records).toEqual({})
})

test('five failed polls in a row drop the watch with a toast that never shows the token', async () => {
  const h = fakeHost({ env: { CODEMAGIC_API_TOKEN: 'tok' }, fetch: () => ({ status: 503, ok: false, text: 'tok' }) })
  await addWatch(h, { provider: 'codemagic', id: 'b1', repo: 'o/r' })
  for (let i = 0; i < 4; i++) await pollOnce(h, { ntfyTopic: '' })
  expect((await loadView(h)).watches.length).toBe(1)
  await pollOnce(h, { ntfyTopic: '' })
  expect((await loadView(h)).watches).toEqual([])
  expect(h.toasts.some(t => t.includes('stopped watching'))).toBe(true)
  expect(h.toasts.join(' ')).not.toContain('tok')
})

test('an Actions watch waits for its run to appear, then tracks it', async () => {
  const t0 = Date.parse('2026-10-05T10:00:00Z')
  let listed: unknown[] = []
  const h = fakeHost({
    now: t0,
    run: argv => argv[2] === 'list'
      ? { exitCode: 0, stdout: JSON.stringify(listed), stderr: '' }
      : { exitCode: 0, stdout: JSON.stringify({ databaseId: 42, number: 1, status: 'in_progress', conclusion: '', workflowName: 'PR', headBranch: 'dev', url: 'u', createdAt: '2026-10-05T10:00:03Z', updatedAt: '2026-10-05T10:00:03Z', jobs: [] }), stderr: '' },
  })
  await addWatch(h, { provider: 'actions', id: '', repo: 'o/r', pending: { workflow: 'pr.yaml', ref: 'dev', since: t0 } })
  await pollOnce(h, { ntfyTopic: '' })
  expect((await loadView(h)).watches[0]!.id).toBe('')
  listed = [{ databaseId: 42, createdAt: '2026-10-05T10:00:03Z' }]
  await pollOnce(h, { ntfyTopic: '' })
  const w = (await loadView(h)).watches[0]!
  expect(w.id).toBe('42')
  expect(w.run!.state).toBe('running')
})

test('stopAll empties the list and says how many it stopped', async () => {
  const { h } = world(() => 'building')
  await addWatch(h, { provider: 'codemagic', id: 'b1', repo: 'r' })
  expect(await stopAll(h)).toBe(1)
  expect((await loadView(h)).watches).toEqual([])
})

test('a replay is stored as the last result without recording anything', async () => {
  const { h } = world(() => 'finished')
  await showReplay(h, { provider: 'codemagic', id: 'b9', repo: 'r', workflow: 'w', label: 'Codemagic #9', branch: 'main', url: 'u', state: 'passed', steps: [] })
  const v = await loadView(h)
  expect(v.last!.isReplay).toBe(true)
  expect(v.records).toEqual({})
  expect(h.prompts).toEqual([])
})
