import React, { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Sparkles,
  Check,
  Disc3,
  X,
  FileCode,
  ShieldCheck,
  Save,
  RotateCcw,
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
  allTracks,
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
    showToast(`Staged metadata match for "${track.title}". Click Save Changes (⌘S) to write.`)
    onClose()
  }

  const comparisonRows = [
    {
      field: 'Track Title',
      key: 'title',
      local: track.title,
      musicbrainz: track.title,
      gemini: track.title + (track.title.includes('(') ? '' : ' (Original Soundtrack)'),
    },
    {
      field: 'Primary Artist',
      key: 'artist',
      local: track.artistCredit || 'Unknown',
      musicbrainz: 'A.R.Rahman',
      gemini: 'A.R. Rahman',
    },
    {
      field: 'Composer',
      key: 'composer',
      local: track.composerName || '(Empty Tag)',
      musicbrainz: 'A. R. Rahman',
      gemini: 'A. R. Rahman',
    },
    {
      field: 'Album Title',
      key: 'album',
      local: release?.title || 'Unknown',
      musicbrainz: (release?.title || 'Dil Se..') + ' (Original Motion Picture Soundtrack)',
      gemini: release?.title || 'Dil Se..',
    },
    {
      field: 'Release Year',
      key: 'year',
      local: String(release?.releaseYear || '(Empty)'),
      musicbrainz: '1998',
      gemini: '1998',
    },
  ]

  return (
    <div className="flex-1 flex flex-col bg-[#0D0E12] overflow-hidden select-none animate-in fade-in duration-150">
      {/* 1. Umbilical Anchor Top Bar */}
      <header className="h-12 px-4 bg-[#12151D] border-b border-white/10 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-xs font-mono text-cyan-400 hover:text-white transition-all cursor-pointer border border-cyan-500/20"
            title="Return to Library (Esc)"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>← Return to "{release?.title || 'Album'}" (Esc)</span>
          </button>
          <span className="text-slate-600">|</span>
          <span className="text-xs text-slate-300 font-mono">
            Focused Workbench: <strong>{track.title}</strong>
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-slate-400 hover:text-white transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-gradient-to-r from-cyan-400 to-lime-400 hover:brightness-110 text-black font-extrabold text-xs transition-all cursor-pointer font-mono shadow-md shadow-cyan-500/20"
          >
            <Check className="w-3.5 h-3.5 stroke-[3]" />
            <span>Apply & Stage Sidecar</span>
          </button>
        </div>
      </header>

      {/* 2. Full-Width Comparison Matrix */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="p-4 rounded-2xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-between">
          <div className="space-y-1">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-purple-400" />
              <span>Multi-Source Metadata Reconciliation</span>
            </h2>
            <p className="text-xs text-slate-300">
              Select the authoritative values for each field. Clicking a candidate column accepts it into your staged sidecar.
            </p>
          </div>
        </div>

        {/* The 4-Column Table */}
        <div className="rounded-2xl border border-white/10 bg-[#0A0C10] overflow-hidden text-xs">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10 bg-white/[0.02] font-mono text-[10px] text-slate-400">
                <th className="p-3 w-36">Field</th>
                <th className="p-3">Local File Tag</th>
                <th className="p-3 text-cyan-400">MusicBrainz Match</th>
                <th className="p-3 text-purple-400">Gemini AI Suggestion</th>
                <th className="p-3 w-48 text-lime-400">Staged Output</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05] text-[11px]">
              {comparisonRows.map((row) => (
                <tr key={row.key} className="hover:bg-white/[0.02]">
                  <td className="p-3 font-mono font-bold text-slate-400">{row.field}</td>
                  <td className="p-3 text-slate-300 font-mono">
                    <button
                      onClick={() => setSelectedFields((prev) => ({ ...prev, [row.key]: row.local }))}
                      className="hover:underline text-left"
                    >
                      {row.local}
                    </button>
                  </td>
                  <td className="p-3 font-mono text-cyan-300 font-semibold">
                    <button
                      onClick={() => setSelectedFields((prev) => ({ ...prev, [row.key]: row.musicbrainz }))}
                      className="hover:bg-cyan-500/10 px-2 py-0.5 rounded transition-all text-left flex items-center gap-1.5"
                    >
                      <span>{row.musicbrainz}</span>
                      <span className="text-[9px] text-cyan-500 font-normal">Use</span>
                    </button>
                  </td>
                  <td className="p-3 font-mono text-purple-300 font-semibold">
                    <button
                      onClick={() => setSelectedFields((prev) => ({ ...prev, [row.key]: row.gemini }))}
                      className="hover:bg-purple-500/10 px-2 py-0.5 rounded transition-all text-left flex items-center gap-1.5"
                    >
                      <span>{row.gemini}</span>
                      <span className="text-[9px] text-purple-500 font-normal">Use</span>
                    </button>
                  </td>
                  <td className="p-3 font-mono font-bold text-emerald-400">
                    <input
                      type="text"
                      value={selectedFields[row.key] || ''}
                      onChange={(e) => setSelectedFields({ ...selectedFields, [row.key]: e.target.value })}
                      className="w-full px-2 py-1 bg-black/60 border border-emerald-500/30 rounded text-emerald-300 text-xs focus:outline-none focus:border-emerald-400"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
