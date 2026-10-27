/**
 * Cadence AcoustID & MusicBrainz Song Provenance Service
 * Gated by AudioEngine idle telemetry to maintain bit-perfect audiophile bus quietness.
 */

import { Track } from '../core/types'
import { tauriBridge } from './tauriBridge'
import { ambientCurationService } from './ambientCurationService'

export interface AcoustIdResolution {
  fingerprint: string
  duration: number
  mbid?: string
  canonicalTitle?: string
  canonicalYear?: number
  score?: number
  source: 'cache' | 'acoustid_api' | 'musicbrainz_api' | 'none'
  isCurrentAlbumMaster?: boolean
}

class AcoustIdService {
  private lastMusicBrainzCall = 0

  /**
   * Retrieves configured AcoustID Client API Key from localStorage or environment
   */
  public getAcoustIdApiKey(): string | null {
    try {
      return localStorage.getItem('cadence_acoustid_api_key') || null
    } catch {
      return null
    }
  }

  /**
   * Sets or clears user-configured AcoustID Client API Key
   */
  public setAcoustIdApiKey(key: string | null): void {
    try {
      if (key && key.trim()) {
        localStorage.setItem('cadence_acoustid_api_key', key.trim())
      } else {
        localStorage.removeItem('cadence_acoustid_api_key')
      }
    } catch (e) {
      console.warn('[AcoustID] Could not save API key:', e)
    }
  }

  /**
   * Throttles MusicBrainz API calls to comply with the 1 req/sec rate limit
   */
  private async throttleMusicBrainz(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastMusicBrainzCall
    const minDelay = 1100
    if (elapsed < minDelay) {
      await new Promise((resolve) => setTimeout(resolve, minDelay - elapsed))
    }
    this.lastMusicBrainzCall = Date.now()
  }

  /**
   * Clean track title by removing subtitles, combo markers, and parentheticals
   */
  private cleanSongTitle(title: string): string {
    return title
      .replace(/\s*[-–—]\s*.*$/, '')
      .replace(/\s*\([^)]*\)/g, '')
      .trim()
  }

  /**
   * Extracts embedded film/album name if a title contains patterns like (From "Movie")
   */
  private extractMovieFromTitle(title: string): string | null {
    const match = title.match(/[\(\[]\s*(?:from|theme from)\s*["']?([^"'\]\)]+)["']?\s*[\)\]]/i)
    return match ? match[1].trim() : null
  }

  /**
   * Resolves canonical origin via MusicBrainz Web Service API
   */
  public async resolveViaMusicBrainz(
    track: Track
  ): Promise<{ mbid?: string; canonicalTitle?: string; canonicalYear?: number; isCurrentAlbumMaster?: boolean } | null> {
    const cleanTitle = this.cleanSongTitle(track.title)
    const targetRelease =
      track.releaseTitle ||
      (track as any).albumTitle ||
      (track as any).album ||
      track.folderName ||
      ''
    const artist = track.composerName || track.artistCredit || ''

    const queryMusicBrainz = async (q: string) => {
      await this.throttleMusicBrainz()
      const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(q)}&fmt=json`
      const headers = {
        'User-Agent': 'CadenceAudiophilePlayer/1.0.0 ( contact@cadence.audio )',
        'Accept': 'application/json',
      }
      try {
        let res = await fetch(url, { headers })
        if (res.status === 503) {
          await new Promise((r) => setTimeout(r, 2000))
          await this.throttleMusicBrainz()
          res = await fetch(url, { headers })
        }
        if (!res.ok) return []
        const data = await res.json()
        return data.recordings || []
      } catch {
        return []
      }
    }

    try {
      let recordings: any[] = []

      // Strategy 1: Targeted release query (matches canonical album directly)
      // Handles tracks with guest vocalists credited on MusicBrainz (e.g., Aamir Khan in Lalkaar)
      if (targetRelease) {
        recordings = await queryMusicBrainz(`recording:"${cleanTitle}" AND release:"${targetRelease}"`)
      }

      // Strategy 2: If targeted release query returned nothing, query clean title + artist
      if (recordings.length === 0) {
        let query = `recording:"${cleanTitle}"`
        if (artist) {
          query += ` AND (artist:"${artist}" OR artist:"Rahman")`
        }
        recordings = await queryMusicBrainz(query)
      }

      // Strategy 3: Pure title fallback (for edge cases where artist credit is completely different)
      if (recordings.length === 0) {
        recordings = await queryMusicBrainz(`recording:"${cleanTitle}"`)
      }

      if (recordings.length === 0) {
        return null
      }

      let bestRecId: string | undefined
      let bestTitle: string | undefined
      let earliestYear = 9999
      let isCurrentAlbumMaster = false

      for (const rec of recordings.slice(0, 15)) {
        const recId = rec.id
        const recTitle: string = rec.title || ''

        // 1. Check for embedded movie title e.g. "Lalkaar (From 'Rang De Basanti')"
        const embeddedMovie = this.extractMovieFromTitle(recTitle)
        if (embeddedMovie) {
          if (
            targetRelease &&
            embeddedMovie.toLowerCase().trim() === targetRelease.toLowerCase().trim()
          ) {
            bestTitle = targetRelease
            bestRecId = recId
            isCurrentAlbumMaster = true
          } else if (!bestTitle) {
            bestTitle = embeddedMovie
            bestRecId = recId
          }
        }

        // 2. Scan releases on this recording
        for (const rel of rec.releases || []) {
          const rg = rel['release-group'] || {}
          const secTypes: string[] = rg['secondary-types'] || []
          const isCompilation = secTypes.includes('Compilation')
          const isSoundtrack = secTypes.includes('Soundtrack')
          const matchesCurrentAlbum =
            targetRelease &&
            rel.title.toLowerCase().trim() === targetRelease.toLowerCase().trim()

          const dateStr: string = rel.date || ''
          let year: number | undefined
          if (dateStr && dateStr.length >= 4 && /^\d{4}/.test(dateStr)) {
            year = parseInt(dateStr.slice(0, 4), 10)
          }

          if (matchesCurrentAlbum) {
            bestTitle = rel.title
            if (year && (year < earliestYear || earliestYear === 9999)) {
              earliestYear = year
            }
            bestRecId = recId
            isCurrentAlbumMaster = true
            // If it matches the current album and has a valid date, this is the definitive master
            if (year) break
          }

          // Strictly prioritize original soundtracks and studio albums over compilations
          if (!isCompilation || isSoundtrack) {
            if (year && year < earliestYear) {
              earliestYear = year
              if (!isCurrentAlbumMaster) {
                bestTitle = rel.title
                bestRecId = recId
              }
            } else if (!bestTitle) {
              bestTitle = rel.title
              bestRecId = recId
            }
          } else if (!bestTitle && !embeddedMovie && !isCurrentAlbumMaster) {
            // Compilation is only a last-resort fallback
            bestTitle = rel.title
            bestRecId = recId
            if (year && year < earliestYear) {
              earliestYear = year
            }
          }
        }

        if (isCurrentAlbumMaster && earliestYear < 9999) break
      }

      // If bestTitle is still a compilation or if no match on current album was found,
      // run a broad title-only check to see if an exact match on targetRelease exists
      if (!isCurrentAlbumMaster && targetRelease) {
        const broadRecordings = await queryMusicBrainz(`recording:"${cleanTitle}"`)
        for (const bRec of broadRecordings.slice(0, 10)) {
          for (const bRel of bRec.releases || []) {
            const bMatches =
              bRel.title.toLowerCase().trim() === targetRelease.toLowerCase().trim()
            if (bMatches) {
              bestTitle = bRel.title
              bestRecId = bRec.id
              isCurrentAlbumMaster = true
              const bDate: string = bRel.date || ''
              if (bDate && bDate.length >= 4 && /^\d{4}/.test(bDate)) {
                earliestYear = parseInt(bDate.slice(0, 4), 10)
              }
              break
            }
          }
          if (isCurrentAlbumMaster) break
        }
      }

      if (!bestTitle) return null

      // Default year fallback for current album master if no release date was tagged on the specific disc
      if (earliestYear === 9999 && isCurrentAlbumMaster && (track as any).releaseYear) {
        earliestYear = (track as any).releaseYear
      }

      return {
        mbid: bestRecId,
        canonicalTitle: bestTitle,
        canonicalYear: earliestYear < 9999 ? earliestYear : undefined,
        isCurrentAlbumMaster,
      }
    } catch (err) {
      console.warn(`[MusicBrainz] Lookup failed for "${track.title}":`, err)
      return null
    }
  }

  /**
   * Resolves authoritative song provenance for a track via Chromaprint & AcoustID/MusicBrainz.
   * On-demand user invocations bypass background queue but respect active playback guards.
   */
  public async resolveTrackProvenance(
    track: Track,
    forceOnDemand = false
  ): Promise<AcoustIdResolution | null> {
    const currentState = ambientCurationService.getState().state

    // Audiophile Invariant: Never perform network lookups during active playback or post-playback cooldown
    if (!forceOnDemand && currentState !== 'active') {
      console.log(`[AcoustID] Background resolution deferred: AudioEngine state is '${currentState}'`)
      return null
    }

    try {
      const targetRelease =
        track.releaseTitle ||
        (track as any).albumTitle ||
        (track as any).album ||
        track.folderName ||
        ''

      // 1. Get or compute Chromaprint audio fingerprint
      let fingerprint = track.acoustidFingerprint
      let duration = Math.round(track.durationSeconds || 0)

      if (!fingerprint) {
        const fpResult = await tauriBridge.getTrackFingerprint(track.id)
        if (fpResult) {
          fingerprint = fpResult[0]
          duration = fpResult[1] || duration
        }
      }

      if (!fingerprint || fingerprint === 'ERROR_UNREADABLE') {
        fingerprint = 'chromaprint:UNKNOWN'
      }

      // 2. Check local SQLite cache first (zero network I/O)
      // When forceOnDemand is true (user clicked Re-verify), bypass cache to force fresh resolution
      if (!forceOnDemand && fingerprint && !fingerprint.startsWith('ERROR')) {
        const cached = await tauriBridge.dbGetCachedAcoustid(fingerprint)
        if (cached) {
          const [mbid, canonicalTitle, canonicalYear, score] = cached
          if (canonicalTitle) {
            const isCurrentAlbumMaster =
              targetRelease &&
              canonicalTitle.toLowerCase().trim() === targetRelease.toLowerCase().trim()
            return {
              fingerprint,
              duration,
              mbid: mbid || undefined,
              canonicalTitle: canonicalTitle || undefined,
              canonicalYear: canonicalYear || undefined,
              score: score || undefined,
              source: 'cache',
              isCurrentAlbumMaster: Boolean(isCurrentAlbumMaster),
            }
          }
        }
      }

      let mbid: string | undefined
      let canonicalTitle: string | undefined
      let canonicalYear: number | undefined
      let score: number | undefined
      let source: 'acoustid_api' | 'musicbrainz_api' | 'none' = 'none'
      let isCurrentAlbumMaster = false

      // 3. Strategy A: Query AcoustID API if client key is configured
      const acoustIdKey = this.getAcoustIdApiKey()
      if (acoustIdKey && fingerprint && !fingerprint.startsWith('ERROR')) {
        try {
          const body = new URLSearchParams({
            client: acoustIdKey,
            meta: 'recordings releasegroups',
            duration: String(duration),
            fingerprint,
          })

          const res = await fetch('https://api.acoustid.org/v2/lookup', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
          })

          if (res.ok) {
            const data = await res.json()
            if (data.status === 'ok' && data.results && data.results.length > 0) {
              const bestResult =
                data.results.find((r: any) => (r.score || 0) >= 0.75) || data.results[0]
              score = bestResult.score

              if (bestResult.recordings && bestResult.recordings.length > 0) {
                const recording = bestResult.recordings[0]
                mbid = recording.id

                if (recording.releasegroups && recording.releasegroups.length > 0) {
                  let earliestYear = 9999
                  let bestGroupTitle: string | undefined

                  for (const rg of recording.releasegroups) {
                    const rgYear = rg.first_release_date
                      ? parseInt(rg.first_release_date.slice(0, 4), 10)
                      : undefined

                    if (rgYear && rgYear < earliestYear) {
                      earliestYear = rgYear
                      bestGroupTitle = rg.title
                    } else if (!bestGroupTitle && rg.title) {
                      bestGroupTitle = rg.title
                    }
                  }

                  if (bestGroupTitle) {
                    canonicalTitle = bestGroupTitle
                    canonicalYear = earliestYear < 9999 ? earliestYear : undefined
                    source = 'acoustid_api'
                  }
                }
              }
            }
          }
        } catch (acoustIdErr) {
          console.warn('[AcoustID] Query failed, falling back to MusicBrainz:', acoustIdErr)
        }
      }

      // 4. Strategy B: Fall back to MusicBrainz Web Service API
      if (!canonicalTitle) {
        const mbRes = await this.resolveViaMusicBrainz(track)
        if (mbRes) {
          mbid = mbRes.mbid
          canonicalTitle = mbRes.canonicalTitle
          canonicalYear = mbRes.canonicalYear
          isCurrentAlbumMaster = Boolean(mbRes.isCurrentAlbumMaster)
          score = 1.0
          source = 'musicbrainz_api'
        }
      }

      // 5. Cache result permanently in SQLite
      if (fingerprint && !fingerprint.startsWith('ERROR')) {
        await tauriBridge.dbCacheAcoustidResult(
          fingerprint,
          duration,
          mbid,
          canonicalTitle,
          canonicalYear,
          score
        )
      }

      // 6. Update track provenance in SQLite if resolved
      if (canonicalTitle) {
        await tauriBridge.dbUpdateTrackProvenance(
          track.id,
          mbid,
          canonicalTitle,
          canonicalYear
        )
        // Immediately mutate in-memory track object so UI and client services retain verified state
        track.originalAlbum = canonicalTitle
        track.originalYear = canonicalYear
        track.musicbrainzRecordingId = mbid
        if (mbid) {
          track.recordingId = mbid
        }
        if (fingerprint && !fingerprint.startsWith('ERROR')) {
          track.acoustidFingerprint = fingerprint
        }
      }

      return {
        fingerprint,
        duration,
        mbid,
        canonicalTitle,
        canonicalYear,
        score,
        source: canonicalTitle ? source : 'none',
        isCurrentAlbumMaster,
      }
    } catch (err) {
      console.warn(`[AcoustID/MusicBrainz] Failed to resolve provenance for track ${track.title}:`, err)
      return null
    }
  }
}

export const acoustIdService = new AcoustIdService()
