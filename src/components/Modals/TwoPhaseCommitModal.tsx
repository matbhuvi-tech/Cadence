import React, { useState, useMemo } from 'react'
import {
  ShieldCheck,
  AlertTriangle,
  X,
  Check,
  RotateCcw,
  Loader2,
  HardDrive,
  CheckCircle2,
  Folder,
  Music,
  Disc3,
  User,
  Search,
  Layers,
  ArrowRight,
  FileCode,
  Trash2,
  Image as ImageIcon,
  Timer,
  Gauge,
  Activity,
  Radio,
  Zap,
} from 'lucide-react'
import { Release, Track } from '../../core/types'
import {
  transactionEngine,
  CommitStepProgress,
  DetailedCommitProgress,
} from '../../core/transactionEngine'

interface TwoPhaseCommitModalProps {
  uncommittedTracks: Track[]
  releases?: Release[]
  onClose: () => void
  onSuccess: () => void
  onDiscardAll?: () => void
  onDiscardTrack?: (trackId: string) => void
  onDiscardRelease?: (releaseId: string) => void
  onDiscardReleaseArtwork?: (releaseId: string) => void
  onDiscardAllArtwork?: () => void
}

interface FieldDiff {
  key: string
  label: string
  current: string
  proposed: string
  icon: React.FC<{ className?: string }>
}

function getTrackRealEdits(track: Track, release?: Release): FieldDiff[] {
  const pending = track.pendingSidecarEdits || {}
  const diffs: FieldDiff[] = []

  if (pending.trackNumber !== undefined && pending.trackNumber !== track.trackNumber) {
    diffs.push({
      key: 'trackNumber',
      label: 'Track Number',
      current: track.trackNumber ? `#${String(track.trackNumber).padStart(2, '0')}` : '<none>',
      proposed: `#${String(pending.trackNumber).padStart(2, '0')}`,
      icon: Music,
    })
  }

  if (pending.title && pending.title !== track.title) {
    diffs.push({
      key: 'title',
      label: 'Track Title',
      current: track.title,
      proposed: pending.title,
      icon: Music,
    })
  }

  const curAlbum = release?.title || track.folderName || ''
  const proposedAlbum = pending.album || pending.releaseTitle
  if (proposedAlbum && proposedAlbum !== curAlbum) {
    diffs.push({
      key: 'album',
      label: 'Album Title',
      current: curAlbum || '<none>',
      proposed: proposedAlbum,
      icon: Disc3,
    })
  }

  const curYear = release?.releaseYear || release?.originalYear
  if (pending.year !== undefined && !isNaN(Number(pending.year)) && Number(pending.year) !== curYear) {
    diffs.push({
      key: 'year',
      label: 'Release Year',
      current: curYear ? String(curYear) : '<empty>',
      proposed: String(pending.year),
      icon: Disc3,
    })
  }

  if (pending.artistCredit && pending.artistCredit !== track.artistCredit) {
    diffs.push({
      key: 'artistCredit',
      label: 'Artist Credit',
      current: track.artistCredit || '<empty>',
      proposed: pending.artistCredit,
      icon: User,
    })
  }

  const curComposer = track.composerName || ''
  if (pending.composerName && pending.composerName !== curComposer) {
    diffs.push({
      key: 'composerName',
      label: 'Composer',
      current: curComposer || '<empty>',
      proposed: pending.composerName,
      icon: User,
    })
  }

  if (pending.discNumber !== undefined && pending.discNumber !== track.discNumber) {
    diffs.push({
      key: 'discNumber',
      label: 'Disc Number',
      current: track.discNumber ? `Disc ${track.discNumber}` : '<none>',
      proposed: `Disc ${pending.discNumber}`,
      icon: Disc3,
    })
  }

  const curMov = track.movementNumber || ''
  if (pending.movementNumber !== undefined && pending.movementNumber !== curMov) {
    diffs.push({
      key: 'movementNumber',
      label: 'Movement',
      current: curMov || '<empty>',
      proposed: `Movement ${pending.movementNumber}`,
      icon: Music,
    })
  }

  const curFolder = track.folderName || ''
  if (pending.targetFolderName && pending.targetFolderName !== curFolder) {
    diffs.push({
      key: 'targetFolderName',
      label: 'Folder Rename',
      current: curFolder || 'Current Folder',
      proposed: `📁 ${pending.targetFolderName}`,
      icon: Folder,
    })
  }

  if (pending.targetFilePath && pending.targetFilePath !== track.filePath) {
    diffs.push({
      key: 'targetFilePath',
      label: 'File Move / Path',
      current: track.filePath.split(/[/\\]/).pop() || track.filePath,
      proposed: pending.targetFilePath.split(/[/\\]/).pop() || pending.targetFilePath,
      icon: HardDrive,
    })
  }

  if (pending.credits && Array.isArray(pending.credits)) {
    diffs.push({
      key: 'credits',
      label: 'Credits Matrix',
      current: `${(track as any).credits?.length || 0} performers`,
      proposed: `${pending.credits.length} linked performers`,
      icon: User,
    })
  }

  // Generic fallback for any other unknown fields
  Object.entries(pending).forEach(([k, val]) => {
    if (
      ![
        'title',
        'album',
        'releaseTitle',
        'artistCredit',
        'composerName',
        'trackNumber',
        'discNumber',
        'year',
        'coverArtUrl',
        'coverResolution',
        'movementNumber',
        'targetFolderName',
        'targetFilePath',
        'credits',
        'sidecarStatus',
      ].includes(k)
    ) {
      const curVal = String((track as any)[k] ?? '')
      const propVal = String(val ?? '')
      if (propVal && propVal !== curVal) {
        diffs.push({
          key: k,
          label: k.replace(/([A-Z])/g, ' $1'),
          current: curVal || '<empty>',
          proposed: propVal,
          icon: FileCode,
        })
      }
    }
  })

  return diffs
}

function formatDuration(seconds?: number): string {
  if (seconds === undefined || isNaN(seconds)) return 'Calculating...'
  if (seconds <= 0) return 'Almost done'
  if (seconds < 60) return `~${seconds}s remaining`
  const mins = Math.floor(seconds / 60)
  const remSecs = seconds % 60
  return `~${mins}m ${remSecs.toString().padStart(2, '0')}s remaining`
}

function formatElapsed(ms: number): string {
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

export const TwoPhaseCommitModal: React.FC<TwoPhaseCommitModalProps> = ({
  uncommittedTracks,
  releases = [],
  onClose,
  onSuccess,
  onDiscardAll,
  onDiscardTrack,
  onDiscardRelease,
  onDiscardReleaseArtwork,
  onDiscardAllArtwork,
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'pipeline'>('preview')
  const [filterCategory, setFilterCategory] = useState<'all' | 'metadata' | 'artwork'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [isCompleted, setIsCompleted] = useState(false)
  const [detailedProgress, setDetailedProgress] = useState<DetailedCommitProgress | null>(null)
  const [committedSummary, setCommittedSummary] = useState<{ total: number; embedded: number; sidecars: number } | null>(null)
  const [errorMessage, setErrorMessage] = useState<string>()
  const [lastTxId, setLastTxId] = useState<string>()
  const [progressSteps, setProgressSteps] = useState<CommitStepProgress[]>([
    { step: 'PREPARE', label: 'Phase 1: Validating storage mount locks and write access', completed: false },
    { step: 'VERIFY_STREAM_CHECKSUM', label: 'Phase 1: Stream MD5 and Vorbis comment validation', completed: false },
    { step: 'CREATE_BACKUP_SNAPSHOT', label: 'Phase 1: Generating atomic rollback snapshot', completed: false },
    { step: 'WRITE_EMBEDDED_TAGS', label: 'Phase 2: Atomic write to ID3v2.4 / Vorbis Atoms', completed: false },
    { step: 'FINALIZE', label: 'Phase 2: Updating sidecar ledger and transaction journal', completed: false },
  ])

  // Compute release lookup map
  const releaseMap = useMemo(() => {
    const map = new Map<string, Release>()
    releases.forEach((r) => map.set(r.id, r))
    return map
  }, [releases])

  // Compute category counts using strict real edits
  const metadataTracksCount = useMemo(() => {
    return uncommittedTracks.filter((t) => {
      const rel = releaseMap.get(t.releaseId)
      const realEdits = getTrackRealEdits(t, rel)
      return realEdits.length > 0
    }).length
  }, [uncommittedTracks, releaseMap])

  const artworkOnlyTracksCount = useMemo(() => {
    return uncommittedTracks.filter((t) => {
      const rel = releaseMap.get(t.releaseId)
      const realEdits = getTrackRealEdits(t, rel)
      return Boolean(t.pendingSidecarEdits?.coverArtUrl) && realEdits.length === 0
    }).length
  }, [uncommittedTracks, releaseMap])

  // Compute total pending tag edits count (excluding artwork duplicates)
  const totalTagEditsCount = useMemo(() => {
    return uncommittedTracks.reduce((acc, t) => {
      const rel = releaseMap.get(t.releaseId)
      const realEdits = getTrackRealEdits(t, rel)
      return acc + realEdits.length
    }, 0)
  }, [uncommittedTracks, releaseMap])

  // Count distinct albums with staged artwork
  const totalArtworkAlbumsCount = useMemo(() => {
    const relSet = new Set<string>()
    uncommittedTracks.forEach((t) => {
      if (t.pendingSidecarEdits?.coverArtUrl) {
        relSet.add(t.releaseId || t.folderName || 'unknown')
      }
    })
    return relSet.size
  }, [uncommittedTracks])

  // Filtered tracks based on category and search
  const filteredTracks = useMemo(() => {
    let list = uncommittedTracks.filter((t) => {
      const rel = releaseMap.get(t.releaseId)
      const realEdits = getTrackRealEdits(t, rel)
      const hasArtwork = Boolean(t.pendingSidecarEdits?.coverArtUrl)
      return realEdits.length > 0 || hasArtwork
    })

    if (filterCategory === 'metadata') {
      list = list.filter((t) => {
        const rel = releaseMap.get(t.releaseId)
        return getTrackRealEdits(t, rel).length > 0
      })
    } else if (filterCategory === 'artwork') {
      list = list.filter((t) => {
        const rel = releaseMap.get(t.releaseId)
        return Boolean(t.pendingSidecarEdits?.coverArtUrl) && getTrackRealEdits(t, rel).length === 0
      })
    }

    if (!searchQuery.trim()) return list
    const q = searchQuery.toLowerCase().trim()
    return list.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artistCredit.toLowerCase().includes(q) ||
        (t.composerName && t.composerName.toLowerCase().includes(q)) ||
        (t.folderName && t.folderName.toLowerCase().includes(q)) ||
        t.filePath.toLowerCase().includes(q)
    )
  }, [uncommittedTracks, releaseMap, filterCategory, searchQuery])

  // Group tracks by release/album
  const groupedByRelease = useMemo(() => {
    const map = new Map<string, { release?: Release; tracks: Track[] }>()
    filteredTracks.forEach((t) => {
      const relId = t.releaseId || 'unknown'
      if (!map.has(relId)) {
        const rel = releases.find((r) => r.id === relId)
        map.set(relId, { release: rel, tracks: [] })
      }
      map.get(relId)!.tracks.push(t)
    })
    return Array.from(map.entries())
  }, [filteredTracks, releases])

  const handleStartCommit = async () => {
    setIsRunning(true)
    setActiveTab('pipeline')
    setErrorMessage(undefined)
    setDetailedProgress(null)

    const initialCount = uncommittedTracks.length
    const result = await transactionEngine.executeTwoPhaseCommit(
      uncommittedTracks,
      `Batch Commit ${uncommittedTracks.length} tracks to embedded headers`,
      (updatedSteps) => setProgressSteps(updatedSteps),
      (progress) => setDetailedProgress(progress)
    )

    setIsRunning(false)
    if (result.success) {
      setCommittedSummary({
        total: result.committedCount ?? initialCount,
        embedded: result.embeddedHeadersCount ?? 0,
        sidecars: result.sidecarsCount ?? initialCount,
      })
      setIsCompleted(true)
      setLastTxId(result.transactionId)
      onSuccess()
    } else {
      setErrorMessage(result.error || 'Transaction aborted.')
    }
  }

  const handleRollback = () => {
    if (lastTxId) {
      transactionEngine.rollbackTransaction(lastTxId)
      setIsCompleted(false)
      setCommittedSummary(null)
      setErrorMessage('Transaction successfully rolled back from pre-commit snapshot.')
      onSuccess()
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div
        data-tutorial-id="modal-staged-commit-pipeline"
        className="bg-[#12151E] border border-white/[0.12] rounded-2xl w-full max-w-4xl max-h-[90vh] shadow-2xl overflow-hidden flex flex-col glow-cyan animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="p-4 px-6 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#10B981]/15 border border-[#10B981]/30 flex items-center justify-center text-[#10B981]">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div className="flex flex-col text-left">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-[#F1F5F9]">Staged for Commit</h2>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30 font-semibold uppercase tracking-wider">
                  2-Phase Safe Parity
                </span>
              </div>
              <span className="text-xs text-[#94A3B8]">
                Review all staged sidecar modifications before transactional commit to audio headers.
              </span>
            </div>
          </div>
          {!isRunning && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Tab & Metric Navigation Bar */}
        <div className="px-6 py-2.5 border-b border-white/[0.06] bg-[#0E1017] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('preview')}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                activeTab === 'preview'
                  ? 'bg-white/[0.1] text-white border border-white/20'
                  : 'text-[#94A3B8] hover:text-white'
              }`}
            >
              <Layers className="w-3.5 h-3.5 text-[#00F5FF]" />
              <span>Changes Preview ({uncommittedTracks.length})</span>
            </button>
            <button
              onClick={() => setActiveTab('pipeline')}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                activeTab === 'pipeline'
                  ? 'bg-white/[0.1] text-white border border-white/20'
                  : 'text-[#94A3B8] hover:text-white'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
              <span>Safety Pipeline (5 Steps)</span>
            </button>
          </div>

          {/* Quick Metrics */}
          <div className="flex items-center gap-2 text-xs font-mono">
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/[0.03] border border-white/[0.06] text-[#94A3B8]">
              <Disc3 className="w-3 h-3 text-[#00F5FF]" />
              <span>
                <strong className="text-white">{groupedByRelease.length}</strong> Albums
              </span>
            </div>
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/[0.03] border border-white/[0.06] text-[#94A3B8]">
              <FileCode className="w-3 h-3 text-[#ADFF2F]" />
              <span>
                <strong className="text-white">{totalTagEditsCount}</strong> Tag Edits
              </span>
            </div>
            {totalArtworkAlbumsCount > 0 && (
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/[0.03] border border-white/[0.06] text-[#94A3B8]">
                <ImageIcon className="w-3 h-3 text-[#C084FC]" />
                <span>
                  <strong className="text-white">{totalArtworkAlbumsCount}</strong> Art Updates
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4 text-left">
          {activeTab === 'preview' ? (
            <>
              {/* Filter Tabs & Search Bar */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  {/* Category Filter Pills */}
                  <div className="flex items-center gap-1 bg-black/40 p-1 rounded-xl border border-white/[0.06]">
                    <button
                      onClick={() => setFilterCategory('all')}
                      className={`px-3 py-1 rounded-lg text-xs font-mono font-semibold transition-all cursor-pointer ${
                        filterCategory === 'all'
                          ? 'bg-white/[0.12] text-white shadow-sm'
                          : 'text-[#94A3B8] hover:text-white'
                      }`}
                    >
                      All Staged ({uncommittedTracks.length})
                    </button>
                    <button
                      onClick={() => setFilterCategory('metadata')}
                      className={`px-3 py-1 rounded-lg text-xs font-mono font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                        filterCategory === 'metadata'
                          ? 'bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/30 shadow-sm'
                          : 'text-[#94A3B8] hover:text-white'
                      }`}
                    >
                      <Music className="w-3 h-3" />
                      <span>Tag & Metadata Edits ({metadataTracksCount})</span>
                    </button>
                    <button
                      onClick={() => setFilterCategory('artwork')}
                      className={`px-3 py-1 rounded-lg text-xs font-mono font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                        filterCategory === 'artwork'
                          ? 'bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/30 shadow-sm'
                          : 'text-[#94A3B8] hover:text-white'
                      }`}
                    >
                      <ImageIcon className="w-3 h-3" />
                      <span>Cover Artwork Only ({artworkOnlyTracksCount})</span>
                    </button>
                  </div>

                  {/* Search Input */}
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[#64748B]" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Filter by title, artist, album, path..."
                      className="w-full pl-9 pr-3 py-1.5 bg-black/40 border border-white/[0.08] rounded-xl text-xs text-white placeholder:text-[#64748B] focus:outline-none focus:border-[#00F5FF]/50 font-mono"
                    />
                  </div>
                </div>

                {/* Safe Non-Destructive Sidecar Staging Banner */}
                <div className="p-3 px-4 rounded-xl bg-gradient-to-r from-[#00F5FF]/10 via-white/[0.02] to-transparent border border-[#00F5FF]/20 text-xs flex items-start gap-3">
                  <ShieldCheck className="w-4 h-4 text-[#00F5FF] shrink-0 mt-0.5" />
                  <div className="flex-1 flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white font-mono">In-Memory / IndexedDB Sidecar Staging</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30">
                        Audio Files 100% Untouched
                      </span>
                    </div>
                    <p className="text-[#94A3B8] text-[11px] leading-relaxed">
                      All physical WAV/FLAC audio files on disk retain their original headers and file timestamps. Changes are staged non-destructively in local sidecar cache. You can safely discard unwanted changes using the buttons below.
                    </p>
                  </div>
                </div>
              </div>

              {uncommittedTracks.length === 0 ? (
                <div className="p-12 rounded-2xl bg-white/[0.01] border border-dashed border-white/[0.08] flex flex-col items-center justify-center text-center gap-2">
                  <CheckCircle2 className="w-10 h-10 text-[#10B981]/50" />
                  <h3 className="text-sm font-bold text-white">No Pending Changes Staged</h3>
                  <p className="text-xs text-[#94A3B8] max-w-sm">
                    All audio headers and sidecars are currently bit-perfect and synchronized with the relational library.
                  </p>
                </div>
              ) : filteredTracks.length === 0 ? (
                <div className="p-12 rounded-2xl bg-white/[0.01] border border-dashed border-white/[0.08] flex flex-col items-center justify-center text-center gap-2">
                  <Search className="w-10 h-10 text-[#64748B]/50" />
                  <h3 className="text-sm font-bold text-white">No Matching Staged Changes</h3>
                  <p className="text-xs text-[#94A3B8] max-w-sm">
                    No staged tracks match the selected filter category or search query.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {groupedByRelease.map(([relId, { release, tracks }]) => {
                    const albumTitle =
                      release?.title ||
                      tracks[0]?.pendingSidecarEdits?.album ||
                      tracks[0]?.folderName ||
                      'Album Release'
                    const folderName = release?.folderName || tracks[0]?.folderName
                    const stagedCoverArt = tracks.find((t) => t.pendingSidecarEdits?.coverArtUrl)?.pendingSidecarEdits?.coverArtUrl
                    const currentCoverArt =
                      release?.artwork?.originalFrontCoverUrl ||
                      (release?.artwork?.frontCoverUrl && release.artwork.frontCoverUrl !== stagedCoverArt
                        ? release.artwork.frontCoverUrl
                        : tracks[0]?.filePath
                        ? `/api/track-art?file=${encodeURIComponent(tracks[0].filePath)}`
                        : undefined)

                    return (
                      <div
                        key={relId}
                        className="rounded-2xl border border-white/[0.08] bg-[#0E1017]/80 overflow-hidden shadow-lg"
                      >
                        {/* Album Group Header */}
                        <div className="p-3.5 px-4 bg-white/[0.03] border-b border-white/[0.06] flex items-center justify-between">
                          <div className="flex items-center gap-3 truncate min-w-0">
                            <div className="w-9 h-9 rounded-lg bg-[#00F5FF]/10 border border-[#00F5FF]/30 flex items-center justify-center shrink-0 text-[#00F5FF]">
                              <Disc3 className="w-4 h-4" />
                            </div>
                            <div className="flex flex-col truncate min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-white truncate font-mono">
                                  {albumTitle}
                                </span>
                                {folderName && (
                                  <span
                                    className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#00F5FF]/10 text-[#00F5FF] border border-[#00F5FF]/20 flex items-center gap-1 shrink-0"
                                    title={`Physical Folder: ${folderName}`}
                                  >
                                    <Folder className="w-3 h-3" />
                                    <span>{folderName}</span>
                                  </span>
                                )}
                              </div>
                              <span className="text-[11px] text-[#94A3B8] truncate mt-0.5">
                                {release?.artistCredit || tracks[0]?.artistCredit || 'Artist'}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {stagedCoverArt && (
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#C084FC]/15 text-[#C084FC] border border-[#C084FC]/30 font-semibold">
                                Archival Art Staged
                              </span>
                            )}
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/[0.05] text-[#CBD5E1] shrink-0 border border-white/10">
                              {tracks.length} track{tracks.length > 1 ? 's' : ''} staged
                            </span>
                            {onDiscardRelease && (
                              <button
                                onClick={() => onDiscardRelease(relId)}
                                title="Discard all staged changes for this album"
                                className="p-1 rounded text-[#64748B] hover:text-[#F43F5E] hover:bg-white/[0.06] transition-all cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Staged Album Artwork Comparison Box */}
                        {stagedCoverArt && (
                          <div className="p-3 px-4 bg-black/40 border-b border-white/[0.06] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div className="flex items-center gap-4">
                              {/* Current Artwork */}
                              <div className="flex items-center gap-2.5">
                                <div className="w-12 h-12 rounded-lg bg-black/60 border border-white/10 overflow-hidden flex items-center justify-center shrink-0">
                                  {currentCoverArt ? (
                                    <img
                                      src={currentCoverArt}
                                      alt="Current Cover"
                                      className="w-full h-full object-cover"
                                      onError={(e) => {
                                        (e.target as HTMLElement).style.display = 'none'
                                      }}
                                    />
                                  ) : (
                                    <Disc3 className="w-6 h-6 text-[#64748B]" />
                                  )}
                                </div>
                                <div className="flex flex-col text-left">
                                  <span className="text-[10px] font-mono text-[#94A3B8] uppercase tracking-wider">Current Disk Art</span>
                                  <span className="text-xs font-mono font-medium text-[#CBD5E1]">
                                    {release?.artwork?.resolution || 'Local Audio Header'}
                                  </span>
                                </div>
                              </div>

                              {/* Arrow */}
                              <div className="flex items-center text-[#00F5FF] shrink-0 px-1">
                                <ArrowRight className="w-4 h-4" />
                              </div>

                              {/* Staged Archival Cover */}
                              <div className="flex items-center gap-2.5">
                                <div className="w-12 h-12 rounded-lg bg-black/60 border border-[#00F5FF]/40 overflow-hidden flex items-center justify-center shrink-0 shadow-md shadow-[#00F5FF]/10">
                                  <img
                                    src={stagedCoverArt}
                                    alt="Staged Archival Cover"
                                    className="w-full h-full object-cover"
                                    onError={(e) => {
                                      (e.target as HTMLElement).style.display = 'none'
                                    }}
                                  />
                                </div>
                                <div className="flex flex-col text-left">
                                  <span className="text-[10px] font-mono text-[#10B981] font-bold uppercase tracking-wider">
                                    Staged Archival Cover
                                  </span>
                                  <span className="text-xs font-mono font-bold text-[#10B981] truncate max-w-[220px]" title={stagedCoverArt}>
                                    Cover Art Archive / Online
                                  </span>
                                </div>
                              </div>
                            </div>

                            {onDiscardReleaseArtwork && (
                              <button
                                onClick={() => onDiscardReleaseArtwork(relId)}
                                className="px-2.5 py-1 rounded-lg text-[11px] font-mono text-[#94A3B8] hover:text-[#F43F5E] hover:bg-white/[0.05] border border-transparent hover:border-[#F43F5E]/30 transition-all cursor-pointer flex items-center gap-1 shrink-0 self-end sm:self-auto"
                                title="Discard staged cover art for this album and keep disk artwork"
                              >
                                <RotateCcw className="w-3 h-3" />
                                <span>Keep Disk Art</span>
                              </button>
                            )}
                          </div>
                        )}

                        {/* Staged Tracks in this Album */}
                        <div className="divide-y divide-white/[0.04]">
                          {tracks.map((track) => {
                            const realEdits = getTrackRealEdits(track, release)
                            const hasTrackMetadataEdits = realEdits.length > 0

                            return (
                              <div key={track.id} className="p-3 px-4 flex flex-col gap-2 hover:bg-white/[0.01] transition-colors">
                                {/* Track Title Bar */}
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 truncate min-w-0">
                                    <span className="text-xs font-mono font-bold text-white truncate">
                                      {track.trackNumber ? `#${String(track.trackNumber).padStart(2, '0')} • ` : ''}
                                      {track.title}
                                    </span>
                                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-white/[0.05] text-[#94A3B8] shrink-0">
                                      {track.sampleRateStr} {track.format}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30 font-semibold uppercase shrink-0">
                                      Staged in Sidecar
                                    </span>
                                    {onDiscardTrack && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          onDiscardTrack(track.id)
                                        }}
                                        title="Discard staged edits for this track and revert to synced"
                                        className="p-1 rounded text-[#64748B] hover:text-[#F43F5E] hover:bg-white/[0.06] transition-all cursor-pointer"
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {/* Physical File Path */}
                                <div className="text-[10px] font-mono text-[#64748B] truncate flex items-center gap-1.5">
                                  <HardDrive className="w-3 h-3 shrink-0 text-[#64748B]" />
                                  <span className="truncate">{track.filePath}</span>
                                </div>

                                {/* Field-by-Field Diff Comparison Table */}
                                {hasTrackMetadataEdits ? (
                                  <div className="mt-1 rounded-xl bg-black/40 border border-white/[0.06] overflow-hidden">
                                    <div className="grid grid-cols-12 gap-2 p-2 bg-white/[0.02] border-b border-white/[0.04] text-[10px] font-mono text-[#94A3B8] font-semibold uppercase tracking-wider">
                                      <div className="col-span-3">Target Field</div>
                                      <div className="col-span-4">Current Value on Disk</div>
                                      <div className="col-span-1 text-center"></div>
                                      <div className="col-span-4">Staged Value to Commit</div>
                                    </div>
                                    <div className="divide-y divide-white/[0.03] text-xs font-mono">
                                      {realEdits.map((diff) => {
                                        const IconComponent = diff.icon
                                        return (
                                          <div key={diff.key} className="grid grid-cols-12 gap-2 p-2 items-center hover:bg-white/[0.02]">
                                            <div className="col-span-3 text-[#CBD5E1] font-semibold flex items-center gap-1.5 truncate">
                                              <IconComponent className="w-3 h-3 text-[#00F5FF] shrink-0" />
                                              <span>{diff.label}</span>
                                            </div>
                                            <div className="col-span-4 text-[#F43F5E]/80 line-through truncate" title={diff.current}>
                                              {diff.current}
                                            </div>
                                            <div className="col-span-1 flex justify-center text-[#10B981]">
                                              <ArrowRight className="w-3 h-3" />
                                            </div>
                                            <div className="col-span-4 text-[#10B981] font-bold truncate" title={diff.proposed}>
                                              {diff.proposed}
                                            </div>
                                          </div>
                                        )
                                      })}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="mt-1 p-2 px-3 rounded-lg bg-white/[0.02] border border-white/[0.04] text-[11px] font-mono text-[#94A3B8] flex items-center justify-between">
                                    <span className="flex items-center gap-1.5 text-[#64748B]">
                                      <Check className="w-3.5 h-3.5 text-[#10B981]" />
                                      <span>Audio tags in sync with disk headers • Album artwork staged above</span>
                                    </span>
                                    {onDiscardTrack && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          onDiscardTrack(track.id)
                                        }}
                                        title="Unstage this track"
                                        className="text-[10px] text-[#64748B] hover:text-[#F43F5E] underline cursor-pointer"
                                      >
                                        Unstage
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            /* Safety Pipeline Tab */
            <div className="flex flex-col gap-4">
              {/* Live Commit Telemetry & Progress HUD (Active or Last Run) */}
              {(isRunning || detailedProgress || isCompleted) && (
                <div className="p-4 rounded-2xl bg-gradient-to-br from-[#0F172A]/90 via-[#0B0F19] to-black border border-white/[0.12] shadow-xl flex flex-col gap-4 relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-64 h-32 bg-[#00F5FF]/5 rounded-full blur-3xl pointer-events-none" />

                  {/* Header Bar: Status & Percentage */}
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2.5">
                      {isRunning ? (
                        <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-[#00F5FF]/15 border border-[#00F5FF]/30 text-[#00F5FF] text-xs font-mono font-semibold animate-pulse">
                          <span className="w-2 h-2 rounded-full bg-[#00F5FF] animate-ping" />
                          <span>COMMITTING IN PROGRESS</span>
                        </div>
                      ) : isCompleted ? (
                        <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-[#10B981]/15 border border-[#10B981]/30 text-[#10B981] text-xs font-mono font-semibold">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>COMMIT COMPLETE</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-white/[0.06] text-[#94A3B8] text-xs font-mono">
                          <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
                          <span>READY TO COMMIT</span>
                        </div>
                      )}
                      <span className="text-xs font-mono text-[#94A3B8]">
                        {detailedProgress
                          ? `${detailedProgress.processedTracks} of ${detailedProgress.totalTracks} tracks processed`
                          : `${uncommittedTracks.length} tracks queued`}
                      </span>
                    </div>

                    {/* Big Percentage */}
                    <div className="flex items-baseline gap-1 font-mono">
                      <span className="text-2xl font-black text-white tracking-tight">
                        {isCompleted ? '100' : detailedProgress ? detailedProgress.percent : '0'}
                      </span>
                      <span className="text-sm font-bold text-[#00F5FF]">%</span>
                    </div>
                  </div>

                  {/* Glowing Animated Progress Bar */}
                  <div className="w-full h-3 bg-black/70 rounded-full overflow-hidden border border-white/10 p-0.5 relative shadow-inner">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        isCompleted
                          ? 'bg-gradient-to-r from-[#10B981] to-[#ADFF2F] shadow-[0_0_12px_rgba(16,185,129,0.5)]'
                          : 'bg-gradient-to-r from-[#00F5FF] via-[#10B981] to-[#ADFF2F] shadow-[0_0_14px_rgba(0,245,255,0.6)]'
                      }`}
                      style={{
                        width: `${isCompleted ? 100 : Math.max(0, Math.min(100, detailedProgress?.percent ?? 0))}%`,
                      }}
                    />
                  </div>

                  {/* Telemetry Metric Cards Grid */}
                  <div className="grid grid-cols-3 gap-3 font-mono">
                    {/* ETA Card */}
                    <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-[#00F5FF]/10 border border-[#00F5FF]/20 flex items-center justify-center text-[#00F5FF] shrink-0">
                        <Timer className="w-4 h-4" />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-[10px] text-[#64748B] uppercase font-semibold">Estimated Time (ETA)</span>
                        <span className="text-xs font-bold text-white truncate">
                          {isCompleted ? 'Done' : isRunning ? formatDuration(detailedProgress?.etaSeconds) : '--'}
                        </span>
                        <span className="text-[10px] text-[#94A3B8]">
                          Elapsed: {formatElapsed(detailedProgress?.elapsedMs || 0)}
                        </span>
                      </div>
                    </div>

                    {/* Speed / Throughput Card */}
                    <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-[#ADFF2F]/10 border border-[#ADFF2F]/20 flex items-center justify-center text-[#ADFF2F] shrink-0">
                        <Zap className="w-4 h-4" />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-[10px] text-[#64748B] uppercase font-semibold">Speed / Throughput</span>
                        <span className="text-xs font-bold text-[#ADFF2F] truncate">
                          {detailedProgress?.throughputItemsPerSec ? `${detailedProgress.throughputItemsPerSec} files/s` : '--'}
                        </span>
                        <span className="text-[10px] text-[#94A3B8]">
                          Batch {detailedProgress?.currentBatchIndex || 1} of {detailedProgress?.totalBatches || 1}
                        </span>
                      </div>
                    </div>

                    {/* Active Sub-Phase Card */}
                    <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-[#C084FC]/10 border border-[#C084FC]/20 flex items-center justify-center text-[#C084FC] shrink-0">
                        <Activity className="w-4 h-4" />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-[10px] text-[#64748B] uppercase font-semibold">Active Sub-Phase</span>
                        <span className="text-xs font-bold text-white truncate" title={detailedProgress?.phaseLabel}>
                          {isCompleted ? 'All Phases Completed' : detailedProgress?.phaseLabel || 'Validating Mounts'}
                        </span>
                        <span className="text-[10px] text-[#94A3B8]">2-Phase Atomic ACID</span>
                      </div>
                    </div>
                  </div>

                  {/* "Currently Committing" Active Focus Card */}
                  {isRunning && detailedProgress?.currentTrack && (
                    <div className="p-3 rounded-xl bg-black/60 border border-[#00F5FF]/30 flex items-center justify-between gap-3 animate-in fade-in duration-200">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-[#00F5FF]/15 border border-[#00F5FF]/30 flex items-center justify-center text-[#00F5FF] shrink-0">
                          <Music className="w-4 h-4 animate-bounce" />
                        </div>
                        <div className="flex flex-col min-w-0 font-mono text-left">
                          <div className="flex items-center gap-2 truncate">
                            <span className="text-xs font-bold text-white truncate">
                              {detailedProgress.currentTrack.title || 'Untitled Track'}
                            </span>
                            <span className="text-[10px] text-[#94A3B8] truncate">
                              by {detailedProgress.currentTrack.artistCredit || 'Unknown Artist'}
                            </span>
                          </div>
                          <div className="text-[10px] text-[#64748B] truncate flex items-center gap-1.5 mt-0.5">
                            <HardDrive className="w-3 h-3 text-[#64748B] shrink-0" />
                            <span className="truncate">{detailedProgress.currentTrack.filePath}</span>
                          </div>
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center gap-2">
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30">
                          Embedding ID3v2.4 & Sidecar
                        </span>
                        <Loader2 className="w-4 h-4 text-[#00F5FF] animate-spin shrink-0" />
                      </div>
                    </div>
                  )}

                  {/* Recent Activity Live Stream */}
                  {detailedProgress?.recentCommittedTracks && detailedProgress.recentCommittedTracks.length > 0 && (
                    <div className="flex flex-col gap-1.5 pt-1 border-t border-white/[0.06]">
                      <div className="flex items-center justify-between text-[10px] font-mono text-[#64748B] uppercase tracking-wider">
                        <span>Recent Commit Activity Stream</span>
                        <span>Latest ({Math.min(5, detailedProgress.recentCommittedTracks.length)})</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        {detailedProgress.recentCommittedTracks.slice(0, 4).map((trk) => (
                          <div
                            key={trk.id}
                            className="px-2.5 py-1 rounded-lg bg-white/[0.02] border border-white/[0.04] flex items-center justify-between text-xs font-mono text-left"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <Check className="w-3 h-3 text-[#10B981] shrink-0 stroke-[3]" />
                              <span className="text-white text-[11px] font-semibold truncate">{trk.title}</span>
                              <span className="text-[#64748B] text-[10px] truncate">— {trk.artistCredit}</span>
                            </div>
                            <span className="text-[10px] text-[#10B981] font-mono shrink-0 ml-2">✓ Written</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Protocol Context Description */}
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.06] flex flex-col gap-2 text-left">
                <span className="text-xs font-bold text-white font-mono flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-[#10B981]" />
                  Two-Phase Commit Protocol
                </span>
                <p className="text-xs text-[#94A3B8] leading-relaxed">
                  Cadence Core uses a strict <strong className="text-white">Sidecar-First Architecture</strong>.
                  Before writing to any audio file on TrueNAS or local storage, Phase 1 verifies mount write-locks,
                  computes FLAC/WAV stream MD5/CRC checksums, and creates an atomic rollback snapshot.
                  Phase 2 writes metadata into headers (ID3v2.4, Vorbis Comments, MP4 atoms) and updates the transaction journal.
                </p>
              </div>

              {/* Progress Steps List */}
              <div className="flex flex-col gap-2">
                {progressSteps.map((step, idx) => (
                  <div
                    key={step.step}
                    className={`p-3.5 rounded-xl border text-xs flex items-center justify-between transition-all ${
                      step.completed
                        ? 'bg-[#10B981]/10 border-[#10B981]/30 text-white'
                        : step.hasError
                        ? 'bg-[#F43F5E]/10 border-[#F43F5E]/30 text-[#F43F5E]'
                        : isRunning && idx === progressSteps.findIndex((s) => !s.completed)
                        ? 'bg-[#00F5FF]/10 border-[#00F5FF]/40 text-[#00F5FF]'
                        : 'bg-white/[0.02] border-white/[0.04] text-[#64748B]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {step.completed ? (
                        <CheckCircle2 className="w-4 h-4 text-[#10B981]" />
                      ) : step.hasError ? (
                        <AlertTriangle className="w-4 h-4 text-[#F43F5E]" />
                      ) : isRunning && idx === progressSteps.findIndex((s) => !s.completed) ? (
                        <Loader2 className="w-4 h-4 text-[#00F5FF] animate-spin" />
                      ) : (
                        <div className="w-4 h-4 rounded-full border border-white/20 flex items-center justify-center text-[9px] font-mono">
                          {idx + 1}
                        </div>
                      )}
                      <span className="font-medium font-mono">{step.label}</span>
                    </div>

                    {step.detail && (
                      <span className="text-[10px] font-mono text-[#94A3B8]">{step.detail}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Error Notice */}
          {errorMessage && (
            <div className="p-3 rounded-xl bg-[#F43F5E]/10 border border-[#F43F5E]/30 text-xs text-[#F43F5E] flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Success Notice */}
          {isCompleted && (
            <div className="p-3.5 rounded-xl bg-[#10B981]/10 border border-[#10B981]/30 text-xs text-[#10B981] flex items-center justify-between">
              <div className="flex items-center gap-2 font-mono">
                <Check className="w-4 h-4 stroke-[3]" />
                <span>
                  All {committedSummary?.total ?? uncommittedTracks.length} files committed bit-perfectly (
                  {committedSummary && committedSummary.embedded > 0
                    ? `${committedSummary.embedded} audio headers embedded, ${committedSummary.sidecars} sidecars written`
                    : `${committedSummary?.sidecars ?? uncommittedTracks.length} sidecar ledgers updated on disk`}
                  ).
                </span>
              </div>
              <button
                onClick={handleRollback}
                className="text-[11px] font-mono underline hover:text-white flex items-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                Rollback Transaction
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 px-6 border-t border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <span className="text-[11px] font-mono text-[#64748B] flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
            <span>Two-Phase Rollback Snapshot Active</span>
          </span>
          <div className="flex items-center gap-3">
            {onDiscardAll && !isCompleted && uncommittedTracks.length > 0 && (
              <button
                onClick={onDiscardAll}
                disabled={isRunning}
                className="px-3.5 py-2 rounded-xl bg-[#F43F5E]/15 hover:bg-[#F43F5E]/25 text-[#F43F5E] border border-[#F43F5E]/30 font-mono font-semibold text-xs transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                title="Discard all staged sidecar edits without writing anything to disk"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Discard Staged ({uncommittedTracks.length})</span>
              </button>
            )}
            {onDiscardAllArtwork && !isCompleted && totalArtworkAlbumsCount > 0 && (
              <button
                onClick={onDiscardAllArtwork}
                disabled={isRunning}
                className="px-3 py-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-[#CBD5E1] border border-white/[0.1] font-mono font-medium text-xs transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                title="Discard staged online cover art across all albums and keep original disk artwork while preserving track tag edits"
              >
                <RotateCcw className="w-3.5 h-3.5 text-[#00F5FF]" />
                <span>Discard Artwork Only ({totalArtworkAlbumsCount})</span>
              </button>
            )}
            <button
              onClick={onClose}
              disabled={isRunning}
              className="px-4 py-2 rounded-lg text-xs font-mono font-medium text-[#94A3B8] hover:text-white cursor-pointer"
            >
              {isCompleted ? 'Close' : 'Cancel'}
            </button>
            {!isCompleted && uncommittedTracks.length > 0 && (
              <button
                onClick={handleStartCommit}
                disabled={isRunning}
                className="px-5 py-2 rounded-xl bg-[#10B981] text-black font-mono font-bold text-xs hover:bg-[#10B981]/90 transition-all flex items-center gap-1.5 disabled:opacity-50 cursor-pointer shadow-lg shadow-[#10B981]/20"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Committing Phase 1 & 2...
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Commit Staged Changes ({uncommittedTracks.length})
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
