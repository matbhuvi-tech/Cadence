import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, SkipBack, SkipForward, Disc3, Shield, ShieldAlert, RefreshCw, Speaker, ChevronDown } from 'lucide-react';
import type { PlaybackStatus, AudioStreamInfo } from '../../types/remote';
import { getArtworkUrl } from '../../services/api';
import { VolumeGuard } from './VolumeGuard';

interface NowPlayingViewProps {
  status: PlaybackStatus;
  token: string;
  baseUrl?: string;
  onClose?: () => void;
  onPlayPause: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  onSeek: (posSecs: number) => void;
  onVolumeChange: (vol: number) => void;
  onTogglePurity: (enabled: boolean) => void;
  outputDevices: string[];
  isLoadingDevices: boolean;
  isChangingDevice: boolean;
  deviceError: string | null;
  onChangeOutputDevice: (deviceName: string) => void;
  onRefreshOutputDevices: () => void;
}

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function formatSignalSource(stream?: AudioStreamInfo | null): string {
  if (!stream) return 'PCM';
  const fmt = (stream.format || 'PCM').toUpperCase();
  if (fmt.includes('DSD') || fmt.includes('DSF') || fmt.includes('DFF')) {
    let rateStr = '';
    if (stream.sampleRate) {
      const mhz = (stream.sampleRate / 1000000).toFixed(1);
      rateStr = ` ${mhz}MHz`;
    }
    return `${fmt}${rateStr}`;
  }
  const sr = stream.sampleRate ? ` ${(stream.sampleRate / 1000).toFixed(1).replace('.0', '')}kHz` : '';
  const bd = stream.bitDepth ? `/${stream.bitDepth}bit` : '';
  return `${fmt}${sr}${bd}`;
}

export const NowPlayingView: React.FC<NowPlayingViewProps> = ({
  status,
  token,
  baseUrl,
  onClose,
  onPlayPause,
  onNextTrack,
  onPrevTrack,
  onSeek,
  onVolumeChange,
  onTogglePurity,
  outputDevices,
  isLoadingDevices,
  isChangingDevice,
  deviceError,
  onChangeOutputDevice,
  onRefreshOutputDevices,
}) => {
  const [sliderPos, setSliderPos] = useState<number>(status.positionSecs);
  const [displayPosition, setDisplayPosition] = useState<number>(status.positionSecs);
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);
  const [artworkLoaded, setArtworkLoaded] = useState<boolean>(false);
  const positionAnchor = useRef({ position: status.positionSecs, at: performance.now() });

  // Android hardware back button & iOS edge swipe integration
  useEffect(() => {
    if (!onClose) return;
    window.history.pushState({ modal: 'now-playing' }, '');
    const handlePopState = () => {
      onClose();
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [onClose]);

  const handleDismiss = () => {
    if (window.history.state?.modal === 'now-playing') {
      window.history.back();
    } else if (onClose) {
      onClose();
    }
  };

  // Sync slider position with server updates when not scrubbing
  useEffect(() => {
    if (!isScrubbing) {
      setSliderPos(status.positionSecs);
    }
    positionAnchor.current = { position: status.positionSecs, at: performance.now() };
    setDisplayPosition(status.positionSecs);
  }, [status.positionSecs, isScrubbing]);

  useEffect(() => {
    if (!status.isPlaying || status.isPaused || isScrubbing) return;
    let frame = 0;
    const updatePosition = (now: number) => {
      const elapsed = (now - positionAnchor.current.at) / 1000;
      const next = Math.min(status.durationSecs || Number.POSITIVE_INFINITY, positionAnchor.current.position + elapsed);
      setDisplayPosition(next);
      if (next < status.durationSecs) frame = requestAnimationFrame(updatePosition);
    };
    frame = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(frame);
  }, [status.isPlaying, status.isPaused, status.durationSecs, status.currentFile, isScrubbing]);

  const stream = status.streamInfo;
  const trackTitle = stream?.title || (status.currentFile ? status.currentFile.split(/[/\\]/).pop() : 'No Track Loaded');
  const artistName = stream?.artist || 'Cadence Transport Engine';
  const albumName = stream?.album || 'Ready for Playback';

  const artworkId = status.currentFile || '';
  const artworkUrl = artworkId ? getArtworkUrl(artworkId, token, baseUrl) : '';
  const upnpRouteLocked = Boolean(status.isPlaying && status.activeDevice?.startsWith('[UPnP]'));

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSliderPos(parseFloat(e.target.value));
  };

  const handleSliderCommit = () => {
    setIsScrubbing(false);
    onSeek(sliderPos);
  };

  const dspModeNode = status.purityMode
    ? 'PURITY (0dB)'
    : status.isBitPerfect
    ? 'RAW STREAM'
    : 'OS MIXER';
  const outputNode = status.activeDevice ? status.activeDevice.replace(/^\[.*?\]\s*/, '') : 'WASAPI Shared';

  return (
    <div className="flex-1 flex flex-col justify-between items-center px-6 py-3 overflow-y-auto no-scrollbar max-w-md mx-auto w-full select-none">
      {/* Modal Dismiss Affordance (Apple HIG) */}
      {onClose && (
        <div className="w-full flex items-center justify-between pb-1 shrink-0">
          <button
            onClick={handleDismiss}
            className="w-10 h-10 rounded-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800/60 active:scale-95 transition-all"
            aria-label="Dismiss Now Playing"
          >
            <ChevronDown className="w-6 h-6" />
          </button>
          <div className="w-10 h-1 rounded-full bg-zinc-700/60 mx-auto" />
          <div className="w-10" />
        </div>
      )}

      {/* TIER 2: 3-Node Hardware Signal Chain */}
      <div className="w-full my-2 px-3 py-1.5 rounded-2xl bg-zinc-900/80 border border-zinc-800/80 flex items-center justify-between text-[10px] font-mono text-zinc-400 gap-1.5 shrink-0 overflow-x-auto no-scrollbar">
        <span className="px-2 py-0.5 rounded-lg bg-zinc-800/90 text-amber-300 font-semibold truncate shrink-0">
          {formatSignalSource(stream)}
        </span>
        <span className="text-zinc-600 font-bold shrink-0">➔</span>
        <span
          className={`px-2 py-0.5 rounded-lg font-semibold truncate shrink-0 ${
            status.purityMode
              ? 'bg-amber-500/10 text-[#D4AF37] border border-amber-500/30'
              : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {dspModeNode}
        </span>
        <span className="text-zinc-600 font-bold shrink-0">➔</span>
        <span className="px-2 py-0.5 rounded-lg bg-zinc-800/90 text-zinc-200 truncate shrink-0">
          {outputNode}
        </span>
      </div>

      {/* TIER 3: Artwork Section */}
      <div className="relative my-auto flex flex-col items-center">
        <div
          className={`relative w-60 h-60 sm:w-68 sm:h-68 rounded-3xl overflow-hidden bg-zinc-900 border border-zinc-800 shadow-2xl transition-all duration-700 ${
            status.isPlaying ? 'shadow-[0_0_35px_rgba(212,175,55,0.18)]' : ''
          }`}
        >
          {artworkUrl ? (
            <img
              src={artworkUrl}
              alt={trackTitle || 'Album Art'}
              onLoad={() => setArtworkLoaded(true)}
              onError={() => setArtworkLoaded(false)}
              className={`w-full h-full object-cover transition-opacity duration-300 ${
                artworkLoaded ? 'opacity-100' : 'opacity-0'
              }`}
            />
          ) : null}

          {/* Fallback vinyl graphic */}
          {(!artworkUrl || !artworkLoaded) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-zinc-900 via-zinc-950 to-black text-zinc-600">
              <Disc3 className={`w-20 h-20 stroke-[1.2] ${status.isPlaying ? 'animate-spin-slow' : ''}`} style={{ animationDuration: '10s' }} />
              <span className="text-[10px] font-mono tracking-widest text-zinc-500 mt-2">CADENCE ENGINE</span>
            </div>
          )}
        </div>
      </div>

      {/* Track Metadata & Dynamic Range */}
      <div className="w-full text-center mt-3 mb-2">
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-zinc-100 truncate">
          {trackTitle}
        </h2>
        <p className="text-sm font-medium text-zinc-400 truncate mt-1">
          {artistName}
        </p>
        <p className="text-xs text-zinc-600 truncate mt-0.5">
          {albumName}
        </p>

        {/* Dynamic Range Badge & Container Spec */}
        <div className="inline-flex items-center space-x-2 mt-2">
          <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-[10px] font-mono font-bold text-amber-400">
            DR 14
          </span>
          {stream && (
            <div className="inline-flex items-center space-x-1.5 px-3 py-0.5 rounded-full bg-zinc-900/90 border border-zinc-800 text-[11px] font-mono text-[#D4AF37]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#D4AF37]" />
              <span>{formatSignalSource(stream)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Scrubber Progress Bar */}
      <div className="w-full max-w-sm flex flex-col space-y-1 mb-2">
        <div className="relative flex items-center">
          <input
            type="range"
            min="0"
            max={status.durationSecs > 0 ? status.durationSecs : 100}
            step="0.5"
            value={isScrubbing ? sliderPos : displayPosition}
            onMouseDown={() => setIsScrubbing(true)}
            onTouchStart={() => setIsScrubbing(true)}
            onChange={handleSliderChange}
            onMouseUp={handleSliderCommit}
            onTouchEnd={handleSliderCommit}
            className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
          />
        </div>
        <div className="flex justify-between text-[11px] font-mono text-zinc-500 px-0.5">
          <span>{formatTime(isScrubbing ? sliderPos : displayPosition)}</span>
          <span>-{formatTime(Math.max(0, status.durationSecs - (isScrubbing ? sliderPos : displayPosition)))}</span>
        </div>
      </div>

      {/* Transport Controls (Apple HIG 48px+ Touch Targets) */}
      <div className="flex items-center justify-center space-x-6 mb-4">
        <button
          onClick={onPrevTrack}
          aria-label="Previous Track"
          className="w-12 h-12 rounded-full flex items-center justify-center text-zinc-300 hover:text-white hover:bg-zinc-800/60 active:scale-95 transition-all"
        >
          <SkipBack className="w-6 h-6 fill-current" />
        </button>

        <button
          onClick={onPlayPause}
          aria-label={status.isPlaying ? 'Pause' : 'Play'}
          className="w-16 h-16 rounded-full bg-[#D4AF37] text-zinc-950 flex items-center justify-center shadow-[0_0_25px_rgba(212,175,55,0.35)] hover:brightness-110 active:scale-95 transition-all"
        >
          {status.isPlaying ? (
            <Pause className="w-7 h-7 fill-current" />
          ) : (
            <Play className="w-7 h-7 fill-current translate-x-0.5" />
          )}
        </button>

        <button
          onClick={onNextTrack}
          aria-label="Next Track"
          className="w-12 h-12 rounded-full flex items-center justify-center text-zinc-300 hover:text-white hover:bg-zinc-800/60 active:scale-95 transition-all"
        >
          <SkipForward className="w-6 h-6 fill-current" />
        </button>
      </div>

      {/* Interactive Output Device Selector */}
      <div className="w-full max-w-sm mx-auto bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-3 flex flex-col space-y-2 mb-2">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span className="flex items-center gap-1.5 font-medium"><Speaker className="w-4 h-4 text-[#D4AF37]" />Output Device</span>
          <button type="button" onClick={onRefreshOutputDevices} disabled={isLoadingDevices || isChangingDevice} aria-label="Refresh output devices" className="p-1 rounded text-zinc-400 hover:text-white disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingDevices ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <select
          aria-label="Output device"
          value={status.activeDevice || ''}
          onChange={(event) => onChangeOutputDevice(event.target.value)}
          disabled={isLoadingDevices || isChangingDevice || outputDevices.length === 0 || upnpRouteLocked}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 outline-none focus:border-[#D4AF37]/60 disabled:opacity-60"
        >
          {outputDevices.length === 0 ? <option value="">{isLoadingDevices ? 'Searching outputs…' : 'No output devices found'}</option> : null}
          {outputDevices.map((device) => <option key={device} value={device}>{device}</option>)}
        </select>
        {upnpRouteLocked && <p className="text-[11px] text-zinc-500">Stop playback before switching UPnP renderers to keep the current stream uninterrupted.</p>}
        {deviceError && <p role="alert" className="text-[11px] text-rose-400">{deviceError}</p>}
        {isChangingDevice && <p className="text-[11px] text-zinc-500">Switching output…</p>}
      </div>

      {/* Purity Switch & Volume Guard */}
      <div className="w-full flex flex-col space-y-3 mb-2">
        <div className="flex items-center justify-center">
          <button
            onClick={() => onTogglePurity(!status.purityMode)}
            className={`flex items-center space-x-2 px-3 py-1 rounded-full border text-xs font-medium transition-all ${
              status.purityMode
                ? 'bg-amber-500/10 border-amber-500/30 text-[#D4AF37]'
                : 'bg-zinc-900 border-zinc-800 text-zinc-500'
            }`}
          >
            {status.purityMode ? (
              <Shield className="w-3.5 h-3.5 text-[#D4AF37]" />
            ) : (
              <ShieldAlert className="w-3.5 h-3.5 text-zinc-500" />
            )}
            <span>Purity Mode (0 dB): {status.purityMode ? 'ON' : 'OFF'}</span>
          </button>
        </div>

        <VolumeGuard
          volume={status.volume}
          isBitPerfect={status.purityMode || status.isBitPerfect}
          onVolumeChange={onVolumeChange}
        />
      </div>
    </div>
  );
};
