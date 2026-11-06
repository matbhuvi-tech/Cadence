import type { CurateDraft } from './curateDraft'
import type { Release, Track } from './types'
import type { NewCommitItemPayload } from '../types/commit'

export interface CurateValueChange {
  previous: string | number | undefined
}

function presentTag(value: string | number | null | undefined): value is string | number {
  return typeof value === 'number' ? Number.isFinite(value) && value > 0 : Boolean(value?.trim())
}

export function getCurateChange(
  local: string | number | null | undefined,
  selected: string | number | null | undefined,
): CurateValueChange | null {
  if (!presentTag(selected) || local === selected) return null
  return { previous: presentTag(local) ? local : undefined }
}

export interface CurateCommitRow {
  id: string
  trackId: string
  status: 'pending' | 'in_flight' | 'failed' | 'completed'
  payloadJson: string
  applies?: boolean
  artworkUrl?: string | null
  errorMessage?: string | null
}

export type CurateReviewState = ReadonlyMap<string, true | string[]>

// The album ID covers ordinary catalog updates. The file set also survives a
// rescan that recreates release and track IDs after a tag change.
export function curateReviewKeys(releaseId: string, tracks: Pick<Track, 'filePath'>[]): string[] {
  const paths = tracks.map(track => track.filePath?.replace(/\\/g, '/').toLowerCase())
  return paths.length && paths.every(Boolean)
    ? [releaseId, JSON.stringify(paths.sort())]
    : [releaseId]
}

export function reconcileCurateReviewState(
  state: CurateReviewState, tracks: Track[], rows: CurateCommitRow[],
): CurateReviewState {
  const byRelease = new Map<string, Track[]>()
  for (const track of tracks) {
    const album = byRelease.get(track.releaseId)
    if (album) album.push(track)
    else byRelease.set(track.releaseId, [track])
  }
  const byTrack = new Map(rows.map(row => [row.trackId, row]))
  const next = new Map(state)
  for (const [releaseId, album] of byRelease) {
    const keys = curateReviewKeys(releaseId, album)
    const previous = keys.map(key => state.get(key)).find(value => value !== undefined)
    const albumRows = album.map(track => byTrack.get(track.id))
    let reviewId: string | undefined
    const completed = previous === true || albumRows.every((row, index) => {
      if (row?.status !== 'completed' || (previous && previous.includes(row.id))) return false
      const payload = JSON.parse(row.payloadJson)
      if (index === 0) reviewId = payload.curateReviewId
      return payload.curate === true && payload.curateTrackCount === album.length &&
        payload.curateReviewId === reviewId
    })
    if (completed) for (const key of keys) next.set(key, true)
  }
  return next.size === state.size && Array.from(next).every(([key, value]) => state.get(key) === value)
    ? state : next
}

interface Tags {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  composer?: string
  year?: number
  originalAlbum?: string
  originalYear?: number
  genre?: string
  coverArtUrl?: string
}

export function makeCurateCommitItems(
  draft: CurateDraft, tracks: Track[], release?: Release,
): NewCommitItemPayload[] {
  const byId = new Map(tracks.map(track => [track.id, track]))
  const cover = draft.fields.coverArt.selected
  if (draft.fields.coverArt.userOverridden && typeof cover === 'string' && cover &&
      cover !== draft.localCoverArt && !coverSource(draft)) {
    throw new Error('Choose a JPEG or PNG cover from an HTTP(S) URL or image data URL.')
  }
  const curateReviewId = crypto.randomUUID()
  return draft.tracks.map(selection => {
    const track = byId.get(selection.trackId)
    if (!track?.filePath || !track.storageMountId) throw new Error('A selected track has no file path or storage mount.')
    return {
      id: crypto.randomUUID(),
      trackId: track.id,
      filePath: track.filePath,
      mountId: track.storageMountId,
      payloadJson: JSON.stringify({
        ...selectedTags(draft, selection), curate: true, curateTrackCount: draft.tracks.length, curateReviewId, destination: 'embedded',
      }),
      backupJson: JSON.stringify({
        title: track.title,
        artist: track.artistCredit,
        album: release?.title,
        albumArtist: track.albumArtist || release?.artistCredit,
        composer: track.composerName,
        year: release?.releaseYear,
        originalAlbum: track.originalAlbum,
        originalYear: track.originalYear,
        genre: release?.genreTags?.[0],
        curate: true,
        destination: 'embedded',
      }),
    }
  })
}

function coverSource(draft: CurateDraft): string | undefined {
  const artwork = draft.fields.coverArt.selected
  if (typeof artwork !== 'string' || !artwork || artwork === draft.localCoverArt) return
  if (/^https?:\/\//i.test(artwork) || /^data:image\/(jpeg|png);base64,/.test(artwork)) return artwork
}

function selectedTags(draft: CurateDraft, selection: CurateDraft['tracks'][number]): Tags {
  const { fields } = draft
  const text = (field: keyof typeof fields) => {
    const value = fields[field].selected
    return typeof value === 'string' && value.trim() ? value : undefined
  }
  const year = fields.year.selected
  return {
    title: selection.matchedTitle || undefined,
    artist: selection.matchedArtists || undefined,
    album: text('albumTitle'),
    albumArtist: text('albumArtist'),
    composer: text('composer'),
    year: typeof year === 'number' && year > 0 ? year : undefined,
    originalAlbum: selection.originalAlbum || undefined,
    originalYear: selection.originalYear || undefined,
    genre: text('genre'),
    coverArtUrl: coverSource(draft),
  }
}

export function isReconciledCurateDraft(draft: CurateDraft, rows: ReadonlyMap<string, CurateCommitRow>) {
  return draft.tracks.length > 0 && draft.tracks.every(selection => {
    const row = rows.get(selection.trackId)
    if (row?.status !== 'completed' || row.applies !== true) return false
    const confirmed: Tags & { curateTrackCount?: number } = JSON.parse(row.payloadJson)
    if (confirmed.curateTrackCount !== undefined && confirmed.curateTrackCount !== draft.tracks.length) return false
    const expected = selectedTags(draft, selection)
    if (confirmed.coverArtUrl) {
      if (!row.artworkUrl || (draft.fields.coverArt.selected !== confirmed.coverArtUrl &&
          draft.fields.coverArt.selected !== row.artworkUrl)) return false
    } else if (expected.coverArtUrl ||
        (draft.fields.coverArt.userOverridden && draft.fields.coverArt.selected !== draft.localCoverArt)) {
      return false
    }
    return (Object.keys(expected) as (keyof Tags)[]).every(
      key => key === 'coverArtUrl' || expected[key] === confirmed[key],
    )
  })
}

export function prepareTier1Commit(
  current: CurateDraft, saved: CurateDraft | null, tracks: Track[], release: Release | undefined,
  rows: ReadonlyMap<string, CurateCommitRow>,
) {
  if (saved) {
    const currentTrackIds = new Set(tracks.map(track => track.id))
    if (saved.baseline !== current.baseline || saved.tracks.length !== current.tracks.length ||
        !saved.tracks.every(track => currentTrackIds.has(track.trackId))) return null
  }
  const draft = saved ? { ...saved, localCoverArt: current.localCoverArt } : current
  if (!draft.tracks.length ||
      isReconciledCurateDraft(draft, rows) ||
      draft.tracks.some(track => {
        const row = rows.get(track.trackId)
        return row && row.status !== 'completed'
      })) return null
  return { draft, items: makeCurateCommitItems(draft, tracks, release) }
}

export function projectCurateCommits(tracks: Track[], releases: Release[], rows: CurateCommitRow[]) {
  if (!rows.length) return { tracks, releases }
  const byTrack = new Map(rows.map((row, order) => [row.trackId, { row, order }]))
  const byRelease = new Map<string, { tags: Tags; order: number }>()
  const updatedTracks = tracks.map(track => {
    const commit = byTrack.get(track.id)
    if (!commit || commit.row.applies === false) return track
    const tags: Tags = JSON.parse(commit.row.payloadJson)
    if (commit.row.status === 'completed') tags.coverArtUrl = commit.row.artworkUrl ?? undefined
    if ((byRelease.get(track.releaseId)?.order ?? -1) < commit.order) {
      byRelease.set(track.releaseId, { tags, order: commit.order })
    }
    return {
      ...track,
      title: tags.title ?? track.title,
      artistCredit: tags.artist ?? track.artistCredit,
      albumTitle: tags.album ?? track.albumTitle,
      releaseTitle: tags.album ?? track.releaseTitle,
      albumArtist: tags.albumArtist ?? track.albumArtist,
      composerName: tags.composer ?? track.composerName,
      canonicalReleaseYear: tags.year ?? track.canonicalReleaseYear,
      originalAlbum: tags.originalAlbum ?? track.originalAlbum,
      originalYear: tags.originalYear ?? track.originalYear,
    }
  })
  return {
    tracks: updatedTracks,
    releases: releases.map(release => {
      const commit = byRelease.get(release.id)
      if (!commit) return release
      const { tags } = commit
      return {
        ...release,
        title: tags.album ?? release.title,
        artistCredit: tags.albumArtist ?? release.artistCredit,
        composerName: tags.composer ?? release.composerName,
        releaseYear: tags.year ?? release.releaseYear,
        genreTags: tags.genre ? [tags.genre, ...release.genreTags.slice(1).filter(genre => genre !== tags.genre)] : release.genreTags,
        coverArtUrl: tags.coverArtUrl ?? release.coverArtUrl,
        artwork: tags.coverArtUrl ? { ...release.artwork, frontCoverUrl: tags.coverArtUrl } : release.artwork,
      }
    }),
  }
}
