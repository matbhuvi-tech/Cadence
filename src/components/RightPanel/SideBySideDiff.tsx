import React, { useState, useEffect, useMemo } from 'react'
import {
  GitCompare,
  Check,
  Sparkles,
  ExternalLink,
  Layers,
  Database,
  RefreshCw,
  Loader2,
  Music,
  Music2,
  Disc3,
  CheckCircle2,
  AlertCircle,
  Image as ImageIcon,
  Zap,
  X,
  Folder,
  PenLine,
} from 'lucide-react'
import { DiffField, DiffSource, Release, Track } from '../../core/types'
import {
  federatedResolversService,
  ProviderResult,
  BatchItem,
} from '../../services/federatedResolvers'
import { ArtworkHoverPreview } from '../common/ArtworkHoverPreview'
import { generatePanoramicBackdrop } from '../../services/panoramicBackdropGenerator'
import { graphEngine } from '../../core/graphEngine'

interface SideBySideDiffProps {
  currentData: {
    trackTitle?: string
    releaseTitle?: string
    title?: string
    artist: string
    composer: string
    year: string
    catalogNo: string
    label: string
    barcode: string
    matrix: string
    artResolution: string
  }
  track?: Track
  release?: Release
  allReleases?: Release[]
  selectedTrackIds?: Set<string>
  onOpenBatchDiff?: () => void
  onOpenBatchAi?: () => void
  onApplyMerge: (mergedFields: Record<string, string>) => void
}

export const SideBySideDiff: React.FC<SideBySideDiffProps> = ({
  currentData,
  track,
  release,
  allReleases = [],
  selectedTrackIds,
  onOpenBatchDiff,
  onOpenBatchAi,
  onApplyMerge,
}) => {
  const [candidates, setCandidates] = useState<ProviderResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isAiLoading, setIsAiLoading] = useState(false)

  // Load external candidates (iTunes + MusicBrainz + cached AI) on track change
  useEffect(() => {
    let isCancelled = false
    setIsLoading(true)

    federatedResolversService
      .fetchFederatedCandidates({
        artist: currentData.artist,
        title: currentData.trackTitle || track?.title || currentData.title || '',
        album: currentData.releaseTitle || release?.title || currentData.title || '',
        id: track?.id,
      })
      .then((res) => {
        if (!isCancelled) {
          setCandidates(res)
          setIsLoading(false)
        }
      })
      .catch(() => {
        if (!isCancelled) setIsLoading(false)
      })

    return () => {
      isCancelled = true
    }
  }, [
    currentData.trackTitle,
    currentData.releaseTitle,
    currentData.title,
    currentData.artist,
    release?.title,
    track?.id,
  ])

  // User source selection map per fieldName: e.g. { trackTitle: 'itunes', artist: 'manual', ... }
  const [userSelectedSources, setUserSelectedSources] = useState<Record<string, DiffSource>>({})
  const [manualValues, setManualValues] = useState<Record<string, string>>({})
  const [isJustStaged, setIsJustStaged] = useState(false)

  // Reset user selection overrides and manual values ONLY when the track changes
  useEffect(() => {
    setUserSelectedSources({})
    setManualValues({})
    setIsJustStaged(false)
  }, [track?.id])

  // Helper to extract the currently selected/active value of a field
  const getActiveFieldValue = (f?: DiffField): string => {
    if (!f) return ''
    if (f.selectedSource === 'manual' && f.customValue !== undefined) return f.customValue
    if (f.selectedSource === 'itunes' && f.itunesValue) return f.itunesValue
    if (f.selectedSource === 'musicbrainz' && f.musicbrainzValue) return f.musicbrainzValue
    if (f.selectedSource === 'ai' && f.aiValue) return f.aiValue
    return f.currentValue || ''
  }

  // Generate interactive diff fields whenever candidates or current data updates
  const [fields, setFields] = useState<DiffField[]>([])

  useEffect(() => {
    const generated = federatedResolversService.generateDiffFields(currentData, candidates)
    // Preserve any user selections & manual values across data refreshes
    const updated = generated.map((f) => {
      const userChoice = userSelectedSources[f.fieldName]
      const manualVal = manualValues[f.fieldName]
      const copy: DiffField = { ...f }
      if (userChoice) {
        copy.selectedSource = userChoice
      }
      if (manualVal !== undefined) {
        copy.customValue = manualVal
      }
      if (copy.selectedSource === 'manual' && manualVal !== undefined) {
        if (!copy.currentValue && manualVal) {
          copy.status = 'added'
        } else if (copy.currentValue !== manualVal) {
          copy.status = 'mutated'
        } else {
          copy.status = 'identical'
        }
      }
      return copy
    })
    setFields(updated)
  }, [currentData, candidates, userSelectedSources, manualValues])

  // Active candidates breakdown
  const itunesCandidate = useMemo(
    () => candidates.find((c) => c.provider === 'itunes'),
    [candidates]
  )
  const mbCandidate = useMemo(
    () => candidates.find((c) => c.provider === 'musicbrainz'),
    [candidates]
  )
  const aiCandidate = useMemo(
    () => candidates.find((c) => c.provider === 'gemini_ai'),
    [candidates]
  )

  // Extract Local Artwork URL from track audio file, physical folder, or release artwork
  const localCoverUrl = useMemo(() => {
    if (track?.filePath) {
      return `/api/track-art?path=${encodeURIComponent(track.filePath)}`
    }
    if (release?.folderPath) {
      return `/api/track-art?path=${encodeURIComponent(release.folderPath)}`
    }
    if (release?.artwork?.frontCoverUrl && !release.artwork.frontCoverUrl.includes('unsplash')) {
      return release.artwork.frontCoverUrl
    }
    return null
  }, [track?.filePath, release?.folderPath, release?.artwork?.frontCoverUrl])

  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({})

  // Reset image errors when track or album changes
  useEffect(() => {
    setImgErrors({})
  }, [track?.id, release?.id])

  // Single on-demand AI resolution
  const handleQuerySingleAi = async () => {
    if (!track) return
    setIsAiLoading(true)
    try {
      const item: BatchItem = {
        id: track.id,
        title: track.title,
        artist: track.artistCredit,
        album: release?.title || track.title,
        year: release?.releaseYear,
        filePath: track.filePath,
      }
      const aiResult = await federatedResolversService.resolveSingleWithAi(item)
      if (aiResult) {
        setCandidates((prev) => {
          const filtered = prev.filter((c) => c.provider !== 'gemini_ai')
          return [...filtered, aiResult]
        })
      }
    } catch (err: any) {
      console.error('Failed to resolve with AI:', err)
    } finally {
      setIsAiLoading(false)
    }
  }

  // Source selection per field
  const handleSelectSource = (
    index: number,
    source: DiffSource
  ) => {
    const targetField = fields[index]
    const fieldName = targetField?.fieldName
    if (fieldName) {
      setUserSelectedSources((prev) => ({ ...prev, [fieldName]: source }))
      if (source === 'manual' && manualValues[fieldName] === undefined) {
        const initialVal = getActiveFieldValue(targetField)
        setManualValues((prev) => ({ ...prev, [fieldName]: initialVal }))
      }
    }
    setFields((prev) => {
      const copy = [...prev]
      if (copy[index]) {
        copy[index] = { ...copy[index], selectedSource: source }
      }
      return copy
    })
    setIsJustStaged(false)
  }

  // Handle direct manual typing
  const handleManualChange = (fieldName: string, value: string, index: number) => {
    setManualValues((prev) => ({ ...prev, [fieldName]: value }))
    setUserSelectedSources((prev) => ({ ...prev, [fieldName]: 'manual' }))
    setFields((prev) => {
      const copy = [...prev]
      if (copy[index]) {
        copy[index] = {
          ...copy[index],
          selectedSource: 'manual',
          customValue: value,
          status: value === copy[index].currentValue ? 'identical' : !copy[index].currentValue ? 'added' : 'mutated',
        }
      }
      return copy
    })
    setIsJustStaged(false)
  }

  // Quick Copy of candidate into manual editor
  const handleCopyActiveToManual = (field: DiffField, index: number) => {
    let valToCopy = field.currentValue
    if (field.selectedSource === 'itunes' && field.itunesValue) valToCopy = field.itunesValue
    else if (field.selectedSource === 'musicbrainz' && field.musicbrainzValue) valToCopy = field.musicbrainzValue
    else if (field.selectedSource === 'ai' && field.aiValue) valToCopy = field.aiValue
    else if (field.itunesValue) valToCopy = field.itunesValue
    else if (field.aiValue) valToCopy = field.aiValue
    else if (field.musicbrainzValue) valToCopy = field.musicbrainzValue

    handleManualChange(field.fieldName, valToCopy, index)
  }

  // Bulk selectors
  const handleBulkSelect = (source: DiffSource) => {
    const newChoices: Record<string, DiffSource> = {}
    fields.forEach((f) => {
      newChoices[f.fieldName] = source
    })
    setUserSelectedSources(newChoices)
    setFields((prev) =>
      prev.map((f) => ({
        ...f,
        selectedSource: source,
      }))
    )
    setIsJustStaged(false)
  }

  // Commit merged fields to sidecar
  const handleCommitMerge = () => {
    const merged: Record<string, string> = {}
    fields.forEach((f) => {
      let proposedVal: string | undefined
      if (f.selectedSource === 'itunes') proposedVal = f.itunesValue
      else if (f.selectedSource === 'musicbrainz') proposedVal = f.musicbrainzValue
      else if (f.selectedSource === 'ai') proposedVal = f.aiValue
      else if (f.selectedSource === 'manual') {
        proposedVal = manualValues[f.fieldName] ?? f.customValue
      }

      // Only stage if the proposed value exists and is different from the current value on disk
      if (proposedVal !== undefined && proposedVal !== '' && proposedVal !== f.currentValue) {
        merged[f.fieldName] = proposedVal
      }
    })

    // Carry over chosen artwork into sidecar and release artwork ledger
    const artField = fields.find((f) => f.fieldName === 'artResolution')
    const selectedArt = artField?.selectedSource || 'current'
    if (selectedArt === 'itunes' && itunesCandidate?.coverArtUrl) {
      merged['coverArtUrl'] = itunesCandidate.coverArtUrl
      merged['coverResolution'] = itunesCandidate.coverResolution || '3000x3000px (Apple Music Master)'
    } else if (selectedArt === 'musicbrainz' && mbCandidate?.coverArtUrl) {
      merged['coverArtUrl'] = mbCandidate.coverArtUrl
      merged['coverResolution'] = mbCandidate.coverResolution || 'Archival Front (Cover Art Archive)'
    } else if (selectedArt === 'current' && localCoverUrl) {
      merged['coverArtUrl'] = localCoverUrl
      merged['coverResolution'] = currentData.artResolution || 'Local Scan'
    } else if (selectedArt === 'ai' && aiCandidate?.coverArtUrl) {
      merged['coverArtUrl'] = aiCandidate.coverArtUrl
      merged['coverResolution'] = aiCandidate.coverResolution || 'Archival Scan'
    } else if (selectedArt === 'manual') {
      const customArt = manualValues['artResolution'] || artField?.customValue || ''
      if (customArt.startsWith('http://') || customArt.startsWith('https://') || customArt.startsWith('/api/')) {
        merged['coverArtUrl'] = customArt
        merged['coverResolution'] = 'Manual Web URL Scan'
      } else {
        merged['coverResolution'] = customArt || 'Manual Artwork Entry'
      }
    }

    onApplyMerge(merged)
    setIsJustStaged(true)
    setTimeout(() => {
      setIsJustStaged(false)
    }, 4000)
  }

  const modifiedCount = fields.filter((f) => {
    if (f.selectedSource === 'itunes') return f.itunesValue && f.itunesValue !== f.currentValue
    if (f.selectedSource === 'musicbrainz')
      return f.musicbrainzValue && f.musicbrainzValue !== f.currentValue
    if (f.selectedSource === 'ai') return f.aiValue && f.aiValue !== f.currentValue
    if (f.selectedSource === 'manual') {
      const val = manualValues[f.fieldName] ?? f.customValue
      return val !== undefined && val !== f.currentValue
    }
    return false
  }).length

  const artField = useMemo(
    () => fields.find((f) => f.fieldName === 'artResolution'),
    [fields]
  )

  return (
    <div className="flex flex-col h-full overflow-hidden text-left bg-[#0E1017]">
      {/* Header & Provider Status Bar */}
      <div className="p-3 border-b border-white/[0.08] bg-[#12151F]/90 flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#00F5FF]" />
            <span className="text-xs font-bold uppercase tracking-wider text-[#F1F5F9]">
              Smart Match Studio
            </span>
          </div>

          {/* Batch Enrich Trigger Button (Virtual Grid Selected Tracks) */}
          {(onOpenBatchDiff || onOpenBatchAi) && (
            <button
              onClick={onOpenBatchDiff || onOpenBatchAi}
              title="Batch Enrich selected tracks across Apple Music, MusicBrainz, and Gemini AI"
              className="px-2.5 py-1 rounded-lg bg-gradient-to-r from-[#00F5FF]/20 via-[#8B5CF6]/20 to-[#ADFF2F]/20 hover:brightness-125 border border-[#00F5FF]/40 text-[10px] font-mono font-bold text-[#E2E8F0] flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
            >
              <Sparkles className="w-3 h-3 text-[#ADFF2F]" />
              <span>
                Batch Enrich (
                {selectedTrackIds && selectedTrackIds.size > 0
                  ? `${Math.min(25, selectedTrackIds.size)} Tracks`
                  : 'Selected Tracks'}
                )
              </span>
            </button>
          )}
        </div>

        {/* Active Inspection Target Banner */}
        <div className="p-2.5 rounded-xl bg-black/40 border border-white/[0.08] flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 truncate min-w-0">
            <div className="w-8 h-8 rounded-lg bg-[#00F5FF]/10 border border-[#00F5FF]/30 flex items-center justify-center shrink-0 text-[#00F5FF]">
              <Disc3 className="w-4 h-4 text-[#00F5FF]" />
            </div>
            <div className="flex flex-col truncate min-w-0 text-left">
              <div className="flex items-center gap-1.5 truncate">
                <span className="text-[11px] font-bold text-white truncate font-mono">
                  {track?.trackNumber ? `#${String(track.trackNumber).padStart(2, '0')} • ` : ''}
                  {currentData.trackTitle || track?.title || currentData.title || 'Unknown Title'}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-[#94A3B8] truncate">
                <span className="text-[#E2E8F0] truncate font-medium">
                  {currentData.releaseTitle || release?.title || 'Album'}
                </span>
                {release?.folderName && (
                  <span
                    className="text-[9px] px-1.5 py-0.2 rounded bg-[#00F5FF]/10 text-[#00F5FF] font-mono shrink-0 truncate max-w-[130px] border border-[#00F5FF]/20"
                    title={`Physical Folder: ${release.folderName}`}
                  >
                    📁 {release.folderName}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-col items-end shrink-0 text-right">
            <span className="text-[9px] font-mono font-bold text-[#ADFF2F] uppercase">
              Active Track
            </span>
            <span className="text-[9px] font-mono text-[#94A3B8] truncate max-w-[110px]">
              {currentData.artist || release?.artistCredit || 'Artist'}
            </span>
          </div>
        </div>

        {/* Live Providers Status Badges */}
        <div
          data-tutorial-id="diff-provider-selector"
          data-testid="diff-provider-selector"
          className="grid grid-cols-3 gap-1.5 text-[10px] font-mono"
        >
          {/* 1. Apple iTunes Badge */}
          <div
            className={`p-1.5 rounded-lg border flex items-center justify-between ${
              itunesCandidate
                ? 'bg-[#00F5FF]/10 border-[#00F5FF]/40 text-[#00F5FF]'
                : isLoading
                ? 'bg-white/[0.02] border-white/[0.05] text-[#94A3B8] animate-pulse'
                : 'bg-white/[0.02] border-white/[0.05] text-[#64748B]'
            }`}
          >
            <div className="flex items-center gap-1.5 truncate">
              <Music2 className="w-3 h-3 shrink-0 text-[#00F5FF]" />
              <span className="truncate font-semibold">iTunes</span>
            </div>
            {itunesCandidate ? (
              <span className="text-[9px] px-1 rounded bg-[#00F5FF]/20 font-bold">LIVE</span>
            ) : isLoading ? (
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
            ) : (
              <span className="text-[9px] text-[#64748B]">No Match</span>
            )}
          </div>

          {/* 2. MusicBrainz Badge */}
          <div
            className={`p-1.5 rounded-lg border flex items-center justify-between ${
              mbCandidate
                ? 'bg-[#ADFF2F]/10 border-[#ADFF2F]/40 text-[#ADFF2F]'
                : isLoading
                ? 'bg-white/[0.02] border-white/[0.05] text-[#94A3B8] animate-pulse'
                : 'bg-white/[0.02] border-white/[0.05] text-[#64748B]'
            }`}
          >
            <div className="flex items-center gap-1.5 truncate">
              <Disc3 className="w-3 h-3 shrink-0 text-[#ADFF2F]" />
              <span className="truncate font-semibold">MusicBrainz</span>
            </div>
            {mbCandidate ? (
              <span className="text-[9px] px-1 rounded bg-[#ADFF2F]/20 font-bold">LIVE</span>
            ) : isLoading ? (
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
            ) : (
              <span className="text-[9px] text-[#64748B]">No Match</span>
            )}
          </div>

          {/* 3. On-Demand Gemini AI Action Pill */}
          <div
            data-tutorial-id="btn-query-gemini-ai"
            data-testid="btn-query-gemini-ai"
            onClick={!isAiLoading ? handleQuerySingleAi : undefined}
            className={`p-1.5 rounded-lg border flex items-center justify-between cursor-pointer transition-all ${
              aiCandidate
                ? 'bg-[#8B5CF6]/20 border-[#8B5CF6]/50 text-[#C084FC]'
                : 'bg-[#8B5CF6]/10 hover:bg-[#8B5CF6]/20 border-[#8B5CF6]/30 text-[#E2E8F0]'
            }`}
            title="Query Gemini 3.7 Flash on demand for canonical musicology"
          >
            <div className="flex items-center gap-1.5 truncate">
              <Sparkles className="w-3 h-3 shrink-0 text-[#C084FC]" />
              <span className="truncate font-semibold">Gemini AI</span>
            </div>
            {isAiLoading ? (
              <Loader2 className="w-2.5 h-2.5 text-[#C084FC] animate-spin" />
            ) : aiCandidate ? (
              <span className="text-[9px] px-1 rounded bg-[#8B5CF6]/30 text-[#E9D5FF] font-bold">
                READY
              </span>
            ) : (
              <span className="text-[9px] px-1 rounded bg-white/[0.08] text-[#CBD5E1] hover:text-white">
                Query AI
              </span>
            )}
          </div>
        </div>

        {/* Bulk Action Buttons */}
        <div className="flex items-center justify-between gap-1 pt-1 border-t border-white/[0.05] text-[10px] font-mono">
          <span className="text-[#64748B] text-[10px]">Batch Select:</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleBulkSelect('current')}
              className="px-2 py-0.5 rounded bg-white/[0.04] text-[#94A3B8] hover:text-white hover:bg-white/[0.08]"
            >
              Keep Local
            </button>
            <button
              onClick={() => handleBulkSelect('itunes')}
              disabled={!itunesCandidate}
              className="px-2 py-0.5 rounded bg-[#00F5FF]/10 text-[#00F5FF] hover:bg-[#00F5FF]/20 disabled:opacity-30 font-semibold"
            >
              All iTunes
            </button>
            <button
              onClick={() => handleBulkSelect('musicbrainz')}
              disabled={!mbCandidate}
              className="px-2 py-0.5 rounded bg-[#ADFF2F]/10 text-[#ADFF2F] hover:bg-[#ADFF2F]/20 disabled:opacity-30 font-semibold"
            >
              All MB
            </button>
            <button
              onClick={() => handleBulkSelect('ai')}
              disabled={!aiCandidate}
              className="px-2 py-0.5 rounded bg-[#8B5CF6]/20 text-[#C084FC] hover:bg-[#8B5CF6]/30 disabled:opacity-30 font-semibold"
            >
              All AI
            </button>
          </div>
        </div>
      </div>

      {/* Diff Table List */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
        {fields.map((field, idx) => {
          const isMutated = field.status === 'mutated'
          const isAdded = field.status === 'added'
          const isArtField = field.fieldName === 'artResolution'

          return (
            <div
              key={field.fieldName}
              className={`p-2.5 rounded-xl border text-xs flex flex-col gap-1.5 transition-all ${
                isAdded
                  ? 'bg-[#10B981]/5 border-[#10B981]/30'
                  : isMutated
                  ? 'bg-[#F59E0B]/5 border-[#F59E0B]/30'
                  : 'bg-white/[0.02] border-white/[0.06]'
              }`}
            >
              {/* Field Label & Status Badge */}
              <div className="flex items-center justify-between">
                <span className="font-mono text-[#E2E8F0] font-bold text-[11px] flex items-center gap-1.5">
                  {isArtField && <ImageIcon className="w-3.5 h-3.5 text-[#00F5FF]" />}
                  {field.fieldName === 'trackTitle' && <Music className="w-3.5 h-3.5 text-[#ADFF2F]" />}
                  {field.fieldName === 'releaseTitle' && <Disc3 className="w-3.5 h-3.5 text-[#00F5FF]" />}
                  <span>{field.label}</span>
                </span>
                <div className="flex items-center gap-1.5">
                  {track?.pendingSidecarEdits && (
                    (field.fieldName === 'trackTitle' && track.pendingSidecarEdits.title) ||
                    (field.fieldName === 'artist' && track.pendingSidecarEdits.artistCredit) ||
                    (field.fieldName === 'composer' && track.pendingSidecarEdits.composerName) ||
                    (field.fieldName === 'releaseTitle' && track.pendingSidecarEdits.album)
                  ) && (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30 font-semibold flex items-center gap-1">
                      <Check className="w-2.5 h-2.5" />
                      <span>Staged</span>
                    </span>
                  )}
                  <span
                    className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${
                      isAdded
                        ? 'bg-[#10B981]/20 text-[#10B981]'
                        : isMutated
                        ? 'bg-[#F59E0B]/20 text-[#F59E0B]'
                        : 'bg-white/[0.05] text-[#64748B]'
                    }`}
                  >
                    {field.status}
                  </span>
                </div>
              </div>

              {/* Source Option Tiles */}
              <div
                data-tutorial-id="diff-table-cells"
                data-testid="diff-table-cells"
                className="grid grid-cols-2 gap-1.5 text-[11px] font-mono mt-0.5"
              >
                {/* 1. Current Local File */}
                <button
                  onClick={() => handleSelectSource(idx, 'current')}
                  className={`p-2 rounded-lg border text-left flex flex-col truncate transition-all ${
                    field.selectedSource === 'current'
                      ? 'bg-white/[0.12] border-white/50 text-white font-bold ring-1 ring-white/30'
                      : 'bg-white/[0.02] border-white/[0.04] text-[#64748B] hover:text-[#94A3B8]'
                  }`}
                >
                  <span className="text-[9px] text-[#64748B] uppercase font-bold flex items-center justify-between">
                    <span>Local</span>
                    {field.selectedSource === 'current' && <Check className="w-2.5 h-2.5 text-white" />}
                  </span>
                  {isArtField ? (
                    <div className="flex items-center gap-2 mt-1">
                      <ArtworkHoverPreview
                        src={localCoverUrl}
                        alt="Local Disk Artwork"
                        title={track?.title || release?.title}
                        subtitle={track?.artistCredit || release?.artistCredit}
                        composer={track?.composerName || release?.composerName}
                        resolution={currentData.artResolution || 'Original Disk'}
                        provider="local"
                        disabled={!localCoverUrl || Boolean(imgErrors['local'])}
                        previewSize={280}
                      >
                        <div className="w-9 h-9 rounded-md bg-black/50 border border-white/10 shrink-0 overflow-hidden flex items-center justify-center cursor-pointer shadow-sm">
                          {localCoverUrl && !imgErrors['local'] ? (
                            <img
                              src={localCoverUrl}
                              alt="Local Artwork"
                              onError={() => setImgErrors((prev) => ({ ...prev, local: true }))}
                              className="w-full h-full object-cover hover:scale-105 transition-transform"
                            />
                          ) : (
                            <ImageIcon className="w-4 h-4 text-[#64748B]" />
                          )}
                        </div>
                      </ArtworkHoverPreview>
                      <div className="flex flex-col truncate">
                        <span className="truncate text-[10px] text-[#CBD5E1]">
                          {field.currentValue || 'Local Scan'}
                        </span>
                        <span className="text-[8px] text-[#64748B] uppercase">Local File</span>
                      </div>
                    </div>
                  ) : (
                    <span className="truncate mt-0.5 text-[#CBD5E1]">
                      {field.currentValue || '<empty>'}
                    </span>
                  )}
                </button>

                {/* 2. Apple iTunes */}
                <button
                  onClick={() => handleSelectSource(idx, 'itunes')}
                  disabled={!field.itunesValue}
                  className={`p-2 rounded-lg border text-left flex flex-col truncate transition-all disabled:opacity-25 ${
                    field.selectedSource === 'itunes'
                      ? 'bg-[#00F5FF]/15 border-[#00F5FF] text-[#00F5FF] font-bold ring-1 ring-[#00F5FF]/40'
                      : 'bg-white/[0.02] border-white/[0.04] text-[#64748B] hover:text-[#00F5FF]'
                  }`}
                >
                  <span className="text-[9px] text-[#00F5FF]/70 uppercase font-bold flex items-center justify-between">
                    <span>iTunes</span>
                    {field.selectedSource === 'itunes' && (
                      <Check className="w-2.5 h-2.5 text-[#00F5FF]" />
                    )}
                  </span>
                  {isArtField ? (
                    <div className="flex items-center gap-2 mt-1">
                      <ArtworkHoverPreview
                        src={itunesCandidate?.coverArtUrl}
                        alt="Apple Music Artwork"
                        title={itunesCandidate?.trackTitle || itunesCandidate?.releaseTitle}
                        subtitle={itunesCandidate?.artistCredit}
                        composer={itunesCandidate?.composer}
                        resolution={itunesCandidate?.coverResolution || '3000x3000px HD'}
                        provider="itunes"
                        disabled={!itunesCandidate?.coverArtUrl || Boolean(imgErrors['itunes'])}
                        previewSize={280}
                      >
                        <div className="w-9 h-9 rounded-md bg-black/50 border border-[#00F5FF]/20 shrink-0 overflow-hidden flex items-center justify-center cursor-pointer shadow-sm">
                          {isLoading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-[#00F5FF]" />
                          ) : itunesCandidate?.coverArtUrl && !imgErrors['itunes'] ? (
                            <img
                              src={itunesCandidate.coverArtUrl}
                              alt="Apple Artwork"
                              onError={() => setImgErrors((prev) => ({ ...prev, itunes: true }))}
                              className="w-full h-full object-cover hover:scale-105 transition-transform"
                            />
                          ) : (
                            <ImageIcon className="w-4 h-4 text-[#00F5FF]/40" />
                          )}
                        </div>
                      </ArtworkHoverPreview>
                      <div className="flex flex-col truncate">
                        <span className="truncate text-[10px] text-[#00F5FF]">
                          {field.itunesValue || '3000x3000px'}
                        </span>
                        <span className="text-[8px] text-[#00F5FF]/60 uppercase">Apple Music HD</span>
                      </div>
                    </div>
                  ) : (
                    <span className="truncate mt-0.5 text-[#00F5FF]">
                      {field.itunesValue || '<no match>'}
                    </span>
                  )}
                </button>

                {/* 3. MusicBrainz */}
                <button
                  onClick={() => handleSelectSource(idx, 'musicbrainz')}
                  disabled={!field.musicbrainzValue}
                  className={`p-2 rounded-lg border text-left flex flex-col truncate transition-all disabled:opacity-25 ${
                    field.selectedSource === 'musicbrainz'
                      ? 'bg-[#ADFF2F]/15 border-[#ADFF2F] text-[#ADFF2F] font-bold ring-1 ring-[#ADFF2F]/40'
                      : 'bg-white/[0.02] border-white/[0.04] text-[#64748B] hover:text-[#ADFF2F]'
                  }`}
                >
                  <span className="text-[9px] text-[#ADFF2F]/70 uppercase font-bold flex items-center justify-between">
                    <span>MusicBrainz</span>
                    {field.selectedSource === 'musicbrainz' && (
                      <Check className="w-2.5 h-2.5 text-[#ADFF2F]" />
                    )}
                  </span>
                  {isArtField ? (
                    <div className="flex items-center gap-2 mt-1">
                      <ArtworkHoverPreview
                        src={mbCandidate?.coverArtUrl}
                        alt="MusicBrainz CAA Artwork"
                        title={mbCandidate?.trackTitle || mbCandidate?.releaseTitle}
                        subtitle={mbCandidate?.artistCredit}
                        composer={mbCandidate?.composer}
                        resolution={mbCandidate?.coverResolution || 'CAA Scan'}
                        provider="musicbrainz"
                        disabled={!mbCandidate?.coverArtUrl || Boolean(imgErrors['mb'])}
                        previewSize={280}
                      >
                        <div className="w-9 h-9 rounded-md bg-black/50 border border-[#ADFF2F]/20 shrink-0 overflow-hidden flex items-center justify-center cursor-pointer shadow-sm">
                          {isLoading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-[#ADFF2F]" />
                          ) : mbCandidate?.coverArtUrl && !imgErrors['mb'] ? (
                            <img
                              src={mbCandidate.coverArtUrl}
                              alt="MusicBrainz CAA"
                              onError={() => setImgErrors((prev) => ({ ...prev, mb: true }))}
                              className="w-full h-full object-cover hover:scale-105 transition-transform"
                            />
                          ) : (
                            <AlertCircle className="w-4 h-4 text-[#ADFF2F]/40" />
                          )}
                        </div>
                      </ArtworkHoverPreview>
                      <div className="flex flex-col truncate">
                        <span className="truncate text-[10px] text-[#ADFF2F]">
                          {field.musicbrainzValue || 'Cover Art Archive'}
                        </span>
                        <span className="text-[8px] text-[#ADFF2F]/60 uppercase">
                          {mbCandidate?.coverArtUrl && !imgErrors['mb'] ? 'CAA Scan' : 'No CAA Image'}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <span className="truncate mt-0.5 text-[#ADFF2F]">
                      {field.musicbrainzValue || '<no match>'}
                    </span>
                  )}
                </button>

                {/* 4. Gemini AI (On-Demand) */}
                <button
                  onClick={() => handleSelectSource(idx, 'ai')}
                  disabled={!field.aiValue}
                  className={`p-2 rounded-lg border text-left flex flex-col truncate transition-all disabled:opacity-25 ${
                    field.selectedSource === 'ai'
                      ? 'bg-[#8B5CF6]/20 border-[#8B5CF6] text-[#C084FC] font-bold ring-1 ring-[#8B5CF6]/40'
                      : 'bg-white/[0.02] border-white/[0.04] text-[#64748B] hover:text-[#C084FC]'
                  }`}
                >
                  <span className="text-[9px] text-[#C084FC] uppercase font-bold flex items-center justify-between">
                    <span className="flex items-center gap-1">
                      <Sparkles className="w-2.5 h-2.5 text-[#C084FC]" />
                      <span>Gemini AI</span>
                    </span>
                    {field.selectedSource === 'ai' && (
                      <Check className="w-2.5 h-2.5 text-[#C084FC]" />
                    )}
                  </span>
                  {isArtField ? (
                    <div className="flex items-center gap-2 mt-1">
                      <div className="w-9 h-9 rounded-md bg-black/50 border border-[#8B5CF6]/20 shrink-0 overflow-hidden flex items-center justify-center">
                        <Sparkles className="w-4 h-4 text-[#C084FC]" />
                      </div>
                      <div className="flex flex-col truncate">
                        <span className="truncate text-[10px] text-[#E9D5FF]">
                          {field.aiValue || (isAiLoading ? 'Resolving...' : 'Archival Scan')}
                        </span>
                        <span className="text-[8px] text-[#C084FC]/70 uppercase">AI Recommendation</span>
                      </div>
                    </div>
                  ) : (
                    <span className="truncate mt-0.5 text-[#E9D5FF]">
                      {field.aiValue || (isAiLoading ? 'Resolving...' : '<query AI>')}
                    </span>
                  )}
                </button>
              </div>

              {/* 5. Manual Entry Bar */}
              <div
                data-testid={`diff-manual-bar-${field.fieldName}`}
                className={`mt-1.5 p-1.5 rounded-lg border flex items-center gap-2 transition-all ${
                  field.selectedSource === 'manual'
                    ? 'bg-[#ADFF2F]/10 border-[#ADFF2F] ring-1 ring-[#ADFF2F]/40'
                    : 'bg-white/[0.02] border-white/[0.05] hover:border-white/[0.12]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleSelectSource(idx, 'manual')}
                  className={`px-2 py-1 rounded text-[10px] font-mono font-bold flex items-center gap-1 shrink-0 transition-all cursor-pointer ${
                    field.selectedSource === 'manual'
                      ? 'bg-[#ADFF2F] text-black shadow'
                      : 'bg-white/[0.06] text-[#94A3B8] hover:text-white hover:bg-white/[0.1]'
                  }`}
                  title="Select Manual Override for this field"
                >
                  <PenLine className="w-2.5 h-2.5" />
                  <span>Manual</span>
                  {field.selectedSource === 'manual' && <Check className="w-2.5 h-2.5 text-black stroke-[3]" />}
                </button>

                <input
                  type="text"
                  value={manualValues[field.fieldName] ?? field.customValue ?? ''}
                  onFocus={() => handleSelectSource(idx, 'manual')}
                  onChange={(e) => handleManualChange(field.fieldName, e.target.value, idx)}
                  placeholder={
                    isArtField
                      ? 'Enter custom artwork URL or resolution descriptor...'
                      : `Type manual ${field.label.toLowerCase()}...`
                  }
                  className="flex-1 bg-black/50 border border-white/[0.08] rounded px-2 py-1 text-[11px] font-mono text-white placeholder-[#64748B] focus:outline-none focus:border-[#ADFF2F]/70"
                />

                <button
                  type="button"
                  onClick={() => handleCopyActiveToManual(field, idx)}
                  className="px-2 py-0.5 rounded text-[9px] font-mono text-[#64748B] hover:text-[#ADFF2F] hover:bg-white/[0.05] border border-transparent hover:border-[#ADFF2F]/30 shrink-0 transition-colors cursor-pointer"
                  title="Copy current active candidate value into manual input"
                >
                  Copy Active
                </button>
              </div>
            </div>
          )
        })}

        {/* 4-Way Archival Front Artwork Comparison Tray */}
        <div className="p-3.5 rounded-2xl bg-white/[0.02] border border-white/[0.08] flex flex-col gap-3 shadow-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <ImageIcon className="w-4 h-4 text-[#00F5FF]" />
              <span className="text-xs font-bold text-white uppercase tracking-wider">
                Front Artwork Comparison
              </span>
            </div>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/[0.05] text-[#CBD5E1] border border-white/[0.08]">
              {artField?.selectedSource === 'itunes'
                ? 'Active: Apple HD (3000px)'
                : artField?.selectedSource === 'musicbrainz'
                ? 'Active: MusicBrainz CAA'
                : artField?.selectedSource === 'ai'
                ? 'Active: Gemini AI'
                : artField?.selectedSource === 'manual'
                ? 'Active: Manual Custom'
                : 'Active: Local Master'}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-left">
            {/* 1. Local Disk / Embedded Scan */}
            <ArtworkHoverPreview
              src={localCoverUrl}
              alt="Local Disk Front Artwork"
              title={track?.title || release?.title}
              subtitle={track?.artistCredit || release?.artistCredit}
              composer={track?.composerName || release?.composerName}
              resolution={currentData.artResolution || 'Original Disk'}
              provider="local"
              disabled={!localCoverUrl || Boolean(imgErrors['local'])}
              previewSize={280}
              className="w-full"
            >
              <div
                onClick={() => {
                  const artIdx = fields.findIndex((f) => f.fieldName === 'artResolution')
                  if (artIdx !== -1) handleSelectSource(artIdx, 'current')
                }}
                className={`w-full group cursor-pointer rounded-xl border p-2 flex flex-col gap-1.5 transition-all ${
                  artField?.selectedSource === 'current'
                    ? 'bg-white/[0.08] border-white ring-1 ring-white/40 shadow-md'
                    : 'bg-black/30 border-white/[0.06] hover:border-white/20'
                }`}
              >
                <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-black/60 border border-white/[0.08] flex items-center justify-center">
                  {localCoverUrl && !imgErrors['local'] ? (
                    <img
                      src={localCoverUrl}
                      alt="Local Front Artwork"
                      onError={() => setImgErrors((prev) => ({ ...prev, local: true }))}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center p-2 text-center text-[#64748B]">
                      <ImageIcon className="w-6 h-6 mb-1 opacity-50" />
                      <span className="text-[9px] font-mono">No Local Art</span>
                    </div>
                  )}
                  <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-sm text-[8px] font-mono font-bold text-white border border-white/10">
                    LOCAL
                  </div>
                  {artField?.selectedSource === 'current' && (
                    <div className="absolute top-1 right-1 p-0.5 rounded-full bg-white text-black shadow">
                      <Check className="w-2.5 h-2.5 stroke-[3]" />
                    </div>
                  )}
                </div>
                <div className="flex flex-col truncate">
                  <span className="text-[10px] font-bold text-white truncate">Local File Scan</span>
                  <span className="text-[9px] font-mono text-[#94A3B8] truncate">
                    {currentData.artResolution || 'Original Disk'}
                  </span>
                </div>
              </div>
            </ArtworkHoverPreview>

            {/* 2. Apple Music Archival Scan */}
            <ArtworkHoverPreview
              src={itunesCandidate?.coverArtUrl}
              alt="Apple Music Archival Scan"
              title={itunesCandidate?.trackTitle || itunesCandidate?.releaseTitle}
              subtitle={itunesCandidate?.artistCredit}
              composer={itunesCandidate?.composer}
              resolution="3000x3000px HD"
              provider="itunes"
              disabled={!itunesCandidate?.coverArtUrl || Boolean(imgErrors['itunes'])}
              previewSize={280}
              className="w-full"
            >
              <div
                onClick={() => {
                  if (itunesCandidate?.coverArtUrl) {
                    const artIdx = fields.findIndex((f) => f.fieldName === 'artResolution')
                    if (artIdx !== -1) handleSelectSource(artIdx, 'itunes')
                  }
                }}
                className={`w-full group rounded-xl border p-2 flex flex-col gap-1.5 transition-all ${
                  itunesCandidate?.coverArtUrl ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'
                } ${
                  artField?.selectedSource === 'itunes'
                    ? 'bg-[#00F5FF]/15 border-[#00F5FF] ring-1 ring-[#00F5FF]/50 shadow-md shadow-[#00F5FF]/10'
                    : 'bg-black/30 border-white/[0.06] hover:border-[#00F5FF]/30'
                }`}
              >
                <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-black/60 border border-white/[0.08] flex items-center justify-center">
                  {isLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin text-[#00F5FF]" />
                  ) : itunesCandidate?.coverArtUrl && !imgErrors['itunes'] ? (
                    <img
                      src={itunesCandidate.coverArtUrl}
                      alt="Apple Music Scan"
                      onError={() => setImgErrors((prev) => ({ ...prev, itunes: true }))}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center p-2 text-center text-[#64748B]">
                      <ImageIcon className="w-6 h-6 mb-1 opacity-50 text-[#00F5FF]" />
                      <span className="text-[9px] font-mono">No Apple Art</span>
                    </div>
                  )}
                  <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-sm text-[8px] font-mono font-bold text-[#00F5FF] border border-[#00F5FF]/20">
                    APPLE
                  </div>
                  {artField?.selectedSource === 'itunes' && (
                    <div className="absolute top-1 right-1 p-0.5 rounded-full bg-[#00F5FF] text-black shadow">
                      <Check className="w-2.5 h-2.5 stroke-[3]" />
                    </div>
                  )}
                </div>
                <div className="flex flex-col truncate">
                  <span className="text-[10px] font-bold text-[#00F5FF] truncate">Apple Music</span>
                  <span className="text-[9px] font-mono text-[#00F5FF]/70 truncate">
                    3000x3000px HD
                  </span>
                </div>
              </div>
            </ArtworkHoverPreview>

            {/* 3. MusicBrainz Cover Art Archive Scan */}
            <ArtworkHoverPreview
              src={mbCandidate?.coverArtUrl}
              alt="MusicBrainz CAA Scan"
              title={mbCandidate?.trackTitle || mbCandidate?.releaseTitle}
              subtitle={mbCandidate?.artistCredit}
              composer={mbCandidate?.composer}
              resolution="CAA Archival Scan"
              provider="musicbrainz"
              disabled={!mbCandidate?.coverArtUrl || Boolean(imgErrors['mb'])}
              previewSize={280}
              className="w-full"
            >
              <div
                onClick={() => {
                  if (mbCandidate?.coverArtUrl) {
                    const artIdx = fields.findIndex((f) => f.fieldName === 'artResolution')
                    if (artIdx !== -1) handleSelectSource(artIdx, 'musicbrainz')
                  }
                }}
                className={`w-full group rounded-xl border p-2 flex flex-col gap-1.5 transition-all ${
                  mbCandidate?.coverArtUrl ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'
                } ${
                  artField?.selectedSource === 'musicbrainz'
                    ? 'bg-[#ADFF2F]/15 border-[#ADFF2F] ring-1 ring-[#ADFF2F]/50 shadow-md shadow-[#ADFF2F]/10'
                    : 'bg-black/30 border-white/[0.06] hover:border-[#ADFF2F]/30'
                }`}
              >
                <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-black/60 border border-white/[0.08] flex items-center justify-center">
                  {isLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin text-[#ADFF2F]" />
                  ) : mbCandidate?.coverArtUrl && !imgErrors['mb'] ? (
                    <img
                      src={mbCandidate.coverArtUrl}
                      alt="MusicBrainz Scan"
                      onError={() => setImgErrors((prev) => ({ ...prev, mb: true }))}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center p-2 text-center text-[#64748B]">
                      <AlertCircle className="w-5 h-5 mb-1 text-[#ADFF2F]/60" />
                      <span className="text-[9px] font-mono text-[#94A3B8]">No CAA Scan</span>
                    </div>
                  )}
                  <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-sm text-[8px] font-mono font-bold text-[#ADFF2F] border border-[#ADFF2F]/20">
                    MB CAA
                  </div>
                  {artField?.selectedSource === 'musicbrainz' && (
                    <div className="absolute top-1 right-1 p-0.5 rounded-full bg-[#ADFF2F] text-black shadow">
                      <Check className="w-2.5 h-2.5 stroke-[3]" />
                    </div>
                  )}
                </div>
                <div className="flex flex-col truncate">
                  <span className="text-[10px] font-bold text-[#ADFF2F] truncate">MusicBrainz</span>
                  <span className="text-[9px] font-mono text-[#ADFF2F]/70 truncate">
                    {mbCandidate?.coverArtUrl && !imgErrors['mb'] ? 'Archive 500px' : 'No CAA Upload'}
                  </span>
                </div>
              </div>
            </ArtworkHoverPreview>

            {/* 4. Manual / Custom URL Art */}
            <ArtworkHoverPreview
              src={manualValues['artResolution']}
              alt="Custom Artwork"
              title="Custom Uploaded Artwork"
              provider="custom"
              disabled={!manualValues['artResolution'] || Boolean(imgErrors['manual'])}
              previewSize={280}
              className="w-full"
            >
              <div
                onClick={() => {
                  const artIdx = fields.findIndex((f) => f.fieldName === 'artResolution')
                  if (artIdx !== -1) handleSelectSource(artIdx, 'manual')
                }}
                className={`w-full group cursor-pointer rounded-xl border p-2 flex flex-col gap-1.5 transition-all ${
                  artField?.selectedSource === 'manual'
                    ? 'bg-[#ADFF2F]/15 border-[#ADFF2F] ring-1 ring-[#ADFF2F]/50 shadow-md shadow-[#ADFF2F]/10'
                    : 'bg-black/30 border-white/[0.06] hover:border-[#ADFF2F]/30'
                }`}
              >
                <div className="relative aspect-square w-full rounded-lg overflow-hidden bg-black/60 border border-white/[0.08] flex items-center justify-center">
                  {manualValues['artResolution'] && !imgErrors['manual'] ? (
                    <img
                      src={manualValues['artResolution']}
                      alt="Manual Artwork"
                      onError={() => setImgErrors((prev) => ({ ...prev, manual: true }))}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center p-2 text-center text-[#64748B]">
                      <PenLine className="w-5 h-5 mb-1 text-[#ADFF2F]/60" />
                      <span className="text-[9px] font-mono text-[#94A3B8]">
                        {manualValues['artResolution'] ? 'Invalid URL' : 'Manual Entry'}
                      </span>
                    </div>
                  )}
                  <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-sm text-[8px] font-mono font-bold text-[#ADFF2F] border border-[#ADFF2F]/20">
                    MANUAL
                  </div>
                  {artField?.selectedSource === 'manual' && (
                    <div className="absolute top-1 right-1 p-0.5 rounded-full bg-[#ADFF2F] text-black shadow">
                      <Check className="w-2.5 h-2.5 stroke-[3]" />
                    </div>
                  )}
                </div>
                <div className="flex flex-col truncate">
                  <span className="text-[10px] font-bold text-[#CBD5E1] truncate">Custom Art</span>
                  <span className="text-[9px] font-mono text-[#94A3B8] truncate">
                    {manualValues['artResolution'] ? 'URL Direct' : 'Enter URL below'}
                  </span>
                </div>
              </div>
            </ArtworkHoverPreview>
          </div>

          {/* Cinematic Panoramic Backdrop Rework Option */}
          <div className="mt-1 p-2.5 rounded-xl bg-black/40 border border-white/[0.08] flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles className="w-4 h-4 text-[#00F5FF] shrink-0" />
              <div className="flex flex-col text-left min-w-0">
                <span className="text-[11px] font-bold text-white truncate">
                  Cinematic Album Backdrop
                </span>
                <span className="text-[9px] text-[#94A3B8] font-mono truncate">
                  Latest 2400×320 Atmospheric Derivative Method
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={async () => {
                const chosenCover =
                  (artField?.selectedSource === 'itunes' ? itunesCandidate?.coverArtUrl :
                   artField?.selectedSource === 'musicbrainz' ? mbCandidate?.coverArtUrl :
                   artField?.selectedSource === 'manual' ? manualValues['artResolution'] :
                   localCoverUrl) || release?.artwork?.frontCoverUrl || release?.coverArtUrl
                if (chosenCover && release) {
                  try {
                    const generated = await generatePanoramicBackdrop(chosenCover, 2400, 320)
                    if (generated) {
                      graphEngine.updateReleaseDetails(release.id, { backdropUrl: generated })
                      onApplyMerge({ backdropUrl: generated })
                    }
                  } catch (e) {
                    console.error('Failed to generate panoramic backdrop:', e)
                  }
                }
              }}
              className="px-2.5 py-1.5 rounded-lg bg-[#00F5FF]/15 hover:bg-[#00F5FF]/25 text-[#00F5FF] border border-[#00F5FF]/30 text-[10px] font-mono font-medium flex items-center gap-1 shrink-0 cursor-pointer transition-all shadow-sm"
              title="Generate 2400x320 cinematic panoramic derivative from chosen artwork source"
            >
              <Sparkles className="w-3 h-3 text-[#00F5FF]" />
              <span>Rework Backdrop</span>
            </button>
          </div>
        </div>
      </div>

      {/* Bottom Merge Staging Bar */}
      <div className="p-3 border-t border-white/[0.08] bg-[#12151F] shrink-0 flex flex-col gap-2">
        <button
          data-tutorial-id="btn-stage-selective-merge"
          data-testid="btn-stage-selective-merge"
          onClick={handleCommitMerge}
          className={`w-full py-2.5 rounded-xl font-mono font-bold text-xs transition-all flex items-center justify-center gap-1.5 shadow-lg cursor-pointer ${
            isJustStaged
              ? 'bg-[#10B981] text-black ring-2 ring-[#10B981]/50 shadow-[#10B981]/20'
              : 'bg-gradient-to-r from-[#ADFF2F] to-[#00F5FF] text-black hover:opacity-90 shadow-[#00F5FF]/10'
          }`}
        >
          {isJustStaged ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-black" />
              <span>Staged in Sidecar Buffer ✓ (Ready in Staged for Commit)</span>
            </>
          ) : (
            <>
              <Check className="w-4 h-4 stroke-[3]" />
              <span>
                Stage Selected Metadata
                {modifiedCount > 0 ? ` (${modifiedCount} updated)` : ''}
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
