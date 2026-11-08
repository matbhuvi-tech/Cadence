import { curateReviewKeys } from './curateCommit'
import {
  cleanRipNoise, disambiguateComboTitle, isDefectiveArtistTag, isPlaceholderTag,
  normalizeCanonicalAlbumTitle, stripRipNoiseAndTags,
} from './taxonomyUtils'
import type { Release, Track } from './types'

const tiers = ['P0', 'P1', 'P2', 'P3'] as const
export type CuratePriorityTier = typeof tiers[number]

const categories = {
  cd_rip_suffix: ['P0', 'releases'],
  artist_as_album_title: ['P0', 'releases'],
  placeholder_track_titles: ['P0', 'tracks'],
  missing_artist_and_composer: ['P0', 'releases'],
  track_artist_copied_from_album: ['P1', 'tracks'],
  featured_artist_missing_from_tag: ['P1', 'tracks'],
  missing_release_year: ['P1', 'releases'],
  missing_track_year: ['P1', 'tracks'],
  missing_cover_art: ['P1', 'releases'],
  missing_album_genre: ['P1', 'releases'],
  missing_track_genre: ['P1', 'tracks'],
  compilation_missing_original_album: ['P2', 'tracks'],
  multi_soundtrack_missing_provenance: ['P2', 'releases'],
  duplicate_editions_missing_note: ['P3', 'releases'],
} as const

export type CurateProblemCategoryId = keyof typeof categories
export type PrioritySettings = Record<CurateProblemCategoryId, CuratePriorityTier>
export type DismissedProblemsMap = Record<string, CurateProblemCategoryId[]>
export type CurateAlbumSummary = { id: string; title: string }
export interface CurateFilterState {
  priorities: readonly CuratePriorityTier[]
  categories: readonly CurateProblemCategoryId[]
  selectedAlbumIdFilter?: string
}

export interface AlbumProblemInstance {
  categoryId: CurateProblemCategoryId
  priority: CuratePriorityTier
  affectedTrackIds?: string[]
}

export interface CatalogProblemSummary {
  albumProblems: Map<string, AlbumProblemInstance[]>
  categoryCounts: Record<CurateProblemCategoryId, { count: number; unit: 'releases' | 'tracks' }>
  priorityAlbumCounts: Record<CuratePriorityTier, number>
  infoExemptCount: number
  totalActionableAlbums: number
}

const categoryIds = Object.keys(categories) as CurateProblemCategoryId[]
export const DEFAULT_PRIORITY_SETTINGS = Object.freeze(Object.fromEntries(
  categoryIds.map(id => [id, categories[id][0]]),
) as PrioritySettings)

const normalizeCredit = (value?: string) =>
  value?.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '') ?? ''
const validYear = (year?: number) => typeof year === 'number' && Number.isFinite(year) && year >= 1900
const validGenre = (genre?: string) =>
  !isPlaceholderTag(genre) && !/^(unclassified|library import)$/i.test(genre?.trim() ?? '')

function albumCredits(release: Release | undefined, tracks: Track[]) {
  return {
    artist: release?.artistCredit || tracks.find(track => track.albumArtist)?.albumArtist,
    composer: release?.composerName || tracks.find(track => track.composerName)?.composerName,
  }
}

function editionKey(release: Release) {
  return JSON.stringify([
    normalizeCanonicalAlbumTitle(release.title), normalizeCredit(release.artistCredit || release.composerName), release.title,
  ])
}

function hasMissingFeaturedArtist(track: Track): boolean {
  const names = track.title.match(/\b(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+)/i)?.[1]
  if (!names) return false
  const credit = normalizeCredit(track.artistCredit)
  return names.split(/\s*(?:[,;&]|\band\b)\s*/i).some(name => {
    const normalized = normalizeCredit(name)
    return normalized && !credit.includes(normalized)
  })
}

function collectAlbumProblems(
  albumId: string, tracks: Track[], release: Release | undefined, duplicateEdition: boolean,
  settings: PrioritySettings, dismissed?: DismissedProblemsMap,
): AlbumProblemInstance[] {
  const keys = curateReviewKeys(albumId, tracks)
  // Prefer the stable file-set record when a rescan has changed the album ID.
  const savedKey = keys.reverse().find(key => dismissed && Object.hasOwn(dismissed, key))
  const exemptions = new Set(savedKey === undefined ? [] : dismissed?.[savedKey])
  const problems: AlbumProblemInstance[] = []
  const add = (categoryId: CurateProblemCategoryId, affected?: string[]) => {
    if (exemptions.has(categoryId) || affected?.length === 0) return
    problems.push({ categoryId, priority: settings[categoryId], ...(affected && { affectedTrackIds: affected }) })
  }
  const title = release?.title ?? ''
  const normalizedTitle = normalizeCredit(title)
  const { artist, composer } = albumCredits(release, tracks)
  const albumGenre = release?.genreTags?.some(validGenre)
  const compilation = release?.isCompilation ||
    release?.genreTags?.some(genre => genre.toLowerCase().includes('compilation')) ||
    /\b(hits\s+of|best\s+of|golden\s+hits|anthology|collection|classics)\b/i.test(title) ||
    tracks.some(track => track.isCompilation || /\(from\s+["'][^"']+["']\)/i.test(track.title))

  if (release) {
    const rawTitle = title.trim().toLowerCase()
    if (rawTitle && [cleanRipNoise(title), stripRipNoiseAndTags(title)].some(clean => clean.toLowerCase() !== rawTitle)) add('cd_rip_suffix')
    if (normalizedTitle && (
      normalizedTitle === normalizeCredit(release.artistCredit) || normalizedTitle === normalizeCredit(release.composerName) ||
      (!isPlaceholderTag(release.artistCredit) && isDefectiveArtistTag(release.artistCredit, title))
    )) add('artist_as_album_title')
    if (!validYear(release.releaseYear)) add('missing_release_year')
    if ((!release.coverArtUrl && !release.artwork?.frontCoverUrl) ||
        release.artwork?.resolution === 'No Embedded Art') add('missing_cover_art')
    if (!albumGenre) add('missing_album_genre')
    if ((release.physicalComboTitle ||
        (disambiguateComboTitle(title, release.folderPath || release.folderName).parts?.length ?? 0) > 1) &&
        tracks.some(track => !track.originalAlbum?.trim())) add('multi_soundtrack_missing_provenance')
    if (duplicateEdition) add('duplicate_editions_missing_note')
  }
  if (isPlaceholderTag(artist) && isPlaceholderTag(composer)) add('missing_artist_and_composer')

  const trackProblems = (id: CurateProblemCategoryId, predicate: (track: Track) => boolean) =>
    add(id, [...new Set(tracks.filter(predicate).map(track => track.id))])

  trackProblems('placeholder_track_titles', track => isPlaceholderTag(track.title) ||
    /^(?:(?:audio\s+)?track\s*\d+|unknown title|\d+)$/i.test(track.title.trim()))
  trackProblems('track_artist_copied_from_album', track => {
    const credit = normalizeCredit(track.artistCredit)
    return Boolean(credit && [normalizedTitle, normalizeCredit(track.folderName), normalizeCredit(release?.folderName)].includes(credit))
  })
  trackProblems('featured_artist_missing_from_tag', hasMissingFeaturedArtist)
  trackProblems('missing_track_year', track => ![track.canonicalReleaseYear, track.originalYear, release?.releaseYear].some(validYear))
  trackProblems('missing_track_genre', track => !albumGenre && !validGenre(track.genre))
  if (compilation) trackProblems('compilation_missing_original_album', track => !track.originalAlbum?.trim())
  return problems
}

export function evaluateAlbumProblems(
  albumId: string, tracks: Track[], release: Release | undefined, allReleases: Release[],
  settings: PrioritySettings, dismissed?: DismissedProblemsMap,
): AlbumProblemInstance[] {
  const key = release && editionKey(release)
  const duplicate = Boolean(release && allReleases.some(other => other.id !== release.id && editionKey(other) === key))
  return collectAlbumProblems(albumId, tracks, release, duplicate, settings, dismissed)
}

export function evaluateCatalogProblems(
  tracks: Track[], releases: Release[], settings: PrioritySettings, dismissed?: DismissedProblemsMap,
): CatalogProblemSummary {
  const tracksByAlbum = new Map<string, Track[]>()
  for (const track of tracks) {
    const members = tracksByAlbum.get(track.releaseId)
    if (members) members.push(track)
    else tracksByAlbum.set(track.releaseId, [track])
  }
  const releasesById = new Map(releases.map(release => [release.id, release]))
  const editionCounts = new Map<string, number>()
  for (const release of releasesById.values()) {
    const key = editionKey(release)
    editionCounts.set(key, (editionCounts.get(key) ?? 0) + 1)
  }
  const albumProblems = new Map<string, AlbumProblemInstance[]>()
  const categoryCounts = Object.fromEntries(categoryIds.map(id =>
    [id, { count: 0, unit: categories[id][1] }],
  )) as CatalogProblemSummary['categoryCounts']
  const priorityAlbumCounts = { P0: 0, P1: 0, P2: 0, P3: 0 }
  let infoExemptCount = 0
  for (const id of new Set([...releasesById.keys(), ...tracksByAlbum.keys()])) {
    const release = releasesById.get(id)
    const members = tracksByAlbum.get(id) ?? []
    const { artist, composer } = albumCredits(release, members)
    if (release && !isPlaceholderTag(artist) && !composer?.trim()) infoExemptCount++
    const duplicate = Boolean(release && (editionCounts.get(editionKey(release)) ?? 0) > 1)
    const problems = collectAlbumProblems(id, members, release, duplicate, settings, dismissed)
    if (!problems.length) continue
    albumProblems.set(id, problems)
    for (const problem of problems) categoryCounts[problem.categoryId].count += problem.affectedTrackIds?.length ?? 1
    for (const tier of new Set(problems.map(problem => problem.priority))) priorityAlbumCounts[tier]++
  }
  return { albumProblems, categoryCounts, priorityAlbumCounts, infoExemptCount, totalActionableAlbums: albumProblems.size }
}

export function filterAndRankCurateAlbums<T extends CurateAlbumSummary>(
  albums: T[], summary: CatalogProblemSummary, filter: CurateFilterState,
): T[] {
  const ranked = new Map<string, { album: T; rank: number }>()
  for (const album of albums) {
    if (ranked.has(album.id) || (filter.selectedAlbumIdFilter && album.id !== filter.selectedAlbumIdFilter)) continue
    const matching = summary.albumProblems.get(album.id)?.filter(problem =>
      (!filter.priorities.length || filter.priorities.includes(problem.priority)) &&
      (!filter.categories.length || filter.categories.includes(problem.categoryId)),
    )
    if (matching?.length) ranked.set(album.id, { album, rank: Math.min(...matching.map(problem => tiers.indexOf(problem.priority))) })
  }
  return [...ranked.values()].sort((a, b) =>
    a.rank - b.rank || a.album.title.localeCompare(b.album.title) || a.album.id.localeCompare(b.album.id),
  ).map(entry => entry.album)
}

const emptyFilter = (): CurateFilterState => ({ priorities: [], categories: [] })

export function resolveFilterTransition<T extends CurateAlbumSummary>(
  albums: T[], summary: CatalogProblemSummary, nextFilter: CurateFilterState, reason: 'filter_change' | 'batch_resolved',
): { filter: CurateFilterState; filteredAlbums: T[]; filterCompleted: boolean; toastMessage?: string } {
  const filteredAlbums = filterAndRankCurateAlbums(albums, summary, nextFilter)
  const active = nextFilter.priorities.length || nextFilter.categories.length || nextFilter.selectedAlbumIdFilter
  if (filteredAlbums.length || !active) return { filter: nextFilter, filteredAlbums, filterCompleted: false }
  if (reason === 'batch_resolved') return { filter: nextFilter, filteredAlbums, filterCompleted: true }
  const filter = emptyFilter()
  return {
    filter, filteredAlbums: filterAndRankCurateAlbums(albums, summary, filter), filterCompleted: false,
    toastMessage: 'No albums match. Filters reset.',
  }
}

type CurateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const priorityKey = 'cadence.curate.priority-settings.v1'
const filterKey = 'cadence.curate.filters.v1'
const dismissalsKey = 'cadence.curate.dismissed-problems.v1'

function readObject(key: string, storage?: CurateStorage): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse((storage ?? globalThis.localStorage)?.getItem(key) ?? 'null')
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // Recover from corrupt or unavailable preferences.
  }
  return {}
}

const isTier = (value: unknown): value is CuratePriorityTier => tiers.some(tier => tier === value)
const isCategory = (value: unknown): value is CurateProblemCategoryId => categoryIds.some(id => id === value)

export function loadPrioritySettings(storage?: CurateStorage): PrioritySettings {
  const saved = readObject(priorityKey, storage)
  const settings = { ...DEFAULT_PRIORITY_SETTINGS }
  for (const id of categoryIds) {
    const tier = saved[id]
    if (isTier(tier)) settings[id] = tier
  }
  return settings
}

export function savePrioritySettings(settings: PrioritySettings, storage: CurateStorage = globalThis.localStorage) {
  storage?.setItem(priorityKey, JSON.stringify(settings))
}

export function resetPrioritySettings(storage: CurateStorage = globalThis.localStorage): PrioritySettings {
  storage?.removeItem(priorityKey)
  return { ...DEFAULT_PRIORITY_SETTINGS }
}

export function loadCurateFilterState(storage?: CurateStorage): CurateFilterState {
  const saved = readObject(filterKey, storage)
  return {
    priorities: Array.isArray(saved.priorities) ? [...new Set(saved.priorities.filter(isTier))] : [],
    categories: Array.isArray(saved.categories) ? [...new Set(saved.categories.filter(isCategory))] : [],
    ...(typeof saved.selectedAlbumIdFilter === 'string' && { selectedAlbumIdFilter: saved.selectedAlbumIdFilter }),
  }
}

export function saveCurateFilterState(filter: CurateFilterState, storage: CurateStorage = globalThis.localStorage) {
  storage?.setItem(filterKey, JSON.stringify(filter))
}

export function loadDismissedProblems(storage?: CurateStorage): DismissedProblemsMap {
  return Object.fromEntries(Object.entries(readObject(dismissalsKey, storage)).flatMap(([key, value]) =>
    Array.isArray(value) ? [[key, [...new Set(value.filter(isCategory))]]] : [],
  ))
}

export function saveDismissedProblem(
  albumId: string, categoryId: CurateProblemCategoryId, tracks: Pick<Track, 'filePath'>[] = [],
  storage: CurateStorage = globalThis.localStorage,
) {
  const dismissed = loadDismissedProblems(storage)
  for (const key of curateReviewKeys(albumId, tracks)) {
    Object.defineProperty(dismissed, key, {
      value: [...new Set([...(Object.hasOwn(dismissed, key) ? dismissed[key] : []), categoryId])],
      enumerable: true, configurable: true, writable: true,
    })
  }
  storage?.setItem(dismissalsKey, JSON.stringify(dismissed))
  return dismissed
}

export function removeDismissedProblem(
  albumId: string, categoryId: CurateProblemCategoryId, tracks: Pick<Track, 'filePath'>[] = [],
  storage: CurateStorage = globalThis.localStorage,
) {
  const dismissed = loadDismissedProblems(storage)
  const keys = curateReviewKeys(albumId, tracks)
  for (const key of keys) {
    if (!Object.hasOwn(dismissed, key)) continue
    dismissed[key] = dismissed[key].filter(id => id !== categoryId)
    // Keep an empty file-set entry so an older album ID cannot revive a dismissal.
    if (!dismissed[key].length && key === albumId) delete dismissed[key]
  }
  storage?.setItem(dismissalsKey, JSON.stringify(dismissed))
  return dismissed
}
