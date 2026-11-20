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

export function useResolvedMediaUrl(src?: string | null, enabled: boolean = true): string {
  const engine = useOptionalEngineController()
  const rawReleaseId = extractEngineArtworkReleaseId(src)
  const syncUrl = rawReleaseId
    ? engine?.getCachedCoreArtworkUrl(rawReleaseId) ?? ''
    : resolveMediaUrl(src)

  const [resolved, setResolved] = useState<string>(syncUrl)
  const playbackActivity = engine?.activeCoreSnapshot?.playback.activity
  const artworkVersion = engine?.artworkVersion ?? 0

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
    if (!enabled) {
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
  }, [
    rawReleaseId,
    src,
    enabled,
    engine,
    engine?.isCoreActive,
    engine?.activeCoreSnapshot?.catalog.revision,
    artworkVersion,
    playbackActivity === 'idle',
  ])

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
  loading,
  ...rest
}) => {
  const isLazy = loading === 'lazy' && typeof IntersectionObserver !== 'undefined'
  const [inView, setInView] = useState<boolean>(!isLazy)
  const anchorRef = React.useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!isLazy || inView) return
    const el = anchorRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const target = el.parentElement ?? el
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin: '480px' },
    )
    observer.observe(target)
    return () => {
      observer.disconnect()
    }
  }, [isLazy, inView, src])

  const resolved = useResolvedMediaUrl(src, inView)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const engineArtworkVersion = useOptionalEngineController()?.artworkVersion ?? 0

  useEffect(() => {
    setFailedSrc(null)
  }, [resolved, engineArtworkVersion])

  if (!resolved || failedSrc === resolved) {
    return isLazy && !inView ? (
      <>
        <span
          ref={anchorRef}
          aria-hidden="true"
          style={{ position: 'absolute', width: 1, height: 1, pointerEvents: 'none', opacity: 0 }}
        />
        {fallback}
      </>
    ) : (
      <>{fallback}</>
    )
  }

  return (
    <img
      src={resolved}
      alt={alt}
      loading={loading}
      onError={(e) => {
        setFailedSrc(resolved)
        onError?.(e)
      }}
      {...rest}
    />
  )
}
