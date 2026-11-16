import type {
  ArtistCreditItem,
  ArtistDetail,
  ArtistSummary,
  Release,
  Track,
} from './types'
import { groupAlbumReleases } from '../services/albumGroupingService'
import { splitMultiArtistCredits } from './taxonomyUtils'

const ARTIST_PREFS_STORAGE_KEY = 'cadence:artist_editorial_prefs:v1'

export interface ClientArtistPreference {
  portraitUrl?: string
  portraitStatus?: 'pending' | 'enriched' | 'not_found' | 'manual_override'
  bioSummary?: string
  eraActive?: string
  primaryRole?: string
  mbid?: string
  appleArtistId?: string
}

function readArtistPreferences(): Record<string, ClientArtistPreference> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {}
    const raw = window.localStorage.getItem(ARTIST_PREFS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function saveClientArtistPreference(
  artistKeyOrId: string,
  artistName: string | undefined,
  patch: Partial<ClientArtistPreference>,
): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    const current = readArtistPreferences()
    const keys = [artistKeyOrId.toLowerCase().trim()]
    if (artistName?.trim()) keys.push(artistName.trim().toLowerCase())
    for (const key of keys) {
      if (!key) continue
      current[key] = { ...(current[key] ?? {}), ...patch }
    }
    window.localStorage.setItem(ARTIST_PREFS_STORAGE_KEY, JSON.stringify(current))
  } catch {
    // ignore storage quota errors
  }
}

export function deriveCanonicalArtistsFromCatalog(
  releases: readonly Release[],
  tracks: readonly Track[],
  splitReleaseIds?: ReadonlySet<string>,
): ArtistSummary[] {
  const prefs = readArtistPreferences()
  const grouped = groupAlbumReleases([...releases], new Set(splitReleaseIds ?? []))
  const releaseToMasterId = new Map<string, string>()
  for (const grc of grouped) {
    const masterId = grc.masterRelease.id
    for (const cr of grc.constituentReleases) {
      releaseToMasterId.set(cr.id, masterId)
    }
  }

  const artistMap = new Map<
    string,
    {
      id: string
      name: string
      albums: Set<string>
      tracks: Set<string>
      roles: Set<string>
    }
  >()

  const ensureEntry = (rawName: string) => {
    const trimmed = rawName.trim()
    const key = trimmed.toLowerCase()
    let entry = artistMap.get(key)
    if (!entry) {
      entry = {
        id: `art-${key.replace(/[^a-z0-9]/g, '_')}`,
        name: trimmed,
        albums: new Set(),
        tracks: new Set(),
        roles: new Set(),
      }
      artistMap.set(key, entry)
    }
    return entry
  }

  for (const r of releases) {
    const masterReleaseId = releaseToMasterId.get(r.id) || r.id
    if (r.composerName?.trim()) {
      const entry = ensureEntry(r.composerName)
      entry.albums.add(masterReleaseId)
      entry.roles.add('Composer')
    }
    if (r.artistCredit?.trim()) {
      for (const s of splitMultiArtistCredits(r.artistCredit, 'Performer')) {
        if (!s.name.trim()) continue
        const entry = ensureEntry(s.name)
        entry.albums.add(masterReleaseId)
        entry.roles.add(s.role)
      }
    }
  }

  for (const t of tracks) {
    const masterReleaseId = (t.releaseId && releaseToMasterId.get(t.releaseId)) || t.releaseId
    if (t.composerName?.trim()) {
      const entry = ensureEntry(t.composerName)
      if (masterReleaseId) entry.albums.add(masterReleaseId)
      entry.tracks.add(t.id)
      entry.roles.add('Composer')
    }
    if (t.artistCredit?.trim()) {
      for (const s of splitMultiArtistCredits(t.artistCredit, 'Performer')) {
        if (!s.name.trim()) continue
        const entry = ensureEntry(s.name)
        if (masterReleaseId) entry.albums.add(masterReleaseId)
        entry.tracks.add(t.id)
        entry.roles.add(s.role)
      }
    }
  }

  const summaries: ArtistSummary[] = []
  for (const [key, item] of artistMap.entries()) {
    if (item.tracks.size === 0 && item.albums.size === 0) continue
    const rolesArr = Array.from(item.roles)
    const primaryRole = rolesArr.includes('Composer')
      ? 'Composer'
      : rolesArr.includes('Performer')
        ? 'Performer'
        : rolesArr[0] || 'Performer'
    const cached = prefs[item.id.toLowerCase()] ?? prefs[key]
    summaries.push({
      id: item.id,
      name: item.name,
      albumsCount: item.albums.size,
      tracksCount: item.tracks.size,
      roles: rolesArr,
      primaryRole: cached?.primaryRole || primaryRole,
      portraitUrl: cached?.portraitUrl,
      portraitStatus: cached?.portraitStatus ?? 'pending',
      eraActive: cached?.eraActive,
    })
  }
  return summaries
}

export function deriveCanonicalArtistDetailFromCatalog(
  artistId: string,
  releases: readonly Release[],
  tracks: readonly Track[],
  splitReleaseIds?: ReadonlySet<string>,
): ArtistDetail | null {
  if (releases.length === 0 && tracks.length === 0) return null
  const summaries = deriveCanonicalArtistsFromCatalog(releases, tracks, splitReleaseIds)
  const summary = summaries.find(
    (s) => s.id === artistId || s.name.toLowerCase() === artistId.toLowerCase(),
  )
  if (!summary) return null

  const normName = summary.name.toLowerCase()
  const prefs = readArtistPreferences()
  const cached = prefs[summary.id.toLowerCase()] ?? prefs[normName]
  const releaseById = new Map(releases.map((r) => [r.id, r]))

  const matchingReleases = releases.filter(
    (r) =>
      (r.composerName && r.composerName.toLowerCase().includes(normName)) ||
      (r.artistCredit && r.artistCredit.toLowerCase().includes(normName)),
  )

  const appearingTracks: ArtistCreditItem[] = []
  for (const t of tracks) {
    const isComposer = Boolean(t.composerName?.toLowerCase().includes(normName))
    const isPerformer = Boolean(t.artistCredit?.toLowerCase().includes(normName))
    if (!isComposer && !isPerformer) continue
    const coArtists = splitMultiArtistCredits(t.artistCredit || '')
      .map((s) => s.name)
      .filter((n) => n.toLowerCase() !== normName)
    const rel = releaseById.get(t.releaseId)
    appearingTracks.push({
      trackId: t.id,
      trackTitle: t.title,
      trackNumber: t.trackNumber,
      releaseId: t.releaseId,
      releaseTitle: rel?.title || t.albumTitle || 'Unknown Release',
      releaseYear: rel?.releaseYear ?? t.canonicalReleaseYear,
      role: isComposer ? 'Composer' : 'Performer',
      format: t.format,
      sampleRate: t.sampleRate,
      bitDepth: t.bitDepth,
      drScore: t.drScore,
      durationSecs: t.durationSeconds || 0,
      fullArtistCredit: t.artistCredit || summary.name,
      coArtists,
    })
  }

  const groupedMatching = groupAlbumReleases(matchingReleases, new Set(splitReleaseIds ?? []))
  return {
    artist: {
      id: summary.id,
      name: summary.name,
      portraitUrl: cached?.portraitUrl || summary.portraitUrl,
      portraitStatus: cached?.portraitStatus || summary.portraitStatus,
      primaryRole: cached?.primaryRole || summary.primaryRole,
      eraActive: cached?.eraActive || summary.eraActive,
      bioSummary: cached?.bioSummary,
      mbid: cached?.mbid,
      appleArtistId: cached?.appleArtistId,
      createdAt: new Date().toISOString(),
    },
    albumsCount: groupedMatching.length,
    tracksCount: appearingTracks.length,
    roles: summary.roles,
    discography: matchingReleases,
    appearingTracks,
  }
}

export function computePlaylistFormatBreakdown(tracks: readonly Track[]): string {
  if (!tracks || tracks.length === 0) return '0 tracks • Empty'

  let dsdCount = 0
  let flacCount = 0
  let wavCount = 0
  let maxDsdRate = ''

  for (const t of tracks) {
    const fmt = (t.format || '').toUpperCase()
    if (fmt.includes('DSD') || fmt.includes('DSF') || fmt.includes('DFF')) {
      dsdCount++
      if (t.sampleRateStr?.includes('DSD256')) maxDsdRate = 'DSD256'
      else if (!maxDsdRate && t.sampleRateStr?.includes('DSD128')) maxDsdRate = 'DSD128'
      else if (!maxDsdRate && t.sampleRateStr?.includes('DSD64')) maxDsdRate = 'DSD64'
    } else if (fmt.includes('FLAC') || fmt.includes('ALAC')) {
      flacCount++
    } else if (fmt.includes('WAV')) {
      wavCount++
    }
  }

  if (dsdCount > 0 && flacCount > 0) {
    return `${tracks.length} tracks • DSD/FLAC hybrid`
  }
  if (dsdCount > 0) {
    return `${tracks.length} tracks • Pure ${maxDsdRate || 'DSD'}`
  }
  if (flacCount > 0) {
    const hasHiRes = tracks.some((t) => t.isHighRes)
    return `${tracks.length} tracks • ${hasHiRes ? 'Hi-Res FLAC' : 'Lossless FLAC'}`
  }
  if (wavCount > 0) {
    return `${tracks.length} tracks • Pure WAV`
  }
  return `${tracks.length} tracks • Mixed audio`
}

export function generatePlaylist4GridArtwork(
  tracks: readonly Track[],
  allReleases?: readonly Release[],
): string[] {
  if (!tracks || tracks.length === 0) return []
  const uniqueArts: string[] = []
  const relMap = new Map<string, string>()
  if (allReleases) {
    for (const r of allReleases) {
      const art = r.coverArtUrl || r.artwork?.frontCoverUrl
      if (art) relMap.set(r.id, art)
    }
  }

  for (const t of tracks) {
    const art = relMap.get(t.releaseId)
    if (art && !uniqueArts.includes(art)) {
      uniqueArts.push(art)
      if (uniqueArts.length === 4) break
    }
  }

  return uniqueArts
}
