import React, { useCallback, useEffect, useState } from 'react'
import {
  X,
  HardDrive,
  FolderPlus,
  RotateCw,
  RefreshCw,
  Trash2,
  Folder,
  Server,
  Clock,
} from 'lucide-react'
import { StorageMount, WatchedFolder } from '../../core/types'
import type {
  EngineFolderRecord,
  EngineNetworkShareRecord,
  EngineScanStatus,
  EngineSmbSupportStatus,
} from '../../core/coreProtocol'
import { useOptionalEngineController } from '../../context/EngineControllerContext'
import { EngineFolderBrowser } from '../Engine/EngineFolderBrowser'
import { formatEngineDisplayPath, isSmbBackedPath } from '../../utils/enginePathDisplay'

interface StorageManagerModalProps {
  isOpen: boolean
  onClose: () => void
  mounts: StorageMount[]
  watchedFolders: WatchedFolder[]
  totalTracksCount: number
  isCoreEngineActive?: boolean
  activeEngineLabel?: string
  onSwitchToLocalEngine?: () => void
  onRefreshLibrary: () => void
  onTriggerScan: (folderPath: string, forceFull?: boolean) => void
  onToggleMountLock: (mountId: string) => void
  onToggleMountStatus: (mountId: string, currentStatus: string) => void
  showToast: (msg: string) => void
}

export const StorageManagerModal: React.FC<StorageManagerModalProps> = ({
  isOpen,
  onClose,
  watchedFolders,
  totalTracksCount,
  activeEngineLabel = 'Playback Engine',
  onRefreshLibrary,
  showToast,
}) => {
  const engine = useOptionalEngineController()
  const engineClient = engine?.engineClient ?? null

  const [engineFolders, setEngineFolders] = useState<EngineFolderRecord[]>([])
  const [scanStatus, setScanStatus] = useState<EngineScanStatus | null>(null)
  const [smbSupport, setSmbSupport] = useState<EngineSmbSupportStatus | null>(null)
  const [smbShares, setSmbShares] = useState<EngineNetworkShareRecord[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isAddingFolder, setIsAddingFolder] = useState(false)
  const [isAddingSmb, setIsAddingSmb] = useState(false)
  const [isMountingSmb, setIsMountingSmb] = useState(false)
  const [smbServer, setSmbServer] = useState('')
  const [smbShare, setSmbShare] = useState('')
  const [smbUsername, setSmbUsername] = useState('')
  const [smbPassword, setSmbPassword] = useState('')
  const [smbVersion, setSmbVersion] = useState('auto')
  const [smbReadOnly, setSmbReadOnly] = useState(true)
  const [smbDisplayName, setSmbDisplayName] = useState('')
  const [smbError, setSmbError] = useState<string | null>(null)

  const refreshEngineStorage = useCallback(async () => {
    if (!engineClient) return
    setIsLoading(true)
    try {
      const [folders, status, support, shares] = await Promise.all([
        engineClient.listFolders().catch(() => []),
        engineClient.getScanStatus().catch(() => null),
        engineClient.getSmbStatus().catch(() => null),
        engineClient.listSmbShares().catch(() => []),
      ])
      setEngineFolders(folders)
      setScanStatus(status)
      setSmbSupport(support)
      setSmbShares(shares)
    } finally {
      setIsLoading(false)
    }
  }, [engineClient])

  useEffect(() => {
    setEngineFolders([])
    setScanStatus(null)
    setSmbSupport(null)
    setSmbShares([])
    setIsAddingFolder(false)
    setIsAddingSmb(false)
    setSmbError(null)
  }, [engineClient])

  useEffect(() => {
    if (isOpen && engineClient) {
      void refreshEngineStorage()
    }
  }, [isOpen, engineClient, refreshEngineStorage])

  useEffect(() => {
    if (!isOpen || !engine) return
    return engine.subscribeEngineEvents((ev) => {
      if (ev.event === 'scan.progress' && ev.data && typeof ev.data === 'object') {
        const next = ev.data as unknown as EngineScanStatus
        if (typeof next.status !== 'string') return
        const isTerminal = next.status === 'completed' || next.status === 'failed'
        const processed = typeof next.processed === 'number' ? next.processed : 0
        if (isTerminal || processed % 25 === 0) {
          setScanStatus(next)
        }
        if (isTerminal) {
          void refreshEngineStorage()
          onRefreshLibrary()
        }
      } else if (ev.event === 'catalog.changed') {
        void refreshEngineStorage()
      }
    })
  }, [isOpen, engine, refreshEngineStorage, onRefreshLibrary])

  if (!isOpen) return null

  const handleScanFolder = async (folderId?: string, forceFull = false) => {
    if (!engineClient) return
    try {
      const next = await engineClient.scanFolders({ folderId, forceFull })
      setScanStatus(next)
      showToast(forceFull ? 'Full rescan queued on Engine.' : 'Quick rescan queued on Engine.')
      onRefreshLibrary()
    } catch (err: any) {
      showToast(err?.message || 'Could not queue Engine scan.')
    }
  }

  const handleRemoveFolder = async (folderId: string, displayName: string) => {
    if (!engineClient) return
    if (!confirm(`Remove watched folder "${displayName}" from Engine monitoring?`)) return
    try {
      await engineClient.removeFolder(folderId)
      showToast(`Removed watched folder "${displayName}"`)
      await refreshEngineStorage()
      onRefreshLibrary()
    } catch (err: any) {
      showToast(err?.message || 'Could not remove folder.')
    }
  }

  const handleMountSmb = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!engineClient || !smbServer.trim() || !smbShare.trim()) return
    setIsMountingSmb(true)
    setSmbError(null)
    try {
      const mounted = await engineClient.addSmbShare({
        server: smbServer.trim(),
        share: smbShare.trim(),
        username: smbUsername.trim() || undefined,
        password: smbPassword || undefined,
        smbVersion,
        readOnly: smbReadOnly,
        displayName: smbDisplayName.trim() || undefined,
      })
      showToast(`Mounted SMB share "${mounted.displayName}".`)
      setSmbServer('')
      setSmbShare('')
      setSmbUsername('')
      setSmbPassword('')
      setSmbDisplayName('')
      setSmbError(null)
      setIsAddingSmb(false)
      setIsAddingFolder(true)
      await refreshEngineStorage()
    } catch (err: any) {
      const msg = err?.message || 'Failed to mount SMB share.'
      setSmbError(msg)
      showToast(msg)
    } finally {
      setIsMountingSmb(false)
    }
  }

  const handleRemoveSmb = async (shareId: string, name: string) => {
    if (!engineClient) return
    if (!confirm(`Unmount and remove SMB share "${name}"?`)) return
    try {
      await engineClient.removeSmbShare(shareId)
      showToast(`Unmounted SMB share "${name}".`)
      await refreshEngineStorage()
    } catch (err: any) {
      showToast(err?.message || 'Could not remove SMB share.')
    }
  }

  const displayedFolders: EngineFolderRecord[] =
    engineFolders.length > 0
      ? engineFolders
      : watchedFolders.map((wf) => ({
          id: wf.id,
          path: wf.folderPath,
          displayName: wf.displayName,
          scanMode: wf.scanMode,
          lastScannedAt: wf.lastScannedTimestamp ?? null,
          trackCount: wf.trackCount ?? 0,
          online: true,
        }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div className="w-full max-w-4xl max-h-[85vh] rounded-2xl border border-white/[0.12] bg-[#0E1017] shadow-2xl flex flex-col text-white overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between bg-[#12151E]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#D4AF37]/15 border border-[#D4AF37]/30 flex items-center justify-center text-[#D4AF37]">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-wide">
                Engine Storage & Library Folders
              </h2>
              <p className="text-xs text-white/55">
                Active Engine: <strong className="text-white">{activeEngineLabel}</strong>
                {engine?.state.musicReadOnly === true && (
                  <>
                    {' · '}
                    <span
                      className="font-medium text-amber-300 cursor-help underline decoration-amber-400/40 decoration-dotted underline-offset-2"
                      title="Curate tag writing requires mounting the media volume read-write (:rw), setting CADENCE_MUSIC_READ_ONLY=false, and granting UID/GID 568:568 write access on the Engine host."
                    >
                      Read-Only Media Mount
                    </span>
                  </>
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Telemetry Bar */}
        <div className="px-6 py-3 bg-white/[0.02] border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-3 text-xs text-white/70">
          <div className="flex items-center gap-6">
            <div>
              <span className="text-white/40 mr-1.5">Indexed Tracks:</span>
              <span className="font-mono font-semibold text-[#D4AF37]">
                {totalTracksCount.toLocaleString()}
              </span>
            </div>
            <div>
              <span className="text-white/40 mr-1.5">Watched Roots:</span>
              <span className="font-mono font-semibold text-white">
                {displayedFolders.length}
              </span>
            </div>
            {scanStatus && (
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-white/40" />
                <span className="text-white/40">Scan:</span>
                <span className="font-mono text-white">
                  {scanStatus.status}
                  {typeof scanStatus.processed === 'number' && scanStatus.processed > 0
                    ? ` (${scanStatus.processed})`
                    : ''}
                  {scanStatus.deferred ? ' · paused during playback/cooldown' : ''}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void refreshEngineStorage()
                onRefreshLibrary()
              }}
              disabled={isLoading || !engineClient}
              className="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/80 font-medium text-xs flex items-center gap-1.5 transition-colors border border-white/[0.08] cursor-pointer disabled:opacity-40"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={() => void handleScanFolder(undefined, false)}
              disabled={!engineClient || displayedFolders.length === 0}
              className="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/80 font-medium text-xs flex items-center gap-1.5 transition-colors border border-white/[0.08] cursor-pointer disabled:opacity-40"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>Scan All</span>
            </button>
            {smbSupport?.supported !== false && (
              <button
                type="button"
                onClick={() => setIsAddingSmb((prev) => !prev)}
                disabled={!engineClient}
                className="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-40 text-white/85 font-medium text-xs flex items-center gap-1.5 transition-colors border border-white/[0.08] cursor-pointer"
              >
                <Server className="w-3.5 h-3.5 text-[#D4AF37]" />
                <span>{isAddingSmb ? 'Hide SMB Form' : 'Add SMB Share'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setIsAddingFolder((prev) => !prev)}
              disabled={!engineClient}
              className="px-3 py-1.5 rounded-lg bg-[#D4AF37] hover:bg-[#E0BE52] disabled:opacity-40 text-black font-semibold text-xs flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>{isAddingFolder ? 'Hide Browser' : 'Browse & Add Folder'}</span>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {isAddingSmb && smbSupport?.supported !== false && engineClient && (
            <form
              onSubmit={(e) => void handleMountSmb(e)}
              className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#D4AF37]">
                  Mount Network SMB Share
                </h3>
                <button
                  type="button"
                  onClick={() => setIsAddingSmb(false)}
                  className="text-xs text-white/50 hover:text-white cursor-pointer"
                >
                  Close
                </button>
              </div>
              {smbSupport && !smbSupport.supported && (
                <p className="text-[11px] text-amber-300/90">
                  {smbSupport.reason ||
                    'Runtime SMB mounting requires root (--user 0:0), CAP_SYS_ADMIN, CAP_DAC_READ_SEARCH, and cifs-utils.'}
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <input
                  type="text"
                  value={smbServer}
                  onChange={(e) => setSmbServer(e.target.value)}
                  placeholder="Server IP / Hostname (e.g. 192.168.1.10)"
                  required
                  className="rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-white placeholder-white/30 font-mono focus:border-[#D4AF37]/50 focus:outline-none"
                />
                <input
                  type="text"
                  value={smbShare}
                  onChange={(e) => setSmbShare(e.target.value)}
                  placeholder="Share Name (e.g. Music/Lossless)"
                  required
                  className="rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-white placeholder-white/30 font-mono focus:border-[#D4AF37]/50 focus:outline-none"
                />
                <input
                  type="text"
                  value={smbUsername}
                  onChange={(e) => setSmbUsername(e.target.value)}
                  placeholder="Username (leave blank for guest)"
                  className="rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-white placeholder-white/30 focus:border-[#D4AF37]/50 focus:outline-none"
                />
                <input
                  type="password"
                  value={smbPassword}
                  onChange={(e) => setSmbPassword(e.target.value)}
                  placeholder="Password (optional)"
                  className="rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-white placeholder-white/30 focus:border-[#D4AF37]/50 focus:outline-none"
                />
                <input
                  type="text"
                  value={smbDisplayName}
                  onChange={(e) => setSmbDisplayName(e.target.value)}
                  placeholder="Display Name (optional)"
                  className="rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-white placeholder-white/30 focus:border-[#D4AF37]/50 focus:outline-none"
                />
                <div className="flex items-center gap-3">
                  <select
                    value={smbVersion}
                    onChange={(e) => setSmbVersion(e.target.value)}
                    aria-label="SMB Version"
                    className="rounded-lg border border-white/10 bg-black/50 px-2.5 py-2 text-white focus:border-[#D4AF37]/50 focus:outline-none"
                  >
                    {(smbSupport?.versions ?? ['auto', '3.1.1', '3.0', '2.1', '2.0', '1.0']).map(
                      (v) => (
                        <option key={v} value={v}>
                          SMB {v}
                        </option>
                      ),
                    )}
                  </select>
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-white/75 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={smbReadOnly}
                      onChange={(e) => setSmbReadOnly(e.target.checked)}
                      className="rounded border-white/20 bg-black/40 accent-[#D4AF37]"
                    />
                    <span>Read-Only</span>
                  </label>
                </div>
              </div>
              {smbError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-mono text-red-300 break-words">
                  {smbError}
                </div>
              )}
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={
                    isMountingSmb ||
                    !smbServer.trim() ||
                    !smbShare.trim()
                  }
                  className="px-3.5 py-1.5 rounded-lg bg-[#D4AF37] hover:bg-[#E0BE52] disabled:opacity-40 text-black font-semibold text-xs cursor-pointer"
                >
                  {isMountingSmb ? 'Mounting…' : 'Mount SMB Share'}
                </button>
              </div>
            </form>
          )}

          {smbShares.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-white/50 flex items-center gap-2 mb-3">
                <Server className="w-3.5 h-3.5" />
                <span>SMB Network Shares ({smbShares.length})</span>
              </h3>
              <div className="space-y-2">
                {smbShares.map((s) => (
                  <div
                    key={s.id}
                    className="p-3 rounded-xl border border-white/[0.06] bg-white/[0.02] flex items-center justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs text-white truncate">
                          {s.displayName}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            s.mounted
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-amber-500/20 text-amber-300'
                          }`}
                        >
                          {s.mounted ? 'Mounted' : 'Offline'}
                        </span>
                        <span className="text-[10px] text-white/45 font-mono">
                          {s.readOnly ? 'ro' : 'rw'}
                          {s.smbVersion ? ` · SMB ${s.smbVersion}` : ''}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-white/40 truncate">
                        //{s.server}/{s.share}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRemoveSmb(s.id, s.displayName)}
                      title="Unmount and remove SMB share"
                      className="p-1.5 rounded-lg bg-white/[0.03] hover:bg-rose-500/20 hover:text-rose-300 text-white/40 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isAddingFolder && engineClient && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#D4AF37]">
                  Browse Engine Storage
                </h3>
                <button
                  type="button"
                  onClick={() => setIsAddingFolder(false)}
                  className="text-xs text-white/50 hover:text-white cursor-pointer"
                >
                  Close browser
                </button>
              </div>
              <EngineFolderBrowser
                engineClient={engineClient}
                smbShares={smbShares}
                showToast={showToast}
                onFolderAdded={() => {
                  void refreshEngineStorage()
                  onRefreshLibrary()
                }}
              />
            </div>
          )}

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-white/50 flex items-center gap-2 mb-3">
              <Folder className="w-3.5 h-3.5" />
              <span>Engine Watched Roots ({displayedFolders.length})</span>
            </h3>

            {displayedFolders.length === 0 ? (
              <div className="p-6 rounded-xl border border-dashed border-white/[0.1] text-center text-white/45 text-xs">
                No Engine library folders added yet. Click &ldquo;Browse &amp; Add Folder&rdquo; to select music roots on {activeEngineLabel}.
              </div>
            ) : (
              <div className="space-y-2">
                {displayedFolders.map((f) => (
                  <div
                    key={f.id}
                    className={`p-3.5 rounded-xl border transition-all flex items-center justify-between gap-4 ${
                      !f.online
                        ? 'bg-amber-500/[0.03] border-amber-500/20 text-white/60'
                        : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.15]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-white/[0.05] text-white/75">
                        {isSmbBackedPath(f.path, smbShares) ? (
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
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              f.online
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-amber-500/20 text-amber-300'
                            }`}
                          >
                            {f.online ? 'Online' : 'Offline'}
                          </span>
                          <span className="text-[10px] text-white/45 font-mono">
                            {f.trackCount.toLocaleString()} tracks · {f.scanMode}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-white/40 truncate">
                          {formatEngineDisplayPath(f.path, smbShares)}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleScanFolder(f.id, false)}
                        disabled={!f.online || !engineClient}
                        className="px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-[#D4AF37]/15 hover:text-[#D4AF37] disabled:opacity-30 text-xs font-medium text-white/75 transition-colors flex items-center gap-1.5 cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Quick Rescan</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleScanFolder(f.id, true)}
                        disabled={!f.online || !engineClient}
                        className="px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] disabled:opacity-30 text-xs font-medium text-white/60 hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
                      >
                        <RotateCw className="w-3.5 h-3.5" />
                        <span>Full Rescan</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRemoveFolder(f.id, f.displayName)}
                        disabled={!engineClient}
                        title="Remove folder from monitoring"
                        className="p-1.5 rounded-lg bg-white/[0.03] hover:bg-rose-500/20 hover:text-rose-300 text-white/40 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-[#12151E] border-t border-white/[0.08] flex items-center justify-end text-xs">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-white/[0.08] hover:bg-white/[0.12] text-white font-medium transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
