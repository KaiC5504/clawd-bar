import { test, expect } from 'claude-code/testing'
import { addWatch, pollOnce, loadView } from '../../hooks/ci/watcher'
import { cmFailureLog, type CmBuild } from '../../hooks/ci/codemagic'
import { fakeHost } from './fake-host'

const T = Date.parse('2026-10-05T10:03:00Z')
const finished = () => ({ status: 200, ok: true, text: JSON.stringify({ build: {
  _id: 'b1', appId: 'app1', index: 10, status: 'finished', branch: 'main',
  startedAt: '2026-10-05T10:00:00Z', finishedAt: '2026-10-05T10:07:00Z', fileWorkflowId: 'testflight',
  buildActions: [{ name: 'Build IPA', status: 'success', startedAt: '2026-10-05T10:00:00Z', finishedAt: '2026-10-05T10:07:00Z' }],
} }) })
const session = (store: Record<string, unknown>, id: string, repo: string, extra: Parameters<typeof fakeHost>[0] = {}) =>
  fakeHost({ storeRef: store, self: { id, repo }, now: T, env: { CODEMAGIC_API_TOKEN: 'tok' }, fetch: finished, ...extra })

test('only the session that owns a watch alerts and prompts', async () => {
  const store: Record<string, unknown> = {}
  const a = session(store, 'A', 'acme/rocket')
  const b = session(store, 'B', 'acme/comet')
  await addWatch(a, { provider: 'codemagic', id: 'b1', repo: 'acme/rocket', isPromised: true })
  await pollOnce(b, { ntfyTopic: '' })
  expect(b.prompts).toEqual([])
  expect(b.toasts).toEqual([])
  await pollOnce(a, { ntfyTopic: '' })
  expect(a.prompts.length).toBe(1)
  expect((await loadView(a)).last?.run.state).toBe('passed')
})

test('a watch whose owner went quiet is adopted by a session in the same repo', async () => {
  const store: Record<string, unknown> = { watches: [{ provider: 'codemagic', id: 'b1', repo: 'acme/rocket', addedAt: 0, errors: 0, owner: 'gone', beat: T - 5 * 60_000, isPromised: true }] }
  const c = session(store, 'C', 'acme/rocket')
  await pollOnce(c, { ntfyTopic: '' })
  expect(c.prompts.length).toBe(1)
})

test('a session in another repo alerts an orphaned build but never asks Claude to act there', async () => {
  const store: Record<string, unknown> = { watches: [{ provider: 'codemagic', id: 'b1', repo: 'acme/rocket', addedAt: 0, errors: 0, owner: 'gone', beat: T - 5 * 60_000, isPromised: true }] }
  const d = session(store, 'D', 'acme/comet')
  await pollOnce(d, { ntfyTopic: '' })
  expect(d.prompts).toEqual([])
  expect(d.toasts.some(t => t.includes('Codemagic #10 passed'))).toBe(true)
  expect(d.toasts.some(t => t.includes('Open Claude Code in acme/rocket'))).toBe(true)
})

test('a watch added by another session during a poll is not lost', async () => {
  const store: Record<string, unknown> = {}
  let b: ReturnType<typeof session> | undefined
  const running = () => ({ status: 200, ok: true, text: JSON.stringify({ build: {
    _id: 'b1', appId: 'app1', index: 10, status: 'building', branch: 'main', startedAt: '2026-10-05T10:00:00Z', finishedAt: null, buildActions: [] } }) })
  let added = false
  const a = session(store, 'A', 'acme/rocket', { fetch: () => {
    // Session B writes to the shared store while A is mid-poll.
    if (!added) { added = true; store.watches = [...((store.watches as unknown[]) ?? []), { provider: 'actions', id: '99', repo: 'o/r', addedAt: T, errors: 0, owner: 'B', beat: T }] }
    return running()
  } })
  b = session(store, 'B', 'o/r')
  void b
  await addWatch(a, { provider: 'codemagic', id: 'b1', repo: 'acme/rocket' })
  await pollOnce(a, { ntfyTopic: '' })
  const ids = (await loadView(a)).watches.map(w => w.id).sort()
  expect(ids).toEqual(['99', 'b1'])
})

test('a prompt that waits for the turn to end does not block the next watch', async () => {
  const h = fakeHost({ now: T, env: { CODEMAGIC_API_TOKEN: 'tok' }, fetch: finished, submit: () => new Promise<void>(() => undefined) })
  await addWatch(h, { provider: 'codemagic', id: 'b1', repo: 'acme/rocket' })
  await pollOnce(h, { ntfyTopic: '' })
  await addWatch(h, { provider: 'codemagic', id: 'b2', repo: 'acme/rocket' })
  expect((await loadView(h)).watches.map(w => w.id)).toEqual(['b2'])
})

test('two pending watches that resolve to the same run alert once', async () => {
  const h = fakeHost({ now: T, run: argv => argv[2] === 'list'
    ? { exitCode: 0, stdout: JSON.stringify([{ databaseId: 42, createdAt: '2026-10-05T10:03:01Z' }]), stderr: '' }
    : { exitCode: 0, stdout: JSON.stringify({ databaseId: 42, number: 1, status: 'completed', conclusion: 'success', workflowName: 'PR', headBranch: 'dev', url: 'u', createdAt: '2026-10-05T10:03:01Z', updatedAt: '2026-10-05T10:05:00Z', jobs: [] }), stderr: '' } })
  await addWatch(h, { provider: 'actions', id: '', repo: 'acme/rocket', pending: { workflow: 'pr.yaml', since: T } })
  h.clock.t += 1
  await addWatch(h, { provider: 'actions', id: '', repo: 'acme/rocket', pending: { workflow: 'pr.yaml', since: T + 1 } })
  await pollOnce(h, { ntfyTopic: '' })
  expect(h.toasts.filter(t => t.includes('passed')).length).toBe(1)
  expect((await loadView(h)).last?.run.state).toBe('passed')
})

test('a dispatch that Claude then watches keeps the promise when the two watches merge', async () => {
  const h = fakeHost({ now: T, run: argv => argv[2] === 'list'
    ? { exitCode: 0, stdout: JSON.stringify([{ databaseId: 42, createdAt: '2026-10-05T10:03:01Z' }]), stderr: '' }
    : { exitCode: 0, stdout: JSON.stringify({ databaseId: 42, number: 1, status: 'completed', conclusion: 'success', workflowName: 'PR', headBranch: 'dev', url: 'u', createdAt: '2026-10-05T10:03:01Z', updatedAt: '2026-10-05T10:05:00Z', jobs: [] }), stderr: '' } })
  await addWatch(h, { provider: 'actions', id: '', repo: 'acme/rocket', pending: { workflow: 'pr.yaml', since: T } })
  await addWatch(h, { provider: 'actions', id: '42', repo: 'acme/rocket', isPromised: true })
  await pollOnce(h, { ntfyTopic: '' })
  expect(h.prompts.length).toBe(1)
})

test('a dropped watch leaves a notice for the status line', async () => {
  const h = fakeHost({ now: T, env: { CODEMAGIC_API_TOKEN: 'tok' }, fetch: () => ({ status: 503, ok: false, text: '' }) })
  await addWatch(h, { provider: 'codemagic', id: 'b1', repo: 'o/r' })
  for (let i = 0; i < 5; i++) await pollOnce(h, { ntfyTopic: '' })
  expect((await loadView(h)).notice?.text).toContain('stopped watching')
})

test('the Codemagic token is only sent to api.codemagic.io', async () => {
  const b: CmBuild = { _id: 'b', appId: 'a', index: 1, status: 'failed', branch: 'main', startedAt: null, finishedAt: null,
    buildActions: [{ name: 'Publishing', status: 'failed', startedAt: null, finishedAt: null, logUrl: 'https://evil.example/log' }] }
  const h = fakeHost({ fetch: () => ({ status: 200, ok: true, text: 'x' }) })
  await cmFailureLog(h, 'tok', b)
  expect(h.fetches[0]?.init?.headers?.['x-auth-token']).toBeUndefined()
})
