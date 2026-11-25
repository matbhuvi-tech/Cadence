/**
 * Preload hook for Node + tsx frontend tests.
 * - Stubs `.css` imports so React components importing stylesheets can be imported in Node.
 * - Exposes `globalThis.React` for TSX files compiled under classic JSX runtime by tsx.
 */
import { registerHooks } from 'node:module'
import React from 'react'

if (typeof globalThis.React === 'undefined') {
  globalThis.React = React
}

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export default {};',
      }
    }
    return nextLoad(url, context)
  },
})
