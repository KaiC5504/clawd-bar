// Builds the README art in docs/readme/ as animated SVG, from the plugin's own
// code: Clawd from hooks/scenes.ts through the desktop's encoder, and the band's
// lines from hooks/band.tsx laid out as a terminal would.
//   cd tools/readme-art && npm ci && npm run build      (Windows: needs Cascadia Mono)
import './load.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

import { glyphs } from './glyphs.mjs'
import { layout } from './layout.mjs'

const { frameAt, svgLoopMs, COLS, ROWS } = await import('../../hooks/scenes.ts')
const { drawClawd } = await import('../../hooks/svg.ts')
const band = await import('../../hooks/band.tsx')
const { barMotion } = await import('../../hooks/bars.ts')
const { levelColor } = await import('../../hooks/usage.ts')
const { recordKey } = await import('../../hooks/ci/splits.ts')
const { wellAt, WELL_LOOP_MS } = await import('../../hooks/well.ts')

const OUT = new URL('../../docs/readme/', import.meta.url)
const SAMPLE_MS = 5

// Claude Code's dark theme, which the band's theme keys resolve to.
const PANEL = '#0d0f14'
const RULE = '#2c313c'
const TEXT = '#e2e5ea'
const DIM = '#7e8490'
const FAINT = '#525864'
const ORANGE = '#de886d'
const THEME = { success: '#4eba65', warning: '#ffc107', error: '#ff6b80', suggestion: '#b1b9f9' }

const SIZE = 20
const LINE = 26
const PAD = 28
const g = glyphs(SIZE)
const CELL = g.cell

const mix = (a, b, k) => {
  const ch = (x, s) => (parseInt(x.slice(1), 16) >> s) & 255
  const out = [16, 8, 0].map(s => Math.round(ch(a, s) * (1 - k) + ch(b, s) * k))
  return `#${out.map(n => n.toString(16).padStart(2, '0')).join('')}`
}
const colorOf = style => {
  const base = style.color ? (THEME[style.color] ?? style.color) : TEXT
  return style.dimColor ? (style.color ? mix(base, PANEL, 0.45) : DIM) : base
}

// --- Animation of anything that comes and goes -------------------------------

// Items keyed by what they draw; each shows and hides on step-end keyframes.
function animator(total, prefix) {
  const items = new Map()
  const names = new Map()
  const styles = []
  let last = new Set()
  return {
    see(t, list) {
      const now = new Map(list.map(i => [i.key, i.svg]))
      for (const key of new Set([...last, ...now.keys()])) {
        const on = now.has(key)
        let item = items.get(key)
        if (!item) {
          if (!on) continue
          item = { svg: now.get(key), track: t === 0 ? [[0, true]] : [[0, false], [t, true]] }
          items.set(key, item)
        } else if (item.track.at(-1)[1] !== on) item.track.push([t, on])
      }
      last = new Set(now.keys())
    },
    body() {
      return [...items.values()]
        .map(({ svg, track }) => {
          if (track.length === 1) return svg
          const keys = track.map(([t, on]) => `${+((t / total) * 100).toFixed(3)}%{opacity:${on ? 1 : 0}}`).join('')
          let name = names.get(keys)
          if (!name) {
            name = `${prefix}${names.size}`
            names.set(keys, name)
            styles.push(`@keyframes ${name}{${keys}}.${name}{animation:${name} ${total}ms step-end infinite}`)
          }
          return `<g class="${name}"${track[0][1] ? '' : ' opacity="0"'}>${svg}</g>`
        })
        .join('')
    },
    styles: () => styles.join(''),
  }
}

// Spans from the layout as drawable items, at a pixel origin.
function spanItems(spans, ox, oy) {
  return spans.map(({ x, y, text, style }) => {
    const left = ox + x * CELL
    const top = oy + y * LINE
    const color = colorOf(style)
    // A terminal joins box-drawing lines from row to row; a glyph alone leaves gaps.
    if (text === '│') return { key: `${x}:${y}:rule`, svg: `<rect x="${(left + CELL / 2 - 0.6).toFixed(1)}" y="${top}" width="1.2" height="${LINE}" fill="${color}"/>` }
    const ink = style.inverse ? PANEL : color
    const back = style.inverse ? `<rect x="${left.toFixed(1)}" y="${top + 3}" width="${(text.length * CELL).toFixed(1)}" height="${LINE - 4}" fill="${color}"/>` : ''
    const svg = `${back}<g fill="${ink}">${g.run(text, left, top + 19, !!style.bold)}</g>`
    return { key: `${x}:${y}:${JSON.stringify(style)}:${text}`, svg }
  })
}

// Clawd, drawn from a frame function, in a box of terminal cells.
function clawdBox(frame, total, x, y, prefix, w = COLS * CELL, h = ROWS * LINE) {
  const d = drawClawd(frame, total, { prefix, theme: 'dark' })
  return {
    defs: d.defs,
    styles: d.styles,
    svg: `<svg x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" viewBox="0 0 ${COLS * 2} ${ROWS * 4}" preserveAspectRatio="none" shape-rendering="crispEdges">${d.body}</svg>`,
  }
}

function document(width, height, parts, label) {
  const defs = parts.map(p => p.defs ?? '').join('') + g.defs()
  const styles = parts.map(p => p.styles ?? '').join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" width="${Math.round(width)}" height="${Math.round(height)}" role="img" aria-label="${label}">` +
    `<defs>${defs}</defs><style>${styles}</style>${parts.map(p => p.svg).join('')}</svg>`
  )
}

function save(name, svg) {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(new URL(name, OUT), svg)
  console.log(`docs/readme/${name}: ${(svg.length / 1024).toFixed(0)} KB`)
}

// --- The band ------------------------------------------------------------------

const ELS = { Box: 'Box', Text: 'Text' }
const BAND_COLS = 110
const BAND_W = BAND_COLS * CELL + 2 * PAD

// The band as register.tsx assembles it: Clawd, the gauges, the divider, the lines.
function bandSpans({ meters, paint, lines }) {
  const fit = band.fitBand(BAND_COLS, COLS, meters)
  const textWidth = Math.max(10, BAND_COLS - COLS - 2 - (fit.gauges ? fit.width + 2 : 0))
  const tree = h(
    'Box',
    { flexDirection: 'row' },
    h('Clawd', { width: COLS, height: ROWS }),
    h('Box', { flexDirection: 'row', marginLeft: 2, flexShrink: 0 }, band.gaugeColumns(ELS, meters, fit, paint)),
    fit.gauges ? band.divider(ELS) : null,
    h('Box', { flexDirection: 'column', marginLeft: 1, flexGrow: 1 }, lines(textWidth)),
  )
  return layout(tree, BAND_COLS).spans
}

// A band animation: `at(t)` says what the band shows at each moment.
function bandArt(name, total, at, label) {
  const height = PAD + ROWS * LINE + 16 + LINE + PAD - 6
  const text = animator(total, 't')
  const bars = barMotion()
  for (let t = 0; t < total; t += SAMPLE_MS) {
    const s = at(t)
    bars.see(s.meters, t)
    const spans = bandSpans({ ...s, paint: (m, boxes) => bars.paint(m, boxes, t) })
    const prompt = [{ x: 0, y: 0, text: '›', style: { bold: true } }]
    if (s.typed) prompt.push({ x: 2, y: 0, text: s.typed, style: {} })
    if (s.caret) prompt.push({ x: 2 + (s.typed?.length ?? 0), y: 0, text: '▏', style: {} })
    text.see(t, [...spanItems(spans, PAD, PAD), ...spanItems(prompt, PAD, PAD + ROWS * LINE + 16)])
  }
  const clawd = clawdBox(t => at(t).clawd, total, PAD, PAD, 'c')
  const rule = PAD + ROWS * LINE + 10
  const panel = `<rect width="${BAND_W.toFixed(0)}" height="${height}" rx="12" fill="${PANEL}"/><line x1="${PAD}" y1="${rule}" x2="${(BAND_W - PAD).toFixed(0)}" y2="${rule}" stroke="${RULE}"/>`
  save(name, document(BAND_W, height, [{ svg: panel }, clawd, { svg: text.body(), styles: text.styles() }], label))
}

// --- A session, start to finish ----------------------------------------------

const meter = (name, percent, resetIn) => ({ name, percent, color: levelColor(percent), ...(resetIn ? { resetIn } : {}) })
const usage = (ctx, five) => [meter('ctx', ctx), meter('5h', five, '2h 41m'), meter('wk', 22, '3d 12h')]
const PLACE = { repo: 'my-app', branch: 'main' }
const PROMPT = 'add a dark mode toggle to settings'
const TYPE_FROM = 600
const TYPE_MS = 45

const tasks = done =>
  [
    { id: '1', subject: 'Add the toggle', activeForm: 'Adding the toggle' },
    { id: '2', subject: 'Theme the settings page', activeForm: 'Theming the settings page' },
    { id: '3', subject: 'Run the tests', activeForm: 'Running the tests' },
  ].map((task, i) => ({ ...task, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' }))

// Where the block game shows a T-spin, so his first stretch of work lands on one.
const firstSpin = (() => {
  let k = 39_000
  while (k < WELL_LOOP_MS && wellAt(k).mood !== 'tSpin') k += 10
  return k
})()

const TURN = 3000
const NONE = { doing: null, turnStartedAt: null, tools: 0, files: [], lastTurn: null, tasks: [] }
const busy = more => ({ ...NONE, turnStartedAt: TURN, ...more })
const after = { ...NONE, lastTurn: { ms: 23_400, tools: 11, files: 3 } }
const SESSION = [
  { ms: 3000, act: 'idle', label: 'Idle', activity: { ...NONE, lastTurn: { ms: 48_000, tools: 6, files: 1 } }, use: usage(18, 76), typing: true },
  { ms: 2400, act: 'thinking', label: 'Thinking…', activity: busy({}), use: usage(19, 76) },
  { ms: 5400, act: 'working', from: firstSpin - 4200, label: 'Working · Edit', activity: busy({ doing: 'Editing theme.ts', tools: 3, files: ['a'], tasks: tasks(0) }), use: usage(26, 77) },
  { ms: 2600, act: 'reading', label: 'Working · Read', activity: busy({ doing: 'Reading settings.tsx', tools: 5, files: ['a'], tasks: tasks(1) }), use: usage(31, 78) },
  { ms: 3200, act: 'delegating', label: 'Juggling 2 subagents', subagents: 2, activity: busy({ doing: 'Handing off: Find hard-coded colours', tools: 6, files: ['a'], tasks: tasks(1) }), use: usage(35, 81) },
  { ms: 2800, act: 'calling', label: 'Needs you', activity: busy({ tools: 8, files: ['a', 'b'], tasks: tasks(2) }), use: usage(38, 81) },
  { ms: 3400, act: 'working', from: 9000, label: 'Working · Bash', activity: busy({ doing: 'Running npm test', tools: 10, files: ['a', 'b', 'c'], tasks: tasks(2) }), use: usage(41, 82) },
  { ms: 3200, act: 'done', label: 'Done!', activity: after, use: usage(42, 82) },
  { ms: 3000, act: 'dozing', label: 'Dozing', activity: after, use: usage(42, 82) },
  { ms: 4000, act: 'sleeping', label: 'Zzz', activity: after, use: usage(42, 82) },
]

function sessionAt(t) {
  let start = 0
  const beat = SESSION.find(b => (start += b.ms) > t) ?? SESSION.at(-1)
  const since = t - (start - beat.ms)
  const shown = { act: beat.act, label: beat.label, activity: beat.activity, subagents: beat.subagents ?? 0, place: PLACE }
  const typed = beat.typing && since >= TYPE_FROM ? PROMPT.slice(0, Math.floor((since - TYPE_FROM) / TYPE_MS) + 1) : ''
  return {
    meters: beat.use,
    clawd: frameAt(beat.act, since + (beat.from ?? 0), { planes: shown.subagents }),
    lines: () => band.sessionLines(ELS, shown, t),
    typed,
    caret: Math.floor(t / 500) % 2 === 0 || (beat.typing && typed.length > 0 && typed.length < PROMPT.length),
  }
}

// --- A CI race ------------------------------------------------------------------

const STEPS = ['Preparing runner', 'Fetching sources', 'Install packages', 'Sign the release', 'Build and test', 'Publish release']
const PB = [26, 44, 98, 121, 380, 430]
const RUN = [24, 41, 92, 117, 368, 418]
const RACE_MS = 11_000
const WIN_MS = 4500
const T0 = 1_700_000_000_000
const RECORD = { label: 'Actions release', total: PB.at(-1), steps: PB.map((at, i) => ({ name: STEPS[i], at })) }
const run = (startedAt, sec, state = 'running') => ({
  provider: 'actions',
  id: 'readme',
  repo: 'me/my-app',
  workflow: 'release',
  label: 'Actions release',
  branch: 'main',
  url: '',
  state,
  startedAt,
  ...(state === 'running' ? {} : { finishedAt: startedAt + RUN.at(-1) * 1000 }),
  steps: STEPS.map((name, i) => {
    const from = (RUN[i - 1] ?? 0) * 1000
    const to = RUN[i] * 1000
    const s = sec * 1000
    return { name, state: s >= to ? 'passed' : s >= from ? 'running' : 'pending', ...(s >= from ? { startedAt: startedAt + from } : {}), ...(s >= to ? { finishedAt: startedAt + to } : {}) }
  }),
})

let raceAct = null
let raceActFrom = 0
function raceAt(t) {
  // The run's 418 s, sped up to fit the race's 11 s.
  const sec = Math.min(RUN.at(-1), (t / RACE_MS) * RUN.at(-1))
  const now = T0 + sec * 1000
  const startedAt = T0
  const finished = t >= RACE_MS
  const r = run(startedAt, finished ? RUN.at(-1) : sec, finished ? 'passed' : 'running')
  const records = { [recordKey(r)]: RECORD }
  const view = finished
    ? { watches: [], records, notice: null, last: { run: r, isNewPB: true, at: now, isReplay: false } }
    : { watches: [{ provider: 'actions', id: 'readme', repo: r.repo, addedAt: T0, errors: 0, run: r }], records, notice: null, last: null }
  const shown = band.ciShown(view, now)
  if (shown.act !== raceAct) {
    raceAct = shown.act
    raceActFrom = t
  }
  return {
    meters: usage(52, 40),
    clawd: frameAt(shown.act, t - raceActFrom),
    lines: width => band.ciLines(ELS, shown, view, now, width),
    caret: Math.floor(t / 500) % 2 === 0,
  }
}

// --- The sprite sheet -------------------------------------------------------------

const SHEET = [
  ['SESSION', [
    ['idle', 'IDLE', 'nothing running'],
    ['thinking', 'THINKING', 'you send a prompt'],
    ['working', 'WORKING', 'edits, commands, tools'],
    ['reading', 'READING', 'Read'],
    ['searching', 'SEARCHING', 'Grep, Glob'],
    ['browsing', 'BROWSING', 'WebFetch, WebSearch'],
    ['delegating', 'DELEGATING', 'subagents run'],
    ['calling', 'NEEDS YOU', 'Claude asks you'],
    ['compacting', 'COMPACTING', 'context compacts'],
    ['done', 'DONE', 'the turn ends'],
    ['error', 'ERROR', 'a tool fails'],
    ['interrupted', 'INTERRUPTED', 'you stop a turn'],
    ['working', 'SWEATING', 'context past 90 %', { sweat: true }],
    ['dozing', 'DOZING', '1 minute idle'],
    ['sleeping', 'ASLEEP', '10 minutes idle'],
    ['waking', 'WAKING', 'back from a nap'],
    ['exhausted', 'EXHAUSTED', 'a usage limit runs out'],
  ]],
  ['CI RACE', [
    ['ciPrep', 'PREP', 'the runner starts'],
    ['ciFetch', 'FETCH', 'sources, packages'],
    ['ciSign', 'SIGN', 'signing'],
    ['ciBuild', 'BUILD', 'build and test'],
    ['ciPublish', 'PUBLISH', 'the release goes out'],
    ['ciWin', 'PASSED', 'the build passes'],
    ['ciFail', 'FAILED', 'the build fails'],
  ]],
]

function sheet() {
  const perRow = 4
  const tileW = (BAND_W - 2 * PAD) / perRow
  const tileH = ROWS * LINE + 76
  const parts = []
  const text = []
  let y = PAD
  let n = 0
  for (const [section, tiles] of SHEET) {
    text.push(...spanItems([{ x: 0, y: 0, text: section, style: { color: FAINT } }], PAD, y - 6))
    y += LINE
    tiles.forEach(([scene, name, trigger, extras = {}], i) => {
      const x = PAD + (i % perRow) * tileW
      const top = y + Math.floor(i / perRow) * tileH
      parts.push(clawdBox(t => frameAt(scene, t, { planes: 2, ...extras }), svgLoopMs(scene), x, top, `s${n++}`))
      text.push(...spanItems([{ x: 0, y: 0, text: name, style: { bold: true } }, { x: 0, y: 1, text: trigger, style: { dimColor: true } }], x, top + ROWS * LINE + 6))
    })
    y += Math.ceil(tiles.length / perRow) * tileH + 12
  }
  const height = y + PAD - 22
  const panel = `<rect width="${BAND_W.toFixed(0)}" height="${height}" rx="12" fill="${PANEL}"/>`
  save('sprite-sheet.svg', document(BAND_W, height, [{ svg: panel }, ...parts, { svg: text.map(t => t.svg).join('') }], 'Every state Clawd acts out, each playing live'))
}

// --- The wordmark ------------------------------------------------------------------

const LETTERS = {
  C: ['.###.', '##.##', '##...', '##...', '##...', '##.##', '.###.'],
  L: ['##...', '##...', '##...', '##...', '##...', '##...', '#####'],
  A: ['.###.', '##.##', '##.##', '#####', '##.##', '##.##', '##.##'],
  W: ['##...##', '##...##', '##...##', '##.#.##', '##.#.##', '#######', '.##.##.'],
  D: ['####.', '##.##', '##.##', '##.##', '##.##', '##.##', '####.'],
  '-': ['....', '....', '....', '####', '....', '....', '....'],
  B: ['####.', '##.##', '##.##', '####.', '##.##', '##.##', '####.'],
  R: ['####.', '##.##', '##.##', '####.', '##.#.', '##.##', '##.##'],
}

function wordmark() {
  const px = 7
  const word = 'CLAWD-BAR'
  const top = 3 * px
  const rects = []
  for (const [layer, color] of [[1, '#8a4a38'], [0, ORANGE]]) {
    let x = 0
    for (const c of word) {
      LETTERS[c].forEach((row, j) =>
        [...row].forEach((cell, i) => {
          if (cell === '#') rects.push(`<rect x="${(x + i + layer) * px}" y="${top + (j + layer) * px}" width="${px}" height="${px}" fill="${color}"/>`)
        }),
      )
      x += LETTERS[c][0].length + 1
    }
  }
  const lettersW = [...word].reduce((sum, c) => sum + LETTERS[c][0].length + 1, 0)
  // His pixels are twice as tall as wide, as in a terminal; his feet stand on the letters' baseline.
  const clawdX = (lettersW + 3) * px
  const baseline = top + 7 * px
  const d = drawClawd(t => frameAt('idle', t), svgLoopMs('idle'), { prefix: 'w' })
  const clawd = `<svg x="${clawdX}" y="${baseline - 5 * 2 * px}" width="${COLS * 2 * px}" height="${ROWS * 2 * 2 * px}" viewBox="0 0 ${COLS * 2} ${ROWS * 4}" preserveAspectRatio="none" shape-rendering="crispEdges">${d.body}</svg>`
  const width = clawdX + COLS * 2 * px
  const height = baseline + 2 * px
  save('wordmark.svg', document(width, height, [{ svg: `<g shape-rendering="crispEdges">${rects.join('')}</g>` }, { defs: d.defs, styles: d.styles, svg: clawd }], 'clawd-bar'))
}

wordmark()
sheet()
bandArt('session.svg', SESSION.reduce((sum, b) => sum + b.ms, 0), sessionAt, 'The band above the Claude Code prompt through one session')
bandArt('ci-race.svg', RACE_MS + WIN_MS, raceAt, 'A CI build racing its personal best in the band')
