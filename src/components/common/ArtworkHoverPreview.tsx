import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Image as ImageIcon, Sparkles, Disc3, Music2, Check, Music } from 'lucide-react'

export interface ArtworkHoverPreviewProps {
  children: React.ReactNode
  src?: string | null
  alt?: string
  title?: string
  subtitle?: string
  composer?: string
  resolution?: string
  provider?: 'itunes' | 'musicbrainz' | 'ai' | 'local' | 'custom' | string
  providerLabel?: string
  audioSpec?: string
  drScore?: number
  className?: string
  previewSize?: number // default 280px
  disabled?: boolean
}

export const ArtworkHoverPreview: React.FC<ArtworkHoverPreviewProps> = ({
  children,
  src,
  alt = 'Album Artwork Preview',
  title,
  subtitle,
  composer,
  resolution,
  provider,
  providerLabel,
  audioSpec,
  drScore,
  className = '',
  previewSize = 280,
  disabled = false,
}) => {
  const [isVisible, setIsVisible] = useState(false)
  const [position, setPosition] = useState<{ x: number; y: number; placeAbove: boolean; placeLeft: boolean }>({
    x: 0,
    y: 0,
    placeAbove: false,
    placeLeft: false,
  })
  const [imgError, setImgError] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const hoverTimeoutRef = useRef<number | null>(null)
  const leaveTimeoutRef = useRef<number | null>(null)

  const clearTimeouts = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    if (leaveTimeoutRef.current) clearTimeout(leaveTimeoutRef.current)
  }

  const updatePosition = () => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    const boxWidth = previewSize + 32 // preview size plus card padding
    const boxHeight = previewSize + 90 // preview image + metadata block height

    // Check if right has enough room
    let x = rect.right + 12
    let placeLeft = false
    if (x + boxWidth > viewportWidth - 16) {
      // Put to left of trigger
      x = rect.left - boxWidth - 12
      placeLeft = true
      if (x < 16) {
        // Fallback: center horizontally over trigger
        x = Math.max(16, Math.min(viewportWidth - boxWidth - 16, rect.left + rect.width / 2 - boxWidth / 2))
      }
    }

    // Check vertical positioning
    let y = rect.top
    let placeAbove = false
    if (y + boxHeight > viewportHeight - 16) {
      y = Math.max(16, viewportHeight - boxHeight - 16)
      placeAbove = true
    }
    if (y < 16) {
      y = 16
    }

    setPosition({ x, y, placeAbove, placeLeft })
  }

  const handleMouseEnter = () => {
    if (disabled || !src) return
    clearTimeouts()
    hoverTimeoutRef.current = window.setTimeout(() => {
      updatePosition()
      setIsVisible(true)
      setImgError(false)
    }, 180) // 180ms subtle delay to prevent accidental flashing
  }

  const handleMouseLeave = () => {
    clearTimeouts()
    leaveTimeoutRef.current = window.setTimeout(() => {
      setIsVisible(false)
    }, 120)
  }

  useEffect(() => {
    return () => {
      clearTimeouts()
    }
  }, [])

  // Provider badge theme
  const getProviderTheme = () => {
    switch (provider) {
      case 'itunes':
      case 'apple':
        return {
          bg: 'bg-[#00F5FF]/15',
          text: 'text-[#00F5FF]',
          border: 'border-[#00F5FF]/30',
          label: providerLabel || 'Apple Music HD',
          icon: Music2,
        }
      case 'musicbrainz':
      case 'mb':
        return {
          bg: 'bg-[#ADFF2F]/15',
          text: 'text-[#ADFF2F]',
          border: 'border-[#ADFF2F]/30',
          label: providerLabel || 'MusicBrainz CAA',
          icon: Disc3,
        }
      case 'ai':
      case 'gemini':
        return {
          bg: 'bg-[#8B5CF6]/20',
          text: 'text-[#C084FC]',
          border: 'border-[#8B5CF6]/40',
          label: providerLabel || 'Gemini AI Vision',
          icon: Sparkles,
        }
      case 'local':
        return {
          bg: 'bg-white/[0.1]',
          text: 'text-[#CBD5E1]',
          border: 'border-white/[0.2]',
          label: providerLabel || 'Embedded Local ID3',
          icon: ImageIcon,
        }
      default:
        return {
          bg: 'bg-[#00F5FF]/15',
          text: 'text-[#00F5FF]',
          border: 'border-[#00F5FF]/30',
          label: providerLabel || 'Archival Artwork',
          icon: ImageIcon,
        }
    }
  }

  const pTheme = getProviderTheme()
  const ProviderIcon = pTheme.icon

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className={`inline-flex items-center justify-center ${className}`}
      >
        {children}
      </div>

      {isVisible &&
        src &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: `${position.y}px`,
              left: `${position.x}px`,
              zIndex: 99999,
              width: `${previewSize + 28}px`,
            }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            className="pointer-events-none animate-in fade-in zoom-in-95 duration-200"
          >
            <div className="bg-[#0B0D14]/95 backdrop-blur-2xl border border-white/[0.16] rounded-2xl p-3.5 shadow-2xl shadow-black/90 ring-1 ring-[#00F5FF]/20 flex flex-col gap-3 relative overflow-hidden">
              {/* Background ambient lighting */}
              <div
                className="absolute inset-0 opacity-20 blur-2xl scale-125 pointer-events-none -z-10 bg-cover bg-center"
                style={{ backgroundImage: `url(${src})` }}
              />

              {/* Header Badges */}
              <div className="flex items-center justify-between gap-2 z-10">
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold flex items-center gap-1 border ${pTheme.bg} ${pTheme.text} ${pTheme.border}`}
                >
                  <ProviderIcon className="w-3 h-3" />
                  <span>{pTheme.label}</span>
                </span>

                {resolution && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-black/60 text-white/90 border border-white/[0.15]">
                    {resolution}
                  </span>
                )}
              </div>

              {/* Large Image Box */}
              <div
                className="relative rounded-xl overflow-hidden bg-black/80 border border-white/[0.1] shadow-xl flex items-center justify-center group"
                style={{ width: `${previewSize}px`, height: `${previewSize}px` }}
              >
                {!imgError ? (
                  <img
                    src={src}
                    alt={alt}
                    onError={() => setImgError(true)}
                    className="w-full h-full object-cover rounded-xl"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center p-4 text-center text-[#64748B]">
                    <ImageIcon className="w-10 h-10 mb-2 opacity-40 text-[#00F5FF]" />
                    <span className="text-xs font-mono">Image Unavailable</span>
                  </div>
                )}

                {/* Subtle vignette gloss */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent pointer-events-none" />
              </div>

              {/* Metadata Footer */}
              {(title || subtitle || composer || audioSpec || drScore !== undefined) && (
                <div className="flex flex-col gap-1 text-left z-10 pt-1 border-t border-white/[0.08]">
                  {title && (
                    <span className="text-xs font-bold text-[#F1F5F9] truncate" title={title}>
                      {title}
                    </span>
                  )}
                  {composer && (
                    <span className="text-[11px] text-[#EC4899] font-mono truncate flex items-center gap-1">
                      <Music className="w-2.5 h-2.5 shrink-0" />
                      <span>{composer}</span>
                    </span>
                  )}
                  {subtitle && (
                    <span className="text-[11px] text-[#94A3B8] truncate" title={subtitle}>
                      {subtitle}
                    </span>
                  )}

                  {(audioSpec || drScore !== undefined) && (
                    <div className="flex items-center gap-2 mt-1">
                      {audioSpec && (
                        <span className="px-1.5 py-0.5 rounded bg-white/[0.06] text-[#00F5FF] font-mono text-[9px] font-bold border border-white/[0.08]">
                          {audioSpec}
                        </span>
                      )}
                      {drScore !== undefined && drScore > 0 && (
                        <span
                          className={`px-1.5 py-0.5 rounded font-mono text-[9px] font-bold ${
                            drScore >= 14
                              ? 'bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/30'
                              : drScore >= 10
                              ? 'bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/30'
                              : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          }`}
                        >
                          DR{drScore}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
