import { Track, Release, Person, FacetSelections, AudioFormat } from './types'
import {
  KNOWN_COMPOSERS,
  canonicalizeComposer,
  KNOWN_ARTISTS,
  getCuratedAlbumArtwork,
} from './taxonomyUtils'

export interface CatalogAlbumMatch {
  type: 'album'
  id: string
  title: string
  artistCredit: string
  composerName?: string
  releaseYear?: number
  tracksCount: number
  formatBadge: string
  artworkUrl?: string
  release: Release
}

export interface CatalogTrackMatch {
  type: 'track'
  id: string
  title: string
  albumTitle: string
  releaseId: string
  artistCredit: string
  composerName?: string
  trackNumber?: number
  formatBadge: string
  track: Track
}

export interface CatalogArtistMatch {
  type: 'artist'
  id: string
  name: string
  role: 'Composer' | 'Artist' | 'Performer'
  albumsCount: number
  tracksCount: number
  portraitUrl?: string
}

export type CatalogEntityMatch = CatalogAlbumMatch | CatalogTrackMatch | CatalogArtistMatch

export interface FilterPill {
  label: string
  value: string
  key: keyof FacetSelections
}

export interface ParsedFacetIntent {
  facets: FacetSelections
  residualQuery: string
  pills: FilterPill[]
}

export interface SystemCommandItem {
  id: string
  title: string
  category: 'ACTION' | 'NAVIGATION' | 'SAFETY' | 'AUDIT' | 'HELP'
  shortcut?: string
  icon: any
  action: () => void
  isToggle?: boolean
}

export type OmnibarRowItem =
  | { kind: 'album'; entity: CatalogAlbumMatch }
  | { kind: 'track'; entity: CatalogTrackMatch }
  | { kind: 'artist'; entity: CatalogArtistMatch }
  | { kind: 'facet'; intent: ParsedFacetIntent }
  | { kind: 'command'; command: SystemCommandItem }
  | { kind: 'agent'; prompt: string; isTopPriority: boolean }

export interface IntentBadgeState {
  label: string
  intentType: 'command_center' | 'catalog' | 'facet' | 'system' | 'ai'
  variant: 'neutral' | 'emerald' | 'cyan' | 'purple' | 'gold'
}

export interface ClassifiedSearchState {
  rawQuery: string
  cleanQuery: string
  badge: IntentBadgeState
  rows: OmnibarRowItem[]
  hasDirectEntityHits: boolean
  isAgentElevated: boolean
  isCommandOnlyMode: boolean
}

const ACTION_VERBS = new Set([
  'find',
  'fetch',
  'clean',
  'audit',
  'organize',
  'fix',
  'stage',
  'canonicalize',
  'show',
  'why',
  'how',
  'check',
  'detect',
  'analyze',
  'remediate',
])

/**
 * Derives a clean format & resolution badge string (e.g., "FLAC 24/96", "DSD64", "WAV 16/44.1")
 */
export function deriveFormatBadge(format?: string, sampleRateStr?: string, bitDepth?: number): string {
  const fmt = (format || 'FLAC').toUpperCase()
  const sRate = (sampleRateStr || '').trim()

  if (fmt.includes('DSD') || sRate.includes('DSD')) {
    if (sRate.includes('DSD256')) return 'DSD256 (11.3MHz)'
    if (sRate.includes('DSD128')) return 'DSD128 (5.6MHz)'
    if (sRate.includes('DSD64')) return 'DSD64 (2.8MHz)'
    return sRate || 'DSD'
  }

  const depthStr = bitDepth ? `${bitDepth}-bit` : ''
  if (sRate) {
    return depthStr ? `${fmt} ${depthStr} · ${sRate}` : `${fmt} ${sRate}`
  }
  return fmt
}

export interface CanonicalEntityCandidate {
  id: string
  name: string
  sortName?: string
  role?: string
  aliases?: string[]
}

/**
 * Synchronous regex and token parser detecting schema attribute tokens in user input.
 * Resolves formats, recording eras, DR scores, composers, and languages.
 * Dynamically matches against library canonical persons/composers.
 */
export function parseFacetTokens(
  rawQuery: string,
  dynamicCandidates?: CanonicalEntityCandidate[]
): ParsedFacetIntent | null {
  const trimmed = rawQuery.trim()
  if (!trimmed) return null

  let remaining = trimmed
  const facets: FacetSelections = {}
  const pills: FilterPill[] = []

  // 1. Audio Formats
  const formatRegex = /\b(flac|dsd(?:64|128|256|512|1024)?|wav|alac|mp3|aac|aiff|hi-?res|24-?bit)\b/i
  const formatMatch = remaining.match(formatRegex)
  if (formatMatch) {
    const rawFmt = formatMatch[1].toUpperCase()
    let resolvedFormat = rawFmt
    if (rawFmt === '24-BIT' || rawFmt === '24BIT' || rawFmt.includes('HI-RES') || rawFmt.includes('HIRES')) {
      resolvedFormat = 'FLAC'
      pills.push({ label: 'Format', value: 'Hi-Res Lossless', key: 'format' })
    } else {
      pills.push({ label: 'Format', value: resolvedFormat, key: 'format' })
    }
    facets.format = resolvedFormat
    remaining = remaining.replace(formatMatch[0], ' ')
  }

  // 2. Eras
  const eraRegex = /\b(19[5-9]0s|20[0-2]0s|[5-9]0s|00s|10s|earlier-1970)\b/i
  const eraMatch = remaining.match(eraRegex)
  if (eraMatch) {
    const rawEra = eraMatch[1].toLowerCase()
    let eraBucket = '1991-2000'
    let displayLabel = '1990s'

    if (rawEra === '70s' || rawEra === '1970s') {
      eraBucket = '1971-1980'
      displayLabel = '1970s'
    } else if (rawEra === '80s' || rawEra === '1980s') {
      eraBucket = '1981-1990'
      displayLabel = '1980s'
    } else if (rawEra === '90s' || rawEra === '1990s') {
      eraBucket = '1991-2000'
      displayLabel = '1990s'
    } else if (rawEra === '00s' || rawEra === '2000s') {
      eraBucket = '2001-2010'
      displayLabel = '2000s'
    } else if (rawEra === '10s' || rawEra === '2010s' || rawEra === '2020s') {
      eraBucket = '2010-present'
      displayLabel = '2010s+'
    } else if (rawEra === 'earlier-1970' || rawEra === '50s' || rawEra === '60s') {
      eraBucket = 'earlier-1970'
      displayLabel = '≤ 1970'
    }

    facets.era = eraBucket
    pills.push({ label: 'Era', value: displayLabel, key: 'era' })
    remaining = remaining.replace(eraMatch[0], ' ')
  }

  // 3. Dynamic Range
  const drRegex = /\b(?:dr\s*(?:>=?|>|:)?\s*(\d+)|high\s*dr)\b/i
  const drMatch = remaining.match(drRegex)
  if (drMatch) {
    const score = drMatch[1] ? parseInt(drMatch[1], 10) : 12
    facets.mastering = `DR >= ${score}`
    pills.push({ label: 'Dynamic Range', value: `DR ≥ ${score}`, key: 'mastering' })
    remaining = remaining.replace(drMatch[0], ' ')
  }

  // 4. Dynamic Library Canonical Composers & Artists
  let matchedPerson = false
  if (dynamicCandidates && dynamicCandidates.length > 0) {
    for (const cand of dynamicCandidates) {
      if (!cand.name) continue
      const namesToTest = [cand.name, ...(cand.aliases || [])]
      const hit = namesToTest.some((n) => {
        if (!n || n.length < 3) return false
        const escaped = n.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
        const regex = new RegExp(`\\b${escaped}\\b`, 'i')
        return regex.test(remaining)
      })

      if (hit) {
        matchedPerson = true
        const isComp = (cand.role || '').toLowerCase().includes('composer')
        const roleLabel = isComp ? 'Composer' : 'Artist'
        facets.composer = cand.name
        pills.push({ label: roleLabel, value: cand.name, key: 'composer' })

        for (const n of namesToTest) {
          const r = new RegExp(`\\b${n.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'gi')
          remaining = remaining.replace(r, ' ')
        }
        break
      }
    }
  }

  // Fallback to built-in taxonomy authorities if no dynamic candidate matched
  if (!matchedPerson) {
    for (const comp of KNOWN_COMPOSERS) {
      const matchesAlias = comp.aliases.some((alias) => {
        const aliasRegex = new RegExp(`\\b${alias.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i')
        return aliasRegex.test(remaining)
      })

      if (matchesAlias) {
        facets.composer = comp.canonicalName
        pills.push({ label: 'Composer', value: comp.canonicalName, key: 'composer' })
        for (const alias of comp.aliases) {
          const r = new RegExp(`\\b${alias.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'gi')
          remaining = remaining.replace(r, ' ')
        }
        break
      }
    }
  }

  // 5. Languages
  const langRegex = /\b(tamil|hindi|malayalam|telugu|kannada|english|carnatic|hindustani)\b/i
  const langMatch = remaining.match(langRegex)
  if (langMatch) {
    const capLang = langMatch[1].charAt(0).toUpperCase() + langMatch[1].slice(1).toLowerCase()
    facets.language = capLang
    pills.push({ label: 'Language', value: capLang, key: 'language' })
    remaining = remaining.replace(langMatch[0], ' ')
  }

  const residualQuery = remaining.replace(/\s+/g, ' ').trim()

  if (pills.length === 0) {
    return null
  }

  return {
    facets,
    residualQuery,
    pills,
  }
}

/**
 * Main Deterministic 4-Tier Intent Classifier:
 * Integrates direct entity hits, token/regex facet pills, fuzzy system commands, and AI Copilot fallback.
 */
export function classifySearchIntent(params: {
  rawQuery: string
  entityHits: {
    albums: CatalogAlbumMatch[]
    tracks: CatalogTrackMatch[]
    artists: CatalogArtistMatch[]
  }
  facetIntent: ParsedFacetIntent | null
  commands: SystemCommandItem[]
  mode: 'search' | 'agent'
}): ClassifiedSearchState {
  const { rawQuery, entityHits, facetIntent, commands, mode } = params
  const trimmed = rawQuery.trim()

  // 1. Prefix Scoping Check: ">" forces pure System Command mode
  const isCommandOnlyMode = trimmed.startsWith('>')
  const cleanCmdQuery = isCommandOnlyMode ? trimmed.slice(1).trim().toLowerCase() : trimmed.toLowerCase()

  // Filter commands
  const filteredCommands = commands.filter((cmd) => {
    if (!cleanCmdQuery) return true
    return (
      cmd.title.toLowerCase().includes(cleanCmdQuery) ||
      cmd.category.toLowerCase().includes(cleanCmdQuery) ||
      (cmd.shortcut && cmd.shortcut.toLowerCase().includes(cleanCmdQuery))
    )
  })

  if (isCommandOnlyMode) {
    const rows: OmnibarRowItem[] = filteredCommands.map((command) => ({
      kind: 'command',
      command,
    }))
    return {
      rawQuery,
      cleanQuery: cleanCmdQuery,
      badge: {
        label: cleanCmdQuery ? `System Action (${filteredCommands.length})` : 'System Commands',
        intentType: 'system',
        variant: 'purple',
      },
      rows,
      hasDirectEntityHits: false,
      isAgentElevated: false,
      isCommandOnlyMode: true,
    }
  }

  // 2. Explicit Agent Prefix Check: "?" or "/ai"
  const isExplicitAgent =
    mode === 'agent' ||
    trimmed.startsWith('?') ||
    trimmed.startsWith('/ai ') ||
    trimmed === '/ai'

  const cleanAgentQuery = trimmed.replace(/^(\?|\/ai\s*)/i, '').trim()

  // 3. Count entity matches
  const totalEntityCount =
    entityHits.albums.length + entityHits.tracks.length + entityHits.artists.length
  const hasDirectEntityHits = totalEntityCount > 0

  // 4. Natural language diagnostic query heuristic
  const words = trimmed.split(/\s+/).filter(Boolean)
  const isDiagnosticNL =
    words.length >= 3 &&
    ACTION_VERBS.has(words[0].toLowerCase()) &&
    !hasDirectEntityHits

  const isAgentElevated = isExplicitAgent || isDiagnosticNL

  // Assemble grouped rows
  const rows: OmnibarRowItem[] = []

  // If agent is elevated to #0:
  if (isAgentElevated) {
    rows.push({
      kind: 'agent',
      prompt: cleanAgentQuery || trimmed || 'Ask Cadence Agent Copilot',
      isTopPriority: true,
    })
  }

  // Tier 1: Direct Catalog Entities (Albums -> Tracks -> Artists)
  if (!isExplicitAgent) {
    entityHits.albums.forEach((entity) => rows.push({ kind: 'album', entity }))
    entityHits.tracks.forEach((entity) => rows.push({ kind: 'track', entity }))
    entityHits.artists.forEach((entity) => rows.push({ kind: 'artist', entity }))
  }

  // Tier 2: Actionable Facet Filter Row
  if (facetIntent && facetIntent.pills.length > 0 && !isExplicitAgent) {
    rows.push({ kind: 'facet', intent: facetIntent })
  }

  // Tier 3: Matching System Commands
  if (!isExplicitAgent && cleanCmdQuery) {
    filteredCommands.forEach((command) => rows.push({ kind: 'command', command }))
  } else if (!isExplicitAgent && !cleanCmdQuery) {
    // When input is empty, show standard system commands
    commands.forEach((command) => rows.push({ kind: 'command', command }))
  }

  // Tier 4: Bottom-Pinned Cadence Copilot Handover (if not already elevated to #0)
  if (!isAgentElevated && trimmed.length > 0) {
    rows.push({
      kind: 'agent',
      prompt: trimmed,
      isTopPriority: false,
    })
  }

  // Compute Intent Badge
  let badge: IntentBadgeState
  if (!trimmed) {
    badge = { label: 'Command Center', intentType: 'command_center', variant: 'neutral' }
  } else if (isAgentElevated) {
    badge = { label: 'AI Agent Query', intentType: 'ai', variant: 'gold' }
  } else if (hasDirectEntityHits) {
    const albumCount = entityHits.albums.length
    const trackCount = entityHits.tracks.length
    const artistCount = entityHits.artists.length
    const parts: string[] = []
    if (albumCount > 0) parts.push(`${albumCount} Album${albumCount > 1 ? 's' : ''}`)
    if (trackCount > 0) parts.push(`${trackCount} Track${trackCount > 1 ? 's' : ''}`)
    if (artistCount > 0) parts.push(`${artistCount} Artist${artistCount > 1 ? 's' : ''}`)
    badge = {
      label: `Catalog Match (${parts.join(', ')})`,
      intentType: 'catalog',
      variant: 'emerald',
    }
  } else if (facetIntent && facetIntent.pills.length > 0) {
    badge = { label: 'Facet Filter', intentType: 'facet', variant: 'cyan' }
  } else if (filteredCommands.length > 0) {
    badge = { label: 'System Action', intentType: 'system', variant: 'purple' }
  } else {
    badge = { label: 'AI Agent Query', intentType: 'ai', variant: 'gold' }
  }

  return {
    rawQuery,
    cleanQuery: trimmed,
    badge,
    rows,
    hasDirectEntityHits,
    isAgentElevated,
    isCommandOnlyMode: false,
  }
}
