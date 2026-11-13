import React, { useEffect, useRef, useState } from 'react'
import './StartupSplashScreen.css'

export interface StartupSplashScreenProps {
  /** Whether database initialization has finished and the splash can fade out. */
  isReady: boolean
  /** Current initialization phase label shown beneath the progress bar. */
  statusText?: string
  /** Initialization progress percentage (0-100). */
  progress?: number
  /** Callback invoked after the exit transition finishes so the overlay can unmount. */
  onExited?: () => void
}

const OUTER_RING_PATH = 'M 89.43 27.27 A 44 44 0 1 0 89.43 92.73'
const MID_RING_PATH = 'M 81.40 36.20 A 32 32 0 1 0 81.40 83.80'
const INNER_RING_PATH = 'M 73.38 45.12 A 20 20 0 1 0 73.38 74.88'

interface GoldenEmber {
  left: string
  size: number
  duration: string
  delay: string
  drift: string
  opacity: number
  color: string
}

// Deterministic golden embers so there is zero layout shift and zero JS animation loop
const GOLDEN_EMBERS: GoldenEmber[] = Array.from({ length: 28 }, (_, i) => {
  const seed = (i * 37 + 13) % 100
  const size = 1.6 + (seed % 4) * 0.7
  const duration = 7 + (seed % 7) * 1.1
  const delay = -((i * 1.35) % duration)
  const drift = ((i % 2 === 0 ? 1 : -1) * (10 + (seed % 26))).toFixed(0)
  const opacity = 0.25 + ((seed % 5) * 0.09)
  const color = i % 3 === 0 ? '#fde68a' : i % 3 === 1 ? '#fbbf24' : '#f59e0b'
  return {
    left: `${(i * 3.6 + (seed % 5)) % 98}%`,
    size,
    duration: `${duration.toFixed(1)}s`,
    delay: `${delay.toFixed(2)}s`,
    drift: `${drift}px`,
    opacity: Number(opacity.toFixed(2)),
    color,
  }
})

export const StartupSplashScreen: React.FC<StartupSplashScreenProps> = ({
  isReady,
  statusText = 'Warming up the listening room...',
  progress = 20,
  onExited,
}) => {
  const [isExiting, setIsExiting] = useState(false)
  const hasExitedRef = useRef(false)

  const finishExit = () => {
    if (hasExitedRef.current) return
    hasExitedRef.current = true
    onExited?.()
  }

  useEffect(() => {
    if (!isReady) return
    setIsExiting(true)

    // Failsafe in case transitionend does not fire (e.g., instant reduced-motion or unmounted parent)
    const failsafeTimer = window.setTimeout(finishExit, 480)
    return () => window.clearTimeout(failsafeTimer)
  }, [isReady])

  const clampedProgress = Math.min(100, Math.max(8, progress))

  return (
    <div
      className="cadence-splash-root fixed inset-0 z-50 flex flex-col items-center justify-center select-none overflow-hidden text-zinc-100"
      data-exiting={isExiting ? 'true' : 'false'}
      aria-label="Cadence startup splash screen"
      onTransitionEnd={(e) => {
        if (isExiting && e.target === e.currentTarget && e.propertyName === 'opacity') {
          finishExit()
        }
      }}
    >
      {/* Ambient Radial Spotlight */}
      <div className="cadence-splash-spotlight absolute inset-0 pointer-events-none" aria-hidden="true" />

      {/* Warm Floating Golden Embers (pure CSS compositor, unmounts on splash exit) */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        {GOLDEN_EMBERS.map((ember, idx) => (
          <span
            key={idx}
            className="cadence-ember"
            style={
              {
                left: ember.left,
                width: `${ember.size}px`,
                height: `${ember.size}px`,
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

      {/* Centerpiece */}
      <div className="cadence-logo-stage relative z-10 flex flex-col items-center p-6">
        {/* Backlight Glow Flare Behind Emblem */}
        <div
          className="cadence-badge-flare absolute -top-8 w-64 h-64 rounded-full bg-gradient-to-tr from-amber-600/30 via-yellow-500/25 to-amber-200/20 blur-3xl pointer-events-none -z-10"
          aria-hidden="true"
        />

        {/* Rounded Golden Tile Emblem */}
        <div
          className="cadence-splash-badge relative w-36 h-36 sm:w-44 sm:h-44 rounded-3xl flex items-center justify-center overflow-hidden shadow-2xl"
          aria-hidden="true"
        >
          {/* Diagonal Metallic Glint Sheen */}
          <div className="cadence-glint-sheen absolute -inset-full bg-gradient-to-r from-transparent via-amber-100/90 to-transparent w-[300%] h-[300%] z-20" />

          {/* Subtle Corner Reflections */}
          <div className="absolute inset-0 rounded-3xl bg-[radial-gradient(ellipse_at_top_left,rgba(255,230,170,0.14),transparent_60%)] pointer-events-none z-10" />
          <div className="absolute inset-0 rounded-3xl bg-[radial-gradient(ellipse_at_bottom_right,rgba(0,0,0,0.85),transparent_65%)] pointer-events-none z-10" />

          {/* Concentric C Arcs Vector SVG */}
          <svg
            className="w-24 h-24 sm:w-28 sm:h-28 relative z-10"
            viewBox="0 0 120 120"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <linearGradient id="cadence-splash-gold-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#fff4cf" />
                <stop offset="28%" stopColor="#ffd573" />
                <stop offset="55%" stopColor="#d9a838" />
                <stop offset="78%" stopColor="#aa791c" />
                <stop offset="100%" stopColor="#ffd573" />
              </linearGradient>

              <filter id="cadence-splash-spark-bloom" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Engraved 3D Shadow Layer */}
            <g stroke="#050506" strokeWidth="6.8" strokeLinecap="round" opacity="0.85" transform="translate(0, 2.5)">
              <path d={OUTER_RING_PATH} />
              <path d={MID_RING_PATH} />
              <path d={INNER_RING_PATH} />
            </g>

            {/* Golden Concentric C Arcs */}
            <g stroke="url(#cadence-splash-gold-grad)" strokeLinecap="round">
              <path
                className="cadence-c-ring cadence-ring-outer"
                d={OUTER_RING_PATH}
                pathLength={100}
                strokeWidth="6.5"
              />
              <path
                className="cadence-c-ring cadence-ring-mid"
                d={MID_RING_PATH}
                pathLength={100}
                strokeWidth="5.8"
              />
              <path
                className="cadence-c-ring cadence-ring-inner"
                d={INNER_RING_PATH}
                pathLength={100}
                strokeWidth="5.2"
              />
            </g>

            {/* Neon Amber Spark Heads Leading the Stroke */}
            <g filter="url(#cadence-splash-spark-bloom)">
              <circle
                className="cadence-spark-head cadence-spark-outer fill-amber-200"
                r="4.2"
                style={{ offsetPath: `path('${OUTER_RING_PATH}')`, offsetRotate: 'auto' }}
              />
              <circle
                className="cadence-spark-head cadence-spark-mid fill-yellow-100"
                r="3.8"
                style={{ offsetPath: `path('${MID_RING_PATH}')`, offsetRotate: 'auto' }}
              />
              <circle
                className="cadence-spark-head cadence-spark-inner fill-white"
                r="3.2"
                style={{ offsetPath: `path('${INNER_RING_PATH}')`, offsetRotate: 'auto' }}
              />
            </g>
          </svg>
        </div>

        {/* Brand Typography & Real Initialization Progress */}
        <div className="mt-9 text-center flex flex-col items-center">
          <h1 className="cadence-brand-title cadence-splash-brand-font text-2xl sm:text-3xl font-bold tracking-[0.42em] text-transparent bg-clip-text bg-gradient-to-b from-amber-100 via-amber-200 to-amber-500/90 pl-[0.42em] drop-shadow-[0_2px_12px_rgba(212,175,55,0.25)]">
            CADENCE
          </h1>
          <p className="cadence-brand-subtitle text-xs sm:text-sm tracking-[0.24em] font-light text-amber-200/60 uppercase mt-2.5">
            Precision Audio Engine
          </p>

          {/* Boot Progress Bar */}
          <div className="w-48 sm:w-56 h-[2px] bg-zinc-800/80 rounded-full mt-7 overflow-hidden relative shadow-inner">
            <div
              className="h-full bg-gradient-to-r from-amber-600 via-amber-300 to-yellow-100 rounded-full shadow-[0_0_8px_rgba(251,191,36,0.8)] transition-all duration-300 ease-out"
              style={{ width: `${clampedProgress}%` }}
            />
          </div>

          {/* Live Initialization Status */}
          <p
            role="status"
            aria-live="polite"
            className={`text-[11px] font-mono tracking-widest mt-3 uppercase transition-colors duration-300 ${
              isReady ? 'text-amber-300' : 'text-zinc-500'
            }`}
          >
            {statusText}
          </p>
        </div>
      </div>
    </div>
  )
}

export default StartupSplashScreen

