/**
 * src/services/curationQueueService.ts
 * Cadence Curation Queue Discovery Engine
 *
 * Fast (<10ms) in-memory aggregation of catalog defect issues and staged sidecars into
 * prioritized Album Curation Cards for the Master-Detail Curation Workbench.
 */

import { Track, Release, AuditIssue, ReleaseConsensusResult } from '../core/types'
import { auditService } from './auditService'
import { isPlaceholderTag, isDefectiveArtistTag, cleanRipNoise } from '../core/taxonomyUtils'
import { tauriBridge } from './tauriBridge'
import { federatedResolversService, globalMusicBrainzQueue } from './federatedResolvers'

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
  confidenceScore?: number
  requiresDisambiguation?: boolean
  folderName?: string
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

    let primaryIssueType: AlbumCurationQueueItem['primaryIssueType'] = 'untagged'
    let issueBadgeLabel = 'Catalog Album'
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

    // Determine confidence score and disambiguation requirements
    const hasPlaceholderTitle = isPlaceholderTag(release.title)
    const hasPlaceholderArtist = isPlaceholderTag(release.artistCredit)
    const hasDefectiveArtist = isDefectiveArtistTag(release.artistCredit, release.title)
    const hasRipNoiseInTitle = Boolean(release.title && cleanRipNoise(release.title).toLowerCase() !== release.title.toLowerCase())
    const hasMissingYear = !release.releaseYear || release.releaseYear <= 1900
    const hasMissingComposer = !release.composerName || isPlaceholderTag(release.composerName)

    // Compute confidence score based on completeness and integrity
    let confidenceScore = 0.95
    if (hasMissingArt) confidenceScore -= 0.25
    if (hasPlaceholderTitle || hasPlaceholderArtist || hasDefectiveArtist) confidenceScore -= 0.40
    if (hasRipNoiseInTitle) confidenceScore -= 0.20
    if (hasMissingYear) confidenceScore -= 0.25
    if (hasMissingComposer) confidenceScore -= 0.15
    if (defectSeverity === 'critical') confidenceScore -= 0.40
    else if (defectSeverity === 'high') confidenceScore -= 0.25
    else if (defectSeverity === 'medium') confidenceScore -= 0.15

    confidenceScore = Math.max(0.1, Math.min(1.0, confidenceScore))

    const requiresDisambiguation =
      isCompilationConflict ||
      defectSeverity === 'critical' ||
      hasPlaceholderTitle ||
      hasPlaceholderArtist ||
      hasDefectiveArtist ||
      hasRipNoiseInTitle ||
      hasMissingYear

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
      confidenceScore,
      requiresDisambiguation,
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

export class LRUCache<K, V> {
  private capacity: number
  private map = new Map<K, V>()

  constructor(capacity = 50) {
    this.capacity = capacity
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const val = this.map.get(key)!
    this.map.delete(key)
    this.map.set(key, val)
    return val
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey)
      }
    }
    this.map.set(key, value)
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  clear(): void {
    this.map.clear()
  }
}

/**
 * Lookahead Queue Prefetcher (Depth = 2)
 * Eliminates MusicBrainz 1 req/sec stepper latency while strictly enforcing
 * the transport guard during active playback.
 */
export class LookaheadQueuePrefetcher {
  private cache = new LRUCache<string, ReleaseConsensusResult>(50)
  private readonly activePrefetch = new Set<AbortController>()

  constructor() {
    if (typeof tauriBridge?.onPlaybackStateChanged === 'function') {
      tauriBridge.onPlaybackStateChanged((state: string) => {
        if (['Loading', 'Playing', 'Paused'].includes(state)) this.cancelPendingPrefetch()
      })
    }
  }

  /**
   * Lookahead may run as soon as the transport is stopped.
   */
  public async isTransportQuiet(statusOverride?: {
    isPlaying?: boolean
    isPaused?: boolean
    playbackState?: string
  }): Promise<boolean> {
    try {
      const status = statusOverride ?? await tauriBridge.getPlaybackStatus()
      return Boolean(status && !status.isPlaying && !status.isPaused &&
        !['Loading', 'Playing', 'Paused'].includes(status.playbackState ?? ''))
    } catch {
      return false
    }
  }

  public getCachedConsensus(albumId: string): ReleaseConsensusResult | undefined {
    return this.cache.get(albumId)
  }

  public setCachedConsensus(albumId: string, result: ReleaseConsensusResult): void {
    this.cache.set(albumId, result)
  }

  public clearCache(): void {
    this.cache.clear()
  }

  public cancelPendingPrefetch(): void {
    for (const controller of this.activePrefetch) controller.abort()
    globalMusicBrainzQueue.cancelPendingPrefetch()
  }

  /**
   * Prefetches metadata candidates for upcoming albums (N+1 and N+2) in the queue.
   */
  public async prefetchLookahead(
    queue: AlbumCurationQueueItem[],
    currentIndex: number,
    releases: Release[],
    tracks: Track[]
  ): Promise<void> {
    const controller = new AbortController()
    this.activePrefetch.add(controller)
    try {
      for (const idx of [currentIndex + 1, currentIndex + 2]) {
        if (!(await this.isTransportQuiet()) || controller.signal.aborted) break
        const targetItem = queue[idx]
        if (!targetItem || this.cache.has(targetItem.albumId)) continue
        const targetRelease = releases.find((r) => r.id === targetItem.albumId)
        if (!targetRelease) continue
        const targetTracks = tracks.filter((t) => t.releaseId === targetItem.albumId)

        const result = await federatedResolversService
          .resolve2of3ReleaseConsensus(targetRelease, targetTracks, true, undefined, undefined, undefined, controller.signal)
        if (!controller.signal.aborted) this.cache.set(targetItem.albumId, result)
      }
    } catch {
      // A cancelled or unavailable prefetch can be retried on the next idle selection.
    } finally {
      this.activePrefetch.delete(controller)
    }
  }
}

export const lookaheadQueuePrefetcher = new LookaheadQueuePrefetcher()

export const curationQueueService = {
  computeCurationQueue,
  resolveCurateInitialAlbum,
  lookaheadQueuePrefetcher,
}
