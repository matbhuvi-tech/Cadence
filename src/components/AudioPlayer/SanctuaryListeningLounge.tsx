import React, { useEffect, useState } from 'react'
import {
  X,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Music2,
  Sparkles,
  Users,
} from 'lucide-react'
import { useAudioPlayer, useAudioProgress } from '../../context/AudioPlayerContext'
import { graphEngine } from '../../core/graphEngine'
import { describeSignalPath } from '../../core/endpointRouting'
import { PanoramicAtmosphericBackdrop } from '../common/PanoramicAtmosphericBackdrop'
import { CadenceArtworkFallback } from '../common/CadenceArtworkFallback'

interface SanctuaryListeningLoungeProps {
  isOpen: boolean
  onClose: () => void
}

const formatClockTime = (seconds: number) => {
  if (!seconds || isNaN(seconds) || seconds < 0) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

const SanctuaryScrubber: React.FC<{
  fallbackDuration: number
  onSeek: (seconds: number) => void
}> = React.memo(({ fallbackDuration, onSeek }) => {
  const { currentTime, duration } = useAudioProgress()
  const effectiveDuration = duration > 0 ? duration : fallbackDuration
  const progressFraction =
    effectiveDuration > 0 ? Math.max(0, Math.min(1, currentTime / effectiveDuration)) : 0

  return (
    <div className="space-y-1.5">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Playback progress"
        aria-valuemin={0}
        aria-valuemax={Math.round(effectiveDuration)}
        aria-valuenow={Math.round(currentTime)}
        className="h-1.5 bg-white/20 rounded-full overflow-hidden cursor-pointer relative group focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-4"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
          onSeek(pct * effectiveDuration)
        }}
        onKeyDown={(e) => {
          if (!effectiveDuration) return
          if (e.key === 'ArrowRight') {
            e.preventDefault()
            onSeek(Math.min(effectiveDuration, currentTime + 5))
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault()
            onSeek(Math.max(0, currentTime - 5))
          }
        }}
      >
        <div
          className="w-full h-full origin-left bg-white rounded-full relative transition-transform duration-150 ease-linear"
          style={{ transform: `scaleX(${progressFraction})` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs font-mono text-white/65 tabular-nums">
        <span>{formatClockTime(currentTime)}</span>
        <span>{formatClockTime(effectiveDuration)}</span>
      </div>
    </div>
  )
})

export const SanctuaryListeningLounge: React.FC<SanctuaryListeningLoungeProps> = ({
  isOpen,
  onClose,
}) => {
  const {
    currentTrack,
    currentRelease,
    isPlaying,
    volume,
    isMuted,
    streamTelemetry,
    selectedEndpoint,
    activeBackendEndpoint,
    signalPathMode,
    isPurityMode,
    isBitPerfect,
    outputSampleRate,
    deviceType,
    togglePurityMode,
    togglePlayPause,
    nextTrack,
    prevTrack,
    seek,
    setVolume,
    toggleMute,
  } = useAudioPlayer()

  const [imgError, setImgError] = useState(false)

  // Listen for Escape key to close lounge
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  const fallbackDuration = currentTrack?.durationSeconds || currentTrack?.duration || 0
  const resolvedRelease =
    currentRelease || (currentTrack?.releaseId ? graphEngine.getReleaseById(currentTrack.releaseId) : null)
  const coverUrl = resolvedRelease?.coverArtUrl || resolvedRelease?.artwork?.frontCoverUrl

  useEffect(() => {
    setImgError(false)
  }, [coverUrl])

  if (!isOpen) return null

  const showCoverImage = Boolean(coverUrl) && !imgError

  const isDsd = (streamTelemetry?.format || currentTrack?.format || '').toUpperCase().includes('DSD')
  const isHiRes = Boolean(streamTelemetry?.isHighRes || currentTrack?.isHighRes)
  const sampleRateKhz = streamTelemetry?.sampleRate ? `${streamTelemetry.sampleRate / 1000} kHz` : null

  const signalDesc = describeSignalPath({
    selectedEndpoint,
    activeBackendEndpoint,
    deviceType,
    signalPathMode,
    isPurityMode,
    isBitPerfect,
    volume,
    isMuted,
    outputSampleRate,
  })

  const isUnavailable = activeBackendEndpoint === null || signalDesc.transportLabel === 'Unavailable'

  const footerTierLabel = isDsd
    ? 'DSD Direct'
    : isHiRes
      ? 'Hi-Res Lossless'
      : signalDesc.isProvenBitPerfect
        ? 'Bit-Perfect'
        : 'Lossless'

  const footerStatusLabel = isUnavailable
    ? 'Output Unavailable'
    : signalDesc.isProvenBitPerfect
      ? 'Optimal Playback'
      : 'Standard Playback'

  const conductorName = currentTrack?.credits.find((c) => c.role === 'conductor')?.personName
  const ensembleName = currentTrack?.credits.find((c) => c.role === 'ensemble')?.personName

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Now Playing"
      className="fixed inset-0 z-50 bg-[#08090C] flex flex-col justify-between p-6 sm:p-10 lg:p-12 select-none animate-in fade-in duration-300 overflow-hidden"
    >
      {/* Reworked Cover Art Backdrop (consistent with Listen - Track view) */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden -z-10" aria-hidden="true">
        {showCoverImage ? (
          <PanoramicAtmosphericBackdrop
            coverArtUrl={coverUrl}
            backdropUrl={resolvedRelease?.backdropUrl}
            overlayVariant="minimal"
          />
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_35%_48%,rgba(196,145,42,0.16)_0%,rgba(28,22,14,0.6)_42%,#08090c_85%)]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/55 to-black/80 backdrop-blur-xl" />
      </div>

      {/* Top Header */}
      <header className="flex items-center justify-between z-10 shrink-0">
        <div className="flex items-center gap-2.5">
          <span
            className={`w-2 h-2 rounded-full ${isUnavailable ? 'bg-rose-400' : 'bg-[#10B981]'}`}
            aria-hidden="true"
          />
          <span className="text-xs font-medium tracking-wide text-white/70">
            Now Playing
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Format Badge */}
          <div className="px-3 py-1 rounded-full bg-white/[0.08] backdrop-blur-md border border-white/15 text-xs font-mono text-white/90 flex items-center gap-2">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: isDsd ? '#818CF8' : isHiRes ? '#F59E0B' : '#10B981' }}
              aria-hidden="true"
            />
            <span>
              {streamTelemetry?.format || currentTrack?.format || 'PCM'}
              {sampleRateKhz ? ` · ${sampleRateKhz}` : ''}
              {streamTelemetry?.bitDepth ? ` · ${streamTelemetry.bitDepth}-bit` : ''}
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Now Playing"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/[0.08] hover:bg-white/[0.16] backdrop-blur-md border border-white/15 text-xs font-medium text-white transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2"
            title="Return to Library (Esc)"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Esc</span>
          </button>
        </div>
      </header>

      {/* Center Stage: Cover Art & Track Details */}
      <main className="flex-1 flex flex-col lg:flex-row items-center justify-center gap-8 lg:gap-16 xl:gap-20 py-6 z-10 overflow-y-auto">
        {/* Cover Art Sleeve */}
        <div className="relative group shrink-0">
          <div className="w-72 h-72 sm:w-88 sm:h-88 md:w-[400px] md:h-[400px] rounded-2xl bg-[#131418] border border-white/15 shadow-[0_28px_70px_rgba(0,0,0,0.65)] overflow-hidden flex items-center justify-center relative">
            {showCoverImage ? (
              <img
                src={coverUrl}
                alt={`${resolvedRelease?.title || currentTrack?.title || 'Album'} cover art`}
                onError={() => setImgError(true)}
                className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.015]"
              />
            ) : (
              <CadenceArtworkFallback isPlaying={isPlaying} size="lg" />
            )}
          </div>
        </div>

        {/* Track Metadata & Playback Status */}
        <div className="max-w-lg w-full space-y-6 text-left">
          <div>
            {currentTrack?.workId && (
              <div className="text-xs font-medium uppercase tracking-widest text-amber-300/90 mb-1.5">
                Classical Work
              </div>
            )}
            <h1 className="text-3xl sm:text-4xl font-semibold text-white tracking-tight leading-tight">
              {currentTrack?.title || 'No Track Selected'}
            </h1>
            <p className="text-lg text-white/90 font-medium mt-1.5">
              {currentTrack?.artistCredit || 'Unknown Artist'}
            </p>
            <p className="text-sm text-white/60 mt-0.5">
              {currentRelease?.title || 'Release'}
              {currentRelease?.releaseYear ? ` (${currentRelease.releaseYear})` : ''}
            </p>
          </div>

          {/* Simplified Credits Pills */}
          {(currentTrack?.composerName || ensembleName || conductorName) && (
            <div className="flex flex-wrap gap-2">
              {currentTrack?.composerName && (
                <span className="px-3 py-1.5 rounded-full bg-white/[0.08] backdrop-blur-md border border-white/[0.14] text-xs text-white/90 flex items-center gap-1.5">
                  <Music2 className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />
                  <span className="text-white/65">Composer:</span>
                  <span className="font-medium text-white">{currentTrack.composerName}</span>
                </span>
              )}
              {ensembleName && (
                <span className="px-3 py-1.5 rounded-full bg-white/[0.08] backdrop-blur-md border border-white/[0.14] text-xs text-white/90 flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />
                  <span className="text-white/65">Ensemble:</span>
                  <span className="font-medium text-white">{ensembleName}</span>
                </span>
              )}
              {conductorName && (
                <span className="px-3 py-1.5 rounded-full bg-white/[0.08] backdrop-blur-md border border-white/[0.14] text-xs text-white/90 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />
                  <span className="text-white/65">Conductor:</span>
                  <span className="font-medium text-white">{conductorName}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Bottom Transport Controls & Scrubber */}
      <footer className="w-full max-w-2xl mx-auto space-y-4 z-10 shrink-0">
        <SanctuaryScrubber fallbackDuration={fallbackDuration} onSeek={seek} />

        <div className="flex items-center justify-between gap-4">
          <div className="w-36 text-xs text-white/55">
            <button
              type="button"
              onClick={onClose}
              className="hover:text-white transition-colors cursor-pointer whitespace-nowrap focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2 rounded"
            >
              Press Esc to return
            </button>
          </div>

          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={prevTrack}
              aria-label="Previous track"
              className="p-2 text-white/70 hover:text-white transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2 rounded-full"
              title="Previous Track"
            >
              <SkipBack className="w-5 h-5 fill-current" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={togglePlayPause}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              className="w-12 h-12 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-md border border-white/25 text-white flex items-center justify-center hover:scale-105 active:scale-95 transition-all cursor-pointer shadow-xl focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 fill-white stroke-white" aria-hidden="true" />
              ) : (
                <Play className="w-5 h-5 fill-white stroke-white ml-0.5" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={nextTrack}
              aria-label="Next track"
              className="p-2 text-white/70 hover:text-white transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2 rounded-full"
              title="Next Track"
            >
              <SkipForward className="w-5 h-5 fill-current" aria-hidden="true" />
            </button>
          </div>

          {/* Volume */}
          <div className="flex items-center gap-2.5 w-36 justify-end">
            <button
              type="button"
              onClick={toggleMute}
              aria-label={isMuted || volume === 0 ? 'Unmute' : 'Mute'}
              className="text-white/70 hover:text-white transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2 rounded"
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="w-4 h-4 text-rose-400" aria-hidden="true" />
              ) : (
                <Volume2 className="w-4 h-4" aria-hidden="true" />
              )}
            </button>
            <input
              type="range"
              aria-label="Volume"
              min={0}
              max={1}
              step={0.01}
              value={isPurityMode ? 1 : isMuted ? 0 : volume}
              disabled={isPurityMode}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-20 h-1 bg-white/25 rounded-lg appearance-none cursor-pointer accent-white focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2"
            />
          </div>
        </div>

        {/* Simplified Footer Status */}
        <div className="text-center text-xs text-white/55 pt-0.5">
          {footerTierLabel}
          {sampleRateKhz ? ` · ${sampleRateKhz}` : ''}
          {` · ${footerStatusLabel}`}
        </div>
      </footer>
    </div>
  )
}
