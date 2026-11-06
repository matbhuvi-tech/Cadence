import type { CurateMappingCandidate, CurationDecisionTrace, Release, ReleaseConsensusResult, Track } from '../core/types'

export const CURATE_REFRESH_PROVIDER_BUDGET = 12

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
    composer?: string
    year?: number
    genre?: string
    artworkUrl?: string
    tracks?: Array<{ number?: number; title?: string; artist?: string }>
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
  options?: { timeoutMs?: number | null; requireResponse?: boolean },
): Promise<T | null> {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const timeout = options?.timeoutMs === null ? undefined : AbortSignal.timeout(options?.timeoutMs ?? 4000)
  const requestSignal = timeout && signal ? AbortSignal.any([signal, timeout])
    : timeout ?? signal ?? new AbortController().signal
  let outcome: CurateProviderAttempt['outcome'] = 'network_error'
  let httpStatus: number | undefined
  let summary: CurateProviderAttempt['candidate']
  try {
    requestSignal.throwIfAborted()
    const response = await request(requestSignal)
    httpStatus = response.status
    if (!response.ok) {
      outcome = 'http_error'
      if (options?.requireResponse && response.status !== 404) {
        const details = await response.json().catch(() => null)
        throw new Error(typeof details?.message === 'string'
          ? details.message : `Apple evidence request failed (HTTP ${response.status}).`)
      }
      return null
    }
    outcome = 'parse_error'
    const candidate = parse(await response.json())
    outcome = candidate === null ? 'empty' : 'success'
    if (candidate !== null) summary = summarize?.(candidate)
    return candidate
  } catch (error) {
    if (signal?.aborted) outcome = 'cancelled'
    else if (timeout?.aborted) outcome = 'timeout'
    if (options?.requireResponse && !signal?.aborted) throw error
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
  identityMappings?: CurateMappingCandidate[]
  identity?: CurateIdentityTrack[]
  sourceCandidates?: CurateSourceCandidate[]
}

export interface CurateIdentityTrack {
  localTrackId: string
  editionId: string
  editionRev: number
  discId: string
  discRev: number
  trackOrderRev: number
  sourceGroupId: string | null
  sourceGroupRev: number | null
}

export interface CurateSourceCandidate {
  localTrackId: string
  title: string
  year?: number
}

export function sourceCandidatesFromGrouping(result: ReleaseConsensusResult): CurateSourceCandidate[] {
  return result.subReleaseGroupings?.flatMap(group => group.trackIds?.map(localTrackId => ({
    localTrackId, title: group.subTitle, year: group.originalYear,
  })) ?? []) ?? []
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
    providerDecisions: track.providerDecisions,
  }))
}
