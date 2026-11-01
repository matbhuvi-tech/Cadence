import React, { useEffect, useState } from 'react'
import { tauriBridge } from '../../services/tauriBridge'

export function useLocalArtworkUrl(path?: string | null, fallbackUrl?: string | null): string | null {
  const [url, setUrl] = useState<string | null>(fallbackUrl || null)

  useEffect(() => {
    let active = true
    if (!path) {
      setUrl(fallbackUrl || null)
      return () => {
        active = false
      }
    }

    if (tauriBridge.isTauri()) {
      setUrl(fallbackUrl || null)
      tauriBridge
        .getCoverArt(path)
        .then((dataUrl) => {
          if (active && dataUrl) setUrl(dataUrl)
        })
        .catch(() => {
          if (active) setUrl(fallbackUrl || null)
        })
    } else {
      setUrl(`/api/track-art?path=${encodeURIComponent(path)}`)
    }

    return () => {
      active = false
    }
  }, [path, fallbackUrl])

  return url
}

interface LocalArtworkImageProps {
  path?: string | null
  fallbackUrl?: string | null
  alt: string
  className?: string
  onError?: React.ReactEventHandler<HTMLImageElement>
}

/** Loads embedded/folder artwork through native IPC in Tauri and the Vite route in browser mode. */
export const LocalArtworkImage: React.FC<LocalArtworkImageProps> = ({
  path,
  fallbackUrl,
  alt,
  className,
  onError,
}) => {
  const resolvedLocalUrl = useLocalArtworkUrl(path, fallbackUrl)
  const [src, setSrc] = useState<string | undefined>(resolvedLocalUrl || undefined)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setSrc(resolvedLocalUrl || undefined)
    setFailed(false)
  }, [resolvedLocalUrl, fallbackUrl])

  return (
    <img
      src={failed ? (fallbackUrl || undefined) : src}
      alt={alt}
      className={className}
      onError={(event) => {
        if (fallbackUrl && src !== fallbackUrl && !failed) {
          setFailed(true)
          return
        }
        onError?.(event)
      }}
    />
  )
}
