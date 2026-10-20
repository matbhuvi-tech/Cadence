import React, { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Music,
  Disc3,
  Clock,
  ShieldCheck,
  AlertTriangle,
  FileCode,
  Tag,
  CheckCircle2,
  Folder,
  Edit3,
} from 'lucide-react'
import { Work, Track, Release, AlbumDisplayMode } from '../../core/types'
import { IntegrityScanner } from '../../services/integrityScanner'
import { ArtworkHoverPreview } from '../common/ArtworkHoverPreview'
import { PanoramicAtmosphericBackdrop } from '../common/PanoramicAtmosphericBackdrop'
import { getCuratedAlbumArtwork } from '../../core/taxonomyUtils'

interface WorkMovementViewProps {
  works: Work[]
  tracks: Track[]
  releases: Release[]
  displayMode?: AlbumDisplayMode
  selectedTrackId?: string
  onSelectTrack: (trackId: string) => void
  onOpenSidecar: (trackId: string) => void
  onCustomizeRelease?: (release: Release) => void
}

export const WorkMovementView: React.FC<WorkMovementViewProps> = ({
  works,
  tracks,
  releases,
  displayMode = 'album_first',
  selectedTrackId,
  onSelectTrack,
  onOpenSidecar,
  onCustomizeRelease,
}) => {
  const [collapsedWorks, setCollapsedWorks] = useState<Record<string, boolean>>({})

  const toggleWork = (workId: string) => {
    setCollapsedWorks((prev) => ({ ...prev, [workId]: !prev[workId] }))
  }

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  if (works.length === 0) {
    return (
      <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
        <div className="p-4 rounded-xl bg-[#161B26] border border-[#00F5FF]/20 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs text-[#94A3B8]">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-[#00F5FF]/10 text-[#00F5FF] shrink-0">
              <Music className="w-5 h-5" />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-white text-sm">
                  Classical Works & Multi-Part Movements Hierarchy
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/[0.06] text-[#ADFF2F]">
                  Auto-Grouping ({releases.length} Albums • {tracks.length} Tracks)
                </span>
              </div>
              <p className="text-[11px] text-[#94A3B8] max-w-3xl leading-relaxed">
                This relational hierarchy view is designed for multi-movement classical suites, symphonies (e.g. Beethoven Symphony No. 5 &rarr; Allegro con brio), concertos, and multi-part raga compositions. For film scores, soundtracks, rock, jazz, and pop albums, switch to Album Variant Stacks or Virtual Data Grid.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 self-end md:self-auto">
            <span className="text-[10px] font-mono px-2 py-1 rounded bg-white/[0.04] border border-white/[0.08] text-[#CBD5E1]">
              Shortcuts: <strong className="text-[#00F5FF]">2</strong> Album Stacks • <strong className="text-[#ADFF2F]">3</strong> Data Grid
            </span>
          </div>
        </div>

        {releases.map((rel) => {
          const isCollapsed = collapsedWorks[rel.id]
          const relTracks = tracks.filter((t) => t.releaseId === rel.id)
          if (relTracks.length === 0) return null
          const totalDuration = relTracks.reduce((acc, t) => acc + t.durationSeconds, 0)

          const primaryTitle = displayMode === 'folder_first'
            ? (rel.folderName || rel.title)
            : rel.title

          const isReleaseSelected = relTracks.some((t) => t.id === selectedTrackId)

          return (
            <div
              key={rel.id}
              data-tutorial-id="work-card-container"
              className={`relative overflow-hidden rounded-2xl bg-[#0A0D14]/90 border transition-all duration-300 shadow-xl group/card ${
                isReleaseSelected
                  ? 'border-[#00F5FF]/60 ring-1 ring-[#00F5FF]/40 shadow-[#00F5FF]/10'
                  : 'border-white/[0.08] hover:border-white/[0.18]'
              }`}
            >
              {/* Cinematic Atmospheric Album-Art Backdrop */}
              <PanoramicAtmosphericBackdrop
                coverArtUrl={rel.artwork?.frontCoverUrl}
                backdropUrl={rel.artwork?.backdropUrl || rel.backdropUrl}
                overlayVariant="card"
              />

              {/* Release Header */}
              <div
                onClick={() => {
                  toggleWork(rel.id)
                  if (relTracks.length > 0) {
                    onSelectTrack(relTracks[0].id)
                  }
                }}
                className="relative z-10 p-4 bg-[#141822]/80 backdrop-blur-md hover:bg-[#181D2A]/90 transition-colors cursor-pointer border-b border-white/[0.06] flex items-center justify-between select-none"
              >
                <div className="flex items-center gap-3">
                  <button className="p-1 rounded hover:bg-white/[0.06] text-[#94A3B8]">
                    {isCollapsed ? (
                      <ChevronRight className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-[#00F5FF]" />
                    )}
                  </button>
                  {rel.artwork?.frontCoverUrl && (
                    <ArtworkHoverPreview
                      src={rel.artwork.frontCoverUrl}
                      alt={rel.title}
                      title={primaryTitle}
                      subtitle={rel.artistCredit}
                      composer={rel.composerName}
                      resolution={rel.artwork.resolution || 'HD Archival'}
                      previewSize={280}
                    >
                      <div className="w-10 h-10 rounded-lg overflow-hidden bg-black/50 border border-white/[0.12] shrink-0 cursor-pointer shadow-sm group">
                        <img
                          src={rel.artwork.frontCoverUrl}
                          alt=""
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                          onError={(e) => {
                            ;(e.target as HTMLElement).style.display = 'none'
                          }}
                        />
                      </div>
                    </ArtworkHoverPreview>
                  )}

                  <div className="flex flex-col text-left">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono text-[#ADFF2F] uppercase tracking-wider font-semibold">
                        {rel.mediaFormat || 'DIGITAL MEDIA'}
                      </span>
                      {rel.releaseYear && (
                        <span className="text-[11px] px-2 py-0.2 rounded-full bg-white/[0.05] text-[#94A3B8] font-mono">
                          {rel.releaseYear}
                        </span>
                      )}
                      {rel.catalogNumber && (
                        <span className="text-[11px] text-[#64748B] font-mono">
                          CAT: {rel.catalogNumber}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-wrap mt-0.5">
                      <h3 className="text-base font-bold text-[#F1F5F9]">{primaryTitle}</h3>
                      {displayMode === 'album_first' && rel.folderName && (
                        <span
                          className="text-[11px] font-mono text-[#38BDF8] bg-[#38BDF8]/10 border border-[#38BDF8]/20 px-2 py-0.5 rounded flex items-center gap-1 shrink-0"
                          title={`Physical Folder: ${rel.folderName}`}
                        >
                          <Folder className="w-3 h-3" />
                          <span className="truncate max-w-[280px]">{rel.folderName}</span>
                        </span>
                      )}
                      {displayMode === 'folder_first' && rel.folderName && rel.title !== rel.folderName && (
                        <span
                          className="text-[11px] font-mono text-[#ADFF2F] bg-[#ADFF2F]/10 border border-[#ADFF2F]/20 px-2 py-0.5 rounded flex items-center gap-1 shrink-0"
                          title={`Metadata Tag: ${rel.title}`}
                        >
                          <Music className="w-3 h-3" />
                          <span className="truncate max-w-[280px]">{rel.title}</span>
                        </span>
                      )}
                    </div>

                    <span className="text-xs text-[#94A3B8] flex items-center gap-1.5 mt-0.5">
                      <Music className="w-3 h-3 text-[#00F5FF]" />
                      {rel.artistCredit}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {isReleaseSelected && (
                    <span className="p-1 px-2 rounded-lg bg-[#00F5FF]/15 text-[#00F5FF] border border-[#00F5FF]/30 text-[10px] font-mono font-bold flex items-center gap-1.5 shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#00F5FF] animate-pulse" />
                      <span>Active in Diff</span>
                    </span>
                  )}
                  {onCustomizeRelease && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onCustomizeRelease(rel)
                      }}
                      className="p-1.5 px-2.5 rounded-lg bg-[#00F5FF]/10 hover:bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/30 text-xs font-mono font-medium flex items-center gap-1.5 transition-all cursor-pointer"
                      title="Customize Album and Physical Folder Name"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>Customize</span>
                    </button>
                  )}
                  <span className="text-xs font-mono text-[#64748B] flex items-center gap-1">
                    <Disc3 className="w-3.5 h-3.5" />
                    {relTracks.length} {relTracks.length === 1 ? 'track' : 'tracks'}
                  </span>
                  <span className="text-xs font-mono text-[#64748B] flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    {formatDuration(totalDuration)}
                  </span>
                </div>
              </div>

              {/* Tracks List */}
              {!isCollapsed && (
                <div className="flex flex-col divide-y divide-white/[0.04]">
                  {relTracks.map((track, idx) => {
                    const isSelected = selectedTrackId === track.id
                    const drClass = IntegrityScanner.getDrBadgeClass(track.drScore)

                    return (
                      <div
                        key={track.id}
                        data-tutorial-id="work-movement-row"
                        onClick={() => onSelectTrack(track.id)}
                        className={`flex items-center justify-between p-3.5 px-6 transition-colors cursor-pointer text-left ${
                          isSelected
                            ? 'bg-[#00F5FF]/10 border-l-2 border-[#00F5FF]'
                            : 'hover:bg-white/[0.02]'
                        }`}
                      >
                        <div className="flex items-center gap-4 flex-1 pr-4">
                          <span className="font-mono text-xs font-bold text-[#00F5FF] w-6 text-center shrink-0">
                            {track.trackNumber || idx + 1}
                          </span>
                          <div className="flex flex-col">
                            <span className="text-sm font-medium text-[#F1F5F9] flex items-center gap-2">
                              {track.title}
                              {track.sidecarStatus === 'uncommitted_sidecar' && (
                                <span className="sidecar-badge-dot" title="Uncommitted Sidecar Edits Staged" />
                              )}
                            </span>
                            <span className="text-xs text-[#94A3B8] flex items-center gap-2 mt-0.5">
                              <span>{track.artistCredit}</span>
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 shrink-0">
                          <div className={`px-2 py-0.5 rounded border text-[11px] font-mono font-bold flex items-center gap-1 ${drClass.bg} ${drClass.text}`}>
                            <span>DR{track.drScore}</span>
                          </div>
                          <div className="px-2 py-0.5 rounded bg-white/[0.04] border border-white/[0.08] text-[11px] font-mono text-[#94A3B8]">
                            {track.sampleRateStr} {track.format}
                          </div>
                          <div title={track.checksumValid ? 'Bit-perfect' : 'Checksum mismatch'}>
                            {track.checksumValid ? (
                              <ShieldCheck className="w-4 h-4 text-[#10B981]" />
                            ) : (
                              <AlertTriangle className="w-4 h-4 text-[#F43F5E]" />
                            )}
                          </div>
                          <div className="flex items-center gap-1 text-xs font-mono text-[#64748B] w-12 justify-end">
                            <Clock className="w-3 h-3 text-[#64748B]" />
                            {formatDuration(track.durationSeconds)}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
      {works.map((work) => {
        const isCollapsed = collapsedWorks[work.id]
        const workTracks = tracks.filter((t) => t.workId === work.id)
        const totalDuration = workTracks.reduce((acc, t) => acc + t.durationSeconds, 0)
        const isWorkSelected = workTracks.some((t) => t.id === selectedTrackId)
        const composer = work.composerName || 'Classical Archive'
        const matchedRel = releases.find((r) => r.id === workTracks[0]?.releaseId)
        const workCoverUrl =
          matchedRel?.artwork?.frontCoverUrl ||
          matchedRel?.coverArtUrl ||
          getCuratedAlbumArtwork(work.title, composer)

        return (
          <div
            key={work.id}
            data-tutorial-id="work-card-container"
            className={`relative overflow-hidden rounded-2xl bg-[#0A0D14]/90 border transition-all duration-300 shadow-xl group/card ${
              isWorkSelected
                ? 'border-[#00F5FF]/60 ring-1 ring-[#00F5FF]/40 shadow-[#00F5FF]/10'
                : 'border-white/[0.08] hover:border-white/[0.18]'
            }`}
          >
            {/* Cinematic Full-Card Album-Art Backdrop */}
            <PanoramicAtmosphericBackdrop
              coverArtUrl={workCoverUrl}
              backdropUrl={matchedRel?.artwork?.backdropUrl || matchedRel?.backdropUrl}
              overlayVariant="card"
            />

            {/* Work Parent Header */}
            <div
              onClick={() => {
                toggleWork(work.id)
                if (workTracks.length > 0) {
                  onSelectTrack(workTracks[0].id)
                }
              }}
              className="relative z-10 p-4 bg-[#141822]/80 backdrop-blur-md hover:bg-[#181D2A]/90 transition-colors cursor-pointer border-b border-white/[0.06] flex items-center justify-between select-none"
            >
              <div className="flex items-center gap-3">
                <button className="p-1 rounded hover:bg-white/[0.06] text-[#94A3B8]">
                  {isCollapsed ? (
                    <ChevronRight className="w-4 h-4" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-[#00F5FF]" />
                  )}
                </button>

                <div className="flex flex-col text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-[#ADFF2F] uppercase tracking-wider font-semibold">
                      {work.opusOrCatalogueNumber || 'CATALOGUE WORK'}
                    </span>
                    {work.musicalKey && (
                      <span className="text-[11px] px-2 py-0.2 rounded-full bg-white/[0.05] text-[#94A3B8] font-mono">
                        {work.musicalKey}
                      </span>
                    )}
                    {work.compositionYear && (
                      <span className="text-[11px] text-[#64748B]">
                        (Comp. {work.compositionYear})
                      </span>
                    )}
                  </div>
                  <h3 className="text-base font-bold text-[#F1F5F9] mt-0.5">
                    {work.title}
                  </h3>
                  <span className="text-xs text-[#94A3B8] flex items-center gap-1.5 mt-0.5">
                    <Music className="w-3 h-3 text-[#00F5FF]" />
                    {composer}
                  </span>
                </div>
              </div>

              {/* Work Metadata Badges */}
              <div className="flex items-center gap-3">
                {isWorkSelected && (
                  <span className="p-1 px-2 rounded-lg bg-[#00F5FF]/15 text-[#00F5FF] border border-[#00F5FF]/30 text-[10px] font-mono font-bold flex items-center gap-1.5 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00F5FF] animate-pulse" />
                    <span>Active in Diff</span>
                  </span>
                )}
                <div className="flex flex-col items-end text-xs font-mono text-[#94A3B8]">
                  <span>{workTracks.length} Movements</span>
                  <span className="text-[#64748B] text-[11px]">
                    {formatDuration(totalDuration)}
                  </span>
                </div>
                <div className="flex gap-1">
                  {work.genreIds.map((g) => (
                    <span
                      key={g}
                      className="text-[10px] px-2 py-0.5 rounded-full bg-[#8B5CF6]/15 text-[#C4B5FD] border border-[#8B5CF6]/30 uppercase font-mono"
                    >
                      {g}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Movements Child Rows */}
            {!isCollapsed && (
              <div className="flex flex-col divide-y divide-white/[0.04]">
                {workTracks.length === 0 ? (
                  <div className="p-4 text-xs text-[#64748B] italic">
                    No recordings mapped to this composition hierarchy yet.
                  </div>
                ) : (
                  workTracks.map((track) => {
                    const isSelected = selectedTrackId === track.id
                    const release = releases.find((r) => r.id === track.releaseId)
                    const drClass = IntegrityScanner.getDrBadgeClass(track.drScore)

                    return (
                      <div
                        key={track.id}
                        data-tutorial-id="work-movement-row"
                        onClick={() => onSelectTrack(track.id)}
                        className={`flex items-center justify-between px-6 py-3 transition-colors cursor-pointer text-left ${
                          isSelected
                            ? 'bg-[#00F5FF]/10 border-l-2 border-[#00F5FF]'
                            : 'hover:bg-white/[0.03]'
                        }`}
                      >
                        {/* Left: Movement designation & title */}
                        <div className="flex items-center gap-4 flex-1 pr-4">
                          {/* Roman / Movement Number Indicator */}
                          <div className="w-8 h-8 rounded-lg bg-white/[0.04] border border-white/[0.08] flex items-center justify-center font-mono font-bold text-xs text-[#00F5FF] shrink-0">
                            {track.movementNumber || track.trackNumber}
                          </div>

                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-[#F1F5F9]">
                                {track.movementTitle || track.title}
                              </span>

                              {/* Sidecar Non-Destructive Indicator */}
                              {track.sidecarStatus === 'uncommitted_sidecar' && (
                                <span
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    onOpenSidecar(track.id)
                                  }}
                                  title="Uncommitted Sidecar Edit: Raw FLAC byte-stream preserved"
                                  className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/40 font-mono font-semibold"
                                >
                                  <span className="sidecar-badge-dot" />
                                  Sidecar Staged
                                </span>
                              )}
                            </div>

                              <span className="text-xs text-[#94A3B8] flex items-center gap-2 mt-0.5">
                                <span>{track.artistCredit}</span>
                                <span className="text-white/20">·</span>
                                <span className="text-[#64748B] font-mono text-[11px] flex items-center gap-1.5">
                                  <span>{release?.title || 'Unknown Release'}</span>
                                  {release?.folderName && (
                                    <span className="text-[#38BDF8]/80 text-[10px] flex items-center gap-1">
                                      <Folder className="w-2.5 h-2.5" />
                                      <span>{release.folderName}</span>
                                    </span>
                                  )}
                                </span>
                              </span>
                          </div>
                        </div>

                        {/* Right: Technical Specs & Audiophile Badges */}
                        <div className="flex items-center gap-4 shrink-0">
                          {/* Dynamic Range Micro-Badge */}
                          <div
                            className={`px-2 py-0.5 rounded border text-[11px] font-mono font-bold flex items-center gap-1 ${drClass.bg} ${drClass.text}`}
                            title={`Dynamic Range: DR${track.drScore} (${drClass.label})`}
                          >
                            <span>DR{track.drScore}</span>
                          </div>

                          {/* Sample Rate / Format */}
                          <div className="px-2 py-0.5 rounded bg-white/[0.04] border border-white/[0.08] text-[11px] font-mono text-[#94A3B8]">
                            {track.sampleRateStr} {track.format}
                          </div>

                          {/* Checksum & Bit-Rot Status */}
                          <div title={track.checksumValid ? 'FLAC stream MD5 verified bit-perfect' : 'Checksum mismatch / Bit-rot detected'}>
                            {track.checksumValid ? (
                              <ShieldCheck className="w-4 h-4 text-[#10B981]" />
                            ) : (
                              <AlertTriangle className="w-4 h-4 text-[#F43F5E]" />
                            )}
                          </div>

                          {/* Duration */}
                          <div className="flex items-center gap-1 text-xs font-mono text-[#64748B] w-12 justify-end">
                            <Clock className="w-3 h-3 text-[#64748B]" />
                            {formatDuration(track.durationSeconds)}
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
