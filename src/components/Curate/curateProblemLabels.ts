import type { CuratePriorityTier, CurateProblemCategoryId } from '../../core/curatePriorities'

export const tiers: CuratePriorityTier[] = ['P0', 'P1', 'P2', 'P3']
export const labels: Record<CurateProblemCategoryId, string> = {
  cd_rip_suffix: 'CD rip suffix in album title',
  artist_as_album_title: 'Artist used as album title',
  placeholder_track_titles: 'Placeholder track titles',
  missing_artist_and_composer: 'Missing both album artist and composer',
  track_artist_copied_from_album: 'Track artist copied from album',
  featured_artist_missing_from_tag: 'Featured artist missing from tag',
  missing_release_year: 'Missing release year',
  missing_track_year: 'Missing track year',
  missing_cover_art: 'Missing cover artwork',
  missing_album_genre: 'Missing album genre',
  missing_track_genre: 'Missing track genre',
  compilation_missing_original_album: 'Compilation missing original album',
  multi_soundtrack_missing_provenance: 'Multi-soundtrack compilation missing provenance',
  duplicate_editions_missing_note: 'Duplicate editions missing a note',
}
export const categoryIds = Object.keys(labels) as CurateProblemCategoryId[]
