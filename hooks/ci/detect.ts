export type Detected =
  | { kind: 'codemagic-start' }
  | { kind: 'actions-start'; workflow: string; ref?: string; repo?: string }
  | { kind: 'foreground-watch'; provider: 'codemagic' | 'actions' }
  | { kind: 'none' }

const unquote = (s: string | undefined) => s?.replace(/^["']|["']$/g, '')
const repoFlag = (command: string) => unquote(command.match(/(?:\s-R|--repo)[ =](\S+)/)?.[1])

export function classify(command: string): Detected {
  // A start wins over a watch in the same command: blocking it would also block the start.
  if (/codemagic\.py["']?\s+start\b/.test(command)) return { kind: 'codemagic-start' }
  const wf = command.match(/\bgh\s+workflow\s+run\s+(\S+)/)
  if (wf) {
    return {
      kind: 'actions-start',
      workflow: unquote(wf[1])!,
      ref: unquote(command.match(/--ref[ =](\S+)/)?.[1]),
      repo: repoFlag(command),
    }
  }
  if (/\bgh\s+run\s+watch\b/.test(command)) return { kind: 'foreground-watch', provider: 'actions' }
  if (/codemagic\.py["']?\s+watch\b/.test(command)) return { kind: 'foreground-watch', provider: 'codemagic' }
  return { kind: 'none' }
}

export function watchedRun(command: string) {
  const id = command.match(/\bgh\s+run\s+watch\s+(\d+)/)?.[1]
  return id ? { id, repo: repoFlag(command) } : undefined
}

export const parseCodemagicStarted = (stdout: string) => stdout.match(/started\s+(\S+)\s+on\s+/)?.[1]
