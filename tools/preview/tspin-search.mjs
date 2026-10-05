// Searches for T-spin showpieces: from an empty well, pieces chosen freely, every
// line clear a T-spin double or triple, ending on an empty well.
// node tools/preview/tspin-search.mjs [beam] [depth]
import './load.mjs'

const { rules, WELL_W, WELL_H } = await import('../../hooks/well.ts')
const { PIECES, KINDS, emptyBoard, place, fullRows, clearRows, moves, hasTSlot } = rules

const BEAM = Number(process.argv[2] ?? 4000)
const DEPTH = Number(process.argv[3] ?? 15)
const still = () => 1

const stats = board => {
  let holes = 0
  let cells = 0
  const heights = []
  for (let col = 0; col < WELL_W; col++) {
    const top = board.findIndex(line => line[col])
    heights.push(top < 0 ? 0 : WELL_H - top)
    if (top >= 0) for (let row = top + 1; row < WELL_H; row++) if (!board[row][col]) holes++
  }
  for (const line of board) for (const c of line) if (c) cells++
  const bumps = heights.slice(1).reduce((s, h, i) => s + Math.abs(h - heights[i]), 0)
  return { holes, cells, max: Math.max(...heights), bumps }
}
const key = board => board.map(l => l.map(c => (c ? 1 : 0)).join('')).join('/')

let beam = [{ board: emptyBoard(), script: [], spins: [] }]
const solutions = []
for (let depth = 1; depth <= DEPTH && beam.length; depth++) {
  const next = new Map()
  for (const state of beam) {
    for (const kind of KINDS) {
      for (const m of moves(state.board, kind, still)) {
        const placed = place(state.board, PIECES[kind].turns[m.turn], m.col, m.row, PIECES[kind].color)
        const rows = fullRows(placed)
        if (rows.length > 0 && !(m.isTSpin && rows.length >= 2)) continue
        const board = clearRows(placed, rows)
        const script = [...state.script, [kind, m.turn, m.col, m.row]]
        const spins = rows.length ? [...state.spins, rows.length] : state.spins
        const s = stats(board)
        if (rows.length && s.cells === 0) {
          if (spins.length >= 2) solutions.push({ script, spins })
          continue
        }
        if (s.max >= WELL_H - 1 || s.holes > 3) continue
        const value = spins.reduce((a, b) => a + b * 30, 0) + (hasTSlot(board) ? 25 : 0) - s.holes * 4 - s.bumps * 2 - s.max * 2 + Math.random() * 6
        const k = key(board) + '|' + spins.join(',')
        const old = next.get(k)
        if (!old || old.value < value) next.set(k, { board, script, spins, value })
      }
    }
  }
  beam = [...next.values()].sort((a, b) => b.value - a.value).slice(0, BEAM)
  console.error(`depth ${depth}: ${next.size} states, ${solutions.length} solutions`)
}
solutions.sort((a, b) => b.spins.length - a.spins.length || Math.max(...b.spins) - Math.max(...a.spins) || a.script.length - b.script.length)
const seen = new Set()
for (const s of solutions) {
  const id = s.spins.join(',') + ':' + s.script.length
  if (seen.has(id)) continue
  seen.add(id)
  console.log(JSON.stringify({ spins: s.spins, pieces: s.script.length, script: s.script }))
  if (seen.size >= 12) break
}
