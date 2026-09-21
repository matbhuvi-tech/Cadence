import React, { useState } from 'react'
import {
  X,
  AlertTriangle,
  FolderOpen,
  RotateCw,
  EyeOff,
  CheckCircle2,
  FileCode,
  ShieldAlert,
} from 'lucide-react'
import { SkippedFile } from '../../core/types'
import { tauriBridge } from '../../services/tauriBridge'

interface QuarantineLogModalProps {
  isOpen: boolean
  onClose: () => void
  skippedFiles: SkippedFile[]
  onRefresh: () => void
  showToast: (msg: string) => void
}

export const QuarantineLogModal: React.FC<QuarantineLogModalProps> = ({
  isOpen,
  onClose,
  skippedFiles,
  onRefresh,
  showToast,
}) => {
  const [filterCategory, setFilterCategory] = useState<string>('all')

  if (!isOpen) return null

  const filtered =
    filterCategory === 'all'
      ? skippedFiles
      : skippedFiles.filter((s) => s.category === filterCategory)

  const handleLocate = async (filePath: string) => {
    try {
      await tauriBridge.showItemInFolder(filePath)
      showToast('Opened file in system explorer')
    } catch (err: any) {
      showToast(`Failed to open explorer: ${err.message || err}`)
    }
  }

  const handleIgnore = async (id: string, fileName: string) => {
    try {
      await tauriBridge.dbIgnoreSkippedFile(id)
      showToast(`Ignored "${fileName}"`)
      onRefresh()
    } catch (err: any) {
      showToast(`Error ignoring file: ${err.message || err}`)
    }
  }

  const getCategoryBadge = (category: string) => {
    switch (category) {
      case 'corrupt_header':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-rose-500/20 text-rose-300 border border-rose-500/30">
            Corrupt Header
          </span>
        )
      case 'zero_byte':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30">
            Zero-Byte File
          </span>
        )
      case 'unsupported_format':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-purple-500/20 text-purple-300 border border-purple-500/30">
            Unsupported Codec
          </span>
        )
      case 'permission_denied':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-red-500/20 text-red-300 border border-red-500/30">
            Permission Denied
          </span>
        )
      case 'duplicate':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-blue-500/20 text-blue-300 border border-blue-500/30">
            Duplicate
          </span>
        )
      default:
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-white/10 text-white/70">
            {category}
          </span>
        )
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="w-full max-w-4xl max-h-[85vh] rounded-2xl border border-white/[0.12] bg-[#0E1017] shadow-2xl flex flex-col text-white overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between bg-[#12151E]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-wide">
                Skipped Files & Quarantine Diagnostics
              </h2>
              <p className="text-xs text-white/50">
                Inspect and remediate unparseable, corrupted, or zero-byte audio files found during indexing.
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

        {/* Category Filters */}
        <div className="px-6 py-2.5 bg-white/[0.02] border-b border-white/[0.06] flex items-center gap-2 text-xs">
          <span className="text-white/40 mr-1">Filter:</span>
          {['all', 'corrupt_header', 'zero_byte', 'unsupported_format'].map((cat) => (
            <button
              key={cat}
              onClick={() => setFilterCategory(cat)}
              className={`px-3 py-1 rounded-lg transition-colors font-medium text-[11px] capitalize ${
                filterCategory === cat
                  ? 'bg-white/[0.15] text-white'
                  : 'text-white/40 hover:text-white/80 hover:bg-white/[0.04]'
              }`}
            >
              {cat.replace('_', ' ')}
            </button>
          ))}
          <span className="ml-auto text-white/40 font-mono text-[11px]">
            {filtered.length} files logged
          </span>
        </div>

        {/* Files List Table */}
        <div className="flex-1 overflow-y-auto p-6">
          {filtered.length === 0 ? (
            <div className="py-16 text-center text-white/40 space-y-2">
              <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto opacity-80" />
              <p className="text-sm font-medium text-white/80">No skipped files found</p>
              <p className="text-xs text-white/40">
                All audio files in your watched folders were successfully parsed into SQLite.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {filtered.map((file) => (
                <div
                  key={file.id}
                  className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/[0.15] transition-all flex items-start justify-between gap-4 text-xs"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2.5">
                      <span className="font-semibold text-white font-mono truncate">
                        {file.fileName}
                      </span>
                      {getCategoryBadge(file.category)}
                    </div>
                    <div className="font-mono text-white/40 text-[11px] truncate">
                      {file.filePath}
                    </div>
                    <div className="p-2 rounded-lg bg-rose-500/[0.06] border border-rose-500/20 text-rose-300 font-mono text-[10px] leading-relaxed">
                      {file.diagnosticError}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0 pt-1">
                    <button
                      onClick={() => handleLocate(file.filePath)}
                      title="Reveal file in Windows Explorer / Finder"
                      className="px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/70 hover:text-white flex items-center gap-1.5 transition-colors text-xs"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      Locate
                    </button>
                    <button
                      onClick={() => handleIgnore(file.id, file.fileName)}
                      title="Ignore this file in future scans"
                      className="p-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] text-white/40 hover:text-white transition-colors"
                    >
                      <EyeOff className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-[#12151E] border-t border-white/[0.08] flex items-center justify-between text-xs text-white/40">
          <div>
            Skipped items are safely isolated and do not prevent other tracks in the same directory from importing.
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-white/[0.08] hover:bg-white/[0.12] text-white font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
