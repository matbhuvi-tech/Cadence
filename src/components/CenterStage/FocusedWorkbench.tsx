import React, { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Sparkles,
  Check,
  Disc3,
  X,
  ShieldCheck,
  Image as ImageIcon,
  CheckCircle2,
  ZoomIn,
} from 'lucide-react'
import { Track, Release } from '../../core/types'

interface FocusedWorkbenchProps {
  track: Track
  release?: Release
  allTracks: Track[]
  onClose: () => void
  onApplyEdits: (edits: Partial<Track>) => void
  showToast: (msg: string) => void
}

export const FocusedWorkbench: React.FC<FocusedWorkbenchProps> = ({
  track,
  release,
  onClose,
  onApplyEdits,
  showToast,
}) => {
  // Candidate values simulated from remote federated resolvers
  const [selectedFields, setSelectedFields] = useState<Record<string, string>>({
    title: track.title,
    artist: track.artistCredit || '',
    composer: track.composerName || 'A. R. Rahman',
    album: release?.title || '',
    year: String(release?.releaseYear || '1998'),
  })

  const [selectedArtwork, setSelectedArtwork] = useState<string>(
    release?.coverArtUrl || release?.artwork?.frontCoverUrl || ''
  )
  const [isZoomingArt, setIsZoomingArt] = useState(false)

  // Listen for Escape key to close workbench
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleSave = () => {
    onApplyEdits({
      title: selectedFields.title,
      artistCredit: selectedFields.artist,
      composerName: selectedFields.composer,
      sidecarStatus: 'uncommitted_sidecar',
    })
    showToast(`Staged metadata match for "${track.title}". Preserved bit-perfectly in sidecar.`)
    onClose()
  }

  const comparisonRows = [
    {
      field: 'Track Title',
      key: 'title',
      local: track.title,
      appleMusic: track.title.replace(/\s*\(.*\)/, ''),
      musicbrainz: track.title,
      gemini: track.title + (track.title.includes('(') ? '' : ' (Original Soundtrack)'),
    },
    {
      field: 'Primary Artist',
      key: 'artist',
      local: track.artistCredit || 'Unknown',
      appleMusic: 'A.R. Rahman',
      musicbrainz: 'A.R.Rahman',
      gemini: 'A.R. Rahman',
    },
    {
      field: 'Composer',
      key: 'composer',
      local: track.composerName || '(Empty Tag)',
      appleMusic: 'A. R. Rahman',
      musicbrainz: 'A. R. Rahman',
      gemini: 'A. R. Rahman',
    },
    {
      field: 'Album Title',
      key: 'album',
      local: release?.title || 'Unknown',
      appleMusic: release?.title || 'Dil Se..',
      musicbrainz: (release?.title || 'Dil Se..') + ' (Original Motion Picture Soundtrack)',
      gemini: release?.title || 'Dil Se..',
    },
    {
      field: 'Release Year',
      key: 'year',
      local: String(release?.releaseYear || '(Empty)'),
      appleMusic: '1998',
      musicbrainz: '1998',
      gemini: '1998',
    },
  ]

  const artworkCandidates = [
    {
      id: 'local',
      source: 'Local Embedded Tag',
      resolution: '600 × 600 px · Embedded JPEG',
      url: release?.coverArtUrl || release?.artwork?.frontCoverUrl || '',
    },
    {
      id: 'apple',
      source: 'Apple Music Master (Recommended)',
      resolution: '3000 × 3000 px · Uncompressed PNG',
      url: release?.coverArtUrl || release?.artwork?.frontCoverUrl || '',
    },
    {
      id: 'musicbrainz',
      source: 'Cover Art Archive (MusicBrainz)',
      resolution: '1400 × 1400 px · Original CD Scan',
      url: release?.coverArtUrl || release?.artwork?.frontCoverUrl || '',
    },
  ]

  return (
    <div className="flex-1 flex flex-col bg-[#0C0D10] overflow-hidden select-none animate-in fade-in duration-200">
      {/* 1. macOS Style Header */}
      <header className="h-13 px-6 bg-[#131418] border-b border-white/[0.06] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-xs font-mono text-[#E5E5EA] hover:text-white transition-all cursor-pointer border border-white/[0.06]"
            title="Return to Library (Esc)"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>← Return (Esc)</span>
          </button>
          <span className="text-white/20">|</span>
          <span className="text-xs text-[#8E8E93] font-mono">
            Curate & 3-Way Reconciliation: <strong className="text-white">{track.title}</strong>
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs text-[#8E8E93] hover:text-white transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-white hover:bg-white/95 text-black font-semibold text-xs transition-all cursor-pointer shadow-md"
          >
            <Check className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>Stage to Sidecar</span>
          </button>
        </div>
      </header>

      {/* 2. Full-Width Reconciliation Matrix & Artwork Inspector */}
      <div className="flex-1 overflow-y-auto p-6 max-w-6xl mx-auto w-full space-y-6">
        {/* Info Capsule */}
        <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-between">
          <div className="space-y-0.5">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#D4AF37]" />
              <span>Multi-Provider Metadata Alignment</span>
            </h2>
            <p className="text-xs text-[#8E8E93]">
              Click any provider's candidate pill to snap it into your staged record. Edits are non-destructive and preserve audio bitstreams.
            </p>
          </div>
          <span className="px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-mono text-[10px] flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Zero Bitstream Mutation</span>
          </span>
        </div>

        {/* The 5-Column Alignment Table */}
        <div className="rounded-xl border border-white/[0.06] bg-[#121316] overflow-hidden text-xs">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/[0.06] bg-white/[0.02] font-mono text-[10px] text-[#8E8E93] uppercase tracking-wider">
                <th className="p-3.5 w-32">Field</th>
                <th className="p-3.5">Local File</th>
                <th className="p-3.5 text-[#F59E0B]">Apple Music</th>
                <th className="p-3.5 text-[#818CF8]">MusicBrainz</th>
                <th className="p-3.5 text-cyan-400">Gemini AI</th>
                <th className="p-3.5 w-48 text-[#10B981]">Staged Output</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04] text-[11px] font-mono">
              {comparisonRows.map((row) => (
                <tr key={row.key} className="hover:bg-white/[0.02]">
                  <td className="p-3.5 font-bold text-[#8E8E93]">{row.field}</td>
                  
                  {/* Local Column */}
                  <td className="p-3.5 text-[#8E8E93]">
                    <button
                      onClick={() => setSelectedFields((prev) => ({ ...prev, [row.key]: row.local }))}
                      className="hover:underline text-left cursor-pointer"
                      title="Use local file value"
                    >
                      {row.local}
                    </button>
                  </td>

                  {/* Apple Music Column */}
                  <td className="p-3.5 text-white font-medium">
                    <button
                      onClick={() => setSelectedFields((prev) => ({ ...prev, [row.key]: row.appleMusic }))}
                      className="hover:bg-amber-500/10 px-2 py-0.5 rounded transition-all text-left flex items-center gap-1.5 cursor-pointer group"
                      title="Snap Apple Music value"
                    >
                      <span className="text-[#F59E0B]">{row.appleMusic}</span>
                      <span className="text-[9px] text-[#8E8E93] opacity-0 group-hover:opacity-100">Use</span>
                    </button>
                  </td>

                  {/* MusicBrainz Column */}
                  <td className="p-3.5 text-white font-medium">
                    <button
                      onClick={() => setSelectedFields((prev) => ({ ...prev, [row.key]: row.musicbrainz }))}
                      className="hover:bg-violet-500/10 px-2 py-0.5 rounded transition-all text-left flex items-center gap-1.5 cursor-pointer group"
                      title="Snap MusicBrainz value"
                    >
                      <span className="text-[#818CF8]">{row.musicbrainz}</span>
                      <span className="text-[9px] text-[#8E8E93] opacity-0 group-hover:opacity-100">Use</span>
                    </button>
                  </td>

                  {/* Gemini AI Column */}
                  <td className="p-3.5 text-white font-medium">
                    <button
                      onClick={() => setSelectedFields((prev) => ({ ...prev, [row.key]: row.gemini }))}
                      className="hover:bg-cyan-500/10 px-2 py-0.5 rounded transition-all text-left flex items-center gap-1.5 cursor-pointer group"
                      title="Snap Gemini AI value"
                    >
                      <span className="text-cyan-300">{row.gemini}</span>
                      <span className="text-[9px] text-[#8E8E93] opacity-0 group-hover:opacity-100">Use</span>
                    </button>
                  </td>

                  {/* Staged Output Column */}
                  <td className="p-3.5">
                    <input
                      type="text"
                      value={selectedFields[row.key] || ''}
                      onChange={(e) => setSelectedFields({ ...selectedFields, [row.key]: e.target.value })}
                      className="w-full px-2.5 py-1 bg-black/60 border border-emerald-500/30 rounded text-emerald-300 text-xs focus:outline-none focus:border-emerald-400"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 3. Cover Art Candidates & Resolution Comparison */}
        <div className="rounded-xl border border-white/[0.06] bg-[#121316] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-[#D4AF37]" />
                <span>High-Resolution Artwork Inspector</span>
              </h3>
              <p className="text-xs text-[#8E8E93]">
                Compare artwork resolution and color profiles before selecting your definitive front cover.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {artworkCandidates.map((art) => (
              <div
                key={art.id}
                onClick={() => setSelectedArtwork(art.url)}
                className={`p-3.5 rounded-xl border transition-all cursor-pointer flex flex-col items-center gap-3 relative ${
                  selectedArtwork === art.url
                    ? 'border-[#D4AF37] bg-[#D4AF37]/5 shadow-sm'
                    : 'border-white/[0.06] bg-black/30 hover:border-white/20'
                }`}
              >
                <div className="w-36 h-36 rounded-md overflow-hidden bg-black/80 relative apple-album-shadow flex items-center justify-center">
                  {art.url ? (
                    <img src={art.url} alt={art.source} className="w-full h-full object-cover" />
                  ) : (
                    <Disc3 className="w-12 h-12 text-white/20" />
                  )}
                </div>

                <div className="text-center space-y-1 w-full">
                  <div className="text-xs font-semibold text-white truncate">{art.source}</div>
                  <div className="text-[10px] font-mono text-[#8E8E93]">{art.resolution}</div>
                </div>

                {selectedArtwork === art.url && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#D4AF37] text-black font-semibold">
                    Selected
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
