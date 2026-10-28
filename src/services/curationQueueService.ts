/**
 * src/services/curationQueueService.ts
 * Cadence Curation Queue Discovery Engine
 *
 * Fast (<10ms) in-memory aggregation of catalog defect issues and staged sidecars into
 * prioritized Album Curation Cards for the Master-Detail Curation Workbench.
 */

import { Track, Release, AuditIssue, ReleaseConsensusResult } from '../core/types'
import { auditService } from './auditService'
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
 * the Audiophile Transport Silence invariant during playback and cooldown.
 */
export class LookaheadQueuePrefetcher {
  private cache = new LRUCache<string, ReleaseConsensusResult>(50)
  private lastPlaybackStoppedTime = 0

  constructor() {
    // Initialized to 0 on boot. Subscribe to playback stops to track cooldown.
    if (typeof tauriBridge?.onPlaybackStateChanged === 'function') {
      tauriBridge.onPlaybackStateChanged((state: string) => {
        if (state === 'Stopped') {
          this.lastPlaybackStoppedTime = Date.now()
        }
      })
    }
  }

  public notifyPlaybackStopped(): void {
    this.lastPlaybackStoppedTime = Date.now()
  }

  public setLastPlaybackStoppedTime(time: number): void {
    this.lastPlaybackStoppedTime = time
  }

  public getLastPlaybackStoppedTime(): number {
    return this.lastPlaybackStoppedTime
  }

  /**
   * Transport Silence Invariant: Returns false if playback is active, paused, loading,
   * or within a 30-second quietness cooldown window after playback stopped.
   */
  public async isTransportQuiet(statusOverride?: {
    isPlaying?: boolean
    isPaused?: boolean
    playbackState?: string
  }): Promise<boolean> {
    try {
      const status = statusOverride || (await tauriBridge.getPlaybackStatus().catch(() => null))
      if (status) {
        if (
          status.isPlaying ||
          status.isPaused ||
          (status as any).playbackState === 'Loading' ||
          (status as any).playbackState === 'Playing' ||
          (status as any).playbackState === 'Paused'
        ) {
          return false
        }
      }
      if (this.lastPlaybackStoppedTime > 0 && Date.now() - this.lastPlaybackStoppedTime < 30000) {
        return false
      }
      return true
    } catch {
      return true
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
    const isQuiet = await this.isTransportQuiet()
    if (!isQuiet) {
      return
    }

    const targetIndices = [currentIndex + 1, currentIndex + 2]
    for (const idx of targetIndices) {
      if (idx >= queue.length) continue
      const targetItem = queue[idx]
      if (!targetItem || this.cache.has(targetItem.albumId)) continue

      const targetRelease = releases.find((r) => r.id === targetItem.albumId)
      if (!targetRelease) continue

      const targetTracks = tracks.filter((t) => t.releaseId === targetItem.albumId)

      federatedResolversService
        .resolve2of3ReleaseConsensus(targetRelease, targetTracks, true)
        .then((result) => {
          this.cache.set(targetItem.albumId, result)
        })
        .catch(() => {})
    }
  }
}

export const lookaheadQueuePrefetcher = new LookaheadQueuePrefetcher()

export const curationQueueService = {
  computeCurationQueue,
  resolveCurateInitialAlbum,
  lookaheadQueuePrefetcher,
}
