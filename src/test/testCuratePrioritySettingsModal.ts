import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CuratePriorityPopover, updatePrioritySettingsDraft } from '../components/Curate/CuratePriorityPopover'
import { DEFAULT_PRIORITY_SETTINGS, evaluateCatalogProblems, loadPrioritySettings, resetPrioritySettings, savePrioritySettings } from '../core/curatePriorities'

test('Priority Settings displays all actionable rows and an informational exemption', () => {
  const summary = evaluateCatalogProblems([], [], DEFAULT_PRIORITY_SETTINGS)
  const draft = updatePrioritySettingsDraft(DEFAULT_PRIORITY_SETTINGS, 'missing_cover_art', 'P0')
  assert.equal(DEFAULT_PRIORITY_SETTINGS.missing_cover_art, 'P1')
  assert.equal(draft.missing_cover_art, 'P0')
  const markup = renderToStaticMarkup(createElement(CuratePriorityPopover, {
    settings: draft, summary, onSave: () => {},
  }))
  assert.equal(markup.match(/<select\b/g)?.length, 14)
  assert.match(markup, /Info · Exempt/)
  assert.match(markup, /Valid album artist and no composer/)
})

test('priority edits remain separate from persisted settings until saved', () => {
  const values = new Map<string, string>()
  const storage = {
    removeItem: (key: string) => { values.delete(key) },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  const saved = loadPrioritySettings(storage)
  const draft = updatePrioritySettingsDraft(saved, 'missing_cover_art', 'P0')
  assert.equal(loadPrioritySettings(storage).missing_cover_art, 'P1')
  savePrioritySettings(draft, storage)
  assert.equal(loadPrioritySettings(storage).missing_cover_art, 'P0')
  assert.deepEqual(resetPrioritySettings(storage), DEFAULT_PRIORITY_SETTINGS)
})
