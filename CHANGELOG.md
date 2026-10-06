# Changelog

## 0.7.0 — 2026-10-06

### Added
- Clawd acts out the call that's running, not just "working", with real text where pixels would
  only hint:
  - An edit shows a little editor headed by the file type, which swaps to the real diff (`-2+2`)
    while the old lines are wiped and the new ones type in. He glances at you when it lands.
  - A new file fills the editor under its line count (`+120`), then a tick.
  - A command shows a terminal headed by its program (`$ git`), its seconds counting up, and a
    `✓` or `✗` with its time when it ends.
  - A test run sweeps ten dots, then settles them to the real pass/fail share and shows the counts
    (`41 ✓` over `7 ✗`), read from vitest, jest, pytest, cargo, node, bun and mocha output. He
    cheers a pass and turns to you on a failure.
  - An install piles up parcels under the package manager's name.
  - An MCP tool plugs a cable into a socket marked with the server's initial in its colour.
- The game cabinet: a command running past 20 s gets him bored onto a game, and he goes back to
  its result when it ends. Snake, breakout and a runner join the falling-block game, each opening
  on its name and closing on `GG!`; the next slow command gets the next game.

### Changed
- The falling-block game is no longer what every edit, command and tool shows. It plays in the
  cabinet, and for tools with no scene of their own.
- A failed command or test run shows its own `✗` instead of the rain cloud; other failed tools
  still rain.
- On the desktop, a scene that plays once (an edit, a result) holds its last frame, and each call
  gets its own drawing.

## 0.6.0 — 2026-10-05

### Changed
- Clawd is the Claude Code logo, three terminal rows tall instead of five, drawn four pixels to a
  cell in quadrant blocks. The band is three rows.
- Every state is a scene with props instead of a few held poses: a bulb that won't quite switch on
  while he thinks, a scroll to read, a torch to search, an antenna to browse, paper planes for
  subagents, a bell when Claude needs you, a suitcase that won't close while context compacts,
  confetti when the turn ends, a rain cloud for errors, a skid when you stop a turn.
- While he works (edits, commands and most tools) he plays a falling-block game with tucks, spins
  and T-spins. Every game ends on a perfect clear, and T-spin showpieces play between games, so the
  loop runs for about three minutes without a seam.
- Usage shows as gauges: `ctx`, `5h` and `wk`, each a bar of boxes, green, yellow from 80 % and red
  from 90 %, with the time left until the limit resets. In a narrow terminal the bars shrink, then
  only the percents stay.
- Sweating past 90 % context plays over whatever he's doing rather than replacing it.
- An interrupted turn skids to a stop before he goes back to idling.
- The README's art is animated SVG drawn by the plugin's own code, and the demo video is gone.

### Added
- The gauges move when something happens: a new value fills in a box at a time, crossing 80 or 90
  sweeps the new colour across and flashes the percent, a limit that resets drains away and
  refills, and from 90 % the last box beats like a heart.
- `node tools/preview/live.mjs` plays every scene in your terminal.

### Known
- In the desktop app's Code tab his animation restarts whenever the band redraws. The terminal is
  the smooth one for now.

## 0.5.0 — 2026-10-05

### Added
- Clawd sweats when context passes 90 %. It plays once per crossing and comes back only after
  context drops below 90 % again, e.g. after a compact.
- Clawd slumps, exhausted, while a usage limit is used up, with the time until it resets. A turn
  or an alert still plays over it.
- Desktop notifications when a build finishes on macOS (`osascript`) and Linux (`notify-send`), not
  just Windows.
- `/clawd doctor` checks `gh auth status`.
- Tests run on GitHub Actions for every push and pull request.

## 0.4.0 — 2026-10-05

### Added
- `/clawd desk` switches Clawd on Desk over to clawd-bar in one command: it backs up
  `~/.claude/settings.json`, removes the app's per-event hooks and keeps its permission hook and
  auto-start.

### Changed
- The Clawd on Desk feed holds off while the app's own hooks are installed, so the desktop pet
  never hears an event twice.
- The CI follow-up prompt marks the failure log as untrusted output, and a new setting, **Let Claude
  continue after builds**, turns the follow-up turn off.

## 0.3.0 — 2026-10-05

### Changed
- The CI follow-up prompt is generic, so it works for every repo and user.
- The demo races clawd-bar's own release; the band uses Claude Code's theme colours.

## 0.2.0 — 2026-10-05

### Added
- Live lines beside Clawd: what's running and the turn clock, task progress, context and usage
  limits, repo and branch.
- CI races for GitHub Actions and Codemagic, with a ghost of your best run, toasts, ntfy pushes and
  a follow-up turn for Claude.
- `/clawd demo` plays every state on a loop.

### Fixed
- The band settles when a turn ends without a Stop hook (interrupts, API errors).
- Startup keeps going when another plugin already owns `/ci`.

## 0.1.0 — 2026-10-05

- First release: Clawd in a band above the prompt, acting out the session in whole-pixel poses, and
  an optional bridge to Clawd on Desk.
