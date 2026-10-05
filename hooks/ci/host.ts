import type { View } from '../../types'

export type HttpReply = { status: number; ok: boolean; text: string }
export type RunReply = { exitCode: number; stdout: string; stderr: string }
export type HttpOptions = { method?: string; headers?: Record<string, string>; body?: string }

// Everything the watcher and the API clients need from the engine. register.tsx builds it
// from `$` (the engine only lets `$` into functions in the same file), and tests hand in
// an in-memory fake.
export type Host = {
  now: () => Promise<number>
  // This session: its id, and the owner/name of the repo it runs in.
  self: () => Promise<{ id: string; repo?: string }>
  env: (name: string) => Promise<string | undefined>
  readFile: (path: string) => Promise<string>
  fetch: (url: string, init?: HttpOptions) => Promise<HttpReply>
  run: (argv: string[], timeoutMs?: number) => Promise<RunReply>
  load: (key: string) => Promise<unknown>
  save: (key: string, value: unknown) => Promise<void>
  toast: (text: string) => void
  submit: (text: string) => Promise<void>
  publish: (view: View) => Promise<void>
}
