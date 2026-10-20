import React, { useState, useMemo } from 'react'
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Music,
  Play,
  Pause,
  HardDrive,
  Sparkles,
  ShieldCheck,
  Search,
  CheckCircle2,
  FileCode,
  Disc3,
} from 'lucide-react'
import { Track, Release } from '../../core/types'
import { useAudioPlayer } from '../../context/AudioPlayerContext'

interface FolderTreeExplorerProps {
  tracks: Track[]
  releases: Release[]
  selectedTrackId?: string
  onSelectTrack: (trackId: string) => void
  highlightedPath?: string
}

interface TreeNode {
  name: string
  path: string
  subfolders: Map<string, TreeNode>
  tracks: Track[]
  formats: Set<string>
  sampleRates: Set<string>
}

export const FolderTreeExplorer: React.FC<FolderTreeExplorerProps> = ({
  tracks,
  releases,
  selectedTrackId,
  onSelectTrack,
  highlightedPath,
}) => {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const { currentTrack, isPlaying, playTrack, togglePlayPause } = useAudioPlayer()

  // Build hierarchical folder tree from track file paths
  const treeRoot = useMemo(() => {
    const root: TreeNode = {
      name: 'Library Root',
      path: '',
      subfolders: new Map(),
      tracks: [],
      formats: new Set(),
      sampleRates: new Set(),
    }

    tracks.forEach((track) => {
      // Normalize separators
      const cleanPath = (track.folderPath || track.filePath).replace(/\\/g, '/')
      const parts = cleanPath.split('/').filter(Boolean)

      let current = root
      let currentPath = ''

      // Build intermediate folder nodes
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        currentPath = currentPath ? `${currentPath}/${part}` : part

        if (!current.subfolders.has(part)) {
          current.subfolders.set(part, {
            name: part,
            path: currentPath,
            subfolders: new Map(),
            tracks: [],
            formats: new Set(),
            sampleRates: new Set(),
          })
        }
        current = current.subfolders.get(part)!
        current.formats.add(track.format)
        if (track.sampleRateStr) current.sampleRates.add(track.sampleRateStr)
      }

      // Add track to the terminal folder node
      current.tracks.push(track)
    })

    return root
  }, [tracks])

  // Automatically expand initial top 2 levels
  React.useEffect(() => {
    const initial = new Set<string>()
    treeRoot.subfolders.forEach((sub, key) => {
      initial.add(sub.path)
      sub.subfolders.forEach((s2) => {
        initial.add(s2.path)
      })
    })
    setExpandedFolders(initial)
  }, [treeRoot])

  // Handle highlighted path from deep-link (e.g. "Reveal in Folder Tree")
  React.useEffect(() => {
    if (highlightedPath) {
      const clean = highlightedPath.replace(/\\/g, '/')
      const parts = clean.split('/').filter(Boolean)
      let cur = ''
      setExpandedFolders((prev) => {
        const next = new Set(prev)
        parts.forEach((p) => {
          cur = cur ? `${cur}/${p}` : p
          next.add(cur)
        })
        return next
      })
    }
  }, [highlightedPath])

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  // Recursive folder node renderer
  const renderFolderNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    const isExpanded = expandedFolders.has(node.path)
    const hasChildren = node.subfolders.size > 0 || node.tracks.length > 0
    const isHighlighted = highlightedPath && highlightedPath.replace(/\\/g, '/').includes(node.path)

    // Calculate recursive track counts and collect all recursive tracks
    const totalRecursiveTracks = (n: TreeNode): number => {
      let count = n.tracks.length
      n.subfolders.forEach((sub) => {
        count += totalRecursiveTracks(sub)
      })
      return count
    }

    const getAllRecursiveTracks = (n: TreeNode): Track[] => {
      let result = [...n.tracks]
      n.subfolders.forEach((sub) => {
        result = result.concat(getAllRecursiveTracks(sub))
      })
      return result
    }

    const recCount = totalRecursiveTracks(node)
    const allNodeTracks = getAllRecursiveTracks(node)
    const isFolderPlaying =
      isPlaying && Boolean(currentTrack && allNodeTracks.some((t) => t.id === currentTrack.id))

    if (searchQuery.trim() && !node.name.toLowerCase().includes(searchQuery.toLowerCase())) {
      // Check if any children match
      if (recCount === 0) return null
    }

    return (
      <div key={node.path} className="select-none text-xs">
        {/* Folder Header Row */}
        <div
          onClick={() => toggleFolder(node.path)}
          style={{ paddingLeft: `${depth * 18 + 12}px` }}
          className={`h-9 flex items-center justify-between pr-4 hover:bg-white/[0.04] cursor-pointer transition-colors border-l-2 group ${
            isHighlighted
              ? 'border-[#00F5FF] bg-[#00F5FF]/10 text-white font-medium'
              : 'border-transparent text-white/80'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-white/40 shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-white/40 shrink-0" />
              )
            ) : (
              <span className="w-3.5 h-3.5 shrink-0" />
            )}

            {/* Play / Pause Folder Button */}
            {allNodeTracks.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (isFolderPlaying) {
                    togglePlayPause()
                  } else {
                    const onlineTracks = allNodeTracks.filter((t) => t.isOnline !== false)
                    if (onlineTracks.length > 0) {
                      playTrack(onlineTracks[0], onlineTracks)
                    }
                  }
                }}
                title={isFolderPlaying ? 'Pause folder' : `Play folder (${allNodeTracks.length} tracks)`}
                className={`w-5 h-5 rounded flex items-center justify-center transition-all shrink-0 ${
                  isFolderPlaying
                    ? 'text-[#00F5FF] bg-[#00F5FF]/20 opacity-100'
                    : 'text-white/40 hover:text-white hover:bg-white/[0.1] opacity-70 group-hover:opacity-100'
                }`}
              >
                {isFolderPlaying ? (
                  <Pause className="w-3 h-3 fill-current" />
                ) : (
                  <Play className="w-3 h-3 fill-current ml-0.5" />
                )}
              </button>
            )}

            {isExpanded ? (
              <FolderOpen className="w-4 h-4 text-[#00F5FF] shrink-0" />
            ) : (
              <Folder className="w-4 h-4 text-amber-400/80 shrink-0" />
            )}

            <span className="truncate font-mono text-[11px] font-medium">{node.name}</span>

            <span className="text-[10px] text-white/40 font-mono">
              ({recCount} {recCount === 1 ? 'track' : 'tracks'})
            </span>
          </div>

          {/* Format Badges on Folder */}
          <div className="flex items-center gap-1.5 shrink-0">
            {Array.from(node.formats).slice(0, 3).map((fmt) => (
              <span
                key={fmt}
                className="px-1.5 py-0.2 rounded text-[9px] font-mono font-medium bg-white/[0.06] text-white/60 border border-white/[0.06]"
              >
                {fmt}
              </span>
            ))}
          </div>
        </div>

        {/* Subfolders & Tracks when Expanded */}
        {isExpanded && (
          <div>
            {/* Render child subfolders */}
            {Array.from(node.subfolders.values()).map((sub) =>
              renderFolderNode(sub, depth + 1)
            )}

            {/* Render tracks in this folder */}
            {node.tracks.map((track) => {
              const isCurrent = currentTrack?.id === track.id
              const isPlayingCurrent = isCurrent && isPlaying
              const isSelected = selectedTrackId === track.id
              const isOffline = track.isOnline === false

              return (
                <div
                  key={track.id}
                  onClick={() => onSelectTrack(track.id)}
                  onDoubleClick={() => {
                    if (!isOffline) {
                      const folderContext = node.tracks.length > 0 ? node.tracks : [track]
                      playTrack(track, folderContext)
                    }
                  }}
                  style={{ paddingLeft: `${(depth + 1) * 18 + 24}px` }}
                  className={`h-8 flex items-center justify-between pr-4 cursor-pointer transition-colors border-l-2 ${
                    isSelected
                      ? 'border-[#00F5FF] bg-[#00F5FF]/10 text-white'
                      : 'border-transparent hover:bg-white/[0.03] text-white/70'
                  } ${isOffline ? 'opacity-40' : ''}`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (isOffline) return
                        if (isCurrent) {
                          togglePlayPause()
                        } else {
                          const folderContext = node.tracks.length > 0 ? node.tracks : [track]
                          playTrack(track, folderContext)
                        }
                      }}
                      disabled={isOffline}
                      title={isOffline ? 'Storage offline' : 'Play track'}
                      className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                        isCurrent
                          ? 'text-[#00F5FF]'
                          : 'text-white/40 hover:text-white hover:bg-white/[0.08]'
                      }`}
                    >
                      {isPlayingCurrent ? (
                        <Pause className="w-3 h-3" />
                      ) : (
                        <Play className="w-3 h-3" />
                      )}
                    </button>

                    <span className="font-mono text-[10px] text-white/40 w-5 shrink-0 text-right">
                      {track.trackNumber}
                    </span>

                    <Music className="w-3.5 h-3.5 text-white/30 shrink-0" />

                    <span className="font-medium text-xs text-white/90 truncate">
                      {track.title}
                    </span>

                    <span className="text-[11px] text-white/40 truncate">
                      — {track.artistCredit}
                    </span>

                    {isOffline && (
                      <span className="px-1.5 py-0.2 rounded text-[9px] bg-amber-500/20 text-amber-300">
                        Offline
                      </span>
                    )}

                    {track.sidecarStatus === 'uncommitted_sidecar' && (
                      <span className="px-1.5 py-0.2 rounded text-[9px] bg-cyan-500/20 text-[#00F5FF] flex items-center gap-1">
                        <FileCode className="w-2.5 h-2.5" />
                        Sidecar
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-3 shrink-0 text-white/40 text-[10px] font-mono">
                    <span>{track.format}</span>
                    <span>{track.sampleRateStr}</span>
                    {track.drScore ? (
                      <span className="text-emerald-400 font-semibold">DR{track.drScore}</span>
                    ) : null}
                    <span>
                      {Math.floor(track.durationSeconds / 60)}:
                      {(Math.floor(track.durationSeconds % 60)).toString().padStart(2, '0')}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0D0E12] overflow-hidden">
      {/* Top Filter Bar */}
      <div className="px-6 py-3 border-b border-white/[0.06] bg-[#12151D]/60 backdrop-blur-xl flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-[#00F5FF]" />
          <span className="font-semibold text-xs text-white">Physical On-Disk Folder Tree</span>
          <span className="text-white/40 text-xs">
            ({tracks.length.toLocaleString()} total files indexed)
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative w-64">
            <Search className="w-3.5 h-3.5 text-white/40 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search folders or tracks..."
              className="w-full pl-8 pr-3 py-1 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-white placeholder-white/30 focus:outline-none focus:border-[#00F5FF]"
            />
          </div>
        </div>
      </div>

      {/* Directory Hierarchy Tree View */}
      <div className="flex-1 overflow-y-auto py-2">
        {treeRoot.subfolders.size === 0 ? (
          <div className="py-20 text-center text-white/40 text-xs">
            No folders in library. Add a watched folder to view physical directory tree.
          </div>
        ) : (
          Array.from(treeRoot.subfolders.values()).map((sub) => renderFolderNode(sub, 0))
        )}
      </div>
    </div>
  )
}
