import React, { useEffect, useRef, useState } from 'react'
import {
  X,
  Smartphone,
  Wifi,
  Copy,
  Check,
  RefreshCw,
  ShieldCheck,
  Radio,
  ExternalLink,
  ChevronDown,
} from 'lucide-react'
import QRCode from 'qrcode'
import { tauriBridge, RemoteServerStatus } from '../../services/tauriBridge'

interface MobileRemoteModalProps {
  isOpen: boolean
  onClose: () => void
}

export const MobileRemoteModal: React.FC<MobileRemoteModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [status, setStatus] = useState<RemoteServerStatus | null>(null)
  const [selectedIp, setSelectedIp] = useState<string>('')
  const [copied, setCopied] = useState<boolean>(false)
  const [isRegenerating, setIsRegenerating] = useState<boolean>(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const loadStatus = async () => {
    const s = await tauriBridge.getRemoteServerInfo()
    if (s) {
      setStatus(s)
      if (!selectedIp || !s.interfaces.some((i) => i.ip === selectedIp)) {
        setSelectedIp(s.primaryIp)
      }
    }
  }

  useEffect(() => {
    if (isOpen) {
      loadStatus()
      const interval = setInterval(loadStatus, 3000)
      return () => clearInterval(interval)
    }
  }, [isOpen])

  const activePort = status?.port || 4040
  const activeToken = status?.pairingToken || ''
  const pairingUrl = `http://${selectedIp || '127.0.0.1'}:${activePort}/?token=${activeToken}`
  const mDnsUrl = status?.mDnsHost
    ? `http://${status.mDnsHost}:${activePort}/?token=${activeToken}`
    : ''

  useEffect(() => {
    if (canvasRef.current && pairingUrl) {
      QRCode.toCanvas(canvasRef.current, pairingUrl, {
        width: 220,
        margin: 2,
        color: {
          dark: '#09090b',
          light: '#ffffff',
        },
      }).catch((err) => console.error('QR Render error:', err))
    }
  }, [pairingUrl, isOpen])

  const handleCopy = () => {
    navigator.clipboard.writeText(pairingUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleRegenerate = async () => {
    setIsRegenerating(true)
    const newToken = await tauriBridge.regeneratePairingToken()
    if (newToken && status) {
      setStatus({ ...status, pairingToken: newToken })
    }
    setIsRegenerating(false)
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-lg bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/40">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
                Cadence Mobile Remote
                {status && status.connectedClients > 0 && (
                  <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    {status.connectedClients} Connected
                  </span>
                )}
              </h2>
              <p className="text-xs text-zinc-400">
                Audiophile Couch Controller & Headless Transport Companion
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto max-h-[80vh]">
          {/* QR Code and Quick Pairing */}
          <div className="flex flex-col items-center justify-center p-5 bg-zinc-900/60 rounded-xl border border-zinc-800/60">
            <div className="p-2 bg-white rounded-xl shadow-lg shadow-cyan-500/5 mb-3">
              <canvas ref={canvasRef} className="rounded-lg" />
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-300 font-medium">
              <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
              Scan with phone camera on the same Wi-Fi
            </div>
          </div>

          {/* Network Interface & URL */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span className="flex items-center gap-1.5 font-medium">
                <Wifi className="w-3.5 h-3.5 text-cyan-400" />
                Network Interface (LAN)
              </span>
              {status && status.interfaces.length > 1 && (
                <div className="relative">
                  <select
                    value={selectedIp}
                    onChange={(e) => setSelectedIp(e.target.value)}
                    className="bg-zinc-900 border border-zinc-700/80 rounded-lg px-2 py-1 text-xs text-zinc-200 outline-none cursor-pointer pr-6 appearance-none"
                  >
                    {status.interfaces.map((iface) => (
                      <option key={iface.ip} value={iface.ip}>
                        {iface.name} ({iface.ip}){iface.isRecommended ? ' ★' : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-3 h-3 text-zinc-400 absolute right-1.5 top-2 pointer-events-none" />
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={pairingUrl}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-mono text-zinc-300 select-all outline-none"
              />
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-3 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded-xl text-xs font-medium transition active:scale-95"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            {mDnsUrl && (
              <div className="text-[11px] text-zinc-500 flex items-center justify-between px-1">
                <span>Windows mDNS: <code className="text-zinc-400">{mDnsUrl}</code></span>
                <span className="text-[10px] text-zinc-500">Port {activePort}</span>
              </div>
            )}
          </div>

          {/* Pairing Security PIN Token */}
          <div className="flex items-center justify-between p-3 bg-zinc-900/40 rounded-xl border border-zinc-800/50">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-amber-400" />
              <div>
                <div className="text-xs font-medium text-zinc-200">Pairing Security Token</div>
                <div className="text-[11px] text-zinc-500">
                  PIN: <code className="text-amber-300 font-mono font-bold tracking-wider">{activeToken}</code> (Encoded in QR code)
                </div>
              </div>
            </div>
            <button
              onClick={handleRegenerate}
              disabled={isRegenerating}
              className="flex items-center gap-1 px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition"
              title="Generate new PIN to disconnect active mobile sessions"
            >
              <RefreshCw className={`w-3 h-3 ${isRegenerating ? 'animate-spin' : ''}`} />
              Reset PIN
            </button>
          </div>

          {/* Audiophile Features & Instructions */}
          <div className="p-3.5 bg-zinc-900/30 rounded-xl border border-zinc-800/40 text-xs text-zinc-400 space-y-2">
            <div className="font-semibold text-zinc-300 flex items-center gap-1.5">
              <span>Audiophile Systems Architecture</span>
            </div>
            <ul className="list-disc list-inside space-y-1 text-[11px] text-zinc-400 leading-relaxed">
              <li>
                <strong className="text-zinc-300">Zero Storage Contention:</strong> Remote library browsing requests lightweight pre-cached thumbnails. Music drive remains 100% idle during playback.
              </li>
              <li>
                <strong className="text-zinc-300">Wi-Fi Low-Noise Pacing:</strong> Scrubber advances via 120fps client interpolation. Zero high-frequency packet floods.
              </li>
              <li>
                <strong className="text-zinc-300">PWA Native Feel:</strong> On iPhone Safari, tap <em className="text-zinc-300">Share &rarr; Add to Home Screen</em> for full-screen standalone couch control.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
