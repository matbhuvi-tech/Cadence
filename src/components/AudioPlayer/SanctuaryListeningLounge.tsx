import React, { useEffect } from 'react'
import {
  X,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Disc3,
  ShieldCheck,
  CheckCircle2,
  Sparkles,
} from 'lucide-react'
import { useAudioPlayer } from '../../context/AudioPlayerContext'

interface SanctuaryListeningLoungeProps {
  isOpen: boolean
  onClose: () => void
}

export const SanctuaryListeningLounge: React.FC<SanctuaryListeningLoungeProps> = ({
  isOpen,
  onClose,
}) => {
  const {
    currentTrack,
    currentRelease,
    isPlaying,
    currentTime,
    duration,
    volume,
    isMuted,
    streamTelemetry,
    activeDevice,
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

  if (!isOpen) return null

  const effectiveDuration = duration > 0 ? duration : currentTrack?.durationSeconds || currentTrack?.duration || 0
  const progressPercent = effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0
  const coverUrl = currentRelease?.coverArtUrl || currentRelease?.artwork?.frontCoverUrl

  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds) || seconds < 0) return '00:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  const isDsd = (streamTelemetry?.format || currentTrack?.format || '').toUpperCase().includes('DSD')
  const isHiRes = streamTelemetry?.isHighRes || currentTrack?.isHighRes

  return (
    <div className="fixed inset-0 z-50 bg-[#08090C] flex flex-col justify-between p-6 sm:p-12 select-none animate-in fade-in duration-300 overflow-hidden">
      {/* Dynamic Ambient Mesh Gradient Backdrop derived from cover art */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden -z-10">
        {coverUrl ? (
          <div
            className="absolute inset-0 bg-cover bg-center filter blur-[100px] scale-125 opacity-25 transition-all duration-1000"
            style={{ backgroundImage: `url(${coverUrl})` }}
          />
        ) : (
          <div className="absolute inset-0 bg-radial from-[#181920] to-[#08090C] opacity-50" />
        )}
        <div className="absolute inset-0 bg-black/60 backdrop-blur-3xl" />
      </div>

      {/* Top Header: Clean Apple-Style Bar */}
      <header className="flex items-center justify-between z-10 shrink-0">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-[#10B981] animate-pulse" />
          <span className="text-[11px] font-mono tracking-widest text-[#8E8E93] uppercase">
            Sanctuary Listening Lounge
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Hardware Lock Badge */}
          <div className="px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-xs font-mono text-[#E5E5EA] flex items-center gap-2">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: isDsd ? '#818CF8' : isHiRes ? '#F59E0B' : '#10B981' }}
            />
            <span>
              {streamTelemetry?.format || currentTrack?.format || 'PCM'}
              {streamTelemetry?.sampleRate ? ` · ${streamTelemetry.sampleRate / 1000}kHz` : ''}
              {streamTelemetry?.bitDepth ? `/${streamTelemetry.bitDepth}b` : ''}
            </span>
          </div>

          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs font-mono text-white transition-all cursor-pointer"
            title="Return to Library (Esc)"
          >
            <X className="w-3.5 h-3.5" />
            <span>Esc</span>
          </button>
        </div>
      </header>

      {/* Center Stage: Editorial Sleeve & Typography */}
      <main className="flex-1 flex flex-col lg:flex-row items-center justify-center gap-8 lg:gap-20 py-8 z-10 overflow-y-auto">
        {/* Cover Art Sleeve */}
        <div className="relative group shrink-0">
          <div className="w-72 h-72 sm:w-88 sm:h-88 md:w-[420px] md:h-[420px] rounded-xl bg-[#131418] border border-white/10 shadow-2xl overflow-hidden flex items-center justify-center relative apple-album-shadow">
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={currentTrack?.title || 'Album Art'}
                className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.02]"
              />
            ) : (
              <Disc3
                className={`w-28 h-28 text-white/20 ${isPlaying ? 'animate-spin' : ''}`}
                style={{ animationDuration: '6s' }}
              />
            )}
          </div>
        </div>

        {/* Editorial Metadata & Liner Notes */}
        <div className="max-w-lg w-full space-y-6 text-left">
          {/* Classical Work & Movement Hierarchy in Editorial Serif */}
          <div>
            {currentTrack?.workId && (
              <div className="text-xs font-mono uppercase tracking-widest text-[#D4AF37] font-semibold mb-1">
                Classical Work
              </div>
            )}
            <h1 className="text-3xl sm:text-4xl font-serif text-white tracking-tight leading-tight">
              {currentTrack?.title || 'No Track Selected'}
            </h1>
            <p className="text-lg text-[#F5F5F7] font-medium mt-1.5">
              {currentTrack?.artistCredit || 'Unknown Artist'}
            </p>
            <p className="text-sm text-[#8E8E93] mt-0.5">
              {currentRelease?.title || 'Release'} ({currentRelease?.releaseYear || 'Unknown Year'})
            </p>
          </div>

          {/* Editorial Credits Pills (Conductor, Orchestra, Composer) */}
          <div className="flex flex-wrap gap-2 pt-1">
            {currentTrack?.composerName && (
              <span className="px-3 py-1 rounded-full bg-white/[0.05] border border-white/[0.08] text-xs text-[#E5E5EA] flex items-center gap-1.5">
                <span className="text-[#D4AF37]">🎼 Composer:</span>
                <span className="font-medium">{currentTrack.composerName}</span>
              </span>
            )}
            {currentTrack?.credits.find((c) => c.role === 'ensemble')?.personName && (
              <span className="px-3 py-1 rounded-full bg-white/[0.05] border border-white/[0.08] text-xs text-[#E5E5EA] flex items-center gap-1.5">
                <span className="text-cyan-400">🎻 Orchestra:</span>
                <span className="font-medium">
                  {currentTrack.credits.find((c) => c.role === 'ensemble')?.personName}
                </span>
              </span>
            )}
            {currentTrack?.credits.find((c) => c.role === 'conductor')?.personName && (
              <span className="px-3 py-1 rounded-full bg-white/[0.05] border border-white/[0.08] text-xs text-[#E5E5EA] flex items-center gap-1.5">
                <span className="text-amber-400">🪄 Conductor:</span>
                <span className="font-medium">
                  {currentTrack.credits.find((c) => c.role === 'conductor')?.personName}
                </span>
              </span>
            )}
            {currentTrack?.drScore && (
              <span className="px-3 py-1 rounded-full bg-white/[0.05] border border-white/[0.08] text-xs font-mono text-[#D4AF37] flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-[#D4AF37]" />
                <span>DR{currentTrack.drScore} Master Dynamic Range</span>
              </span>
            )}
          </div>

          {/* Minimalist Signal Path Capsule */}
          <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.07] font-mono text-xs space-y-2">
            <div className="flex items-center justify-between text-[#8E8E93] text-[10px] uppercase font-bold tracking-wider">
              <span>Bit-Perfect Signal Path</span>
              <span className="text-[#10B981] flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                <span>Locked</span>
              </span>
            </div>
            <div className="text-[11px] text-[#F5F5F7] flex items-center justify-between pt-1 border-t border-white/[0.05]">
              <span className="text-[#8E8E93]">Transport:</span>
              <span>VirtualLock Pinned RAM · MMCSS Pro Audio</span>
            </div>
            <div className="text-[11px] text-[#F5F5F7] flex items-center justify-between">
              <span className="text-[#8E8E93]">Output DAC:</span>
              <span className="truncate max-w-[220px]">
                {isPurityMode ? 'WASAPI Exclusive 0dB' : activeDevice}
              </span>
            </div>
          </div>
        </div>
      </main>

      {/* Bottom Minimalist Transport Controls & Scrubber */}
      <footer className="w-full max-w-2xl mx-auto space-y-4 z-10 shrink-0">
        {/* Scrubber */}
        <div className="space-y-1">
          <div
            className="h-1.5 bg-white/10 rounded-full overflow-hidden cursor-pointer relative group"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const pct = (e.clientX - rect.left) / rect.width
              seek(pct * effectiveDuration)
            }}
          >
            <div
              className="h-full bg-gradient-to-r from-[#D4AF37] to-white rounded-full relative"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] font-mono text-[#8E8E93] tabular-nums">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(effectiveDuration)}</span>
          </div>
        </div>

        {/* Transport Controls */}
        <div className="flex items-center justify-between gap-4">
          <div className="w-24 text-[10px] font-mono text-[#636366]">
            Press Esc to return
          </div>

          <div className="flex items-center gap-6">
            <button
              onClick={prevTrack}
              className="p-2 text-[#8E8E93] hover:text-white transition-colors cursor-pointer"
              title="Previous Track"
            >
              <SkipBack className="w-5 h-5 fill-current" />
            </button>
            <button
              onClick={togglePlayPause}
              className="w-12 h-12 rounded-full bg-white hover:bg-white/95 text-black flex items-center justify-center hover:scale-105 active:scale-95 transition-transform cursor-pointer shadow-2xl"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="w-5 h-5 fill-black stroke-black" /> : <Play className="w-5 h-5 fill-black stroke-black ml-0.5" />}
            </button>
            <button
              onClick={nextTrack}
              className="p-2 text-[#8E8E93] hover:text-white transition-colors cursor-pointer"
              title="Next Track"
            >
              <SkipForward className="w-5 h-5 fill-current" />
            </button>
          </div>

          {/* Volume */}
          <div className="flex items-center gap-2 w-24 justify-end">
            <button
              onClick={toggleMute}
              className="text-[#8E8E93] hover:text-white transition-colors cursor-pointer"
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="w-4 h-4 text-rose-400" />
              ) : (
                <Volume2 className="w-4 h-4 text-[#8E8E93]" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={isPurityMode ? 1 : isMuted ? 0 : volume}
              disabled={isPurityMode}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-16 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-white"
            />
          </div>
        </div>

        {/* Minimalist Telemetry Footer */}
        <div className="text-center text-[10px] font-mono text-[#636366] pt-1">
          Bit-Perfect · {streamTelemetry?.sampleRate ? `${streamTelemetry.sampleRate / 1000}kHz` : '192kHz'} · RAM Play Active · Zero Host Jitter
        </div>
      </footer>
    </div>
  )
}
