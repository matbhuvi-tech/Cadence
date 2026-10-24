import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  Sparkles,
  Check,
  CheckCircle2,
  Music,
  Disc3,
  Image as ImageIcon,
  Loader2,
  AlertCircle,
  PenLine,
  User,
  Calendar,
  Hash,
  Building2,
  Barcode,
  Layers,
  X,
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

interface ConsolidatedCandidate {
  value: string
  sources: DiffSource[]
  badges: Array<{ label: string; colorClass: string }>
  isSelected: boolean
}

export const SideBySideDiff: React.FC<SideBySideDiffProps> = ({
  currentData,
  track,
  release,
  allReleases: _allReleases = [],
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

  // Direct Inline Editing state
  const [editingField, setEditingField] = useState<string | null>(null)
  const [inlineDraftValue, setInlineDraftValue] = useState<string>('')
  const inlineInputRef = useRef<HTMLInputElement>(null)

  // Reset user selection overrides and manual values ONLY when the track changes
  useEffect(() => {
    setUserSelectedSources({})
    setManualValues({})
    setEditingField(null)
    setIsJustStaged(false)
  }, [track?.id])

  // Auto-focus and select text when entering inline editing mode
  useEffect(() => {
    if (editingField && inlineInputRef.current) {
      inlineInputRef.current.focus()
      inlineInputRef.current.select()
    }
  }, [editingField])

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

  // Inline editing controls
  const handleStartEdit = (field: DiffField) => {
    setEditingField(field.fieldName)
    const currentVal = getActiveFieldValue(field) || field.currentValue || ''
    setInlineDraftValue(currentVal)
  }

  const handleCommitInlineEdit = (fieldName: string, index: number) => {
    handleManualChange(fieldName, inlineDraftValue, index)
    setEditingField(null)
  }

  const handleCancelInlineEdit = () => {
    setEditingField(null)
  }

  // Bulk selectors
  const handleBulkSelect = (source: DiffSource) => {
    const newChoices: Record<string, DiffSource> = {}
    fields.forEach((f) => {
      // Protect clean canonical composer from polluted multi-artist fallbacks
      if (f.fieldName === 'composer' && (source === 'itunes' || source === 'musicbrainz')) {
        const remoteComposer = source === 'itunes' ? f.itunesValue : f.musicbrainzValue
        const remoteArtist = source === 'itunes'
          ? fields.find((x) => x.fieldName === 'artist')?.itunesValue
          : fields.find((x) => x.fieldName === 'artist')?.musicbrainzValue

        const isPollutedFallback = Boolean(
          remoteComposer && (
            (remoteArtist && remoteComposer.trim() === remoteArtist.trim() && (remoteComposer.includes(',') || remoteComposer.includes('&'))) ||
            (f.currentValue && !f.currentValue.includes(',') && !f.currentValue.includes('&') && (remoteComposer.includes(',') || remoteComposer.includes('&') || remoteComposer.toLowerCase().includes('feat')))
          )
        )

        if (!remoteComposer || isPollutedFallback) {
          // Keep local canonical composer!
          newChoices[f.fieldName] = 'current'
          return
        }
      }

      newChoices[f.fieldName] = source
    })
    setUserSelectedSources(newChoices)
    setFields((prev) =>
      prev.map((f) => ({
        ...f,
        selectedSource: newChoices[f.fieldName] || source,
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

  // Calculate actual modified count: only counts non-local choices that actually differ from local disk
  const modifiedCount = fields.filter((f) => {
    if (f.fieldName === 'artResolution') {
      return f.selectedSource !== 'current'
    }
    const activeVal = getActiveFieldValue(f)
    return Boolean(
      f.selectedSource !== 'current' &&
      activeVal &&
      f.currentValue !== undefined &&
      activeVal.trim() !== f.currentValue.trim()
    )
  }).length

  const artField = useMemo(
    () => fields.find((f) => f.fieldName === 'artResolution'),
    [fields]
  )

  // Deduplicate and consolidate candidate rows per field (Refinement 1)
  const getConsolidatedCandidates = (field: DiffField): ConsolidatedCandidate[] => {
    const currentVal = field.currentValue || ''
    const itunesVal = field.itunesValue || ''
    const mbVal = field.musicbrainzValue || ''
    const aiVal = field.aiValue || ''
    const manualVal = manualValues[field.fieldName] ?? field.customValue

    const rawList: Array<{
      source: DiffSource
      label: string
      value: string
      colorClass: string
    }> = []

    // Always include Local baseline
    rawList.push({
      source: 'current',
      label: 'LOCAL',
      value: currentVal,
      colorClass: 'bg-white/[0.06] text-[#8E8E93] border-white/[0.08]',
    })

    // Apple Music (only if non-empty)
    if (itunesVal.trim()) {
      const isPerformerPollution = field.fieldName === 'composer' && Boolean(
        (field.itunesValue && fields.find((x) => x.fieldName === 'artist')?.itunesValue && field.itunesValue.trim() === fields.find((x) => x.fieldName === 'artist')?.itunesValue?.trim() && (itunesVal.includes(',') || itunesVal.includes('&'))) ||
        (currentVal && !currentVal.includes(',') && !currentVal.includes('&') && (itunesVal.includes(',') || itunesVal.includes('&') || itunesVal.toLowerCase().includes('feat')))
      )
      rawList.push({
        source: 'itunes',
        label: isPerformerPollution ? 'APPLE (Performer Fallback)' : 'APPLE',
        value: itunesVal.trim(),
        colorClass: isPerformerPollution
          ? 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/30'
          : 'bg-[#D4AF37]/15 text-[#D4AF37] border-[#D4AF37]/30',
      })
    }

    // MusicBrainz (only if non-empty)
    if (mbVal.trim()) {
      rawList.push({
        source: 'musicbrainz',
        label: 'MB',
        value: mbVal.trim(),
        colorClass: 'bg-[#4ADE80]/15 text-[#4ADE80] border-[#4ADE80]/30',
      })
    }

    // Gemini AI (only if non-empty)
    if (aiVal.trim()) {
      rawList.push({
        source: 'ai',
        label: 'AI',
        value: aiVal.trim(),
        colorClass: 'bg-[#818CF8]/15 text-[#818CF8] border-[#818CF8]/30',
      })
    }

    // Manual custom override (only if user has typed/saved)
    if (manualVal !== undefined && manualVal.trim() !== '') {
      rawList.push({
        source: 'manual',
        label: 'MANUAL',
        value: manualVal.trim(),
        colorClass: 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/30',
      })
    }

    // Group by trimmed value string
    const map = new Map<string, ConsolidatedCandidate>()

    for (const item of rawList) {
      const key = item.value
      const existing = map.get(key)
      if (existing) {
        existing.sources.push(item.source)
        existing.badges.push({ label: item.label, colorClass: item.colorClass })
        if (item.source === field.selectedSource) {
          existing.isSelected = true
        }
      } else {
        map.set(key, {
          value: item.value,
          sources: [item.source],
          badges: [{ label: item.label, colorClass: item.colorClass }],
          isSelected: item.source === field.selectedSource,
        })
      }
    }

    const result = Array.from(map.values())
    // Fallback: if no row explicitly has isSelected, default to the local matching row
    if (!result.some((r) => r.isSelected) && result.length > 0) {
      result[0].isSelected = true
    }

    return result
  }

  // Field icons mapping
  const getFieldIcon = (fieldName: string) => {
    switch (fieldName) {
      case 'trackTitle':
        return <Music className="w-3.5 h-3.5 text-[#D4AF37]" />
      case 'releaseTitle':
        return <Disc3 className="w-3.5 h-3.5 text-[#D4AF37]" />
      case 'artist':
        return <User className="w-3.5 h-3.5 text-[#D4AF37]" />
      case 'composer':
        return <span className="text-xs">🎼</span>
      case 'year':
        return <Calendar className="w-3.5 h-3.5 text-[#8E8E93]" />
      case 'catalogNo':
        return <Hash className="w-3.5 h-3.5 text-[#8E8E93]" />
      case 'label':
        return <Building2 className="w-3.5 h-3.5 text-[#8E8E93]" />
      case 'barcode':
        return <Barcode className="w-3.5 h-3.5 text-[#8E8E93]" />
      case 'matrix':
        return <Layers className="w-3.5 h-3.5 text-[#8E8E93]" />
      default:
        return <Disc3 className="w-3.5 h-3.5 text-[#8E8E93]" />
    }
  }

  // Filter text fields (artwork is handled in dedicated front artwork comparison section)
  const textFields = useMemo(
    () => fields.filter((f) => f.fieldName !== 'artResolution'),
    [fields]
  )

  return (
    <div className="flex flex-col h-full overflow-hidden text-left bg-[#0C0D10]">
      {/* 1. Header & Provider Status Bar */}
      <div className="p-3 border-b border-white/[0.06] bg-[#121316] flex flex-col gap-2.5 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#D4AF37]" />
            <span className="text-xs font-semibold uppercase tracking-wider text-[#F5F5F7]">
              Smart Match Studio
            </span>
          </div>

          {/* Batch Enrich Trigger Button (Virtual Grid Selected Tracks) */}
          {(onOpenBatchDiff || onOpenBatchAi) && (
            <button
              onClick={onOpenBatchDiff || onOpenBatchAi}
              title="Batch Enrich selected tracks across Apple Music, MusicBrainz, and Gemini AI"
              className="px-2.5 py-1 rounded-md bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-[10px] font-mono font-medium text-[#EDEDED] flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
            >
              <Sparkles className="w-3 h-3 text-[#D4AF37]" />
              <span>
                Batch (
                {selectedTrackIds && selectedTrackIds.size > 0
                  ? `${Math.min(25, selectedTrackIds.size)} Tracks`
                  : 'Selected'}
                )
              </span>
            </button>
          )}
        </div>

        {/* Live Authority Provider Selector Badges */}
        <div
          data-tutorial-id="diff-provider-selector"
          data-testid="diff-provider-selector"
          className="grid grid-cols-3 gap-1.5 text-[10px] font-mono"
        >
          {/* Apple Music Pill */}
          <div
            className={`px-2 py-1.5 rounded-md border flex items-center justify-between transition-colors ${
              itunesCandidate
                ? 'bg-[#D4AF37]/10 border-[#D4AF37]/35 text-[#D4AF37]'
                : isLoading
                ? 'bg-white/[0.02] border-white/[0.05] text-[#8E8E93] animate-pulse'
                : 'bg-white/[0.02] border-white/[0.05] text-[#636366]'
            }`}
          >
            <span className="font-semibold truncate">Apple Music</span>
            {itunesCandidate ? (
              <span className="text-[9px] px-1 py-0.2 rounded bg-[#D4AF37]/20 font-bold">LIVE</span>
            ) : isLoading ? (
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
            ) : (
              <span className="text-[9px] opacity-60">0</span>
            )}
          </div>

          {/* MusicBrainz Pill */}
          <div
            className={`px-2 py-1.5 rounded-md border flex items-center justify-between transition-colors ${
              mbCandidate
                ? 'bg-[#4ADE80]/10 border-[#4ADE80]/35 text-[#4ADE80]'
                : isLoading
                ? 'bg-white/[0.02] border-white/[0.05] text-[#8E8E93] animate-pulse'
                : 'bg-white/[0.02] border-white/[0.05] text-[#636366]'
            }`}
          >
            <span className="font-semibold truncate">MusicBrainz</span>
            {mbCandidate ? (
              <span className="text-[9px] px-1 py-0.2 rounded bg-[#4ADE80]/20 font-bold">LIVE</span>
            ) : isLoading ? (
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
            ) : (
              <span className="text-[9px] opacity-60">0</span>
            )}
          </div>

          {/* Gemini AI Action Pill */}
          <button
            type="button"
            data-tutorial-id="btn-query-gemini-ai"
            data-testid="btn-query-gemini-ai"
            onClick={!isAiLoading ? handleQuerySingleAi : undefined}
            disabled={isAiLoading}
            className={`px-2 py-1.5 rounded-md border flex items-center justify-between cursor-pointer transition-all ${
              aiCandidate
                ? 'bg-[#818CF8]/15 border-[#818CF8]/40 text-[#818CF8]'
                : 'bg-white/[0.03] hover:bg-white/[0.07] border-white/[0.07] text-[#8E8E93] hover:text-white'
            }`}
            title="Query Gemini AI on demand for canonical musicology"
          >
            <span className="font-semibold truncate flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-[#818CF8]" />
              <span>Gemini AI</span>
            </span>
            {isAiLoading ? (
              <Loader2 className="w-2.5 h-2.5 text-[#818CF8] animate-spin" />
            ) : aiCandidate ? (
              <span className="text-[9px] px-1 py-0.2 rounded bg-[#818CF8]/25 font-bold">READY</span>
            ) : (
              <span className="text-[9px] px-1 py-0.2 rounded bg-white/[0.08] text-[#8E8E93]">Ask</span>
            )}
          </button>
        </div>

        {/* Bulk Action Buttons */}
        <div className="flex items-center justify-between gap-1 pt-1.5 border-t border-white/[0.05] text-[10px] font-mono">
          <span className="text-[#8E8E93] text-[10px]">Apply All:</span>
          <div className="flex items-center gap-1 flex-wrap justify-end">
            <button
              onClick={() => handleBulkSelect('current')}
              className="px-2 py-0.5 rounded bg-white/[0.04] text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
            >
              Keep Local
            </button>
            {itunesCandidate && (
              <button
                onClick={() => handleBulkSelect('itunes')}
                className="px-2 py-0.5 rounded bg-[#D4AF37]/10 text-[#D4AF37] hover:bg-[#D4AF37]/20 border border-[#D4AF37]/25 font-semibold transition-colors cursor-pointer"
              >
                Use Apple
              </button>
            )}
            {mbCandidate && (
              <button
                onClick={() => handleBulkSelect('musicbrainz')}
                className="px-2 py-0.5 rounded bg-[#4ADE80]/10 text-[#4ADE80] hover:bg-[#4ADE80]/20 border border-[#4ADE80]/25 font-semibold transition-colors cursor-pointer"
              >
                Use MB
              </button>
            )}
            {aiCandidate && (
              <button
                onClick={() => handleBulkSelect('ai')}
                className="px-2 py-0.5 rounded bg-[#818CF8]/15 text-[#818CF8] hover:bg-[#818CF8]/25 border border-[#818CF8]/25 font-semibold transition-colors cursor-pointer"
              >
                Use AI
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 2. Metadata Comparison List: Full-Width Vertical Radio Stack */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
        {textFields.map((field, idx) => {
          const originalIdx = fields.findIndex((f) => f.fieldName === field.fieldName)
          const activeVal = getActiveFieldValue(field)

          // Refinement 3: [MODIFIED] badge only renders when non-local choice differs from local baseline
          const isDifferentFromLocal = Boolean(
            activeVal &&
            field.currentValue !== undefined &&
            activeVal.trim() !== field.currentValue.trim()
          )
          const isModified = field.selectedSource !== 'current' && isDifferentFromLocal

          // Check if already staged in sidecar
          const isStagedInSidecar = Boolean(
            track?.pendingSidecarEdits && (
              (field.fieldName === 'trackTitle' && track.pendingSidecarEdits.title) ||
              (field.fieldName === 'artist' && track.pendingSidecarEdits.artistCredit) ||
              (field.fieldName === 'composer' && track.pendingSidecarEdits.composerName) ||
              (field.fieldName === 'releaseTitle' && track.pendingSidecarEdits.album)
            )
          )

          const isEditing = editingField === field.fieldName
          const candidateOptions = getConsolidatedCandidates(field)

          return (
            <div
              key={field.fieldName}
              className={`p-2.5 rounded-xl border text-xs flex flex-col gap-2 transition-all ${
                isModified
                  ? 'bg-[#18191E] border-[#D4AF37]/30 shadow-sm'
                  : 'bg-[#121316] border-white/[0.05]'
              }`}
            >
              {/* Field Label Header */}
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[#EDEDED] font-semibold text-[11px] flex items-center gap-1.5 truncate">
                  {getFieldIcon(field.fieldName)}
                  <span className="uppercase tracking-wider truncate">{field.label}</span>
                </span>

                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Staged or Modified Badge */}
                  {isStagedInSidecar ? (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30 font-semibold flex items-center gap-1">
                      <Check className="w-2.5 h-2.5" />
                      <span>Staged</span>
                    </span>
                  ) : isModified ? (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/30 font-semibold uppercase tracking-wider">
                      Modified
                    </span>
                  ) : null}

                  {/* Inline Edit Toggle (Refinement 4) */}
                  <button
                    type="button"
                    onClick={() => {
                      if (isEditing) {
                        handleCancelInlineEdit()
                      } else {
                        handleStartEdit(field)
                      }
                    }}
                    title={isEditing ? 'Cancel inline editing (Esc)' : 'Edit text inline (or double click a candidate)'}
                    className={`p-1 rounded transition-colors cursor-pointer ${
                      isEditing
                        ? 'bg-[#D4AF37]/20 text-[#D4AF37]'
                        : 'text-[#8E8E93] hover:text-white hover:bg-white/[0.06]'
                    }`}
                  >
                    {isEditing ? <X className="w-3 h-3" /> : <PenLine className="w-3 h-3" />}
                  </button>
                </div>
              </div>

              {/* Direct Inline Editor View (Refinement 4) */}
              {isEditing ? (
                <div className="p-2 rounded-lg bg-black/60 border border-[#D4AF37]/50 flex flex-col gap-2 shadow-inner">
                  <div className="flex items-center gap-1.5">
                    <input
                      ref={inlineInputRef}
                      type="text"
                      value={inlineDraftValue}
                      onChange={(e) => setInlineDraftValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          handleCommitInlineEdit(field.fieldName, originalIdx)
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          handleCancelInlineEdit()
                        }
                      }}
                      placeholder={`Type manual ${field.label.toLowerCase()}...`}
                      className="flex-1 bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-xs text-white font-sans focus:outline-none focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37]"
                    />
                    <button
                      type="button"
                      onClick={() => handleCommitInlineEdit(field.fieldName, originalIdx)}
                      className="px-2.5 py-1.5 rounded bg-[#D4AF37] text-black text-xs font-semibold hover:bg-[#E0BC46] transition-colors shrink-0 cursor-pointer"
                    >
                      Done
                    </button>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-[#8E8E93] font-mono px-0.5">
                    <span>↵ Enter to save • Esc to cancel</span>
                    {field.itunesValue && (
                      <button
                        type="button"
                        onClick={() => setInlineDraftValue(field.itunesValue || '')}
                        className="hover:text-[#D4AF37] transition-colors cursor-pointer"
                      >
                        Copy Apple
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                /* Full-Width Vertical Radio Stack (Refinement 1 & 2) */
                <div
                  data-tutorial-id={idx === 0 ? 'diff-table-cells' : undefined}
                  data-testid={`diff-cells-${field.fieldName}`}
                  className="flex flex-col gap-1.5"
                >
                  {candidateOptions.map((cand, candIdx) => {
                    return (
                      <div
                        key={`${cand.value}-${candIdx}`}
                        onClick={() => {
                          const chosenSource = cand.sources.includes('current')
                            ? 'current'
                            : cand.sources[0]
                          handleSelectSource(originalIdx, chosenSource)
                        }}
                        onDoubleClick={() => handleStartEdit(field)}
                        title="Click to select • Double-click to edit inline"
                        className={`w-full text-left p-2 rounded-lg border transition-all cursor-pointer flex items-center justify-between gap-2.5 ${
                          cand.isSelected
                            ? 'bg-[#D4AF37]/[0.08] border-[#D4AF37]/50 text-white shadow-sm ring-1 ring-[#D4AF37]/20'
                            : 'bg-white/[0.02] border-white/[0.04] text-[#8E8E93] hover:bg-white/[0.05] hover:text-[#EDEDED]'
                        }`}
                      >
                        {/* Radio indicator + Provider Badges + Value string */}
                        <div className="flex items-start gap-2 min-w-0 flex-1">
                          {/* Radio circle */}
                          <div className="mt-0.5 shrink-0">
                            <div
                              className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center transition-colors ${
                                cand.isSelected
                                  ? 'border-[#D4AF37]'
                                  : 'border-white/20'
                              }`}
                            >
                              {cand.isSelected && (
                                <div className="w-1.5 h-1.5 rounded-full bg-[#D4AF37]" />
                              )}
                            </div>
                          </div>

                          {/* Consolidated Provider Badges (Refinement 1) */}
                          <div className="flex items-center gap-1 shrink-0 mt-0.5 flex-wrap">
                            {cand.badges.map((b, bIdx) => (
                              <span
                                key={bIdx}
                                className={`text-[9px] font-mono font-semibold uppercase px-1.5 py-0.2 rounded border ${b.colorClass}`}
                              >
                                {b.label}
                              </span>
                            ))}
                            {field.fieldName === 'composer' &&
                              !cand.sources.includes('current') &&
                              cand.value &&
                              (cand.value.includes(',') || cand.value.includes('&') || cand.value.toLowerCase().includes('feat')) &&
                              field.currentValue &&
                              !field.currentValue.includes(',') &&
                              !field.currentValue.includes('&') && (
                                <span
                                  title="Remote provider composer suggestion contains multi-performer credits"
                                  className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-white/[0.04] text-[#A1A1AA] border border-white/[0.08]"
                                >
                                  Performer Fallback
                                </span>
                            )}
                          </div>

                          {/* Value Text with line-clamp-2 (Refinement 2) */}
                          <span
                            className={`flex-1 text-[12px] font-sans break-words line-clamp-2 leading-snug ${
                              cand.isSelected ? 'text-[#F5F5F7] font-medium' : 'text-[#8E8E93]'
                            }`}
                            title={cand.value}
                          >
                            {cand.value || <span className="italic opacity-50">&lt;empty&gt;</span>}
                          </span>
                        </div>

                        {/* Right Checkmark */}
                        {cand.isSelected && (
                          <Check className="w-3.5 h-3.5 text-[#D4AF37] shrink-0" />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* 3. Front Artwork Comparison Tray (Warm Obsidian / Apple HIG Style) */}
        <div className="p-3.5 rounded-xl bg-[#121316] border border-white/[0.06] flex flex-col gap-3 shadow-md">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <ImageIcon className="w-4 h-4 text-[#D4AF37]" />
              <span className="text-xs font-semibold text-white uppercase tracking-wider">
                Front Artwork
              </span>
            </div>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/[0.05] text-[#8E8E93] border border-white/[0.08]">
              {artField?.selectedSource === 'itunes'
                ? 'Apple Music (3000px)'
                : artField?.selectedSource === 'musicbrainz'
                ? 'MusicBrainz CAA'
                : artField?.selectedSource === 'ai'
                ? 'Gemini AI'
                : artField?.selectedSource === 'manual'
                ? 'Manual URL'
                : 'Local Master'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-left">
            {/* 1. Local Disk Artwork */}
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
                className={`w-full group cursor-pointer rounded-lg border p-2 flex flex-col gap-1.5 transition-all ${
                  artField?.selectedSource === 'current'
                    ? 'bg-[#D4AF37]/10 border-[#D4AF37] ring-1 ring-[#D4AF37]/40 shadow-sm'
                    : 'bg-black/30 border-white/[0.06] hover:border-white/20'
                }`}
              >
                <div className="relative aspect-square w-full rounded-md overflow-hidden bg-black/60 border border-white/[0.08] flex items-center justify-center">
                  {localCoverUrl && !imgErrors['local'] ? (
                    <img
                      src={localCoverUrl}
                      alt="Local Front Artwork"
                      onError={() => setImgErrors((prev) => ({ ...prev, local: true }))}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center p-2 text-center text-[#636366]">
                      <ImageIcon className="w-5 h-5 mb-1 opacity-50" />
                      <span className="text-[9px] font-mono">No Local Art</span>
                    </div>
                  )}
                  <div className="absolute top-1 left-1 px-1.5 py-0.2 rounded bg-black/75 backdrop-blur-sm text-[8px] font-mono font-semibold text-white border border-white/10">
                    LOCAL
                  </div>
                  {artField?.selectedSource === 'current' && (
                    <div className="absolute top-1 right-1 p-0.5 rounded-full bg-[#D4AF37] text-black shadow">
                      <Check className="w-2.5 h-2.5 stroke-[3]" />
                    </div>
                  )}
                </div>
                <div className="flex flex-col truncate">
                  <span className="text-[10px] font-semibold text-white truncate">Local File Scan</span>
                  <span className="text-[9px] font-mono text-[#8E8E93] truncate">
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
                className={`w-full group rounded-lg border p-2 flex flex-col gap-1.5 transition-all ${
                  itunesCandidate?.coverArtUrl ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'
                } ${
                  artField?.selectedSource === 'itunes'
                    ? 'bg-[#D4AF37]/10 border-[#D4AF37] ring-1 ring-[#D4AF37]/40 shadow-sm'
                    : 'bg-black/30 border-white/[0.06] hover:border-[#D4AF37]/30'
                }`}
              >
                <div className="relative aspect-square w-full rounded-md overflow-hidden bg-black/60 border border-white/[0.08] flex items-center justify-center">
                  {isLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin text-[#D4AF37]" />
                  ) : itunesCandidate?.coverArtUrl && !imgErrors['itunes'] ? (
                    <img
                      src={itunesCandidate.coverArtUrl}
                      alt="Apple Music Scan"
                      onError={() => setImgErrors((prev) => ({ ...prev, itunes: true }))}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center p-2 text-center text-[#636366]">
                      <ImageIcon className="w-5 h-5 mb-1 opacity-50 text-[#D4AF37]" />
                      <span className="text-[9px] font-mono">No Apple Art</span>
                    </div>
                  )}
                  <div className="absolute top-1 left-1 px-1.5 py-0.2 rounded bg-black/75 backdrop-blur-sm text-[8px] font-mono font-semibold text-[#D4AF37] border border-[#D4AF37]/20">
                    APPLE
                  </div>
                  {artField?.selectedSource === 'itunes' && (
                    <div className="absolute top-1 right-1 p-0.5 rounded-full bg-[#D4AF37] text-black shadow">
                      <Check className="w-2.5 h-2.5 stroke-[3]" />
                    </div>
                  )}
                </div>
                <div className="flex flex-col truncate">
                  <span className="text-[10px] font-semibold text-[#D4AF37] truncate">Apple Music HD</span>
                  <span className="text-[9px] font-mono text-[#D4AF37]/70 truncate">
                    3000x3000px Master
                  </span>
                </div>
              </div>
            </ArtworkHoverPreview>
          </div>

          {/* Cinematic Panoramic Backdrop Rework Button */}
          <div className="p-2 rounded-lg bg-black/40 border border-white/[0.06] flex items-center justify-between gap-3">
            <div className="flex flex-col text-left min-w-0">
              <span className="text-[11px] font-semibold text-white truncate">
                Cinematic Backdrop (2400×320)
              </span>
              <span className="text-[9px] text-[#8E8E93] font-mono truncate">
                Atmospheric header derivative
              </span>
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
              className="px-2 py-1 rounded-md bg-white/[0.06] hover:bg-white/[0.1] text-[#D4AF37] border border-white/[0.08] text-[10px] font-mono font-medium flex items-center gap-1 shrink-0 cursor-pointer transition-all shadow-sm"
              title="Generate 2400x320 cinematic panoramic derivative from chosen artwork source"
            >
              <Sparkles className="w-3 h-3 text-[#D4AF37]" />
              <span>Rework</span>
            </button>
          </div>
        </div>
      </div>

      {/* 4. Bottom Staging Action Bar */}
      <div className="p-3 border-t border-white/[0.06] bg-[#121316] shrink-0 flex flex-col gap-2">
        <button
          data-tutorial-id="btn-stage-selective-merge"
          data-testid="btn-stage-selective-merge"
          onClick={handleCommitMerge}
          disabled={isJustStaged}
          className={`w-full py-2.5 rounded-xl font-semibold text-xs transition-all flex items-center justify-center gap-2 shadow-md cursor-pointer ${
            isJustStaged
              ? 'bg-[#10B981] text-[#0C0D10] ring-2 ring-[#10B981]/50'
              : modifiedCount > 0
              ? 'bg-[#D4AF37] hover:bg-[#E0BC46] text-[#0C0D10]'
              : 'bg-white/[0.08] hover:bg-white/[0.12] text-[#8E8E93] hover:text-white'
          }`}
        >
          {isJustStaged ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-[#0C0D10]" />
              <span>Staged in Sidecar Buffer</span>
            </>
          ) : (
            <>
              <Check className="w-4 h-4 stroke-[2.5]" />
              <span>
                {modifiedCount > 0
                  ? `Stage ${modifiedCount} Changes (Sidecar Buffer)`
                  : 'Keep Current (No Changes)'}
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
