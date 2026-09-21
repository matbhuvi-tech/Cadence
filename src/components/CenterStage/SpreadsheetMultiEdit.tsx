import React, { useState } from 'react'
import { X, Sparkles, Wand2, Check, ArrowRight, RefreshCw, AlertCircle } from 'lucide-react'
import { Track } from '../../core/types'

interface SpreadsheetMultiEditProps {
  selectedTracks: Track[]
  onClose: () => void
  onApplyEdits: (editsMap: Record<string, Partial<Track>>) => void
}

type TransformType = 'REGEX_REPLACE' | 'TITLE_CASE' | 'SET_COMPOSER' | 'PREFIX_MOVEMENT'

export const SpreadsheetMultiEdit: React.FC<SpreadsheetMultiEditProps> = ({
  selectedTracks,
  onClose,
  onApplyEdits,
}) => {
  const [transformType, setTransformType] = useState<TransformType>('REGEX_REPLACE')
  const [targetField, setTargetField] = useState<'title' | 'composerName' | 'artistCredit'>('title')
  const [regexPattern, setRegexPattern] = useState<string>('(\\d+)\\.\\s*')
  const [regexReplacement, setRegexReplacement] = useState<string>('Mov $1: ')
  const [constantValue, setConstantValue] = useState<string>('A. R. Rahman')

  // Live preview generator
  const previews = selectedTracks.map((track) => {
    const original = (track[targetField] as string) || ''
    let transformed = original

    try {
      if (transformType === 'REGEX_REPLACE' && regexPattern) {
        const re = new RegExp(regexPattern, 'g')
        transformed = original.replace(re, regexReplacement)
      } else if (transformType === 'TITLE_CASE') {
        transformed = original.replace(
          /\w\S*/g,
          (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase()
        )
      } else if (transformType === 'SET_COMPOSER') {
        transformed = constantValue
      } else if (transformType === 'PREFIX_MOVEMENT') {
        transformed = `${track.movementNumber ? track.movementNumber + '. ' : ''}${original}`
      }
    } catch (e) {
      transformed = original
    }

    return {
      trackId: track.id,
      trackNum: track.trackNumber,
      original,
      transformed,
      isChanged: original !== transformed,
    }
  })

  const changedCount = previews.filter((p) => p.isChanged).length

  const handleApply = () => {
    const editsMap: Record<string, Partial<Track>> = {}
    previews.forEach((p) => {
      if (p.isChanged) {
        editsMap[p.trackId] = {
          [targetField]: p.transformed,
        }
      }
    })
    onApplyEdits(editsMap)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#12151D] border border-white/[0.12] rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="p-4 px-6 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-[#00F5FF]" />
            <h2 className="text-base font-bold text-[#F1F5F9]">
              Spreadsheet-Grade Multi-Edit
            </h2>
            <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-[#00F5FF]/15 text-[#00F5FF] font-semibold">
              {selectedTracks.length} Tracks Selected
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Configuration Controls */}
        <div className="p-5 border-b border-white/[0.06] flex flex-col gap-4 bg-[#0D0E12]/50">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Target Field */}
            <div className="flex flex-col gap-1.5 text-left">
              <label className="text-xs font-mono text-[#94A3B8]">Target Metadata Field</label>
              <select
                value={targetField}
                onChange={(e) => setTargetField(e.target.value as any)}
                className="bg-[#181C26] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-[#F1F5F9] font-mono focus:outline-none focus:border-[#00F5FF]"
              >
                <option value="title">Track Title</option>
                <option value="composerName">Composer Name</option>
                <option value="artistCredit">Artist Credit</option>
              </select>
            </div>

            {/* Transform Rule Type */}
            <div className="flex flex-col gap-1.5 text-left md:col-span-2">
              <label className="text-xs font-mono text-[#94A3B8]">Batch Transform Rule</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'REGEX_REPLACE', label: 'Regex Search & Replace' },
                  { id: 'TITLE_CASE', label: 'Capitalize / Title Case' },
                  { id: 'SET_COMPOSER', label: 'Canonical Set Value' },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTransformType(t.id as any)}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border transition-all text-center ${
                      transformType === t.id
                        ? 'bg-[#00F5FF]/15 border-[#00F5FF] text-[#00F5FF]'
                        : 'bg-white/[0.02] border-white/[0.06] text-[#94A3B8] hover:bg-white/[0.04]'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Dynamic Inputs for Rule */}
          {transformType === 'REGEX_REPLACE' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5 text-left">
                <label className="text-xs font-mono text-[#94A3B8]">Pattern (Regex)</label>
                <input
                  type="text"
                  value={regexPattern}
                  onChange={(e) => setRegexPattern(e.target.value)}
                  placeholder="e.g. (\d+)\.\s*"
                  className="bg-[#181C26] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-[#F1F5F9] font-mono focus:outline-none focus:border-[#00F5FF]"
                />
              </div>
              <div className="flex flex-col gap-1.5 text-left">
                <label className="text-xs font-mono text-[#94A3B8]">Replacement Pattern</label>
                <input
                  type="text"
                  value={regexReplacement}
                  onChange={(e) => setRegexReplacement(e.target.value)}
                  placeholder="e.g. Mov $1: "
                  className="bg-[#181C26] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-[#F1F5F9] font-mono focus:outline-none focus:border-[#00F5FF]"
                />
              </div>
            </div>
          )}

          {transformType === 'SET_COMPOSER' && (
            <div className="flex flex-col gap-1.5 text-left">
              <label className="text-xs font-mono text-[#94A3B8]">New Value</label>
              <input
                type="text"
                value={constantValue}
                onChange={(e) => setConstantValue(e.target.value)}
                className="bg-[#181C26] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-[#F1F5F9] font-mono focus:outline-none focus:border-[#00F5FF]"
              />
            </div>
          )}
        </div>

        {/* Live Transformation Preview Grid */}
        <div className="flex-1 overflow-y-auto p-4 max-h-[350px]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono font-semibold text-[#94A3B8]">
              Live Transformation Diff Preview ({changedCount} modifications)
            </span>
            <span className="text-[11px] text-[#64748B] font-mono">
              Green = Modified Staging Value
            </span>
          </div>

          <div className="flex flex-col divide-y divide-white/[0.04] border border-white/[0.06] rounded-xl overflow-hidden bg-[#0D0E12]">
            {previews.map((p) => (
              <div
                key={p.trackId}
                className="grid grid-cols-12 gap-2 p-2.5 text-xs font-mono items-center hover:bg-white/[0.02]"
              >
                <span className="col-span-1 text-[#64748B] text-center">#{p.trackNum}</span>
                <span className="col-span-5 text-[#94A3B8] truncate">{p.original}</span>
                <div className="col-span-1 flex justify-center text-[#64748B]">
                  <ArrowRight className="w-3.5 h-3.5" />
                </div>
                <span
                  className={`col-span-5 truncate font-semibold ${
                    p.isChanged ? 'text-[#10B981]' : 'text-[#64748B]'
                  }`}
                >
                  {p.transformed}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 px-6 border-t border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <span className="text-xs text-[#64748B] flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-[#F59E0B]" />
            Edits will be stored non-destructively in Sidecars until committed.
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium text-[#94A3B8] hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={changedCount === 0}
              className="px-5 py-2 rounded-lg bg-[#00F5FF] text-black font-semibold text-xs hover:bg-[#00F5FF]/90 transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check className="w-3.5 h-3.5 stroke-[3]" />
              Apply {changedCount} Sidecar Edits
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
