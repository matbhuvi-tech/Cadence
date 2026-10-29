import React, { useState, useMemo, useEffect } from 'react'
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
  ChevronDown,
  ChevronUp,
  ChevronRight,
  RefreshCw,
  ZoomIn,
  Eye,
  Maximize2,
  Lock,
  Link,
} from 'lucide-react'
import { Release, Track } from '../../core/types'
import {
  transactionEngine,
  CommitStepProgress,
  DetailedCommitProgress,
} from '../../core/transactionEngine'
import {
  analyzeHeaderPadding,
  HeaderPaddingAnalysis,
  CommitUnitMetrics,
} from '../../types/commit'
import { useAudioPlayer } from '../../context/AudioPlayerContext'

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
  onUpdateReleaseArtwork?: (releaseId: string, url: string) => void
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

  // Track Number
  if (pending.trackNumber !== undefined) {
    const orig = (pending as any).originalTrackNumber
    if (orig !== undefined && orig !== pending.trackNumber) {
      diffs.push({
        key: 'trackNumber',
        label: 'Track Number',
        current: orig ? `#${String(orig).padStart(2, '0')}` : '<none>',
        proposed: `#${String(pending.trackNumber).padStart(2, '0')}`,
        icon: Music,
      })
    } else if (pending.trackNumber !== track.trackNumber) {
      diffs.push({
        key: 'trackNumber',
        label: 'Track Number',
        current: track.trackNumber ? `#${String(track.trackNumber).padStart(2, '0')}` : '<none>',
        proposed: `#${String(pending.trackNumber).padStart(2, '0')}`,
        icon: Music,
      })
    }
  }

  // Title
  if (pending.title) {
    const orig = (pending as any).originalTitle
    if (orig && orig !== pending.title) {
      diffs.push({
        key: 'title',
        label: 'Track Title',
        current: orig,
        proposed: pending.title,
        icon: Music,
      })
    } else if (pending.title !== track.title) {
      diffs.push({
        key: 'title',
        label: 'Track Title',
        current: track.title,
        proposed: pending.title,
        icon: Music,
      })
    }
  }

  // Album Title
  const curAlbum = release?.title || track.folderName || ''
  const proposedAlbum = pending.album || pending.releaseTitle
  if (proposedAlbum) {
    const orig = (pending as any).originalAlbum || (pending as any).originalReleaseTitle
    if (orig && orig !== proposedAlbum) {
      diffs.push({
        key: 'album',
        label: 'Album Title',
        current: orig,
        proposed: proposedAlbum,
        icon: Disc3,
      })
    } else if (proposedAlbum !== curAlbum) {
      diffs.push({
        key: 'album',
        label: 'Album Title',
        current: curAlbum || '<none>',
        proposed: proposedAlbum,
        icon: Disc3,
      })
    }
  }

  // Year
  const curYear = release?.releaseYear || release?.originalYear
  if (pending.year !== undefined && !isNaN(Number(pending.year))) {
    const orig = (pending as any).originalYear
    if (orig !== undefined && Number(orig) !== Number(pending.year)) {
      diffs.push({
        key: 'year',
        label: 'Release Year',
        current: String(orig),
        proposed: String(pending.year),
        icon: Disc3,
      })
    } else if (Number(pending.year) !== curYear) {
      diffs.push({
        key: 'year',
        label: 'Release Year',
        current: curYear ? String(curYear) : '<empty>',
        proposed: String(pending.year),
        icon: Disc3,
      })
    }
  }

  // Artist Credit
  if (pending.artistCredit) {
    const orig = (pending as any).originalArtistCredit
    if (orig && orig !== pending.artistCredit) {
      diffs.push({
        key: 'artistCredit',
        label: 'Artist Credit',
        current: orig,
        proposed: pending.artistCredit,
        icon: User,
      })
    } else if (pending.artistCredit !== track.artistCredit) {
      diffs.push({
        key: 'artistCredit',
        label: 'Artist Credit',
        current: track.artistCredit || '<empty>',
        proposed: pending.artistCredit,
        icon: User,
      })
    }
  }

  // Album Artist
  const curAlbumArtist = track.albumArtist || release?.artistCredit || ''
  if (pending.albumArtist) {
    const orig = (pending as any).originalAlbumArtist
    if (orig && orig !== pending.albumArtist) {
      diffs.push({
        key: 'albumArtist',
        label: 'Album Artist',
        current: orig,
        proposed: pending.albumArtist,
        icon: User,
      })
    } else if (pending.albumArtist !== curAlbumArtist) {
      diffs.push({
        key: 'albumArtist',
        label: 'Album Artist',
        current: curAlbumArtist || '<empty>',
        proposed: pending.albumArtist,
        icon: User,
      })
    }
  }

  // Composer Name
  const curComposer = track.composerName || ''
  if (pending.composerName) {
    const orig = (pending as any).originalComposerName
    if (orig && orig !== pending.composerName) {
      diffs.push({
        key: 'composerName',
        label: 'Composer',
        current: orig,
        proposed: pending.composerName,
        icon: User,
      })
    } else if (pending.composerName !== curComposer) {
      diffs.push({
        key: 'composerName',
        label: 'Composer',
        current: curComposer || '<empty>',
        proposed: pending.composerName,
        icon: User,
      })
    }
  }

  // Disc Number
  if (pending.discNumber !== undefined) {
    const orig = (pending as any).originalDiscNumber
    if (orig !== undefined && orig !== pending.discNumber) {
      diffs.push({
        key: 'discNumber',
        label: 'Disc Number',
        current: orig ? `Disc ${orig}` : '<none>',
        proposed: `Disc ${pending.discNumber}`,
        icon: Disc3,
      })
    } else if (pending.discNumber !== track.discNumber) {
      diffs.push({
        key: 'discNumber',
        label: 'Disc Number',
        current: track.discNumber ? `Disc ${track.discNumber}` : '<none>',
        proposed: `Disc ${pending.discNumber}`,
        icon: Disc3,
      })
    }
  }

  // Movement
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
        'originalArtistCredit',
        'originalComposerName',
        'originalTrackNumber',
        'originalDiscNumber',
        'originalYear',
        'originalAlbum',
        'originalTitle',
        'originalReleaseTitle',
      ].includes(k)
    ) {
      const curVal = String((track as any)[k] ?? '')
      const propVal = String(val ?? '')
      if (propVal && (propVal !== curVal || !(k in track))) {
        diffs.push({
          key: k,
          label: k.replace(/([A-Z])/g, ' $1'),
          current: curVal || '<none>',
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
  const secInt = Math.floor(seconds)
  if (secInt < 60) return `~${secInt}s remaining`
  const mins = Math.floor(secInt / 60)
  const remSecs = secInt % 60
  return `~${mins}m ${remSecs.toString().padStart(2, '0')}s remaining`
}

function formatElapsed(ms: number): string {
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

interface ArtworkZoomThumbnailProps {
  url?: string
  label: string
  resolution?: string
  isStaged?: boolean
  onClick?: () => void
}

const ArtworkZoomThumbnail: React.FC<ArtworkZoomThumbnailProps> = ({
  url,
  label,
  resolution,
  isStaged,
  onClick,
}) => {
  const [imageError, setImageError] = useState(false)

  return (
    <div
      onClick={onClick}
      className={`w-14 h-14 rounded-xl overflow-hidden flex items-center justify-center shrink-0 cursor-pointer relative group/art transition-all duration-200 hover:scale-105 ${
        isStaged
          ? 'bg-black/70 border-2 border-emerald-400/80 shadow-md shadow-emerald-500/20'
          : 'bg-black/70 border border-white/20 hover:border-white/40'
      }`}
      title={`${label} (${resolution || ''}) • Click to inspect in Archival Pane`}
    >
      {url && !imageError ? (
        <img
          src={url}
          alt={label}
          className="w-full h-full object-cover"
          onError={() => setImageError(true)}
        />
      ) : (
        <Disc3 className="w-6 h-6 text-zinc-500" />
      )}

      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/art:opacity-100 transition-opacity flex items-center justify-center">
        <ZoomIn className="w-4 h-4 text-white drop-shadow" />
      </div>
    </div>
  )
}

interface ArtworkDisplayCardProps {
  url?: string
  label: string
  badgeText: string
  badgeColor?: 'zinc' | 'purple' | 'emerald'
  resolution?: string
  isStaged?: boolean
  emptyTitle?: string
  emptySubtitle?: string
  onClick?: () => void
  className?: string
}

const ArtworkDisplayCard: React.FC<ArtworkDisplayCardProps> = ({
  url,
  label,
  badgeText,
  badgeColor = 'zinc',
  resolution,
  isStaged = false,
  emptyTitle = 'No Embedded Artwork',
  emptySubtitle = 'Audio container has no embedded APIC / picture chunk',
  onClick,
  className = '',
}) => {
  const [hasError, setHasError] = useState(false)

  useEffect(() => {
    setHasError(false)
  }, [url])

  const showImage = Boolean(url) && !hasError

  return (
    <div className={`flex flex-col gap-1.5 flex-1 min-w-0 ${className}`}>
      <div
        onClick={onClick}
        className={`aspect-square max-h-48 w-full rounded-xl bg-[#090a0f] border overflow-hidden relative group transition-all flex flex-col items-center justify-center ${
          isStaged
            ? 'border-purple-500/40 hover:border-purple-400 hover:shadow-[0_0_15px_rgba(168,85,247,0.2)]'
            : 'border-white/10 hover:border-white/20'
        } ${onClick ? 'cursor-pointer' : ''}`}
      >
        {showImage ? (
          <img
            src={url}
            alt={label}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            onError={() => setHasError(true)}
          />
        ) : (
          <div className="p-3 w-full h-full flex flex-col items-center justify-center text-center gap-1.5 bg-[#0a0c13]/90 select-none">
            <Disc3 className="w-8 h-8 text-zinc-600 stroke-[1.5]" />
            <span className="text-[11px] font-mono font-medium text-zinc-300">{emptyTitle}</span>
            <span className="text-[9px] font-mono text-zinc-500 max-w-[150px] leading-tight">
              {emptySubtitle}
            </span>
          </div>
        )}

        {/* Badge in top-left */}
        <div
          className={`absolute top-2 left-2 px-2 py-0.5 rounded-md text-[9px] font-mono backdrop-blur-md border ${
            badgeColor === 'purple'
              ? 'bg-purple-950/85 text-purple-200 border-purple-500/40'
              : badgeColor === 'emerald'
              ? 'bg-emerald-950/85 text-emerald-200 border-emerald-500/40'
              : 'bg-black/80 text-zinc-300 border-white/10'
          }`}
        >
          {badgeText}
        </div>

        {showImage && onClick && (
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
            <Maximize2 className="w-5 h-5 text-white drop-shadow" />
          </div>
        )}
      </div>

      <div
        className={`text-[10px] font-mono truncate text-center ${
          isStaged ? 'text-purple-300 font-semibold' : 'text-zinc-400'
        }`}
      >
        {showImage ? resolution || 'Disk File' : 'None detected'}
      </div>
    </div>
  )
}

interface LightboxArtworkCardProps {
  url?: string
  label: string
  badgeText: string
  res?: string
  isStaged?: boolean
}

const LightboxArtworkCard: React.FC<LightboxArtworkCardProps> = ({
  url,
  label,
  badgeText,
  res,
  isStaged = false,
}) => {
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    setLoadError(false)
  }, [url])

  return (
    <div
      className={`flex flex-col gap-2.5 p-4 rounded-2xl bg-black/50 border ${
        isStaged
          ? 'border-emerald-500/40 shadow-xl shadow-emerald-500/10'
          : 'border-white/10'
      }`}
    >
      <div className="flex items-center justify-between">
        <span
          className={`text-xs font-mono font-bold uppercase tracking-wider flex items-center gap-1.5 ${
            isStaged ? 'text-emerald-400' : 'text-zinc-400'
          }`}
        >
          {isStaged && <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}
          {badgeText}
        </span>
        <span className={`text-xs font-mono ${isStaged ? 'text-emerald-300 font-semibold' : 'text-zinc-300'}`}>
          {res || (isStaged ? '3000×3000px' : 'Disk File')}
        </span>
      </div>
      <div
        className={`aspect-square w-full rounded-xl overflow-hidden bg-black/80 flex items-center justify-center border ${
          isStaged ? 'border-emerald-500/20' : 'border-white/10'
        }`}
      >
        {url && !loadError ? (
          <img
            src={url}
            alt={label}
            className="w-full h-full object-contain"
            onError={() => setLoadError(true)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 text-zinc-500 p-6 text-center select-none">
            <Disc3 className="w-16 h-16 stroke-[1.5] text-zinc-600" />
            <span className="text-xs font-mono text-zinc-400">
              {url
                ? 'Artwork could not be loaded from storage'
                : isStaged
                ? 'No Staged Artwork'
                : 'No Local Cover Embedded'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function getAlbumWideEdits(relTracks: Track[], release?: Release): FieldDiff[] {
  if (relTracks.length <= 1) return []
  const firstTrackEdits = getTrackRealEdits(relTracks[0], release)
  if (firstTrackEdits.length === 0) return []

  return firstTrackEdits.filter((firstDiff) => {
    return relTracks.slice(1).every((track) => {
      const trackEdits = getTrackRealEdits(track, release)
      return trackEdits.some(
        (d) => d.key === firstDiff.key && d.current === firstDiff.current && d.proposed === firstDiff.proposed
      )
    })
  })
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
  onUpdateReleaseArtwork,
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'pipeline'>('preview')
  const [filterCategory, setFilterCategory] = useState<'all' | 'metadata' | 'artwork'>('all')
  const [compactDiffs, setCompactDiffs] = useState(false)
  const [commitTarget, setCommitTarget] = useState<'sidecar' | 'embedded'>('embedded')
  const { isPlaying, togglePlayPause } = useAudioPlayer()
  const isPlaybackActive = isPlaying
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null)
  const [inspectorArtTab, setInspectorArtTab] = useState<'split' | 'staged' | 'current'>('split')
  const [inspectingArtwork, setInspectingArtwork] = useState<{
    currentUrl?: string
    stagedUrl?: string
    albumTitle: string
    currentRes?: string
    stagedRes?: string
  } | null>(null)

  // Custom Artwork URL Input State
  const [customUrlReleaseId, setCustomUrlReleaseId] = useState<string | null>(null)
  const [customUrlInput, setCustomUrlInput] = useState('')

  // Exclusion & Expansion Sets
  const [excludedTrackIds, setExcludedTrackIds] = useState<Set<string>>(new Set())
  const [expandedReleaseIds, setExpandedReleaseIds] = useState<Set<string>>(() => {
    // Default: expand only albums that have song-level tag changes.
    // When audio tags across all tracks in an album are identical to disk and only album-level cover art is updated,
    // default to collapsed to prevent visual noise.
    const set = new Set<string>()
    const groups = new Map<string, Track[]>()
    uncommittedTracks.forEach((t) => {
      const key = t.releaseId || t.folderName || 'unknown'
      const list = groups.get(key) || []
      list.push(t)
      groups.set(key, list)
    })

    groups.forEach((tracksInGroup, releaseKey) => {
      const rel = releases.find((r) => r.id === releaseKey || r.folderName === releaseKey)
      const hasSongLevelChanges = tracksInGroup.some((t) => getTrackRealEdits(t, rel).length > 0)
      if (hasSongLevelChanges) {
        set.add(releaseKey)
      }
    })

    return set
  })

  // Execution & Progress State
  const [isRunning, setIsRunning] = useState(false)
  const [isCompleted, setIsCompleted] = useState(false)
  const [detailedProgress, setDetailedProgress] = useState<DetailedCommitProgress | null>(null)
  const [committedSummary, setCommittedSummary] = useState<{
    total: number
    embedded: number
    sidecars: number
    durationMs: number
  } | null>(null)
  const [failedTracks, setFailedTracks] = useState<{ trackId: string; filePath: string; error: string }[]>([])
  const [errorMessage, setErrorMessage] = useState<string>()
  const [lastTxId, setLastTxId] = useState<string>()
  const [showTechDetails, setShowTechDetails] = useState(false)

  const [progressSteps, setProgressSteps] = useState<CommitStepProgress[]>([
    { step: 'PREPARE', label: '1. Checking storage permissions, playback idle & mount locks', completed: false },
    { step: 'VERIFY_STREAM_CHECKSUM', label: '2. Verifying audio checksums & stream integrity', completed: false },
    { step: 'CREATE_BACKUP_SNAPSHOT', label: '3. Creating safe rollback snapshot', completed: false },
    { step: 'WRITE_EMBEDDED_TAGS', label: '4. Updating track metadata & artwork', completed: false },
    { step: 'FINALIZE', label: '5. Finalizing changes & updating journal', completed: false },
  ])

  // Compute release lookup map
  const releaseMap = useMemo(() => {
    const map = new Map<string, Release>()
    releases.forEach((r) => map.set(r.id, r))
    return map
  }, [releases])

  // Pre-calculate padding analysis for all uncommitted tracks
  const paddingMap = useMemo(() => {
    const map = new Map<string, HeaderPaddingAnalysis>()
    uncommittedTracks.forEach((t) => {
      map.set(t.id, analyzeHeaderPadding(t))
    })
    return map
  }, [uncommittedTracks])

  // Filtered tracks based on category and search query
  const filteredTracks = useMemo(() => {
    let list = uncommittedTracks

    if (filterCategory === 'metadata') {
      list = list.filter((t) => {
        const rel = releaseMap.get(t.releaseId)
        return getTrackRealEdits(t, rel).length > 0
      })
    } else if (filterCategory === 'artwork') {
      // "With Artwork Updates": includes any tracks that have staged cover art
      list = list.filter((t) => Boolean(t.pendingSidecarEdits?.coverArtUrl))
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

  // Group filtered tracks by release / album
  const groupedByRelease = useMemo(() => {
    const map = new Map<string, { release?: Release; tracks: Track[] }>()
    filteredTracks.forEach((t) => {
      const relId = t.releaseId || t.folderName || 'unknown'
      if (!map.has(relId)) {
        const rel = releases.find((r) => r.id === relId)
        map.set(relId, { release: rel, tracks: [] })
      }
      map.get(relId)!.tracks.push(t)
    })
    return Array.from(map.entries())
  }, [filteredTracks, releases])

  // Selected Release Synchronization for Inspector Pane
  useEffect(() => {
    if (groupedByRelease.length > 0) {
      if (!selectedReleaseId || !groupedByRelease.some(([id]) => id === selectedReleaseId)) {
        setSelectedReleaseId(groupedByRelease[0][0])
      }
    } else {
      setSelectedReleaseId(null)
    }
  }, [groupedByRelease, selectedReleaseId])

  const selectedGroup = useMemo(() => {
    if (!selectedReleaseId) return groupedByRelease[0] || null
    return groupedByRelease.find(([id]) => id === selectedReleaseId) || groupedByRelease[0] || null
  }, [groupedByRelease, selectedReleaseId])

  const selectedReleaseData = useMemo(() => {
    if (!selectedGroup) return null
    const [relId, { release, tracks: relTracks }] = selectedGroup
    const albumTitle =
      release?.title ||
      relTracks[0]?.pendingSidecarEdits?.album ||
      relTracks[0]?.folderName ||
      'Album Release'
    const folderName = release?.folderName || relTracks[0]?.folderName
    const artistCredit = release?.artistCredit || relTracks[0]?.artistCredit || 'Various Artists'
    const stagedCoverArt =
      release?.artwork?.frontCoverUrl ||
      relTracks.find((t) => t.pendingSidecarEdits?.coverArtUrl)?.pendingSidecarEdits?.coverArtUrl
    const currentCoverArt =
      release?.artwork?.originalFrontCoverUrl ||
      (release?.artwork?.frontCoverUrl && release.artwork.frontCoverUrl !== stagedCoverArt
        ? release.artwork.frontCoverUrl
        : relTracks[0]?.filePath
        ? `/api/track-art?file=${encodeURIComponent(relTracks[0].filePath)}`
        : undefined)
    const stagedRes =
      relTracks.find((t) => t.pendingSidecarEdits?.coverResolution)?.pendingSidecarEdits?.coverResolution ||
      release?.artwork?.resolution ||
      '3000×3000px (Apple Music Master Scan)'
    const currentRes = release?.artwork?.originalFrontCoverUrl
      ? 'Local Disk / Original'
      : release?.artwork?.resolution || 'Disk file'

    const realEdits = relTracks.flatMap((t) => getTrackRealEdits(t, release))
    const allTracksExcluded = relTracks.every((t) => excludedTrackIds.has(t.id))

    return {
      relId,
      release,
      relTracks,
      albumTitle,
      folderName,
      artistCredit,
      stagedCoverArt,
      currentCoverArt,
      stagedRes,
      currentRes,
      realEdits,
      allTracksExcluded,
    }
  }, [selectedGroup, excludedTrackIds])

  // Decoupled Metrics: All Staged Items
  const allMetrics: CommitUnitMetrics = useMemo(() => {
    const relSet = new Set<string>()
    let tagEdits = 0
    const artAlbums = new Set<string>()

    uncommittedTracks.forEach((t) => {
      const rel = releaseMap.get(t.releaseId)
      relSet.add(t.releaseId || t.folderName || 'unknown')
      tagEdits += getTrackRealEdits(t, rel).length
      if (t.pendingSidecarEdits?.coverArtUrl) {
        artAlbums.add(t.releaseId || t.folderName || 'unknown')
      }
    })

    return {
      albumCount: relSet.size,
      audioTrackCount: uncommittedTracks.length,
      tagEditCount: tagEdits,
      coverArtUpdateCount: artAlbums.size,
    }
  }, [uncommittedTracks, releaseMap])

  // Tracks selected for commit (taking excludedTrackIds into account)
  const activeTracksToCommit = useMemo(() => {
    return uncommittedTracks.filter((t) => !excludedTrackIds.has(t.id))
  }, [uncommittedTracks, excludedTrackIds])

  // Dynamic Decoupled Metrics for currently selected/included items
  const activeMetrics: CommitUnitMetrics = useMemo(() => {
    const relSet = new Set<string>()
    let tagEdits = 0
    const artAlbums = new Set<string>()

    activeTracksToCommit.forEach((t) => {
      const rel = releaseMap.get(t.releaseId)
      relSet.add(t.releaseId || t.folderName || 'unknown')
      tagEdits += getTrackRealEdits(t, rel).length
      if (t.pendingSidecarEdits?.coverArtUrl) {
        artAlbums.add(t.releaseId || t.folderName || 'unknown')
      }
    })

    return {
      albumCount: relSet.size,
      audioTrackCount: activeTracksToCommit.length,
      tagEditCount: tagEdits,
      coverArtUpdateCount: artAlbums.size,
    }
  }, [activeTracksToCommit, releaseMap])

  // Category counts for filter tabs
  const metadataTracksCount = useMemo(() => {
    return uncommittedTracks.filter((t) => {
      const rel = releaseMap.get(t.releaseId)
      return getTrackRealEdits(t, rel).length > 0
    }).length
  }, [uncommittedTracks, releaseMap])

  const artworkTracksCount = useMemo(() => {
    return uncommittedTracks.filter((t) => {
      const rel = releaseMap.get(t.releaseId)
      return Boolean(t.pendingSidecarEdits?.coverArtUrl) || Boolean(rel?.artwork?.frontCoverUrl && rel.artwork.frontCoverUrl !== (rel as any)?.originalCoverArtUrl)
    }).length
  }, [uncommittedTracks, releaseMap])

  // Preflight Verification Check
  const preflight = useMemo(() => {
    return transactionEngine.runPreflightChecks(activeTracksToCommit, isPlaybackActive)
  }, [activeTracksToCommit, isPlaybackActive])

  // Exclude / Include Handlers
  const toggleTrackExclusion = (trackId: string) => {
    setExcludedTrackIds((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }

  const toggleReleaseExclusion = (relId: string, relTracks: Track[]) => {
    setExcludedTrackIds((prev) => {
      const next = new Set(prev)
      const allExcluded = relTracks.every((t) => next.has(t.id))
      if (allExcluded) {
        relTracks.forEach((t) => next.delete(t.id))
      } else {
        relTracks.forEach((t) => next.add(t.id))
      }
      return next
    })
  }

  const toggleReleaseExpanded = (relId: string) => {
    setExpandedReleaseIds((prev) => {
      const next = new Set(prev)
      if (next.has(relId)) next.delete(relId)
      else next.add(relId)
      return next
    })
  }

  const handleApplyCustomUrl = (releaseId: string) => {
    const trimmed = customUrlInput.trim()
    if (!trimmed) return
    onUpdateReleaseArtwork?.(releaseId, trimmed)
    setCustomUrlReleaseId(null)
    setCustomUrlInput('')
  }

  // Commit Execution Handler with Native Asynchronous Queue Handoff
  const handleStartCommit = async (tracksToRun: Track[] = activeTracksToCommit) => {
    if (tracksToRun.length === 0 || !preflight.storageWritable) return

    setIsRunning(true)
    setErrorMessage(undefined)
    setDetailedProgress(null)
    setFailedTracks([])

    const startTime = Date.now()
    const description = `Batch Commit ${tracksToRun.length} tracks to ${
      commitTarget === 'sidecar' ? 'Album Sidecars' : 'Embedded Headers'
    }`

    const result = await transactionEngine.executeTwoPhaseCommit(
      tracksToRun,
      description,
      (updatedSteps) => setProgressSteps(updatedSteps),
      (progress) => setDetailedProgress(progress),
      {
        destination: commitTarget,
        isPlaybackActive,
        allowAsyncQueue: true,
      }
    )

    const duration = Date.now() - startTime
    setIsRunning(false)

    if (result.success && (!result.failedTracks || result.failedTracks.length === 0)) {
      setCommittedSummary({
        total: result.committedCount ?? tracksToRun.length,
        embedded: result.embeddedHeadersCount ?? 0,
        sidecars: result.sidecarsCount ?? tracksToRun.length,
        durationMs: duration,
      })
      setIsCompleted(true)
      setLastTxId(result.transactionId)
      onSuccess()

      // Close modal smoothly to return user to listening & browsing; CommitStatusPill tracks background save
      onClose()
    } else {
      setActiveTab('pipeline')
      setErrorMessage(result.error || 'Transaction encountered write errors on disk.')
      if (result.failedTracks && result.failedTracks.length > 0) {
        setFailedTracks(result.failedTracks)
      }
    }
  }

  const handleRetryFailed = () => {
    if (failedTracks.length === 0) return
    const failedSet = new Set(failedTracks.map((f) => f.trackId))
    const retryTracks = uncommittedTracks.filter((t) => failedSet.has(t.id))
    handleStartCommit(retryTracks)
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
    <div className="fixed inset-0 z-[70] bg-black/85 backdrop-blur-md flex items-start justify-center pt-[52px] animate-in fade-in duration-200">
      <div
        data-tutorial-id="modal-staged-commit-pipeline"
        className="bg-[#121318] border-x border-b border-white/[0.08] rounded-t-none rounded-b-2xl w-full max-w-[1400px] max-h-[calc(94vh-52px)] h-[calc(94vh-52px)] shadow-[0_24px_60px_rgba(0,0,0,0.9)] overflow-hidden flex flex-col animate-in slide-in-from-top-6 duration-240 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] will-change-transform"
      >
        {/* 1. Modal Header with Trust Badges */}
        <div className="p-4 px-6 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${
              isRunning
                ? 'bg-cyan-500/15 border border-cyan-500/30 text-cyan-400'
                : isCompleted
                ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400'
                : 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400'
            }`}>
              {isRunning ? <Loader2 className="w-5 h-5 animate-spin text-cyan-400" /> : <ShieldCheck className="w-5 h-5" />}
            </div>
            <div className="flex flex-col text-left">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2 className="text-base font-bold text-slate-100">Review & Commit Changes</h2>
                
                {/* Dynamic Transaction State Badge */}
                {isRunning ? (
                  <span className="text-[11px] font-mono font-medium px-2.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 flex items-center gap-1.5 animate-pulse">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                    <span>Commit In Progress (Writing to Disk)</span>
                  </span>
                ) : isCompleted ? (
                  <span className="text-[11px] font-mono font-medium px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Transaction Verified (Committed)</span>
                  </span>
                ) : failedTracks.length > 0 ? (
                  <span className="text-[11px] font-mono font-medium px-2.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                    <span>Commit Completed with Errors</span>
                  </span>
                ) : (
                  <span className="text-[11px] font-mono font-medium px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Staged Locally (Draft / Untouched)</span>
                  </span>
                )}

                {/* Pre-Commit State Snapshot Badge */}
                <span
                  className="text-[11px] font-mono font-medium px-2.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 flex items-center gap-1.5"
                  title="A pre-commit snapshot is recorded before any write begins. Sidecar JSON edits are non-destructively reversible; embedded header tags can be restored from the pre-commit snapshot."
                >
                  <RotateCcw className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Pre-Commit State Snapshot</span>
                </span>
              </div>
              <span className="text-xs text-slate-400 mt-0.5">
                {isRunning
                  ? 'Writing metadata and artwork to library storage. Controls locked to guarantee transaction integrity.'
                  : isCompleted
                  ? 'All staged modifications have been verified and saved to storage.'
                  : 'Inspect pending field diffs grouped by album authority before saving to storage.'}
              </span>
            </div>
          </div>
          {!isRunning && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
              title="Close commit review"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* 2. Decoupled Summary Metrics Strip (Distinct from Filter Tabs) */}
        <div className="px-6 py-2.5 bg-[#0f1015] border-b border-white/[0.06] flex items-center justify-between gap-4 flex-wrap shrink-0">
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mr-1">
              Total Staged Batch:
            </span>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.03] border border-white/[0.06] text-zinc-300">
              <Disc3 className="w-3.5 h-3.5 text-cyan-400" />
              <span>
                <strong className="text-white font-semibold">{allMetrics.albumCount}</strong> Albums
              </span>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.03] border border-white/[0.06] text-zinc-300">
              <Music className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                <strong className="text-white font-semibold">{allMetrics.audioTrackCount}</strong> Audio Track Files
              </span>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.03] border border-white/[0.06] text-zinc-300">
              <FileCode className="w-3.5 h-3.5 text-amber-400" />
              <span>
                <strong className="text-white font-semibold">{allMetrics.tagEditCount}</strong> Tag Edits
              </span>
            </div>
            {allMetrics.coverArtUpdateCount > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.03] border border-white/[0.06] text-zinc-300">
                <ImageIcon className="w-3.5 h-3.5 text-purple-400" />
                <span>
                  <strong className="text-white font-semibold">{allMetrics.coverArtUpdateCount}</strong> Cover Art Updates
                </span>
              </div>
            )}
            {activeTracksToCommit.length !== uncommittedTracks.length && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[11px] font-mono">
                <span>Selected: <strong>{activeTracksToCommit.length}</strong> of {uncommittedTracks.length} files</span>
              </div>
            )}
          </div>

          {/* View Switcher: Diff Review vs Execution Drawer */}
          <div className="flex items-center gap-1.5 bg-black/40 p-0.5 rounded-lg border border-white/[0.06]">
            <button
              type="button"
              onClick={() => setActiveTab('preview')}
              className={`px-3 py-1 rounded-md text-xs font-mono font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'preview'
                  ? 'bg-white/[0.12] text-white shadow-sm border border-white/10'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <span>Diff Review</span>
              {isRunning && (
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                  Snapshot
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('pipeline')}
              className={`px-3 py-1 rounded-md text-xs font-mono font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'pipeline'
                  ? 'bg-white/[0.12] text-white shadow-sm border border-white/10'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <span>Execution Log</span>
              {isRunning && <Loader2 className="w-3 h-3 text-cyan-400 animate-spin" />}
            </button>
          </div>
        </div>

        {/* 3. Main Body Viewport */}
        <div className="flex-1 overflow-hidden p-6 flex flex-col gap-4 text-left min-h-0">
          {activeTab === 'preview' ? (
            <>
              {/* Category Filter Tabs, Compact Toggle & Search Bar */}
              <div className="flex items-center justify-between gap-3 flex-wrap shrink-0">
                <div className="flex items-center gap-1 bg-black/40 p-1 rounded-xl border border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => setFilterCategory('all')}
                    className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition-all cursor-pointer ${
                      filterCategory === 'all'
                        ? 'bg-white/[0.12] text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    All Changes ({uncommittedTracks.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilterCategory('metadata')}
                    className={`px-3 py-1 rounded-lg text-xs font-mono font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                      filterCategory === 'metadata'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Music className="w-3 h-3" />
                    <span>Tag Edits ({metadataTracksCount})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilterCategory('artwork')}
                    className={`px-3 py-1 rounded-lg text-xs font-mono font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
                      filterCategory === 'artwork'
                        ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30 shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <ImageIcon className="w-3 h-3" />
                    <span>With Artwork Updates ({artworkTracksCount})</span>
                  </button>
                </div>

                <div className="flex items-center gap-2 flex-1 min-w-[280px]">
                  {/* Compact Diff Toggle */}
                  <button
                    type="button"
                    onClick={() => setCompactDiffs(!compactDiffs)}
                    className={`px-3 py-1.5 rounded-xl border text-xs font-mono transition-all cursor-pointer shrink-0 flex items-center gap-1.5 ${
                      compactDiffs
                        ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-300 font-semibold'
                        : 'bg-black/40 border-white/[0.08] text-zinc-400 hover:text-white'
                    }`}
                    title={compactDiffs ? 'Showing only track-specific differences' : 'Showing all field diffs'}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    <span>{compactDiffs ? 'Compact Diffs: ON' : 'Compact Diffs'}</span>
                  </button>

                  {/* Search Bar */}
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Filter by title, artist, album, path..."
                      className="w-full pl-9 pr-3 py-1.5 bg-black/40 border border-white/[0.08] rounded-xl text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400/50 font-mono"
                    />
                  </div>
                </div>
              </div>

              {/* Persistent Live Commit Banner if user is viewing diffs while isRunning */}
              {isRunning && (
                <div className="p-3 px-4 rounded-xl bg-gradient-to-r from-cyan-950/60 via-[#0C1220] to-[#0A0D14] border border-cyan-500/40 text-cyan-200 flex items-center justify-between gap-4 animate-in fade-in shrink-0 shadow-lg">
                  <div className="flex items-center gap-3 min-w-0">
                    <Loader2 className="w-4 h-4 text-cyan-400 animate-spin shrink-0" />
                    <div className="flex flex-col min-w-0 text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white">
                          Commit Transaction In Progress — Snapshot Frozen
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.2 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                          Read-Only
                        </span>
                      </div>
                      <span className="text-[11px] text-zinc-300 font-mono truncate mt-0.5">
                        {detailedProgress
                          ? `Writing track ${detailedProgress.processedTracks} of ${detailedProgress.totalTracks} (${detailedProgress.percent}%) • Current: ${detailedProgress.currentTrack?.title || 'Processing...'}`
                          : `Committing ${activeTracksToCommit.length} tracks to storage...`}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('pipeline')}
                    className="px-3 py-1 text-xs font-mono font-semibold rounded-lg bg-cyan-500 text-black hover:bg-cyan-400 transition-all cursor-pointer shrink-0 shadow-md"
                  >
                    View Live Execution Log →
                  </button>
                </div>
              )}

              {/* Preflight Transport Warning if Playback Active */}
              {!preflight.playbackIdle && (
                <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-center justify-between gap-3 animate-in fade-in shrink-0">
                  <div className="flex items-center gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>
                      <strong>Audiophile Storage Bus Silence Active:</strong> Playback is active. Changes will be safely queued and written to storage during 30s playback silence.
                    </span>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/30 text-amber-300 shrink-0">
                    Paced Background Queue
                  </span>
                </div>
              )}

              {/* Two-Column Master-Detail Layout */}
              <div className="flex-1 min-h-0 flex gap-5 overflow-hidden">
                {/* Left Pane (Master Album & Track Review List) */}
                <div className="flex-1 min-w-0 overflow-y-auto pr-1.5 flex flex-col gap-4">
                  {uncommittedTracks.length === 0 ? (
                    <div className="p-12 rounded-2xl bg-white/[0.01] border border-dashed border-white/[0.08] flex flex-col items-center justify-center text-center gap-2">
                      <CheckCircle2 className="w-10 h-10 text-emerald-500/50" />
                      <h3 className="text-sm font-bold text-white">No Pending Changes Staged</h3>
                      <p className="text-xs text-zinc-400 max-w-sm">
                        All audio headers and sidecars are currently synchronized and bit-perfect with your library.
                      </p>
                    </div>
                  ) : filteredTracks.length === 0 ? (
                    <div className="p-12 rounded-2xl bg-white/[0.01] border border-dashed border-white/[0.08] flex flex-col items-center justify-center text-center gap-2">
                      <Search className="w-10 h-10 text-zinc-500/50" />
                      <h3 className="text-sm font-bold text-white">No Matching Staged Changes</h3>
                      <p className="text-xs text-zinc-400 max-w-sm">
                        No staged tracks match the selected filter category or search query.
                      </p>
                    </div>
                  ) : (
                    groupedByRelease.map(([relId, { release, tracks: relTracks }]) => {
                      const albumTitle =
                        release?.title ||
                        relTracks[0]?.pendingSidecarEdits?.album ||
                        relTracks[0]?.folderName ||
                        'Album Release'
                      const folderName = release?.folderName || relTracks[0]?.folderName
                      const stagedCoverArt = relTracks.find((t) => t.pendingSidecarEdits?.coverArtUrl)
                        ?.pendingSidecarEdits?.coverArtUrl
                      const currentCoverArt =
                        release?.artwork?.originalFrontCoverUrl ||
                        (release?.artwork?.frontCoverUrl && release.artwork.frontCoverUrl !== stagedCoverArt
                          ? release.artwork.frontCoverUrl
                          : relTracks[0]?.filePath
                          ? `/api/track-art?file=${encodeURIComponent(relTracks[0].filePath)}`
                          : undefined)

                      const isExpanded = expandedReleaseIds.has(relId)
                      const isSelected = selectedReleaseId === relId
                      const allTracksExcluded = relTracks.every((t) => excludedTrackIds.has(t.id))
                      const someTracksExcluded = relTracks.some((t) => excludedTrackIds.has(t.id))

                      return (
                        <div
                          key={relId}
                          onClick={() => setSelectedReleaseId(relId)}
                          className={`rounded-2xl border transition-all ${
                            allTracksExcluded
                              ? 'border-white/[0.04] bg-[#0c0d11]/60 opacity-60'
                              : isSelected
                              ? 'border-cyan-500/50 bg-[#0E1017] shadow-xl shadow-cyan-950/20 ring-1 ring-cyan-500/40'
                              : 'border-white/[0.08] bg-[#0E1017]/90 shadow-lg hover:border-white/20'
                          }`}
                        >
                          {/* Sticky Album Group Header */}
                          <div
                            onClick={(e) => {
                              setSelectedReleaseId(relId)
                              toggleReleaseExpanded(relId)
                            }}
                            className={`sticky top-0 z-10 backdrop-blur-xl p-3.5 px-4 border-b border-white/[0.06] flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-[#101422]/95 border-b-cyan-500/30'
                                : 'bg-[#0c0e17]/95 hover:bg-[#12141f]/95'
                            }`}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              {/* Album Checkbox */}
                              <div
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (isRunning) return
                                  toggleReleaseExclusion(relId, relTracks)
                                }}
                                className={`w-5 h-5 flex items-center justify-center shrink-0 ${
                                  isRunning ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                                }`}
                                title={isRunning ? 'Locked during execution' : allTracksExcluded ? 'Include album in commit' : 'Exclude album from commit'}
                              >
                                <div
                                  className={`w-4 h-4 rounded flex items-center justify-center transition-all ${
                                    !allTracksExcluded && !someTracksExcluded
                                      ? 'bg-emerald-500 border border-emerald-400 text-black'
                                      : someTracksExcluded && !allTracksExcluded
                                      ? 'bg-emerald-500/40 border border-emerald-400/60'
                                      : 'bg-zinc-900 border border-zinc-700'
                                  }`}
                                >
                                  {!allTracksExcluded && <Check className="w-3 h-3 stroke-[3]" />}
                                </div>
                              </div>

                              {/* Album Artwork Thumbnail */}
                              <div className="w-10 h-10 rounded-lg bg-black/60 border border-white/10 overflow-hidden flex items-center justify-center shrink-0">
                                {stagedCoverArt || currentCoverArt ? (
                                  <img
                                    src={stagedCoverArt || currentCoverArt}
                                    alt="Cover"
                                    className="w-full h-full object-cover"
                                    onError={(e) => {
                                      ;(e.target as HTMLElement).style.display = 'none'
                                    }}
                                  />
                                ) : (
                                  <Disc3 className="w-5 h-5 text-cyan-400" />
                                )}
                              </div>

                              {/* Album Meta */}
                              <div className="flex flex-col min-w-0 text-left">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-bold text-white truncate">
                                    {albumTitle}
                                  </span>
                                  {folderName && folderName.toLowerCase().trim() !== albumTitle.toLowerCase().trim() && (
                                    <span
                                      className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 flex items-center gap-1 shrink-0"
                                      title={`Physical Folder: ${folderName}`}
                                    >
                                      <Folder className="w-3 h-3" />
                                      <span className="truncate max-w-[180px]">{folderName}</span>
                                    </span>
                                  )}
                                </div>
                                <span className="text-[11px] text-zinc-400 truncate mt-0.5 font-mono">
                                  {release?.artistCredit || relTracks[0]?.artistCredit || 'Various Artists'}
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {isSelected && (
                                <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 hidden sm:inline-flex items-center gap-1">
                                  <Eye className="w-3 h-3" />
                                  <span>Inspecting</span>
                                </span>
                              )}
                              {stagedCoverArt && (
                                <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30">
                                  Cover Art Updated
                                </span>
                              )}
                              <span className={`text-[10px] font-mono font-medium px-2 py-0.5 rounded-full ${
                                commitTarget === 'embedded'
                                  ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30'
                                  : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                              }`}>
                                {commitTarget === 'embedded' ? 'Header Write Staged' : 'Sidecar Staged'}
                              </span>
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/[0.05] text-zinc-300 border border-white/10">
                                {relTracks.length} track{relTracks.length > 1 ? 's' : ''}
                              </span>
                              {onDiscardRelease && !isRunning && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    onDiscardRelease(relId)
                                  }}
                                  title="Discard all staged changes for this album"
                                  className="p-1 rounded text-zinc-400 hover:text-rose-400 hover:bg-white/[0.06] transition-all cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <div className="p-1 text-zinc-400">
                                {isExpanded ? (
                                  <ChevronDown className="w-4 h-4 text-cyan-400" />
                                ) : (
                                  <ChevronRight className="w-4 h-4 text-zinc-400" />
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Uniform Album Edits Banner */}
                          {isExpanded && (() => {
                            const albumWideEdits = getAlbumWideEdits(relTracks, release)
                            if (albumWideEdits.length === 0) return null
                            return (
                              <div className="mx-4 my-2.5 p-3 rounded-xl bg-cyan-500/[0.07] border border-cyan-500/25 flex flex-col gap-2 text-xs text-left animate-in fade-in duration-150">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-mono uppercase tracking-wider font-semibold text-cyan-300 flex items-center gap-1.5">
                                    <Layers className="w-3.5 h-3.5 text-cyan-400" />
                                    <span>Uniform Album Modifications Applied to All {relTracks.length} Tracks:</span>
                                  </span>
                                  <span className="text-[10px] font-mono text-zinc-400">
                                    {albumWideEdits.length} uniform field{albumWideEdits.length > 1 ? 's' : ''}
                                  </span>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {albumWideEdits.map((ed) => (
                                    <div
                                      key={ed.key}
                                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/60 border border-cyan-500/30 text-[11px] font-mono shadow-sm"
                                    >
                                      <span className="text-zinc-400">{ed.label}:</span>
                                      <span className="text-zinc-500 line-through truncate max-w-[140px]" title={ed.current}>
                                        {ed.current}
                                      </span>
                                      <span className="text-cyan-400 font-bold">→</span>
                                      <span className="text-emerald-300 font-semibold truncate max-w-[180px]" title={ed.proposed}>
                                        {ed.proposed}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )
                          })()}

                          {/* Expandable Inline Artwork Comparison (if artwork staged) */}
                          {isExpanded && stagedCoverArt && (
                            <div className="p-3.5 px-4 bg-black/40 border-b border-white/[0.06] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                              <div className="flex items-center gap-4">
                                <div className="flex items-center gap-3">
                                  <ArtworkZoomThumbnail
                                    url={currentCoverArt}
                                    label="Current Artwork"
                                    resolution={release?.artwork?.resolution || 'Disk file'}
                                    onClick={() => setSelectedReleaseId(relId)}
                                  />
                                  <div className="flex flex-col text-left">
                                    <span className="text-[10px] text-zinc-400 font-mono uppercase tracking-wider">
                                      Current Artwork
                                    </span>
                                    <span className="text-xs text-zinc-300 font-mono">
                                      {release?.artwork?.resolution || 'Disk file'}
                                    </span>
                                  </div>
                                </div>

                                <div className="flex items-center text-cyan-400 shrink-0 px-1">
                                  <ArrowRight className="w-4 h-4" />
                                </div>

                                <div className="flex items-center gap-3">
                                  <ArtworkZoomThumbnail
                                    url={stagedCoverArt}
                                    label="Staged Archival Cover"
                                    resolution={
                                      relTracks.find((t) => t.pendingSidecarEdits?.coverResolution)
                                        ?.pendingSidecarEdits?.coverResolution || 'High-Resolution Scan'
                                    }
                                    isStaged
                                    onClick={() => setSelectedReleaseId(relId)}
                                  />
                                  <div className="flex flex-col text-left">
                                    <span className="text-[10px] text-emerald-400 font-mono uppercase tracking-wider font-semibold">
                                      Staged Archival Cover
                                    </span>
                                    <span className="text-xs text-emerald-300 font-mono">
                                      {relTracks.find((t) => t.pendingSidecarEdits?.coverResolution)
                                        ?.pendingSidecarEdits?.coverResolution || 'High-Resolution Scan'}
                                    </span>
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setSelectedReleaseId(relId)}
                                  className="px-2.5 py-1 text-xs font-mono rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-all cursor-pointer flex items-center gap-1.5"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                  <span>Inspect Pane</span>
                                </button>
                                {onUpdateReleaseArtwork && !isRunning && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedReleaseId(relId)
                                      setCustomUrlReleaseId(relId)
                                      setCustomUrlInput(stagedCoverArt || '')
                                    }}
                                    className="px-2.5 py-1 text-xs font-mono rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-all cursor-pointer flex items-center gap-1"
                                    title="Provide custom artwork URL"
                                  >
                                    <Link className="w-3 h-3" />
                                    <span>Custom URL</span>
                                  </button>
                                )}
                                {onDiscardReleaseArtwork && !isRunning && (
                                  <button
                                    type="button"
                                    onClick={() => onDiscardReleaseArtwork(relId)}
                                    className="px-2.5 py-1 text-xs font-mono rounded-lg border border-white/10 hover:border-rose-400/50 hover:bg-rose-500/10 text-zinc-400 hover:text-rose-300 transition-all cursor-pointer"
                                  >
                                    Revert Art
                                  </button>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Track-Level Diff List */}
                          {isExpanded && (
                            <div className="divide-y divide-white/[0.04]">
                              {relTracks.map((track) => {
                                const realEdits = getTrackRealEdits(track, release)
                                const isTrackExcluded = excludedTrackIds.has(track.id)
                                const paddingInfo = paddingMap.get(track.id)

                                const albumWideEdits = getAlbumWideEdits(relTracks, release)
                                const albumWideKeys = new Set(albumWideEdits.map((e) => e.key))
                                const displayedEdits = compactDiffs
                                  ? realEdits.filter((e) => !albumWideKeys.has(e.key))
                                  : realEdits

                                // Multi-disc numbering & proposed track number formatting
                                const discNum = track.discNumber || (track as any).discIndex || 1
                                const hasMultipleDiscs = relTracks.some(
                                  (t) => (t.discNumber || (t as any).discIndex || 1) > 1
                                )
                                const trackNumRaw = track.trackNumber
                                  ? String(track.trackNumber).padStart(2, '0')
                                  : '—'
                                const proposedTrackNum = track.pendingSidecarEdits?.trackNumber
                                const trackNumberDisplay = hasMultipleDiscs
                                  ? `D${discNum} #${trackNumRaw}`
                                  : `#${trackNumRaw}`

                                return (
                                  <div
                                    key={track.id}
                                    className={`p-3 px-4 flex flex-col gap-2 transition-colors ${
                                      isTrackExcluded
                                        ? 'bg-black/20 opacity-50'
                                        : 'hover:bg-white/[0.01]'
                                    }`}
                                  >
                                    {/* Track Item Row Header */}
                                    <div className="flex items-center justify-between gap-3">
                                      <div className="flex items-center gap-2.5 min-w-0">
                                        {/* Track Checkbox */}
                                        <button
                                          type="button"
                                          role="checkbox"
                                          aria-checked={!isTrackExcluded}
                                          disabled={isRunning}
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            if (isRunning) return
                                            toggleTrackExclusion(track.id)
                                          }}
                                          className={`w-4 h-4 rounded flex items-center justify-center transition-all shrink-0 ${
                                            isRunning ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                                          } ${
                                            !isTrackExcluded
                                              ? 'bg-emerald-500 border border-emerald-400 text-black'
                                              : 'bg-zinc-900 border border-zinc-700'
                                          }`}
                                          title={isRunning ? 'Locked during execution' : isTrackExcluded ? 'Include track' : 'Exclude track'}
                                        >
                                          {!isTrackExcluded && <Check className="w-3 h-3 stroke-[3]" />}
                                        </button>

                                        <div className="w-14 text-[11px] font-mono text-zinc-400 shrink-0 font-medium">
                                          {proposedTrackNum !== undefined && proposedTrackNum !== track.trackNumber ? (
                                            <span
                                              className="text-emerald-300 flex items-center gap-0.5"
                                              title={`Track number updated from #${trackNumRaw} to #${String(proposedTrackNum).padStart(2, '0')}`}
                                            >
                                              {hasMultipleDiscs ? `D${discNum} ` : ''}
                                              <span className="line-through text-zinc-500">#{trackNumRaw}</span>
                                              <span>→</span>
                                              <span>#{String(proposedTrackNum).padStart(2, '0')}</span>
                                            </span>
                                          ) : (
                                            <span>{trackNumberDisplay}</span>
                                          )}
                                        </div>

                                        <span className="text-xs font-semibold text-zinc-100 truncate">
                                          {track.title}
                                        </span>
                                      </div>

                                      <div className="flex items-center gap-2 shrink-0">
                                        {/* Header Write Strategy Badge (When Embed Headers is selected) */}
                                        {commitTarget === 'embedded' && paddingInfo && (
                                          <span
                                            className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
                                              paddingInfo.requiresFullRewrite
                                                ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                                                : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                                            }`}
                                            title={paddingInfo.reason}
                                          >
                                            {paddingInfo.requiresFullRewrite ? 'Stream Rewrite' : 'In-Place Overwrite'}
                                          </span>
                                        )}

                                        {onDiscardTrack && !isRunning && (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation()
                                              onDiscardTrack(track.id)
                                            }}
                                            title="Discard staged edits for this track"
                                            className="p-1 rounded text-zinc-500 hover:text-rose-400 transition-colors cursor-pointer"
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                        )}
                                      </div>
                                    </div>

                                    {/* Field Diffs Table */}
                                    {displayedEdits.length > 0 ? (
                                      <div className="ml-6 mt-1 rounded-xl bg-black/40 border border-white/[0.04] overflow-hidden text-xs">
                                        <div className="grid grid-cols-12 gap-3 px-3 py-1.5 bg-white/[0.02] border-b border-white/[0.04] text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                                          <div className="col-span-3">TAG FIELD</div>
                                          <div className="col-span-4">CURRENT ON-DISK</div>
                                          <div className="col-span-5 text-emerald-400">PROPOSED VALUE</div>
                                        </div>
                                        <div className="divide-y divide-white/[0.03]">
                                          {displayedEdits.map((diff) => (
                                            <div
                                              key={diff.key}
                                              className="grid grid-cols-12 gap-3 px-3 py-2 items-center font-mono text-[11px]"
                                            >
                                              <div className="col-span-3 text-zinc-400 flex items-center gap-1.5 truncate">
                                                <diff.icon className="w-3 h-3 text-zinc-500 shrink-0" />
                                                <span className="truncate">{diff.label}</span>
                                              </div>
                                              <div className="col-span-4 text-zinc-500 truncate" title={diff.current}>
                                                {diff.current}
                                              </div>
                                              <div className="col-span-5 text-zinc-100 font-semibold truncate flex items-center gap-1.5" title={diff.proposed}>
                                                <span className="text-zinc-600 font-normal shrink-0">→</span>
                                                <span className="text-emerald-300 truncate">{diff.proposed}</span>
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    ) : realEdits.length > 0 && compactDiffs ? (
                                      <div className="ml-6 text-[11px] font-mono text-zinc-400 flex items-center gap-1.5 py-0.5">
                                        <Check className="w-3 h-3 text-cyan-400" />
                                        <span>All modifications applied via uniform album edits above</span>
                                      </div>
                                    ) : (
                                      <div className="ml-6 text-[11px] font-mono text-zinc-500 flex items-center gap-1.5">
                                        <Check className="w-3 h-3 text-emerald-400" />
                                        <span>
                                          {track.pendingSidecarEdits?.coverArtUrl
                                            ? 'Audio tags identical to current file • Album artwork updated'
                                            : 'Staged for sidecar ledger creation (cadence-album.sidecar.json) • Bit-perfect audio tags intact'}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>

                {/* Right Pane (Sticky Archival Inspector) */}
                <div className="w-[380px] xl:w-[420px] shrink-0 bg-[#0c0d14] rounded-2xl border border-white/[0.08] p-4 flex flex-col gap-4 shadow-2xl overflow-y-auto">
                  {selectedReleaseData ? (
                    <>
                      {/* Header */}
                      <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
                        <div className="flex flex-col text-left">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                              <ImageIcon className="w-3.5 h-3.5" />
                            </div>
                            <span className="text-xs font-mono font-semibold tracking-wide uppercase text-zinc-300">
                              Archival Inspector
                            </span>
                            {isRunning && (
                              <span className="text-[10px] font-mono px-2 py-0.2 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 flex items-center gap-1">
                                <Lock className="w-2.5 h-2.5" />
                                <span>Snapshot</span>
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] text-zinc-400 font-mono mt-0.5">
                            Selected Album Scope: {selectedReleaseData.relTracks.length} of {allMetrics.audioTrackCount} batch tracks
                          </span>
                        </div>
                        {selectedReleaseData.stagedCoverArt && (
                          <button
                            type="button"
                            onClick={() =>
                              setInspectingArtwork({
                                currentUrl: selectedReleaseData.currentCoverArt,
                                stagedUrl: selectedReleaseData.stagedCoverArt,
                                albumTitle: selectedReleaseData.albumTitle,
                                currentRes: selectedReleaseData.currentRes,
                                stagedRes: selectedReleaseData.stagedRes,
                              })
                            }
                            className="px-2 py-1 rounded-lg bg-white/[0.05] hover:bg-white/10 text-zinc-300 hover:text-white transition-all text-[11px] font-mono flex items-center gap-1.5 cursor-pointer border border-white/10"
                            title="Open Fullscreen Lightbox"
                          >
                            <Maximize2 className="w-3 h-3 text-cyan-400" />
                            <span>Lightbox</span>
                          </button>
                        )}
                      </div>

                      {/* Album Identity */}
                      <div className="flex flex-col text-left gap-0.5">
                        <div className="text-sm font-bold text-white truncate" title={selectedReleaseData.albumTitle}>
                          {selectedReleaseData.albumTitle}
                        </div>
                        <div className="text-xs text-zinc-400 font-mono truncate">
                          {selectedReleaseData.artistCredit}
                        </div>
                        {selectedReleaseData.folderName && (
                          <div className="text-[10px] text-cyan-400/80 font-mono truncate flex items-center gap-1 mt-0.5">
                            <Folder className="w-3 h-3 shrink-0" />
                            <span className="truncate">{selectedReleaseData.folderName}</span>
                          </div>
                        )}
                      </div>

                      {/* Artwork View Mode Toggle & Canvas */}
                      <div className="flex flex-col gap-2.5">
                        <div className="flex items-center justify-between bg-black/60 p-1 rounded-xl border border-white/[0.08]">
                          <button
                            type="button"
                            onClick={() => setInspectorArtTab('split')}
                            className={`flex-1 py-1 text-[11px] font-mono rounded-lg transition-all cursor-pointer ${
                              inspectorArtTab === 'split'
                                ? 'bg-white/[0.14] text-white font-semibold shadow-sm'
                                : 'text-zinc-400 hover:text-white'
                            }`}
                          >
                            Side-by-Side
                          </button>
                          <button
                            type="button"
                            onClick={() => setInspectorArtTab('staged')}
                            className={`flex-1 py-1 text-[11px] font-mono rounded-lg transition-all cursor-pointer ${
                              inspectorArtTab === 'staged'
                                ? 'bg-purple-500/25 text-purple-200 border border-purple-500/30 font-semibold'
                                : 'text-zinc-400 hover:text-white'
                            }`}
                          >
                            Staged HD
                          </button>
                          <button
                            type="button"
                            onClick={() => setInspectorArtTab('current')}
                            className={`flex-1 py-1 text-[11px] font-mono rounded-lg transition-all cursor-pointer ${
                              inspectorArtTab === 'current'
                                ? 'bg-white/[0.14] text-white font-semibold shadow-sm'
                                : 'text-zinc-400 hover:text-white'
                            }`}
                          >
                            Current
                          </button>
                        </div>

                        {/* Artwork Preview Canvas */}
                        {inspectorArtTab === 'split' ? (
                          <div className="grid grid-cols-2 gap-2.5">
                            {/* Current Artwork Card */}
                            <ArtworkDisplayCard
                              url={selectedReleaseData.currentCoverArt}
                              label="Current Artwork"
                              badgeText="Current"
                              badgeColor="zinc"
                              resolution={selectedReleaseData.currentRes}
                              emptyTitle="No Embedded Artwork"
                              emptySubtitle="File contains no embedded cover"
                            />

                            {/* Staged Artwork Card */}
                            <ArtworkDisplayCard
                              url={selectedReleaseData.stagedCoverArt}
                              label="Staged HD Artwork"
                              badgeText="Staged HD"
                              badgeColor="purple"
                              isStaged
                              resolution={selectedReleaseData.stagedRes}
                              emptyTitle="Unchanged"
                              emptySubtitle="No new artwork staged for release"
                              onClick={
                                selectedReleaseData.stagedCoverArt
                                  ? () =>
                                      setInspectingArtwork({
                                        currentUrl: selectedReleaseData.currentCoverArt,
                                        stagedUrl: selectedReleaseData.stagedCoverArt,
                                        albumTitle: selectedReleaseData.albumTitle,
                                        currentRes: selectedReleaseData.currentRes,
                                        stagedRes: selectedReleaseData.stagedRes,
                                      })
                                  : undefined
                              }
                            />
                          </div>
                        ) : inspectorArtTab === 'staged' ? (
                          <div className="flex flex-col gap-2">
                            <ArtworkDisplayCard
                              url={selectedReleaseData.stagedCoverArt}
                              label="Staged Archival Cover"
                              badgeText="Staged Archival Cover"
                              badgeColor="purple"
                              isStaged
                              resolution={selectedReleaseData.stagedRes}
                              emptyTitle="No Staged Art"
                              emptySubtitle="No artwork replacement queued"
                              onClick={
                                selectedReleaseData.stagedCoverArt
                                  ? () =>
                                      setInspectingArtwork({
                                        currentUrl: selectedReleaseData.currentCoverArt,
                                        stagedUrl: selectedReleaseData.stagedCoverArt,
                                        albumTitle: selectedReleaseData.albumTitle,
                                        currentRes: selectedReleaseData.currentRes,
                                        stagedRes: selectedReleaseData.stagedRes,
                                      })
                                  : undefined
                              }
                            />
                          </div>
                        ) : (
                          <div className="flex flex-col gap-2">
                            <ArtworkDisplayCard
                              url={selectedReleaseData.currentCoverArt}
                              label="Current Disk Art"
                              badgeText="Current Disk Art"
                              badgeColor="zinc"
                              resolution={selectedReleaseData.currentRes}
                              emptyTitle="No Current Art"
                              emptySubtitle="Audio files have no local cover art"
                            />
                          </div>
                        )}
                      </div>

                      {/* Quick Actions for Selected Album */}
                      <div className="flex items-center gap-2 pt-1 flex-wrap">
                        {selectedReleaseData.stagedCoverArt && onDiscardReleaseArtwork && (
                          <button
                            type="button"
                            disabled={isRunning}
                            onClick={() => onDiscardReleaseArtwork(selectedReleaseData.relId)}
                            title={isRunning ? 'Unavailable while commit is in progress' : 'Revert staged cover art for this album'}
                            className={`flex-1 py-1.5 px-2 rounded-xl text-xs font-mono border transition-all flex items-center justify-center gap-1.5 ${
                              isRunning
                                ? 'opacity-40 cursor-not-allowed text-zinc-600 bg-white/[0.02] border-white/5'
                                : 'text-rose-300 bg-rose-500/10 border-rose-500/25 hover:bg-rose-500/20 cursor-pointer'
                            }`}
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>Revert Art</span>
                          </button>
                        )}
                        {onUpdateReleaseArtwork && (
                          <button
                            type="button"
                            disabled={isRunning}
                            onClick={() => {
                              if (customUrlReleaseId === selectedReleaseData.relId) {
                                setCustomUrlReleaseId(null)
                                setCustomUrlInput('')
                              } else {
                                setCustomUrlReleaseId(selectedReleaseData.relId)
                                setCustomUrlInput(selectedReleaseData.stagedCoverArt || '')
                              }
                            }}
                            title={isRunning ? 'Unavailable while commit is in progress' : 'Provide custom artwork URL for this album'}
                            className={`flex-1 py-1.5 px-2 rounded-xl text-xs font-mono border transition-all flex items-center justify-center gap-1.5 ${
                              isRunning
                                ? 'opacity-40 cursor-not-allowed text-zinc-600 bg-white/[0.02] border-white/5'
                                : customUrlReleaseId === selectedReleaseData.relId
                                ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300 font-semibold cursor-pointer'
                                : 'bg-white/[0.04] border-white/10 text-cyan-300 hover:bg-cyan-500/10 hover:border-cyan-500/30 cursor-pointer'
                            }`}
                          >
                            <Link className="w-3 h-3" />
                            <span>Custom URL</span>
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isRunning}
                          onClick={() =>
                            toggleReleaseExclusion(selectedReleaseData.relId, selectedReleaseData.relTracks)
                          }
                          title={isRunning ? 'Unavailable while commit is in progress' : undefined}
                          className={`flex-1 py-1.5 px-2 rounded-xl text-xs font-mono border transition-all flex items-center justify-center gap-1.5 ${
                            isRunning
                              ? 'opacity-40 cursor-not-allowed text-zinc-600 bg-white/[0.02] border-white/5'
                              : selectedReleaseData.allTracksExcluded
                              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 cursor-pointer'
                              : 'bg-white/[0.04] border-white/10 text-zinc-400 hover:text-white hover:bg-white/[0.08] cursor-pointer'
                          }`}
                        >
                          <Check className="w-3 h-3" />
                          <span>{selectedReleaseData.allTracksExcluded ? 'Include Album' : 'Exclude Album'}</span>
                        </button>
                      </div>

                      {/* Custom Artwork URL Inline Card */}
                      {customUrlReleaseId === selectedReleaseData.relId && !isRunning && (
                        <div className="p-3 rounded-xl bg-black/60 border border-cyan-500/30 flex flex-col gap-2.5 animate-in fade-in duration-150">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-mono text-cyan-300 font-semibold flex items-center gap-1.5">
                              <Link className="w-3 h-3 text-cyan-400" />
                              <span>Provide Custom Artwork URL:</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setCustomUrlReleaseId(null)
                                setCustomUrlInput('')
                              }}
                              className="text-zinc-500 hover:text-white p-0.5"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="url"
                              value={customUrlInput}
                              onChange={(e) => setCustomUrlInput(e.target.value)}
                              placeholder="https://... or file:///... image URL"
                              className="flex-1 px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-white/10 text-xs font-mono text-white placeholder:text-zinc-600 focus:outline-none focus:border-cyan-400/60"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleApplyCustomUrl(selectedReleaseData.relId)
                                if (e.key === 'Escape') setCustomUrlReleaseId(null)
                              }}
                              autoFocus
                            />
                            <button
                              type="button"
                              disabled={!customUrlInput.trim()}
                              onClick={() => handleApplyCustomUrl(selectedReleaseData.relId)}
                              className="px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-xs font-mono font-medium disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                            >
                              Apply
                            </button>
                          </div>
                          {customUrlInput.trim() && (
                            <div className="flex items-center gap-2 pt-1 border-t border-white/[0.05]">
                              <div className="w-7 h-7 rounded bg-black border border-white/10 overflow-hidden shrink-0 flex items-center justify-center">
                                <img
                                  src={customUrlInput.trim()}
                                  alt="Preview"
                                  className="w-full h-full object-cover"
                                  onError={(e) => ((e.target as HTMLElement).style.display = 'none')}
                                />
                              </div>
                              <span className="text-[10px] text-zinc-400 font-mono truncate">
                                Live Preview: {customUrlInput.trim()}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Staged Operations & Tag Changes Summary */}
                      <div className="flex flex-col gap-2 pt-2 border-t border-white/[0.06] text-left">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                          Staged Mutations ({selectedReleaseData.relTracks.length} Tracks)
                        </span>
                        <div className="flex flex-col gap-1.5">
                          {selectedReleaseData.stagedCoverArt && (
                            <div className="p-2.5 rounded-xl bg-purple-500/[0.08] border border-purple-500/20 flex items-start gap-2 text-xs">
                              <ImageIcon className="w-3.5 h-3.5 text-purple-400 shrink-0 mt-0.5" />
                              <div className="flex flex-col">
                                <span className="font-semibold text-purple-200">Cover Artwork Write</span>
                                <span className="text-[10px] text-purple-300/80 font-mono mt-0.5">
                                  Writes high-resolution cover.jpg to folder & updates sidecar ledger.
                                </span>
                              </div>
                            </div>
                          )}

                          {selectedReleaseData.realEdits.length > 0 ? (
                            <div className="p-2.5 rounded-xl bg-emerald-500/[0.08] border border-emerald-500/20 flex items-start gap-2 text-xs">
                              <Music className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                              <div className="flex flex-col min-w-0">
                                <span className="font-semibold text-emerald-200">
                                  {selectedReleaseData.realEdits.length} Tag Field Modification{selectedReleaseData.realEdits.length > 1 ? 's' : ''}
                                </span>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {Array.from(new Set(selectedReleaseData.realEdits.map((e) => e.label))).map((lbl) => (
                                    <span
                                      key={lbl}
                                      className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-[9px] font-mono text-emerald-300"
                                    >
                                      {lbl}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.06] flex items-center gap-2 text-[11px] text-zinc-400 font-mono">
                              <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                              <span>Bit-perfect audio tags intact</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 text-zinc-500 py-12">
                      <ImageIcon className="w-8 h-8 text-zinc-600" />
                      <span className="text-xs font-mono font-medium text-zinc-400">Archival Inspector</span>
                      <span className="text-[11px] text-zinc-500 max-w-[240px]">
                        Select an album on the left to inspect high-resolution cover art and tag diffs.
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            /* 4. Execution Pipeline & Drawer View */
            <div className="flex-1 overflow-y-auto pr-1 flex flex-col gap-4 min-h-0">
              {isRunning ? (
                /* Active Execution Progress Hero */
                <div className="p-6 rounded-2xl bg-gradient-to-br from-[#0F172A]/90 via-[#0B0F19] to-black border border-white/[0.12] shadow-xl flex flex-col gap-4 relative overflow-hidden text-left">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2.5">
                      <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-xs font-semibold">
                        <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                        <span>Writing Changes to Storage...</span>
                      </div>
                      <span className="text-xs text-slate-400 font-mono">
                        {detailedProgress
                          ? `${detailedProgress.processedTracks} of ${detailedProgress.totalTracks} tracks`
                          : `${activeTracksToCommit.length} tracks in queue`}
                      </span>
                    </div>

                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-bold text-white tracking-tight font-mono">
                        {detailedProgress ? detailedProgress.percent : '0'}
                      </span>
                      <span className="text-sm font-semibold text-cyan-400 font-mono">%</span>
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full h-2.5 bg-black/70 rounded-full overflow-hidden border border-white/10 p-0.5 relative shadow-inner">
                    <div
                      className="h-full rounded-full transition-all duration-300 bg-gradient-to-r from-cyan-400 via-emerald-400 to-lime-400 shadow-[0_0_14px_rgba(0,245,255,0.5)]"
                      style={{
                        width: `${Math.max(0, Math.min(100, detailedProgress?.percent ?? 0))}%`,
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-xs text-slate-400 px-0.5 font-mono">
                    <span className="flex items-center gap-1.5">
                      <Timer className="w-3.5 h-3.5 text-cyan-400" />
                      <span>{formatDuration(detailedProgress?.etaSeconds)}</span>
                    </span>
                    <span>Elapsed: {formatElapsed(detailedProgress?.elapsedMs || 0)}</span>
                  </div>

                  {detailedProgress?.currentTrack && (
                    <div className="p-3.5 rounded-xl bg-black/50 border border-cyan-500/30 flex items-center justify-between gap-3 animate-in fade-in duration-200">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-lg bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
                          <Music className="w-4 h-4 animate-bounce" />
                        </div>
                        <div className="flex flex-col min-w-0 text-left">
                          <span className="text-xs font-bold text-white truncate">
                            {detailedProgress.currentTrack.title || 'Untitled Track'}
                          </span>
                          <span className="text-[11px] text-slate-400 truncate">
                            {detailedProgress.currentTrack.artistCredit || 'Unknown Artist'}
                          </span>
                        </div>
                      </div>
                      <Loader2 className="w-4 h-4 text-cyan-400 animate-spin shrink-0" />
                    </div>
                  )}
                </div>
              ) : isCompleted ? (
                /* Completed State Hero */
                <div className="p-6 rounded-2xl bg-gradient-to-br from-emerald-950/40 via-[#0B0F19] to-black border border-emerald-500/30 shadow-xl flex flex-col items-center justify-center text-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-lg shadow-emerald-500/20">
                    <CheckCircle2 className="w-6 h-6 stroke-[2.5]" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-base font-bold text-white">All Changes Committed Successfully</h3>
                    <p className="text-xs text-zinc-400 max-w-md font-mono">
                      {committedSummary && committedSummary.embedded > 0
                        ? `${committedSummary.embedded} audio headers and ${committedSummary.sidecars} library records updated bit-perfectly in ${committedSummary.durationMs}ms.`
                        : `${committedSummary?.total ?? activeTracksToCommit.length} album sidecars updated bit-perfectly on disk.`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <button
                      type="button"
                      onClick={handleRollback}
                      className="px-3.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 border border-white/10 text-xs font-mono transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Rollback This Transaction</span>
                    </button>
                  </div>
                </div>
              ) : (
                /* Idle Technical Details Drawer */
                <div className="p-6 rounded-2xl bg-gradient-to-br from-white/[0.03] to-black border border-white/[0.08] shadow-lg flex flex-col items-center justify-center text-center gap-3">
                  <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                    <ShieldCheck className="w-6 h-6" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-base font-bold text-white">Ready to Commit Changes</h3>
                    <p className="text-xs text-zinc-400 max-w-md font-mono">
                      Targeting {activeTracksToCommit.length} tracks across {activeMetrics.albumCount} albums.
                    </p>
                  </div>
                </div>
              )}

              {/* Partial Failures / Retry Drawer */}
              {failedTracks.length > 0 && (
                <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 space-y-3 text-left">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-rose-300 font-bold text-xs">
                      <AlertTriangle className="w-4 h-4 text-rose-400" />
                      <span>Partial Write Failures ({failedTracks.length} tracks)</span>
                    </div>
                    <button
                      type="button"
                      onClick={handleRetryFailed}
                      className="px-3 py-1 rounded-lg text-xs font-mono font-semibold bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 transition-all cursor-pointer flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Retry Failed ({failedTracks.length})</span>
                    </button>
                  </div>
                  <div className="space-y-1 max-h-36 overflow-y-auto">
                    {failedTracks.map((ft, idx) => (
                      <div
                        key={idx}
                        className="p-2 bg-black/40 rounded-lg text-[11px] font-mono text-zinc-300 flex items-center justify-between"
                      >
                        <span className="truncate max-w-md">{ft.filePath}</span>
                        <span className="text-rose-400 shrink-0">{ft.error}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Technical Pipeline Steps Log */}
              <div className="rounded-xl border border-white/[0.06] overflow-hidden bg-white/[0.01]">
                <button
                  type="button"
                  onClick={() => setShowTechDetails(!showTechDetails)}
                  className="w-full p-3.5 px-4 flex items-center justify-between text-xs text-slate-300 hover:bg-white/[0.03] transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    <span className="font-semibold text-slate-200">Technical Preflight & Execution Log</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <span>{showTechDetails ? 'Hide details' : 'Show details'}</span>
                    {showTechDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </button>

                {showTechDetails && (
                  <div className="p-4 border-t border-white/[0.06] flex flex-col gap-2 bg-black/30 text-left">
                    {progressSteps.map((step, idx) => (
                      <div
                        key={step.step}
                        className={`p-3 rounded-xl border text-xs flex items-center justify-between transition-all ${
                          step.completed
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-white'
                            : step.hasError
                            ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                            : isRunning && idx === progressSteps.findIndex((s) => !s.completed)
                            ? 'bg-cyan-500/10 border-cyan-500/40 text-cyan-300'
                            : 'bg-white/[0.02] border-white/[0.04] text-slate-500'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 font-mono">
                          {step.completed ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          ) : step.hasError ? (
                            <AlertTriangle className="w-4 h-4 text-rose-400" />
                          ) : isRunning && idx === progressSteps.findIndex((s) => !s.completed) ? (
                            <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
                          ) : (
                            <div className="w-4 h-4 rounded-full border border-white/20 flex items-center justify-center text-[10px]">
                              {idx + 1}
                            </div>
                          )}
                          <span className="font-medium">{step.label}</span>
                        </div>
                        {step.detail && <span className="text-[10px] text-slate-400 font-mono">{step.detail}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Error Notice */}
          {errorMessage && (
            <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        {/* 4. Sticky Destination Footer Bar & Dynamic Execution CTA */}
        <div className="p-4 px-6 border-t border-white/[0.08] bg-[#121318]/95 backdrop-blur-md flex flex-col sm:flex-row sm:items-center justify-between gap-4 shrink-0">
          {/* Destination Selector with Explicit Audiophile Trade-Off Copy */}
          <div className="flex items-center gap-3">
            {/* Embedded Header Option (Default) */}
            <button
              type="button"
              disabled={isRunning}
              onClick={() => setCommitTarget('embedded')}
              title={isRunning ? 'Write strategy is locked during commit execution' : undefined}
              className={`p-2.5 px-3.5 rounded-xl border text-left transition-all flex flex-col gap-0.5 ${
                isRunning ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'
              } ${
                commitTarget === 'embedded'
                  ? 'bg-purple-500/[0.08] border-purple-500/40 text-zinc-100 shadow-sm'
                  : 'bg-white/[0.02] border-white/[0.05] text-zinc-400 hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${
                    commitTarget === 'embedded' ? 'bg-purple-400' : 'border border-zinc-600'
                  }`}
                />
                <span className="text-xs font-mono font-semibold">Embed Headers (FLAC Vorbis / ID3v2.4 / ALAC / DSF)</span>
                <span className="text-[9px] font-mono uppercase px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300">
                  Default • Mutates File
                </span>
                {isRunning && commitTarget === 'embedded' && (
                  <span className="flex items-center gap-1 text-[9px] font-mono text-zinc-400 ml-1">
                    <Lock className="w-2.5 h-2.5 text-purple-400" />
                    <span>Locked</span>
                  </span>
                )}
              </div>
              <span className="text-[10px] text-zinc-400 font-sans pl-4">
                Portable tags for standalone UPnP streamers • Mutates container file hashes • Audio bit-identical
              </span>
            </button>

            {/* Sidecar Option */}
            <button
              type="button"
              disabled={isRunning}
              onClick={() => setCommitTarget('sidecar')}
              title={isRunning ? 'Write strategy is locked during commit execution' : undefined}
              className={`p-2.5 px-3.5 rounded-xl border text-left transition-all flex flex-col gap-0.5 ${
                isRunning ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'
              } ${
                commitTarget === 'sidecar'
                  ? 'bg-amber-500/[0.08] border-amber-500/40 text-zinc-100 shadow-sm'
                  : 'bg-white/[0.02] border-white/[0.05] text-zinc-400 hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${
                    commitTarget === 'sidecar' ? 'bg-amber-400' : 'border border-zinc-600'
                  }`}
                />
                <span className="text-xs font-mono font-semibold">Sidecar JSON (cadence-album.sidecar.json)</span>
                <span className="text-[9px] font-mono uppercase px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-300/80">
                  Non-Destructive
                </span>
                {isRunning && commitTarget === 'sidecar' && (
                  <span className="flex items-center gap-1 text-[9px] font-mono text-zinc-400 ml-1">
                    <Lock className="w-2.5 h-2.5 text-amber-400" />
                    <span>Locked</span>
                  </span>
                )}
              </div>
              <span className="text-[10px] text-zinc-400 font-sans pl-4">
                Zero audio file checksum mutation • Preserves bitstream hashes • Non-portable to external UPnP
              </span>
            </button>
          </div>

          {/* Action Buttons with Real-Time Dynamic Count */}
          <div className="flex items-center gap-3 shrink-0">
            {onDiscardAll && !isCompleted && uncommittedTracks.length > 0 && !isRunning && (
              <button
                type="button"
                onClick={onDiscardAll}
                className="px-3.5 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 font-mono text-xs transition-all flex items-center gap-1.5 cursor-pointer"
                title="Discard all pending staged edits"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Discard All</span>
              </button>
            )}

            {isRunning ? (
              <div
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white/[0.04] border border-white/10 text-xs font-mono text-zinc-400 select-none cursor-not-allowed"
                title="Disk write transaction in progress. Navigation is available via tabs, but the commit cannot be interrupted safely midway."
              >
                <Lock className="w-3.5 h-3.5 text-amber-400" />
                <span>Writing Locked</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-mono text-zinc-400 hover:text-white cursor-pointer transition-colors"
              >
                {isCompleted ? 'Close' : 'Cancel'}
              </button>
            )}

            {!isCompleted && uncommittedTracks.length > 0 && (
              <button
                type="button"
                onClick={() => handleStartCommit()}
                disabled={isRunning || !preflight.storageWritable || activeTracksToCommit.length === 0}
                title={
                  !preflight.storageWritable
                    ? 'Storage mount is read-only locked.'
                    : activeTracksToCommit.length === 0
                    ? 'All staged tracks are currently excluded.'
                    : !preflight.playbackIdle
                    ? 'Audio playback active. Changes will be saved safely in background during playback silence.'
                    : undefined
                }
                className={`px-5 py-2 rounded-xl text-xs font-mono font-semibold transition-all flex items-center gap-2 shadow-lg cursor-pointer ${
                  isRunning
                    ? 'bg-amber-500/50 text-black cursor-wait'
                    : !preflight.storageWritable || activeTracksToCommit.length === 0
                    ? 'bg-zinc-800 text-zinc-500 border border-zinc-700 cursor-not-allowed'
                    : 'bg-amber-400 hover:bg-amber-300 text-black shadow-amber-400/20'
                }`}
              >
                {isRunning ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Enqueuing...</span>
                  </>
                ) : !preflight.storageWritable ? (
                  <>
                    <span>🔒 Storage Read-Only</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-3.5 h-3.5 stroke-[2.5]" />
                    <span>
                      {commitTarget === 'sidecar'
                        ? `Save ${activeMetrics.albumCount} Album Sidecar${activeMetrics.albumCount === 1 ? '' : 's'}`
                        : `Save ${activeMetrics.audioTrackCount} Track${activeMetrics.audioTrackCount === 1 ? '' : 's'} in Background`}
                    </span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Side-by-Side Artwork Full Inspection Lightbox Modal */}
      {inspectingArtwork && (
        <div
          className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-6 animate-in fade-in duration-150"
          onClick={() => setInspectingArtwork(null)}
        >
          <div
            className="bg-[#0e1017] border border-white/20 rounded-3xl p-6 max-w-4xl w-full flex flex-col gap-5 shadow-2xl relative"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <span>Artwork Inspection</span>
                  <span className="text-zinc-400 font-normal text-sm font-mono">• {inspectingArtwork.albumTitle}</span>
                </h3>
                <p className="text-xs text-zinc-400 font-mono mt-0.5">Side-by-side comparison of local vs. staged archival cover art</p>
              </div>
              <button
                type="button"
                onClick={() => setInspectingArtwork(null)}
                className="p-1.5 rounded-xl hover:bg-white/10 text-zinc-400 hover:text-white transition-all cursor-pointer"
                title="Close inspection"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
              {/* Current Artwork */}
              <LightboxArtworkCard
                url={inspectingArtwork.currentUrl}
                label="Current Artwork"
                badgeText="Current Artwork"
                res={inspectingArtwork.currentRes}
              />

              {/* Staged Archival Cover */}
              <LightboxArtworkCard
                url={inspectingArtwork.stagedUrl}
                label="Staged Archival Cover"
                badgeText="Staged Archival Cover"
                res={inspectingArtwork.stagedRes}
                isStaged
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-white/[0.08] text-xs font-mono text-zinc-400">
              <span>Press <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-zinc-300">Esc</kbd> or click outside to dismiss</span>
              <button
                type="button"
                onClick={() => setInspectingArtwork(null)}
                className="px-4 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-mono transition-all cursor-pointer"
              >
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
