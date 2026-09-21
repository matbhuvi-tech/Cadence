import React, { useState, useMemo } from 'react'
import {
  GitCompare,
  Sparkles,
  Zap,
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Folder,
  Disc3,
  FileCode,
  ArrowRight,
  ShieldCheck,
  Check,
  RotateCcw,
  SlidersHorizontal,
  Music2,
  PenLine,
  ChevronDown,
  ChevronUp,
  Table,
  LayoutGrid,
  User,
  Search,
  Building2,
  Hash,
  Calendar,
} from 'lucide-react'
import { Track, Release, DiffSource } from '../../core/types'
import {
  federatedResolversService,
  BatchItem,
  BatchDiffTrackResult,
  ProviderResult,
} from '../../services/federatedResolvers'
import { ArtworkHoverPreview } from '../common/ArtworkHoverPreview'
import { generatePanoramicBackdrop } from '../../services/panoramicBackdropGenerator'
import { PanoramicAtmosphericBackdrop } from '../common/PanoramicAtmosphericBackdrop'
import { graphEngine } from '../../core/graphEngine'

export interface BatchDiffTracksModalProps {
  isOpen: boolean
  onClose: () => void
  selectedTrackIds: Set<string>
  allTracks: Track[]
  releases: Release[]
  onToggleTrackSelection: (trackId: string, isMulti: boolean) => void
  onSelectTracks: (trackIds: Set<string>) => void
  onApplyBatchEdits: (editsMap: Record<string, Partial<Track>>) => void
  currentRelease?: Release
  onOpenCommitModal?: () => void
}

export const BatchDiffTracksModal: React.FC<BatchDiffTracksModalProps> = ({
  isOpen,
  onClose,
  selectedTrackIds,
  allTracks,
  releases,
  onToggleTrackSelection,
  onSelectTracks,
  onApplyBatchEdits,
  currentRelease,
  onOpenCommitModal,
}) => {
  const [isResolving, setIsResolving] = useState(false)
  const [progressMsg, setProgressMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [providerWarning, setProviderWarning] = useState<string | null>(null)
  const [resultsMap, setResultsMap] = useState<Map<string, BatchDiffTrackResult>>(new Map())
  const [isStaged, setIsStaged] = useState(false)
  const [activeTab, setActiveTab] = useState<'queue' | 'results'>('queue')
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table')
  const [searchQuery, setSearchQuery] = useState('')

  // Provider inclusion toggles
  const [includeItunes, setIncludeItunes] = useState(true)
  const [includeMusicBrainz, setIncludeMusicBrainz] = useState(true)
  const [includeAi, setIncludeAi] = useState(true)

  // Track ID for which manual entry row is currently expanded
  const [manualExpandedTrackId, setManualExpandedTrackId] = useState<string | null>(null)

  // List of tracks selected in Virtual Grid
  const selectedTracks = useMemo(() => {
    return allTracks.filter((t) => selectedTrackIds.has(t.id))
  }, [allTracks, selectedTrackIds])

  // Up to 25 tracks for this Batch Diff call
  const queuedTracks = useMemo(() => {
    return selectedTracks.slice(0, 25)
  }, [selectedTracks])

  // Panoramic Backdrop Rework as part of enrichment
  const [reworkBackdrops, setReworkBackdrops] = useState(true)
  const [reworkedBackdrops, setReworkedBackdrops] = useState<Record<string, string>>({})
  const [isReworkingBackdrop, setIsReworkingBackdrop] = useState(false)

  const handleReworkBackdropForRelease = async (releaseToRework?: Release) => {
    const rel = releaseToRework || currentRelease || (releases.length > 0 ? releases[0] : undefined)
    const artSrc = rel?.artwork?.frontCoverUrl || rel?.coverArtUrl
    if (!artSrc || !rel) return

    setIsReworkingBackdrop(true)
    try {
      const generated = await generatePanoramicBackdrop(artSrc, 2400, 320)
      if (generated) {
        setReworkedBackdrops((prev) => ({ ...prev, [rel.id]: generated }))
        graphEngine.updateReleaseDetails(rel.id, { backdropUrl: generated })
      }
    } catch (e) {
      console.error('Failed to generate panoramic backdrop:', e)
    } finally {
      setIsReworkingBackdrop(false)
    }
  }

  // Find tracks belonging to current release if available
  const currentAlbumTracks = useMemo(() => {
    if (!currentRelease) return []
    return allTracks.filter((t) => t.releaseId === currentRelease.id)
  }, [allTracks, currentRelease])

  // Filtered tracks for results view
  const displayTracks = useMemo(() => {
    if (!searchQuery.trim()) return queuedTracks
    const q = searchQuery.toLowerCase()
    return queuedTracks.filter((trk) => {
      const res = resultsMap.get(trk.id)
      const cand =
        res?.selectedSource === 'ai'
          ? res?.candidates.ai
          : res?.selectedSource === 'itunes'
          ? res?.candidates.itunes
          : res?.selectedSource === 'musicbrainz'
          ? res?.candidates.musicbrainz
          : null
      const proposedTitle = cand?.trackTitle || trk.title
      const proposedArtist = cand?.artistCredit || trk.artistCredit
      return (
        trk.title.toLowerCase().includes(q) ||
        trk.artistCredit.toLowerCase().includes(q) ||
        (trk.filePath && trk.filePath.toLowerCase().includes(q)) ||
        proposedTitle.toLowerCase().includes(q) ||
        proposedArtist.toLowerCase().includes(q)
      )
    })
  }, [queuedTracks, searchQuery, resultsMap])

  // Consensus metadata across active selected sources
  const albumSummary = useMemo(() => {
    if (resultsMap.size === 0) return null
    const albums = new Map<string, number>()
    const years = new Map<number, number>()
    const composers = new Map<string, number>()
    const labels = new Map<string, number>()
    const catalogs = new Map<string, number>()

    let totalConfidence = 0
    let countWithConfidence = 0

    resultsMap.forEach((res) => {
      const cand =
        res.selectedSource === 'ai'
          ? res.candidates.ai
          : res.selectedSource === 'itunes'
          ? res.candidates.itunes
          : res.selectedSource === 'musicbrainz'
          ? res.candidates.musicbrainz
          : null

      if (cand) {
        if (cand.releaseTitle) {
          albums.set(cand.releaseTitle, (albums.get(cand.releaseTitle) || 0) + 1)
        }
        if (cand.releaseYear) {
          years.set(cand.releaseYear, (years.get(cand.releaseYear) || 0) + 1)
        }
        if (cand.composer) {
          composers.set(cand.composer, (composers.get(cand.composer) || 0) + 1)
        }
        if (cand.label) {
          labels.set(cand.label, (labels.get(cand.label) || 0) + 1)
        }
        if (cand.catalogNumber) {
          catalogs.set(cand.catalogNumber, (catalogs.get(cand.catalogNumber) || 0) + 1)
        }
        if (cand.confidenceScore) {
          totalConfidence += cand.confidenceScore
          countWithConfidence++
        }
      }
    })

    const topAlbum = [...albums.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const topYear = [...years.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const topComposer = [...composers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const topLabel = [...labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const topCatalog = [...catalogs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const avgConfidence = countWithConfidence > 0 ? Math.round((totalConfidence / countWithConfidence) * 100) : null

    return {
      album: topAlbum || currentRelease?.title || 'Unknown Album',
      year: topYear || currentRelease?.releaseYear,
      composer: topComposer,
      label: topLabel,
      catalogNumber: topCatalog,
      confidence: avgConfidence,
    }
  }, [resultsMap, currentRelease])

  // Quick preset: Select first 25 tracks from library
  const handleSelectFirst25 = () => {
    const first25 = new Set(allTracks.slice(0, 25).map((t) => t.id))
    onSelectTracks(first25)
    setErrorMsg(null)
  }

  // Quick preset: Select all tracks of current album
  const handleSelectCurrentAlbum = () => {
    if (currentAlbumTracks.length === 0) return
    const albumTrackIds = new Set(currentAlbumTracks.slice(0, 25).map((t) => t.id))
    onSelectTracks(albumTrackIds)
    setErrorMsg(null)
  }

  // Quick preset: Clear selection
  const handleClearSelection = () => {
    onSelectTracks(new Set())
    setResultsMap(new Map())
    setIsStaged(false)
    setErrorMsg(null)
    setProviderWarning(null)
  }

  // Execute Batch Diff Resolution
  const handleExecuteResolution = async () => {
    if (queuedTracks.length === 0) return
    if (!includeItunes && !includeMusicBrainz && !includeAi) {
      setErrorMsg('Please select at least one provider (iTunes, MusicBrainz, or Gemini AI).')
      return
    }

    setIsResolving(true)
    setErrorMsg(null)
    setProviderWarning(null)
    setIsStaged(false)
    setProgressMsg(`Starting Batch Diff across selected providers for ${queuedTracks.length} tracks...`)

    try {
      const batchItems: BatchItem[] = queuedTracks.map((trk) => {
        const rel = releases.find((r) => r.id === trk.releaseId)
        return {
          id: trk.id,
          title: trk.title,
          artist: trk.artistCredit,
          album: rel?.title || '',
          year: rel?.releaseYear,
          filePath: trk.filePath,
        }
      })

      const resolved = await federatedResolversService.resolveBatchDiff(
        batchItems,
        { includeItunes, includeMusicBrainz, includeAi },
        (msg) => setProgressMsg(msg)
      )

      setResultsMap(resolved)
      setActiveTab('results')

      const warnings = (resolved as any).warnings
      if (warnings?.ai) {
        setProviderWarning(`Gemini AI Notice: ${warnings.ai}. Candidates from other providers are displayed.`)
      }

      setProgressMsg(`Batch Diff complete: Generated candidates for ${resolved.size} tracks!`)
    } catch (err: any) {
      console.error('Batch Diff resolution failed:', err)
      setErrorMsg(err.message || 'Batch Diff resolution failed. Please try again.')
    } finally {
      setIsResolving(false)
    }
  }

  // Bulk set chosen source for all tracks in results
  const handleBulkSetSource = (source: DiffSource) => {
    setResultsMap((prev) => {
      const next = new Map(prev)
      next.forEach((item, trackId) => {
        next.set(trackId, {
          ...item,
          selectedSource: source,
        })
      })
      return next
    })
    setIsStaged(false)
  }

  // Select source for single track
  const handleSelectTrackSource = (trackId: string, source: DiffSource) => {
    setResultsMap((prev) => {
      const next = new Map(prev)
      const current = next.get(trackId)
      if (current) {
        next.set(trackId, {
          ...current,
          selectedSource: source,
        })
      }
      return next
    })
    setIsStaged(false)
  }

  // Update manual entry fields for single track
  const handleUpdateTrackManual = (
    trackId: string,
    field: 'title' | 'artistCredit' | 'composerName' | 'albumTitle' | 'releaseYear' | 'label' | 'catalogNumber',
    value: any
  ) => {
    setResultsMap((prev) => {
      const next = new Map(prev)
      const current = next.get(trackId)
      if (current) {
        const trk = allTracks.find((t) => t.id === trackId)
        const currentManual = current.manualValues || {
          title: current.candidates.ai?.trackTitle || current.candidates.itunes?.trackTitle || trk?.title || '',
          artistCredit: current.candidates.ai?.artistCredit || current.candidates.itunes?.artistCredit || trk?.artistCredit || '',
          composerName: current.candidates.ai?.composer || trk?.composerName || '',
          albumTitle: current.candidates.ai?.releaseTitle || current.candidates.itunes?.releaseTitle || current.albumTitle || '',
          releaseYear: current.candidates.ai?.releaseYear || current.candidates.itunes?.releaseYear || current.releaseYear,
        }
        next.set(trackId, {
          ...current,
          selectedSource: 'manual',
          manualValues: {
            ...currentManual,
            [field]: value,
          },
        })
      }
      return next
    })
    setIsStaged(false)
  }

  // Copy candidate values to manual inputs
  const handleCopyCandidateToManual = (trackId: string, candidate: ProviderResult | null) => {
    if (!candidate) return
    const trk = allTracks.find((t) => t.id === trackId)
    setResultsMap((prev) => {
      const next = new Map(prev)
      const current = next.get(trackId)
      if (current) {
        next.set(trackId, {
          ...current,
          selectedSource: 'manual',
          manualValues: {
            title: candidate.trackTitle || trk?.title || '',
            artistCredit: candidate.artistCredit || trk?.artistCredit || '',
            composerName: candidate.composer || trk?.composerName || '',
            albumTitle: candidate.releaseTitle || current.albumTitle || '',
            releaseYear: candidate.releaseYear || current.releaseYear,
            label: candidate.label,
            catalogNumber: candidate.catalogNumber,
          },
        })
      }
      return next
    })
    setIsStaged(false)
  }

  // 1-Click Stage All in Sidecars
  const handleStageAllSidecars = () => {
    if (resultsMap.size === 0) return

    const editsMap: Record<string, Partial<Track>> = {}
    resultsMap.forEach((res, trackId) => {
      const trk = allTracks.find((t) => t.id === trackId)
      if (!trk) return

      let chosenTitle = trk.title
      let chosenArtist = trk.artistCredit
      let chosenComposer = trk.composerName
      let chosenAlbum: string | undefined
      let chosenYear: number | undefined
      let chosenGenre: string | undefined
      let chosenLabel: string | undefined
      let chosenCatalog: string | undefined

      if (res.selectedSource === 'manual' && res.manualValues) {
        chosenTitle = res.manualValues.title ?? trk.title
        chosenArtist = res.manualValues.artistCredit ?? trk.artistCredit
        chosenComposer = res.manualValues.composerName ?? trk.composerName
        chosenAlbum = res.manualValues.albumTitle
        chosenYear = res.manualValues.releaseYear
        chosenLabel = res.manualValues.label
        chosenCatalog = res.manualValues.catalogNumber
      } else if (res.selectedSource === 'ai' && res.candidates.ai) {
        chosenTitle = res.candidates.ai.trackTitle || trk.title
        chosenArtist = res.candidates.ai.artistCredit || trk.artistCredit
        chosenComposer = res.candidates.ai.composer || trk.composerName
        chosenAlbum = res.candidates.ai.releaseTitle
        chosenYear = res.candidates.ai.releaseYear
        chosenGenre = res.candidates.ai.genre
        chosenLabel = res.candidates.ai.label
        chosenCatalog = res.candidates.ai.catalogNumber
      } else if (res.selectedSource === 'itunes' && res.candidates.itunes) {
        chosenTitle = res.candidates.itunes.trackTitle || trk.title
        chosenArtist = res.candidates.itunes.artistCredit || trk.artistCredit
        chosenComposer = res.candidates.itunes.composer || trk.composerName
        chosenAlbum = res.candidates.itunes.releaseTitle
        chosenYear = res.candidates.itunes.releaseYear
        chosenGenre = res.candidates.itunes.genre
        chosenLabel = res.candidates.itunes.label
        chosenCatalog = res.candidates.itunes.catalogNumber
      } else if (res.selectedSource === 'musicbrainz' && res.candidates.musicbrainz) {
        chosenTitle = res.candidates.musicbrainz.trackTitle || trk.title
        chosenArtist = res.candidates.musicbrainz.artistCredit || trk.artistCredit
        chosenComposer = res.candidates.musicbrainz.composer || trk.composerName
        chosenAlbum = res.candidates.musicbrainz.releaseTitle
        chosenYear = res.candidates.musicbrainz.releaseYear
        chosenGenre = res.candidates.musicbrainz.genre
        chosenLabel = res.candidates.musicbrainz.label
        chosenCatalog = res.candidates.musicbrainz.catalogNumber
      }

      const changes: Record<string, any> = {}

      if (chosenTitle && chosenTitle !== trk.title) {
        changes.title = chosenTitle
      }
      if (chosenArtist && chosenArtist !== trk.artistCredit) {
        changes.artistCredit = chosenArtist
      }
      if (chosenComposer !== undefined && chosenComposer !== (trk.composerName || '')) {
        changes.composerName = chosenComposer
      }
      if (chosenAlbum && chosenAlbum !== (currentRelease?.title || trk.folderName || '')) {
        changes.album = chosenAlbum
        changes.releaseTitle = chosenAlbum
      }
      if (chosenYear !== undefined && chosenYear !== (currentRelease?.releaseYear || currentRelease?.originalYear)) {
        changes.year = chosenYear
        changes.releaseYear = chosenYear
      }
      if (chosenGenre && chosenGenre !== ((trk as any).genre || '')) {
        changes.genre = chosenGenre
      }
      if (chosenLabel && chosenLabel !== (currentRelease?.label || '')) {
        changes.label = chosenLabel
      }
      if (chosenCatalog && chosenCatalog !== (currentRelease?.catalogNumber || '')) {
        changes.catalogNumber = chosenCatalog
      }

      if (Object.keys(changes).length > 0) {
        changes.sidecarStatus = 'uncommitted_sidecar'
        editsMap[trackId] = changes
      }
    })

    if (reworkBackdrops) {
      const affectedReleaseIds = new Set<string>()
      resultsMap.forEach((_, trackId) => {
        const trk = allTracks.find((t) => t.id === trackId)
        if (trk?.releaseId) affectedReleaseIds.add(trk.releaseId)
      })
      if (currentRelease?.id) affectedReleaseIds.add(currentRelease.id)

      affectedReleaseIds.forEach(async (relId) => {
        const rel = releases.find((r) => r.id === relId)
        const artSrc = rel?.artwork?.frontCoverUrl || rel?.coverArtUrl
        if (artSrc) {
          try {
            const generated = await generatePanoramicBackdrop(artSrc, 2400, 320)
            if (generated) {
              graphEngine.updateReleaseDetails(relId, { backdropUrl: generated })
            }
          } catch (err) {
            console.error('Failed to auto-rework backdrop during batch staging:', err)
          }
        }
      })
    }

    onApplyBatchEdits(editsMap)
    setIsStaged(true)
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#12151E] border border-white/[0.12] rounded-2xl w-full max-w-5xl max-h-[90vh] shadow-2xl overflow-hidden flex flex-col glow-cyan animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="p-4 px-6 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-[#00F5FF]/30 via-[#8B5CF6]/30 to-[#EC4899]/30 border border-[#00F5FF]/40 text-[#00F5FF]">
              <GitCompare className="w-5 h-5 text-[#ADFF2F]" />
            </div>
            <div className="flex flex-col text-left">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                Batch Track & Album Harmonizer
                <span className="text-[10px] font-mono font-normal px-2 py-0.5 rounded-full bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/30">
                  Smart Match Studio
                </span>
              </h3>
              <span className="text-[11px] font-mono text-[#94A3B8]">
                Concurrent multi-provider match & enrichment across Apple Music, MusicBrainz, and Gemini AI for selected tracks
              </span>
            </div>
          </div>
          {!isResolving && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.05] transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Provider Controls & Options Bar */}
        <div className="p-3 px-6 bg-[#161A26] border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
          <div className="flex items-center gap-4">
            <span className="text-[#94A3B8] font-bold">Query Providers:</span>

            {/* iTunes Toggle */}
            <label className="flex items-center gap-1.5 cursor-pointer select-none text-[#00F5FF]">
              <input
                type="checkbox"
                checked={includeItunes}
                onChange={(e) => setIncludeItunes(e.target.checked)}
                disabled={isResolving}
                className="accent-[#00F5FF] w-3.5 h-3.5 rounded"
              />
              <Music2 className="w-3.5 h-3.5" />
              <span>Apple iTunes</span>
            </label>

            {/* MusicBrainz Toggle */}
            <label className="flex items-center gap-1.5 cursor-pointer select-none text-[#ADFF2F]">
              <input
                type="checkbox"
                checked={includeMusicBrainz}
                onChange={(e) => setIncludeMusicBrainz(e.target.checked)}
                disabled={isResolving}
                className="accent-[#ADFF2F] w-3.5 h-3.5 rounded"
              />
              <Disc3 className="w-3.5 h-3.5" />
              <span>MusicBrainz</span>
            </label>

            {/* Gemini AI Toggle */}
            <label className="flex items-center gap-1.5 cursor-pointer select-none text-[#C084FC]">
              <input
                type="checkbox"
                checked={includeAi}
                onChange={(e) => setIncludeAi(e.target.checked)}
                disabled={isResolving}
                className="accent-[#C084FC] w-3.5 h-3.5 rounded"
              />
              <Sparkles className="w-3.5 h-3.5" />
              <span>Gemini AI (Single Batch)</span>
            </label>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`font-semibold px-2.5 py-0.5 rounded-full text-[11px] ${
                queuedTracks.length > 0
                  ? 'bg-[#00F5FF]/15 text-[#00F5FF] border border-[#00F5FF]/30'
                  : 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
              }`}
            >
              {queuedTracks.length} of 25 tracks queued
            </span>
            {selectedTracks.length > 25 && (
              <span className="text-[10px] text-amber-400 font-mono">
                (Batch capped at first 25)
              </span>
            )}
          </div>
        </div>

        {/* Tab & Preset Controls */}
        <div className="p-3 px-6 bg-black/40 border-b border-white/[0.06] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setActiveTab('queue')}
              className={`px-3 py-1 rounded-lg text-xs font-mono transition-all cursor-pointer ${
                activeTab === 'queue'
                  ? 'bg-white/[0.1] text-white font-bold border border-white/[0.15]'
                  : 'text-[#94A3B8] hover:text-white'
              }`}
            >
              Queued Tracks ({queuedTracks.length})
            </button>
            {resultsMap.size > 0 && (
              <button
                onClick={() => setActiveTab('results')}
                className={`px-3 py-1 rounded-lg text-xs font-mono transition-all flex items-center gap-1.5 cursor-pointer ${
                  activeTab === 'results'
                    ? 'bg-[#10B981]/20 text-[#10B981] font-bold border border-[#10B981]/40'
                    : 'text-[#94A3B8] hover:text-white'
                }`}
              >
                <Check className="w-3 h-3 text-[#10B981]" />
                Harmonized Match Results ({resultsMap.size})
              </button>
            )}
          </div>

          {/* Quick Selection Presets */}
          <div className="flex items-center gap-2 text-xs font-mono">
            {currentAlbumTracks.length > 0 && (
              <button
                onClick={handleSelectCurrentAlbum}
                disabled={isResolving}
                className="px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-[#CBD5E1] hover:text-white border border-white/[0.06] transition-all text-[11px] cursor-pointer"
                title={`Select all tracks in ${currentRelease?.title}`}
              >
                Select Album ({currentAlbumTracks.length} tracks)
              </button>
            )}
            <button
              onClick={handleSelectFirst25}
              disabled={isResolving}
              className="px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-[#CBD5E1] hover:text-white border border-white/[0.06] transition-all text-[11px] cursor-pointer"
            >
              Select First 25 from Grid
            </button>
            {selectedTrackIds.size > 0 && (
              <button
                onClick={handleClearSelection}
                disabled={isResolving}
                className="px-2 py-1 rounded-lg text-[#64748B] hover:text-rose-400 transition-all text-[11px] cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Modal Main Content Area */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* TAB 1: QUEUED TRACKS */}
          {activeTab === 'queue' && (
            <div className="flex flex-col gap-3">
              {queuedTracks.length === 0 ? (
                <div className="p-8 rounded-2xl border border-dashed border-white/[0.12] bg-white/[0.01] flex flex-col items-center justify-center text-center">
                  <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-[#64748B] mb-3">
                    <SlidersHorizontal className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-bold text-white mb-1">
                    No Tracks Selected for Batch Harmonization
                  </h4>
                  <p className="text-xs text-[#94A3B8] max-w-md mb-4 font-mono">
                    Select up to 25 tracks in the Virtual Grid using the checkboxes, or click one of the quick selection presets below to run Smart Batch Match across Apple Music, MusicBrainz, and Gemini AI.
                  </p>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleSelectFirst25}
                      className="px-4 py-2 rounded-xl bg-[#00F5FF] text-black font-semibold text-xs hover:bg-[#00F5FF]/90 transition-all flex items-center gap-2 shadow-sm cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Select First 25 Tracks from Grid
                    </button>
                    {currentAlbumTracks.length > 0 && (
                      <button
                        onClick={handleSelectCurrentAlbum}
                        className="px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-white font-mono text-xs border border-white/[0.12] transition-all flex items-center gap-2 cursor-pointer"
                      >
                        <Disc3 className="w-3.5 h-3.5 text-[#00F5FF]" />
                        Select Current Album ({currentAlbumTracks.length} tracks)
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {selectedTracks.length > 25 && (
                    <div className="p-2.5 px-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs font-mono text-amber-300 flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
                      <span>
                        You have {selectedTracks.length} tracks checked. The batch payload is capped at the first 25 tracks for rate protection.
                      </span>
                    </div>
                  )}

                  <div className="border border-white/[0.08] rounded-xl overflow-hidden">
                    <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-[#161A26] border-b border-white/[0.08] text-[11px] font-mono text-[#94A3B8]">
                      <div className="col-span-1 flex items-center">#</div>
                      <div className="col-span-4">Track Title</div>
                      <div className="col-span-3">Artist Credit</div>
                      <div className="col-span-3">Album / Release</div>
                      <div className="col-span-1 text-right">Status</div>
                    </div>

                    <div className="divide-y divide-white/[0.04] max-h-80 overflow-y-auto font-mono text-xs">
                      {queuedTracks.map((trk) => {
                        const rel = releases.find((r) => r.id === trk.releaseId)
                        const trkCoverUrl = trk.pendingSidecarEdits?.coverArtUrl || rel?.artwork?.frontCoverUrl
                        const hasResult = resultsMap.has(trk.id)
                        return (
                          <div
                            key={trk.id}
                            className="grid grid-cols-12 gap-2 px-3 py-2.5 items-center hover:bg-white/[0.02] transition-colors"
                          >
                            <div className="col-span-1 flex items-center gap-1.5 text-[#64748B]">
                              <input
                                type="checkbox"
                                checked={selectedTrackIds.has(trk.id)}
                                onChange={() => onToggleTrackSelection(trk.id, false)}
                                className="accent-[#00F5FF] w-3 h-3 rounded cursor-pointer"
                                disabled={isResolving}
                              />
                              <span>{String(trk.trackNumber || 1).padStart(2, '0')}</span>
                            </div>

                            <div className="col-span-4 flex items-center gap-2.5 min-w-0 pr-2">
                              {trkCoverUrl && (
                                <ArtworkHoverPreview
                                  src={trkCoverUrl}
                                  alt={trk.title}
                                  title={trk.title}
                                  subtitle={trk.artistCredit}
                                  composer={trk.composerName}
                                  provider="local"
                                  audioSpec={trk.sampleRateStr}
                                  previewSize={260}
                                >
                                  <div className="w-7 h-7 rounded-md overflow-hidden bg-black/50 border border-white/[0.1] shrink-0 cursor-pointer shadow-sm">
                                    <img
                                      src={trkCoverUrl}
                                      alt=""
                                      className="w-full h-full object-cover"
                                      onError={(e) => {
                                        ;(e.target as HTMLElement).style.display = 'none'
                                      }}
                                    />
                                  </div>
                                </ArtworkHoverPreview>
                              )}

                              <div className="flex flex-col min-w-0">
                                <span className="truncate font-semibold text-[#F1F5F9]" title={trk.title}>
                                  {trk.title}
                                </span>
                                {trk.filePath && (
                                  <span
                                    className="text-[10px] text-[#64748B] truncate flex items-center gap-1"
                                    title={trk.filePath}
                                  >
                                    <Folder className="w-2.5 h-2.5 shrink-0" />
                                    <span className="truncate">{trk.filePath}</span>
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="col-span-3 truncate text-[#CBD5E1]" title={trk.artistCredit}>
                              {trk.artistCredit}
                            </div>

                            <div className="col-span-3 truncate text-[#94A3B8]" title={rel?.title || 'Unknown'}>
                              {rel?.title || 'Unknown Album'}
                            </div>

                            <div className="col-span-1 text-right">
                              {hasResult ? (
                                <span className="text-[10px] font-bold text-[#10B981] bg-[#10B981]/15 px-1.5 py-0.5 rounded">
                                  Resolved
                                </span>
                              ) : isResolving ? (
                                <Loader2 className="w-3 h-3 text-[#00F5FF] animate-spin inline" />
                              ) : (
                                <span className="text-[10px] text-[#64748B]">Queued</span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* TAB 2: DIFF & RESOLUTION RESULTS */}
          {activeTab === 'results' && (
            <div className="flex flex-col gap-3 text-left font-mono">
              {/* Toolbar: Results count, search, view switcher, and batch apply */}
              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.08] flex flex-wrap items-center justify-between gap-3 text-xs">
                {/* Left: Count & Search */}
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 font-bold text-white">
                    <CheckCircle2 className="w-4 h-4 text-[#10B981]" />
                    <span>{resultsMap.size} Tracks Resolved</span>
                  </div>

                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#64748B]" />
                    <input
                      type="text"
                      placeholder="Filter tracks or files..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-8 pr-2.5 py-1 bg-black/50 border border-white/[0.08] rounded-lg text-xs text-white placeholder-[#64748B] focus:outline-none focus:border-[#00F5FF]/50 w-44 sm:w-56"
                    />
                  </div>
                </div>

                {/* Center: View Switcher */}
                <div className="flex items-center bg-black/40 border border-white/[0.08] rounded-lg p-0.5">
                  <button
                    type="button"
                    onClick={() => setViewMode('table')}
                    className={`px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                      viewMode === 'table'
                        ? 'bg-white/[0.15] text-white shadow-sm font-bold'
                        : 'text-[#64748B] hover:text-[#94A3B8]'
                    }`}
                    title="Compact tabular view for rapid review"
                  >
                    <Table className="w-3.5 h-3.5 text-[#00F5FF]" />
                    <span>Compact Table</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('cards')}
                    className={`px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                      viewMode === 'cards'
                        ? 'bg-white/[0.15] text-white shadow-sm font-bold'
                        : 'text-[#64748B] hover:text-[#94A3B8]'
                    }`}
                    title="Detailed side-by-side comparison cards"
                  >
                    <LayoutGrid className="w-3.5 h-3.5 text-[#ADFF2F]" />
                    <span>Side-by-Side</span>
                  </button>
                </div>

                {/* Right: Batch Apply Source */}
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-[#64748B] mr-1 text-[11px]">Batch Apply:</span>
                  <button
                    type="button"
                    onClick={() => handleBulkSetSource('ai')}
                    className="px-2 py-1 rounded bg-[#8B5CF6]/20 hover:bg-[#8B5CF6]/30 text-[#C084FC] border border-[#8B5CF6]/40 font-semibold cursor-pointer"
                    title="Select Gemini AI metadata for all tracks"
                  >
                    All AI
                  </button>
                  <button
                    type="button"
                    onClick={() => handleBulkSetSource('itunes')}
                    className="px-2 py-1 rounded bg-[#00F5FF]/15 hover:bg-[#00F5FF]/25 text-[#00F5FF] border border-[#00F5FF]/40 font-semibold cursor-pointer"
                    title="Select Apple iTunes metadata for all tracks"
                  >
                    All iTunes
                  </button>
                  <button
                    type="button"
                    onClick={() => handleBulkSetSource('musicbrainz')}
                    className="px-2 py-1 rounded bg-[#ADFF2F]/15 hover:bg-[#ADFF2F]/25 text-[#ADFF2F] border border-[#ADFF2F]/40 font-semibold cursor-pointer"
                    title="Select MusicBrainz metadata for all tracks"
                  >
                    All MB
                  </button>
                  <button
                    type="button"
                    onClick={() => handleBulkSetSource('current')}
                    className="px-2 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] text-[#94A3B8] border border-white/[0.08] cursor-pointer"
                    title="Keep original tags from disk"
                  >
                    Keep Local
                  </button>
                </div>
              </div>

              {/* Provider Warning Banner (e.g. if Gemini or a provider encountered high load) */}
              {providerWarning && (
                <div className="p-3 px-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs text-amber-300">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>{providerWarning}</span>
                  </div>
                  <button
                    onClick={() => setProviderWarning(null)}
                    className="text-[10px] text-amber-400/80 hover:text-amber-200 underline cursor-pointer ml-3 shrink-0"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Staging Notification Banner */}
              {isStaged && (
                <div className="p-3 px-4 rounded-xl bg-[#00F5FF]/10 border border-[#00F5FF]/30 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs text-[#00F5FF]">
                    <ShieldCheck className="w-4 h-4 text-[#00F5FF]" />
                    <span>
                      ✓ Staged {resultsMap.size} tracks into non-destructive JSON sidecars. Ready for 2-phase commit!
                    </span>
                  </div>
                  {onOpenCommitModal && (
                    <button
                      onClick={() => {
                        onClose()
                        onOpenCommitModal()
                      }}
                      className="px-3 py-1 rounded-lg bg-[#00F5FF] text-black font-semibold text-xs hover:bg-[#00F5FF]/90 transition-all flex items-center gap-1 cursor-pointer"
                    >
                      <span>Review in Staged for Commit</span>
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}

              {/* Album Consensus Banner: Decision-making context at a glance */}
              {albumSummary && (() => {
                const consensusCoverUrl = currentRelease?.artwork?.frontCoverUrl ||
                  Array.from(resultsMap.values()).map(r => r.candidates.ai?.coverArtUrl || r.candidates.itunes?.coverArtUrl || r.candidates.musicbrainz?.coverArtUrl).find(Boolean)

                return (
                  <div className="p-3 px-4 rounded-xl bg-gradient-to-r from-[#8B5CF6]/15 via-[#00F5FF]/10 to-[#ADFF2F]/10 border border-white/[0.08] flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-3">
                      {consensusCoverUrl ? (
                        <ArtworkHoverPreview
                          src={consensusCoverUrl}
                          alt={albumSummary.album}
                          title={albumSummary.album}
                          composer={albumSummary.composer}
                          subtitle={albumSummary.label}
                          resolution={currentRelease?.artwork?.resolution || 'HD Archival'}
                          previewSize={280}
                        >
                          <div className="w-10 h-10 rounded-lg overflow-hidden border border-white/[0.15] bg-black/60 shrink-0 cursor-pointer shadow-md group">
                            <img
                              src={consensusCoverUrl}
                              alt=""
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                              onError={(e) => {
                                ;(e.target as HTMLElement).style.display = 'none'
                              }}
                            />
                          </div>
                        </ArtworkHoverPreview>
                      ) : (
                        <div className="p-2 rounded-lg bg-white/[0.06] text-white">
                          <Disc3 className="w-4 h-4 text-[#00F5FF]" />
                        </div>
                      )}

                      <div className="flex flex-col text-left">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white text-sm">{albumSummary.album}</span>
                          {albumSummary.year && (
                            <span className="px-1.5 py-0.2 rounded bg-white/[0.1] text-white text-[10px] font-bold">
                              {albumSummary.year}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-[#94A3B8]">
                          {albumSummary.composer && (
                            <span className="text-[#ADFF2F] flex items-center gap-1">
                              <User className="w-3 h-3" />
                              <span>Composer: {albumSummary.composer}</span>
                            </span>
                          )}
                          {albumSummary.label && (
                            <span className="text-[#CBD5E1]">
                              • {albumSummary.label} {albumSummary.catalogNumber ? `(${albumSummary.catalogNumber})` : ''}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {albumSummary.confidence !== null && (
                        <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-[#8B5CF6]/20 text-[#C084FC] border border-[#8B5CF6]/40 flex items-center gap-1.5">
                          <Sparkles className="w-3 h-3" />
                          <span>{albumSummary.confidence}% Match Consensus</span>
                        </span>
                      )}
                    </div>
                  </div>
                )
              })()}

              {/* Enrichment Option: Cinematic Panoramic Backdrop Rework */}
              <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.08] flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-[#00F5FF]" />
                    <span className="text-xs font-bold text-white">
                      Enrichment Option: Cinematic Album Backdrop (2400×320 Atmospheric Derivative)
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#00F5FF]/10 text-[#00F5FF] border border-[#00F5FF]/20">
                      Latest Fixed Gradient Method
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-mono text-[#CBD5E1] hover:text-white select-none">
                      <input
                        type="checkbox"
                        checked={reworkBackdrops}
                        onChange={(e) => setReworkBackdrops(e.target.checked)}
                        className="accent-[#00F5FF] w-3.5 h-3.5 rounded cursor-pointer"
                      />
                      <span>Auto-rework backdrops on staging</span>
                    </label>

                    <button
                      type="button"
                      onClick={() => handleReworkBackdropForRelease(currentRelease)}
                      disabled={isReworkingBackdrop}
                      className="px-3 py-1 rounded-lg bg-[#00F5FF]/15 hover:bg-[#00F5FF]/25 text-[#00F5FF] border border-[#00F5FF]/30 text-xs font-mono font-medium flex items-center gap-1.5 transition-all cursor-pointer shadow-sm disabled:opacity-50"
                    >
                      {isReworkingBackdrop ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-[#00F5FF]" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5 text-[#00F5FF]" />
                      )}
                      <span>{isReworkingBackdrop ? 'Generating...' : '✨ Rework Backdrop Now'}</span>
                    </button>
                  </div>
                </div>

                {/* Live Preview of the Panoramic Backdrop for Current/Consensus Album */}
                {(() => {
                  const activeRel = currentRelease || (releases.length > 0 ? releases[0] : undefined)
                  const previewCover = activeRel?.artwork?.frontCoverUrl || activeRel?.coverArtUrl || ''
                  const previewBackdrop = (activeRel?.id && reworkedBackdrops[activeRel.id]) || activeRel?.artwork?.backdropUrl || activeRel?.backdropUrl

                  return (
                    <div className="relative h-16 w-full rounded-xl overflow-hidden border border-white/[0.1] bg-[#0A0D14] flex items-center px-4 justify-between">
                      <PanoramicAtmosphericBackdrop
                        coverArtUrl={previewCover}
                        backdropUrl={previewBackdrop}
                        overlayVariant="banner"
                        headerBaseHeight={45}
                      />
                      <div className="relative z-10 flex items-center gap-2.5">
                        {previewCover && (
                          <div className="w-8 h-8 rounded-lg overflow-hidden border border-white/20 bg-black/60 shrink-0">
                            <img src={previewCover} alt="" className="w-full h-full object-cover" />
                          </div>
                        )}
                        <span className="text-xs font-bold text-white truncate max-w-[300px]">
                          {activeRel?.title || 'Album Backdrop Preview'}
                        </span>
                        <span className="text-[10px] text-[#94A3B8] font-mono hidden sm:inline">
                          {previewBackdrop ? '✓ 2400×320 High-Res Derivative Active' : 'Auto Generated from Master Art'}
                        </span>
                      </div>
                      <div className="relative z-10 text-[10px] font-mono text-[#00F5FF] px-2 py-0.5 rounded bg-black/40 border border-white/[0.08]">
                        Header-Anchored Fixed Fade Active
                      </div>
                    </div>
                  )
                })()}
              </div>

              {/* VIEW 1: COMPACT TABLE REVIEW */}
              {viewMode === 'table' && (
                <div className="border border-white/[0.08] rounded-xl overflow-hidden bg-[#161A26]">
                  <div className="max-h-[55vh] overflow-y-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="sticky top-0 z-10 bg-[#12151E] border-b border-white/[0.08] text-[11px] text-[#94A3B8]">
                        <tr>
                          <th className="py-2.5 px-3 w-10 text-center font-bold">#</th>
                          <th className="py-2.5 px-3 w-56 font-bold">File on Disk & Tags</th>
                          <th className="py-2.5 px-3 w-64 font-bold">Proposed Title</th>
                          <th className="py-2.5 px-3 w-44 font-bold">Artist & Composer</th>
                          <th className="py-2.5 px-3 w-36 font-bold">Album & Year</th>
                          <th className="py-2.5 px-3 w-56 font-bold">Source Selector</th>
                          <th className="py-2.5 px-3 w-12 text-right font-bold">Edit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {displayTracks.map((trk) => {
                          const res = resultsMap.get(trk.id)
                          if (!res) return null

                          const isExpanded = manualExpandedTrackId === trk.id
                          const effectiveManual = res.manualValues || {
                            title: trk.title,
                            artistCredit: trk.artistCredit,
                            composerName: trk.composerName || '',
                            albumTitle: currentRelease?.title || '',
                            releaseYear: currentRelease?.releaseYear,
                          }

                          // Selected candidate
                          const cand =
                            res.selectedSource === 'ai'
                              ? res.candidates.ai
                              : res.selectedSource === 'itunes'
                              ? res.candidates.itunes
                              : res.selectedSource === 'musicbrainz'
                              ? res.candidates.musicbrainz
                              : null

                          const proposedTitle =
                            res.selectedSource === 'manual'
                              ? effectiveManual.title
                              : cand?.trackTitle || trk.title
                          const proposedArtist =
                            res.selectedSource === 'manual'
                              ? effectiveManual.artistCredit
                              : cand?.artistCredit || trk.artistCredit
                          const proposedComposer =
                            res.selectedSource === 'manual'
                              ? effectiveManual.composerName
                              : cand?.composer || trk.composerName
                          const proposedAlbum =
                            res.selectedSource === 'manual'
                              ? effectiveManual.albumTitle
                              : cand?.releaseTitle || currentRelease?.title
                          const proposedYear =
                            res.selectedSource === 'manual'
                              ? effectiveManual.releaseYear
                              : cand?.releaseYear || currentRelease?.releaseYear

                          const hasTitleDiff = proposedTitle !== trk.title
                          const fileBasename = trk.filePath ? trk.filePath.split(/[/\\]/).pop() : trk.title

                          return (
                            <React.Fragment key={trk.id}>
                              <tr className="hover:bg-white/[0.03] transition-colors">
                                {/* Track # */}
                                <td className="py-2 px-3 text-center align-middle font-bold text-white/[0.6]">
                                  {String(trk.trackNumber || 1).padStart(2, '0')}
                                </td>

                                {/* File on Disk & Tags */}
                                <td className="py-2 px-3 align-middle max-w-[210px]">
                                  <div className="flex flex-col min-w-0">
                                    <span
                                      className="text-[10px] text-[#64748B] truncate flex items-center gap-1"
                                      title={trk.filePath || trk.title}
                                    >
                                      <Folder className="w-2.5 h-2.5 shrink-0 text-[#64748B]" />
                                      <span className="truncate">{fileBasename}</span>
                                    </span>
                                    <span
                                      className="text-xs text-[#94A3B8] truncate"
                                      title={`${trk.title} • ${trk.artistCredit}`}
                                    >
                                      {trk.title} <span className="text-[#64748B]">• {trk.artistCredit}</span>
                                    </span>
                                  </div>
                                </td>

                                {/* Proposed Title */}
                                <td className="py-2 px-3 align-middle max-w-[240px]">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <span
                                      className={`text-xs truncate ${
                                        hasTitleDiff ? 'text-white font-bold' : 'text-[#CBD5E1]'
                                      }`}
                                      title={proposedTitle}
                                    >
                                      {proposedTitle}
                                    </span>
                                    {hasTitleDiff && (
                                      <span className="px-1 py-0.2 rounded text-[9px] font-bold bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40 shrink-0">
                                        DIFF
                                      </span>
                                    )}
                                  </div>
                                </td>

                                {/* Artist & Composer */}
                                <td className="py-2 px-3 align-middle max-w-[170px]">
                                  <div className="flex flex-col min-w-0">
                                    <span className="text-xs text-[#CBD5E1] truncate font-semibold" title={proposedArtist}>
                                      {proposedArtist}
                                    </span>
                                    {proposedComposer && (
                                      <span
                                        className="text-[10px] text-[#ADFF2F] truncate flex items-center gap-1"
                                        title={`Composer: ${proposedComposer}`}
                                      >
                                        <User className="w-2.5 h-2.5 shrink-0" />
                                        <span className="truncate">{proposedComposer}</span>
                                      </span>
                                    )}
                                  </div>
                                </td>

                                {/* Album & Year */}
                                <td className="py-2 px-3 align-middle max-w-[140px]">
                                  <div className="flex flex-col min-w-0">
                                    <span className="text-xs text-[#94A3B8] truncate" title={proposedAlbum || '—'}>
                                      {proposedAlbum || '—'}
                                    </span>
                                    {proposedYear && (
                                      <span className="text-[10px] text-[#64748B] font-bold">
                                        {proposedYear}
                                      </span>
                                    )}
                                  </div>
                                </td>

                                {/* Source Selector Segmented Pills */}
                                <td className="py-2 px-3 align-middle">
                                  <div className="inline-flex items-center p-0.5 rounded-lg bg-black/40 border border-white/[0.08] gap-0.5 text-[10px]">
                                    {/* Local */}
                                    {(() => {
                                      const rel = releases.find((r) => r.id === trk.releaseId)
                                      const trkCoverUrl = trk.pendingSidecarEdits?.coverArtUrl || rel?.artwork?.frontCoverUrl
                                      return (
                                        <ArtworkHoverPreview
                                          src={trkCoverUrl}
                                          alt={trk.title}
                                          title={trk.title}
                                          subtitle={trk.artistCredit}
                                          composer={trk.composerName}
                                          provider="local"
                                          disabled={!trkCoverUrl}
                                          previewSize={260}
                                        >
                                          <button
                                            type="button"
                                            onClick={() => handleSelectTrackSource(trk.id, 'current')}
                                            className={`px-2 py-0.5 rounded transition-all font-semibold cursor-pointer ${
                                              res.selectedSource === 'current'
                                                ? 'bg-white/[0.2] text-white shadow-sm'
                                                : 'text-[#64748B] hover:text-[#94A3B8]'
                                            }`}
                                            title="Keep original tags from disk (Hover for art)"
                                          >
                                            Local
                                          </button>
                                        </ArtworkHoverPreview>
                                      )
                                    })()}

                                    {/* iTunes */}
                                    <ArtworkHoverPreview
                                      src={res.candidates.itunes?.coverArtUrl}
                                      alt={res.candidates.itunes?.releaseTitle || 'iTunes Cover'}
                                      title={res.candidates.itunes?.trackTitle}
                                      subtitle={res.candidates.itunes?.artistCredit}
                                      composer={res.candidates.itunes?.composer}
                                      resolution={res.candidates.itunes?.coverResolution || '3000x3000px HD'}
                                      provider="itunes"
                                      disabled={!res.candidates.itunes?.coverArtUrl}
                                      previewSize={260}
                                    >
                                      <button
                                        type="button"
                                        disabled={!res.candidates.itunes}
                                        onClick={() => handleSelectTrackSource(trk.id, 'itunes')}
                                        className={`px-2 py-0.5 rounded transition-all font-semibold cursor-pointer flex items-center gap-1 ${
                                          res.selectedSource === 'itunes'
                                            ? 'bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/40 shadow-sm'
                                            : res.candidates.itunes
                                            ? 'text-[#00F5FF]/70 hover:text-[#00F5FF]'
                                            : 'text-[#64748B]/30 cursor-not-allowed'
                                        }`}
                                        title={
                                          res.candidates.itunes
                                            ? `iTunes: "${res.candidates.itunes.trackTitle}" (${res.candidates.itunes.releaseTitle}) • Hover for Apple Music Art`
                                            : 'No iTunes match'
                                        }
                                      >
                                        <Music2 className="w-2.5 h-2.5" />
                                        <span>iTunes</span>
                                      </button>
                                    </ArtworkHoverPreview>

                                    {/* MusicBrainz */}
                                    <ArtworkHoverPreview
                                      src={res.candidates.musicbrainz?.coverArtUrl}
                                      alt={res.candidates.musicbrainz?.releaseTitle || 'MusicBrainz CAA'}
                                      title={res.candidates.musicbrainz?.trackTitle}
                                      subtitle={res.candidates.musicbrainz?.artistCredit}
                                      composer={res.candidates.musicbrainz?.composer}
                                      resolution={res.candidates.musicbrainz?.coverResolution || 'CAA Scan'}
                                      provider="musicbrainz"
                                      disabled={!res.candidates.musicbrainz?.coverArtUrl}
                                      previewSize={260}
                                    >
                                      <button
                                        type="button"
                                        disabled={!res.candidates.musicbrainz}
                                        onClick={() => handleSelectTrackSource(trk.id, 'musicbrainz')}
                                        className={`px-2 py-0.5 rounded transition-all font-semibold cursor-pointer flex items-center gap-1 ${
                                          res.selectedSource === 'musicbrainz'
                                            ? 'bg-[#ADFF2F]/20 text-[#ADFF2F] border border-[#ADFF2F]/40 shadow-sm'
                                            : res.candidates.musicbrainz
                                            ? 'text-[#ADFF2F]/70 hover:text-[#ADFF2F]'
                                            : 'text-[#64748B]/30 cursor-not-allowed'
                                        }`}
                                        title={
                                          res.candidates.musicbrainz
                                            ? `MusicBrainz: "${res.candidates.musicbrainz.trackTitle}" (${res.candidates.musicbrainz.releaseTitle}) • Hover for CAA Art`
                                            : 'No MusicBrainz match'
                                        }
                                      >
                                        <Disc3 className="w-2.5 h-2.5" />
                                        <span>MB</span>
                                      </button>
                                    </ArtworkHoverPreview>

                                    {/* Gemini AI */}
                                    <ArtworkHoverPreview
                                      src={res.candidates.ai?.coverArtUrl}
                                      alt={res.candidates.ai?.releaseTitle || 'Gemini AI Art'}
                                      title={res.candidates.ai?.trackTitle}
                                      subtitle={res.candidates.ai?.artistCredit}
                                      composer={res.candidates.ai?.composer}
                                      provider="ai"
                                      disabled={!res.candidates.ai?.coverArtUrl}
                                      previewSize={260}
                                    >
                                      <button
                                        type="button"
                                        disabled={!res.candidates.ai}
                                        onClick={() => handleSelectTrackSource(trk.id, 'ai')}
                                        className={`px-2 py-0.5 rounded transition-all font-semibold cursor-pointer flex items-center gap-1 ${
                                          res.selectedSource === 'ai'
                                            ? 'bg-[#8B5CF6]/25 text-[#C084FC] border border-[#8B5CF6]/50 shadow-sm'
                                            : res.candidates.ai
                                            ? 'text-[#C084FC]/70 hover:text-[#C084FC]'
                                            : 'text-[#64748B]/30 cursor-not-allowed'
                                        }`}
                                        title={
                                          res.candidates.ai
                                            ? `Gemini AI (${Math.round((res.candidates.ai.confidenceScore || 0.98) * 100)}%): "${res.candidates.ai.trackTitle}" • ${res.candidates.ai.composer || res.candidates.ai.artistCredit}`
                                            : 'No Gemini AI match'
                                        }
                                      >
                                        <Sparkles className="w-2.5 h-2.5" />
                                        <span>Gemini</span>
                                      </button>
                                    </ArtworkHoverPreview>

                                    {res.selectedSource === 'manual' && (
                                      <span className="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[9px] font-bold">
                                        Custom
                                      </span>
                                    )}
                                  </div>
                                </td>

                                {/* Quick Edit Toggle */}
                                <td className="py-2 px-3 align-middle text-right">
                                  <button
                                    type="button"
                                    onClick={() => setManualExpandedTrackId(isExpanded ? null : trk.id)}
                                    className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
                                      isExpanded
                                        ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                                        : 'bg-white/[0.04] border-white/[0.06] text-[#64748B] hover:text-white hover:bg-white/[0.08]'
                                    }`}
                                    title="Fine-tune / Edit track values manually"
                                  >
                                    <PenLine className="w-3 h-3" />
                                  </button>
                                </td>
                              </tr>

                              {/* Expanded Inline Editor Row */}
                              {isExpanded && (
                                <tr className="bg-black/50 border-b border-amber-500/20">
                                  <td colSpan={7} className="p-3">
                                    <div className="flex flex-col gap-2 bg-[#12151E] border border-amber-500/30 rounded-xl p-3">
                                      <div className="flex items-center justify-between text-xs">
                                        <span className="text-amber-400 font-bold flex items-center gap-1.5">
                                          <PenLine className="w-3.5 h-3.5" />
                                          Custom Override for Track #{String(trk.trackNumber || 1).padStart(2, '0')}: "{trk.title}"
                                        </span>
                                        <div className="flex items-center gap-1.5 text-[10px]">
                                          {res.candidates.ai && (
                                            <button
                                              type="button"
                                              onClick={() => handleCopyCandidateToManual(trk.id, res.candidates.ai)}
                                              className="px-2 py-0.5 rounded bg-[#8B5CF6]/15 text-[#C084FC] hover:bg-[#8B5CF6]/25 border border-[#8B5CF6]/30 cursor-pointer"
                                            >
                                              Fill with Gemini AI
                                            </button>
                                          )}
                                          {res.candidates.itunes && (
                                            <button
                                              type="button"
                                              onClick={() => handleCopyCandidateToManual(trk.id, res.candidates.itunes)}
                                              className="px-2 py-0.5 rounded bg-[#00F5FF]/15 text-[#00F5FF] hover:bg-[#00F5FF]/25 border border-[#00F5FF]/30 cursor-pointer"
                                            >
                                              Fill with iTunes
                                            </button>
                                          )}
                                          {res.candidates.musicbrainz && (
                                            <button
                                              type="button"
                                              onClick={() => handleCopyCandidateToManual(trk.id, res.candidates.musicbrainz)}
                                              className="px-2 py-0.5 rounded bg-[#ADFF2F]/15 text-[#ADFF2F] hover:bg-[#ADFF2F]/25 border border-[#ADFF2F]/30 cursor-pointer"
                                            >
                                              Fill with MusicBrainz
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            onClick={() => setManualExpandedTrackId(null)}
                                            className="px-2 py-0.5 rounded bg-white/[0.08] hover:bg-white/[0.15] text-[#CBD5E1] cursor-pointer"
                                          >
                                            Done
                                          </button>
                                        </div>
                                      </div>

                                      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 text-xs pt-1">
                                        <div className="flex flex-col gap-1">
                                          <label className="text-[9px] text-[#94A3B8] uppercase">Track Title</label>
                                          <input
                                            type="text"
                                            value={effectiveManual.title}
                                            onChange={(e) => handleUpdateTrackManual(trk.id, 'title', e.target.value)}
                                            className="bg-black/60 border border-white/[0.1] rounded px-2.5 py-1 text-xs text-white focus:border-amber-400 focus:outline-none"
                                          />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                          <label className="text-[9px] text-[#94A3B8] uppercase">Artist Credit</label>
                                          <input
                                            type="text"
                                            value={effectiveManual.artistCredit}
                                            onChange={(e) => handleUpdateTrackManual(trk.id, 'artistCredit', e.target.value)}
                                            className="bg-black/60 border border-white/[0.1] rounded px-2.5 py-1 text-xs text-white focus:border-amber-400 focus:outline-none"
                                          />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                          <label className="text-[9px] text-[#94A3B8] uppercase">Composer</label>
                                          <input
                                            type="text"
                                            value={effectiveManual.composerName}
                                            onChange={(e) => handleUpdateTrackManual(trk.id, 'composerName', e.target.value)}
                                            className="bg-black/60 border border-white/[0.1] rounded px-2.5 py-1 text-xs text-white focus:border-amber-400 focus:outline-none"
                                          />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                          <label className="text-[9px] text-[#94A3B8] uppercase">Album Title</label>
                                          <input
                                            type="text"
                                            value={effectiveManual.albumTitle || ''}
                                            onChange={(e) => handleUpdateTrackManual(trk.id, 'albumTitle', e.target.value)}
                                            className="bg-black/60 border border-white/[0.1] rounded px-2.5 py-1 text-xs text-white focus:border-amber-400 focus:outline-none"
                                          />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                          <label className="text-[9px] text-[#94A3B8] uppercase">Release Year</label>
                                          <input
                                            type="number"
                                            value={effectiveManual.releaseYear || ''}
                                            onChange={(e) => handleUpdateTrackManual(trk.id, 'releaseYear', e.target.value ? Number(e.target.value) : undefined)}
                                            className="bg-black/60 border border-white/[0.1] rounded px-2.5 py-1 text-xs text-white focus:border-amber-400 focus:outline-none"
                                          />
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* VIEW 2: MULTI-CANDIDATE DIFF CARDS (Alternative View) */}
              {viewMode === 'cards' && (
                <div className="flex flex-col gap-3 text-xs max-h-[55vh] overflow-y-auto pr-1">
                  {displayTracks.map((trk) => {
                    const res = resultsMap.get(trk.id)
                    if (!res) return null

                    const isManualExpanded = manualExpandedTrackId === trk.id
                    const effectiveManual = res.manualValues || {
                      title: trk.title,
                      artistCredit: trk.artistCredit,
                      composerName: trk.composerName || '',
                      albumTitle: currentRelease?.title || '',
                      releaseYear: currentRelease?.releaseYear,
                    }

                    return (
                      <div
                        key={trk.id}
                        className="p-3 rounded-xl border border-white/[0.08] bg-[#161A26] flex flex-col gap-2.5 transition-all"
                      >
                        {/* Track Header */}
                        <div className="flex items-center justify-between gap-2 border-b border-white/[0.05] pb-2">
                          <div className="flex items-center gap-2 truncate">
                            <span className="text-[#64748B] font-bold">
                              #{String(trk.trackNumber || 1).padStart(2, '0')}
                            </span>
                            <span className="text-white font-bold truncate">
                              {trk.title}
                            </span>
                            <span className="text-[#94A3B8] truncate text-[11px]">
                              • {trk.artistCredit}
                            </span>
                            {trk.filePath && (
                              <span className="text-[10px] text-[#64748B] truncate ml-1 flex items-center gap-1">
                                <Folder className="w-2.5 h-2.5" />
                                {trk.filePath.split(/[/\\]/).pop()}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-[10px] text-[#64748B]">Active Source:</span>
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${
                                res.selectedSource === 'ai'
                                  ? 'bg-[#8B5CF6]/20 text-[#C084FC] border border-[#8B5CF6]/40'
                                  : res.selectedSource === 'itunes'
                                  ? 'bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/40'
                                  : res.selectedSource === 'musicbrainz'
                                  ? 'bg-[#ADFF2F]/20 text-[#ADFF2F] border border-[#ADFF2F]/40'
                                  : res.selectedSource === 'manual'
                                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                                  : 'bg-white/[0.08] text-[#CBD5E1]'
                              }`}
                            >
                              {res.selectedSource}
                            </span>
                          </div>
                        </div>

                        {/* Provider Candidate Selection Grid */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-[11px]">
                          {/* 1. Local Current */}
                          {(() => {
                            const rel = releases.find((r) => r.id === trk.releaseId)
                            const trkCoverUrl = trk.pendingSidecarEdits?.coverArtUrl || rel?.artwork?.frontCoverUrl
                            return (
                              <ArtworkHoverPreview
                                src={trkCoverUrl}
                                alt={trk.title}
                                title={trk.title}
                                subtitle={trk.artistCredit}
                                composer={trk.composerName}
                                provider="local"
                                disabled={!trkCoverUrl}
                                previewSize={260}
                                className="w-full"
                              >
                                <button
                                  type="button"
                                  onClick={() => handleSelectTrackSource(trk.id, 'current')}
                                  className={`w-full p-2.5 rounded-lg border text-left flex flex-col justify-between gap-1 transition-all cursor-pointer ${
                                    res.selectedSource === 'current'
                                      ? 'bg-white/[0.12] border-white text-white font-bold ring-1 ring-white/40'
                                      : 'bg-black/30 border-white/[0.05] text-[#94A3B8] hover:border-white/20'
                                  }`}
                                >
                                  <div className="flex items-center justify-between text-[9px] text-[#64748B] uppercase font-bold">
                                    <span>Local Disk</span>
                                    {res.selectedSource === 'current' && <Check className="w-2.5 h-2.5 text-white" />}
                                  </div>
                                  <div className="flex flex-col truncate">
                                    <span className="truncate text-white font-semibold">{trk.title}</span>
                                    <span className="truncate text-[10px] text-[#94A3B8]">{trk.artistCredit}</span>
                                  </div>
                                </button>
                              </ArtworkHoverPreview>
                            )
                          })()}

                          {/* 2. Apple iTunes */}
                          <ArtworkHoverPreview
                            src={res.candidates.itunes?.coverArtUrl}
                            alt={res.candidates.itunes?.releaseTitle || 'Apple Music HD'}
                            title={res.candidates.itunes?.trackTitle}
                            subtitle={res.candidates.itunes?.artistCredit}
                            composer={res.candidates.itunes?.composer}
                            resolution={res.candidates.itunes?.coverResolution || '3000x3000px HD'}
                            provider="itunes"
                            disabled={!res.candidates.itunes?.coverArtUrl}
                            previewSize={260}
                            className="w-full"
                          >
                            <button
                              type="button"
                              disabled={!res.candidates.itunes}
                              onClick={() => handleSelectTrackSource(trk.id, 'itunes')}
                              className={`w-full p-2.5 rounded-lg border text-left flex flex-col justify-between gap-1 transition-all disabled:opacity-30 cursor-pointer ${
                                res.selectedSource === 'itunes'
                                  ? 'bg-[#00F5FF]/15 border-[#00F5FF] text-[#00F5FF] font-bold ring-1 ring-[#00F5FF]/40'
                                  : 'bg-black/30 border-white/[0.05] text-[#94A3B8] hover:border-[#00F5FF]/30'
                              }`}
                            >
                              <div className="flex items-center justify-between text-[9px] text-[#00F5FF]/80 uppercase font-bold">
                                <span className="flex items-center gap-1">
                                  <Music2 className="w-2.5 h-2.5" />
                                  <span>iTunes</span>
                                </span>
                                {res.selectedSource === 'itunes' && <Check className="w-2.5 h-2.5 text-[#00F5FF]" />}
                              </div>
                              <div className="flex flex-col truncate">
                                <span className="truncate text-[#00F5FF] font-semibold">
                                  {res.candidates.itunes?.trackTitle || '<no match>'}
                                </span>
                                <span className="truncate text-[10px] text-[#00F5FF]/70">
                                  {res.candidates.itunes?.artistCredit || ''}
                                </span>
                                {res.candidates.itunes?.releaseTitle && (
                                  <span className="truncate text-[9px] text-[#64748B]">
                                    {res.candidates.itunes.releaseTitle} ({res.candidates.itunes.releaseYear || '—'})
                                  </span>
                                )}
                              </div>
                            </button>
                          </ArtworkHoverPreview>

                          {/* 3. MusicBrainz */}
                          <ArtworkHoverPreview
                            src={res.candidates.musicbrainz?.coverArtUrl}
                            alt={res.candidates.musicbrainz?.releaseTitle || 'MusicBrainz CAA'}
                            title={res.candidates.musicbrainz?.trackTitle}
                            subtitle={res.candidates.musicbrainz?.artistCredit}
                            composer={res.candidates.musicbrainz?.composer}
                            resolution={res.candidates.musicbrainz?.coverResolution || 'CAA Scan'}
                            provider="musicbrainz"
                            disabled={!res.candidates.musicbrainz?.coverArtUrl}
                            previewSize={260}
                            className="w-full"
                          >
                            <button
                              type="button"
                              disabled={!res.candidates.musicbrainz}
                              onClick={() => handleSelectTrackSource(trk.id, 'musicbrainz')}
                              className={`w-full p-2.5 rounded-lg border text-left flex flex-col justify-between gap-1 transition-all disabled:opacity-30 cursor-pointer ${
                                res.selectedSource === 'musicbrainz'
                                  ? 'bg-[#ADFF2F]/15 border-[#ADFF2F] text-[#ADFF2F] font-bold ring-1 ring-[#ADFF2F]/40'
                                  : 'bg-black/30 border-white/[0.05] text-[#94A3B8] hover:border-[#ADFF2F]/30'
                              }`}
                            >
                              <div className="flex items-center justify-between text-[9px] text-[#ADFF2F]/80 uppercase font-bold">
                                <span className="flex items-center gap-1">
                                  <Disc3 className="w-2.5 h-2.5" />
                                  <span>MusicBrainz</span>
                                </span>
                                {res.selectedSource === 'musicbrainz' && <Check className="w-2.5 h-2.5 text-[#ADFF2F]" />}
                              </div>
                              <div className="flex flex-col truncate">
                                <span className="truncate text-[#ADFF2F] font-semibold">
                                  {res.candidates.musicbrainz?.trackTitle || '<no match>'}
                                </span>
                                <span className="truncate text-[10px] text-[#ADFF2F]/70">
                                  {res.candidates.musicbrainz?.artistCredit || ''}
                                </span>
                                {res.candidates.musicbrainz?.releaseTitle && (
                                  <span className="truncate text-[9px] text-[#64748B]">
                                    {res.candidates.musicbrainz.releaseTitle} ({res.candidates.musicbrainz.releaseYear || '—'})
                                  </span>
                                )}
                              </div>
                            </button>
                          </ArtworkHoverPreview>

                          {/* 4. Gemini AI */}
                          <ArtworkHoverPreview
                            src={res.candidates.ai?.coverArtUrl}
                            alt={res.candidates.ai?.releaseTitle || 'Gemini AI Art'}
                            title={res.candidates.ai?.trackTitle}
                            subtitle={res.candidates.ai?.artistCredit}
                            composer={res.candidates.ai?.composer}
                            provider="ai"
                            disabled={!res.candidates.ai?.coverArtUrl}
                            previewSize={260}
                            className="w-full"
                          >
                            <button
                              type="button"
                              disabled={!res.candidates.ai}
                              onClick={() => handleSelectTrackSource(trk.id, 'ai')}
                              className={`w-full p-2.5 rounded-lg border text-left flex flex-col justify-between gap-1 transition-all disabled:opacity-30 cursor-pointer ${
                                res.selectedSource === 'ai'
                                  ? 'bg-[#8B5CF6]/20 border-[#8B5CF6] text-[#C084FC] font-bold ring-1 ring-[#8B5CF6]/40'
                                  : 'bg-black/30 border-white/[0.05] text-[#94A3B8] hover:border-[#8B5CF6]/30'
                              }`}
                            >
                              <div className="flex items-center justify-between text-[9px] text-[#C084FC] uppercase font-bold">
                                <span className="flex items-center gap-1">
                                  <Sparkles className="w-2.5 h-2.5" />
                                  <span>Gemini AI</span>
                                </span>
                                {res.selectedSource === 'ai' && <Check className="w-2.5 h-2.5 text-[#C084FC]" />}
                              </div>
                              <div className="flex flex-col truncate">
                                <span className="truncate text-[#E9D5FF] font-semibold">
                                  {res.candidates.ai?.trackTitle || '<query AI>'}
                                </span>
                                <span className="truncate text-[10px] text-[#C084FC]/70">
                                  {res.candidates.ai?.artistCredit || ''}
                                </span>
                                {res.candidates.ai?.composer && (
                                  <span className="truncate text-[9px] text-[#ADFF2F] flex items-center gap-1">
                                    <User className="w-2.5 h-2.5" />
                                    <span>{res.candidates.ai.composer}</span>
                                  </span>
                                )}
                                {res.candidates.ai?.releaseTitle && (
                                  <span className="truncate text-[9px] text-[#64748B]">
                                    {res.candidates.ai.releaseTitle} ({res.candidates.ai.releaseYear || '—'})
                                  </span>
                                )}
                              </div>
                            </button>
                          </ArtworkHoverPreview>
                        </div>

                        {/* Manual Entry Toggle & Collapsible Editor for this track */}
                        <div className="mt-1 pt-1 border-t border-white/[0.04] flex flex-col gap-2">
                          <div className="flex items-center justify-between">
                            <button
                              type="button"
                              onClick={() => {
                                if (res.selectedSource !== 'manual') {
                                  handleSelectTrackSource(trk.id, 'manual')
                                }
                                setManualExpandedTrackId(isManualExpanded ? null : trk.id)
                              }}
                              className={`px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                                res.selectedSource === 'manual'
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                  : 'bg-white/[0.04] hover:bg-white/[0.08] text-[#94A3B8] border border-white/[0.06]'
                              }`}
                            >
                              <PenLine className="w-3 h-3" />
                              <span>Manual Override for Track #{String(trk.trackNumber || 1)}</span>
                              {isManualExpanded ? (
                                <ChevronUp className="w-3 h-3" />
                              ) : (
                                <ChevronDown className="w-3 h-3" />
                              )}
                            </button>

                            {/* Quick Copy Helpers into Manual */}
                            <div className="flex items-center gap-1.5 text-[10px]">
                              {res.candidates.ai && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    handleCopyCandidateToManual(trk.id, res.candidates.ai)
                                    setManualExpandedTrackId(trk.id)
                                  }}
                                  className="px-2 py-0.5 rounded bg-[#8B5CF6]/10 text-[#C084FC] hover:bg-[#8B5CF6]/20 border border-[#8B5CF6]/20 cursor-pointer"
                                >
                                  Copy AI
                                </button>
                              )}
                              {res.candidates.itunes && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    handleCopyCandidateToManual(trk.id, res.candidates.itunes)
                                    setManualExpandedTrackId(trk.id)
                                  }}
                                  className="px-2 py-0.5 rounded bg-[#00F5FF]/10 text-[#00F5FF] hover:bg-[#00F5FF]/20 border border-[#00F5FF]/20 cursor-pointer"
                                >
                                  Copy iTunes
                                </button>
                              )}
                              {res.candidates.musicbrainz && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    handleCopyCandidateToManual(trk.id, res.candidates.musicbrainz)
                                    setManualExpandedTrackId(trk.id)
                                  }}
                                  className="px-2 py-0.5 rounded bg-[#ADFF2F]/10 text-[#ADFF2F] hover:bg-[#ADFF2F]/20 border border-[#ADFF2F]/20 cursor-pointer"
                                >
                                  Copy MB
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Expanded Manual Inputs */}
                          {isManualExpanded && (
                            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 p-2.5 rounded-lg bg-black/40 border border-amber-500/20 animate-in fade-in duration-100">
                              <div className="flex flex-col gap-1">
                                <span className="text-[9px] text-[#94A3B8] uppercase">Track Title</span>
                                <input
                                  type="text"
                                  value={effectiveManual.title}
                                  onChange={(e) => handleUpdateTrackManual(trk.id, 'title', e.target.value)}
                                  className="bg-black/60 border border-white/[0.1] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-amber-400"
                                />
                              </div>
                              <div className="flex flex-col gap-1">
                                <span className="text-[9px] text-[#94A3B8] uppercase">Artist Credit</span>
                                <input
                                  type="text"
                                  value={effectiveManual.artistCredit}
                                  onChange={(e) => handleUpdateTrackManual(trk.id, 'artistCredit', e.target.value)}
                                  className="bg-black/60 border border-white/[0.1] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-amber-400"
                                />
                              </div>
                              <div className="flex flex-col gap-1">
                                <span className="text-[9px] text-[#94A3B8] uppercase">Composer Name</span>
                                <input
                                  type="text"
                                  value={effectiveManual.composerName}
                                  onChange={(e) => handleUpdateTrackManual(trk.id, 'composerName', e.target.value)}
                                  className="bg-black/60 border border-white/[0.1] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-amber-400"
                                />
                              </div>
                              <div className="flex flex-col gap-1">
                                <span className="text-[9px] text-[#94A3B8] uppercase">Album Title</span>
                                <input
                                  type="text"
                                  value={effectiveManual.albumTitle || ''}
                                  onChange={(e) => handleUpdateTrackManual(trk.id, 'albumTitle', e.target.value)}
                                  className="bg-black/60 border border-white/[0.1] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-amber-400"
                                />
                              </div>
                              <div className="flex flex-col gap-1">
                                <span className="text-[9px] text-[#94A3B8] uppercase">Release Year</span>
                                <input
                                  type="number"
                                  value={effectiveManual.releaseYear || ''}
                                  onChange={(e) => handleUpdateTrackManual(trk.id, 'releaseYear', e.target.value ? Number(e.target.value) : undefined)}
                                  className="bg-black/60 border border-white/[0.1] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-amber-400"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Progress / Status Message */}
          {progressMsg && (
            <div className="mt-4 p-3 px-4 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center gap-2 text-xs font-mono text-[#00F5FF]">
              {isResolving && <Loader2 className="w-4 h-4 animate-spin text-[#00F5FF]" />}
              <span>{progressMsg}</span>
            </div>
          )}

          {/* Error Message */}
          {errorMsg && (
            <div className="mt-4 p-3 px-4 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center gap-2 text-xs font-mono text-rose-300">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* Modal Footer Actions */}
        <div className="p-4 px-6 border-t border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <span className="text-[11px] font-mono text-[#64748B]">
            All changes are staged non-destructively in JSON sidecars. Zero audio headers modified until 2-phase commit.
          </span>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={isResolving}
              className="px-3.5 py-2 rounded-xl text-xs font-mono text-[#94A3B8] hover:text-white cursor-pointer"
            >
              Close
            </button>

            {resultsMap.size > 0 && (
              <button
                onClick={handleStageAllSidecars}
                disabled={isResolving || isStaged}
                className={`px-4 py-2 rounded-xl font-mono font-bold text-xs transition-all flex items-center gap-1.5 shadow-md cursor-pointer ${
                  isStaged
                    ? 'bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40'
                    : 'bg-[#10B981] text-black hover:bg-[#10B981]/90'
                }`}
              >
                {isStaged ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#10B981]" />
                    <span>Staged in Sidecars ✓</span>
                  </>
                ) : (
                  <>
                    <FileCode className="w-3.5 h-3.5" />
                    <span>Stage All Selected ({resultsMap.size}) in Sidecars</span>
                  </>
                )}
              </button>
            )}

            <button
              onClick={handleExecuteResolution}
              disabled={isResolving || queuedTracks.length === 0}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-[#00F5FF] via-[#8B5CF6] to-[#EC4899] text-white font-mono font-bold text-xs hover:brightness-110 transition-all flex items-center gap-1.5 disabled:opacity-40 shadow-lg cursor-pointer"
            >
              {isResolving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Resolving Smart Match ({queuedTracks.length} Tracks)...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 text-[#ADFF2F]" />
                  <span>Run Batch Enrich ({queuedTracks.length} Tracks)</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
