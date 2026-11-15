export type LibraryOnboardingChoice = 'start_new_library' | 'import_existing_library'

export interface RootPathMapping {
  windowsPrefix: string
  corePrefix: string
}

export interface SnapshotOnboardingSummaryInput {
  mode: LibraryOnboardingChoice
  mappedTracksCount: number
  unmappedRootsCount: number
  caseMismatchCount: number
  suppressedPendingJobs: number
}

export interface SnapshotOnboardingSummary {
  mode: LibraryOnboardingChoice
  implicitBidirectionalSync: false
  summaryText: string
}

function normalizeSlashes(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function mapWindowsPathToCorePath(
  sourcePath: string,
  mappings: readonly RootPathMapping[],
): string | null {
  const normSrc = normalizeSlashes(sourcePath)
  const lowerSrc = normSrc.toLowerCase()

  let bestLength = -1
  let bestMapping: RootPathMapping | null = null
  for (const mapping of mappings) {
    const prefix = normalizeSlashes(mapping.windowsPrefix)
    if (!prefix) continue
    const lowerPrefix = prefix.toLowerCase()
    if (lowerSrc === lowerPrefix || lowerSrc.startsWith(`${lowerPrefix}/`)) {
      if (prefix.length > bestLength) {
        bestLength = prefix.length
        bestMapping = mapping
      }
    }
  }

  if (!bestMapping) return null
  const rel = normSrc.slice(bestLength).replace(/^\/+/, '')
  const corePrefix = normalizeSlashes(bestMapping.corePrefix)
  if (!rel) return corePrefix || '/'
  return corePrefix ? `${corePrefix}/${rel}` : `/${rel}`
}

export function buildSnapshotOnboardingSummary(
  input: SnapshotOnboardingSummaryInput,
): SnapshotOnboardingSummary {
  if (input.mode === 'start_new_library') {
    return {
      mode: 'start_new_library',
      implicitBidirectionalSync: false,
      summaryText: 'Starting a new empty Core library. Catalog remains independent of This PC.',
    }
  }

  return {
    mode: 'import_existing_library',
    implicitBidirectionalSync: false,
    summaryText: `Import preview: ${input.mappedTracksCount} mapped, ${input.unmappedRootsCount} unmapped, ${input.caseMismatchCount} case mismatch, ${input.suppressedPendingJobs} pending write(s) suppressed. Catalogs stay independent after import.`,
  }
}
