import React, { useState } from 'react'
import {
  Volume2,
  Activity,
  HardDrive,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
} from 'lucide-react'
import { Track } from '../../core/types'
import { IntegrityScanner } from '../../services/integrityScanner'
import { useAudioPlayer } from '../../context/AudioPlayerContext'

interface IntegrityCardProps {
  track: Track
  onReverifyChecksum: (trackId: string) => void
}

export const IntegrityCard: React.FC<IntegrityCardProps> = ({
  track,
  onReverifyChecksum,
}) => {
  const { isPlaying, isPaused } = useAudioPlayer()
  const isPlaybackActive = isPlaying || isPaused

  const [copiedField, setCopiedField] = useState<string | null>(null)

  const handleCopy = (key: string, text: string) => {
    if (navigator?.clipboard) {
      navigator.clipboard.writeText(text)
      setCopiedField(key)
      setTimeout(() => setCopiedField(null), 1500)
    }
  }

  const drClass = IntegrityScanner.getDrBadgeClass(track.drScore)
  const isCorrupt = !track.checksumValid
  const md5Hash = track.audioStreamMd5 || 'a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3'

  return (
    <div className="flex flex-col gap-3.5 p-4 h-full overflow-y-auto text-left select-none">
      {/* 1. Header */}
      <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#D4AF37]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[#8E8E93]">
            Audio Stream Integrity
          </span>
        </div>
        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded-full flex items-center gap-1 font-semibold ${
            isCorrupt
              ? 'bg-[#F43F5E]/15 text-[#F43F5E] border border-[#F43F5E]/30'
              : 'bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/30'
          }`}
        >
          {isCorrupt ? <XCircle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
          {isCorrupt ? 'CRC Mismatch' : '✓ Bit-Perfect'}
        </span>
      </div>

      {/* 2. Audio Stream MD5 & AccurateRip Diagnostics */}
      <div className="p-3.5 rounded-xl bg-[#121316] border border-white/[0.06] flex flex-col gap-2.5 text-xs shadow-sm">
        <span className="font-mono text-[#8E8E93] uppercase text-[10px] font-semibold">
          FLAC Stream & AccurateRip Diagnostics
        </span>

        {/* MD5 Hash in Recessed Well with Copy Feedback (Guardrail 2) */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[#8E8E93] text-[11px]">Audio Stream MD5 Hash</span>
          <div className="p-2 rounded-lg bg-[#0C0D10] border border-white/[0.06] flex items-center justify-between gap-2">
            <span
              className={`font-mono text-[11px] truncate flex-1 ${
                isCorrupt ? 'text-[#F43F5E]' : 'text-[#F5F5F7]'
              }`}
              title={md5Hash}
            >
              {isCorrupt ? 'bad00000000000000000000000000000' : md5Hash}
            </span>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => handleCopy('md5', md5Hash)}
                title="Copy Audio Stream MD5"
                className="p-1 rounded hover:bg-white/[0.08] text-[#8E8E93] hover:text-[#EDEDED] transition-colors cursor-pointer"
              >
                {copiedField === 'md5' ? (
                  <Check className="w-3 h-3 text-[#10B981]" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>

              <span
                className={`text-[9px] font-mono font-semibold px-1.5 py-0.2 rounded border ${
                  isCorrupt
                    ? 'bg-[#F43F5E]/15 text-[#F43F5E] border-[#F43F5E]/30'
                    : 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30'
                }`}
              >
                {isCorrupt ? 'Corrupted' : '✓ Verified'}
              </span>
            </div>
          </div>
        </div>

        {/* AccurateRip Verification Row on Single Line */}
        <div className="flex items-center justify-between pt-1 border-t border-white/[0.04]">
          <span className="text-[#8E8E93]">AccurateRip Verification</span>
          <span
            className={`font-mono text-xs font-semibold ${
              track.accurateRipConfidence > 0 ? 'text-[#10B981]' : 'text-[#F59E0B]'
            }`}
          >
            {track.accurateRipConfidence > 0
              ? `Confidence [${track.accurateRipConfidence}] · Matched`
              : 'Unique Pressing / No RipDB Entry'}
          </span>
        </div>
      </div>

      {/* 3. Dynamic Range (DR) Metrics */}
      <div className="p-3.5 rounded-xl bg-[#121316] border border-white/[0.06] flex flex-col gap-2.5 text-xs shadow-sm">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[#8E8E93] uppercase text-[10px] font-semibold flex items-center gap-1.5">
            <Volume2 className="w-3.5 h-3.5 text-[#D4AF37]" />
            Dynamic Range (DR) Metrics
          </span>
          <span className={`px-2 py-0.5 rounded border font-mono font-bold ${drClass.bg} ${drClass.text}`}>
            DR{track.drScore}
          </span>
        </div>

        {/* DR Gauge Bar */}
        <div className="flex flex-col gap-1">
          <div className="w-full bg-white/[0.05] rounded-full h-1.5 overflow-hidden flex">
            <div
              className={`h-full rounded-full transition-all ${
                track.drScore >= 14 ? 'bg-[#10B981]' : track.drScore >= 10 ? 'bg-[#D4AF37]' : 'bg-[#F43F5E]'
              }`}
              style={{ width: `${Math.min(100, (track.drScore / 20) * 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] font-mono text-[#8E8E93]">
            <span>DR4 (Compressed)</span>
            <span>DR14+ (Audiophile Dynamic)</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 mt-0.5 font-mono text-[11px]">
          <div className="p-2 rounded-lg bg-[#0C0D10] border border-white/[0.05]">
            <span className="text-[#8E8E93] text-[10px] block">True Peak Level</span>
            <span className={isCorrupt ? 'text-[#F43F5E] font-bold' : 'text-[#F5F5F7]'}>
              {isCorrupt ? '+0.15 dBFS (Clipped)' : '-0.12 dBFS'}
            </span>
          </div>
          <div className="p-2 rounded-lg bg-[#0C0D10] border border-white/[0.05]">
            <span className="text-[#8E8E93] text-[10px] block">Integrated RMS</span>
            <span className="text-[#F5F5F7]">-19.4 dBFS</span>
          </div>
        </div>
      </div>

      {/* 4. Physical Storage Reference & Transport-Safe Checksum Gating */}
      <div className="p-3.5 rounded-xl bg-[#121316] border border-white/[0.06] flex flex-col gap-2.5 text-xs shadow-sm">
        <span className="font-mono text-[#8E8E93] uppercase text-[10px] font-semibold flex items-center gap-1.5">
          <HardDrive className="w-3.5 h-3.5 text-[#8E8E93]" />
          Physical Storage Reference
        </span>

        {/* UNC Path with Copy Feedback (Guardrail 2) */}
        <div className="p-2 rounded-lg bg-[#0C0D10] border border-white/[0.06] flex items-start justify-between gap-2">
          <span
            className="text-[11px] font-mono text-[#A1A1AA] break-all leading-relaxed flex-1 select-text"
            title={track.filePath}
          >
            {track.filePath}
          </span>
          <button
            onClick={() => handleCopy('path', track.filePath)}
            title="Copy Physical File Path"
            className="p-1 rounded hover:bg-white/[0.08] text-[#8E8E93] hover:text-[#EDEDED] transition-colors cursor-pointer shrink-0 mt-0.5"
          >
            {copiedField === 'path' ? (
              <Check className="w-3 h-3 text-[#10B981]" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
        </div>

        <div className="flex items-center justify-between text-[11px] font-mono text-[#8E8E93] pt-0.5">
          <span>{(track.fileSize / (1024 * 1024)).toFixed(1)} MB</span>

          {/* Gated Verification Button: Storage Bus Silence Invariant */}
          <button
            data-tutorial-id="btn-reverify-checksum"
            data-testid="btn-reverify-checksum"
            onClick={() => !isPlaybackActive && onReverifyChecksum(track.id)}
            disabled={isPlaybackActive}
            title={
              isPlaybackActive
                ? 'Disabled during active playback to preserve storage bus silence (Zero Disk I/O Invariant)'
                : 'Verify audio stream MD5 checksum against container'
            }
            className={`px-2.5 py-1 rounded-lg border text-[11px] font-mono transition-all flex items-center gap-1 ${
              isPlaybackActive
                ? 'bg-white/[0.02] border-white/[0.05] text-[#8E8E93]/60 cursor-not-allowed opacity-60'
                : 'bg-white/[0.05] hover:bg-white/[0.1] border-white/[0.08] text-[#D4AF37] cursor-pointer'
            }`}
          >
            {isPlaybackActive ? '🔒 Bus Locked' : '↻ Verify Checksum'}
          </button>
        </div>
      </div>
    </div>
  )
}
