import { graphEngine } from '../core/graphEngine'
import { auditService } from './auditService'
import { Track, Release, Work, StorageMount, AuditIssue } from '../core/types'
import { canonicalizeComposer, canonicalizeGenre, splitAndCanonicalizePerformers } from '../core/taxonomyUtils'

export interface CatalogStatistics {
  totalTracks: number
  totalReleases: number
  totalWorks: number
  totalStorageMounts: number
  healthScore: number
  lastAuditTimestamp: string | null
  totalAnomalies: number
  uncommittedSidecars: number
  
  // Format Distribution
  formatCounts: Record<string, number>
  hiRes24BitCount: number
  dsdCount: number
  
  // Dynamic Range Analytics
  averageDrScore: number
  audiophileDr14Count: number
  highDr10to13Count: number
  compressedDrLowCount: number
  
  // Taxonomy Distribution
  topComposers: { name: string; count: number }[]
  topPerformers: { name: string; count: number }[]
  topGenres: { name: string; count: number }[]
  languageCounts: Record<string, number>
  eraCounts: Record<string, number>
  
  // Hygiene Defects
  untaggedTracksCount: number
  lowResArtCount: number
  compilationConflictCount: number
  missingTrackNumCount: number
  inconsistentNameCount: number
  
  // Storage Mounts
  mountSummaries: { name: string; path: string; fs: string; usedPct: number }[]
  sourceDirectories: { path: string; albums: number; tracks: number }[]
}

export interface AgentRecommendation {
  id: string
  title: string
  description: string
  priority: 'critical' | 'high' | 'medium' | 'info'
  actionType: string
  actionLabel: string
  payload?: any
  affectedCount?: number
}

export class AgentSnapshotService {
  /**
   * Computes comprehensive real-time statistics across the active music catalog.
   */
  public getCatalogStatistics(scopeTracks?: Track[]): CatalogStatistics {
    const tracks = scopeTracks || graphEngine.getAllTracks()
    const releases = graphEngine.getAllReleases()
    const works = graphEngine.getAllWorks()
    const mounts = graphEngine.getAllStorageMounts()
    const audit = auditService.computeCatalogAudit(tracks, releases)

    const formatCounts: Record<string, number> = {}
    let hiRes24BitCount = 0
    let dsdCount = 0

    let totalDr = 0
    let drCount = 0
    let audiophileDr14Count = 0
    let highDr10to13Count = 0
    let compressedDrLowCount = 0

    const composerCounts = new Map<string, number>()
    const performerCounts = new Map<string, number>()
    const genreCounts = new Map<string, number>()
    const languageCounts: Record<string, number> = {}
    const eraCounts: Record<string, number> = {}
    const sourceDirMap = new Map<string, { albums: Set<string>; tracks: number }>()

    let uncommittedSidecars = 0
    let untaggedTracksCount = 0

    const relMap = new Map<string, Release>()
    releases.forEach((r) => relMap.set(r.id, r))

    tracks.forEach((t) => {
      // Formats
      const fmt = t.format || 'FLAC'
      formatCounts[fmt] = (formatCounts[fmt] || 0) + 1
      const fmtStr = String(fmt)
      if (fmtStr === 'DSD' || fmtStr === 'DSF' || fmtStr === 'DFF' || t.sampleRateStr?.includes('DSD')) dsdCount++
      if (t.sampleRateStr?.includes('24/') || t.sampleRateStr?.includes('32/') || fmtStr === 'DSD' || fmtStr === 'DSF' || fmtStr === 'DFF' || t.isHighRes) hiRes24BitCount++

      // Dynamic Range
      if (t.drScore > 0) {
        totalDr += t.drScore
        drCount++
        if (t.drScore >= 14) audiophileDr14Count++
        else if (t.drScore >= 10) highDr10to13Count++
        else compressedDrLowCount++
      }

      // Untagged
      const isUntagged = !t.artistCredit || t.artistCredit === 'Unknown Artist' || t.artistCredit === 'Unknown'
      if (isUntagged) untaggedTracksCount++

      // Uncommitted Sidecars
      if (t.sidecarStatus === 'uncommitted_sidecar') uncommittedSidecars++

      // Composers
      if (t.composerName) {
        const { canonicalName } = canonicalizeComposer(t.composerName)
        if (canonicalName && canonicalName !== 'Unknown Composer') {
          composerCounts.set(canonicalName, (composerCounts.get(canonicalName) || 0) + 1)
        }
      }

      // Performers
      const perfs = splitAndCanonicalizePerformers(t.artistCredit || '')
      perfs.forEach((p) => {
        performerCounts.set(p, (performerCounts.get(p) || 0) + 1)
      })

      // Languages
      const lang = t.language || 'English'
      languageCounts[lang] = (languageCounts[lang] || 0) + 1

      // Eras
      const rel = relMap.get(t.releaseId)
      const yr = rel?.releaseYear || rel?.originalYear
      if (yr && yr > 0) {
        let bucket = 'Earlier'
        if (yr <= 1970) bucket = 'Pre-1970'
        else if (yr <= 1980) bucket = '1970s'
        else if (yr <= 1990) bucket = '1980s'
        else if (yr <= 2000) bucket = '1990s'
        else if (yr <= 2010) bucket = '2000s'
        else bucket = '2010s-Present'
        eraCounts[bucket] = (eraCounts[bucket] || 0) + 1
      }

      // Source Directories
      const p = (t.filePath || '').replace(/\\/g, '/')
      const parts = p.split('/').filter(Boolean)
      if (parts.length >= 2) {
        const dir = parts.slice(0, parts.length - 1).join('/')
        if (!sourceDirMap.has(dir)) {
          sourceDirMap.set(dir, { albums: new Set(), tracks: 0 })
        }
        const sEntry = sourceDirMap.get(dir)!
        sEntry.tracks++
        sEntry.albums.add(t.releaseId)
      }
    })

    // Genres from Releases
    releases.forEach((r) => {
      if (Array.isArray(r.genreTags)) {
        r.genreTags.forEach((g) => {
          const canonical = canonicalizeGenre(g)
          if (canonical && canonical !== 'Unclassified') {
            genreCounts.set(canonical, (genreCounts.get(canonical) || 0) + r.tracksCount)
          }
        })
      }
    })

    // Top Lists
    const topComposers = Array.from(composerCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count }))

    const topPerformers = Array.from(performerCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count }))

    const topGenres = Array.from(genreCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count }))

    // Mount summaries
    const mountSummaries = mounts.map((m) => ({
      name: m.name,
      path: m.mountPath,
      fs: m.fileSystem,
      usedPct: m.totalBytes > 0 ? Math.round((m.usedBytes / m.totalBytes) * 100) : 0,
    }))

    // Source directories
    const sourceDirectories = Array.from(sourceDirMap.entries()).map(([path, data]) => ({
      path,
      albums: data.albums.size,
      tracks: data.tracks,
    }))

    // Specific defect counts
    const lowResArtCount = releases.filter((r) => r.artwork?.isLowRes || !r.artwork?.frontCoverUrl).length
    const compilationConflictCount = audit.issues.find((i) => i.category === 'compilation_conflict')?.affectedCount || 0
    const missingTrackNumCount = audit.issues.find((i) => i.category === 'missing_track_num')?.affectedCount || 0
    const inconsistentNameCount = audit.issues.find((i) => i.category === 'inconsistent_name')?.affectedCount || 0

    return {
      totalTracks: tracks.length,
      totalReleases: releases.length,
      totalWorks: works.length,
      totalStorageMounts: mounts.length,
      healthScore: audit.healthScore,
      lastAuditTimestamp: auditService.lastAuditTimestamp,
      totalAnomalies: audit.issues.reduce((acc, i) => acc + i.affectedCount, 0),
      uncommittedSidecars,
      formatCounts,
      hiRes24BitCount,
      dsdCount,
      averageDrScore: drCount > 0 ? parseFloat((totalDr / drCount).toFixed(1)) : 12.0,
      audiophileDr14Count,
      highDr10to13Count,
      compressedDrLowCount,
      topComposers,
      topPerformers,
      topGenres,
      languageCounts,
      eraCounts,
      untaggedTracksCount,
      lowResArtCount,
      compilationConflictCount,
      missingTrackNumCount,
      inconsistentNameCount,
      mountSummaries,
      sourceDirectories,
    }
  }

  /**
   * Generates prioritized proactive recommendations for catalog optimization.
   */
  public generateRecommendations(stats: CatalogStatistics): AgentRecommendation[] {
    const recs: AgentRecommendation[] = []

    // 1. Untagged Tracks
    if (stats.untaggedTracksCount > 0) {
      recs.push({
        id: 'rec-untagged-artists',
        title: `Auto-Resolve ${stats.untaggedTracksCount} Untagged Tracks`,
        description: `Discovered ${stats.untaggedTracksCount} tracks with missing or 'Unknown Artist' tags. The agent can infer canonical artist and composer credits from the directory folder hierarchy.`,
        priority: 'critical',
        actionType: 'RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER',
        actionLabel: 'Extract from Folders',
        affectedCount: stats.untaggedTracksCount,
      })
    }

    // 2. Compilation vs Soundtrack Conflicts
    if (stats.compilationConflictCount > 0) {
      recs.push({
        id: 'rec-compilation-disentangle',
        title: `Disentangle ${stats.compilationConflictCount} Compilation Boxset Conflicts`,
        description: `Found ${stats.compilationConflictCount} tracks where generic compilation tags (e.g. 'Signature Collection 2') override canonical soundtrack folder names (e.g. 'Dil Se', 'Guru').`,
        priority: 'high',
        actionType: 'SYNC_FOLDER_TO_ALBUM',
        actionLabel: 'Sync Album from Folder',
        affectedCount: stats.compilationConflictCount,
      })
    }

    // 3. Duplicate Genres
    if (stats.topGenres.length > 0) {
      recs.push({
        id: 'rec-normalize-genres',
        title: 'Cluster & Normalize Fragmented Genres',
        description: 'Unify semantic duplicate genre tags (e.g. "Tamil Film", "Tamil Film Music" &rarr; "Tamil Film Music & Soundtrack").',
        priority: 'medium',
        actionType: 'NORMALIZE_GENRES',
        actionLabel: 'Normalize Genres',
      })
    }

    // 4. Missing Cover Art
    if (stats.lowResArtCount > 0) {
      recs.push({
        id: 'rec-fetch-hires-art',
        title: `Fetch 3000x3000px Archival Artwork for ${stats.lowResArtCount} Albums`,
        description: `Search Apple Music Master Scans and Cover Art Archive for ${stats.lowResArtCount} album(s) currently using low-resolution or placeholder images.`,
        priority: 'medium',
        actionType: 'FETCH_HIRES_ART',
        actionLabel: 'Fetch Online Art',
        affectedCount: stats.lowResArtCount,
      })
    }

    // 5. Uncommitted Sidecars
    if (stats.uncommittedSidecars > 0) {
      recs.push({
        id: 'rec-commit-sidecars',
        title: `Review & Commit ${stats.uncommittedSidecars} Staged Sidecar Changes`,
        description: `You have ${stats.uncommittedSidecars} metadata modifications staged in memory. Open the Two-Phase Commit modal to write lossless .sidecar.json files to disk.`,
        priority: 'info',
        actionType: 'OPEN_COMMIT_MODAL',
        actionLabel: 'Review & Commit',
        affectedCount: stats.uncommittedSidecars,
      })
    }

    return recs
  }

  /**
   * Generates a concise markdown summary of catalog statistics for LLM context injection.
   */
  public getCatalogSummaryText(): string {
    const stats = this.getCatalogStatistics()
    return `### Live Music Library Snapshot:
- **Total Tracks:** ${stats.totalTracks.toLocaleString()} | **Releases / Albums:** ${stats.totalReleases} | **Works:** ${stats.totalWorks}
- **Catalog Health Score:** ${stats.healthScore}% (${stats.totalAnomalies} anomalies detected)
- **Audio Formats:** ${Object.entries(stats.formatCounts).map(([fmt, cnt]) => `${fmt}: ${cnt}`).join(', ')}
- **Audiophile Specs:** ${stats.hiRes24BitCount} Hi-Res 24-bit/DSD tracks | Mean DR: ${stats.averageDrScore} (${stats.audiophileDr14Count} DR14+ master tracks)
- **Top Composers:** ${stats.topComposers.map((c) => `${c.name} (${c.count})`).join(', ') || 'None catalogued'}
- **Top Performers:** ${stats.topPerformers.map((p) => `${p.name} (${p.count})`).join(', ') || 'None catalogued'}
- **Languages:** ${Object.entries(stats.languageCounts).map(([l, cnt]) => `${l}: ${cnt}`).join(', ')}
- **Hygiene Deficiencies:** Untagged tracks: ${stats.untaggedTracksCount}, Low-res art albums: ${stats.lowResArtCount}, Boxset conflicts: ${stats.compilationConflictCount}, Staged sidecars: ${stats.uncommittedSidecars}
- **Storage Mounts:** ${stats.mountSummaries.map((m) => `${m.name} [${m.fs}]`).join(', ')}`
  }
}

export const agentSnapshotService = new AgentSnapshotService()
