import React from 'react'
import { HealthTriageQueue } from './HealthTriageQueue'
import { FacetedFilters, FacetSelections } from './FacetedFilters'
import { StorageMounts } from './StorageMounts'
import { AuditIssue, StorageMount, Track, Release } from '../../core/types'
import { Database } from 'lucide-react'

interface LeftRailProps {
  auditIssues: AuditIssue[]
  activeTriageFilter?: string
  onSelectTriageFilter: (filterId?: string) => void
  onRemediateAudit: (issueId: string) => void
  healthScore?: number
  isFilteredScope?: boolean
  scopeTrackCount?: number
  totalTrackCount?: number
  onRefreshAudit?: () => void

  facets: FacetSelections
  onFacetChange: (facets: FacetSelections) => void
  onResetFacets: () => void

  storageMounts: StorageMount[]
  onToggleReadOnly: (mountId: string) => void
  selectedMountId?: string
  onSelectMount: (mountId?: string) => void
  selectedFolderFilter?: string
  onSelectFolderFilter?: (folderPath?: string) => void
  onOpenStorageManager?: () => void

  tracks: Track[]
  releases: Release[]
}

export const LeftRail: React.FC<LeftRailProps> = ({
  auditIssues,
  activeTriageFilter,
  onSelectTriageFilter,
  onRemediateAudit,
  healthScore,
  isFilteredScope,
  scopeTrackCount,
  totalTrackCount,
  onRefreshAudit,
  facets,
  onFacetChange,
  onResetFacets,
  storageMounts,
  onToggleReadOnly,
  selectedMountId,
  onSelectMount,
  selectedFolderFilter,
  onSelectFolderFilter,
  onOpenStorageManager,
  tracks,
  releases,
}) => {
  return (
    <aside className="w-[320px] shrink-0 h-full overflow-y-auto flex flex-col gap-3 p-3 border-r border-white/[0.07] bg-[#0D0E12]/80 select-none">
      {/* Dynamic Taxonomy Banner */}
      <div
        data-tutorial-id="left-rail-taxonomy-banner"
        data-testid="left-rail-taxonomy-banner"
        className="flex items-center gap-2 px-1 py-0.5 text-xs text-[#64748B]"
      >
        <Database className="w-3.5 h-3.5 text-[#00F5FF]" />
        <span className="font-semibold uppercase tracking-wider text-[10px] text-[#94A3B8]">
          Dynamic Taxonomy Tree
        </span>
      </div>

      {/* 1. Health & Triage Queue */}
      <div data-tutorial-id="audit-triage-panel" data-testid="audit-triage-panel">
        <HealthTriageQueue
          issues={auditIssues}
          activeFilter={activeTriageFilter}
          onSelectFilter={onSelectTriageFilter}
          onRemediate={onRemediateAudit}
          healthScore={healthScore}
          isFilteredScope={isFilteredScope}
          scopeTrackCount={scopeTrackCount}
          totalTrackCount={totalTrackCount}
          onRefreshAudit={onRefreshAudit}
        />
      </div>

      {/* 2. Faceted Multi-Dimensional Filters */}
      <div data-tutorial-id="faceted-filters-container" data-testid="faceted-filters-container">
        <FacetedFilters
          facets={facets}
          onFacetChange={onFacetChange}
          onReset={onResetFacets}
          tracks={tracks}
          releases={releases}
        />
      </div>

      {/* 3. Physical Storage Mounts & Imported Folder Hierarchy */}
      <div data-tutorial-id="storage-mounts-container" data-testid="storage-mounts-container">
        <StorageMounts
          mounts={storageMounts}
          tracks={tracks}
          releases={releases}
          onToggleReadOnly={onToggleReadOnly}
          selectedMountId={selectedMountId}
          onSelectMount={onSelectMount}
          selectedFolderFilter={selectedFolderFilter}
          onSelectFolderFilter={onSelectFolderFilter}
          onOpenStorageManager={onOpenStorageManager}
        />
      </div>
    </aside>
  )
}
