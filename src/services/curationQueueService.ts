/**
 * src/services/curationQueueService.ts
 * Cadence Curation Queue Discovery Engine
 *
 * Fast (<10ms) in-memory aggregation of catalog defect issues and staged sidecars into
 * prioritized Album Curation Cards for the Master-Detail Curation Workbench.
 */

import { Track, Release, AuditIssue } from '../core/types'
import { auditService } from './auditService'

export interface AlbumCurationQueueItem {
  albumId: string
  albumTitle: string
  artistCredit: string
  coverArtUrl?: string
  primaryIssueType: 'compilation_conflict' | 'missing_artwork' | 'untagged' | 'genre_fragment' | 'staged_uncommitted'
  issueBadgeLabel: string
  defectSeverity: 'critical' | 'high' | 'medium' | 'info'
  affectedTrackCount: number
  totalTracks: number
  isStaged: boolean
}

/**
 * Computes prioritized Album Curation Cards across the catalog.
 * Runs in <10ms against in-memory catalog graphs.
 */
export function computeCurationQueue(
  tracks: Track[],
  releases: Release[],
  existingIssues?: AuditIssue[]
): AlbumCurationQueueItem[] {
  if (!releases || releases.length === 0) return []

  const issues = existingIssues || auditService.computeCatalogAudit(tracks, releases).issues

  // Map tracks to releases for fast lookup
  const tracksByRelease = new Map<string, Track[]>()
  tracks.forEach((t) => {
    const list = tracksByRelease.get(t.releaseId) || []
    list.push(t)
    tracksByRelease.set(t.releaseId, list)
  })

  // Map issues to releases
  const releaseIssueMap = new Map<
    string,
    {
      issueType: AlbumCurationQueueItem['primaryIssueType']
      badgeLabel: string
      severity: AlbumCurationQueueItem['defectSeverity']
      affectedTracks: Set<string>
    }
  >()

  // 1. Check existing audit issues
  for (const issue of issues) {
    const sampleTrackIds = issue.sampleTrackIds || []
    for (const tid of sampleTrackIds) {
      const trk = tracks.find((t) => t.id === tid)
      if (trk && trk.releaseId) {
        const existing = releaseIssueMap.get(trk.releaseId)
        let issueType: AlbumCurationQueueItem['primaryIssueType'] = 'untagged'
        let badgeLabel = issue.title
        let severity: AlbumCurationQueueItem['defectSeverity'] = 'medium'

        if (
          issue.category === 'low_res_art' ||
          issue.tagField === 'COVER_ART' ||
          issue.id.includes('cover') ||
          issue.id.includes('art')
        ) {
          issueType = 'missing_artwork'
          badgeLabel = 'Missing Artwork'
          severity = 'high'
        } else if (
          issue.category === 'compilation_conflict' ||
          issue.id.includes('compilation') ||
          issue.title.toLowerCase().includes('compilation')
        ) {
          issueType = 'compilation_conflict'
          badgeLabel = 'Compilation Conflict'
          severity = 'critical'
        } else if (issue.id.includes('genre')) {
          issueType = 'genre_fragment'
          badgeLabel = 'Fragmented Genre'
          severity = 'info'
        }

        if (!existing) {
          releaseIssueMap.set(trk.releaseId, {
            issueType,
            badgeLabel,
            severity,
            affectedTracks: new Set([tid]),
          })
        } else {
          existing.affectedTracks.add(tid)
          if (severity === 'critical') {
            existing.severity = 'critical'
            existing.issueType = issueType
            existing.badgeLabel = badgeLabel
          }
        }
      }
    }
  }

  // 2. Formulate discrete AlbumCurationQueueItem cards
  const queueItems: AlbumCurationQueueItem[] = []

  for (const release of releases) {
    const relTracks = tracksByRelease.get(release.id) || []
    const stagedTracks = relTracks.filter(
      (t) =>
        t.sidecarStatus === 'uncommitted_sidecar' ||
        (t.pendingSidecarEdits && Object.keys(t.pendingSidecarEdits).length > 0)
    )
    const isStaged = stagedTracks.length > 0

    const issueInfo = releaseIssueMap.get(release.id)

    // Direct check: missing cover art if not already flagged
    const hasMissingArt =
      !release.artwork?.frontCoverUrl && !release.coverArtUrl
    // Direct check: compilation conflict (soundtrack boxset)
    const isCompilationConflict =
      release.isCompilation ||
      relTracks.some((t) => /\(from\s+['"][^'"]+['"]\)/i.test(t.title))

    if (!issueInfo && !isStaged && !hasMissingArt && !isCompilationConflict) {
      continue
    }

    let primaryIssueType: AlbumCurationQueueItem['primaryIssueType'] = 'untagged'
    let issueBadgeLabel = 'Metadata Review'
    let defectSeverity: AlbumCurationQueueItem['defectSeverity'] = 'info'
    let affectedTrackCount = 0

    if (isStaged) {
      primaryIssueType = 'staged_uncommitted'
      issueBadgeLabel = `${stagedTracks.length} Staged Uncommitted`
      defectSeverity = 'info'
      affectedTrackCount = stagedTracks.length
    } else if (issueInfo) {
      primaryIssueType = issueInfo.issueType
      issueBadgeLabel = issueInfo.badgeLabel
      defectSeverity = issueInfo.severity
      affectedTrackCount = issueInfo.affectedTracks.size || relTracks.length
    } else if (isCompilationConflict) {
      primaryIssueType = 'compilation_conflict'
      issueBadgeLabel = 'Soundtrack Conflict'
      defectSeverity = 'critical'
      affectedTrackCount = relTracks.length
    } else if (hasMissingArt) {
      primaryIssueType = 'missing_artwork'
      issueBadgeLabel = 'Missing Cover Art'
      defectSeverity = 'high'
      affectedTrackCount = relTracks.length
    }

    queueItems.push({
      albumId: release.id,
      albumTitle: release.title,
      artistCredit: release.artistCredit || 'Various Artists',
      coverArtUrl: release.artwork?.frontCoverUrl || release.coverArtUrl,
      primaryIssueType,
      issueBadgeLabel,
      defectSeverity,
      affectedTrackCount,
      totalTracks: relTracks.length || release.tracksCount || 1,
      isStaged,
    })
  }

  // Sort queue items: critical > high > medium > info, prioritizing staged items
  const severityRank: Record<AlbumCurationQueueItem['defectSeverity'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    info: 3,
  }

  return queueItems.sort((a, b) => {
    if (a.isStaged && !b.isStaged) return -1
    if (!a.isStaged && b.isStaged) return 1
    const rankDiff = severityRank[a.defectSeverity] - severityRank[b.defectSeverity]
    if (rankDiff !== 0) return rankDiff
    return a.albumTitle.localeCompare(b.albumTitle)
  })
}

/**
 * Resolves initial album selection for Curate workbench.
 * If activeAlbumId is present and in the queue, selects it; otherwise defaults to queue[0] or null.
 */
export function resolveCurateInitialAlbum(
  queue: AlbumCurationQueueItem[],
  activeAlbumId?: string
): AlbumCurationQueueItem | null {
  if (!queue || queue.length === 0) return null
  if (activeAlbumId) {
    const found = queue.find((item) => item.albumId === activeAlbumId)
    if (found) return found
  }
  return queue[0] || null
}

export const curationQueueService = {
  computeCurationQueue,
  resolveCurateInitialAlbum,
}
