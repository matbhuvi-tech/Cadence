export interface CoreBuildInfo {
  tag: string
  commitsSinceTag: number
  commitSha: string
  commitDate: string
  commitSummary: string
  dirty: boolean
  display: string
}

export type CatalogDegradationCause =
  | 'unsupported_engine'
  | 'invalid_metadata'
  | 'payload_too_large'
  | 'connection_interrupted'
  | 'engine_busy'
  | 'unknown'

export interface CatalogHealth {
  status: 'healthy' | 'degraded'
  cause?: CatalogDegradationCause
  reason?: string
}

export function describeCatalogDegradation(cause: CatalogDegradationCause): string {
  switch (cause) {
    case 'unsupported_engine':
      return "Your Playback Engine is running an older version that doesn't provide full album artwork and track details. Update your Playback Engine to restore complete library info."
    case 'invalid_metadata':
      return "Some track details from your Playback Engine couldn't be read, so Cadence loaded a basic track list instead. Playback still works, but cover art and extra details may be missing."
    case 'payload_too_large':
      return "A batch of library details was too large to load in full, so Cadence loaded a basic track list instead. Playback still works, but cover art and extra details may be missing."
    case 'connection_interrupted':
      return 'The connection to your Playback Engine was interrupted while loading full album details, so Cadence loaded a basic track list instead. Try reconnecting to refresh.'
    case 'engine_busy':
      return 'Your Playback Engine paused full library loading while music is playing. Pause playback briefly and refresh to load complete cover art and track details.'
    default:
      return "Cadence couldn't load full album artwork and track details from your Playback Engine, so a basic track list was loaded instead. Playback still works normally."
  }
}

export interface EngineCompatibilityWarning {
  severity: 'warning' | 'info'
  reason: 'v2_catalog_degraded' | 'core_older' | 'engine_older' | 'build_mismatch'
  title: string
  detail: string
  coreBuild: CoreBuildInfo
  engineBuild: CoreBuildInfo | null
}

declare const __CADENCE_BUILD_INFO__: CoreBuildInfo | undefined

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

const CONVENTIONAL_TYPES = new Set([
  'feat',
  'fix',
  'chore',
  'refactor',
  'docs',
  'perf',
  'test',
  'build',
  'ci',
  'merge',
  'revert',
])

function stripControlChars(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) >= 32) {
      out += raw[i]
    }
  }
  return out.trim()
}

export function formatShortBuildDate(isoDate: string): string | null {
  const dateOnly = isoDate.trim().split(/[T ]/)[0]?.trim() ?? ''
  const parts = dateOnly.split('-')
  if (parts.length !== 3) return null
  const [year, monthStr, dayStr] = parts
  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(monthStr) || !/^\d{1,2}$/.test(dayStr)) {
    return null
  }
  const month = Number(monthStr)
  const day = Number(dayStr)
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  if (!Number.isInteger(day) || day < 1 || day > 31) return null
  return `${SHORT_MONTHS[month - 1]} ${day}`
}

export function cleanCommitSummary(rawSubject: string): string {
  const sanitized = stripControlChars(rawSubject)
  if (!sanitized) return ''

  let summary = sanitized
  const colonIdx = sanitized.indexOf(':')
  if (colonIdx !== -1) {
    const rawPrefix = sanitized.slice(0, colonIdx).trim().replace(/!$/, '').trim()
    const restTrimmed = sanitized.slice(colonIdx + 1).trim()
    if (restTrimmed) {
      const openParen = rawPrefix.indexOf('(')
      if (openParen !== -1 && rawPrefix.endsWith(')')) {
        const kind = rawPrefix.slice(0, openParen).trim().toLowerCase()
        const scope = rawPrefix.slice(openParen + 1, -1).trim()
        if (CONVENTIONAL_TYPES.has(kind) && scope && !scope.includes('(')) {
          summary = `${scope}: ${restTrimmed}`
        }
      } else if (CONVENTIONAL_TYPES.has(rawPrefix.toLowerCase())) {
        summary = restTrimmed
      }
    }
  }

  const chars = Array.from(summary)
  if (chars.length > 56) {
    let earliestIdx = -1
    for (const sep of [', ', ' — ']) {
      const idx = summary.indexOf(sep)
      if (idx !== -1) {
        const left = summary.slice(0, idx).trim()
        if (Array.from(left).length >= 16 && (earliestIdx === -1 || idx < earliestIdx)) {
          earliestIdx = idx
        }
      }
    }
    if (earliestIdx !== -1) {
      summary = summary.slice(0, earliestIdx).trim()
    }
  }

  const finalChars = Array.from(summary)
  if (finalChars.length > 64) {
    let truncated = finalChars.slice(0, 63).join('')
    const lastSpace = truncated.lastIndexOf(' ')
    if (lastSpace !== -1 && Array.from(truncated.slice(0, lastSpace)).length >= 20) {
      truncated = truncated.slice(0, lastSpace)
    }
    truncated = truncated.replace(/[\s,;:_-]+$/, '')
    return `${truncated}…`
  }
  return summary
}

export function formatBuildDisplay(input: {
  tag: string
  commitsSinceTag: number
  commitDate: string
  commitSha: string
  dirty: boolean
  pkgVersion?: string
}): string {
  const tag = input.tag.trim()
  const commitSha = input.commitSha.trim()
  const shortDate = formatShortBuildDate(input.commitDate)
  const dirtySuffix = input.dirty ? ' · local' : ''

  if (tag) {
    if (input.commitsSinceTag === 0) {
      return `${tag}${dirtySuffix}`
    }
    return shortDate
      ? `${tag} +${input.commitsSinceTag} · ${shortDate}${dirtySuffix}`
      : `${tag} +${input.commitsSinceTag}${dirtySuffix}`
  }

  const pkg = (input.pkgVersion ?? '0.1.0').trim() || '0.1.0'
  const base = pkg.startsWith('v') ? pkg : `v${pkg}`
  const hasSha = Boolean(commitSha) && commitSha !== 'unknown'
  if (hasSha && shortDate) return `${base} (${commitSha} · ${shortDate})${dirtySuffix}`
  if (hasSha) return `${base} (${commitSha})${dirtySuffix}`
  if (shortDate) return `${base} (${shortDate})${dirtySuffix}`
  return `${base}${dirtySuffix}`
}

const DEV_FALLBACK_BUILD_INFO: CoreBuildInfo = {
  tag: 'v0.1.0',
  commitsSinceTag: 0,
  commitSha: 'dev',
  commitDate: '',
  commitSummary: '',
  dirty: false,
  display: 'v0.1.0 (dev)',
}

export const CORE_BUILD_INFO: CoreBuildInfo =
  typeof __CADENCE_BUILD_INFO__ !== 'undefined' && __CADENCE_BUILD_INFO__
    ? __CADENCE_BUILD_INFO__
    : DEV_FALLBACK_BUILD_INFO

function isKnownCommitSha(sha: string): boolean {
  const trimmed = sha.trim()
  return Boolean(trimmed) && trimmed !== 'unknown' && trimmed !== 'dev'
}

export function evaluateEngineCompatibility(params: {
  coreBuild: CoreBuildInfo
  coreProtocolRevision: number
  engineBuild?: CoreBuildInfo | null
  engineProtocolVersion?: number | null
  engineProtocolRevision?: number | null
  v2CatalogDegraded?: boolean
  v2CatalogDegradedReason?: string | null
}): EngineCompatibilityWarning | null {
  const {
    coreBuild,
    coreProtocolRevision,
    engineBuild = null,
    engineProtocolVersion = null,
    engineProtocolRevision = null,
    v2CatalogDegraded = false,
    v2CatalogDegradedReason = null,
  } = params

  if (v2CatalogDegraded) {
    return {
      severity: 'warning',
      reason: 'v2_catalog_degraded',
      title: 'Catalog health degraded',
      detail: v2CatalogDegradedReason || describeCatalogDegradation('unknown'),
      coreBuild,
      engineBuild,
    }
  }

  if (engineProtocolVersion === 2 && typeof engineProtocolRevision === 'number') {
    if (engineProtocolRevision > coreProtocolRevision) {
      const engineLabel = engineBuild?.display ?? 'newer build'
      return {
        severity: 'warning',
        reason: 'core_older',
        title: 'Cadence Core update recommended',
        detail: `Cadence Core (${coreBuild.display}) is older than your Playback Engine (${engineLabel}). Update Cadence Core to avoid missing features.`,
        coreBuild,
        engineBuild,
      }
    }
    if (engineProtocolRevision < coreProtocolRevision) {
      const engineLabel = engineBuild?.display ?? 'older build'
      return {
        severity: 'warning',
        reason: 'engine_older',
        title: 'Playback Engine update recommended',
        detail: `Your Playback Engine (${engineLabel}) is older than Cadence Core (${coreBuild.display}). Update Playback Engine for the latest features.`,
        coreBuild,
        engineBuild,
      }
    }
  }

  if (engineProtocolVersion === 2 && engineProtocolRevision == null && !engineBuild) {
    return {
      severity: 'warning',
      reason: 'engine_older',
      title: 'Playback Engine update recommended',
      detail: `Your Playback Engine predates version reporting (Cadence Core is ${coreBuild.display}). Update Playback Engine to keep features in sync.`,
      coreBuild,
      engineBuild: null,
    }
  }

  if (
    engineBuild &&
    isKnownCommitSha(coreBuild.commitSha) &&
    isKnownCommitSha(engineBuild.commitSha) &&
    coreBuild.commitSha !== engineBuild.commitSha
  ) {
    let detail: string
    if (
      coreBuild.tag === engineBuild.tag &&
      coreBuild.commitsSinceTag !== engineBuild.commitsSinceTag
    ) {
      detail =
        coreBuild.commitsSinceTag > engineBuild.commitsSinceTag
          ? `Cadence Core (${coreBuild.display}) is ahead of Playback Engine (${engineBuild.display}).`
          : `Playback Engine (${engineBuild.display}) is ahead of Cadence Core (${coreBuild.display}).`
    } else {
      detail = `Cadence Core (${coreBuild.display}) and Playback Engine (${engineBuild.display}) are running different builds.`
    }
    return {
      severity: 'info',
      reason: 'build_mismatch',
      title: 'Different build',
      detail,
      coreBuild,
      engineBuild,
    }
  }

  return null
}
