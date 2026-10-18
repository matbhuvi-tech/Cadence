import React, { useState, useEffect } from 'react'
import {
  X,
  Sparkles,
  Plus,
  Trash2,
  Check,
  RotateCcw,
  SlidersHorizontal,
  ArrowRight,
  ShieldCheck,
  Layers,
  FileCode,
} from 'lucide-react'
import {
  normalizationService,
  NormalizationRule,
  NormalizationField,
} from '../../services/normalizationService'
import { graphEngine } from '../../core/graphEngine'

interface NormalizationRulesModalProps {
  isOpen: boolean
  onClose: () => void
  onRefreshCatalog?: () => void
}

export const NormalizationRulesModal: React.FC<NormalizationRulesModalProps> = ({
  isOpen,
  onClose,
  onRefreshCatalog,
}) => {
  const [rules, setRules] = useState<NormalizationRule[]>([])
  const [sourceInput, setSourceInput] = useState('')
  const [targetInput, setTargetInput] = useState('')
  const [fieldInput, setFieldInput] = useState<NormalizationField>('artist')
  const [notice, setNotice] = useState<string | null>(null)
  const [isApplying, setIsApplying] = useState(false)

  const loadCurrentRules = () => {
    setRules(normalizationService.getRules())
  }

  useEffect(() => {
    if (isOpen) {
      loadCurrentRules()
      const unsubscribe = normalizationService.subscribe(() => {
        loadCurrentRules()
      })
      return () => unsubscribe()
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleAddRule = (e: React.FormEvent) => {
    e.preventDefault()
    if (!sourceInput.trim() || !targetInput.trim()) {
      setNotice('Please provide both source pattern and target canonical value.')
      return
    }

    normalizationService.recordNormalization(
      sourceInput.trim(),
      targetInput.trim(),
      fieldInput
    )
    setSourceInput('')
    setTargetInput('')
    setNotice(`Rule saved: "${sourceInput.trim()}" → "${targetInput.trim()}"`)
    setTimeout(() => setNotice(null), 3000)
  }

  const handleToggleRule = (id: string, current: boolean) => {
    normalizationService.toggleRule(id, !current)
  }

  const handleDeleteRule = (id: string) => {
    normalizationService.removeRule(id)
  }

  const handleApplyToCatalog = () => {
    setIsApplying(true)
    try {
      const modified = graphEngine.applyRememberedNormalizations()
      if (onRefreshCatalog) onRefreshCatalog()
      setNotice(
        modified > 0
          ? `Successfully applied normalization rules to ${modified} track(s) and staged sidecars.`
          : 'All loaded tracks already conform to active normalization rules.'
      )
      setTimeout(() => setNotice(null), 4000)
    } finally {
      setIsApplying(false)
    }
  }

  const totalMatches = rules.reduce((acc, r) => acc + (r.matchCount || 0), 0)
  const activeCount = rules.filter((r) => r.isEnabled).length

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#12151D] border border-white/[0.12] rounded-2xl w-full max-w-3xl max-h-[85vh] shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="p-4 px-6 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-[#ADFF2F]/10 border border-[#ADFF2F]/20 text-[#ADFF2F]">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-[#F1F5F9] flex items-center gap-2">
                <span>Remembered Normalization Rules</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#ADFF2F]/15 text-[#ADFF2F] border border-[#ADFF2F]/30 font-bold">
                  Precedence Enforced
                </span>
              </h2>
              <p className="text-xs text-[#94A3B8]">
                Rules remembered from audit remediation cleanups or defined manually. These rules take precedence in future Apple Music, MusicBrainz, and Gemini AI enrichments.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Telemetry / Summary Header */}
        <div className="px-6 py-3 bg-[#0D0E12]/80 border-b border-white/[0.06] flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-4 text-[#94A3B8]">
            <span>
              Total Rules: <strong className="text-white font-semibold">{rules.length}</strong>
            </span>
            <span>•</span>
            <span>
              Active: <strong className="text-[#ADFF2F] font-semibold">{activeCount}</strong>
            </span>
            <span>•</span>
            <span>
              Total Matches Resolved: <strong className="text-[#00F5FF] font-semibold">{totalMatches}</strong>
            </span>
          </div>

          <button
            type="button"
            onClick={handleApplyToCatalog}
            disabled={isApplying || activeCount === 0}
            className="px-3 py-1.5 rounded-xl bg-[#00F5FF]/10 hover:bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/30 text-xs font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-40"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Apply Rules to Loaded Catalog</span>
          </button>
        </div>

        {/* Notification banner */}
        {notice && (
          <div className="mx-6 mt-3 p-2.5 rounded-xl bg-[#ADFF2F]/10 border border-[#ADFF2F]/25 text-[#ADFF2F] text-xs font-mono flex items-center justify-between">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-[#ADFF2F]/60 hover:text-[#ADFF2F] p-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Add New Rule Form */}
        <form onSubmit={handleAddRule} className="p-4 px-6 border-b border-white/[0.06] bg-white/[0.01]">
          <div className="text-xs font-mono text-[#94A3B8] mb-2 font-semibold flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5 text-[#ADFF2F]" />
            <span>Add / Update Normalization Rule</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
            <div className="sm:col-span-4">
              <input
                type="text"
                value={sourceInput}
                onChange={(e) => setSourceInput(e.target.value)}
                placeholder="Source (e.g. A. R. Rahman)"
                className="w-full bg-[#181C26] border border-white/[0.1] rounded-xl px-3 py-2 text-xs font-mono text-white placeholder:text-[#64748B] focus:outline-none focus:border-[#ADFF2F]"
              />
            </div>

            <div className="sm:col-span-1 flex justify-center text-[#64748B]">
              <ArrowRight className="w-4 h-4" />
            </div>

            <div className="sm:col-span-4">
              <input
                type="text"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                placeholder="Target Canonical (e.g. A.R.Rahman)"
                className="w-full bg-[#181C26] border border-white/[0.1] rounded-xl px-3 py-2 text-xs font-mono text-white placeholder:text-[#64748B] focus:outline-none focus:border-[#ADFF2F]"
              />
            </div>

            <div className="sm:col-span-2">
              <select
                value={fieldInput}
                onChange={(e) => setFieldInput(e.target.value as NormalizationField)}
                className="w-full bg-[#181C26] border border-white/[0.1] rounded-xl px-2.5 py-2 text-xs font-mono text-[#CBD5E1] focus:outline-none focus:border-[#ADFF2F]"
              >
                <option value="artist">Artist</option>
                <option value="composer">Composer</option>
                <option value="genre">Genre</option>
                <option value="all">All Fields</option>
              </select>
            </div>

            <div className="sm:col-span-1">
              <button
                type="submit"
                className="w-full py-2 bg-[#ADFF2F] text-black font-mono font-bold text-xs rounded-xl hover:bg-[#ADFF2F]/90 transition-all flex items-center justify-center cursor-pointer shadow-md"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>
        </form>

        {/* Rules Table / List */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-2">
          {rules.length === 0 ? (
            <div className="p-8 text-center flex flex-col items-center justify-center gap-3 text-[#64748B]">
              <Sparkles className="w-8 h-8 text-[#64748B]/40" />
              <div className="text-sm font-semibold text-[#94A3B8]">No Normalization Rules Recorded Yet</div>
              <p className="text-xs max-w-md">
                When you click "Normalize" in the Health & Triage panel (e.g. normalizing variants of A. R. Rahman), rules are automatically remembered here. You can also add manual rules using the form above.
              </p>
            </div>
          ) : (
            rules.map((rule) => {
              const fieldBadgeColor =
                rule.field === 'artist'
                  ? 'bg-[#00F5FF]/15 text-[#00F5FF] border-[#00F5FF]/30'
                  : rule.field === 'composer'
                  ? 'bg-[#8B5CF6]/15 text-[#C084FC] border-[#8B5CF6]/30'
                  : rule.field === 'genre'
                  ? 'bg-[#EC4899]/15 text-[#F472B6] border-[#EC4899]/30'
                  : 'bg-[#F59E0B]/15 text-[#FBBF24] border-[#F59E0B]/30'

              return (
                <div
                  key={rule.id}
                  className={`p-3 rounded-xl border transition-all flex items-center justify-between gap-4 ${
                    rule.isEnabled
                      ? 'bg-white/[0.02] border-white/[0.08] hover:border-white/[0.15]'
                      : 'bg-white/[0.01] border-white/[0.04] opacity-50'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`text-[10px] font-mono uppercase font-bold px-2 py-0.5 rounded border shrink-0 ${fieldBadgeColor}`}
                    >
                      {rule.field}
                    </span>

                    <div className="flex items-center gap-2 font-mono text-xs truncate">
                      <span className="text-[#94A3B8] truncate line-through-if-disabled">
                        "{rule.sourcePattern}"
                      </span>
                      <ArrowRight className="w-3.5 h-3.5 text-[#64748B] shrink-0" />
                      <span className="text-[#ADFF2F] font-bold truncate">
                        "{rule.targetValue}"
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-[10px] font-mono text-[#64748B] bg-white/[0.03] px-2 py-0.5 rounded border border-white/[0.05]">
                      {rule.matchCount || 0} match{rule.matchCount === 1 ? '' : 'es'}
                    </span>

                    <button
                      type="button"
                      onClick={() => handleToggleRule(rule.id, rule.isEnabled)}
                      className={`text-xs font-mono px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
                        rule.isEnabled
                          ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30 hover:bg-[#10B981]/25'
                          : 'bg-white/[0.05] text-[#94A3B8] border-white/[0.1] hover:text-white'
                      }`}
                    >
                      {rule.isEnabled ? 'Enabled' : 'Disabled'}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDeleteRule(rule.id)}
                      className="p-1 rounded-lg text-[#64748B] hover:text-[#F43F5E] hover:bg-[#F43F5E]/10 transition-colors cursor-pointer"
                      title="Delete Rule"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="p-4 px-6 border-t border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <span className="text-[11px] font-mono text-[#64748B]">
            Rules persist in local database and IndexedDB.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-mono bg-white/[0.06] hover:bg-white/[0.1] text-white transition-all cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
