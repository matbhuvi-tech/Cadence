import React, { useCallback, useEffect, useState } from 'react'
import {
  Check,
  ChevronRight,
  Folder,
  FolderPlus,
  HardDrive,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import type { EngineFsEntry, EngineNetworkShareRecord } from '../../core/coreProtocol'
import type { EngineClient } from '../../services/engineClient'
import { formatEngineDisplayName, formatEngineDisplayPath } from '../../utils/enginePathDisplay'

interface EngineFolderBrowserProps {
  engineClient: EngineClient
  smbShares?: readonly EngineNetworkShareRecord[]
  onFolderAdded?: (path: string) => void
  showToast?: (msg: string) => void
}

export const EngineFolderBrowser: React.FC<EngineFolderBrowserProps> = ({
  engineClient,
  smbShares = [],
  onFolderAdded,
  showToast,
}) => {
  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined)
  const [history, setHistory] = useState<string[]>([])
  const [entries, setEntries] = useState<EngineFsEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [addingPath, setAddingPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadPath = useCallback(
    async (targetPath?: string) => {
      setIsLoading(true)
      setError(null)
      try {
        const res = await engineClient.fsBrowse(targetPath)
        setEntries(res.entries ?? [])
        setCurrentPath(targetPath)
      } catch (err: any) {
        setError(err?.message || 'Could not browse Engine folders.')
      } finally {
        setIsLoading(false)
      }
    },
    [engineClient],
  )

  useEffect(() => {
    void loadPath(undefined)
  }, [loadPath])

  const handleOpenDir = (entry: EngineFsEntry) => {
    if (!entry.isDir) return
    setHistory((prev) => (currentPath ? [...prev, currentPath] : prev))
    void loadPath(entry.path)
  }

  const handleNavigateBack = (index: number) => {
    if (index < 0) {
      setHistory([])
      void loadPath(undefined)
      return
    }
    const target = history[index]
    setHistory(history.slice(0, index))
    void loadPath(target)
  }

  const handleAddAndScan = async (path: string) => {
    setAddingPath(path)
    setError(null)
    try {
      const fallbackName = path.split(/[/\\]/).filter(Boolean).pop() || path
      const displayName = formatEngineDisplayName(path, fallbackName, smbShares)
      const added = await engineClient.addFolder({
        path,
        displayName,
        scanMode: 'manual',
      })
      await engineClient.scanFolders({ folderId: added.id, forceFull: false })
      showToast?.(`Added "${displayName}" on Engine and queued scan.`)
      onFolderAdded?.(path)
      await loadPath(currentPath)
    } catch (err: any) {
      const msg = err?.message || 'Failed to add or scan folder on Engine.'
      setError(msg)
      showToast?.(msg)
    } finally {
      setAddingPath(null)
    }
  }

  return (
    <div className="rounded-xl border border-white/[0.1] bg-black/35 overflow-hidden flex flex-col">
      {/* Breadcrumb Bar */}
      <div className="px-3.5 py-2.5 border-b border-white/[0.08] bg-white/[0.02] flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 text-xs overflow-x-auto min-w-0">
          <button
            type="button"
            onClick={() => handleNavigateBack(-1)}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-white/75 hover:bg-white/[0.06] hover:text-white cursor-pointer shrink-0"
          >
            <HardDrive className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span>Engine Roots</span>
          </button>
          {history.map((item, idx) => (
            <React.Fragment key={item}>
              <ChevronRight className="w-3.5 h-3.5 text-white/30 shrink-0" />
              <button
                type="button"
                onClick={() => handleNavigateBack(idx)}
                className="rounded px-1.5 py-1 text-white/70 hover:bg-white/[0.06] hover:text-white cursor-pointer truncate max-w-[160px]"
              >
                {formatEngineDisplayName(
                  item,
                  item.split(/[/\\]/).filter(Boolean).pop() || item,
                  smbShares,
                )}
              </button>
            </React.Fragment>
          ))}
          {currentPath && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-white/30 shrink-0" />
              <span className="px-1.5 py-1 font-medium text-white truncate max-w-[180px]">
                {formatEngineDisplayName(
                  currentPath,
                  currentPath.split(/[/\\]/).filter(Boolean).pop() || currentPath,
                  smbShares,
                )}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {currentPath && (
            <button
              type="button"
              disabled={addingPath === currentPath}
              onClick={() => void handleAddAndScan(currentPath)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#D4AF37] px-2.5 py-1 text-[11px] font-semibold text-black hover:bg-[#E0BE52] cursor-pointer disabled:opacity-50"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>Add Current Folder</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadPath(currentPath)}
            disabled={isLoading}
            title="Refresh directory"
            className="p-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/[0.06] cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-3.5 py-2 bg-rose-950/40 border-b border-rose-500/25 text-xs text-rose-200">
          {error}
        </div>
      )}

      {/* Directory Entries */}
      <div className="max-h-64 overflow-y-auto divide-y divide-white/[0.04]">
        {isLoading && entries.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-white/50">
            <Loader2 className="w-4 h-4 animate-spin text-[#D4AF37]" />
            <span>Browsing Engine storage…</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="py-8 text-center text-xs text-white/45">
            No subdirectories in this Engine folder.
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.path}
              className="flex items-center justify-between gap-3 px-3.5 py-2 hover:bg-white/[0.04] transition-colors"
            >
              <button
                type="button"
                onClick={() => handleOpenDir(entry)}
                disabled={!entry.isDir || !entry.readable}
                className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer disabled:opacity-50"
              >
                <Folder className="w-4 h-4 text-[#D4AF37] shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-white truncate">
                    {formatEngineDisplayName(
                      entry.path,
                      entry.name || entry.path,
                      smbShares,
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-white/40 truncate">
                    {formatEngineDisplayPath(entry.path, smbShares)}
                  </div>
                </div>
              </button>

              <div className="flex items-center gap-2 shrink-0">
                {entry.isWatched && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                    <Check className="w-3 h-3" />
                    <span>Watched</span>
                  </span>
                )}
                <button
                  type="button"
                  disabled={addingPath === entry.path || !entry.readable}
                  onClick={() => void handleAddAndScan(entry.path)}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-white/85 hover:bg-white/[0.1] cursor-pointer disabled:opacity-50"
                >
                  {addingPath === entry.path ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <FolderPlus className="w-3 h-3 text-[#D4AF37]" />
                  )}
                  <span>{entry.isWatched ? 'Rescan' : 'Add & Scan'}</span>
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
