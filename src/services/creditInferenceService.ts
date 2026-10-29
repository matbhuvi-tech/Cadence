/**
 * src/services/creditInferenceService.ts
 * Soundtrack & Classical Credit Authority Inference Engine
 *
 * Implements deterministic 3-signal scoring rubric (+40 genre, +30 title/keywords,
 * +30 track composer uniformity) to resolve whether Composer or Performer represents
 * the primary Album Artist.
 */

import { Release, Track } from '../core/types'
import { KNOWN_COMPOSERS } from '../core/taxonomyUtils'

export interface AuthorityInferenceResult {
  authority: 'composer' | 'performer'
  confidence: number // 0.0 - 1.0
  composerName?: string
  performerName?: string
  score: number // 0 - 100
  rationale: string
  isOverride: boolean
}

// Film / Soundtrack genres heavily indicative of composer-driven albums
const SOUNDTRACK_GENRES = new Set([
  'soundtrack',
  'ost',
  'original soundtrack',
  'film score',
  'score',
  'cinema',
  'movie',
  'film',
  'tamil',
  'telugu',
  'hindi',
  'malayalam',
  'kannada',
  'bollywood',
  'kollywood',
  'tollywood',
  'indian pop',
])

// Classical / Ghazal / Devotional genres indicative of performer-driven albums
const PERFORMER_GENRES = new Set([
  'carnatic',
  'hindustani',
  'classical',
  'indian classical',
  'ghazal',
  'devotional',
  'bhajan',
  'kirtan',
  'sufi',
  'folk',
  'jazz',
  'rock',
  'pop',
  'electronic',
  'metal',
  'blues',
])

const SOUNDTRACK_TITLE_REGEX = /\b(?:soundtrack|ost|original\s+motion\s+picture|film\s+score|bgm|theme\s+music|from\s+['"][^'"]+['"])\b/i

export class CreditInferenceService {
  /**
   * Infers whether the album authority should be Composer or Performer.
   */
  inferReleaseAuthority(
    release: Release | null | undefined,
    tracks: Track[]
  ): AuthorityInferenceResult {
    // 0. Explicit User Override Gate
    if (release?.metadataAuthorityOverride) {
      const auth = release.metadataAuthorityOverride
      return {
        authority: auth,
        confidence: 1.0,
        composerName: release.composerName || tracks[0]?.composerName,
        performerName: release.artistCredit || tracks[0]?.artistCredit,
        score: auth === 'composer' ? 100 : 0,
        rationale: `Manual user override explicitly locked to ${auth}.`,
        isOverride: true,
      }
    }

    let composerScore = 50 // baseline
    const rationales: string[] = []

    // 1. Signal 1: Genre Analysis (+40 / -40)
    const genreCandidates: string[] = []
    if (release?.genre) genreCandidates.push(release.genre)
    if (release?.genreTags) genreCandidates.push(...release.genreTags)
    tracks.forEach((t) => {
      if ((t as any).genre) genreCandidates.push((t as any).genre)
      if ((t as any).genreTags) genreCandidates.push(...(t as any).genreTags)
    })

    const normalizedGenres = genreCandidates.map((g) => g.trim().toLowerCase())
    const isSoundtrackGenre = normalizedGenres.some((g) =>
      Array.from(SOUNDTRACK_GENRES).some((sg) => g.includes(sg))
    )
    const isPerformerGenre = normalizedGenres.some((g) =>
      Array.from(PERFORMER_GENRES).some((pg) => g.includes(pg))
    )

    if (isSoundtrackGenre && !isPerformerGenre) {
      composerScore += 40
      rationales.push('Soundtrack / Film genre detected (+40)')
    } else if (isPerformerGenre && !isSoundtrackGenre) {
      composerScore -= 40
      rationales.push('Classical / Ghazal / Solo Artist genre detected (-40)')
    }

    // 2. Signal 2: Title and Folder Metadata Keywords (+30)
    const titleCandidates = [
      release?.title || '',
      release?.folderName || '',
      ...tracks.map((t) => t.albumTitle || ''),
    ]
    const hasSoundtrackKeyword = titleCandidates.some((t) => SOUNDTRACK_TITLE_REGEX.test(t))
    if (hasSoundtrackKeyword) {
      composerScore += 30
      rationales.push('Soundtrack / OST keyword in title or folder (+30)')
    }

    // 3. Signal 3: Track Composer Uniformity & Known Composer Catalog (+30)
    const validComposers = tracks
      .map((t) => t.composerName?.trim())
      .filter((c): c is string => Boolean(c && c.length > 0))

    let dominantComposer: string | undefined
    if (validComposers.length > 0) {
      const counts = new Map<string, number>()
      validComposers.forEach((c) => {
        const norm = c.toLowerCase()
        counts.set(norm, (counts.get(norm) || 0) + 1)
      })

      let maxCount = 0
      let maxNorm = ''
      counts.forEach((cnt, norm) => {
        if (cnt > maxCount) {
          maxCount = cnt
          maxNorm = norm
        }
      })

      const uniformityRatio = tracks.length > 0 ? maxCount / tracks.length : 0
      dominantComposer = validComposers.find((c) => c.toLowerCase() === maxNorm)

      // Check if matches known film composers (Ilaiyaraaja, Rahman, etc.)
      const isFamousComposer = KNOWN_COMPOSERS.some(
        (kc) => kc.key === maxNorm || kc.aliases.includes(maxNorm)
      )

      if (uniformityRatio >= 0.7 || isFamousComposer) {
        composerScore += 30
        rationales.push(
          `Uniform composer "${dominantComposer}" across ${(uniformityRatio * 100).toFixed(0)}% of tracks (+30)`
        )
      }
    } else if (release?.composerName) {
      dominantComposer = release.composerName
      const norm = release.composerName.toLowerCase()
      const isFamousComposer = KNOWN_COMPOSERS.some(
        (kc) => kc.key === norm || kc.aliases.includes(norm)
      )
      if (isFamousComposer) {
        composerScore += 30
        rationales.push(`Recognized master composer "${release.composerName}" (+30)`)
      }
    }

    // Compilation flag check: Multi-track vocalists with a single composer strongly implies soundtrack
    const distinctVocalists = new Set(
      tracks.map((t) => t.artistCredit?.trim()).filter(Boolean)
    )
    if (distinctVocalists.size >= 3 && dominantComposer) {
      composerScore += 15
      rationales.push(`Multiple track vocalists (${distinctVocalists.size}) under single composer (+15)`)
    }

    // Clamp score
    const finalScore = Math.max(0, Math.min(100, composerScore))
    const isComposerAuthority = finalScore >= 60

    return {
      authority: isComposerAuthority ? 'composer' : 'performer',
      confidence: isComposerAuthority ? finalScore / 100 : (100 - finalScore) / 100,
      composerName: dominantComposer || release?.composerName,
      performerName: release?.artistCredit || tracks[0]?.artistCredit,
      score: finalScore,
      rationale: rationales.join(' • ') || 'Default heuristics applied.',
      isOverride: false,
    }
  }

  /**
   * Resolves the display artist name for catalog grids, detail headers, and player bars.
   */
  resolveDisplayArtist(
    release: Release | null | undefined,
    tracks: Track[] = []
  ): string {
    if (!release) return 'Unknown Artist'
    const inference = this.inferReleaseAuthority(release, tracks)
    if (inference.authority === 'composer' && inference.composerName) {
      return inference.composerName
    }
    return release.artistCredit || inference.performerName || 'Various Artists'
  }

  /**
   * Resolves both primary and secondary display credits with authority distinction.
   */
  resolveDetailedDisplayArtist(
    release: Release | null | undefined,
    tracks: Track[] = []
  ): { primary: string; secondary?: string; authority: 'composer' | 'performer' } {
    if (!release) return { primary: 'Unknown Artist', authority: 'performer' }
    const inference = this.inferReleaseAuthority(release, tracks)
    if (inference.authority === 'composer' && inference.composerName) {
      return {
        primary: inference.composerName,
        secondary: release.artistCredit || inference.performerName,
        authority: 'composer',
      }
    }
    return {
      primary: release.artistCredit || inference.performerName || 'Various Artists',
      secondary: inference.composerName || release.composerName,
      authority: 'performer',
    }
  }
}

export const creditInferenceService = new CreditInferenceService()
