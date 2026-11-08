import { migrateCurateDraft, type CurateDraft } from './curateDraft'
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
  hasNewerDraft?: boolean
  hasHeldEdits?: boolean
  lineageChanged?: boolean
  catalog?: Partial<Record<keyof Tags, string | number | null>>
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
  const byTrack = new Map(rows.map((row, order) => [row.trackId, { row, order }]))
  const next = new Map(state)
  for (const [releaseId, album] of byRelease) {
    const keys = curateReviewKeys(releaseId, album)
    const previous = keys.map(key => state.get(key)).find(value => value !== undefined)
    const albumRows = album.flatMap(track => byTrack.get(track.id) ?? []).sort((a, b) => a.order - b.order)
      .map(({ row }) => row)
    const confirmations = albumRows.map(row => ({ row, payload: JSON.parse(row.payloadJson) }))
    const latest = confirmations.at(-1)?.payload
    const group = latest ? confirmations.filter(({ payload }) => payload.curateReviewId === latest.curateReviewId) : []
    if (group.some(({ row }) => row.hasNewerDraft || row.hasHeldEdits || row.lineageChanged)) {
      for (const key of keys) if (next.get(key) === true) next.delete(key)
      continue
    }
    const completed = previous === true || (group.length > 0 && group.every(({ row, payload }) =>
      row.status === 'completed' && !(previous && previous.includes(row.id)) &&
      payload.curate === true && payload.curateTrackCount === group.length,
    ))
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

function physicalTags(track: Track, release?: Release): Tags {
  return {
    title: track.title,
    artist: track.artistCredit,
    album: release?.title,
    albumArtist: track.albumArtist || release?.artistCredit,
    composer: track.composerName || release?.composerName,
    year: track.canonicalReleaseYear || release?.releaseYear,
    originalAlbum: track.originalAlbum,
    originalYear: track.originalYear,
    genre: track.genre || release?.genreTags?.[0],
    coverArtUrl: release?.coverArtUrl || release?.artwork?.frontCoverUrl,
  }
}

export function hasTrackPhysicalDelta(
  draft: CurateDraft, selection: CurateDraft['tracks'][number], rawTrack: Track, rawRelease?: Release,
): boolean {
  const raw = physicalTags(rawTrack, rawRelease)
  const selected = selectedTags(draft, selection)
  return (Object.keys(selected) as (keyof Tags)[]).some(key => getCurateChange(raw[key], selected[key]))
}

function prepareCurateCommitTracks(draft: CurateDraft, rawTracks: Track[], rawRelease?: Release) {
  const byId = new Map(rawTracks.map(track => [track.id, track]))
  const cover = draft.fields.coverArt.selected
  if (draft.fields.coverArt.userOverridden && typeof cover === 'string' && cover &&
      cover !== draft.localCoverArt && !coverSource(draft)) {
    throw new Error('Choose a JPEG or PNG cover from an HTTP(S) URL or image data URL.')
  }
  return draft.tracks.flatMap(selection => {
    const track = byId.get(selection.trackId)
    if (!track) throw new Error('A selected track is missing from the physical catalog.')
    if (!hasTrackPhysicalDelta(draft, selection, track, rawRelease)) return []
    if (!track.filePath || !track.storageMountId) throw new Error('A selected track has no file path or storage mount.')
    return [{ track, selection, filePath: track.filePath, mountId: track.storageMountId }]
  })
}

export function makeCurateCommitItems(
  draft: CurateDraft, rawTracks: Track[], rawRelease?: Release,
): NewCommitItemPayload[] {
  const changed = prepareCurateCommitTracks(draft, rawTracks, rawRelease)
  if (!changed.length) return []
  const curateReviewId = crypto.randomUUID()
  return changed.map(({ track, selection, filePath, mountId }) => ({
    id: crypto.randomUUID(),
    trackId: track.id,
    filePath,
    mountId,
    payloadJson: JSON.stringify({
      ...selectedTags(draft, selection), curate: true, curateTrackCount: changed.length,
      curateReviewId, curateDraftRevision: draft.revision, destination: 'embedded',
    }),
    backupJson: JSON.stringify({ ...physicalTags(track, rawRelease), curate: true, destination: 'embedded' }),
  }))
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

export function isReconciledCurateDraft(
  draft: CurateDraft, rows: ReadonlyMap<string, CurateCommitRow>, rawTracks?: Track[], rawRelease?: Release,
) {
  return matchesCurateConfirmation(draft, rows, true, rawTracks, rawRelease)
}

export function matchesCurateConfirmation(
  draft: CurateDraft, rows: ReadonlyMap<string, CurateCommitRow>, requireCompleted = false,
  rawTracks?: Track[], rawRelease?: Release,
) {
  let reviewId: string | undefined
  const rawById = rawTracks && new Map(rawTracks.map(track => [track.id, track]))
  const confirmedTracks = draft.tracks.filter(selection => {
    const row = rows.get(selection.trackId)
    if (!row) return false
    const payload = JSON.parse(row.payloadJson)
    return payload.curateDraftRevision === draft.revision
  })
  if (!confirmedTracks.length) return false
  if (rawById) {
    const confirmedIds = new Set(confirmedTracks.map(track => track.trackId))
    if (draft.tracks.some(selection => {
      const track = rawById.get(selection.trackId)
      return !track || (!confirmedIds.has(selection.trackId) && hasTrackPhysicalDelta(draft, selection, track, rawRelease))
    })) return false
  }
  return confirmedTracks.every((selection, index) => {
    const row = rows.get(selection.trackId)
    if (!row || row.lineageChanged || (requireCompleted && row.status !== 'completed')) return false
    const confirmed: Tags & {
      curateTrackCount?: number; curateReviewId?: string; curateDraftRevision?: string
    } = JSON.parse(row.payloadJson)
    if (index === 0) reviewId = confirmed.curateReviewId
    if (confirmed.curateReviewId !== reviewId || confirmed.curateDraftRevision !== draft.revision) return false
    if ((confirmed.curateTrackCount ?? draft.tracks.length) !== confirmedTracks.length) return false
    const expected = selectedTags(draft, selection)
    if (confirmed.coverArtUrl) {
      if ((requireCompleted && !row.artworkUrl) || (draft.fields.coverArt.selected !== confirmed.coverArtUrl &&
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

const commitFieldLabels: Record<keyof Tags, string> = {
  title: 'Track title', artist: 'Track credit', album: 'Album title', albumArtist: 'Album artist',
  composer: 'Composer', year: 'Year', originalAlbum: 'Original album', originalYear: 'Original year',
  genre: 'Genre', coverArtUrl: 'Cover art',
}

export function getCurateCommitPreviewTracks(draft: CurateDraft, rawTracks: Track[], rawRelease?: Release) {
  return prepareCurateCommitTracks(draft, rawTracks, rawRelease).map(({ track, selection }) => {
    const raw = physicalTags(track, rawRelease)
    const selected = selectedTags(draft, selection)
    return {
      trackId: track.id,
      title: track.title,
      changes: (Object.keys(commitFieldLabels) as (keyof Tags)[]).flatMap(key => {
        const change = getCurateChange(raw[key], selected[key])
        return change ? [{ field: commitFieldLabels[key], previous: change.previous, selected: selected[key] }] : []
      }),
    }
  })
}

export function curateCommitDifferences(row: CurateCommitRow, draft?: CurateDraft) {
  if (!row.catalog) return []
  const tags: Tags = JSON.parse(row.payloadJson)
  const track = draft?.tracks.find(selection => selection.trackId === row.trackId)
  const draftTags = draft && track ? selectedTags(draft, track) : undefined
  return (Object.keys(commitFieldLabels) as (keyof Tags)[]).flatMap(key => {
    const catalog = row.catalog?.[key] ?? undefined
    const confirmed = row.lineageChanged || row.applies === false
      ? catalog : key === 'coverArtUrl' && row.artworkUrl ? row.artworkUrl : tags[key] ?? catalog
    const selected = draftTags?.[key] ?? (key === 'coverArtUrl' ? draft?.fields.coverArt.selected : undefined)
    if (catalog === confirmed && (selected === undefined || catalog === selected)) return []
    const display = (value: string | number | undefined) => key === 'coverArtUrl' && typeof value === 'string'
      ? value.startsWith('data:') ? 'Embedded image' : value : value
    return [{
      field: commitFieldLabels[key],
      catalog: display(catalog),
      confirmed: display(confirmed),
      selected: display(selected),
    }]
  })
}

export function makeStagedCurateCommitItems(
  draft: CurateDraft, rawTracks: Track[], rawRelease: Release | undefined,
  rows: ReadonlyMap<string, CurateCommitRow>,
): NewCommitItemPayload[] {
  if (draft.staged !== true || matchesCurateConfirmation(draft, rows, false, rawTracks, rawRelease)) return []
  return makeCurateCommitItems(draft, rawTracks, rawRelease)
}

export function prepareTier1Commit(
  current: CurateDraft, saved: CurateDraft | null, tracks: Track[], release: Release | undefined,
  rows: ReadonlyMap<string, CurateCommitRow>,
  revision?: string,
  currentSession = false,
) {
  if (saved) {
    const currentTrackIds = new Set(tracks.map(track => track.id))
    if (saved.baseline !== current.baseline || saved.tracks.length !== current.tracks.length ||
        !saved.tracks.every(track => currentTrackIds.has(track.trackId))) return null
  }
  if ((saved && isReconciledCurateDraft(saved, rows, tracks, release)) ||
      isReconciledCurateDraft(current, rows, tracks, release)) return null
  const draft = saved && !currentSession ? migrateCurateDraft(saved, current) : saved ?? current
  if (revision && saved && !currentSession && draft.tracks.some((track, index) =>
    JSON.stringify(selectedTags(draft, track)) !== JSON.stringify(selectedTags(saved, saved.tracks[index])))) return null
  if (!draft.tracks.length ||
      draft.tracks.some(track => {
        const row = rows.get(track.trackId)
        return row && row.status !== 'completed'
      })) return null
  const frozen = { ...draft, revision: draft.revision ?? revision }
  const items = makeCurateCommitItems(frozen, tracks, release)
  return items.length ? { draft: frozen, items } : null
}

export function projectCurateCommits(tracks: Track[], releases: Release[], rows: CurateCommitRow[]) {
  if (!rows.length) return { tracks, releases }
  const albumByTrack = new Map(tracks.map(track => [track.id, track.releaseId]))
  const byTrack = new Map<string, Tags>()
  const byRelease = new Map<string, Tags>()
  for (const row of rows) {
    const releaseId = albumByTrack.get(row.trackId)
    if (releaseId === undefined || row.applies === false || row.lineageChanged) continue
    const tags: Tags = JSON.parse(row.payloadJson)
    if (row.status === 'completed' && tags.coverArtUrl) {
      if (row.artworkUrl) tags.coverArtUrl = row.artworkUrl
      else delete tags.coverArtUrl
    }
    byTrack.set(row.trackId, { ...byTrack.get(row.trackId), ...tags })
    byRelease.set(releaseId, { ...byRelease.get(releaseId), ...tags })
  }
  const updatedTracks = tracks.map(track => {
    const tags = byTrack.get(track.id)
    const album = byRelease.get(track.releaseId)
    if (!tags && album?.year === undefined && album?.genre === undefined) return track
    return {
      ...track,
      title: tags?.title ?? track.title,
      artistCredit: tags?.artist ?? track.artistCredit,
      albumTitle: tags?.album ?? track.albumTitle,
      releaseTitle: tags?.album ?? track.releaseTitle,
      albumArtist: tags?.albumArtist ?? track.albumArtist,
      composerName: tags?.composer ?? track.composerName,
      canonicalReleaseYear: tags?.year ?? album?.year ?? track.canonicalReleaseYear,
      genre: tags?.genre ?? album?.genre ?? track.genre,
      originalAlbum: tags?.originalAlbum ?? track.originalAlbum,
      originalYear: tags?.originalYear ?? track.originalYear,
    }
  })
  return {
    tracks: updatedTracks,
    releases: releases.map(release => {
      const tags = byRelease.get(release.id)
      if (!tags) return release
      return {
        ...release,
        title: tags?.album ?? release.title,
        artistCredit: tags?.albumArtist ?? release.artistCredit,
        composerName: tags?.composer ?? release.composerName,
        releaseYear: tags.year ?? release.releaseYear,
        genreTags: tags.genre ? [tags.genre, ...(release.genreTags ?? []).slice(1).filter(genre => genre !== tags.genre)] : release.genreTags,
        coverArtUrl: tags.coverArtUrl ?? release.coverArtUrl,
        artwork: tags.coverArtUrl ? { ...release.artwork, frontCoverUrl: tags.coverArtUrl,
          resolution: release.artwork?.resolution === 'No Embedded Art' ? '' : release.artwork?.resolution ?? '' } : release.artwork,
      }
    }),
  }
}
