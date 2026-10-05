import type { Host, HttpOptions, HttpReply, RunReply } from '../../hooks/ci/host'
import type { View } from '../../types'

export type Fake = Host & {
  store: Record<string, unknown>
  toasts: string[]
  prompts: string[]
  views: View[]
  fetches: { url: string; init?: HttpOptions }[]
  runs: string[][]
  clock: { t: number }
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

export function fakeHost(o: {
  env?: Record<string, string>
  files?: Record<string, string>
  fetch?: (url: string, init?: HttpOptions) => HttpReply
  run?: (argv: string[]) => RunReply
  store?: Record<string, unknown>
  // Pass the same object to two fakes to model two sessions sharing one store.
  storeRef?: Record<string, unknown>
  self?: { id: string; repo?: string }
  submit?: (text: string) => Promise<void>
  now?: number
} = {}): Fake {
  const f: Fake = {
    store: o.storeRef ?? clone(o.store ?? {}),
    toasts: [],
    prompts: [],
    views: [],
    fetches: [],
    runs: [],
    clock: { t: o.now ?? 0 },
    now: async () => f.clock.t,
    self: async () => o.self ?? { id: 's1', repo: 'acme/rocket' },
    env: async name => o.env?.[name],
    readFile: async path => {
      const hit = Object.entries(o.files ?? {}).find(([k]) => path.replace(/\\/g, '/').endsWith(k))
      if (!hit) throw new Error(`no such file ${path}`)
      return hit[1]
    },
    fetch: async (url, init) => {
      f.fetches.push({ url, init })
      if (!o.fetch) throw new Error(`unexpected fetch ${url}`)
      return o.fetch(url, init)
    },
    run: async argv => {
      f.runs.push([...argv])
      return o.run ? o.run(argv) : { exitCode: 0, stdout: '', stderr: '' }
    },
    load: async key => clone(f.store[key]),
    save: async (key, value) => { f.store[key] = clone(value) },
    toast: text => { f.toasts.push(text) },
    submit: async text => {
      f.prompts.push(text)
      if (o.submit) await o.submit(text)
    },
    publish: async view => { f.views.push(view) },
  }
  return f
}
