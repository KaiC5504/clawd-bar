import type { Run, RunState, StepState } from '../../types'
import type { Host } from './host'
import { normalizeRemote } from './repo'

const API = 'https://api.codemagic.io'

export type CmAction = { name: string; status: string | null; startedAt: string | null; finishedAt: string | null; logUrl?: string }
export type CmBuild = {
  _id: string
  appId: string
  index: number
  status: string
  branch: string
  startedAt: string | null
  finishedAt: string | null
  fileWorkflowId?: string | null
  workflowId?: string | null
  config?: { name?: string }
  message?: string
  buildActions?: CmAction[]
}

export async function cmToken(h: Host) {
  const env = await h.env('CODEMAGIC_API_TOKEN')
  if (env) return env.trim()
  const home = (await h.env('USERPROFILE')) ?? (await h.env('HOME'))
  if (!home) return undefined
  try {
    return (await h.readFile(`${home}/.codemagic-token`)).trim() || undefined
  } catch {
    return undefined
  }
}

async function get<T>(h: Host, token: string, path: string): Promise<T> {
  const res = await h.fetch(`${API}${path}`, { headers: { 'x-auth-token': token } })
  // The message names the status only: the token must never reach a toast or a log.
  if (!res.ok) throw new Error(`Codemagic answered ${res.status} for ${path.split('?')[0]}`)
  return JSON.parse(res.text) as T
}

type CmApp = { _id: string; appName: string; repository?: { htmlUrl?: string } }

export async function findApp(h: Host, token: string, remote: string) {
  const { applications = [] } = await get<{ applications?: CmApp[] }>(h, token, '/apps')
  const want = normalizeRemote(remote)
  const app = applications.find(a => a.repository?.htmlUrl && normalizeRemote(a.repository.htmlUrl) === want)
  return app ? { id: app._id, name: app.appName } : undefined
}

export async function fetchBuild(h: Host, token: string, buildId: string) {
  return (await get<{ build: CmBuild }>(h, token, `/builds/${buildId}`)).build
}

export async function latestBuildId(h: Host, token: string, appId: string) {
  const { builds = [] } = await get<{ builds?: CmBuild[] }>(h, token, `/builds?appId=${appId}`)
  return builds[0]?._id
}

const ms = (s: string | null | undefined) => (s ? Date.parse(s) : undefined)

function runState(status: string): RunState {
  if (status === 'finished') return 'passed'
  if (status === 'failed' || status === 'timeout') return 'failed'
  if (status === 'canceled' || status === 'skipped') return 'canceled'
  if (status === 'queued') return 'queued'
  return 'running'
}

function stepState(a: CmAction): StepState {
  if (a.status === 'success') return 'passed'
  if (a.status === 'failed') return 'failed'
  if (a.status === 'skipped' || a.status === 'canceled') return 'skipped'
  if (a.startedAt && !a.finishedAt) return 'running'
  return a.status ? 'running' : 'pending'
}

export function cmToRun(b: CmBuild, repo: string): Run {
  return {
    provider: 'codemagic',
    id: b._id,
    repo,
    workflow: b.fileWorkflowId ?? b.workflowId ?? b.config?.name ?? 'default',
    label: `Codemagic #${b.index}`,
    branch: b.branch,
    url: `https://codemagic.io/app/${b.appId}/build/${b._id}`,
    state: runState(b.status),
    startedAt: ms(b.startedAt),
    finishedAt: ms(b.finishedAt),
    steps: (b.buildActions ?? []).map(a => ({ name: a.name, state: stepState(a), startedAt: ms(a.startedAt), finishedAt: ms(a.finishedAt) })),
  }
}

export async function cmFailureLog(h: Host, token: string, b: CmBuild) {
  const url = `https://codemagic.io/app/${b.appId}/build/${b._id}`
  const failed = b.buildActions?.find(a => a.status === 'failed')
  const head = `${failed ? `Failed step: ${failed.name}\n` : ''}${b.message?.trim() ?? ''}\nBuild: ${url}`
  // Codemagic only gives built-in steps a logUrl; script steps fall back to the message.
  if (!failed?.logUrl) return head
  try {
    // The token only ever goes to Codemagic's own API host.
    const isOwnHost = failed.logUrl.startsWith(`${API}/`)
    const res = await h.fetch(failed.logUrl, isOwnHost ? { headers: { 'x-auth-token': token } } : undefined)
    if (!res.ok) return head
    const lines = res.text.replace(/<\/?span[^>]*>/g, '').split('\n').filter(l => l.trim())
    return `${head}\n\nLast ${Math.min(60, lines.length)} log lines:\n${lines.slice(-60).join('\n')}`
  } catch {
    return head
  }
}
