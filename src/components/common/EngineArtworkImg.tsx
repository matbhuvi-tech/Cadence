import React, { useEffect, useState } from 'react'
import { useOptionalEngineController } from '../../context/EngineControllerContext'
import { resolveMediaUrl } from '../../services/tauriBridge'

const ENGINE_ART_SCHEME = 'cadence-art://'

export function extractEngineArtworkReleaseId(url?: string | null): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed.startsWith(ENGINE_ART_SCHEME)) return null
  const id = trimmed.slice(ENGINE_ART_SCHEME.length).trim()
  return id || null
}

export function useResolvedMediaUrl(src?: string | null): string {
  const engine = useOptionalEngineController()
  const rawReleaseId = extractEngineArtworkReleaseId(src)
  const syncUrl = rawReleaseId
    ? engine?.getCachedCoreArtworkUrl(rawReleaseId) ?? ''
    : resolveMediaUrl(src)

  const [resolved, setResolved] = useState<string>(syncUrl)

  useEffect(() => {
    if (!rawReleaseId) {
      setResolved(resolveMediaUrl(src))
      return
    }
    const cached = engine?.getCachedCoreArtworkUrl(rawReleaseId)
    if (cached) {
      setResolved(cached)
      return
    }
    setResolved('')
    if (!engine?.isCoreActive) return
    let cancelled = false
    void engine
      .resolveCoreArtworkUrl(rawReleaseId)
      .then((url) => {
        if (!cancelled && url) {
          setResolved(url)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [rawReleaseId, src, engine, engine?.isCoreActive, engine?.activeCoreSnapshot?.catalog.revision])

  return resolved
}

interface EngineArtworkImgProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src?: string | null
  fallback?: React.ReactNode
}

export const EngineArtworkImg: React.FC<EngineArtworkImgProps> = ({
  src,
  fallback = null,
  onError,
  alt = '',
  ...rest
}) => {
  const resolved = useResolvedMediaUrl(src)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  if (!resolved || failedSrc === resolved) {
    return <>{fallback}</>
  }

  return (
    <img
      src={resolved}
      alt={alt}
      onError={(e) => {
        setFailedSrc(resolved)
        onError?.(e)
      }}
      {...rest}
    />
  )
}
