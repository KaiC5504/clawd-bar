import type { Run, RunState, StepState } from '../../types'
import type { Host, RunReply } from './host'

type GhStep = { name: string; status: string; conclusion: string; startedAt: string | null; completedAt: string | null }
type GhJob = { name: string; status: string; conclusion: string; steps?: GhStep[] }
export type GhRun = {
  databaseId: number
  number: number
  status: string
  conclusion: string
  workflowName: string
  headBranch: string
  url: string
  createdAt: string
  startedAt?: string
  updatedAt: string
  jobs?: GhJob[]
}

const FIELDS = 'databaseId,number,status,conclusion,workflowName,headBranch,url,createdAt,startedAt,updatedAt,jobs'

async function gh(h: Host, args: string[]) {
  const r = await h.run(['gh', ...args])
  if (r.exitCode !== 0) throw new Error(`gh ${args[0]} ${args[1]} failed: ${r.stderr.split('\n')[0] ?? ''}`)
  return r.stdout
}

const ms = (s: string | null | undefined) => (s ? Date.parse(s) : undefined)

function runState(r: GhRun): RunState {
  if (r.status !== 'completed') return ['queued', 'waiting', 'pending', 'requested'].includes(r.status) ? 'queued' : 'running'
  if (r.conclusion === 'success') return 'passed'
  if (r.conclusion === 'cancelled' || r.conclusion === 'skipped') return 'canceled'
  return 'failed'
}

function stepState(s: GhStep): StepState {
  if (s.status === 'completed') return s.conclusion === 'success' ? 'passed' : s.conclusion === 'skipped' ? 'skipped' : 'failed'
  return s.status === 'in_progress' ? 'running' : 'pending'
}

export function ghToRun(raw: GhRun, repo: string): Run {
  const jobs = raw.jobs ?? []
  const steps = jobs.flatMap(j => (j.steps ?? [])
    .filter(s => !/^(Post |Complete job)/.test(s.name))
    .map(s => ({
      name: jobs.length > 1 ? `${j.name}: ${s.name}` : s.name,
      state: stepState(s),
      startedAt: ms(s.startedAt),
      finishedAt: ms(s.completedAt),
    })))
  const state = runState(raw)
  return {
    provider: 'actions',
    id: String(raw.databaseId),
    repo,
    workflow: raw.workflowName,
    label: `Actions ${raw.workflowName}`,
    branch: raw.headBranch,
    url: raw.url,
    state,
    startedAt: ms(raw.startedAt) ?? ms(raw.createdAt),
    finishedAt: state === 'running' || state === 'queued' ? undefined : ms(raw.updatedAt),
    steps,
  }
}

export async function fetchGhRun(h: Host, repo: string, id: string) {
  return JSON.parse(await gh(h, ['run', 'view', id, '-R', repo, '--json', FIELDS])) as GhRun
}

export async function findGhRun(h: Host, repo: string, p: { workflow: string; ref?: string; since: number }) {
  const args = ['run', 'list', '-R', repo, '--workflow', p.workflow, '--limit', '5', '--json', 'databaseId,createdAt']
  if (p.ref) args.push('--branch', p.ref)
  const runs = JSON.parse(await gh(h, args)) as { databaseId: number; createdAt: string }[]
  // `gh workflow run` returns before the run exists; allow a little clock skew.
  const fresh = runs.filter(r => Date.parse(r.createdAt) >= p.since - 10_000)
  return fresh.length ? String(fresh[0]!.databaseId) : undefined
}

export async function latestGhRunId(h: Host, repo: string) {
  const runs = JSON.parse(await gh(h, ['run', 'list', '-R', repo, '--limit', '1', '--json', 'databaseId'])) as { databaseId: number }[]
  return runs[0] ? String(runs[0].databaseId) : undefined
}

export async function ghFailureLog(h: Host, repo: string, id: string) {
  try {
    const out = await gh(h, ['run', 'view', id, '-R', repo, '--log-failed'])
    const lines = out.split('\n').filter(l => l.trim())
    return `Last ${Math.min(60, lines.length)} log lines:\n${lines.slice(-60).join('\n')}`
  } catch (err) {
    return `Could not read the failed log (${(err as Error).message}).`
  }
}

// One doctor line from `gh auth status`; `null` when gh couldn't be started at all.
export function ghAuthLine(ran: RunReply | null): string {
  if (!ran) return '✗ gh not found: install the GitHub CLI to race Actions builds'
  const account = /Logged in to \S+ (?:account|as) (\S+)/.exec(ran.stdout + ran.stderr)?.[1]
  if (ran.exitCode === 0) return `✓ gh logged in${account ? ` as ${account}` : ''}`
  if (/not logged in/i.test(ran.stderr + ran.stdout)) return '✗ gh not logged in: run gh auth login'
  const lines = (ran.stderr || ran.stdout).split('\n').map(l => l.trim()).filter(Boolean)
  const why = lines.find(l => /fail|invalid|expired/i.test(l)) ?? lines[0]
  return `✗ gh auth status failed${why ? `: ${why}` : ''}`
}
