import { expect, test } from 'claude-code/testing'

import { findInstallDir, readDeskHooks, setupDesk, switchToBridge } from '../hooks/desk'
import type { ClaudeSettings, DeskHost, DeskPaths, HookGroup, Rendered } from '../hooks/desk'

const APP = 'C:/Apps/Clawd on Desk/resources/app.asar.unpacked'
const NODE = '& "C:\\Program Files\\nodejs\\node.exe"'
const stateHook = (event: string): HookGroup => ({
  matcher: '',
  hooks: [{ type: 'command', command: `${NODE} "${APP}/hooks/clawd-hook.js" ${event}`, shell: 'powershell', async: true, timeout: 5 }],
})
const PERMISSION: HookGroup = { matcher: '', hooks: [{ type: 'http', url: 'http://127.0.0.1:23333/permission', timeout: 600 }] }
const AUTO_START: HookGroup = {
  matcher: '',
  hooks: [{ type: 'command', command: `${NODE} "${APP}/hooks/auto-start.js"`, shell: 'powershell', async: true, timeout: 15 }],
}
const OTHER = (n: string): HookGroup => ({ matcher: '*', hooks: [{ type: 'command', command: `other-tool ${n}`, timeout: 10 }] })

// What Clawd on Desk leaves in settings.json, next to another tool's hooks.
const INSTALLED: ClaudeSettings = {
  env: { KEEP: '1' },
  hooks: {
    PermissionRequest: [PERMISSION, OTHER('permission')],
    PreToolUse: [stateHook('PreToolUse'), OTHER('pre')],
    SessionStart: [AUTO_START, stateHook('SessionStart'), OTHER('start')],
    Stop: [stateHook('Stop')],
  },
  statusLine: { type: 'command', command: 'some-statusline' },
}

const RENDERED: Rendered = { permission: PERMISSION, autoStart: AUTO_START }

test('the installed hooks are counted, and their commands say where the app is', () => {
  expect(readDeskHooks(INSTALLED)).toEqual({ stateHooks: 3, hasPermission: true, hasAutoStart: true, installDir: APP })
  expect(readDeskHooks({})).toEqual({ stateHooks: 0, hasPermission: false, hasAutoStart: false, installDir: null })
  const posix = { hooks: { Stop: [{ hooks: [{ type: 'command', command: '"/usr/bin/node" "/opt/Clawd/resources/app.asar.unpacked/hooks/clawd-hook.js" Stop' }] }] } }
  expect(readDeskHooks(posix).installDir).toBe('/opt/Clawd/resources/app.asar.unpacked')
})

test('switching over removes only the per-event hooks and keeps everything else', () => {
  const { settings, removed, added } = switchToBridge(INSTALLED, RENDERED)
  expect(removed).toBe(3)
  expect(added).toEqual([])
  expect(settings.hooks).toEqual({
    PermissionRequest: [PERMISSION, OTHER('permission')],
    PreToolUse: [OTHER('pre')],
    SessionStart: [AUTO_START, OTHER('start')],
  })
  expect(settings.env).toEqual({ KEEP: '1' })
  expect(settings.statusLine).toEqual({ command: 'some-statusline', type: 'command' })
  // The input is left as it was, for the backup.
  expect(readDeskHooks(INSTALLED).stateHooks).toBe(3)
})

test('a missing permission or auto-start hook is put back first, and a second run changes nothing', () => {
  const stripped: ClaudeSettings = { hooks: { PermissionRequest: [OTHER('permission')], SessionStart: [OTHER('start')], Stop: [stateHook('Stop')] } }
  const once = switchToBridge(stripped, RENDERED)
  expect(once.added).toEqual(['the permission hook', 'the auto-start hook'])
  expect(once.settings.hooks?.PermissionRequest).toEqual([PERMISSION, OTHER('permission')])
  expect(once.settings.hooks?.SessionStart).toEqual([AUTO_START, OTHER('start')])
  expect(once.settings.hooks?.Stop).toBeUndefined()

  const twice = switchToBridge(once.settings, RENDERED)
  expect(twice.removed).toBe(0)
  expect(twice.added).toEqual([])
  expect(twice.settings).toEqual(once.settings)
})

type Disk = Record<string, string>

function fakeHost(disk: Disk, run: DeskHost['run'] = async () => ({ exitCode: 0, stdout: JSON.stringify(RENDERED), stderr: '' })) {
  const runs: string[][] = []
  const host: DeskHost = {
    readFile: async path => {
      const text = disk[path]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
    writeFile: async (path, text) => {
      disk[path] = text
    },
    exists: async path => path in disk,
    run: async (argv, ms) => {
      runs.push(argv)
      return run(argv, ms)
    },
  }
  return { host, runs }
}

const PATHS: DeskPaths = { home: 'C:/Users/tester', claudeDir: 'C:/Users/tester/.claude', appData: 'C:/Users/tester/AppData/Roaming', localAppData: 'C:/Users/tester/AppData/Local' }
const SETTINGS = 'C:/Users/tester/.claude/settings.json'
const PREFS = 'C:/Users/tester/AppData/Roaming/clawd-on-desk/clawd-prefs.json'
// Local time, as the backup's name is.
const NOW = new Date(2026, 9, 5, 10, 0, 0).getTime()
const SETUP = { installDir: APP, isBridgeOn: true, nodePath: 'node', bridgeScript: 'C:/plugin/tools/clawd-bridge.js', now: NOW }

test('the app folder: the /config override, then its hooks, then last time, then the usual places', async () => {
  const { host } = fakeHost({
    [`${APP}/hooks/clawd-hook.js`]: '',
    'C:/Users/tester/AppData/Local/Programs/Clawd on Desk/resources/app.asar.unpacked/hooks/clawd-hook.js': '',
  })
  expect(await findInstallDir(host, PATHS, { override: 'D:\\Mine\\', fromHooks: APP, remembered: null })).toBe('D:/Mine')
  expect(await findInstallDir(host, PATHS, { override: '', fromHooks: APP, remembered: null })).toBe(APP)
  expect(await findInstallDir(host, PATHS, { override: '', fromHooks: 'C:/Gone', remembered: APP })).toBe(APP)
  expect(await findInstallDir(host, PATHS, { override: '', fromHooks: null, remembered: null })).toBe(
    'C:/Users/tester/AppData/Local/Programs/Clawd on Desk/resources/app.asar.unpacked',
  )
  expect(await findInstallDir(fakeHost({}).host, PATHS, { override: '', fromHooks: APP, remembered: null })).toBeNull()
})

test('on Windows a custom install folder is read from the uninstall entry', async () => {
  const reg = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\3e93',
    '    DisplayName    REG_SZ    Clawd on Desk 1.2.0',
    '    UninstallString    REG_SZ    "D:\\Apps\\Clawd on Desk\\Uninstall Clawd on Desk.exe" /currentuser',
  ].join('\n')
  const { host, runs } = fakeHost({ 'D:/Apps/Clawd on Desk/resources/app.asar.unpacked/hooks/clawd-hook.js': '' }, async argv => ({
    exitCode: argv[2]?.startsWith('HKCU') ? 0 : 1,
    stdout: argv[2]?.startsWith('HKCU') ? reg : '',
    stderr: '',
  }))
  expect(await findInstallDir(host, PATHS, { override: '', fromHooks: null, remembered: null })).toBe('D:/Apps/Clawd on Desk/resources/app.asar.unpacked')
  expect(runs.map(r => r[0])).toEqual(['reg', 'reg'])

  const mac = fakeHost({})
  expect(await findInstallDir(mac.host, { home: '/Users/tester', claudeDir: '/Users/tester/.claude' }, { override: '', fromHooks: null, remembered: null })).toBeNull()
  expect(mac.runs).toEqual([])
})

test('/clawd desk backs up settings.json, then switches it over', async () => {
  const disk: Disk = { [SETTINGS]: JSON.stringify(INSTALLED), [PREFS]: JSON.stringify({ manageClaudeHooksAutomatically: false }) }
  const { host, runs } = fakeHost(disk)
  const done = await setupDesk(host, PATHS, SETUP)

  expect(done.didWrite).toBe(true)
  expect(done.text).toContain('removed its 3 per-event hooks')
  expect(done.text).toContain('Restart Claude Code')
  const backup = `${SETTINGS}.clawd-bar-20261005-100000.bak`
  expect(done.text).toContain(backup)
  expect(JSON.parse(disk[backup] ?? '')).toEqual(INSTALLED)
  expect(readDeskHooks(JSON.parse(disk[SETTINGS] ?? '')).stateHooks).toBe(0)
  // Both hooks were there, so the app's installer wasn't needed.
  expect(runs).toEqual([])

  const again = await setupDesk(host, PATHS, SETUP)
  expect(again.didWrite).toBe(false)
  expect(again.text).toContain('Already set up')
})

test('/clawd desk renders missing hooks with the app\'s own installer', async () => {
  const stripped: ClaudeSettings = { hooks: { Stop: [stateHook('Stop')] } }
  const disk: Disk = { [SETTINGS]: JSON.stringify(stripped), [PREFS]: JSON.stringify({ manageClaudeHooksAutomatically: false, autoStartWithClaude: true }) }
  const { host, runs } = fakeHost(disk)
  const done = await setupDesk(host, PATHS, SETUP)

  expect(runs).toEqual([['node', 'C:/plugin/tools/clawd-bridge.js', 'render-hooks', '--install-dir', APP, '--auto-start']])
  expect(done.text).toContain('added back the permission hook and the auto-start hook')
  expect(JSON.parse(disk[SETTINGS] ?? '').hooks).toEqual({ PermissionRequest: [PERMISSION], SessionStart: [AUTO_START] })
})

test('auto-start stays off when the app has it off', async () => {
  const disk: Disk = { [SETTINGS]: JSON.stringify({ hooks: { PermissionRequest: [PERMISSION] } }), [PREFS]: JSON.stringify({ autoStartWithClaude: false }) }
  const { host, runs } = fakeHost(disk)
  const done = await setupDesk(host, PATHS, SETUP)
  expect(runs).toEqual([])
  expect(done.didWrite).toBe(false)
})

test('when the installer fails, the per-event hooks still go and the reply says what is missing', async () => {
  const disk: Disk = { [SETTINGS]: JSON.stringify({ hooks: { Stop: [stateHook('Stop')] } }) }
  const { host } = fakeHost(disk, async () => ({ exitCode: 1, stdout: '', stderr: "Cannot find module 'install.js'" }))
  const done = await setupDesk(host, PATHS, SETUP)
  expect(done.didWrite).toBe(true)
  expect(done.text).toContain("Couldn't add back the permission hook (permission bubbles) or the auto-start hook: Cannot find module 'install.js'")
  expect(JSON.parse(disk[SETTINGS] ?? '').hooks).toEqual({})
})

test('/clawd desk changes nothing while the app manages its hooks, or when it cannot', async () => {
  const managed: Disk = { [SETTINGS]: JSON.stringify(INSTALLED), [PREFS]: JSON.stringify({ manageClaudeHooksAutomatically: true }) }
  const m = await setupDesk(fakeHost(managed).host, PATHS, SETUP)
  expect(m.didWrite).toBe(false)
  expect(m.text).toContain('"Disable automatic management only"')
  expect(Object.keys(managed)).toEqual([SETTINGS, PREFS])

  const broken: Disk = { [SETTINGS]: '{ not json' }
  expect((await setupDesk(fakeHost(broken).host, PATHS, SETUP)).text).toContain("Couldn't read")
  expect(broken[SETTINGS]).toBe('{ not json')

  expect((await setupDesk(fakeHost({}).host, PATHS, { ...SETUP, installDir: null })).text).toContain("Couldn't find Clawd on Desk")
  expect((await setupDesk(fakeHost({}).host, PATHS, { ...SETUP, isBridgeOn: false })).text).toContain('is off in /config')
})
