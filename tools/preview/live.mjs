// Plays every scene in this terminal, the way the band will draw them.
//   node tools/preview/live.mjs            all scenes
//   node tools/preview/live.mjs working    just the ones named
//   add --sweat to see the high-context overlay on top
import './load.mjs'

const { frameAt, SCENE_NAMES, COLS, ROWS } = await import('../../hooks/scenes.ts')
const { pack, DEFAULT_COLOR } = await import('../../hooks/pixels.ts')

const args = process.argv.slice(2)
const sweat = args.includes('--sweat')
const picked = args.filter(a => !a.startsWith('--'))
const names = picked.length > 0 ? SCENE_NAMES.filter(n => picked.includes(n)) : SCENE_NAMES
const perRow = Math.max(1, Math.floor((process.stdout.columns || 80) / (COLS + 4)))
const tileW = COLS + 4

const color = (n, layer) =>
  n === DEFAULT_COLOR ? `\x1b[${layer === 'fg' ? 39 : 49}m` : `\x1b[${layer === 'fg' ? 38 : 48};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`

function screen(t) {
  const lines = []
  for (let i = 0; i < names.length; i += perRow) {
    const group = names.slice(i, i + perRow)
    const words = group.map(n => pack(frameAt(n, t, { sweat, planes: 2 })))
    for (let r = 0; r < ROWS; r++) {
      let line = ''
      for (const w of words) {
        for (let c = 0; c < COLS; c++) {
          const at = (r * COLS + c) * 3
          line += color(w[at + 1], 'fg') + color(w[at + 2], 'bg') + String.fromCodePoint(w[at])
        }
        line += '\x1b[0m' + ' '.repeat(tileW - COLS)
      }
      lines.push(line)
    }
    lines.push('\x1b[2m' + group.map(n => n.padEnd(tileW)).join('') + '\x1b[0m', '')
  }
  return lines
}

const start = Date.now()
process.stdout.write('\x1b[?25l\x1b[2J')
const restore = () => {
  process.stdout.write('\x1b[0m\x1b[?25h\n')
  process.exit(0)
}
process.on('SIGINT', restore)
setInterval(() => {
  process.stdout.write('\x1b[H' + screen(Date.now() - start).join('\n') + '\n\x1b[2mCtrl+C to stop\x1b[0m')
}, 100)
