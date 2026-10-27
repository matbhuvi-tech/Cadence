import { useMemo } from 'react'
import { Track, Release } from '../core/types'

export interface StagedChangesState {
  stagedAlbumsCount: number
  stagedTracksCount: number
  stagedTagEditsCount: number
  stagedArtworkCount: number
  hasPendingCommits: boolean
  uncommittedTracks: Track[]
  uncommittedReleases: Release[]
}

/**
 * Shared authoritative hook for aggregating in-memory staged changes
 * across track sidecars and release artwork modifications.
 */
export function useStagedChanges(tracks: Track[], releases: Release[]): StagedChangesState {
  return useMemo(() => {
    const uncommittedTracks: Track[] = []
    const affectedAlbumIds = new Set<string>()
    let tagEditsCount = 0
    let artworkEditsCount = 0

    // 1. Scan tracks for pending sidecar edits
    for (const t of tracks) {
      const edits = t.pendingSidecarEdits
      if (edits && Object.keys(edits).length > 0) {
        uncommittedTracks.push(t)
        if (t.releaseId) {
          affectedAlbumIds.add(t.releaseId)
        }
        for (const [key] of Object.entries(edits)) {
          if (key === 'coverArtUrl' || key === 'artwork') {
            artworkEditsCount++
          } else {
            tagEditsCount++
          }
        }
      }
    }

    // 2. Scan releases for staged artwork or manual overrides
    const uncommittedReleases: Release[] = []
    for (const r of releases) {
      const hasReleaseArtwork = Boolean(r.artwork?.frontCoverUrl && r.artwork.frontCoverUrl.startsWith('data:'))
      if (hasReleaseArtwork) {
        uncommittedReleases.push(r)
        affectedAlbumIds.add(r.id)
        artworkEditsCount++
      }
    }

    const stagedAlbumsCount = affectedAlbumIds.size
    const stagedTracksCount = uncommittedTracks.length
    const hasPendingCommits = stagedAlbumsCount > 0 || stagedTracksCount > 0 || artworkEditsCount > 0

    return {
      stagedAlbumsCount,
      stagedTracksCount,
      stagedTagEditsCount: tagEditsCount,
      stagedArtworkCount: artworkEditsCount,
      hasPendingCommits,
      uncommittedTracks,
      uncommittedReleases,
    }
  }, [tracks, releases])
}
