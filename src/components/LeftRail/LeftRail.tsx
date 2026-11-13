import React, { useState, useMemo } from 'react'
import {
  Music4,
  FolderTree,
  FolderPlus,
  Sparkles,
  Flame,
  Volume2,
  HardDrive,
  LayoutGrid,
  FileCheck2,
  Database,
  Radio,
  ListMusic,
  ShieldAlert,
  Maximize2,
  ChevronDown,
  Disc3,
} from 'lucide-react'
import { AuditIssue, StorageMount, Track, Release, WatchedFolder, CanvasViewMode, Playlist } from '../../core/types'
import { FacetSelections } from './FacetedFilters'
import { AmbientCurationCapsule } from './AmbientCurationCapsule'
import { FEATURES } from '../../config/features'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import { graphEngine } from '../../core/graphEngine'

interface LeftRailProps {
  auditIssues?: AuditIssue[]
  activeTriageFilter?: string
  onSelectTriageFilter?: (filterId?: string) => void
  onRemediateAudit?: (issueId: string) => void
  healthScore?: number
  isFilteredScope?: boolean
  scopeTrackCount?: number
  totalTrackCount?: number
  onRefreshAudit?: () => void
  onOpenNormalizationRules?: () => void

  facets: FacetSelections
  onFacetChange: (facets: FacetSelections) => void
  onResetFacets: () => void

  storageMounts: StorageMount[]
  onToggleReadOnly?: (mountId: string) => void
  selectedMountId?: string
  onSelectMount?: (mountId?: string) => void
  selectedFolderFilter?: string
  onSelectFolderFilter?: (folderPath?: string) => void
  onOpenStorageManager?: () => void
  onOpenImportModal?: () => void
  watchedFolders?: WatchedFolder[]

  tracks: Track[]
  releases: Release[]

  viewMode?: CanvasViewMode
  onViewModeChange?: (mode: CanvasViewMode) => void
  topMode?: 'library' | 'curate' | 'maintain'
  onTopModeChange?: (mode: 'library' | 'curate' | 'maintain') => void
  onOpenCommitModal?: () => void

  playlists?: Playlist[]
  selectedPlaylistId?: string
  onSelectPlaylist?: (playlist: Playlist) => void
  onOpenCreatePlaylist?: () => void

  isIconOnly?: boolean
  onOpenSanctuary?: () => void
  isArtworkDockExpanded?: boolean
  onCollapseArtworkDock?: () => void
}

const LeftRailArtworkCard: React.FC<{
  onOpenSanctuary?: () => void
  onCollapse?: () => void
}> = React.memo(({ onOpenSanctuary, onCollapse }) => {
  const { currentTrack, currentRelease, isPlaying } = useAudioPlayer()

  if (!currentTrack) return null

  const resolvedRelease =
    currentRelease || (currentTrack.releaseId ? graphEngine.getReleaseById(currentTrack.releaseId) : null)
  const coverUrl = resolvedRelease?.coverArtUrl || resolvedRelease?.artwork?.frontCoverUrl

  return (
    <div className="pt-2">
      <div
        role="button"
        tabIndex={0}
        onClick={onOpenSanctuary}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpenSanctuary?.()
          }
        }}
        title="Open Now Playing (⌘L)"
        aria-label={`Open Now Playing for ${currentTrack.title}`}
        className="relative w-full aspect-square rounded-xl bg-[#131418] border border-white/10 shadow-2xl overflow-hidden group cursor-pointer focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2"
      >
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={`${resolvedRelease?.title || currentTrack.title} cover art`}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-[#131418]">
            <Disc3
              className={`w-14 h-14 text-white/25 ${isPlaying ? 'animate-spin' : ''}`}
              style={{ animationDuration: '6s' }}
              aria-hidden="true"
            />
          </div>
        )}

        {/* Hover / Focus Scrim + Centered Expand Icon */}
        <div
          className="absolute inset-0 bg-black/25 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-200 flex items-center justify-center"
          aria-hidden="true"
        >
          <div className="p-2.5 rounded-full bg-black/55 backdrop-blur-md border border-white/20 text-white shadow-xl">
            <Maximize2 className="w-4 h-4" />
          </div>
        </div>

        {/* Top-right Collapse Button */}
        {onCollapse && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onCollapse()
            }}
            aria-label="Collapse artwork preview"
            title="Collapse artwork preview"
            className="absolute top-2 right-2 p-1 rounded-full bg-black/60 hover:bg-black/80 backdrop-blur-md border border-white/15 text-white/80 hover:text-white opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity cursor-pointer focus-visible:outline-2 focus-visible:outline-white"
          >
            <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
})

export const LeftRail: React.FC<LeftRailProps> = ({
  facets,
  onFacetChange,
  onResetFacets,
  tracks,
  releases,
  viewMode = 'cover_grid',
  onViewModeChange,
  topMode = 'library',
  onTopModeChange,
  storageMounts = [],
  watchedFolders = [],
  onOpenImportModal,
  onOpenStorageManager,
  onOpenCommitModal,
  playlists = [],
  selectedPlaylistId,
  onSelectPlaylist,
  onOpenCreatePlaylist,
  auditIssues = [],
  isIconOnly = false,
  onOpenSanctuary,
  isArtworkDockExpanded = true,
  onCollapseArtworkDock,
}) => {
  // Derive active smart tier directly from facets state
  const activeSmartTier = useMemo(() => {
    if (facets?.format === 'DSD' || facets?.format === 'DSD256' || facets?.format === 'Native DSD') {
      return 'dsd'
    }
    if (facets?.mastering === 'high_res_24bit') {
      return 'highres'
    }
    if (facets?.mastering === 'audiophile_dr14') {
      return 'dr'
    }
    return null
  }, [facets])

  // Smart Tier Quick Filter Handlers
  const handleSmartTierClick = (type: string) => {
    if (activeSmartTier === type) {
      onResetFacets()
      return
    }
    if (type === 'highres') {
      onFacetChange({ ...facets, format: undefined, mastering: 'high_res_24bit' })
    } else if (type === 'dsd') {
      onFacetChange({ ...facets, mastering: undefined, format: 'DSD' })
    } else if (type === 'dr') {
      onFacetChange({ ...facets, format: undefined, mastering: 'audiophile_dr14' })
    }
  }

  type LeftRailNavId = CanvasViewMode

  const libraryNavItems: Array<{
    id: LeftRailNavId
    label: string
    icon: typeof LayoutGrid
    count?: number
  }> = [
    {
      id: 'cover_grid',
      label: 'Library Browse',
      icon: LayoutGrid,
      count: releases.length,
    },
    {
      id: 'playlist_detail',
      label: 'Playlists',
      icon: ListMusic,
      count: playlists.length,
    },
    {
      id: 'folder_tree',
      label: 'Physical Folder Tree',
      icon: FolderTree,
    },
  ]

  return (
    <aside
      className={`shrink-0 h-full overflow-hidden flex flex-col justify-between border-r border-white/[0.06] bg-[#0C0D10]/95 backdrop-blur-2xl select-none text-xs transition-all duration-200 ${
        isIconOnly ? 'w-16 p-2 items-center' : 'w-[260px] p-3'
      }`}
    >
      <div className={`flex-1 min-h-0 overflow-y-auto space-y-4 ${isIconOnly ? 'w-full flex flex-col items-center' : 'w-full pr-0.5'}`}>
        {/* 0. Primary Ingestion Action */}
        <div className={`pb-2 ${isIconOnly ? 'w-full flex justify-center' : ''}`}>
          <button
            onClick={onOpenImportModal}
            title="Import audio folder or file into library (⌘O)"
            className={`${
              isIconOnly
                ? 'w-10 h-10 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#F5F5F7] flex items-center justify-center cursor-pointer shadow-sm group'
                : 'w-full py-2 px-3 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#F5F5F7] font-medium text-xs transition-all flex items-center justify-between shadow-sm cursor-pointer group'
            }`}
          >
            <div className={`flex items-center ${isIconOnly ? 'justify-center' : 'gap-2'}`}>
              <FolderPlus className="w-3.5 h-3.5 text-[#D4AF37] group-hover:scale-105 transition-transform" />
              {!isIconOnly && <span>Add Music</span>}
            </div>
            {!isIconOnly && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/40 text-[#8E8E93] border border-white/[0.06]">
                ⌘O
              </span>
            )}
          </button>
        </div>

        {/* 1. Source List: Library Views */}
        <div className={`space-y-0.5 ${isIconOnly ? 'w-full flex flex-col items-center' : ''}`}>
          {!isIconOnly && (
            <div className="text-[10px] uppercase font-mono text-[#8E8E93]/70 font-semibold px-2 py-1 tracking-wider">
              Library
            </div>
          )}

          {libraryNavItems.map((item) => {
            const Icon = item.icon
            const isActive =
              topMode === 'library' && (viewMode === item.id || (item.id === 'cover_grid' && (viewMode === 'cover_grid' || viewMode === 'virtual_table')))

            return (
              <button
                key={item.id}
                title={`${item.label}${item.count !== undefined ? ` (${item.count})` : ''}`}
                onClick={() => {
                  if (item.id === 'playlist_detail') {
                    onTopModeChange?.('library')
                    if (playlists.length > 0) {
                      onSelectPlaylist?.(playlists[0])
                      onViewModeChange?.('playlist_detail')
                    } else {
                      onOpenCreatePlaylist?.()
                    }
                  } else {
                    onTopModeChange?.('library')
                    onViewModeChange?.(item.id)
                  }
                }}
                className={`rounded-lg transition-all cursor-pointer flex items-center ${
                  isIconOnly
                    ? `w-10 h-10 justify-center ${
                        isActive
                          ? 'bg-white/[0.12] text-white shadow-sm border border-white/[0.08]'
                          : 'text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'
                      }`
                    : `w-full px-2.5 py-1.5 justify-between ${
                        isActive
                          ? 'bg-white/[0.1] text-white font-medium shadow-sm'
                          : 'text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'
                      }`
                }`}
              >
                <div className={`flex items-center ${isIconOnly ? 'justify-center' : 'gap-2'}`}>
                  <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-[#D4AF37]' : 'text-[#8E8E93]'}`} />
                  {!isIconOnly && <span>{item.label}</span>}
                </div>
                {!isIconOnly && item.count !== undefined && (
                  <span className="text-[10px] font-mono text-[#636366] tabular-nums">
                    {item.count}
                  </span>
                )}
              </button>
            )
          })}

          {/* Individual Playlists Sub-tree */}
          {!isIconOnly && viewMode === 'playlist_detail' && playlists.length > 0 && (
            <div className="pl-3 py-1 space-y-0.5 border-l border-white/10 ml-3 my-1 animate-fadeIn">
              {playlists.map((pl) => (
                <button
                  key={pl.id}
                  onClick={() => onSelectPlaylist?.(pl)}
                  className={`w-full px-2 py-1 rounded text-left text-[11px] truncate transition-colors flex items-center justify-between cursor-pointer ${
                    selectedPlaylistId === pl.id
                      ? 'bg-emerald-500/20 text-emerald-300 font-medium'
                      : 'text-neutral-400 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <span className="truncate">{pl.title}</span>
                  <span className="text-[9px] font-mono text-neutral-500 ml-1">
                    {pl.tracksCount}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 2. Source List: Smart Tiers */}
        <div className={`space-y-0.5 pt-1 ${isIconOnly ? 'w-full flex flex-col items-center' : ''}`}>
          {!isIconOnly && (
            <div className="text-[10px] uppercase font-mono text-[#8E8E93]/70 font-semibold px-2 py-1 tracking-wider">
              Smart Tiers
            </div>
          )}

          <button
            onClick={() => handleSmartTierClick('dsd')}
            title="Native DSD (DSD128+)"
            className={`rounded-lg flex items-center transition-all cursor-pointer ${
              isIconOnly
                ? `w-10 h-10 justify-center ${activeSmartTier === 'dsd' ? 'bg-white/[0.12] text-white' : 'text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'}`
                : `w-full px-2.5 py-1.5 justify-between ${activeSmartTier === 'dsd' ? 'bg-white/[0.1] text-white font-medium shadow-sm' : 'text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'}`
            }`}
          >
            <div className={`flex items-center ${isIconOnly ? 'justify-center' : 'gap-2'}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-[#818CF8] shadow-sm shadow-[#818CF8]/40" />
              {!isIconOnly && <span>Native DSD</span>}
            </div>
            {!isIconOnly && <span className="text-[10px] font-mono text-[#818CF8]">DSD128+</span>}
          </button>

          <button
            onClick={() => handleSmartTierClick('highres')}
            title="PCM Hi-Res (24/96+)"
            className={`rounded-lg flex items-center transition-all cursor-pointer ${
              isIconOnly
                ? `w-10 h-10 justify-center ${activeSmartTier === 'highres' ? 'bg-white/[0.12] text-white' : 'text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'}`
                : `w-full px-2.5 py-1.5 justify-between ${activeSmartTier === 'highres' ? 'bg-white/[0.1] text-white font-medium shadow-sm' : 'text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'}`
            }`}
          >
            <div className={`flex items-center ${isIconOnly ? 'justify-center' : 'gap-2'}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B] shadow-sm shadow-[#F59E0B]/40" />
              {!isIconOnly && <span>PCM Hi-Res</span>}
            </div>
            {!isIconOnly && <span className="text-[10px] font-mono text-[#F59E0B]">24/96+</span>}
          </button>

          {FEATURES.DYNAMIC_RANGE && (
            <button
              onClick={() => handleSmartTierClick('dr')}
              title="High Dynamic Range (DR12+)"
              className={`rounded-lg flex items-center transition-all cursor-pointer ${
                isIconOnly
                  ? `w-10 h-10 justify-center ${activeSmartTier === 'dr' ? 'bg-white/[0.12] text-white' : 'text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'}`
                  : `w-full px-2.5 py-1.5 justify-between ${activeSmartTier === 'dr' ? 'bg-white/[0.1] text-white font-medium shadow-sm' : 'text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'}`
              }`}
            >
              <div className={`flex items-center ${isIconOnly ? 'justify-center' : 'gap-2'}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] shadow-sm shadow-[#10B981]/40" />
                {!isIconOnly && <span>High Dynamic Range</span>}
              </div>
              {!isIconOnly && <span className="text-[10px] font-mono text-[#10B981]">DR12+</span>}
            </button>
          )}
        </div>

        {/* 3. Source List: Storage Mounts & Staged Status */}
        <div className={`space-y-1 pt-1 ${isIconOnly ? 'w-full flex flex-col items-center' : ''}`}>
          {!isIconOnly && (
            <div className="text-[10px] uppercase font-mono text-[#8E8E93]/70 font-semibold px-2 py-1 tracking-wider flex items-center justify-between">
              <span>Storage</span>
              <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" title="Storage subsystem active & online" />
            </div>
          )}

          <button
            onClick={onOpenStorageManager}
            className={`rounded-lg flex items-center transition-all cursor-pointer group ${
              isIconOnly
                ? 'w-10 h-10 justify-center text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'
                : 'w-full px-2.5 py-1.5 justify-between text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'
            }`}
            title={`Manage Storage & Folders (${watchedFolders.length} Watched Folders, ${storageMounts.length} Mounts)`}
          >
            <div className={`flex items-center truncate ${isIconOnly ? 'justify-center' : 'gap-2'}`}>
              <HardDrive className="w-3.5 h-3.5 text-[#8E8E93] group-hover:text-white shrink-0" />
              {!isIconOnly && (
                <span className="truncate">
                  Storage & Folders
                </span>
              )}
            </div>
            {!isIconOnly && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.05] text-[#8E8E93] border border-white/[0.04]">
                {watchedFolders.length}
              </span>
            )}
          </button>

          {/* Ambient Hardware Telemetry: Background Artist Portrait Sync */}
          {!isIconOnly && <AmbientCurationCapsule />}
        </div>
      </div>

      {/* Footer Stats & Docked Now Playing Artwork */}
      <div className="shrink-0 w-full pb-16 space-y-2">
        <div className={`pt-2 border-t border-white/[0.05] text-[10px] font-mono text-[#636366] flex items-center ${isIconOnly ? 'justify-center' : 'justify-between px-1'}`}>
          {!isIconOnly ? (
            <>
              <span>{releases.length} Albums</span>
              <span>{tracks.length} Tracks</span>
            </>
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-[#D4AF37]/50" title={`${releases.length} Albums · ${tracks.length} Tracks`} />
          )}
        </div>

        {!isIconOnly && isArtworkDockExpanded && (
          <LeftRailArtworkCard
            onOpenSanctuary={onOpenSanctuary}
            onCollapse={onCollapseArtworkDock}
          />
        )}
      </div>
    </aside>
  )
}
