import { Release, Track } from '../core/types'
import { graphEngine } from '../core/graphEngine'
import { generatePanoramicBackdrop } from './panoramicBackdropGenerator'
import { getCuratedAlbumArtwork } from '../core/taxonomyUtils'
import { federatedResolversService } from './federatedResolvers'

export type BackdropIssueReason =
  | 'missing_panoramic'
  | 'suspected_inlay_or_back_cover'
  | 'aspect_ratio_mismatch'
  | 'low_resolution'
  | 'valid'

export interface BackdropAnalysis {
  releaseId: string
  albumTitle: string
  isUnformatted: boolean
  reason: BackdropIssueReason
  diagnosticMessage: string
  currentBackdropUrl?: string
  frontCoverUrl?: string
  suggestedAction: string
}

// Regex patterns indicating back cover, jewel-case tray, booklet, or text scan
export const INLAY_SCAN_PATTERNS =
  /(?:^|[\\/._-])(?:back|rear|tray|inlay|liner|booklet|case|disc|cd|scan|reverse|backcover|inlaycard)(?:[\\/._-]|\d|\.|$)/i

export class BackdropAnalyzerService {
  /**
   * Inspects a single album release to determine whether its background is properly formatted
   */
  public analyzeReleaseBackdrop(release: Release | undefined | null): BackdropAnalysis {
    if (!release) {
      return {
        releaseId: '',
        albumTitle: 'Unknown Album',
        isUnformatted: false,
        reason: 'valid',
        diagnosticMessage: 'No release data',
        suggestedAction: 'none',
      }
    }

    const currentBackdrop = release.artwork?.backdropUrl || release.backdropUrl || ''
    const frontCover = release.artwork?.frontCoverUrl || release.coverArtUrl || ''
    const title = release.title || release.folderName || 'Unknown Album'

    // 1. Check for suspected back-cover or inlay scan used as backdrop or cover
    if (currentBackdrop && INLAY_SCAN_PATTERNS.test(currentBackdrop)) {
      return {
        releaseId: release.id,
        albumTitle: title,
        isUnformatted: true,
        reason: 'suspected_inlay_or_back_cover',
        diagnosticMessage:
          'Backdrop image references a back-cover, tray inlay, or booklet scan containing typographic clutter and logos.',
        currentBackdropUrl: currentBackdrop,
        frontCoverUrl: frontCover,
        suggestedAction: 'Generate a clean 2400×320 panoramic wallpaper derived from the authentic front cover.',
      }
    }

    if (frontCover && INLAY_SCAN_PATTERNS.test(frontCover)) {
      return {
        releaseId: release.id,
        albumTitle: title,
        isUnformatted: true,
        reason: 'suspected_inlay_or_back_cover',
        diagnosticMessage:
          'Album cover references an inlay or tray scan with tracklists and legal text.',
        currentBackdropUrl: currentBackdrop,
        frontCoverUrl: frontCover,
        suggestedAction: 'Replace with authentic front artwork scan and generate panoramic backdrop.',
      }
    }

    // 2. Check if backdrop is missing entirely
    if (!currentBackdrop) {
      return {
        releaseId: release.id,
        albumTitle: title,
        isUnformatted: true,
        reason: 'missing_panoramic',
        diagnosticMessage:
          'No dedicated 2400×320 panoramic backdrop asset found. Display is falling back to raw square cover art.',
        currentBackdropUrl: '',
        frontCoverUrl: frontCover,
        suggestedAction: 'Generate 2400×320 panoramic derivative with feathered atmospheric wings.',
      }
    }

    // 3. Check if backdrop is merely a raw reference to the 1:1 square front cover
    if (currentBackdrop === frontCover && !currentBackdrop.startsWith('data:image')) {
      return {
        releaseId: release.id,
        albumTitle: title,
        isUnformatted: true,
        reason: 'missing_panoramic',
        diagnosticMessage:
          'Backdrop is identical to the 1:1 square front cover without panoramic composition or ambient wings.',
        currentBackdropUrl: currentBackdrop,
        frontCoverUrl: frontCover,
        suggestedAction: 'Generate 2400×320 panoramic derivative from front cover.',
      }
    }

    // 4. Check for low resolution
    if (release.artwork?.width && release.artwork.width < 600 && !currentBackdrop.startsWith('data:image')) {
      return {
        releaseId: release.id,
        albumTitle: title,
        isUnformatted: true,
        reason: 'low_resolution',
        diagnosticMessage: 'Backdrop resolution is under 600px width, causing visual pixelation in banner view.',
        currentBackdropUrl: currentBackdrop,
        frontCoverUrl: frontCover,
        suggestedAction: 'Fetch high-resolution artwork and rebuild panoramic backdrop.',
      }
    }

    return {
      releaseId: release.id,
      albumTitle: title,
      isUnformatted: false,
      reason: 'valid',
      diagnosticMessage: 'Backdrop is properly formatted as a high-fidelity panoramic derivative.',
      currentBackdropUrl: currentBackdrop,
      frontCoverUrl: frontCover,
      suggestedAction: 'none',
    }
  }

  /**
   * Scans a set of releases (or all releases) and returns all releases with unformatted backgrounds
   */
  public auditLibraryBackdrops(releases: Release[], _tracks?: Track[]): BackdropAnalysis[] {
    const unformatted: BackdropAnalysis[] = []

    for (const rel of releases) {
      const analysis = this.analyzeReleaseBackdrop(rel)
      if (analysis.isUnformatted) {
        unformatted.push(analysis)
      }
    }

    return unformatted
  }

  /**
   * Fast check if a specific release has an unformatted backdrop
   */
  public isBackdropUnformatted(release: Release | undefined | null): { isUnformatted: boolean; reason: string } {
    const analysis = this.analyzeReleaseBackdrop(release)
    return {
      isUnformatted: analysis.isUnformatted,
      reason: analysis.diagnosticMessage,
    }
  }

  /**
   * Formats and stages a pristine 2400×320 panoramic backdrop for a single release
   */
  public async formatBackdropForRelease(
    releaseId: string,
    preferredArtUrl?: string
  ): Promise<{ success: boolean; backdropUrl?: string; message: string }> {
    const rel = graphEngine.getReleaseById(releaseId)
    if (!rel) {
      return { success: false, message: `Release "${releaseId}" not found in catalog.` }
    }

    let artUrl = preferredArtUrl || rel.artwork?.frontCoverUrl || rel.coverArtUrl || ''

    // If artUrl is suspected to be a back cover/inlay scan, or missing, resolve authentic front art
    if (!artUrl || INLAY_SCAN_PATTERNS.test(artUrl)) {
      const curated = getCuratedAlbumArtwork(rel.title, rel.artistCredit || rel.composerName)
      if (curated) {
        artUrl = curated
      } else {
        try {
          const candidate = await federatedResolversService.fetchAlbumArtworkCandidate({
            albumTitle: rel.title,
            artistCredit: rel.artistCredit,
            composerName: rel.composerName,
            releaseYear: rel.releaseYear,
            provider: 'apple',
          })
          if (candidate?.coverArtUrl) {
            artUrl = candidate.coverArtUrl
          }
        } catch {
          // Keep artUrl as is
        }
      }
    }

    if (!artUrl) {
      return {
        success: false,
        message: `Could not find source artwork to format backdrop for "${rel.title}".`,
      }
    }

    try {
      const panoramicUrl = await generatePanoramicBackdrop(artUrl, 2400, 320)
      if (!panoramicUrl) {
        return { success: false, message: 'Panoramic backdrop generator returned empty output.' }
      }

      // Update release in graph engine
      graphEngine.updateReleaseDetails(rel.id, {
        backdropUrl: panoramicUrl,
        ...(artUrl && INLAY_SCAN_PATTERNS.test(rel.artwork?.frontCoverUrl || '') ? { coverArtUrl: artUrl } : {}),
      })

      // Stage in track sidecars
      const relTracks = graphEngine.getAllTracks().filter((t) => t.releaseId === rel.id)
      relTracks.forEach((trk) => {
        trk.sidecarStatus = 'uncommitted_sidecar'
        trk.pendingSidecarEdits = {
          ...(trk.pendingSidecarEdits || {}),
          backdropUrl: panoramicUrl,
        }
        graphEngine.addOrUpdateTrack(trk)
      })

      return {
        success: true,
        backdropUrl: panoramicUrl,
        message: `Generated 2400×320 panoramic backdrop for "${rel.title}".`,
      }
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to format backdrop: ${err.message || err}`,
      }
    }
  }

  /**
   * Batch formats all unformatted releases across the library
   */
  public async formatAllUnformattedBackdrops(
    targetReleaseIds?: string[]
  ): Promise<{ formattedCount: number; message: string }> {
    const allReleases = graphEngine.getAllReleases()
    const candidates = targetReleaseIds
      ? allReleases.filter((r) => targetReleaseIds.includes(r.id))
      : allReleases.filter((r) => this.analyzeReleaseBackdrop(r).isUnformatted)

    let formattedCount = 0
    for (const rel of candidates) {
      const res = await this.formatBackdropForRelease(rel.id)
      if (res.success) {
        formattedCount++
      }
    }

    return {
      formattedCount,
      message: `Successfully formatted panoramic backdrops across ${formattedCount} album(s).`,
    }
  }
}

export const backdropAnalyzer = new BackdropAnalyzerService()
