import { Track, Release, AuditIssue, ActiveEntityScope } from './types'
import { splitMultiArtistCredits } from './taxonomyUtils'
import { getIssueCanonicalTarget } from '../components/Maintain/MaintainCockpit'

/**
 * Checks whether a track belongs to an artist, supporting raw string match, parent release match,
 * and canonical multi-artist splitting (e.g., "Shankar Mahadevan, Loy Mendonsa").
 */
export function trackMatchesArtist(
  track: Track,
  release: Release | undefined,
  artistName: string
): boolean {
  if (!artistName || !artistName.trim()) return false
  const norm = artistName.toLowerCase().trim()

  if ((track.artistCredit || '').toLowerCase().trim() === norm) return true
  if (release && (release.artistCredit || '').toLowerCase().trim() === norm) return true

  const trackSplits = splitMultiArtistCredits(track.artistCredit || '')
  if (trackSplits.some((c) => c.name.toLowerCase().trim() === norm)) return true

  if (release?.artistCredit) {
    const relSplits = splitMultiArtistCredits(release.artistCredit)
    if (relSplits.some((c) => c.name.toLowerCase().trim() === norm)) return true
  }

  return false
}

/**
 * Checks whether a track belongs to a composer, checking track.composerName,
 * release.composerName, and track.credits.
 */
export function trackMatchesComposer(
  track: Track,
  release: Release | undefined,
  composerName: string
): boolean {
  if (!composerName || !composerName.trim()) return false
  const norm = composerName.toLowerCase().trim()

  if ((track.composerName || (track as any).composer || '').toLowerCase().trim() === norm) return true
  if (release && (release.composerName || '').toLowerCase().trim() === norm) return true

  if (track.credits && track.credits.length > 0) {
    if (
      track.credits.some(
        (c) => c.role === 'composer' && c.personName.toLowerCase().trim() === norm
      )
    ) {
      return true
    }
  }

  return false
}

export interface ResolveCurateTrackParams {
  tracks: Track[]
  releases: Release[]
  selectedTrackId?: string | null
  selectedAlbumId?: string | null
  selectedArtist?: string | null
  selectedComposer?: string | null
  currentPlayingTrack?: Track | null
}

/**
 * Resolves the target track for Curate (⌘2) according to the strict scoped resolution priority:
 * 1. Currently selected track (selectedTrackId) if it belongs to the active scope.
 * 2. First track of selectedAlbumId (if drilled into an album).
 * 3. First track matching selectedComposer (e.g. Shankar Ehsaan Loy) or selectedArtist.
 * 4. Currently playing track (currentPlayingTrack).
 * 5. Global tracks[0] fallback.
 */
export function resolveCurateTargetTrack({
  tracks,
  releases,
  selectedTrackId,
  selectedAlbumId,
  selectedArtist,
  selectedComposer,
  currentPlayingTrack,
}: ResolveCurateTrackParams): Track | null {
  if (!tracks || tracks.length === 0) return null

  const releaseMap = new Map<string, Release>()
  releases.forEach((r) => releaseMap.set(r.id, r))

  const isTrackInActiveScope = (t: Track): boolean => {
    if (selectedAlbumId) {
      if (t.releaseId !== selectedAlbumId) return false
    }
    if (selectedComposer) {
      if (!trackMatchesComposer(t, releaseMap.get(t.releaseId), selectedComposer)) return false
    }
    if (selectedArtist) {
      if (!trackMatchesArtist(t, releaseMap.get(t.releaseId), selectedArtist)) return false
    }
    return true
  }

  // 1. Currently selected track if it belongs to the active scope
  if (selectedTrackId) {
    const selected = tracks.find((t) => t.id === selectedTrackId)
    if (selected && isTrackInActiveScope(selected)) {
      return selected
    }
  }

  // 2. First track of selectedAlbumId (if drilled into an album)
  if (selectedAlbumId) {
    const albumTrack = tracks.find((t) => {
      if (t.releaseId !== selectedAlbumId) return false
      if (selectedComposer) {
        return trackMatchesComposer(t, releaseMap.get(t.releaseId), selectedComposer)
      }
      if (selectedArtist) {
        return trackMatchesArtist(t, releaseMap.get(t.releaseId), selectedArtist)
      }
      return true
    })
    if (albumTrack) return albumTrack
  }

  // 3. First track matching selectedComposer or selectedArtist
  if (selectedComposer) {
    const compTrack = tracks.find((t) =>
      trackMatchesComposer(t, releaseMap.get(t.releaseId), selectedComposer)
    )
    if (compTrack) return compTrack
  }

  if (selectedArtist) {
    const artTrack = tracks.find((t) =>
      trackMatchesArtist(t, releaseMap.get(t.releaseId), selectedArtist)
    )
    if (artTrack) return artTrack
  }

  // 4. Currently playing track if valid
  if (currentPlayingTrack) {
    return currentPlayingTrack
  }

  // 5. Global tracks[0] fallback
  return tracks[0] || null
}

/**
 * Checks whether an AuditIssue touches the specified active entity scope.
 */
export function isIssueInEntityScope(
  issue: AuditIssue,
  scope: ActiveEntityScope,
  tracks: Track[],
  releases: Release[]
): boolean {
  const normName = scope.name.toLowerCase().trim()
  const releaseMap = new Map<string, Release>()
  releases.forEach((r) => releaseMap.set(r.id, r))

  // If scoped to a specific album
  if (scope.type === 'album') {
    if (scope.albumId && issue.sampleTrackIds && issue.sampleTrackIds.length > 0) {
      const match = issue.sampleTrackIds.some((id) => {
        const t = tracks.find((trk) => trk.id === id)
        return t?.releaseId === scope.albumId
      })
      if (match) return true
    }
    // Also check album title canonical target
    const canonical = getIssueCanonicalTarget(issue, tracks, releases).toLowerCase().trim()
    if (canonical === normName) return true
    return false
  }

  // If scoped to a composer
  if (scope.type === 'composer') {
    const canonical = getIssueCanonicalTarget(issue, tracks, releases).toLowerCase().trim()
    if (canonical === normName) return true

    if (issue.sampleTrackIds && issue.sampleTrackIds.length > 0) {
      return issue.sampleTrackIds.some((id) => {
        const t = tracks.find((trk) => trk.id === id)
        if (!t) return false
        return trackMatchesComposer(t, releaseMap.get(t.releaseId), scope.name)
      })
    }
    return false
  }

  // If scoped to an artist
  if (scope.type === 'artist') {
    const canonical = getIssueCanonicalTarget(issue, tracks, releases).toLowerCase().trim()
    if (canonical === normName) return true

    if (issue.sampleTrackIds && issue.sampleTrackIds.length > 0) {
      return issue.sampleTrackIds.some((id) => {
        const t = tracks.find((trk) => trk.id === id)
        if (!t) return false
        return trackMatchesArtist(t, releaseMap.get(t.releaseId), scope.name)
      })
    }
    return false
  }

  return true
}
