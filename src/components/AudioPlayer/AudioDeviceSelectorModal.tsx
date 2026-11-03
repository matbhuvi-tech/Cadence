import React, { useMemo, useState } from 'react'
import { Speaker, X, Check, RefreshCw, Radio, ShieldCheck, Wifi, Loader2 } from 'lucide-react'
import { useAudioPlayer } from '../../context/AudioPlayerContext'

interface AudioDeviceSelectorModalProps {
  isOpen: boolean
  onClose: () => void
}

function decodeDeviceName(raw: string): string {
  return raw
    .replace(/^\[UPnP\]\s*/, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
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
    isPurityMode,
    isBitPerfect,
    outputSampleRate,
    togglePurityMode,
    discoverUpnpDevices,
    upnpDevices,
  } = useAudioPlayer()

  const [isRefreshing, setIsRefreshing] = useState(false)

  const isUpnpDevice = (device: string) => device.startsWith('[UPnP]') || device.startsWith('uuid:')

  // Segregate devices into Direct Audio and Network Streamers
  const { hardwareDevices, networkDevices } = useMemo(() => {
    const hw: string[] = []
    const net: string[] = []
    for (const d of availableDevices) {
      if (isUpnpDevice(d)) {
        net.push(d)
      } else {
        hw.push(d)
      }
    }
    return { hardwareDevices: hw, networkDevices: net }
  }, [availableDevices])

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      await Promise.all([refreshDevices(), discoverUpnpDevices()])
    } finally {
      setIsRefreshing(false)
    }
  }

  if (!isOpen) return null

  const getDeviceSubtitle = (device: string, isNetwork: boolean, cleanName: string, upnpMeta: any) => {
    if (isNetwork) {
      if (/rose/i.test(cleanName) || /rose/i.test(upnpMeta?.modelName || '')) {
        return 'HiFi ROSE RS130 · UPnP'
      }
      if (/avm\s*70|anthem/i.test(cleanName) || /avm\s*70|anthem/i.test(upnpMeta?.modelName || '')) {
        return 'Anthem AVM 70 · UPnP'
      }
      if (upnpMeta?.modelDescription || upnpMeta?.modelName) {
        return `${upnpMeta.modelDescription || upnpMeta.modelName} · UPnP`
      }
      if (/odyssey|oled|tv|monitor|screen|display/i.test(cleanName)) {
        return 'Smart Display · UPnP / DLNA'
      }
      return 'Network Streamer · UPnP'
    }

    if (device.toLowerCase().includes('dac') || device.toLowerCase().includes('maxwell') || device.toLowerCase().includes('usb')) {
      return 'Hardware DAC · WASAPI Exclusive'
    }
    return 'WASAPI · Local Audio'
  }

  const renderDeviceCard = (device: string) => {
    const isSelected = activeDevice === device
    const isNetwork = isUpnpDevice(device)
    const cleanName = decodeDeviceName(device)
    const upnpMeta = isNetwork
      ? upnpDevices.find(
          (u: any) =>
            u.friendlyName === cleanName ||
            `[UPnP] ${u.friendlyName}` === device ||
            cleanName.toLowerCase().includes((u.friendlyName || '').toLowerCase())
        )
      : null
    const modelDesc = upnpMeta?.modelDescription || upnpMeta?.modelName
    const subtitle = getDeviceSubtitle(device, isNetwork, cleanName, upnpMeta)

    return (
      <button
        key={device}
        onClick={() => selectDevice(device)}
        className={`w-full p-3 rounded-xl border text-left flex items-center justify-between transition-all cursor-pointer ${
          isSelected
            ? 'bg-white/[0.08] border-[#D4AF37]/50 text-white shadow-sm'
            : 'bg-white/[0.02] hover:bg-white/[0.05] border-white/[0.06] text-[#A1A1AA]'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0 pr-3">
          <div
            className={`p-2 rounded-lg shrink-0 ${
              isSelected ? 'bg-[#D4AF37]/15 text-[#D4AF37]' : 'bg-white/[0.04] text-[#71717A]'
            }`}
          >
            {isNetwork ? <Wifi className="w-4 h-4" /> : <Radio className="w-4 h-4" />}
          </div>
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs font-medium truncate ${isSelected ? 'text-white' : 'text-[#E4E4E7]'}`}>
                {cleanName}
              </span>
              {modelDesc && (
                <span className="text-[11px] text-[#A1A1AA] truncate">
                  ({modelDesc})
                </span>
              )}
              {isNetwork && (
                <span className="px-1.5 py-0.5 rounded text-[9px] bg-white/[0.06] text-[#A1A1AA] border border-white/[0.08]">
                  UPnP
                </span>
              )}
            </div>
            <span className="text-[11px] text-[#71717A] truncate mt-0.5">
              {subtitle}
            </span>
          </div>
        </div>

        {isSelected && (
          <div className="w-5 h-5 rounded-full flex items-center justify-center bg-[#D4AF37] text-black shrink-0 shadow-sm">
            <Check className="w-3 h-3 stroke-[3]" />
          </div>
        )}
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="bg-[#121318] border border-white/[0.10] rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col">
        {/* Modal Header */}
        <div className="p-4 px-6 border-b border-white/[0.08] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-white/[0.05] border border-white/[0.08] text-[#D4AF37]">
              <Speaker className="w-4 h-4 text-[#D4AF37]" />
            </div>
            <div className="flex flex-col text-left">
              <h3 className="text-sm font-semibold text-white">
                Audio Output
              </h3>
              <span className="text-xs text-[#8E8E93]">
                Playback devices and audio routing
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#71717A] hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Master Switch: Bit-Perfect Mode */}
        <div className="p-4 px-6 bg-white/[0.02] border-b border-white/[0.08] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`p-2 rounded-xl border transition-all shrink-0 ${
                isPurityMode
                  ? 'bg-[#D4AF37]/15 border-[#D4AF37]/40 text-[#D4AF37]'
                  : 'bg-white/[0.04] border-white/[0.08] text-[#71717A]'
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div className="flex flex-col text-left">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-white tracking-wide">
                  Bit-Perfect Mode
                </span>
                {isPurityMode && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium tracking-wide uppercase bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/30">
                    ENABLED · UNITY GAIN
                  </span>
                )}
              </div>
              <span className="text-xs text-[#8E8E93] max-w-sm mt-0.5 leading-relaxed">
                Locks digital volume at 0 dB and enables native sample-rate output.
              </span>
            </div>
          </div>

          {/* HIG Toggle Switch (Cadence Gold accent) */}
          <button
            onClick={() => togglePurityMode()}
            role="switch"
            aria-checked={isPurityMode}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              isPurityMode ? 'bg-[#D4AF37]' : 'bg-white/20 hover:bg-white/30'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full shadow-md ring-0 transition duration-200 ease-in-out ${
                isPurityMode ? 'translate-x-5 bg-black' : 'translate-x-0 bg-white'
              }`}
            />
          </button>
        </div>

        {/* Active Stream & Clock Telemetry */}
        {streamTelemetry && (
          <div className="p-3 px-6 bg-black/20 border-b border-white/[0.06] flex items-center justify-between text-xs">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase font-medium tracking-wider text-[#71717A]">
                Source & Clock
              </span>
              <div className="flex items-center gap-2 text-[#E4E4E7] font-medium mt-0.5">
                <span>{streamTelemetry.format}</span>
                <span className="text-[#52525B]">·</span>
                <span>
                  {streamTelemetry.sampleRate ? `${streamTelemetry.sampleRate / 1000} kHz` : '44.1 kHz'}
                </span>
                <span className="text-[#52525B]">/</span>
                <span>{streamTelemetry.bitDepth || 16}-bit</span>
                {outputSampleRate && (
                  <span className="text-[11px] text-[#A1A1AA]">
                    (DAC: {outputSampleRate / 1000} kHz)
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isBitPerfect && (
                <span className="px-2 py-0.5 rounded bg-white/[0.06] text-[#E4E4E7] border border-white/[0.10] text-[10px] font-medium">
                  Bit-Perfect
                </span>
              )}
              {streamTelemetry.isHighRes && (
                <span className="px-2 py-0.5 rounded bg-[#D4AF37]/15 text-[#D4AF37] border border-[#D4AF37]/30 text-[10px] font-medium">
                  Hi-Res
                </span>
              )}
            </div>
          </div>
        )}

        {/* Device List Sectioned */}
        <div className="p-6 flex flex-col gap-5 max-h-80 overflow-y-auto">
          <div className="flex items-center justify-between text-xs text-[#8E8E93]">
            <span className="font-medium text-white/90">Audio Devices</span>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="text-[#D4AF37] hover:text-[#D4AF37]/80 flex items-center gap-1.5 cursor-pointer text-xs transition-colors disabled:opacity-50"
              title="Refresh hardware audio devices and local UPnP/DLNA streamers"
            >
              {isRefreshing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              <span>{isRefreshing ? 'Refreshing...' : 'Refresh Devices'}</span>
            </button>
          </div>

          {availableDevices.length === 0 ? (
            <div className="p-5 rounded-xl border border-white/[0.08] bg-black/30 text-center text-xs text-[#71717A]">
              No audio devices detected. Defaulting to system audio.
            </div>
          ) : (
            <>
              {/* Direct Audio Section */}
              {hardwareDevices.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-[11px] font-medium text-[#71717A]">
                    <Radio className="w-3.5 h-3.5 text-[#A1A1AA]" />
                    <span>Direct Audio ({hardwareDevices.length})</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {hardwareDevices.map(renderDeviceCard)}
                  </div>
                </div>
              )}

              {/* Network Streamers Section */}
              {networkDevices.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-[11px] font-medium text-[#71717A]">
                    <Wifi className="w-3.5 h-3.5 text-[#A1A1AA]" />
                    <span>Network Streamers ({networkDevices.length})</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {networkDevices.map(renderDeviceCard)}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 px-6 border-t border-white/[0.08] flex items-center justify-end bg-white/[0.01]">
          <button
            onClick={onClose}
            className="px-5 py-1.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-white text-xs cursor-pointer transition-colors font-medium"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
