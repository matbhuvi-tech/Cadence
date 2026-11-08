import assert from 'node:assert/strict'
import test from 'node:test'
import type { CurateDraft } from '../core/curateDraft'
import { stepFilteredAlbumSelection, resolvePostCommitNavigation, applyAcceptedSuggestionsToDraft, resolveAlbumSelectionDraftState, resolveStagedAlbumIds } from '../core/curateWorkflow'

const albums = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

test('navigation stays within the filtered rail', () => {
  assert.equal(stepFilteredAlbumSelection(albums, 'b', 1), 'c')
  assert.equal(stepFilteredAlbumSelection(albums, 'a', -1), 'a')
  assert.equal(stepFilteredAlbumSelection(albums, 'outside', 1), 'a')
})

test('partial commits keep the current album and resolved commits advance', () => {
  assert.equal(resolvePostCommitNavigation(albums, albums, 'b'), 'b')
  assert.equal(resolvePostCommitNavigation(albums, [albums[0], albums[2]], 'b'), 'c')
  assert.equal(resolvePostCommitNavigation(albums, [], 'b'), null)
})

test('a direct selection outside the filter stays open', () => {
  assert.equal(resolvePostCommitNavigation(albums, albums, 'outside'), 'outside')
})


test('opening skips unapproved suggestions and accepting keeps manual choices', () => {
  const field = (selected: string | number | undefined) => ({
    selected, source: 'local_fallback' as const, confidence: 1,
  })
  const baseline: CurateDraft = {
    version: 1, baseline: 'physical', staged: false, tracks: [],
    fields: {
      albumTitle: field('Original'), albumArtist: field('Artist'), composer: field(''),
      year: field(undefined), coverArt: field(''), genre: field('Rock'),
    },
  }
  const proposal = {
    ...baseline, revision: 'unapproved',
    fields: { ...baseline.fields, year: field(1999), albumTitle: field('Suggested') },
  }
  assert.equal(resolveAlbumSelectionDraftState(proposal, baseline, false, false), null)

  const manual = {
    ...baseline, revision: 'manual',
    fields: { ...baseline.fields, albumTitle: { ...field('Manual'), userOverridden: true } },
  }
  const accepted = applyAcceptedSuggestionsToDraft(manual, proposal, {})
  assert.equal(accepted.fields.albumTitle.selected, 'Manual')
  assert.equal(accepted.fields.year.selected, 1999)
  assert.equal(accepted.fields.year.userOverridden, true)
  assert.equal(resolveAlbumSelectionDraftState(accepted, baseline, false, false), accepted)
  assert.deepEqual(resolveStagedAlbumIds({ manual, staged: { ...accepted, staged: true } }), ['staged'])
})
