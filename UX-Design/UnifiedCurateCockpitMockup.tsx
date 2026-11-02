/**
 * UX-Design/UnifiedCurateCockpitMockup.tsx
 * 
 * Standalone Interactive TSX Mockup for the Unified Curate & Audit Cockpit.
 * Grounded in Apple Human Interface Guidelines (HIG):
 * - Purpose: Single unified cockpit for catalog health, 3-tier staged metadata curation, and behavioral learning.
 * - Simplicity: 3-segment operational pill control (Tier 1 Auto-Staged, Tier 2 Smart Aligned, Tier 3 Needs Review).
 * - Agency: Reversible two-phase batch commits, transparent track offset bridge, and auditable learned rules registry.
 * - Familiarity: Native Dark Audiophile UI with gold (#D4AF37), cyan (#06B6D4), and emerald (#10B981) accents.
 */

import React, { useState } from 'react'
import {
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  SlidersHorizontal,
  Layers,
  ArrowRight,
  RefreshCw,
  Search,
  BookOpen,
  ShieldCheck,
  Disc3,
  Play,
  Pause,
  X,
  ExternalLink,
  ChevronRight,
  Database,
  Volume2,
  Lock,
  Plus,
  Trash2,
  Edit2,
  Undo2,
  FileCheck2,
  Music2,
  Info
} from 'lucide-react'

// --- Mock Domain Models ---

type CurateTier = 'tier1' | 'tier2' | 'tier3'

interface MockAlbumItem {
  id: string
  folderName: string
  currentTitle: string
  proposedTitle: string
  proposedArtist: string
  proposedComposer: string
  proposedYear: number
  coverArtUrl: string
  trackCount: number
  confidenceScore: number
  tier: CurateTier
  consensusAgreedSources: ('local' | 'apple' | 'musicbrainz' | 'gemini')[]
  offsetApplied?: number
  phoneticMatchConfidence?: number
  groundingUrl?: string
  status: 'staged' | 'committing' | 'committed' | 'rejected'
  tracks: MockTrackItem[]
}

interface MockTrackItem {
  trackNumber: number
  localTitle: string
  localFile: string
  proposedTitle: string
  proposedArtists: string
  offsetSourceTrack?: number
  durationSecs: number
  matchedDurationSecs?: number
}

interface MockLearnedRule {
  id: string
  rawPattern: string
  canonicalReplacement: string
  ruleType: 'spelling' | 'delimiter' | 'packaging_suffix' | 'honorific'
  scope: 'global' | 'album'
  occurrences: number
  isActive: boolean
  lastApplied: string
}

// --- Sample Seed Data ---

const INITIAL_ALBUMS: MockAlbumItem[] = [
  {
    id: 'alb-1',
    folderName: 'Thalapathi CD RIP',
    currentTitle: 'Thalapathi CD RIP',
    proposedTitle: 'Thalapathi (Original Motion Picture Soundtrack)',
    proposedArtist: 'Ilaiyaraaja',
    proposedComposer: 'Ilaiyaraaja',
    proposedYear: 1991,
    coverArtUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/bb/94/bc/bb94bc97-e818-f2e3-2ee8-dc1a8f90ff8a/8901858022889.jpg/600x600bb.jpg',
    trackCount: 7,
    confidenceScore: 0.98,
    tier: 'tier1',
    consensusAgreedSources: ['local', 'apple', 'musicbrainz', 'gemini'],
    status: 'staged',
    tracks: [
      { trackNumber: 1, localTitle: 'Rakkamma Kaiya Thattu', localFile: '01 - Rakkamma.wav', proposedTitle: 'Rakkamma Kaiya Thattu', proposedArtists: 'S. P. Balasubrahmanyam & Swarnalatha', durationSecs: 432, matchedDurationSecs: 432 },
      { trackNumber: 2, localTitle: 'Sundari Kannal', localFile: '02 - Sundari.wav', proposedTitle: 'Sundari Kannal Oru Sethi', proposedArtists: 'S. P. Balasubrahmanyam & S. Janaki', durationSecs: 435, matchedDurationSecs: 434 },
      { trackNumber: 3, localTitle: 'Yamunai Aatrile', localFile: '03 - Yamunai.wav', proposedTitle: 'Yamunai Aatrile', proposedArtists: 'Mitali Banerjee Bhawmik', durationSecs: 260, matchedDurationSecs: 261 },
    ]
  },
  {
    id: 'alb-2',
    folderName: 'Ranga CD RIP',
    currentTitle: 'Ranga CD RIP',
    proposedTitle: 'Ranga (Original Motion Picture Soundtrack) - EP',
    proposedArtist: 'Shankar Ganesh',
    proposedComposer: 'Shankar Ganesh',
    proposedYear: 1982,
    coverArtUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/e2/fe/21/e2fe21b6-50e6-7b4b-285a-d40394baba4e/8902894628990_cover.jpg/600x600bb.jpg',
    trackCount: 5,
    confidenceScore: 0.88,
    tier: 'tier2',
    consensusAgreedSources: ['apple', 'gemini'],
    offsetApplied: 5,
    phoneticMatchConfidence: 0.94,
    status: 'staged',
    tracks: [
      { trackNumber: 6, localTitle: 'Pattukottai', localFile: '06 - Pattukottai.wav', proposedTitle: 'Pattukotta Ammalu', proposedArtists: 'Shankar Ganesh, Vaalee & Malaysia Vasudevan', offsetSourceTrack: 1, durationSecs: 278, matchedDurationSecs: 279 },
      { trackNumber: 7, localTitle: 'Azhagana', localFile: '07 - Azhagana.wav', proposedTitle: 'Azhagana Pattu Poochi', proposedArtists: 'Shankar Ganesh, Vaalee, Malaysia Vasudevan & Vani Jairam', offsetSourceTrack: 2, durationSecs: 285, matchedDurationSecs: 284 },
      { trackNumber: 8, localTitle: 'Purushanthan', localFile: '08 - Purushanthan.wav', proposedTitle: 'Purushantha Evan Purushantha', proposedArtists: 'Shankar Ganesh, Vaalee, Malaysia Vasudevan & P. Susheela', offsetSourceTrack: 3, durationSecs: 265, matchedDurationSecs: 265 },
      { trackNumber: 9, localTitle: 'Tooth Paste', localFile: '09 - Tooth Paste.wav', proposedTitle: 'Tooth Paste Erukku Brush Irukku', proposedArtists: 'Shankar Ganesh, S.P. Balasubrahmanyam & S. Janaki', offsetSourceTrack: 4, durationSecs: 270, matchedDurationSecs: 271 },
      { trackNumber: 10, localTitle: 'Oru Maina', localFile: '10 - Oru Maina.wav', proposedTitle: 'Oru Maina Maina', proposedArtists: 'Shankar Ganesh, Malaysia Vasudevan & S. Janaki', offsetSourceTrack: 5, durationSecs: 282, matchedDurationSecs: 281 },
    ]
  },
  {
    id: 'alb-3',
    folderName: 'Mouna Raagam Rare Cassette',
    currentTitle: 'Mouna Raagam Rare Cassette',
    proposedTitle: 'Mouna Ragam (Original Soundtrack)',
    proposedArtist: 'Ilaiyaraaja',
    proposedComposer: 'Ilaiyaraaja',
    proposedYear: 1986,
    coverArtUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/8e/f8/85/8ef88544-a6c7-018b-0a75-dc3b6b024fa0/cover.jpg/600x600bb.jpg',
    trackCount: 5,
    confidenceScore: 0.62,
    tier: 'tier3',
    consensusAgreedSources: ['gemini'],
    status: 'staged',
    groundingUrl: '',
    tracks: [
      { trackNumber: 1, localTitle: 'Track 01 Mandram', localFile: '01 - Track 01 Mandram.wav', proposedTitle: 'Mandram Vandha Thendralukku', proposedArtists: 'S. P. Balasubrahmanyam', durationSecs: 280 },
      { trackNumber: 2, localTitle: 'Track 02 Nilave', localFile: '02 - Track 02 Nilave.wav', proposedTitle: 'Nilave Vaa', proposedArtists: 'S. P. Balasubrahmanyam', durationSecs: 274 },
    ]
  }
]

const INITIAL_LEARNED_RULES: MockLearnedRule[] = [
  {
    id: 'rule-1',
    rawPattern: 'A.R. Rahman',
    canonicalReplacement: 'A. R. Rahman',
    ruleType: 'spelling',
    scope: 'global',
    occurrences: 48,
    isActive: true,
    lastApplied: '2026-11-01'
  },
  {
    id: 'rule-2',
    rawPattern: 'Illayaraja',
    canonicalReplacement: 'Ilaiyaraaja',
    ruleType: 'spelling',
    scope: 'global',
    occurrences: 84,
    isActive: true,
    lastApplied: '2026-11-02'
  },
  {
    id: 'rule-3',
    rawPattern: 'feat.',
    canonicalReplacement: '&',
    ruleType: 'delimiter',
    scope: 'global',
    occurrences: 19,
    isActive: true,
    lastApplied: '2026-10-28'
  }
]

export const UnifiedCurateCockpitMockup: React.FC = () => {
  const [activeTier, setActiveTier] = useState<CurateTier>('tier2')
  const [albums, setAlbums] = useState<MockAlbumItem[]>(INITIAL_ALBUMS)
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>('alb-2')
  const [learnedRules, setLearnedRules] = useState<MockLearnedRule[]>(INITIAL_LEARNED_RULES)
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false)
  const [isHealthDrawerOpen, setIsHealthDrawerOpen] = useState(false)
  const [groundingInput, setGroundingInput] = useState('')
  const [isCommittingBatch, setIsCommittingBatch] = useState(false)
  const [commitProgress, setCommitProgress] = useState(0)
  const [isPlaybackActive, setIsPlaybackActive] = useState(false) // Transport guard simulation
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  const selectedAlbum = albums.find(a => a.id === selectedAlbumId) || albums[0]
  const tier1Count = albums.filter(a => a.tier === 'tier1' && a.status === 'staged').length
  const tier2Count = albums.filter(a => a.tier === 'tier2' && a.status === 'staged').length
  const tier3Count = albums.filter(a => a.tier === 'tier3' && a.status === 'staged').length

  const showToast = (msg: string) => {
    setToastMessage(msg)
    setTimeout(() => setToastMessage(null), 3500)
  }

  // Action: Commit All Tier 1
  const handleCommitAllTier1 = () => {
    if (isPlaybackActive) {
      showToast('⚠️ Transport Purity Guard: Commit paused because audio playback is active.')
      return
    }
    setIsCommittingBatch(true)
    setCommitProgress(10)
    const interval = setInterval(() => {
      setCommitProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval)
          setIsCommittingBatch(false)
          setAlbums(prevAlbums =>
            prevAlbums.map(a => a.tier === 'tier1' ? { ...a, status: 'committed' } : a)
          )
          showToast(`✓ Successfully committed ${tier1Count} Tier 1 albums in background!`)
          return 0
        }
        return prev + 30
      })
    }, 400)
  }

  // Action: Reject Album from Tier 1/2 to Tier 3
  const handleRejectToTier3 = (albumId: string) => {
    setAlbums(prev =>
      prev.map(a => (a.id === albumId ? { ...a, tier: 'tier3', confidenceScore: 0.55 } : a))
    )
    setActiveTier('tier3')
    showToast('Album demoted to Tier 3 for guided human steering.')
  }

  // Action: Submit Grounding URL in Tier 3
  const handleApplyGrounding = () => {
    if (!groundingInput.trim()) return
    setAlbums(prev =>
      prev.map(a =>
        a.id === selectedAlbum.id
          ? {
              ...a,
              groundingUrl: groundingInput,
              confidenceScore: 0.96,
              tier: 'tier1',
              status: 'staged',
              consensusAgreedSources: ['apple', 'gemini', 'local']
            }
          : a
      )
    )
    setGroundingInput('')
    setActiveTier('tier1')
    showToast('✓ Grounding URL validated! Promoted to Tier 1 (Auto-Staged).')
  }

  return (
    <div className="w-full h-screen bg-[#0E0F12] text-[#F3F4F6] flex flex-col font-sans select-none overflow-hidden">
      {/* 1. Header Toolbar */}
      <header className="h-14 border-b border-white/[0.08] px-6 flex items-center justify-between shrink-0 bg-[#121318]/80 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center text-[#D4AF37]">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-white">Curate & Catalog Cockpit</h1>
            <p className="text-[10px] text-white/50">Autonomous 3-Tier Pipeline • Cadence Audiophile Engine</p>
          </div>
        </div>

        {/* Center: 3-Tier Operational Segmented Control (Apple HIG standard) */}
        <div className="flex items-center p-1 bg-black/40 rounded-xl border border-white/[0.08]">
          <button
            onClick={() => setActiveTier('tier1')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-2 cursor-pointer ${
              activeTier === 'tier1'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                : 'text-white/60 hover:text-white'
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Tier 1: Auto-Staged</span>
            <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-500/30 text-emerald-200">
              {tier1Count}
            </span>
          </button>

          <button
            onClick={() => setActiveTier('tier2')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-2 cursor-pointer ${
              activeTier === 'tier2'
                ? 'bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/40 shadow-sm'
                : 'text-white/60 hover:text-white'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Tier 2: Smart Aligned</span>
            <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-[#D4AF37]/30 text-[#D4AF37]">
              {tier2Count}
            </span>
          </button>

          <button
            onClick={() => setActiveTier('tier3')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-2 cursor-pointer ${
              activeTier === 'tier3'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                : 'text-white/60 hover:text-white'
            }`}
          >
            <HelpCircle className="w-3.5 h-3.5" />
            <span>Tier 3: Needs Review</span>
            <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-cyan-500/30 text-cyan-200">
              {tier3Count}
            </span>
          </button>
        </div>

        {/* Right Utility Actions */}
        <div className="flex items-center gap-2">
          {/* Audio Transport Invariant Simulator */}
          <button
            onClick={() => setIsPlaybackActive(!isPlaybackActive)}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 cursor-pointer ${
              isPlaybackActive
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                : 'bg-white/[0.04] text-white/60 border-white/[0.08] hover:text-white'
            }`}
            title="Simulate Windows WASAPI Exclusive playback state"
          >
            {isPlaybackActive ? <Volume2 className="w-3.5 h-3.5 animate-pulse" /> : <Pause className="w-3.5 h-3.5" />}
            <span className="text-[11px]">{isPlaybackActive ? 'Playing (Bus Silent)' : 'Engine Idle'}</span>
          </button>

          <button
            onClick={() => setIsHealthDrawerOpen(true)}
            className="px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-white/70 hover:text-white text-xs border border-white/[0.08] transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
            <span>Health & Audit</span>
          </button>

          <button
            onClick={() => setIsRulesModalOpen(true)}
            className="px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-white/70 hover:text-white text-xs border border-white/[0.08] transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <BookOpen className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span>Learned Rules ({learnedRules.length})</span>
          </button>
        </div>
      </header>

      {/* 2. Main Content Split View */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sub-Queue Column (300px) */}
        <aside className="w-80 border-r border-white/[0.08] bg-[#0A0B0E] flex flex-col shrink-0">
          <div className="p-3 border-b border-white/[0.06] flex items-center justify-between">
            <span className="text-xs font-medium text-white/70">
              {activeTier === 'tier1' && 'Auto-Staged Releases'}
              {activeTier === 'tier2' && 'Sequence-Aligned Releases'}
              {activeTier === 'tier3' && 'Releases Requiring Review'}
            </span>
            {activeTier === 'tier1' && tier1Count > 0 && (
              <button
                onClick={handleCommitAllTier1}
                disabled={isCommittingBatch}
                className="px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-[11px] transition-all cursor-pointer shadow-sm flex items-center gap-1"
              >
                <CheckCircle2 className="w-3 h-3" />
                <span>Commit All ({tier1Count})</span>
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
            {albums
              .filter(a => a.tier === activeTier && a.status === 'staged')
              .map(alb => (
                <div
                  key={alb.id}
                  onClick={() => setSelectedAlbumId(alb.id)}
                  className={`p-3.5 transition-colors cursor-pointer flex gap-3 ${
                    selectedAlbum.id === alb.id
                      ? 'bg-white/[0.08] border-l-2 border-[#D4AF37]'
                      : 'hover:bg-white/[0.03]'
                  }`}
                >
                  <img
                    src={alb.coverArtUrl}
                    alt={alb.proposedTitle}
                    className="w-12 h-12 rounded-lg object-cover border border-white/10 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <h3 className="text-xs font-medium text-white truncate">{alb.proposedTitle}</h3>
                    <p className="text-[11px] text-white/50 truncate mt-0.5">{alb.proposedArtist} • {alb.proposedYear}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/[0.06] text-white/60">
                        {alb.trackCount} tracks
                      </span>
                      {alb.offsetApplied !== undefined && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#D4AF37]/20 text-[#D4AF37] font-mono">
                          +{alb.offsetApplied} offset
                        </span>
                      )}
                      <span className="text-[10px] text-emerald-400 ml-auto font-mono">
                        {Math.round(alb.confidenceScore * 100)}%
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            {albums.filter(a => a.tier === activeTier && a.status === 'staged').length === 0 && (
              <div className="p-8 text-center text-white/40 text-xs">
                No albums currently in this tier queue.
              </div>
            )}
          </div>
        </aside>

        {/* Center / Right Workbench (Reconciliation Stage) */}
        <main className="flex-1 flex flex-col bg-[#0E0F12] overflow-y-auto">
          {/* Top Banner: Context & Tier Intelligence */}
          <div className="p-6 border-b border-white/[0.08] bg-[#121318]/50">
            <div className="flex items-start justify-between gap-6">
              <div className="flex items-start gap-4">
                <img
                  src={selectedAlbum.coverArtUrl}
                  alt={selectedAlbum.proposedTitle}
                  className="w-24 h-24 rounded-xl object-cover border border-white/10 shadow-lg"
                />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/[0.08] text-white/60 uppercase">
                      {selectedAlbum.folderName}
                    </span>
                    {selectedAlbum.tier === 'tier1' && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        Tier 1: Auto-Staged (Consensus)
                      </span>
                    )}
                    {selectedAlbum.tier === 'tier2' && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/30">
                        Tier 2: Smart Offset & Phonetic Aligned
                      </span>
                    )}
                    {selectedAlbum.tier === 'tier3' && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                        Tier 3: Guided Human Review
                      </span>
                    )}
                  </div>
                  <h2 className="text-lg font-semibold text-white mt-1">{selectedAlbum.proposedTitle}</h2>
                  <p className="text-xs text-white/60 mt-0.5">
                    Composer: <span className="text-[#D4AF37]">{selectedAlbum.proposedComposer}</span> • Artist: {selectedAlbum.proposedArtist} • Year: {selectedAlbum.proposedYear}
                  </p>

                  {/* Consensus Agreement Pills */}
                  <div className="flex items-center gap-2 mt-3">
                    <span className="text-[11px] text-white/40">Consensus Evidence:</span>
                    {selectedAlbum.consensusAgreedSources.map(s => (
                      <span key={s} className="text-[10px] px-2 py-0.5 rounded bg-white/[0.06] text-white/80 border border-white/[0.08] capitalize">
                        ✓ {s === 'apple' ? 'Apple Music' : s}
                      </span>
                    ))}
                    <div className="ml-auto text-xs font-mono text-emerald-400">
                      Confidence: {Math.round(selectedAlbum.confidenceScore * 100)}%
                    </div>
                  </div>
                </div>
              </div>

              {/* Action Buttons for Active Release */}
              <div className="flex flex-col items-end gap-2">
                <div className="flex items-center gap-2">
                  {selectedAlbum.tier !== 'tier3' && (
                    <button
                      onClick={() => handleRejectToTier3(selectedAlbum.id)}
                      className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-red-500/20 text-white/60 hover:text-red-300 text-xs border border-white/[0.08] transition-colors cursor-pointer"
                    >
                      Reject to Tier 3
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setAlbums(prev => prev.map(a => a.id === selectedAlbum.id ? { ...a, status: 'committed' } : a))
                      showToast(`✓ Committed "${selectedAlbum.proposedTitle}" to library!`)
                    }}
                    className="px-4 py-1.5 rounded-lg bg-[#D4AF37] hover:bg-[#c29e2f] text-black font-semibold text-xs transition-colors cursor-pointer shadow-sm flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Commit This Album</span>
                  </button>
                </div>
                <span className="text-[10px] text-white/40">Writes ID3v2/FLAC tags non-blocking</span>
              </div>
            </div>

            {/* Tier 3 Guided Steering Box */}
            {selectedAlbum.tier === 'tier3' && (
              <div className="mt-4 p-3.5 rounded-xl bg-cyan-500/[0.06] border border-cyan-500/20 flex items-center gap-3">
                <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />
                <div className="flex-1">
                  <span className="text-xs font-medium text-cyan-200">Provide Human Grounding Hint</span>
                  <p className="text-[11px] text-cyan-200/60 mt-0.5">
                    Paste an Apple Music, MusicBrainz, or Discogs album link to instantly anchor metadata:
                  </p>
                </div>
                <div className="flex items-center gap-2 w-1/2">
                  <input
                    type="text"
                    value={groundingInput}
                    onChange={(e) => setGroundingInput(e.target.value)}
                    placeholder="https://music.apple.com/... or search terms"
                    className="flex-1 bg-black/50 border border-cyan-500/30 rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    onClick={handleApplyGrounding}
                    className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black font-semibold text-xs cursor-pointer transition-colors"
                  >
                    Anchor
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Tracklist Alignment Table */}
          <div className="p-6 flex-1">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-medium text-white/80">Tracklist Alignment & Authentic Performers</h3>
              {selectedAlbum.offsetApplied !== undefined && (
                <div className="text-[11px] text-[#D4AF37] flex items-center gap-1.5 bg-[#D4AF37]/10 px-2.5 py-1 rounded-lg border border-[#D4AF37]/20">
                  <SlidersHorizontal className="w-3 h-3" />
                  <span>Offset Bridge: Local tracks #{selectedAlbum.tracks[0]?.trackNumber}–#{selectedAlbum.tracks[selectedAlbum.tracks.length - 1]?.trackNumber} mapped to Provider #{selectedAlbum.tracks[0]?.offsetSourceTrack}–#{selectedAlbum.tracks[selectedAlbum.tracks.length - 1]?.offsetSourceTrack}</span>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-white/[0.08] overflow-hidden bg-[#121318]/30">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-white/[0.08] bg-white/[0.02] text-white/40 text-[11px]">
                    <th className="py-2.5 px-4 w-16">Local #</th>
                    <th className="py-2.5 px-4 w-1/4">Local File Title</th>
                    <th className="py-2.5 px-4 w-16">Store #</th>
                    <th className="py-2.5 px-4 w-1/4">Canonical Track Title</th>
                    <th className="py-2.5 px-4">Singers / Performers</th>
                    <th className="py-2.5 px-4 w-24 text-right">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {selectedAlbum.tracks.map((trk) => (
                    <tr key={trk.trackNumber} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-2.5 px-4 font-mono text-white/50">#{trk.trackNumber}</td>
                      <td className="py-2.5 px-4">
                        <div className="text-white font-medium">{trk.localTitle}</div>
                        <div className="text-[10px] text-white/40 font-mono mt-0.5">{trk.localFile}</div>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-[#D4AF37]">
                        {trk.offsetSourceTrack ? `#${trk.offsetSourceTrack}` : '—'}
                      </td>
                      <td className="py-2.5 px-4 text-emerald-300 font-medium">
                        {trk.proposedTitle}
                      </td>
                      <td className="py-2.5 px-4 text-white/80">
                        {trk.proposedArtists}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-white/50 text-[11px]">
                        {Math.floor(trk.durationSecs / 60)}:{(trk.durationSecs % 60).toString().padStart(2, '0')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>

      {/* Floating Batch Commit Progress HUD */}
      {isCommittingBatch && (
        <div className="fixed bottom-6 right-6 z-50 bg-[#1A1C23] border border-emerald-500/40 rounded-xl p-4 shadow-2xl flex items-center gap-4 animate-fade-in">
          <div className="w-8 h-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin shrink-0" />
          <div>
            <div className="text-xs font-semibold text-white">Committing Tier 1 Batch ({commitProgress}%)</div>
            <p className="text-[10px] text-white/50">Writing non-blocking tags to storage...</p>
          </div>
          <button
            onClick={() => setIsCommittingBatch(false)}
            className="px-2.5 py-1 rounded bg-white/[0.06] hover:bg-white/[0.1] text-xs text-white/60 cursor-pointer"
          >
            Pause
          </button>
        </div>
      )}

      {/* Learned Rules Management Modal */}
      {isRulesModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="w-full max-w-2xl bg-[#121318] border border-white/[0.1] rounded-2xl p-6 shadow-2xl flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between pb-4 border-b border-white/[0.08]">
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-[#D4AF37]" />
                <h3 className="text-sm font-semibold text-white">Learned Normalization Conventions</h3>
              </div>
              <button
                onClick={() => setIsRulesModalOpen(false)}
                className="text-white/40 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-white/60 mt-3">
              Cadence remembers manual spelling corrections and automatically applies them in Tier 1 consensus.
            </p>

            <div className="flex-1 overflow-y-auto mt-4 divide-y divide-white/[0.06]">
              {learnedRules.map((rule) => (
                <div key={rule.id} className="py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs line-through text-white/40">{rule.rawPattern}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-[#D4AF37]" />
                      <span className="text-xs font-semibold text-emerald-300">{rule.canonicalReplacement}</span>
                    </div>
                    <div className="text-[10px] text-white/40 mt-1">
                      Type: {rule.ruleType} • Applied {rule.occurrences} times • Scope: {rule.scope}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setLearnedRules(prev => prev.filter(r => r.id !== rule.id))
                        showToast(`Revoked rule: ${rule.rawPattern}`)
                      }}
                      className="p-1.5 rounded hover:bg-red-500/20 text-white/40 hover:text-red-300 transition-colors cursor-pointer"
                      title="Revoke Rule"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-4 border-t border-white/[0.08] flex justify-end">
              <button
                onClick={() => setIsRulesModalOpen(false)}
                className="px-4 py-2 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-xs font-medium text-white cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Catalog Health & Audit Drawer */}
      {isHealthDrawerOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex justify-end">
          <div className="w-96 bg-[#121318] border-l border-white/[0.1] p-6 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-white/[0.08]">
              <div className="flex items-center gap-2">
                <Layers className="w-5 h-5 text-cyan-400" />
                <h3 className="text-sm font-semibold text-white">Catalog Health Telemetry</h3>
              </div>
              <button onClick={() => setIsHealthDrawerOpen(false)} className="text-white/40 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                <div className="text-[11px] text-white/50">Uncurated Releases</div>
                <div className="text-xl font-semibold text-white mt-0.5">192</div>
              </div>
              <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                <div className="text-[11px] text-white/50">Missing Artwork Scans</div>
                <div className="text-xl font-semibold text-amber-300 mt-0.5">14</div>
              </div>
              <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                <div className="text-[11px] text-white/50">Conflicting Artist Spellings</div>
                <div className="text-xl font-semibold text-cyan-300 mt-0.5">28</div>
              </div>
            </div>

            <div className="mt-auto">
              <button
                onClick={() => {
                  setIsHealthDrawerOpen(false)
                  setActiveTier('tier1')
                }}
                className="w-full py-2.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-xs font-medium text-white cursor-pointer"
              >
                Review All Uncurated Albums
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-[#1E2028] border border-white/20 text-white text-xs px-4 py-2.5 rounded-xl shadow-2xl animate-fade-in flex items-center gap-2">
          <Info className="w-4 h-4 text-[#D4AF37]" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  )
}
export default UnifiedCurateCockpitMockup
