import React, { useState } from 'react'
import {
  AlertTriangle,
  FolderTree,
  FolderPlus,
  Folder,
  FolderCheck,
  Sparkles,
  HardDrive,
  ShieldCheck,
  Check,
  RefreshCw,
  Trash2,
  FileCode,
  ArrowRight,
  Database,
  Lock,
  Unlock,
  Eye,
  SlidersHorizontal,
  ChevronRight,
  Search,
} from 'lucide-react'
import { Track, Release, AuditIssue, StorageMount, WatchedFolder, SkippedFile } from '../../core/types'
import { normalizationService, NormalizationRule } from '../../services/normalizationService'

export type MaintainSubTab = 'needs_attention' | 'organize_files' | 'metadata_matching' | 'storage_mounts' | 'pending_changes'

interface MaintainCockpitProps {
  tracks: Track[]
  releases: Release[]
  auditIssues: AuditIssue[]
  storageMounts: StorageMount[]
  watchedFolders: WatchedFolder[]
  skippedFiles: SkippedFile[]
  uncommittedCount: number
  onRemediateAudit: (issueId: string) => void
  onRefreshAudit: () => void
  onApplyPathRestructure: (pattern: string) => void
  onCommitTwoPhase: () => void
  onToggleMountLock: (mountId: string) => void
  onToggleMountStatus: (mountId: string) => void
  onTriggerScan: (folderPath?: string) => void
  onRefreshLibrary: () => void
  onSelectTrack?: (trackId: string) => void
  onSelectRelease?: (releaseId: string) => void
  showToast: (msg: string) => void
  onSwitchToLibrary: () => void
  activeSubTab?: MaintainSubTab
  onSubTabChange?: (tab: MaintainSubTab) => void
  onAddWatchedFolder?: () => void
  onRemoveWatchedFolder?: (folderId: string) => void
}

export const MaintainCockpit: React.FC<MaintainCockpitProps> = ({
  tracks,
  releases,
  auditIssues,
  storageMounts,
  watchedFolders,
  skippedFiles,
  uncommittedCount,
  onRemediateAudit,
  onRefreshAudit,
  onApplyPathRestructure,
  onCommitTwoPhase,
  onToggleMountLock,
  onToggleMountStatus,
  onTriggerScan,
  onRefreshLibrary,
  showToast,
  onSwitchToLibrary,
  activeSubTab: controlledTab,
  onSubTabChange,
  onAddWatchedFolder,
  onRemoveWatchedFolder,
}) => {
  const [internalTab, setInternalTab] = useState<MaintainSubTab>('needs_attention')
  const activeTab = controlledTab ?? internalTab
  const setActiveTab = (tab: MaintainSubTab) => {
    setInternalTab(tab)
    onSubTabChange?.(tab)
  }
  const [selectedIssueCategory, setSelectedIssueCategory] = useState<string>('all')
  const [pathPattern, setPathPattern] = useState<string>('{Artist}/{Year} - {Album}/{TrackNum} - {Title}')
  const [normalizationRules, setNormalizationRules] = useState<NormalizationRule[]>(() => normalizationService.getRules())
  const [newRulePattern, setNewRulePattern] = useState('')
  const [newRuleTarget, setNewRuleTarget] = useState('')

  // Calculate Health Score
  const totalAuditWeight = auditIssues.reduce((acc, issue) => {
    return acc + (issue.severity === 'critical' ? 10 : issue.severity === 'warning' ? 5 : 2)
  }, 0)
  const healthScore = Math.max(10, Math.min(100, Math.round(100 - (totalAuditWeight / Math.max(1, tracks.length)) * 100)))

  // Filter issues
  const filteredIssues = auditIssues.filter((issue) => {
    if (selectedIssueCategory === 'all') return true
    if (selectedIssueCategory === 'critical') return issue.severity === 'critical'
    if (selectedIssueCategory === 'warning') return issue.severity === 'warning'
    if (selectedIssueCategory === 'info') return issue.severity === 'info'
    return true
  })

  // Impacted albums count
  const allAffectedTrackIds = new Set(auditIssues.flatMap((i) => i.sampleTrackIds || []))
  const impactedAlbumsCount = new Set(
    tracks.filter((t) => allAffectedTrackIds.has(t.id)).map((t) => t.releaseId).filter(Boolean)
  ).size

  // Path restructure preview
  const previewSampleTracks = tracks.slice(0, 8).map((t) => {
    const rel = releases.find((r) => r.id === t.releaseId)
    const proposed = pathPattern
      .replace('{Artist}', t.artistCredit || 'Unknown Artist')
      .replace('{Year}', String(rel?.releaseYear || 'Unknown Year'))
      .replace('{Album}', rel?.title || 'Unknown Album')
      .replace('{TrackNum}', String(t.trackNumber || 1).padStart(2, '0'))
      .replace('{Title}', t.title)
    return {
      id: t.id,
      current: t.filePath,
      proposed: proposed + '.' + (t.format || 'flac').toLowerCase(),
    }
  })

  const handleAddNormalizationRule = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newRulePattern.trim() || !newRuleTarget.trim()) return
    normalizationService.recordNormalization(newRulePattern.trim(), newRuleTarget.trim(), 'artist')
    setNormalizationRules(normalizationService.getRules())
    setNewRulePattern('')
    setNewRuleTarget('')
    showToast(`Saved preferred name rule: "${newRulePattern}" → "${newRuleTarget}"`)
    onRefreshAudit()
  }

  const handleDeleteRule = (ruleId: string) => {
    normalizationService.removeRule(ruleId)
    setNormalizationRules(normalizationService.getRules())
    showToast('Rule deleted')
    onRefreshAudit()
  }

  return (
    <div className="flex-1 flex overflow-hidden bg-[#0D0E12] select-none">
      {/* 1. Maintain Lifecycle Sub-Navigation (Left Rail) */}
      <aside className="w-64 border-r border-white/10 bg-[#0A0C10] p-4 flex flex-col justify-between shrink-0">
        <div className="space-y-4 text-xs">
          {/* Header */}
          <div className="flex items-center justify-between pb-2 border-b border-white/10">
            <span className="font-mono text-[10px] uppercase font-bold tracking-wider text-slate-400">
              Maintenance Cockpit
            </span>
            <span
              className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full ${
                healthScore >= 90
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : healthScore >= 70
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
              }`}
            >
              {healthScore}% Health
            </span>
          </div>

          {/* Navigation Links */}
          <div className="space-y-1">
            <button
              onClick={() => setActiveTab('needs_attention')}
              className={`w-full px-3 py-2 rounded-xl text-left font-semibold flex items-center justify-between transition-all cursor-pointer ${
                activeTab === 'needs_attention'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span>Needs Attention</span>
              </div>
              {impactedAlbumsCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/40 font-mono text-amber-300 border border-amber-500/30">
                  {impactedAlbumsCount}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('organize_files')}
              className={`w-full px-3 py-2 rounded-xl text-left font-semibold flex items-center justify-between transition-all cursor-pointer ${
                activeTab === 'organize_files'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2">
                <FolderTree className="w-4 h-4 text-cyan-400" />
                <span>Organize File Names</span>
              </div>
            </button>

            <button
              onClick={() => setActiveTab('metadata_matching')}
              className={`w-full px-3 py-2 rounded-xl text-left font-semibold flex items-center justify-between transition-all cursor-pointer ${
                activeTab === 'metadata_matching'
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-400" />
                <span>Metadata Matching</span>
              </div>
            </button>

            <button
              onClick={() => setActiveTab('storage_mounts')}
              className={`w-full px-3 py-2 rounded-xl text-left font-semibold flex items-center justify-between transition-all cursor-pointer ${
                activeTab === 'storage_mounts'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-emerald-400" />
                <span>Storage & Watched</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-500/20 text-emerald-300 font-mono border border-emerald-500/30">
                {watchedFolders.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('pending_changes')}
              className={`w-full px-3 py-2 rounded-xl text-left font-semibold flex items-center justify-between transition-all cursor-pointer ${
                activeTab === 'pending_changes'
                  ? 'bg-lime-500/20 text-lime-300 border border-lime-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-lime-400" />
                <span>Review & Save</span>
              </div>
              {uncommittedCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-lime-500/20 text-lime-300 border border-lime-500/30 font-mono">
                  {uncommittedCount}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Bottom Back to Library Link */}
        <div className="pt-3 border-t border-white/10 space-y-2">
          <button
            onClick={onSwitchToLibrary}
            className="w-full py-2 px-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 hover:text-white text-xs font-mono flex items-center justify-between transition-all cursor-pointer"
          >
            <span>← Return to Library</span>
            <span className="text-[10px] text-slate-500">⌘1</span>
          </button>
        </div>
      </aside>

      {/* 2. Main Workbench Area (Center Stage) */}
      <main className="flex-1 flex flex-col overflow-y-auto">
        {/* TAB 1: NEEDS ATTENTION */}
        {activeTab === 'needs_attention' && (
          <div className="p-6 space-y-6">
            {/* Top Overview Card */}
            <div className="p-4 rounded-2xl bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border border-amber-500/30 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  <span>Library Hygiene Status</span>
                </h2>
                <p className="text-xs text-slate-300 mt-1">
                  {impactedAlbumsCount} albums have issues across metadata tags, cover art, or file naming.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={onRefreshAudit}
                  className="px-3 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] text-xs font-mono text-slate-300 hover:text-white flex items-center gap-1.5 transition-all cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Re-scan Hygiene</span>
                </button>
              </div>
            </div>

            {/* Filter Tabs */}
            <div className="flex items-center gap-2 pb-2 border-b border-white/10 text-xs">
              <button
                onClick={() => setSelectedIssueCategory('all')}
                className={`px-3 py-1 rounded-lg font-medium transition-all ${
                  selectedIssueCategory === 'all'
                    ? 'bg-white/10 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                All Issues ({auditIssues.length})
              </button>
              <button
                onClick={() => setSelectedIssueCategory('critical')}
                className={`px-3 py-1 rounded-lg font-medium transition-all ${
                  selectedIssueCategory === 'critical'
                    ? 'bg-rose-500/20 text-rose-300'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Critical ({auditIssues.filter((i) => i.severity === 'critical').length})
              </button>
              <button
                onClick={() => setSelectedIssueCategory('warning')}
                className={`px-3 py-1 rounded-lg font-medium transition-all ${
                  selectedIssueCategory === 'warning'
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Warnings ({auditIssues.filter((i) => i.severity === 'warning').length})
              </button>
            </div>

            {/* Issues List */}
            <div className="space-y-3">
              {filteredIssues.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-xs">
                  ✓ No issues found in this category. Your library is healthy!
                </div>
              ) : (
                filteredIssues.map((issue) => (
                  <div
                    key={issue.id}
                    className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.08] hover:border-white/20 transition-all flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[9px] font-mono uppercase font-bold px-1.5 py-0.5 rounded ${
                            issue.severity === 'critical'
                              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                              : issue.severity === 'warning'
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                              : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                          }`}
                        >
                          {issue.severity}
                        </span>
                        <span className="font-bold text-white text-xs">{issue.title}</span>
                      </div>
                      <p className="text-slate-400 text-xs">{issue.description}</p>
                      {issue.suggestedFix && (
                        <p className="text-emerald-400 font-mono text-[11px]">
                          Suggestion: {issue.suggestedFix}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => onRemediateAudit(issue.id)}
                        className="px-3 py-1.5 bg-gradient-to-r from-amber-400 to-lime-400 text-black font-bold text-xs rounded-xl hover:brightness-110 transition-all cursor-pointer"
                      >
                        Auto-Fix Issue
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Embedded Quarantine / Skipped Files Section */}
            {skippedFiles.length > 0 && (
              <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-rose-300 font-bold text-xs">
                    <AlertTriangle className="w-4 h-4 text-rose-400" />
                    <span>Quarantined / Unparseable Files ({skippedFiles.length})</span>
                  </div>
                </div>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {skippedFiles.map((sf, idx) => (
                    <div
                      key={idx}
                      className="p-2 bg-black/40 rounded-lg border border-white/10 text-[11px] font-mono text-slate-300 flex items-center justify-between"
                    >
                      <span className="truncate max-w-lg">{sf.filePath}</span>
                      <span className="text-rose-400 shrink-0">{sf.diagnosticError || 'Failed to import'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: ORGANIZE FILE NAMES */}
        {activeTab === 'organize_files' && (
          <div className="p-6 space-y-6">
            <div className="p-4 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 space-y-3">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <FolderTree className="w-4 h-4 text-cyan-400" />
                <span>Dynamic Path & File Name Rule Builder</span>
              </h2>
              <p className="text-xs text-slate-300">
                Structure on-disk audio directories consistently. All changes are verified for filename collisions before writing.
              </p>

              {/* Template Input */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-slate-400 uppercase">
                  Path Naming Pattern
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={pathPattern}
                    onChange={(e) => setPathPattern(e.target.value)}
                    className="flex-1 px-3 py-2 bg-black/60 border border-white/20 rounded-xl font-mono text-xs text-cyan-300 focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    onClick={() => {
                      onApplyPathRestructure(pathPattern)
                      showToast(`Applied path restructuring rule across ${tracks.length} tracks. Staged for review.`)
                    }}
                    className="px-4 py-2 bg-cyan-400 hover:bg-cyan-300 text-black font-bold text-xs rounded-xl transition-all cursor-pointer shrink-0"
                  >
                    Stage Path Restructure
                  </button>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500 pt-1">
                  <span>Available Tokens:</span>
                  <span className="text-slate-400">{'{Artist}'}</span>
                  <span className="text-slate-400">{'{Album}'}</span>
                  <span className="text-slate-400">{'{Year}'}</span>
                  <span className="text-slate-400">{'{TrackNum}'}</span>
                  <span className="text-slate-400">{'{Title}'}</span>
                </div>
              </div>
            </div>

            {/* Live Transformation Preview */}
            <div className="space-y-3">
              <span className="text-xs font-bold text-white font-mono uppercase tracking-wider">
                Live Disk Transformation Preview ({previewSampleTracks.length} sample tracks)
              </span>

              <div className="rounded-xl border border-white/10 bg-[#0B0D12] overflow-hidden text-xs">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/[0.02] text-slate-400 font-mono text-[10px]">
                      <th className="p-3">Current Path on Disk</th>
                      <th className="p-3 w-8"></th>
                      <th className="p-3 text-cyan-400">Proposed New Path</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05] font-mono text-[11px]">
                    {previewSampleTracks.map((item) => (
                      <tr key={item.id} className="hover:bg-white/[0.02]">
                        <td className="p-3 text-slate-400 truncate max-w-sm">{item.current}</td>
                        <td className="p-3 text-slate-600">→</td>
                        <td className="p-3 text-emerald-400 truncate max-w-sm">{item.proposed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: METADATA MATCHING & PREFERRED NAMES */}
        {activeTab === 'metadata_matching' && (
          <div className="p-6 space-y-6">
            <div className="p-4 rounded-2xl bg-purple-500/10 border border-purple-500/30 space-y-2">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-400" />
                <span>Preferred Names & Spelling Rules</span>
              </h2>
              <p className="text-xs text-slate-300">
                Establish authoritative artist and composer spellings. All incoming scans and cloud matches automatically adhere to your preferred rules.
              </p>
            </div>

            {/* Add Rule Form */}
            <form onSubmit={handleAddNormalizationRule} className="p-4 rounded-xl bg-white/[0.02] border border-white/10 space-y-3 text-xs">
              <span className="font-bold text-white font-mono text-xs">Add New Preferred Spelling Rule</span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-slate-400 uppercase">Incoming Variant Pattern</label>
                  <input
                    type="text"
                    placeholder='e.g. "AR Rahman" or "A. R. Rahman"'
                    value={newRulePattern}
                    onChange={(e) => setNewRulePattern(e.target.value)}
                    className="w-full mt-1 px-3 py-1.5 bg-black/40 border border-white/20 rounded-lg text-white font-mono text-xs focus:outline-none focus:border-purple-400"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-slate-400 uppercase">Preferred Canonical Name</label>
                  <input
                    type="text"
                    placeholder='e.g. "A.R.Rahman"'
                    value={newRuleTarget}
                    onChange={(e) => setNewRuleTarget(e.target.value)}
                    className="w-full mt-1 px-3 py-1.5 bg-black/40 border border-white/20 rounded-lg text-emerald-300 font-mono text-xs focus:outline-none focus:border-emerald-400"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-purple-500 hover:bg-purple-400 text-white font-bold text-xs rounded-lg transition-all cursor-pointer"
                >
                  Save Preferred Rule
                </button>
              </div>
            </form>

            {/* Existing Rules Ledger */}
            <div className="space-y-2">
              <span className="text-xs font-bold text-white font-mono uppercase tracking-wider">
                Active Preferred Rules ({normalizationRules.length})
              </span>
              <div className="space-y-1.5">
                {normalizationRules.length === 0 ? (
                  <div className="p-4 text-center text-slate-500 text-xs">No custom rules registered yet.</div>
                ) : (
                  normalizationRules.map((r: NormalizationRule) => (
                    <div
                      key={r.id}
                      className="p-3 bg-white/[0.02] border border-white/[0.08] rounded-xl flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-3 font-mono">
                        <span className="text-slate-400">"{r.sourcePattern}"</span>
                        <span className="text-slate-600">→</span>
                        <span className="text-emerald-400 font-bold">"{r.targetValue}"</span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300">
                          {r.field}
                        </span>
                      </div>
                      <button
                        onClick={() => handleDeleteRule(r.id)}
                        className="text-slate-500 hover:text-rose-400 p-1 transition-colors cursor-pointer"
                        title="Delete rule"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: STORAGE & WATCHED FOLDERS HUB */}
        {activeTab === 'storage_mounts' && (
          <div className="p-6 space-y-6">
            {/* Header Banner */}
            <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-emerald-400" />
                  <span>Storage & Watched Folders Hub</span>
                </h2>
                <p className="text-xs text-slate-300 max-w-xl">
                  Add and monitor audio directories from local SSDs, USB drives, and network SMB shares. Real-time background indexing discovers newly added albums with bit-rot and ghost-track protection.
                </p>
              </div>

              {onAddWatchedFolder && (
                <button
                  onClick={onAddWatchedFolder}
                  className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 hover:from-emerald-300 hover:to-cyan-300 text-black font-extrabold text-xs shadow-lg shadow-emerald-500/20 flex items-center gap-2 transition-all cursor-pointer shrink-0 font-mono"
                  title="Add audio directory to library"
                >
                  <FolderPlus className="w-4 h-4 text-black stroke-[2.5]" />
                  <span>+ Add Watched Folder</span>
                </button>
              )}
            </div>

            {/* SECTION 1: MONITORED WATCHED DIRECTORIES */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white font-mono uppercase tracking-wider flex items-center gap-2">
                  <Folder className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Monitored Music Folders ({watchedFolders.length})</span>
                </span>
                <span className="text-[10px] text-slate-500 font-mono">
                  Indexed with SQLite WAL
                </span>
              </div>

              {watchedFolders.length === 0 ? (
                <div className="p-8 border-2 border-dashed border-white/10 rounded-2xl text-center space-y-3 bg-black/20">
                  <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 mx-auto flex items-center justify-center">
                    <FolderPlus className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">No Watched Directories Added Yet</h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Connect your audio folder to start indexing FLAC, DSD, ALAC, and WAV files.
                    </p>
                  </div>
                  {onAddWatchedFolder && (
                    <button
                      onClick={onAddWatchedFolder}
                      className="px-4 py-2 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-black font-bold text-xs transition-all cursor-pointer font-mono inline-flex items-center gap-1.5"
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      <span>Choose Music Folder</span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {watchedFolders.map((wf) => {
                    const mount = storageMounts.find((m) => m.id === wf.mountId)
                    return (
                      <div
                        key={wf.id}
                        className="p-3.5 rounded-xl bg-white/[0.02] border border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-white text-sm truncate">
                              {wf.displayName || wf.folderPath.split(/[/\\]/).filter(Boolean).pop()}
                            </span>
                            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                              {wf.scanMode === 'realtime' ? 'Real-Time Watch' : 'Manual Scan'}
                            </span>
                            {mount && (
                              <span className="text-[10px] font-mono text-slate-500">
                                on {mount.name}
                              </span>
                            )}
                          </div>
                          <div className="text-slate-400 font-mono text-[11px] truncate">
                            {wf.folderPath}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => onTriggerScan(wf.folderPath)}
                            className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-mono flex items-center gap-1.5 transition-all cursor-pointer"
                            title="Rescan folder for new/modified files"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            <span>Rescan Folder</span>
                          </button>

                          {onRemoveWatchedFolder && (
                            <button
                              onClick={() => onRemoveWatchedFolder(wf.id)}
                              className="p-1.5 rounded-lg hover:bg-rose-500/20 text-slate-500 hover:text-rose-400 border border-transparent hover:border-rose-500/30 transition-all cursor-pointer"
                              title="Remove folder from watched list"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* SECTION 2: PHYSICAL STORAGE MOUNTS & DISCONNECTED DRIVE PROTECTION */}
            <div className="space-y-3 pt-4 border-t border-white/[0.08]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white font-mono uppercase tracking-wider flex items-center gap-2">
                  <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Physical Storage Mounts & Drives ({storageMounts.length})</span>
                </span>
                <span className="text-[10px] text-slate-500 font-mono">
                  Hardware Level Locks
                </span>
              </div>

              <div className="space-y-2">
                {storageMounts.map((mount) => (
                  <div
                    key={mount.id}
                    className="p-3.5 rounded-xl bg-white/[0.02] border border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-sm">{mount.name}</span>
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.2 rounded ${
                            mount.status === 'online'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                          }`}
                        >
                          {(mount.status || 'online').toUpperCase()}
                        </span>
                        {mount.isReadOnlyLocked && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                            <Lock className="w-2.5 h-2.5" /> RO LOCK
                          </span>
                        )}
                        <span className="text-[10px] font-mono text-slate-500">
                          {mount.fileSystem}
                        </span>
                      </div>
                      <div className="text-slate-400 font-mono text-[11px] truncate">{mount.mountPath}</div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => onToggleMountLock(mount.id)}
                        className="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-xs font-mono text-slate-300 hover:text-white flex items-center gap-1.5 transition-all cursor-pointer"
                        title={mount.isReadOnlyLocked ? "Unlock mount for edits" : "Lock mount as read-only"}
                      >
                        {mount.isReadOnlyLocked ? <Unlock className="w-3.5 h-3.5 text-amber-400" /> : <Lock className="w-3.5 h-3.5 text-emerald-400" />}
                        <span>{mount.isReadOnlyLocked ? 'Unlock (RW)' : 'Lock (RO)'}</span>
                      </button>

                      <button
                        onClick={() => onTriggerScan(mount.mountPath)}
                        className="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 text-xs font-mono transition-all cursor-pointer"
                      >
                        Rescan Mount
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: REVIEW & SAVE CHANGES (TWO-PHASE COMMIT) */}
        {activeTab === 'pending_changes' && (
          <div className="p-6 space-y-6">
            <div className="p-4 rounded-2xl bg-lime-500/10 border border-lime-500/30 space-y-2">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-lime-400" />
                <span>Review & Save Pending Changes</span>
              </h2>
              <p className="text-xs text-slate-300">
                All changes made across metadata, artwork, and path rules are held safely in memory sidecars. Committing writes clean metadata without altering audio stream PCM.
              </p>
            </div>

            <div className="p-6 bg-[#0E1118] border border-white/10 rounded-2xl text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-lime-500/15 border border-lime-500/30 mx-auto flex items-center justify-center text-lime-400 text-2xl font-bold font-mono">
                {uncommittedCount}
              </div>
              <div>
                <h3 className="text-base font-bold text-white">
                  {uncommittedCount > 0 ? `${uncommittedCount} Sidecar Edits Staged in Memory` : 'All Changes Committed to Disk'}
                </h3>
                <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                  {uncommittedCount > 0
                    ? 'Ready to write non-destructive sidecars and commit atomic tags directly to audio files.'
                    : 'Your music library is fully synchronized with disk. No pending writes.'}
                </p>
              </div>

              {uncommittedCount > 0 && (
                <button
                  onClick={onCommitTwoPhase}
                  className="px-6 py-2.5 bg-gradient-to-r from-lime-400 via-emerald-400 to-cyan-400 text-black font-extrabold text-xs rounded-xl shadow-lg shadow-lime-500/20 hover:brightness-110 transition-all cursor-pointer font-mono"
                >
                  Save {uncommittedCount} Changes to Disk (⌘S)
                </button>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
