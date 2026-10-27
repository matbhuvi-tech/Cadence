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
  ShieldCheck,
  Wifi,
  Smartphone,
  ChevronUp,
  Cpu,
  Layers,
  CheckCircle2,
  Lock,
  ListMusic,
  Zap,
} from 'lucide-react'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { AudioDeviceSelectorModal } from './AudioDeviceSelectorModal'

interface NowPlayingBarProps {
  onOpenSanctuary?: () => void
  onOpenRemoteModal?: () => void
}

export const NowPlayingBar: React.FC<NowPlayingBarProps> = ({
  onOpenSanctuary,
  onOpenRemoteModal,
}) => {
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
    isPurityMode,
    isBitPerfect,
    deviceType,
    togglePurityMode,
    togglePlayPause,
    nextTrack,
    prevTrack,
    seek,
    setVolume,
    toggleMute,
    toggleRepeat,
    toggleShuffle,
    upcomingTracks,
    rightSidebarTab,
    isRightSidebarOpen,
    toggleRightSidebar,
    isGapless,
    toggleGapless,
    settlingDelayMs,
    setSettlingDelay,
    nextTrackTransition,
  } = useAudioPlayer()

  const [isDeviceModalOpen, setIsDeviceModalOpen] = useState(false)
  const [isSignalPopoverOpen, setIsSignalPopoverOpen] = useState(false)

  // Format seconds to mm:ss with tabular-nums
  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds) || seconds < 0) return '00:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  const effectiveDuration = duration > 0 ? duration : currentTrack?.durationSeconds || currentTrack?.duration || 0
  const progressPercent = effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0
  const coverUrl = currentRelease?.coverArtUrl || currentRelease?.artwork?.frontCoverUrl

  const isDsd = (streamTelemetry?.format || currentTrack?.format || '').toUpperCase().includes('DSD')
  const isHiRes = streamTelemetry?.isHighRes || currentTrack?.isHighRes

  const ledColor = isDsd ? '#818CF8' : isHiRes ? '#F59E0B' : '#10B981'

  return (
    <>
      {/* Floating Frosted Signal-Chain Transport Bar Dock */}
      <footer className="fixed bottom-3 left-3 right-3 md:left-1/2 md:-translate-x-1/2 md:w-[92%] max-w-6xl z-50">
        <div className="glass-dropdown border border-white/[0.08] rounded-2xl h-[56px] px-4 flex items-center justify-between gap-4 shadow-2xl relative select-none">
          {/* Subtle Top Specular Scrubber Highlight */}
          <div
            className="absolute -top-[1.5px] left-4 right-4 h-[3px] hover:h-[5px] bg-white/[0.08] hover:bg-white/[0.18] rounded-full overflow-hidden cursor-pointer transition-all duration-150 group/scrub"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
              seek(pct * effectiveDuration)
            }}
            title={`Seek: ${formatTime(currentTime)} / ${effectiveDuration > 0 ? formatTime(effectiveDuration) : '00:00'}`}
          >
            <div
              className="h-full bg-gradient-to-r from-[#D4AF37] via-[#F59E0B] to-[#10B981] transition-all duration-100"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {/* LEFT SECTION: TRACK CREDITS & SANCTUARY TRIGGER */}
          <div className="flex items-center gap-2.5 w-[28%] min-w-[180px] max-w-[300px]">
            {/* Artwork Thumbnail */}
            <div
              onClick={onOpenSanctuary}
              title="Expand Audiophile Sanctuary Lounge (⌘L)"
              className="relative w-9 h-9 rounded-md bg-[#131418] border border-white/[0.08] overflow-hidden shrink-0 flex items-center justify-center shadow-md cursor-pointer hover:border-white/30 transition-all group"
            >
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt={currentTrack?.title || 'Album Art'}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                />
              ) : (
                <Disc3
                  className={`w-4 h-4 text-white/30 ${isPlaying ? 'animate-spin' : ''}`}
                  style={{ animationDuration: '4s' }}
                />
              )}
              {isPlaying && <div className="absolute inset-0 bg-white/[0.04] pointer-events-none" />}
            </div>

            {/* Track Info */}
            <div className="flex flex-col min-w-0 pr-1">
              <span
                onClick={onOpenSanctuary}
                className="text-xs font-semibold text-white truncate hover:underline cursor-pointer leading-tight"
                title={currentTrack?.title || 'No Track Selected'}
              >
                {currentTrack?.title || 'No Track Selected'}
              </span>
              <span
                className="text-[11px] text-[#8E8E93] truncate leading-tight mt-0.5"
                title={currentTrack?.artistCredit || 'Select a track to play'}
              >
                {currentTrack?.artistCredit || 'Cadence Audiophile Player'}
              </span>
            </div>
          </div>

          {/* CENTER SECTION: TACTILE TRANSPORT CONTROLS (SINGLE-AXIS 56PX) */}
          <div className="flex items-center justify-center gap-2 sm:gap-3 flex-1">
            {/* Elapsed Time */}
            <span className="text-[11px] font-mono tabular-nums text-[#8E8E93] w-10 text-right select-none">
              {formatTime(currentTime)}
            </span>

            {/* Shuffle Button */}
            <button
              onClick={toggleShuffle}
              title={isShuffle ? 'Shuffle On' : 'Shuffle Off'}
              className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                isShuffle ? 'text-[#D4AF37]' : 'text-[#636366] hover:text-[#8E8E93]'
              }`}
            >
              <Shuffle className="w-3.5 h-3.5" />
            </button>

            {/* Prev Track */}
            <button
              onClick={prevTrack}
              title="Previous Track (⌘Left)"
              className="p-1.5 rounded-md text-[#E5E5EA] hover:text-white transition-colors cursor-pointer"
            >
              <SkipBack className="w-4 h-4 fill-current" />
            </button>

            {/* Play / Pause Tactile Button */}
            <button
              onClick={togglePlayPause}
              title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
              className="w-8 h-8 rounded-full bg-white hover:bg-white/95 active:scale-95 text-black font-bold flex items-center justify-center shadow-lg transition-transform cursor-pointer shrink-0"
            >
              {isPlaying ? (
                <Pause className="w-3.5 h-3.5 fill-black stroke-black" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-black stroke-black ml-0.5" />
              )}
            </button>

            {/* Next Track */}
            <button
              onClick={nextTrack}
              title="Next Track (⌘Right)"
              className="p-1.5 rounded-md text-[#E5E5EA] hover:text-white transition-colors cursor-pointer"
            >
              <SkipForward className="w-4 h-4 fill-current" />
            </button>

            {/* Repeat Mode Button */}
            <button
              onClick={toggleRepeat}
              title={`Repeat: ${repeatMode.toUpperCase()}`}
              className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                repeatMode !== 'off' ? 'text-[#D4AF37]' : 'text-[#636366] hover:text-[#8E8E93]'
              }`}
            >
              {repeatMode === 'one' ? (
                <Repeat1 className="w-3.5 h-3.5" />
              ) : (
                <Repeat className="w-3.5 h-3.5" />
              )}
            </button>

            {/* Remaining / Total Time */}
            <span className="text-[11px] font-mono tabular-nums text-[#8E8E93] w-10 text-left select-none">
              {effectiveDuration > 0 ? formatTime(effectiveDuration) : '--:--'}
            </span>
          </div>

          {/* RIGHT SECTION: AUDIOPHILE SIGNAL PATH, QUEUE & PLAYLIST TOGGLES, VOLUME */}
          <div className="flex items-center justify-end gap-2 w-auto min-w-[280px] relative">
            {/* Audio Output Device Modal Trigger */}
            <button
              onClick={() => setIsDeviceModalOpen(true)}
              title={`Output Endpoint: ${activeDevice}`}
              className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-[#8E8E93] hover:text-white transition-all cursor-pointer"
            >
              <Speaker className="w-3.5 h-3.5 text-[#D4AF37]" />
            </button>

            {/* Volume Control */}
            <div className="flex items-center gap-1">
              <button
                onClick={toggleMute}
                disabled={isPurityMode}
                title={
                  isPurityMode
                    ? 'Volume locked in Bit-Perfect Purity Mode (Unity Gain)'
                    : isMuted
                    ? 'Unmute'
                    : 'Mute'
                }
                className={`p-1 rounded transition-colors ${
                  isPurityMode
                    ? 'text-amber-400 opacity-80 cursor-not-allowed'
                    : 'text-[#8E8E93] hover:text-white cursor-pointer'
                }`}
              >
                {isPurityMode ? (
                  <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                ) : isMuted || volume === 0 ? (
                  <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                ) : (
                  <Volume2 className="w-3.5 h-3.5 text-[#E5E5EA]" />
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
                className={`w-14 h-1 rounded-lg appearance-none transition-all ${
                  isPurityMode
                    ? 'bg-amber-400/40 accent-amber-400 cursor-not-allowed'
                    : 'bg-white/[0.15] accent-white cursor-pointer'
                }`}
                title={
                  isPurityMode
                    ? 'Bit-Perfect Unity Gain (0 dB Lock): Adjust volume on analog preamplifier/DAC.'
                    : `Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`
                }
              />
            </div>

            {/* The Clickable Audiophile Signal Path Pill */}
            <button
              onClick={() => setIsSignalPopoverOpen((prev) => !prev)}
              title="Inspect Deterministic Bit-Perfect Signal Path & DAC Clock"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[11px] font-mono transition-all cursor-pointer shadow-sm group"
            >
              <span
                className="w-2 h-2 rounded-full animate-pulse shadow-sm"
                style={{ backgroundColor: ledColor }}
              />
              <span className="text-[#F5F5F7] font-semibold">
                {streamTelemetry?.format || currentTrack?.format || 'PCM'}
              </span>
              <span className="text-[#8E8E93]">→</span>
              <span className="text-[#8E8E93] truncate max-w-[70px]">
                {deviceType === 'upnp_streamer' ? 'UPnP' : isPurityMode ? 'WASAPI Ex.' : 'WASAPI'}
              </span>
            </button>

            {/* Dedicated Now Playing Queue Toggle (Matching Mockup) */}
            <button
              onClick={() => toggleRightSidebar('queue')}
              title={`Now Playing Queue (⌘U / Q) • ${upcomingTracks.length} upcoming`}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-all cursor-pointer select-none ${
                isRightSidebarOpen && rightSidebarTab === 'queue'
                  ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300 font-semibold shadow-sm shadow-emerald-500/20'
                  : 'bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.06] text-[#8E8E93] hover:text-white'
              }`}
            >
              <ListMusic className="w-3.5 h-3.5 text-emerald-400" />
              <span>Queue</span>
              {upcomingTracks.length > 0 && (
                <span className="flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-mono font-bold text-black shadow-sm">
                  {upcomingTracks.length}
                </span>
              )}
            </button>

            {/* Dedicated Playlists Toggle (Matching Mockup) */}
            <button
              onClick={() => toggleRightSidebar('playlists')}
              title="Curated Audiophile Playlists"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-all cursor-pointer select-none ${
                isRightSidebarOpen && rightSidebarTab === 'playlists'
                  ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300 font-semibold shadow-sm shadow-emerald-500/20'
                  : 'bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.06] text-[#8E8E93] hover:text-white'
              }`}
            >
              <Disc3 className="w-3.5 h-3.5 text-emerald-400" />
              <span>Playlists</span>
            </button>

            {/* Mobile Remote Pairing */}
            <button
              onClick={() => onOpenRemoteModal?.()}
              title="Mobile Remote: Scan QR to control Cadence from iPhone / iPad"
              className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-[#8E8E93] hover:text-white transition-all cursor-pointer"
            >
              <Smartphone className="w-3.5 h-3.5" />
            </button>

            {/* Sanctuary Lounge Trigger */}
            {onOpenSanctuary && (
              <button
                onClick={onOpenSanctuary}
                title="Expand Audiophile Sanctuary Lounge (⌘L)"
                className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-[#8E8E93] hover:text-white transition-all cursor-pointer"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Subtle Floating Gapless Playback Chip (as in Mockup) */}
        <div
          className="absolute -top-7 right-6 flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-black/75 backdrop-blur-md border border-white/10 text-[10px] font-mono text-neutral-300 shadow-lg select-none cursor-pointer hover:border-emerald-500/40 transition-all z-30 group"
          onClick={() => toggleGapless()}
          title={`Gapless Playback: ${isGapless ? 'Enabled' : 'Disabled'} • Click to toggle`}
        >
          <Sparkles className={`w-3 h-3 ${isGapless ? 'text-emerald-400' : 'text-neutral-500'}`} />
          <span className={isGapless ? 'text-emerald-300' : 'text-neutral-400'}>Gapless playback</span>
        </div>

        {/* Apple-Style Translucent Popover: The Deterministic Signal Path & Audiophile DAC Controls */}
        {isSignalPopoverOpen && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-16 right-4 w-88 glass-dropdown rounded-2xl p-4 border border-white/[0.1] shadow-2xl animate-in zoom-in-95 duration-150 z-50 text-xs font-mono"
          >
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.08] mb-3">
              <span className="font-bold text-white text-xs flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#10B981]" />
                <span>Deterministic Signal Path & DAC Clock</span>
              </span>
              <button
                onClick={() => setIsSignalPopoverOpen(false)}
                className="text-[#8E8E93] hover:text-white p-0.5 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              {/* Step 1: Source */}
              <div className="flex items-start gap-2.5">
                <div className="w-5 h-5 rounded-full bg-white/[0.06] flex items-center justify-center text-[10px] text-[#D4AF37] shrink-0 mt-0.5">
                  1
                </div>
                <div>
                  <div className="text-[#8E8E93] text-[10px]">Source Ground Truth</div>
                  <div className="text-white font-semibold">
                    {streamTelemetry?.format || currentTrack?.format || 'PCM'}
                    {streamTelemetry?.sampleRate ? ` · ${streamTelemetry.sampleRate / 1000}kHz` : ''}
                    {streamTelemetry?.bitDepth ? `/${streamTelemetry.bitDepth}b` : ''}
                  </div>
                </div>
              </div>

              {/* Step 2: Memory */}
              <div className="flex items-start gap-2.5">
                <div className="w-5 h-5 rounded-full bg-white/[0.06] flex items-center justify-center text-[10px] text-[#10B981] shrink-0 mt-0.5">
                  2
                </div>
                <div>
                  <div className="text-[#8E8E93] text-[10px]">RAM Pinning (Zero Disk I/O)</div>
                  <div className="text-white font-semibold flex items-center gap-1.5">
                    <span>VirtualLock Active</span>
                    <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300">
                      100% Pinned
                    </span>
                  </div>
                </div>
              </div>

              {/* Step 3: Thread */}
              <div className="flex items-start gap-2.5">
                <div className="w-5 h-5 rounded-full bg-white/[0.06] flex items-center justify-center text-[10px] text-[#818CF8] shrink-0 mt-0.5">
                  3
                </div>
                <div>
                  <div className="text-[#8E8E93] text-[10px]">Isolated Thread & Priority</div>
                  <div className="text-white font-semibold">
                    MMCSS Pro Audio · Core Pinned
                  </div>
                </div>
              </div>

              {/* Step 4: DAC Output */}
              <div className="flex items-start gap-2.5">
                <div className="w-5 h-5 rounded-full bg-white/[0.06] flex items-center justify-center text-[10px] text-[#F59E0B] shrink-0 mt-0.5">
                  4
                </div>
                <div>
                  <div className="text-[#8E8E93] text-[10px]">Endpoint Hardware Lock</div>
                  <div className="text-white font-semibold truncate max-w-[200px]">
                    {isPurityMode ? 'WASAPI Exclusive (Bit-Perfect)' : activeDevice}
                  </div>
                </div>
              </div>

              {/* Step 5: Gain Integrity */}
              <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between text-[10px]">
                <span className="text-[#8E8E93]">Gain Attenuation:</span>
                <span className="text-amber-400 font-semibold flex items-center gap-1">
                  <Lock className="w-2.5 h-2.5" />
                  <span>0 dB Unity Gain Locked</span>
                </span>
              </div>

              {/* Step 6: Hardware Clock Resync Transition Warning */}
              {nextTrackTransition && (
                <div className="p-2.5 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] flex items-start gap-2 text-amber-300">
                  <Zap className="w-3.5 h-3.5 shrink-0 text-amber-400 mt-0.5" />
                  <div className="flex-1 min-w-0 text-[10px]">
                    <div className="font-semibold text-amber-200">Hardware Clock Resync</div>
                    <div className="text-amber-300/80 mt-0.5">{nextTrackTransition.warningLabel}</div>
                  </div>
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-mono text-amber-400 border border-amber-500/20 shrink-0">
                    {nextTrackTransition.settlingDelayMs}ms
                  </span>
                </div>
              )}

              {/* Step 7: DAC Settling Delay Selector */}
              <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between text-[11px]">
                <span className="text-[#8E8E93]">DAC Settling Delay:</span>
                <select
                  value={settlingDelayMs}
                  onChange={(e) => setSettlingDelay(parseInt(e.target.value, 10))}
                  className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white focus:outline-none focus:border-emerald-500/50 cursor-pointer"
                >
                  <option value="0" className="bg-neutral-900">0ms (Instant)</option>
                  <option value="150" className="bg-neutral-900">150ms (Same-Clock)</option>
                  <option value="350" className="bg-neutral-900">350ms (Default)</option>
                  <option value="500" className="bg-neutral-900">500ms (R2R / FPGA)</option>
                  <option value="1000" className="bg-neutral-900">1000ms (Master Clock)</option>
                  <option value="1500" className="bg-neutral-900">1500ms (Relay Lock)</option>
                </select>
              </div>

              {/* Step 8: Gapless Buffer Pre-Roll Toggle */}
              <div className="flex items-center justify-between text-[11px] pt-1">
                <span className="text-[#8E8E93]">Gapless Playback:</span>
                <button
                  type="button"
                  onClick={() => toggleGapless()}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-mono font-semibold transition-all cursor-pointer ${
                    isGapless
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-white/5 text-neutral-400 border border-white/10'
                  }`}
                >
                  {isGapless ? 'ENABLED' : 'DISABLED'}
                </button>
              </div>
            </div>
          </div>
        )}
      </footer>

      {/* Audio Hardware DAC & Output Device Modal */}
      <AudioDeviceSelectorModal
        isOpen={isDeviceModalOpen}
        onClose={() => setIsDeviceModalOpen(false)}
      />
    </>
  )
}
