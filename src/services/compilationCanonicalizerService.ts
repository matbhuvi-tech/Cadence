/**
 * src/services/compilationCanonicalizerService.ts
 * Cadence Semantic AI Engine: Batch Auto-Canonicalization of Compilation Soundtracks.
 * Uses Gemini LLM to identify the original soundtrack/movie release group and original release year
 * for all tracks on compilation or multi-film albums in a single batch pass.
 *
 * Gated by AudioEngine idle telemetry to maintain bit-perfect audiophile bus quietness.
 */

import { Track, Release } from '../core/types'
import { tauriBridge } from './tauriBridge'
import { ambientCurationService } from './ambientCurationService'
import { graphEngine } from '../core/graphEngine'
import { stripRipNoiseAndTags } from '../core/taxonomyUtils'

export interface ProposedTrackCanonicalization {
  trackId: string
  trackNumber: number
  title: string
  currentOriginalAlbum?: string
  proposedOriginalAlbum: string
  currentOriginalYear?: number
  proposedOriginalYear?: number
  composer?: string
  primaryVocalists?: string
  isCompilationTrack: boolean
  confidence: number
  notes?: string
  matchedInLibrary: boolean
  matchedReleaseId?: string
  matchedReleaseTitle?: string
  selected: boolean
}

export interface CompilationResolutionResult {
  success: boolean
  albumTitle: string
  tracks: ProposedTrackCanonicalization[]
  deferredPlayback?: boolean
  error?: string
  telemetry?: {
    modelUsed?: string
    pacingDelayMs?: number
    retriesAttempted?: number
  }
}

class CompilationCanonicalizerService {
  /**
   * Resolves the canonical soundtrack / motion picture origin for all tracks on an album.
   * Enforces the Audiophile Transport Purity & Deterministic Execution Gate:
   * Rejects / defers network lookups if playback is active or in post-playback cooldown.
   */
  public async resolveCompilationSoundtracks(
    release: Release,
    tracks: Track[],
    allReleases: Release[] = []
  ): Promise<CompilationResolutionResult> {
    // 1. Audiophile Invariant Check: Never perform network lookups during active playback or cooldown
    const playbackStatus = await tauriBridge.getPlaybackStatus().catch(() => null)
    const isPlaying = Boolean(playbackStatus?.isPlaying)
    const isPaused = Boolean(playbackStatus?.isPaused)
    const isPlaybackStateLoading = playbackStatus?.playbackState === 'Loading'

    const ambientState = ambientCurationService.getState().state
    const isCoolingDown = ambientState === 'cooldown'

    if (isPlaying || isPaused || isPlaybackStateLoading || isCoolingDown) {
      return {
        success: false,
        albumTitle: release.title,
        tracks: [],
        deferredPlayback: true,
        error:
          'AudioEngine playback is active or in cooldown. Transport Purity Lock enforces quiet storage & network bus during playback.',
      }
    }

    if (!tracks || tracks.length === 0) {
      return {
        success: false,
        albumTitle: release.title,
        tracks: [],
        error: 'No tracks available on this release to resolve.',
      }
    }

    // 2. Build local release lookup index for matching original soundtracks
    const releaseTitleMap = new Map<string, Release>()
    for (const rel of allReleases) {
      if (rel.title) {
        const clean = stripRipNoiseAndTags(rel.title).toLowerCase().trim()
        releaseTitleMap.set(clean, rel)
      }
    }

    // 3. Call server middleware endpoint
    try {
      const payload = {
        albumTitle: release.title,
        artistCredit: release.artistCredit || release.composerName || '',
        releaseYear: release.releaseYear || release.originalYear,
        tracks: tracks.map((t) => ({
          id: t.id,
          trackNumber: t.trackNumber || 1,
          title: t.title,
          artist: t.artistCredit || '',
          composer: t.composerName || '',
          duration: t.durationSeconds || 0,
        })),
      }

      const res = await fetch('/api/ai-compilation-resolver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        return {
          success: false,
          albumTitle: release.title,
          tracks: [],
          error: errJson.error || `HTTP ${res.status} from AI Compilation Resolver`,
        }
      }

      const json = await res.json()
      const rawResults: any[] = Array.isArray(json.results) ? json.results : []

      // 4. Map results and cross-reference with local library
      const proposedList: ProposedTrackCanonicalization[] = tracks.map((track) => {
        const aiMatch = rawResults.find((r) => r.id === track.id) || rawResults.find((r) => r.trackNumber === track.trackNumber)

        const proposedAlbum = (aiMatch?.originalAlbum || track.originalAlbum || track.canonicalAlbumTitle || '').trim()
        const proposedYear = Number(aiMatch?.originalYear) || track.originalYear || track.canonicalReleaseYear

        // Check if proposed soundtrack exists in user's library
        let matchedInLibrary = false
        let matchedReleaseId: string | undefined
        let matchedReleaseTitle: string | undefined

        if (proposedAlbum) {
          const cleanProposed = stripRipNoiseAndTags(proposedAlbum).toLowerCase().trim()
          const matchedRel = releaseTitleMap.get(cleanProposed)
          if (matchedRel) {
            matchedInLibrary = true
            matchedReleaseId = matchedRel.id
            matchedReleaseTitle = matchedRel.title
          }
        }

        const isCompilationTrack =
          aiMatch?.isCompilationTrack !== undefined
            ? Boolean(aiMatch.isCompilationTrack)
            : Boolean(proposedAlbum && proposedAlbum.toLowerCase() !== release.title.toLowerCase())

        // Default selected if we have a proposed original album and reasonable confidence
        const confidence = typeof aiMatch?.confidence === 'number' ? aiMatch.confidence : 0.95
        const hasChange =
          proposedAlbum &&
          (proposedAlbum.toLowerCase() !== (track.originalAlbum || '').toLowerCase() ||
            proposedYear !== track.originalYear)

        return {
          trackId: track.id,
          trackNumber: track.trackNumber || 1,
          title: track.title,
          currentOriginalAlbum: track.originalAlbum || track.canonicalAlbumTitle,
          proposedOriginalAlbum: proposedAlbum,
          currentOriginalYear: track.originalYear || track.canonicalReleaseYear,
          proposedOriginalYear: proposedYear,
          composer: aiMatch?.canonicalComposer || track.composerName,
          primaryVocalists: aiMatch?.primaryVocalists || track.artistCredit,
          isCompilationTrack,
          confidence,
          notes: aiMatch?.notes,
          matchedInLibrary,
          matchedReleaseId,
          matchedReleaseTitle,
          selected: Boolean(hasChange && confidence >= 0.7),
        }
      })

      return {
        success: true,
        albumTitle: release.title,
        tracks: proposedList,
        telemetry: json.telemetry,
      }
    } catch (err: any) {
      console.error('[CompilationCanonicalizerService] Resolution failed:', err)
      return {
        success: false,
        albumTitle: release.title,
        tracks: [],
        error: err.message || 'Network error while contacting AI compilation resolver',
      }
    }
  }

  /**
   * Applies confirmed canonical soundtrack origins to SQLite and in-memory models.
   */
  public async applyBatchCanonicalization(
    items: ProposedTrackCanonicalization[],
    allTracks: Track[],
    allReleases: Release[] = []
  ): Promise<{ updatedCount: number }> {
    const selected = items.filter((it) => it.selected && it.proposedOriginalAlbum)
    if (selected.length === 0) return { updatedCount: 0 }

    const releaseTitleMap = new Map<string, Release>()
    for (const rel of allReleases) {
      if (rel.title) {
        releaseTitleMap.set(stripRipNoiseAndTags(rel.title).toLowerCase().trim(), rel)
      }
    }

    let updatedCount = 0

    for (const item of selected) {
      try {
        // 1. Permanent SQLite persistence
        await tauriBridge.dbUpdateTrackProvenance(
          item.trackId,
          undefined,
          item.proposedOriginalAlbum,
          item.proposedOriginalYear
        )

        // 2. In-memory Track object mutation for immediate zero-lag reactivity
        const targetTrack = allTracks.find((t) => t.id === item.trackId)
        if (targetTrack) {
          targetTrack.originalAlbum = item.proposedOriginalAlbum
          targetTrack.originalYear = item.proposedOriginalYear
          targetTrack.canonicalAlbumTitle = item.proposedOriginalAlbum
          targetTrack.canonicalReleaseYear = item.proposedOriginalYear

          const cleanProposed = stripRipNoiseAndTags(item.proposedOriginalAlbum).toLowerCase().trim()
          const matchedRel = releaseTitleMap.get(cleanProposed)
          if (matchedRel) {
            targetTrack.canonicalReleaseId = matchedRel.id
          }

          targetTrack.isCanonicalAlbumTrack = false
        }

        // 3. Staged sidecar mutation in graphEngine
        graphEngine.updateTrackSidecar(item.trackId, {
          originalAlbum: item.proposedOriginalAlbum,
          originalYear: item.proposedOriginalYear,
        })

        updatedCount++
      } catch (e) {
        console.error(`[CompilationCanonicalizerService] Failed updating track ${item.trackId}:`, e)
      }
    }

    // 4. Dispatch global event to notify components
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('cadence:provenance-updated', {
          detail: { updatedCount },
        })
      )
    }

    return { updatedCount }
  }
}

export const compilationCanonicalizerService = new CompilationCanonicalizerService()
