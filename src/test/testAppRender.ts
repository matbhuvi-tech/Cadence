import React from 'react'
import { renderToString } from 'react-dom/server'

// Provide basic browser globals for SSR / test environment
if (typeof globalThis.window === 'undefined') {
  const listeners: Record<string, Function[]> = {}
  ;(globalThis as any).window = {
    addEventListener: (event: string, cb: Function) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(cb)
    },
    removeEventListener: (event: string, cb: Function) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((f) => f !== cb)
      }
    },
    dispatchEvent: (event: any) => true,
    location: { href: 'http://localhost:5173', search: '', pathname: '/' },
    localStorage: {
      getItem: (key: string) => null,
      setItem: (key: string, val: string) => {},
      removeItem: (key: string) => {},
      clear: () => {},
    },
    matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} }),
    __TAURI_INTERNALS__: undefined,
  }
}
if (typeof globalThis.document === 'undefined') {
  ;(globalThis as any).document = {
    getElementById: (id: string) => ({ innerHTML: '', appendChild: () => {} }),
    createElement: (tag: string) => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { style: {}, classList: { add: () => {}, remove: () => {} } },
  }
}
if (typeof globalThis.localStorage === 'undefined') {
  ;(globalThis as any).localStorage = (globalThis as any).window.localStorage
}

async function testAppRender() {
  console.log('Testing App component import and render...')
  try {
    const { App } = await import('../App.tsx')
    console.log('App imported successfully.')
    const html = renderToString(React.createElement(App))
    console.log(`App rendered successfully to string! Length: ${html.length} chars.`)
    console.log('Sample rendered output (first 300 chars):', html.slice(0, 300))
    return true
  } catch (err: any) {
    console.error('❌ FATAL: App component failed to render:', err)
    console.error(err.stack)
    return false
  }
}

testAppRender().then((ok) => {
  if (!ok) process.exit(1)
  console.log('✅ TEST PASSED: App renders without throwing!')
})
