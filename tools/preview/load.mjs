import { registerHooks } from 'node:module'

// The plugin imports its modules without extensions, the way Claude Code resolves them.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (err) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context)
      throw err
    }
  },
})
