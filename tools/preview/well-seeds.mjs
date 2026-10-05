// Searches seeds for block games worth keeping: each must end on a perfect clear.
// node tools/preview/well-seeds.mjs [from] [count]
import './load.mjs'

const { simulateWell } = await import('../../hooks/well.ts')

const from = Number(process.argv[2] ?? 0)
const count = Number(process.argv[3] ?? 2000)
const found = []
for (let seed = from; seed < from + count; seed++) {
  const game = simulateWell(seed)
  if (game) found.push({ seed, s: Math.round(game.ms / 1000), pieces: game.pieces, tSpins: game.tSpins, clears: game.clears, doubles: game.doubles })
}
found.sort((a, b) => b.tSpins - a.tSpins || b.doubles - a.doubles)
console.log(`${found.length} of ${count} seeds end on a perfect clear`)
console.table(found.slice(0, 25))
