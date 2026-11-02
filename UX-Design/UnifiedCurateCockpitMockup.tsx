/**
 * UX-Design/UnifiedCurateCockpitMockup.tsx
 * 
 * Standalone Interactive TSX Mockup: Unified Curate & Catalog Cockpit.
 * 2-Tier Architecture (Tier 2 & 3 Merged into Guided 4-Way Table Reconciliation):
 * - Tier 1: Auto-Staged (High-confidence consensus >= 0.85, 1-click batch commit).
 * - Tier 2: Guided Review & Alignment (Unified table format: Apple / MusicBrainz / Local / AI / Selected).
 * 
 * Fully clickable and interactive:
 * - Click any provider cell (Apple, MB, Local, AI) to select it as the staged value.
 * - Inline edit icons for every field to supply manual overrides (URL for cover art).
 * - Sequence-aware track offset visualizer with track-level 4-way candidate selection.
 * - Non-blocking background commit queue simulation with transport purity guard.
 */

import React, { useState } from 'react'
import {
  Sparkles,
  CheckCircle2,
  SlidersHorizontal,
  Layers,
  ArrowRight,
  BookOpen,
  Volume2,
  Pause,
  X,
  Edit2,
  Check,
  Undo2,
  Trash2,
  Image as ImageIcon,
  Link2,
  Music,
  Info,
  ChevronDown,
  RotateCcw
} from 'lucide-react'

// --- Types ---

type CurateTier = 'tier1' | 'tier2'

interface FieldCandidate<T> {
  value: T
  sourceLabel: string
  confidence?: number
}

interface MetadataFieldState<T> {
  fieldKey: string
  label: string
  local: FieldCandidate<T>
  apple: FieldCandidate<T>
  musicbrainz: FieldCandidate<T>
  ai: FieldCandidate<T>
  selectedSource: 'local' | 'apple' | 'musicbrainz' | 'ai' | 'manual'
  manualValue?: T
}

interface TrackCandidateState {
  trackNumber: number
  localTitle: string
  localFile: string
  offsetSourceTrack?: number
  durationSecs: number
  apple: { title: string; artists: string }
  musicbrainz: { title: string; artists: string }
  ai: { title: string; artists: string }
  local: { title: string; artists: string }
  selectedSource: 'local' | 'apple' | 'musicbrainz' | 'ai' | 'manual'
  manualTitle?: string
  manualArtists?: string
}

interface MockAlbumItem {
  id: string
  folderName: string
  currentTitle: string
  tier: CurateTier
  status: 'staged' | 'committing' | 'committed'
  confidenceScore: number
  offsetApplied?: number
  // Album-level 4-way fields
  albumTitle: MetadataFieldState<string>
  albumArtist: MetadataFieldState<string>
  composer: MetadataFieldState<string>
  year: MetadataFieldState<number>
  coverArt: MetadataFieldState<string>
  genre: MetadataFieldState<string>
  // Track-level 4-way fields
  tracks: TrackCandidateState[]
}

interface MockLearnedRule {
  id: string
  rawPattern: string
  canonicalReplacement: string
  ruleType: 'spelling' | 'delimiter' | 'packaging_suffix'
  occurrences: number
}

// --- Sample Seed Data ---

const INITIAL_ALBUMS: MockAlbumItem[] = [
  {
    id: 'alb-ranga',
    folderName: 'Ranga CD RIP',
    currentTitle: 'Ranga CD RIP',
    tier: 'tier2',
    status: 'staged',
    confidenceScore: 0.88,
    offsetApplied: 5,
    albumTitle: {
      fieldKey: 'title',
      label: 'Album Title',
      local: { value: 'Ranga CD RIP', sourceLabel: 'Local File' },
      apple: { value: 'Ranga (Original Motion Picture Soundtrack) - EP', sourceLabel: 'Apple Music', confidence: 0.95 },
      musicbrainz: { value: 'St. Ranga', sourceLabel: 'MusicBrainz', confidence: 0.40 },
      ai: { value: 'Ranga (Original Motion Picture Soundtrack)', sourceLabel: 'Gemini AI', confidence: 0.98 },
      selectedSource: 'ai',
    },
    albumArtist: {
      fieldKey: 'artist',
      label: 'Album Artist',
      local: { value: 'Unknown Artist', sourceLabel: 'Local File' },
      apple: { value: 'Shankar Ganesh, Vaalee & Malaysia Vasudevan', sourceLabel: 'Apple Music', confidence: 0.90 },
      musicbrainz: { value: 'Bloodnut', sourceLabel: 'MusicBrainz', confidence: 0.35 },
      ai: { value: 'Shankar Ganesh & Vaalee', sourceLabel: 'Gemini AI', confidence: 0.96 },
      selectedSource: 'ai',
    },
    composer: {
      fieldKey: 'composer',
      label: 'Composer',
      local: { value: 'Shankar-Ganesh', sourceLabel: 'Local File' },
      apple: { value: 'Shankar Ganesh', sourceLabel: 'Apple Music', confidence: 0.95 },
      musicbrainz: { value: 'Bloodnut', sourceLabel: 'MusicBrainz', confidence: 0.30 },
      ai: { value: 'Shankar Ganesh', sourceLabel: 'Gemini AI', confidence: 0.99 },
      selectedSource: 'apple',
    },
    year: {
      fieldKey: 'year',
      label: 'Release Year',
      local: { value: 1982, sourceLabel: 'Local File' },
      apple: { value: 1982, sourceLabel: 'Apple Music', confidence: 0.95 },
      musicbrainz: { value: 2017, sourceLabel: 'MusicBrainz', confidence: 0.50 },
      ai: { value: 1982, sourceLabel: 'Gemini AI', confidence: 0.98 },
      selectedSource: 'apple',
    },
    coverArt: {
      fieldKey: 'coverArt',
      label: 'Cover Art',
      local: { value: '', sourceLabel: 'Local (None)' },
      apple: { value: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/e2/fe/21/e2fe21b6-50e6-7b4b-285a-d40394baba4e/8902894628990_cover.jpg/600x600bb.jpg', sourceLabel: 'Apple Music HD 3000px', confidence: 0.96 },
      musicbrainz: { value: 'https://coverartarchive.org/release/123/front-500', sourceLabel: 'MusicBrainz CAA', confidence: 0.60 },
      ai: { value: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/e2/fe/21/e2fe21b6-50e6-7b4b-285a-d40394baba4e/8902894628990_cover.jpg/600x600bb.jpg', sourceLabel: 'Gemini AI Reference', confidence: 0.95 },
      selectedSource: 'apple',
    },
    genre: {
      fieldKey: 'genre',
      label: 'Genre',
      local: { value: 'Soundtrack', sourceLabel: 'Local File' },
      apple: { value: 'Tamil Cinema / Soundtrack', sourceLabel: 'Apple Music', confidence: 0.92 },
      musicbrainz: { value: 'Film Score', sourceLabel: 'MusicBrainz', confidence: 0.80 },
      ai: { value: 'Soundtrack', sourceLabel: 'Gemini AI', confidence: 0.95 },
      selectedSource: 'apple',
    },
    tracks: [
      {
        trackNumber: 6,
        localTitle: 'Pattukottai',
        localFile: '06 - Pattukottai.wav',
        offsetSourceTrack: 1,
        durationSecs: 278,
        local: { title: 'Pattukottai', artists: 'Unknown' },
        apple: { title: 'Pattukotta Ammalu', artists: 'Shankar Ganesh, Vaalee & Malaysia Vasudevan' },
        musicbrainz: { title: 'Pattukottai', artists: 'Bloodnut' },
        ai: { title: 'Pattukotta Ammalu', artists: 'Malaysia Vasudevan' },
        selectedSource: 'apple',
      },
      {
        trackNumber: 7,
        localTitle: 'Azhagana',
        localFile: '07 - Azhagana.wav',
        offsetSourceTrack: 2,
        durationSecs: 285,
        local: { title: 'Azhagana', artists: 'Unknown' },
        apple: { title: 'Azhagana Pattu Poochi', artists: 'Shankar Ganesh, Vaalee, Malaysia Vasudevan & Vani Jairam' },
        musicbrainz: { title: 'Azhagana', artists: 'Bloodnut' },
        ai: { title: 'Azhagana Pattu Poochi', artists: 'Malaysia Vasudevan & Vani Jairam' },
        selectedSource: 'apple',
      },
      {
        trackNumber: 8,
        localTitle: 'Purushanthan',
        localFile: '08 - Purushanthan.wav',
        offsetSourceTrack: 3,
        durationSecs: 265,
        local: { title: 'Purushanthan', artists: 'Unknown' },
        apple: { title: 'Purushantha Evan Purushantha', artists: 'Shankar Ganesh, Vaalee, Malaysia Vasudevan & P. Susheela' },
        musicbrainz: { title: 'Purushanthan', artists: 'Bloodnut' },
        ai: { title: 'Purushantha Evan Purushantha', artists: 'Malaysia Vasudevan & P. Susheela' },
        selectedSource: 'apple',
      },
      {
        trackNumber: 9,
        localTitle: 'Tooth Paste',
        localFile: '09 - Tooth Paste.wav',
        offsetSourceTrack: 4,
        durationSecs: 270,
        local: { title: 'Tooth Paste', artists: 'Unknown' },
        apple: { title: 'Tooth Paste Erukku Brush Irukku', artists: 'Shankar Ganesh, S.P. Balasubrahmanyam & S. Janaki' },
        musicbrainz: { title: 'Tooth Paste', artists: 'Bloodnut' },
        ai: { title: 'Tooth Paste Erukku Brush Irukku', artists: 'S.P. Balasubrahmanyam & S. Janaki' },
        selectedSource: 'apple',
      },
      {
        trackNumber: 10,
        localTitle: 'Oru Maina',
        localFile: '10 - Oru Maina.wav',
        offsetSourceTrack: 5,
        durationSecs: 282,
        local: { title: 'Oru Maina', artists: 'Unknown' },
        apple: { title: 'Oru Maina Maina', artists: 'Shankar Ganesh, Malaysia Vasudevan & S. Janaki' },
        musicbrainz: { title: 'Oru Maina', artists: 'Bloodnut' },
        ai: { title: 'Oru Maina Maina', artists: 'Malaysia Vasudevan & S. Janaki' },
        selectedSource: 'apple',
      },
    ]
  },
  {
    id: 'alb-thalapathi',
    folderName: 'Thalapathi CD RIP',
    currentTitle: 'Thalapathi CD RIP',
    tier: 'tier1',
    status: 'staged',
    confidenceScore: 0.98,
    albumTitle: {
      fieldKey: 'title',
      label: 'Album Title',
      local: { value: 'Thalapathi CD RIP', sourceLabel: 'Local File' },
      apple: { value: 'Thalapathi (Original Motion Picture Soundtrack)', sourceLabel: 'Apple Music', confidence: 0.98 },
      musicbrainz: { value: 'Thalapathi', sourceLabel: 'MusicBrainz', confidence: 0.95 },
      ai: { value: 'Thalapathi (Original Motion Picture Soundtrack)', sourceLabel: 'Gemini AI', confidence: 0.99 },
      selectedSource: 'apple',
    },
    albumArtist: {
      fieldKey: 'artist',
      label: 'Album Artist',
      local: { value: 'Ilaiyaraaja', sourceLabel: 'Local File' },
      apple: { value: 'Ilaiyaraaja', sourceLabel: 'Apple Music', confidence: 0.99 },
      musicbrainz: { value: 'Ilaiyaraaja', sourceLabel: 'MusicBrainz', confidence: 0.98 },
      ai: { value: 'Ilaiyaraaja', sourceLabel: 'Gemini AI', confidence: 0.99 },
      selectedSource: 'apple',
    },
    composer: {
      fieldKey: 'composer',
      label: 'Composer',
      local: { value: 'Ilaiyaraaja', sourceLabel: 'Local File' },
      apple: { value: 'Ilaiyaraaja', sourceLabel: 'Apple Music', confidence: 0.99 },
      musicbrainz: { value: 'Ilaiyaraaja', sourceLabel: 'MusicBrainz', confidence: 0.98 },
      ai: { value: 'Ilaiyaraaja', sourceLabel: 'Gemini AI', confidence: 0.99 },
      selectedSource: 'apple',
    },
    year: {
      fieldKey: 'year',
      label: 'Release Year',
      local: { value: 1991, sourceLabel: 'Local File' },
      apple: { value: 1991, sourceLabel: 'Apple Music', confidence: 0.99 },
      musicbrainz: { value: 1991, sourceLabel: 'MusicBrainz', confidence: 0.98 },
      ai: { value: 1991, sourceLabel: 'Gemini AI', confidence: 0.99 },
      selectedSource: 'apple',
    },
    coverArt: {
      fieldKey: 'coverArt',
      label: 'Cover Art',
      local: { value: '', sourceLabel: 'Local (None)' },
      apple: { value: 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/bb/94/bc/bb94bc97-e818-f2e3-2ee8-dc1a8f90ff8a/8901858022889.jpg/600x600bb.jpg', sourceLabel: 'Apple Music HD', confidence: 0.98 },
      musicbrainz: { value: 'https://coverartarchive.org/release/thalapathi/front-500', sourceLabel: 'MusicBrainz CAA', confidence: 0.90 },
      ai: { value: 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/bb/94/bc/bb94bc97-e818-f2e3-2ee8-dc1a8f90ff8a/8901858022889.jpg/600x600bb.jpg', sourceLabel: 'Gemini AI', confidence: 0.98 },
      selectedSource: 'apple',
    },
    genre: {
      fieldKey: 'genre',
      label: 'Genre',
      local: { value: 'Soundtrack', sourceLabel: 'Local File' },
      apple: { value: 'Tamil Cinema', sourceLabel: 'Apple Music', confidence: 0.95 },
      musicbrainz: { value: 'Soundtrack', sourceLabel: 'MusicBrainz', confidence: 0.90 },
      ai: { value: 'Soundtrack', sourceLabel: 'Gemini AI', confidence: 0.98 },
      selectedSource: 'apple',
    },
    tracks: [
      {
        trackNumber: 1,
        localTitle: 'Rakkamma',
        localFile: '01 - Rakkamma.wav',
        durationSecs: 432,
        local: { title: 'Rakkamma', artists: 'SPB' },
        apple: { title: 'Rakkamma Kaiya Thattu', artists: 'S. P. Balasubrahmanyam & Swarnalatha' },
        musicbrainz: { title: 'Rakkamma Kaiya Thattu', artists: 'S. P. Balasubrahmanyam, Swarnalatha' },
        ai: { title: 'Rakkamma Kaiya Thattu', artists: 'S. P. Balasubrahmanyam & Swarnalatha' },
        selectedSource: 'apple',
      }
    ]
  }
]

export const UnifiedCurateCockpitMockup: React.FC = () => {
  const [activeTier, setActiveTier] = useState<CurateTier>('tier2')
  const [albums, setAlbums] = useState<MockAlbumItem[]>(INITIAL_ALBUMS)
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>('alb-ranga')
  const [isPlaybackActive, setIsPlaybackActive] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false)
  const [isHealthDrawerOpen, setIsHealthDrawerOpen] = useState(false)

  // Inline editing state: { fieldKey: string, currentValue: string }
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null)
  const [editInputValue, setEditInputValue] = useState('')

  // Track editing state: { trackNumber: number, field: 'title' | 'artists', value: string }
  const [editingTrack, setEditingTrack] = useState<{ trackNum: number; field: 'title' | 'artists' } | null>(null)
  const [trackEditValue, setTrackEditValue] = useState('')

  const selectedAlbum = albums.find(a => a.id === selectedAlbumId) || albums[0]
  const tier1Count = albums.filter(a => a.tier === 'tier1' && a.status === 'staged').length
  const tier2Count = albums.filter(a => a.tier === 'tier2' && a.status === 'staged').length

  const showToast = (msg: string) => {
    setToastMessage(msg)
    setTimeout(() => setToastMessage(null), 3500)
  }

  // Select source for album field
  const handleSelectFieldSource = (fieldKey: keyof MockAlbumItem, source: 'local' | 'apple' | 'musicbrainz' | 'ai') => {
    setAlbums(prev =>
      prev.map(alb => {
        if (alb.id !== selectedAlbum.id) return alb
        const currentField = alb[fieldKey] as MetadataFieldState<any>
        return {
          ...alb,
          [fieldKey]: {
            ...currentField,
            selectedSource: source,
            manualValue: undefined,
          }
        }
      })
    )
    showToast(`Adopted ${source.toUpperCase()} for ${fieldKey}`)
  }

  // Save manual edit for album field
  const handleSaveManualField = (fieldKey: keyof MockAlbumItem) => {
    setAlbums(prev =>
      prev.map(alb => {
        if (alb.id !== selectedAlbum.id) return alb
        const currentField = alb[fieldKey] as MetadataFieldState<any>
        return {
          ...alb,
          [fieldKey]: {
            ...currentField,
            selectedSource: 'manual',
            manualValue: fieldKey === 'year' ? Number(editInputValue) : editInputValue,
          }
        }
      })
    )
    setEditingFieldKey(null)
    showToast(`Saved manual override for ${fieldKey}`)
  }

  // Select source for a track
  const handleSelectTrackSource = (trackNum: number, source: 'local' | 'apple' | 'musicbrainz' | 'ai') => {
    setAlbums(prev =>
      prev.map(alb => {
        if (alb.id !== selectedAlbum.id) return alb
        return {
          ...alb,
          tracks: alb.tracks.map(t =>
            t.trackNumber === trackNum
              ? { ...t, selectedSource: source, manualTitle: undefined, manualArtists: undefined }
              : t
          )
        }
      })
    )
  }

  // Save manual track edit
  const handleSaveManualTrack = (trackNum: number, field: 'title' | 'artists') => {
    setAlbums(prev =>
      prev.map(alb => {
        if (alb.id !== selectedAlbum.id) return alb
        return {
          ...alb,
          tracks: alb.tracks.map(t => {
            if (t.trackNumber !== trackNum) return t
            return {
              ...t,
              selectedSource: 'manual',
              ...(field === 'title' ? { manualTitle: trackEditValue } : { manualArtists: trackEditValue }),
            }
          })
        }
      })
    )
    setEditingTrack(null)
    showToast(`Saved custom track ${field}`)
  }

  // Bulk adopt provider for all tracks
  const handleAdoptAllTracks = (source: 'apple' | 'musicbrainz' | 'ai') => {
    setAlbums(prev =>
      prev.map(alb => {
        if (alb.id !== selectedAlbum.id) return alb
        return {
          ...alb,
          tracks: alb.tracks.map(t => ({
            ...t,
            selectedSource: source,
            manualTitle: undefined,
            manualArtists: undefined,
          }))
        }
      })
    )
    showToast(`Applied ${source.toUpperCase()} tracklist to all tracks!`)
  }

  // Helper to resolve currently selected value for a field
  const getSelectedValue = (field: MetadataFieldState<any>): any => {
    if (field.selectedSource === 'manual') return field.manualValue
    return field[field.selectedSource]?.value ?? '—'
  }

  const getSelectedTrack = (t: TrackCandidateState) => {
    if (t.selectedSource === 'manual') {
      return {
        title: t.manualTitle || t.apple.title,
        artists: t.manualArtists || t.apple.artists,
      }
    }
    return t[t.selectedSource]
  }

  return (
    <div className="w-full h-screen bg-[#0E0F12] text-[#F3F4F6] flex flex-col font-sans select-none overflow-hidden">
      {/* 1. Top Navigation Bar */}
      <header className="h-14 border-b border-white/[0.08] px-6 flex items-center justify-between shrink-0 bg-[#121318]/90 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center text-[#D4AF37]">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-white">Curate & Metadata Cockpit</h1>
            <p className="text-[10px] text-white/50">2-Tier Autonomous & Guided Pipeline • Cadence Audiophile Engine</p>
          </div>
        </div>

        {/* Center: 2-Tier Segmented Control */}
        <div className="flex items-center p-1 bg-black/40 rounded-xl border border-white/[0.08]">
          <button
            onClick={() => setActiveTier('tier1')}
            className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-2 cursor-pointer ${
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
            className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-2 cursor-pointer ${
              activeTier === 'tier2'
                ? 'bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/40 shadow-sm'
                : 'text-white/60 hover:text-white'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Tier 2: Guided Reconciliation</span>
            <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-[#D4AF37]/30 text-[#D4AF37]">
              {tier2Count}
            </span>
          </button>
        </div>

        {/* Right Utility Actions */}
        <div className="flex items-center gap-2">
          {/* Transport Guard Simulator */}
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
            <span>Learned Rules (3)</span>
          </button>
        </div>
      </header>

      {/* 2. Main Workbench */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Album Queue Sidebar */}
        <aside className="w-72 border-r border-white/[0.08] bg-[#0A0B0E] flex flex-col shrink-0">
          <div className="p-3 border-b border-white/[0.06] flex items-center justify-between">
            <span className="text-xs font-medium text-white/70">
              {activeTier === 'tier1' ? 'Ready to Commit' : 'Pending Review'}
            </span>
            {activeTier === 'tier1' && tier1Count > 0 && (
              <button
                onClick={() => showToast(`Committed ${tier1Count} albums to library!`)}
                className="px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-[11px] cursor-pointer"
              >
                Commit All ({tier1Count})
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
                    src={getSelectedValue(alb.coverArt) || alb.coverArt.apple.value}
                    alt={alb.currentTitle}
                    className="w-12 h-12 rounded-lg object-cover border border-white/10 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <h3 className="text-xs font-medium text-white truncate">{getSelectedValue(alb.albumTitle)}</h3>
                    <p className="text-[11px] text-white/50 truncate mt-0.5">{getSelectedValue(alb.albumArtist)} • {getSelectedValue(alb.year)}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/[0.06] text-white/60">
                        {alb.tracks.length} tracks
                      </span>
                      {alb.offsetApplied !== undefined && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#D4AF37]/20 text-[#D4AF37] font-mono">
                          +{alb.offsetApplied} offset
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </aside>

        {/* Center Workbench (Unified 4-Way Table Engine) */}
        <main className="flex-1 flex flex-col bg-[#0E0F12] overflow-y-auto p-6 space-y-6">
          {/* Header Action Bar for Selected Album */}
          <div className="flex items-center justify-between pb-4 border-b border-white/[0.08]">
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-white/[0.06] text-white/60 uppercase">
                {selectedAlbum.folderName}
              </span>
              <span className="text-xs text-white/40">•</span>
              <span className="text-xs text-[#D4AF37] font-medium flex items-center gap-1.5">
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>Tier 2 Guided Reconciliation Table</span>
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => showToast(`✓ Successfully committed "${getSelectedValue(selectedAlbum.albumTitle)}"!`)}
                className="px-4 py-1.5 rounded-lg bg-[#D4AF37] hover:bg-[#c29e2f] text-black font-semibold text-xs transition-colors cursor-pointer shadow-sm flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Commit Staged Album</span>
              </button>
            </div>
          </div>

          {/* TABLE 1: Album-Level 4-Way Metadata Reconciliation Table */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-white/70">
                1. Album-Level Master Metadata
              </h2>
              <span className="text-[11px] text-white/40">
                Click any provider cell to adopt as Selected • Click <Edit2 className="w-3 h-3 inline text-white/60" /> to provide manual override
              </span>
            </div>

            <div className="rounded-xl border border-white/[0.08] overflow-hidden bg-[#121318]/40 shadow-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-white/[0.08] bg-white/[0.02] text-white/40 text-[11px] font-mono">
                    <th className="py-2.5 px-4 w-32">Field</th>
                    <th className="py-2.5 px-4 w-1/5">Local File Tag</th>
                    <th className="py-2.5 px-4 w-1/5 text-[#D4AF37]">Apple Music Master</th>
                    <th className="py-2.5 px-4 w-1/5">MusicBrainz Archive</th>
                    <th className="py-2.5 px-4 w-1/5 text-cyan-400">Gemini AI Master</th>
                    <th className="py-2.5 px-4 w-1/4 text-emerald-400 font-semibold bg-emerald-500/[0.03]">Selected Output</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {/* Row: Album Title */}
                  {renderAlbumFieldRow('albumTitle', selectedAlbum.albumTitle)}
                  {/* Row: Album Artist */}
                  {renderAlbumFieldRow('albumArtist', selectedAlbum.albumArtist)}
                  {/* Row: Composer */}
                  {renderAlbumFieldRow('composer', selectedAlbum.composer)}
                  {/* Row: Release Year */}
                  {renderAlbumFieldRow('year', selectedAlbum.year)}
                  {/* Row: Cover Art */}
                  {renderCoverArtRow(selectedAlbum.coverArt)}
                  {/* Row: Genre */}
                  {renderAlbumFieldRow('genre', selectedAlbum.genre)}
                </tbody>
              </table>
            </div>
          </section>

          {/* TABLE 2: Track-Level 4-Way Metadata Reconciliation Table */}
          <section className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-white/70">
                  2. Track-Level Metadata & Performers
                </h2>
                {selectedAlbum.offsetApplied !== undefined && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-[#D4AF37]/20 text-[#D4AF37] font-mono border border-[#D4AF37]/30">
                    Offset Bridge: Local #{selectedAlbum.tracks[0]?.trackNumber}–#{selectedAlbum.tracks[selectedAlbum.tracks.length - 1]?.trackNumber} ➔ Store #{selectedAlbum.tracks[0]?.offsetSourceTrack}–#{selectedAlbum.tracks[selectedAlbum.tracks.length - 1]?.offsetSourceTrack}
                  </span>
                )}
              </div>

              {/* Bulk Track Adoption Quick-Actions */}
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="text-white/40 mr-1">Adopt Tracklist:</span>
                <button
                  onClick={() => handleAdoptAllTracks('apple')}
                  className="px-2 py-1 rounded bg-[#D4AF37]/10 hover:bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/30 cursor-pointer"
                >
                  All Apple Music
                </button>
                <button
                  onClick={() => handleAdoptAllTracks('ai')}
                  className="px-2 py-1 rounded bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 cursor-pointer"
                >
                  All Gemini AI
                </button>
                <button
                  onClick={() => handleAdoptAllTracks('local')}
                  className="px-2 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] text-white/60 border border-white/10 cursor-pointer"
                >
                  Reset Local
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-white/[0.08] overflow-hidden bg-[#121318]/40 shadow-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-white/[0.08] bg-white/[0.02] text-white/40 text-[11px] font-mono">
                    <th className="py-2.5 px-3 w-14">#</th>
                    <th className="py-2.5 px-3 w-1/5">Local File</th>
                    <th className="py-2.5 px-3 w-1/5 text-[#D4AF37]">Apple Music Track</th>
                    <th className="py-2.5 px-3 w-1/5">MusicBrainz Track</th>
                    <th className="py-2.5 px-3 w-1/5 text-cyan-400">Gemini AI Track</th>
                    <th className="py-2.5 px-3 w-1/4 text-emerald-400 font-semibold bg-emerald-500/[0.03]">Selected Track & Singers</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {selectedAlbum.tracks.map((trk) => {
                    const sel = getSelectedTrack(trk)
                    return (
                      <tr key={trk.trackNumber} className="hover:bg-white/[0.015] transition-colors">
                        <td className="py-3 px-3 font-mono text-white/50 text-[11px]">
                          #{trk.trackNumber}
                          {trk.offsetSourceTrack && (
                            <span className="block text-[9px] text-[#D4AF37]">➔ #{trk.offsetSourceTrack}</span>
                          )}
                        </td>

                        {/* Local */}
                        <td
                          onClick={() => handleSelectTrackSource(trk.trackNumber, 'local')}
                          className={`py-3 px-3 cursor-pointer transition-colors ${
                            trk.selectedSource === 'local' ? 'bg-white/[0.04] font-medium text-white' : 'text-white/60 hover:text-white'
                          }`}
                        >
                          <div className="font-medium text-white/80">{trk.local.title}</div>
                          <div className="text-[10px] text-white/40 font-mono">{trk.localFile}</div>
                        </td>

                        {/* Apple Music */}
                        <td
                          onClick={() => handleSelectTrackSource(trk.trackNumber, 'apple')}
                          className={`py-3 px-3 cursor-pointer transition-colors ${
                            trk.selectedSource === 'apple' ? 'bg-[#D4AF37]/10 text-white font-medium' : 'text-white/70 hover:text-[#D4AF37]'
                          }`}
                        >
                          <div className="font-medium">{trk.apple.title}</div>
                          <div className="text-[10px] text-white/50 mt-0.5">{trk.apple.artists}</div>
                        </td>

                        {/* MusicBrainz */}
                        <td
                          onClick={() => handleSelectTrackSource(trk.trackNumber, 'musicbrainz')}
                          className={`py-3 px-3 cursor-pointer transition-colors ${
                            trk.selectedSource === 'musicbrainz' ? 'bg-white/[0.04] text-white font-medium' : 'text-white/60 hover:text-white'
                          }`}
                        >
                          <div className="font-medium">{trk.musicbrainz.title}</div>
                          <div className="text-[10px] text-white/40 mt-0.5">{trk.musicbrainz.artists}</div>
                        </td>

                        {/* Gemini AI */}
                        <td
                          onClick={() => handleSelectTrackSource(trk.trackNumber, 'ai')}
                          className={`py-3 px-3 cursor-pointer transition-colors ${
                            trk.selectedSource === 'ai' ? 'bg-cyan-500/10 text-cyan-200 font-medium' : 'text-white/70 hover:text-cyan-300'
                          }`}
                        >
                          <div className="font-medium text-cyan-300">{trk.ai.title}</div>
                          <div className="text-[10px] text-cyan-200/60 mt-0.5">{trk.ai.artists}</div>
                        </td>

                        {/* Selected Track Output */}
                        <td className="py-3 px-3 bg-emerald-500/[0.03] border-l border-white/[0.06]">
                          {editingTrack?.trackNum === trk.trackNumber ? (
                            <div className="flex flex-col gap-1.5">
                              <input
                                type="text"
                                value={trackEditValue}
                                onChange={(e) => setTrackEditValue(e.target.value)}
                                className="w-full bg-black/60 border border-emerald-400 rounded px-2 py-1 text-xs text-white focus:outline-none"
                                placeholder={`Edit ${editingTrack.field}`}
                                autoFocus
                              />
                              <div className="flex justify-end gap-1">
                                <button
                                  onClick={() => handleSaveManualTrack(trk.trackNumber, editingTrack.field)}
                                  className="px-2 py-0.5 rounded bg-emerald-500 text-black font-semibold text-[10px]"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingTrack(null)}
                                  className="px-2 py-0.5 rounded bg-white/[0.08] text-white/60 text-[10px]"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="group relative">
                              <div className="flex items-center justify-between gap-2">
                                <div className="font-medium text-emerald-300">{sel.title}</div>
                                <button
                                  onClick={() => {
                                    setEditingTrack({ trackNum: trk.trackNumber, field: 'title' })
                                    setTrackEditValue(sel.title)
                                  }}
                                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/[0.08] rounded text-white/60 transition-opacity cursor-pointer"
                                  title="Edit Title"
                                >
                                  <Edit2 className="w-3 h-3" />
                                </button>
                              </div>
                              <div className="flex items-center justify-between gap-2 mt-0.5">
                                <div className="text-[11px] text-white/80">{sel.artists}</div>
                                <button
                                  onClick={() => {
                                    setEditingTrack({ trackNum: trk.trackNumber, field: 'artists' })
                                    setTrackEditValue(sel.artists)
                                  }}
                                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/[0.08] rounded text-white/60 transition-opacity cursor-pointer"
                                  title="Edit Singers"
                                >
                                  <Edit2 className="w-3 h-3" />
                                </button>
                              </div>
                              <div className="mt-1 flex items-center gap-1.5">
                                <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-white/[0.06] text-white/50 uppercase">
                                  Source: {trk.selectedSource}
                                </span>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>

      {/* Helper to Render Album Row */}
      {function renderAlbumFieldRow(key: keyof MockAlbumItem, field: MetadataFieldState<any>) {
        const selectedVal = getSelectedValue(field)
        const isEditing = editingFieldKey === key

        return (
          <tr key={key} className="hover:bg-white/[0.015] transition-colors">
            {/* Field Label */}
            <td className="py-2.5 px-4 font-medium text-white/70">{field.label}</td>

            {/* Local */}
            <td
              onClick={() => handleSelectFieldSource(key, 'local')}
              className={`py-2.5 px-4 cursor-pointer transition-colors ${
                field.selectedSource === 'local' ? 'bg-white/[0.04] text-white font-medium' : 'text-white/60 hover:text-white'
              }`}
            >
              {String(field.local.value || '—')}
            </td>

            {/* Apple */}
            <td
              onClick={() => handleSelectFieldSource(key, 'apple')}
              className={`py-2.5 px-4 cursor-pointer transition-colors ${
                field.selectedSource === 'apple' ? 'bg-[#D4AF37]/10 text-white font-medium' : 'text-white/70 hover:text-[#D4AF37]'
              }`}
            >
              {String(field.apple.value || '—')}
            </td>

            {/* MusicBrainz */}
            <td
              onClick={() => handleSelectFieldSource(key, 'musicbrainz')}
              className={`py-2.5 px-4 cursor-pointer transition-colors ${
                field.selectedSource === 'musicbrainz' ? 'bg-white/[0.04] text-white font-medium' : 'text-white/60 hover:text-white'
              }`}
            >
              {String(field.musicbrainz.value || '—')}
            </td>

            {/* Gemini AI */}
            <td
              onClick={() => handleSelectFieldSource(key, 'ai')}
              className={`py-2.5 px-4 cursor-pointer transition-colors ${
                field.selectedSource === 'ai' ? 'bg-cyan-500/10 text-cyan-200 font-medium' : 'text-white/70 hover:text-cyan-300'
              }`}
            >
              {String(field.ai.value || '—')}
            </td>

            {/* Selected Staged Output */}
            <td className="py-2.5 px-4 bg-emerald-500/[0.03] border-l border-white/[0.06]">
              {isEditing ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={editInputValue}
                    onChange={(e) => setEditInputValue(e.target.value)}
                    className="flex-1 bg-black/60 border border-emerald-400 rounded px-2 py-1 text-xs text-white focus:outline-none"
                    autoFocus
                  />
                  <button
                    onClick={() => handleSaveManualField(key)}
                    className="p-1 rounded bg-emerald-500 text-black cursor-pointer"
                    title="Save"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setEditingFieldKey(null)}
                    className="p-1 rounded bg-white/[0.08] text-white/60 cursor-pointer"
                    title="Cancel"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2 group">
                  <span className="font-semibold text-emerald-300 truncate">{String(selectedVal)}</span>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-white/[0.06] text-white/40 uppercase">
                      {field.selectedSource}
                    </span>
                    <button
                      onClick={() => {
                        setEditingFieldKey(key)
                        setEditInputValue(String(selectedVal))
                      }}
                      className="p-1 rounded hover:bg-white/[0.08] text-white/60 hover:text-white transition-colors cursor-pointer"
                      title="Edit manually"
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )}
            </td>
          </tr>
        )
      }}

      {/* Helper to Render Cover Art Row */}
      {function renderCoverArtRow(field: MetadataFieldState<string>) {
        const isEditing = editingFieldKey === 'coverArt'

        return (
          <tr className="hover:bg-white/[0.015] transition-colors">
            <td className="py-3 px-4 font-medium text-white/70">Cover Artwork</td>

            {/* Local */}
            <td onClick={() => handleSelectFieldSource('coverArt', 'local')} className="py-3 px-4 cursor-pointer">
              <div className="w-10 h-10 rounded border border-white/10 bg-black/40 flex items-center justify-center text-white/30 text-[10px]">
                None
              </div>
            </td>

            {/* Apple */}
            <td onClick={() => handleSelectFieldSource('coverArt', 'apple')} className="py-3 px-4 cursor-pointer">
              <div className={`p-0.5 rounded-lg w-fit transition-all ${field.selectedSource === 'apple' ? 'ring-2 ring-[#D4AF37]' : ''}`}>
                <img src={field.apple.value} alt="Apple Art" className="w-12 h-12 rounded object-cover shadow" />
                <span className="text-[9px] text-[#D4AF37] block mt-1">3000px HD</span>
              </div>
            </td>

            {/* MusicBrainz */}
            <td onClick={() => handleSelectFieldSource('coverArt', 'musicbrainz')} className="py-3 px-4 cursor-pointer">
              <div className={`p-0.5 rounded-lg w-fit transition-all ${field.selectedSource === 'musicbrainz' ? 'ring-2 ring-white/60' : ''}`}>
                <img src={field.musicbrainz.value} alt="MB Art" className="w-12 h-12 rounded object-cover shadow opacity-70" />
                <span className="text-[9px] text-white/50 block mt-1">CAA 500px</span>
              </div>
            </td>

            {/* Gemini AI */}
            <td onClick={() => handleSelectFieldSource('coverArt', 'ai')} className="py-3 px-4 cursor-pointer">
              <div className={`p-0.5 rounded-lg w-fit transition-all ${field.selectedSource === 'ai' ? 'ring-2 ring-cyan-400' : ''}`}>
                <img src={field.ai.value} alt="AI Art" className="w-12 h-12 rounded object-cover shadow" />
                <span className="text-[9px] text-cyan-300 block mt-1">AI Verified</span>
              </div>
            </td>

            {/* Selected Artwork Output */}
            <td className="py-3 px-4 bg-emerald-500/[0.03] border-l border-white/[0.06]">
              {isEditing ? (
                <div className="flex flex-col gap-2">
                  <input
                    type="text"
                    value={editInputValue}
                    onChange={(e) => setEditInputValue(e.target.value)}
                    placeholder="Paste Image URL (https://...)"
                    className="bg-black/60 border border-emerald-400 rounded px-2.5 py-1 text-xs text-white focus:outline-none"
                    autoFocus
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleSaveManualField('coverArt')}
                      className="px-2.5 py-0.5 rounded bg-emerald-500 text-black font-semibold text-[11px]"
                    >
                      Save URL
                    </button>
                    <button
                      onClick={() => setEditingFieldKey(null)}
                      className="px-2.5 py-0.5 rounded bg-white/[0.08] text-white/60 text-[11px]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 group">
                  <img
                    src={getSelectedValue(field) || field.apple.value}
                    alt="Selected Art"
                    className="w-14 h-14 rounded-lg object-cover border-2 border-emerald-500/60 shadow-lg"
                  />
                  <div>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.08] text-emerald-300 uppercase">
                      Source: {field.selectedSource}
                    </span>
                    <button
                      onClick={() => {
                        setEditingFieldKey('coverArt')
                        setEditInputValue(getSelectedValue(field))
                      }}
                      className="mt-1.5 flex items-center gap-1 text-[11px] text-white/50 hover:text-white cursor-pointer"
                    >
                      <Edit2 className="w-3 h-3" />
                      <span>Custom URL</span>
                    </button>
                  </div>
                </div>
              )}
            </td>
          </tr>
        )
      }}

      {/* Slide-over Learned Rules Modal */}
      {isRulesModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="w-full max-w-xl bg-[#121318] border border-white/[0.1] rounded-2xl p-6 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-white/[0.08]">
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-[#D4AF37]" />
                <h3 className="text-sm font-semibold text-white">Learned Library Conventions</h3>
              </div>
              <button onClick={() => setIsRulesModalOpen(false)} className="text-white/40 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-white/60 mt-2">
              Cadence remembers manual spelling corrections and delimiter preferences across all providers.
            </p>
            <div className="mt-4 divide-y divide-white/[0.06] max-h-60 overflow-y-auto">
              <div className="py-2.5 flex items-center justify-between">
                <div>
                  <span className="text-xs line-through text-white/40">A.R. Rahman</span>
                  <span className="mx-2 text-[#D4AF37]">➔</span>
                  <span className="text-xs font-semibold text-emerald-300">A. R. Rahman</span>
                </div>
                <span className="text-[10px] text-white/40">48 occurrences</span>
              </div>
              <div className="py-2.5 flex items-center justify-between">
                <div>
                  <span className="text-xs line-through text-white/40">Illayaraja</span>
                  <span className="mx-2 text-[#D4AF37]">➔</span>
                  <span className="text-xs font-semibold text-emerald-300">Ilaiyaraaja</span>
                </div>
                <span className="text-[10px] text-white/40">84 occurrences</span>
              </div>
            </div>
            <div className="pt-4 border-t border-white/[0.08] flex justify-end">
              <button
                onClick={() => setIsRulesModalOpen(false)}
                className="px-4 py-1.5 rounded-lg bg-white/[0.08] text-xs font-medium text-white cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Catalog Health Drawer */}
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
                onClick={() => setIsHealthDrawerOpen(false)}
                className="w-full py-2.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-xs font-medium text-white cursor-pointer"
              >
                Close
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
