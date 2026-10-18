import React, { useState } from 'react'
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Repeat,
  Repeat1,
  Shuffle,
  Disc3,
  Speaker,
  Sparkles,
  Maximize2,
} from 'lucide-react'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { AudioDeviceSelectorModal } from './AudioDeviceSelectorModal'

interface NowPlayingBarProps {
  onOpenSanctuary?: () => void
}

export const NowPlayingBar: React.FC<NowPlayingBarProps> = ({ onOpenSanctuary }) => {
  const {
    currentTrack,
    currentRelease,
    isPlaying,
    currentTime,
    duration,
    volume,
    isMuted,
    repeatMode,
    isShuffle,
    streamTelemetry,
    activeDevice,
    togglePlayPause,
    nextTrack,
    prevTrack,
    seek,
    setVolume,
    toggleMute,
    toggleRepeat,
    toggleShuffle,
  } = useAudioPlayer()

  const [isDeviceModalOpen, setIsDeviceModalOpen] = useState(false)

  // Format seconds to mm:ss
  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds) || seconds < 0) return '00:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  const effectiveDuration = duration > 0 ? duration : currentTrack?.durationSeconds || currentTrack?.duration || 0
  const progressPercent = effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0
  const coverUrl = currentRelease?.coverArtUrl || currentRelease?.artwork?.frontCoverUrl

  return (
    <>
      <footer className="h-18 border-t border-white/[0.08] bg-[#0E1118]/90 backdrop-blur-2xl px-4 flex items-center justify-between gap-4 shrink-0 z-40 relative shadow-2xl">
        {/* Progress Bar Top Highlight */}
        <div
          className="absolute top-0 left-0 h-[2px] bg-gradient-to-r from-[#00F5FF] via-[#8B5CF6] to-[#ADFF2F] transition-all duration-150"
          style={{ width: `${progressPercent}%` }}
        />

        {/* LEFT SECTION: TRACK & ALBUM CREDITS */}
        <div className="flex items-center gap-3 w-1/4 min-w-[220px] max-w-[340px]">
          {/* Cover Art Thumbnail */}
          <div
            onClick={onOpenSanctuary}
            title="Expand Audiophile Sanctuary Lounge (⌘L)"
            className="relative w-12 h-12 rounded-xl bg-gradient-to-br from-white/[0.06] to-white/[0.02] border border-white/[0.1] overflow-hidden shrink-0 flex items-center justify-center shadow-md cursor-pointer hover:border-[#00F5FF]/50 transition-all group"
          >
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={currentTrack?.title || 'Album Art'}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
              />
            ) : (
              <Disc3
                className={`w-6 h-6 text-[#00F5FF] ${
                  isPlaying ? 'animate-spin' : ''
                }`}
                style={{ animationDuration: '4s' }}
              />
            )}
            {isPlaying && (
              <div className="absolute inset-0 bg-[#00F5FF]/10 pointer-events-none" />
            )}
          </div>

          {/* Track Titles & Metadata */}
          <div className="flex flex-col min-w-0 pr-1">
            <span
              className="text-xs font-bold text-white truncate hover:underline cursor-pointer"
              title={currentTrack?.title || 'No Track Selected'}
            >
              {currentTrack?.title || 'No Track Selected'}
            </span>
            <span
              className="text-[11px] text-[#94A3B8] truncate"
              title={currentTrack?.artistCredit || 'Select a track to play'}
            >
              {currentTrack?.artistCredit || 'Cadence Audiophile Player'}
            </span>

            {/* Audiophile Quality Tag */}
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-[#00F5FF]/15 text-[#00F5FF] border border-[#00F5FF]/30 truncate">
                {streamTelemetry?.format || currentTrack?.format || 'PCM'}
                {streamTelemetry?.sampleRate
                  ? ` · ${streamTelemetry.sampleRate / 1000}kHz`
                  : ''}
                {streamTelemetry?.bitDepth ? `/${streamTelemetry.bitDepth}b` : ''}
              </span>
              {(streamTelemetry?.isHighRes || currentTrack?.isHighRes) && (
                <span className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-[#ADFF2F]/15 text-[#ADFF2F] border border-[#ADFF2F]/30 flex items-center gap-0.5">
                  <Sparkles className="w-2.5 h-2.5" />
                  Hi-Res
                </span>
              )}
            </div>
          </div>
        </div>

        {/* CENTER SECTION: TRANSPORT CONTROLS & TIMELINE SCRUBBER */}
        <div className="flex flex-col items-center justify-center flex-1 max-w-xl">
          {/* Controls Bar */}
          <div className="flex items-center gap-4 mb-1">
            {/* Shuffle Button */}
            <button
              onClick={toggleShuffle}
              title={isShuffle ? 'Shuffle On' : 'Shuffle Off'}
              className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                isShuffle
                  ? 'text-[#00F5FF] bg-[#00F5FF]/15'
                  : 'text-[#64748B] hover:text-white'
              }`}
            >
              <Shuffle className="w-3.5 h-3.5" />
            </button>

            {/* Prev Track */}
            <button
              onClick={prevTrack}
              title="Previous Track (⌘Left)"
              className="p-1.5 rounded-lg text-[#CBD5E1] hover:text-white hover:bg-white/[0.05] transition-colors cursor-pointer"
            >
              <SkipBack className="w-4 h-4 fill-current" />
            </button>

            {/* Play / Pause Glow Button */}
            <button
              onClick={togglePlayPause}
              title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
              className="w-9 h-9 rounded-full bg-gradient-to-br from-[#00F5FF] to-[#8B5CF6] text-black font-bold flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-transform cursor-pointer glow-cyan"
            >
              {isPlaying ? (
                <Pause className="w-4 h-4 fill-black stroke-black" />
              ) : (
                <Play className="w-4 h-4 fill-black stroke-black ml-0.5" />
              )}
            </button>

            {/* Next Track */}
            <button
              onClick={nextTrack}
              title="Next Track (⌘Right)"
              className="p-1.5 rounded-lg text-[#CBD5E1] hover:text-white hover:bg-white/[0.05] transition-colors cursor-pointer"
            >
              <SkipForward className="w-4 h-4 fill-current" />
            </button>

            {/* Repeat Mode Button */}
            <button
              onClick={toggleRepeat}
              title={`Repeat: ${repeatMode.toUpperCase()}`}
              className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                repeatMode !== 'off'
                  ? 'text-[#ADFF2F] bg-[#ADFF2F]/15'
                  : 'text-[#64748B] hover:text-white'
              }`}
            >
              {repeatMode === 'one' ? (
                <Repeat1 className="w-3.5 h-3.5" />
              ) : (
                <Repeat className="w-3.5 h-3.5" />
              )}
            </button>
          </div>

          {/* Scrubber Slider with Time Labels */}
          <div className="w-full flex items-center gap-2 text-[10px] font-mono text-[#94A3B8]">
            <span className="w-10 text-right">{formatTime(currentTime)}</span>
            <div className="relative flex-1 flex items-center group cursor-pointer">
              <input
                type="range"
                min={0}
                max={effectiveDuration || 100}
                step={0.1}
                value={currentTime}
                onChange={(e) => seek(Number(e.target.value))}
                className="w-full h-1 bg-white/[0.1] rounded-lg appearance-none cursor-pointer accent-[#00F5FF] group-hover:h-1.5 transition-all"
              />
            </div>
            <span className="w-10 text-left">
              {effectiveDuration > 0
                ? formatTime(effectiveDuration)
                : '--:--'}
            </span>
          </div>
        </div>

        {/* RIGHT SECTION: HARDWARE DAC SELECTOR, VU METERS & VOLUME */}
        <div className="flex items-center justify-end gap-3 w-1/4 min-w-[220px] max-w-[340px]">
          {/* Animated Mini Spectrum / VU Bars */}
          <div className="hidden sm:flex items-center gap-0.5 h-4 px-2 py-0.5 rounded bg-black/40 border border-white/[0.06]">
            {[0.4, 0.8, 0.3, 0.9, 0.6, 0.2].map((heightRatio, i) => (
              <span
                key={i}
                className={`w-0.5 rounded-full bg-[#00F5FF] transition-all duration-75 ${
                  isPlaying ? 'animate-pulse' : 'opacity-30'
                }`}
                style={{
                  height: isPlaying ? `${heightRatio * 100}%` : '20%',
                  animationDelay: `${i * 120}ms`,
                }}
              />
            ))}
          </div>

          {/* Audio Output Device Selector Button */}
          <button
            onClick={() => setIsDeviceModalOpen(true)}
            title={`Active Audio Device: ${activeDevice}`}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[11px] font-mono text-[#CBD5E1] hover:text-white transition-all cursor-pointer truncate max-w-[130px]"
          >
            <Speaker className="w-3 h-3 text-[#ADFF2F] shrink-0" />
            <span className="truncate">{activeDevice.split('(')[0]}</span>
          </button>

          {/* Volume Control */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={toggleMute}
              title={isMuted ? 'Unmute' : 'Mute'}
              className="p-1 rounded text-[#94A3B8] hover:text-white transition-colors cursor-pointer"
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="w-4 h-4 text-rose-400" />
              ) : (
                <Volume2 className="w-4 h-4 text-[#CBD5E1]" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={isMuted ? 0 : volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-18 h-1 bg-white/[0.1] rounded-lg appearance-none cursor-pointer accent-[#00F5FF]"
              title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
            />
            {/* Expand Sanctuary Lounge Button */}
            {onOpenSanctuary && (
              <button
                onClick={onOpenSanctuary}
                title="Expand Audiophile Sanctuary Lounge (⌘L)"
                className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-[#94A3B8] hover:text-[#00F5FF] transition-all cursor-pointer ml-1"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </footer>

      {/* Audio Hardware DAC & Output Device Modal */}
      <AudioDeviceSelectorModal
        isOpen={isDeviceModalOpen}
        onClose={() => setIsDeviceModalOpen(false)}
      />
    </>
  )
}
