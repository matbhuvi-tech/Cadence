import type { EngineScanStatus } from './coreProtocol'

export function formatEngineScanSummary(
  scan: Pick<EngineScanStatus, 'status' | 'processed' | 'errors' | 'errorCount'>,
): string {
  const details = [scan.status]

  if (typeof scan.processed === 'number' && scan.processed > 0) {
    details.push(`${scan.processed} items processed`)
  }

  const errorCount = scan.errorCount ?? scan.errors?.length ?? 0
  if (errorCount > 0) {
    details.push(`${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`)
  }

  return details.join(' · ')
}
