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
} from 'lucide-react'
import { AuditIssue, StorageMount, Track, Release, WatchedFolder, CanvasViewMode, Playlist } from '../../core/types'
import { FacetSelections } from './FacetedFilters'
import { AmbientCurationCapsule } from './AmbientCurationCapsule'

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
  topMode?: 'library' | 'maintain'
  onTopModeChange?: (mode: 'library' | 'maintain') => void
  onOpenCommitModal?: () => void

  playlists?: Playlist[]
  selectedPlaylistId?: string
  onSelectPlaylist?: (playlist: Playlist) => void
  onOpenCreatePlaylist?: () => void
}

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

  type LeftRailNavId = CanvasViewMode | 'audit'

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
    {
      id: 'audit',
      label: 'Audit & Hygiene',
      icon: ShieldAlert,
      count: auditIssues.length,
    },
  ]

  return (
    <aside className="w-[260px] shrink-0 h-full overflow-y-auto flex flex-col justify-between p-3 border-r border-white/[0.06] bg-[#0C0D10]/95 backdrop-blur-2xl select-none text-xs">
      <div className="space-y-4">
        {/* 0. Primary Ingestion Action (Apple style subtle button) */}
        <div className="pb-2">
          <button
            onClick={onOpenImportModal}
            title="Import audio folder or file into library (⌘O)"
            className="w-full py-2 px-3 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-[#F5F5F7] font-medium text-xs transition-all flex items-center justify-between shadow-sm cursor-pointer group"
          >
            <div className="flex items-center gap-2">
              <FolderPlus className="w-3.5 h-3.5 text-[#D4AF37] group-hover:scale-105 transition-transform" />
              <span>Add Music</span>
            </div>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/40 text-[#8E8E93] border border-white/[0.06]">
              ⌘O
            </span>
          </button>
        </div>

        {/* 1. Source List: Library Views */}
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase font-mono text-[#8E8E93]/70 font-semibold px-2 py-1 tracking-wider">
            Library
          </div>

          {libraryNavItems.map((item) => {
            const Icon = item.icon
            const isActive =
              item.id === 'audit'
                ? topMode === 'maintain'
                : topMode === 'library' && (viewMode === item.id || (item.id === 'cover_grid' && (viewMode === 'cover_grid' || viewMode === 'virtual_table')))

            return (
              <button
                key={item.id}
                onClick={() => {
                  if (item.id === 'audit') {
                    onTopModeChange?.('maintain')
                  } else if (item.id === 'playlist_detail') {
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
                className={`w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between transition-all cursor-pointer ${
                  isActive
                    ? 'bg-white/[0.1] text-white font-medium shadow-sm'
                    : 'text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-[#D4AF37]' : 'text-[#8E8E93]'}`} />
                  <span>{item.label}</span>
                </div>
                {item.count !== undefined && (
                  <span className="text-[10px] font-mono text-[#636366] tabular-nums">
                    {item.count}
                  </span>
                )}
              </button>
            )
          })}

          {/* Individual Playlists Sub-tree */}
          {viewMode === 'playlist_detail' && playlists.length > 0 && (
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
        <div className="space-y-0.5 pt-1">
          <div className="text-[10px] uppercase font-mono text-[#8E8E93]/70 font-semibold px-2 py-1 tracking-wider">
            Smart Tiers
          </div>

          <button
            onClick={() => handleSmartTierClick('dsd')}
            className={`w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between transition-all cursor-pointer ${
              activeSmartTier === 'dsd'
                ? 'bg-white/[0.1] text-white font-medium shadow-sm'
                : 'text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#818CF8] shadow-sm shadow-[#818CF8]/40" />
              <span>Native DSD</span>
            </div>
            <span className="text-[10px] font-mono text-[#818CF8]">DSD128+</span>
          </button>

          <button
            onClick={() => handleSmartTierClick('highres')}
            className={`w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between transition-all cursor-pointer ${
              activeSmartTier === 'highres'
                ? 'bg-white/[0.1] text-white font-medium shadow-sm'
                : 'text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B] shadow-sm shadow-[#F59E0B]/40" />
              <span>PCM Hi-Res</span>
            </div>
            <span className="text-[10px] font-mono text-[#F59E0B]">24/96+</span>
          </button>

          <button
            onClick={() => handleSmartTierClick('dr')}
            className={`w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between transition-all cursor-pointer ${
              activeSmartTier === 'dr'
                ? 'bg-white/[0.1] text-white font-medium shadow-sm'
                : 'text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04]'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] shadow-sm shadow-[#10B981]/40" />
              <span>High Dynamic Range</span>
            </div>
            <span className="text-[10px] font-mono text-[#10B981]">DR12+</span>
          </button>
        </div>

        {/* 3. Source List: Storage Mounts & Staged Status */}
        <div className="space-y-1 pt-1">
          <div className="text-[10px] uppercase font-mono text-[#8E8E93]/70 font-semibold px-2 py-1 tracking-wider flex items-center justify-between">
            <span>Storage Mounts</span>
            <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" title="Storage subsystem active & online" />
          </div>

          <button
            onClick={onOpenStorageManager}
            className="w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between text-[#8E8E93] hover:text-[#F5F5F7] hover:bg-white/[0.04] transition-all cursor-pointer group"
            title="Manage Storage Mounts & Watched Folders"
          >
            <div className="flex items-center gap-2 truncate">
              <HardDrive className="w-3.5 h-3.5 text-[#8E8E93] group-hover:text-white shrink-0" />
              <span className="truncate">
                {storageMounts[0]?.name?.split('(')[0]?.trim() || 'Local Storage'}
              </span>
            </div>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.05] text-[#8E8E93] border border-white/[0.04]">
              {watchedFolders.length}
            </span>
          </button>

          {/* Ambient Hardware Telemetry: Background Artist Portrait Sync */}
          <AmbientCurationCapsule />
        </div>
      </div>

      {/* Footer Stats: Apple minimalist style */}
      <div className="pt-2 border-t border-white/[0.05] text-[10px] font-mono text-[#636366] flex items-center justify-between px-1">
        <span>{releases.length} Albums</span>
        <span>{tracks.length} Tracks</span>
      </div>
    </aside>
  )
}
