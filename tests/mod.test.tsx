import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEMO_SCENES, DEMO_SCENE_MS } from '../hooks/demo'
import { encode } from '../hooks/pixels'
import { frameAt } from '../hooks/scenes'

const still = (act: Parameters<typeof frameAt>[0], t = 0) => encode(frameAt(act, t, { sweat: false, planes: 0 }))

const NOW = Date.parse('2026-10-05T10:00:00Z')
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

type Usage = { rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[] }

function fakeSession(on: On, calls: { argv: readonly string[] }[], blits: string[], runStdout = '', usage: Usage = {}) {
  // Absolute on every OS: the engine resolves a drive path like C:/ under the cwd on Linux.
  mock.env(on, { USERPROFILE: '/Users/tester' })
  mock.store(on)
  on('process.run', ($, e) => {
    calls.push({ argv: e.argv })
    const git = e.argv[0] === 'git'
    const stdout = git ? (e.argv[1] === 'branch' ? 'main\n' : 'https://github.com/KaiC5504/clawd-bar.git\n') : runStdout
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: 'C:/src/clawd-bar' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, tokens: 24000, percent: 12 }, rateLimits: usage.rateLimits ?? [] },
  }))
  // In a session the engine's classic hook runner sits beneath the plugins.
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.Stop', () => ({}))
  on('ui.blit', ($, e) => {
    if ('cells' in e) blits.push(e.cells)
    return { value: {} }
  })
}

const BAND = {
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
}

test('the band acts out the session on the terminal and the desktop', async ($, on) => {
  const calls: { argv: readonly string[] }[] = []
  const blits: string[] = []
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, calls, blits)

  await $.classic.SessionStart({ source: 'startup' })
  await $.classic.UserPromptSubmit({ prompt: 'hello' })
  await clock.settle()

  const terminal = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  expect(await terminal.find({ type: 'Text', text: /Thinking/ })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: 'ctx' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: '12%' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /clawd-bar · ⎇ main/ })).toBeDefined()
  const raster = await terminal.find({ type: 'Raster', key: 'clawd' })
  expect(raster?.props.columns).toBe(15)
  expect(raster?.props.rows).toBe(3)
  expect(raster?.props.cells).toBe(still('thinking'))

  // Frames are drawn every 100 ms but only sent when the picture changes:
  // nothing moves for his first 1.4 s of thinking, then he looks at the bulb.
  await clock.advance(1300)
  expect(blits).toEqual([])
  await clock.advance(400)
  expect(blits.length).toBeGreaterThan(0)
  expect(blits.at(-1)).toBe(still('thinking', 1700))
  await terminal.unmount()

  const desktop = await $.ui.mount({ plugin: 'clawd-bar', surface: 'desktop', ...BAND })
  // Sized to the art's shape; a frame given no width takes the browser's 300 px.
  const svg = await desktop.find({ type: 'Svg' })
  expect([svg?.props.width, svg?.props.height]).toEqual([120, 48])
  expect(svg?.props.source).toContain('color-scheme:light dark')
  await desktop.unmount()

  // No Clawd on Desk here: nothing but git was run.
  expect(calls.every(call => call.argv[0] === 'git')).toBe(true)
})

test('on the desktop the band fits its width, ticks the clock itself, and Clawd resumes mid-loop after a redraw', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, [], [], '', {
    rateLimits: [
      { kind: 'five_hour', percentUsed: 38, resetsAt: at(62) },
      { kind: 'seven_day', percentUsed: 22, resetsAt: at(84 * 60) },
    ],
  })
  await $.classic.SessionStart({ source: 'startup' })
  await $.classic.UserPromptSubmit({ prompt: 'hello' })
  await clock.settle()

  const DESK = { ...BAND, props: { ...BAND.props, bodyColumns: 94 } }
  const desktop = await $.ui.mount({ plugin: 'clawd-bar', surface: 'desktop', ...DESK })
  // The desktop stacks the meters a row each, so at 94 columns the bars keep all 10 boxes.
  for (const key of ['names', 'bars', 'percents', 'resets']) expect(await desktop.find({ type: 'Box', key })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: '▊▊▊▊▊▊▊▊▊' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: '↻ 3d 12h' })).toBeDefined()

  // Narrower, the bars go before the text does.
  const narrow = await $.ui.mount({ plugin: 'clawd-bar', surface: 'desktop', ...DESK, props: { ...DESK.props, bodyColumns: 66 } })
  expect(await narrow.find({ type: 'Box', key: 'bars' })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: '38%' })).toBeDefined()
  await narrow.unmount()
  const ticker = await desktop.find({ type: 'Client', key: 'turn-clock' })
  expect(ticker?.props.module).toBe('hooks/ticker.tsx')
  const delay = async () => /animation-delay:-(\d+)ms/.exec(String((await desktop.find({ type: 'Svg' }))?.props.source))?.[1]
  expect(await delay()).toBe('0')

  // The turn clock ticks in its own region, so the band itself doesn't redraw every second.
  await clock.advance(2300)
  expect(await delay()).toBe('0')
  await desktop.unmount()

  // A redraw rebuilds the frame; it starts where the loop already was, not at 0.
  const again = await $.ui.mount({ plugin: 'clawd-bar', surface: 'desktop', ...DESK })
  expect(/animation-delay:-(\d+)ms/.exec(String((await again.find({ type: 'Svg' }))?.props.source))?.[1]).toBe('2300')
  await again.unmount()
})

test('a tool call names what he is doing and counts the turn', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, [], [])
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} }) as never)

  await $.classic.SessionStart({ source: 'startup' })
  await $.classic.UserPromptSubmit({ prompt: 'fix it' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/src/clawd-bar/hooks/sprites.ts', old_string: 'a', new_string: 'b' } as never)
  await clock.advance(102_000)

  const band = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: 'Editing sprites.ts' })).toBeDefined()
  const edit = { id: '', kind: 'edit', startedAt: 0, ext: 'ts', removed: 1, added: 1 } as const
  expect((await band.find({ type: 'Raster', key: 'clawd' }))?.props.cells).toBe(encode(frameAt('editing', 0, { sweat: false, planes: 0, work: edit })))
  expect(await band.find({ type: 'Text', text: '1 tool · 1 file changed' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '1:42' })).toBeDefined()
  await band.unmount()

  await $.classic.Stop({ stop_hook_active: false })
  await clock.settle()
  const after = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  expect(await after.find({ type: 'Text', text: /Done in 1m 42s · 1 tool · 1 file/ })).toBeDefined()
  expect((await after.find({ type: 'Raster', key: 'clawd' }))?.props.cells).toBe(still('done'))
  await after.unmount()
})

test('a command plays its own scene, turns to the game cabinet when slow, and its result plays from the start', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const blits: string[] = []
  fakeSession(on, [], blits)
  // The command runs until the test lets it finish.
  let finish = (_: unknown) => {}
  on('tool.call', { tool: 'Bash' }, () => new Promise(resolve => (finish = resolve)) as never)

  // Claude Code says a turn runs, so the long wait below isn't taken for a stuck one.
  const busy = { ...BAND, props: { ...BAND.props, isWorking: true } }
  await $.classic.SessionStart({ source: 'startup' })
  await $.classic.UserPromptSubmit({ prompt: 'run the tests' })
  const ran = $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await clock.settle()

  const first = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...busy })
  expect(await first.find({ type: 'Text', text: 'Running npm test' })).toBeDefined()
  expect((await first.find({ type: 'Raster', key: 'clawd' }))?.props.cells).toBe(encode(frameAt('testing', 0, { lead: 0 })))
  await first.unmount()

  // Twenty seconds in, he gives up waiting and the cabinet comes out: every game opens on a blank title screen.
  await clock.advance(20_000)
  const bored = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...busy })
  expect((await bored.find({ type: 'Raster', key: 'clawd' }))?.props.cells).toBe(encode(frameAt('working', 0)))
  await bored.unmount()

  finish({ result: { stdout: '      Tests  48 passed (48)\n', stderr: '', interrupted: false } })
  await ran
  await clock.settle()
  const result = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...busy })
  blits.length = 0
  await clock.advance(1800)
  const passed = { id: '', kind: 'tests', startedAt: 0, result: { ok: true, ms: 20_000, passed: 48, failed: 0 } } as const
  expect(blits.at(-1)).toBe(encode(frameAt('tested', 1800, { sweat: false, planes: 0, work: passed })))
  await result.unmount()
})

test('on the desktop each call gets its own Svg, and a scene that plays once holds its last frame', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, [], [])
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} }) as never)
  // Claude Code says a turn runs, so the long wait below isn't taken for a stuck one.
  const busy = { ...BAND, props: { ...BAND.props, isWorking: true } }
  const source = async () => {
    const desktop = await $.ui.mount({ plugin: 'clawd-bar', surface: 'desktop', ...busy })
    const svg = String((await desktop.find({ type: 'Svg' }))?.props.source)
    await desktop.unmount()
    return svg
  }

  await $.classic.SessionStart({ source: 'startup' })
  await $.classic.UserPromptSubmit({ prompt: 'fix it' })
  await $.tool.call({ tool: 'Edit', file_path: 'D:/x/band.tsx', old_string: 'a', new_string: 'b' } as never)
  await clock.settle()
  const ts = await source()
  expect(ts).toContain('step-end 1 forwards')

  await $.tool.call({ tool: 'Edit', file_path: 'D:/x/main.py', old_string: 'a\nb\nc', new_string: 'd' } as never)
  await clock.settle()
  const py = await source()
  expect(py).not.toBe(ts)

  // Long after the edit, a redraw shows where the scene ended, not its start again.
  await clock.advance(60_000)
  expect(/animation-delay:-(\d+)ms/.exec(await source())?.[1]).toBe('4000')
})

test('an interrupted turn, which fires no Stop, skids to a stop and then idles', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, [], [])
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} }) as never)
  on('turn.complete', () => ({ text: '' }))

  await $.classic.SessionStart({ source: 'startup' })
  await $.classic.UserPromptSubmit({ prompt: 'fix it' })
  await $.tool.call({ tool: 'Edit', file_path: 'D:/x/band.tsx', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete({ answer: '', durationMs: 4000, isAborted: true, turnId: 't1', reason: 'aborted' })
  await clock.settle()

  const band = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: 'Interrupted' })).toBeDefined()
  expect((await band.find({ type: 'Raster', key: 'clawd' }))?.props.cells).toBe(still('interrupted'))
  expect(await band.find({ type: 'Text', text: /Editing/ })).toBeUndefined()
  await band.unmount()

  await clock.advance(3000)
  const later = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  expect(await later.find({ type: 'Text', text: 'Idle' })).toBeDefined()
  expect(await later.find({ type: 'Text', text: /Done in \d+s · 1 tool · 1 file/ })).toBeDefined()
  await later.unmount()
})

test('when Claude Code says no turn is running, a stuck Working settles by itself', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, [], [])
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} }) as never)

  await $.classic.SessionStart({ source: 'startup' })
  await $.classic.UserPromptSubmit({ prompt: 'fix it' })
  await $.tool.call({ tool: 'Edit', file_path: 'D:/x/band.tsx', old_string: 'a', new_string: 'b' } as never)
  const idleBand = { ...BAND, props: { ...BAND.props, isWorking: false } }
  const first = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...idleBand })
  expect(await first.find({ type: 'Text', text: /Editing/ })).toBeDefined()
  await first.unmount()

  await clock.advance(7000)
  const later = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...idleBand })
  expect(await later.find({ type: 'Text', text: 'Idle' })).toBeDefined()
  await later.unmount()
})

test('usage shows as boxed gauges with their reset countdowns, and shrinks to fit', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, [], [], '', {
    rateLimits: [
      { kind: 'five_hour', percentUsed: 61, resetsAt: at(62) },
      { kind: 'seven_day', percentUsed: 30, resetsAt: at(84 * 60) },
    ],
  })
  await $.classic.SessionStart({ source: 'startup' })
  await clock.settle()

  const band = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  for (const name of ['ctx', '5h', 'wk']) expect(await band.find({ type: 'Text', text: name })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '↻ 1h 2m' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '↻ 3d 12h' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^▊{10} 61%$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^▊{10} 30%$/ })).toBeDefined()
  await band.unmount()

  // Narrow: the bars shrink first; narrower still, only the percents are left.
  const mid = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 90 } })
  expect(await mid.find({ type: 'Text', text: /^▊{8} 61%$/ })).toBeDefined()
  await mid.unmount()
  const tight = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 72 } })
  expect(await tight.find({ type: 'Text', text: /▊/ })).toBeUndefined()
  expect(await tight.find({ type: 'Text', text: '61%' })).toBeDefined()
  expect(await tight.find({ type: 'Raster', key: 'clawd' })).toBeDefined()
  await tight.unmount()
})

test('the task list shows its progress', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, [], [])
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: {} }) as never)
  await $.classic.SessionStart({ source: 'startup' })
  await $.classic.UserPromptSubmit({ prompt: 'plan it' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Write the tests', status: 'completed', activeForm: 'Writing the tests' },
      { content: 'Fix the band', status: 'in_progress', activeForm: 'Fixing the band' },
    ],
  } as never)
  await clock.settle()

  const band = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: 'Tasks 1/2 ▶ Fixing the band' })).toBeDefined()
  await band.unmount()
})

const TYPED_CLAWD = {
  command: 'clawd',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
}

test('/clawd hides the band and brings it back', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, [], [])
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="beneath">nothing above the prompt</Text>
  })

  await $.classic.SessionStart({ source: 'startup' })
  await clock.settle()

  const hidden = await $.command.run(TYPED_CLAWD)
  expect(hidden.text).toContain('tucked away')
  const empty = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  expect(await empty.find({ type: 'Raster' })).toBeUndefined()
  await empty.unmount()

  await $.command.run(TYPED_CLAWD)
  const back = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  expect(await back.find({ type: 'Raster' })).toBeDefined()
  await back.unmount()
})

test('/clawd demo plays every state of the band, then stops', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, [], [])
  await $.classic.SessionStart({ source: 'startup' })
  await clock.settle()

  const started = await $.command.run({ ...TYPED_CLAWD, args: 'demo' })
  expect(started.text).toContain(`all ${DEMO_SCENES} states`)
  const seen: string[] = []
  for (let i = 0; i < DEMO_SCENES; i++) {
    const band = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
    expect(await band.find({ type: 'Raster', key: 'clawd' })).toBeDefined()
    const title = (await band.find({ type: 'Box' }))?.text ?? ''
    seen.push(title)
    await band.unmount()
    await clock.advance(DEMO_SCENE_MS)
  }
  expect(seen[0]).toContain('Idle')
  expect(seen.some(t => t.includes('Editing scenes.ts'))).toBe(true)
  expect(seen.some(t => t.includes('Actions release'))).toBe(true)
  expect(seen.some(t => t.includes('passed'))).toBe(true)
  expect(seen.some(t => t.includes('failed'))).toBe(true)

  expect((await $.command.run({ ...TYPED_CLAWD, args: 'demo' })).text).toBe('Demo stopped.')
  const back = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND })
  expect(await back.find({ text: /demo \d+\/\d+/ })).toBeUndefined()
  await back.unmount()
})

test('a race on a wide terminal keeps the gauges whole, and its lane stops at 30', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, [], [])
  await $.classic.SessionStart({ source: 'startup' })
  await clock.settle()
  await $.command.run({ ...TYPED_CLAWD, args: 'demo' })
  // The demo's CI scenes come last; the first of them is a live race.
  await clock.advance((DEMO_SCENES - 7) * DEMO_SCENE_MS)

  const band = await $.ui.mount({ plugin: 'clawd-bar', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 200 } })
  expect(await band.find({ type: 'Text', text: /^▊{10} 61%$/ })).toBeDefined()
  const you = String((await band.find({ type: 'Text', text: /^you / }))?.text)
  expect(/^you {3}([━▶·]+)/.exec(you)?.[1]).toHaveLength(31)
  await band.unmount()
})

const APP = '/Tools/Clawd/resources/app.asar.unpacked'
const SETTINGS = '/Users/tester/.claude/settings.json'
const STATE_HOOK = { matcher: '', hooks: [{ type: 'command', command: `"node" "${APP}/hooks/clawd-hook.js" Stop` }] }
const PERMISSION = { matcher: '', hooks: [{ type: 'http', url: 'http://127.0.0.1:23333/permission', timeout: 600 }] }
const AUTO_START = { matcher: '', hooks: [{ type: 'command', command: `"node" "${APP}/hooks/auto-start.js"` }] }

// The files the bridge looks at, kept in memory.
function fakeDisk(on: On, disk: Record<string, string>) {
  // The engine hands over /Users/... as D:/Users/... on Windows.
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('fs.exists', ($, e) => ({ value: norm(e.path) in disk }))
  on('fs.read', ($, e) => {
    const text = disk[norm(e.path)]
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    disk[norm(e.path)] = e.text
    return { value: undefined }
  })
}

function fakeBridge(on: On, posted: { event: string; claudePid: number }[]) {
  on('http.fetch', ($, e) => {
    if (e.url === 'http://127.0.0.1:4321/event' && e.init?.body) posted.push(JSON.parse(e.init.body))
    return { value: { status: 202, ok: true, headers: {}, text: '' } }
  })
}

test("once the app's own hooks are gone, events reach the sidecar in order", async ($, on) => {
  const calls: { argv: readonly string[] }[] = []
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, calls, [], '{"port":4321,"pid":9,"claudePid":77}\n')
  // The folder is found from the auto-start hook; nothing in /config.
  fakeDisk(on, { [SETTINGS]: JSON.stringify({ hooks: { PermissionRequest: [PERMISSION], SessionStart: [AUTO_START] } }), [`${APP}/hooks/clawd-hook.js`]: '' })
  const posted: { event: string; claudePid: number }[] = []
  fakeBridge(on, posted)

  await $.classic.SessionStart({ source: 'startup' })
  await $.classic.UserPromptSubmit({ prompt: 'go' })
  await $.classic.Stop({ stop_hook_active: false })
  await clock.settle()

  const ensure = calls.find(call => call.argv.includes('ensure'))
  expect(ensure?.argv).toContain(APP)
  expect(posted.map(p => p.event)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop'])
  expect(posted[0]?.claudePid).toBe(77)
})

test("while the app's own hooks are installed nothing is forwarded, and the doctor says how to switch", async ($, on) => {
  const calls: { argv: readonly string[] }[] = []
  const clock = mock.clock(on, { now: NOW })
  fakeSession(on, calls, [], '{"port":4321,"pid":9,"claudePid":77}\n')
  fakeDisk(on, { [SETTINGS]: JSON.stringify({ hooks: { Stop: [STATE_HOOK] } }), [`${APP}/hooks/clawd-hook.js`]: '' })
  const posted: { event: string; claudePid: number }[] = []
  fakeBridge(on, posted)

  await $.classic.SessionStart({ source: 'startup' })
  await $.classic.Stop({ stop_hook_active: false })
  await clock.settle()

  expect(calls.some(call => call.argv.includes('ensure'))).toBe(false)
  expect(posted).toEqual([])
  const doctor = await $.command.run({ ...TYPED_CLAWD, args: 'doctor' })
  expect(doctor.text).toContain("runs its own 1 per-event hook, so clawd-bar isn't feeding it: /clawd desk switches it over")
})

test('/clawd desk switches the hooks over, and warns when the app puts them back', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  fakeSession(on, [], [])
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const disk: Record<string, string> = {
    [SETTINGS]: JSON.stringify({ hooks: { PermissionRequest: [PERMISSION], SessionStart: [AUTO_START, STATE_HOOK] } }),
    [`${APP}/hooks/clawd-hook.js`]: '',
  }
  fakeDisk(on, disk)
  await $.classic.SessionStart({ source: 'startup' })
  await clock.settle()

  const done = await $.command.run({ ...TYPED_CLAWD, args: 'desk' })
  expect(done.text).toContain('removed its 1 per-event hook')
  expect(JSON.parse(disk[SETTINGS] ?? '').hooks).toEqual({ PermissionRequest: [PERMISSION], SessionStart: [AUTO_START] })
  expect((await $.command.run({ ...TYPED_CLAWD, args: 'doctor' })).text).toContain('restart Claude Code to start feeding it')

  // The app is still watching settings.json and restores its hook.
  disk[SETTINGS] = JSON.stringify({ hooks: { PermissionRequest: [PERMISSION], SessionStart: [AUTO_START, STATE_HOOK] } })
  await clock.advance(8000)
  await clock.settle()
  expect(toasts.some(t => t.includes('put its per-event hooks back'))).toBe(true)
})
