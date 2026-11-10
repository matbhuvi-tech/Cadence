import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CadenceSettingsModal } from '../components/Modals/CadenceSettingsModal'
import { DEFAULT_PRIORITY_SETTINGS, evaluateCatalogProblems } from '../core/curatePriorities'

// Minimal browser globals for importing App / UI components in Node test runner.
if (typeof globalThis.window === 'undefined') {
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  }
  ;(globalThis as Record<string, unknown>).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    location: { href: 'http://localhost:5173', search: '', pathname: '/' },
    localStorage: storage,
    matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} }),
    __TAURI_INTERNALS__: undefined,
  }
  ;(globalThis as Record<string, unknown>).document = {
    getElementById: () => ({ innerHTML: '', appendChild: () => {} }),
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { style: {}, classList: { add: () => {}, remove: () => {} } },
  }
  ;(globalThis as Record<string, unknown>).localStorage = storage
}

const summary = evaluateCatalogProblems([], [], DEFAULT_PRIORITY_SETTINGS)

test('CadenceSettingsModal renders native dialog, tablist, and diagnostics panel cleanly', () => {
  const html = renderToStaticMarkup(
    createElement(CadenceSettingsModal, {
      isOpen: true,
      onClose: () => {},
      initialTab: 'diagnostics',
      prioritySettings: DEFAULT_PRIORITY_SETTINGS,
      prioritySummary: summary,
      onSavePrioritySettings: () => {},
    }),
  )

  assert.match(html, /<dialog\b[^>]*aria-labelledby=/)
  assert.doesNotMatch(html, /\brole="dialog"/)
  assert.doesNotMatch(html, /\baria-modal=/)
  assert.match(html, /role="tablist"/)
  assert.equal(html.match(/role="tab"/g)?.length, 3)
  assert.equal(html.match(/role="tabpanel"/g)?.length, 3)
  assert.match(html, /Debug Logging \(Idle Persistence\)/)
})

test('CadenceSettingsModal renders Priority Settings tab with all 14 categories and Info · Exempt', () => {
  const html = renderToStaticMarkup(
    createElement(CadenceSettingsModal, {
      isOpen: true,
      onClose: () => {},
      initialTab: 'priorities',
      prioritySettings: DEFAULT_PRIORITY_SETTINGS,
      prioritySummary: summary,
      onSavePrioritySettings: () => {},
    }),
  )

  assert.equal(html.match(/<select\b/g)?.length, 14)
  assert.match(html, /Info · Exempt/)
  assert.match(html, /Save priorities/)
})

test('CadenceSettingsModal renders Gemini API Key tab with key & model fields', () => {
  const html = renderToStaticMarkup(
    createElement(CadenceSettingsModal, {
      isOpen: true,
      onClose: () => {},
      initialTab: 'gemini',
      prioritySettings: DEFAULT_PRIORITY_SETTINGS,
      prioritySummary: summary,
      onSavePrioritySettings: () => {},
    }),
  )

  assert.match(html, /Gemini API key/)
  assert.match(html, /GEMINI_MODEL/)
  assert.match(html, /Remove saved key/)
})

test('AppContent renders always-visible Cadence Settings trigger without standalone floating Gemini button', async () => {
  const { AppContent } = await import('../App.tsx')
  const { AudioPlayerProvider } = await import('../context/AudioPlayerContext.tsx')
  const html = renderToStaticMarkup(
    createElement(AudioPlayerProvider, null, createElement(AppContent)),
  )
  assert.match(html, /aria-label="Open Cadence Settings"/)
  assert.doesNotMatch(html, /title="Gemini configuration"/)
})
