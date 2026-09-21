import React from 'react'

interface PanoramicAtmosphericBackdropProps {
  coverArtUrl?: string
  backdropUrl?: string
  className?: string
  overlayVariant?: 'banner' | 'card' | 'minimal'
  headerBaseHeight?: string | number
}

/**
 * PanoramicAtmosphericBackdrop
 * 
 * Cinematic Atmospheric Album-Art Backdrop for the entire AlbumCard:
 * 
 * DOM Architecture:
 * <AlbumCard relative overflow-hidden>
 *   <PanoramicAtmosphericBackdrop absolute inset-0 />
 *   <AlbumContent relative z-10>
 *     <AlbumHeader />
 *     <TrackList />
 *   </AlbumContent>
 * </AlbumCard>
 * 
 * Vertical Intensity Profile:
 * - 0 to --header-base-height (~140px): Transparent/minimal mask (cinematic artwork clearly visible)
 * - 140px to 190px (+50px): Strong atmospheric fade begins
 * - 190px to 260px (+120px): Artwork detail largely disappears
 * - 260px to 320px (+180px): Subtle album-derived ambient color field remains
 * - 320px+ (converges completely): Solid dark track-list background (#0A0D14)
 * 
 * Anchored to absolute pixel stops via CSS variables + calc(), ensuring the exact same
 * physical fade position across 3-track, 7-track, 15-track, and 25-track albums.
 */
export const PanoramicAtmosphericBackdrop: React.FC<PanoramicAtmosphericBackdropProps> = ({
  coverArtUrl,
  backdropUrl: explicitBackdropUrl,
  className = '',
  overlayVariant = 'banner',
  headerBaseHeight = 140,
}) => {
  const activeBackdrop = explicitBackdropUrl || coverArtUrl
  const formattedHeaderHeight =
    typeof headerBaseHeight === 'number' ? `${headerBaseHeight}px` : headerBaseHeight

  if (!activeBackdrop) {
    return (
      <div
        className={`absolute inset-0 bg-gradient-to-r from-[#0E131F] via-[#141824] to-[#0E131F] pointer-events-none -z-0 ${className}`}
      />
    )
  }

  return (
    <div
      className={`absolute inset-0 pointer-events-none select-none overflow-hidden -z-0 ${className}`}
      style={
        {
          '--header-base-height': formattedHeaderHeight,
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      {/* 1. DEDICATED PANORAMIC BACKDROP ASSET */}
      <div
        className="absolute inset-0 bg-cover bg-top pointer-events-none transition-all duration-700"
        style={{
          backgroundImage: `url(${activeBackdrop})`,
          opacity: 0.85,
          filter: 'blur(3px)',
        }}
      />

      {/* 2. PROGRESSIVE VERTICAL DARKENING & LEGIBILITY OVERLAYS */}
      {overlayVariant === 'banner' && (
        <>
          {/* Continuous vertical gradient anchored to fixed header height:
              - 0 to 140px: Minimal mask (cinematic artwork clearly visible in header)
              - 140 to 190px: Strong atmospheric fade
              - 190 to 260px: Artwork detail disappears
              - 260 to 320px: Subtle ambient color field
              - 320px+: Complete convergence to solid dark background (#0A0D14)
          */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: `linear-gradient(
                to bottom,
                rgba(10, 13, 20, 0.12) 0px,
                rgba(10, 13, 20, 0.18) var(--header-base-height, 140px),
                rgba(10, 13, 20, 0.70) calc(var(--header-base-height, 140px) + 50px),
                rgba(10, 13, 20, 0.92) calc(var(--header-base-height, 140px) + 120px),
                rgba(10, 13, 20, 0.98) calc(var(--header-base-height, 140px) + 180px),
                #0A0D14 calc(var(--header-base-height, 140px) + 180px),
                #0A0D14 100%
              )`,
            }}
          />

          {/* Left-side header text & metadata protection */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'linear-gradient(to right, rgba(10, 13, 20, 0.85) 0px, rgba(10, 13, 20, 0.40) 320px, transparent 550px)',
            }}
          />

          {/* Baseline subtle ambient tint */}
          <div className="absolute inset-0 bg-[#0A0D14]/10 pointer-events-none" />
        </>
      )}

      {overlayVariant === 'card' && (
        <>
          {/* Balanced card vignette with absolute pixel vertical fade */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: `linear-gradient(
                to bottom,
                rgba(10, 13, 20, 0.20) 0px,
                rgba(10, 13, 20, 0.25) var(--header-base-height, 140px),
                rgba(10, 13, 20, 0.70) calc(var(--header-base-height, 140px) + 50px),
                rgba(10, 13, 20, 0.92) calc(var(--header-base-height, 140px) + 120px),
                rgba(10, 13, 20, 0.98) calc(var(--header-base-height, 140px) + 180px),
                #0A0D14 calc(var(--header-base-height, 140px) + 180px),
                #0A0D14 100%
              )`,
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-r from-[#07090E]/70 via-transparent to-[#07090E]/50 pointer-events-none" />
          <div className="absolute inset-0 bg-[#07090E]/15 pointer-events-none" />
        </>
      )}

      {overlayVariant === 'minimal' && (
        <div className="absolute inset-0 bg-black/25 backdrop-blur-[1px] pointer-events-none" />
      )}
    </div>
  )
}

