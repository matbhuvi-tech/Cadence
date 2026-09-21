import React, { useState } from 'react'
import {
  Wand2,
  X,
  Check,
  ArrowRight,
  FolderTree,
  AlertCircle,
  FileCode,
  Sparkles,
  HelpCircle,
} from 'lucide-react'
import { Track } from '../../core/types'
import { templateEngine, TemplateEngine } from '../../core/templateEngine'

interface BatchRuleModalProps {
  tracks: Track[]
  onClose: () => void
  onApplyPathRestructure: (previews: { trackId: string; proposedPath: string }[]) => void
}

export const BatchRuleModal: React.FC<BatchRuleModalProps> = ({
  tracks,
  onClose,
  onApplyPathRestructure,
}) => {
  const [template, setTemplate] = useState<string>(TemplateEngine.DEFAULT_TEMPLATE)
  const [baseMount, setBaseMount] = useState<string>('/mnt/audiophile-nas/lossless')

  // Generate live restructure preview
  const previews = templateEngine.generateRestructurePreview(tracks, template, baseMount)
  const changedCount = previews.filter((p) => p.isChanged).length
  const collisionCount = previews.filter((p) => p.hasCollision).length

  const handleApply = () => {
    const toApply = previews.map((p) => ({
      trackId: p.trackId,
      proposedPath: p.proposedPath,
    }))
    onApplyPathRestructure(toApply)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#12151D] border border-white/[0.12] rounded-2xl w-full max-w-4xl max-h-[85vh] shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 px-6 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-[#ADFF2F]" />
            <h2 className="text-base font-bold text-[#F1F5F9]">
              Dynamic File & Directory Path Templating Engine
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Configuration Section */}
        <div className="p-5 border-b border-white/[0.06] flex flex-col gap-3 bg-[#0D0E12]/60 text-left">
          <div className="flex items-center justify-between">
            <label className="text-xs font-mono text-[#94A3B8] font-semibold">
              Deterministic Template Pattern Syntax
            </label>
            <span className="text-[11px] font-mono text-[#64748B] flex items-center gap-1">
              <HelpCircle className="w-3.5 h-3.5 text-[#00F5FF]" />
              Supports conditional branching &#123;%if classical%&#125; ... &#123;%else%&#125; ... &#123;%endif%&#125;
            </span>
          </div>

          <textarea
            rows={3}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            className="w-full bg-[#181C26] border border-white/[0.1] rounded-xl p-3 text-xs font-mono text-[#00F5FF] focus:outline-none focus:border-[#ADFF2F] leading-relaxed"
          />

          <div className="flex items-center gap-4 text-xs font-mono text-[#64748B]">
            <span className="text-[#94A3B8]">Tokens:</span>
            <span>{'{composer}'}</span>
            <span>{'{work}'}</span>
            <span>{'{movement_num}'}</span>
            <span>{'{movement_title}'}</span>
            <span>{'{artist}'}</span>
            <span>{'{album}'}</span>
            <span>{'{track_num:2}'}</span>
          </div>
        </div>

        {/* Dry Run Preview Grid */}
        <div className="flex-1 overflow-y-auto p-4 max-h-[360px] text-left">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono font-semibold text-[#94A3B8]">
              Dry-Run Path Simulation ({changedCount} files to restructure)
            </span>
            {collisionCount > 0 && (
              <span className="text-xs font-mono text-[#F43F5E] flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" />
                {collisionCount} Collision Warnings Detected
              </span>
            )}
          </div>

          <div className="flex flex-col divide-y divide-white/[0.04] border border-white/[0.06] rounded-xl overflow-hidden bg-[#0D0E12]">
            {previews.map((p) => (
              <div
                key={p.trackId}
                className="p-2.5 text-xs font-mono flex flex-col gap-1 hover:bg-white/[0.02]"
              >
                <div className="flex items-center justify-between text-[#64748B] text-[11px]">
                  <span className="truncate pr-2">From: {p.currentPath}</span>
                  {p.isChanged && (
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#ADFF2F]/15 text-[#ADFF2F] shrink-0">
                      Will Move
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <ArrowRight className="w-3.5 h-3.5 text-[#00F5FF] shrink-0" />
                  <span
                    className={`truncate font-semibold ${
                      p.isChanged ? 'text-[#00F5FF]' : 'text-[#64748B]'
                    }`}
                  >
                    To: {p.proposedPath}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 px-6 border-t border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <span className="text-xs text-[#64748B] flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-[#00F5FF]" />
            Relocations update database pointers automatically without breaking playlists.
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium text-[#94A3B8] hover:text-white"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={changedCount === 0 || collisionCount > 0}
              className="px-5 py-2 rounded-lg bg-[#ADFF2F] text-black font-bold text-xs hover:bg-[#ADFF2F]/90 transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check className="w-3.5 h-3.5 stroke-[3]" />
              Execute Dry-Run Path Restructure
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
