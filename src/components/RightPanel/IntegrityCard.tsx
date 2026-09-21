import React from 'react'
import {
  ShieldCheck,
  AlertTriangle,
  FileCheck,
  Volume2,
  Activity,
  HardDrive,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { Track } from '../../core/types'
import { IntegrityScanner } from '../../services/integrityScanner'

interface IntegrityCardProps {
  track: Track
  onReverifyChecksum: (trackId: string) => void
}

export const IntegrityCard: React.FC<IntegrityCardProps> = ({
  track,
  onReverifyChecksum,
}) => {
  const drClass = IntegrityScanner.getDrBadgeClass(track.drScore)
  const isCorrupt = !track.checksumValid

  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-y-auto text-left">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#10B981]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
            Audio Stream Integrity
          </span>
        </div>
        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded-full flex items-center gap-1 ${
            isCorrupt
              ? 'bg-[#F43F5E]/20 text-[#F43F5E] border border-[#F43F5E]/30'
              : 'bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/30'
          }`}
        >
          {isCorrupt ? <XCircle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
          {isCorrupt ? 'CRC Mismatch' : 'Bit-Perfect'}
        </span>
      </div>

      {/* Checksum & AccurateRip Box */}
      <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] flex flex-col gap-2.5 text-xs">
        <span className="font-mono text-[#94A3B8] uppercase text-[10px] font-semibold">
          FLAC Stream & AccurateRip Diagnostics
        </span>

        <div className="flex flex-col gap-1">
          <span className="text-[#64748B] text-[11px]">Audio Stream MD5 Hash:</span>
          <span
            className={`font-mono text-[10px] p-1.5 rounded border break-all ${
              isCorrupt
                ? 'bg-[#F43F5E]/10 border-[#F43F5E]/30 text-[#F43F5E]'
                : 'bg-black/50 border-white/[0.08] text-[#00F5FF]'
            }`}
          >
            {isCorrupt
              ? 'bad00000000000000000000000000000 (Stream Corrupted)'
              : 'a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3 (Verified Match)'}
          </span>
        </div>

        <div className="flex items-center justify-between mt-1">
          <span className="text-[#64748B]">AccurateRip Verification:</span>
          <span
            className={`font-mono font-semibold ${
              track.accurateRipConfidence > 0 ? 'text-[#10B981]' : 'text-[#F59E0B]'
            }`}
          >
            {track.accurateRipConfidence > 0
              ? `Confidence [${track.accurateRipConfidence}] Rips Match`
              : 'No Database Entry / Unique Pressing'}
          </span>
        </div>
      </div>

      {/* Dynamic Range (DR) Deep Meter */}
      <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] flex flex-col gap-2.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[#94A3B8] uppercase text-[10px] font-semibold flex items-center gap-1.5">
            <Volume2 className="w-3.5 h-3.5 text-[#00F5FF]" />
            Dynamic Range (DR) Metrics
          </span>
          <span className={`px-2 py-0.5 rounded border font-mono font-bold ${drClass.bg} ${drClass.text}`}>
            DR{track.drScore}
          </span>
        </div>

        {/* DR Gauge Bar */}
        <div className="flex flex-col gap-1">
          <div className="w-full bg-white/[0.05] rounded-full h-2 overflow-hidden flex">
            <div
              className={`h-full rounded-full transition-all ${
                track.drScore >= 14 ? 'bg-[#10B981]' : track.drScore >= 10 ? 'bg-[#00F5FF]' : 'bg-[#F43F5E]'
              }`}
              style={{ width: `${Math.min(100, (track.drScore / 20) * 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] font-mono text-[#64748B]">
            <span>DR4 (Compressed)</span>
            <span>DR14+ (Audiophile Dynamic)</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 mt-1 font-mono text-[11px]">
          <div className="p-2 rounded bg-black/40 border border-white/[0.05]">
            <span className="text-[#64748B] text-[10px] block">True Peak Level</span>
            <span className={isCorrupt ? 'text-[#F43F5E]' : 'text-white'}>
              {isCorrupt ? '+0.15 dBFS (Clipped)' : '-0.12 dBFS'}
            </span>
          </div>
          <div className="p-2 rounded bg-black/40 border border-white/[0.05]">
            <span className="text-[#64748B] text-[10px] block">Integrated RMS</span>
            <span className="text-white">-19.4 dBFS</span>
          </div>
        </div>
      </div>

      {/* Storage Mount & File Specs */}
      <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] flex flex-col gap-2 text-xs">
        <span className="font-mono text-[#94A3B8] uppercase text-[10px] font-semibold flex items-center gap-1.5">
          <HardDrive className="w-3.5 h-3.5 text-[#ADFF2F]" />
          Physical Storage Reference
        </span>
        <span className="text-[#64748B] text-[10px] font-mono break-all">{track.filePath}</span>
        <div className="flex items-center justify-between text-[11px] font-mono text-[#94A3B8] mt-1">
          <span>{(track.fileSize / (1024 * 1024)).toFixed(1)} MB</span>
          <button
            data-tutorial-id="btn-reverify-checksum"
            data-testid="btn-reverify-checksum"
            onClick={() => onReverifyChecksum(track.id)}
            className="text-[11px] text-[#00F5FF] hover:underline cursor-pointer"
          >
            Re-scan Checksum
          </button>
        </div>
      </div>
    </div>
  )
}
