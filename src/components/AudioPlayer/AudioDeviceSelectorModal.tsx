import React from 'react'
import { Speaker, X, Check, RefreshCw, Radio, HardDrive } from 'lucide-react'
import { useAudioPlayer } from '../../context/AudioPlayerContext'

interface AudioDeviceSelectorModalProps {
  isOpen: boolean
  onClose: () => void
}

export const AudioDeviceSelectorModal: React.FC<AudioDeviceSelectorModalProps> = ({
  isOpen,
  onClose,
}) => {
  const {
    activeDevice,
    availableDevices,
    selectDevice,
    refreshDevices,
    streamTelemetry,
    isNativeTauri,
  } = useAudioPlayer()

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="bg-[#12151E] border border-white/[0.12] rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col glow-cyan">
        {/* Modal Header */}
        <div className="p-4 px-6 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-[#00F5FF]/30 to-[#8B5CF6]/30 border border-[#00F5FF]/40 text-[#00F5FF]">
              <Speaker className="w-5 h-5 text-[#ADFF2F]" />
            </div>
            <div className="flex flex-col text-left">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                Audio Output & Hardware DAC
                <span className="text-[10px] font-mono font-normal px-2 py-0.5 rounded-full bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/30">
                  {isNativeTauri ? 'WASAPI Direct' : 'Web Audio'}
                </span>
              </h3>
              <span className="text-[11px] font-mono text-[#94A3B8]">
                Select playback endpoint for bit-perfect stream pass-through
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.05] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Stream Telemetry Card */}
        {streamTelemetry && (
          <div className="p-4 px-6 bg-[#161A26] border-b border-white/[0.08] flex items-center justify-between text-xs font-mono">
            <div className="flex flex-col">
              <span className="text-[10px] text-[#64748B] uppercase">Active Stream Telemetry</span>
              <span className="text-white font-bold">
                {streamTelemetry.format} · {streamTelemetry.sampleRate ? `${streamTelemetry.sampleRate / 1000} kHz` : '44.1 kHz'} / {streamTelemetry.bitDepth || 16}-bit
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40 text-[10px] font-bold">
                Bit-Perfect Mode
              </span>
              {streamTelemetry.isHighRes && (
                <span className="px-2 py-0.5 rounded bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/40 text-[10px] font-bold">
                  High-Res Lossless
                </span>
              )}
            </div>
          </div>
        )}

        {/* Device List */}
        <div className="p-6 flex flex-col gap-2 max-h-80 overflow-y-auto">
          <div className="flex items-center justify-between text-xs font-mono text-[#94A3B8] mb-1">
            <span>Available Audio Endpoints:</span>
            <button
              onClick={refreshDevices}
              className="text-[#00F5FF] hover:underline flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Rescan Devices</span>
            </button>
          </div>

          {availableDevices.length === 0 ? (
            <div className="p-4 rounded-xl border border-white/[0.08] bg-black/40 text-center text-xs font-mono text-[#64748B]">
              No audio hardware endpoints detected. Defaulting to system audio.
            </div>
          ) : (
            availableDevices.map((device, idx) => {
              const isSelected = activeDevice === device
              return (
                <button
                  key={idx}
                  onClick={() => selectDevice(device)}
                  className={`p-3 rounded-xl border text-left flex items-center justify-between transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-[#00F5FF]/15 border-[#00F5FF]/50 text-white shadow-md'
                      : 'bg-white/[0.02] hover:bg-white/[0.05] border-white/[0.06] text-[#CBD5E1]'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`p-2 rounded-lg ${
                        isSelected
                          ? 'bg-[#00F5FF]/20 text-[#00F5FF]'
                          : 'bg-white/[0.05] text-[#64748B]'
                      }`}
                    >
                      <Radio className="w-4 h-4" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-semibold">{device}</span>
                      <span className="text-[10px] font-mono text-[#94A3B8]">
                        {device.toLowerCase().includes('dac') || device.toLowerCase().includes('usb')
                          ? 'Hardware DAC · Exclusive Mode Capable'
                          : 'Default Audio Endpoint'}
                      </span>
                    </div>
                  </div>

                  {isSelected && (
                    <div className="w-6 h-6 rounded-full bg-[#00F5FF] text-black flex items-center justify-center shadow-sm">
                      <Check className="w-3.5 h-3.5 stroke-[3]" />
                    </div>
                  )}
                </button>
              )
            })
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 px-6 border-t border-white/[0.08] flex items-center justify-between bg-white/[0.02] text-xs font-mono text-[#64748B]">
          <div className="flex items-center gap-1.5">
            <HardDrive className="w-3.5 h-3.5 text-[#10B981]" />
            <span>WASAPI Exclusive Auto-Lock Enabled</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.12] text-white font-mono text-xs cursor-pointer transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
