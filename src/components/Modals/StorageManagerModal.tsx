import React, { useState } from 'react'
import {
  X,
  HardDrive,
  FolderPlus,
  RotateCw,
  RefreshCw,
  Trash2,
  Lock,
  Unlock,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Folder,
  Server,
  Activity,
  SlidersHorizontal,
} from 'lucide-react'
import { StorageMount, WatchedFolder } from '../../core/types'
import { tauriBridge } from '../../services/tauriBridge'

interface StorageManagerModalProps {
  isOpen: boolean
  onClose: () => void
  mounts: StorageMount[]
  watchedFolders: WatchedFolder[]
  totalTracksCount: number
  onRefreshLibrary: () => void
  onTriggerScan: (folderPath: string, forceFull?: boolean) => void
  onToggleMountLock: (mountId: string) => void
  onToggleMountStatus: (mountId: string, currentStatus: string) => void
  showToast: (msg: string) => void
}

export const StorageManagerModal: React.FC<StorageManagerModalProps> = ({
  isOpen,
  onClose,
  mounts,
  watchedFolders,
  totalTracksCount,
  onRefreshLibrary,
  onTriggerScan,
  onToggleMountLock,
  onToggleMountStatus,
  showToast,
}) => {
  const [newFolderPath, setNewFolderPath] = useState('')
  const [isAddingFolder, setIsAddingFolder] = useState(false)
  const [selectedMountForAdd, setSelectedMountForAdd] = useState<string>('')

  if (!isOpen) return null

  const handleBrowseFolder = async () => {
    const selected = await tauriBridge.openDirectoryDialog()
    if (selected) {
      setNewFolderPath(selected)
    }
  }

  const handleAddWatchedFolder = async () => {
    if (!newFolderPath.trim()) return

    const path = newFolderPath.trim()
    const folderName = path.split(/[/\\]/).filter(Boolean).pop() || path

    // Auto-create or select mount
    const matchedMount = mounts.find((m) => path.startsWith(m.mountPath))
    const mountId = matchedMount ? matchedMount.id : selectedMountForAdd || mounts[0]?.id || 'mount-local'

    const newFolder: WatchedFolder = {
      id: `watch-${Date.now()}`,
      mountId,
      folderPath: path,
      displayName: folderName,
      scanMode: 'realtime',
      isEnabled: true,
      lastScannedTimestamp: new Date().toISOString(),
    }

    try {
      await tauriBridge.dbSaveWatchedFolder(newFolder)
      showToast(`Added watched folder "${folderName}". Starting background index...`)
      setNewFolderPath('')
      setIsAddingFolder(false)
      onRefreshLibrary()
      onTriggerScan(path, false)
    } catch (err: any) {
      showToast(`Failed to add watched folder: ${err.message || err}`)
    }
  }

  const handleRemoveFolder = async (folderId: string, displayName: string) => {
    if (confirm(`Remove watched folder "${displayName}" from library monitoring?`)) {
      await tauriBridge.dbRemoveWatchedFolder(folderId)
      showToast(`Removed watched folder "${displayName}"`)
      onRefreshLibrary()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="w-full max-w-4xl max-h-[85vh] rounded-2xl border border-white/[0.12] bg-[#0E1017] shadow-2xl flex flex-col text-white overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between bg-[#12151E]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#00F5FF]/15 border border-[#00F5FF]/30 flex items-center justify-center text-[#00F5FF]">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-wide">
                Library & Storage Management
              </h2>
              <p className="text-xs text-white/50">
                Manage watched roots, network shares, offline storage policies, and SQLite indexing.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Global Catalog Telemetry Bar */}
        <div className="px-6 py-3 bg-white/[0.02] border-b border-white/[0.06] flex items-center justify-between text-xs text-white/70">
          <div className="flex items-center gap-6">
            <div>
              <span className="text-white/40 mr-1.5">Indexed Tracks:</span>
              <span className="font-mono font-semibold text-[#00F5FF]">
                {totalTracksCount.toLocaleString()}
              </span>
            </div>
            <div>
              <span className="text-white/40 mr-1.5">Watched Roots:</span>
              <span className="font-mono font-semibold text-white">
                {watchedFolders.length}
              </span>
            </div>
            <div>
              <span className="text-white/40 mr-1.5">Storage Mounts:</span>
              <span className="font-mono font-semibold text-white">
                {mounts.length}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Native SQLite WAL Active</span>
            </div>
          </div>
          <button
            onClick={() => setIsAddingFolder(true)}
            className="px-3 py-1.5 rounded-lg bg-[#00F5FF] hover:bg-[#00F5FF]/90 text-black font-semibold text-xs flex items-center gap-1.5 transition-all shadow-[0_0_12px_rgba(0,245,255,0.3)]"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            Add Watched Folder
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Add Folder Inline Panel */}
          {isAddingFolder && (
            <div className="p-4 rounded-xl bg-white/[0.03] border border-[#00F5FF]/40 space-y-3 animate-in slide-in-from-top-2 duration-150">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-[#00F5FF] uppercase tracking-wider">
                  Add Storage Location or Watched Folder
                </h4>
                <button
                  onClick={() => setIsAddingFolder(false)}
                  className="text-white/40 hover:text-white text-xs"
                >
                  Cancel
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newFolderPath}
                  onChange={(e) => setNewFolderPath(e.target.value)}
                  placeholder="Local directory (e.g. E:\Music) or Network Share (\\NAS\Music)"
                  className="flex-1 px-3 py-2 rounded-lg bg-black/40 border border-white/[0.12] text-xs text-white placeholder-white/30 focus:outline-none focus:border-[#00F5FF]"
                />
                <button
                  onClick={handleBrowseFolder}
                  className="px-3 py-2 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-xs font-medium text-white transition-colors"
                >
                  Browse...
                </button>
                <button
                  onClick={handleAddWatchedFolder}
                  disabled={!newFolderPath.trim()}
                  className="px-4 py-2 rounded-lg bg-[#00F5FF] hover:bg-[#00F5FF]/90 disabled:opacity-50 text-black font-semibold text-xs transition-colors"
                >
                  Confirm & Scan
                </button>
              </div>
            </div>
          )}

          {/* 1. Watched Folders Section */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-white/50 flex items-center gap-2">
                <Folder className="w-3.5 h-3.5" />
                Monitored Storage Roots ({watchedFolders.length})
              </h3>
            </div>

            {watchedFolders.length === 0 ? (
              <div className="p-6 rounded-xl border border-dashed border-white/[0.1] text-center text-white/40 text-xs">
                No watched folders configured. Click "+ Add Watched Folder" to start importing your library.
              </div>
            ) : (
              <div className="space-y-2">
                {watchedFolders.map((f) => {
                  const associatedMount = mounts.find((m) => m.id === f.mountId)
                  const isOffline = associatedMount?.status === 'offline'

                  return (
                    <div
                      key={f.id}
                      className={`p-3.5 rounded-xl border transition-all flex items-center justify-between gap-4 ${
                        isOffline
                          ? 'bg-amber-500/[0.03] border-amber-500/20 text-white/60'
                          : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.15]'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                            isOffline
                              ? 'bg-amber-500/10 text-amber-400'
                              : 'bg-white/[0.05] text-white/70'
                          }`}
                        >
                          {f.folderPath.startsWith('\\\\') || f.folderPath.startsWith('//') ? (
                            <Server className="w-4 h-4" />
                          ) : (
                            <Folder className="w-4 h-4" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-xs text-white truncate">
                              {f.displayName}
                            </span>
                            {isOffline ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 font-medium">
                                Drive Offline
                              </span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300 font-medium">
                                Watching
                              </span>
                            )}
                            <span className="text-[10px] text-white/40">
                              Mode: {f.scanMode}
                            </span>
                          </div>
                          <div className="text-[11px] font-mono text-white/40 truncate">
                            {f.folderPath}
                          </div>
                        </div>
                      </div>

                      {/* Folder Action Buttons */}
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => onTriggerScan(f.folderPath, false)}
                          disabled={isOffline}
                          title="Quick Rescan: Check timestamps and ingest modified or newly added tracks in <1 sec"
                          className="px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-[#00F5FF]/15 hover:text-[#00F5FF] disabled:opacity-30 text-xs font-medium text-white/70 transition-colors flex items-center gap-1.5"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Quick Rescan
                        </button>
                        <button
                          onClick={() => onTriggerScan(f.folderPath, true)}
                          disabled={isOffline}
                          title="Force Full Rescan: Re-read all audio metadata tags and sidecars from disk"
                          className="px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-30 text-xs font-medium text-white/50 hover:text-white transition-colors flex items-center gap-1"
                        >
                          <RotateCw className="w-3.5 h-3.5" />
                          Full Rescan
                        </button>
                        <button
                          onClick={() => handleRemoveFolder(f.id, f.displayName)}
                          title="Remove folder from monitoring"
                          className="p-1.5 rounded-lg bg-white/[0.03] hover:bg-rose-500/20 hover:text-rose-300 text-white/40 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 2. Physical Storage Mounts & NAS Topology */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-white/50 flex items-center gap-2">
                <HardDrive className="w-3.5 h-3.5" />
                Physical Volumes & Storage Mounts ({mounts.length})
              </h3>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {mounts.map((m) => {
                const usedGb = (m.usedBytes / 1_000_000_000).toFixed(1)
                const totalGb = (m.totalBytes / 1_000_000_000).toFixed(1)
                const usagePercent =
                  m.totalBytes > 0
                    ? Math.round((m.usedBytes / m.totalBytes) * 100)
                    : 0
                const isOnline = m.status !== 'offline'

                return (
                  <div
                    key={m.id}
                    className={`p-4 rounded-xl border transition-all ${
                      isOnline
                        ? 'bg-white/[0.02] border-white/[0.08]'
                        : 'bg-amber-500/[0.02] border-amber-500/20 opacity-75'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            isOnline ? 'bg-emerald-400' : 'bg-amber-400'
                          }`}
                        />
                        <span className="font-semibold text-xs text-white truncate">
                          {m.name}
                        </span>
                        <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-white/[0.06] text-white/60">
                          {m.fileSystem}
                        </span>
                      </div>

                      {/* Mount Status Toggle (Online/Offline simulator for testing ghost-track protection) */}
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => onToggleMountLock(m.id)}
                          title={
                            m.isReadOnlyLocked
                              ? 'Volume is Read-Only Locked'
                              : 'Volume is Read-Write Enabled'
                          }
                          className={`p-1 rounded text-xs transition-colors ${
                            m.isReadOnlyLocked
                              ? 'text-amber-400 bg-amber-500/10'
                              : 'text-white/40 hover:text-white'
                          }`}
                        >
                          {m.isReadOnlyLocked ? (
                            <Lock className="w-3.5 h-3.5" />
                          ) : (
                            <Unlock className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => onToggleMountStatus(m.id, m.status || 'online')}
                          title={
                            isOnline
                              ? 'Click to simulate drive unmount (test ghost track protection)'
                              : 'Click to reconnect drive'
                          }
                          className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                            isOnline
                              ? 'bg-emerald-500/15 text-emerald-300 hover:bg-amber-500/20 hover:text-amber-300'
                              : 'bg-amber-500/20 text-amber-300 hover:bg-emerald-500/20 hover:text-emerald-300'
                          }`}
                        >
                          {isOnline ? 'Online' : 'Offline'}
                        </button>
                      </div>
                    </div>

                    <div className="text-[10px] font-mono text-white/40 truncate mb-3">
                      {m.mountPath}
                    </div>

                    {/* Capacity meter */}
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px] text-white/50">
                        <span>Capacity</span>
                        <span className="font-mono">
                          {usedGb} GB / {totalGb} GB ({usagePercent}%)
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                        <div
                          className={`h-full ${
                            usagePercent > 90
                              ? 'bg-rose-500'
                              : usagePercent > 75
                              ? 'bg-amber-400'
                              : 'bg-[#00F5FF]'
                          }`}
                          style={{ width: `${usagePercent}%` }}
                        />
                      </div>
                    </div>

                    {/* SMART health & temp */}
                    <div className="mt-3 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-white/40">
                      <div className="flex items-center gap-1 text-emerald-400">
                        <ShieldCheck className="w-3 h-3" />
                        <span>SMART: {m.healthScore}</span>
                      </div>
                      <div>Temp: {m.tempCelsius}°C</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 3. Non-Destructive Ghost Track Safety Note */}
          <div className="p-4 rounded-xl bg-blue-500/[0.06] border border-blue-500/20 text-xs text-blue-200/80 flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-blue-300 mb-0.5">
                Non-Destructive Library Integrity Guarantee
              </div>
              <p className="text-[11px] leading-relaxed">
                When external USB drives or NAS shares disconnect, Cadence Core protects your library by flagging records as offline rather than deleting them. All play statistics, dynamic range ratings, and sidecar edits remain safe in SQLite.
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-[#12151E] border-t border-white/[0.08] flex items-center justify-between text-xs">
          <div className="text-white/40">
            Database location: <span className="font-mono text-white/60">%APPDATA%/com.cadence.core/cadence.db</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-white/[0.08] hover:bg-white/[0.12] text-white font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
