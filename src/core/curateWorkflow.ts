import { migrateCurateDraft, type CurateDraft } from './curateDraft'
import { projectCurateCommits, type CurateCommitRow } from './curateCommit'
import { evaluateCatalogProblems, type DismissedProblemsMap, type PrioritySettings } from './curatePriorities'
import type { Release, Track } from './types'

export function buildCurateCockpitCatalogProps(
  rawTracks: Track[], rawReleases: Release[], commits: CurateCommitRow[],
  settings: PrioritySettings, dismissed: DismissedProblemsMap,
) {
  const catalog = projectCurateCommits(rawTracks, rawReleases, commits)
  const summary = evaluateCatalogProblems(catalog.tracks, catalog.releases, settings, dismissed)
  return { ...catalog, rawTracks, rawReleases, summary, curateBadgeCount: summary.totalActionableAlbums }
}

export function stepFilteredAlbumSelection(albums: readonly { id: string }[], id: string | null, step: -1 | 1) {
  const index = albums.findIndex(album => album.id === id)
  if (index < 0) return (step === 1 ? albums[0] : albums.at(-1))?.id ?? null
  return albums[index + step]?.id ?? id
}

export function resolvePostCommitNavigation(
  previous: readonly { id: string }[], filtered: readonly { id: string }[], id: string | null,
) {
  if (filtered.some(album => album.id === id)) return id
  const index = previous.findIndex(album => album.id === id)
  if (id && index < 0) return id
  const remaining = new Set(filtered.map(album => album.id))
  return previous.slice(index + 1).find(album => remaining.has(album.id))?.id ?? filtered[0]?.id ?? null
}

export function resolveStagedAlbumIds(drafts: Record<string, CurateDraft>) {
  return Object.keys(drafts).filter(id => drafts[id]?.staged === true)
}

export function resolveAlbumSelectionDraftState(
  saved: CurateDraft | null, baseline: CurateDraft, completed: boolean, confirmed: boolean,
) {
  if (!saved || completed) return null
  if (confirmed) return saved
  const explicit = saved.staged || Object.values(saved.fields).some(field => field.userOverridden) ||
    saved.tracks.some(track => track.selectedOverrides?.length || track.provenanceSource === 'user_override')
  if (!explicit) return null
  return saved.revision && saved.baseline === baseline.baseline ? saved : migrateCurateDraft(saved, baseline)
}

export function applyAcceptedSuggestionsToDraft(
  draft: CurateDraft, proposal: CurateDraft | undefined,
  fallback: Partial<Record<keyof CurateDraft['fields'], string | number | undefined>>,
): CurateDraft {
  const fields = { ...draft.fields }
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    const current = fields[key]
    if (current.userOverridden) continue
    const candidate = proposal?.fields[key]
    const selected = candidate?.selected === current.selected ? fallback[key] : candidate?.selected ?? fallback[key]
    if (!selected || selected === current.selected) continue
    fields[key] = { ...current, ...candidate, selected, userOverridden: true, requiresHumanReview: false }
  }
  const proposals = new Map(proposal?.tracks.map(track => [track.trackId, track]))
  const tracks = draft.tracks.map(track => {
    const candidate = proposals.get(track.trackId)
    if (!candidate) return track
    const changes = {} as Partial<typeof track>
    const overrides = new Set(track.selectedOverrides)
    for (const key of ['matchedTitle', 'matchedArtists', 'originalAlbum', 'originalYear'] as const) {
      if (overrides.has(key) || !candidate[key] || track[key] === candidate[key]) continue
      Object.assign(changes, { [key]: candidate[key] })
      overrides.add(key)
    }
    if (!Object.keys(changes).length) return track
    return {
      ...track, ...changes, selectedOverrides: [...overrides],
      source: candidate.source, confidence: candidate.confidence, requiresHumanReview: false,
      provenanceSource: changes.originalAlbum ? candidate.provenanceSource : track.provenanceSource,
    }
  })
  return { ...draft, fields, tracks }
}

