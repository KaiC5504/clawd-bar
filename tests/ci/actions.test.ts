import { test, expect } from 'claude-code/testing'
import { ghToRun, findGhRun, fetchGhRun, ghFailureLog, ghAuthLine, type GhRun } from '../../hooks/ci/actions'
import { fakeHost } from './fake-host'

const RAW: GhRun = {
  databaseId: 42, number: 7, status: 'in_progress', conclusion: '', workflowName: 'PR check', headBranch: 'dev',
  url: 'https://github.com/acme/rocket/actions/runs/42', createdAt: '2026-10-05T10:00:00Z', startedAt: '2026-10-05T10:00:05Z', updatedAt: '2026-10-05T10:04:00Z',
  jobs: [{ name: 'build-ios', status: 'in_progress', conclusion: '', steps: [
    { name: 'Set up job', status: 'completed', conclusion: 'success', startedAt: '2026-10-05T10:00:06Z', completedAt: '2026-10-05T10:00:10Z' },
    { name: 'Run flutter build ios', status: 'in_progress', conclusion: '', startedAt: '2026-10-05T10:00:10Z', completedAt: null },
    { name: 'Post Run actions/checkout', status: 'pending', conclusion: '', startedAt: null, completedAt: null },
  ] }],
}

test('a gh run maps to a Run with post steps dropped', () => {
  const run = ghToRun(RAW, 'acme/rocket')
  expect(run.state).toBe('running')
  expect(run.label).toBe('Actions PR check')
  expect(run.finishedAt).toBeUndefined()
  expect(run.steps.map(s => `${s.name}:${s.state}`)).toEqual(['Set up job:passed', 'Run flutter build ios:running'])
})

test('completed runs map by conclusion', () => {
  expect(ghToRun({ ...RAW, status: 'completed', conclusion: 'success' }, 'r').state).toBe('passed')
  expect(ghToRun({ ...RAW, status: 'completed', conclusion: 'failure' }, 'r').state).toBe('failed')
  expect(ghToRun({ ...RAW, status: 'completed', conclusion: 'cancelled' }, 'r').state).toBe('canceled')
  expect(ghToRun({ ...RAW, status: 'queued' }, 'r').state).toBe('queued')
})

test('several jobs prefix step names with the job', () => {
  const two = { ...RAW, jobs: [{ ...RAW.jobs![0]!, name: 'a' }, { ...RAW.jobs![0]!, name: 'b' }] }
  expect(ghToRun(two, 'r').steps[0]!.name).toBe('a: Set up job')
})

test('every gh call names the repo with -R, so a fork never lists upstream runs', async () => {
  const h = fakeHost({ run: argv => argv[2] === 'list'
    ? { exitCode: 0, stdout: JSON.stringify([{ databaseId: 42, createdAt: '2026-10-05T10:00:00Z' }]), stderr: '' }
    : { exitCode: 0, stdout: JSON.stringify(RAW), stderr: '' } })
  expect(await findGhRun(h, 'acme/rocket', { workflow: 'pr.yaml', ref: 'dev', since: Date.parse('2026-10-05T09:59:58Z') })).toBe('42')
  await fetchGhRun(h, 'acme/rocket', '42')
  expect(h.runs.length).toBe(2)
  for (const argv of h.runs) expect(argv.join(' ')).toContain('-R acme/rocket')
  expect(h.runs[0]!.join(' ')).toContain('--branch dev')
})

test('a run created before the command is not picked up', async () => {
  const h = fakeHost({ run: () => ({ exitCode: 0, stdout: JSON.stringify([{ databaseId: 41, createdAt: '2026-10-05T09:00:00Z' }]), stderr: '' }) })
  expect(await findGhRun(h, 'o/r', { workflow: 'pr.yaml', since: Date.parse('2026-10-05T10:00:00Z') })).toBeUndefined()
})

test('a gh failure throws with its first stderr line', async () => {
  const h = fakeHost({ run: () => ({ exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\nmore' }) })
  let msg = ''
  try { await fetchGhRun(h, 'o/r', '1') } catch (err) { msg = (err as Error).message }
  expect(msg).toBe('gh run view failed: To get started with GitHub CLI, please run:  gh auth login')
})

test('the failed log keeps the last 60 lines and never throws', async () => {
  const lines = Array.from({ length: 80 }, (_, i) => `l${i}`).join('\n')
  expect(await ghFailureLog(fakeHost({ run: () => ({ exitCode: 0, stdout: lines, stderr: '' }) }), 'o/r', '1')).toContain('Last 60 log lines:\nl20\n')
  expect(await ghFailureLog(fakeHost({ run: () => ({ exitCode: 1, stdout: '', stderr: 'nope' }) }), 'o/r', '1')).toContain('Could not read the failed log')
})

test('gh auth status becomes one doctor line', () => {
  const ok = { exitCode: 0, stdout: 'github.com\n  ✓ Logged in to github.com account octo (keyring)\n  - Active account: true\n', stderr: '' }
  expect(ghAuthLine(ok)).toBe('✓ gh logged in as octo')
  expect(ghAuthLine({ exitCode: 0, stdout: '', stderr: '✓ Logged in to github.com as octo (oauth_token)' })).toBe('✓ gh logged in as octo')

  const out = { exitCode: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n' }
  expect(ghAuthLine(out)).toBe('✗ gh not logged in: run gh auth login')

  const expired = { exitCode: 1, stdout: '', stderr: 'github.com\n  X Failed to log in to github.com account octo (keyring)\n' }
  expect(ghAuthLine(expired)).toBe('✗ gh auth status failed: X Failed to log in to github.com account octo (keyring)')

  expect(ghAuthLine(null)).toContain('gh not found')
})
