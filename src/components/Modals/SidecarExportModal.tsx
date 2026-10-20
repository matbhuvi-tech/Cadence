import React, { useState } from 'react'
import {
  FileCode,
  X,
  Copy,
  Check,
  Download,
  ShieldCheck,
} from 'lucide-react'
import { Track, Release, Work } from '../../core/types'
import { sidecarManager } from '../../core/sidecarManager'

interface SidecarExportModalProps {
  track: Track
  release?: Release
  work?: Work
  onClose: () => void
}

export const SidecarExportModal: React.FC<SidecarExportModalProps> = ({
  track,
  release,
  work,
  onClose,
}) => {
  const [format, setFormat] = useState<'json' | 'yaml' | 'xmp'>('json')
  const [copied, setCopied] = useState(false)

  const sidecarContent =
    format === 'json'
      ? sidecarManager.createJsonSidecar(track, release, work)
      : format === 'yaml'
      ? sidecarManager.createYamlSidecar(track)
      : sidecarManager.createXmpSidecar(track)

  const sidecarPath = sidecarManager.getSidecarPath(track.filePath, format)

  const handleCopy = () => {
    navigator.clipboard.writeText(sidecarContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#12151D] border border-white/[0.12] rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 px-6 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-2">
            <FileCode className="w-5 h-5 text-[#F59E0B]" />
            <h2 className="text-base font-bold text-[#F1F5F9]">
              Non-Destructive Sidecar Vault
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Format Selector & Path */}
        <div className="p-4 px-6 border-b border-white/[0.06] flex items-center justify-between bg-[#0D0E12]/60 text-left">
          <div className="flex flex-col">
            <span className="text-xs font-mono text-[#94A3B8]">Target Sidecar File Path:</span>
            <span className="text-[11px] font-mono text-[#00F5FF] truncate max-w-md mt-0.5">
              {sidecarPath}
            </span>
          </div>

          <div className="flex items-center gap-1 p-1 rounded-lg bg-white/[0.05] border border-white/[0.08] text-xs font-mono">
            <button
              onClick={() => setFormat('json')}
              className={`px-2.5 py-1 rounded-md transition-all ${
                format === 'json' ? 'bg-[#00F5FF] text-black font-bold' : 'text-[#94A3B8] hover:text-white'
              }`}
            >
              JSON
            </button>
            <button
              onClick={() => setFormat('yaml')}
              className={`px-2.5 py-1 rounded-md transition-all ${
                format === 'yaml' ? 'bg-[#00F5FF] text-black font-bold' : 'text-[#94A3B8] hover:text-white'
              }`}
            >
              YAML
            </button>
            <button
              onClick={() => setFormat('xmp')}
              className={`px-2.5 py-1 rounded-md transition-all ${
                format === 'xmp' ? 'bg-[#00F5FF] text-black font-bold' : 'text-[#94A3B8] hover:text-white'
              }`}
            >
              XMP
            </button>
          </div>
        </div>

        {/* Code Content Box */}
        <div className="p-4 max-h-[380px] overflow-y-auto bg-[#0A0C0F] text-left">
          <pre className="text-xs font-mono text-[#CBD5E1] whitespace-pre-wrap leading-relaxed">
            {sidecarContent}
          </pre>
        </div>

        {/* Footer */}
        <div className="p-4 px-6 border-t border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <span className="text-xs text-[#64748B] flex items-center gap-1.5 font-mono">
            <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
            Pure Sidecar Persistence: Audio stream bit-depth & CRC unchanged.
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="px-4 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-xs font-mono text-white flex items-center gap-1.5 transition-all"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-[#10B981]" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy Sidecar'}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-[#00F5FF] text-black font-bold text-xs hover:bg-[#00F5FF]/90 transition-all"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
