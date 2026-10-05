import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_COLOR, canvas, dot, glyph, pack } from '../hooks/pixels'
import { COLS, ROWS, SCENE_NAMES, frameAt, loopMs, svgLoopMs } from '../hooks/scenes'
import { SVG_MAX_CHARS, svgFor } from '../hooks/svg'
import { WELL_H, WELL_LOOP_MS, WELL_W, simulateWell, wellAt } from '../hooks/well'

const BODY = [0xde886d, 0xa98276]
const EYE = 0x000000

// Every pixel the logo may cover: body, arms (out by one at most) and both leg stances.
const OUTLINE = new Set<string>()
for (let y = 0; y < 4; y++) for (let x = 3; x <= 14; x++) OUTLINE.add(`${x},${y}`)
for (const x of [0, 1, 2, 15, 16, 17]) OUTLINE.add(`${x},2`)
for (const x of [4, 5, 6, 7, 10, 11, 12, 13]) OUTLINE.add(`${x},4`)

const times = (scene: (typeof SCENE_NAMES)[number], step = 50) => {
  const out: number[] = []
  for (let t = 0; t < Math.min(loopMs(scene), 40_000); t += step) out.push(t)
  return out
}

describe('pixels', () => {
  test('four pixels pack into one quadrant block per cell', () => {
    const c = canvas(2, 1)
    dot(c, 0, 0, 0xff0000)
    dot(c, 1, 1, 0xff0000)
    dot(c, 2, 0, 0x00ff00)
    dot(c, 3, 0, 0x00ff00)
    expect(Array.from(pack(c))).toEqual(['▚'.codePointAt(0), 0xff0000, DEFAULT_COLOR, '▀'.codePointAt(0), 0x00ff00, DEFAULT_COLOR])
  })

  test('a full cell of two colours draws the smaller one over the larger', () => {
    const c = canvas(1, 1)
    for (const [x, y] of [[0, 0], [1, 0], [0, 1]] as const) dot(c, x, y, 0xde886d)
    dot(c, 1, 1, EYE)
    expect(Array.from(pack(c))).toEqual(['▗'.codePointAt(0), EYE, 0xde886d])
  })

  test('a character wins over the pixels under it', () => {
    const c = canvas(1, 1)
    dot(c, 0, 0, 0xde886d)
    glyph(c, 0, 0, 'z', 0x90a4ae)
    expect(Array.from(pack(c))).toEqual(['z'.codePointAt(0), 0x90a4ae, DEFAULT_COLOR])
  })
})

describe('scenes', () => {
  test('every scene draws on the same 15×3 canvas, so the text never shifts', () => {
    for (const scene of SCENE_NAMES) {
      const c = frameAt(scene, 0)
      expect([c.cols, c.rows]).toEqual([COLS, ROWS])
      expect(pack(c).length).toBe(COLS * ROWS * 3)
    }
  })

  test('his outline stays the logo in every frame: nothing of him leaves it', () => {
    for (const scene of SCENE_NAMES.filter(s => s !== 'interrupted')) {
      for (const t of times(scene)) {
        const c = frameAt(scene, t, { sweat: true, planes: 3 })
        c.px.forEach((color, i) => {
          if (color === undefined || !BODY.includes(color)) return
          const at = `${i % (COLS * 2)},${Math.floor(i / (COLS * 2))}`
          if (!OUTLINE.has(at)) throw new Error(`${scene} at ${t} ms puts him at ${at}`)
        })
      }
    }
  })

  test('his eyes are black whenever they are open', () => {
    for (const scene of SCENE_NAMES) {
      for (const t of times(scene, 200)) {
        const c = frameAt(scene, t)
        for (const i of [1 * COLS * 2 + 4, 1 * COLS * 2 + 5, 1 * COLS * 2 + 6]) {
          const color = c.px[i]
          if (color !== undefined && !BODY.includes(color)) expect(color).toBe(EYE)
        }
      }
    }
  })

  test('sleeping, dozing and error close his eyes with a line, not a colour', () => {
    const shut = (scene: (typeof SCENE_NAMES)[number], t = 0) => [2, 6].map(col => frameAt(scene, t).glyphs.get(col)?.[0])
    const line = '▁'.codePointAt(0)
    expect(shut('sleeping')).toEqual([line, line])
    expect(shut('error')).toEqual([line, line])
    expect(shut('ciFail')).toEqual([line, line])
    // Dozing peeks with one eye at a time.
    expect(shut('dozing', 2000)).toEqual([undefined, line])
    expect(shut('dozing', 6000)).toEqual([line, undefined])
  })

  test('sweat sits on top of any scene, and the planes follow the subagent count', () => {
    expect(frameAt('working', 0, { sweat: true }).px[0]).toBe(0x7cc4f2)
    expect(frameAt('working', 0).px[0]).toBeUndefined()
    const white = (planes: number) => frameAt('delegating', 600, { planes }).px.filter(c => c === 0xeeeeee).length
    expect(white(2)).toBeGreaterThan(white(1))
  })
})

describe('the falling-block game', () => {
  test('no piece ever overlaps a block or leaves the well', () => {
    // Every 30 ms: no step of the game is shorter than a 35 ms hard drop, so each position is seen.
    for (let k = 0; k < WELL_LOOP_MS; k += 30) {
      const seen = new Set<string>()
      for (const [col, row] of wellAt(k).blocks) {
        expect(col >= 0 && col < WELL_W && row >= 0 && row < WELL_H).toBe(true)
        expect(seen.has(`${col},${row}`)).toBe(false)
        seen.add(`${col},${row}`)
      }
    }
  })

  test('the well only ever empties by clearing lines, and every game ends on a perfect clear', () => {
    const settled = (k: number) => wellAt(k).blocks.filter(b => b[2] !== 0xffe58a).length
    const moods = new Set<string>()
    let perfects = 0
    for (let k = 10; k < WELL_LOOP_MS; k += 5) {
      const { mood } = wellAt(k)
      moods.add(mood)
      if (mood === 'perfect' && wellAt(k - 5).mood !== 'perfect') perfects++
      // Blocks only go away in a line clear, never in a wipe.
      if (settled(k) < settled(k - 5) - 4) expect(['clear', 'tSpin', 'perfect']).toContain(wellAt(k - 5).mood)
    }
    expect([...moods].sort()).toEqual(['clear', 'drop', 'perfect', 'steer', 'tSpin', 'twist'])
    expect(perfects).toBe(6)
    expect(wellAt(WELL_LOOP_MS - 1).mood).toBe('perfect')
    expect(WELL_LOOP_MS).toBeGreaterThan(120_000)
  })

  test('the showpieces clear only by T-spins, from an empty well to an empty one', () => {
    let k = 0
    let showpieces = 0
    while (k < WELL_LOOP_MS) {
      // A showpiece is the stretch between two perfect clears in which every clear is a T-spin.
      const clears: string[] = []
      while (k < WELL_LOOP_MS && wellAt(k).mood !== 'perfect') {
        const { mood } = wellAt(k)
        if ((mood === 'clear' || mood === 'tSpin') && wellAt(k - 5).mood !== mood) clears.push(mood)
        k += 5
      }
      if (clears.length >= 3 && clears.every(c => c === 'tSpin')) showpieces++
      while (k < WELL_LOOP_MS && wellAt(k).mood === 'perfect') k += 5
    }
    expect(showpieces).toBe(3)
  })

  test('T-spins are real: the T turns last, into a slot it could not fall into', () => {
    let spins = 0
    for (let seed = 0; seed < 40; seed++) spins += simulateWell(seed)?.tSpins ?? 0
    expect(spins).toBeGreaterThan(5)
  })

  test('he watches the well and never cheers a clear: feet planted, left arm down', () => {
    for (let t = 0; t < WELL_LOOP_MS; t += 50) {
      const c = frameAt('working', t)
      for (const x of [4, 6, 11, 13]) expect(c.px[4 * COLS * 2 + x]).toBe(0xde886d)
      expect(c.px[2 * COLS * 2]).toBeUndefined()
    }
  })
})

describe('desktop svg', () => {
  // Plays an svg's step-end keyframes at time t and reads back the pixel grid.
  function playAt(svg: string, total: number, t: number): (number | undefined)[] {
    const keys = new Map<string, [number, string][]>()
    for (const [, name, body] of svg.matchAll(/@keyframes (\w+)\{((?:[\d.]+%\{[^}]*\})+)\}/g)) {
      keys.set(name!, [...body!.matchAll(/([\d.]+)%\{([^}]*)\}/g)].map(([, p, v]) => [Number(p), v!]))
    }
    const px: (number | undefined)[] = new Array(COLS * 2 * ROWS * 2)
    for (const [, cls, fill, attr] of svg.matchAll(/<path(?: class="([\w ]+)")? fill="#(\w+)" d="([^"]*)"\/>/g)) {
      let d = attr!
      const name = cls?.split(' ').find(c => /^a\d+$/.test(c))
      if (name) {
        // Mid-sample, clear of the keyframe percents' rounding.
        const at = (((t % total) + 2.5) / total) * 100
        const style = keys.get(name)!.filter(([p]) => p <= at).at(-1)![1]
        d = /d:path\("([^"]*)"\)/.exec(style)?.[1] ?? ''
      }
      for (const [, x, y, w, h] of d.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)/g)) {
        for (let j = 0; j < Number(h) / 2; j++) {
          for (let i = 0; i < Number(w); i++) px[(Number(y) / 2 + j) * COLS * 2 + Number(x) + i] = parseInt(fill!, 16)
        }
      }
    }
    return px
  }

  test('at any moment it shows exactly the frame the terminal draws', () => {
    for (const scene of ['idle', 'thinking', 'working', 'delegating', 'done', 'interrupted', 'ciWin'] as const) {
      const svg = svgFor(scene, { planes: 2 })
      for (const t of times(scene, 245).filter(t => t < svgLoopMs(scene))) {
        expect(playAt(svg, svgLoopMs(scene), t)).toEqual(Array.from(frameAt(scene, t, { planes: 2 }).px))
      }
    }
  })

  test('every scene fits the Svg size cap, the full block game included', () => {
    for (const scene of SCENE_NAMES) expect(svgFor(scene, { sweat: true, planes: 3 }).length).toBeLessThan(SVG_MAX_CHARS)
    expect(svgFor('working')).toContain(`${svgLoopMs('working')}ms step-end infinite`)
  })

  test('his body is one shape; light sources glow on dark, white props get an outline on light', () => {
    expect(svgFor('interrupted').match(/<path[^>]*fill="#de886d"/g)).toHaveLength(1)
    expect(svgFor('thinking')).toMatch(/<path class="a\d+ g" fill="#ffd54f"/)
    expect(svgFor('delegating', { planes: 1 })).toMatch(/<g class="pale"><path [^>]*fill="#eeeeee"/)
    expect(svgFor('idle')).toContain('@media (prefers-color-scheme:dark){.g{filter:url(#glow)}}')
  })
})
