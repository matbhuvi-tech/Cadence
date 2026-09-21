import React, { useState } from 'react'
import {
  Users2,
  Plus,
  Tag,
  Music2,
  Mic2,
  Radio,
  Sliders,
  Sparkles,
  ExternalLink,
  Check,
  Play,
} from 'lucide-react'
import { Track, Credit, CreditRole } from '../../core/types'
import { useAudioPlayer } from '../../context/AudioPlayerContext'

interface GranularCreditMatrixProps {
  track: Track
  onAddCredit: (credit: Credit) => void
}

const roleColors: Record<CreditRole, { bg: string; text: string; border: string }> = {
  composer: { bg: 'bg-[#8B5CF6]/15', text: 'text-[#C4B5FD]', border: 'border-[#8B5CF6]/40' },
  conductor: { bg: 'bg-[#00F5FF]/15', text: 'text-[#00F5FF]', border: 'border-[#00F5FF]/40' },
  soloist: { bg: 'bg-[#ADFF2F]/15', text: 'text-[#ADFF2F]', border: 'border-[#ADFF2F]/40' },
  primary_artist: { bg: 'bg-[#38BDF8]/15', text: 'text-[#38BDF8]', border: 'border-[#38BDF8]/40' },
  featured_artist: { bg: 'bg-[#EC4899]/15', text: 'text-[#EC4899]', border: 'border-[#EC4899]/40' },
  arranger: { bg: 'bg-[#F59E0B]/15', text: 'text-[#F59E0B]', border: 'border-[#F59E0B]/40' },
  ensemble: { bg: 'bg-[#10B981]/15', text: 'text-[#10B981]', border: 'border-[#10B981]/40' },
  recording_engineer: { bg: 'bg-[#F43F5E]/15', text: 'text-[#F43F5E]', border: 'border-[#F43F5E]/40' },
  mastering_engineer: { bg: 'bg-[#E11D48]/15', text: 'text-[#E11D48]', border: 'border-[#E11D48]/40' },
  lyricist: { bg: 'bg-[#A855F7]/15', text: 'text-[#A855F7]', border: 'border-[#A855F7]/40' },
  producer: { bg: 'bg-[#6366F1]/15', text: 'text-[#6366F1]', border: 'border-[#6366F1]/40' },
}

export const GranularCreditMatrix: React.FC<GranularCreditMatrixProps> = ({
  track,
  onAddCredit,
}) => {
  const { playTrack } = useAudioPlayer()
  const [isAdding, setIsAdding] = useState(false)
  const [newPersonName, setNewPersonName] = useState('')
  const [newRole, setNewRole] = useState<CreditRole>('recording_engineer')
  const [newDetail, setNewDetail] = useState('')

  const handleSave = () => {
    if (!newPersonName.trim()) return
    onAddCredit({
      personId: `p-${Date.now()}`,
      personName: newPersonName.trim(),
      role: newRole,
      instrumentOrDetail: newDetail.trim() || undefined,
    })
    setNewPersonName('')
    setNewDetail('')
    setIsAdding(false)
  }

  const getMusicBrainzUrl = () => {
    if (track.recordingId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(track.recordingId)) {
      return `https://musicbrainz.org/recording/${track.recordingId}`
    }
    const queryParts = [track.title, track.artistCredit || track.composerName].filter(Boolean)
    return `https://musicbrainz.org/search?type=recording&query=${encodeURIComponent(queryParts.join(' '))}`
  }

  return (
    <div
      data-tutorial-id="credits-matrix-container"
      data-testid="credits-matrix-container"
      className="flex flex-col gap-4 p-4"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users2 className="w-4 h-4 text-[#00F5FF]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
            Granular Credit Matrix
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => playTrack(track)}
            className="p-1.5 px-2 rounded-lg bg-[#10B981]/15 hover:bg-[#10B981]/25 text-[#10B981] border border-[#10B981]/30 text-xs flex items-center gap-1 font-mono transition-colors cursor-pointer"
            title="Play selected track"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Play Track</span>
          </button>
          <button
            onClick={() => setIsAdding(!isAdding)}
            className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-[#00F5FF] text-xs flex items-center gap-1 font-mono transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Credit</span>
          </button>
        </div>
      </div>

      {/* Add Credit Form */}
      {isAdding && (
        <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.08] flex flex-col gap-2.5 text-left text-xs">
          <span className="font-semibold text-white">Add Entity-Level Role</span>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="Person / Entity Name"
              value={newPersonName}
              onChange={(e) => setNewPersonName(e.target.value)}
              className="bg-[#181C26] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#00F5FF]"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as CreditRole)}
              className="bg-[#181C26] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#00F5FF]"
            >
              <option value="composer">Composer</option>
              <option value="conductor">Conductor</option>
              <option value="soloist">Soloist</option>
              <option value="arranger">Arranger</option>
              <option value="ensemble">Ensemble</option>
              <option value="recording_engineer">Recording Engineer</option>
              <option value="mastering_engineer">Mastering Engineer</option>
              <option value="producer">Producer</option>
              <option value="lyricist">Lyricist</option>
            </select>
          </div>
          <input
            type="text"
            placeholder="Instrument / Detail (e.g. Cello, Balance Tonmeister)"
            value={newDetail}
            onChange={(e) => setNewDetail(e.target.value)}
            className="bg-[#181C26] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#00F5FF]"
          />
          <div className="flex justify-end gap-2 mt-1">
            <button
              onClick={() => setIsAdding(false)}
              className="px-3 py-1 rounded text-[#94A3B8] hover:text-white"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1 rounded bg-[#00F5FF] text-black font-semibold hover:bg-[#00F5FF]/90"
            >
              Save Credit
            </button>
          </div>
        </div>
      )}

      {/* Credit Chips by Role */}
      <div className="flex flex-wrap gap-2">
        {track.credits.length === 0 ? (
          <div className="text-xs text-[#64748B] italic">No granular credits assigned.</div>
        ) : (
          track.credits.map((c, i) => {
            const roleStyle = roleColors[c.role] || {
              bg: 'bg-white/10',
              text: 'text-white',
              border: 'border-white/20',
            }

            return (
              <div
                key={i}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-mono transition-all ${roleStyle.bg} ${roleStyle.border} ${roleStyle.text}`}
              >
                <span className="font-semibold">{c.personName}</span>
                <span className="text-[10px] uppercase font-bold opacity-75">[{c.role.replace('_', ' ')}]</span>
                {c.instrumentOrDetail && (
                  <span className="text-[10px] opacity-60">({c.instrumentOrDetail})</span>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Linked Canonical Entities info */}
      <div className="mt-2 p-3 rounded-xl bg-white/[0.02] border border-white/[0.06] text-left text-xs">
        <span className="text-[11px] font-mono text-[#64748B] uppercase font-semibold block mb-2">
          Authority Entity Records
        </span>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[#94A3B8]">
            <span>Composer Entity</span>
            <span className="text-white font-mono">{track.composerName || 'N/A'}</span>
          </div>
          <div className="flex items-center justify-between text-[#94A3B8]">
            <span>AcoustID Hash</span>
            <span className="text-[#00F5FF] font-mono text-[10px] truncate max-w-[160px]">
              chromaprint:AQAAuVIaShKR...
            </span>
          </div>
          <div className="flex items-center justify-between text-[#94A3B8]">
            <span>External Authority</span>
            <a
              href={getMusicBrainzUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#10B981] hover:text-[#00F5FF] hover:underline flex items-center gap-1 text-[11px] cursor-pointer transition-colors group"
              title={`Open MusicBrainz recording for "${track.title}"`}
            >
              <span>MusicBrainz Linked</span>
              <ExternalLink className="w-3 h-3 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
