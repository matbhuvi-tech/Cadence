import type { MetadataFieldState, TrackCandidateState } from './types'

const albumFields = ['albumTitle', 'albumArtist', 'composer', 'year', 'coverArt', 'genre'] as const
const trackFields = ['matchedTitle', 'matchedArtists', 'originalAlbum', 'originalYear'] as const

type AlbumField = typeof albumFields[number]
export type CurateTrackField = typeof trackFields[number]
export type CurateDraftTrack = TrackCandidateState & {
  selectedOverrides?: readonly CurateTrackField[]
}

type Proposal = {
  [K in AlbumField]: MetadataFieldState<K extends 'year' ? number | undefined : string>
} & {
  tracks: CurateDraftTrack[]
  heldTrackEdits?: TrackSelection[]
  userOverridden?: boolean
}

type FieldSelection = Pick<MetadataFieldState<string | number | undefined>,
  'selected' | 'userOverridden' | 'source' | 'confidence' | 'requiresHumanReview'>
type TrackSelection = Pick<CurateDraftTrack, CurateTrackField |
  'trackId' | 'source' | 'confidence' | 'requiresHumanReview' | 'selectedOverrides' | 'userOverridden' |
  'provenanceSource' | 'providerDecisions'>

export interface CurateDraft {
  version: 1
  revision?: string
  baseline: string
  localCoverArt?: string
  staged: boolean
  fields: Record<AlbumField, FieldSelection>
  tracks: TrackSelection[]
  heldTrackEdits?: TrackSelection[]
}

function selection(field: FieldSelection): FieldSelection {
  const { selected, userOverridden, source, confidence, requiresHumanReview } = field
  return { selected, userOverridden, source, confidence, requiresHumanReview }
}

export function captureCurateDraft(album: Proposal): CurateDraft {
  return {
    version: 1,
    baseline: JSON.stringify([
      albumFields.map(key => album[key].local),
      album.tracks.map(t => [t.trackId, t.localTitle, t.localArtists, t.trackNumber])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ]),
    staged: album.userOverridden === true,
    heldTrackEdits: album.heldTrackEdits,
    localCoverArt: album.coverArt.local,
    fields: Object.fromEntries(albumFields.map(key => [key, selection(album[key])])) as CurateDraft['fields'],
    tracks: album.tracks.map(t => {
      const { trackId, matchedTitle, matchedArtists, originalAlbum, originalYear, provenanceSource,
        source, confidence, requiresHumanReview, selectedOverrides, userOverridden, providerDecisions } = t
      return { trackId, matchedTitle, matchedArtists, originalAlbum, originalYear, provenanceSource,
        source, confidence, requiresHumanReview, selectedOverrides, userOverridden, providerDecisions }
    }),
  }
}

export function restoreCurateDraft<T extends Proposal>(album: T, draft: CurateDraft): T {
  const savedTracks = new Map(draft.tracks.map(t => [t.trackId, t]))
  const fields = Object.fromEntries(albumFields.map(key => [
    key, { ...album[key], ...selection(draft.fields[key]) },
  ]))
  const tracks = album.tracks.map(track => {
    const saved = savedTracks.get(track.trackId)
    if (!saved) return track
    const { matchedTitle, matchedArtists, originalAlbum, originalYear } = saved
    return { ...track, ...saved, matchedTitle, matchedArtists, originalAlbum, originalYear }
  })
  return { ...album, ...fields, tracks, heldTrackEdits: draft.heldTrackEdits, userOverridden: draft.staged }
}

export function captureCurateBaseline(album: Proposal): CurateDraft {
  return captureCurateDraft({
    ...album,
    ...Object.fromEntries(albumFields.map(key => [key, {
      ...album[key], selected: album[key].local, source: 'local_fallback', userOverridden: false,
    }])),
    tracks: album.tracks.map(track => ({
      ...track, matchedTitle: track.localTitle, matchedArtists: track.localArtists,
    })),
  })
}

// Saved evidence without field dependencies is historical. Only an explicit
// selection can be restored independently of that evidence.
export function migrateCurateDraft(draft: CurateDraft, baseline: CurateDraft): CurateDraft {
  const fields = { ...baseline.fields }
  for (const key of albumFields) {
    const prior = draft.fields[key]
    if (prior?.userOverridden) fields[key] = prior
    else if (prior && prior.selected !== fields[key].selected) {
      fields[key] = { ...fields[key], requiresHumanReview: true }
    }
  }
  const savedTracks = new Map([...(draft.heldTrackEdits ?? []), ...draft.tracks].map(track => [track.trackId, track]))
  const tracks = baseline.tracks.map(track => {
    const saved = savedTracks.get(track.trackId)
    if (!saved) return track
    savedTracks.delete(track.trackId)
    const overrides = saved.selectedOverrides ?? (saved.provenanceSource === 'user_override'
      ? ['originalAlbum', 'originalYear'] as const : [])
    const pendingReview = trackFields.some(key => !overrides.includes(key) && saved[key] !== track[key])
    return {
      ...track,
      ...Object.fromEntries(overrides.map(key => [key, saved[key]])),
      selectedOverrides: overrides.length ? overrides : undefined,
      provenanceSource: overrides.includes('originalAlbum') ? saved.provenanceSource : track.provenanceSource,
      providerDecisions: saved.providerDecisions?.map(decision => decision.status === 'needs_review' ? decision : {
        ...decision, status: 'needs_review' as const, reason: 'Saved proposal lacks verified dependencies.',
      }),
      requiresHumanReview: pendingReview || track.requiresHumanReview,
    }
  })
  const heldTrackEdits = Array.from(savedTracks.values()).filter(track =>
    track.selectedOverrides?.length || track.provenanceSource === 'user_override')
  return { ...draft, fields, tracks, heldTrackEdits: heldTrackEdits.length ? heldTrackEdits : undefined }
}

export function mergeCurateProposal<T extends Proposal>(current: T, fresh: T): T {
  const currentTracks = new Map(current.tracks.map(t => [t.trackId, t]))
  const fields = Object.fromEntries(albumFields.map(key => {
    const local = current[key].local
    return [
      key,
      { ...fresh[key], ...(current[key].userOverridden ? selection(current[key]) : {}), local },
    ]
  }))
  const tracks = fresh.tracks.map(track => {
    const previous = currentTracks.get(track.trackId)
    if (!previous?.selectedOverrides?.length) return track
    const overrides = Object.fromEntries(previous.selectedOverrides.map(key => [key, previous[key]]))
    return {
      ...track,
      ...overrides,
      selectedOverrides: previous.selectedOverrides,
      userOverridden: previous.userOverridden,
      source: previous.source,
      provenanceSource: previous.selectedOverrides.includes('originalAlbum') ? previous.provenanceSource : track.provenanceSource,
    }
  })
  return { ...fresh, ...fields, tracks }
}

export function selectCurateTrackFields(track: CurateDraftTrack, ...fields: CurateTrackField[]): CurateDraftTrack {
  return { ...track, selectedOverrides: [...new Set([...track.selectedOverrides ?? [], ...fields])] }
}

/**
 * Applies a provider or local track cell selection, updating both track title and artists when present
 * and recording the updated fields in `selectedOverrides` so they survive refreshes and draft restores.
 */
export function applyCurateTrackSelection(
  track: CurateDraftTrack,
  selection: { title?: string; artists?: string; source?: TrackCandidateState['source'] },
): CurateDraftTrack {
  const fields: CurateTrackField[] = []
  const next: CurateDraftTrack = {
    ...track,
    source: selection.source ?? 'single_provider_match',
    requiresHumanReview: false,
  }
  if (selection.title) {
    next.matchedTitle = selection.title
    fields.push('matchedTitle')
  }
  if (selection.artists !== undefined) {
    next.matchedArtists = selection.artists
    fields.push('matchedArtists')
  }
  return fields.length ? selectCurateTrackFields(next, ...fields) : next
}
