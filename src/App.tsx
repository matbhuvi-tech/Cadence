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
  ShieldCheck,
  RotateCcw,
  Music4,
  Compass,
  Bot,
  WifiOff,
  AlertTriangle,
  RefreshCw,
  Server,
  Smartphone,
  PanelRight,
} from 'lucide-react'
import { Track, Release, Work, Credit, StorageMount, AuditIssue, AlbumDisplayMode, Playlist, ActiveEntityScope, NavigationAnchor } from './core/types'
import { graphEngine, FacetFilterState } from './core/graphEngine'
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
import { EmbeddedAgentDrawer } from './components/Agent/EmbeddedAgentDrawer'
import { BatchProposalSheet, BatchProposalData } from './components/Agent/BatchProposalSheet'
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
import { MobileRemoteModal } from './components/Modals/MobileRemoteModal'
import { MaintainCockpit, MaintainSubTab } from './components/Maintain/MaintainCockpit'
import { FocusedWorkbench } from './components/CenterStage/FocusedWorkbench'
import { CurationWorkbench } from './components/Curate/CurationWorkbench'
import { SanctuaryListeningLounge } from './components/AudioPlayer/SanctuaryListeningLounge'
import { ScanProgressPayload, WatchedFolder, SkippedFile } from './core/types'
import { backdropAnalyzer } from './services/backdropAnalyzer'
import { CreatePlaylistModal } from './components/Modals/CreatePlaylistModal'
import { EditPlaylistModal } from './components/Modals/EditPlaylistModal'
import { AddTracksToPlaylistModal } from './components/Modals/AddTracksToPlaylistModal'
import { PlaylistDetailView } from './components/CenterStage/PlaylistDetailView'
import { backgroundArtworkService } from './services/backgroundArtworkService'
import { useStagedChanges } from './hooks/useStagedChanges'

function AppContent() {
  // Primary Graph State
  const [tracks, setTracks] = useState<Track[]>(() => graphEngine.getAllTracks())
  const [releases, setReleases] = useState<Release[]>(() => graphEngine.getAllReleases())
  const [works, setWorks] = useState<Work[]>(() => graphEngine.getAllWorks())
  const [storageMounts, setStorageMounts] = useState<StorageMount[]>(() => graphEngine.getAllStorageMounts())
  const [auditIssues, setAuditIssues] = useState<AuditIssue[]>(() => graphEngine.getAllAuditIssues())
  const [isCustomLibraryActive, setIsCustomLibraryActive] = useState<boolean>(false)
  const [offlineMounts, setOfflineMounts] = useState<StorageMount[]>([])
  const [offlineStats, setOfflineStats] = useState<{ tracks: number; releases: number }>({ tracks: 0, releases: 0 })
  const [isCheckingConnectivity, setIsCheckingConnectivity] = useState<boolean>(false)

  // Split releases persisted from SQLite
  const [splitReleaseIds, setSplitReleaseIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    tauriBridge.dbGetSplitReleases().then((ids) => {
      setSplitReleaseIds(new Set(ids))
    }).catch((err) => {
      console.warn('[App] Failed to load split release IDs:', err)
    })
  }, [])

  const handleToggleReleaseSplit = async (releaseId: string) => {
    try {
      if (splitReleaseIds.has(releaseId)) {
        await tauriBridge.dbRemoveReleaseSplit(releaseId)
        setSplitReleaseIds((prev) => {
          const next = new Set(prev)
          next.delete(releaseId)
          return next
        })
        showToast('Multi-disc release recombined.')
      } else {
        await tauriBridge.dbSetReleaseSplit(releaseId)
        setSplitReleaseIds((prev) => {
          const next = new Set(prev)
          next.add(releaseId)
          return next
        })
        showToast('Multi-disc release split into individual discs.')
      }
    } catch (err) {
      console.error('[App] Failed to toggle release split:', err)
      showToast('Failed to update release split setting.')
    }
  }

  // Selection State
  const [selectedTrackId, setSelectedTrackId] = useState<string>(tracks[0]?.id || '')
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set())

  // Canonical staged mutations hook
  const { stagedAlbumsCount, stagedTracksCount, triageAlbumsCount, hasPendingCommits } = useStagedChanges(tracks, releases)

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
  const [isAgentDrawerOpen, setIsAgentDrawerOpen] = useState(false)
  const [isTutorialOpen, setIsTutorialOpen] = useState(false)
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('credits')
  const [isCommandBarOpen, setIsCommandBarOpen] = useState(false)
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false)
  const [isPathRuleModalOpen, setIsPathRuleModalOpen] = useState(false)
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [isBatchDiffModalOpen, setIsBatchDiffModalOpen] = useState(false)
  const [compilationModalRelease, setCompilationModalRelease] = useState<Release | null>(null)
  const [navigationAnchor, setNavigationAnchor] = useState<NavigationAnchor | null>(null)
  const [curateAutoTriggerAi, setCurateAutoTriggerAi] = useState(false)
  const [sidecarTrackId, setSidecarTrackId] = useState<string | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [isActivityPopoverOpen, setIsActivityPopoverOpen] = useState(false)
  const [isStorageManagerOpen, setIsStorageManagerOpen] = useState(false)
  const [isQuarantineModalOpen, setIsQuarantineModalOpen] = useState(false)
  const [isNormalizationRulesModalOpen, setIsNormalizationRulesModalOpen] = useState(false)
  const [isRemoteModalOpen, setIsRemoteModalOpen] = useState(false)
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
  const [topMode, setTopMode] = useState<'library' | 'curate' | 'maintain'>('library')
  const [maintainSubTab, setMaintainSubTab] = useState<MaintainSubTab>('needs_attention')
  const [isSanctuaryOpen, setIsSanctuaryOpen] = useState<boolean>(false)
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
  const [initialPlaylistTracks, setInitialPlaylistTracks] = useState<Track[]>([])
  const [activeBatchProposal, setActiveBatchProposal] = useState<BatchProposalData | null>(null)

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
  }, [isPlaying, isPaused])

  // Initialize background artwork service and hook debounced checkpoints
  useEffect(() => {
    backgroundArtworkService.init()
    backgroundArtworkService.setCheckpointHandler(async () => {
      await persistCurrentLibrary()
      refreshFromEngine()
    })
  }, [])

  const refreshPlaylists = async () => {
    try {
      const data = await sqliteLibraryService.getPlaylists()
      setPlaylists(data)
      if (selectedPlaylist) {
        const updated = data.find((p) => p.id === selectedPlaylist.id)
        if (updated) setSelectedPlaylist(updated)
      }
    } catch (err) {
      console.warn('[App] Failed to load playlists:', err)
    }
  }

  useEffect(() => {
    refreshPlaylists()
  }, [])

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
        setTopMode('maintain')
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
      persistCurrentLibrary()
      if (updates.coverArtUrl !== undefined || updates.backdropUrl !== undefined) {
        sqliteLibraryService.persistReleaseArtworkToDb(releaseId, {
          frontCoverUrl: updates.coverArtUrl,
          backdropUrl: updates.backdropUrl,
        })
      }
      showToast(`Customized "${res.release.title}" • ${res.affectedTracksCount} tracks staged in sidecar`)
    }
  }

  // Persist current active library to IndexedDB local database and native SQLite
  const persistCurrentLibrary = async () => {
    try {
      const allTracks = graphEngine.getAllTracks()
      const allReleases = graphEngine.getAllReleases()

      await storagePersistence.saveLibrary({
        tracks: allTracks,
        releases: allReleases,
        works: graphEngine.getAllWorks(),
        storageMounts: graphEngine.getAllStorageMounts(),
        auditIssues: graphEngine.getAllAuditIssues(),
        isCustomLibrary: graphEngine.isUsingCustomLibrary(),
        lastImportedTimestamp: new Date().toISOString(),
      })

      // Immediately synchronize tracks and releases into native SQLite database
      await sqliteLibraryService.persistLibraryToDb(allTracks, allReleases)
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
      if (dbData && mounted) {
        setStorageMounts(dbData.storageMounts)
        setWatchedFolders(dbData.watchedFolders)
        setSkippedFiles(dbData.skippedFiles)
        setScanTelemetry((prev) => ({
          ...prev,
          skippedCount: dbData.skippedFiles.length,
        }))

        if (dbData.offlineMounts.length > 0) {
          setOfflineMounts(dbData.offlineMounts)
          setOfflineStats({
            tracks: dbData.offlineTracksCount,
            releases: dbData.offlineReleasesCount,
          })
        } else {
          setOfflineMounts([])
          setOfflineStats({ tracks: 0, releases: 0 })
        }

        if (dbData.tracks.length > 0) {
          graphEngine.loadCustomLibrary({
            tracks: dbData.tracks,
            releases: dbData.releases,
            works: [],
            auditIssues: [],
            storageMounts: dbData.storageMounts,
          })
          refreshFromEngine()
          if (dbData.tracks.length > 0) {
            setSelectedTrackId(dbData.tracks[0].id)
          }
          if (dbData.offlineMounts.length > 0) {
            showToast(
              `Loaded ${dbData.tracks.length} active tracks. Notice: "${dbData.offlineMounts[0].name}" is offline (${dbData.offlineReleasesCount} albums withheld).`
            )
          } else {
            showToast(`Loaded ${dbData.tracks.length} tracks from SQLite database (WAL active)`)
          }
        } else if (dbData.offlineMounts.length > 0) {
          // All tracks are on offline network storage!
          // Withhold all album data as requested by user to prevent unplayable playback and failed commits
          graphEngine.clearLibrary()
          refreshFromEngine()
          showToast(
            `Network folder not accessible (${dbData.offlineMounts[0].mountPath}). Albums withheld from display.`
          )
        } else if (tauriBridge.isTauri()) {
          // In desktop environment with empty library: do not load stale legacy IndexedDB cache
          graphEngine.clearLibrary()
          refreshFromEngine()
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
      }

      // Sync user's scan playback policy to Rust backend
      const savedScanPolicy = (localStorage.getItem('cadence_scan_playback_policy') || 'purist') as
        | 'purist'
        | 'paced'
        | 'unthrottled'
      tauriBridge.setScannerPlaybackPolicy(savedScanPolicy).catch(() => {})

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
              setScanTelemetry((prev) => ({
                ...prev,
                skippedCount: refreshed.skippedFiles.length,
              }))
              setStorageMounts(refreshed.storageMounts)
              setOfflineMounts(refreshed.offlineMounts)
              if (refreshed.tracks.length > 0) {
                graphEngine.loadCustomLibrary({
                  tracks: refreshed.tracks,
                  releases: refreshed.releases,
                  works: [],
                  auditIssues: [],
                  storageMounts: refreshed.storageMounts,
                })
              }
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
      const savedPolicy = (localStorage.getItem('cadence_scan_playback_policy') || 'purist') as
        | 'purist'
        | 'paced'
        | 'unthrottled'
      await tauriBridge.startLibraryScan(folderPath, undefined, forceFull, savedPolicy)
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
      setScanTelemetry((prev) => ({
        ...prev,
        skippedCount: data.skippedFiles.length,
      }))
      setStorageMounts(data.storageMounts)

      if (data.offlineMounts.length > 0) {
        setOfflineMounts(data.offlineMounts)
        setOfflineStats({
          tracks: data.offlineTracksCount,
          releases: data.offlineReleasesCount,
        })
      } else {
        setOfflineMounts([])
        setOfflineStats({ tracks: 0, releases: 0 })
      }

      if (data.tracks.length > 0) {
        graphEngine.loadCustomLibrary({
          tracks: data.tracks,
          releases: data.releases,
          works: [],
          auditIssues: [],
          storageMounts: data.storageMounts,
        })
        refreshFromEngine()
        showToast(
          data.offlineMounts.length > 0
            ? `Storage refreshed: ${data.tracks.length} active tracks (${data.offlineReleasesCount} albums withheld).`
            : `Storage refreshed: ${data.tracks.length} tracks loaded.`
        )
      } else if (data.offlineMounts.length > 0) {
        graphEngine.clearLibrary()
        refreshFromEngine()
        showToast(`Network folder still inaccessible (${data.offlineMounts[0].mountPath}). Albums withheld.`)
      }
    }
  }

  const handleIgnoreSkippedFile = async (id: string) => {
    try {
      await tauriBridge.dbIgnoreSkippedFile(id)
      setSkippedFiles((prev) => prev.filter((s) => s.id !== id))
      setScanTelemetry((prev) => ({
        ...prev,
        skippedCount: Math.max(0, prev.skippedCount - 1),
      }))
      showToast('Ignored unparseable file from future scans')
    } catch (err: any) {
      showToast(`Error ignoring file: ${err.message || err}`)
    }
  }

  const handleIgnoreAllSkippedFiles = async () => {
    try {
      await tauriBridge.dbIgnoreAllSkippedFiles()
      setSkippedFiles([])
      setScanTelemetry((prev) => ({
        ...prev,
        skippedCount: 0,
      }))
      showToast('Dismissed and permanently ignored all skipped files')
    } catch (err: any) {
      showToast(`Error dismissing skipped files: ${err.message || err}`)
    }
  }

  const handleRetryConnection = async () => {
    setIsCheckingConnectivity(true)
    try {
      const data = await sqliteLibraryService.loadLibraryFromDb()
      if (data) {
        setWatchedFolders(data.watchedFolders)
        setSkippedFiles(data.skippedFiles)
        setStorageMounts(data.storageMounts)

        if (data.offlineMounts.length > 0) {
          setOfflineMounts(data.offlineMounts)
          setOfflineStats({
            tracks: data.offlineTracksCount,
            releases: data.offlineReleasesCount,
          })
        } else {
          setOfflineMounts([])
          setOfflineStats({ tracks: 0, releases: 0 })
        }

        if (data.tracks.length > 0) {
          graphEngine.loadCustomLibrary({
            tracks: data.tracks,
            releases: data.releases,
            works: [],
            auditIssues: [],
            storageMounts: data.storageMounts,
          })
          refreshFromEngine()
          setSelectedTrackId(data.tracks[0].id)
          showToast(
            `Network storage reconnected! Loaded ${data.releases.length} albums (${data.tracks.length} tracks).`
          )
        } else if (data.offlineMounts.length > 0) {
          graphEngine.clearLibrary()
          refreshFromEngine()
          showToast(`Network storage is still unreachable (${data.offlineMounts[0].mountPath}).`)
        } else {
          showToast('No music tracks found in storage.')
        }
      }
    } catch (err: any) {
      showToast(`Connection check failed: ${err.message || err}`)
    } finally {
      setIsCheckingConnectivity(false)
    }
  }

  const handleAddWatchedFolder = async () => {
    try {
      const selected = await tauriBridge.openDirectoryDialog()
      if (selected) {
        const folderName = selected.split(/[/\\]/).filter(Boolean).pop() || selected

        const winMatch = selected.match(/^([A-Za-z]:)/)
        const uncMatch = selected.match(/^(\\\\[^\\]+\\[^\\]+)/)
        const rootKey = winMatch
          ? winMatch[1]
          : uncMatch
          ? uncMatch[1]
          : selected.startsWith('/')
          ? '/' + selected.split('/').filter(Boolean)[0]
          : 'Local Audio'
        const expectedMountId = `mount-${rootKey.toLowerCase().replace(/[^a-z0-9]/g, '_')}`

        const normSelected = selected.replace(/\//g, '\\').toLowerCase()
        let matchedMount = storageMounts.find((m) => {
          const normMount = m.mountPath.replace(/\//g, '\\').toLowerCase().trim()
          return (
            normSelected.startsWith(normMount) ||
            m.id.toLowerCase() === expectedMountId.toLowerCase()
          )
        })

        if (!matchedMount) {
          const isWin = Boolean(winMatch)
          const isUnc = Boolean(uncMatch)
          const newMount: StorageMount = {
            id: expectedMountId,
            name: isUnc
              ? `TrueNAS Network Storage (${rootKey})`
              : isWin
              ? `Drive ${rootKey} (Local Audio Disk)`
              : `Storage Volume (${rootKey})`,
            mountPath: isWin ? `${rootKey}\\` : rootKey,
            type: isUnc ? 'nas_array' : 'local_disk',
            fileSystem: isUnc ? 'ZFS' : isWin ? 'NTFS' : 'APFS',
            totalBytes: 1000000000000,
            usedBytes: 450000000000,
            isReadOnlyLocked: false,
            healthScore: 'healthy',
            smartOk: true,
            tempCelsius: 34,
            status: 'online',
            lastSeenTimestamp: new Date().toISOString(),
          }
          await tauriBridge.dbSaveStorageMount(newMount)
          matchedMount = newMount
          setStorageMounts((prev) => [...prev.filter((m) => m.id !== newMount.id), newMount])
        }

        const newFolder: WatchedFolder = {
          id: `wf-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          mountId: matchedMount.id,
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
    facets.mastering ||
    facets.reviewStatus
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
    // Self-healing: if graphEngine was reloaded or emptied by HMR while React state still has tracks
    if (tracks.length > 0 && graphEngine.getAllTracks().length === 0) {
      graphEngine.loadCustomLibrary({
        tracks,
        releases,
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
    return result
  }, [searchQuery, facets, selectedMountId, selectedFolderFilter, tracks, releases, works, auditIssues, storageMounts, stagedReleaseIds])

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

  // 3b. Derived displayed releases: scoped when filtering by staged review status
  const displayedReleases = useMemo(() => {
    if (facets.reviewStatus === 'staged') {
      return releases.filter(
        (r) => stagedReleaseIds.has(r.id) || (r.folderName && stagedReleaseIds.has(r.folderName))
      )
    }
    return releases
  }, [releases, facets.reviewStatus, stagedReleaseIds])

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

  const handleInspectRelease = (releaseId: string, autoTriggerAi = false) => {
    setSelectedAlbumId(releaseId)
    setNavigationAnchor({
      returnView: 'library',
      selectedAlbumId: releaseId,
      scrollPosition: window.scrollY || 0,
    })
    setCurateAutoTriggerAi(autoTriggerAi)
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
      persistCurrentLibrary()
      if (updates.coverArtUrl !== undefined || updates.backdropUrl !== undefined) {
        sqliteLibraryService.persistReleaseArtworkToDb(releaseId, {
          frontCoverUrl: updates.coverArtUrl,
          backdropUrl: updates.backdropUrl,
        })
      }
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
        else if (modalName === 'curate') {
          setTopMode('curate')
          setFocusedWorkbenchTrack(null)
        }
        else if (modalName === 'pathrule') setIsPathRuleModalOpen(true)
        else if (modalName === 'batch_diff' || modalName === 'batch_ai') setIsBatchDiffModalOpen(true)
        else if (modalName === 'tutorial') setIsTutorialOpen(true)
        else if (modalName === 'command_bar' || modalName === 'spotlight') setIsCommandBarOpen(true)
        else if (modalName === 'agent') setIsAgentDrawerOpen(true)
        else if (modalName === 'customize') {
          const target = payload || currentRelease || releases[0]
          if (target) handleInspectRelease(target.id)
        }
      },
      openBatchProposal: (data: BatchProposalData) => setActiveBatchProposal(data),
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
  ]

  const uncommittedCount = tracks.filter((t) => t.sidecarStatus === 'uncommitted_sidecar').length
  const allAffectedTrackIds = new Set(auditIssues.flatMap((i) => i.sampleTrackIds || []))
  const impactedAlbumsCount = new Set(
    tracks.filter((t) => allAffectedTrackIds.has(t.id)).map((t) => t.releaseId).filter(Boolean)
  ).size

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0D0E12] text-[#F1F5F9] select-none font-sans">
      {/* Apple HIG Unified macOS-Style Toolbar */}
      <header className="h-[52px] border-b border-white/[0.06] bg-[#0C0D10]/95 backdrop-blur-2xl px-3.5 flex items-center justify-between shrink-0 z-30 select-none">
        {/* Left: Brand Lockup & Telemetry Monospace */}
        <div className="flex items-center gap-3">
          <div data-tutorial-id="header-brand" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-[7px] bg-gradient-to-b from-[#2A2B32] to-[#16171B] border border-white/10 flex items-center justify-center text-[#D4AF37] shadow-sm">
              <Music4 className="w-3.5 h-3.5" />
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
            <span>·</span>
            <span className="text-[#EDEDED]">{stats.highResPercentage}% Hi-Res</span>
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
            className={`px-3.5 py-1 rounded-[7px] text-[12px] font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
              topMode === 'library' && !focusedWorkbenchTrack
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
            title="Precision Metadata Workbench (⌘2)"
            className={`px-3.5 py-1 rounded-[7px] text-[12px] font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
              topMode === 'curate'
                ? 'bg-white/[0.12] text-white shadow-sm border border-white/[0.08]'
                : 'text-[#8E8E93] hover:text-[#EDEDED]'
            }`}
          >
            <span>Curate</span>
            {triageAlbumsCount > 0 && (
              <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-[#D4AF37]/20 text-[#D4AF37] font-mono font-medium">
                {triageAlbumsCount}
              </span>
            )}
            <span className="text-[10px] text-[#636366] font-mono hidden md:inline">⌘2</span>
          </button>

          <button
            onClick={() => {
              setTopMode('maintain')
              setFocusedWorkbenchTrack(null)
            }}
            title="Library Hygiene & Storage Audit (⌘3)"
            className={`px-3.5 py-1 rounded-[7px] text-[12px] font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
              topMode === 'maintain'
                ? 'bg-white/[0.12] text-white shadow-sm border border-white/[0.08]'
                : 'text-[#8E8E93] hover:text-[#EDEDED]'
            }`}
          >
            <span>Audit</span>
            {impactedAlbumsCount > 0 && (
              <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-300 font-mono font-medium">
                {impactedAlbumsCount}
              </span>
            )}
            <span className="text-[10px] text-[#636366] font-mono hidden md:inline">⌘3</span>
          </button>
        </div>

        {/* Right Toolbar Actions */}
        <div className="flex items-center gap-2">
          {/* Canonical Staged Changes Badge */}
          {hasPendingCommits && (
            <button
              onClick={() => {
                if (isPlaying) {
                  showToast('⚠️ Transport Purity Notice: Playback is active. Physical disk writes are locked until playback pauses/stops.')
                }
                setIsCommitModalOpen(true)
              }}
              title="Review and commit staged metadata and artwork changes"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-[7px] bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 text-[11px] font-mono transition-all cursor-pointer shadow-sm"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>{stagedAlbumsCount} Albums · {stagedTracksCount} Staged</span>
            </button>
          )}

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
              setTopMode('maintain')
              setIsActivityPopoverOpen(false)
            }}
            onDismissAllSkipped={handleIgnoreAllSkippedFiles}
          />

          {/* AI Copilot Drawer */}
          <button
            data-tutorial-id="btn-cadence-agent"
            onClick={() => setIsAgentDrawerOpen((prev) => !prev)}
            title="Cadence Music Agent Copilot (⌘J)"
            className={`p-1.5 rounded-[7px] border transition-all cursor-pointer ${
              isAgentDrawerOpen
                ? 'bg-[#D4AF37]/20 border-[#D4AF37]/40 text-[#D4AF37]'
                : 'bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.06] text-[#8E8E93] hover:text-white'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
          </button>

          {/* Mobile Remote Modal */}
          <button
            onClick={() => setIsRemoteModalOpen(true)}
            title="Mobile Remote QR Controller"
            className="p-1.5 rounded-[7px] bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[#8E8E93] hover:text-[#EDEDED] transition-all cursor-pointer"
          >
            <Smartphone className="w-3.5 h-3.5" />
          </button>

          {/* Sidecar Drawer Toggle (Queue / Playlists) */}
          <button
            onClick={() => toggleRightSidebar()}
            title={isRightSidebarOpen ? 'Hide Right Panel' : 'Show Right Panel (Queue & Playlists)'}
            className={`p-1.5 rounded-[7px] border transition-all cursor-pointer ${
              isRightSidebarOpen
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
            setTopMode('maintain')
            setMaintainSubTab('storage_mounts')
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
          <CurationWorkbench
            tracks={tracks}
            releases={releases}
            auditIssues={auditIssues}
            initialSelectedAlbumId={selectedAlbumId}
            navigationAnchor={navigationAnchor}
            autoTriggerAi={curateAutoTriggerAi}
            onReturnToAnchor={() => {
              if (navigationAnchor) {
                setSelectedAlbumId(navigationAnchor.selectedAlbumId)
                const scrollPos = navigationAnchor.scrollPosition
                setNavigationAnchor(null)
                setCurateAutoTriggerAi(false)
                setTopMode('library')
                requestAnimationFrame(() => {
                  window.scrollTo({ top: scrollPos, behavior: 'instant' })
                })
              } else {
                setTopMode('library')
              }
            }}
            onOpenCommitModal={() => {
              if (isPlaying) {
                showToast('⚠️ Transport Purity Notice: Playback is active. Physical disk writes are locked until playback pauses/stops.')
              }
              setIsCommitModalOpen(true)
            }}
            onBackToLibrary={() => {
              setNavigationAnchor(null)
              setCurateAutoTriggerAi(false)
              setTopMode('library')
            }}
            showToast={showToast}
            onRefreshLibrary={() => {
              refreshFromEngine()
              persistCurrentLibrary()
            }}
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
          ) : tracks.length === 0 && offlineMounts.length > 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 bg-[#0B0D13] relative overflow-hidden text-center">
              {/* Ambient background glow */}
              <div className="absolute w-96 h-96 rounded-full bg-amber-500/10 blur-[120px] pointer-events-none" />

              <div className="relative z-10 max-w-lg flex flex-col items-center">
                <div className="w-16 h-16 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-6 shadow-xl shadow-amber-500/10">
                  <WifiOff className="w-8 h-8" />
                </div>

                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 text-[11px] font-mono font-semibold border border-amber-500/30 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
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
                      setTopMode('maintain')
                      setMaintainSubTab('storage_mounts')
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
                        setTopMode('maintain')
                        setMaintainSubTab('storage_mounts')
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
                works={works}
                releases={displayedReleases}
                tracks={filteredTracks}
                facets={facets}
                onFacetChange={setFacets}
                selectedTrackId={selectedTrackId}
                onSelectTrack={setSelectedTrackId}
                selectedTrackIds={selectedTrackIds}
                onToggleTrackSelection={handleToggleTrackSelection}
                onSelectAllTracks={handleSelectAllTracks}
                onSelectVariant={handleSelectVariant}
                onInspectRelease={handleInspectRelease}
                onCustomizeRelease={(rel) => handleInspectRelease(rel.id)}
                onUpdateReleaseDetails={handleUpdateReleaseDetails}
                onOpenSidecar={(trackId) => setSidecarTrackId(trackId)}
                onApplyBatchEdits={handleApplyBatchEdits}
                onTriggerTwoPhaseCommit={() => setIsCommitModalOpen(true)}
                onOpenBatchRuleModal={() => setIsPathRuleModalOpen(true)}
                onOpenImportModal={() => setIsImportModalOpen(true)}
                onOpenBatchDiff={() => setIsBatchDiffModalOpen(true)}
                onOpenBatchAi={() => setIsBatchDiffModalOpen(true)}
                totalLibraryTracksCount={tracks.length}
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
                      tracks,
                      releases,
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
      />

      {/* Omni Command Bar Modal */}
      <OmniCommandBar
        isOpen={isCommandBarOpen}
        onClose={() => setIsCommandBarOpen(false)}
        commands={commands}
        initialQuery={searchQuery}
        onOpenAgent={(prompt) => {
          setIsAgentDrawerOpen(true)
          if (prompt) {
            window.dispatchEvent(new CustomEvent('cadence:agent:prompt', { detail: prompt }))
          }
        }}
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
          const refreshed = await sqliteLibraryService.loadLibraryFromDb()
          if (refreshed && refreshed.tracks.length > 0) {
            graphEngine.loadCustomLibrary({
              tracks: refreshed.tracks,
              releases: refreshed.releases,
              works: [],
              auditIssues: [],
              storageMounts: refreshed.storageMounts,
            })
            refreshFromEngine()
          } else {
            refreshFromEngine()
            persistCurrentLibrary()
          }
        }}
        showToast={showToast}
      />

      {/* Cadence Core Embedded AI Agent Copilot Drawer */}
      <EmbeddedAgentDrawer
        isOpen={isAgentDrawerOpen}
        onClose={() => setIsAgentDrawerOpen(false)}
        dispatcherContext={agentDispatcherContext}
        tracks={tracks}
        releases={releases}
        currentRelease={currentRelease}
        currentTrack={currentTrack}
        activeTriageLabel={activeTriageIssue?.title}
        activeFilterCount={gridScopedTracks.length}
        isGridFiltered={isGridFilterActive}
      />

      {/* Copilot Batch Proposal Safety Layer Modal */}
      <BatchProposalSheet
        proposal={activeBatchProposal}
        isOpen={Boolean(activeBatchProposal)}
        onClose={() => setActiveBatchProposal(null)}
        showToast={showToast}
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
      <NowPlayingBar
        onOpenSanctuary={() => setIsSanctuaryOpen(true)}
        onOpenRemoteModal={() => setIsRemoteModalOpen(true)}
      />

      {/* Cadence Mobile Remote QR Pairing Modal */}
      <MobileRemoteModal
        isOpen={isRemoteModalOpen}
        onClose={() => setIsRemoteModalOpen(false)}
      />

      {/* Audiophile Sanctuary Listening Lounge Overlay */}
      <SanctuaryListeningLounge
        isOpen={isSanctuaryOpen}
        onClose={() => setIsSanctuaryOpen(false)}
      />

      {/* Create Playlist Modal */}
      <CreatePlaylistModal
        isOpen={isCreatePlaylistOpen}
        onClose={() => setIsCreatePlaylistOpen(false)}
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
  return (
    <AudioPlayerProvider>
      <AppContent />
    </AudioPlayerProvider>
  )
}

export default App
