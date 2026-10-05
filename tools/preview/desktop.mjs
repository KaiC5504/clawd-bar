// Writes a page of every scene as the desktop draws it, dark and light side by side.
// node tools/preview/desktop.mjs OUT.html
import './load.mjs'
import { writeFileSync } from 'node:fs'

const { SCENE_NAMES } = await import('../../hooks/scenes.ts')
const { svgFor } = await import('../../hooks/svg.ts')

const out = process.argv[2] ?? 'desktop.html'
const HEIGHT = 60

// A sandboxed frame takes its colour scheme from the frame element, as the desktop's does.
const frame = (svg, scheme) =>
  `<iframe sandbox style="color-scheme:${scheme}" width="${HEIGHT * 2.5}" height="${HEIGHT}" srcdoc="${
    `<style>body{margin:0}svg{display:block;width:100%;height:100%}</style>${svg}`.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  }"></iframe>`

const rows = SCENE_NAMES.map(scene => {
  const svg = svgFor(scene, { planes: 2 })
  return `<tr><td>${scene}<br><small>${(svg.length / 1024).toFixed(1)} KB</small></td><td class="dark">${frame(svg, 'dark')}</td><td class="light">${frame(svg, 'light')}</td></tr>`
})

writeFileSync(out, `<!doctype html><meta charset="utf-8"><title>Desktop Clawd</title>
<style>body{font:13px system-ui;margin:16px;background:#888}td{padding:6px 12px}iframe{border:0;display:block}
.dark{background:#262624}.light{background:#faf9f5}small{opacity:.7}</style>
<table>${rows.join('\n')}</table>`)
console.log(`wrote ${out}`)
