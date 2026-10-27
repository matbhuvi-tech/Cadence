import { useMemo } from 'react'
import { Track, Release } from '../core/types'

export interface StagedChangesState {
  stagedAlbumsCount: number
  stagedTracksCount: number
  stagedTagEditsCount: number
  stagedArtworkCount: number
  triageAlbumsCount: number
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
    const triageAlbumIds = new Set<string>()
    let tagEditsCount = 0
    let artworkEditsCount = 0

    // 1. Scan tracks for pending sidecar edits and basic tag defects
    for (const t of tracks) {
      const edits = t.pendingSidecarEdits
      if (edits && Object.keys(edits).length > 0) {
        uncommittedTracks.push(t)
        if (t.releaseId) {
          affectedAlbumIds.add(t.releaseId)
          triageAlbumIds.add(t.releaseId)
        }
        for (const [key] of Object.entries(edits)) {
          if (key === 'coverArtUrl' || key === 'artwork') {
            artworkEditsCount++
          } else {
            tagEditsCount++
          }
        }
      }

      // Check for untagged / compilation defect
      if (
        !t.artistCredit ||
        t.artistCredit.trim().toLowerCase() === 'unknown artist' ||
        t.isCompilation ||
        /\(from\s+['"][^'"]+['"]\)/i.test(t.title)
      ) {
        if (t.releaseId) {
          triageAlbumIds.add(t.releaseId)
        }
      }
    }

    // 2. Scan releases for staged artwork or hygiene defects
    const uncommittedReleases: Release[] = []
    for (const r of releases) {
      const hasReleaseArtwork = Boolean(r.artwork?.frontCoverUrl && r.artwork.frontCoverUrl.startsWith('data:'))
      if (hasReleaseArtwork) {
        uncommittedReleases.push(r)
        affectedAlbumIds.add(r.id)
        triageAlbumIds.add(r.id)
        artworkEditsCount++
      }

      // Check missing cover art or compilation conflict
      if (
        (!r.artwork?.frontCoverUrl && !r.coverArtUrl) ||
        r.isCompilation
      ) {
        triageAlbumIds.add(r.id)
      }
    }

    const stagedAlbumsCount = affectedAlbumIds.size
    const stagedTracksCount = uncommittedTracks.length
    const triageAlbumsCount = triageAlbumIds.size
    const hasPendingCommits = stagedAlbumsCount > 0 || stagedTracksCount > 0 || artworkEditsCount > 0

    return {
      stagedAlbumsCount,
      stagedTracksCount,
      stagedTagEditsCount: tagEditsCount,
      stagedArtworkCount: artworkEditsCount,
      triageAlbumsCount,
      hasPendingCommits,
      uncommittedTracks,
      uncommittedReleases,
    }
  }, [tracks, releases])
}
