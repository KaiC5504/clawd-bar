import type { LastResult, Notice, PendingLookup, Provider, Run, SplitRecord, View, Watch } from '../../types'
import { fetchGhRun, findGhRun, ghFailureLog, ghToRun } from './actions'
import { cmFailureLog, cmToken, cmToRun, fetchBuild } from './codemagic'
import type { Host } from './host'
import { alertText, continuePrompt } from './messages'
import { desktopToast, ntfy } from './notify'
import { isNewPB, recordKey, toRecord } from './splits'

const MAX_ERRORS = 5
const LOOKUP_WINDOW = 2 * 60_000
// The mod runs in every open session and they share one store, so each watch has an
// owner that renews its lease on every poll. Another session adopts it only once the
// owner has been quiet this long (closed, or restarted with a new id).
const LEASE = 90_000

// One store write at a time within this process. Other processes are handled by the
// lease and by re-reading the list just before saving it.
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const isDone = (run: Run) => run.state === 'passed' || run.state === 'failed' || run.state === 'canceled'
const sameRepo = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase()
const keyOf = (w: Watch) => `${w.provider}:${w.id || `pending:${w.pending?.workflow}:${w.pending?.since}`}`
const loadWatches = async (h: Host) => ((await h.load('watches')) as Watch[] | undefined) ?? []

export async function loadView(h: Host): Promise<View> {
  return {
    watches: await loadWatches(h),
    records: ((await h.load('records')) as Record<string, SplitRecord> | undefined) ?? {},
    last: ((await h.load('last')) as LastResult | undefined) ?? null,
    notice: ((await h.load('notice')) as Notice | undefined) ?? null,
  }
}

async function publish(h: Host) {
  await h.publish(await loadView(h))
}

export function addWatch(h: Host, w: { provider: Provider; id: string; repo: string; pending?: PendingLookup; isPromised?: boolean }) {
  return serial(async () => {
    const watches = await loadWatches(h)
    const same = w.id ? watches.find(x => x.provider === w.provider && x.id === w.id) : undefined
    if (same) {
      if (w.isPromised && !same.isPromised) {
        same.isPromised = true
        await h.save('watches', watches)
      }
      return
    }
    const now = await h.now()
    watches.push({ ...w, addedAt: now, errors: 0, owner: (await h.self()).id, beat: now })
    await h.save('watches', watches)
    await publish(h)
  })
}

// Marks the matching watches promised; false when there are none.
export function promiseWatches(h: Host, match: (w: Watch) => boolean) {
  return serial(async () => {
    const watches = await loadWatches(h)
    const hits = watches.filter(match)
    for (const w of hits) w.isPromised = true
    if (hits.length) await h.save('watches', watches)
    return hits.length > 0
  })
}

export function stopAll(h: Host) {
  return serial(async () => {
    const n = (await loadWatches(h)).length
    await h.save('watches', [])
    await publish(h)
    return n
  })
}

export function showReplay(h: Host, run: Run) {
  return serial(async () => {
    const last: LastResult = { run, isNewPB: false, at: await h.now(), isReplay: true }
    await h.save('last', last)
    await publish(h)
  })
}

async function refresh(h: Host, w: Watch, now: number): Promise<{ run?: Run; log?: () => Promise<string> }> {
  if (w.provider === 'codemagic') {
    const token = await cmToken(h)
    if (!token) throw new Error('no Codemagic token (set CODEMAGIC_API_TOKEN or ~/.codemagic-token)')
    const raw = await fetchBuild(h, token, w.id)
    return { run: cmToRun(raw, w.repo), log: () => cmFailureLog(h, token, raw) }
  }
  if (!w.id && w.pending) {
    const id = await findGhRun(h, w.repo, w.pending)
    if (!id) {
      if (now - w.pending.since > LOOKUP_WINDOW) throw new Error('the run never appeared')
      return {}
    }
    w.id = id
  }
  const run = ghToRun(await fetchGhRun(h, w.repo, w.id), w.repo)
  return { run, log: () => ghFailureLog(h, w.repo, w.id) }
}

// Returns the prompt to queue, if any; the caller submits it after the store chain is
// released, because a submit only resolves once the current turn ends.
async function finish(h: Host, run: Run, log: (() => Promise<string>) | undefined, opts: PollOpts, canPrompt: boolean, isPromised: boolean) {
  const records = ((await h.load('records')) as Record<string, SplitRecord> | undefined) ?? {}
  let last: LastResult = { run, isNewPB: false, at: await h.now(), isReplay: false }

  if (run.state === 'passed' || run.state === 'failed') {
    const key = recordKey(run)
    const pb = isNewPB(records[key], run)
    if (pb) {
      records[key] = toRecord(run)
      await h.save('records', records)
    }
    last = { ...last, isNewPB: pb }
  }
  await h.save('last', last)

  const { title, body } = alertText(run)
  h.toast(`${title} · ${body}`)
  await desktopToast(h, title, body).catch(() => undefined)
  if (opts.ntfyTopic) await ntfy(h, opts.ntfyTopic, title, body, run.url).catch(() => undefined)

  if (opts.canContinue === false) return undefined
  // Claude is usually watching its own build already; a pass only needs saying if it was told not to.
  if (run.state === 'passed' && !isPromised) return undefined
  const text = continuePrompt(run, run.state === 'failed' && log ? await log() : undefined)
  if (!text) return undefined
  if (canPrompt) return text
  h.toast(`Open Claude Code in ${run.repo} to let Claude continue.`)
  return undefined
}

// canContinue off keeps the race and the alerts but never hands Claude a turn.
export type PollOpts = { ntfyTopic: string; canContinue?: boolean }

export async function pollOnce(h: Host, opts: PollOpts) {
  const prompts = await serial(async () => {
    const me = await h.self()
    const now = await h.now()
    const watches = await loadWatches(h)
    const handled = new Map<string, Watch | null>()
    // A run's first watch, or null when another session holds it.
    const seen = new Map<string, Watch | null>()
    const done: { watch: Watch; run: Run; log?: () => Promise<string> }[] = []

    for (const w of watches) {
      const key = keyOf(w)
      if (w.owner && w.owner !== me.id && now - (w.beat ?? 0) < LEASE) {
        if (w.id) seen.set(`${w.provider}:${w.id}`, null)
        continue
      }
      w.owner = me.id
      w.beat = now
      try {
        const { run, log } = await refresh(h, w, now)
        w.errors = 0
        // Two dispatches, or /ci plus a dispatch, can land on the same run: keep the first.
        const runKey = `${w.provider}:${w.id}`
        if (w.id && seen.has(runKey)) {
          const kept = seen.get(runKey)
          if (kept && w.isPromised) kept.isPromised = true
          handled.set(key, null)
          continue
        }
        if (w.id) seen.set(runKey, w)
        if (run) w.run = run
        if (run && isDone(run)) {
          done.push({ watch: w, run, log })
          handled.set(key, null)
        } else {
          handled.set(key, w)
        }
      } catch (err) {
        w.errors++
        if (w.errors >= MAX_ERRORS) {
          const text = `stopped watching ${w.run?.label ?? w.repo}: ${(err as Error).message}`
          h.toast(`clawd-bar ${text}`)
          await h.save('notice', { text, at: now })
          handled.set(key, null)
        } else {
          handled.set(key, w)
        }
      }
    }

    // Re-read before saving: another session may have added or stopped watches meanwhile.
    // Their entries pass through untouched; a watch that vanished was stopped, so it stays gone.
    const next: Watch[] = []
    for (const f of await loadWatches(h)) {
      const mine = handled.get(keyOf(f))
      if (mine === undefined) next.push(f)
      else if (mine) next.push(mine)
    }
    await h.save('watches', next)

    const texts: string[] = []
    for (const d of done) {
      const text = await finish(h, d.run, d.log, opts, sameRepo(me.repo, d.run.repo), d.watch.isPromised === true)
      if (text) texts.push(text)
    }
    await publish(h)
    return texts
  })
  for (const text of prompts) void h.submit(text).catch(() => undefined)
}
