import type { DbRelease } from '../../types/remote';

export type SortBy = 'year_desc' | 'year_asc' | 'artist_asc' | 'title_asc';

export const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'year_desc', label: 'Year (Newest First)' },
  { value: 'year_asc', label: 'Year (Oldest First)' },
  { value: 'artist_asc', label: 'Artist (A-Z)' },
  { value: 'title_asc', label: 'Album Title (A-Z)' },
];

export const ERA_OPTIONS = ['1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s'] as const;

export const FORMAT_OPTIONS: { label: string; value: string; colorClass?: string }[] = [
  { label: '24-bit Hi-Res', value: '24-bit Hi-Res', colorClass: 'text-amber-300' },
  { label: 'Native DSD', value: 'DSD', colorClass: 'text-[#818CF8]' },
  { label: 'WAV', value: 'WAV', colorClass: 'text-[#38BDF8]' },
  { label: 'FLAC', value: 'FLAC', colorClass: 'text-[#F59E0B]' },
  { label: 'AIFF', value: 'AIFF' },
  { label: 'ALAC', value: 'ALAC' },
];

export interface CatalogFacets {
  era?: string;
  format?: string;
  language?: string;
  favoritesOnly?: boolean;
  compilationsOnly?: boolean;
}

/**
 * Mirrors desktop `detectLanguage` heuristics at the release level so mobile
 * language chips match the desktop Filter Shelf.
 */
export function detectReleaseLanguage(release: DbRelease): string {
  const genreStr = (release.genreTags || '').toLowerCase();
  if (genreStr) {
    if (/\b(hindi|bollywood)\b/i.test(genreStr)) return 'Hindi';
    if (/\b(tamil|kollywood)\b/i.test(genreStr)) return 'Tamil';
    if (/\b(telugu|tollywood)\b/i.test(genreStr)) return 'Telugu';
    if (/\b(malayalam|mollywood)\b/i.test(genreStr)) return 'Malayalam';
    if (/\b(kannada|sandalwood)\b/i.test(genreStr)) return 'Kannada';
  }

  if (release.folderPath) {
    const normPath = release.folderPath.replace(/\\/g, '/');
    if (/\/(hindi|bollywood)\//i.test(normPath)) return 'Hindi';
    if (/\/(tamil|kollywood)\//i.test(normPath)) return 'Tamil';
    if (/\/(telugu|tollywood)\//i.test(normPath)) return 'Telugu';
    if (/\/(malayalam|mollywood)\//i.test(normPath)) return 'Malayalam';
    if (/\/(kannada|sandalwood)\//i.test(normPath)) return 'Kannada';
  }

  const allText = [
    release.title,
    release.artistCredit,
    release.composerName,
    release.folderName,
    release.folderPath,
    release.genreTags,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/[\u0B80-\u0BFF]/.test(allText)) return 'Tamil';
  if (/[\u0900-\u097F]/.test(allText)) return 'Hindi';
  if (/[\u0D00-\u0D7F]/.test(allText)) return 'Malayalam';
  if (/[\u0C00-\u0C7F]/.test(allText)) return 'Telugu';
  if (/[\u0C80-\u0CFF]/.test(allText)) return 'Kannada';

  if (
    /\b(tamil|kollywood|amman|ilaiyaraaja|ilayaraja|illayaraja|m\.?\s*s\.?\s*v|viswanathan|vaali|vairamuthu|spb|s\.?\s*p\.?\s*balasubrahmanyam|chithra|janaki|anirudh|yuvan|harris jayaraj|deva|thiruvizha|nizhalgal|kizhakale|nayagan|thalapathi|mouna ragam|oriental)\b/i.test(
      allText,
    )
  ) {
    return 'Tamil';
  }

  if (
    /\b(hindi|bollywood|dil se|qawwali|lata|kishore|rafi|mohammed rafi|burman|rd burman|r\.?\s*d\.?\s*burman|asha|mukesh|kumar sanu|udit narayan|alka yagnik|sonu nigam)\b/i.test(
      allText,
    )
  ) {
    return 'Hindi';
  }

  if (
    /\b(malayalam|mollywood|yesudas|k\.?\s*j\.?\s*yesudas|raveendran|johnson|chemmeen|manichitrathazhu|chithra malayalam|mg sreekumar|sujatha)\b/i.test(
      allText,
    )
  ) {
    return 'Malayalam';
  }

  if (/\b(telugu|tollywood|ghantasala|keeravani|m\.?\s*m\.?\s*keeravani|veturi)\b/i.test(allText)) {
    return 'Telugu';
  }

  if (/\b(kannada|sandalwood|rajkumar|dr\.?\s*rajkumar|hamsalekha)\b/i.test(allText)) {
    return 'Kannada';
  }

  return 'English';
}

export function getAvailableLanguages(releases: DbRelease[]): string[] {
  const counts = new Map<string, number>();
  for (const rel of releases) {
    const lang = detectReleaseLanguage(rel);
    if (lang && lang.toLowerCase() !== 'unknown') {
      counts.set(lang, (counts.get(lang) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lang]) => lang);
}

export function matchesReleaseEra(year: number | null | undefined, era: string): boolean {
  if (!era) return true;
  if (!year || year <= 0) return false;
  const decadeMatch = era.match(/^(\d{4})s$/i);
  if (decadeMatch) {
    const start = parseInt(decadeMatch[1], 10);
    return year >= start && year <= start + 9;
  }
  return true;
}

export function matchesReleaseFormat(release: DbRelease, format: string): boolean {
  if (!format) return true;
  const upperFormats = (release.formats || []).map((f) => f.toUpperCase());
  const folderLower = (release.folderName || '').toLowerCase();

  switch (format) {
    case '24-bit Hi-Res':
      return (
        release.hasHighRes ||
        folderLower.includes('hi-res') ||
        folderLower.includes('24bit') ||
        folderLower.includes('flac 24')
      );
    case 'DSD':
      return (
        release.hasDsd ||
        upperFormats.some((f) => f === 'DSF' || f === 'DFF' || f === 'DSDIFF' || f.includes('DSD')) ||
        folderLower.includes('dsd')
      );
    case 'FLAC':
      return release.hasFlac || upperFormats.includes('FLAC') || folderLower.includes('flac');
    case 'WAV':
      return upperFormats.includes('WAV') || folderLower.includes('wav');
    case 'AIFF':
      return upperFormats.some((f) => f === 'AIFF' || f === 'AIF') || folderLower.includes('aiff');
    case 'ALAC':
      return upperFormats.some((f) => f === 'ALAC' || f === 'M4A') || folderLower.includes('alac');
    default:
      return upperFormats.includes(format.toUpperCase());
  }
}

export function filterAndSortReleases(
  releases: DbRelease[],
  searchQuery: string,
  facets: CatalogFacets,
  sortBy: SortBy,
): DbRelease[] {
  const q = searchQuery.trim().toLowerCase();

  const filtered = releases.filter((rel) => {
    if (q) {
      const matchesText =
        rel.title.toLowerCase().includes(q) ||
        rel.artistCredit.toLowerCase().includes(q) ||
        (rel.composerName ? rel.composerName.toLowerCase().includes(q) : false) ||
        (rel.formats ? rel.formats.some((f) => f.toLowerCase().includes(q)) : false);
      if (!matchesText) return false;
    }

    if (facets.favoritesOnly && !rel.isFavorite) return false;
    if (facets.compilationsOnly && !rel.isCompilation) return false;
    if (facets.era && !matchesReleaseEra(rel.releaseYear, facets.era)) return false;
    if (facets.format && !matchesReleaseFormat(rel, facets.format)) return false;
    if (facets.language && detectReleaseLanguage(rel).toLowerCase() !== facets.language.toLowerCase()) {
      return false;
    }

    return true;
  });

  return [...filtered].sort((a, b) => {
    switch (sortBy) {
      case 'year_desc':
        return (b.releaseYear || 0) - (a.releaseYear || 0) || a.title.localeCompare(b.title);
      case 'year_asc':
        return (a.releaseYear || 0) - (b.releaseYear || 0) || a.title.localeCompare(b.title);
      case 'artist_asc':
        return a.artistCredit.localeCompare(b.artistCredit) || a.title.localeCompare(b.title);
      case 'title_asc':
        return a.title.localeCompare(b.title);
      default:
        return 0;
    }
  });
}

