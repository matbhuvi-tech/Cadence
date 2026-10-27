import React, { useState, useEffect } from 'react'
import {
  AlertTriangle,
  FolderTree,
  FolderPlus,
  Folder,
  FolderCheck,
  Sparkles,
  HardDrive,
  ShieldCheck,
  Check,
  RefreshCw,
  Trash2,
  FileCode,
  ArrowRight,
  Database,
  Lock,
  Unlock,
  Eye,
  SlidersHorizontal,
  ChevronRight,
  ChevronDown,
  Search,
  Cpu,
  Image as ImageIcon,
  CheckCircle2,
  Layers,
  Users,
  Music,
  Mic,
  EyeOff,
  Pause,
  Play,
  StopCircle,
} from 'lucide-react'
import { Track, Release, AuditIssue, StorageMount, WatchedFolder, SkippedFile, ActiveEntityScope } from '../../core/types'
import { graphEngine } from '../../core/graphEngine'
import { normalizationService, NormalizationRule } from '../../services/normalizationService'
import { auditService } from '../../services/auditService'
import { useMaintenanceWorker } from '../../hooks/useMaintenanceWorker'
import { useCatalogHealth } from '../../hooks/useCatalogHealth'
import { tauriBridge, MaintenanceStats } from '../../services/tauriBridge'
import { isIssueInEntityScope } from '../../core/scopeUtils'
import { backgroundArtworkService, BackgroundArtworkState } from '../../services/backgroundArtworkService'

export type MaintainSubTab = 'needs_attention' | 'organize_files' | 'metadata_matching' | 'storage_mounts' | 'pending_changes'

// Canonical Target and Presentation Helpers for Audit Clusters
export const getIssueCanonicalTarget = (issue: AuditIssue, tracks: Track[] = [], releases: Release[] = []): string => {
  // 1. Explicit canonicalTarget property
  if (issue.canonicalTarget && issue.canonicalTarget.trim()) {
    return issue.canonicalTarget.trim()
  }

  // 2. Explicit targetValue property for normalization
  if (issue.targetValue && issue.targetValue.trim() && issue.category === 'inconsistent_name') {
    return issue.targetValue.trim()
  }

  // 3. Parent entity (e.g. composer / album artist authority for role conflicts)
  if (issue.parentEntity && issue.parentEntity.trim()) {
    return issue.parentEntity.trim()
  }

  // 4. Regex extraction from proposedAction or suggestedFix
  const actionText = `${issue.proposedAction || ''} ${issue.suggestedFix || ''}`
  const match = actionText.match(/(?:ALBUMARTIST\s*=\s*|to\s+(?:canonical\s+authority\s+)?|Standardize to\s+)["']([^"']+)["']/i)
  if (match && match[1] && match[1].trim()) {
    return match[1].trim()
  }

  // 5. Category-level domain groupings
  if (issue.category === 'unformatted_backdrop' || issue.category === 'low_res_art') {
    return 'Artwork & Media Integrity'
  }
  if (issue.category === 'missing_track_num') {
    return 'Sequential Track Indexing'
  }
  if (issue.category === 'checksum_mismatch') {
    return 'Bitstream & Checksum Integrity'
  }
  if (issue.category === 'empty_composer') {
    return 'Untagged Audio Standards'
  }
  if (issue.category === 'uncommitted_sidecar') {
    return 'Pending Metadata Changes'
  }

  // 6. Track/Release-scoped resolution
  if (issue.sampleTrackIds && issue.sampleTrackIds.length > 0) {
    const firstTrack = tracks.find((t) => t.id === issue.sampleTrackIds[0])
    if (firstTrack) {
      const rel = releases.find((r) => r.id === firstTrack.releaseId)
      if (rel?.artistCredit && rel.artistCredit.trim() && !/^(various artists|soundtrack|unknown)$/i.test(rel.artistCredit)) {
        return rel.artistCredit.trim()
      }
      if (rel?.composerName && rel.composerName.trim()) {
        return rel.composerName.trim()
      }
      if (firstTrack.composerName && firstTrack.composerName.trim() && !/^(unknown)$/i.test(firstTrack.composerName)) {
        return firstTrack.composerName.trim()
      }
      if (firstTrack.artistCredit && firstTrack.artistCredit.trim() && !/^(unknown)$/i.test(firstTrack.artistCredit)) {
        return firstTrack.artistCredit.trim()
      }
    }
  }

  return 'Catalog Standards'
}

export const getIssueDetectedValue = (issue: AuditIssue, canonicalTarget: string, tracks: Track[] = []): string => {
  // 1. Explicit currentValue
  if (issue.currentValue && issue.currentValue.trim()) {
    return issue.currentValue.trim()
  }

  // 2. Clean detectedValue (if not an old verbose issue title or log string)
  if (
    issue.detectedValue &&
    issue.detectedValue.trim() &&
    !issue.detectedValue.startsWith('Inconsistent') &&
    !issue.detectedValue.startsWith('Untagged') &&
    !issue.detectedValue.startsWith('Discovered')
  ) {
    return issue.detectedValue.trim()
  }

  // 3. For inconsistent_name, extract the actual variant from title or description
  if (issue.category === 'inconsistent_name') {
    const vsMatch = (issue.title || '').match(/vs\s+["']([^"']+)["']/i)
    if (vsMatch && vsMatch[1]) return vsMatch[1].trim()

    const spellMatch = (issue.description || '').match(/spelling\s+["']([^"']+)["']/i)
    if (spellMatch && spellMatch[1]) return spellMatch[1].trim()

    // Find sample track whose artistCredit or composerName differs from canonical
    if (issue.sampleTrackIds && issue.sampleTrackIds.length > 0) {
      const variantTrk = tracks.find(
        (t) =>
          issue.sampleTrackIds.includes(t.id) &&
          t.artistCredit &&
          t.artistCredit.trim() !== canonicalTarget
      )
      if (variantTrk) return variantTrk.artistCredit.trim()
    }
  }

  // 4. Role conflicts (performer singer)
  if (issue.isRoleConflict || issue.category === 'compilation_conflict') {
    const singerMatch = (issue.title || '').match(/Performer vs\. Composer:\s+["']([^"']+)["']/i)
    if (singerMatch && singerMatch[1]) return singerMatch[1].trim()
    if (issue.sampleTrackIds && issue.sampleTrackIds.length > 0) {
      const trk = tracks.find((t) => issue.sampleTrackIds.includes(t.id))
      if (trk?.artistCredit) return trk.artistCredit
    }
  }

  // 5. Domain fallbacks
  if (issue.category === 'uncommitted_sidecar') return `${issue.affectedCount} Pending Edits`
  if (issue.category === 'low_res_art') return issue.detectedValue || 'Low-Res Cover (< 800px)'
  if (issue.category === 'missing_track_num') return 'Missing Index (0 / Null)'
  if (issue.category === 'checksum_mismatch') return 'Stream CRC Failure'
  if (issue.category === 'empty_composer') return 'Unknown Artist'

  return issue.detectedValue || issue.title
}

export const getIssueProposedAction = (issue: AuditIssue, canonicalTarget: string): string => {
  if (issue.category === 'empty_composer') {
    return 'Parse Artist & Composer from Folder Hierarchy'
  }

  if (issue.category === 'low_res_art') {
    return 'Fetch Archival Artwork (Apple Music / MusicBrainz)'
  }

  if (issue.targetValue && issue.tagField === 'ALBUMARTIST' && !issue.targetValue.includes('Folder') && !issue.targetValue.includes('Extract') && !issue.targetValue.includes('Parse')) {
    return `ALBUMARTIST = "${issue.targetValue}"`
  }

  if (issue.category === 'inconsistent_name') {
    const target = issue.targetValue || issue.canonicalTarget || canonicalTarget
    return `ALBUMARTIST = "${target}"`
  }

  if (issue.isRoleConflict) {
    const val = issue.currentValue || issue.detectedValue || 'Performer'
    return `ARTIST = "${val}" (Keep Singer)`
  }

  if (issue.category === 'uncommitted_sidecar') {
    return 'Review & Save Pending Changes'
  }

  if (issue.category === 'unformatted_backdrop') {
    return 'Generate Atmospheric Backdrop'
  }

  if (issue.category === 'missing_track_num') {
    return 'TRACKNUMBER = Sequential (01..N)'
  }

  if (issue.category === 'checksum_mismatch') {
    return 'Restore from Bit-Perfect Backup'
  }

  if (issue.proposedAction && !issue.proposedAction.startsWith('Standardize to')) {
    return issue.proposedAction
  }

  return issue.proposedAction || issue.suggestedFix
}

export const getIssueTagBadge = (issue: AuditIssue) => {
  if (issue.category === 'uncommitted_sidecar') {
    return {
      label: 'PENDING EDITS',
      className: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
    }
  }
  if (issue.category === 'unformatted_backdrop') {
    return {
      label: 'ARTWORK / BACKDROP',
      className: 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30',
    }
  }
  if (issue.category === 'low_res_art') {
    return {
      label: 'COVER ART',
      className: 'bg-pink-500/15 text-pink-300 border border-pink-500/30',
    }
  }
  if (issue.category === 'missing_track_num') {
    return {
      label: 'TRACK NUM',
      className: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
    }
  }
  if (issue.category === 'checksum_mismatch') {
    return {
      label: 'INTEGRITY',
      className: 'bg-rose-500/15 text-rose-300 border border-rose-500/30',
    }
  }
  if (issue.isRoleConflict || issue.tagField === 'ARTIST') {
    return {
      label: 'ARTIST',
      className: 'bg-purple-500/15 text-purple-300 border border-purple-500/30',
    }
  }
  if (issue.category === 'inconsistent_name' || issue.tagField === 'ALBUMARTIST') {
    return {
      label: 'ALBUMARTIST',
      className: 'bg-blue-500/15 text-blue-300 border border-blue-500/30',
    }
  }
  if (issue.category === 'empty_composer') {
    return {
      label: 'METADATA',
      className: 'bg-orange-500/15 text-orange-300 border border-orange-500/30',
    }
  }
  return {
    label: issue.tagField || 'METADATA',
    className: 'bg-zinc-500/15 text-zinc-300 border border-zinc-500/30',
  }
}

interface MaintainCockpitProps {
  tracks: Track[]
  releases: Release[]
  auditIssues: AuditIssue[]
  storageMounts: StorageMount[]
  watchedFolders: WatchedFolder[]
  skippedFiles: SkippedFile[]
  uncommittedCount: number
  onRemediateAudit: (issueId: string) => void
  onRefreshAudit: () => void
  onDiscardTrackEdits?: (trackIds: string[]) => void
  onApplyPathRestructure: (pattern: string) => void
  onCommitTwoPhase: () => void
  onToggleMountLock: (mountId: string) => void
  onToggleMountStatus: (mountId: string) => void
  onTriggerScan: (folderPath?: string) => void
  onRefreshLibrary: () => void
  onSelectTrack?: (trackId: string) => void
  onSelectRelease?: (releaseId: string) => void
  showToast: (msg: string) => void
  onSwitchToLibrary: () => void
  activeSubTab?: MaintainSubTab
  onSubTabChange?: (tab: MaintainSubTab) => void
  onAddWatchedFolder?: () => void
  onRemoveWatchedFolder?: (folderId: string) => void
  activeEntityScope?: ActiveEntityScope | null
  onClearEntityScope?: () => void
  onIgnoreSkippedFile?: (id: string) => void
  onIgnoreAllSkippedFiles?: () => void
}

export const MaintainCockpit: React.FC<MaintainCockpitProps> = ({
  tracks,
  releases,
  auditIssues,
  storageMounts,
  watchedFolders,
  skippedFiles,
  uncommittedCount,
  onRemediateAudit,
  onRefreshAudit,
  onDiscardTrackEdits,
  onApplyPathRestructure,
  onCommitTwoPhase,
  onToggleMountLock,
  onToggleMountStatus,
  onTriggerScan,
  onRefreshLibrary,
  showToast,
  onSwitchToLibrary,
  activeSubTab: controlledTab,
  onSubTabChange,
  onAddWatchedFolder,
  onRemoveWatchedFolder,
  activeEntityScope,
  onClearEntityScope,
  onIgnoreSkippedFile,
  onIgnoreAllSkippedFiles,
}) => {
  const [internalTab, setInternalTab] = useState<MaintainSubTab>('needs_attention')
  const activeTab = controlledTab ?? internalTab
  const setActiveTab = (tab: MaintainSubTab) => {
    setInternalTab(tab)
    onSubTabChange?.(tab)
  }
  const [isScopeFilterActive, setIsScopeFilterActive] = useState<boolean>(true)

  const [selectedIssueCategory, setSelectedIssueCategory] = useState<string>('triage')

  // Edge Case 3: Reset isScopeFilterActive to true and auto-select first non-empty triage category whenever activeEntityScope changes
  useEffect(() => {
    if (activeEntityScope) {
      setIsScopeFilterActive(true)
      const matchingIssues = auditIssues.filter((issue) =>
        isIssueInEntityScope(issue, activeEntityScope, tracks, releases)
      )
      const hasTriage = matchingIssues.some((i) => !i.isRoleConflict)
      const hasCritical = matchingIssues.some((i) => i.severity === 'critical')
      const hasWarning = matchingIssues.some((i) => i.severity === 'warning')
      const hasPerformers = matchingIssues.some((i) => i.isRoleConflict)

      if (hasTriage) {
        setSelectedIssueCategory('triage')
      } else if (hasCritical) {
        setSelectedIssueCategory('critical')
      } else if (hasWarning) {
        setSelectedIssueCategory('warning')
      } else if (hasPerformers) {
        setSelectedIssueCategory('performers')
      }
    }
  }, [activeEntityScope?.type, activeEntityScope?.name, activeEntityScope?.albumId, auditIssues, tracks, releases])

  const [pathPattern, setPathPattern] = useState<string>('{Artist}/{Year} - {Album}/{TrackNum} - {Title}')
  const [normalizationRules, setNormalizationRules] = useState<NormalizationRule[]>(() => normalizationService.getRules())
  const [newRulePattern, setNewRulePattern] = useState('')
  const [newRuleTarget, setNewRuleTarget] = useState('')
  const [remediatingIssueId, setRemediatingIssueId] = useState<string | null>(null)
  const [remediationProgress, setRemediationProgress] = useState<{ current: number; total: number; title: string } | null>(null)
  const { maintenanceStats: mStats } = useMaintenanceWorker(true)

  // Background Artwork Enrichment State & Reactive Subscription
  const [bgArtState, setBgArtState] = useState<BackgroundArtworkState>(() => backgroundArtworkService.getState())

  useEffect(() => {
    return backgroundArtworkService.subscribe((s) => {
      setBgArtState(s)
      if (s.updatedCount > 0) {
        onRefreshAudit()
      }
    })
  }, [onRefreshAudit])

  const isArtBgBusy =
    bgArtState.status === 'active' ||
    bgArtState.status === 'cooldown' ||
    bgArtState.status === 'suspended_playback' ||
    bgArtState.status === 'user_paused'

  // Grouping & Staging Workbench State
  const [groupByMode, setGroupByMode] = useState<'artist' | 'album' | 'category'>('artist')
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(new Set())
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(new Set())
  const [expandedSingerClusterKeys, setExpandedSingerClusterKeys] = useState<Set<string>>(new Set())

  const toggleGroupCollapsed = (key: string) => {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleSingerClusterExpanded = (key: string) => {
    setExpandedSingerClusterKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleIssueSelection = (issueId: string) => {
    setSelectedIssueIds((prev) => {
      const next = new Set(prev)
      if (next.has(issueId)) next.delete(issueId)
      else next.add(issueId)
      return next
    })
  }

  const handleWhitelistAllSingers = async (issues: AuditIssue[], clusterTitle: string) => {
    let count = 0
    for (const issue of issues) {
      await auditService.remediateIssue(issue.id, { action: 'KEEP_TRACK_ARTIST' })
      count++
    }
    onRefreshAudit()
    showToast(`✓ Whitelisted ${count} playback singers under "${clusterTitle}". Track credits preserved.`)
  }

  // Authoritative Unified Health Score computed by useCatalogHealth
  const { globalHealthScore } = useCatalogHealth(tracks, releases)
  const healthScore = globalHealthScore

  // Filter issues (scoped to active entity when isScopeFilterActive is true)
  const scopedIssues = React.useMemo(() => {
    if (activeEntityScope && isScopeFilterActive) {
      return auditIssues.filter((issue) =>
        isIssueInEntityScope(issue, activeEntityScope, tracks, releases)
      )
    }
    return auditIssues
  }, [auditIssues, activeEntityScope, isScopeFilterActive, tracks, releases])

  const scopeTotalCount = React.useMemo(() => {
    if (!activeEntityScope) return 0
    return auditIssues.filter((issue) =>
      isIssueInEntityScope(issue, activeEntityScope, tracks, releases)
    ).length
  }, [auditIssues, activeEntityScope, tracks, releases])

  // Actionable defects requiring mutation/triage (excluding auto-verified role conflicts)
  const actionableIssues = scopedIssues.filter((i) => !i.isRoleConflict)
  const allAffectedTrackIds = new Set(actionableIssues.flatMap((i) => i.sampleTrackIds || []))
  const impactedAlbumsCount = new Set(
    tracks.filter((t) => allAffectedTrackIds.has(t.id)).map((t) => t.releaseId).filter(Boolean)
  ).size

  const safeFixesCount = actionableIssues.filter((i) => i.isAutoFixable).length
  const roleConflictsCount = scopedIssues.filter((i) => i.isRoleConflict).length

  interface IssueCluster {
    key: string
    title: string
    subtitle: string
    albumArtist?: string
    issues: AuditIssue[]
    totalTracks: number
    safeFixesCount: number
    hasRoleConflicts: boolean
    primaryIssuesCount: number
    primaryTracksAffected: number
    artworkUrl?: string
  }

  // Assemble Clusters based on groupByMode
  const allRawClusters: IssueCluster[] = React.useMemo(() => {
    const map = new Map<string, IssueCluster>()

    scopedIssues.forEach((issue) => {
      let key = ''
      let title = ''
      let subtitle = ''
      let albumArtist: string | undefined
      let artworkUrl: string | undefined

      if (groupByMode === 'artist') {
        const canonical = getIssueCanonicalTarget(issue, tracks, releases)
        key = canonical
        title = canonical
        if (canonical === 'Artwork & Media Integrity') {
          subtitle = 'Visual standards & high-resolution artwork rules'
        } else if (canonical === 'Sequential Track Indexing') {
          subtitle = 'Track numbering & disc sequence rules'
        } else if (canonical === 'Bitstream & Checksum Integrity') {
          subtitle = 'FLAC MD5 checksum & stream payload verification'
        } else if (canonical === 'Untagged Audio Standards') {
          subtitle = 'Missing artist tags and folder extraction rules'
        } else if (canonical === 'Pending Metadata Changes' || canonical === 'Pending Library Changes') {
          subtitle = 'Staged in-memory changes awaiting review and save'
        } else {
          subtitle = `Canonical Authority: ALBUMARTIST = "${canonical}"`
        }
      } else if (groupByMode === 'album') {
        const firstTrack = issue.sampleTrackIds.length > 0 ? tracks.find((t) => t.id === issue.sampleTrackIds[0]) : null
        const rel = releases.find((r) => r.id === firstTrack?.releaseId)
        key = rel?.id || 'unknown_album'
        title = rel?.title ? `${rel.title} (${rel.releaseYear || 'Unknown Year'})` : 'Non-Album / Standalone Tracks'
        albumArtist = rel?.artistCredit || rel?.composerName || 'Various Artists'
        subtitle = rel ? `Album Artist: ${albumArtist} • ${rel.tracksCount || issue.sampleTrackIds.length} Tracks` : 'Tracks without verified album wrapper'
        artworkUrl = rel?.artwork?.frontCoverUrl || rel?.coverArtUrl
      } else {
        key = issue.category
        title = issue.category === 'inconsistent_name'
          ? 'Inconsistent Artist Name Variants'
          : issue.category === 'compilation_conflict'
          ? 'Performer vs. Composer Role Conflicts'
          : issue.category === 'low_res_art'
          ? 'Cover Artwork Resolution & Missing Artwork'
          : issue.category === 'missing_track_num'
          ? 'Missing Sequential Track Indexes'
          : issue.category === 'unformatted_backdrop'
          ? 'Unformatted Panoramic Backdrops'
          : issue.category.replace(/_/g, ' ').toUpperCase()
        subtitle = `Rules governing ${title.toLowerCase()}`
      }

      if (!map.has(key)) {
        map.set(key, {
          key,
          title,
          subtitle,
          albumArtist,
          issues: [],
          totalTracks: 0,
          safeFixesCount: 0,
          hasRoleConflicts: false,
          primaryIssuesCount: 0,
          primaryTracksAffected: 0,
          artworkUrl,
        })
      }

      const cluster = map.get(key)!
      cluster.issues.push(issue)
      cluster.totalTracks += issue.affectedCount || issue.sampleTrackIds.length || 0
      if (!issue.isRoleConflict) {
        cluster.primaryIssuesCount++
        if (issue.isAutoFixable) {
          cluster.safeFixesCount++
        }
      } else {
        cluster.hasRoleConflicts = true
      }
    })

    map.forEach((cluster) => {
      const primary = cluster.issues.filter((i) => !i.isRoleConflict)
      cluster.primaryTracksAffected = new Set(primary.flatMap((i) => i.sampleTrackIds || [])).size
    })

    return Array.from(map.values()).sort((a, b) => b.totalTracks - a.totalTracks)
  }, [scopedIssues, groupByMode, tracks, releases])

  // Filter clusters based on selected view category
  const clusters: IssueCluster[] = React.useMemo(() => {
    if (selectedIssueCategory === 'triage') {
      return allRawClusters.filter((c) => c.primaryIssuesCount > 0)
    }
    if (selectedIssueCategory === 'warning') {
      return allRawClusters.filter((c) => c.issues.some((i) => i.severity === 'warning'))
    }
    if (selectedIssueCategory === 'critical') {
      return allRawClusters.filter((c) => c.issues.some((i) => i.severity === 'critical'))
    }
    if (selectedIssueCategory === 'performers') {
      return allRawClusters.filter((c) => c.hasRoleConflicts)
    }
    return allRawClusters
  }, [allRawClusters, selectedIssueCategory])

  const triageClustersCount = allRawClusters.filter((c) => c.primaryIssuesCount > 0).length
  const performerClustersCount = allRawClusters.filter((c) => c.hasRoleConflicts).length

  const handleStageSelected = async () => {
    const idsToStage = selectedIssueIds.size > 0
      ? Array.from(selectedIssueIds)
      : clusters.flatMap((c) => c.issues.filter((i) => !i.isRoleConflict && i.isAutoFixable).map((i) => i.id))

    if (idsToStage.length === 0) return

    let stagedCount = 0
    for (const id of idsToStage) {
      setRemediatingIssueId(id)
      setRemediationProgress(null)
      await auditService.remediateIssue(id, {
        onProgress: (p: { current: number; total: number; title: string }) => {
          setRemediationProgress(p)
        },
      })
      stagedCount++
    }
    setRemediatingIssueId(null)
    setRemediationProgress(null)
    setSelectedIssueIds(new Set())
    onRefreshAudit()
    showToast(`Staged ${stagedCount} audit fix(es) in non-destructive sidecars. Ready in Review & Save.`)
  }

  const handleRemediateSingle = async (issueId: string) => {
    const issue = scopedIssues.find((i) => i.id === issueId)
    if (issue?.category === 'low_res_art' || issue?.autoFixAction === 'FETCH_HIRES_ART') {
      const targetReleaseIds = new Set<string>()
      if (issue.sampleTrackIds && issue.sampleTrackIds.length > 0) {
        issue.sampleTrackIds.forEach((tid) => {
          const trk = tracks.find((t) => t.id === tid)
          if (trk?.releaseId) targetReleaseIds.add(trk.releaseId)
        })
      }
      backgroundArtworkService.start({
        releaseIds: targetReleaseIds.size > 0 ? Array.from(targetReleaseIds) : undefined,
        preferredProvider: 'apple',
      })
      showToast('Started background archival artwork fetch. Runs safely during audio-idle.')
      return
    }

    setRemediatingIssueId(issueId)
    setRemediationProgress(null)
    try {
      const res = await auditService.remediateIssue(issueId, {
        onProgress: (p: { current: number; total: number; title: string }) => {
          setRemediationProgress(p)
        },
      })
      onRefreshAudit()
      showToast(res.message)
    } catch (err: any) {
      showToast(err?.message || 'Remediation error')
    } finally {
      setRemediatingIssueId(null)
      setRemediationProgress(null)
    }
  }

  const handleStageClusterFixes = async (cluster: IssueCluster) => {
    if (cluster.title === 'Artwork & Media Integrity') {
      backgroundArtworkService.start({ preferredProvider: 'apple' })
      showToast('Started background archival artwork fetch for all albums.')
      return
    }

    const ids = cluster.issues.filter((i) => !i.isRoleConflict && i.isAutoFixable).map((i) => i.id)
    for (const id of ids) {
      setRemediatingIssueId(id)
      setRemediationProgress(null)
      await auditService.remediateIssue(id, {
        onProgress: (p: { current: number; total: number; title: string }) => {
          setRemediationProgress(p)
        },
      })
    }
    setRemediatingIssueId(null)
    setRemediationProgress(null)
    onRefreshAudit()
    showToast(`Staged all safe fixes for "${cluster.title}". Ready in Review & Save.`)
  }

  // Library format composition breakdown (macOS Storage Management style)
  const dsdTracks = tracks.filter(
    (t) =>
      (t.format || '').toLowerCase().includes('dsd') ||
      (t.sampleRateStr || '').toLowerCase().includes('dsd') ||
      (t.filePath || '').toLowerCase().endsWith('.dsf') ||
      (t.filePath || '').toLowerCase().endsWith('.dff')
  )
  const hiResPcmTracks = tracks.filter(
    (t) =>
      !dsdTracks.includes(t) &&
      (Boolean(t.isHighRes) ||
        (t.sampleRateStr || '').includes('24/') ||
        (t.sampleRateStr || '').includes('32/') ||
        (t.sampleRateStr || '').includes('96') ||
        (t.sampleRateStr || '').includes('192') ||
        (t.sampleRateStr || '').includes('384') ||
        (t.sampleRateStr || '').includes('768'))
  )
  const redbookTracks = tracks.filter((t) => !dsdTracks.includes(t) && !hiResPcmTracks.includes(t))
  const totalCount = Math.max(1, tracks.length)
  const dsdPct = Math.round((dsdTracks.length / totalCount) * 100)
  const hiResPct = Math.round((hiResPcmTracks.length / totalCount) * 100)
  const redbookPct = Math.round((redbookTracks.length / totalCount) * 100)

  // Path restructure preview
  const previewSampleTracks = tracks.slice(0, 8).map((t) => {
    const rel = releases.find((r) => r.id === t.releaseId)
    const proposed = pathPattern
      .replace('{Artist}', t.artistCredit || 'Unknown Artist')
      .replace('{Year}', String(rel?.releaseYear || 'Unknown Year'))
      .replace('{Album}', rel?.title || 'Unknown Album')
      .replace('{TrackNum}', String(t.trackNumber || 1).padStart(2, '0'))
      .replace('{Title}', t.title)
    return {
      id: t.id,
      current: t.filePath,
      proposed: proposed + '.' + (t.format || 'flac').toLowerCase(),
    }
  })

  const handleAddNormalizationRule = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newRulePattern.trim() || !newRuleTarget.trim()) return
    normalizationService.recordNormalization(newRulePattern.trim(), newRuleTarget.trim(), 'artist')
    setNormalizationRules(normalizationService.getRules())
    setNewRulePattern('')
    setNewRuleTarget('')
    showToast(`Saved preferred name rule: "${newRulePattern}" → "${newRuleTarget}"`)
    onRefreshAudit()
  }

  const handleDeleteRule = (ruleId: string) => {
    normalizationService.removeRule(ruleId)
    setNormalizationRules(normalizationService.getRules())
    showToast('Rule deleted')
    onRefreshAudit()
  }

  return (
    <div className="flex-1 flex overflow-hidden bg-[#0C0D10] select-none">
      {/* 1. Maintain Lifecycle Sub-Navigation (Left Rail) */}
      <aside className="w-64 border-r border-white/[0.06] bg-[#0A0B0E]/95 backdrop-blur-2xl p-4 flex flex-col justify-between shrink-0">
        <div className="space-y-4 text-xs">
          {/* Header */}
          <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
            <span className="font-mono text-[10px] uppercase font-medium tracking-wider text-[#8E8E93]">
              Audit & Hygiene
            </span>
            <span
              className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full ${
                healthScore >= 90
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : healthScore >= 70
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
              }`}
            >
              {healthScore}% Health
            </span>
          </div>

          {/* Navigation Links */}
          <div className="space-y-1">
            <button
              onClick={() => setActiveTab('needs_attention')}
              className={`w-full px-3 py-2 rounded-xl text-left font-semibold flex items-center justify-between transition-all cursor-pointer ${
                activeTab === 'needs_attention'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span>Needs Attention</span>
              </div>
              {impactedAlbumsCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/40 font-mono text-amber-300 border border-amber-500/30">
                  {impactedAlbumsCount}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('organize_files')}
              className={`w-full px-3 py-2 rounded-xl text-left font-semibold flex items-center justify-between transition-all cursor-pointer ${
                activeTab === 'organize_files'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2">
                <FolderTree className="w-4 h-4 text-cyan-400" />
                <span>Organize File Names</span>
              </div>
            </button>

            <button
              onClick={() => setActiveTab('metadata_matching')}
              className={`w-full px-3 py-2 rounded-xl text-left font-semibold flex items-center justify-between transition-all cursor-pointer ${
                activeTab === 'metadata_matching'
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-400" />
                <span>Metadata Matching</span>
              </div>
            </button>

            <button
              onClick={() => setActiveTab('storage_mounts')}
              className={`w-full px-3 py-2 rounded-xl text-left font-semibold flex items-center justify-between transition-all cursor-pointer ${
                activeTab === 'storage_mounts'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-emerald-400" />
                <span>Storage & Watched</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-500/20 text-emerald-300 font-mono border border-emerald-500/30">
                {watchedFolders.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('pending_changes')}
              className={`w-full px-3 py-2 rounded-xl text-left font-semibold flex items-center justify-between transition-all cursor-pointer ${
                activeTab === 'pending_changes'
                  ? 'bg-lime-500/20 text-lime-300 border border-lime-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-lime-400" />
                <span>Review & Save</span>
              </div>
              {uncommittedCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-lime-500/20 text-lime-300 border border-lime-500/30 font-mono">
                  {uncommittedCount}
                </span>
              )}
            </button>
          </div>

          {/* Background Maintenance Status Card */}
          {mStats && (
            <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5 space-y-2 mt-2">
              <div className="flex items-center justify-between">
                <span
                  className="font-mono text-[9px] uppercase tracking-wider text-slate-400 flex items-center gap-1.5 cursor-help"
                  title="Runs only when audio playback is idle to preserve bit-perfect transport purity"
                >
                  <Cpu className="w-3 h-3 text-cyan-400" />
                  Background Tasks
                </span>
                <span
                  className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full flex items-center gap-1 ${
                    mStats.statusMessage.startsWith('Suspended')
                      ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                      : mStats.statusMessage.startsWith('Cooling')
                      ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                      : mStats.pendingItems === 0
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                      : 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                  }`}
                >
                  <span
                    className={`w-1 h-1 rounded-full ${
                      mStats.statusMessage.startsWith('Suspended')
                        ? 'bg-amber-400'
                        : mStats.statusMessage.startsWith('Cooling')
                        ? 'bg-amber-300 animate-pulse'
                        : mStats.pendingItems === 0
                        ? 'bg-emerald-400'
                        : 'bg-cyan-400 animate-pulse'
                    }`}
                  />
                  {mStats.statusMessage.startsWith('Suspended')
                    ? 'Suspended'
                    : mStats.statusMessage.startsWith('Cooling')
                    ? 'Cooldown'
                    : mStats.pendingItems === 0
                    ? 'Up to date'
                    : 'Active'}
                </span>
              </div>

              <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono">
                <span className="flex items-center gap-1">
                  <ImageIcon className="w-2.5 h-2.5 text-slate-400" />
                  Indexing Artwork
                </span>
                {mStats.pendingItems === 0 ? (
                  <span className="text-emerald-400 font-medium">
                    {mStats.cachedCount}/{mStats.totalItems} Albums
                  </span>
                ) : (
                  <span className="text-white font-medium">
                    {mStats.totalItems - mStats.pendingItems}/{mStats.totalItems} scanned
                  </span>
                )}
              </div>

              {/* Scan Completion Progress Bar */}
              <div className="w-full bg-white/5 rounded-full h-1 overflow-hidden">
                <div
                  className={`h-1 rounded-full transition-all duration-300 ${
                    mStats.pendingItems === 0 ? 'bg-emerald-500' : 'bg-cyan-500'
                  }`}
                  style={{
                    width: `${
                      mStats.totalItems > 0
                        ? Math.min(
                            100,
                            Math.round(
                              ((mStats.totalItems - mStats.pendingItems) / mStats.totalItems) * 100
                            )
                          )
                        : 100
                    }%`,
                  }}
                />
              </div>

              <div className="flex items-center justify-between text-[9px] text-slate-500 font-mono truncate">
                {mStats.pendingItems === 0 ? (
                  <>
                    <span>100% of library verified</span>
                    {mStats.notFoundCount > 0 && (
                      <span className="text-slate-500">({mStats.notFoundCount} without art)</span>
                    )}
                  </>
                ) : (
                  <span>{mStats.statusMessage}</span>
                )}
              </div>

              {/* Archival Artwork Fetch Status Section */}
              {bgArtState.status !== 'idle' && (
                <div className="pt-2 border-t border-white/5 space-y-1.5 mt-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9px] uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                      <Sparkles className="w-2.5 h-2.5 text-amber-400" />
                      Archival Art Fetch
                    </span>
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">
                      {bgArtState.status === 'suspended_playback'
                        ? 'Suspended (Playing)'
                        : bgArtState.status === 'cooldown'
                        ? `Cooldown (${bgArtState.cooldownRemainingSecs}s)`
                        : bgArtState.status === 'user_paused'
                        ? 'Paused'
                        : bgArtState.status === 'complete'
                        ? 'Complete'
                        : `${bgArtState.completed}/${bgArtState.total}`}
                    </span>
                  </div>
                  <div className="w-full bg-white/5 rounded-full h-1 overflow-hidden">
                    <div
                      className="h-1 rounded-full bg-amber-400 transition-all duration-300"
                      style={{
                        width: `${
                          bgArtState.total > 0
                            ? Math.min(100, Math.round((bgArtState.completed / bgArtState.total) * 100))
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono">
                    <span className="truncate max-w-[130px]" title={bgArtState.currentAlbumTitle || 'Idle'}>
                      {bgArtState.currentAlbumTitle || 'Idle'}
                    </span>
                    <div className="flex items-center gap-1">
                      {bgArtState.status === 'user_paused' ? (
                        <button
                          type="button"
                          onClick={() => backgroundArtworkService.resume()}
                          className="text-[10px] text-amber-400 hover:text-amber-300 underline cursor-pointer"
                        >
                          Resume
                        </button>
                      ) : bgArtState.status === 'active' || bgArtState.status === 'cooldown' ? (
                        <button
                          type="button"
                          onClick={() => backgroundArtworkService.pause()}
                          className="text-[10px] text-slate-400 hover:text-white underline cursor-pointer"
                        >
                          Pause
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => backgroundArtworkService.cancel()}
                        className="text-[10px] text-rose-400/80 hover:text-rose-300 underline cursor-pointer ml-1"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom Back to Library Link */}
        <div className="pt-3 border-t border-white/10 space-y-2">
          <button
            onClick={onSwitchToLibrary}
            className="w-full py-2 px-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 hover:text-white text-xs font-mono flex items-center justify-between transition-all cursor-pointer"
          >
            <span>← Return to Library</span>
            <span className="text-[10px] text-slate-500">⌘1</span>
          </button>
        </div>
      </aside>

      {/* 2. Main Workbench Area (Center Stage) */}
      <main className="flex-1 flex flex-col overflow-y-auto pb-48">
        {/* TAB 1: NEEDS ATTENTION */}
        {activeTab === 'needs_attention' && (
          <div className="w-full max-w-[1500px] mx-auto p-6 space-y-6">
            {/* Apple Storage Management Style Overview Card */}
            <div className="p-5 rounded-2xl bg-[#16171B] border border-white/[0.06] shadow-sm space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-[#EDEDED]">Catalog Health & Integrity</span>
                    <span
                      className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full ${
                        healthScore >= 90
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
                          : healthScore >= 70
                          ? 'bg-amber-500/15 text-amber-300 border border-amber-500/25'
                          : 'bg-rose-500/15 text-rose-400 border border-rose-500/25'
                      }`}
                    >
                      {healthScore >= 90
                        ? `${healthScore}% Library Health · Optimal`
                        : healthScore >= 70
                        ? `${healthScore}% Library Health · Minor Attention`
                        : allAffectedTrackIds.size > 0
                        ? `${allAffectedTrackIds.size} Tracks Need Triage`
                        : `${healthScore}% Health · Needs Triage`}
                    </span>
                  </div>
                  <p className="text-xs text-[#8E8E93] mt-1 font-mono">
                    {impactedAlbumsCount > 0
                      ? `${healthScore}% Library Health · ${impactedAlbumsCount} Albums affected across ${allAffectedTrackIds.size} tracks`
                      : 'All albums and tracks conform to bit-perfect metadata standards.'}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={onRefreshAudit}
                    className="px-3 py-1.5 rounded-[8px] bg-white/[0.05] hover:bg-white/[0.1] text-xs font-mono text-[#8E8E93] hover:text-[#EDEDED] flex items-center gap-1.5 transition-all cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Re-audit</span>
                  </button>
                </div>
              </div>

              {/* Segmented Composition & Health Bar */}
              <div className="space-y-2">
                <div className="h-2.5 rounded-full overflow-hidden flex bg-white/[0.06] w-full">
                  <div
                    style={{ width: `${healthScore}%` }}
                    className="bg-[#10B981] h-full transition-all duration-500"
                    title={`Verified Integrity: ${healthScore}%`}
                  />
                  {healthScore < 100 && (
                    <div
                      style={{ width: `${100 - healthScore}%` }}
                      className="bg-[#F59E0B] h-full transition-all duration-500"
                      title={`Needs Triage: ${100 - healthScore}%`}
                    />
                  )}
                </div>

                {/* Legend Row */}
                <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono text-[#8E8E93]">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-1.5 text-emerald-400">
                      <span className="w-2 h-2 rounded-full bg-[#10B981]" />
                      <span>{healthScore}% Verified Integrity</span>
                    </div>
                    {impactedAlbumsCount > 0 && (
                      <div className="flex items-center gap-1.5 text-amber-400">
                        <span className="w-2 h-2 rounded-full bg-[#F59E0B]" />
                        <span>{100 - healthScore}% Needs Triage ({impactedAlbumsCount} Albums, {allAffectedTrackIds.size} Tracks)</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-slate-500">
                    <span>Native DSD ({dsdPct}%)</span>
                    <span>•</span>
                    <span>Hi-Res PCM ({hiResPct}%)</span>
                    <span>•</span>
                    <span>Redbook CD ({redbookPct}%)</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Scoped Entity Filter Banner */}
            {activeEntityScope && isScopeFilterActive ? (
              <div className="p-3 rounded-xl bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2.5">
                  <div className="w-6 h-6 rounded-lg bg-[#D4AF37]/20 flex items-center justify-center text-[#D4AF37]">
                    <Sparkles className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <span className="text-[#EDEDED] font-medium">
                      Scoped to {activeEntityScope.type === 'album' && activeEntityScope.parentEntity ? `Album: ${activeEntityScope.name} (${activeEntityScope.parentEntity})` : `${activeEntityScope.type.charAt(0).toUpperCase() + activeEntityScope.type.slice(1)}: ${activeEntityScope.name}`}
                    </span>
                    <span className="text-[#8E8E93] ml-2 font-mono text-[11px]">
                      ({scopedIssues.length} of {auditIssues.length} total library issues)
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIsScopeFilterActive(false)}
                    className="px-2.5 py-1 rounded-lg bg-black/40 hover:bg-black/60 text-[#D4AF37] hover:text-white border border-[#D4AF37]/30 text-xs font-mono transition-all cursor-pointer"
                  >
                    × Clear Filter (Show all {auditIssues.length})
                  </button>
                  {onClearEntityScope && (
                    <button
                      onClick={onClearEntityScope}
                      className="px-2 py-1 rounded-lg text-slate-500 hover:text-slate-300 text-[11px] font-mono transition-all cursor-pointer"
                      title="Reset scope back to entire library"
                    >
                      Reset Scope
                    </button>
                  )}
                </div>
              </div>
            ) : activeEntityScope && !isScopeFilterActive ? (
              <div className="px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.06] flex items-center justify-between text-xs">
                <span className="text-slate-400 font-mono text-[11px]">
                  Viewing all {auditIssues.length} library issues.
                </span>
                <button
                  onClick={() => setIsScopeFilterActive(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#D4AF37]/15 hover:bg-[#D4AF37]/25 text-[#D4AF37] border border-[#D4AF37]/30 text-xs font-mono transition-all cursor-pointer"
                >
                  <Sparkles className="w-3 h-3 text-[#D4AF37]" />
                  <span>Re-apply scope: {activeEntityScope.name} ({scopeTotalCount} issues)</span>
                </button>
              </div>
            ) : null}

            {/* Precision Triage Action Bar & View Switcher */}
            <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.08] flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1 text-xs">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mr-1">Group By:</span>
                  <button
                    onClick={() => setGroupByMode('artist')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                      groupByMode === 'artist'
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                        : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                    }`}
                  >
                    Canonical Artist
                  </button>
                  <button
                    onClick={() => setGroupByMode('album')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                      groupByMode === 'album'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                        : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                    }`}
                  >
                    Album ({impactedAlbumsCount})
                  </button>
                  <button
                    onClick={() => setGroupByMode('category')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                      groupByMode === 'category'
                        ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 shadow-sm'
                        : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                    }`}
                  >
                    Issue Type
                  </button>
                </div>

                <div className="h-4 w-px bg-white/10 hidden md:block" />

                {/* Filter Pills */}
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
                  <button
                    onClick={() => setSelectedIssueCategory('triage')}
                    className={`px-2.5 py-1 rounded-lg cursor-pointer transition-all ${
                      selectedIssueCategory === 'triage'
                        ? 'bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
                    }`}
                  >
                    Needs Triage ({triageClustersCount})
                  </button>
                  <button
                    onClick={() => setSelectedIssueCategory('warning')}
                    className={`px-2 py-0.5 rounded-md cursor-pointer transition-all ${
                      selectedIssueCategory === 'warning'
                        ? 'bg-amber-500/20 text-amber-300 font-bold'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Warnings ({auditIssues.filter((i) => i.severity === 'warning').length})
                  </button>
                  <button
                    onClick={() => setSelectedIssueCategory('critical')}
                    className={`px-2 py-0.5 rounded-md cursor-pointer transition-all ${
                      selectedIssueCategory === 'critical'
                        ? 'bg-rose-500/20 text-rose-300 font-bold'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Critical ({auditIssues.filter((i) => i.severity === 'critical').length})
                  </button>
                  <button
                    onClick={() => setSelectedIssueCategory('performers')}
                    className={`px-2.5 py-1 rounded-lg cursor-pointer transition-all flex items-center gap-1 ${
                      selectedIssueCategory === 'performers'
                        ? 'bg-purple-500/20 text-purple-300 font-bold border border-purple-500/30'
                        : 'text-slate-400 hover:text-purple-300 hover:bg-white/[0.04]'
                    }`}
                  >
                    <span>🎧 Performers</span>
                    <span>({performerClustersCount})</span>
                  </button>
                  <button
                    onClick={() => setSelectedIssueCategory('all')}
                    className={`px-2 py-0.5 rounded-md cursor-pointer transition-all ${
                      selectedIssueCategory === 'all'
                        ? 'bg-white/10 text-white font-bold'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    All ({allRawClusters.length})
                  </button>
                </div>
              </div>

              {/* Primary Header Action */}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleStageSelected}
                  disabled={safeFixesCount === 0 && selectedIssueIds.size === 0}
                  className="px-3.5 py-1.5 rounded-xl font-bold font-mono text-xs flex items-center gap-1.5 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-black shadow-md shadow-amber-500/15 transition-all cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>
                    {selectedIssueIds.size > 0
                      ? `Stage ${selectedIssueIds.size} Selected Fixes`
                      : `Stage ${safeFixesCount} Safe Fixes`}
                  </span>
                </button>
              </div>
            </div>

            {/* Clustered Accordion Workbench */}
            <div className="space-y-4">
              {clusters.length === 0 ? (
                <div className="p-12 text-center text-slate-500 text-xs rounded-2xl bg-white/[0.02] border border-white/[0.06] font-mono">
                  ✓ No issues found in this category. Your library metadata is pristine!
                </div>
              ) : (
                clusters.map((cluster) => {
                  const isCollapsed = collapsedGroupKeys.has(cluster.key)
                  return (
                    <div
                      key={cluster.key}
                      className="rounded-2xl border border-white/[0.08] bg-[#121318] overflow-hidden transition-all shadow-sm"
                    >
                      {/* Accordion Header */}
                      <div
                        onClick={() => toggleGroupCollapsed(cluster.key)}
                        className="p-4 bg-white/[0.02] hover:bg-white/[0.04] flex items-center justify-between gap-4 cursor-pointer transition-colors border-b border-white/[0.06]"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleGroupCollapsed(cluster.key)
                            }}
                            className="p-1 rounded-md text-slate-400 hover:text-white"
                          >
                            {isCollapsed ? (
                              <ChevronRight className="w-4 h-4 text-slate-400" />
                            ) : (
                              <ChevronDown className="w-4 h-4 text-amber-400" />
                            )}
                          </button>

                          {cluster.artworkUrl && (
                            <img
                              src={cluster.artworkUrl}
                              alt={cluster.title}
                              className="w-8 h-8 rounded-md object-cover border border-white/10 shrink-0"
                            />
                          )}

                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-bold text-white text-sm tracking-tight truncate">
                                {cluster.title}
                              </span>
                              {cluster.primaryIssuesCount > 0 ? (
                                <>
                                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                    {cluster.primaryIssuesCount} {cluster.primaryIssuesCount === 1 ? 'Variant' : 'Variants'}
                                  </span>
                                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/[0.05] text-slate-300 border border-white/10">
                                    {cluster.primaryTracksAffected} Tracks Affected
                                  </span>
                                </>
                              ) : (
                                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                                  <Check className="w-3 h-3 text-emerald-400 stroke-[2.5]" />
                                  <span>Clean Primary Tags</span>
                                </span>
                              )}
                              {cluster.hasRoleConflicts && (
                                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30 flex items-center gap-1">
                                  <span>🎧</span>
                                  <span>{cluster.issues.filter((i) => i.isRoleConflict).length} Credited Performers</span>
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-400 mt-0.5 font-mono truncate">
                              {cluster.subtitle}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2.5 shrink-0">
                          {cluster.title === 'Artwork & Media Integrity' && isArtBgBusy ? (
                            <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg text-xs font-mono border border-amber-400/40 bg-amber-400/10 text-amber-300">
                              <span className="flex items-center gap-1.5 font-medium">
                                {bgArtState.status === 'suspended_playback' ? (
                                  <>
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                                    <span>Suspended (Playing)</span>
                                  </>
                                ) : bgArtState.status === 'cooldown' ? (
                                  <>
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />
                                    <span>Cooldown ({bgArtState.cooldownRemainingSecs}s)</span>
                                  </>
                                ) : bgArtState.status === 'user_paused' ? (
                                  <>
                                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-400" />
                                    <span>Paused ({bgArtState.completed}/{bgArtState.total})</span>
                                  </>
                                ) : (
                                  <>
                                    <RefreshCw className="w-3 h-3 animate-spin text-amber-400" />
                                    <span>Fetching {bgArtState.completed}/{bgArtState.total}</span>
                                  </>
                                )}
                              </span>
                              <div className="flex items-center gap-1 border-l border-amber-400/20 pl-2">
                                {bgArtState.status === 'user_paused' ? (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      backgroundArtworkService.resume()
                                    }}
                                    className="p-0.5 hover:text-white transition-colors cursor-pointer"
                                    title="Resume Artwork Fetch"
                                  >
                                    <Play className="w-3 h-3" />
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      backgroundArtworkService.pause()
                                    }}
                                    className="p-0.5 hover:text-white transition-colors cursor-pointer"
                                    title="Pause Artwork Fetch"
                                  >
                                    <Pause className="w-3 h-3" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    backgroundArtworkService.cancel()
                                  }}
                                  className="p-0.5 hover:text-rose-400 transition-colors cursor-pointer"
                                  title="Cancel Artwork Fetch"
                                >
                                  <StopCircle className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          ) : cluster.safeFixesCount > 0 ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleStageClusterFixes(cluster)
                              }}
                              className="px-3 py-1 rounded-lg text-xs font-mono font-medium border border-amber-400/30 hover:border-amber-400/60 bg-amber-400/10 hover:bg-amber-400/20 text-amber-300 transition-all cursor-pointer"
                            >
                              {cluster.title === 'Artwork & Media Integrity'
                                ? `Fetch All Artwork (${cluster.safeFixesCount})`
                                : `Stage All Safe Fixes (${cluster.safeFixesCount})`}
                            </button>
                          ) : null}
                          <span className="text-xs text-slate-500 font-mono hidden sm:inline">
                            {isCollapsed ? '[Expand]' : '[Collapse]'}
                          </span>
                        </div>
                      </div>

                      {/* Accordion Tabular Diff Body */}
                      {!isCollapsed && (() => {
                        const primaryIssues = cluster.issues.filter((i) => !i.isRoleConflict)
                        const singerIssues = cluster.issues.filter((i) => i.isRoleConflict)
                        const isSingersExpanded = expandedSingerClusterKeys.has(cluster.key)
                        const totalSingerTracks = singerIssues.reduce((sum, i) => sum + i.affectedCount, 0)

                        const renderIssueRow = (issue: AuditIssue) => {
                          const isSelected = selectedIssueIds.has(issue.id)
                          const detectedVal = getIssueDetectedValue(issue, cluster.title, tracks)
                          const proposedAction = getIssueProposedAction(issue, cluster.title)
                          const tagBadge = getIssueTagBadge(issue)

                          return (
                            <div
                              key={issue.id}
                              className={`px-4 py-3 flex items-center text-xs transition-colors ${
                                isSelected ? 'bg-amber-500/[0.05]' : 'hover:bg-white/[0.02]'
                              }`}
                            >
                              {/* SEL: w-12 fixed */}
                              <div className="w-12 shrink-0 flex items-center">
                                <button
                                  type="button"
                                  role="checkbox"
                                  aria-checked={isSelected}
                                  onClick={() => toggleIssueSelection(issue.id)}
                                  className={`w-4 h-4 rounded flex items-center justify-center transition-all cursor-pointer ${
                                    isSelected
                                      ? 'bg-amber-500 border border-amber-400 text-black shadow-sm shadow-amber-500/30'
                                      : 'bg-zinc-900 border border-zinc-700/80 hover:border-zinc-500'
                                  }`}
                                  title={isSelected ? 'Deselect issue' : 'Select issue for staging'}
                                >
                                  {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                                </button>
                              </div>

                              {/* TAG FIELD: w-36 fixed */}
                              <div className="w-36 shrink-0 flex items-center gap-1.5 pr-2">
                                <span
                                  className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${tagBadge.className}`}
                                >
                                  {tagBadge.label}
                                </span>
                              </div>

                              {/* DETECTED VALUE: w-[320px] fixed with high contrast */}
                              <div className="w-[320px] shrink-0 min-w-0 pr-3">
                                <span
                                  className="font-mono text-[11px] text-zinc-100 font-medium bg-[#14151b] px-2.5 py-1 rounded border border-zinc-700/80 truncate block shadow-inner"
                                  title={detectedVal}
                                >
                                  "{detectedVal}"
                                </span>
                              </div>

                              {/* PROPOSED ACTION: flex-1 min-w-[240px] */}
                              <div className="flex-1 min-w-[240px] flex items-center gap-2 pr-3 min-w-0">
                                <span className="text-zinc-500 shrink-0 font-mono text-xs">→</span>
                                <div className="min-w-0">
                                  <span
                                    className={`text-xs font-mono font-medium truncate block ${
                                      issue.isRoleConflict ? 'text-purple-300' : 'text-emerald-400/90'
                                    }`}
                                  >
                                    {proposedAction}
                                  </span>
                                  {issue.isRoleConflict && (
                                    <span className="text-[10px] text-amber-400/80 font-sans block mt-0.5">
                                      ⚠️ Performer vs. Composer conflict (Soundtrack / Classical)
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* AFFECTED / ACTION: w-52 fixed right-aligned */}
                              <div className="w-52 shrink-0 flex items-center justify-end gap-2.5">
                                <span className="text-[11px] font-mono text-zinc-400 shrink-0">
                                  {issue.affectedCount} trks
                                </span>

                                {issue.isRoleConflict ? (
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => onRemediateAudit(issue.id)}
                                      className="px-2.5 py-1 text-xs font-mono font-medium rounded-lg border border-zinc-700 hover:border-amber-500/50 text-zinc-300 hover:text-white bg-zinc-900/60 hover:bg-zinc-800/80 transition-all cursor-pointer"
                                      title="Whitelist this playback singer under the album authority"
                                    >
                                      Keep Singer
                                    </button>
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        await auditService.remediateIssue(issue.id, { action: 'STANDARDIZE_COMPOSER_ONLY' })
                                        onRefreshAudit()
                                        showToast(`Standardized composer to "${issue.parentEntity}" while keeping singer intact.`)
                                      }}
                                      className="px-2 py-1 text-xs font-mono font-medium rounded-lg border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 bg-zinc-900/30 hover:bg-zinc-800/50 transition-all cursor-pointer"
                                      title="Set composer while preserving playback singer in ARTIST"
                                    >
                                      Move COMP
                                    </button>
                                  </div>
                                ) : issue.category === 'uncommitted_sidecar' ? (
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => onCommitTwoPhase()}
                                      className="px-2.5 py-1 text-xs font-mono font-semibold rounded-lg border border-emerald-500/40 hover:border-emerald-400 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 transition-all cursor-pointer shrink-0"
                                      title="Open Two-Phase Review & Save modal to commit staged edits"
                                    >
                                      Review & Save
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (onDiscardTrackEdits && issue.sampleTrackIds) {
                                          onDiscardTrackEdits(issue.sampleTrackIds)
                                        }
                                      }}
                                      className="px-2 py-1 text-xs font-mono font-medium rounded-lg border border-rose-500/30 hover:border-rose-500/50 text-rose-400 hover:text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 transition-all cursor-pointer shrink-0"
                                      title="Discard pending staged edits and restore original file state"
                                    >
                                      Discard
                                    </button>
                                  </div>
                                ) : issue.category === 'low_res_art' && isArtBgBusy ? (
                                  <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-mono font-medium rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-300 shrink-0">
                                    {bgArtState.status === 'suspended_playback' ? (
                                      <span className="flex items-center gap-1 text-[11px]">
                                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                                        <span>Suspended (Audio)</span>
                                      </span>
                                    ) : bgArtState.status === 'cooldown' ? (
                                      <span className="flex items-center gap-1 text-[11px]">
                                        <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />
                                        <span>Cooldown ({bgArtState.cooldownRemainingSecs}s)</span>
                                      </span>
                                    ) : bgArtState.status === 'user_paused' ? (
                                      <span className="flex items-center gap-1 text-[11px]">
                                        <span className="w-1.5 h-1.5 rounded-full bg-zinc-400" />
                                        <span>Paused ({bgArtState.completed}/{bgArtState.total})</span>
                                      </span>
                                    ) : (
                                      <span className="flex items-center gap-1 text-[11px]">
                                        <RefreshCw className="w-3 h-3 animate-spin text-amber-400" />
                                        <span>Fetching {bgArtState.completed}/{bgArtState.total}</span>
                                      </span>
                                    )}
                                    <div className="flex items-center gap-1 border-l border-amber-400/20 pl-1.5">
                                      {bgArtState.status === 'user_paused' ? (
                                        <button
                                          type="button"
                                          onClick={() => backgroundArtworkService.resume()}
                                          className="p-0.5 hover:text-white transition-colors cursor-pointer"
                                          title="Resume Artwork Fetch"
                                        >
                                          <Play className="w-3 h-3" />
                                        </button>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => backgroundArtworkService.pause()}
                                          className="p-0.5 hover:text-white transition-colors cursor-pointer"
                                          title="Pause Artwork Fetch"
                                        >
                                          <Pause className="w-3 h-3" />
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => backgroundArtworkService.cancel()}
                                        className="p-0.5 hover:text-rose-400 transition-colors cursor-pointer"
                                        title="Cancel Artwork Fetch"
                                      >
                                        <StopCircle className="w-3 h-3" />
                                      </button>
                                    </div>
                                  </div>
                                ) : remediatingIssueId === issue.id ? (
                                  <div className="flex items-center gap-2 px-3 py-1 text-xs font-mono font-medium rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-300 shrink-0">
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-400" />
                                    <span>
                                      {remediationProgress
                                        ? `Resolving ${remediationProgress.current}/${remediationProgress.total} (${remediationProgress.title.slice(0, 16)}...)`
                                        : 'Querying Sources...'}
                                    </span>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleRemediateSingle(issue.id)}
                                    className="px-3 py-1 text-xs font-mono font-semibold rounded-lg border border-amber-500/40 hover:border-amber-400 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 transition-all cursor-pointer shrink-0"
                                  >
                                    {issue.category === 'low_res_art'
                                      ? 'Fetch & Preview Art'
                                      : issue.fixActionLabel || 'Stage Fix'}
                                  </button>
                                )}
                              </div>
                            </div>
                          )
                        }

                        return (
                          <div className="divide-y divide-white/[0.04]">
                            {/* Sticky Table Column Headers - ONLY when primaryIssues.length > 0 */}
                            {primaryIssues.length > 0 && (
                              <div className="sticky top-0 z-10 px-4 py-2 bg-[#0f1015]/95 backdrop-blur-md border-b border-white/[0.08] text-xs font-mono uppercase tracking-wider text-zinc-400 font-semibold flex items-center">
                                <div
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const primaryIds = primaryIssues.map((i) => i.id)
                                    const allSelected = primaryIds.length > 0 && primaryIds.every((id) => selectedIssueIds.has(id))
                                    setSelectedIssueIds((prev) => {
                                      const next = new Set(prev)
                                      if (allSelected) {
                                        primaryIds.forEach((id) => next.delete(id))
                                      } else {
                                        primaryIds.forEach((id) => next.add(id))
                                      }
                                      return next
                                    })
                                  }}
                                  className="w-12 shrink-0 flex items-center gap-1.5 cursor-pointer hover:text-zinc-200 transition-colors"
                                  title="Click to select/deselect all in cluster"
                                >
                                  <div
                                    className={`w-3.5 h-3.5 rounded flex items-center justify-center transition-all ${
                                      primaryIssues.length > 0 && primaryIssues.every((issue) => selectedIssueIds.has(issue.id))
                                        ? 'bg-amber-500 border border-amber-400 text-black'
                                        : primaryIssues.some((issue) => selectedIssueIds.has(issue.id))
                                        ? 'bg-amber-500/40 border border-amber-400/60'
                                        : 'bg-zinc-900 border border-zinc-700/80'
                                    }`}
                                  >
                                    {primaryIssues.length > 0 && primaryIssues.every((issue) => selectedIssueIds.has(issue.id)) && (
                                      <Check className="w-2.5 h-2.5 stroke-[3]" />
                                    )}
                                  </div>
                                  <span>SEL</span>
                                </div>
                                <div className="w-36 shrink-0">TAG FIELD</div>
                                <div className="w-[320px] shrink-0">DETECTED VALUE</div>
                                <div className="flex-1 min-w-[240px]">PROPOSED ACTION</div>
                                <div className="w-52 shrink-0 text-right">AFFECTED / ACTION</div>
                              </div>
                            )}

                            {/* Primary Issues (Variants / Integrity / Metadata) */}
                            {primaryIssues.length > 0 ? (
                              primaryIssues.map(renderIssueRow)
                            ) : (
                              <div className="px-4 py-3 text-xs text-zinc-400 font-mono flex items-center gap-2 bg-black/10">
                                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                                <span>
                                  All primary tags conform to canonical authority "{cluster.title}".
                                </span>
                              </div>
                            )}

                            {/* Grouped Soundtrack & Film Playback Singers Sub-Banner */}
                            {singerIssues.length > 0 && (
                              <div className="bg-[#121319]/90 border-t border-b border-purple-500/20 p-3.5 flex flex-wrap items-center justify-between gap-4">
                                <div className="flex items-center gap-3 min-w-0">
                                  <div className="w-8 h-8 rounded-lg bg-purple-500/15 border border-purple-500/30 flex items-center justify-center shrink-0 text-purple-300">
                                    <Mic className="w-4 h-4" />
                                  </div>
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-bold text-zinc-100">
                                        Playback Singers / Performers ({totalSingerTracks} Tracks across {singerIssues.length} Credited Singers)
                                      </span>
                                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                                        Soundtrack Roster
                                      </span>
                                    </div>
                                    <p className="text-[11px] text-zinc-400 truncate mt-0.5">
                                      {(() => {
                                        const effectiveAlbumArtist = cluster.albumArtist || cluster.title
                                        return `ALBUMARTIST = "${effectiveAlbumArtist}" is set. Playback singers are preserved in ARTIST.`
                                      })()}
                                    </p>
                                  </div>
                                </div>

                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      const canonical = cluster.albumArtist || cluster.title
                                      const allTrackIds = Array.from(new Set(singerIssues.flatMap((i) => i.sampleTrackIds)))
                                      for (const id of allTrackIds) {
                                        const trk = graphEngine.getTrackById(id)
                                        if (trk) {
                                          trk.composerName = canonical
                                          trk.sidecarStatus = 'uncommitted_sidecar'
                                          trk.pendingSidecarEdits = {
                                            ...(trk.pendingSidecarEdits || {}),
                                            composerName: canonical,
                                          }
                                          graphEngine.addOrUpdateTrack(trk)
                                        }
                                      }
                                      onRefreshAudit()
                                      showToast(`Staged COMPOSER = "${canonical}" for ${allTrackIds.length} tracks.`)
                                    }}
                                    className="px-3 py-1.5 rounded-lg text-xs font-mono font-medium border border-zinc-700/80 hover:border-purple-400/50 text-zinc-300 hover:text-white bg-zinc-900/60 hover:bg-purple-950/30 transition-all cursor-pointer flex items-center gap-1.5 shadow-sm"
                                    title={`Set COMPOSER = "${cluster.albumArtist || cluster.title}" on all ${totalSingerTracks} tracks while preserving singers in ARTIST`}
                                  >
                                    <span>+ Populate COMPOSER = "{cluster.albumArtist || cluster.title}" ({totalSingerTracks} trks)</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => toggleSingerClusterExpanded(cluster.key)}
                                    className="px-3 py-1.5 rounded-lg text-xs font-mono text-zinc-300 hover:text-white bg-zinc-900/80 border border-zinc-700/80 hover:border-zinc-600 transition-all cursor-pointer flex items-center gap-1.5"
                                  >
                                    <span>{isSingersExpanded ? 'Hide Singers' : `Inspect Individual Singers (${singerIssues.length})`}</span>
                                    {isSingersExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Expanded Individual Singer Roster Table (Clean, read-only, NO diff arrows or warning icons) */}
                            {singerIssues.length > 0 && isSingersExpanded && (
                              <div className="p-4 bg-black/25">
                                <div className="rounded-xl border border-white/[0.06] overflow-hidden bg-[#101116]">
                                  {/* Roster Table Header */}
                                  <div className="px-4 py-2.5 bg-white/[0.02] border-b border-white/[0.06] text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-semibold grid grid-cols-12 gap-3">
                                    <div className="col-span-5">Singer / Performer</div>
                                    <div className="col-span-3">Assigned Tag Field</div>
                                    <div className="col-span-2">Tracks</div>
                                    <div className="col-span-2 text-right">Role Status</div>
                                  </div>

                                  {/* Roster Rows */}
                                  <div className="divide-y divide-white/[0.04]">
                                    {singerIssues.map((issue) => {
                                      const singer = issue.detectedValue || issue.currentValue || ''
                                      return (
                                        <div
                                          key={issue.id}
                                          className="px-4 py-2.5 grid grid-cols-12 gap-3 items-center text-xs font-mono hover:bg-white/[0.02] transition-colors"
                                        >
                                          <div className="col-span-5 flex items-center gap-2 min-w-0">
                                            <span className="text-zinc-100 font-medium truncate">
                                              "{singer}"
                                            </span>
                                          </div>
                                          <div className="col-span-3">
                                            <span className="text-[10px] px-2 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30">
                                              ARTIST (Playback Singer)
                                            </span>
                                          </div>
                                          <div className="col-span-2 text-zinc-400">
                                            {issue.affectedCount} trks
                                          </div>
                                          <div className="col-span-2 flex items-center justify-end gap-1.5 text-emerald-400/90 text-[11px]">
                                            <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                                            <span>Verified Credit</span>
                                          </div>
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  )
                })
              )}
            </div>

            {/* Embedded Quarantine / Skipped Files Section */}
            {skippedFiles.length > 0 && (
              <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-rose-300 font-bold text-xs">
                    <AlertTriangle className="w-4 h-4 text-rose-400" />
                    <span>Quarantined / Unparseable Files ({skippedFiles.length})</span>
                  </div>
                  {onIgnoreAllSkippedFiles && (
                    <button
                      onClick={onIgnoreAllSkippedFiles}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/30 transition-colors cursor-pointer"
                    >
                      Dismiss All
                    </button>
                  )}
                </div>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {skippedFiles.map((sf, idx) => (
                    <div
                      key={sf.id || idx}
                      className="p-2 bg-black/40 rounded-lg border border-white/10 text-[11px] font-mono text-slate-300 flex items-center justify-between gap-3"
                    >
                      <span className="truncate max-w-lg">{sf.filePath}</span>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-rose-400">{sf.diagnosticError || 'Failed to import'}</span>
                        {onIgnoreSkippedFile && (
                          <button
                            onClick={() => onIgnoreSkippedFile(sf.id)}
                            title="Ignore and permanently dismiss this unparseable file from future scans"
                            className="p-1 rounded bg-white/[0.04] hover:bg-white/[0.1] text-slate-400 hover:text-white transition-colors cursor-pointer"
                          >
                            <EyeOff className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: ORGANIZE FILE NAMES */}
        {activeTab === 'organize_files' && (
          <div className="p-6 space-y-6">
            <div className="p-4 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 space-y-3">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <FolderTree className="w-4 h-4 text-cyan-400" />
                <span>Dynamic Path & File Name Rule Builder</span>
              </h2>
              <p className="text-xs text-slate-300">
                Structure on-disk audio directories consistently. All changes are verified for filename collisions before writing.
              </p>

              {/* Template Input */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-slate-400 uppercase">
                  Path Naming Pattern
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={pathPattern}
                    onChange={(e) => setPathPattern(e.target.value)}
                    className="flex-1 px-3 py-2 bg-black/60 border border-white/20 rounded-xl font-mono text-xs text-cyan-300 focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    onClick={() => {
                      onApplyPathRestructure(pathPattern)
                      showToast(`Applied path restructuring rule across ${tracks.length} tracks. Staged for review.`)
                    }}
                    className="px-4 py-2 bg-cyan-400 hover:bg-cyan-300 text-black font-bold text-xs rounded-xl transition-all cursor-pointer shrink-0"
                  >
                    Stage Path Restructure
                  </button>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500 pt-1">
                  <span>Available Tokens:</span>
                  <span className="text-slate-400">{'{Artist}'}</span>
                  <span className="text-slate-400">{'{Album}'}</span>
                  <span className="text-slate-400">{'{Year}'}</span>
                  <span className="text-slate-400">{'{TrackNum}'}</span>
                  <span className="text-slate-400">{'{Title}'}</span>
                </div>
              </div>
            </div>

            {/* Live Transformation Preview */}
            <div className="space-y-3">
              <span className="text-xs font-bold text-white font-mono uppercase tracking-wider">
                Live Disk Transformation Preview ({previewSampleTracks.length} sample tracks)
              </span>

              <div className="rounded-xl border border-white/10 bg-[#0B0D12] overflow-hidden text-xs">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/[0.02] text-slate-400 font-mono text-[10px]">
                      <th className="p-3">Current Path on Disk</th>
                      <th className="p-3 w-8"></th>
                      <th className="p-3 text-cyan-400">Proposed New Path</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05] font-mono text-[11px]">
                    {previewSampleTracks.map((item) => (
                      <tr key={item.id} className="hover:bg-white/[0.02]">
                        <td className="p-3 text-slate-400 truncate max-w-sm">{item.current}</td>
                        <td className="p-3 text-slate-600">→</td>
                        <td className="p-3 text-emerald-400 truncate max-w-sm">{item.proposed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: METADATA MATCHING & PREFERRED NAMES */}
        {activeTab === 'metadata_matching' && (
          <div className="p-6 space-y-6">
            <div className="p-4 rounded-2xl bg-purple-500/10 border border-purple-500/30 space-y-2">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-400" />
                <span>Preferred Names & Spelling Rules</span>
              </h2>
              <p className="text-xs text-slate-300">
                Establish authoritative artist and composer spellings. All incoming scans and cloud matches automatically adhere to your preferred rules.
              </p>
            </div>

            {/* Add Rule Form */}
            <form onSubmit={handleAddNormalizationRule} className="p-4 rounded-xl bg-white/[0.02] border border-white/10 space-y-3 text-xs">
              <span className="font-bold text-white font-mono text-xs">Add New Preferred Spelling Rule</span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-slate-400 uppercase">Incoming Variant Pattern</label>
                  <input
                    type="text"
                    placeholder='e.g. "AR Rahman" or "A. R. Rahman"'
                    value={newRulePattern}
                    onChange={(e) => setNewRulePattern(e.target.value)}
                    className="w-full mt-1 px-3 py-1.5 bg-black/40 border border-white/20 rounded-lg text-white font-mono text-xs focus:outline-none focus:border-purple-400"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-slate-400 uppercase">Preferred Canonical Name</label>
                  <input
                    type="text"
                    placeholder='e.g. "A.R.Rahman"'
                    value={newRuleTarget}
                    onChange={(e) => setNewRuleTarget(e.target.value)}
                    className="w-full mt-1 px-3 py-1.5 bg-black/40 border border-white/20 rounded-lg text-emerald-300 font-mono text-xs focus:outline-none focus:border-emerald-400"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-purple-500 hover:bg-purple-400 text-white font-bold text-xs rounded-lg transition-all cursor-pointer"
                >
                  Save Preferred Rule
                </button>
              </div>
            </form>

            {/* Existing Rules Ledger */}
            <div className="space-y-2">
              <span className="text-xs font-bold text-white font-mono uppercase tracking-wider">
                Active Preferred Rules ({normalizationRules.length})
              </span>
              <div className="space-y-1.5">
                {normalizationRules.length === 0 ? (
                  <div className="p-4 text-center text-slate-500 text-xs">No custom rules registered yet.</div>
                ) : (
                  normalizationRules.map((r: NormalizationRule) => (
                    <div
                      key={r.id}
                      className="p-3 bg-white/[0.02] border border-white/[0.08] rounded-xl flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-3 font-mono">
                        <span className="text-slate-400">"{r.sourcePattern}"</span>
                        <span className="text-slate-600">→</span>
                        <span className="text-emerald-400 font-bold">"{r.targetValue}"</span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300">
                          {r.field}
                        </span>
                      </div>
                      <button
                        onClick={() => handleDeleteRule(r.id)}
                        className="text-slate-500 hover:text-rose-400 p-1 transition-colors cursor-pointer"
                        title="Delete rule"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: STORAGE & WATCHED FOLDERS HUB */}
        {activeTab === 'storage_mounts' && (
          <div className="p-6 space-y-6">
            {/* Header Banner */}
            <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-emerald-400" />
                  <span>Storage & Watched Folders Hub</span>
                </h2>
                <p className="text-xs text-slate-300 max-w-xl">
                  Add and monitor audio directories from local SSDs, USB drives, and network SMB shares. Real-time background indexing discovers newly added albums with bit-rot and ghost-track protection.
                </p>
              </div>

              {onAddWatchedFolder && (
                <button
                  onClick={onAddWatchedFolder}
                  className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 hover:from-emerald-300 hover:to-cyan-300 text-black font-extrabold text-xs shadow-lg shadow-emerald-500/20 flex items-center gap-2 transition-all cursor-pointer shrink-0 font-mono"
                  title="Add audio directory to library"
                >
                  <FolderPlus className="w-4 h-4 text-black stroke-[2.5]" />
                  <span>+ Add Watched Folder</span>
                </button>
              )}
            </div>

            {/* SECTION 1: MONITORED WATCHED DIRECTORIES */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white font-mono uppercase tracking-wider flex items-center gap-2">
                  <Folder className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Monitored Music Folders ({watchedFolders.length})</span>
                </span>
                <span className="text-[10px] text-slate-500 font-mono">
                  Indexed with SQLite WAL
                </span>
              </div>

              {watchedFolders.length === 0 ? (
                <div className="p-8 border-2 border-dashed border-white/10 rounded-2xl text-center space-y-3 bg-black/20">
                  <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 mx-auto flex items-center justify-center">
                    <FolderPlus className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">No Watched Directories Added Yet</h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Connect your audio folder to start indexing FLAC, DSD, ALAC, and WAV files.
                    </p>
                  </div>
                  {onAddWatchedFolder && (
                    <button
                      onClick={onAddWatchedFolder}
                      className="px-4 py-2 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-black font-bold text-xs transition-all cursor-pointer font-mono inline-flex items-center gap-1.5"
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      <span>Choose Music Folder</span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {watchedFolders.map((wf) => {
                    const mount = storageMounts.find((m) => m.id === wf.mountId)
                    return (
                      <div
                        key={wf.id}
                        className="p-3.5 rounded-xl bg-white/[0.02] border border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-white text-sm truncate">
                              {wf.displayName || wf.folderPath.split(/[/\\]/).filter(Boolean).pop()}
                            </span>
                            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                              {wf.scanMode === 'realtime' ? 'Real-Time Watch' : 'Manual Scan'}
                            </span>
                            {mount && (
                              <span className="text-[10px] font-mono text-slate-500">
                                on {mount.name}
                              </span>
                            )}
                          </div>
                          <div className="text-slate-400 font-mono text-[11px] truncate">
                            {wf.folderPath}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => onTriggerScan(wf.folderPath)}
                            className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-mono flex items-center gap-1.5 transition-all cursor-pointer"
                            title="Rescan folder for new/modified files"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            <span>Rescan Folder</span>
                          </button>

                          {onRemoveWatchedFolder && (
                            <button
                              onClick={() => onRemoveWatchedFolder(wf.id)}
                              className="p-1.5 rounded-lg hover:bg-rose-500/20 text-slate-500 hover:text-rose-400 border border-transparent hover:border-rose-500/30 transition-all cursor-pointer"
                              title="Remove folder from watched list"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* SECTION 2: PHYSICAL STORAGE MOUNTS & DISCONNECTED DRIVE PROTECTION */}
            <div className="space-y-3 pt-4 border-t border-white/[0.08]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white font-mono uppercase tracking-wider flex items-center gap-2">
                  <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Physical Storage Mounts & Drives ({storageMounts.length})</span>
                </span>
                <span className="text-[10px] text-slate-500 font-mono">
                  Hardware Level Locks
                </span>
              </div>

              <div className="space-y-2">
                {storageMounts.map((mount) => (
                  <div
                    key={mount.id}
                    className="p-3.5 rounded-xl bg-white/[0.02] border border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-sm">{mount.name}</span>
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.2 rounded ${
                            mount.status === 'online'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                          }`}
                        >
                          {(mount.status || 'online').toUpperCase()}
                        </span>
                        {mount.isReadOnlyLocked && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                            <Lock className="w-2.5 h-2.5" /> RO LOCK
                          </span>
                        )}
                        <span className="text-[10px] font-mono text-slate-500">
                          {mount.fileSystem}
                        </span>
                      </div>
                      <div className="text-slate-400 font-mono text-[11px] truncate">{mount.mountPath}</div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => onToggleMountLock(mount.id)}
                        className="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-xs font-mono text-slate-300 hover:text-white flex items-center gap-1.5 transition-all cursor-pointer"
                        title={mount.isReadOnlyLocked ? "Unlock mount for edits" : "Lock mount as read-only"}
                      >
                        {mount.isReadOnlyLocked ? <Unlock className="w-3.5 h-3.5 text-amber-400" /> : <Lock className="w-3.5 h-3.5 text-emerald-400" />}
                        <span>{mount.isReadOnlyLocked ? 'Unlock (RW)' : 'Lock (RO)'}</span>
                      </button>

                      <button
                        onClick={() => onTriggerScan(mount.mountPath)}
                        className="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 text-xs font-mono transition-all cursor-pointer"
                      >
                        Rescan Mount
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: REVIEW & SAVE CHANGES (TWO-PHASE COMMIT) */}
        {activeTab === 'pending_changes' && (
          <div className="p-6 space-y-6">
            <div className="p-4 rounded-2xl bg-lime-500/10 border border-lime-500/30 space-y-2">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-lime-400" />
                <span>Review & Save Pending Changes</span>
              </h2>
              <p className="text-xs text-slate-300">
                All changes made across metadata, artwork, and path rules are held safely in memory sidecars. Committing writes clean metadata without altering audio stream PCM.
              </p>
            </div>

            <div className="p-6 bg-[#0E1118] border border-white/10 rounded-2xl text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-lime-500/15 border border-lime-500/30 mx-auto flex items-center justify-center text-lime-400 text-2xl font-bold font-mono">
                {uncommittedCount}
              </div>
              <div>
                <h3 className="text-base font-bold text-white">
                  {uncommittedCount > 0 ? `${uncommittedCount} Sidecar Edits Staged in Memory` : 'All Changes Committed to Disk'}
                </h3>
                <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                  {uncommittedCount > 0
                    ? 'Ready to write non-destructive sidecars and commit atomic tags directly to audio files.'
                    : 'Your music library is fully synchronized with disk. No pending writes.'}
                </p>
              </div>

              {uncommittedCount > 0 && (
                <button
                  onClick={onCommitTwoPhase}
                  className="px-6 py-2.5 bg-gradient-to-r from-lime-400 via-emerald-400 to-cyan-400 text-black font-extrabold text-xs rounded-xl shadow-lg shadow-lime-500/20 hover:brightness-110 transition-all cursor-pointer font-mono"
                >
                  Save {uncommittedCount} Changes to Disk (⌘S)
                </button>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
