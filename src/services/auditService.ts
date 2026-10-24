import { AuditIssue, Track, Release } from '../core/types'
import { graphEngine } from '../core/graphEngine'
import { federatedResolversService } from './federatedResolvers'
import { generatePanoramicBackdrop } from './panoramicBackdropGenerator'
import {
  canonicalizeComposer,
  canonicalizeGenre,
  stripRipNoiseAndTags,
  getCuratedAlbumArtwork,
  splitMultiArtistCredits,
  KNOWN_COMPOSERS,
  KNOWN_ARTISTS,
} from '../core/taxonomyUtils'
import { normalizationService } from './normalizationService'
import { backdropAnalyzer, INLAY_SCAN_PATTERNS } from './backdropAnalyzer'

export interface AuditDeduction {
  reason: string
  category: string
  points: number
  affectedCount: number
}

export interface AuditEvaluationResult {
  issues: AuditIssue[]
  healthScore: number
  deductions: AuditDeduction[]
  totalTracks: number
  cleanTracks: number
}

export class AuditService {
  public lastAuditTimestamp: string | null = null

  /**
   * Computes dynamic hygiene diagnostics and health score (0-100%) for an arbitrary slice of tracks & releases.
   * This is called by the UI whenever the Virtual Grid filter (search query, format, genre, etc.) changes.
   */
  public computeCatalogAudit(tracks: Track[], releases: Release[]): AuditEvaluationResult {
    if (!tracks || tracks.length === 0) {
      return { issues: [], healthScore: 100, deductions: [], totalTracks: 0, cleanTracks: 0 }
    }

    const dynamicIssues: AuditIssue[] = []
    const deductions: AuditDeduction[] = []
    const trackReleaseIds = new Set(tracks.map((t) => t.releaseId))
    const scopedReleases = releases.filter((r) => trackReleaseIds.has(r.id))

    // 1. Detect Missing Essential Metadata (Untagged Audio Files / "Unknown Artist")
    const missingArtistTracks = tracks.filter((t) => {
      const art = (t.artistCredit || '').trim().toLowerCase()
      const comp = (t.composerName || '').trim().toLowerCase()
      return !art || art === 'unknown artist' || art === 'unknown' || (!comp && art.includes('unknown'))
    })

    if (missingArtistTracks.length > 0) {
      const canResolveFromFolder = missingArtistTracks.some((t) => {
        const p = t.filePath || ''
        return /(?:hindi|tamil|telugu|malayalam|kannada)[\\/]([^\\/]+)/i.test(p) || (t.folderName && !/^(music|audio|flac|wav|mp3)$/i.test(t.folderName))
      })

      dynamicIssues.push({
        id: 'audit-missing-artists',
        category: 'empty_composer',
        severity: 'critical',
        title: `Untagged Audio Files (${missingArtistTracks.length} tracks with Unknown Artist)`,
        description: `Found ${missingArtistTracks.length} track(s) without primary artist tags or assigned to generic "Unknown Artist".`,
        affectedCount: missingArtistTracks.length,
        sampleTrackIds: missingArtistTracks.map((t) => t.id),
        suggestedFix: canResolveFromFolder
          ? 'Auto-extract canonical artist & composer from directory structure.'
          : 'Query MusicBrainz & AcoustID or edit artist in Album Inspector.',
        autoFixAction: 'RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER',
        isAutoFixable: canResolveFromFolder,
        fixActionLabel: 'Extract from Folders',
        tagField: 'ALBUMARTIST',
        detectedValue: 'Unknown Artist',
        currentValue: 'Unknown Artist',
        targetValue: 'Extract from Folder',
        proposedAction: 'ALBUMARTIST = Extract from Directory',
        canonicalTarget: 'Untagged Audio Standards',
        parentEntity: 'Untagged Audio Standards',
      })
    }

    // 2. Detect Inconsistent Artist & Composer Name Variants (Dynamic Phonetic/Punctuation Clustering)
    const nameClusters = new Map<string, Map<string, string[]>>() // normKey -> exactName -> trackIds[]
    tracks.forEach((t) => {
      const candidates = [t.artistCredit, t.composerName].filter((n): n is string => Boolean(n && n.trim() && n !== 'Unknown Artist'))
      candidates.forEach((name) => {
        // Multi-artist collaboration credits must NEVER be clustered as single-artist typo variants
        if (splitMultiArtistCredits(name).length > 1) return

        const norm = name.toLowerCase().replace(/[\.\s_,\-]+/g, '')
        if (!norm || norm === 'unknownartist') return
        if (!nameClusters.has(norm)) {
          nameClusters.set(norm, new Map())
        }
        const sub = nameClusters.get(norm)!
        const arr = sub.get(name) || []
        arr.push(t.id)
        sub.set(name, arr)
      })
    })

    nameClusters.forEach((subMap, normKey) => {
      const variants = Array.from(subMap.keys()).sort(
        (a, b) => subMap.get(b)!.length - subMap.get(a)!.length
      )
      // Check if a user-remembered normalization rule exists for this cluster
      const rememberedRule = normalizationService.findRuleForCluster(normKey, variants, 'artist')
      const canonical = rememberedRule?.targetValue || variants[0]

      if (subMap.size > 1) {
        // Conflicting variants found in the scoped tracks
        const nonCanonicalVariants = variants.filter((v) => v !== canonical)
        const allTrackIds = Array.from(new Set(Array.from(subMap.values()).flat()))
        const nonCanonicalIds = Array.from(
          new Set(nonCanonicalVariants.flatMap((v) => subMap.get(v)!))
        )
        const detectedVal = nonCanonicalVariants[0] || variants[1] || ''

        dynamicIssues.push({
          id: `audit-name-${encodeURIComponent(normKey)}`,
          category: 'inconsistent_name',
          severity: 'warning',
          title: `Inconsistent Artist Name: "${canonical}" vs "${nonCanonicalVariants[0] || variants[1]}"`,
          description: `Discovered ${allTrackIds.length} track(s) with conflicting spellings (${variants.join(' vs ')}).${
            rememberedRule ? ` (Precedence: Remembered Rule → "${canonical}")` : ''
          }`,
          affectedCount: nonCanonicalIds.length,
          sampleTrackIds: allTrackIds,
          suggestedFix: `Normalize all affected tracks to canonical authority "${canonical}".`,
          autoFixAction: 'NORMALIZE_ARTIST_NAMES',
          isAutoFixable: true,
          fixActionLabel: 'Normalize Names',
          tagField: 'ALBUMARTIST',
          detectedValue: detectedVal,
          currentValue: detectedVal,
          targetValue: canonical,
          proposedAction: `ALBUMARTIST = "${canonical}"`,
          canonicalTarget: canonical,
          parentEntity: canonical,
          isRoleConflict: false,
          confidence: 'high_confidence_typo',
        })
      } else if (
        rememberedRule &&
        variants[0] !== rememberedRule.targetValue &&
        splitMultiArtistCredits(variants[0]).length <= 1 &&
        normalizationService.isPlausibleVariant(variants[0], rememberedRule.targetValue)
      ) {
        // All tracks in this cluster currently share a spelling, but a remembered rule dictates a different canonical form
        const allTrackIds = subMap.get(variants[0]) || []
        dynamicIssues.push({
          id: `audit-name-${encodeURIComponent(normKey)}`,
          category: 'inconsistent_name',
          severity: 'warning',
          title: `Artist Name Deviation from Remembered Rule: "${variants[0]}"`,
          description: `Discovered ${allTrackIds.length} track(s) with spelling "${variants[0]}" which deviates from remembered canonical rule "${rememberedRule.targetValue}".`,
          affectedCount: allTrackIds.length,
          sampleTrackIds: allTrackIds,
          suggestedFix: `Normalize all affected tracks to canonical authority "${rememberedRule.targetValue}".`,
          autoFixAction: 'NORMALIZE_ARTIST_NAMES',
          isAutoFixable: true,
          fixActionLabel: 'Normalize Names',
          tagField: 'ALBUMARTIST',
          detectedValue: variants[0],
          currentValue: variants[0],
          targetValue: rememberedRule.targetValue,
          proposedAction: `ALBUMARTIST = "${rememberedRule.targetValue}"`,
          canonicalTarget: rememberedRule.targetValue,
          parentEntity: rememberedRule.targetValue,
          isRoleConflict: false,
          confidence: 'high_confidence_typo',
        })
      }
    })

    // 2b. Detect Performer vs. Composer Role Conflicts (Soundtracks & Compilations)
    const singerMap = new Map<string, { parent: string; trackIds: string[]; singer: string }>()
    tracks.forEach((t) => {
      if (t.pendingSidecarEdits?.roleVerified) return
      const rel = scopedReleases.find((r) => r.id === t.releaseId)
      const parentArtist = (rel?.artistCredit || t.composerName || '').trim()
      const trackArtist = (t.artistCredit || '').trim()

      if (
        parentArtist &&
        trackArtist &&
        parentArtist.toLowerCase() !== 'unknown artist' &&
        trackArtist.toLowerCase() !== 'unknown artist' &&
        trackArtist.toLowerCase() !== parentArtist.toLowerCase() &&
        !normalizationService.isPlausibleVariant(trackArtist, parentArtist)
      ) {
        const key = `${parentArtist}:::${trackArtist}`
        if (!singerMap.has(key)) {
          singerMap.set(key, { parent: parentArtist, trackIds: [], singer: trackArtist })
        }
        singerMap.get(key)!.trackIds.push(t.id)
      }
    })

    singerMap.forEach(({ parent, trackIds, singer }, key) => {
      dynamicIssues.push({
        id: `audit-role-${encodeURIComponent(key)}`,
        category: 'compilation_conflict',
        severity: 'info',
        title: `Performer vs. Composer: "${singer}"`,
        description: `Discovered ${trackIds.length} track(s) performed by "${singer}" under album authority "${parent}".`,
        affectedCount: trackIds.length,
        sampleTrackIds: trackIds,
        suggestedFix: `Keep as Track Artist to preserve playback singer credits.`,
        autoFixAction: 'KEEP_TRACK_ARTIST',
        isAutoFixable: true,
        fixActionLabel: 'Keep Singer',
        tagField: 'ARTIST',
        detectedValue: singer,
        currentValue: singer,
        targetValue: singer,
        proposedAction: `ARTIST = "${singer}" (Keep Singer)`,
        canonicalTarget: parent,
        parentEntity: parent,
        isRoleConflict: true,
        confidence: 'role_review_required',
      })
    })


    // 3. Detect Missing Sequential Track Numbers
    const missingTrackNumIds = tracks.filter((t) => !t.trackNumber || t.trackNumber <= 0).map((t) => t.id)
    if (missingTrackNumIds.length > 0) {
      dynamicIssues.push({
        id: 'audit-missing-track-numbers',
        category: 'missing_track_num',
        severity: 'warning',
        title: 'Missing Sequential Track Numbers',
        description: `Found ${missingTrackNumIds.length} track(s) without sequential track index tags.`,
        affectedCount: missingTrackNumIds.length,
        sampleTrackIds: missingTrackNumIds,
        suggestedFix: 'Auto-sequence track numbers based on directory file order or file naming.',
        autoFixAction: 'AUTOGEN_TRACK_NUMBERS',
        isAutoFixable: true,
        fixActionLabel: 'Auto-Sequence',
        tagField: 'TRACK_NUMBER',
        detectedValue: 'Missing Track Numbers',
        currentValue: '0 / Null',
        targetValue: 'Sequential (01..N)',
        proposedAction: 'TRACKNUMBER = Sequential (01..N)',
        canonicalTarget: 'Sequential Track Indexing',
        parentEntity: 'Sequential Track Indexing',
      })
    }

    // 4. Detect Low-Resolution Cover Artwork (< 800px) or Missing Artwork
    const lowResReleases = scopedReleases.filter(
      (r) =>
        r.artwork?.isLowRes ||
        !r.artwork?.width ||
        r.artwork.width < 800 ||
        r.artwork.resolution === 'No Embedded Art' ||
        r.artwork.resolution.includes('Low-Res')
    )
    if (lowResReleases.length > 0) {
      const affectedTrackIds = tracks
        .filter((t) => lowResReleases.some((r) => r.id === t.releaseId))
        .map((t) => t.id)

      if (affectedTrackIds.length > 0) {
        dynamicIssues.push({
          id: 'audit-low-res-art',
          category: 'low_res_art',
          severity: 'warning',
          title: 'Missing / Low-Resolution Cover Artwork (< 800px)',
          description: `Found ${lowResReleases.length} album(s) (${affectedTrackIds.length} tracks) lacking archival artwork.`,
          affectedCount: affectedTrackIds.length,
          sampleTrackIds: affectedTrackIds,
          suggestedFix: 'Search Cover Art Archive and iTunes for archival album cover art.',
          autoFixAction: 'FETCH_HIRES_ART',
          isAutoFixable: true,
          fixActionLabel: 'Fetch Online Art',
          tagField: 'COVER_ART',
          detectedValue: 'Low-Res Cover Art (< 800px)',
          currentValue: '< 800px',
          targetValue: 'Archival High-Res (Front)',
          proposedAction: 'COVER = Archival Front Scan',
          canonicalTarget: 'Artwork & Media Integrity',
          parentEntity: 'Artwork & Media Integrity',
        })
      }
    }

    // 5. Detect Compilation Boxset vs Folder Mismatch
    const compilationConflictTracks = tracks.filter((t) => {
      const rel = scopedReleases.find((r) => r.id === t.releaseId)
      const folderName = t.folderName || rel?.folderName
      const albumTitle = rel?.title
      if (!folderName || !albumTitle) return false
      const isGeneric = /^(signature collection|greatest hits|best of|collection|boxset|anthology|various artists)/i.test(albumTitle.trim())
      const isCleanFolder = !['music', 'audio', 'master', 'flac', 'wav', 'mp3'].includes(folderName.toLowerCase())
      return isGeneric && isCleanFolder && folderName.toLowerCase() !== albumTitle.toLowerCase()
    })

    if (compilationConflictTracks.length > 0) {
      dynamicIssues.push({
        id: 'audit-compilation-conflict',
        category: 'compilation_conflict',
        severity: 'warning',
        title: 'Compilation Boxset vs Folder Mismatch',
        description: `Found ${compilationConflictTracks.length} track(s) where compilation boxset tag overrides canonical album folder name.`,
        affectedCount: compilationConflictTracks.length,
        sampleTrackIds: compilationConflictTracks.map((t) => t.id),
        suggestedFix: 'Synchronize canonical album names from physical album directories.',
        autoFixAction: 'SYNC_FOLDER_TO_ALBUM',
        isAutoFixable: true,
        fixActionLabel: 'Sync from Folder',
        tagField: 'ALBUMARTIST',
        detectedValue: compilationConflictTracks[0]?.folderName || 'Generic Title Mismatch',
        currentValue: compilationConflictTracks[0]?.folderName || 'Generic Title',
        targetValue: 'Sync Directory Name',
        proposedAction: 'ALBUM = Synchronize from Directory',
        canonicalTarget: 'Physical Directory Hierarchy',
        parentEntity: 'Physical Directory Hierarchy',
      })
    }

    // 6. Detect FLAC Stream Bit-Rot / Unverified Checksum
    const unverifiedChecksums = tracks.filter((t) => t.checksumValid === false)
    if (unverifiedChecksums.length > 0) {
      dynamicIssues.push({
        id: 'audit-checksum-failure',
        category: 'checksum_mismatch',
        severity: 'critical',
        title: 'FLAC Stream Bit-Rot / CRC Failure',
        description: `Found ${unverifiedChecksums.length} track(s) with corrupted stream data or CRC failure.`,
        affectedCount: unverifiedChecksums.length,
        sampleTrackIds: unverifiedChecksums.map((t) => t.id),
        suggestedFix: 'Corrupted audio stream bytes. Replace or restore original FLAC from bit-perfect backup or re-rip disc.',
        isAutoFixable: false,
        manualActionHint: 'Corrupted audio stream bytes cannot be repaired by metadata sidecars. Re-rip or restore from backup.',
        tagField: 'METADATA',
        detectedValue: 'Stream CRC Failure',
        currentValue: 'Corrupted Stream CRC',
        targetValue: 'Bit-Perfect Backup',
        proposedAction: 'Restore Stream from Bit-Perfect Backup',
        canonicalTarget: 'Bitstream & Checksum Integrity',
        parentEntity: 'Bitstream & Checksum Integrity',
      })
    }

    // 7. Detect Uncommitted Staged Edits (Awaiting User Review & Commit)
    const uncommittedTrackIds = tracks.filter((t) => t.sidecarStatus === 'uncommitted_sidecar').map((t) => t.id)
    if (uncommittedTrackIds.length > 0) {
      dynamicIssues.push({
        id: 'audit-uncommitted-sidecars',
        category: 'uncommitted_sidecar',
        severity: 'info',
        title: `Pending Library Edits (${uncommittedTrackIds.length} tracks)`,
        description: `Found ${uncommittedTrackIds.length} track(s) with pending metadata edits staged in memory.`,
        affectedCount: uncommittedTrackIds.length,
        sampleTrackIds: uncommittedTrackIds,
        suggestedFix: 'Review and save pending changes, or discard edits to restore original tags.',
        isAutoFixable: false,
        manualActionHint: 'Pending staged edits in memory. Click Review & Save to write to disk or Discard to revert.',
        tagField: 'METADATA',
        detectedValue: `${uncommittedTrackIds.length} Pending Edits`,
        currentValue: `${uncommittedTrackIds.length} Pending Edits`,
        targetValue: 'Save Changes to Library',
        proposedAction: 'Review & Save Pending Changes',
        canonicalTarget: 'Pending Library Changes',
        parentEntity: 'Pending Library Changes',
      })
    }

    // ==========================================
    // Calibrated Production-Grade Health Score Calculation
    // ==========================================
    const totalTracks = tracks.length
    // Exclude auto-verified role conflict issues (playback singers) from health score penalty
    const activeIssues = dynamicIssues.filter((i) => i.affectedCount > 0 && !i.isRoleConflict)
    let totalPenalty = 0

    if (totalTracks > 0 && activeIssues.length > 0) {
      for (const issue of activeIssues) {
        const ratio = Math.min(1, issue.affectedCount / totalTracks)
        let itemDeduction = 0

        if (issue.severity === 'critical') {
          // Critical defects: e.g. untagged tracks or CRC failure
          // Base deduction 5 points + up to 25 points proportional to library defect percentage
          itemDeduction = Math.round(5 + ratio * 25)
        } else if (issue.severity === 'warning') {
          // Warning defects: low-res art, inconsistent names, compilation mismatch
          itemDeduction = Math.round(2 + ratio * 12)
        } else {
          // Info defects
          itemDeduction = Math.round(1 + ratio * 4)
        }

        totalPenalty += itemDeduction
        deductions.push({
          reason: issue.title,
          category: issue.category,
          points: itemDeduction,
          affectedCount: issue.affectedCount,
        })
      }
    }

    // Health Score between 10% and 100%
    const healthScore = totalPenalty === 0 ? 100 : Math.max(10, Math.min(99, 100 - totalPenalty))
    const cleanTracks = Math.max(0, totalTracks - missingArtistTracks.length)

    return {
      issues: dynamicIssues,
      healthScore,
      deductions: deductions.sort((a, b) => b.points - a.points),
      totalTracks,
      cleanTracks,
    }
  }

  /**
   * Performs real-time dynamic hygiene diagnostics across all tracks currently in the graph engine
   * (or a specified scope) and persists them in graphEngine.
   */
  public runFullCatalogAudit(scopeTracks?: Track[]): AuditIssue[] {
    this.lastAuditTimestamp = new Date().toISOString()
    const tracks = scopeTracks || graphEngine.getAllTracks()
    const releases = graphEngine.getAllReleases()

    if (tracks.length === 0) {
      return graphEngine.getAllAuditIssues()
    }

    // Self-healing purge: if any tracks only contain pending backdrop edits from previous audit runs, clean them up
    tracks.forEach((trk) => {
      if (trk.sidecarStatus === 'uncommitted_sidecar' && trk.pendingSidecarEdits) {
        const editKeys = Object.keys(trk.pendingSidecarEdits)
        if (editKeys.length === 1 && editKeys[0] === 'backdropUrl') {
          trk.sidecarStatus = 'synced'
          trk.pendingSidecarEdits = undefined
          graphEngine.addOrUpdateTrack(trk)
        }
      }
    })

    const { issues: dynamicIssues } = this.computeCatalogAudit(tracks, releases)

    let finalIssues: AuditIssue[] = []
    if (graphEngine.isUsingCustomLibrary()) {
      finalIssues = dynamicIssues.filter((i) => i.category !== 'unformatted_backdrop')
    } else {
      // In demo catalog mode: merge with existing demo issues, filtering out unformatted_backdrop
      const existingIssues = graphEngine.getAllAuditIssues().filter((i) => i.category !== 'unformatted_backdrop')
      const mergedMap = new Map<string, AuditIssue>()
      existingIssues.forEach((i) => mergedMap.set(i.id, i))
      dynamicIssues.forEach((i) => {
        if (i.category !== 'unformatted_backdrop') {
          mergedMap.set(i.id, i)
        }
      })
      finalIssues = Array.from(mergedMap.values())
    }

    // Align any audit issues with active remembered normalization rules
    for (const issue of finalIssues) {
      if (issue.autoFixAction === 'NORMALIZE_ARTIST_NAMES' && !issue.isRoleConflict) {
        const rawNames = issue.description.match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, '')) || []
        for (const name of rawNames) {
          const normKey = normalizationService.normalizeKey(name)
          const rule = normalizationService.findRuleForCluster(normKey, rawNames, 'artist')
          if (rule && rule.isEnabled && normalizationService.isPlausibleVariant(name, rule.targetValue)) {
            issue.suggestedFix = `Standardize to "${rule.targetValue}" matching remembered normalization authority.`
            issue.title = `Inconsistent Artist Name: "${rule.targetValue}" vs variants`
            issue.parentEntity = rule.targetValue
            issue.proposedAction = `Normalize to "${rule.targetValue}"`
            break
          }
        }
      }
    }

    graphEngine.setAuditIssues(finalIssues)
    return finalIssues
  }


  /**
   * Executes 1-click automatic remediation directly on the user's real tracks and releases.
   * Only operates on issues that are genuinely auto-fixable.
   */
  public async remediateIssue(
    issueIdOrAction: string,
    options?: { provider?: 'apple' | 'musicbrainz' | 'ai'; [key: string]: any }
  ): Promise<{ success: boolean; message: string }> {
    let issues = graphEngine.getAllAuditIssues()
    let issue = issues.find((i) => i.id === issueIdOrAction || i.autoFixAction === issueIdOrAction)
    if (!issue) {
      issues = this.runFullCatalogAudit()
      issue = issues.find((i) => i.id === issueIdOrAction || i.autoFixAction === issueIdOrAction)
    }

    if (!issue) {
      if (issueIdOrAction === 'FETCH_HIRES_ART') {
        const lowResReleases = graphEngine.getAllReleases().filter(
          (r) =>
            r.artwork?.isLowRes ||
            !r.artwork?.frontCoverUrl ||
            !r.artwork?.width ||
            r.artwork.width < 800 ||
            r.artwork.resolution === 'No Embedded Art' ||
            r.artwork.resolution.includes('Low-Res')
        )
        const affectedTrackIds = graphEngine
          .getAllTracks()
          .filter((t) => lowResReleases.some((r) => r.id === t.releaseId))
          .map((t) => t.id)

        if (lowResReleases.length > 0 || affectedTrackIds.length > 0) {
          issue = {
            id: 'audit-low-res-art',
            category: 'low_res_art',
            severity: 'warning',
            title: 'Missing / Low-Resolution Cover Artwork (< 800px)',
            description: `Found ${lowResReleases.length} album(s) lacking archival artwork.`,
            affectedCount: affectedTrackIds.length,
            sampleTrackIds: affectedTrackIds,
            suggestedFix: 'Search Cover Art Archive and Apple Music for archival album cover art.',
            autoFixAction: 'FETCH_HIRES_ART',
            isAutoFixable: true,
            fixActionLabel: 'Fetch Online Art',
          }
        }
      } else if (issueIdOrAction === 'REWORK_BACKDROP' || issueIdOrAction === 'APPLY_BACKDROP') {
        const composerQuery = options?.composer || options?.artist || ''
        const candidateReleases = graphEngine.getAllReleases().filter((r) => {
          if (composerQuery) {
            const matchC = r.composerName?.toLowerCase().includes(composerQuery.toLowerCase())
            const matchA = r.artistCredit?.toLowerCase().includes(composerQuery.toLowerCase())
            if (!matchC && !matchA) return false
          }
          return true
        })

        const affectedTrackIds = graphEngine
          .getAllTracks()
          .filter((t) => candidateReleases.some((r) => r.id === t.releaseId))
          .map((t) => t.id)

          issue = {
          id: 'audit-missing-backdrops',
          category: 'missing_backdrop' as any,
          severity: 'info',
          title: 'Album Panoramic Backdrops for Virtual Grid',
          description: `Ready to generate and apply high-fidelity cinematic backdrops across ${candidateReleases.length} album(s).`,
          affectedCount: affectedTrackIds.length,
          sampleTrackIds: affectedTrackIds,
          suggestedFix: 'Generate 2400x320 cinematic panoramic wallpaper derivatives and stage in sidecars.',
          autoFixAction: 'REWORK_BACKDROP',
          isAutoFixable: true,
          fixActionLabel: 'Rework Backdrops',
        }
      } else if (issueIdOrAction === 'NORMALIZE_GENRES') {
        issue = {
          id: 'audit-normalize-genres',
          category: 'genre_conflict' as any,
          severity: 'info',
          title: 'Fragmented Genre Normalization',
          description: 'Ready to normalize and unify genre tags across catalog albums.',
          affectedCount: graphEngine.getAllReleases().length,
          sampleTrackIds: [],
          suggestedFix: 'Cluster and normalize semantic genre variations.',
          autoFixAction: 'NORMALIZE_GENRES',
          isAutoFixable: true,
          fixActionLabel: 'Normalize Genres',
        }
      } else if (issueIdOrAction === 'RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER') {
        const unknownTracks = graphEngine.getAllTracks().filter(
          (t) =>
            !t.artistCredit ||
            t.artistCredit.toLowerCase() === 'unknown artist' ||
            t.artistCredit.toLowerCase() === 'unknown'
        )
        issue = {
          id: 'audit-missing-artists',
          category: 'empty_composer',
          severity: 'critical',
          title: 'Untagged Audio Files (Unknown Artist)',
          description: `Found ${unknownTracks.length} track(s) without primary artist tags.`,
          affectedCount: unknownTracks.length,
          sampleTrackIds: unknownTracks.map((t) => t.id),
          suggestedFix: 'Auto-extract canonical artist & composer from directory structure.',
          autoFixAction: 'RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER',
          isAutoFixable: true,
          fixActionLabel: 'Extract from Folders',
        }
      } else if (issueIdOrAction === 'SYNC_FOLDER_TO_ALBUM') {
        const allTracks = graphEngine.getAllTracks()
        issue = {
          id: 'audit-sync-folder-album',
          category: 'album_folder_conflict' as any,
          severity: 'warning',
          title: 'Physical Folder to Album Name Desynchronization',
          description: 'Ready to sync release titles from physical directory folder names.',
          affectedCount: allTracks.length,
          sampleTrackIds: allTracks.map((t) => t.id),
          suggestedFix: 'Synchronize canonical album names from physical directory folders.',
          autoFixAction: 'SYNC_FOLDER_TO_ALBUM',
          isAutoFixable: true,
          fixActionLabel: 'Sync Album Names',
        }
      } else if (issueIdOrAction === 'MERGE_DUPLICATE_PERFORMERS') {
        issue = {
          id: 'audit-merge-performers',
          category: 'duplicate_performers' as any,
          severity: 'info',
          title: 'Merge Duplicate Performers',
          description: 'Canonicalize and merge performer credit authorities.',
          affectedCount: graphEngine.getAllTracks().length,
          sampleTrackIds: graphEngine.getAllTracks().map((t) => t.id),
          suggestedFix: 'Normalize and merge duplicate performer authorities across catalog.',
          autoFixAction: 'MERGE_DUPLICATE_PERFORMERS',
          isAutoFixable: true,
          fixActionLabel: 'Merge Performers',
        }
      }
    }

    if (!issue) return { success: false, message: 'Issue not found' }

    if (issue.isAutoFixable === false || !issue.autoFixAction) {
      return {
        success: false,
        message:
          issue.manualActionHint ||
          `Issue "${issue.title}" cannot be automatically repaired via metadata sidecars and requires manual triage.`,
      }
    }

    const actionToRun = issue.autoFixAction || issueIdOrAction
    switch (actionToRun) {
      case 'NORMALIZE_ARTIST_NAMES': {
        // Dynamically identify canonical name from suggestedFix, parentEntity, or sample track
        let canonical = ''
        const match = issue.suggestedFix.match(/to (?:canonical authority )?"([^"]+)"/)
        if (match) {
          canonical = match[1]
        } else if (issue.parentEntity) {
          canonical = issue.parentEntity
        } else if (issue.sampleTrackIds.length > 0) {
          const t0 = graphEngine.getTrackById(issue.sampleTrackIds[0])
          if (t0) canonical = t0.artistCredit
        }

        if (!canonical) {
          canonical = 'Canonical Artist'
        }

        let count = 0
        const trackIdsToFix =
          issue.sampleTrackIds.length > 0
            ? issue.sampleTrackIds
            : graphEngine.getAllTracks().map((t) => t.id)

        const recordedSources = new Set<string>()

        trackIdsToFix.forEach((id) => {
          const trk = graphEngine.getTrackById(id)
          if (trk) {
            const isArtistPlausible = normalizationService.isPlausibleVariant(trk.artistCredit, canonical)
            const isComposerPlausible = trk.composerName && normalizationService.isPlausibleVariant(trk.composerName, canonical)

            let isModified = false
            const pendingEdits: Record<string, any> = { ...(trk.pendingSidecarEdits || {}) }

            // Only update artistCredit if it is genuinely a spelling/spacing/typo variant of canonical
            // and strictly NOT a multi-artist collaboration credit
            const isMultiArtist = splitMultiArtistCredits(trk.artistCredit).length > 1
            if (!isMultiArtist && isArtistPlausible && trk.artistCredit !== canonical) {
              recordedSources.add(trk.artistCredit)
              trk.artistCredit = canonical
              pendingEdits.artistCredit = canonical
              isModified = true
            }

            // Update composerName if it is a variant
            if (isComposerPlausible && trk.composerName !== canonical) {
              recordedSources.add(trk.composerName!)
              trk.composerName = canonical
              pendingEdits.composerName = canonical
              isModified = true
            }

            if (isModified) {
              trk.sidecarStatus = 'uncommitted_sidecar'
              trk.pendingSidecarEdits = pendingEdits
              count++
            }
          }
        })

        // Also check if issue title or description explicitly mentions the non-canonical variant
        const vsMatch = issue.title.match(/vs\s+"([^"]+)"/) || issue.description.match(/variants?\s+"([^"]+)"/)
        if (vsMatch && vsMatch[1] && vsMatch[1] !== canonical && normalizationService.isPlausibleVariant(vsMatch[1], canonical)) {
          recordedSources.add(vsMatch[1])
        }

        // Persist each normalization rule so it is remembered forever
        recordedSources.forEach((src) => {
          normalizationService.recordNormalization(src, canonical, 'artist')
        })

        this.runFullCatalogAudit()

        return { success: true, message: `Normalized ${count} artist tag instances to "${canonical}" in staged sidecars.` }
      }

      case 'KEEP_TRACK_ARTIST': {
        let count = 0
        issue.sampleTrackIds.forEach((id) => {
          const trk = graphEngine.getTrackById(id)
          if (trk) {
            trk.sidecarStatus = 'uncommitted_sidecar'
            trk.pendingSidecarEdits = {
              ...(trk.pendingSidecarEdits || {}),
              roleVerified: true,
            }
            count++
          }
        })
        this.runFullCatalogAudit()
        return { success: true, message: `Preserved ${count} playback singer credit(s) as track artist.` }
      }

      case 'STANDARDIZE_COMPOSER_ONLY': {
        let count = 0
        const canonical = issue.parentEntity || ''
        if (canonical) {
          issue.sampleTrackIds.forEach((id) => {
            const trk = graphEngine.getTrackById(id)
            if (trk) {
              trk.composerName = canonical
              trk.sidecarStatus = 'uncommitted_sidecar'
              trk.pendingSidecarEdits = {
                ...(trk.pendingSidecarEdits || {}),
                composerName: canonical,
                roleVerified: true,
              }
              count++
            }
          })
        }
        this.runFullCatalogAudit()
        return { success: true, message: `Standardized composer to "${canonical}" for ${count} track(s) while keeping singer intact.` }
      }

      case 'AUTOGEN_TRACK_NUMBERS': {
        const byRelease = new Map<string, Track[]>()
        const trackIds =
          issue.sampleTrackIds.length > 0
            ? issue.sampleTrackIds
            : graphEngine.getAllTracks().filter((t) => !t.trackNumber).map((t) => t.id)

        trackIds.forEach((id) => {
          const trk = graphEngine.getTrackById(id)
          if (trk) {
            const arr = byRelease.get(trk.releaseId) || []
            arr.push(trk)
            byRelease.set(trk.releaseId, arr)
          }
        })

        let count = 0
        byRelease.forEach((relTracks) => {
          relTracks.sort((a, b) => a.filePath.localeCompare(b.filePath))
          relTracks.forEach((trk, idx) => {
            let nextNo = idx + 1
            const fnMatch = trk.filePath.match(/(?:^|[\\/])(?:track|trk)?[\s\-_]?0*(\d{1,3})[\s\.\-_]/i)
            if (fnMatch && fnMatch[1]) {
              const parsed = parseInt(fnMatch[1], 10)
              if (parsed > 0 && parsed <= 999) {
                nextNo = parsed
              }
            }

            trk.trackNumber = nextNo
            trk.sidecarStatus = 'uncommitted_sidecar'
            trk.pendingSidecarEdits = {
              ...(trk.pendingSidecarEdits || {}),
              trackNumber: nextNo,
            }
            count++
          })
        })

        this.runFullCatalogAudit()
        return { success: true, message: `Assigned sequential track numbers to ${count} tracks in staged sidecars.` }
      }

      case 'FETCH_HIRES_ART': {
        const preferredProvider = options?.provider || 'apple'
        const affectedReleaseIds = new Set<string>()
        if (issue.sampleTrackIds && issue.sampleTrackIds.length > 0) {
          issue.sampleTrackIds.forEach((id) => {
            const trk = graphEngine.getTrackById(id)
            if (trk) affectedReleaseIds.add(trk.releaseId)
          })
        }

        if (affectedReleaseIds.size === 0) {
          graphEngine.getAllReleases().forEach((r) => {
            if (
              r.artwork?.isLowRes ||
              !r.artwork?.frontCoverUrl ||
              !r.artwork?.width ||
              r.artwork.width < 800 ||
              r.artwork.resolution === 'No Embedded Art' ||
              r.artwork.resolution.includes('Low-Res')
            ) {
              affectedReleaseIds.add(r.id)
            }
          })
        }

        let updatedCount = 0
        const providerName =
          preferredProvider === 'apple'
            ? 'Apple Music'
            : preferredProvider === 'musicbrainz'
            ? 'MusicBrainz CAA'
            : 'Gemini AI'

        for (const relId of affectedReleaseIds) {
          const rel = graphEngine.getReleaseById(relId)
          if (!rel) continue
          const relTracks = graphEngine.getAllTracks().filter((t) => t.releaseId === relId)
          const sampleTrack = relTracks[0]
          const artist = rel.artistCredit || sampleTrack?.artistCredit || ''
          const composer = rel.composerName || sampleTrack?.composerName || ''
          const title = rel.title || sampleTrack?.folderName || sampleTrack?.title || ''

          if (!title) continue

          try {
            // 1. First attempt with preferred provider (e.g. Apple Music)
            let candidate = await federatedResolversService.fetchAlbumArtworkCandidate({
              albumTitle: title,
              artistCredit: artist,
              composerName: composer,
              releaseYear: rel.releaseYear,
              provider: preferredProvider,
            })

            // 2. Fallback hierarchy if preferred provider didn't return art
            if (!candidate?.coverArtUrl) {
              const fallbackProviders: ('apple' | 'musicbrainz' | 'ai')[] = (['apple', 'musicbrainz', 'ai'] as const).filter(
                (p) => p !== preferredProvider
              )
              for (const fb of fallbackProviders) {
                candidate = await federatedResolversService.fetchAlbumArtworkCandidate({
                  albumTitle: title,
                  artistCredit: artist,
                  composerName: composer,
                  releaseYear: rel.releaseYear,
                  provider: fb,
                })
                if (candidate?.coverArtUrl) break
              }
            }

            if (candidate?.coverArtUrl && candidate.coverArtUrl.startsWith('http')) {
              if (!rel.artwork) {
                rel.artwork = {
                  frontCoverUrl: candidate.coverArtUrl,
                  resolution: candidate.coverResolution || '3000×3000px (Apple Music Master Scan)',
                  width: 3000,
                  height: 3000,
                  dpi: 300,
                  colorProfile: 'sRGB',
                  isLowRes: false,
                  hasBookletPdf: false,
                }
              } else {
                if (!rel.artwork.originalFrontCoverUrl) {
                  rel.artwork.originalFrontCoverUrl = rel.artwork.frontCoverUrl
                }
                rel.artwork.frontCoverUrl = candidate.coverArtUrl
                rel.artwork.resolution = candidate.coverResolution || '3000×3000px (Apple Music Master Scan)'
                rel.artwork.isLowRes = false
                rel.artwork.width = 3000
                rel.artwork.height = 3000
              }

              relTracks.forEach((trk) => {
                trk.sidecarStatus = 'uncommitted_sidecar'
                trk.pendingSidecarEdits = {
                  ...(trk.pendingSidecarEdits || {}),
                  coverArtUrl: candidate!.coverArtUrl,
                }
                graphEngine.addOrUpdateTrack(trk)
              })
              graphEngine.addOrUpdateRelease(rel)
              updatedCount++
            }
          } catch (e) {
            console.warn(`[FETCH_HIRES_ART] Error resolving art for "${title}":`, e)
          }
        }

        if (updatedCount > 0) {
          this.runFullCatalogAudit()
          return {
            success: true,
            message: `Retrieved archival cover art from ${providerName} for ${updatedCount} album(s) staged in sidecars.`,
          }
        }

        return {
          success: false,
          message: 'No high-resolution archival cover art found online for the affected album(s). Please select or upload artwork in Album Customize.',
        }
      }

      case 'FILL_MISSING_METADATA': {
        let count = 0
        issue.sampleTrackIds.forEach((id) => {
          const trk = graphEngine.getTrackById(id)
          if (trk) {
            const rel = graphEngine.getReleaseById(trk.releaseId)
            let inferredYear = rel?.releaseYear || rel?.originalYear || 0
            if (!inferredYear) {
              const match = trk.filePath.match(/(?:19|20)\d{2}/)
              if (match) {
                const yr = parseInt(match[0], 10)
                if (yr >= 1900 && yr <= 2030) {
                  inferredYear = yr
                }
              }
            }
            if (inferredYear > 0) {
              if (rel) {
                rel.releaseYear = inferredYear
                rel.originalYear = inferredYear
              }
              trk.sidecarStatus = 'uncommitted_sidecar'
              trk.pendingSidecarEdits = {
                ...(trk.pendingSidecarEdits || {}),
                year: inferredYear,
              }
              count++
            }
          }
        })

        if (count > 0) {
          this.runFullCatalogAudit()
          return { success: true, message: `Derived release year across ${count} tracks from directory structure in staged sidecars.` }
        }
        return {
          success: false,
          message: 'Could not reliably infer release year from directory path. Please specify the year manually in the Album Inspector.',
        }
      }

      case 'SYNC_FOLDER_TO_ALBUM': {
        let count = 0
        issue.sampleTrackIds.forEach((id) => {
          const trk = graphEngine.getTrackById(id)
          if (trk && trk.folderName) {
            const rel = graphEngine.getReleaseById(trk.releaseId)
            if (rel && rel.title !== trk.folderName) {
              graphEngine.updateReleaseNames(rel.id, { title: trk.folderName })
            }
            trk.sidecarStatus = 'uncommitted_sidecar'
            trk.pendingSidecarEdits = {
              ...(trk.pendingSidecarEdits || {}),
              album: trk.folderName,
            }
            count++
          }
        })

        if (count > 0) {
          this.runFullCatalogAudit()
          return {
            success: true,
            message: `Synchronized canonical album names from physical directory folders across ${count} tracks in staged sidecars.`,
          }
        }
        return {
          success: false,
          message: 'No physical folder names found to synchronize.',
        }
      }

      case 'RESOLVE_UNKNOWN_ARTISTS_FROM_FOLDER': {
        let count = 0
        const allTracks = graphEngine.getAllTracks()
        allTracks.forEach((trk) => {
          const rawArt = (trk.artistCredit || '').trim().toLowerCase()
          const isUnknown = !rawArt || rawArt === 'unknown artist' || rawArt === 'unknown'
          if (isUnknown) {
            const p = (trk.filePath || '').replace(/\\/g, '/')
            const parts = p.split('/').filter(Boolean)

            // Pattern: .../Language/Artist/Album/Track.wav
            let candidateArtist = ''
            let candidateComposer = ''

            for (let i = 0; i < parts.length; i++) {
              const part = parts[i]
              for (const comp of KNOWN_COMPOSERS) {
                if (comp.aliases.some((al) => part.toLowerCase().includes(al))) {
                  candidateArtist = comp.canonicalName
                  candidateComposer = comp.canonicalName
                  break
                }
              }
              if (candidateArtist) break
              for (const art of KNOWN_ARTISTS) {
                if (art.aliases.some((al) => part.toLowerCase().includes(al))) {
                  candidateArtist = art.canonicalName
                  break
                }
              }
              if (candidateArtist) break
            }

            if (!candidateArtist && trk.folderName && !/^(music|audio|flac|wav|mp3|songs)$/i.test(trk.folderName)) {
              candidateArtist = trk.folderName
            }

            if (candidateArtist) {
              trk.artistCredit = candidateArtist
              if (candidateComposer) trk.composerName = candidateComposer
              trk.sidecarStatus = 'uncommitted_sidecar'
              trk.pendingSidecarEdits = {
                ...(trk.pendingSidecarEdits || {}),
                artistCredit: candidateArtist,
                ...(candidateComposer ? { composerName: candidateComposer } : {}),
              }
              count++
            }
          }
        })

        if (count > 0) {
          this.runFullCatalogAudit()
          return {
            success: true,
            message: `Auto-resolved canonical artist and composer credits from directory hierarchy for ${count} track(s) in staged sidecars.`,
          }
        }
        return {
          success: false,
          message: 'No directory hierarchy patterns matched for unknown artists. Please edit manually in Album Inspector.',
        }
      }

      case 'MERGE_DUPLICATE_PERFORMERS': {
        let count = 0
        const allTracks = graphEngine.getAllTracks()
        allTracks.forEach((trk) => {
          const raw = trk.artistCredit || ''
          const norm = raw.toLowerCase().replace(/[\.\-_,\s]+/g, '')
          for (const art of KNOWN_ARTISTS) {
            if (
              art.aliases.some((al) => {
                const normAl = al.replace(/[\.\-_,\s]+/g, '')
                return norm === normAl || (norm.includes(normAl) && !norm.includes('feat') && !norm.includes('&'))
              })
            ) {
              if (trk.artistCredit !== art.canonicalName) {
                trk.artistCredit = art.canonicalName
                trk.sidecarStatus = 'uncommitted_sidecar'
                trk.pendingSidecarEdits = {
                  ...(trk.pendingSidecarEdits || {}),
                  artistCredit: art.canonicalName,
                }
                count++
              }
              break
            }
          }
        })

        if (count > 0) {
          this.runFullCatalogAudit()
          return {
            success: true,
            message: `Normalized and merged duplicate performer authorities across ${count} track(s) in staged sidecars.`,
          }
        }
        return {
          success: false,
          message: 'All performer authorities are already canonicalized.',
        }
      }

      case 'NORMALIZE_GENRES': {
        let count = 0
        const allReleases = graphEngine.getAllReleases()
        allReleases.forEach((rel) => {
          if (Array.isArray(rel.genreTags) && rel.genreTags.length > 0) {
            const canonicalTags = Array.from(
              new Set(rel.genreTags.map((g) => canonicalizeGenre(g)).filter((g) => g !== 'Unclassified'))
            )
            if (canonicalTags.length > 0 && JSON.stringify(canonicalTags) !== JSON.stringify(rel.genreTags)) {
              rel.genreTags = canonicalTags
              count++
            }
          }
        })

        if (count > 0) {
          this.runFullCatalogAudit()
          return {
            success: true,
            message: `Normalized and unified genre tags across ${count} album(s) in catalog.`,
          }
        }
        return {
          success: false,
          message: 'All genre tags are already canonicalized.',
        }
      }

      case 'APPLY_BACKDROP':
      case 'REWORK_BACKDROP': {
        const composerQuery = options?.composer || options?.artist || ''
        const targetReleaseId = options?.releaseId

        let targetReleases = graphEngine.getAllReleases()
        if (targetReleaseId) {
          targetReleases = targetReleases.filter((r) => r.id === targetReleaseId)
        } else if (composerQuery) {
          const normQuery = composerQuery.toLowerCase().replace(/[\.\-_,]/g, ' ').replace(/\s+/g, ' ').trim()
          targetReleases = targetReleases.filter((r) => {
            const normC = (r.composerName || '').toLowerCase().replace(/[\.\-_,]/g, ' ').replace(/\s+/g, ' ').trim()
            const normA = (r.artistCredit || '').toLowerCase().replace(/[\.\-_,]/g, ' ').replace(/\s+/g, ' ').trim()
            const matchC = normC.includes(normQuery) || (normC.length > 0 && normQuery.includes(normC))
            const matchA = normA.includes(normQuery) || (normA.length > 0 && normQuery.includes(normA))
            return matchC || matchA
          })
        }

        if (targetReleases.length === 0) {
          targetReleases = graphEngine.getAllReleases()
        }

        let updatedCount = 0
        for (const rel of targetReleases) {
          let artUrl = rel.artwork?.frontCoverUrl || ''

          // If front cover is missing or low-res or generic placeholder or suspected inlay scan, fetch high-resolution authentic front artwork first
          if (!artUrl || rel.artwork?.isLowRes || artUrl.includes('unsplash') || INLAY_SCAN_PATTERNS.test(artUrl)) {
            const relTracks = graphEngine.getAllTracks().filter((t) => t.releaseId === rel.id)
            const sampleTrack = relTracks[0]
            const artist = rel.artistCredit || sampleTrack?.artistCredit || ''
            const composer = rel.composerName || sampleTrack?.composerName || ''
            const title = rel.title || sampleTrack?.folderName || sampleTrack?.title || ''

            const curated = getCuratedAlbumArtwork(title, artist || composer)
            if (curated) {
              artUrl = curated
              if (rel.artwork) {
                rel.artwork.frontCoverUrl = artUrl
                rel.artwork.isLowRes = false
              }
            } else if (title) {
              try {
                const candidate = await federatedResolversService.fetchAlbumArtworkCandidate({
                  albumTitle: title,
                  artistCredit: artist,
                  composerName: composer,
                  releaseYear: rel.releaseYear,
                  provider: options?.provider || 'apple',
                })
                if (candidate?.coverArtUrl) {
                  artUrl = candidate.coverArtUrl
                  if (!rel.artwork) {
                    rel.artwork = {
                      frontCoverUrl: artUrl,
                      resolution: candidate.coverResolution || '3000×3000px (Apple Music Master Scan)',
                      width: 3000,
                      height: 3000,
                      dpi: 300,
                      colorProfile: 'sRGB',
                      isLowRes: false,
                      hasBookletPdf: false,
                    }
                  } else {
                    rel.artwork.frontCoverUrl = artUrl
                    rel.artwork.isLowRes = false
                  }
                }
              } catch {}
            }
          }

          if (!artUrl) continue

          try {
            const backdrop = await generatePanoramicBackdrop(artUrl, 2400, 320)
            if (backdrop) {
              if (!rel.artwork) {
                rel.artwork = {
                  frontCoverUrl: artUrl,
                  backdropUrl: backdrop,
                  resolution: '3000×3000px (Apple Music Master Scan)',
                  width: 3000,
                  height: 3000,
                  dpi: 300,
                  colorProfile: 'sRGB',
                  isLowRes: false,
                  hasBookletPdf: false,
                }
              } else {
                rel.artwork.backdropUrl = backdrop
              }
              rel.backdropUrl = backdrop

              const relTracks = graphEngine.getAllTracks().filter((t) => t.releaseId === rel.id)
              relTracks.forEach((trk) => {
                trk.sidecarStatus = 'uncommitted_sidecar'
                trk.pendingSidecarEdits = {
                  ...(trk.pendingSidecarEdits || {}),
                  backdropUrl: backdrop,
                  ...(artUrl && !trk.pendingSidecarEdits?.coverArtUrl ? { coverArtUrl: artUrl } : {}),
                }
                graphEngine.addOrUpdateTrack(trk)
              })

              graphEngine.addOrUpdateRelease(rel)
              updatedCount++
            }
          } catch (e) {
            console.warn(`[REWORK_BACKDROP] Error generating backdrop for "${rel.title}":`, e)
          }
        }

        if (updatedCount > 0) {
          this.runFullCatalogAudit()
          return {
            success: true,
            message: `Successfully reworked and applied panoramic backdrops across ${updatedCount} album(s) in Virtual Grid.`,
          }
        }

        return {
          success: false,
          message: 'Could not generate panoramic backdrops. Ensure album cover art is available.',
        }
      }

      default:
        return {
          success: false,
          message: `No automated 1-click remediation available for "${issue.title}". Manual triage required.`,
        }
    }
  }
}

export const auditService = new AuditService()
