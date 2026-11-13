import React, { useId } from 'react'
import './CadenceArtworkFallback.css'

export interface CadenceArtworkFallbackProps {
  isPlaying?: boolean
  size?: 'sm' | 'lg'
  className?: string
}

const OUTER_RING_PATH = 'M 89.43 27.27 A 44 44 0 1 0 89.43 92.73'
const MID_RING_PATH = 'M 81.40 36.20 A 32 32 0 1 0 81.40 83.80'
const INNER_RING_PATH = 'M 73.38 45.12 A 20 20 0 1 0 73.38 74.88'

interface EmberSpec {
  left: string
  size: number
  duration: string
  delay: string
  drift: string
  opacity: number
  color: string
}

const FALLBACK_EMBERS: EmberSpec[] = Array.from({ length: 16 }, (_, i) => {
  const seed = (i * 41 + 17) % 100
  const size = 2 + (seed % 4) * 0.75
  const duration = 6.5 + (seed % 6) * 1.1
  const delay = -((i * 1.4) % duration)
  const drift = ((i % 2 === 0 ? 1 : -1) * (8 + (seed % 20))).toFixed(0)
  const opacity = 0.3 + (seed % 5) * 0.09
  const color = i % 3 === 0 ? '#fde68a' : i % 3 === 1 ? '#fbbf24' : '#f59e0b'
  return {
    left: `${(i * 6.2 + (seed % 5)) % 94 + 3}%`,
    size,
    duration: `${duration.toFixed(1)}s`,
    delay: `${delay.toFixed(2)}s`,
    drift: `${drift}px`,
    opacity: Number(opacity.toFixed(2)),
    color,
  }
})

export const CadenceArtworkFallback: React.FC<CadenceArtworkFallbackProps> = ({
  isPlaying = false,
  size = 'lg',
  className = '',
}) => {
  const gradId = useId()
  const isSmall = size === 'sm'

  return (
    <div
      className={`cadence-fallback-root relative w-full h-full flex items-center justify-center overflow-hidden select-none ${className}`}
      data-playing={isPlaying ? 'true' : 'false'}
      aria-hidden="true"
    >
      {/* Rising Golden Embers (pure CSS compositor, active during playback) */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {FALLBACK_EMBERS.map((ember, idx) => (
          <span
            key={idx}
            className="cadence-fallback-ember"
            style={
              {
                left: ember.left,
                width: `${isSmall ? ember.size * 0.8 : ember.size}px`,
                height: `${isSmall ? ember.size * 0.8 : ember.size}px`,
                backgroundColor: ember.color,
                boxShadow: `0 0 ${Math.round(ember.size * 3)}px ${ember.color}`,
                '--ember-duration': ember.duration,
                '--ember-delay': ember.delay,
                '--ember-drift': ember.drift,
                '--ember-opacity': ember.opacity,
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      {/* Warm Backlight Halo */}
      <div
        className={`absolute rounded-full bg-gradient-to-tr from-amber-600/25 via-yellow-500/20 to-amber-200/15 blur-2xl pointer-events-none ${
          isSmall ? 'w-28 h-28' : 'w-56 h-56'
        }`}
      />

      {/* Luxury Gold Tile Emblem */}
      <div
        className={`cadence-fallback-tile relative flex items-center justify-center overflow-hidden ${
          isSmall ? 'w-24 h-24 rounded-2xl' : 'w-40 h-40 sm:w-44 sm:h-44 rounded-3xl'
        }`}
      >
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(255,230,170,0.14),transparent_60%)] pointer-events-none" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,rgba(0,0,0,0.8),transparent_65%)] pointer-events-none" />

        <svg
          className={isSmall ? 'w-16 h-16 relative z-10' : 'w-28 h-28 relative z-10'}
          viewBox="0 0 120 120"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#fff4cf" />
              <stop offset="28%" stopColor="#ffd573" />
              <stop offset="55%" stopColor="#d9a838" />
              <stop offset="78%" stopColor="#aa791c" />
              <stop offset="100%" stopColor="#ffd573" />
            </linearGradient>
          </defs>

          <g stroke="#050506" strokeWidth="6.8" strokeLinecap="round" opacity="0.85" transform="translate(0, 2.5)">
            <path d={OUTER_RING_PATH} />
            <path d={MID_RING_PATH} />
            <path d={INNER_RING_PATH} />
          </g>

          <g stroke={`url(#${gradId})`} strokeLinecap="round">
            <path d={OUTER_RING_PATH} strokeWidth="6.5" />
            <path d={MID_RING_PATH} strokeWidth="5.8" />
            <path d={INNER_RING_PATH} strokeWidth="5.2" />
          </g>
        </svg>
      </div>
    </div>
  )
}

export default CadenceArtworkFallback

