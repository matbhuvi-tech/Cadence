import React, { useState, useRef } from 'react'
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
} from 'lucide-react'
import { libraryImporter, IngestionProgress, IngestionResult } from '../../services/libraryImporter'
import { storagePersistence } from '../../core/storagePersistence'
import { tauriBridge } from '../../services/tauriBridge'

interface ImportLibraryModalProps {
  isOpen: boolean
  onClose: () => void
  onImportComplete: (result: IngestionResult, isCustom: boolean, isStreaming?: boolean) => void
  onResetToDemo: () => void
  isCustomLibraryActive: boolean
}

export const ImportLibraryModal: React.FC<ImportLibraryModalProps> = ({
  isOpen,
  onClose,
  onImportComplete,
  onResetToDemo,
  isCustomLibraryActive,
}) => {
  const [localPath, setLocalPath] = useState('\\\\192.168.1.3\\Mathan\\Music Collection\\Master')
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
          // Automatically trigger scan for selected directory
          startLocalPathScan(selected)
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

  const quickPresets = [
    { label: 'Master Collection', path: '\\\\192.168.1.3\\Mathan\\Music Collection\\Master' },
    { label: 'Hindi Master (A R Rahman)', path: '\\\\192.168.1.3\\Mathan\\Music Collection\\Master\\Hindi\\A R Rahman' },
    { label: 'Tamil Master (Ilaiyaraaja)', path: '\\\\192.168.1.3\\Mathan\\Music Collection\\Master\\Tamil\\Ilaiyaraaja' },
  ]

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
                <div className="flex items-center justify-between text-xs font-mono text-[#94A3B8]">
                  <span className="font-semibold text-white/90">Selected Directory / Network UNC Path:</span>
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
