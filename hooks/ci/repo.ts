import type { Host } from './host'

export function normalizeRemote(url: string) {
  return url.trim()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .toLowerCase()
}

export function repoSlug(url: string) {
  const m = url.trim().replace(/\/+$/, '').replace(/\.git$/, '').match(/[:/]([^/:]+)\/([^/]+)$/)
  return m ? `${m[1]}/${m[2]}` : url
}

export async function originRemote(h: Host) {
  const r = await h.run(['git', 'remote', 'get-url', 'origin'])
  return r.exitCode === 0 ? r.stdout.trim() : undefined
}
