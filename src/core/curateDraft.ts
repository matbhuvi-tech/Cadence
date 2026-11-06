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
  userOverridden?: boolean
}

type FieldSelection = Pick<MetadataFieldState<string | number | undefined>,
  'selected' | 'userOverridden' | 'source' | 'confidence' | 'requiresHumanReview'>
type TrackSelection = Pick<CurateDraftTrack, CurateTrackField |
  'trackId' | 'source' | 'confidence' | 'requiresHumanReview' | 'selectedOverrides' | 'userOverridden' | 'provenanceSource'>

export interface CurateDraft {
  version: 1
  baseline: string
  localCoverArt?: string
  staged: boolean
  fields: Record<AlbumField, FieldSelection>
  tracks: TrackSelection[]
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
    localCoverArt: album.coverArt.local,
    fields: Object.fromEntries(albumFields.map(key => [key, selection(album[key])])) as CurateDraft['fields'],
    tracks: album.tracks.map(t => {
      const { trackId, matchedTitle, matchedArtists, originalAlbum, originalYear, provenanceSource,
        source, confidence, requiresHumanReview, selectedOverrides, userOverridden } = t
      return { trackId, matchedTitle, matchedArtists, originalAlbum, originalYear, provenanceSource,
        source, confidence, requiresHumanReview, selectedOverrides, userOverridden }
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
  return { ...album, ...fields, tracks, userOverridden: draft.staged }
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
