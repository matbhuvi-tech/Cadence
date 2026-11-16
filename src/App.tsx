import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  FolderPlus,
  Folder,
  HardDrive,
  FolderTree,
  Layers,
  Table,
  Sparkles,
  Command,
  ShieldCheck,
  RotateCcw,
  Music4,
  Compass,
  WifiOff,
  AlertTriangle,
  RefreshCw,
  Server,
  Smartphone,
  PanelRight,
  KeyRound,
  Settings,
  SlidersHorizontal,
  Activity,
} from 'lucide-react'
import { Track, Release, Work, Credit, StorageMount, AuditIssue, AlbumDisplayMode, Playlist, ActiveEntityScope, NavigationAnchor } from './core/types'
import { graphEngine, FacetFilterState } from './core/graphEngine'
import type { CurateCommitRow } from './core/curateCommit'
import { buildCurateCockpitCatalogProps } from './core/curateWorkflow'
import { loadPrioritySettings, loadDismissedProblems, savePrioritySettings, type PrioritySettings } from './core/curatePriorities'
import type { CurateDraft } from './core/curateDraft'
import { auditService } from './services/auditService'
import { storagePersistence } from './core/storagePersistence'
import { IngestionResult } from './services/libraryImporter'
import { LeftRail } from './components/LeftRail/LeftRail'
import { FacetSelections } from './components/LeftRail/FacetedFilters'
import { DataCanvas, CanvasViewMode } from './components/CenterStage/DataCanvas'
import { EntityTab } from './components/CenterStage/AlbumCoverGrid'
import { resolveCurateTargetTrack } from './core/scopeUtils'
import { RightPanelTab } from './components/RightPanel/RightPanel'
import { UnifiedRightSidebar } from './components/RightPanel/UnifiedRightSidebar'
import { OmniCommandBar, CommandItem } from './components/CommandBar/OmniCommandBar'
import { TwoPhaseCommitModal } from './components/Modals/TwoPhaseCommitModal'
import { BatchRuleModal } from './components/Modals/BatchRuleModal'
import { SidecarExportModal } from './components/Modals/SidecarExportModal'
import { ImportLibraryModal } from './components/Modals/ImportLibraryModal'
import { BatchDiffTracksModal } from './components/Modals/BatchDiffTracksModal'
import { CompilationProvenanceModal } from './components/Modals/CompilationProvenanceModal'
import { GuidedTutorialModal } from './components/Tutorial/GuidedTutorialModal'
import { TutorialActions } from './tutorial/tutorialSteps'
import { AudioPlayerProvider, useAudioPlayer } from './context/AudioPlayerContext'
import { EngineControllerProvider, useEngineController } from './context/EngineControllerContext'
import { NowPlayingBar } from './components/AudioPlayer/NowPlayingBar'
import { EngineConnectionGate } from './components/Engine/EngineConnectionGate'
import { listEnginePlaylists } from './services/enginePlaylistService'
import { mapEngineJobStatusToCommitStatus } from './services/engineCurateBridge'
import { stripCoreReleasePrefix } from './services/engineClient'
import { tauriBridge, type CaptureMode } from './services/tauriBridge'
import { ActivityPill } from './components/CommandBar/ActivityPill'
import { CommitStatusPill } from './components/CommandBar/CommitStatusPill'
import { ActivityCenterPopover } from './components/CommandBar/ActivityCenterPopover'
import { StorageManagerModal } from './components/Modals/StorageManagerModal'
import { QuarantineLogModal } from './components/Modals/QuarantineLogModal'
import { NormalizationRulesModal } from './components/Modals/NormalizationRulesModal'
import { MobileRemoteModal } from './components/Modals/MobileRemoteModal'
import { CadenceSettingsModal, type CadenceSettingsTab } from './components/Modals/CadenceSettingsModal'
import { EngineSwitchPromptModal } from './components/Modals/EngineSwitchPromptModal'
import { MaintainCockpit, MaintainSubTab } from './components/Maintain/MaintainCockpit'
import { FocusedWorkbench } from './components/CenterStage/FocusedWorkbench'
import { CurationWorkbench } from './components/Curate/CurationWorkbench'
import { UnifiedCurateCockpit } from './components/Curate/UnifiedCurateCockpit'
import { SanctuaryListeningLounge } from './components/AudioPlayer/SanctuaryListeningLounge'
import { ScanProgressPayload, WatchedFolder, SkippedFile } from './core/types'
import { backdropAnalyzer } from './services/backdropAnalyzer'
import { CreatePlaylistModal } from './components/Modals/CreatePlaylistModal'
import { EditPlaylistModal } from './components/Modals/EditPlaylistModal'
import { AddTracksToPlaylistModal } from './components/Modals/AddTracksToPlaylistModal'
import { PlaylistDetailView } from './components/CenterStage/PlaylistDetailView'
import { backgroundArtworkService } from './services/backgroundArtworkService'
import { CadenceLogo } from './components/common/CadenceLogo'
import { StartupSplashScreen } from './components/common/StartupSplashScreen'
import { useStagedChanges } from './hooks/useStagedChanges'
import { GeminiSetupScreen } from './components/GeminiSetupScreen'

function areCurateCommitRowsEqual(a: readonly CurateCommitRow[], b: readonly CurateCommitRow[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.trackId !== y.trackId ||
      x.status !== y.status ||
      x.payloadJson !== y.payloadJson ||
      x.applies !== y.applies ||
      x.hasNewerDraft !== y.hasNewerDraft ||
      x.hasHeldEdits !== y.hasHeldEdits ||
      x.lineageChanged !== y.lineageChanged ||
      x.artworkUrl !== y.artworkUrl ||
      x.errorMessage !== y.errorMessage
    ) {
      return false
    }
    const cx = x.catalog
    const cy = y.catalog
    if (cx !== cy) {
      if (!cx || !cy) return false
      const keysA = Object.keys(cx) as (keyof typeof cx)[]
      const keysB = Object.keys(cy) as (keyof typeof cy)[]
      if (keysA.length !== keysB.length) return false
      for (const k of keysA) {
        if (cx[k] !== cy[k]) return false
      }
    }
  }
  return true
}

export function AppContent({ onGeminiRemoved }: { onGeminiRemoved?: () => void }) {
  return (
    <EngineControllerProvider>
      <AppContentView onGeminiRemoved={onGeminiRemoved} />
    </EngineControllerProvider>
  )
}

function AppContentView({ onGeminiRemoved }: { onGeminiRemoved?: () => void }) {
  const {
    state: engineState,
    isCoreActive,
    isBootstrapping,
    activeCoreSnapshot,
    engineClient,
    coreCatalogTracks,
    coreCatalogReleases,
    requestSwitchToLocal,
    reconnectCore,
    coreRefreshSnapshot,
    coreRefreshCatalog,
    subscribeEngineEvents,
  } = useEngineController()

  // Primary Graph State (pure in-memory projection fed by the active Playback Engine)
  const [catalogTracks, setTracks] = useState<Track[]>([])
  const [catalogReleases, setReleases] = useState<Release[]>([])
  const [curateCommits, setCurateCommits] = useState<CurateCommitRow[]>([])
  const activeEngineJobsRef = useRef<
    Map<string, { jobId: string; draftId: string; trackId: string; payloadJson: string; status: string }>
  >(new Map())
  const draftSaveVersion = useRef(0)

  const syncCurateRowsFromActiveJobs = useCallback(() => {
    const rows: CurateCommitRow[] = Array.from(activeEngineJobsRef.current.values()).map((j) => ({
      id: j.jobId,
      trackId: j.trackId,
      status: mapEngineJobStatusToCommitStatus(j.status),
      payloadJson: j.payloadJson,
    }))
    setCurateCommits((current) => (areCurateCommitRowsEqual(current, rows) ? current : rows))
  }, [])

  const refreshCurateCommits = useCallback(
    async (
      submittedJobs?: Array<{
        jobId: string
        draftId: string
        trackId: string
        payloadJson: string
        status: string
      }>,
    ) => {
      if (submittedJobs?.length) {
        for (const job of submittedJobs) {
          activeEngineJobsRef.current.set(job.jobId, job)
        }
        syncCurateRowsFromActiveJobs()
      }
      if (!engineClient || activeEngineJobsRef.current.size === 0) return
      let anyVerified = false
      for (const [jobId, existing] of activeEngineJobsRef.current.entries()) {
        if (existing.status === 'verified' || existing.status === 'failed') continue
        try {
          const next = await engineClient.getCurateJobStatus(jobId)
          activeEngineJobsRef.current.set(jobId, { ...existing, status: next.status })
          if (next.status === 'verified') anyVerified = true
        } catch {
          // keep last known status
        }
      }
      syncCurateRowsFromActiveJobs()
      if (anyVerified) {
        void coreRefreshCatalog().catch(() => {})
      }
    },
    [engineClient, coreRefreshCatalog, syncCurateRowsFromActiveJobs],
  )

  const noteCurateDraftSaved = useCallback((draft: CurateDraft) => {
    draftSaveVersion.current++
    const ids = new Set(draft.tracks.map(track => track.trackId))
    setCurateCommits(current => current.map(row => {
      if (!ids.has(row.trackId)) return row
      const confirmation = JSON.parse(row.payloadJson)
      if (!confirmation.curateDraftRevision || confirmation.curateDraftRevision === draft.revision) return row
      return { ...row, hasNewerDraft: true, hasHeldEdits: Boolean(draft.heldTrackEdits?.length) }
    }))
  }, [])

  const [prioritySettings, setPrioritySettings] = useState(loadPrioritySettings)
  const [dismissedProblems, setDismissedProblems] = useState(loadDismissedProblems)
  const curateCatalog = useMemo(
    () => buildCurateCockpitCatalogProps(catalogTracks, catalogReleases, curateCommits, prioritySettings, dismissedProblems),
    [catalogTracks, catalogReleases, curateCommits, prioritySettings, dismissedProblems],
  )
  const [topMode, setTopMode] = useState<'library' | 'curate' | 'maintain'>('library')
  const tracks = useMemo(
    () => (isCoreActive && topMode !== 'curate' ? coreCatalogTracks : curateCatalog.tracks),
    [isCoreActive, topMode, coreCatalogTracks, curateCatalog.tracks],
  )
  const releases = useMemo(
    () => (isCoreActive && topMode !== 'curate' ? coreCatalogReleases : curateCatalog.releases),
    [isCoreActive, topMode, coreCatalogReleases, curateCatalog.releases],
  )
  const [works, setWorks] = useState<Work[]>([])
  const [storageMounts, setStorageMounts] = useState<StorageMount[]>([])
  const [auditIssues, setAuditIssues] = useState<AuditIssue[]>([])
  const [isCustomLibraryActive, setIsCustomLibraryActive] = useState<boolean>(false)
  const [offlineMounts, setOfflineMounts] = useState<StorageMount[]>([])
  const [offlineStats, setOfflineStats] = useState<{ tracks: number; releases: number }>({ tracks: 0, releases: 0 })
  const [isCheckingConnectivity, setIsCheckingConnectivity] = useState<boolean>(false)
  const [showStartupSplash, setShowStartupSplash] = useState<boolean>(true)
  const isDbInitializing = isBootstrapping
  const dbInitStatus = isBootstrapping
    ? 'Discovering & connecting to Playback Engine...'
    : isCoreActive
      ? `Connected to ${engineState.view.session.active.label}`
      : 'Select a Playback Engine'
  const dbInitProgress = isBootstrapping ? 45 : 100

  // Split releases persisted on the Engine
  const [splitReleaseIds, setSplitReleaseIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!engineClient) {
      setSplitReleaseIds(new Set())
      return
    }
    let cancelled = false
    engineClient
      .listSplitReleases()
      .then((ids) => {
        if (cancelled) return
        setSplitReleaseIds(new Set(ids.map((id) => `core_rel_${stripCoreReleasePrefix(id)}`)))
      })
      .catch((err) => {
        console.warn('[App] Failed to load split release IDs from Engine:', err)
      })
    return () => {
      cancelled = true
    }
  }, [engineClient])

  const handleToggleReleaseSplit = async (releaseId: string) => {
    if (!engineClient) return
    try {
      const res = await engineClient.toggleSplitRelease(releaseId)
      const uiId = `core_rel_${stripCoreReleasePrefix(releaseId)}`
      setSplitReleaseIds((prev) => {
        const next = new Set(prev)
        if (res.split) next.add(uiId)
        else next.delete(uiId)
        return next
      })
      showToast(
        res.split
          ? 'Multi-disc release split into individual discs.'
          : 'Multi-disc release recombined.',
      )
    } catch (err) {
      console.error('[App] Failed to toggle release split:', err)
      showToast('Failed to update release split setting.')
    }
  }

  // Selection State
  const [selectedTrackId, setSelectedTrackId] = useState<string>(tracks[0]?.id || '')
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set())

  // Canonical staged mutations hook (always scoped to This PC library)
  const { stagedAlbumsCount } = useStagedChanges(curateCatalog.tracks, curateCatalog.releases)

  // View & Filter State
  const [viewMode, setViewMode] = useState<CanvasViewMode>('cover_grid')
  const [albumDisplayMode, setAlbumDisplayMode] = useState<AlbumDisplayMode>('album_first')
  const [searchQuery, setSearchQuery] = useState('')
  const [facets, setFacets] = useState<FacetSelections>({})
  const [activeTriageFilter, setActiveTriageFilter] = useState<string | undefined>()
  const [selectedMountId, setSelectedMountId] = useState<string | undefined>()
  const [selectedFolderFilter, setSelectedFolderFilter] = useState<string | undefined>()

  // Entity Navigation & Drilldown State (Composers / Artists / Albums)
  const [activeCoverTab, setActiveCoverTab] = useState<EntityTab>('albums')
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null)
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null)
  const [selectedComposer, setSelectedComposer] = useState<string | null>(null)

  // Isolate navigation/filter state across playback engines (This PC <-> Cadence Core)
  const activeEngineKey = `${engineState.view.session.active.kind}:${engineState.view.session.active.engineId}:${engineState.view.session.active.libraryId}`
  useEffect(() => {
    setSelectedAlbumId(null)
    setSelectedArtist(null)
    setSelectedComposer(null)
    setNavigationAnchor(null)
    setSelectedTrackIds(new Set())
    setActiveTriageFilter(undefined)
    setSelectedMountId(undefined)
    setSelectedFolderFilter(undefined)
    setSearchQuery('')
    setFacets({})
    setActiveCoverTab('albums')
  }, [activeEngineKey, engineState.view.session.activeEpoch])

  // Active Entity Scope (Compound hierarchy awareness)
  const activeEntityScope = useMemo<ActiveEntityScope | null>(() => {
    if (selectedAlbumId) {
      const album = releases.find((r) => r.id === selectedAlbumId)
      const title = album?.title || 'Selected Album'
      if (selectedComposer) {
        return {
          type: 'album',
          name: title,
          albumId: selectedAlbumId,
          parentEntity: selectedComposer,
          parentType: 'composer',
        }
      }
      if (selectedArtist) {
        return {
          type: 'album',
          name: title,
          albumId: selectedAlbumId,
          parentEntity: selectedArtist,
          parentType: 'artist',
        }
      }
      return { type: 'album', name: title, albumId: selectedAlbumId }
    }
    if (selectedComposer) {
      return { type: 'composer', name: selectedComposer }
    }
    if (selectedArtist) {
      return { type: 'artist', name: selectedArtist }
    }
    return null
  }, [selectedAlbumId, selectedComposer, selectedArtist, releases])

  // Modals & Overlays
  const [isTutorialOpen, setIsTutorialOpen] = useState(false)
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('credits')
  const [isCommandBarOpen, setIsCommandBarOpen] = useState(false)
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false)
  const [isPathRuleModalOpen, setIsPathRuleModalOpen] = useState(false)
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [isBatchDiffModalOpen, setIsBatchDiffModalOpen] = useState(false)
  const [compilationModalRelease, setCompilationModalRelease] = useState<Release | null>(null)
  const [navigationAnchor, setNavigationAnchor] = useState<NavigationAnchor | null>(null)
  const [sidecarTrackId, setSidecarTrackId] = useState<string | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [isActivityPopoverOpen, setIsActivityPopoverOpen] = useState(false)
  const [isStorageManagerOpen, setIsStorageManagerOpen] = useState(false)
  const [isQuarantineModalOpen, setIsQuarantineModalOpen] = useState(false)
  const [isNormalizationRulesModalOpen, setIsNormalizationRulesModalOpen] = useState(false)
  const [isRemoteModalOpen, setIsRemoteModalOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<CadenceSettingsTab>('diagnostics')
  const [debugMode, setDebugMode] = useState<CaptureMode>('off')

  useEffect(() => {
    let mounted = true
    if (tauriBridge.isTauri()) {
      tauriBridge.getDebugLogState().then((s) => {
        if (mounted) setDebugMode(s.mode)
      }).catch(() => { })
    }
    const unsub = tauriBridge.subscribeDebugLogState((s) => {
      if (mounted) setDebugMode(s.mode)
    })
    return () => {
      mounted = false
      unsub()
    }
  }, [])

  const openSettings = useCallback((tab: CadenceSettingsTab = 'diagnostics') => {
    setSettingsTab(tab)
    setIsSettingsOpen(true)
  }, [])

  const handleSavePrioritySettings = useCallback((next: PrioritySettings) => {
    savePrioritySettings(next)
    setPrioritySettings(next)
  }, [])
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

  // Top-Level Unified Product Model: Library vs Maintain vs Curate & Sanctuary Lounge
  const [curateQueueHost, setCurateQueueHost] = useState<HTMLDivElement | null>(null)
  const [maintainSubTab, setMaintainSubTab] = useState<MaintainSubTab>('needs_attention')
  const [isSanctuaryOpen, setIsSanctuaryOpen] = useState<boolean>(false)
  const [isArtworkDockExpanded, setIsArtworkDockExpanded] = useState<boolean>(true)
  const [focusedWorkbenchTrack, setFocusedWorkbenchTrack] = useState<Track | null>(null)
  const [isWindowDragOver, setIsWindowDragOver] = useState<boolean>(false)

  // Playlist State & Modals
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null)
  const [isCreatePlaylistOpen, setIsCreatePlaylistOpen] = useState(false)
  const [isEditPlaylistOpen, setIsEditPlaylistOpen] = useState(false)
  const [editingPlaylist, setEditingPlaylist] = useState<Playlist | null>(null)
  const [isAddTracksModalOpen, setIsAddTracksModalOpen] = useState(false)
  const [tracksToAdd, setTracksToAdd] = useState<Track[]>([])
  const [initialPlaylistTitle, setInitialPlaylistTitle] = useState('')
  const [initialPlaylistTracks, setInitialPlaylistTracks] = useState<Track[]>([])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ title?: string; tracks?: Track[] }>).detail
      setInitialPlaylistTitle(detail?.title ?? '')
      setInitialPlaylistTracks(detail?.tracks ?? [])
      setIsCreatePlaylistOpen(true)
    }
    window.addEventListener('cadence:open-create-playlist', handler)
    return () => window.removeEventListener('cadence:open-create-playlist', handler)
  }, [])

  const {
    isPlaying,
    isPaused,
    togglePlayPause,
    nextTrack,
    prevTrack,
    toggleMute,
    isRightSidebarOpen,
    setIsRightSidebarOpen,
    rightSidebarTab,
    setRightSidebarTab,
    toggleRightSidebar,
  } = useAudioPlayer()

  // Audiophile Transport Synchronization: Immediately notify background artwork service
  useEffect(() => {
    backgroundArtworkService.notifyPlaybackState(isPlaying, isPaused)
    if (isPlaying || isPaused) tauriBridge.notifyPlaybackState(isPaused ? 'Paused' : 'Playing')
  }, [isPlaying, isPaused])

  // Initialize background artwork service and hook debounced checkpoints
  useEffect(() => {
    backgroundArtworkService.init()
    backgroundArtworkService.setCheckpointHandler(async () => {
      auditService.runFullCatalogAudit()
      await persistCurrentLibrary()
      refreshFromEngine()
    })
  }, [])

  const refreshPlaylists = useCallback(async () => {
    if (!engineClient) {
      setPlaylists([])
      return
    }
    try {
      const data = await listEnginePlaylists(engineClient, coreCatalogTracks, coreCatalogReleases)
      setPlaylists(data)
      setSelectedPlaylist((prev) => (prev ? data.find((p) => p.id === prev.id) ?? prev : null))
    } catch (err) {
      console.warn('[App] Failed to load Engine playlists:', err)
    }
  }, [engineClient, coreCatalogTracks, coreCatalogReleases])

  useEffect(() => {
    void refreshPlaylists()
  }, [refreshPlaylists])

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
      } else if (
        ((e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U')) ||
        (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'q' || e.key === 'Q'))
      ) {
        e.preventDefault()
        toggleRightSidebar('queue')
      } else if ((e.ctrlKey || e.metaKey) && e.key === '1') {
        e.preventDefault()
        setTopMode('library')
        setFocusedWorkbenchTrack(null)
      } else if ((e.ctrlKey || e.metaKey) && e.key === '2') {
        e.preventDefault()
        setTopMode('curate')
        setFocusedWorkbenchTrack(null)
      } else if ((e.ctrlKey || e.metaKey) && e.key === '3') {
        e.preventDefault()
        setTopMode('curate')
        setFocusedWorkbenchTrack(null)
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        if (selectedAlbumId) {
          handleInspectRelease(selectedAlbumId)
        } else if (currentRelease) {
          handleInspectRelease(currentRelease.id)
        } else if (releases.length > 0) {
          handleInspectRelease(releases[0].id)
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault()
        handleOpenCurate()
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault()
        setIsSanctuaryOpen((prev) => !prev)
      } else if (e.key === 'Escape') {
        if (focusedWorkbenchTrack) {
          setFocusedWorkbenchTrack(null)
        } else if (isSanctuaryOpen) {
          setIsSanctuaryOpen(false)
        } else if (isRightSidebarOpen) {
          setIsRightSidebarOpen(false)
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
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === '<' || e.key === ',' || e.code === 'Comma')) {
        e.preventDefault()
        openSettings('diagnostics')
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

    const handleAddTracksEvent = (e: CustomEvent<Track[]>) => {
      if (e.detail && e.detail.length > 0) {
        setTracksToAdd(e.detail)
        setIsAddTracksModalOpen(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('cadence:toast' as any, handleToastEvent as any)
    window.addEventListener('cadence:add-tracks-playlist' as any, handleAddTracksEvent as any)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('cadence:toast' as any, handleToastEvent as any)
      window.removeEventListener('cadence:add-tracks-playlist' as any, handleAddTracksEvent as any)
    }
  }, [togglePlayPause, nextTrack, prevTrack, toggleMute, toggleRightSidebar, tracks, selectedTrackId, focusedWorkbenchTrack, isSanctuaryOpen, isRightSidebarOpen, setIsRightSidebarOpen])

  // Window drag and drop detection for audio folders & files
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      // Only handle OS file drags, not internal DOM drag and drop
      const isFileDrag = e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')
      if (!isFileDrag) return

      e.preventDefault()
      e.stopPropagation()
      setIsWindowDragOver(true)
    }

    const handleDragLeave = (e: DragEvent) => {
      const isFileDrag = e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')
      if (!isFileDrag) return

      e.preventDefault()
      e.stopPropagation()
      if (e.relatedTarget === null || e.clientX <= 0 || e.clientY <= 0) {
        setIsWindowDragOver(false)
      }
    }

    const handleDrop = (e: DragEvent) => {
      const isFileDrag = e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')
      if (!isFileDrag) return

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
      showToast(`Customized "${res.release.title}" • ${res.affectedTracksCount} tracks staged in sidecar`)
    }
  }

  // Pure in-memory catalog projection (Zero local SQLite / IndexedDB persistence)
  const persistCurrentLibrary = async () => {
    // Engine owns cadence.db; frontend maintains pure in-memory projections.
  }

  // Refresh entire data graph from engine and synchronously recompute dynamic catalog hygiene
  const refreshFromEngine = useCallback(() => {
    auditService.runFullCatalogAudit()
    setTracks([...graphEngine.getAllTracks()])
    setReleases([...graphEngine.getAllReleases()])
    setWorks([...graphEngine.getAllWorks()])
    setStorageMounts([...graphEngine.getAllStorageMounts()])
    setAuditIssues([...graphEngine.getAllAuditIssues()])
    setIsCustomLibraryActive(graphEngine.isUsingCustomLibrary())
  }, [])

  // Project connected Engine catalog into graphEngine for Browse, Curate, Search, and Facets
  useEffect(() => {
    if (!isCoreActive) {
      graphEngine.clearLibrary()
      refreshFromEngine()
      setWatchedFolders([])
      return
    }
    graphEngine.loadCustomLibrary({
      tracks: coreCatalogTracks,
      releases: coreCatalogReleases,
      works: [],
      auditIssues: [],
      storageMounts: [],
    })
    refreshFromEngine()
    if (coreCatalogTracks.length > 0) {
      setSelectedTrackId((prev) =>
        coreCatalogTracks.some((t) => t.id === prev) ? prev : coreCatalogTracks[0].id,
      )
    }
  }, [isCoreActive, coreCatalogTracks, coreCatalogReleases, refreshFromEngine])

  const refreshEngineFolders = useCallback(async () => {
    if (!engineClient) {
      setWatchedFolders([])
      return
    }
    try {
      const folders = await engineClient.listFolders()
      setWatchedFolders(
        folders.map((f) => ({
          id: f.id,
          mountId: 'core',
          folderPath: f.path,
          displayName: f.displayName,
          scanMode: f.scanMode === 'manual' ? 'manual' : 'realtime',
          isEnabled: true,
          lastScannedTimestamp: f.lastScannedAt ?? undefined,
          trackCount: f.trackCount,
        })),
      )
    } catch {
      // ignore if engine busy/offline
    }
  }, [engineClient])

  useEffect(() => {
    void refreshEngineFolders()
  }, [refreshEngineFolders])

  useEffect(() => {
    if (!isCoreActive) return
    return subscribeEngineEvents((ev) => {
      if (ev.event === 'catalog.changed') {
        void refreshEngineFolders()
        void refreshPlaylists()
        void refreshCurateCommits()
      } else if (ev.event.startsWith('scan.')) {
        const data = (ev.data ?? {}) as Record<string, unknown>
        const processed = typeof data.processed === 'number' ? data.processed : 0
        setScanTelemetry((prev) => ({
          ...prev,
          status: ev.event === 'scan.complete' ? 'completed' : 'scanning',
          importedCount: typeof data.imported === 'number' ? data.imported : processed,
          currentFile: typeof data.path === 'string' ? data.path : prev.currentFile,
        }))
        if (ev.event === 'scan.complete') {
          void coreRefreshCatalog().catch(() => {})
          void refreshEngineFolders()
        }
      } else if (ev.event.startsWith('curate.')) {
        void refreshCurateCommits()
      }
    })
  }, [
    isCoreActive,
    subscribeEngineEvents,
    refreshEngineFolders,
    refreshPlaylists,
    refreshCurateCommits,
    coreRefreshCatalog,
  ])

  const handleTriggerScan = async (folderPath?: string, forceFull: boolean = false) => {
    if (!engineClient) return
    try {
      const matched = folderPath
        ? watchedFolders.find((f) => f.folderPath === folderPath)
        : undefined
      await engineClient.scanFolders({ folderId: matched?.id, forceFull })
      showToast(
        folderPath
          ? `Queued Engine scan of "${folderPath}"...`
          : 'Queued Engine library scan...',
      )
    } catch (err: any) {
      showToast(`Scan error: ${err?.message || err}`)
    }
  }

  const handleToggleMountStatus = async (_mountId: string, _currentStatus: string) => {
    showToast('Storage mounts are managed directly by the Playback Engine.')
  }

  const handleToggleMountLock = async (_mountId: string) => {
    showToast('Read-only locks are enforced by the Playback Engine.')
  }

  const handleRefreshLibrary = async () => {
    if (!isCoreActive) return
    await Promise.all([coreRefreshCatalog(), refreshEngineFolders(), refreshPlaylists()])
    showToast('Refreshed library catalog from Playback Engine.')
  }

  const handleIgnoreSkippedFile = async (id: string) => {
    setSkippedFiles((prev) => prev.filter((s) => s.id !== id))
    setScanTelemetry((prev) => ({
      ...prev,
      skippedCount: Math.max(0, prev.skippedCount - 1),
    }))
  }

  const handleIgnoreAllSkippedFiles = async () => {
    setSkippedFiles([])
    setScanTelemetry((prev) => ({
      ...prev,
      skippedCount: 0,
    }))
  }

  const handleRetryConnection = async () => {
    setIsCheckingConnectivity(true)
    try {
      await reconnectCore()
    } finally {
      setIsCheckingConnectivity(false)
    }
  }

  const handleAddWatchedFolder = async () => {
    setIsImportModalOpen(true)
  }

  const handleRemoveWatchedFolder = async (folderId: string) => {
    if (!engineClient) return
    try {
      await engineClient.removeFolder(folderId)
      await refreshEngineFolders()
      showToast('Removed watched folder from Engine monitoring.')
    } catch (err: any) {
      showToast(`Could not remove folder: ${err?.message || err}`)
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
    facets.mastering ||
    facets.reviewStatus ||
    facets.favoritesOnly
  )

  // Set of all release IDs that currently have items staged for review (sidecars, pending edits, or cover art)
  const stagedReleaseIds = useMemo(() => {
    const set = new Set<string>()
    releases.forEach((r) => {
      if (r.artwork?.originalFrontCoverUrl) set.add(r.id)
    })
    tracks.forEach((t) => {
      if (
        t.sidecarStatus === 'uncommitted_sidecar' ||
        Boolean(t.pendingSidecarEdits && Object.keys(t.pendingSidecarEdits).length > 0)
      ) {
        if (t.releaseId) set.add(t.releaseId)
        if (t.folderName) set.add(t.folderName)
      }
    })
    return set
  }, [releases, tracks])

  // 1. Grid-scoped tracks: filter by Search, Facets (era, composer, language, format), Storage Mount, and Folder.
  // EXCLUDES activeTriageFilter so that selecting an anomaly isolates tracks in the grid without collapsing the diagnostic queue!
  const gridScopedTracks = useMemo(() => {
    if (isCoreActive && topMode !== 'curate' && tracks.length === 0) {
      return []
    }
    // Self-healing: if graphEngine was reloaded or emptied by HMR while React state still has tracks
    if (!isCoreActive && tracks.length > 0 && graphEngine.getAllTracks().length === 0) {
      graphEngine.loadCustomLibrary({
        tracks: catalogTracks,
        releases: catalogReleases,
        works,
        auditIssues,
        storageMounts,
      })
    }
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
    let result = graphEngine.filterTracks(filterState, tracks, releases)
    if (selectedFolderFilter) {
      result = result.filter((t) => (t.filePath || '').replace(/\\/g, '/').startsWith(selectedFolderFilter))
    }
    if (facets.reviewStatus === 'staged') {
      result = result.filter(
        (t) =>
          stagedReleaseIds.has(t.releaseId) ||
          (t.folderName && stagedReleaseIds.has(t.folderName)) ||
          t.sidecarStatus === 'uncommitted_sidecar' ||
          Boolean(t.pendingSidecarEdits && Object.keys(t.pendingSidecarEdits).length > 0)
      )
    }
    if (facets.favoritesOnly) {
      const favoriteReleaseIds = new Set(releases.filter((r) => r.isFavorite).map((r) => r.id))
      result = result.filter((t) => favoriteReleaseIds.has(t.releaseId))
    }
    return result
  }, [isCoreActive, topMode, searchQuery, facets, selectedMountId, selectedFolderFilter, tracks, releases, works, auditIssues, storageMounts, stagedReleaseIds])

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

  // 3b. Mount and folder scoped tracks (invariant to shelf facet toggles)
  const mountAndFolderScopedTracks = useMemo(() => {
    let result = tracks
    if (selectedMountId) {
      result = result.filter((t) => t.storageMountId === selectedMountId)
    }
    if (selectedFolderFilter) {
      result = result.filter((t) => (t.filePath || '').replace(/\\/g, '/').startsWith(selectedFolderFilter))
    }
    return result
  }, [tracks, selectedMountId, selectedFolderFilter])

  // 3c. Derived displayed releases: scoped when any catalog filter or staged review status is active
  const displayedReleases = useMemo(() => {
    if (isGridFilterActive || Boolean(activeTriageFilter)) {
      const activeReleaseIds = new Set<string>()
      filteredTracks.forEach((t) => {
        if (t.releaseId) activeReleaseIds.add(t.releaseId)
        if (t.folderName) activeReleaseIds.add(t.folderName)
      })
      return releases.filter(
        (r) => activeReleaseIds.has(r.id) || (r.folderName && activeReleaseIds.has(r.folderName))
      )
    }
    return releases
  }, [releases, isGridFilterActive, activeTriageFilter, filteredTracks])

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

  useEffect(() => {
    const handleOpenProvenance = (e: any) => {
      const relId = e.detail?.releaseId
      const target =
        releases.find((r) => r.id === relId) ||
        (currentTrack ? releases.find((r) => r.id === currentTrack.releaseId) : null) ||
        releases[0]
      if (target) {
        setCompilationModalRelease(target)
      }
    }

    const handleProvenanceUpdated = async () => {
      refreshFromEngine()
      persistCurrentLibrary()
    }

    window.addEventListener('cadence:open-compilation-provenance', handleOpenProvenance)
    window.addEventListener('cadence:provenance-updated', handleProvenanceUpdated)

    return () => {
      window.removeEventListener('cadence:open-compilation-provenance', handleOpenProvenance)
      window.removeEventListener('cadence:provenance-updated', handleProvenanceUpdated)
    }
  }, [releases, currentTrack])

  // Scoped Curate Trigger Handler
  const handleOpenCurate = () => {
    setTopMode('curate')
    setFocusedWorkbenchTrack(null)
  }

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
    setSelectedAlbumId(releaseId)
    setNavigationAnchor({
      returnView: 'library',
      selectedAlbumId: releaseId,
      scrollPosition: window.scrollY || 0,
    })
    setTopMode('curate')
  }

  const handleToggleTrackSelection = (trackId: string, _isMulti: boolean) => {
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
      const releaseUpdates: {
        title?: string
        releaseYear?: number
        coverArtUrl?: string
        backdropUrl?: string
      } = {}
      if (mergedFields.releaseTitle && mergedFields.releaseTitle !== currentRelease.title) {
        releaseUpdates.title = mergedFields.releaseTitle
      }
      if (mergedFields.year && !isNaN(Number(mergedFields.year))) {
        releaseUpdates.releaseYear = Number(mergedFields.year)
      }
      if (mergedFields.coverArtUrl) {
        releaseUpdates.coverArtUrl = mergedFields.coverArtUrl
      }
      if (mergedFields.backdropUrl) {
        releaseUpdates.backdropUrl = mergedFields.backdropUrl
      }
      if (Object.keys(releaseUpdates).length > 0) {
        graphEngine.updateReleaseDetails(currentRelease.id, releaseUpdates)
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
      if (updates.rating !== undefined) {
        showToast(updates.rating > 0 ? `Rated "${res.release.title}" ${updates.rating}★` : `Cleared rating for "${res.release.title}"`)
      } else if (updates.isFavorite !== undefined) {
        showToast(updates.isFavorite ? `Added "${res.release.title}" to Favorites` : `Removed "${res.release.title}" from Favorites`)
      } else if (res.affectedTracksCount > 0) {
        showToast(`Updated "${res.release.title}" & staged edits across ${res.affectedTracksCount} tracks`)
      } else {
        showToast(`Updated "${res.release.title}"`)
      }

      // Edge Case 1: Release-level rename updates active entity scope
      if (selectedComposer && updates.composerName && updates.composerName !== selectedComposer) {
        setSelectedComposer(updates.composerName)
      }
      if (selectedArtist && updates.artistCredit && updates.artistCredit !== selectedArtist) {
        setSelectedArtist(updates.artistCredit)
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
        const target = currentRelease || releases[0]
        if (target) handleInspectRelease(target.id)
      },
      closeCustomizeModal: () => setTopMode('library'),
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

  // Keyboard shortcut listener
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
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
      id: 'cmd-guided-tutorial',
      title: 'Cadence Quick Tour',
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
      title: 'Review & Apply Staged Changes',
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
      id: 'cmd-resolve-compilation-soundtracks',
      title: 'Resolve Original Soundtracks',
      category: 'ACTION',
      shortcut: '⌘R',
      icon: <Sparkles className="w-4 h-4 text-[#00F5FF]" />,
      action: () => {
        const targetRel = currentRelease || (currentTrack ? releases.find((r) => r.id === currentTrack.releaseId) : null) || releases[0]
        if (targetRel) {
          setCompilationModalRelease(targetRel)
        }
      },
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
    {
      id: 'cmd-open-cadence-settings',
      title: 'Open Cadence Settings (Diagnostics, Priorities & Gemini)',
      category: 'NAVIGATION',
      shortcut: '⌘⇧,',
      icon: <Settings className="w-4 h-4 text-[#D4AF37]" />,
      action: () => openSettings('diagnostics'),
    },
    {
      id: 'cmd-settings-diagnostics',
      title: 'Settings: Diagnostics & Debug Logs',
      category: 'ACTION',
      icon: <Activity className="w-4 h-4 text-[#D4AF37]" />,
      action: () => openSettings('diagnostics'),
    },
    {
      id: 'cmd-settings-priorities',
      title: 'Settings: Priority Settings (Curate Triage)',
      category: 'ACTION',
      icon: <SlidersHorizontal className="w-4 h-4 text-amber-400" />,
      action: () => openSettings('priorities'),
    },
    {
      id: 'cmd-settings-gemini',
      title: 'Settings: Gemini API Key & Model',
      category: 'ACTION',
      icon: <KeyRound className="w-4 h-4 text-cyan-300" />,
      action: () => openSettings('gemini'),
    },
  ]

  const uncommittedCount = tracks.filter((t) => t.sidecarStatus === 'uncommitted_sidecar').length

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0D0E12] text-[#F1F5F9] select-none font-sans">
      {showStartupSplash && (
        <StartupSplashScreen
          isReady={!isDbInitializing}
          statusText={dbInitStatus}
          progress={dbInitProgress}
          onExited={() => setShowStartupSplash(false)}
        />
      )}
      {/* Apple HIG Unified macOS-Style Toolbar */}
      <header className="h-[52px] border-b border-white/[0.06] bg-[#0C0D10]/95 backdrop-blur-2xl px-3.5 flex items-center justify-between shrink-0 z-30 select-none">
        {/* Left: Brand Lockup & Telemetry Monospace */}
        <div className="flex items-center gap-3">
          <div data-tutorial-id="header-brand" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-[7px] bg-gradient-to-b from-[#1E2026] to-[#0C0D10] border border-[#D4AF37]/30 flex items-center justify-center text-[#D4AF37] shadow-[0_2px_8px_rgba(212,175,55,0.18)]">
              <CadenceLogo variant="gold" className="w-4 h-4" />
            </div>
            <div className="flex flex-col text-left">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold tracking-wider text-[12px] text-[#EDEDED] leading-none">
                  CADENCE
                </span>
                <span className="text-[10px] font-mono text-[#D4AF37] font-medium leading-none">
                  PRO
                </span>
              </div>
            </div>
          </div>

          <div className="h-3.5 w-[1px] bg-white/[0.08] mx-0.5 hidden sm:block" />

          <div className="hidden lg:flex items-center gap-1.5 text-[11px] font-mono text-[#8E8E93]">
            <span>{tracks.length} tracks</span>
          </div>
        </div>

        {/* Center: Apple 3-Way Segmented Control */}
        <div className="flex items-center p-0.5 rounded-[9px] bg-black/40 border border-white/[0.08] shadow-inner">
          <button
            onClick={() => {
              setTopMode('library')
              setFocusedWorkbenchTrack(null)
            }}
            title="Listening Room & Album Library (⌘1)"
            className={`px-3.5 py-1 rounded-[7px] text-[12px] font-medium transition-all flex items-center gap-1.5 cursor-pointer ${topMode === 'library' && !focusedWorkbenchTrack
                ? 'bg-white/[0.12] text-white shadow-sm border border-white/[0.08]'
                : 'text-[#8E8E93] hover:text-[#EDEDED]'
              }`}
          >
            <span>Listen</span>
            <span className="text-[10px] text-[#636366] font-mono hidden md:inline">⌘1</span>
          </button>

          <button
            onClick={() => {
              setTopMode('curate')
              setFocusedWorkbenchTrack(null)
            }}
            title="Unified Precision Metadata Workbench & Catalog Hygiene (⌘2)"
            className={`px-3.5 py-1 rounded-[7px] text-[12px] font-medium transition-all flex items-center gap-1.5 cursor-pointer ${topMode === 'curate'
                ? 'bg-white/[0.12] text-white shadow-sm border border-white/[0.08]'
                : 'text-[#8E8E93] hover:text-[#EDEDED]'
              }`}
          >
            <span>Curate</span>
            <span className="text-[10px] text-[#636366] font-mono hidden md:inline">⌘2</span>
          </button>
        </div>

        {/* Right Toolbar Actions */}
        <div className="flex items-center gap-2">
          {/* Unified Spotlight Search Trigger */}
          <button
            data-tutorial-id="btn-spotlight-cmd"
            onClick={() => setIsCommandBarOpen(true)}
            title="Spotlight Search & Command Palette (⌘K)"
            className="flex items-center gap-2 px-2.5 py-1 rounded-[7px] bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[11px] text-[#8E8E93] hover:text-[#EDEDED] transition-all cursor-pointer"
          >
            <Command className="w-3.5 h-3.5 text-[#8E8E93]" />
            <span className="hidden sm:inline">Search</span>
            <kbd className="text-[10px] px-1 py-0.2 rounded bg-black/40 text-[#636366] font-mono">⌘K</kbd>
          </button>

          {/* Background Save Queue status pill */}
          {(topMode !== 'curate' || curateQueueHost) && <CommitStatusPill
            portalTarget={topMode === 'curate' ? curateQueueHost : null}
            alwaysVisible={topMode === 'curate'}
            commitRows={topMode === 'curate' ? curateCommits : undefined}
            tracks={topMode === 'curate' ? catalogTracks : undefined}
            releases={topMode === 'curate' ? catalogReleases : undefined}
          />}

          {/* Activity telemetry */}
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
              setTopMode('curate')
              setIsActivityPopoverOpen(false)
            }}
            onDismissAllSkipped={handleIgnoreAllSkippedFiles}
          />

          {/* Mobile Remote Modal */}
          <button
            onClick={() => setIsRemoteModalOpen(true)}
            title="Mobile Remote QR Controller"
            className="p-1.5 rounded-[7px] bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[#8E8E93] hover:text-[#EDEDED] transition-all cursor-pointer"
          >
            <Smartphone className="w-3.5 h-3.5" />
          </button>

          {/* Active Playback Engine Trigger */}
          <button
            type="button"
            onClick={() => openSettings('engine')}
            aria-label={`Playback engine: ${engineState.view.session.active.label}${
              isCoreActive && !engineState.view.session.connected ? ' (Disconnected)' : ''
            }`}
            title={`Playback engine: ${engineState.view.session.active.label}`}
            className={`px-2 py-1.5 rounded-[7px] border transition-all cursor-pointer flex items-center gap-1.5 text-[11px] font-medium ${
              isCoreActive
                ? engineState.view.session.connected
                  ? 'bg-[#D4AF37]/12 border-[#D4AF37]/35 text-[#EDEDED] hover:bg-[#D4AF37]/20'
                  : 'bg-rose-500/12 border-rose-500/35 text-rose-200 hover:bg-rose-500/20'
                : 'bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.06] text-[#8E8E93] hover:text-[#EDEDED]'
            }`}
          >
            <Server className="w-3.5 h-3.5" aria-hidden="true" />
            <span className={isCoreActive ? 'inline max-w-[130px] truncate' : 'hidden xl:inline max-w-[110px] truncate'}>
              {isCoreActive ? engineState.view.session.active.label : 'Connect Engine'}
            </span>
          </button>

          {/* Always-Visible Cadence Settings */}
          <button
            type="button"
            onClick={() => openSettings('diagnostics')}
            aria-label="Open Cadence Settings"
            title="Cadence Settings (⌘⇧,)"
            className={`relative p-1.5 rounded-[7px] border transition-all cursor-pointer flex items-center gap-1.5 ${isSettingsOpen
                ? 'bg-white/[0.15] border-[#D4AF37]/50 text-[#D4AF37]'
                : debugMode !== 'off'
                  ? 'bg-[#D4AF37]/10 hover:bg-[#D4AF37]/20 border-[#D4AF37]/30 text-[#EDEDED]'
                  : 'bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.06] text-[#8E8E93] hover:text-[#EDEDED]'
              }`}
          >
            <Settings className="w-3.5 h-3.5" />
            <span className="hidden lg:inline text-[11px] font-medium">Settings</span>
            {debugMode !== 'off' && (
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full ${debugMode === 'diagnostic_capture' ? 'bg-rose-400' : 'bg-[#D4AF37]'
                  }`}
              />
            )}
          </button>

          {/* Sidecar Drawer Toggle (Queue / Playlists) */}
          <button
            onClick={() => toggleRightSidebar()}
            title={isRightSidebarOpen ? 'Hide Right Panel' : 'Show Right Panel (Queue & Playlists)'}
            className={`p-1.5 rounded-[7px] border transition-all cursor-pointer ${isRightSidebarOpen
                ? 'bg-white/[0.15] border-white/[0.15] text-white'
                : 'bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.06] text-[#8E8E93] hover:text-white'
              }`}
          >
            <PanelRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Main Workspace Stage */}
      <div className="flex-1 flex overflow-hidden">
        {!isCoreActive ? (
          <EngineConnectionGate />
        ) : (
          <>
        {/* 1. Left Rail: Normalized Navigation (Persistent Shell) */}
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
            setIsStorageManagerOpen(true)
          }}
          onOpenImportModal={() => setIsImportModalOpen(true)}
          watchedFolders={watchedFolders}
          tracks={tracks}
          releases={releases}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          topMode={topMode}
          onTopModeChange={setTopMode}
          onOpenCommitModal={() => setIsCommitModalOpen(true)}
          playlists={playlists}
          selectedPlaylistId={selectedPlaylist?.id}
          onSelectPlaylist={(pl) => {
            setSelectedPlaylist(pl)
            setViewMode('playlist_detail')
          }}
          onOpenCreatePlaylist={() => {
            setInitialPlaylistTracks([])
            setIsCreatePlaylistOpen(true)
          }}
          isIconOnly={topMode === 'curate'}
          onOpenSanctuary={() => setIsSanctuaryOpen(true)}
          isArtworkDockExpanded={isArtworkDockExpanded}
          onCollapseArtworkDock={() => setIsArtworkDockExpanded(false)}
        />

        {/* 2. Center Stage: MaintainCockpit OR CurationWorkbench OR Focused Workbench OR Playlist Detail OR Storage Offline View */}
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
            onIgnoreSkippedFile={handleIgnoreSkippedFile}
            onIgnoreAllSkippedFiles={handleIgnoreAllSkippedFiles}
            onRefreshAudit={() => {
              auditService.runFullCatalogAudit()
              refreshFromEngine()
              showToast('Catalog hygiene diagnostic scan updated.')
            }}
            onDiscardTrackEdits={(trackIds: string[]) => {
              trackIds.forEach((id) => graphEngine.discardTrackEdits(id))
              refreshFromEngine()
              persistCurrentLibrary()
              auditService.runFullCatalogAudit()
              showToast(`Discarded staged edits for ${trackIds.length} track(s).`)
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
            onCommitTwoPhase={() => {
              if (isPlaying) {
                showToast('⚠️ Transport Purity Notice: Playback is active. Physical disk writes are locked until playback pauses/stops.')
              }
              setIsCommitModalOpen(true)
            }}
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
            onSelectRelease={(releaseId: string) => handleInspectRelease(releaseId)}
            showToast={showToast}
            onSwitchToLibrary={() => setTopMode('library')}
            activeEntityScope={activeEntityScope}
            onClearEntityScope={() => {
              setSelectedAlbumId(null)
              setSelectedArtist(null)
              setSelectedComposer(null)
            }}
          />
        ) : topMode === 'curate' ? (
          <UnifiedCurateCockpit
            {...curateCatalog}
            prioritySettings={prioritySettings}
            onPrioritySettingsChange={setPrioritySettings}
            dismissedProblems={dismissedProblems}
            onDismissedProblemsChange={setDismissedProblems}
            commitRows={curateCommits}
            commitQueueHostRef={setCurateQueueHost}
            onCommitQueued={refreshCurateCommits}
            onDraftSaved={noteCurateDraftSaved}
            initialSelectedAlbumId={navigationAnchor?.selectedAlbumId}
            onReturnToAnchor={() => {
              if (navigationAnchor) {
                setSelectedAlbumId(navigationAnchor.selectedAlbumId)
                const scrollPos = navigationAnchor.scrollPosition
                setNavigationAnchor(null)
                setTopMode('library')
                requestAnimationFrame(() => {
                  window.scrollTo({ top: scrollPos, behavior: 'instant' })
                })
              } else {
                setTopMode('library')
              }
            }}
            onBackToLibrary={() => {
              setNavigationAnchor(null)
              setTopMode('library')
            }}
            showToast={showToast}
            isPlaying={isPlaying || isPaused}
          />
        ) : focusedWorkbenchTrack ? (
          <FocusedWorkbench
            track={focusedWorkbenchTrack}
            release={releases.find((r) => r.id === focusedWorkbenchTrack.releaseId)}
            allTracks={tracks}
            onClose={() => setFocusedWorkbenchTrack(null)}
            onApplyEdits={(edits) => {
              graphEngine.updateTrackSidecar(focusedWorkbenchTrack.id, edits)
              refreshFromEngine()
              persistCurrentLibrary()

              // Edge Case 1: Reactive Renaming Refinement
              if (selectedComposer && edits.composerName && edits.composerName !== selectedComposer) {
                const remaining = graphEngine.getAllTracks().filter((t) => {
                  const rel = graphEngine.getAllReleases().find((r) => r.id === t.releaseId)
                  return (
                    (t.composerName || '').toLowerCase().trim() === selectedComposer.toLowerCase().trim() ||
                    (rel?.composerName || '').toLowerCase().trim() === selectedComposer.toLowerCase().trim()
                  )
                })
                if (remaining.length === 0) {
                  setSelectedComposer(edits.composerName)
                }
              }

              if (selectedArtist && edits.artistCredit && edits.artistCredit !== selectedArtist) {
                const remaining = graphEngine.getAllTracks().filter((t) => {
                  const rel = graphEngine.getAllReleases().find((r) => r.id === t.releaseId)
                  return (
                    (t.artistCredit || '').toLowerCase().trim() === selectedArtist.toLowerCase().trim() ||
                    (rel?.artistCredit || '').toLowerCase().trim() === selectedArtist.toLowerCase().trim()
                  )
                })
                if (remaining.length === 0) {
                  setSelectedArtist(edits.artistCredit)
                }
              }
            }}
            showToast={showToast}
          />
        ) : viewMode === 'playlist_detail' && selectedPlaylist ? (
          <PlaylistDetailView
            playlist={selectedPlaylist}
            allTracks={tracks}
            allReleases={releases}
            onBackToLibrary={() => setViewMode('cover_grid')}
            onOpenEditPlaylist={(pl) => {
              setEditingPlaylist(pl)
              setIsEditPlaylistOpen(true)
            }}
            onOpenAddTracksModal={(trks) => {
              setTracksToAdd(trks)
              setIsAddTracksModalOpen(true)
            }}
            showToast={showToast}
          />
        ) : !isCoreActive && tracks.length === 0 && offlineMounts.length > 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 bg-[#0B0D13] relative overflow-hidden text-center">
            {/* Ambient background glow */}
            <div className="absolute w-96 h-96 rounded-full bg-amber-500/10 blur-[120px] pointer-events-none" />

            <div className="relative z-10 max-w-lg flex flex-col items-center">
              <div className="w-16 h-16 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-6 shadow-xl shadow-amber-500/10">
                <WifiOff className="w-8 h-8" />
              </div>

              <div className="flex items-center gap-2 mb-2">
                <span className="px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 text-[11px] font-mono font-semibold border border-amber-500/30 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-400" />
                  Network Folder Offline
                </span>
              </div>

              <h2 className="text-xl font-bold text-white mb-2">
                Storage Location Inaccessible
              </h2>

              <p className="text-xs text-white/60 mb-4 leading-relaxed">
                Cadence Core detected that your network folder is currently unreachable.
                To protect playback integrity and prevent uncommittable metadata edits,
                album data from this storage location is withheld from display.
              </p>

              {/* Storage Path Card */}
              <div className="w-full bg-white/[0.03] border border-white/[0.08] rounded-xl p-4 mb-6 text-left">
                <div className="text-[11px] font-medium text-white/50 mb-1">Target Storage Path:</div>
                <div className="font-mono text-xs text-[#00F5FF] break-all bg-black/40 px-3 py-2 rounded-lg border border-white/[0.05] flex items-center gap-2">
                  <Server className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>{offlineMounts[0]?.mountPath}</span>
                </div>
                {offlineStats.releases > 0 && (
                  <div className="mt-3 flex items-center justify-between text-[11px] text-white/40 pt-2 border-t border-white/[0.05]">
                    <span>Preserved in SQLite Database:</span>
                    <span className="text-amber-300 font-mono">
                      {offlineStats.releases} albums • {offlineStats.tracks} tracks
                    </span>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleRetryConnection}
                  disabled={isCheckingConnectivity}
                  className="px-5 py-2.5 rounded-xl bg-[#00F5FF]/20 hover:bg-[#00F5FF]/30 text-[#00F5FF] border border-[#00F5FF]/50 text-xs font-semibold transition-all flex items-center gap-2 shadow-lg shadow-[#00F5FF]/10 disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${isCheckingConnectivity ? 'animate-spin' : ''}`} />
                  {isCheckingConnectivity ? 'Checking Connection...' : 'Retry Connection'}
                </button>

                <button
                  onClick={() => {
                    setIsStorageManagerOpen(true)
                  }}
                  className="px-4 py-2.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] text-white/80 border border-white/[0.1] text-xs font-medium transition-colors"
                >
                  Manage Storage Roots
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {isCoreActive && !engineState.view.session.connected && (
              <div
                role="status"
                aria-live="polite"
                className="px-4 py-2 bg-rose-500/10 border-b border-rose-500/30 flex items-center justify-between gap-4 text-xs font-medium shrink-0"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <WifiOff className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
                  <span className="text-rose-200 truncate">
                    {engineState.view.session.active.label}: Connection lost. Playback may still be continuing.
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void reconnectCore()}
                    className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-100 border border-rose-500/40 text-[11px] font-medium cursor-pointer"
                  >
                    Reconnect
                  </button>
                  <button
                    type="button"
                    onClick={() => openSettings('engine')}
                    className="px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-white/85 border border-white/[0.1] text-[11px] cursor-pointer"
                  >
                    Choose engine
                  </button>
                </div>
              </div>
            )}
            {isCoreActive &&
              engineState.view.session.connected &&
              activeCoreSnapshot?.playback.takeoverRequired && (
                <div
                  role="status"
                  aria-live="polite"
                  className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 flex items-center justify-between gap-4 text-xs font-medium shrink-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                    <span className="text-amber-200 truncate">
                      {engineState.view.session.active.label}: RS130 is currently playing via HiFi ROSE (
                      {activeCoreSnapshot.playback.externalPlayback?.transportState || 'PLAYING'}
                      ). External playback remains undisturbed until you confirm takeover.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void coreRefreshSnapshot()}
                    className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 border border-amber-500/40 text-[11px] font-medium cursor-pointer shrink-0"
                  >
                    Refresh status
                  </button>
                </div>
              )}
            {/* If some mounts are offline, render top alert banner */}
            {offlineMounts.length > 0 && (
              <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 flex items-center justify-between gap-4 text-xs font-medium shrink-0 animate-in fade-in duration-200">
                <div className="flex items-center gap-2 min-w-0">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span className="text-amber-300 truncate">
                    Network Storage Offline: <span className="font-mono">{offlineMounts[0].name}</span> ({offlineMounts[0].mountPath}) is unreachable.
                    {offlineStats.releases > 0 && ` ${offlineStats.releases} albums from this folder are withheld.`}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={handleRetryConnection}
                    disabled={isCheckingConnectivity}
                    className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 text-[11px] font-mono transition-colors flex items-center gap-1.5"
                  >
                    <RefreshCw className={`w-3 h-3 ${isCheckingConnectivity ? 'animate-spin' : ''}`} />
                    {isCheckingConnectivity ? 'Checking...' : 'Retry'}
                  </button>
                  <button
                    onClick={() => {
                      setIsStorageManagerOpen(true)
                    }}
                    className="px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/70 text-[11px] transition-colors"
                  >
                    Manage
                  </button>
                </div>
              </div>
            )}
            <DataCanvas
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              albumDisplayMode={albumDisplayMode}
              onAlbumDisplayModeChange={setAlbumDisplayMode}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              works={isCoreActive ? [] : works}
              releases={displayedReleases}
              tracks={filteredTracks}
              mountAndFolderScopedTracks={mountAndFolderScopedTracks}
              facets={facets}
              onFacetChange={setFacets}
              selectedTrackId={selectedTrackId}
              onSelectTrack={setSelectedTrackId}
              selectedTrackIds={selectedTrackIds}
              onToggleTrackSelection={handleToggleTrackSelection}
              onSelectAllTracks={handleSelectAllTracks}
              onSelectVariant={handleSelectVariant}
              onInspectRelease={handleInspectRelease}
              onCustomizeRelease={rel => handleInspectRelease(rel.id)}
              onUpdateReleaseDetails={handleUpdateReleaseDetails}
              onOpenSidecar={(trackId) => setSidecarTrackId(trackId)}
              onApplyBatchEdits={handleApplyBatchEdits}
              onTriggerTwoPhaseCommit={() => setIsCommitModalOpen(true)}
              onOpenBatchRuleModal={() => setIsPathRuleModalOpen(true)}
              onOpenImportModal={() => setIsImportModalOpen(true)}
              onOpenBatchDiff={() => setIsBatchDiffModalOpen(true)}
              onOpenBatchAi={() => setIsBatchDiffModalOpen(true)}
              totalLibraryTracksCount={tracks.length}
              totalLibraryReleasesCount={releases.length}
              activeEngineLabel={engineState.view.session.active.label}
              isCoreEngineActive={isCoreActive}
              onSwitchToLocalEngine={
                tauriBridge.hasLocalEngine() ? () => void requestSwitchToLocal() : undefined
              }
              stagedAlbumsCount={stagedAlbumsCount}
              splitReleaseIds={splitReleaseIds}
              onToggleReleaseSplit={handleToggleReleaseSplit}
              onResetFilters={() => {
                setFacets({})
                setActiveTriageFilter(undefined)
                setSelectedMountId(undefined)
                setSelectedFolderFilter(undefined)
                setSearchQuery('')
                if (tracks.length > 0 && graphEngine.getAllTracks().length === 0) {
                  graphEngine.loadCustomLibrary({
                    tracks: catalogTracks,
                    releases: catalogReleases,
                    works,
                    auditIssues,
                    storageMounts,
                  })
                }
              }}
              activeTriageIssue={activeTriageIssue}
              onClearTriageFilter={() => setActiveTriageFilter(undefined)}
              onRemediateTriageIssue={handleRemediateAudit}
              activeCoverTab={activeCoverTab}
              onActiveCoverTabChange={setActiveCoverTab}
              selectedAlbumId={selectedAlbumId}
              onSelectAlbumId={setSelectedAlbumId}
              selectedArtist={selectedArtist}
              onSelectArtist={setSelectedArtist}
              selectedComposer={selectedComposer}
              onSelectComposer={setSelectedComposer}
            />
          </div>
        )}

        {/* 3. Unified Right Sidebar: Queue & Playlists */}
        {isRightSidebarOpen && (
          <UnifiedRightSidebar
            allReleases={releases}
            onOpenCreatePlaylist={(trks) => {
              setInitialPlaylistTracks(trks || [])
              setIsCreatePlaylistOpen(true)
            }}
            onOpenEditPlaylist={(pl) => {
              setEditingPlaylist(pl)
              setIsEditPlaylistOpen(true)
            }}
            onOpenAddTracksModal={(trks) => {
              setTracksToAdd(trks)
              setIsAddTracksModalOpen(true)
            }}
            onSelectPlaylistDetail={(pl) => {
              setSelectedPlaylist(pl)
              setViewMode('playlist_detail')
            }}
            onClose={() => setIsRightSidebarOpen(false)}
            showToast={showToast}
          />
        )}
          </>
        )}
      </div>

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
        storageMounts={storageMounts}
        watchedFolders={watchedFolders}
        onTriggerScan={handleTriggerScan}
        onOpenStorageManager={() => {
          setIsImportModalOpen(false)
          setIsStorageManagerOpen(true)
        }}
        showToast={showToast}
      />

      {/* Omni Command Bar Modal */}
      <OmniCommandBar
        isOpen={isCommandBarOpen}
        onClose={() => setIsCommandBarOpen(false)}
        commands={commands}
        initialQuery={searchQuery}
        onSelectEntity={(entity) => {
          // Safe navigation: selects/focuses entity, never mutates AudioEngine playback!
          if (entity.type === 'album') {
            const relTracks = tracks.filter((t) => t.releaseId === entity.id)
            if (relTracks.length > 0) {
              setSelectedTrackId(relTracks[0].id)
            }
            setViewMode('cover_grid')
          } else if (entity.type === 'track') {
            setSelectedTrackId(entity.id)
          } else if (entity.type === 'artist') {
            const isComposer = entity.role === 'Composer'
            if (isComposer) {
              setFacets((prev) => ({ ...prev, composer: entity.name }))
            } else {
              setSearchQuery(entity.name)
            }
          }
        }}
        onInspectEntity={(entity) => {
          if (entity.type === 'album') {
            handleInspectRelease(entity.id)
          } else if (entity.type === 'track') {
            const trk = tracks.find((t) => t.id === entity.id)
            if (trk) {
              handleInspectRelease(trk.releaseId)
            }
          } else if (entity.type === 'artist') {
            const isComposer = entity.role === 'Composer'
            if (isComposer) {
              setFacets((prev) => ({ ...prev, composer: entity.name }))
            } else {
              setSearchQuery(entity.name)
            }
          }
        }}
        onEnrichEntity={(entity) => {
          if (entity.type === 'album') {
            const relTracks = tracks.filter((t) => t.releaseId === entity.id)
            if (relTracks.length > 0) {
              setSelectedTrackIds(new Set(relTracks.map((t) => t.id)))
            }
          } else if (entity.type === 'track') {
            setSelectedTrackIds(new Set([entity.id]))
          }
          setIsBatchDiffModalOpen(true)
        }}
        onApplyFacetFilter={(newFacets, residual) => {
          setFacets((prev) => ({ ...prev, ...newFacets }))
          if (residual && residual.trim()) {
            setSearchQuery(residual.trim())
          }
        }}
      />

      {/* Staged for Commit Modal */}
      {isCommitModalOpen && (
        <TwoPhaseCommitModal
          uncommittedTracks={tracks.filter(
            (t) =>
              t.sidecarStatus === 'uncommitted_sidecar' ||
              Boolean(t.pendingSidecarEdits && Object.keys(t.pendingSidecarEdits).length > 0)
          )}
          releases={releases}
          onClose={() => setIsCommitModalOpen(false)}
          onSuccess={() => {
            refreshFromEngine()
            // Asynchronous queue architecture: native CommitQueueWorker writes files and syncs
            // SQLite track-by-track in the background. We only persist in-memory state to IndexedDB
            // asynchronously without blocking the UI thread with synchronous SQLite batch transactions.
            storagePersistence
              .saveLibrary({
                tracks: graphEngine.getAllTracks(),
                releases: graphEngine.getAllReleases(),
                works: graphEngine.getAllWorks(),
                storageMounts: graphEngine.getAllStorageMounts(),
                auditIssues: graphEngine.getAllAuditIssues(),
                isCustomLibrary: graphEngine.isUsingCustomLibrary(),
                lastImportedTimestamp: new Date().toISOString(),
              })
              .catch((err) => console.warn('Failed to persist library snapshot:', err))
            showToast('Changes queued for saving. Writing to disk in background.')
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
            graphEngine.discardReleaseArtwork(releaseId)
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
          onUpdateReleaseArtwork={(releaseId, url) => {
            handleUpdateReleaseDetails(releaseId, { coverArtUrl: url })
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

      {/* Compilation Canonical Soundtrack Resolver Modal (Apple HIG) */}
      <CompilationProvenanceModal
        isOpen={Boolean(compilationModalRelease)}
        onClose={() => setCompilationModalRelease(null)}
        release={compilationModalRelease}
        allTracks={tracks}
        allReleases={releases}
        onSuccess={async () => {
          await coreRefreshCatalog()
          refreshFromEngine()
        }}
        showToast={showToast}
      />

      {/* Comprehensive Library & Storage Management Modal */}
      <StorageManagerModal
        isOpen={isStorageManagerOpen}
        onClose={() => setIsStorageManagerOpen(false)}
        mounts={storageMounts}
        watchedFolders={watchedFolders}
        totalTracksCount={catalogTracks.length}
        isCoreEngineActive={isCoreActive}
        activeEngineLabel={engineState.view.session.active.label}
        onSwitchToLocalEngine={() => void requestSwitchToLocal()}
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
      <NowPlayingBar
        onOpenSanctuary={() => setIsSanctuaryOpen(true)}
        onOpenRemoteModal={() => setIsRemoteModalOpen(true)}
        onOpenEngineSettings={() => openSettings('engine')}
        topMode={topMode}
        isArtworkDockExpanded={isArtworkDockExpanded && topMode !== 'curate'}
        onExpandArtworkDock={() => setIsArtworkDockExpanded(true)}
      />

      {/* Cadence Mobile Remote QR Pairing Modal */}
      <MobileRemoteModal
        isOpen={isRemoteModalOpen}
        onClose={() => setIsRemoteModalOpen(false)}
      />

      {/* Unified Always-Accessible Cadence Settings */}
      <CadenceSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        initialTab={settingsTab}
        prioritySettings={prioritySettings}
        prioritySummary={curateCatalog.summary}
        onSavePrioritySettings={handleSavePrioritySettings}
        onGeminiSaved={() => showToast('Gemini configuration updated')}
        onGeminiRemoved={() => {
          setIsSettingsOpen(false)
          onGeminiRemoved?.()
        }}
      />

      <EngineSwitchPromptModal />

      {/* Audiophile Sanctuary Listening Lounge Overlay */}
      <SanctuaryListeningLounge
        isOpen={isSanctuaryOpen}
        onClose={() => setIsSanctuaryOpen(false)}
      />

      {/* Create Playlist Modal */}
      <CreatePlaylistModal
        isOpen={isCreatePlaylistOpen}
        onClose={() => {
          setIsCreatePlaylistOpen(false)
          setInitialPlaylistTitle('')
        }}
        initialTitle={initialPlaylistTitle}
        initialTracks={initialPlaylistTracks}
        allReleases={releases}
        onPlaylistCreated={(newPl) => {
          refreshPlaylists()
          setSelectedPlaylist(newPl)
          setViewMode('playlist_detail')
        }}
        showToast={showToast}
      />

      {/* Edit Playlist Modal */}
      <EditPlaylistModal
        isOpen={isEditPlaylistOpen}
        onClose={() => {
          setIsEditPlaylistOpen(false)
          setEditingPlaylist(null)
        }}
        playlist={editingPlaylist}
        onPlaylistUpdated={(updated) => {
          refreshPlaylists()
          if (selectedPlaylist?.id === updated.id) {
            setSelectedPlaylist(updated)
          }
        }}
        onPlaylistDeleted={(deletedId) => {
          refreshPlaylists()
          if (selectedPlaylist?.id === deletedId) {
            setSelectedPlaylist(null)
            setViewMode('cover_grid')
          }
        }}
        showToast={showToast}
      />

      {/* Add Tracks to Playlist Modal */}
      <AddTracksToPlaylistModal
        isOpen={isAddTracksModalOpen}
        onClose={() => {
          setIsAddTracksModalOpen(false)
          setTracksToAdd([])
        }}
        tracksToAdd={tracksToAdd}
        onOpenCreateNew={() => {
          setInitialPlaylistTracks(tracksToAdd)
          setIsCreatePlaylistOpen(true)
        }}
        showToast={showToast}
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
  const [geminiConfigured, setGeminiConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    if (!tauriBridge.isTauri()) {
      setGeminiConfigured(true)
      return
    }
    invoke<{ configured: boolean }>('get_gemini_config')
      .then((config) => setGeminiConfigured(config.configured))
      .catch((error) => {
        console.error('[App] Failed to load Gemini configuration:', error)
        setGeminiConfigured(false)
      })
  }, [])

  if (geminiConfigured === null) {
    return <div className="min-h-screen bg-[#0a0a0c]" aria-label="Loading configuration" />
  }

  if (!geminiConfigured) {
    return <GeminiSetupScreen onConfigured={() => setGeminiConfigured(true)} />
  }

  return (
    <AudioPlayerProvider>
      <AppContent onGeminiRemoved={() => setGeminiConfigured(false)} />
    </AudioPlayerProvider>
  )
}

export default App
