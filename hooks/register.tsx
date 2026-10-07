import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { ClawdAct, Place, Run, Work } from '../types'
import { NO_ACTIVITY, applyActivity, withTaskCreated, withTaskUpdated, withTodos } from './activity'
import { ciLines, ciShown, divider, fitBand, gaugeColumns, sessionLines } from './band'
import { barMotion } from './bars'
import type { SessionShown } from './band'
import { DEMO_SCENES, DEMO_SCENE_MS, demoScene } from './demo'
import { CAME_BACK, canFeed, inspectDesk, setupDesk, slashes } from './desk'
import type { Desk, DeskHost, DeskPaths } from './desk'
import { fetchGhRun, ghAuthLine, ghToRun, latestGhRunId } from './ci/actions'
import { cmToRun, cmToken, fetchBuild, findApp, latestBuildId } from './ci/codemagic'
import { classify, parseCodemagicStarted, watchedRun } from './ci/detect'
import type { Host } from './ci/host'
import { originRemote, repoSlug } from './ci/repo'
import { addWatch, loadView, pollOnce, promiseWatches, showReplay, stopAll } from './ci/watcher'
import { applyEvent, initialPet, settleWork, visualFor, withUsage } from './pet-state'
import type { HookPayload } from './pet-state'
import { encode } from './pixels'
import { CABINET_GAMES, COLS as CLAWD_COLS, ROWS as CLAWD_ROWS, frameAt, isOnce, svgLoopMs } from './scenes'
import type { Extras } from './scenes'
import { svgFor } from './svg'
import { meters } from './usage'
import type { Meter } from './usage'

const RASTER_KEY = 'clawd'
const TICK_MS = 1000
// Scenes are drawn fresh each frame; a frame that matches the last one isn't sent.
const FRAME_MS = 100
// The bars' smallest step is a 35 ms drain; 40 ms catches each box.
const BAR_MS = 40
// How long Clawd may look busy while Claude Code says no turn is running.
const STALE_BUSY_MS = 5000
const CI_POLL_MS = 30_000
const GAP = 2
// 4 px to a pixel of his: crisp at 100%, 125% and 150% scaling alike.
const SVG_HEIGHT = 48
// A frame left without a width takes the browser's 300 px.
const SVG_ASPECT = (CLAWD_COLS * 2) / (CLAWD_ROWS * 4)
// The desktop counts its width in columns of about 9 px: Clawd's 120 px take 14 of
// them, and one ▊ draws half again as wide as a column in its font.
const DESKTOP_CLAWD_COLS = 14
const DESKTOP_BOX_COLS = 1.5
// Desktop Svgs kept built: every edit or command result can be its own.
const SVG_CACHE = 24
// The scenes that act out one call: a new call starts its scene over.
const CALL_ACTS: ReadonlySet<ClawdAct> = new Set(['editing', 'writing', 'running', 'ran', 'testing', 'tested', 'installing', 'installed', 'linking'])

const pet = atom({ plugin: 'clawd-bar', key: 'pet' } as const, initialPet(0))
const visual = atom({ plugin: 'clawd-bar', key: 'visual' } as const, { act: 'idle', label: 'Idle' })
const isHidden = atom({ plugin: 'clawd-bar', key: 'isHidden' } as const, false)
const activity = atom({ plugin: 'clawd-bar', key: 'activity' } as const, NO_ACTIVITY)
const place = atom({ plugin: 'clawd-bar', key: 'place' } as const, null)
const ciView = atom({ plugin: 'clawd-bar', key: 'view' } as const, null)
// Bumped once a second while a clock is on the band, so it redraws.
const second = atom({ plugin: 'clawd-bar', key: 'second' } as const, 0)
// Bumped when the demo moves to its next scene: the desktop redraws on this, not every second.
const demoStep = atom({ plugin: 'clawd-bar', key: 'demoStep' } as const, 0)
// Bumped when a moving usage bar changes how it looks.
const barFrame = atom({ plugin: 'clawd-bar', key: 'barFrame' } as const, 0)

const DENY = "clawd-bar is already watching this run in the background. End your turn; you'll get a new turn when it finishes."
const NO_TOKEN = "clawd-bar can't watch Codemagic without a token: set CODEMAGIC_API_TOKEN or write it to ~/.codemagic-token."

// Module state: a hot reload starts it over, while the atoms live on in $.state.
let settings = { installDir: '', nodePath: 'node', isPetOn: true, isBridgeOn: true, isCiOn: true, isContinueOn: true, ntfyTopic: '' }
let isReady = false
let dataDir = ''
let transcriptPath = ''
let selfRepo: string | null | undefined
let animation: { key: string; act: ClawdAct; startedAt: number; requestId: string; extras: Extras; painted: string } | null = null
let frameTimer: { cancel: () => void } | null = null
const bars = barMotion()
// What the terminal's bars last drew from, so the bar ticker can tell when a redraw is due.
let barsShown: { meters: Meter[]; boxes: number; look: string } | null = null
let barTimer: { cancel: () => void } | null = null
let hasClock = false
let demoStartedAt: number | null = null
let demoIndex = -1
// The desktop rebuilds an Svg's frame on every redraw; this is where its loop started.
let desktopPlay: { key: string; startedAt: number } | null = null
let isEngineWorking: boolean | null = null
const svgs = new Map<string, string>()
// Each spell at the cabinet starts on the next game.
let cabinetSpell = -1
let lastAct: ClawdAct | null = null

// Resolves to `fallback` instead of hanging a queue when `promise` never settles.
function within<T>($: EngineInterface, ms: number, promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = $.clock.after(ms, () => resolve(fallback))
    promise.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      () => {
        timer.cancel()
        resolve(fallback)
      },
    )
  })
}

type BridgeConfig = {
  nodePath: string
  script: string
  installDir: string
  stateFile: string
}

type BridgeStatus = {
  port: number | null
  claudePid: number | null
  forwarded: number
  failed: number
  lastError: string | null
}

type Endpoint = { port: number; claudePid: number | null }

const RE_ENSURE_AFTER_MS = 10000
const ENSURE_TIMEOUT_MS = 12000
const POST_TIMEOUT_MS = 2000

// Forwards classic hook payloads to tools/clawd-bridge.js, which runs the
// installed Clawd on Desk app's own hook code. Fire-and-forget, in arrival order.
let bridgeConfig: BridgeConfig | null = null
let endpoint: Promise<Endpoint | null> | null = null
let lastEnsureAt = 0
let chain: Promise<void> = Promise.resolve()
// Events wait on this, so none is dropped while the session looks for the app.
let deskReady: Promise<void> = Promise.resolve()
let desk: Desk | null = null
let deskPaths: DeskPaths | null = null
const DESK_RECHECK_MS = 8000

const bridgeStatus: BridgeStatus = { port: null, claudePid: null, forwarded: 0, failed: 0, lastError: null }

function configureBridge(next: BridgeConfig | null): void {
  bridgeConfig = next
  endpoint = null
}

async function ensureBridge($: EngineInterface): Promise<Endpoint | null> {
  if (!bridgeConfig) return null
  lastEnsureAt = await $.clock.now()
  try {
    const ran = await $.process.run(
      [bridgeConfig.nodePath, bridgeConfig.script, 'ensure', '--install-dir', bridgeConfig.installDir, '--state-file', bridgeConfig.stateFile],
      { timeoutMs: 10000 },
    )
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `ensure exited ${ran.exitCode}`)
    const info = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '') as { port: number; claudePid?: number }
    bridgeStatus.port = info.port
    bridgeStatus.claudePid = info.claudePid ?? null
    return { port: info.port, claudePid: info.claudePid ?? null }
  } catch (error) {
    bridgeStatus.lastError = String(error instanceof Error ? error.message : error)
    return null
  }
}

async function postEvent($: EngineInterface, target: Endpoint, body: string): Promise<boolean> {
  const sent = $.http
    .fetch(`http://127.0.0.1:${target.port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    .then(response => response.ok)
  return within($, POST_TIMEOUT_MS, sent, false)
}

async function sendEvent($: EngineInterface, event: string, payload: HookPayload, eventAt: number): Promise<void> {
  endpoint ??= ensureBridge($)
  let target = await within($, ENSURE_TIMEOUT_MS, endpoint, null)
  const body = (t: Endpoint) => JSON.stringify({ event, payload, claudePid: t.claudePid, eventAt })
  if (target && (await postEvent($, target, body(target)))) {
    bridgeStatus.forwarded += 1
    return
  }
  // The sidecar exits on its own (idle, app update): start it again, rate-limited.
  if ((await $.clock.now()) - lastEnsureAt >= RE_ENSURE_AFTER_MS) {
    endpoint = ensureBridge($)
    target = await within($, ENSURE_TIMEOUT_MS, endpoint, null)
    if (target && (await postEvent($, target, body(target)))) {
      bridgeStatus.forwarded += 1
      return
    }
  }
  bridgeStatus.failed += 1
}

function forwardEvent($: EngineInterface, event: string, payload: HookPayload, eventAt: number): void {
  if (!settings.isBridgeOn) return
  chain = chain
    .then(() => deskReady)
    .then(() => (bridgeConfig ? sendEvent($, event, payload, eventAt) : undefined))
    .catch(() => undefined)
}

function deskHost($: EngineInterface): DeskHost {
  return {
    readFile: path => $.fs.read(path),
    writeFile: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    run: (argv, timeoutMs = 15_000) => $.process.run(argv, { timeoutMs }),
  }
}

const bridgeScript = ($: EngineInterface) => `${slashes($.plugin.root)}/tools/clawd-bridge.js`

async function lookAtDesk($: EngineInterface, paths: DeskPaths): Promise<Desk> {
  const remembered = await $.store.get('deskInstallDir')
  const found = await inspectDesk(deskHost($), paths, {
    override: settings.installDir,
    remembered: typeof remembered === 'string' ? remembered : null,
  })
  if (found.installDir && found.installDir !== remembered) await $.store.set('deskInstallDir', found.installDir)
  return found
}

// The feed starts only once the app's own hooks are gone, and only at session start:
// this session's hooks were read from settings.json when it started.
async function prepareDesk($: EngineInterface, paths: DeskPaths): Promise<void> {
  desk = await lookAtDesk($, paths).catch(() => null)
  configureBridge(
    desk?.installDir && canFeed(desk)
      ? { nodePath: settings.nodePath, script: bridgeScript($), installDir: desk.installDir, stateFile: `${dataDir}/bridge.json` }
      : null,
  )
}

function readSettings(options: PluginOptions): typeof settings {
  return {
    installDir: slashes(String(options.clawdInstallDir ?? '')),
    nodePath: String(options.nodePath || 'node'),
    isPetOn: options.pet !== false,
    isBridgeOn: options.bridge !== false,
    isCiOn: options.ci !== false,
    isContinueOn: options.continueAfterBuilds !== false,
    ntfyTopic: String(options.ntfyTopic ?? ''),
  }
}

// Everything the CI watcher needs from the engine, as closures over `$`.
function hostFrom($: EngineInterface): Host {
  return {
    now: () => $.clock.now(),
    self: async () => {
      if (selfRepo === undefined) {
        const r = await $.process.run(['git', 'remote', 'get-url', 'origin'])
        selfRepo = r.exitCode === 0 ? repoSlug(r.stdout.trim()) : null
      }
      return { id: await $.session.id(), repo: selfRepo ?? undefined }
    },
    // The engine wants literal names here so it can list what the mod reads.
    env: async name => {
      if (name === 'CODEMAGIC_API_TOKEN') return $.env.get('CODEMAGIC_API_TOKEN')
      if (name === 'USERPROFILE') return $.env.get('USERPROFILE')
      if (name === 'HOME') return $.env.get('HOME')
      if (name === 'OS') return $.env.get('OS')
      return undefined
    },
    readFile: path => $.fs.read(path),
    fetch: (url, init) => $.http.fetch(url, init),
    run: (argv, timeoutMs = 30_000) => $.process.run(argv, { timeoutMs }),
    load: key => $.store.get(key),
    save: (key, value) => $.store.set(key, value),
    toast: text => $.ui.toast(text),
    submit: async text => {
      await $.prompt.submit({ text })
    },
    publish: async view => {
      await update($, ciView, () => view)
    },
  }
}

async function refreshVisual($: EngineInterface): Promise<void> {
  const next = visualFor(await read($, pet), await $.clock.now())
  const shown = await read($, visual)
  if (next.act !== shown.act || next.label !== shown.label) {
    await update($, visual, () => next)
  }
}

// The repo's name and branch for the footer; outside git, the folder's name.
async function refreshPlace($: EngineInterface): Promise<void> {
  const [remote, branch] = await Promise.all([
    $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: 5000 }).catch(() => null),
    $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 5000 }).catch(() => null),
  ])
  const folder = slashes(await $.session.cwd().catch(() => '')).split('/').pop() ?? ''
  const slug = remote?.exitCode === 0 ? repoSlug(remote.stdout.trim()) : ''
  const next: Place = {
    repo: slug.split('/').pop() || folder,
    branch: branch?.exitCode === 0 ? branch.stdout.trim() || null : null,
  }
  const shown = await read($, place)
  if (shown?.repo !== next.repo || shown?.branch !== next.branch) await update($, place, () => next)
}

async function observe($: EngineInterface, event: string, payload: HookPayload): Promise<void> {
  await ensureReady($)
  const now = await $.clock.now()
  if (typeof payload.transcript_path === 'string' && payload.transcript_path) {
    transcriptPath = payload.transcript_path
  }
  // TurnEnded is this mod's own; Clawd on Desk only knows the hook events.
  if (event !== 'TurnEnded') forwardEvent($, event, payload, now)
  if (!settings.isPetOn) return
  await update($, pet, p => applyEvent(p, event, payload, now))
  await update($, activity, a => applyActivity(a, event, payload, now))
  await refreshVisual($)
  // A shell command may have switched branches.
  if (event === 'PostToolUse' && (payload.tool_name === 'Bash' || payload.tool_name === 'PowerShell')) void refreshPlace($).catch(() => undefined)
}

const barLook = (meters: Meter[], boxes: number, now: number) => JSON.stringify(meters.map(m => bars.paint(m, boxes, now)))

async function barTick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const shown = barsShown
  if (!shown || !bars.isMoving(shown.meters, shown.boxes, now)) {
    barTimer?.cancel()
    barTimer = null
  }
  if (shown && barLook(shown.meters, shown.boxes, now) !== shown.look) await update($, barFrame, n => n + 1)
}

function stopAnimation(): void {
  frameTimer?.cancel()
  frameTimer = null
  animation = null
}

const cellsAt = (playing: NonNullable<typeof animation>, now: number) => encode(frameAt(playing.act, now - playing.startedAt, playing.extras))

async function paintFrame($: EngineInterface): Promise<void> {
  const playing = animation
  if (!playing) return
  const cells = cellsAt(playing, await $.clock.now())
  if (cells === playing.painted) return
  playing.painted = cells
  const blitted = await $.ui.blit({ requestId: playing.requestId, key: RASTER_KEY, cells })
  // Not mounted (band hidden or collapsed): rest until the next draw.
  if (blitted.deny !== undefined && animation === playing) stopAnimation()
}

async function tick($: EngineInterface): Promise<void> {
  // The backstop for an ending no event reported: Claude Code says no turn runs.
  const current = await read($, pet)
  if (isEngineWorking === false && current.state !== 'idle' && (await $.clock.now()) - current.lastActivityAt > STALE_BUSY_MS) {
    await observe($, 'TurnEnded', { reason: 'stale' })
  }
  const usage = await $.session.usage().then(u => u, () => null)
  if (usage) {
    const now = await $.clock.now()
    const latest = await read($, pet)
    const next = withUsage(latest, usage, now)
    if (next !== latest) await update($, pet, () => next)
  }
  await refreshVisual($)
  if (hasClock) await update($, second, n => n + 1)
  if (demoStartedAt !== null) {
    const index = Math.floor(((await $.clock.now()) - demoStartedAt) / DEMO_SCENE_MS)
    if (index !== demoIndex) {
      demoIndex = index
      await update($, demoStep, n => n + 1)
    }
  }
}

const pollOpts = () => ({ ntfyTopic: settings.ntfyTopic, canContinue: settings.isContinueOn })

async function deskLines($: EngineInterface): Promise<string[]> {
  if (!settings.isBridgeOn) return ['· Clawd on Desk feed off in /config']
  await deskReady
  const now = deskPaths ? await lookAtDesk($, deskPaths).catch(() => desk) : desk
  if (!now?.installDir) return ['· Clawd on Desk not found; if it\'s installed, set "Clawd on Desk app folder" in /config']
  if (!now.hooks) return ["✗ couldn't read Claude's settings.json, so clawd-bar isn't feeding Clawd on Desk"]
  const n = now.hooks.stateHooks
  if (n > 0) return [`· Clawd on Desk runs its own ${n} per-event hook${n === 1 ? '' : 's'}, so clawd-bar isn't feeding it: /clawd desk switches it over`]
  if (!bridgeConfig) return ['· Clawd on Desk is switched over; restart Claude Code to start feeding it']
  const s = bridgeStatus
  const lines = [
    `${s.port ? '✓' : '✗'} bridge sidecar ${s.port ? `on port ${s.port}` : 'not running'}, Claude pid ${s.claudePid ?? '?'}`,
    `  app folder ${bridgeConfig.installDir}`,
    `  forwarded ${s.forwarded}, failed ${s.failed}${s.lastError ? `, last error: ${s.lastError}` : ''}`,
  ]
  if (s.port) {
    const health = await within($, 1500, $.http.fetch(`http://127.0.0.1:${s.port}/health`).then(r => r.text), '')
    if (health) lines.push(`  sidecar says ${health}`)
  }
  if (!now.hooks.hasPermission) lines.push("✗ Clawd on Desk's permission hook is missing, so permission bubbles won't show: /clawd desk adds it back")
  return lines
}

async function runDesk($: EngineInterface): Promise<string> {
  await deskReady
  if (!deskPaths) return "clawd-bar couldn't find your home folder."
  const paths = deskPaths
  const found = await lookAtDesk($, paths)
  const done = await setupDesk(deskHost($), paths, {
    installDir: found.installDir,
    isBridgeOn: settings.isBridgeOn,
    nodePath: settings.nodePath,
    bridgeScript: bridgeScript($),
    now: await $.clock.now(),
  })
  if (done.didWrite) {
    // The app may still be watching settings.json and put its hooks back.
    $.clock.after(DESK_RECHECK_MS, () => {
      void lookAtDesk($, paths)
        .then(later => {
          if ((later.hooks?.stateHooks ?? 0) > 0) $.ui.toast(CAME_BACK)
        })
        .catch(() => undefined)
    })
  }
  return done.text
}

async function doctor($: EngineInterface): Promise<string> {
  const shown = await read($, visual)
  const lines = [`clawd-bar · ${settings.isPetOn ? `showing "${shown.label}" (${shown.act})` : 'pet off in /config'}`]
  if (settings.isCiOn) {
    const view = await loadView(hostFrom($))
    const token = await cmToken(hostFrom($))
    lines.push(`· CI: watching ${view.watches.length} run(s); Codemagic token ${token ? 'found' : 'not set'}; phone pushes ${settings.ntfyTopic ? 'on' : 'off'}`)
    lines.push(`  ${ghAuthLine(await hostFrom($).run(['gh', 'auth', 'status'], 5000).catch(() => null))}`)
  } else {
    lines.push('· CI watching off in /config')
  }
  lines.push(...(await deskLines($)))
  if (transcriptPath) lines.push(`· transcript ${transcriptPath}`)
  return lines.join('\n')
}

// Idempotent, and retried from later events: a session can start before a
// test has its fakes in place.
async function ensureReady($: EngineInterface): Promise<void> {
  if (isReady) return
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  if (!home) return
  isReady = true
  dataDir = `${slashes(home)}/.claude/clawd-bar`
  const [appData, localAppData, configDir] = await Promise.all([$.env.get('APPDATA'), $.env.get('LOCALAPPDATA'), $.env.get('CLAUDE_CONFIG_DIR')])
  deskPaths = {
    home: slashes(home),
    claudeDir: slashes(configDir || `${home}/.claude`),
    ...(appData ? { appData: slashes(appData) } : {}),
    ...(localAppData ? { localAppData: slashes(localAppData) } : {}),
  }
  configureBridge(null)
  if (settings.isBridgeOn) deskReady = prepareDesk($, deskPaths)
  if (settings.isCiOn) {
    const h = hostFrom($)
    $.clock.every(CI_POLL_MS, () => void pollOnce(h, pollOpts()).catch(() => undefined))
    void pollOnce(h, pollOpts()).catch(() => undefined)
  }
  if (!settings.isPetOn) return
  const now = await $.clock.now()
  if ((await read($, pet)).lastActivityAt === 0) await update($, pet, () => initialPet(now))
  await refreshVisual($)
  if ((await $.store.get('isHidden')) === true) await update($, isHidden, () => true)
  $.clock.every(TICK_MS, () => void tick($))
  void refreshPlace($).catch(() => undefined)
}

async function startSession($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'clawd',
    description: 'Show or hide Clawd above the prompt · /clawd doctor checks the setup · /clawd demo plays every state · /clawd desk feeds Clawd on Desk',
    argumentHint: '[doctor|demo|desk]',
  })
  if (settings.isCiOn) {
    // Another plugin may own /ci already; the band and the build watching don't need it.
    await $.command
      .register({ name: 'ci', description: 'Watch the latest CI run for this repo above the prompt (/ci stop to stop watching)' })
      .catch(() => undefined)
  }
  await ensureReady($)
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  await ensureReady($)
  if (args.trim() === 'desk') return runDesk($)
  if (args.trim() === 'doctor' || !settings.isPetOn) return doctor($)
  if (args.trim() === 'demo') {
    if (demoStartedAt !== null) {
      demoStartedAt = null
      await update($, second, n => n + 1)
      await update($, demoStep, n => n + 1)
      return 'Demo stopped.'
    }
    if (await read($, isHidden)) return 'Clawd is tucked away: /clawd to bring him back, then /clawd demo.'
    demoStartedAt = await $.clock.now()
    demoIndex = 0
    await update($, second, n => n + 1)
    await update($, demoStep, n => n + 1)
    return `Playing all ${DEMO_SCENES} states above the prompt, ${DEMO_SCENE_MS / 1000} s each, on a loop. /clawd demo stops it.`
  }
  const hide = !(await read($, isHidden))
  await update($, isHidden, () => hide)
  await $.store.set('isHidden', hide)
  return hide ? 'Clawd tucked away. /clawd brings him back.' : 'Clawd is back above the prompt.'
}

async function repoHere(h: Host) {
  const remote = await originRemote(h)
  return remote ? { remote, slug: repoSlug(remote) } : undefined
}

const isLive = (run: Run) => run.state === 'running' || run.state === 'queued'

async function runCi($: EngineInterface, args: string) {
  const h = hostFrom($)
  if (args.trim() === 'stop') {
    const n = await stopAll(h)
    return { text: n ? `Stopped watching ${n} run${n > 1 ? 's' : ''}.` : 'Nothing was being watched.' }
  }
  const here = await repoHere(h)
  if (!here) return { text: 'This folder has no git origin, so there is no CI to watch.' }

  // Look at both providers: a running Actions check beats yesterday's finished Codemagic build.
  const found: Run[] = []
  const token = await cmToken(h)
  const app = token ? await findApp(h, token, here.remote).catch(() => undefined) : undefined
  if (token && app) {
    const id = await latestBuildId(h, token, app.id).catch(() => undefined)
    if (id) found.push(cmToRun(await fetchBuild(h, token, id), here.slug))
  }
  let ghError: string | undefined
  try {
    const id = await latestGhRunId(h, here.slug)
    if (id) found.push(ghToRun(await fetchGhRun(h, here.slug, id), here.slug))
  } catch (err) {
    ghError = (err as Error).message
  }

  const live = found.find(isLive)
  if (live) {
    await addWatch(h, { provider: live.provider, id: live.id, repo: here.slug })
    await pollOnce(h, pollOpts())
    return { text: `Watching ${live.label}.` }
  }
  const newest = found.sort((a, b) => (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0))[0]
  if (newest) {
    await showReplay(h, newest)
    return { text: `${newest.label} already finished (${newest.state}). It's above the prompt; nothing to watch.` }
  }
  if (ghError) {
    return { text: /auth login/.test(ghError) ? "gh isn't logged in, so Actions can't be watched. Run `gh auth login`." : `Couldn't read Actions runs: ${ghError}` }
  }
  return { text: token ? `No Codemagic app or Actions run found for ${here.slug}.` : `No Actions run found for ${here.slug}, and no Codemagic token is set (CODEMAGIC_API_TOKEN or ~/.codemagic-token).` }
}

async function raceWatchedRun($: EngineInterface, command: string, isPromised: boolean) {
  const h = hostFrom($)
  const target = watchedRun(command)
  const repo = target?.repo ?? (await repoHere(h))?.slug
  if (!target || !repo) return false
  await addWatch(h, { provider: 'actions', id: target.id, repo, isPromised })
  $.clock.after(5_000, () => void pollOnce(h, pollOpts()).catch(() => undefined))
  return true
}

// A foreground watch is only refused when clawd-bar really is watching that run, so the
// reason it gives is true. Anything it can't take over runs as asked.
async function takeOverWatch($: EngineInterface, command: string, provider: 'codemagic' | 'actions') {
  if (provider === 'actions') return raceWatchedRun($, command, true)
  const h = hostFrom($)
  const here = await repoHere(h)
  if (!here) return false
  return promiseWatches(h, w => w.provider === 'codemagic' && w.repo.toLowerCase() === here.slug.toLowerCase())
}

type Shell = { command: string; run_in_background?: boolean; tool_use_id?: string }
type ShellResult = { deny?: string; isError?: boolean; text?: string; result?: { stdout?: string } | null }

async function onShell($: EngineInterface, e: Shell, next: (e: Shell) => Promise<ShellResult>) {
  const ran = await watchShell($, e, next)
  await settleShell($, e, ran)
  return ran
}

// The command's result, straight from the call, for its result scene; PostToolUse brings the same.
async function settleShell($: EngineInterface, e: Shell, ran: ShellResult): Promise<void> {
  if (!settings.isPetOn || ran.deny !== undefined) return
  const now = await $.clock.now()
  const payload = ran.isError ? { tool_use_id: e.tool_use_id, error: ran.text ?? '' } : { tool_use_id: e.tool_use_id, tool_response: ran.result }
  await update($, pet, p => settleWork(p, payload, ran.isError === true, now))
  await refreshVisual($)
}

async function watchShell($: EngineInterface, e: Shell, next: (e: Shell) => Promise<ShellResult>) {
  if (!settings.isCiOn) return next(e)
  const d = classify(e.command)
  // The refusal promises Claude a new turn, so it only happens when one will come.
  if (d.kind === 'foreground-watch' && settings.isContinueOn && !e.run_in_background && (await takeOverWatch($, e.command, d.provider))) {
    return { deny: DENY }
  }
  // Claude keeps its own watch, usually in the background, so this one races without promising a turn.
  if (d.kind === 'foreground-watch' && d.provider === 'actions') await raceWatchedRun($, e.command, false)
  const ran = await next(e)
  if (ran.deny !== undefined || ran.isError) return ran
  const h = hostFrom($)
  if (d.kind === 'codemagic-start') {
    const id = parseCodemagicStarted(String(ran.result?.stdout ?? ''))
    const here = await repoHere(h)
    if (id && here) {
      if (!(await cmToken(h))) {
        $.ui.toast(NO_TOKEN)
        return ran
      }
      await addWatch(h, { provider: 'codemagic', id, repo: here.slug })
      $.clock.after(5_000, () => void pollOnce(h, pollOpts()).catch(() => undefined))
    }
  } else if (d.kind === 'actions-start') {
    const repo = d.repo ?? (await repoHere(h))?.slug
    if (repo) {
      await addWatch(h, { provider: 'actions', id: '', repo, pending: { workflow: d.workflow, ref: d.ref, since: await h.now() } })
      $.clock.after(8_000, () => void pollOnce(h, pollOpts()).catch(() => undefined))
    }
  }
  return ran
}

type ToolRan = { deny?: string; isError?: boolean; result?: unknown }

// The session's task list, followed through the tools that change it.
async function onTasks($: EngineInterface, tool: string, input: Record<string, unknown>, ran: ToolRan): Promise<void> {
  if (ran.deny !== undefined || ran.isError) return
  if (tool === 'TodoWrite') {
    await update($, activity, a => withTodos(a, input.todos))
  } else if (tool === 'TaskCreate') {
    const task = (ran.result as { task?: { id?: unknown } } | null)?.task
    const id = typeof task?.id === 'string' ? task.id : ''
    await update($, activity, a => withTaskCreated(a, id, String(input.subject ?? ''), typeof input.activeForm === 'string' ? input.activeForm : undefined))
  } else if (tool === 'TaskUpdate') {
    await update($, activity, a => withTaskUpdated(a, String(input.taskId ?? ''), input))
  }
}

type BandEvent = Parameters<EngineInterface['ui']['resolve']>[0] & {
  requestId: string
  props: { hasSurvey: boolean; isWorking: boolean; bodyColumns: number }
}

async function drawBand($: EngineInterface, e: BandEvent, next: (e: BandEvent) => unknown) {
  if (e.props.hasSurvey || !settings.isPetOn || (await read($, isHidden))) {
    stopAnimation()
    return next(e)
  }
  isEngineWorking = e.props.isWorking
  const now = await $.clock.now()
  const isTerminal = e.surface === 'terminal'
  if (isTerminal) await read($, second)
  else await read($, demoStep)
  if (isTerminal) await read($, barFrame)
  const scene = demoStartedAt === null ? null : demoScene(now - demoStartedAt, now)
  const view = scene ? (scene.ci ?? null) : settings.isCiOn ? ((await read($, ciView)) ?? (await loadView(hostFrom($)))) : null
  const ci = scene || settings.isCiOn ? ciShown(view, now) : null
  const shownVisual = await read($, visual)
  const shownPet = await read($, pet)
  const session: SessionShown = scene?.session ?? {
    ...shownVisual,
    activity: await read($, activity),
    subagents: shownPet.subagents.length,
    place: await read($, place),
  }
  const act = ci?.act ?? session.act
  if (act === 'working' && lastAct !== 'working') cabinetSpell++
  lastAct = act
  const work: Work | null = (scene ? scene.work : shownPet.work) ?? null
  const extras: Extras = ci
    ? {}
    : {
        sweat: (scene ? scene.sweat : shownVisual.isSweating) === true,
        planes: session.subagents,
        ...(work ? { work } : {}),
        ...(act === 'working' ? { game: Math.max(0, cabinetSpell) % CABINET_GAMES } : {}),
      }
  const playKey = CALL_ACTS.has(act) && work ? `${act}:${work.id}` : act
  const usage = scene ? null : await $.session.usage().then(u => u, () => null)
  const meterList: Meter[] = scene ? scene.meters : usage ? meters(usage, now) : []
  hasClock = scene !== null || ci !== null || session.activity.turnStartedAt !== null
  // A live race's lanes move every second; on the desktop that's the one redraw a second worth its rebuild.
  if (!isTerminal && ci?.run) await read($, second)

  const columns = e.props.bodyColumns
  const clawdCols = isTerminal ? CLAWD_COLS : DESKTOP_CLAWD_COLS
  const boxCols = isTerminal ? 1 : DESKTOP_BOX_COLS
  const fit = fitBand(columns, clawdCols, meterList, 10, boxCols, !isTerminal)
  const textWidth = Math.max(10, columns - clawdCols - GAP - (fit.gauges ? fit.width + 2 : 0))
  const els = $.ui.resolve(e) as never as { Box: any; Text: any; Client?: any }
  const { Box, Client } = els
  const turnStartedAt = session.activity.turnStartedAt
  const turnClock =
    !isTerminal && Client && turnStartedAt !== null ? (
      <Client key="turn-clock" module="./ticker.tsx" props={{ elapsedMs: now - turnStartedAt }} />
    ) : undefined
  const lines = ci ? ciLines(els, ci, view, now, textWidth) : sessionLines(els, session, now, turnClock)
  // The terminal's bars move when their values change; the desktop's stand still, since a redraw there costs Clawd his frame.
  if (isTerminal) {
    bars.see(meterList, now)
    barsShown = { meters: meterList, boxes: fit.boxes, look: barLook(meterList, fit.boxes, now) }
    if (!barTimer && bars.isMoving(meterList, fit.boxes, now)) barTimer = $.clock.every(BAR_MS, () => void barTick($))
  }
  const paint = isTerminal ? (m: Meter, boxes: number) => bars.paint(m, boxes, now) : undefined
  const right = [
    <Box key="gauges" flexDirection="row" marginLeft={GAP} flexShrink={0}>
      {gaugeColumns(els, meterList, fit, paint)}
    </Box>,
    fit.gauges ? divider(els) : null,
    <Box key="lines" flexDirection="column" marginLeft={1} flexGrow={1} flexShrink={1} minWidth={0}>
      {lines}
    </Box>,
  ]

  if (e.surface === 'terminal') {
    const { Raster } = $.ui.resolve(e as never) as never as { Raster: any }
    // A new label over the same act keeps its place in the loop; a new call starts its scene over.
    if (!animation || animation.key !== playKey || animation.requestId !== e.requestId) {
      stopAnimation()
      animation = { key: playKey, act, startedAt: now, requestId: e.requestId, extras, painted: '' }
      frameTimer = $.clock.every(FRAME_MS, () => void paintFrame($))
    }
    animation.extras = work ? { ...extras, lead: animation.startedAt - work.startedAt } : extras
    animation.painted = cellsAt(animation, now)
    return (
      <Box flexDirection="row">
        <Raster key={RASTER_KEY} columns={CLAWD_COLS} rows={CLAWD_ROWS} cells={animation.painted} />
        {right}
      </Box>
    )
  }

  const { Svg } = $.ui.resolve(e as never) as never as { Svg: any }
  const drawn = CALL_ACTS.has(act) && work ? JSON.stringify({ ...work, id: undefined, startedAt: undefined }) : `${extras.game ?? ''}`
  const svgKey = `${act}:${extras.sweat ? 1 : 0}:${extras.planes ?? 0}:${drawn}`
  const svg = svgs.get(svgKey) ?? svgFor(act, extras)
  // Most recently used last, so the oldest goes first.
  svgs.delete(svgKey)
  svgs.set(svgKey, svg)
  if (svgs.size > SVG_CACHE) svgs.delete(svgs.keys().next().value!)
  if (desktopPlay?.key !== `${svgKey}:${playKey}`) desktopPlay = { key: `${svgKey}:${playKey}`, startedAt: now }
  // Start the rebuilt frame where the loop already is, so a redraw doesn't send him back to the start.
  const loop = svgLoopMs(act, extras)
  const into = isOnce(act) ? Math.min(now - desktopPlay.startedAt, loop) : (now - desktopPlay.startedAt) % loop
  const source = svg.replace('<style>', `<style>*{animation-delay:-${into}ms!important}`)
  return (
    <Box flexDirection="row" alignItems="center">
      <Svg source={source} alt={session.label} width={SVG_HEIGHT * SVG_ASPECT} height={SVG_HEIGHT} isInteractive />
      {right}
    </Box>
  )
}

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await startSession($)
    return next(e)
  })

  on('command.run', { command: 'clawd' }, async ($, e) => ({ text: await runCommand($, e.args) }))
  on('command.run', { command: 'ci' }, ($, e) => runCi($, e.args))

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => drawBand($, e as never, next as never) as never)

  on('tool.call', { tool: 'Bash' }, ($, e, next) => onShell($, e, next as never) as never)
  on('tool.call', { tool: 'PowerShell' }, ($, e, next) => onShell($, e, next as never) as never)
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    await onTasks($, 'TodoWrite', e as never, ran as never)
    return ran
  })
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    await onTasks($, 'TaskCreate', e as never, ran as never)
    return ran
  })
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    await onTasks($, 'TaskUpdate', e as never, ran as never)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await observe($, 'TurnEnded', { reason: e.reason })
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    await observe($, 'SessionStart', e)
    return next(e)
  })
  on('classic.SessionEnd', async ($, e, next) => {
    await observe($, 'SessionEnd', e)
    return next(e)
  })
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await observe($, 'UserPromptSubmit', e)
    return next(e)
  })
  on('classic.PreToolUse', async ($, e, next) => {
    // classic.PreToolUse carries the tool call envelope, not the hook's stdin JSON.
    const { tool, tool_use_id: toolUseId, consent: _consent, ...input } = e as unknown as Record<string, unknown>
    await observe($, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: await $.session.id(),
      transcript_path: transcriptPath,
      cwd: await $.session.cwd(),
      tool_name: tool,
      tool_input: input,
      tool_use_id: toolUseId,
    })
    return next(e)
  })
  on('classic.PostToolUse', async ($, e, next) => {
    await observe($, 'PostToolUse', e)
    return next(e)
  })
  on('classic.PostToolUseFailure', async ($, e, next) => {
    await observe($, 'PostToolUseFailure', e)
    return next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    await observe($, 'Stop', e)
    return next(e)
  })
  on('classic.StopFailure', async ($, e, next) => {
    await observe($, 'StopFailure', e)
    return next(e)
  })
  on('classic.SubagentStart', async ($, e, next) => {
    await observe($, 'SubagentStart', e)
    return next(e)
  })
  on('classic.SubagentStop', async ($, e, next) => {
    await observe($, 'SubagentStop', e)
    return next(e)
  })
  on('classic.PreCompact', async ($, e, next) => {
    await observe($, 'PreCompact', e)
    return next(e)
  })
  on('classic.PostCompact', async ($, e, next) => {
    await observe($, 'PostCompact', e)
    return next(e)
  })
  on('classic.Notification', async ($, e, next) => {
    await observe($, 'Notification', e)
    return next(e)
  })
  on('classic.Elicitation', async ($, e, next) => {
    await observe($, 'Elicitation', e)
    return next(e)
  })
}
