import type { EngineNetworkShareRecord } from '../core/coreProtocol'

function findMatchingShare(
  rawPath: string,
  smbShares: readonly EngineNetworkShareRecord[],
): EngineNetworkShareRecord | undefined {
  if (!rawPath) return undefined
  return smbShares.find(
    (share) =>
      rawPath === share.mountPath || rawPath.startsWith(`${share.mountPath}/`),
  )
}

/** Formats internal Core mount paths (e.g. /tmp/cadence-mounts/smb_...) as user-facing SMB UNC paths. */
export function formatEngineDisplayPath(
  rawPath: string,
  smbShares: readonly EngineNetworkShareRecord[],
): string {
  const share = findMatchingShare(rawPath, smbShares)
  if (!share) return rawPath
  const suffix = rawPath.slice(share.mountPath.length)
  return `//${share.server}/${share.share}${suffix}`
}

/** Formats internal Core mount root names (e.g. smb_78ff06d46cafb9b8) using the share display name. */
export function formatEngineDisplayName(
  rawPath: string,
  fallbackName: string,
  smbShares: readonly EngineNetworkShareRecord[],
): string {
  const share = smbShares.find((s) => s.mountPath === rawPath)
  if (share) {
    return share.displayName || share.share
  }
  return fallbackName
}

export function isSmbBackedPath(
  rawPath: string,
  smbShares: readonly EngineNetworkShareRecord[],
): boolean {
  return (
    rawPath.startsWith('\\\\') ||
    rawPath.startsWith('//') ||
    Boolean(findMatchingShare(rawPath, smbShares))
  )
}
