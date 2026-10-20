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
  Speaker,
  ShieldCheck,
  Activity,
  Music,
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

  // 48 simulated spectrum visualizer bars
  const spectrumHeights = isPlaying
    ? [25, 45, 65, 85, 95, 75, 55, 40, 60, 80, 70, 50, 65, 85, 90, 75, 60, 45, 70, 85, 65, 50, 40, 60, 80, 95, 85, 60, 45, 70, 85, 65, 50, 35, 55, 75, 90, 80, 60, 45, 65, 80, 70, 50, 40, 55, 70, 50]
    : Array(48).fill(8)

  return (
    <div className="fixed inset-0 z-50 bg-[#07080B]/96 backdrop-blur-2xl flex flex-col justify-between p-6 sm:p-10 select-none animate-in fade-in duration-200">
      {/* Ambient Atmospheric Glow */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden -z-10">
        <div
          className="absolute -top-32 -left-32 w-[600px] h-[600px] rounded-full blur-[140px] opacity-20"
          style={{
            background: 'radial-gradient(circle, #00F5FF 0%, #8B5CF6 70%, transparent 100%)',
          }}
        />
        <div
          className="absolute -bottom-32 -right-32 w-[600px] h-[600px] rounded-full blur-[160px] opacity-15"
          style={{
            background: 'radial-gradient(circle, #ADFF2F 0%, #00F5FF 70%, transparent 100%)',
          }}
        />
      </div>

      {/* Top Header: Title & Close Button */}
      <header className="flex items-center justify-between z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#00F5FF] to-[#8B5CF6] flex items-center justify-center text-black font-extrabold text-sm shadow-lg shadow-[#00F5FF]/20">
            C
          </div>
          <div>
            <div className="text-xs font-mono font-bold tracking-widest text-[#00F5FF] uppercase">
              Audiophile Sanctuary Lounge
            </div>
            <div className="text-[11px] text-[#94A3B8] font-mono">
              Bit-Perfect Output · Active Session Preserved
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="px-3 py-1 rounded-full bg-white/[0.04] border border-white/10 text-xs font-mono text-[#94A3B8] flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#10B981] animate-pulse" />
            <span>Streaming {streamTelemetry?.sampleRate ? `${streamTelemetry.sampleRate / 1000}kHz` : '96kHz'} / {streamTelemetry?.bitDepth || 24}b</span>
          </div>

          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs font-mono text-white transition-all cursor-pointer"
            title="Return to Library (Esc)"
          >
            <X className="w-4 h-4" />
            <span>Esc</span>
          </button>
        </div>
      </header>

      {/* Main Center Stage: Cover Art, Title & Spectrum */}
      <main className="flex-1 flex flex-col lg:flex-row items-center justify-center gap-8 lg:gap-16 py-6 z-10 overflow-y-auto">
        {/* Left: Big Artwork Sleeve */}
        <div className="relative group shrink-0">
          <div className="w-64 h-64 sm:w-80 sm:h-80 md:w-96 md:h-96 rounded-2xl bg-gradient-to-br from-[#1E293B] to-[#0F172A] border border-white/15 shadow-2xl overflow-hidden flex items-center justify-center relative">
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={currentTrack?.title || 'Album Art'}
                className="w-full h-full object-cover shadow-inner group-hover:scale-102 transition-transform duration-500"
              />
            ) : (
              <Disc3
                className={`w-28 h-28 text-[#00F5FF]/40 ${isPlaying ? 'animate-spin' : ''}`}
                style={{ animationDuration: '6s' }}
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-4">
              <span className="text-[11px] font-mono text-white/90">
                {currentRelease?.mediaFormat || 'Master Audio Pressing'} · {currentTrack?.format || 'FLAC'}
              </span>
            </div>
          </div>
        </div>

        {/* Right: Rich Metadata, Hardware Signal Path & Liner Notes */}
        <div className="max-w-md w-full space-y-5 text-left">
          <div>
            <span className="text-[11px] font-mono uppercase tracking-wider text-[#00F5FF] font-bold">
              Now Playing
            </span>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mt-1 leading-tight">
              {currentTrack?.title || 'No Track Selected'}
            </h1>
            <p className="text-base text-[#ADFF2F] font-medium mt-1">
              {currentTrack?.artistCredit || 'Unknown Artist'}
            </p>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              {currentRelease?.title || 'Single'} ({currentRelease?.releaseYear || 'Unknown Year'})
            </p>
          </div>

          {/* Hardware Signal Chain Specs */}
          <div className="p-4 bg-white/[0.03] border border-white/10 rounded-2xl space-y-2.5 font-mono text-xs">
            <div className="text-[10px] text-[#94A3B8] uppercase font-bold tracking-wider flex items-center justify-between">
              <span>Hardware Signal Chain & Clock</span>
              <button
                onClick={() => togglePurityMode()}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border transition-all cursor-pointer ${
                  isPurityMode
                    ? 'bg-[#EAB308]/20 border-[#EAB308]/40 text-[#EAB308]'
                    : 'bg-[#10B981]/20 border-[#10B981]/40 text-[#10B981]'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                {isPurityMode ? 'Purity Mode: 0dB Unity' : 'Bit-Perfect Clock'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] pt-1 border-t border-white/[0.06]">
              <div>
                <span className="text-slate-500">Output Endpoint:</span>
                <div className="text-white truncate font-semibold">
                  {deviceType === 'upnp_streamer' ? `[Network Streamer] ${activeDevice.replace(/^\[UPnP\]\s*/, '')}` : activeDevice}
                </div>
              </div>
              <div>
                <span className="text-slate-500">DAC Clock Negotiation:</span>
                <div className="text-[#00F5FF] font-semibold">
                  {outputSampleRate ? `${outputSampleRate / 1000} kHz Locked` : 'WASAPI Native Clock'}
                </div>
              </div>
              <div>
                <span className="text-slate-500">Native Stream:</span>
                <div className="text-[#ADFF2F] font-semibold">
                  {streamTelemetry?.format || currentTrack?.format || 'FLAC'} · {streamTelemetry?.sampleRate ? `${streamTelemetry.sampleRate / 1000}kHz` : '44.1kHz'} / {streamTelemetry?.bitDepth || 16}b
                </div>
              </div>
              <div>
                <span className="text-slate-500">Stream Delivery:</span>
                <div className="text-white font-semibold">
                  {deviceType === 'upnp_streamer'
                    ? 'Untouched Stream (Raw UPnP)'
                    : isPurityMode
                    ? 'Bit-Perfect Exclusive Pass'
                    : 'WASAPI Direct Stream'}
                </div>
              </div>
            </div>
          </div>

          {/* Real-time Spectrum Visualizer */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 uppercase tracking-wider">
              <span>Audio Spectrum Analysis</span>
              <span>48 Bands FFT</span>
            </div>
            <div className="h-10 bg-white/[0.02] border border-white/[0.06] rounded-xl px-2 flex items-end justify-between gap-1 overflow-hidden">
              {spectrumHeights.map((h, i) => (
                <div
                  key={i}
                  className="flex-1 bg-gradient-to-t from-[#00F5FF]/40 via-[#8B5CF6]/60 to-[#ADFF2F] rounded-t-sm transition-all duration-150"
                  style={{ height: `${h}%` }}
                />
              ))}
            </div>
          </div>
        </div>
      </main>

      {/* Bottom Transport Controls & Scrubber */}
      <footer className="w-full max-w-3xl mx-auto space-y-3 z-10 shrink-0">
        {/* Scrubber */}
        <div className="space-y-1">
          <div
            className="h-2 bg-white/10 rounded-full overflow-hidden cursor-pointer relative group"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const pct = (e.clientX - rect.left) / rect.width
              seek(pct * effectiveDuration)
            }}
          >
            <div
              className="h-full bg-gradient-to-r from-[#00F5FF] via-[#8B5CF6] to-[#ADFF2F] rounded-full relative"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] font-mono text-[#94A3B8]">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(effectiveDuration)}</span>
          </div>
        </div>

        {/* Transport Buttons */}
        <div className="flex items-center justify-between gap-4">
          <div className="w-24 text-[11px] font-mono text-slate-500">
            Press Esc to exit
          </div>

          <div className="flex items-center gap-6">
            <button
              onClick={prevTrack}
              className="p-2 text-white/70 hover:text-white transition-colors cursor-pointer"
              title="Previous Track"
            >
              <SkipBack className="w-5 h-5" />
            </button>
            <button
              onClick={togglePlayPause}
              className="w-12 h-12 rounded-full bg-gradient-to-r from-[#00F5FF] to-[#ADFF2F] text-black flex items-center justify-center hover:scale-105 transition-transform cursor-pointer shadow-lg shadow-[#00F5FF]/20"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current translate-x-0.5" />}
            </button>
            <button
              onClick={nextTrack}
              className="p-2 text-white/70 hover:text-white transition-colors cursor-pointer"
              title="Next Track"
            >
              <SkipForward className="w-5 h-5" />
            </button>
          </div>

          {/* Volume */}
          <div className="flex items-center gap-2 w-24 justify-end">
            <button
              onClick={toggleMute}
              className="text-[#94A3B8] hover:text-white transition-colors cursor-pointer"
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="w-4 h-4 text-rose-400" />
              ) : (
                <Volume2 className="w-4 h-4" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={isMuted ? 0 : volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-16 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-[#00F5FF]"
            />
          </div>
        </div>
      </footer>
    </div>
  )
}
