import React, { useState, useRef, useEffect, useMemo } from 'react'
import {
  FolderPlus,
  HardDrive,
  Upload,
  X,
  Check,
  AlertCircle,
  Loader2,
  Folder,
  FileAudio,
  Sparkles,
  RotateCcw,
  ArrowRight,
  Database,
  ShieldCheck,
  FolderOpen,
  Server,
  RotateCw,
  SlidersHorizontal,
} from 'lucide-react'
import { libraryImporter, IngestionProgress, IngestionResult } from '../../services/libraryImporter'
import { storagePersistence } from '../../core/storagePersistence'
import { tauriBridge } from '../../services/tauriBridge'
import { StorageMount, WatchedFolder } from '../../core/types'

interface ImportLibraryModalProps {
  isOpen: boolean
  onClose: () => void
  onImportComplete: (result: IngestionResult, isCustom: boolean, isStreaming?: boolean) => void
  onResetToDemo: () => void
  isCustomLibraryActive: boolean
  storageMounts?: StorageMount[]
  watchedFolders?: WatchedFolder[]
  onTriggerScan?: (folderPath: string, forceFull?: boolean) => void
  onOpenStorageManager?: () => void
}

export const ImportLibraryModal: React.FC<ImportLibraryModalProps> = ({
  isOpen,
  onClose,
  onImportComplete,
  onResetToDemo,
  isCustomLibraryActive,
  storageMounts = [],
  watchedFolders = [],
  onTriggerScan,
  onOpenStorageManager,
}) => {
  const [activeMounts, setActiveMounts] = useState<StorageMount[]>(storageMounts)
  const [activeWatchedFolders, setActiveWatchedFolders] = useState<WatchedFolder[]>(watchedFolders)
  const [playbackPolicy, setPlaybackPolicy] = useState<'purist' | 'paced' | 'unthrottled'>(() => {
    return (localStorage.getItem('cadence_scan_playback_policy') as any) || 'purist'
  })

  const handlePolicyChange = (newPolicy: 'purist' | 'paced' | 'unthrottled') => {
    setPlaybackPolicy(newPolicy)
    localStorage.setItem('cadence_scan_playback_policy', newPolicy)
    tauriBridge.setScannerPlaybackPolicy(newPolicy).catch(() => {})
  }

  // Sync props when updated from parent
  useEffect(() => {
    if (storageMounts.length > 0) setActiveMounts(storageMounts)
    if (watchedFolders.length > 0) setActiveWatchedFolders(watchedFolders)
  }, [storageMounts, watchedFolders])

  // On open, refresh directly from SQLite if in native Tauri environment
  useEffect(() => {
    if (!isOpen) return

    if (tauriBridge.isTauri()) {
      Promise.all([
        tauriBridge.dbGetStorageMounts().catch(() => []),
        tauriBridge.dbGetWatchedFolders().catch(() => []),
      ]).then(([dbMounts, dbFolders]) => {
        if (dbMounts && dbMounts.length > 0) {
          const mappedMounts: StorageMount[] = dbMounts.map((m: any) => ({
            id: m.id,
            name: m.name,
            mountPath: m.mountPath || m.mount_path || '',
            type: m.type || m.mount_type || 'nas_array',
            fileSystem: m.fileSystem || m.file_system || 'ZFS',
            totalBytes: m.totalBytes || m.total_bytes || 0,
            usedBytes: m.usedBytes || m.used_bytes || 0,
            isReadOnlyLocked: Boolean(m.isReadOnlyLocked ?? m.is_read_only_locked),
            healthScore: m.healthScore || m.health_score || 'healthy',
            smartOk: Boolean(m.smartOk ?? m.smart_ok ?? true),
            tempCelsius: m.tempCelsius || m.temp_celsius || 35,
            status: m.status || 'online',
            lastSeenTimestamp: m.lastSeenTimestamp || m.last_seen_timestamp,
          }))
          setActiveMounts(mappedMounts)
        }
        if (dbFolders && dbFolders.length > 0) {
          const mappedFolders: WatchedFolder[] = dbFolders.map((f: any) => ({
            id: f.id,
            mountId: f.mountId || f.mount_id || '',
            folderPath: f.folderPath || f.folder_path || '',
            displayName: f.displayName || f.display_name,
            scanMode: f.scanMode || f.scan_mode || 'realtime',
            isEnabled: Boolean(f.isEnabled ?? f.is_enabled ?? true),
            lastScanned: f.lastScanned || f.last_scanned,
            trackCount: f.trackCount || f.track_count,
          }))
          setActiveWatchedFolders(mappedFolders)
        }
      })
    }
  }, [isOpen])

  // Resolve primary active mount & base path
  const primaryMount = useMemo(() => {
    return activeMounts.find((m) => m.status === 'online') || activeMounts[0] || null
  }, [activeMounts])

  const baseMountPath = useMemo(() => {
    return primaryMount?.mountPath ? primaryMount.mountPath.replace(/[/\\]+$/, '') : ''
  }, [primaryMount])

  // Derive suggested default path dynamically from active mount and watched folders
  const suggestedDefaultPath = useMemo(() => {
    if (activeWatchedFolders && activeWatchedFolders.length > 0) {
      const masterFolder = activeWatchedFolders.find(
        (f) => f?.folderPath && /master/i.test(f.folderPath)
      )
      if (masterFolder?.folderPath) {
        const match = masterFolder.folderPath.match(/^(.*?[\\/]Master)/i)
        if (match) return match[1]
      }
      if (activeWatchedFolders[0]?.folderPath) {
        return activeWatchedFolders[0].folderPath
      }
    }
    if (baseMountPath) {
      return `${baseMountPath}\\Music Collection\\Master`
    }
    return ''
  }, [activeWatchedFolders, baseMountPath])

  const [localPath, setLocalPath] = useState(suggestedDefaultPath || '')

  // Dynamically update localPath when opening or when active mount is detected
  useEffect(() => {
    if (isOpen && suggestedDefaultPath && !localPath) {
      setLocalPath(suggestedDefaultPath)
    }
  }, [isOpen, suggestedDefaultPath])

  const quickPresets = useMemo(() => {
    const list: { label: string; path: string }[] = []

    if (baseMountPath) {
      list.push({
        label: 'Master Collection',
        path: `${baseMountPath}\\Music Collection\\Master`,
      })
      list.push({
        label: 'Mount Root',
        path: baseMountPath,
      })
    }

    // Add all registered watched folders
    if (Array.isArray(activeWatchedFolders)) {
      activeWatchedFolders.forEach((wf) => {
        if (!wf?.folderPath) return
        const folderName =
          wf.displayName ||
          wf.folderPath.split(/[/\\]/).filter(Boolean).pop() ||
          'Watched Folder'
        list.push({
          label: folderName,
          path: wf.folderPath,
        })
      })
    }

    // If base mount path is available, also provide common artist presets
    if (baseMountPath) {
      list.push({
        label: 'Hindi Master (A R Rahman)',
        path: `${baseMountPath}\\Music Collection\\Master\\Hindi\\A R Rahman`,
      })
      list.push({
        label: 'Tamil Master (Ilaiyaraaja)',
        path: `${baseMountPath}\\Music Collection\\Master\\Tamil\\Ilaiyaraaja`,
      })
    }

    // Deduplicate presets by normalized path
    const seen = new Set<string>()
    return list.filter((item) => {
      if (!item?.path) return false
      const norm = String(item.path).toLowerCase().replace(/[/\\]+$/, '')
      if (seen.has(norm)) return false
      seen.add(norm)
      return true
    })
  }, [baseMountPath, activeWatchedFolders])

  const [isProcessing, setIsProcessing] = useState(false)
  const [progress, setProgress] = useState<IngestionProgress | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  if (!isOpen) return null

  // 1. Browse Folder Handler (OS Native Dialog in Tauri, File System Access in Browser)
  const handleBrowseFolder = async () => {
    setErrorMessage(null)

    // Option A: If running in native Tauri, open OS file dialog
    if (tauriBridge.isTauri()) {
      try {
        const selected = await tauriBridge.openDirectoryDialog(localPath)
        if (selected) {
          setLocalPath(selected)
          onClose()
          if (onTriggerScan) {
            onTriggerScan(selected, false)
          } else {
            await tauriBridge.startLibraryScan(selected, undefined, false, playbackPolicy)
          }
        }
      } catch (err: any) {
        console.error('Failed to open native directory picker:', err)
        setErrorMessage(err.message || 'Failed to open directory picker')
      }
      return
    }

    // Option B: Browser File System Access API
    if ('showDirectoryPicker' in window) {
      try {
        const dirHandle = await (window as any).showDirectoryPicker()
        if (dirHandle) {
          setLocalPath(dirHandle.name)
          await handleBrowserDirectoryImport(dirHandle)
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          setErrorMessage(err.message || 'Failed to select directory')
        }
      }
      return
    }

    // Option C: HTML5 webkitdirectory input fallback
    if (fileInputRef.current) {
      fileInputRef.current.click()
    }
  }

  // Helper for Browser showDirectoryPicker
  const handleBrowserDirectoryImport = async (dirHandle: any) => {
    setIsProcessing(true)
    setProgress({
      totalFiles: 0,
      processedFiles: 0,
      currentFileName: `Reading files from "${dirHandle.name}"...`,
      discoveredTracks: 0,
      discoveredReleases: 0,
      discoveredWorks: 0,
      status: 'scanning',
    })

    try {
      const files: File[] = []
      let discoveredCount = 0
      let folderCount = 0

      async function readDir(handle: any, pathPrefix: string = '') {
        folderCount++
        for await (const entry of handle.values()) {
          if (entry.kind === 'file') {
            if (libraryImporter.isAudioFile(entry.name)) {
              const file = await entry.getFile()
              Object.defineProperty(file, 'webkitRelativePath', {
                value: `${pathPrefix}${file.name}`,
                writable: true,
              })
              files.push(file)
              discoveredCount++

              if (discoveredCount % 25 === 0) {
                setProgress({
                  totalFiles: 0,
                  processedFiles: 0,
                  currentFileName: `Scanning "${pathPrefix}${entry.name}" (${discoveredCount} audio files across ${folderCount} folders)...`,
                  discoveredTracks: discoveredCount,
                  discoveredReleases: folderCount,
                  discoveredWorks: 0,
                  status: 'scanning',
                })
                await new Promise((r) => setTimeout(r, 0))
              }
            }
          } else if (entry.kind === 'directory') {
            if (
              entry.name !== 'node_modules' &&
              !entry.name.startsWith('.') &&
              entry.name !== '$RECYCLE.BIN' &&
              entry.name !== 'System Volume Information'
            ) {
              await readDir(entry, `${pathPrefix}${entry.name}/`)
            }
          }
        }
      }

      await readDir(dirHandle, `${dirHandle.name}/`)

      if (files.length === 0) {
        throw new Error(`No supported audio files found inside folder "${dirHandle.name}".`)
      }

      const result = await libraryImporter.importFiles(files, (p) => setProgress(p))
      await storagePersistence.saveLibrary({
        tracks: result.tracks,
        releases: result.releases,
        works: result.works,
        auditIssues: result.auditIssues,
        isCustomLibrary: true,
        lastImportedTimestamp: new Date().toISOString(),
      })

      setIsProcessing(false)
      onImportComplete(result, true)
      onClose()
    } catch (err: any) {
      setIsProcessing(false)
      if (err.name !== 'AbortError') {
        setErrorMessage(err.message || 'Failed to read directory')
      }
    }
  }

  // Fallback for HTML5 input
  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return
    const fileList = Array.from(e.target.files)
    setErrorMessage(null)
    setIsProcessing(true)

    try {
      const result = await libraryImporter.importFiles(fileList, (p) => setProgress(p))
      await storagePersistence.saveLibrary({
        tracks: result.tracks,
        releases: result.releases,
        works: result.works,
        auditIssues: result.auditIssues,
        isCustomLibrary: true,
        lastImportedTimestamp: new Date().toISOString(),
      })
      setIsProcessing(false)
      onImportComplete(result, true)
      onClose()
    } catch (err: any) {
      setIsProcessing(false)
      setErrorMessage(err.message || 'Failed to process files')
    }
  }

  // Drag and Drop Handler
  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    setErrorMessage(null)

    const items = e.dataTransfer.items
    if (!items || items.length === 0) return

    setIsProcessing(true)
    setProgress({
      totalFiles: 0,
      processedFiles: 0,
      currentFileName: 'Scanning dropped folder hierarchy...',
      discoveredTracks: 0,
      discoveredReleases: 0,
      discoveredWorks: 0,
      status: 'scanning',
    })

    const files: File[] = []

    async function traverseFileTree(item: any, path: string = '') {
      if (item.isFile) {
        return new Promise<void>((resolve) => {
          item.file((file: File) => {
            if (libraryImporter.isAudioFile(file.name)) {
              Object.defineProperty(file, 'webkitRelativePath', {
                value: `${path}${file.name}`,
                writable: true,
              })
              files.push(file)
            }
            resolve()
          })
        })
      } else if (item.isDirectory) {
        const dirReader = item.createReader()
        return new Promise<void>((resolve) => {
          dirReader.readEntries(async (entries: any[]) => {
            for (const entry of entries) {
              await traverseFileTree(entry, `${path}${item.name}/`)
            }
            resolve()
          })
        })
      }
    }

    try {
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.()
        if (entry) {
          await traverseFileTree(entry)
        }
      }

      if (files.length === 0) {
        throw new Error('No supported audio files (.flac, .dsf, .wav, .mp3, etc.) found in dropped items.')
      }

      const result = await libraryImporter.importFiles(files, (p) => setProgress(p))
      await storagePersistence.saveLibrary({
        tracks: result.tracks,
        releases: result.releases,
        works: result.works,
        auditIssues: result.auditIssues,
        isCustomLibrary: true,
        lastImportedTimestamp: new Date().toISOString(),
      })
      setIsProcessing(false)
      onImportComplete(result, true)
      onClose()
    } catch (err: any) {
      setIsProcessing(false)
      setErrorMessage(err.message || 'Failed to process dropped files')
    }
  }

  // 2. Direct Disk / Network Path Scanner Execution
  const startLocalPathScan = async (pathOverride?: string) => {
    const pathToScan = pathOverride || localPath
    const cleaned = pathToScan.trim().replace(/^["']+|["']+$/g, '')
    if (!cleaned) return
    setErrorMessage(null)

    if (tauriBridge.isTauri()) {
      onClose()
      if (onTriggerScan) {
        onTriggerScan(cleaned, false)
      } else {
        await tauriBridge.startLibraryScan(cleaned, undefined, false, playbackPolicy)
      }
      return
    }

    setIsProcessing(true)

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const result = await libraryImporter.importFromLocalPath(
        cleaned,
        (p) => setProgress(p),
        (partialResult) => {
          // Stream progressive updates into catalog live
          onImportComplete(partialResult, true, true)
        },
        controller.signal
      )
      if (result.tracks.length > 0) {
        await storagePersistence.saveLibrary({
          tracks: result.tracks,
          releases: result.releases,
          works: result.works,
          auditIssues: result.auditIssues,
          isCustomLibrary: true,
          lastImportedTimestamp: new Date().toISOString(),
        })
        onImportComplete(result, true, false)
      }
      setIsProcessing(false)
      onClose()
    } catch (err: any) {
      setIsProcessing(false)
      setErrorMessage(err.message || 'Local path scan failed.')
    } finally {
      abortControllerRef.current = null
    }
  }

  const handleStopScan = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
  }

  // 3. Reset to Audiophile Demo Catalog
  const handleResetCatalog = async () => {
    await storagePersistence.clearLibrary()
    onResetToDemo()
    onClose()
  }


  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#12151D] border border-white/[0.12] rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col glow-cyan animate-in fade-in zoom-in-95 duration-150">
        {/* Hidden directory input */}
        <input
          ref={fileInputRef}
          type="file"
          // @ts-ignore
          webkitdirectory=""
          directory=""
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />

        {/* Modal Header */}
        <div className="p-4 px-6 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-gradient-to-br from-[#00F5FF]/30 to-[#8B5CF6]/30 border border-[#00F5FF]/40 text-[#00F5FF]">
              <FolderPlus className="w-5 h-5 text-[#ADFF2F]" />
            </div>
            <div className="flex flex-col text-left">
              <h2 className="text-base font-bold text-[#F1F5F9] flex items-center gap-2">
                Import Music Library
                <span className="text-[10px] font-mono font-normal px-2 py-0.5 rounded-full bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/30">
                  Native & Network UNC
                </span>
              </h2>
              <span className="text-[11px] font-mono text-[#64748B]">
                Parse high-res audio tags, artwork & sidecars across local disks or NAS shares
              </span>
            </div>
          </div>
          {!isProcessing ? (
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          ) : (
            <button
              onClick={handleStopScan}
              title="Stop scanning and keep ingested tracks"
              className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 text-xs font-mono transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              <span>Stop & Keep</span>
            </button>
          )}
        </div>

        {/* Modal Body */}
        <div className="p-6 flex flex-col gap-5 text-left">
          {!isProcessing ? (
            <>
              {/* PRIMARY ACTION: BROWSE OR DRAG & DROP HERO CARD */}
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setIsDragOver(true)
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
                onClick={handleBrowseFolder}
                className={`p-6 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center text-center cursor-pointer transition-all ${
                  isDragOver
                    ? 'border-[#00F5FF] bg-[#00F5FF]/10 scale-[1.01]'
                    : 'border-[#00F5FF]/40 hover:border-[#00F5FF] bg-[#00F5FF]/[0.03] hover:bg-[#00F5FF]/[0.07]'
                }`}
              >
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#00F5FF]/20 to-[#8B5CF6]/20 border border-[#00F5FF]/30 text-[#00F5FF] flex items-center justify-center mb-2.5 shadow-md">
                  <FolderOpen className="w-6 h-6 text-[#00F5FF]" />
                </div>
                <h3 className="text-sm font-bold text-white mb-1 flex items-center gap-1.5">
                  <span>Browse & Choose Music Folder</span>
                  <span className="text-xs text-[#00F5FF]">📁</span>
                </h3>
                <p className="text-xs text-[#94A3B8] max-w-md leading-relaxed">
                  Click to open your system directory picker to choose your library folder, or drag and drop any folder directly here.
                </p>
              </div>

              {/* DIRECT PATH INPUT WITH INTEGRATED BROWSE BUTTON */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs font-mono text-[#94A3B8] flex-wrap gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white/90">Selected Directory / Network UNC Path:</span>
                    {primaryMount && (
                      <span className="inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-mono">
                        <HardDrive className="w-3 h-3 text-emerald-400" />
                        <span className="truncate max-w-[220px]">
                          Active: {primaryMount.name || primaryMount.mountPath}
                        </span>
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-[#64748B]">Auto-detects FLAC, WAV, DSF, DFF, MP3, AAC</span>
                </div>

                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={localPath}
                      onChange={(e) => setLocalPath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') startLocalPathScan()
                      }}
                      placeholder="e.g. \\NAS\Music\Master or E:\Music"
                      className="w-full bg-[#161A26] border border-white/[0.12] rounded-xl px-3.5 py-2.5 text-xs font-mono text-[#00F5FF] focus:outline-none focus:border-[#00F5FF] pr-24 shadow-inner"
                    />
                    <button
                      type="button"
                      onClick={handleBrowseFolder}
                      className="absolute right-1.5 top-1.5 bottom-1.5 px-3 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] text-white text-xs font-mono flex items-center gap-1 transition-all cursor-pointer border border-white/[0.08]"
                      title="Open file dialog to browse folders"
                    >
                      <Folder className="w-3.5 h-3.5 text-[#00F5FF]" />
                      <span>Browse...</span>
                    </button>
                  </div>

                  <button
                    onClick={() => startLocalPathScan()}
                    className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#00F5FF] to-[#ADFF2F] text-black font-mono font-bold text-xs hover:brightness-110 transition-all flex items-center gap-1.5 shadow-lg shadow-[#00F5FF]/20 cursor-pointer shrink-0"
                  >
                    <Sparkles className="w-4 h-4 text-black" />
                    <span>Scan & Ingest</span>
                  </button>
                </div>

                {/* Quick Selection Presets */}
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  <span className="text-[10px] font-mono text-[#64748B]">Quick Paths:</span>
                  {quickPresets.map((preset, idx) => (
                    <button
                      key={idx}
                      onClick={() => setLocalPath(preset.path)}
                      className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-[#94A3B8] hover:text-[#00F5FF] border border-white/[0.06] transition-colors cursor-pointer"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* AUDIOPHILE SCAN BEHAVIOR DURING PLAYBACK POLICY */}
              <div className="flex flex-col gap-2 p-3 rounded-xl bg-white/[0.02] border border-white/[0.08]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-mono text-white/90">
                    <ShieldCheck className="w-3.5 h-3.5 text-[#00F5FF]" />
                    <span className="font-semibold">Scan Behavior During Playback:</span>
                  </div>
                  <span className="text-[10px] font-mono text-[#64748B]">
                    SMB/UNC & Local I/O Purity
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => handlePolicyChange('purist')}
                    className={`p-2.5 rounded-lg border text-left transition-all cursor-pointer flex flex-col gap-1 ${
                      playbackPolicy === 'purist'
                        ? 'bg-emerald-500/10 border-emerald-500/50 text-white shadow-sm shadow-emerald-500/10'
                        : 'bg-[#161A26] border-white/[0.06] text-[#94A3B8] hover:border-white/[0.15]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold flex items-center gap-1">
                        <span className={playbackPolicy === 'purist' ? 'text-emerald-400' : 'text-[#64748B]'}>●</span>
                        Purist
                      </span>
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 font-mono">0 Noise</span>
                    </div>
                    <span className="text-[10px] text-[#64748B] leading-tight">
                      Auto-suspends when music is playing. Resumes when stopped.
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handlePolicyChange('paced')}
                    className={`p-2.5 rounded-lg border text-left transition-all cursor-pointer flex flex-col gap-1 ${
                      playbackPolicy === 'paced'
                        ? 'bg-[#00F5FF]/10 border-[#00F5FF]/50 text-white shadow-sm shadow-[#00F5FF]/10'
                        : 'bg-[#161A26] border-white/[0.06] text-[#94A3B8] hover:border-white/[0.15]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold flex items-center gap-1">
                        <span className={playbackPolicy === 'paced' ? 'text-[#00F5FF]' : 'text-[#64748B]'}>●</span>
                        Paced
                      </span>
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-[#00F5FF]/20 text-[#00F5FF] font-mono">15ms Sleep</span>
                    </div>
                    <span className="text-[10px] text-[#64748B] leading-tight">
                      15ms inter-file sleep during playback prevents NIC bursts.
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handlePolicyChange('unthrottled')}
                    className={`p-2.5 rounded-lg border text-left transition-all cursor-pointer flex flex-col gap-1 ${
                      playbackPolicy === 'unthrottled'
                        ? 'bg-amber-500/10 border-amber-500/50 text-white shadow-sm shadow-amber-500/10'
                        : 'bg-[#161A26] border-white/[0.06] text-[#94A3B8] hover:border-white/[0.15]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold flex items-center gap-1">
                        <span className={playbackPolicy === 'unthrottled' ? 'text-amber-400' : 'text-[#64748B]'}>●</span>
                        Unthrottled
                      </span>
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-400 font-mono">Full Speed</span>
                    </div>
                    <span className="text-[10px] text-[#64748B] leading-tight">
                      Full background speed regardless of playback state.
                    </span>
                  </button>
                </div>
              </div>

              {/* EXISTING IMPORTED DIRECTORIES & MOUNTS */}
              {activeWatchedFolders && activeWatchedFolders.length > 0 && (
                <div className="flex flex-col gap-2.5 pt-3 border-t border-white/[0.08]">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="font-semibold text-white/90 flex items-center gap-1.5">
                      <Folder className="w-3.5 h-3.5 text-[#00F5FF]" />
                      Existing Imported Directories ({activeWatchedFolders.length})
                    </span>
                    {onOpenStorageManager && (
                      <button
                        type="button"
                        onClick={onOpenStorageManager}
                        className="text-[11px] text-[#00F5FF] hover:underline flex items-center gap-1 transition-colors cursor-pointer"
                      >
                        <SlidersHorizontal className="w-3 h-3" />
                        <span>Storage Manager Cockpit</span>
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 max-h-56 overflow-y-auto pr-1">
                    {activeWatchedFolders.map((wf) => {
                      const associatedMount = activeMounts.find((m) => {
                        if (m.id === wf.mountId) return true
                        const normMount = m.mountPath.replace(/\//g, '\\').toLowerCase().trim()
                        const normWf = wf.folderPath.replace(/\//g, '\\').toLowerCase().trim()
                        return normWf.startsWith(normMount)
                      })
                      const isOffline = associatedMount?.status === 'offline'
                      const isUnc = wf.folderPath.startsWith('\\\\') || wf.folderPath.startsWith('//')
                      const isSelected = localPath.trim().toLowerCase() === wf.folderPath.trim().toLowerCase()

                      return (
                        <div
                          key={wf.id}
                          className={`p-3 rounded-xl border transition-all flex items-center justify-between gap-3 ${
                            isSelected
                              ? 'bg-[#00F5FF]/10 border-[#00F5FF]/50 shadow-sm shadow-[#00F5FF]/10'
                              : 'bg-[#161A26] border-white/[0.08] hover:border-white/[0.18]'
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div
                              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
                                isOffline
                                  ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                                  : 'bg-[#00F5FF]/10 border-[#00F5FF]/20 text-[#00F5FF]'
                              }`}
                            >
                              {isUnc ? (
                                <Server className="w-4 h-4" />
                              ) : (
                                <HardDrive className="w-4 h-4" />
                              )}
                            </div>

                            <div className="min-w-0 flex flex-col text-left">
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-xs text-white truncate max-w-[280px]">
                                  {wf.displayName || wf.folderPath.split(/[/\\]/).filter(Boolean).pop()}
                                </span>
                                {isOffline ? (
                                  <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                    Offline
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                    Online
                                  </span>
                                )}
                                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-white/[0.06] text-[#ADFF2F] border border-white/[0.08]">
                                  {wf.trackCount != null ? `${wf.trackCount} Tracks` : 'Monitored'}
                                </span>
                              </div>

                              <span
                                className="text-[10px] font-mono text-[#94A3B8] truncate max-w-[380px]"
                                title={wf.folderPath}
                              >
                                {wf.folderPath}
                              </span>

                              {associatedMount && (
                                <span className="text-[9px] font-mono text-[#64748B] truncate">
                                  Mount: {associatedMount.name} ({associatedMount.fileSystem})
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => setLocalPath(wf.folderPath)}
                              className={`px-2.5 py-1 rounded-lg text-[10px] font-mono transition-all cursor-pointer border ${
                                isSelected
                                  ? 'bg-[#00F5FF]/20 text-[#00F5FF] border-[#00F5FF]/40'
                                  : 'bg-white/[0.04] hover:bg-white/[0.08] text-[#94A3B8] hover:text-white border-white/[0.08]'
                              }`}
                              title="Set as active target in input"
                            >
                              {isSelected ? 'Active' : 'Select'}
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                setLocalPath(wf.folderPath)
                                startLocalPathScan(wf.folderPath)
                              }}
                              className="px-2.5 py-1 rounded-lg bg-[#00F5FF]/10 hover:bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/30 text-[10px] font-mono flex items-center gap-1 transition-all cursor-pointer"
                              title="Trigger immediate rescan of this folder"
                            >
                              <RotateCw className="w-3 h-3" />
                              <span>Rescan</span>
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          ) : (
            /* ACTIVE INGESTION / PROGRESS DISPLAY */
            <div className="flex flex-col gap-4 p-4 rounded-2xl bg-[#161A26] border border-white/[0.08] animate-in fade-in duration-150">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#00F5FF]/15 text-[#00F5FF] flex items-center justify-center">
                    <Loader2 className="w-5 h-5 animate-spin" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-bold text-white">
                      {progress?.status === 'complete' ? 'Import Complete!' : 'Ingesting Audio Library...'}
                    </span>
                    <span className="text-xs font-mono text-[#00F5FF] truncate max-w-sm">
                      {progress?.currentFileName || 'Processing audio files...'}
                    </span>
                  </div>
                </div>

                {progress?.totalFiles ? (
                  <span className="font-mono text-xs font-bold text-white bg-black/40 px-2.5 py-1 rounded-lg border border-white/[0.08]">
                    {progress.processedFiles} / {progress.totalFiles}
                  </span>
                ) : (
                  <span className="font-mono text-xs text-[#ADFF2F] bg-[#ADFF2F]/10 px-2.5 py-1 rounded-lg border border-[#ADFF2F]/30">
                    {progress?.discoveredTracks || 0} tracks scanned
                  </span>
                )}
              </div>

              {/* Progress Bar */}
              <div className="w-full h-2 bg-black/40 rounded-full overflow-hidden border border-white/[0.06]">
                <div
                  className="h-full bg-gradient-to-r from-[#00F5FF] via-[#8B5CF6] to-[#ADFF2F] transition-all duration-150 rounded-full"
                  style={{
                    width: progress?.totalFiles
                      ? `${Math.round((progress.processedFiles / progress.totalFiles) * 100)}%`
                      : '100%',
                  }}
                />
              </div>

              {/* Live Statistics Strip */}
              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-white/[0.06] text-xs font-mono">
                <div className="flex flex-col p-2 rounded-lg bg-black/30">
                  <span className="text-[10px] text-[#64748B]">Tracks Discovered</span>
                  <span className="text-sm font-bold text-white">{progress?.discoveredTracks || 0}</span>
                </div>
                <div className="flex flex-col p-2 rounded-lg bg-black/30">
                  <span className="text-[10px] text-[#64748B]">Albums Formed</span>
                  <span className="text-sm font-bold text-[#00F5FF]">{progress?.discoveredReleases || 0}</span>
                </div>
                <div className="flex flex-col p-2 rounded-lg bg-black/30">
                  <span className="text-[10px] text-[#64748B]">Works & Hierarchies</span>
                  <span className="text-sm font-bold text-[#ADFF2F]">{progress?.discoveredWorks || 0}</span>
                </div>
              </div>
            </div>
          )}

          {/* Error Banner */}
          {errorMessage && (
            <div className="p-3 px-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs font-mono text-rose-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 px-6 border-t border-white/[0.08] flex items-center justify-between bg-white/[0.02] text-xs font-mono text-[#64748B]">
          <button
            onClick={handleResetCatalog}
            disabled={isProcessing}
            className="text-[#64748B] hover:text-amber-400 flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Reset to sample classical/audiophile demo catalog"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset to Demo Catalog</span>
          </button>

          <button
            onClick={onClose}
            disabled={isProcessing}
            className="px-4 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-white transition-all cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
