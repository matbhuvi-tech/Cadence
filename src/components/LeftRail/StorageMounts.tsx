import React, { useMemo } from 'react'
import { HardDrive, Lock, Unlock, Activity, Cpu, FolderTree, Folder, CheckCircle2, AlertTriangle, X, SlidersHorizontal } from 'lucide-react'
import { StorageMount, Track, Release } from '../../core/types'
import { stripRipNoiseAndTags } from '../../core/taxonomyUtils'

interface StorageMountsProps {
  mounts: StorageMount[]
  tracks?: Track[]
  releases?: Release[]
  onToggleReadOnly: (mountId: string) => void
  selectedMountId?: string
  onSelectMount: (mountId?: string) => void
  selectedFolderFilter?: string
  onSelectFolderFilter?: (folderPath?: string) => void
  onOpenStorageManager?: () => void
}

export const StorageMounts: React.FC<StorageMountsProps> = ({
  mounts,
  tracks = [],
  releases = [],
  onToggleReadOnly,
  selectedMountId,
  onSelectMount,
  selectedFolderFilter,
  onSelectFolderFilter,
  onOpenStorageManager,
}) => {
  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '0 GB'
    if (bytes >= 1024 * 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`
    }
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  // Aggregate physical folder roots and compute per-folder health & counts
  const folderStats = useMemo(() => {
    const map = new Map<
      string,
      {
        folderPath: string
        displayName: string
        albumCount: number
        trackCount: number
        formats: Set<string>
        untaggedCount: number
        uncommittedCount: number
      }
    >()

    const relMap = new Map<string, Release>()
    releases.forEach((r) => relMap.set(r.id, r))

    tracks.forEach((t) => {
      const p = (t.filePath || '').replace(/\\/g, '/')
      const parts = p.split('/').filter(Boolean)
      let albumDirPath = ''
      let displayName = ''

      if (parts.length >= 2) {
        let fName = parts[parts.length - 2]
        let fPath = parts.slice(0, parts.length - 1).join('/')
        
        // Handle nested CD1/Disc 1 folders
        if (/^(cd\s*\d+|disc\s*\d+|disk\s*\d+|side\s*[a-d]|\d+)$/i.test(fName) && parts.length >= 3) {
          fName = parts[parts.length - 3]
          fPath = parts.slice(0, parts.length - 2).join('/')
        }

        albumDirPath = fPath
        const cleanAlbumName = stripRipNoiseAndTags(fName) || fName
        const parentArtistFolder = parts.length >= 3 ? parts[parts.length - 3] : ''
        
        if (
          parentArtistFolder &&
          !/^(master|music|audio|flac|wav|mp3|songs|hindi|tamil|telugu|malayalam|kannada|western|rock|jazz|classical)$/i.test(parentArtistFolder) &&
          parentArtistFolder.toLowerCase() !== cleanAlbumName.toLowerCase()
        ) {
          displayName = `${parentArtistFolder} • ${cleanAlbumName}`
        } else {
          displayName = cleanAlbumName
        }
      } else {
        albumDirPath = t.folderName || 'Local Music'
        displayName = t.folderName || 'Local Music'
      }

      if (!map.has(albumDirPath)) {
        map.set(albumDirPath, {
          folderPath: albumDirPath,
          displayName,
          albumCount: 1,
          trackCount: 0,
          formats: new Set(),
          untaggedCount: 0,
          uncommittedCount: 0,
        })
      }

      const item = map.get(albumDirPath)!
      item.trackCount++
      if (t.format) item.formats.add(t.format)
      const isUntagged = !t.artistCredit || t.artistCredit === 'Unknown Artist'
      if (isUntagged) item.untaggedCount++
      if (t.sidecarStatus === 'uncommitted_sidecar') item.uncommittedCount++
    })

    // Compute distinct release counts per folder
    map.forEach((item, rootDir) => {
      const folderRelIds = new Set(
        tracks
          .filter((t) => (t.filePath || '').replace(/\\/g, '/').startsWith(rootDir))
          .map((t) => t.releaseId)
      )
      item.albumCount = folderRelIds.size || 1
    })

    return Array.from(map.values()).sort((a, b) => b.trackCount - a.trackCount)
  }, [tracks, releases])

  return (
    <div className="bento-card p-3.5 flex flex-col gap-3 bg-[#12151D]/90 border-white/[0.07]">
      {/* Header */}
      <div className="flex items-center justify-between pb-1 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-[#10B981]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
            Storage & Watched Roots
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-[#64748B]">
            {mounts.filter((m) => m.isReadOnlyLocked).length}/{mounts.length} RO
          </span>
          {onOpenStorageManager && (
            <button
              onClick={onOpenStorageManager}
              title="Manage Watched Roots & Storage"
              className="p-1 rounded hover:bg-white/[0.08] text-white/50 hover:text-[#00F5FF] transition-colors"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Mounts List */}
      <div className="flex flex-col gap-2">
        {mounts.map((mount) => {
          const usedPct = Math.round((mount.usedBytes / mount.totalBytes) * 100)
          const isSelected = selectedMountId === mount.id
          const isOffline = mount.status === 'offline'

          return (
            <div
              key={mount.id}
              onClick={() => onSelectMount(isSelected ? undefined : mount.id)}
              className={`p-2.5 rounded-lg border transition-all cursor-pointer text-left ${
                isSelected
                  ? 'bg-[#00F5FF]/10 border-[#00F5FF]/40'
                  : isOffline
                  ? 'bg-amber-500/[0.03] border-amber-500/20 opacity-75'
                  : 'bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.05]'
              }`}
            >
              {/* Title & Lock */}
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5 overflow-hidden">
                  <div
                    className={`w-1.5 h-1.5 rounded-full ${
                      isOffline
                        ? 'bg-amber-400'
                        : mount.healthScore === 'healthy'
                        ? 'bg-[#10B981]'
                        : 'bg-[#F59E0B]'
                    }`}
                  />
                  <span className="text-xs font-medium text-[#F1F5F9] truncate">
                    {mount.name}
                  </span>
                  {isOffline && (
                    <span className="text-[9px] px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 font-mono">
                      Offline
                    </span>
                  )}
                </div>
                <button
                  data-tutorial-id="storage-ro-toggle"
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleReadOnly(mount.id)
                  }}
                  title={mount.isReadOnlyLocked ? 'Storage is Read-Only Locked (Safe)' : 'Storage is Read-Write Enabled'}
                  className={`p-1 rounded transition-colors flex items-center gap-1 text-[10px] font-mono px-1.5 ${
                    mount.isReadOnlyLocked
                      ? 'bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30'
                      : 'bg-[#F59E0B]/15 text-[#F59E0B] border border-[#F59E0B]/30'
                  }`}
                >
                  {mount.isReadOnlyLocked ? (
                    <>
                      <Lock className="w-2.5 h-2.5" />
                      RO
                    </>
                  ) : (
                    <>
                      <Unlock className="w-2.5 h-2.5" />
                      RW
                    </>
                  )}
                </button>
              </div>

              {/* Path & FS */}
              <div className="flex items-center justify-between text-[10px] text-[#64748B] mb-2 font-mono truncate">
                <span className="truncate pr-1">{mount.mountPath}</span>
                <span className="shrink-0 text-[#94A3B8] font-semibold">{mount.fileSystem}</span>
              </div>

              {/* Storage Meter */}
              <div className="w-full bg-white/[0.05] rounded-full h-1.5 overflow-hidden mb-1.5">
                <div
                  className={`h-full rounded-full transition-all ${
                    usedPct > 85 ? 'bg-[#F43F5E]' : usedPct > 70 ? 'bg-[#F59E0B]' : 'bg-[#00F5FF]'
                  }`}
                  style={{ width: `${usedPct}%` }}
                />
              </div>

              {/* Meter Stats & SMART Health */}
              <div className="flex items-center justify-between text-[10px] text-[#94A3B8]">
                <span>
                  {formatBytes(mount.usedBytes)} / {formatBytes(mount.totalBytes)} ({usedPct}%)
                </span>
                <div className="flex items-center gap-1.5 font-mono text-[10px] text-[#64748B]">
                  <span className="flex items-center gap-0.5 text-[#10B981]">
                    <Activity className="w-2.5 h-2.5" />
                    SMART
                  </span>
                  <span className="flex items-center gap-0.5">
                    <Cpu className="w-2.5 h-2.5" />
                    {mount.tempCelsius}°C
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Imported Directories & Repertoire Hierarchy */}
      {folderStats.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-2 border-t border-white/[0.06]">
          <div className="flex items-center justify-between text-[11px] font-semibold text-[#CBD5E1]">
            <div className="flex items-center gap-1.5">
              <FolderTree className="w-3.5 h-3.5 text-[#00F5FF]" />
              <span>Imported Directories</span>
            </div>
            <div className="flex items-center gap-1.5">
              {selectedFolderFilter && (
                <button
                  onClick={() => onSelectFolderFilter && onSelectFolderFilter(undefined)}
                  className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-[#00F5FF]/15 text-[#00F5FF] hover:bg-[#00F5FF]/25 border border-[#00F5FF]/30 flex items-center gap-0.5 cursor-pointer"
                  title="Clear folder filter"
                >
                  <X className="w-2.5 h-2.5" />
                  <span>Clear</span>
                </button>
              )}
              <span className="text-[10px] font-mono text-[#64748B]">
                {folderStats.length} Folders
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1 max-h-52 overflow-y-auto pr-1">
            {folderStats.map((f) => {
              const isFolderSelected = selectedFolderFilter === f.folderPath
              const healthScore =
                f.trackCount > 0
                  ? Math.max(10, Math.round(((f.trackCount - f.untaggedCount) / f.trackCount) * 100))
                  : 100

              return (
                <div
                  key={f.folderPath}
                  onClick={() => onSelectFolderFilter && onSelectFolderFilter(isFolderSelected ? undefined : f.folderPath)}
                  className={`p-2 rounded-md border text-left transition-all cursor-pointer flex items-center justify-between ${
                    isFolderSelected
                      ? 'bg-[#00F5FF]/10 border-[#00F5FF]/40 text-[#00F5FF]'
                      : 'bg-white/[0.02] border-white/[0.04] hover:bg-white/[0.05] text-[#94A3B8]'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <Folder className={`w-3.5 h-3.5 shrink-0 ${isFolderSelected ? 'text-[#00F5FF]' : 'text-[#ADFF2F]'}`} />
                    <div className="flex flex-col truncate">
                      <span className={`text-[11px] font-medium truncate ${isFolderSelected ? 'text-white' : 'text-[#CBD5E1]'}`}>
                        {f.displayName}
                      </span>
                      <span className="text-[9px] font-mono text-[#64748B]">
                        {f.albumCount} {f.albumCount === 1 ? 'Album' : 'Albums'} &bull; {f.trackCount} Tracks
                        {f.uncommittedCount > 0 && ` (${f.uncommittedCount} staged)`}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {f.uncommittedCount > 0 && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B]" title={`${f.uncommittedCount} tracks staged for commit`} />
                    )}
                    <span
                      className={`text-[9px] font-mono px-1.5 py-0.2 rounded font-semibold ${
                        healthScore >= 90
                          ? 'bg-[#10B981]/15 text-[#10B981]'
                          : healthScore >= 70
                          ? 'bg-[#F59E0B]/15 text-[#F59E0B]'
                          : 'bg-[#F43F5E]/15 text-[#F43F5E]'
                      }`}
                    >
                      {healthScore}%
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
