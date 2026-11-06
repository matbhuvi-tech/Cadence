import React, { useState } from 'react'
import { Disc } from 'lucide-react'

export interface CurateArtworkThumbnailProps {
  src?: string | null
  alt: string
  className?: string
  imageClassName?: string
  fallbackIconClassName?: string
  fallbackLabel?: string
  fallbackSubtext?: string
  testId?: string
  onClick?: () => void
  onError?: () => void
  showDiscIcon?: boolean
}

export function CurateArtworkThumbnail({
  src,
  alt,
  className = 'w-12 h-12 rounded-lg',
  imageClassName = 'w-full h-full object-cover',
  fallbackIconClassName = 'w-6 h-6 text-white/30',
  fallbackLabel,
  fallbackSubtext,
  testId = 'curate-artwork',
  onClick,
  onError,
  showDiscIcon = true,
}: CurateArtworkThumbnailProps) {
  const [prevSrc, setPrevSrc] = useState(src)
  const [hasError, setHasError] = useState(false)

  // Reset error state during render if src changes
  if (prevSrc !== src) {
    setPrevSrc(src)
    setHasError(false)
  }

  const effectiveSrc = typeof src === 'string' && src.trim().length > 0 ? src.trim() : null
  const isImageAvailable = Boolean(effectiveSrc && !hasError)

  const handleImageError = () => {
    setHasError(true)
    onError?.()
  }

  return (
    <div
      data-testid={testId}
      onClick={onClick}
      className={`relative overflow-hidden shrink-0 bg-black/40 border border-white/10 flex flex-col items-center justify-center select-none ${className}`}
    >
      {/* Fallback container */}
      <div
        data-testid={`${testId}-fallback`}
        className={`w-full h-full flex flex-col items-center justify-center text-center p-1 ${
          isImageAvailable ? 'hidden' : 'flex'
        }`}
      >
        {showDiscIcon && (
          <Disc
            className={fallbackIconClassName}
            data-testid={`${testId}-disc-icon`}
            aria-hidden="true"
          />
        )}
        {fallbackLabel && (
          <span className="text-[10px] text-white/50 block leading-tight mt-0.5 truncate max-w-full font-medium">
            {fallbackLabel}
          </span>
        )}
        {fallbackSubtext && (
          <span className="text-[8px] text-white/30 block leading-tight truncate max-w-full">
            {fallbackSubtext}
          </span>
        )}
      </div>

      {effectiveSrc && !hasError && (
        <img
          data-testid={`${testId}-image`}
          src={effectiveSrc}
          alt={alt}
          loading="lazy"
          onError={handleImageError}
          className={`${imageClassName} absolute inset-0`}
        />
      )}
    </div>
  )
}
