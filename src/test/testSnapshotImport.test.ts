import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  buildSnapshotOnboardingSummary,
  mapWindowsPathToCorePath,
  type RootPathMapping,
} from '../core/snapshotImport'

test('maps Windows UNC and drive prefixes to Linux paths while preserving case sensitivity', () => {
  const mappings: RootPathMapping[] = [
    {
      windowsPrefix: '\\\\192.168.1.6\\Mathan\\Music Collection',
      corePrefix: '/music',
    },
  ]

  assert.equal(
    mapWindowsPathToCorePath(
      '\\\\192.168.1.6\\mathan\\Music Collection\\Master\\Hindi\\Track 01.flac',
      mappings,
    ),
    '/music/Master/Hindi/Track 01.flac',
  )

  assert.equal(mapWindowsPathToCorePath('E:\\Mathan\\Music\\DSD\\Sweep.dsf', mappings), null)
})

test('onboarding options support Start a new library and Import existing Cadence library with independent catalog flag', () => {
  const newLib = buildSnapshotOnboardingSummary({
    mode: 'start_new_library',
    mappedTracksCount: 0,
    unmappedRootsCount: 0,
    caseMismatchCount: 0,
    suppressedPendingJobs: 0,
  })
  assert.equal(newLib.mode, 'start_new_library')
  assert.equal(newLib.implicitBidirectionalSync, false)

  const imported = buildSnapshotOnboardingSummary({
    mode: 'import_existing_library',
    mappedTracksCount: 120,
    unmappedRootsCount: 4,
    caseMismatchCount: 1,
    suppressedPendingJobs: 3,
  })
  assert.equal(imported.mode, 'import_existing_library')
  assert.equal(imported.implicitBidirectionalSync, false)
  assert.match(imported.summaryText, /120 mapped/)
  assert.match(imported.summaryText, /4 unmapped/)
  assert.match(imported.summaryText, /1 case mismatch/)
  assert.match(imported.summaryText, /3 pending write/)
})
