import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

// The plugin imports its modules without extensions and writes its band in JSX
// against a global `h`, the way Claude Code loads it; Node does neither alone.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (err) {
      if (!specifier.startsWith('.')) throw err
      for (const ext of ['.ts', '.tsx']) {
        try {
          return next(specifier + ext, context)
        } catch {}
      }
      throw err
    }
  },
  load(url, context, next) {
    if (!url.endsWith('.tsx')) return next(url, context)
    const source = readFileSync(fileURLToPath(url), 'utf8')
    const { code } = transformSync(source, { loader: 'tsx', jsxFactory: 'h', jsxFragment: 'Fragment', format: 'esm' })
    return { format: 'module', source: code, shortCircuit: true }
  },
})

// What the band's JSX builds: plain nodes the layout in layout.mjs reads.
globalThis.h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
globalThis.Fragment = 'Fragment'
