import { Release } from '../core/types'
import { cleanRipNoise } from '../core/taxonomyUtils'
export { cleanRipNoise }

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
 * Calculates Jaro-Winkler string similarity (0.0 to 1.0).
 */
export function jaroWinklerSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0
  if (!s1 || !s2) return 0.0

  const str1 = s1.toLowerCase().trim()
  const str2 = s2.toLowerCase().trim()
  if (str1 === str2) return 1.0

  const len1 = str1.length
  const len2 = str2.length
  const matchDistance = Math.floor(Math.max(len1, len2) / 2) - 1

  const s1Matches = new Array(len1).fill(false)
  const s2Matches = new Array(len2).fill(false)

  let matches = 0
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance)
    const end = Math.min(i + matchDistance + 1, len2)

    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue
      if (str1[i] !== str2[j]) continue
      s1Matches[i] = true
      s2Matches[j] = true
      matches++
      break
    }
  }

  if (matches === 0) return 0.0

  let transpositions = 0
  let k = 0
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue
    while (!s2Matches[k]) k++
    if (str1[i] !== str2[k]) transpositions++
    k++
  }

  const jaro =
    (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3

  // Winkler prefix scale (max 4 chars)
  let prefix = 0
  for (let i = 0; i < Math.min(4, len1, len2); i++) {
    if (str1[i] === str2[i]) prefix++
    else break
  }

  return jaro + prefix * 0.1 * (1 - jaro)
}

/**
 * Extracts disc index and canonical base album title by stripping disc indicators.
 */
export function extractDiscInfo(rawTitle: string): DiscInfo {
  if (!rawTitle) {
    return { baseTitle: '', discNumber: 1, hasDiscIndicator: false }
  }

  // 1. Strip digital rip noise like [FLAC], (2013), [WAV], etc.
  const clean = cleanRipNoise(rawTitle)

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
  return cleanRipNoise(title)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
}

/**
 * Normalizes artist credit string, stripping dots, hyphens, and whitespace variance.
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
  // Tier 1: Dedicated master/group ID (e.g. from MusicBrainz or user override)
  if (release.masterReleaseId && release.masterReleaseId.trim() !== '' && release.masterReleaseId !== release.id) {
    return `mbid:${release.masterReleaseId.trim().toLowerCase()}`
  }
  // Tier 2: Structural Artist + Canonical Base Album Title (disc suffixes and rip tags stripped)
  const discInfo = extractDiscInfo(release.title || '')
  const normTitle = normalizeTitleForGrouping(discInfo.baseTitle)
  const normArtist = normalizeArtistForGrouping(release.composerName || release.artistCredit || '')
  return `group:${normArtist}::${normTitle}`
}

/**
 * Groups a collection of releases into unified multi-disc cards,
 * with bounded fuzzy agglomerative clustering (Jaro-Winkler >= 0.88, |Δtracks| <= 1).
 */
export function groupAlbumReleases(
  releases: Release[],
  splitReleaseIds: Set<string> = new Set()
): GroupedReleaseCard[] {
  const groups = new Map<string, Release[]>()

  for (const rel of releases) {
    const key = computeGroupingKey(rel)
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

  // Bounded Pairwise Agglomerative Fuzzy Clustering for typo/rip variants
  const groupKeys = Array.from(groups.keys()).filter((k) => !k.startsWith('split:') && !k.startsWith('mbid:'))
  const mergedInto = new Map<string, string>()

  const isUnknownArtist = (artist: string) =>
    !artist || /^(unknown artist|unknown|various artists|various)$/i.test(artist.trim())

  for (let i = 0; i < groupKeys.length; i++) {
    const keyA = groupKeys[i]
    const rootA = mergedInto.get(keyA) || keyA
    const relsA = groups.get(rootA)
    if (!relsA || relsA.length === 0) continue

    const [artistA, titleA] = keyA.replace(/^group:/, '').split('::')

    for (let j = i + 1; j < groupKeys.length; j++) {
      const keyB = groupKeys[j]
      const rootB = mergedInto.get(keyB) || keyB
      if (rootA === rootB) continue

      const relsB = groups.get(rootB)
      if (!relsB || relsB.length === 0) continue

      const [artistB, titleB] = keyB.replace(/^group:/, '').split('::')

      // 1. Artist / Composer check
      const artistsMatch =
        artistA === artistB || isUnknownArtist(artistA) || isUnknownArtist(artistB)
      if (!artistsMatch) continue

      // 2. Jaro-Winkler Title similarity check (>= 0.88)
      const sim = jaroWinklerSimilarity(titleA, titleB)
      if (sim < 0.88) continue

      // 3. Track count check (|Δtracks| <= 1 when track counts are known)
      const repA = relsA[0]
      const repB = relsB[0]
      const tracksA = repA.tracksCount || 0
      const tracksB = repB.tracksCount || 0
      if (tracksA > 0 && tracksB > 0 && Math.abs(tracksA - tracksB) > 1) {
        continue
      }

      // Merge rootB into rootA
      relsA.push(...relsB)
      groups.delete(rootB)
      mergedInto.set(keyB, rootA)
      mergedInto.set(rootB, rootA)
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

    const maxDiscNum = Math.max(...constituent.map((r) => extractDiscInfo(r.title || '').discNumber))
    const totalDiscsFromMetadata = Math.max(...constituent.map((r) => extractDiscInfo(r.title || '').totalDiscs || r.discsCount || 1))
    const discCount = Math.max(constituent.length, maxDiscNum, totalDiscsFromMetadata)

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

