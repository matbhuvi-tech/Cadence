import React from 'react'
import { Speaker, X, Check, RefreshCw, Radio, HardDrive, ShieldCheck, Wifi, Sparkles } from 'lucide-react'
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
    isPurityMode,
    isBitPerfect,
    outputSampleRate,
    deviceType,
    togglePurityMode,
    discoverUpnpDevices,
    upnpDevices,
  } = useAudioPlayer()

  if (!isOpen) return null

  const isUpnpDevice = (device: string) => device.startsWith('[UPnP]') || device.startsWith('uuid:')

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="bg-[#10131C] border border-white/[0.12] rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col glow-cyan">
        {/* Modal Header */}
        <div className="p-4 px-6 border-b border-white/[0.08] flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-[#00F5FF]/30 via-[#8B5CF6]/30 to-[#ADFF2F]/20 border border-[#00F5FF]/40 text-[#00F5FF]">
              <Speaker className="w-5 h-5 text-[#00F5FF]" />
            </div>
            <div className="flex flex-col text-left">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                Audio Output & Bit-Perfect Engine
                <span className="text-[10px] font-mono font-normal px-2 py-0.5 rounded-full bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/30">
                  {isNativeTauri ? 'WASAPI / UPnP' : 'Web Audio'}
                </span>
              </h3>
              <span className="text-[11px] font-mono text-[#94A3B8]">
                Audiophile hardware endpoints & network streamer routing
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

        {/* Master Switch: Bit-Perfect Purity Mode */}
        <div className="p-4 px-6 bg-gradient-to-r from-[#141A28] to-[#121620] border-b border-white/[0.08] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-xl border transition-all ${
                isPurityMode
                  ? 'bg-[#EAB308]/20 border-[#EAB308]/50 text-[#EAB308]'
                  : 'bg-white/[0.04] border-white/[0.08] text-[#64748B]'
              }`}
            >
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div className="flex flex-col text-left">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white tracking-wide">
                  Bit-Perfect Purity Mode (Maestro Philosophy)
                </span>
                {isPurityMode && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-[#EAB308]/20 text-[#EAB308] border border-[#EAB308]/40 animate-pulse">
                    ACTIVE · 0dB UNITY
                  </span>
                )}
              </div>
              <span className="text-[10px] font-mono text-[#94A3B8] max-w-sm">
                Locks software volume to 100% (prevents bit depth loss) & forces DAC hardware clock to match native track rate.
              </span>
            </div>
          </div>

          <button
            onClick={() => togglePurityMode()}
            className={`px-3.5 py-1.5 rounded-xl font-mono text-xs font-bold transition-all cursor-pointer border ${
              isPurityMode
                ? 'bg-gradient-to-r from-[#EAB308] to-[#F59E0B] text-black border-transparent shadow-lg shadow-[#EAB308]/20'
                : 'bg-white/[0.06] hover:bg-white/[0.1] text-white border-white/[0.12]'
            }`}
          >
            {isPurityMode ? 'ON' : 'OFF'}
          </button>
        </div>

        {/* Active Stream & Clock Telemetry */}
        {streamTelemetry && (
          <div className="p-4 px-6 bg-[#0E111A] border-b border-white/[0.08] flex items-center justify-between text-xs font-mono">
            <div className="flex flex-col">
              <span className="text-[10px] text-[#64748B] uppercase">Source Stream & Output Clock</span>
              <div className="flex items-center gap-2 text-white font-bold mt-0.5">
                <span>{streamTelemetry.format}</span>
                <span className="text-[#64748B]">·</span>
                <span className="text-[#00F5FF]">
                  {streamTelemetry.sampleRate ? `${streamTelemetry.sampleRate / 1000} kHz` : '44.1 kHz'}
                </span>
                <span className="text-[#64748B]">/</span>
                <span className="text-[#ADFF2F]">{streamTelemetry.bitDepth || 16}-bit</span>
                {outputSampleRate && (
                  <span className="text-[10px] text-[#94A3B8] font-normal">
                    (DAC Clock: {outputSampleRate / 1000} kHz)
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isBitPerfect && (
                <span className="px-2 py-0.5 rounded bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40 text-[10px] font-bold flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />
                  Bit-Perfect Pass
                </span>
              )}
              {deviceType === 'upnp_streamer' && (
                <span className="px-2 py-0.5 rounded bg-[#8B5CF6]/20 text-[#A78BFA] border border-[#8B5CF6]/40 text-[10px] font-bold flex items-center gap-1" title="Dedicated OS Thread · MMCSS Pro Audio · RAM Page-Locked · Paced TCP Stream">
                  <Wifi className="w-3 h-3" />
                  Locked RAM (Paced UPnP)
                </span>
              )}
              {streamTelemetry.isHighRes && (
                <span className="px-2 py-0.5 rounded bg-[#00F5FF]/20 text-[#00F5FF] border border-[#00F5FF]/40 text-[10px] font-bold">
                  Hi-Res
                </span>
              )}
            </div>
          </div>
        )}

        {/* Device List */}
        <div className="p-6 flex flex-col gap-2 max-h-80 overflow-y-auto">
          <div className="flex items-center justify-between text-xs font-mono text-[#94A3B8] mb-1">
            <span>Available Audio Endpoints:</span>
            <div className="flex items-center gap-3">
              <button
                onClick={discoverUpnpDevices}
                className="text-[#A78BFA] hover:underline flex items-center gap-1 cursor-pointer"
                title="Search local Wi-Fi / Ethernet for UPnP/DLNA renderers"
              >
                <Wifi className="w-3 h-3" />
                <span>Find Network Streamers</span>
              </button>
              <button
                onClick={refreshDevices}
                className="text-[#00F5FF] hover:underline flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Rescan</span>
              </button>
            </div>
          </div>

          {availableDevices.length === 0 ? (
            <div className="p-4 rounded-xl border border-white/[0.08] bg-black/40 text-center text-xs font-mono text-[#64748B]">
              No audio hardware endpoints detected. Defaulting to system audio.
            </div>
          ) : (
            availableDevices.map((device, idx) => {
              const isSelected = activeDevice === device
              const isNetwork = isUpnpDevice(device)
              const cleanName = device.replace(/^\[UPnP\]\s*/, '')
              const upnpMeta = isNetwork
                ? upnpDevices.find(
                    (u: any) =>
                      u.friendlyName === cleanName ||
                      `[UPnP] ${u.friendlyName}` === device ||
                      cleanName.toLowerCase().includes(u.friendlyName.toLowerCase())
                  )
                : null
              const modelDesc = upnpMeta?.modelDescription || upnpMeta?.modelName

              return (
                <button
                  key={idx}
                  onClick={() => selectDevice(device)}
                  className={`p-3 rounded-xl border text-left flex items-center justify-between transition-all cursor-pointer ${
                    isSelected
                      ? isNetwork
                        ? 'bg-[#8B5CF6]/15 border-[#8B5CF6]/50 text-white shadow-md'
                        : 'bg-[#00F5FF]/15 border-[#00F5FF]/50 text-white shadow-md'
                      : 'bg-white/[0.02] hover:bg-white/[0.05] border-white/[0.06] text-[#CBD5E1]'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`p-2 rounded-lg ${
                        isSelected
                          ? isNetwork
                            ? 'bg-[#8B5CF6]/20 text-[#A78BFA]'
                            : 'bg-[#00F5FF]/20 text-[#00F5FF]'
                          : 'bg-white/[0.05] text-[#64748B]'
                      }`}
                    >
                      {isNetwork ? <Wifi className="w-4 h-4" /> : <Radio className="w-4 h-4" />}
                    </div>
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold">{cleanName}</span>
                        {modelDesc && (
                          <span className="text-[11px] font-medium text-[#A78BFA] opacity-90">
                            ({modelDesc})
                          </span>
                        )}
                        {isNetwork && (
                          <span className="px-1.5 py-0.2 rounded text-[9px] font-mono bg-[#8B5CF6]/20 text-[#A78BFA] border border-[#8B5CF6]/30">
                            NETWORK DLNA
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-mono text-[#94A3B8]">
                        {isNetwork
                          ? upnpMeta?.modelDescription
                            ? `${upnpMeta.modelDescription} ${upnpMeta.modelName || ''} · Pure Untouched Stream Direct Delivery`
                            : /odyssey|oled|tv|monitor|screen|display/i.test(cleanName)
                            ? 'Smart Display / Monitor DLNA Endpoint'
                            : 'UPnP / DLNA Endpoint · Pure Untouched Stream Direct Delivery'
                          : device.toLowerCase().includes('dac') || device.toLowerCase().includes('maxwell') || device.toLowerCase().includes('usb')
                          ? 'Hardware DAC · WASAPI Exclusive Native Clock Capable'
                          : 'Direct Hardware Audio Output'}
                      </span>
                    </div>
                  </div>

                  {isSelected && (
                    <div
                      className={`w-6 h-6 rounded-full flex items-center justify-center shadow-sm text-black ${
                        isNetwork ? 'bg-[#A78BFA]' : 'bg-[#00F5FF]'
                      }`}
                    >
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
            <span>
              {isPurityMode
                ? 'Purity Mode: Unity Gain & Dynamic Clock Match Locked'
                : 'WASAPI Auto-Clock Active'}
            </span>
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
