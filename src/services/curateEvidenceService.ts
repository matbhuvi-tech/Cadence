import type { CurationDecisionTrace, Release, ReleaseConsensusResult, Track } from '../core/types'

export interface CurateProviderAttempt {
  provider: 'apple' | 'musicbrainz'
  query: string
  startedAt: string
  completedAt: string
  durationMs: number
  httpStatus?: number
  outcome: 'success' | 'empty' | 'http_error' | 'parse_error' | 'timeout' | 'cancelled' | 'network_error'
  candidate?: {
    releaseId?: string
    title?: string
    artist?: string
    year?: number
    trackCount?: number
  }
}

export type RecordCurateAttempt = (attempt: CurateProviderAttempt) => void

export async function fetchCurateCandidate<T>(
  provider: CurateProviderAttempt['provider'],
  query: string,
  request: (signal: AbortSignal) => Promise<Response>,
  parse: (body: any) => T | null,
  record?: RecordCurateAttempt,
  signal?: AbortSignal,
  summarize?: (candidate: T) => CurateProviderAttempt['candidate'],
): Promise<T | null> {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const timeout = AbortSignal.timeout(4000)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let outcome: CurateProviderAttempt['outcome'] = 'network_error'
  let httpStatus: number | undefined
  let summary: CurateProviderAttempt['candidate']
  try {
    requestSignal.throwIfAborted()
    const response = await request(requestSignal)
    httpStatus = response.status
    if (!response.ok) {
      outcome = 'http_error'
      return null
    }
    outcome = 'parse_error'
    const candidate = parse(await response.json())
    outcome = candidate === null ? 'empty' : 'success'
    if (candidate !== null) summary = summarize?.(candidate)
    return candidate
  } catch {
    if (signal?.aborted) outcome = 'cancelled'
    else if (timeout.aborted) outcome = 'timeout'
    return null
  } finally {
    record?.({
      provider, query, startedAt, httpStatus, outcome, candidate: summary,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
    })
  }
}

export function curateMatchingContext(release: Release, tracks: Track[]) {
  return {
    title: release.title,
    artist: release.artistCredit,
    composer: release.composerName,
    year: release.releaseYear,
    tracks: tracks.map(track => ({
      id: track.id, number: track.trackNumber, title: track.title,
      artist: track.artistCredit, duration: track.duration ?? track.durationSeconds,
    })),
  }
}

export interface CurateEvidenceSummary {
  id: string
  trigger: 'initial' | 'user_refresh'
  requestedAt: string
  completedAt: string
  outcome: 'completed' | 'cancelled' | 'failed'
  current: boolean
}

export interface CurateEvidenceRun extends Omit<CurateEvidenceSummary, 'current'> {
  context: ReturnType<typeof curateMatchingContext>
  attempts: CurateProviderAttempt[]
  decision?: CurationDecisionTrace
  trackDecisions?: ReturnType<typeof captureTrackDecisions>
}

export function captureTrackDecisions(result: ReleaseConsensusResult) {
  return result.trackStates?.map(track => ({
    trackId: track.trackId,
    trackNumber: track.trackNumber,
    localTitle: track.localTitle,
    localArtists: track.localArtists,
    selectedTitle: track.matchedTitle,
    selectedArtists: track.matchedArtists,
    titleAction: track.matchedTitle && track.matchedTitle !== track.localTitle ? 'Applied' : 'Retained',
    artistsAction: track.matchedArtists && track.matchedArtists !== track.localArtists ? 'Applied' : 'Retained',
    source: track.source,
    confidence: track.confidence,
    requiresHumanReview: track.requiresHumanReview,
    matchedProviderTrack: track.providerTrackNumber,
    sequenceOffset: track.sequenceOffset,
  }))
}
