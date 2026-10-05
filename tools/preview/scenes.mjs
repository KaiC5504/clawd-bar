// Dumps every scene's frames as Raster words, for tools/readme-art/sheet.py.
import './load.mjs'

const { frameAt, loopMs, SCENE_NAMES, COLS, ROWS } = await import('../../hooks/scenes.ts')
const { pack } = await import('../../hooks/pixels.ts')

const STEP = Number(process.argv[2] ?? 100)
const scenes = {}
for (const name of SCENE_NAMES) {
  const frames = []
  for (let t = 0; t < loopMs(name); t += STEP) frames.push(Array.from(pack(frameAt(name, t, { planes: 2 }))))
  scenes[name] = frames
}
process.stdout.write(JSON.stringify({ cols: COLS, rows: ROWS, step: STEP, scenes }))
