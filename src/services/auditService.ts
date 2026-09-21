import { AuditIssue, Track, Release } from '../core/types'
import { graphEngine } from '../core/graphEngine'
import { federatedResolversService } from './federatedResolvers'
import {
  canonicalizeComposer,
  canonicalizeGenre,
  stripRipNoiseAndTags,
  KNOWN_COMPOSERS,
  KNOWN_ARTISTS,
} from '../core/taxonomyUtils'

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
      })
    }

    // 2. Detect Inconsistent Artist & Composer Name Variants (Dynamic Phonetic/Punctuation Clustering)
    const nameClusters = new Map<string, Map<string, string[]>>() // normKey -> exactName -> trackIds[]
    tracks.forEach((t) => {
      const candidates = [t.artistCredit, t.composerName].filter((n): n is string => Boolean(n && n.trim() && n !== 'Unknown Artist'))
      candidates.forEach((name) => {
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
      if (subMap.size > 1) {
        // Conflicting variants found in the scoped tracks
        const variants = Array.from(subMap.keys()).sort(
          (a, b) => subMap.get(b)!.length - subMap.get(a)!.length
        )
        const canonical = variants[0]
        const allTrackIds = Array.from(new Set(Array.from(subMap.values()).flat()))
        const nonCanonicalIds = Array.from(
          new Set(variants.slice(1).flatMap((v) => subMap.get(v)!))
        )

        dynamicIssues.push({
          id: `audit-name-${encodeURIComponent(normKey)}`,
          category: 'inconsistent_name',
          severity: 'warning',
          title: `Inconsistent Artist Name: "${variants[0]}" vs "${variants[1]}"`,
          description: `Discovered ${allTrackIds.length} track(s) with conflicting spellings (${variants.join(' vs ')}).`,
          affectedCount: nonCanonicalIds.length,
          sampleTrackIds: allTrackIds,
          suggestedFix: `Normalize all affected tracks to canonical authority "${canonical}".`,
          autoFixAction: 'NORMALIZE_ARTIST_NAMES',
          isAutoFixable: true,
          fixActionLabel: 'Normalize Names',
        })
      }
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
      })
    }

    // 7. Detect Uncommitted Staged Sidecars
    const uncommittedTrackIds = tracks.filter((t) => t.sidecarStatus === 'uncommitted_sidecar').map((t) => t.id)
    if (uncommittedTrackIds.length > 0) {
      dynamicIssues.push({
        id: 'audit-uncommitted-sidecars',
        category: 'uncommitted_sidecar',
        severity: 'info',
        title: 'Uncommitted Staged Sidecars',
        description: `Found ${uncommittedTrackIds.length} track(s) with pending metadata edits staged in memory.`,
        affectedCount: uncommittedTrackIds.length,
        sampleTrackIds: uncommittedTrackIds,
        suggestedFix: 'Review staged sidecar diffs and commit changes via Two-Phase Commit modal.',
        isAutoFixable: false,
        manualActionHint: 'Pending staged edits in memory. Open Two-Phase Commit modal to write sidecars to disk.',
      })
    }

    // ==========================================
    // Calibrated Production-Grade Health Score Calculation
    // ==========================================
    const totalTracks = tracks.length
    const activeIssues = dynamicIssues.filter((i) => i.affectedCount > 0)
    let totalPenalty = 0

    if (totalTracks > 0 && activeIssues.length > 0) {
      for (const issue of activeIssues) {
        const ratio = Math.min(1, issue.affectedCount / totalTracks)
        let itemDeduction = 0

        if (issue.severity === 'critical') {
          // Critical defects: e.g. untagged tracks or CRC failure
          // Base deduction 10 points + up to 50 points proportional to library defect percentage
          itemDeduction = Math.round(10 + ratio * 50)
        } else if (issue.severity === 'warning') {
          // Warning defects: low-res art, inconsistent names, compilation mismatch
          itemDeduction = Math.round(4 + ratio * 20)
        } else {
          // Info defects
          itemDeduction = Math.round(1 + ratio * 5)
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

    // Health Score between 0% and 100%
    const healthScore = totalPenalty === 0 ? 100 : Math.max(0, Math.min(99, 100 - totalPenalty))
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
    const tracks = scopeTracks || graphEngine.getAllTracks()
    const releases = graphEngine.getAllReleases()

    if (tracks.length === 0) {
      return graphEngine.getAllAuditIssues()
    }

    const { issues: dynamicIssues } = this.computeCatalogAudit(tracks, releases)

    let finalIssues: AuditIssue[] = []
    if (graphEngine.isUsingCustomLibrary()) {
      finalIssues = dynamicIssues
    } else {
      // In demo catalog mode: merge with existing demo issues
      const existingIssues = graphEngine.getAllAuditIssues()
      const mergedMap = new Map<string, AuditIssue>()
      existingIssues.forEach((i) => mergedMap.set(i.id, i))
      dynamicIssues.forEach((i) => mergedMap.set(i.id, i))
      finalIssues = Array.from(mergedMap.values())
    }

    graphEngine.setAuditIssues(finalIssues)
    return finalIssues
  }

  /**
   * Executes 1-click automatic remediation directly on the user's real tracks and releases.
   * Only operates on issues that are genuinely auto-fixable.
   */
  public async remediateIssue(issueId: string): Promise<{ success: boolean; message: string }> {
    const issues = graphEngine.getAllAuditIssues()
    const issue = issues.find((i) => i.id === issueId)
    if (!issue) return { success: false, message: 'Issue not found' }

    if (issue.isAutoFixable === false || !issue.autoFixAction) {
      return {
        success: false,
        message:
          issue.manualActionHint ||
          `Issue "${issue.title}" cannot be automatically repaired via metadata sidecars and requires manual triage.`,
      }
    }

    switch (issue.autoFixAction) {
      case 'NORMALIZE_ARTIST_NAMES': {
        // Dynamically identify canonical name from suggestedFix or the first sample track
        let canonical = ''
        const match = issue.suggestedFix.match(/to (?:canonical authority )?"([^"]+)"/)
        if (match) {
          canonical = match[1]
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

        trackIdsToFix.forEach((id) => {
          const trk = graphEngine.getTrackById(id)
          if (trk) {
            const normTrk = trk.artistCredit.toLowerCase().replace(/[\.\s_,\-]+/g, '')
            const normCanonical = canonical.toLowerCase().replace(/[\.\s_,\-]+/g, '')
            if (normTrk === normCanonical || issue.sampleTrackIds.includes(id)) {
              trk.artistCredit = canonical
              if (trk.composerName && trk.composerName.toLowerCase().replace(/[\.\s_,\-]+/g, '') === normCanonical) {
                trk.composerName = canonical
              }
              trk.sidecarStatus = 'uncommitted_sidecar'
              trk.pendingSidecarEdits = {
                ...(trk.pendingSidecarEdits || {}),
                artistCredit: canonical,
                ...(trk.composerName === canonical ? { composerName: canonical } : {}),
              }
              count++
            }
          }
        })

        this.runFullCatalogAudit()
        return { success: true, message: `Normalized ${count} artist tag instances to "${canonical}" in staged sidecars.` }
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
        const affectedReleaseIds = new Set<string>()
        issue.sampleTrackIds.forEach((id) => {
          const trk = graphEngine.getTrackById(id)
          if (trk) affectedReleaseIds.add(trk.releaseId)
        })

        if (affectedReleaseIds.size === 0) {
          graphEngine.getAllReleases().forEach((r) => {
            if (r.artwork?.isLowRes || !r.artwork?.frontCoverUrl) affectedReleaseIds.add(r.id)
          })
        }

        let updatedCount = 0
        for (const relId of affectedReleaseIds) {
          const rel = graphEngine.getReleaseById(relId)
          if (!rel) continue
          const relTracks = graphEngine.getAllTracks().filter((t) => t.releaseId === relId)
          const sampleTrack = relTracks[0]
          const artist = sampleTrack?.artistCredit || rel.artistCredit || ''
          const title = rel.title || sampleTrack?.folderName || ''

          if (!artist && !title) continue

          try {
            let candidate = await federatedResolversService.fetchMusicBrainzCandidate(artist, sampleTrack?.title || title, title)
            if (!candidate?.coverArtUrl) {
              candidate = await federatedResolversService.fetchItunesCandidate(artist, sampleTrack?.title || title, title)
            }

            if (candidate?.coverArtUrl && candidate.coverArtUrl.startsWith('http')) {
              if (!rel.artwork.originalFrontCoverUrl) {
                rel.artwork.originalFrontCoverUrl = rel.artwork.frontCoverUrl
              }
              rel.artwork.frontCoverUrl = candidate.coverArtUrl
              rel.artwork.resolution = candidate.coverResolution || 'High-Res Front (Cover Art Archive)'
              rel.artwork.isLowRes = false

              relTracks.forEach((trk) => {
                trk.sidecarStatus = 'uncommitted_sidecar'
                trk.pendingSidecarEdits = {
                  ...(trk.pendingSidecarEdits || {}),
                  coverArtUrl: candidate!.coverArtUrl,
                }
              })
              updatedCount++
            }
          } catch {
            // Network failure: do not fake art
          }
        }

        if (updatedCount > 0) {
          this.runFullCatalogAudit()
          return {
            success: true,
            message: `Retrieved archival cover art from online authorities for ${updatedCount} album(s) staged in sidecars.`,
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

      default:
        return {
          success: false,
          message: `No automated 1-click remediation available for "${issue.title}". Manual triage required.`,
        }
    }
  }
}

export const auditService = new AuditService()
