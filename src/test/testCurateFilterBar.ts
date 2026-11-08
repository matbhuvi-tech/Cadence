import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildCurateFilterBarModel, CurateAlbumSearch, CurateFilterBar } from '../components/Curate/CurateFilterBar'
import { DEFAULT_PRIORITY_SETTINGS, evaluateCatalogProblems, type CurateFilterState } from '../core/curatePriorities'
import type { Release, Track } from '../core/types'

const albums = [{ id: 'a', title: 'Harbor Lights' }, { id: 'b', title: 'Harbor Dawn', releaseYear: 2000 }] as Release[]
const tracks = albums.map(album => ({ id: album.id + '-track', releaseId: album.id, title: 'Overture' })) as Track[]
const settings = { ...DEFAULT_PRIORITY_SETTINGS, missing_release_year: 'P0' as const }
const summary = evaluateCatalogProblems(tracks, albums, settings)
const filter: CurateFilterState = { priorities: ['P0'], categories: ['missing_release_year'], selectedAlbumIdFilter: 'b' }

test('counts stay global and album search follows chip filters and remapped categories', () => {
  const model = buildCurateFilterBarModel(summary, settings, filter, 'HARBOR', albums)
  assert.deepEqual(model.albumSuggestions.map(album => album.id), ['a'])
  assert.equal(model.groups[0].count, summary.priorityAlbumCounts.P0)
  assert.deepEqual(model.groups[0].categories.find(row => row.id === 'missing_release_year')?.affected, { count: 1, unit: 'releases' })
  assert.equal(buildCurateFilterBarModel(summary, settings, filter, 'unmatched', albums).searchMessage, 'No matching albums')
  assert.deepEqual(filter.categories, ['missing_release_year'])
})

test('reset is shown for an active filter only', () => {
  const props = { summary, settings, albums, onFilterChange: () => {} }
  assert.doesNotMatch(renderToStaticMarkup(createElement(CurateFilterBar, { ...props, filter: { priorities: [], categories: [] } })), /Reset Filters/)
  assert.match(renderToStaticMarkup(createElement(CurateFilterBar, { ...props, filter })), /Reset Filters/)
})

test('sidebar shows collapsible priorities and expands the group containing a saved selection', () => {
  const markup = renderToStaticMarkup(createElement(CurateFilterBar, {
    summary, settings, filter, albums, onFilterChange: () => {},
  }))
  assert.match(markup, /aria-label="Curate filters"/)
  assert.match(markup, /All Issues/)
  assert.match(markup, /<details[^>]* open=""[^>]*><summary[^>]*>[\s\S]*?P0/)
  assert.match(markup, /aria-pressed="true"[^>]*>[\s\S]*?Missing release year/)
  assert.doesNotMatch(markup, /type="search"/)
})


test('album search keeps its selected title and offers a separate clear action', () => {
  const markup = renderToStaticMarkup(createElement(CurateAlbumSearch, {
    summary, settings, filter, albums, onFilterChange: () => {},
  }))
  assert.match(markup, /Search filtered albums/)
  assert.match(markup, /placeholder="Harbor Dawn"/)
  assert.match(markup, /Clear album filter/)
})
