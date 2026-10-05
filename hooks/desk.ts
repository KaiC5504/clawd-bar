// Clawd on Desk installs one `clawd-hook.js` command hook per Claude Code event in
// settings.json, each starting a node process. The bridge replaces those, so this file
// finds the app, reads what it has installed, and swaps its hooks for the bridge.

export type HookSpec = { type?: string; command?: string; url?: string; [key: string]: unknown }
export type HookGroup = { matcher?: string; hooks: HookSpec[]; [key: string]: unknown }
export type ClaudeSettings = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown }

export type DeskHooks = {
  stateHooks: number
  hasPermission: boolean
  hasAutoStart: boolean
  // Where the app's hook commands point, when any still do.
  installDir: string | null
}

export type DeskPrefs = {
  // null when the prefs file can't be read: an older app, or not installed.
  isManagingHooks: boolean | null
  isAutoStartOn: boolean
}

// What register.tsx hands in, built from `$`.
export type DeskHost = {
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  run: (argv: string[], timeoutMs?: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export type DeskPaths = {
  home: string
  claudeDir: string
  appData?: string
  localAppData?: string
}

export const slashes = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

const hooksOf = (s: ClaudeSettings): HookSpec[] => Object.values(s.hooks ?? {}).flatMap(groups => groups.flatMap(g => g.hooks ?? []))

export const isStateHook = (h: HookSpec): boolean => h.type === 'command' && /clawd-hook\.js/.test(h.command ?? '')
const isAutoStartHook = (h: HookSpec): boolean => h.type === 'command' && /auto-start\.js/.test(h.command ?? '')
const isPermissionHook = (h: HookSpec): boolean => h.type === 'http' && /^http:\/\/127\.0\.0\.1:\d+\/permission/.test(h.url ?? '')

const HOOK_SCRIPT = /(?:"([^"]+)|([^\s"]+))[\\/]hooks[\\/](?:clawd-hook|auto-start)\.js/

export function readDeskHooks(s: ClaudeSettings): DeskHooks {
  const hooks = hooksOf(s)
  let installDir: string | null = null
  for (const h of hooks) {
    const m = HOOK_SCRIPT.exec(h.type === 'command' ? (h.command ?? '') : '')
    if (m) {
      installDir = slashes(m[1] ?? m[2] ?? '')
      break
    }
  }
  return {
    stateHooks: hooks.filter(isStateHook).length,
    hasPermission: hooks.some(isPermissionHook),
    hasAutoStart: hooks.some(isAutoStartHook),
    installDir,
  }
}

export type Rendered = { permission: HookGroup | null; autoStart: HookGroup | null }

// Drops the per-event hooks and puts back the permission and auto-start hooks when they
// are missing, as the app's own installer rendered them. Everything else stays as it was.
export function switchToBridge(s: ClaudeSettings, rendered: Rendered): { settings: ClaudeSettings; removed: number; added: string[] } {
  const next = JSON.parse(JSON.stringify(s)) as ClaudeSettings
  const before = readDeskHooks(next)
  const hooks: Record<string, HookGroup[]> = next.hooks ?? {}
  let removed = 0
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map(g => {
        const left = (g.hooks ?? []).filter(h => !isStateHook(h))
        removed += (g.hooks ?? []).length - left.length
        return { ...g, hooks: left }
      })
      .filter(g => g.hooks.length > 0)
    if (kept.length > 0) hooks[event] = kept
    else delete hooks[event]
  }
  const added: string[] = []
  if (!before.hasPermission && rendered.permission) {
    hooks.PermissionRequest = [rendered.permission, ...(hooks.PermissionRequest ?? [])]
    added.push('the permission hook')
  }
  if (!before.hasAutoStart && rendered.autoStart) {
    hooks.SessionStart = [rendered.autoStart, ...(hooks.SessionStart ?? [])]
    added.push('the auto-start hook')
  }
  next.hooks = hooks
  return { settings: next, removed, added }
}

export const settingsPath = (p: DeskPaths): string => `${p.claudeDir}/settings.json`

export async function readClaudeSettings(host: DeskHost, p: DeskPaths): Promise<ClaudeSettings | null> {
  if (!(await host.exists(settingsPath(p)))) return {}
  try {
    const parsed: unknown = JSON.parse(await host.readFile(settingsPath(p)))
    return parsed && typeof parsed === 'object' ? (parsed as ClaudeSettings) : null
  } catch {
    return null
  }
}

function installCandidates(p: DeskPaths): string[] {
  const unpacked = 'resources/app.asar.unpacked'
  const out: string[] = []
  if (p.localAppData) {
    out.push(`${p.localAppData}/Programs/Clawd on Desk/${unpacked}`, `${p.localAppData}/Programs/clawd-on-desk/${unpacked}`)
  }
  if (p.appData) out.push(`C:/Program Files/Clawd on Desk/${unpacked}`)
  else out.push('/Applications/Clawd on Desk.app/Contents/Resources/app.asar.unpacked')
  return out.map(slashes)
}

const isInstallDir = (host: DeskHost, dir: string) => host.exists(`${dir}/hooks/clawd-hook.js`).catch(() => false)

// The /config override wins; then where its hooks point, the folder found last time,
// and the usual install folders.
export async function findInstallDir(host: DeskHost, p: DeskPaths, o: { override: string; fromHooks: string | null; remembered: string | null }): Promise<string | null> {
  if (o.override) return slashes(o.override)
  for (const dir of [o.fromHooks, o.remembered, ...installCandidates(p)]) {
    if (dir && (await isInstallDir(host, dir))) return slashes(dir)
  }
  if (!p.appData) return null
  for (const dir of await registryInstallDirs(host)) {
    if (await isInstallDir(host, dir)) return dir
  }
  return null
}

// The Windows installer records where it put the app, wherever the person chose.
async function registryInstallDirs(host: DeskHost): Promise<string[]> {
  const out: string[] = []
  for (const hive of ['HKCU', 'HKLM']) {
    const ran = await host
      .run(['reg', 'query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', 'Clawd on Desk', '/d'], 5000)
      .catch(() => null)
    for (const m of ran?.stdout.matchAll(/"([^"]+)[\\/]Uninstall Clawd on Desk\.exe"/gi) ?? []) {
      if (m[1]) out.push(`${slashes(m[1])}/resources/app.asar.unpacked`)
    }
  }
  return [...new Set(out)]
}

function prefsCandidates(p: DeskPaths): string[] {
  const file = 'clawd-on-desk/clawd-prefs.json'
  if (p.appData) return [`${p.appData}/${file}`]
  return [`${p.home}/Library/Application Support/${file}`, `${p.home}/.config/${file}`]
}

export async function readDeskPrefs(host: DeskHost, p: DeskPaths): Promise<DeskPrefs> {
  for (const path of prefsCandidates(p)) {
    if (!(await host.exists(path).catch(() => false))) continue
    try {
      const prefs = JSON.parse(await host.readFile(path)) as Record<string, unknown>
      return {
        isManagingHooks: typeof prefs.manageClaudeHooksAutomatically === 'boolean' ? prefs.manageClaudeHooksAutomatically : null,
        isAutoStartOn: prefs.autoStartWithClaude !== false,
      }
    } catch {
      break
    }
  }
  return { isManagingHooks: null, isAutoStartOn: true }
}

export type Desk = { installDir: string | null; hooks: DeskHooks | null; prefs: DeskPrefs }

export async function inspectDesk(host: DeskHost, p: DeskPaths, o: { override: string; remembered: string | null }): Promise<Desk> {
  const s = await readClaudeSettings(host, p)
  const hooks = s ? readDeskHooks(s) : null
  const installDir = await findInstallDir(host, p, { ...o, fromHooks: hooks?.installDir ?? null })
  return { installDir, hooks, prefs: await readDeskPrefs(host, p) }
}

// Feeding the app while its own hooks are installed would show it every event twice.
export const canFeed = (d: Desk): boolean => d.installDir !== null && d.hooks !== null && d.hooks.stateHooks === 0

const MANAGED =
  'Clawd on Desk is still managing its Claude hooks, so it would put them straight back. In Clawd on Desk, open Settings → Agents, turn off "Manage Claude hooks automatically" and choose "Disable automatic management only". Then run /clawd desk again.'

export const CAME_BACK =
  'Clawd on Desk put its per-event hooks back. In Clawd on Desk, open Settings → Agents, turn off "Manage Claude hooks automatically" and choose "Disable automatic management only". Then run /clawd desk again.'

function stamp(now: number): string {
  const d = new Date(now)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
}

export type SetupResult = { text: string; didWrite: boolean }

// /clawd desk: the whole switch-over in one go, with a backup first.
export async function setupDesk(
  host: DeskHost,
  p: DeskPaths,
  o: { installDir: string | null; isBridgeOn: boolean; nodePath: string; bridgeScript: string; now: number },
): Promise<SetupResult> {
  if (!o.isBridgeOn) return { text: '"Feed Clawd on Desk" is off in /config. Turn it on, then run /clawd desk again.', didWrite: false }
  if (!o.installDir) {
    return {
      text: 'Couldn\'t find Clawd on Desk. If it\'s installed, set "Clawd on Desk app folder" in /config to its resources/app.asar.unpacked folder, then run /clawd desk again.',
      didWrite: false,
    }
  }
  const current = await readClaudeSettings(host, p)
  if (!current) return { text: `Couldn't read ${settingsPath(p)} as JSON, so nothing was changed.`, didWrite: false }
  const hooks = readDeskHooks(current)
  // Read again: the person may have just turned it off.
  const prefs = await readDeskPrefs(host, p)
  if (prefs.isManagingHooks === true) return { text: MANAGED, didWrite: false }

  let rendered: Rendered = { permission: null, autoStart: null }
  let renderError = ''
  const wantsAutoStart = !hooks.hasAutoStart && prefs.isAutoStartOn
  if (!hooks.hasPermission || wantsAutoStart) {
    const argv = [o.nodePath, o.bridgeScript, 'render-hooks', '--install-dir', o.installDir, ...(wantsAutoStart ? ['--auto-start'] : [])]
    try {
      const ran = await host.run(argv, 15_000)
      if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `render-hooks exited ${ran.exitCode}`)
      rendered = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '') as Rendered
    } catch (error) {
      renderError = error instanceof Error ? error.message : String(error)
    }
  }

  const { settings, removed, added } = switchToBridge(current, rendered)
  const missing = [
    !hooks.hasPermission && !added.includes('the permission hook') ? 'the permission hook (permission bubbles)' : '',
    wantsAutoStart && !added.includes('the auto-start hook') ? 'the auto-start hook' : '',
  ].filter(Boolean)
  const warn = missing.length ? `\nCouldn't add back ${missing.join(' or ')}${renderError ? `: ${renderError}` : ''}.` : ''

  if (removed === 0 && added.length === 0) {
    return { text: `Already set up: Clawd on Desk has no per-event hooks left, and clawd-bar feeds it.${warn}`, didWrite: false }
  }
  const backup = `${settingsPath(p)}.clawd-bar-${stamp(o.now)}.bak`
  await host.writeFile(backup, JSON.stringify(current, null, 2) + '\n')
  await host.writeFile(settingsPath(p), JSON.stringify(settings, null, 2) + '\n')

  const did = [removed ? `removed its ${removed} per-event hook${removed === 1 ? '' : 's'}` : '', added.length ? `added back ${added.join(' and ')}` : '']
    .filter(Boolean)
    .join(', ')
  return {
    text: [
      `Switched Clawd on Desk over to clawd-bar: ${did}.${warn}`,
      `Backup: ${backup}`,
      'Restart Claude Code to finish. After that, /clawd doctor shows the events being forwarded.',
      'To undo, turn "Manage Claude hooks automatically" back on in Clawd on Desk; it reinstalls its own hooks.',
    ].join('\n'),
    didWrite: true,
  }
}
