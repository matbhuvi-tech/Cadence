import type { Playlist, Release, Track } from '../core/types'
import {
  computePlaylistFormatBreakdown,
  generatePlaylist4GridArtwork,
} from '../core/libraryProjection'
import type { EngineClient } from './engineClient'

function sumDuration(tracks: readonly Track[]): number {
  return tracks.reduce((sum, t) => sum + (t.durationSeconds || t.duration || 0), 0)
}

export async function listEnginePlaylists(
  client: EngineClient,
  allTracks: readonly Track[],
  allReleases: readonly Release[],
): Promise<Playlist[]> {
  const summaries = await client.listPlaylists()
  const trackMap = new Map(allTracks.map((t) => [t.id, t]))
  const details = await Promise.all(
    summaries.map(async (s) => {
      try {
        return await client.getPlaylist(s.id)
      } catch {
        return { id: s.id, title: s.title, description: s.description, trackIds: [] }
      }
    }),
  )
  const nowIso = new Date().toISOString()
  return details.map((d) => {
    const resolvedTracks = d.trackIds
      .map((id) => trackMap.get(id))
      .filter((t): t is Track => Boolean(t))
    const arts = generatePlaylist4GridArtwork(resolvedTracks, allReleases)
    return {
      id: d.id,
      title: d.title,
      description: d.description ?? undefined,
      coverArtUrl: arts[0],
      tags: [],
      tracksCount: d.trackIds.length,
      totalDurationSecs: sumDuration(resolvedTracks),
      formatBreakdown: computePlaylistFormatBreakdown(resolvedTracks),
      tracks: resolvedTracks,
      createdAt: nowIso,
      updatedAt: nowIso,
    }
  })
}

export async function getEnginePlaylistDetails(
  client: EngineClient,
  playlistId: string,
  allTracks: readonly Track[],
  allReleases: readonly Release[],
): Promise<{ playlist: Playlist; tracks: Track[] } | null> {
  const detail = await client.getPlaylist(playlistId)
  const trackMap = new Map(allTracks.map((t) => [t.id, t]))
  const resolvedTracks = detail.trackIds
    .map((id) => trackMap.get(id))
    .filter((t): t is Track => Boolean(t))
  const arts = generatePlaylist4GridArtwork(resolvedTracks, allReleases)
  const nowIso = new Date().toISOString()
  return {
    playlist: {
      id: detail.id,
      title: detail.title,
      description: detail.description ?? undefined,
      coverArtUrl: arts[0],
      tags: [],
      tracksCount: detail.trackIds.length,
      totalDurationSecs: sumDuration(resolvedTracks),
      formatBreakdown: computePlaylistFormatBreakdown(resolvedTracks),
      tracks: resolvedTracks,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    tracks: resolvedTracks,
  }
}

export async function createEnginePlaylist(
  client: EngineClient,
  input: {
    title: string
    description?: string
    trackIds: string[]
    tracks?: readonly Track[]
    allReleases?: readonly Release[]
  },
): Promise<Playlist> {
  const created = await client.createPlaylist(input.title, input.description)
  const uniqueIds = Array.from(new Set(input.trackIds))
  if (uniqueIds.length > 0) {
    await client.setPlaylistTracks(created.id, uniqueIds)
  }
  const tracks = [...(input.tracks ?? [])]
  const arts = generatePlaylist4GridArtwork(tracks, input.allReleases)
  const nowIso = new Date().toISOString()
  return {
    id: created.id,
    title: created.title,
    description: created.description ?? input.description,
    coverArtUrl: arts[0],
    tags: [],
    tracksCount: uniqueIds.length,
    totalDurationSecs: sumDuration(tracks),
    formatBreakdown: computePlaylistFormatBreakdown(tracks),
    tracks,
    createdAt: nowIso,
    updatedAt: nowIso,
  }
}

export async function addTracksToEnginePlaylist(
  client: EngineClient,
  playlistId: string,
  tracksToAdd: readonly Track[],
): Promise<void> {
  const detail = await client.getPlaylist(playlistId)
  const seen = new Set(detail.trackIds)
  const nextIds = [...detail.trackIds]
  for (const t of tracksToAdd) {
    if (!seen.has(t.id)) {
      seen.add(t.id)
      nextIds.push(t.id)
    }
  }
  await client.setPlaylistTracks(playlistId, nextIds)
}

export async function removeTrackFromEnginePlaylist(
  client: EngineClient,
  playlistId: string,
  position: number,
): Promise<void> {
  const detail = await client.getPlaylist(playlistId)
  const nextIds = detail.trackIds.filter((_, idx) => idx !== position)
  await client.setPlaylistTracks(playlistId, nextIds)
}
