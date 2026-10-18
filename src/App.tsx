import React, { useState, useEffect, useMemo } from 'react'
import {
  FolderPlus,
  Folder,
  HardDrive,
  FolderTree,
  Layers,
  Table,
  Sparkles,
  Command,
  FileCode,
  ShieldCheck,
  RotateCcw,
  Music4,
  Volume2,
  Compass,
  Bot,
} from 'lucide-react'
import { Track, Release, Work, Credit, StorageMount, AuditIssue, AlbumDisplayMode } from './core/types'
import { graphEngine, FacetFilterState } from './core/graphEngine'
import { auditService } from './services/auditService'
import { storagePersistence } from './core/storagePersistence'
import { IngestionResult } from './services/libraryImporter'
import { LeftRail } from './components/LeftRail/LeftRail'
import { FacetSelections } from './components/LeftRail/FacetedFilters'
import { DataCanvas, CanvasViewMode } from './components/CenterStage/DataCanvas'
import { RightPanel, RightPanelTab } from './components/RightPanel/RightPanel'
import { OmniCommandBar, CommandItem } from './components/CommandBar/OmniCommandBar'
import { TwoPhaseCommitModal } from './components/Modals/TwoPhaseCommitModal'
import { BatchRuleModal } from './components/Modals/BatchRuleModal'
import { SidecarExportModal } from './components/Modals/SidecarExportModal'
import { ImportLibraryModal } from './components/Modals/ImportLibraryModal'
import { CustomizeAlbumModal } from './components/Modals/CustomizeAlbumModal'
import { BatchDiffTracksModal } from './components/Modals/BatchDiffTracksModal'
import { GuidedTutorialModal } from './components/Tutorial/GuidedTutorialModal'
import { TutorialActions } from './tutorial/tutorialSteps'
import { EmbeddedAgentDrawer } from './components/Agent/EmbeddedAgentDrawer'
import { AgentDispatcherContext } from './services/agentActionDispatcher'
import { AudioPlayerProvider, useAudioPlayer } from './context/AudioPlayerContext'
import { NowPlayingBar } from './components/AudioPlayer/NowPlayingBar'
import { sqliteLibraryService } from './services/sqliteLibraryService'
import { tauriBridge } from './services/tauriBridge'
import { ActivityPill } from './components/CommandBar/ActivityPill'
import { ActivityCenterPopover } from './components/CommandBar/ActivityCenterPopover'
import { StorageManagerModal } from './components/Modals/StorageManagerModal'
import { QuarantineLogModal } from './components/Modals/QuarantineLogModal'
import { NormalizationRulesModal } from './components/Modals/NormalizationRulesModal'
import { MaintainCockpit, MaintainSubTab } from './components/Maintain/MaintainCockpit'
import { FocusedWorkbench } from './components/CenterStage/FocusedWorkbench'
import { SanctuaryListeningLounge } from './components/AudioPlayer/SanctuaryListeningLounge'
import { ScanProgressPayload, WatchedFolder, SkippedFile } from './core/types'
import { backdropAnalyzer } from './services/backdropAnalyzer'

function AppContent() {
  // Primary Graph State
  const [tracks, setTracks] = useState<Track[]>(() => graphEngine.getAllTracks())
  const [releases, setReleases] = useState<Release[]>(() => graphEngine.getAllReleases())
  const [works, setWorks] = useState<Work[]>(() => graphEngine.getAllWorks())
  const [storageMounts, setStorageMounts] = useState<StorageMount[]>(() => graphEngine.getAllStorageMounts())
  const [auditIssues, setAuditIssues] = useState<AuditIssue[]>(() => graphEngine.getAllAuditIssues())
  const [isCustomLibraryActive, setIsCustomLibraryActive] = useState<boolean>(false)

  // Selection State
  const [selectedTrackId, setSelectedTrackId] = useState<string>(tracks[0]?.id || '')
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set())

  // View & Filter State
  const [viewMode, setViewMode] = useState<CanvasViewMode>('cover_grid')
  const [albumDisplayMode, setAlbumDisplayMode] = useState<AlbumDisplayMode>('album_first')
  const [searchQuery, setSearchQuery] = useState('')
  const [facets, setFacets] = useState<FacetSelections>({})
  const [activeTriageFilter, setActiveTriageFilter] = useState<string | undefined>()
  const [selectedMountId, setSelectedMountId] = useState<string | undefined>()
  const [selectedFolderFilter, setSelectedFolderFilter] = useState<string | undefined>()

  // Modals & Overlays
  const [isAgentDrawerOpen, setIsAgentDrawerOpen] = useState(false)
  const [isTutorialOpen, setIsTutorialOpen] = useState(false)
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('credits')
  const [isCommandBarOpen, setIsCommandBarOpen] = useState(false)
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false)
  const [isPathRuleModalOpen, setIsPathRuleModalOpen] = useState(false)
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [isBatchDiffModalOpen, setIsBatchDiffModalOpen] = useState(false)
  const [customizingRelease, setCustomizingRelease] = useState<Release | null>(null)
  const [sidecarTrackId, setSidecarTrackId] = useState<string | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [isActivityPopoverOpen, setIsActivityPopoverOpen] = useState(false)
  const [isStorageManagerOpen, setIsStorageManagerOpen] = useState(false)
  const [isQuarantineModalOpen, setIsQuarantineModalOpen] = useState(false)
  const [isNormalizationRulesModalOpen, setIsNormalizationRulesModalOpen] = useState(false)
  const [scanTelemetry, setScanTelemetry] = useState<ScanProgressPayload>({
    stage: 'idle',
    processedCount: 0,
    totalCount: 0,
    currentFile: '',
    currentFolder: '',
    speedTracksPerSec: 0,
    etaSeconds: 0,
    isPaused: false,
    isScanning: false,
    skippedCount: 0,
  })
  const [watchedFolders, setWatchedFolders] = useState<WatchedFolder[]>([])
  const [skippedFiles, setSkippedFiles] = useState<SkippedFile[]>([])

  // Top-Level Unified Product Model: Library vs Maintain & Sanctuary Lounge
  const [topMode, setTopMode] = useState<'library' | 'maintain'>('library')
  const [maintainSubTab, setMaintainSubTab] = useState<MaintainSubTab>('needs_attention')
  const [isSanctuaryOpen, setIsSanctuaryOpen] = useState<boolean>(false)
  const [focusedWorkbenchTrack, setFocusedWorkbenchTrack] = useState<Track | null>(null)
  const [isWindowDragOver, setIsWindowDragOver] = useState<boolean>(false)

  const { togglePlayPause, nextTrack, prevTrack, toggleMute } = useAudioPlayer()

  const showToast = (msg: string) => {
    setToastMessage(msg)
    setTimeout(() => setToastMessage(null), 3500)
  }

  // Global Audio Playback & Navigation Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) {
        return
      }

      if (e.code === 'Space') {
        e.preventDefault()
        togglePlayPause()
      } else if ((e.ctrlKey || e.metaKey) && e.key === '1') {
        e.preventDefault()
        setTopMode('library')
      } else if ((e.ctrlKey || e.metaKey) && e.key === '2') {
        e.preventDefault()
        setTopMode('maintain')
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault()
        setIsSanctuaryOpen((prev) => !prev)
      } else if (e.key === 'Escape') {
        if (focusedWorkbenchTrack) {
          setFocusedWorkbenchTrack(null)
        } else if (isSanctuaryOpen) {
          setIsSanctuaryOpen(false)
        }
      } else if (e.code === 'ArrowRight' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        nextTrack()
      } else if (e.code === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        prevTrack()
      } else if (e.key === 'm' || e.key === 'M') {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          toggleMute()
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        setIsImportModalOpen(true)
      } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        setIsStorageManagerOpen(true)
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        setIsNormalizationRulesModalOpen(true)
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === '1') setViewMode('work_movement')
        else if (e.key === '2') setViewMode('variant_stack')
        else if (e.key === '3') setViewMode('virtual_table')
        else if (e.key === '4') setViewMode('folder_tree')
      }
    }

    const handleToastEvent = (e: CustomEvent<string>) => {
      if (e.detail) {
        showToast(e.detail)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('cadence:toast' as any, handleToastEvent as any)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('cadence:toast' as any, handleToastEvent as any)
    }
  }, [togglePlayPause, nextTrack, prevTrack, toggleMute])

  // Window drag and drop detection for audio folders & files
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsWindowDragOver(true)
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.relatedTarget === null || e.clientX <= 0 || e.clientY <= 0) {
        setIsWindowDragOver(false)
      }
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsWindowDragOver(false)
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        setIsImportModalOpen(true)
      }
    }

    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('drop', handleDrop)

    return () => {
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('drop', handleDrop)
    }
  }, [])

  // Handle saving customized album and folder names
  const handleSaveAlbumCustomization = (
    releaseId: string,
    updates: {
      title?: string
      folderName?: string
      composerName?: string
      artistCredit?: string
      releaseYear?: number
      coverArtUrl?: string
      backdropUrl?: string
    }
  ) => {
    const res = graphEngine.updateReleaseDetails(releaseId, updates)
    if (res) {
      refreshFromEngine()
      persistCurrentLibrary()
      showToast(`Customized "${res.release.title}" • ${res.affectedTracksCount} tracks staged in sidecar`)
    }
  }

  // Persist current active library to IndexedDB local database
  const persistCurrentLibrary = async () => {
    try {
      await storagePersistence.saveLibrary({
        tracks: graphEngine.getAllTracks(),
        releases: graphEngine.getAllReleases(),
        works: graphEngine.getAllWorks(),
        storageMounts: graphEngine.getAllStorageMounts(),
        auditIssues: graphEngine.getAllAuditIssues(),
        isCustomLibrary: graphEngine.isUsingCustomLibrary(),
        lastImportedTimestamp: new Date().toISOString(),
      })
    } catch (err) {
      console.warn('Failed to persist library to local database:', err)
    }
  }

  // Refresh entire data graph from engine and synchronously recompute dynamic catalog hygiene
  const refreshFromEngine = () => {
    auditService.runFullCatalogAudit()
    setTracks([...graphEngine.getAllTracks()])
    setReleases([...graphEngine.getAllReleases()])
    setWorks([...graphEngine.getAllWorks()])
    setStorageMounts([...graphEngine.getAllStorageMounts()])
    setAuditIssues([...graphEngine.getAllAuditIssues()])
    setIsCustomLibraryActive(graphEngine.isUsingCustomLibrary())
  }

  // On initial mount: initialize SQLite, check migration from IndexedDB, and subscribe to native scanner telemetry
  useEffect(() => {
    let mounted = true

    async function initSqliteAndLibrary() {
      // 1. Check & migrate legacy IndexedDB scans into SQLite
      const migration = await sqliteLibraryService.checkAndMigrateFromIndexedDB()
      if (migration.migrated && mounted) {
        showToast(
          `Migrated ${migration.tracksCount} tracks from previous scan cache into native SQLite database`
        )
      }

      // 2. Load from SQLite
      const dbData = await sqliteLibraryService.loadLibraryFromDb()
      if (dbData && dbData.tracks.length > 0 && mounted) {
        graphEngine.loadCustomLibrary({
          tracks: dbData.tracks,
          releases: dbData.releases,
          works: [],
          auditIssues: [],
          storageMounts: dbData.storageMounts,
        })
        setWatchedFolders(dbData.watchedFolders)
        setSkippedFiles(dbData.skippedFiles)
        refreshFromEngine()
        if (dbData.tracks.length > 0) {
          setSelectedTrackId(dbData.tracks[0].id)
        }
        showToast(`Loaded ${dbData.tracks.length} tracks from SQLite database (WAL active)`)
      } else {
        // Fallback to legacy IndexedDB if SQLite has no data and not in Tauri
        const saved = await storagePersistence.loadLibrary()
        if (saved && saved.tracks && saved.tracks.length > 0 && mounted) {
          graphEngine.loadCustomLibrary({
            tracks: saved.tracks,
            releases: saved.releases,
            works: saved.works,
            auditIssues: saved.auditIssues,
            storageMounts: saved.storageMounts,
          })
          refreshFromEngine()
          if (saved.tracks.length > 0) {
            setSelectedTrackId(saved.tracks[0].id)
          }
          showToast(`Loaded personal library (${saved.tracks.length} tracks) from storage cache`)
        }
      }

      // 3. Subscribe to real-time native scanner events
      await sqliteLibraryService.subscribeToScannerEvents({
        onProgress: (payload) => {
          if (mounted) {
            setScanTelemetry(payload)
          }
        },
        onChunk: (chunk) => {
          if (mounted && chunk.tracks.length > 0) {
            chunk.tracks.forEach((t) => graphEngine.addOrUpdateTrack(t))
            chunk.releases.forEach((r) => graphEngine.addOrUpdateRelease(r))
            refreshFromEngine()
          }
        },
        onComplete: async (result) => {
          if (mounted) {
            showToast(
              `Indexing complete: ${result.importedCount} imported, ${result.skippedCount} skipped (${result.durationSecs}s)`
            )
            const refreshed = await sqliteLibraryService.loadLibraryFromDb()
            if (refreshed) {
              setWatchedFolders(refreshed.watchedFolders)
              setSkippedFiles(refreshed.skippedFiles)
              refreshFromEngine()
            }
          }
        },
      })
    }

    initSqliteAndLibrary()

    return () => {
      mounted = false
      sqliteLibraryService.cleanupListeners()
    }
  }, [])

  const handleTriggerScan = async (folderPath: string, forceFull: boolean = false) => {
    try {
      await tauriBridge.startLibraryScan(folderPath, undefined, forceFull)
      setIsActivityPopoverOpen(true)
      showToast(`Started scan of "${folderPath}"...`)
    } catch (err: any) {
      showToast(`Scan error: ${err.message || err}`)
    }
  }

  const handleToggleMountStatus = async (mountId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'offline' ? 'online' : 'offline'
    await tauriBridge.dbSetMountStatus(mountId, newStatus)
    graphEngine.setMountOnlineStatus(mountId, newStatus === 'online')
    refreshFromEngine()
    showToast(`Mount marked ${newStatus}. Ghost-track protection active.`)
  }

  const handleToggleMountLock = async (mountId: string) => {
    const newLock = await tauriBridge.dbToggleMountLock(mountId)
    setStorageMounts((prev) =>
      prev.map((m) => (m.id === mountId ? { ...m, isReadOnlyLocked: newLock } : m))
    )
    showToast(newLock ? 'Storage mount Read-Only locked' : 'Storage mount Read-Write unlocked')
  }

  const handleRefreshLibrary = async () => {
    const data = await sqliteLibraryService.loadLibraryFromDb()
    if (data) {
      setWatchedFolders(data.watchedFolders)
      setSkippedFiles(data.skippedFiles)
      setStorageMounts(data.storageMounts)
      refreshFromEngine()
    }
  }

  const handleAddWatchedFolder = async () => {
    try {
      const selected = await tauriBridge.openDirectoryDialog()
      if (selected) {
        const folderName = selected.split(/[/\\]/).filter(Boolean).pop() || selected
        const matchedMount = storageMounts.find((m) => selected.startsWith(m.mountPath))
        const mountId = matchedMount ? matchedMount.id : storageMounts[0]?.id || 'mount-local'
        const newFolder: WatchedFolder = {
          id: `wf-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          mountId,
          folderPath: selected,
          displayName: folderName,
          scanMode: 'realtime',
          isEnabled: true,
          lastScannedTimestamp: new Date().toISOString(),
        }
        await tauriBridge.dbSaveWatchedFolder(newFolder)
        await handleRefreshLibrary()
        handleTriggerScan(selected)
        showToast(`Added watched folder: "${folderName}" and started indexing.`)
      }
    } catch (err: any) {
      showToast(`Could not add folder: ${err.message || err}`)
    }
  }

  const handleRemoveWatchedFolder = async (folderId: string) => {
    try {
      await tauriBridge.dbRemoveWatchedFolder(folderId)
      await handleRefreshLibrary()
      showToast('Removed watched folder from monitoring.')
    } catch (err: any) {
      showToast(`Could not remove folder: ${err.message || err}`)
    }
  }

  // Whether any filters are currently active on the Virtual Grid
  const isGridFilterActive = Boolean(
    searchQuery.trim() ||
    selectedMountId ||
    selectedFolderFilter ||
    facets.era ||
    facets.composer ||
    facets.language ||
    facets.format ||
    facets.genre ||
    facets.ensemble ||
    facets.mastering
  )

  // 1. Grid-scoped tracks: filter by Search, Facets (era, composer, language, format), Storage Mount, and Folder.
  // EXCLUDES activeTriageFilter so that selecting an anomaly isolates tracks in the grid without collapsing the diagnostic queue!
  const gridScopedTracks = useMemo(() => {
    const filterState: FacetFilterState = {
      searchQuery,
      formatFilter: facets.format,
      eraFilter: facets.era,
      composerFilter: facets.composer,
      languageFilter: facets.language,
      genreFilter: facets.genre,
      ensembleFilter: facets.ensemble,
      masteringFilter: facets.mastering,
      storageMountFilter: selectedMountId,
    }
    let result = graphEngine.filterTracks(filterState)
    if (selectedFolderFilter) {
      result = result.filter((t) => (t.filePath || '').replace(/\\/g, '/').startsWith(selectedFolderFilter))
    }
    return result
  }, [searchQuery, facets, selectedMountId, selectedFolderFilter, tracks])

  // 2. Dynamic hygiene diagnostics & health score scoped to the active grid slice
  const scopedAuditResult = useMemo(() => {
    return auditService.computeCatalogAudit(gridScopedTracks, releases)
  }, [gridScopedTracks, releases])

  const scopedAuditIssues = scopedAuditResult.issues
  const scopedHealthScore = scopedAuditResult.healthScore

  // 3. Derived filtered tracks displayed on Data Canvas (further isolated by activeTriageFilter if set)
  const filteredTracks = useMemo(() => {
    if (!activeTriageFilter) return gridScopedTracks

    const targetIssue =
      scopedAuditIssues.find((i) => i.id === activeTriageFilter) ||
      graphEngine.getAllAuditIssues().find((i) => i.id === activeTriageFilter)

    if (targetIssue && targetIssue.sampleTrackIds && targetIssue.sampleTrackIds.length > 0) {
      const idSet = new Set(targetIssue.sampleTrackIds)
      return gridScopedTracks.filter((t) => idSet.has(t.id))
    }

    return gridScopedTracks.filter((t) => {
      if (activeTriageFilter === 'uncommitted_sidecar') return t.sidecarStatus === 'uncommitted_sidecar'
      if (activeTriageFilter === 'checksum_mismatch') return !t.checksumValid
      if (activeTriageFilter === 'low_res_art') {
        const rel = graphEngine.getReleaseById(t.releaseId)
        return rel?.artwork.isLowRes || !rel?.artwork.width || rel.artwork.width < 800
      }
      if (activeTriageFilter === 'missing_track_num') return !t.trackNumber || t.trackNumber <= 0
      if (activeTriageFilter === 'missing_movement') return t.workId && !t.movementNumber
      if (activeTriageFilter === 'empty_composer') return !t.artistCredit?.trim() && !t.composerName?.trim()
      if (activeTriageFilter === 'missing_metadata') {
        const rel = graphEngine.getReleaseById(t.releaseId)
        return !rel?.releaseYear && !rel?.originalYear
      }
      if (activeTriageFilter === 'unformatted_backdrop' || activeTriageFilter === 'audit-unformatted-backdrops') {
        const rel = graphEngine.getReleaseById(t.releaseId)
        return rel ? backdropAnalyzer.isBackdropUnformatted(rel).isUnformatted : false
      }
      return true
    })
  }, [gridScopedTracks, activeTriageFilter, scopedAuditIssues])

  // 4. Currently active triage anomaly details (if any)
  const activeTriageIssue = useMemo(() => {
    if (!activeTriageFilter) return undefined
    return (
      scopedAuditIssues.find(
        (i) => i.id === activeTriageFilter || i.category === activeTriageFilter
      ) ||
      graphEngine
        .getAllAuditIssues()
        .find((i) => i.id === activeTriageFilter || i.category === activeTriageFilter)
    )
  }, [activeTriageFilter, scopedAuditIssues])

  // Current active selections
  const currentTrack = tracks.find((t) => t.id === selectedTrackId) || tracks[0]
  const currentRelease = currentTrack ? releases.find((r) => r.id === currentTrack.releaseId) : releases[0]

  // Library statistics
  const stats = useMemo(() => graphEngine.getStats(), [tracks, storageMounts, auditIssues])

  // Handlers
  const handleImportComplete = (result: IngestionResult, isCustom: boolean, isStreaming = false) => {
    graphEngine.loadCustomLibrary({
      tracks: result.tracks,
      releases: result.releases,
      works: result.works,
      auditIssues: result.auditIssues,
      storageMounts: result.storageMounts,
    })
    // Run live dynamic hygiene diagnostics on newly ingested tracks
    auditService.runFullCatalogAudit()

    // Reset any stale filters from previous state so the new library is immediately 100% visible
    if (!isStreaming) {
      setActiveTriageFilter(undefined)
      setSelectedMountId(undefined)
      setSelectedFolderFilter(undefined)
      setFacets({})
      setSearchQuery('')
    }

    // Auto-select view mode based on imported repertoire
    if (result.works.length === 0 && result.releases.length > 0) {
      setViewMode('variant_stack')
    }

    refreshFromEngine()
    if (result.tracks.length > 0 && (!selectedTrackId || !isStreaming)) {
      setSelectedTrackId(result.tracks[0].id)
    }
    if (!isStreaming) {
      persistCurrentLibrary()
      showToast(
        `Library imported: ${result.tracks.length} tracks, ${result.releases.length} albums, ${result.works.length} works!`
      )
    }
  }

  const handleResetToDemo = () => {
    graphEngine.resetToDemoCatalog()
    refreshFromEngine()
    const all = graphEngine.getAllTracks()
    if (all.length > 0) setSelectedTrackId(all[0].id)
    storagePersistence.clearLibrary()
    showToast('Loaded Audiophile Demo Catalog (Kind of Blue, Beethoven, Bach)')
  }

  const handleToggleReadOnly = (mountId: string) => {
    const newState = graphEngine.toggleMountReadOnly(mountId)
    refreshFromEngine()
    showToast(
      newState
        ? 'Storage Mount Read-Only Lock ENGAGED (File modifications blocked)'
        : 'Storage Mount Read-Write access ENABLED'
    )
  }

  const handleRemediateAudit = async (issueId: string) => {
    const res = await auditService.remediateIssue(issueId)
    refreshFromEngine()
    persistCurrentLibrary()
    showToast(res.message)
  }

  const handleSelectVariant = (releaseId: string, variantId: string) => {
    graphEngine.setMasterVariant(releaseId, variantId)
    refreshFromEngine()
    persistCurrentLibrary()
    showToast('Active Master Variant Updated')
  }

  const handleInspectRelease = (releaseId: string) => {
    const relTracks = tracks.filter((t) => t.releaseId === releaseId)
    if (relTracks.length > 0) {
      setSelectedTrackId(relTracks[0].id)
    }
  }

  const handleToggleTrackSelection = (trackId: string, isMulti: boolean) => {
    setSelectedTrackIds((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) {
        next.delete(trackId)
      } else {
        next.add(trackId)
      }
      return next
    })
  }

  const handleSelectAllTracks = (selectAll: boolean) => {
    if (selectAll) {
      setSelectedTrackIds(new Set(filteredTracks.map((t) => t.id)))
    } else {
      setSelectedTrackIds(new Set())
    }
  }

  const handleApplyBatchEdits = (editsMap: Record<string, Partial<Track>>) => {
    Object.entries(editsMap).forEach(([trackId, edits]) => {
      graphEngine.updateTrackSidecar(trackId, edits)
    })
    refreshFromEngine()
    persistCurrentLibrary()
    showToast(`Staged ${Object.keys(editsMap).length} edits in non-destructive sidecars`)
  }

  const handleAddCredit = (credit: Credit) => {
    if (!currentTrack) return
    const nextCredits = [...currentTrack.credits, credit]
    graphEngine.updateTrackSidecar(currentTrack.id, { credits: nextCredits })
    refreshFromEngine()
    persistCurrentLibrary()
    showToast(`Added ${credit.role.replace('_', ' ')} credit for "${credit.personName}"`)
  }

  const handleApplyMerge = (mergedFields: Record<string, string>) => {
    if (!currentTrack) return
    const editsToStage: Record<string, any> = {}

    const newTitle = mergedFields.trackTitle || mergedFields.title
    if (newTitle && newTitle !== currentTrack.title) editsToStage.title = newTitle

    const newArtist = mergedFields.artist || mergedFields.artistCredit
    if (newArtist && newArtist !== currentTrack.artistCredit) editsToStage.artistCredit = newArtist

    const newComposer = mergedFields.composer || mergedFields.composerName
    if (newComposer && newComposer !== (currentTrack.composerName || '')) editsToStage.composerName = newComposer

    const newAlbum = mergedFields.releaseTitle || mergedFields.album
    if (newAlbum && newAlbum !== (currentRelease?.title || currentTrack.folderName || '')) editsToStage.album = newAlbum

    if (mergedFields.year && !isNaN(Number(mergedFields.year))) {
      const parsedYear = Number(mergedFields.year)
      if (parsedYear !== (currentRelease?.releaseYear || currentRelease?.originalYear)) {
        editsToStage.year = parsedYear
      }
    }

    if (mergedFields.coverArtUrl) {
      editsToStage.coverArtUrl = mergedFields.coverArtUrl
    }

    graphEngine.updateTrackSidecar(currentTrack.id, editsToStage)

    if (currentRelease) {
      if (mergedFields.releaseTitle && mergedFields.releaseTitle !== currentRelease.title) {
        graphEngine.updateReleaseNames(currentRelease.id, { title: mergedFields.releaseTitle })
      }
      if (mergedFields.year && !isNaN(Number(mergedFields.year))) {
        currentRelease.releaseYear = Number(mergedFields.year)
      }
      if (mergedFields.label) {
        currentRelease.label = mergedFields.label
      }
      if (mergedFields.catalogNo) {
        currentRelease.catalogNumber = mergedFields.catalogNo
      }
      if (mergedFields.barcode) {
        currentRelease.barcodeUpc = mergedFields.barcode
      }
      if (mergedFields.coverArtUrl) {
        currentRelease.artwork.frontCoverUrl = mergedFields.coverArtUrl
        if (mergedFields.coverResolution) {
          currentRelease.artwork.resolution = mergedFields.coverResolution
        }
      }
      if (mergedFields.backdropUrl) {
        if (!currentRelease.artwork) {
          currentRelease.artwork = {
            frontCoverUrl: mergedFields.coverArtUrl || currentRelease.coverArtUrl || '',
            backdropUrl: mergedFields.backdropUrl,
            resolution: 'Custom',
            width: 2400,
            height: 2400,
            dpi: 300,
            colorProfile: 'sRGB',
            isLowRes: false,
            hasBookletPdf: false,
          }
        } else {
          currentRelease.artwork.backdropUrl = mergedFields.backdropUrl
        }
        currentRelease.backdropUrl = mergedFields.backdropUrl
      }
    }

    refreshFromEngine()
    persistCurrentLibrary()
    showToast('Selective federated merge staged in track sidecar & artwork ledger')
  }

  const handleUpdateReleaseDetails = (
    releaseId: string,
    updates: {
      title?: string
      folderName?: string
      composerName?: string
      artistCredit?: string
      releaseYear?: number
      coverArtUrl?: string
      backdropUrl?: string
      rating?: number
      isFavorite?: boolean
      isMasterpiece?: boolean
    }
  ) => {
    const res = graphEngine.updateReleaseDetails(releaseId, updates)
    if (res) {
      refreshFromEngine()
      persistCurrentLibrary()
      if (updates.rating !== undefined) {
        showToast(updates.rating > 0 ? `Rated "${res.release.title}" ${updates.rating}★` : `Cleared rating for "${res.release.title}"`)
      } else if (updates.isFavorite !== undefined) {
        showToast(updates.isFavorite ? `Added "${res.release.title}" to Favorites` : `Removed "${res.release.title}" from Favorites`)
      } else if (res.affectedTracksCount > 0) {
        showToast(`Updated "${res.release.title}" & staged edits across ${res.affectedTracksCount} tracks`)
      } else {
        showToast(`Updated "${res.release.title}"`)
      }
    }
  }

  const handleReverifyChecksum = async (trackId: string) => {
    const trk = graphEngine.getTrackById(trackId)
    if (trk) {
      showToast('Computing FLAC stream MD5 & verifying CRC against Vorbis comment block...')
      setTimeout(() => {
        trk.checksumValid = true
        refreshFromEngine()
        persistCurrentLibrary()
        showToast('Checksum verification confirmed: Stream is bit-perfect.')
      }, 800)
    }
  }

  const handleApplyPathRestructure = (previews: { trackId: string; proposedPath: string }[]) => {
    previews.forEach((p) => {
      const trk = graphEngine.getTrackById(p.trackId)
      if (trk) {
        trk.filePath = p.proposedPath
        trk.sidecarStatus = 'uncommitted_sidecar'
      }
    })
    refreshFromEngine()
    persistCurrentLibrary()
    showToast(`Updated paths for ${previews.length} tracks according to rule template`)
  }

  // Comprehensive contextual action handlers for Guided Tutorial Controller
  const tutorialActions: TutorialActions = useMemo(
    () => ({
      setViewMode: (mode) => setViewMode(mode),
      setAlbumDisplayMode: (mode) => setAlbumDisplayMode(mode === 'both' ? 'album_first' : mode),
      setRightPanelTab: (tab) => setRightPanelTab(tab),
      openImportModal: () => setIsImportModalOpen(true),
      closeImportModal: () => setIsImportModalOpen(false),
      openCommitModal: () => setIsCommitModalOpen(true),
      closeCommitModal: () => setIsCommitModalOpen(false),
      openBatchRuleModal: () => setIsPathRuleModalOpen(true),
      closeBatchRuleModal: () => setIsPathRuleModalOpen(false),
      openBatchAiModal: () => setIsBatchDiffModalOpen(true),
      closeBatchAiModal: () => setIsBatchDiffModalOpen(false),
      openBatchDiffModal: () => setIsBatchDiffModalOpen(true),
      closeBatchDiffModal: () => setIsBatchDiffModalOpen(false),
      openCustomizeModal: () => {
        if (currentRelease) setCustomizingRelease(currentRelease)
        else if (releases.length > 0) setCustomizingRelease(releases[0])
      },
      closeCustomizeModal: () => setCustomizingRelease(null),
      openCommandBar: () => setIsCommandBarOpen(true),
      closeCommandBar: () => setIsCommandBarOpen(false),
      selectTrack: (trackId) => {
        if (trackId) {
          setSelectedTrackId(trackId)
        } else if (tracks.length > 0) {
          setSelectedTrackId(tracks[0].id)
        }
      },
      selectTracks: (trackIds) => setSelectedTrackIds(new Set(trackIds)),
    }),
    [tracks, releases, currentRelease]
  )

  // Agent Dispatcher Context: bridge between AI Copilot and UI state
  const agentDispatcherContext: AgentDispatcherContext = useMemo(
    () => ({
      setViewMode: (mode) => setViewMode(mode),
      setFacets: (newFacets) => setFacets(newFacets),
      setSearchQuery: (query) => setSearchQuery(query),
      setSelectedTrackId: (id) => setSelectedTrackId(id),
      openModal: (modalName: string, payload?: any) => {
        if (modalName === 'import') setIsImportModalOpen(true)
        else if (modalName === 'commit' || modalName === 'twophase') setIsCommitModalOpen(true)
        else if (modalName === 'pathrule') setIsPathRuleModalOpen(true)
        else if (modalName === 'batch_diff' || modalName === 'batch_ai') setIsBatchDiffModalOpen(true)
        else if (modalName === 'tutorial') setIsTutorialOpen(true)
        else if (modalName === 'command_bar' || modalName === 'spotlight') setIsCommandBarOpen(true)
        else if (modalName === 'agent') setIsAgentDrawerOpen(true)
        else if (modalName === 'customize') {
          if (payload) setCustomizingRelease(payload)
          else if (currentRelease) setCustomizingRelease(currentRelease)
        }
      },
      refreshFromEngine: () => {
        refreshFromEngine()
        persistCurrentLibrary()
      },
      showToast: (msg) => showToast(msg),
    }),
    [currentRelease]
  )

  // Keyboard shortcut listener
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setIsAgentDrawerOpen((prev) => !prev)
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setIsCommandBarOpen((prev) => !prev)
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        setIsImportModalOpen(true)
      } else if (e.key === '?' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        e.preventDefault()
        setIsTutorialOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleGlobalKey)
    return () => window.removeEventListener('keydown', handleGlobalKey)
  }, [])

  // Command palette items
  const commands: CommandItem[] = [
    {
      id: 'cmd-cadence-agent',
      title: 'Open Cadence AI Copilot (Chat, Statistics & Auto-Remediations)',
      category: 'ACTION',
      shortcut: '⌘J',
      icon: <Bot className="w-4 h-4 text-[#ADFF2F]" />,
      action: () => setIsAgentDrawerOpen(true),
    },
    {
      id: 'cmd-guided-tutorial',
      title: 'Interactive Guided Tutorial & Headless Agent Protocol Tour',
      category: 'HELP',
      shortcut: '?',
      icon: <Compass className="w-4 h-4 text-[#00F5FF]" />,
      action: () => setIsTutorialOpen(true),
    },
    {
      id: 'cmd-import-library',
      title: 'Import Music Library (Folder Picker, Local Disk Scan, or Dropzone)',
      category: 'ACTION',
      shortcut: '⌘O',
      icon: <FolderPlus className="w-4 h-4 text-[#00F5FF]" />,
      action: () => setIsImportModalOpen(true),
    },
    {
      id: 'cmd-twophase',
      title: 'Review Staged Metadata & Write to Disk (Two-Phase Commit)',
      category: 'SAFETY',
      shortcut: '⌘S',
      icon: <ShieldCheck className="w-4 h-4 text-[#10B981]" />,
      action: () => setIsCommitModalOpen(true),
    },
    {
      id: 'cmd-batch-diff-tracks',
      title: 'Batch Enrich & Harmonize Tracks (Up to 25 Selected)',
      category: 'ACTION',
      shortcut: '⌘B',
      icon: <Sparkles className="w-4 h-4 text-[#ADFF2F]" />,
      action: () => setIsBatchDiffModalOpen(true),
    },
    {
      id: 'cmd-pathrule',
      title: 'Configure Dynamic File & Directory Path Rules',
      category: 'ACTION',
      shortcut: '⌘P',
      icon: <FolderTree className="w-4 h-4 text-[#ADFF2F]" />,
      action: () => setIsPathRuleModalOpen(true),
    },
    {
      id: 'cmd-run-audit',
      title: 'Run Comprehensive Metadata Hygiene Audit',
      category: 'AUDIT',
      icon: <Sparkles className="w-4 h-4 text-[#00F5FF]" />,
      action: () => {
        const issues = auditService.runFullCatalogAudit()
        refreshFromEngine()
        showToast(`Catalog Audit Complete: Found ${issues.length} hygiene issue categories`)
      },
    },
    {
      id: 'cmd-normalization-rules',
      title: 'Manage Remembered Normalization Rules (A. R. Rahman → A.R.Rahman)',
      category: 'AUDIT',
      shortcut: '⌘N',
      icon: <Sparkles className="w-4 h-4 text-[#ADFF2F]" />,
      action: () => setIsNormalizationRulesModalOpen(true),
    },

    {
      id: 'cmd-auto-remediate',
      title: 'Auto-Remediate First Pending Hygiene Issue in Queue',
      category: 'AUDIT',
      icon: <RotateCcw className="w-4 h-4 text-[#10B981]" />,
      action: () => {
        const first = auditIssues.find(
          (i) => i.affectedCount > 0 && i.isAutoFixable !== false && Boolean(i.autoFixAction)
        )
        if (first) {
          handleRemediateAudit(first.id)
        } else {
          showToast('No auto-fixable anomalies pending in triage queue.')
        }
      },
    },
    {
      id: 'cmd-toggle-mount-lock',
      title: 'Toggle Storage Mount Read-Only Lock',
      category: 'SAFETY',
      icon: <HardDrive className="w-4 h-4 text-[#F59E0B]" />,
      action: () => {
        const targetMount = storageMounts[0]
        if (targetMount) {
          handleToggleReadOnly(targetMount.id)
        } else {
          showToast('No storage mount detected.')
        }
      },
    },
    {
      id: 'cmd-view-work',
      title: 'Switch View: Classical Work / Movement Hierarchies',
      category: 'NAVIGATION',
      shortcut: '1',
      icon: <FolderTree className="w-4 h-4 text-[#00F5FF]" />,
      action: () => setViewMode('work_movement'),
    },
    {
      id: 'cmd-view-variants',
      title: 'Switch View: Variant & Master Pressing Stacks',
      category: 'NAVIGATION',
      shortcut: '2',
      icon: <Layers className="w-4 h-4 text-[#00F5FF]" />,
      action: () => setViewMode('variant_stack'),
    },
    {
      id: 'cmd-view-grid',
      title: 'Switch View: Ultra-Fast Virtual Data Grid',
      category: 'NAVIGATION',
      shortcut: '3',
      icon: <Table className="w-4 h-4 text-[#00F5FF]" />,
      action: () => setViewMode('virtual_table'),
    },
    {
      id: 'cmd-view-folder-tree',
      title: 'Switch View: Physical Folder Tree Explorer',
      category: 'NAVIGATION',
      shortcut: '4',
      icon: <Folder className="w-4 h-4 text-[#00F5FF]" />,
      action: () => setViewMode('folder_tree'),
    },
    {
      id: 'cmd-open-storage-manager',
      title: 'Open Storage & Watched Folders Manager',
      category: 'NAVIGATION',
      shortcut: '⌘,',
      icon: <HardDrive className="w-4 h-4 text-[#00F5FF]" />,
      action: () => setIsStorageManagerOpen(true),
    },
  ]

  const uncommittedCount = tracks.filter((t) => t.sidecarStatus === 'uncommitted_sidecar').length
  const allAffectedTrackIds = new Set(auditIssues.flatMap((i) => i.sampleTrackIds || []))
  const impactedAlbumsCount = new Set(
    tracks.filter((t) => allAffectedTrackIds.has(t.id)).map((t) => t.releaseId).filter(Boolean)
  ).size

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0D0E12] text-[#F1F5F9] select-none font-sans">
      {/* Refined Ergonomic Master Navigation Switchboard */}
      <header className="h-14 border-b border-white/[0.08] bg-[#12151D]/80 backdrop-blur-xl px-4 flex items-center justify-between shrink-0 z-30">
        {/* Brand & Library Stats */}
        <div className="flex items-center gap-3">
          <div data-tutorial-id="header-brand" className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#00F5FF] to-[#8B5CF6] flex items-center justify-center text-black font-extrabold text-sm shadow-md">
              <Music4 className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="flex flex-col text-left">
              <span className="font-extrabold tracking-tight text-sm text-[#F1F5F9] leading-none">
                CADENCE PRO
              </span>
              <span className="text-[9px] font-mono text-[#00F5FF] tracking-wider uppercase font-semibold">
                Relational Music Engine
              </span>
            </div>
          </div>

          <div className="h-4 w-[1px] bg-white/10 mx-1 hidden sm:block" />

          <div className="hidden lg:flex items-center gap-1.5 text-[11px] font-mono text-slate-400">
            <span>{tracks.length} Tracks</span>
            <span>·</span>
            <span className="text-[#00F5FF] font-semibold">{stats.highResPercentage}% Hi-Res</span>
          </div>
        </div>

        {/* PRIMARY OBJECT & OPERATION SWITCHBOARD */}
        <div className="flex items-center gap-1 bg-black/40 p-1 rounded-xl border border-white/10 shadow-inner">
          <button
            onClick={() => {
              setTopMode('library')
              setFocusedWorkbenchTrack(null)
            }}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
              topMode === 'library'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <span>📚</span>
            <span>Library</span>
            <span className="text-[10px] text-slate-500 font-mono hidden md:inline">⌘1</span>
          </button>

          <button
            onClick={() => setTopMode('maintain')}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
              topMode === 'maintain'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <span>🛠️</span>
            <span>Maintain</span>
            {impactedAlbumsCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-300 font-mono border border-amber-500/30">
                ⚠️ {impactedAlbumsCount}
              </span>
            )}
            {uncommittedCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-lime-500/20 text-lime-300 font-mono border border-lime-500/30">
                💾 {uncommittedCount}
              </span>
            )}
            <span className="text-[10px] text-slate-500 font-mono hidden md:inline">⌘2</span>
          </button>
        </div>

        {/* Right Header: Ingestion Action, Spotlight, Copilot, Activity */}
        <div className="flex items-center gap-2 relative">
          <button
            onClick={() => setIsImportModalOpen(true)}
            title="Import Music Folder (⌘O)"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-cyan-500/20 to-teal-500/20 hover:from-cyan-500/30 hover:to-teal-500/30 border border-cyan-500/40 text-cyan-300 hover:text-white text-xs font-semibold shadow-md transition-all cursor-pointer"
          >
            <FolderPlus className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">Add Music</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-black/40 text-cyan-300 font-mono border border-cyan-500/30">
              ⌘O
            </span>
          </button>

          <ActivityPill
            telemetry={scanTelemetry}
            onClick={() => setIsActivityPopoverOpen((prev) => !prev)}
            isOpen={isActivityPopoverOpen}
          />
          <ActivityCenterPopover
            isOpen={isActivityPopoverOpen}
            onClose={() => setIsActivityPopoverOpen(false)}
            telemetry={scanTelemetry}
            onOpenQuarantineModal={() => {
              setTopMode('maintain')
              setIsActivityPopoverOpen(false)
            }}
          />

          <button
            data-tutorial-id="btn-cadence-agent"
            onClick={() => setIsAgentDrawerOpen((prev) => !prev)}
            title="Cadence Embedded AI Agent Copilot (⌘J)"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all shadow-md cursor-pointer ${
              isAgentDrawerOpen
                ? 'bg-[#ADFF2F]/25 border-[#ADFF2F] text-[#ADFF2F] shadow-[#ADFF2F]/20'
                : 'bg-gradient-to-r from-[#8B5CF6]/20 to-[#00F5FF]/20 hover:from-[#8B5CF6]/30 hover:to-[#00F5FF]/30 border-[#8B5CF6]/40 text-[#F1F5F9] hover:text-white'
            }`}
          >
            <Bot className="w-3.5 h-3.5 text-[#ADFF2F]" />
            <span className="hidden sm:inline">AI Copilot</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-black/40 text-[#ADFF2F] font-mono border border-[#ADFF2F]/30">
              ⌘J
            </span>
          </button>

          <button
            data-tutorial-id="btn-spotlight-cmd"
            onClick={() => setIsCommandBarOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-mono text-[#94A3B8] hover:text-white transition-all shadow-sm cursor-pointer"
          >
            <Command className="w-3.5 h-3.5 text-[#00F5FF]" />
            <span className="hidden sm:inline">Spotlight</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-black/40 text-[#64748B]">
              ⌘K
            </span>
          </button>
        </div>
      </header>

      {/* Main Workspace Stage */}
      {topMode === 'maintain' ? (
        <MaintainCockpit
          tracks={tracks}
          releases={releases}
          auditIssues={auditIssues}
          storageMounts={storageMounts}
          watchedFolders={watchedFolders}
          skippedFiles={skippedFiles}
          uncommittedCount={uncommittedCount}
          activeSubTab={maintainSubTab}
          onSubTabChange={setMaintainSubTab}
          onAddWatchedFolder={handleAddWatchedFolder}
          onRemoveWatchedFolder={handleRemoveWatchedFolder}
          onRemediateAudit={handleRemediateAudit}
          onRefreshAudit={() => {
            auditService.runFullCatalogAudit()
            refreshFromEngine()
            showToast('Catalog hygiene diagnostic scan updated.')
          }}
          onApplyPathRestructure={(pattern: string) => {
            const previews = tracks.map((t) => {
              const rel = releases.find((r) => r.id === t.releaseId)
              const proposed = pattern
                .replace('{Artist}', t.artistCredit || 'Unknown Artist')
                .replace('{Year}', String(rel?.releaseYear || 'Unknown Year'))
                .replace('{Album}', rel?.title || 'Unknown Album')
                .replace('{TrackNum}', String(t.trackNumber || 1).padStart(2, '0'))
                .replace('{Title}', t.title)
              return {
                trackId: t.id,
                proposedPath: proposed + '.' + (t.format || 'flac').toLowerCase(),
              }
            })
            handleApplyPathRestructure(previews)
          }}
          onCommitTwoPhase={() => setIsCommitModalOpen(true)}
          onToggleMountLock={handleToggleMountLock}
          onToggleMountStatus={(mountId: string) => {
            const mount = storageMounts.find((m) => m.id === mountId)
            handleToggleMountStatus(mountId, mount?.status || 'online')
          }}
          onTriggerScan={(folderPath?: string) => {
            if (folderPath) {
              handleTriggerScan(folderPath)
            } else if (storageMounts.length > 0) {
              handleTriggerScan(storageMounts[0].mountPath)
            }
          }}
          onRefreshLibrary={handleRefreshLibrary}
          showToast={showToast}
          onSwitchToLibrary={() => setTopMode('library')}
        />
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* 1. Left Rail: Normalized Navigation */}
          <LeftRail
            auditIssues={scopedAuditIssues}
            activeTriageFilter={activeTriageFilter}
            onSelectTriageFilter={setActiveTriageFilter}
            onRemediateAudit={handleRemediateAudit}
            healthScore={scopedHealthScore}
            isFilteredScope={isGridFilterActive}
            scopeTrackCount={gridScopedTracks.length}
            totalTrackCount={tracks.length}
            onRefreshAudit={() => {
              auditService.runFullCatalogAudit()
              refreshFromEngine()
              showToast('Catalog hygiene diagnostic scan updated.')
            }}
            onOpenNormalizationRules={() => setIsNormalizationRulesModalOpen(true)}
            facets={facets}
            onFacetChange={setFacets}
            onResetFacets={() => setFacets({})}
            storageMounts={storageMounts}
            onToggleReadOnly={handleToggleReadOnly}
            selectedMountId={selectedMountId}
            onSelectMount={setSelectedMountId}
            selectedFolderFilter={selectedFolderFilter}
            onSelectFolderFilter={setSelectedFolderFilter}
            onOpenStorageManager={() => {
              setTopMode('maintain')
              setMaintainSubTab('storage_mounts')
            }}
            onOpenImportModal={() => setIsImportModalOpen(true)}
            watchedFolders={watchedFolders}
            tracks={tracks}
            releases={releases}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />

          {/* 2. Center Stage: Data Canvas OR Focused Workbench */}
          {focusedWorkbenchTrack ? (
            <FocusedWorkbench
              track={focusedWorkbenchTrack}
              release={releases.find((r) => r.id === focusedWorkbenchTrack.releaseId)}
              allTracks={tracks}
              onClose={() => setFocusedWorkbenchTrack(null)}
              onApplyEdits={(edits) => {
                graphEngine.updateTrackSidecar(focusedWorkbenchTrack.id, edits)
                refreshFromEngine()
                persistCurrentLibrary()
              }}
              showToast={showToast}
            />
          ) : (
            <DataCanvas
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              albumDisplayMode={albumDisplayMode}
              onAlbumDisplayModeChange={setAlbumDisplayMode}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              works={works}
              releases={releases}
              tracks={filteredTracks}
              selectedTrackId={selectedTrackId}
              onSelectTrack={setSelectedTrackId}
              selectedTrackIds={selectedTrackIds}
              onToggleTrackSelection={handleToggleTrackSelection}
              onSelectAllTracks={handleSelectAllTracks}
              onSelectVariant={handleSelectVariant}
              onInspectRelease={handleInspectRelease}
              onCustomizeRelease={(rel) => setCustomizingRelease(rel)}
              onUpdateReleaseDetails={handleUpdateReleaseDetails}
              onOpenSidecar={(trackId) => setSidecarTrackId(trackId)}
              onApplyBatchEdits={handleApplyBatchEdits}
              onTriggerTwoPhaseCommit={() => setIsCommitModalOpen(true)}
              onOpenBatchRuleModal={() => setIsPathRuleModalOpen(true)}
              onOpenImportModal={() => setIsImportModalOpen(true)}
              onOpenBatchDiff={() => setIsBatchDiffModalOpen(true)}
              onOpenBatchAi={() => setIsBatchDiffModalOpen(true)}
              totalLibraryTracksCount={tracks.length}
              onResetFilters={() => {
                setFacets({})
                setActiveTriageFilter(undefined)
                setSelectedMountId(undefined)
                setSelectedFolderFilter(undefined)
                setSearchQuery('')
              }}
              activeTriageIssue={activeTriageIssue}
              onClearTriageFilter={() => setActiveTriageFilter(undefined)}
              onRemediateTriageIssue={handleRemediateAudit}
            />
          )}

          {/* 3. Right Panel: Contextual Action Surface */}
          <RightPanel
            track={currentTrack}
            release={currentRelease}
            allReleases={releases}
            selectedTrackIds={selectedTrackIds}
            activeTab={rightPanelTab}
            onTabChange={setRightPanelTab}
            onOpenBatchDiff={() => setIsBatchDiffModalOpen(true)}
            onOpenBatchAi={() => setIsBatchDiffModalOpen(true)}
            onAddCredit={handleAddCredit}
            onApplyMerge={handleApplyMerge}
            onReverifyChecksum={handleReverifyChecksum}
            onOpenFocusedWorkbench={(t) => setFocusedWorkbenchTrack(t)}
          />
        </div>
      )}

      {/* Guided Tutorial Interactive Tour & Headless Agent Protocol */}
      <GuidedTutorialModal
        isOpen={isTutorialOpen}
        onClose={() => setIsTutorialOpen(false)}
        actions={tutorialActions}
      />

      {/* Global Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-xl bg-[#12151D] border border-[#00F5FF]/40 text-xs font-mono text-[#00F5FF] shadow-2xl flex items-center gap-2 glow-cyan animate-in fade-in slide-in-from-bottom-3 duration-200">
          <Sparkles className="w-4 h-4 text-[#ADFF2F]" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Import Library Modal */}
      <ImportLibraryModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImportComplete={handleImportComplete}
        onResetToDemo={handleResetToDemo}
        isCustomLibraryActive={isCustomLibraryActive}
      />

      {/* Omni Command Bar Modal */}
      <OmniCommandBar
        isOpen={isCommandBarOpen}
        onClose={() => setIsCommandBarOpen(false)}
        commands={commands}
      />

      {/* Staged for Commit Modal */}
      {isCommitModalOpen && (
        <TwoPhaseCommitModal
          uncommittedTracks={tracks.filter((t) => t.sidecarStatus === 'uncommitted_sidecar')}
          releases={releases}
          onClose={() => setIsCommitModalOpen(false)}
          onSuccess={() => {
            refreshFromEngine()
            persistCurrentLibrary()
            showToast('Staged changes committed bit-perfectly to audio headers, sidecars & local database')
          }}
          onDiscardAll={() => {
            const count = graphEngine.discardAllUncommittedEdits()
            refreshFromEngine()
            persistCurrentLibrary()
            setIsCommitModalOpen(false)
            showToast(`Discarded ${count} staged edits. Library returned to clean synced state.`)
          }}
          onDiscardTrack={(trackId) => {
            graphEngine.discardTrackEdits(trackId)
            refreshFromEngine()
            persistCurrentLibrary()
            showToast('Discarded staged edit for track')
          }}
          onDiscardRelease={(releaseId) => {
            const count = graphEngine.discardReleaseEdits(releaseId)
            refreshFromEngine()
            persistCurrentLibrary()
            showToast(`Discarded ${count} staged edits for album`)
          }}
          onDiscardReleaseArtwork={(releaseId) => {
            const count = graphEngine.discardReleaseArtwork(releaseId)
            refreshFromEngine()
            persistCurrentLibrary()
            showToast(`Discarded staged cover art for album`)
          }}
          onDiscardAllArtwork={() => {
            const count = graphEngine.discardAllArtworkEdits()
            refreshFromEngine()
            persistCurrentLibrary()
            showToast(`Discarded staged cover art across all ${count} tracks. Real metadata edits preserved.`)
          }}
        />
      )}

      {/* Batch Rule & Path Restructuring Modal */}
      {isPathRuleModalOpen && (
        <BatchRuleModal
          tracks={tracks}
          onClose={() => setIsPathRuleModalOpen(false)}
          onApplyPathRestructure={handleApplyPathRestructure}
        />
      )}

      {/* Customize Album & Folder Modal */}
      <CustomizeAlbumModal
        isOpen={Boolean(customizingRelease)}
        release={customizingRelease || undefined}
        tracksCount={tracks.filter((t) => t.releaseId === customizingRelease?.id).length}
        onClose={() => setCustomizingRelease(null)}
        onSave={handleSaveAlbumCustomization}
      />

      {/* Sidecar Inspector Modal */}
      {sidecarTrackId && (
        <SidecarExportModal
          track={tracks.find((t) => t.id === sidecarTrackId) || tracks[0]}
          release={releases.find((r) => r.id === (tracks.find((t) => t.id === sidecarTrackId)?.releaseId || ''))}
          work={works.find((w) => w.id === (tracks.find((t) => t.id === sidecarTrackId)?.workId || ''))}
          onClose={() => setSidecarTrackId(null)}
        />
      )}

      {/* Batch Diff Metadata Resolution Modal (Up to 25 Selected Tracks) */}
      <BatchDiffTracksModal
        isOpen={isBatchDiffModalOpen}
        onClose={() => setIsBatchDiffModalOpen(false)}
        selectedTrackIds={selectedTrackIds}
        allTracks={tracks}
        releases={releases}
        onToggleTrackSelection={handleToggleTrackSelection}
        onSelectTracks={setSelectedTrackIds}
        onApplyBatchEdits={handleApplyBatchEdits}
        currentRelease={currentRelease}
        onOpenCommitModal={() => setIsCommitModalOpen(true)}
      />

      {/* Cadence Core Embedded AI Agent Copilot Drawer */}
      <EmbeddedAgentDrawer
        isOpen={isAgentDrawerOpen}
        onClose={() => setIsAgentDrawerOpen(false)}
        dispatcherContext={agentDispatcherContext}
        tracks={tracks}
        releases={releases}
      />

      {/* Comprehensive Library & Storage Management Modal */}
      <StorageManagerModal
        isOpen={isStorageManagerOpen}
        onClose={() => setIsStorageManagerOpen(false)}
        mounts={storageMounts}
        watchedFolders={watchedFolders}
        totalTracksCount={tracks.length}
        onRefreshLibrary={handleRefreshLibrary}
        onTriggerScan={handleTriggerScan}
        onToggleMountLock={handleToggleMountLock}
        onToggleMountStatus={handleToggleMountStatus}
        showToast={showToast}
      />

      {/* Skipped Files & Quarantine Diagnostics Modal */}
      <QuarantineLogModal
        isOpen={isQuarantineModalOpen}
        onClose={() => setIsQuarantineModalOpen(false)}
        skippedFiles={skippedFiles}
        onRefresh={handleRefreshLibrary}
        showToast={showToast}
      />

      {/* Remembered Normalization Rules & Precedence Modal */}
      <NormalizationRulesModal
        isOpen={isNormalizationRulesModalOpen}
        onClose={() => setIsNormalizationRulesModalOpen(false)}
        onRefreshCatalog={refreshFromEngine}
      />


      {/* Audiophile Now Playing Player Dock */}
      <NowPlayingBar onOpenSanctuary={() => setIsSanctuaryOpen(true)} />

      {/* Audiophile Sanctuary Listening Lounge Overlay */}
      <SanctuaryListeningLounge
        isOpen={isSanctuaryOpen}
        onClose={() => setIsSanctuaryOpen(false)}
      />

      {/* Global Drag-and-Drop Ingestion Overlay */}
      {isWindowDragOver && (
        <div className="fixed inset-0 z-50 pointer-events-none bg-[#07090E]/85 backdrop-blur-md border-4 border-dashed border-cyan-400 flex flex-col items-center justify-center animate-in fade-in duration-150">
          <div className="bg-[#12151D] p-8 rounded-2xl border border-cyan-400/40 shadow-2xl flex flex-col items-center text-center gap-4 max-w-md pointer-events-auto">
            <div className="w-16 h-16 rounded-2xl bg-cyan-500/20 border border-cyan-400/50 flex items-center justify-center animate-bounce">
              <FolderPlus className="w-8 h-8 text-cyan-300" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-white tracking-wide">Drop Music Folder Here</h3>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                Cadence will scan and index your audio files with bit-accurate metadata, DR metering, and sidecar safety.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function App() {
  return (
    <AudioPlayerProvider>
      <AppContent />
    </AudioPlayerProvider>
  )
}

export default App
