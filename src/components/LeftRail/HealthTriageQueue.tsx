import React, { useState } from 'react'
import { AlertTriangle, CheckCircle2, ShieldAlert, Sparkles, ChevronRight, RotateCw, Filter, ShieldCheck, Info } from 'lucide-react'
import { AuditIssue } from '../../core/types'

interface HealthTriageQueueProps {
  issues: AuditIssue[]
  activeFilter?: string
  onSelectFilter: (filterId?: string) => void
  onRemediate: (issueId: string) => void
  healthScore?: number
  isFilteredScope?: boolean
  scopeTrackCount?: number
  totalTrackCount?: number
  onRefreshAudit?: () => void
}

export const HealthTriageQueue: React.FC<HealthTriageQueueProps> = ({
  issues,
  activeFilter,
  onSelectFilter,
  onRemediate,
  healthScore = 100,
  isFilteredScope = false,
  scopeTrackCount = 0,
  totalTrackCount = 0,
  onRefreshAudit,
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [showBreakdown, setShowBreakdown] = useState(false)
  const totalCount = issues.reduce((acc, i) => acc + i.affectedCount, 0)

  const handleRefreshClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsRefreshing(true)
    if (onRefreshAudit) onRefreshAudit()
    setTimeout(() => setIsRefreshing(false), 600)
  }

  const effectiveHealthScore = totalCount > 0 && healthScore >= 100 ? 99 : healthScore

  const getHealthBadgeStyle = (score: number) => {
    if (totalCount === 0 && score === 100) return 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30 hover:bg-[#10B981]/25'
    if (score >= 90) return 'bg-[#00F5FF]/15 text-[#00F5FF] border-[#00F5FF]/30 hover:bg-[#00F5FF]/25'
    if (score >= 70) return 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/30 hover:bg-[#F59E0B]/25'
    return 'bg-[#F43F5E]/15 text-[#F43F5E] border-[#F43F5E]/30 hover:bg-[#F43F5E]/25'
  }

  const autoFixableIssues = issues.filter((i) => i.isAutoFixable !== false && Boolean(i.autoFixAction) && i.affectedCount > 0)

  return (
    <div className="bento-card p-3.5 flex flex-col gap-2.5 bg-[#12151D]/90 border-white/[0.07] relative">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="relative">
            <ShieldAlert className={`w-4 h-4 ${totalCount > 0 ? 'text-[#F59E0B]' : 'text-[#10B981]'}`} />
            {totalCount > 0 && (
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-[#F43F5E] animate-ping" />
            )}
          </div>
          <span className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
            Health & Triage Queue
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Interactive Health Score Pill */}
          <button
            onClick={() => setShowBreakdown(!showBreakdown)}
            className={`text-[10px] font-bold px-2 py-0.5 rounded-full border flex items-center gap-1 cursor-pointer transition-all ${getHealthBadgeStyle(
              effectiveHealthScore
            )}`}
            title="Click to view mathematical health score breakdown & deductions"
          >
            {totalCount === 0 ? (
              <ShieldCheck className="w-3 h-3 text-[#10B981]" />
            ) : effectiveHealthScore >= 90 ? (
              <ShieldCheck className="w-3 h-3 text-[#00F5FF]" />
            ) : (
              <AlertTriangle className="w-3 h-3 text-[#F59E0B]" />
            )}
            <span>{effectiveHealthScore}% Health</span>
          </button>

          {/* Re-scan button */}
          {onRefreshAudit && (
            <button
              onClick={handleRefreshClick}
              title="Re-run Diagnostic Scan"
              className="p-1 rounded hover:bg-white/[0.08] text-[#64748B] hover:text-[#00F5FF] transition-all"
            >
              <RotateCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-[#00F5FF]' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {/* Health Score Mathematical Breakdown Modal / Dropdown */}
      {showBreakdown && (
        <div className="p-3 rounded-xl bg-[#0F121A] border border-[#00F5FF]/30 shadow-2xl flex flex-col gap-2 text-xs">
          <div className="flex items-center justify-between border-b border-white/[0.08] pb-1.5">
            <span className="font-semibold text-white flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-[#00F5FF]" />
              Health Score Breakdown
            </span>
            <span className="text-[10px] font-mono text-[#94A3B8]">
              Base 100%
            </span>
          </div>

          <div className="flex flex-col gap-1.5 text-[11px]">
            {issues.filter(i => i.affectedCount > 0).length === 0 ? (
              <span className="text-[#10B981]">No active defects. Perfect 100% sound health.</span>
            ) : (
              issues.filter(i => i.affectedCount > 0).map((issue) => {
                const ratio = Math.min(1, issue.affectedCount / Math.max(1, totalTrackCount || 1))
                const deduction = issue.severity === 'critical'
                  ? Math.round(10 + ratio * 50)
                  : issue.severity === 'warning'
                  ? Math.round(4 + ratio * 20)
                  : Math.round(1 + ratio * 5)

                return (
                  <div key={issue.id} className="flex items-center justify-between text-[#94A3B8]">
                    <span className="truncate pr-2">{issue.title} ({issue.affectedCount} tracks)</span>
                    <span className="font-mono text-[#F43F5E] font-semibold shrink-0">
                      -{deduction}%
                    </span>
                  </div>
                )
              })
            )}
          </div>

          <div className="pt-1.5 border-t border-white/[0.08] flex items-center justify-between text-xs font-bold text-white">
            <span>Net Calculated Score</span>
            <span className={effectiveHealthScore >= 90 ? 'text-[#00F5FF]' : effectiveHealthScore >= 70 ? 'text-[#F59E0B]' : 'text-[#F43F5E]'}>
              {effectiveHealthScore}%
            </span>
          </div>
        </div>
      )}

      {/* 1-Click Batch Auto-Remediation Banner */}
      {autoFixableIssues.length > 0 && (
        <div className="p-2 rounded-lg bg-[#00F5FF]/5 border border-[#00F5FF]/20 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[10px] text-[#00F5FF]">
            <span className="font-semibold flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              1-Click Intelligent Batch Cleanups
            </span>
            <span className="font-mono text-[#94A3B8]">
              {autoFixableIssues.length} Available
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {autoFixableIssues.slice(0, 3).map((iss) => (
              <button
                key={iss.id}
                onClick={() => onRemediate(iss.id)}
                className="px-2 py-1 rounded bg-[#00F5FF]/15 hover:bg-[#00F5FF]/25 border border-[#00F5FF]/30 text-[#00F5FF] text-[10px] font-medium transition-all flex items-center gap-1 cursor-pointer"
              >
                <Sparkles className="w-2.5 h-2.5" />
                {iss.fixActionLabel || 'Auto Fix'}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Dynamic Scope Badge */}
      <div className="flex items-center justify-between px-2 py-1 rounded-md bg-white/[0.03] border border-white/[0.05] text-[10px]">
        <div className="flex items-center gap-1.5">
          <Filter className={`w-3 h-3 ${isFilteredScope ? 'text-[#00F5FF]' : 'text-[#64748B]'}`} />
          <span className="text-[#94A3B8]">Scope:</span>
          <span className={isFilteredScope ? 'text-[#00F5FF] font-semibold' : 'text-[#CBD5E1]'}>
            {isFilteredScope
              ? `Filtered (${scopeTrackCount} of ${totalTrackCount} tracks)`
              : `All Library (${scopeTrackCount || totalTrackCount} tracks)`}
          </span>
        </div>
        <span
          className={`font-semibold px-1.5 py-0.2 rounded text-[9px] ${
            totalCount > 0
              ? 'bg-[#F59E0B]/20 text-[#F59E0B]'
              : 'bg-[#10B981]/20 text-[#10B981]'
          }`}
        >
          {totalCount} {totalCount === 1 ? 'Anomaly' : 'Anomalies'}
        </span>
      </div>

      {/* Issues list */}
      <div className="flex flex-col gap-1.5 mt-0.5">
        {issues.length === 0 ? (
          <div className="text-center py-3 text-[11px] text-[#10B981] font-mono flex flex-col items-center justify-center gap-1 bg-[#10B981]/5 rounded-lg border border-[#10B981]/20">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-[#10B981]" />
              <span className="font-semibold">Clean Catalog &bull; 100% Sound</span>
            </div>
            <span className="text-[10px] text-[#64748B]">
              No tagging, artwork, or stream anomalies in this scope.
            </span>
          </div>
        ) : (
          issues.map((issue) => {
            const isSelected = activeFilter === issue.id || activeFilter === issue.category
            const isResolved = issue.affectedCount === 0

            return (
              <div
                key={issue.id}
                data-tutorial-id="audit-issue-item"
                onClick={() => onSelectFilter(isSelected ? undefined : issue.id)}
                className={`group flex items-start justify-between p-2 rounded-lg cursor-pointer transition-all text-left text-xs border ${
                  isSelected
                    ? 'bg-[#00F5FF]/10 border-[#00F5FF]/40 text-[#F1F5F9] shadow-sm shadow-[#00F5FF]/10'
                    : isResolved
                    ? 'bg-white/[0.02] border-white/[0.04] text-[#64748B]'
                    : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06] text-[#94A3B8]'
                }`}
              >
                <div className="flex items-start gap-2 flex-1 pr-2">
                  {isResolved ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-[#10B981] mt-0.5 shrink-0" />
                  ) : issue.severity === 'critical' ? (
                    <AlertTriangle className="w-3.5 h-3.5 text-[#F43F5E] mt-0.5 shrink-0" />
                  ) : issue.severity === 'info' ? (
                    <Info className="w-3.5 h-3.5 text-[#00F5FF] mt-0.5 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 text-[#F59E0B] mt-0.5 shrink-0" />
                  )}
                  <div className="flex flex-col">
                    <span
                      className={`font-medium line-clamp-1 ${
                        isResolved ? 'line-through text-[#64748B]' : 'text-[#F1F5F9]'
                      }`}
                    >
                      {issue.title}
                    </span>
                    <span className="text-[10px] text-[#64748B] line-clamp-1">
                      {issue.description}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {!isResolved && issue.isAutoFixable !== false && Boolean(issue.autoFixAction) && (
                    <button
                      data-tutorial-id="audit-remediate-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemediate(issue.id)
                      }}
                      title={issue.suggestedFix || "1-Click Auto Remediate into Sidecars"}
                      className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded bg-[#00F5FF]/20 text-[#00F5FF] hover:bg-[#00F5FF]/30 transition-all text-[10px] flex items-center gap-1 font-semibold border border-[#00F5FF]/30 shadow-sm cursor-pointer"
                    >
                      <Sparkles className="w-2.5 h-2.5" />
                      {issue.fixActionLabel || 'Fix'}
                    </button>
                  )}
                  {!isResolved && (issue.isAutoFixable === false || !issue.autoFixAction) && (
                    <span
                      title={issue.manualActionHint || issue.suggestedFix || "Requires manual triage or physical file repair"}
                      className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded bg-white/[0.05] text-[#94A3B8] border border-white/[0.08] text-[9px] font-mono tracking-tight cursor-help"
                    >
                      Manual Triage
                    </span>
                  )}
                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-semibold ${
                      isResolved
                        ? 'bg-white/[0.05] text-[#64748B]'
                        : issue.severity === 'critical'
                        ? 'bg-[#F43F5E]/20 text-[#F43F5E]'
                        : issue.severity === 'info'
                        ? 'bg-[#00F5FF]/20 text-[#00F5FF]'
                        : 'bg-[#F59E0B]/20 text-[#F59E0B]'
                    }`}
                  >
                    {issue.affectedCount}
                  </span>
                  <ChevronRight
                    className={`w-3 h-3 transition-all ${
                      isSelected
                        ? 'text-[#00F5FF] rotate-90'
                        : 'text-[#64748B] opacity-0 group-hover:opacity-100'
                    }`}
                  />
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
