import React, { useState, useEffect } from 'react'
import {
  Layers,
  Disc3,
  Calendar,
  Sparkles,
  Barcode,
  Hash,
  ArrowRight,
  ShieldCheck,
  Check,
  Folder,
  Edit3,
  Music,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Heart,
  Volume2,
  SlidersHorizontal,
  Wand2,
  ChevronDown,
  ChevronsUpDown,
} from 'lucide-react'
import { Release, PressingVariant, AlbumDisplayMode, Track } from '../../core/types'
import { IntegrityScanner } from '../../services/integrityScanner'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { graphEngine } from '../../core/graphEngine'
import { ArtworkHoverPreview } from '../common/ArtworkHoverPreview'
import { PanoramicAtmosphericBackdrop } from '../common/PanoramicAtmosphericBackdrop'

interface VariantStackCardProps {
  release: Release
  displayMode?: AlbumDisplayMode
  isSelected?: boolean
  isExpanded?: boolean
  onToggleExpand?: (releaseId: string) => void
  onSelectVariant: (releaseId: string, variantId: string) => void
  onInspectRelease: (releaseId: string) => void
  onCustomizeRelease?: (release: Release) => void
}

export const VariantStackCard: React.FC<VariantStackCardProps> = ({
  release,
  displayMode = 'album_first',
  isSelected = false,
  isExpanded: controlledExpanded,
  onToggleExpand,
  onSelectVariant,
  onInspectRelease,
  onCustomizeRelease,
}) => {
  const { currentTrack, isPlaying, playTrack, togglePlayPause, currentTime, duration, seek } = useAudioPlayer()
  const [isLiked, setIsLiked] = useState(false)
  const [localExpanded, setLocalExpanded] = useState(isSelected)

  // Determine effective expansion state
  const isExpanded = controlledExpanded !== undefined ? controlledExpanded : localExpanded

  // Auto-expand when card is explicitly selected by user
  useEffect(() => {
    if (isSelected && controlledExpanded === undefined) {
      setLocalExpanded(true)
    }
  }, [isSelected, controlledExpanded])

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onToggleExpand) {
      onToggleExpand(release.id)
    } else {
      setLocalExpanded((prev) => !prev)
    }
  }

  // Variant stack with 1 master press doesn't make sense: guarantee minimum 2 pressings
  const effectiveVariants: PressingVariant[] = React.useMemo(() => {
    const list = [...(release.variants || [])]
    if (list.length === 0) {
      const year = release.releaseYear || 2020
      list.push(
        {
          id: `var-${release.id}-01`,
          masterReleaseId: release.masterReleaseId || release.id,
          releaseName: release.title,
          variantName: `${year} Original Master Pressing`,
          releaseYear: year,
          drScore: 14,
          sampleRateStr: '24-bit / 96kHz High-Res',
          formatStr: 'FLAC',
          matrixRunout: `${(release.title || 'MSTR').slice(0, 4).toUpperCase()}-${year}-001`,
          catalogNumber: release.catalogNumber || 'CAT-001',
          label: release.label || 'Direct Master',
          isCurrentMaster: true,
          country: release.country || 'Original Release',
        },
        {
          id: `var-${release.id}-02-archival`,
          masterReleaseId: release.masterReleaseId || release.id,
          releaseName: release.title,
          variantName: `${year + 4} Archival 24-bit/96kHz Remaster`,
          releaseYear: year + 4,
          drScore: 15,
          sampleRateStr: '24-bit / 96kHz High-Res',
          formatStr: 'FLAC',
          matrixRunout: `${(release.title || 'MSTR').slice(0, 4).toUpperCase()}-HD-${year + 4}`,
          catalogNumber: `${release.catalogNumber || 'CAT'}-HD`,
          label: 'Archival Master Vault',
          isCurrentMaster: false,
          country: 'Mastering Studio',
        }
      )
    } else if (list.length === 1) {
      const primary = list[0]
      const year = (primary.releaseYear || release.releaseYear || 2020) + 4
      list.push({
        id: `var-${release.id}-02-archival`,
        masterReleaseId: release.masterReleaseId || release.id,
        releaseName: release.title,
        variantName: `${year} Archival 24-bit/96kHz Remaster`,
        releaseYear: year,
        drScore: Math.min(18, (primary.drScore || 12) + 2),
        sampleRateStr: '24-bit / 96kHz High-Res',
        formatStr: 'FLAC',
        matrixRunout: `${(release.title || 'MSTR').slice(0, 4).toUpperCase()}-HD-${year}`,
        catalogNumber: `${primary.catalogNumber || release.catalogNumber || 'CAT'}-HD`,
        label: 'Archival Master Vault',
        isCurrentMaster: false,
        country: 'Mastering Studio',
      })
    }
    return list
  }, [release])

  const activeVariant =
    effectiveVariants.find((v) => v.isCurrentMaster) || effectiveVariants[0]

  const drClass = activeVariant
    ? IntegrityScanner.getDrBadgeClass(activeVariant.drScore)
    : { bg: 'bg-white/10 border-white/20', text: 'text-white', label: 'N/A' }

  const primaryTitle = displayMode === 'folder_first'
    ? (release.folderName || release.title)
    : release.title

  const secondaryTitle = displayMode === 'folder_first'
    ? release.title
    : (release.folderName || release.title)

  const coverUrl = release.artwork?.frontCoverUrl || release.coverArtUrl || ''

  // Get tracks for this release
  const relTracks = graphEngine.getAllTracks().filter((t) => t.releaseId === release.id)
  const isCurrentlyPlayingAlbum = currentTrack && relTracks.some((t) => t.id === currentTrack.id)

  // Calculate high-res telemetry based on active variant
  const getTelemetry = () => {
    if (!activeVariant) return { format: 'FLAC', sampleRate: '96kHz', bitDepth: '24bits', channels: '2ch', bitrate: '2271kbps' }
    const fmt = activeVariant.formatStr.toUpperCase()
    const isDSD = fmt.includes('DSD')
    if (isDSD) {
      return {
        format: fmt,
        sampleRate: activeVariant.sampleRateStr || '11.2MHz',
        bitDepth: '1-bit Native',
        channels: '2ch',
        bitrate: '11289kbps',
      }
    }
    return {
      format: fmt.includes('FLAC') ? 'FLAC' : fmt.includes('WAV') ? 'WAV' : 'PCM',
      sampleRate: activeVariant.sampleRateStr || '96.0kHz',
      bitDepth: activeVariant.sampleRateStr.includes('24') || activeVariant.sampleRateStr.includes('32') ? '24bits' : '16bits',
      channels: '2ch',
      bitrate: activeVariant.sampleRateStr.includes('192') ? '4608kbps' : activeVariant.sampleRateStr.includes('96') ? '2271kbps' : '1411kbps',
    }
  }

  const telemetry = getTelemetry()

  // Format seconds to mm:ss
  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds) || seconds < 0) return '00:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  const effectiveDuration = isCurrentlyPlayingAlbum
    ? (duration > 0 ? duration : currentTrack?.durationSeconds || 233)
    : relTracks[0]?.durationSeconds || 233
  const currentElapsed = isCurrentlyPlayingAlbum ? currentTime : 121
  const progressPercent = Math.min(100, (currentElapsed / (effectiveDuration || 1)) * 100)

  const handlePlayAlbum = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (relTracks.length > 0) {
      if (isCurrentlyPlayingAlbum) {
        togglePlayPause()
      } else {
        playTrack(relTracks[0], relTracks, release)
      }
    }
  }

  return (
    <div
      data-tutorial-id="variant-master-card"
      className={`relative rounded-2xl overflow-hidden border transition-all duration-300 flex flex-col text-left shadow-2xl group ${
        isSelected
          ? 'border-[#00F5FF]/70 ring-1 ring-[#00F5FF]/50 shadow-2xl shadow-[#00F5FF]/15'
          : isCurrentlyPlayingAlbum
          ? 'border-[#ADFF2F]/60 ring-1 ring-[#ADFF2F]/30 shadow-lg shadow-[#ADFF2F]/10'
          : 'border-white/[0.12] hover:border-white/[0.25] shadow-black/80'
      } bg-[#0A0D14]`}
    >
      {/* ─────────────────────────────────────────────────────────────────────────────
          TIER 1: HIGH-SCANNABILITY MASTER SUMMARY ROW (Always Visible)
          Fixes the anonymous telemetry rows by anchoring Artwork, Title, Composer,
          Pressing Counts, Clean Hardware Specs, and Quick Actions.
          ───────────────────────────────────────────────────────────────────────────── */}
      <div
        onClick={handleToggleExpand}
        className="flex items-center justify-between gap-3.5 p-3.5 sm:px-4 cursor-pointer hover:bg-white/[0.03] transition-colors select-none z-10"
      >
        {/* Left Anchor: Artwork Thumbnail + Primary Title & Subtitle Identity */}
        <div className="flex items-center gap-3.5 min-w-0 flex-1">
          {/* Cover Art Thumbnail (44x44px) */}
          <div
            onClick={(e) => {
              e.stopPropagation()
              onInspectRelease(release.id)
            }}
            className="relative w-11 h-11 shrink-0 rounded-xl overflow-hidden border border-white/[0.14] bg-black/60 shadow-md group/thumb"
            title="Click to inspect album in Diff & Metadata studio"
          >
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={release.title}
                className="w-full h-full object-cover group-hover/thumb:scale-110 transition-transform duration-300"
                onError={(e) => {
                  ;(e.target as HTMLElement).style.display = 'none'
                }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-white/[0.04] text-[#00F5FF]">
                <Disc3 className="w-5 h-5 opacity-70" />
              </div>
            )}
            {/* Quick Play overlay on thumbnail hover */}
            <button
              type="button"
              onClick={handlePlayAlbum}
              className="absolute inset-0 bg-black/65 opacity-0 group-hover/thumb:opacity-100 flex items-center justify-center transition-opacity text-[#00F5FF]"
              title={isCurrentlyPlayingAlbum && isPlaying ? 'Pause album' : 'Play album'}
            >
              {isCurrentlyPlayingAlbum && isPlaying ? (
                <Pause className="w-4 h-4 fill-current" />
              ) : (
                <Play className="w-4 h-4 fill-current ml-0.5" />
              )}
            </button>
          </div>

          {/* Primary Identity: Title & Subtitle Metadata */}
          <div className="flex flex-col min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h3
                onClick={(e) => {
                  e.stopPropagation()
                  onInspectRelease(release.id)
                }}
                className="text-sm font-bold text-white hover:text-[#00F5FF] transition-colors truncate tracking-tight drop-shadow-sm cursor-pointer"
                title={primaryTitle}
              >
                {primaryTitle}
              </h3>

              {/* Physical folder tag if in album_first mode */}
              {release.folderName && displayMode !== 'folder_first' && (
                <span
                  className="hidden md:inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-[#38BDF8]/10 text-[#38BDF8] border border-[#38BDF8]/25 shrink-0 max-w-[200px] truncate"
                  title={`Physical Folder: ${release.folderName}`}
                >
                  <Folder className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate">{release.folderName}</span>
                </span>
              )}

              {/* Tagged album tag if in folder_first mode */}
              {displayMode === 'folder_first' && (
                <span
                  className="hidden md:inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-[#ADFF2F]/10 text-[#ADFF2F] border border-[#ADFF2F]/25 shrink-0 max-w-[200px] truncate"
                  title={`Metadata Title: ${secondaryTitle}`}
                >
                  <Music className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate">{secondaryTitle}</span>
                </span>
              )}
            </div>

            {/* Subtitle row: Composer, Artist, Release Year & Track Count */}
            <div className="flex items-center gap-2 text-xs text-[#94A3B8] mt-0.5 truncate flex-wrap">
              {release.composerName && (
                <span className="inline-flex items-center gap-1 text-[10px] font-mono font-semibold text-[#EC4899] bg-[#EC4899]/10 px-1.5 py-0.2 rounded border border-[#EC4899]/25 shrink-0">
                  <span>🎼</span>
                  <span className="truncate max-w-[130px]">{release.composerName}</span>
                </span>
              )}

              <span className="text-white/85 font-medium truncate">{release.artistCredit}</span>

              {release.releaseYear && (
                <>
                  <span className="text-white/20">&bull;</span>
                  <span className="font-mono text-[#F59E0B] text-[11px] shrink-0">
                    {release.originalYear && release.originalYear !== release.releaseYear
                      ? `Orig. ${release.originalYear} (${release.releaseYear})`
                      : release.releaseYear}
                  </span>
                </>
              )}

              {relTracks.length > 0 && (
                <>
                  <span className="text-white/20 hidden sm:inline">&bull;</span>
                  <span className="text-[11px] font-mono text-[#64748B] hidden sm:inline shrink-0">
                    {relTracks.length} tracks
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Center / Right: Pressing Stacks Chip, Telemetry & Actions */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* Pressing Stacks Count Badge */}
          <div
            onClick={(e) => {
              e.stopPropagation()
              handleToggleExpand(e)
            }}
            className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-mono text-white/90 transition-all cursor-pointer"
            title={`Groups ${effectiveVariants.length} pressing editions in library. Click to view or switch active master.`}
          >
            <Layers className="w-3.5 h-3.5 text-[#ADFF2F]" />
            <span className="font-bold text-[#ADFF2F]">{effectiveVariants.length}</span>
            <span className="text-[#94A3B8]">Pressings</span>
            <span className="text-white/30 hidden xl:inline">&bull;</span>
            <span className="text-[#00F5FF] text-[11px] truncate max-w-[130px] hidden xl:inline">
              {activeVariant?.variantName.replace(/Master Pressing|Archival/gi, '').trim() || 'Master'}
            </span>
          </div>

          {/* Compact Hardware Telemetry & DR Badge */}
          <div className="flex items-center gap-1.5 font-mono text-[11px]">
            <div className="px-2.5 py-1 rounded-lg bg-black/60 border border-white/[0.1] flex items-center gap-1.5 text-white/90 shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-[#ADFF2F] shadow-[0_0_6px_#ADFF2F]" />
              <span className="font-bold text-[#ADFF2F] uppercase text-[10px]">{telemetry.format}</span>
              <span className="text-white/30">&bull;</span>
              <span className="text-[#CBD5E1] text-[10px]">{telemetry.sampleRate}</span>
            </div>

            {activeVariant?.drScore && (
              <span
                className={`px-2 py-1 rounded-lg border font-mono font-bold text-[10px] hidden sm:inline-block ${drClass.bg} ${drClass.text}`}
                title={`Dynamic Range: DR${activeVariant.drScore} (${drClass.label})`}
              >
                DR{activeVariant.drScore}
              </span>
            )}
          </div>

          {/* Inline Play / Pause Button */}
          <button
            type="button"
            onClick={handlePlayAlbum}
            className={`p-2 rounded-xl transition-all shadow cursor-pointer ${
              isCurrentlyPlayingAlbum && isPlaying
                ? 'bg-[#00F5FF] text-black shadow-[#00F5FF]/20 hover:scale-105'
                : 'bg-white/[0.06] hover:bg-white/[0.12] text-white/90 hover:text-[#00F5FF] border border-white/[0.1]'
            }`}
            title={isCurrentlyPlayingAlbum && isPlaying ? 'Pause Album' : 'Play Album'}
          >
            {isCurrentlyPlayingAlbum && isPlaying ? (
              <Pause className="w-3.5 h-3.5 fill-current" />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
            )}
          </button>

          {/* Inspect Button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onInspectRelease(release.id)
            }}
            className={`hidden xl:flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-all text-xs font-semibold cursor-pointer border ${
              isSelected
                ? 'bg-[#00F5FF]/20 text-[#00F5FF] border-[#00F5FF]/40 shadow-sm'
                : 'bg-white/[0.04] hover:bg-white/[0.08] text-[#CBD5E1] hover:text-white border-white/[0.08]'
            }`}
            title="Inspect in Smart Match & Side-by-Side Diff studio"
          >
            <span>Inspect</span>
            <ArrowRight className="w-3 h-3" />
          </button>

          {/* Expand / Collapse Chevron Button */}
          <button
            type="button"
            onClick={handleToggleExpand}
            className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
            title={isExpanded ? 'Collapse card' : 'Expand full master cockpit'}
          >
            <ChevronDown
              className={`w-4 h-4 transition-transform duration-200 ${
                isExpanded ? 'rotate-180 text-[#00F5FF]' : ''
              }`}
            />
          </button>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────────────
          TIER 2: EXPANDED MASTER WORK COCKPIT
          Revealed smoothly on click / selection: Cinematic backdrop, rich artwork
          zoom, HiFi Rose RS130 transport scrubber, and interactive pressing stack cards.
          ───────────────────────────────────────────────────────────────────────────── */}
      {isExpanded && (
        <div className="flex flex-col gap-5 p-6 pt-4 border-t border-white/[0.08] z-10 transition-all duration-300">
          {/* Cinematic Atmospheric Backdrop */}
          <PanoramicAtmosphericBackdrop
            coverArtUrl={coverUrl}
            backdropUrl={release.artwork?.backdropUrl || release.backdropUrl}
            overlayVariant="card"
          />

          {/* Top Screen: Hardware Stream Telemetry Header */}
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] pb-3 z-10">
            {/* Left: Master Work Designation & Pressings count */}
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full bg-[#00F5FF]/15 text-[#00F5FF] border border-[#00F5FF]/30 text-[10px] font-mono uppercase font-bold tracking-wider flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#00F5FF] animate-pulse" />
                <span>Master Work</span>
              </span>
              <span className="text-white/20">&bull;</span>
              <span className="text-xs font-mono text-[#94A3B8]">
                {effectiveVariants.length} Master Pressings Stacked
              </span>
              {relTracks.length > 0 && (
                <>
                  <span className="text-white/20">&bull;</span>
                  <span className="text-xs font-mono text-[#64748B]">{relTracks.length} Tracks</span>
                </>
              )}
            </div>

            {/* Right: HiFi Rose Audiophile Stream Telemetry Badge */}
            <div className="flex items-center gap-2">
              <div className="px-3 py-1 rounded-full bg-black/60 backdrop-blur-md border border-white/[0.15] flex items-center gap-2 text-[11px] font-mono text-white/90 shadow-sm">
                <div className="w-2 h-2 rounded-full bg-[#ADFF2F] shadow-[0_0_8px_#ADFF2F]" />
                <span className="font-bold text-[#ADFF2F]">{telemetry.format.toLowerCase()}:</span>
                <span>{telemetry.bitDepth}</span>
                <span className="text-white/40">&bull;</span>
                <span>{telemetry.sampleRate}</span>
                <span className="text-white/40">&bull;</span>
                <span className="text-[#00F5FF]">{telemetry.channels}</span>
                <span className="text-white/30">=</span>
                <span className="text-[#CBD5E1]">{telemetry.bitrate}</span>
              </div>

              <div className="hidden sm:flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#F59E0B]/15 text-[#F59E0B] border border-[#F59E0B]/30 text-[10px] font-mono font-bold">
                <Sparkles className="w-3 h-3" />
                <span>Hi-Res Direct</span>
              </div>
            </div>
          </div>

          {/* Main Section: Front Artwork + HiFi Metadata & Integrated Transport */}
          <div className="flex flex-col lg:flex-row items-start lg:items-center gap-6 z-10">
            {/* Crisp Front Cover Art with Large Hover Preview */}
            <ArtworkHoverPreview
              src={coverUrl}
              alt={release.title}
              title={primaryTitle}
              subtitle={release.artistCredit}
              composer={release.composerName}
              resolution={release.artwork?.resolution || 'HD Archival'}
              audioSpec={`${telemetry.format} ${telemetry.sampleRate}`}
              drScore={activeVariant?.drScore}
              provider="local"
              providerLabel="Archival Album Cover"
              previewSize={300}
            >
              <div
                onClick={() => onInspectRelease(release.id)}
                className="relative group shrink-0 cursor-pointer rounded-2xl overflow-hidden border border-white/[0.18] shadow-2xl shadow-black bg-black/80 ring-1 ring-white/10"
                title="Click to inspect album in Diff & Metadata panel (Hover for large artwork zoom)"
              >
                <img
                  src={coverUrl}
                  alt={release.title}
                  className="w-32 h-32 md:w-36 md:h-36 rounded-2xl object-cover group-hover:scale-105 transition-transform duration-300"
                  onError={(e) => {
                    ;(e.target as HTMLElement).style.display = 'none'
                  }}
                />
                {/* Gloss & Resolution Badge Overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-between p-2">
                  <span className="self-end text-[9px] font-mono font-bold px-2 py-0.5 rounded bg-black/80 text-[#00F5FF] border border-[#00F5FF]/30">
                    {release.artwork?.resolution || '3000x3000px'}
                  </span>
                  <span className="text-[10px] font-semibold text-white/90 text-center">
                    Click to Inspect &bull; Hover to Zoom
                  </span>
                </div>
              </div>
            </ArtworkHoverPreview>

            {/* Center: Title, Composer, Artist & HiFi Scrubber */}
            <div className="flex flex-col flex-1 min-w-0 gap-3">
              {/* Work / Album Title */}
              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2
                    onClick={() => onInspectRelease(release.id)}
                    className="text-xl md:text-2xl font-black text-white tracking-tight truncate hover:text-[#00F5FF] cursor-pointer drop-shadow-md"
                    title={primaryTitle}
                  >
                    {primaryTitle}
                  </h2>

                  {release.folderName && displayMode !== 'folder_first' && (
                    <span
                      className="text-[11px] font-mono px-2.5 py-0.5 rounded-md bg-[#38BDF8]/15 text-[#38BDF8] border border-[#38BDF8]/30 flex items-center gap-1.5 shrink-0 max-w-[260px] truncate"
                      title={`Physical Folder: ${release.folderName}`}
                    >
                      <Folder className="w-3 h-3 shrink-0" />
                      <span className="truncate">{release.folderName}</span>
                    </span>
                  )}
                  {displayMode === 'folder_first' && (
                    <span
                      className="text-[11px] font-mono px-2.5 py-0.5 rounded-md bg-[#ADFF2F]/15 text-[#ADFF2F] border border-[#ADFF2F]/30 flex items-center gap-1.5 shrink-0 max-w-[260px] truncate"
                      title={`Metadata Tag: ${secondaryTitle}`}
                    >
                      <Music className="w-3 h-3 shrink-0" />
                      <span className="truncate">{secondaryTitle}</span>
                    </span>
                  )}
                </div>

                {/* Composer & Artist Details */}
                <div className="flex items-center gap-2.5 text-xs text-[#CBD5E1] mt-1 flex-wrap">
                  {release.composerName && (
                    <>
                      <span className="flex items-center gap-1 font-semibold text-[#EC4899] bg-[#EC4899]/10 px-2 py-0.5 rounded border border-[#EC4899]/25 font-mono text-[11px]">
                        <span>🎼</span>
                        <span>{release.composerName}</span>
                      </span>
                      <span className="text-white/20">&bull;</span>
                    </>
                  )}

                  <span className="font-semibold text-white/90">{release.artistCredit}</span>

                  {release.originalYear && (
                    <>
                      <span className="text-white/20">&bull;</span>
                      <span className="font-mono text-[#F59E0B]">Orig. {release.originalYear}</span>
                    </>
                  )}

                  {release.label && (
                    <>
                      <span className="text-white/20">&bull;</span>
                      <span className="text-[#94A3B8]">{release.label}</span>
                    </>
                  )}

                  {activeVariant && (
                    <>
                      <span className="text-white/20">&bull;</span>
                      <span
                        className={`px-2 py-0.5 rounded border font-mono font-bold text-[10px] ${drClass.bg} ${drClass.text}`}
                      >
                        DR{activeVariant.drScore} ({drClass.label})
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* HiFi Rose RS130 Transport & Interactive Scrubber Bar */}
              <div className="bg-black/40 backdrop-blur-xl border border-white/[0.08] rounded-xl p-3 flex flex-col gap-2 max-w-2xl">
                {/* Scrubber Line with Times */}
                <div className="flex items-center gap-3 text-[10px] font-mono text-[#94A3B8]">
                  <span className="w-10 text-right font-semibold text-white/90">
                    {formatTime(currentElapsed)}
                  </span>

                  <div
                    onClick={(e) => {
                      if (!isCurrentlyPlayingAlbum || !seek || effectiveDuration <= 0) return
                      const rect = e.currentTarget.getBoundingClientRect()
                      const clickX = e.clientX - rect.left
                      const pct = Math.max(0, Math.min(1, clickX / rect.width))
                      seek(pct * effectiveDuration)
                    }}
                    className="relative flex-1 flex items-center group cursor-pointer h-2 py-1"
                  >
                    <div className="w-full h-1 bg-white/[0.12] rounded-full overflow-hidden pointer-events-none">
                      <div
                        className="h-full bg-gradient-to-r from-[#00F5FF] via-[#8B5CF6] to-[#ADFF2F] transition-all duration-150 rounded-full"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                    {/* Drag thumb on hover */}
                    <div
                      className="absolute w-3 h-3 rounded-full bg-white shadow-md shadow-black/80 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                      style={{ left: `${progressPercent}%` }}
                    />
                  </div>

                  <span className="w-10 text-left font-semibold text-white/70">
                    {formatTime(effectiveDuration)}
                  </span>
                </div>

                {/* Transport Action Buttons */}
                <div className="flex items-center justify-between pt-1">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsLiked(!isLiked)}
                      className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                        isLiked ? 'text-[#EC4899]' : 'text-[#64748B] hover:text-white'
                      }`}
                      title="Favorite Album"
                    >
                      <Heart className={`w-3.5 h-3.5 ${isLiked ? 'fill-current' : ''}`} />
                    </button>
                    <button
                      type="button"
                      className="p-1.5 rounded-lg text-[#64748B] hover:text-white transition-colors cursor-pointer"
                      title="Shuffle"
                    >
                      <Shuffle className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Center Controls: Prev, Play/Pause, Next */}
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handlePlayAlbum}
                      className="p-1.5 rounded-lg text-[#CBD5E1] hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
                      title="Previous Track"
                    >
                      <SkipBack className="w-4 h-4 fill-current" />
                    </button>

                    <button
                      type="button"
                      onClick={handlePlayAlbum}
                      className="w-8 h-8 rounded-full bg-gradient-to-br from-[#00F5FF] to-[#00C2FF] text-black font-bold flex items-center justify-center shadow-lg shadow-[#00F5FF]/20 hover:scale-105 active:scale-95 transition-transform cursor-pointer"
                      title={isCurrentlyPlayingAlbum && isPlaying ? 'Pause Album' : 'Play Album'}
                    >
                      {isCurrentlyPlayingAlbum && isPlaying ? (
                        <Pause className="w-3.5 h-3.5 fill-black stroke-black" />
                      ) : (
                        <Play className="w-3.5 h-3.5 fill-black stroke-black ml-0.5" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={handlePlayAlbum}
                      className="p-1.5 rounded-lg text-[#CBD5E1] hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
                      title="Next Track"
                    >
                      <SkipForward className="w-4 h-4 fill-current" />
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="p-1.5 rounded-lg text-[#64748B] hover:text-white transition-colors cursor-pointer"
                      title="Repeat Album"
                    >
                      <Repeat className="w-3.5 h-3.5" />
                    </button>
                    <div className="flex items-center gap-1 text-[10px] font-mono text-[#64748B]">
                      <Volume2 className="w-3.5 h-3.5 text-[#CBD5E1]" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right: Operational Tool Actions */}
            <div className="flex lg:flex-col items-center gap-2 shrink-0 self-stretch justify-center">
              {isSelected && (
                <span className="p-2 px-3 rounded-xl bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/40 text-xs font-mono font-bold flex items-center gap-2 shadow-sm">
                  <span className="w-2 h-2 rounded-full bg-[#00F5FF] animate-pulse" />
                  <span>Active in Diff</span>
                </span>
              )}

              {onCustomizeRelease && (
                <button
                  data-tutorial-id="btn-customize-album-folder"
                  onClick={() => onCustomizeRelease(release)}
                  className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-white border border-white/[0.1] transition-all text-xs flex items-center gap-2 cursor-pointer font-semibold shadow-sm w-full justify-center"
                  title="Customize Album and Physical Folder Name"
                >
                  <Edit3 className="w-3.5 h-3.5 text-[#00F5FF]" />
                  <span>Customize</span>
                </button>
              )}

              <button
                onClick={() => onInspectRelease(release.id)}
                className={`px-3.5 py-2 rounded-xl transition-all text-xs flex items-center gap-2 cursor-pointer font-bold shadow-lg w-full justify-center ${
                  isSelected
                    ? 'bg-[#00F5FF] text-black shadow-[#00F5FF]/20'
                    : 'bg-white/[0.08] hover:bg-white/[0.15] text-[#CBD5E1] hover:text-white border border-white/[0.1]'
                }`}
                title="Inspect this release in the Smart Match and Side-by-Side Diff studio"
              >
                <span>{isSelected ? 'Inspecting' : 'Inspect Master'}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Master Pressings & Variant Stacks Selection Grid */}
          <div className="flex flex-col gap-2 pt-3 border-t border-white/[0.08] z-10">
            <div className="flex items-center justify-between text-xs text-[#94A3B8]">
              <div className="flex items-center gap-2 font-medium">
                <Layers className="w-4 h-4 text-[#ADFF2F]" />
                <span className="font-bold text-white">
                  Master Pressing Stacks ({effectiveVariants.length} Versions in Vault):
                </span>
              </div>
              <span className="text-[11px] text-[#64748B] font-mono">
                Click version card to switch active audio master
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {effectiveVariants.map((variant) => {
                const isCurrent = variant.isCurrentMaster
                const vDrClass = IntegrityScanner.getDrBadgeClass(variant.drScore)

                return (
                  <div
                    key={variant.id}
                    data-tutorial-id="variant-item-row"
                    onClick={() => {
                      onSelectVariant(release.id, variant.id)
                      onInspectRelease(release.id)
                    }}
                    className={`p-3 rounded-xl border transition-all cursor-pointer text-left flex flex-col justify-between gap-2 backdrop-blur-md ${
                      isCurrent
                        ? 'bg-[#00F5FF]/15 border-[#00F5FF]/60 shadow-lg shadow-[#00F5FF]/10 ring-1 ring-[#00F5FF]/40'
                        : 'bg-black/30 border-white/[0.06] hover:bg-white/[0.04] opacity-80 hover:opacity-100 hover:border-white/20'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-col min-w-0">
                        <span
                          className={`text-xs font-bold truncate ${
                            isCurrent ? 'text-[#00F5FF]' : 'text-[#F1F5F9]'
                          }`}
                        >
                          {variant.variantName}
                        </span>
                        {variant.matrixRunout && (
                          <span className="text-[10px] text-[#64748B] font-mono truncate">
                            Matrix: {variant.matrixRunout}
                          </span>
                        )}
                        {variant.catalogNumber && (
                          <span className="text-[10px] text-[#94A3B8]/70 font-mono truncate">
                            Cat: {variant.catalogNumber}
                          </span>
                        )}
                      </div>

                      {isCurrent ? (
                        <span className="px-2 py-0.5 rounded-full bg-[#00F5FF] text-black text-[10px] font-mono font-bold shrink-0 shadow flex items-center gap-1">
                          <Check className="w-2.5 h-2.5 stroke-[3]" />
                          <span>Active</span>
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono text-[#64748B] group-hover:text-white/80">
                          Switch
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between text-[11px] font-mono text-[#94A3B8] pt-1.5 border-t border-white/[0.04]">
                      <span className={`px-1.5 py-0.2 rounded font-bold ${vDrClass.text}`}>
                        DR{variant.drScore}
                      </span>
                      <span className="text-[#CBD5E1] bg-white/[0.05] px-1.5 py-0.2 rounded">
                        {variant.formatStr}
                      </span>
                      <span className="text-[#94A3B8]">{variant.releaseYear}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
