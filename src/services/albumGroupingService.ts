import { Release } from '../core/types'

export interface GroupedReleaseCard {
  masterRelease: Release
  constituentReleases: Release[]
  discCount: number
  isSplit: boolean
  groupKey: string
}

export interface DiscInfo {
  baseTitle: string
  discNumber: number
  totalDiscs?: number
  hasDiscIndicator: boolean
}

/**
 * Extracts disc index and canonical base album title by stripping disc indicators.
 * Handles patterns such as:
 * - "Rahmania CD1", "Rahmania CD 2", "Rahmania CD03"
 * - "Signature Collection 2 - CD2", "Signature Collection 2 - CD3"
 * - "The Wall (Disc 1)", "The Wall [Disc 2 of 2]"
 * - "Live in Tokyo, CD 2", "Live in Tokyo: Disc 1"
 */
export function extractDiscInfo(rawTitle: string): DiscInfo {
  if (!rawTitle) {
    return { baseTitle: '', discNumber: 1, hasDiscIndicator: false }
  }

  // 1. Strip digital rip noise like [FLAC], (2013), [WAV], etc.
  const clean = rawTitle
    .replace(/\b(?:cd\s*rip|dvd\s*rip|web\s*rip|vinyl\s*rip|cassette\s*rip|flac\s*rip|sacd\s*rip)\b/gi, '')
    .replace(/\[\s*(?:flac|wav|alac|dsd\d*|mp3|aac|hi-?res|24bit|16bit|\d{1,3}[-/]\d{1,3}(?:\.\d)?|\d{2,4}khz|audio|master)\s*\]/gi, '')
    .replace(/\(\s*(?:flac|wav|alac|dsd\d*|mp3|aac|hi-?res|24bit|16bit|\d{1,3}[-/]\d{1,3}(?:\.\d)?|\d{2,4}khz|audio|master)\s*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

  // 2. Bracketed disc indicators: e.g. "(Disc 1)", "[CD 2]", "(Disc 1 of 2)"
  const bracketMatch = clean.match(
    /[\s\-_–—,:]*[\(\[\{]\s*(?:cd|disc|disk)\s*(\d+)(?:\s*(?:of|\/)\s*(\d+))?\s*[\)\]\}]\s*$/i
  )
  if (bracketMatch && bracketMatch.index !== undefined) {
    const baseTitle = clean.slice(0, bracketMatch.index).trim().replace(/[\s\-_–—,:]+$/, '')
    const discNumber = parseInt(bracketMatch[1], 10)
    const totalDiscs = bracketMatch[2] ? parseInt(bracketMatch[2], 10) : undefined
    return {
      baseTitle: baseTitle || clean,
      discNumber: isNaN(discNumber) ? 1 : discNumber,
      totalDiscs,
      hasDiscIndicator: true,
    }
  }

  // 3. Separator + disc indicator: e.g. "Signature Collection 2 - CD2", ", Disc 1", ": CD 2"
  const sepMatch = clean.match(
    /[\s\-_–—,:]+(?:cd|disc|disk)\s*(\d+)(?:\s*(?:of|\/)\s*(\d+))?\s*$/i
  )
  if (sepMatch && sepMatch.index !== undefined) {
    const baseTitle = clean.slice(0, sepMatch.index).trim().replace(/[\s\-_–—,:]+$/, '')
    const discNumber = parseInt(sepMatch[1], 10)
    const totalDiscs = sepMatch[2] ? parseInt(sepMatch[2], 10) : undefined
    return {
      baseTitle: baseTitle || clean,
      discNumber: isNaN(discNumber) ? 1 : discNumber,
      totalDiscs,
      hasDiscIndicator: true,
    }
  }

  // 4. Trailing whitespace + CD/Disc: e.g. "Rahmania CD1", "Rahmania CD 2", "Rahmania Disc 3"
  const spaceMatch = clean.match(
    /\s+(?:cd|disc|disk)\s*(\d+)(?:\s*(?:of|\/)\s*(\d+))?\s*$/i
  )
  if (spaceMatch && spaceMatch.index !== undefined) {
    const baseTitle = clean.slice(0, spaceMatch.index).trim().replace(/[\s\-_–—,:]+$/, '')
    const discNumber = parseInt(spaceMatch[1], 10)
    const totalDiscs = spaceMatch[2] ? parseInt(spaceMatch[2], 10) : undefined
    return {
      baseTitle: baseTitle || clean,
      discNumber: isNaN(discNumber) ? 1 : discNumber,
      totalDiscs,
      hasDiscIndicator: true,
    }
  }

  return {
    baseTitle: clean,
    discNumber: 1,
    hasDiscIndicator: false,
  }
}

/**
 * Normalizes title string for structural grouping comparison.
 */
export function normalizeTitleForGrouping(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Normalizes artist credit string, stripping dots, hyphens, and whitespace variance.
 * Ensures "A. R. Rahman", "A.R. Rahman", and "AR Rahman" resolve to the identical grouping key.
 */
export function normalizeArtistForGrouping(artist: string): string {
  return artist
    .toLowerCase()
    .replace(/[\.\-_–—,']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b([a-z])\s+(?=[a-z]\b)/gi, '$1')
}

/**
 * Generates grouping key using two-tier confidence hierarchy:
 * Tier 1: MusicBrainz Release Group ID or masterReleaseId if non-empty and valid.
 * Tier 2: Normalized artist credit + canonical base album title (disc suffixes stripped).
 */
export function computeGroupingKey(release: Release): string {
  // Tier 1: Dedicated master/group ID (e.g. from MusicBrainz)
  if (release.masterReleaseId && release.masterReleaseId.trim() !== '' && release.masterReleaseId !== release.id) {
    return `mbid:${release.masterReleaseId.trim().toLowerCase()}`
  }
  // Tier 2: Structural Artist + Canonical Base Album Title (disc suffixes stripped)
  const discInfo = extractDiscInfo(release.title || '')
  const normTitle = normalizeTitleForGrouping(discInfo.baseTitle)
  const normArtist = normalizeArtistForGrouping(release.artistCredit || '')
  return `group:${normArtist}::${normTitle}`
}

/**
 * Groups a collection of releases into unified multi-disc cards,
 * excluding releases present in splitReleaseIds.
 */
export function groupAlbumReleases(
  releases: Release[],
  splitReleaseIds: Set<string> = new Set()
): GroupedReleaseCard[] {
  const groups = new Map<string, Release[]>()

  for (const rel of releases) {
    const key = computeGroupingKey(rel)
    // If this release key or individual release ID is in splitReleaseIds, it is kept separate
    const isSplit = splitReleaseIds.has(rel.id) || splitReleaseIds.has(key)

    if (isSplit) {
      groups.set(`split:${rel.id}`, [rel])
    } else {
      if (!groups.has(key)) {
        groups.set(key, [])
      }
      groups.get(key)!.push(rel)
    }
  }

  const result: GroupedReleaseCard[] = []

  for (const [groupKey, constituent] of groups.entries()) {
    if (constituent.length === 0) continue

    const isSplit =
      groupKey.startsWith('split:') ||
      splitReleaseIds.has(groupKey) ||
      splitReleaseIds.has(constituent[0].id)

    // Sort constituent releases by disc number (ascending), prioritizing releases with artwork
    const sorted = [...constituent].sort((a, b) => {
      const aArt = (a.artwork?.frontCoverUrl || a.coverArtUrl) ? 1 : 0
      const bArt = (b.artwork?.frontCoverUrl || b.coverArtUrl) ? 1 : 0
      if (aArt !== bArt) return bArt - aArt

      const aDisc = extractDiscInfo(a.title || '').discNumber || a.discsCount || 1
      const bDisc = extractDiscInfo(b.title || '').discNumber || b.discsCount || 1
      if (aDisc !== bDisc) return aDisc - bDisc
      return (a.releaseYear || 0) - (b.releaseYear || 0)
    })

    const primary = sorted[0]
    const totalTracks = constituent.reduce((sum, r) => sum + (r.tracksCount || 0), 0)

    // Determine total disc count from constituent count or parsed disc numbers
    const maxDiscNum = Math.max(...constituent.map((r) => extractDiscInfo(r.title || '').discNumber))
    const totalDiscsFromMetadata = Math.max(...constituent.map((r) => extractDiscInfo(r.title || '').totalDiscs || r.discsCount || 1))
    const discCount = Math.max(constituent.length, maxDiscNum, totalDiscsFromMetadata)

    // For multi-disc sets, use canonical base title without disc indicator
    const canonicalTitle = constituent.length > 1
      ? extractDiscInfo(primary.title || '').baseTitle
      : primary.title

    const masterRelease: Release = {
      ...primary,
      title: canonicalTitle || primary.title,
      discsCount: discCount,
      tracksCount: totalTracks > 0 ? totalTracks : primary.tracksCount,
    }

    result.push({
      masterRelease,
      constituentReleases: constituent,
      discCount,
      isSplit,
      groupKey,
    })
  }

  return result
}
