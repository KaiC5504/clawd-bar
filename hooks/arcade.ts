// The cabinet's other games, on a 10×6 screen: snake, breakout and a runner.
// Like the block game, each is played out once into a timeline of ticks, so any
// moment is a lookup, and each plays to a natural end: the snake grown long, the
// last brick broken, the last cactus cleared.

export const SCREEN_W = 10
export const SCREEN_H = 6

export type Px = [x: number, y: number, color: number]

const SNAKE = 0x6fcf97
const APPLE = 0xeb5757
const BRICKS = [0xeb5757, 0xf2994a]
const PADDLE = 0xf5f5f5
const BALL = 0xffd54f
const CACTUS = 0x66bb6a
const GROUND = 0x6e6e6e
// The little runner is coral like Clawd, a shade off so he's never mistaken for him.
const RUNNER = 0xf0a080

function random(seed: number): () => number {
  let s = seed
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
}

// --- Snake ----------------------------------------------------------------

// A loop through every cell of the screen. Riding it, the snake can never run into itself.
const CYCLE: [number, number][] = (() => {
  const path: [number, number][] = []
  for (let y = 0; y < SCREEN_H - 1; y++) for (let i = 1; i < SCREEN_W; i++) path.push([y % 2 === 0 ? i : SCREEN_W - i, y])
  for (let x = SCREEN_W - 1; x >= 0; x--) path.push([x, SCREEN_H - 1])
  for (let y = SCREEN_H - 2; y >= 0; y--) path.push([0, y])
  return path
})()

const SNAKE_TICK_MS = 110
const SNAKE_FULL = 28
const FLASHES = 8

type SnakeTick = { head: number; len: number; apple: number; flash?: number }

const SNAKE_TICKS: SnakeTick[] = (() => {
  const rand = random(7)
  const ticks: SnakeTick[] = []
  let head = 3
  let len = 3
  let apple = 12
  while (len < SNAKE_FULL) {
    head = (head + 1) % CYCLE.length
    if (head === apple) {
      len += 2
      // Somewhere ahead on the loop, so always on a free cell.
      apple = (head + 3 + Math.floor(rand() * (CYCLE.length - len - 4))) % CYCLE.length
    }
    ticks.push({ head, len, apple })
  }
  const last = ticks.at(-1)!
  for (let flash = 0; flash < FLASHES; flash++) ticks.push({ ...last, flash })
  return ticks
})()

export const SNAKE_MS = SNAKE_TICKS.length * SNAKE_TICK_MS

export function snakeAt(t: number): Px[] {
  const s = SNAKE_TICKS[Math.min(SNAKE_TICKS.length - 1, Math.floor(Math.max(0, t) / SNAKE_TICK_MS))]!
  if (s.flash !== undefined && s.flash % 2 === 1) return []
  const out: Px[] = []
  for (let i = 0; i < s.len; i++) {
    const [x, y] = CYCLE[(s.head - i + CYCLE.length) % CYCLE.length]!
    out.push([x, y, SNAKE])
  }
  if (s.flash === undefined) out.push([...CYCLE[s.apple]!, APPLE])
  return out
}

// --- Breakout -------------------------------------------------------------

const BALL_TICK_MS = 100
const BRICK_COUNT = 10

type BallTick = { x: number; y: number; bricks: number[]; flash?: number }

// Two rows of five bricks, two pixels wide; the paddle follows the ball and sends it back at an angle of its choosing.
const BREAKOUT_TICKS: BallTick[] = (() => {
  const rand = random(3)
  const bricks = new Set(Array.from({ length: BRICK_COUNT }, (_, i) => i))
  let x = 4
  let y = 4
  let vx = 1
  let vy = -1
  const ticks: BallTick[] = []
  const brickAt = (bx: number, by: number) => by * 5 + Math.floor(bx / 2)
  while (bricks.size > 0) {
    if (ticks.length > 2000) throw new Error('breakout: the ball never clears the bricks')
    if (x + vx < 0 || x + vx >= SCREEN_W) vx = -vx
    if (y + vy < 0) vy = -vy
    if (y + vy <= 1 && bricks.has(brickAt(x + vx, y + vy))) {
      bricks.delete(brickAt(x + vx, y + vy))
      vy = -vy
      // Between the ceiling and the brick it just broke, it goes on down through the gap.
      if (y + vy < 0) vy = 1
    }
    if (y + vy >= SCREEN_H - 1) {
      vy = -1
      vx = rand() < 0.5 ? -1 : 1
      if (x + vx < 0 || x + vx >= SCREEN_W) vx = -vx
    }
    x += vx
    y += vy
    ticks.push({ x, y, bricks: [...bricks] })
  }
  const last = ticks.at(-1)!
  for (let flash = 0; flash < FLASHES; flash++) ticks.push({ ...last, flash })
  return ticks
})()

export const BREAKOUT_MS = BREAKOUT_TICKS.length * BALL_TICK_MS

export function breakoutAt(t: number): Px[] {
  const s = BREAKOUT_TICKS[Math.min(BREAKOUT_TICKS.length - 1, Math.floor(Math.max(0, t) / BALL_TICK_MS))]!
  const out: Px[] = []
  for (const b of s.bricks) {
    const x = (b % 5) * 2
    const y = Math.floor(b / 5)
    out.push([x, y, BRICKS[y]!], [x + 1, y, BRICKS[y]!])
  }
  const paddle = Math.max(0, Math.min(SCREEN_W - 3, s.x - 1))
  for (let i = 0; i < 3; i++) out.push([paddle + i, SCREEN_H - 1, PADDLE])
  if (s.flash === undefined || s.flash % 2 === 0) out.push([s.x, s.y, BALL])
  return out
}

// --- Runner ---------------------------------------------------------------

const RUN_TICK_MS = 80
// Pixels between one cactus and the next.
const GAPS = [9, 13, 7, 11, 15, 8, 12, 9, 14, 7, 10, 13]
const RUNNER_X = 2
// Cacti start just off the right edge and are gone past the left one.
const CACTI = GAPS.map((_, i) => SCREEN_W + GAPS.slice(0, i + 1).reduce((a, b) => a + b, 0) - GAPS[0]!)
const RUN_TICKS = CACTI.at(-1)! + 2

export const RUNNER_MS = RUN_TICKS * RUN_TICK_MS

export function runnerAt(t: number): Px[] {
  const tick = Math.min(RUN_TICKS - 1, Math.floor(Math.max(0, t) / RUN_TICK_MS))
  const out: Px[] = []
  for (let x = 0; x < SCREEN_W; x++) if ((x + tick) % 3 !== 0) out.push([x, 4, GROUND])
  let jump = false
  for (const start of CACTI) {
    const x = start - tick
    if (x >= 0 && x < SCREEN_W) out.push([x, 2, CACTUS], [x, 3, CACTUS])
    // In the air from a few steps before the cactus until it's past him.
    if (x >= RUNNER_X && x <= RUNNER_X + 4) jump = true
  }
  const y = jump ? 0 : 2
  out.push([RUNNER_X, y, RUNNER], [RUNNER_X + 1, y, RUNNER])
  // Legs: both tucked in a jump, one at a time on the ground.
  if (jump) out.push([RUNNER_X, y + 1, RUNNER], [RUNNER_X + 1, y + 1, RUNNER])
  else out.push([tick % 4 < 2 ? RUNNER_X : RUNNER_X + 1, y + 1, RUNNER])
  return out
}
