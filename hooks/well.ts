// The falling-block game Clawd plays while working: a 5×6 well, a seeded
// shuffle of pieces and a small AI that picks where each one goes, tucking under
// overhangs and spinning into slots. Each game is simulated once into a timeline,
// so any moment is a lookup. A game only ends on a perfect clear, and between
// games come scripted showpieces, T-spin after T-spin down to an empty well, so
// the loop runs for minutes with no visible seam.

export const WELL_W = 5
export const WELL_H = 6

export type Block = [col: number, row: number, color: number]
export type WellMood = 'steer' | 'drop' | 'twist' | 'clear' | 'tSpin' | 'perfect'
export type WellFrame = { blocks: Block[]; mood: WellMood }

type Cells = readonly (readonly [number, number])[]
type Kind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L'

const PIECES: Record<Kind, { color: number; turns: Cells[] }> = {
  I: { color: 0x56ccf2, turns: [[[0, 0], [1, 0], [2, 0], [3, 0]], [[0, 0], [0, 1], [0, 2], [0, 3]]] },
  O: { color: 0xf2c94c, turns: [[[0, 0], [1, 0], [0, 1], [1, 1]]] },
  T: { color: 0xbb6bd9, turns: [[[0, 0], [1, 0], [2, 0], [1, 1]], [[1, 0], [0, 1], [1, 1], [1, 2]], [[1, 0], [0, 1], [1, 1], [2, 1]], [[0, 0], [0, 1], [1, 1], [0, 2]]] },
  S: { color: 0x6fcf97, turns: [[[1, 0], [2, 0], [0, 1], [1, 1]], [[0, 0], [0, 1], [1, 1], [1, 2]]] },
  Z: { color: 0xeb5757, turns: [[[0, 0], [1, 0], [1, 1], [2, 1]], [[1, 0], [0, 1], [1, 1], [0, 2]]] },
  J: { color: 0x5b7fe6, turns: [[[0, 0], [0, 1], [1, 1], [2, 1]], [[0, 0], [1, 0], [0, 1], [0, 2]], [[0, 0], [1, 0], [2, 0], [2, 1]], [[1, 0], [1, 1], [0, 2], [1, 2]]] },
  L: { color: 0xf2994a, turns: [[[2, 0], [0, 1], [1, 1], [2, 1]], [[0, 0], [0, 1], [0, 2], [1, 2]], [[0, 0], [1, 0], [2, 0], [0, 1]], [[0, 0], [1, 0], [1, 1], [1, 2]]] },
}
const KINDS = Object.keys(PIECES) as Kind[]
const SPARK = 0xffe58a

const SOFT_MS = 130
const HARD_MS = 35
const TWIST_MS = 170
const FLASH_MS = 420
const SPARKLE_MS = 900
// A game must run at least this many pieces before a perfect clear may end it, and fails past the cap.
const MIN_PIECES = 30
const MAX_PIECES = 110
// Spins try the spot itself, then a step aside, then one or two steps down: enough to reach a slot.
const KICKS: [number, number][] = [[0, 0], [-1, 0], [1, 0], [0, 1], [-1, 1], [1, 1], [0, 2], [-1, 2], [1, 2]]

type Board = number[][]

const emptyBoard = (): Board => Array.from({ length: WELL_H }, () => Array<number>(WELL_W).fill(0))

const blocksOf = (board: Board): Block[] =>
  board.flatMap((line, row) => line.flatMap((color, col): Block[] => (color ? [[col, row, color]] : [])))

const width = (cells: Cells) => Math.max(...cells.map(([c]) => c)) + 1

function fits(board: Board, cells: Cells, col: number, row: number): boolean {
  return cells.every(([c, r]) => {
    const x = col + c
    const y = row + r
    return x >= 0 && x < WELL_W && y >= 0 && y < WELL_H && !board[y]![x]
  })
}

function place(board: Board, cells: Cells, col: number, row: number, color: number): Board {
  const next = board.map(line => [...line])
  for (const [c, r] of cells) next[row + r]![col + c] = color
  return next
}

const fullRows = (board: Board) => board.flatMap((line, row) => (line.every(Boolean) ? [row] : []))

function clearRows(board: Board, rows: number[]): Board {
  const kept = board.filter((_, row) => !rows.includes(row))
  return [...Array.from({ length: rows.length }, () => Array<number>(WELL_W).fill(0)), ...kept]
}

// mulberry32: tiny, seedable, good enough for a toy.
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function score(board: Board, cleared: number, noise: number): number {
  let holes = 0
  const heights: number[] = []
  for (let col = 0; col < WELL_W; col++) {
    const top = board.findIndex(line => line[col])
    heights.push(top < 0 ? 0 : WELL_H - top)
    if (top >= 0) for (let row = top + 1; row < WELL_H; row++) if (!board[row]![col]) holes++
  }
  const bumps = heights.slice(1).reduce((sum, h, i) => sum + Math.abs(h - heights[i]!), 0)
  return cleared * 8 - holes * 6 - heights.reduce((a, b) => a + b, 0) - bumps - Math.max(...heights) * 2 + (hasTSlot(board) ? 9 : 0) + noise
}

// A slot a T can spin into: a gap one wide with room for the T's arms above it,
// under a ledge on one side. Worth keeping open, so T-spins happen at all.
function hasTSlot(board: Board): boolean {
  const at = (x: number, y: number) => x < 0 || x >= WELL_W || y >= WELL_H || (y >= 0 && !!board[y]![x])
  for (let y = 1; y < WELL_H - 1; y++) {
    for (let x = 1; x < WELL_W - 1; x++) {
      const gap = !at(x, y + 1) && at(x - 1, y + 1) && at(x + 1, y + 1)
      const arms = !at(x - 1, y) && !at(x, y) && !at(x + 1, y)
      if (gap && arms && at(x - 1, y - 1) !== at(x + 1, y - 1)) return true
    }
  }
  return false
}

// A T-spin, by the usual rule: the T's last move was a turn and three of the four
// corners around its middle are blocked (walls and floor count).
function isTSpin(board: Board, cells: Cells, col: number, row: number): boolean {
  const middle = cells.find(([c, r]) => cells.filter(([c2, r2]) => Math.abs(c - c2) + Math.abs(r - r2) === 1).length === 3)
  if (!middle) return false
  const [mx, my] = [col + middle[0], row + middle[1]]
  const blocked = ([dx, dy]: [number, number]) => {
    const [x, y] = [mx + dx, my + dy]
    return x < 0 || x >= WELL_W || y >= WELL_H || (y >= 0 && !!board[y]![x])
  }
  return ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]).filter(blocked).length >= 3
}

type Step = { turn: number; col: number; row: number; kind: 'steer' | 'fall' | 'twist' }
type Move = { turn: number; col: number; row: number; steps: Step[]; isTSpin: boolean }

const fall = (board: Board, cells: Cells, steps: Step[], turn: number, col: number, row: number) => {
  while (fits(board, cells, col, row + 1)) steps.push({ turn, col, row: ++row, kind: 'fall' })
  return row
}

// Every reachable resting place: turn at the top, slide across and fall; then,
// at the bottom, tuck a step or two sideways or spin into a slot.
function moves(board: Board, kind: Kind, rand: () => number): Move[] {
  const turns = PIECES[kind].turns
  const start = Math.floor((WELL_W - width(turns[0]!)) / 2)
  if (!fits(board, turns[0]!, start, 0)) return []
  const found = new Map<string, Move>()
  const keep = (move: Move) => {
    const key = `${move.turn}:${move.col}:${move.row}`
    if (!found.has(key)) found.set(key, move)
  }

  const drops: Move[] = []
  turns.forEach((cells, turn) => {
    if (!fits(board, cells, start, 0)) return
    for (let col = 0; col + width(cells) <= WELL_W; col++) {
      const steps: Step[] = [{ turn: 0, col: start, row: 0, kind: 'steer' }]
      if (turn !== 0) steps.push({ turn, col: start, row: 0, kind: 'steer' })
      const dir = Math.sign(col - start)
      // Now and then he starts the wrong way and changes his mind.
      if (dir !== 0 && rand() < 0.15 && fits(board, cells, start - dir, 0)) {
        steps.push({ turn, col: start - dir, row: 0, kind: 'steer' }, { turn, col: start, row: 0, kind: 'steer' })
      }
      let ok = true
      for (let x = start; x !== col; x += dir) {
        if (!fits(board, cells, x + dir, 0)) {
          ok = false
          break
        }
        steps.push({ turn, col: x + dir, row: 0, kind: 'steer' })
      }
      if (!ok) continue
      const row = fall(board, cells, steps, turn, col, 0)
      drops.push({ turn, col, row, steps, isTSpin: false })
    }
  })
  // Plain drops first, so a spot a piece can simply fall into never gets a needless wiggle.
  drops.forEach(keep)

  for (const { turn, col, row, steps } of drops) {
    const cells = turns[turn]!
    for (const side of [-1, 1]) {
      const tuck = [...steps]
      for (let x = col + side; Math.abs(x - col) <= 2 && fits(board, cells, x, row); x += side) {
        tuck.push({ turn, col: x, row, kind: 'twist' })
        const landed = [...tuck]
        const r = fall(board, cells, landed, turn, x, row)
        if (r > row) {
          keep({ turn, col: x, row: r, steps: landed, isTSpin: false })
          break
        }
      }
    }
    for (const other of turns.keys()) {
      if (other === turn) continue
      const kick = KICKS.find(([dx, dy]) => fits(board, turns[other]!, col + dx, row + dy))
      if (!kick) continue
      const [x, y] = [col + kick[0], row + kick[1]]
      const spin: Step[] = [...steps, { turn: other, col: x, row: y, kind: 'twist' }]
      const r = fall(board, turns[other]!, spin, other, x, y)
      const endsTurning = spin.at(-1)!.kind === 'twist'
      keep({ turn: other, col: x, row: r, steps: spin, isTSpin: kind === 'T' && endsTurning && isTSpin(board, turns[other]!, x, r) })
    }
  }
  return [...found.values()]
}

// Fisher–Yates: the same order on every JS engine, unlike a random sort comparator.
function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

type Segment = { from: number; to: number; frame: (k: number) => WellFrame }
export type Game = { ms: number; segments: Segment[]; pieces: number; tSpins: number; clears: number; doubles: number }

// Where a move leaves the well, how many lines it clears, and what that's worth beyond the shape.
function land(board: Board, kind: Kind, m: Move, n: number) {
  const placed = place(board, PIECES[kind].turns[m.turn]!, m.col, m.row, PIECES[kind].color)
  const rows = fullRows(placed)
  const after = clearRows(placed, rows).map(line => [...line])
  const isEmpty = rows.length > 0 && after.every(line => line.every(c => !c))
  const bonus = (m.isTSpin ? (rows.length > 0 ? 25 * rows.length : 4) : 0) + (isEmpty && n >= MIN_PIECES ? 60 : 0)
  return { board: after, rows: rows.length, bonus }
}

// Turns moves into a timeline: each piece's steering, spins and fall, the flash
// of a clear, and the sparkle when the well comes up empty.
function player(rand: () => number) {
  const segments: Segment[] = []
  const tally = { pieces: 0, tSpins: 0, clears: 0, doubles: 0 }
  let t = 0
  let board = emptyBoard()
  const push = (ms: number, frame: Segment['frame']) => {
    segments.push({ from: t, to: t + ms, frame })
    t += ms
  }

  return {
    board: () => board,
    // Plays one move and says whether it left the well empty.
    play(kind: Kind, move: Move, { canPause = true } = {}): boolean {
      const { color, turns } = PIECES[kind]
      tally.pieces++
      const before = blocksOf(board)
      const steerMs = 110 + Math.floor(rand() * 4) * 15
      const fallMs = rand() < 0.3 ? HARD_MS : SOFT_MS
      const lengths = move.steps.map(s => (s.kind === 'steer' ? steerMs : s.kind === 'twist' ? TWIST_MS : fallMs))
      const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0))
      const steps = move.steps
      push(lengths.reduce((a, b) => a + b, 0), k => {
        let i = steps.length - 1
        while (i > 0 && starts[i]! > k) i--
        const { turn, col, row, kind: how } = steps[i]!
        const piece = turns[turn]!.map(([c, r]): Block => [col + c, row + r, color])
        return { blocks: [...before, ...piece], mood: how === 'steer' ? 'steer' : how === 'twist' ? 'twist' : 'drop' }
      })

      board = place(board, turns[move.turn]!, move.col, move.row, color)
      const rows = fullRows(board)
      if (rows.length === 0) {
        if (canPause && rand() < 0.25) {
          const still = blocksOf(board)
          push(120 + Math.floor(rand() * 4) * 60, () => ({ blocks: still, mood: 'drop' }))
        }
        return false
      }
      tally.clears++
      if (rows.length > 1) tally.doubles++
      if (move.isTSpin) tally.tSpins++
      const landed = blocksOf(board)
      const flash = move.isTSpin ? PIECES.T.color : 0xffffff
      push(FLASH_MS, k => ({
        blocks: landed.map(([col, row, c]): Block => [col, row, rows.includes(row) && k % 140 < 70 ? flash : c]),
        mood: move.isTSpin ? 'tSpin' : 'clear',
      }))
      board = clearRows(board, rows)
      return blocksOf(board).length === 0
    },
    // Twinkles across the empty well, one cell after another, and closes the timeline.
    finish(): Game {
      const cells = shuffle(Array.from({ length: WELL_W * WELL_H }, (_, i) => i), rand).slice(0, 6)
      push(SPARKLE_MS, k => ({
        blocks: cells.flatMap((cell, i): Block[] => (Math.abs(k - i * 120 - 120) < 110 ? [[cell % WELL_W, Math.floor(cell / WELL_W), SPARK]] : [])),
        mood: 'perfect',
      }))
      return { ms: t, segments, ...tally }
    },
  }
}

// One game from an empty well to a perfect clear, or null when it tops out or runs too long.
export function simulateWell(seed: number): Game | null {
  const rand = random(seed)
  const game = player(rand)
  let bag: Kind[] = []

  for (let n = 1; n <= MAX_PIECES; n++) {
    const board = game.board()
    if (bag.length === 0) bag = shuffle(KINDS, rand)
    // A friendly randomizer: every piece still comes once a bag, but he draws the
    // one that sits best now, with a little luck, so the tiny well rarely tops out.
    const picks = [...new Set(bag)].flatMap(kind => {
      const options = moves(board, kind, rand)
      if (options.length === 0) return []
      const rated = options.map(m => {
        const after = land(board, kind, m, n)
        return { m, value: after.bonus + score(after.board, after.rows, rand() * 2) }
      })
      const best = rated.reduce((x, y) => (y.value > x.value ? y : x))
      return [{ kind, move: best.m, value: best.value + rand() * 6 }]
    })
    if (picks.length === 0) return null
    const pick = picks.reduce((x, y) => (y.value > x.value ? y : x))
    bag.splice(bag.indexOf(pick.kind), 1)
    if (game.play(pick.kind, pick.move) && n >= MIN_PIECES) return game.finish()
  }
  return null
}

type Placement = [kind: Kind, turn: number, col: number, row: number]

// A scripted T-spin showpiece: every clear a T-spin, from an empty well to an empty one.
export function playShowpiece(script: readonly Placement[], seed: number): Game {
  const game = player(random(seed))
  for (const [kind, turn, col, row] of script) {
    const move = moves(game.board(), kind, () => 1).find(m => m.turn === turn && m.col === col && m.row === row)
    if (!move) throw new Error(`showpiece: no way to put ${kind} at ${turn}:${col}:${row}`)
    game.play(kind, move, { canPause: false })
  }
  return game.finish()
}

// Found by tools/preview/tspin-search.mjs. The T-spins in each, in lines cleared:
// 2-3-3 in ten pieces; 3-2-2-2-3 using all seven kinds; 2-2-3-2-3.
const SHOWPIECES: Placement[][] = [
  [['I', 0, 1, 5], ['J', 3, 3, 2], ['J', 0, 1, 2], ['T', 3, 0, 3], ['O', 0, 3, 2], ['Z', 1, 0, 2], ['T', 3, 2, 3], ['O', 0, 3, 3], ['J', 1, 0, 3], ['T', 1, 1, 3]],
  [['I', 0, 1, 5], ['S', 1, 1, 2], ['O', 0, 3, 3], ['T', 3, 0, 3], ['L', 3, 3, 3], ['J', 1, 0, 3], ['T', 2, 1, 3], ['Z', 1, 0, 2], ['O', 0, 3, 3], ['T', 1, 1, 3], ['T', 2, 1, 2], ['J', 1, 0, 2], ['T', 1, 3, 1], ['J', 2, 0, 3], ['T', 3, 3, 3]],
  [['Z', 1, 0, 3], ['S', 1, 3, 3], ['T', 2, 1, 4], ['L', 0, 2, 3], ['J', 0, 1, 2], ['T', 3, 0, 3], ['L', 3, 3, 3], ['T', 3, 0, 2], ['T', 3, 2, 3], ['S', 1, 3, 3], ['L', 1, 0, 2], ['T', 2, 1, 4], ['L', 3, 3, 3], ['L', 3, 0, 3], ['T', 3, 2, 3]],
]

// Picked by a seed search (tools/preview/well-seeds.mjs): each ends on a perfect
// clear with two T-spins, and they run 38, 59 and 50 s. The shortest goes first.
const SEEDS = [1010, 389, 12]

// Every game and showpiece starts and ends on an empty well, so they chain with no
// seam. The showpieces come between games in a mixed order, so none feels scheduled.
const TIMELINE: Game[] = [
  simulateWell(SEEDS[0]!)!,
  playShowpiece(SHOWPIECES[1]!, 1),
  simulateWell(SEEDS[1]!)!,
  playShowpiece(SHOWPIECES[0]!, 2),
  simulateWell(SEEDS[2]!)!,
  playShowpiece(SHOWPIECES[2]!, 3),
]
const SEGMENTS = TIMELINE.flatMap((game, i) => {
  const offset = TIMELINE.slice(0, i).reduce((sum, g) => sum + g.ms, 0)
  return game.segments.map(s => ({ ...s, from: s.from + offset, to: s.to + offset }))
})

export const WELL_LOOP_MS = TIMELINE.reduce((sum, g) => sum + g.ms, 0)
// The first game and showpiece alone also start and end empty: a shorter loop
// where size matters (the desktop's Svg).
export const WELL_SHORT_LOOP_MS = TIMELINE[0]!.ms + TIMELINE[1]!.ms

export function wellAt(t: number): WellFrame {
  const k = ((t % WELL_LOOP_MS) + WELL_LOOP_MS) % WELL_LOOP_MS
  let lo = 0
  let hi = SEGMENTS.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (SEGMENTS[mid]!.from <= k) lo = mid
    else hi = mid - 1
  }
  const seg = SEGMENTS[lo]!
  return seg.frame(k - seg.from)
}

// The game's rules, for tools/preview/tspin-search.mjs.
export const rules = { PIECES, KINDS, emptyBoard, place, fullRows, clearRows, moves, hasTSlot }
