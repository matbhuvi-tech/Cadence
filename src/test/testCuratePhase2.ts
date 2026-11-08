import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SelectedOutputCard } from '../components/Curate/SelectedOutputCard'

test('Selected Output summarizes local changes and disables unavailable adoption', () => {
  assert.match(renderToStaticMarkup(createElement(SelectedOutputCard, {
    albumCount: 0, trackCount: 0, onAcceptSuggestions: () => {},
  })), /No changes from local tags[\s\S]*disabled[^>]*>Accept Suggestions/)
  assert.match(renderToStaticMarkup(createElement(SelectedOutputCard, {
    albumCount: 1, trackCount: 2,
  })), /1 album field · 2 tracks changed/)
})
