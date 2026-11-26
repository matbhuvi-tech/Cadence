import React, { useEffect, useRef, useState } from 'react'
import { X, WifiOff, Copy, Check, ShieldCheck, Server } from 'lucide-react'
import QRCode from 'qrcode'
import { useOptionalEngineController } from '../../context/EngineControllerContext'
import { CadenceLogo } from '../common/CadenceLogo'

interface MobileRemoteModalProps {
  isOpen: boolean
  onClose: () => void
}

export const MobileRemoteModal: React.FC<MobileRemoteModalProps> = ({
  isOpen,
  onClose,
}) => {
  const engine = useOptionalEngineController()
  const activeProfile = engine?.state.activeProfile ?? null
  const activeEngineHealth = engine?.state.activeEngineHealth ?? null
  const [copied, setCopied] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const pairingUrl = (() => {
    if (!activeProfile) return ''
    try {
      const url = new URL(activeProfile.baseUrl)
      const isLoopback =
        url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
      let origin = url.origin
      if (isLoopback) {
        const advIp = activeEngineHealth?.advertisedIp?.trim() || ''
        const isAdvLoopback =
          !advIp || advIp === '127.0.0.1' || advIp === 'localhost' || advIp === '::1'
        if (isAdvLoopback) return ''
        const port = activeEngineHealth?.controlPort || url.port || '4040'
        origin = `${url.protocol}//${advIp}:${port}`
      }
      const params = new URLSearchParams()
      params.set('kind', 'core')
      if (activeProfile.pairingToken) params.set('token', activeProfile.pairingToken)
      const fp = activeProfile.certFingerprint || activeEngineHealth?.tlsFingerprintSha256
      if (fp) params.set('fp', fp)
      const engineId = activeProfile.engineId || activeEngineHealth?.engineId
      if (engineId) params.set('engineId', engineId)
      const libraryId = activeProfile.libraryId || activeEngineHealth?.libraryId
      if (libraryId) params.set('libraryId', libraryId)
      const label = activeProfile.label || activeEngineHealth?.label
      if (label) params.set('label', label)
      const qs = params.toString()
      return `${origin}/${qs ? `?${qs}` : ''}`
    } catch {
      return ''
    }
  })()

  useEffect(() => {
    if (isOpen && canvasRef.current && pairingUrl) {
      QRCode.toCanvas(canvasRef.current, pairingUrl, {
        width: 200,
        margin: 2,
        color: {
          dark: '#0D0E11',
          light: '#F5F5F7',
        },
      }).catch((err) => console.error('QR Render error:', err))
    }
  }, [pairingUrl, isOpen])

  if (!isOpen) return null

  const handleCopy = () => {
    if (!pairingUrl) return
    void navigator.clipboard.writeText(pairingUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md">
      <div className="relative w-full max-w-lg bg-[#16171B] border border-white/[0.08] rounded-2xl shadow-[0_32px_64px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-[#0C0D10] border border-[#D4AF37]/35 text-[#D4AF37]">
              <CadenceLogo variant="gold" className="w-5 h-5" />
            </div>
            <div className="text-left">
              <h2 className="text-sm font-semibold text-[#EDEDED]">Cadence Mobile Remote</h2>
              <p className="text-xs text-[#8E8E93]">
                Pair your phone directly to the active Playback Engine
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#8E8E93] hover:text-[#EDEDED] hover:bg-white/[0.06] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 text-left">
          {!activeProfile ? (
            <div className="flex flex-col items-center justify-center p-8 bg-[#0D0E11] rounded-2xl border border-white/[0.06] text-center space-y-2">
              <WifiOff className="w-8 h-8 text-amber-400" />
              <p className="text-xs font-medium text-white">No Playback Engine Connected</p>
              <p className="text-[11px] text-white/55">
                Connect to a Playback Engine first to generate a Mobile Remote pairing QR code.
              </p>
            </div>
          ) : !pairingUrl ? (
            <div className="flex flex-col items-center justify-center p-8 bg-[#0D0E11] rounded-2xl border border-white/[0.06] text-center space-y-2">
              <Server className="w-8 h-8 text-amber-400" />
              <p className="text-xs font-medium text-white">
                {activeProfile.label} is bound to loopback ({activeProfile.baseUrl})
              </p>
              <p className="text-[11px] text-white/55">
                Connect using the Engine&apos;s LAN IP address so mobile devices on Wi-Fi can reach it.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <div className="p-4 rounded-2xl bg-[#F5F5F7] shadow-lg">
                <canvas ref={canvasRef} />
              </div>

              <div className="w-full rounded-xl border border-white/10 bg-black/35 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-white/60 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                    <span>{activeProfile.label}</span>
                  </span>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="inline-flex items-center gap-1 text-[11px] text-[#D4AF37] hover:underline cursor-pointer"
                  >
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    <span>{copied ? 'Copied' : 'Copy Link'}</span>
                  </button>
                </div>
                <p className="text-[11px] font-mono text-white/75 break-all">{pairingUrl}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
