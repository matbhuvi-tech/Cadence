import React, { useState, useMemo } from 'react'
import {
  Users2,
  Plus,
  ExternalLink,
  Check,
  Copy,
  Film,
} from 'lucide-react'
import { Track, Credit, CreditRole } from '../../core/types'
import { splitMultiArtistCredits, canonicalizeComposer } from '../../core/taxonomyUtils'

interface GranularCreditMatrixProps {
  track: Track
  onAddCredit: (credit: Credit) => void
}

interface DisplayCredit {
  id: string
  name: string
  roles: string[]
  detail?: string
  isManual?: boolean
}

export const GranularCreditMatrix: React.FC<GranularCreditMatrixProps> = ({
  track,
  onAddCredit,
}) => {
  const [isAdding, setIsAdding] = useState(false)
  const [newPersonName, setNewPersonName] = useState('')
  const [newRole, setNewRole] = useState<CreditRole>('recording_engineer')
  const [newDetail, setNewDetail] = useState('')
  const [copiedField, setCopiedField] = useState<string | null>(null)

  const handleCopy = (key: string, text: string) => {
    if (navigator?.clipboard) {
      navigator.clipboard.writeText(text)
      setCopiedField(key)
      setTimeout(() => setCopiedField(null), 1500)
    }
  }

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

  const getInitials = (name: string): string => {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return '?'
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }

  // Deduplicate and group composer + multi-artist performers + manual credits (Guardrail 1)
  const displayCredits = useMemo((): DisplayCredit[] => {
    const map = new Map<string, DisplayCredit>()

    // 1. Canonical Composer
    if (track.composerName && track.composerName.trim()) {
      const canonical = canonicalizeComposer(track.composerName)
      const name = canonical.canonicalName || track.composerName.trim()
      const normKey = name.toLowerCase().replace(/[^a-z0-9]/g, '')
      map.set(normKey, {
        id: `composer-${normKey}`,
        name,
        roles: ['Composer'],
      })
    }

    // 2. Split multi-artist performer credits
    if (track.artistCredit && track.artistCredit.trim()) {
      const splitPerformers = splitMultiArtistCredits(track.artistCredit, 'Performer')
      for (const p of splitPerformers) {
        const normKey = p.name.toLowerCase().replace(/[^a-z0-9]/g, '')
        const existing = map.get(normKey)
        if (existing) {
          if (!existing.roles.includes(p.role)) {
            existing.roles.push(p.role)
          }
        } else {
          map.set(normKey, {
            id: `performer-${normKey}`,
            name: p.name,
            roles: [p.role],
          })
        }
      }
    }

    // 3. User manual assigned credits from track.credits
    if (track.credits && track.credits.length > 0) {
      for (const c of track.credits) {
        const normKey = c.personName.toLowerCase().replace(/[^a-z0-9]/g, '')
        const roleLabel = c.role.replace(/_/g, ' ')
        const formattedRole = roleLabel.charAt(0).toUpperCase() + roleLabel.slice(1)
        const existing = map.get(normKey)
        if (existing) {
          if (!existing.roles.includes(formattedRole)) {
            existing.roles.push(formattedRole)
          }
          if (c.instrumentOrDetail) {
            existing.detail = c.instrumentOrDetail
          }
          existing.isManual = true
        } else {
          map.set(normKey, {
            id: c.personId,
            name: c.personName,
            roles: [formattedRole],
            detail: c.instrumentOrDetail,
            isManual: true,
          })
        }
      }
    }

    return Array.from(map.values())
  }, [track.composerName, track.artistCredit, track.credits])

  const acoustIdHash = track.acousticFingerprint || 'chromaprint:AQAAuVIaShKR89'

  return (
    <div
      data-tutorial-id="credits-matrix-container"
      data-testid="credits-matrix-container"
      className="flex flex-col gap-3.5 p-4 h-full overflow-y-auto text-left select-none"
    >
      {/* Header Row: Clean Single Line with Sleek Add Credit Pill */}
      <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <Users2 className="w-4 h-4 text-[#D4AF37]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[#8E8E93]">
            Granular Credits
          </span>
        </div>
        <button
          onClick={() => setIsAdding(!isAdding)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-[#F5F5F7] transition-colors cursor-pointer"
          title="Add custom contributor role"
        >
          <Plus className="w-3.5 h-3.5 text-[#D4AF37]" />
          <span>Add Credit</span>
        </button>
      </div>

      {/* Original Soundtrack Provenance Banner (Compilation Tracks) */}
      {track.canonicalAlbumTitle && !track.isCanonicalAlbumTrack && (
        <div className="p-3 rounded-xl bg-gradient-to-r from-cyan-950/40 via-cyan-900/20 to-indigo-950/30 border border-cyan-500/25 flex flex-col gap-1.5 shadow-sm">
          <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-cyan-400 font-semibold">
            <Film className="w-3.5 h-3.5 text-cyan-400" />
            <span>Original Soundtrack Provenance</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold text-cyan-100 truncate" title={`Canonical Source: ${track.canonicalAlbumTitle}`}>
              {track.canonicalAlbumTitle}
            </span>
            {track.canonicalReleaseYear && (
              <span className="text-[10px] font-mono text-cyan-300/80 shrink-0">
                ({track.canonicalReleaseYear})
              </span>
            )}
          </div>
          <p className="text-[10px] text-cyan-300/70 leading-relaxed font-sans">
            Linked from compilation recording to canonical movie soundtrack.
          </p>
        </div>
      )}

      {/* Add Credit Form */}
      {isAdding && (
        <div className="p-3 rounded-xl bg-[#16171B] border border-white/[0.08] flex flex-col gap-2.5 text-left text-xs shadow-md">
          <span className="font-semibold text-white">Add Entity-Level Role</span>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="Person / Entity Name"
              value={newPersonName}
              onChange={(e) => setNewPersonName(e.target.value)}
              className="bg-[#0C0D10] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as CreditRole)}
              className="bg-[#0C0D10] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
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
            className="bg-[#0C0D10] border border-white/[0.1] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
          />
          <div className="flex justify-end gap-2 mt-1">
            <button
              onClick={() => setIsAdding(false)}
              className="px-2.5 py-1 rounded text-xs text-[#8E8E93] hover:text-white cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1 rounded-md bg-[#D4AF37] text-[#0C0D10] font-semibold text-xs hover:bg-[#E0BC46] cursor-pointer shadow"
            >
              Save Credit
            </button>
          </div>
        </div>
      )}

      {/* Auto-Populated Relational Entity Cards (Apple HIG Inset Rows) */}
      <div className="flex flex-col gap-2">
        {displayCredits.length === 0 ? (
          <div className="text-xs text-[#636366] italic p-3 text-center bg-white/[0.02] rounded-xl border border-white/[0.04]">
            No credits detected or assigned.
          </div>
        ) : (
          displayCredits.map((credit) => (
            <div
              key={credit.id}
              className="flex items-center justify-between p-2.5 rounded-xl bg-[#16171B] border border-white/[0.06] hover:border-white/[0.12] transition-all gap-2"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-7 h-7 rounded-full bg-white/[0.06] ring-1 ring-white/10 flex items-center justify-center text-[10px] font-serif font-bold text-[#D4AF37] shrink-0">
                  {getInitials(credit.name)}
                </div>
                <div className="flex flex-col truncate min-w-0">
                  <span className="text-xs font-medium text-[#F5F5F7] truncate">{credit.name}</span>
                  {credit.detail && (
                    <span className="text-[10px] text-[#8E8E93] truncate">{credit.detail}</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                {credit.roles.map((r, rIdx) => (
                  <span
                    key={rIdx}
                    className="text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/30 font-semibold"
                  >
                    {r}
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Linked Canonical Entities & Authority Records */}
      <div className="mt-1 p-3.5 rounded-xl bg-[#121316] border border-white/[0.06] text-left text-xs shadow-sm">
        <span className="text-[10px] font-mono text-[#8E8E93] uppercase font-semibold block mb-2.5">
          Authority Entity Records
        </span>
        <div className="flex flex-col gap-2">
          {/* Composer Entity */}
          <div className="flex items-center justify-between text-[#8E8E93]">
            <span>Composer Entity</span>
            <span className="text-[#F5F5F7] font-medium truncate max-w-[170px]">
              {track.composerName || 'Not Cataloged'}
            </span>
          </div>

          {/* Original Soundtrack / Master Provenance */}
          {track.canonicalAlbumTitle && (
            <div className="flex items-center justify-between text-[#8E8E93]">
              <span>Original Soundtrack</span>
              <span className="text-cyan-400 font-medium truncate max-w-[170px]" title={`Primary Master Release: ${track.canonicalAlbumTitle}`}>
                {track.canonicalAlbumTitle} {track.canonicalReleaseYear ? `(${track.canonicalReleaseYear})` : ''}
              </span>
            </div>
          )}

          {/* AcoustID Hash with Copy Feedback (Guardrail 2) */}
          <div className="flex items-center justify-between text-[#8E8E93]">
            <span>AcoustID Hash</span>
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[#A1A1AA] font-mono text-[11px] truncate max-w-[130px]" title={acoustIdHash}>
                {acoustIdHash}
              </span>
              <button
                onClick={() => handleCopy('acoustid', acoustIdHash)}
                title="Copy AcoustID Chromaprint Hash"
                className="p-1 rounded hover:bg-white/[0.08] text-[#8E8E93] hover:text-[#EDEDED] transition-colors cursor-pointer"
              >
                {copiedField === 'acoustid' ? (
                  <Check className="w-3 h-3 text-[#10B981]" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
            </div>
          </div>

          {/* External Authority */}
          <div className="flex items-center justify-between text-[#8E8E93]">
            <span>External Authority</span>
            <a
              href={getMusicBrainzUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#D4AF37] hover:underline flex items-center gap-1 text-[11px] cursor-pointer transition-colors group"
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
