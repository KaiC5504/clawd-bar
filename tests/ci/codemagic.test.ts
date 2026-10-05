import { test, expect } from 'claude-code/testing'
import { cmToken, findApp, cmToRun, cmFailureLog, type CmBuild } from '../../hooks/ci/codemagic'
import { fakeHost } from './fake-host'

const BUILD: CmBuild = {
  _id: 'b9', appId: 'app1', index: 9, status: 'failed', branch: 'main',
  startedAt: '2026-10-04T07:24:13.152Z', finishedAt: '2026-10-04T07:31:01.272Z',
  fileWorkflowId: 'testflight', workflowId: null, config: { name: 'rocket to TestFlight' },
  message: 'Script Build IPA exited with status code 65',
  buildActions: [
    { name: 'Preparing build machine', status: 'success', startedAt: '2026-10-04T07:24:13.545Z', finishedAt: '2026-10-04T07:24:39.564Z', logUrl: 'https://api.codemagic.io/log/1' },
    { name: 'Build IPA', status: 'failed', startedAt: '2026-10-04T07:26:49.355Z', finishedAt: '2026-10-04T07:29:21.363Z' },
    { name: 'Publishing', status: null, startedAt: null, finishedAt: null },
  ],
}

test('a Codemagic build maps to a Run', () => {
  const run = cmToRun(BUILD, 'acme/rocket')
  expect(run.state).toBe('failed')
  expect(run.label).toBe('Codemagic #9')
  expect(run.workflow).toBe('testflight')
  expect(run.url).toBe('https://codemagic.io/app/app1/build/b9')
  expect(run.steps.map(s => s.state)).toEqual(['passed', 'failed', 'pending'])
  expect(run.startedAt).toBe(Date.parse('2026-10-04T07:24:13.152Z'))
})

test('a running step is one that started and has not finished', () => {
  const b = { ...BUILD, status: 'building', buildActions: [{ name: 'Build IPA', status: null, startedAt: '2026-10-04T07:26:49Z', finishedAt: null }] }
  expect(cmToRun(b, 'r').state).toBe('running')
  expect(cmToRun(b, 'r').steps[0]!.state).toBe('running')
})

test('a script step failure with no logUrl falls back to the build message and URL', async () => {
  const h = fakeHost()
  const log = await cmFailureLog(h, 'tok', BUILD)
  expect(log).toContain('exited with status code 65')
  expect(log).toContain('https://codemagic.io/app/app1/build/b9')
  expect(h.fetches).toEqual([])
})

test('a built-in step failure appends the last log lines', async () => {
  const h = fakeHost({ fetch: () => ({ status: 200, ok: true, text: '<span class="x">line 1</span>\nline 2\n' }) })
  const b = { ...BUILD, buildActions: [{ ...BUILD.buildActions![0]!, status: 'failed' }] }
  const log = await cmFailureLog(h, 'tok', b)
  expect(log).toContain('Last 2 log lines:\nline 1\nline 2')
})

test('the token comes from the home file when the environment has none', async () => {
  const h = fakeHost({ env: { USERPROFILE: 'C:\\Users\\me' }, files: { '/.codemagic-token': 'filetok\n' } })
  expect(await cmToken(h)).toBe('filetok')
})

test('the environment token wins over the file', async () => {
  const h = fakeHost({ env: { CODEMAGIC_API_TOKEN: 'envtok', USERPROFILE: 'C:\\Users\\me' }, files: { '/.codemagic-token': 'filetok' } })
  expect(await cmToken(h)).toBe('envtok')
})

test('no token anywhere is undefined, not an error', async () => {
  expect(await cmToken(fakeHost({ env: { USERPROFILE: 'C:\\Users\\me' } }))).toBeUndefined()
})

test('apps match by repository URL and the token goes only in the header', async () => {
  const h = fakeHost({ fetch: () => ({ status: 200, ok: true, text: JSON.stringify({ applications: [
    { _id: 'x', appName: 'Other', repository: { htmlUrl: 'https://github.com/acme/Other' } },
    { _id: 'app1', appName: 'rocket', repository: { htmlUrl: 'https://github.com/acme/rocket' } },
  ] }) }) })
  expect(await findApp(h, 'secret', 'https://github.com/acme/rocket.git')).toEqual({ id: 'app1', name: 'rocket' })
  expect(h.fetches[0]!.url).toBe('https://api.codemagic.io/apps')
  expect(h.fetches[0]!.init?.headers?.['x-auth-token']).toBe('secret')
})

test('an API error names the status, never the token', async () => {
  const h = fakeHost({ fetch: () => ({ status: 401, ok: false, text: 'bad token secret' }) })
  let msg = ''
  try { await findApp(h, 'secret', 'x') } catch (err) { msg = (err as Error).message }
  expect(msg).toBe('Codemagic answered 401 for /apps')
})
