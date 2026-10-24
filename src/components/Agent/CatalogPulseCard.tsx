import React from 'react'
import {
  Sparkles,
  BarChart3,
  FolderTree,
  Headphones,
  Zap,
  Image,
  Music,
  Layers,
  Search,
} from 'lucide-react'
import { CatalogStatistics } from '../../services/agentSnapshotService'

interface CatalogPulseCardProps {
  stats: CatalogStatistics
  scopeType?: 'album' | 'catalog' | 'anomaly' | 'filter'
  scopeLabel?: string
  scopeDetail?: string
  albumTitle?: string
  onSelectAction: (prompt: string) => void
}

export const CatalogPulseCard: React.FC<CatalogPulseCardProps> = ({
  stats,
  scopeType = 'catalog',
  albumTitle,
  onSelectAction,
}) => {
  const isAlbumScoped = scopeType === 'album' && Boolean(albumTitle)

  // Health score semantic color coding: Emerald (>=85%), Amber (50-84%), Rose (<50%)
  const healthColor =
    stats.healthScore >= 85
      ? 'text-[#10B981]'
      : stats.healthScore >= 50
      ? 'text-[#F59E0B]'
      : 'text-[#F43F5E]'

  const hasAuditRun = Boolean(stats.lastAuditTimestamp)

  return (
    <div className="p-4 rounded-2xl bg-gradient-to-b from-[#151922] via-[#12161F] to-[#0E1118] border border-white/[0.09] shadow-2xl flex flex-col gap-3.5 select-none animate-in fade-in duration-200">
      {/* 1. Header with Live Graph Connection indicator */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="p-2 rounded-xl bg-gradient-to-tr from-[#00F5FF]/20 to-[#ADFF2F]/20 border border-[#00F5FF]/40 text-[#00F5FF] shadow-inner shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <h3 className="font-bold text-white text-xs tracking-wide truncate">Catalog Intelligence Pulse</h3>
            <span className="text-[10px] text-[#94A3B8] truncate">
              In-Memory Graph &bull; {stats.uncommittedSidecars || 0} Pending Sidecars
            </span>
          </div>
        </div>
        <div className="shrink-0 whitespace-nowrap flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30 text-[10px] font-mono">
          <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-pulse" />
          <span>Live Graph</span>
        </div>
      </div>

      {/* 2. Reactive 4-Column Metrics Bento */}
      <div className="grid grid-cols-4 gap-2 text-center">
        <div className="p-2.5 rounded-xl bg-white/[0.025] border border-white/[0.06] flex flex-col gap-0.5">
          <span className="text-[9px] uppercase font-mono text-[#64748B]">Tracks</span>
          <p className="text-sm font-bold text-white font-mono">{stats.totalTracks.toLocaleString()}</p>
        </div>
        <div className="p-2.5 rounded-xl bg-white/[0.025] border border-white/[0.06] flex flex-col gap-0.5">
          <span className="text-[9px] uppercase font-mono text-[#64748B]">Releases</span>
          <p className="text-sm font-bold text-[#CBD5E1] font-mono">{stats.totalReleases.toLocaleString()}</p>
        </div>
        <div className="p-2.5 rounded-xl bg-white/[0.025] border border-white/[0.06] flex flex-col gap-0.5 items-center justify-center">
          <span className="text-[9px] uppercase font-mono text-[#64748B]">Health</span>
          {hasAuditRun ? (
            <p className={`text-sm font-bold font-mono ${healthColor}`}>{stats.healthScore}%</p>
          ) : (
            <button
              onClick={() => onSelectAction('Run hygiene check scan on library')}
              title="Run library health audit"
              className="text-xs font-bold text-[#00F5FF] hover:underline flex items-center gap-1 cursor-pointer"
            >
              <span>Scan</span>
              <Sparkles className="w-2.5 h-2.5" />
            </button>
          )}
        </div>
        <div className="p-2.5 rounded-xl bg-white/[0.025] border border-white/[0.06] flex flex-col gap-0.5">
          <span className="text-[9px] uppercase font-mono text-[#64748B]">Hi-Res / DSD</span>
          <p className="text-sm font-bold text-[#ADFF2F] font-mono">{stats.hiRes24BitCount}</p>
        </div>
      </div>

      {/* 3. Scope-Conditional Semantic Starter Pills */}
      <div className="flex flex-col gap-2 pt-2 border-t border-white/[0.06]">
        <div className="flex items-center justify-between text-[10px] text-[#64748B] font-mono uppercase tracking-wider">
          <span>{isAlbumScoped ? 'Album Actions' : 'Curator Quick Actions'}</span>
          <span>{isAlbumScoped ? 'Scoped Workbench' : 'Instant Dispatch'}</span>
        </div>

        {isAlbumScoped ? (
          /* Album Scoped Quick Actions */
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() =>
                onSelectAction(
                  `Fetch high-resolution 3000px cover art from Apple Music and rework panoramic backdrop for ${albumTitle}`
                )
              }
              className="p-2 rounded-xl bg-white/[0.03] hover:bg-[#00F5FF]/15 border border-white/[0.07] hover:border-[#00F5FF]/30 text-[#94A3B8] hover:text-[#00F5FF] text-[11px] font-medium flex items-center gap-2 transition-all cursor-pointer group text-left min-w-0"
            >
              <Image className="w-3.5 h-3.5 text-[#00F5FF] shrink-0 group-hover:scale-110 transition-transform" />
              <span className="truncate">Fetch 3000px Cover & Backdrop</span>
            </button>

            <button
              onClick={() =>
                onSelectAction(`Disentangle work hierarchy and playback credits for ${albumTitle}`)
              }
              className="p-2 rounded-xl bg-white/[0.03] hover:bg-[#ADFF2F]/15 border border-white/[0.07] hover:border-[#ADFF2F]/30 text-[#94A3B8] hover:text-[#ADFF2F] text-[11px] font-medium flex items-center gap-2 transition-all cursor-pointer group text-left min-w-0"
            >
              <Music className="w-3.5 h-3.5 text-[#ADFF2F] shrink-0 group-hover:scale-110 transition-transform" />
              <span className="truncate">Parse Movement & Credits</span>
            </button>

            <button
              onClick={() =>
                onSelectAction(`Compare variant pressings and find best master for ${albumTitle}`)
              }
              className="p-2 rounded-xl bg-white/[0.03] hover:bg-[#ADFF2F]/15 border border-white/[0.07] hover:border-[#ADFF2F]/30 text-[#94A3B8] hover:text-[#ADFF2F] text-[11px] font-medium flex items-center gap-2 transition-all cursor-pointer group text-left min-w-0"
            >
              <Layers className="w-3.5 h-3.5 text-[#ADFF2F] shrink-0 group-hover:scale-110 transition-transform" />
              <span className="truncate">Compare Pressing DR & Variants</span>
            </button>

            <button
              onClick={() =>
                onSelectAction(`Inspect graph metadata and run hygiene check on ${albumTitle}`)
              }
              className="p-2 rounded-xl bg-white/[0.03] hover:bg-[#00F5FF]/15 border border-white/[0.07] hover:border-[#00F5FF]/30 text-[#94A3B8] hover:text-[#00F5FF] text-[11px] font-medium flex items-center gap-2 transition-all cursor-pointer group text-left min-w-0"
            >
              <Search className="w-3.5 h-3.5 text-[#00F5FF] shrink-0 group-hover:scale-110 transition-transform" />
              <span className="truncate">Audit Album Metadata</span>
            </button>
          </div>
        ) : (
          /* Catalog Wide Quick Actions */
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => onSelectAction('Give me a complete statistical breakdown of my library')}
              className="p-2 rounded-xl bg-white/[0.03] hover:bg-[#00F5FF]/15 border border-white/[0.07] hover:border-[#00F5FF]/30 text-[#94A3B8] hover:text-[#00F5FF] text-[11px] font-medium flex items-center gap-2 transition-all cursor-pointer group text-left min-w-0"
            >
              <BarChart3 className="w-3.5 h-3.5 text-[#00F5FF] shrink-0 group-hover:scale-110 transition-transform" />
              <span className="truncate">Collection Statistics</span>
            </button>

            <button
              onClick={() => onSelectAction('What actions do you recommend next?')}
              className="p-2 rounded-xl bg-white/[0.03] hover:bg-[#ADFF2F]/15 border border-white/[0.07] hover:border-[#ADFF2F]/30 text-[#94A3B8] hover:text-[#ADFF2F] text-[11px] font-medium flex items-center gap-2 transition-all cursor-pointer group text-left min-w-0"
            >
              <Zap className="w-3.5 h-3.5 text-[#ADFF2F] shrink-0 group-hover:scale-110 transition-transform" />
              <span className="truncate">Prioritized Next Actions</span>
            </button>

            <button
              onClick={() => onSelectAction('Auto-extract missing artists from directory hierarchy')}
              className="p-2 rounded-xl bg-white/[0.03] hover:bg-[#ADFF2F]/15 border border-white/[0.07] hover:border-[#ADFF2F]/30 text-[#94A3B8] hover:text-[#ADFF2F] text-[11px] font-medium flex items-center gap-2 transition-all cursor-pointer group text-left min-w-0"
            >
              <FolderTree className="w-3.5 h-3.5 text-[#ADFF2F] shrink-0 group-hover:scale-110 transition-transform" />
              <span className="truncate">Auto-Resolve Artists</span>
            </button>

            <button
              onClick={() => onSelectAction('Filter catalog to 24-bit and DSD audiophile tracks')}
              className="p-2 rounded-xl bg-white/[0.03] hover:bg-[#00F5FF]/15 border border-white/[0.07] hover:border-[#00F5FF]/30 text-[#94A3B8] hover:text-[#00F5FF] text-[11px] font-medium flex items-center gap-2 transition-all cursor-pointer group text-left min-w-0"
            >
              <Headphones className="w-3.5 h-3.5 text-[#00F5FF] shrink-0 group-hover:scale-110 transition-transform" />
              <span className="truncate">Filter to Hi-Res 24-bit</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
