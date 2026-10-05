import type { ClientModule } from 'claude-code'

// The turn clock on the desktop. It ticks itself in its own region: a band
// redraw rebuilds Clawd's Svg frame there, so the band can't redraw every second.
//
// `elapsedMs` is the clock's reading when the band drew it; the module counts on
// from its own mount, so the engine's clock and this surface's never meet.
type Props = { elapsedMs: number }
type State = { since: number; from: number }

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = String(Math.floor((s % 3600) / 60))
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${m.padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

const Ticker: ClientModule<Props, State> = ({ elapsedMs }, surface) => {
  const { Text } = surface.elements
  const state = surface.state
  if (state === undefined) surface.every(1000, () => surface.setState({ ...surface.state! }))
  if (state === undefined || state.from !== elapsedMs) surface.setState({ since: Date.now(), from: elapsedMs })
  const shown = state && state.from === elapsedMs ? elapsedMs + Date.now() - state.since : elapsedMs
  return <Text bold>{clock(shown)}</Text>
}

export default Ticker
