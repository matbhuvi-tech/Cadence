import React, { useEffect, useRef, useState } from 'react'
import {
  X,
  Wifi,
  WifiOff,
  Copy,
  Check,
  RefreshCw,
  ShieldCheck,
  ChevronDown,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import QRCode from 'qrcode'
import { tauriBridge, RemoteServerStatus, MaintenanceStats } from '../../services/tauriBridge'
import { CadenceLogo } from '../common/CadenceLogo'

interface MobileRemoteModalProps {
  isOpen: boolean
  onClose: () => void
}

type ModalLifecycle = 'discovering' | 'verified' | 'no_lan'

export const MobileRemoteModal: React.FC<MobileRemoteModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [status, setStatus] = useState<RemoteServerStatus | null>(null)
  const [mStats, setMStats] = useState<MaintenanceStats | null>(null)
  const [selectedIp, setSelectedIp] = useState<string>('')
  const [copied, setCopied] = useState<boolean>(false)
  const [isRegenerating, setIsRegenerating] = useState<boolean>(false)
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false)
  const [lifecycle, setLifecycle] = useState<ModalLifecycle>('discovering')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const loadStatus = async () => {
    try {
      const s = await tauriBridge.getRemoteServerInfo()
      if (s) {
        setStatus(s)
        if (s.hasVerifiedLan && s.primaryIp) {
          if (!selectedIp || !s.interfaces.some((i) => i.ip === selectedIp)) {
            setSelectedIp(s.primaryIp)
          }
          setLifecycle('verified')
        } else {
          setSelectedIp('')
          setLifecycle('no_lan')
        }
      } else {
        setLifecycle('no_lan')
      }
    } catch {
      setLifecycle('no_lan')
    }

    try {
      const ms = await tauriBridge.getMaintenanceStats()
      if (ms) {
        setMStats(ms)
      }
    } catch {
      // ignore maintenance stats errors
    }
  }

  useEffect(() => {
    if (isOpen) {
      setLifecycle('discovering')
      loadStatus()
      const interval = setInterval(loadStatus, 4000)
      return () => clearInterval(interval)
    }
  }, [isOpen])

  const activePort = status?.port || 4040
  const activeToken = status?.pairingToken || ''
  const hasValidIp = lifecycle === 'verified' && Boolean(selectedIp) && selectedIp !== '127.0.0.1'
  const pairingUrl = hasValidIp ? `https://${selectedIp}:${activePort}/?token=${activeToken}` : ''
  const mDnsUrl = status?.mDnsHost && hasValidIp
    ? `https://${status.mDnsHost}:${activePort}/?token=${activeToken}`
    : ''

  // High-Contrast Scannability QR Rendering:
  // Pure high-luminance light matrix on deep matte well with a 16px quiet zone.
  // ONLY render when lifecycle is verified and hasValidIp is true!
  useEffect(() => {
    if (canvasRef.current && hasValidIp && pairingUrl) {
      QRCode.toCanvas(canvasRef.current, pairingUrl, {
        width: 200,
        margin: 2,
        color: {
          dark: '#0D0E11',
          light: '#F5F5F7',
        },
      }).catch((err) => console.error('QR Render error:', err))
    }
  }, [pairingUrl, hasValidIp, isOpen])

  const handleCopy = () => {
    if (!pairingUrl) return
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

  const handleManualRefresh = async () => {
    setIsRefreshing(true)
    await loadStatus()
    setIsRefreshing(false)
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-lg bg-[#16171B] border border-white/[0.08] rounded-2xl shadow-[0_32px_64px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col will-change-transform">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-[#0C0D10] border border-[#D4AF37]/35 text-[#D4AF37] shadow-[0_2px_10px_rgba(212,175,55,0.18)]">
              <CadenceLogo variant="gold" className="w-5 h-5" />
            </div>
            <div className="text-left">
              <h2 className="text-sm font-semibold text-[#EDEDED] flex items-center gap-2">
                Cadence Mobile Remote
                {status && status.connectedClients > 0 && (
                  <span className="flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-mono text-[#10B981] bg-[#10B981]/15 border border-[#10B981]/30 rounded-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-pulse" />
                    {status.connectedClients} Connected
                  </span>
                )}
              </h2>
              <p className="text-xs text-[#8E8E93]">
                Audiophile Couch Controller & Headless Transport Companion
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#8E8E93] hover:text-[#EDEDED] hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 overflow-y-auto max-h-[80vh] text-left">
          {/* 3-State Lifecycle Container */}
          {lifecycle === 'discovering' && (
            <div className="flex flex-col items-center justify-center p-8 bg-[#0D0E11] rounded-2xl border border-white/[0.06] shadow-inner text-center space-y-3">
              <Loader2 className="w-8 h-8 text-[#D4AF37] animate-spin" />
              <div className="space-y-1">
                <p className="text-xs font-medium text-[#EDEDED]">Discovering Physical Network Interfaces...</p>
                <p className="text-[11px] text-[#636366]">Verifying local Wi-Fi and Ethernet routing</p>
              </div>
            </div>
          )}

          {lifecycle === 'no_lan' && (
            <div className="p-5 bg-[#0D0E11] rounded-2xl border border-rose-500/20 shadow-inner space-y-4">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-xl bg-rose-500/10 text-rose-400 shrink-0">
                  <WifiOff className="w-6 h-6" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-[#EDEDED]">No Local Wi-Fi Connection Found</h3>
                  <p className="text-xs text-[#8E8E93] leading-relaxed">
                    Cadence requires a verified physical Wi-Fi or Ethernet connection to pair with your smartphone. Virtual adapters (WSL, Docker, Tailscale) and loopback addresses are excluded.
                  </p>
                </div>
              </div>

              <div className="p-3 bg-white/[0.02] border border-white/[0.06] rounded-xl space-y-2 text-[11px] text-[#8E8E93]">
                <div className="font-medium text-[#EDEDED] flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-[#D4AF37]" />
                  <span>Troubleshooting Checklist</span>
                </div>
                <ul className="list-disc list-inside space-y-1 text-[#8E8E93]">
                  <li>Ensure this PC is connected to your local Wi-Fi router.</li>
                  <li>In Windows Network Settings, ensure your connection profile is set to <strong className="text-[#EDEDED]">Private</strong> (Public profiles block inbound connections).</li>
                  <li>Ensure your phone is connected to the exact same Wi-Fi network.</li>
                </ul>
              </div>

              <div className="flex justify-end pt-1">
                <button
                  onClick={handleManualRefresh}
                  disabled={isRefreshing}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.06] hover:bg-white/[0.1] text-[#EDEDED] border border-white/[0.08] rounded-xl text-xs font-medium transition cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                  <span>Refresh Network Interfaces</span>
                </button>
              </div>
            </div>
          )}

          {lifecycle === 'verified' && (
            <>
              {/* QR Code and Quick Pairing (Luxury High-Contrast Well) */}
              <div className="flex flex-col items-center justify-center p-5 bg-[#0D0E11] rounded-2xl border border-white/[0.06] shadow-inner">
                <div className="p-3 bg-[#F5F5F7] rounded-xl shadow-lg mb-3">
                  <canvas ref={canvasRef} className="rounded-md" />
                </div>

                {/* Monospace Tabular-Nums Interface Line */}
                <div className="text-center space-y-1">
                  <div className="text-[11px] font-mono text-[#8E8E93] flex items-center justify-center gap-1.5 tabular-nums">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
                    <span>Bound to {selectedIp}:{activePort}</span>
                    <span>·</span>
                    <span className="text-[#EDEDED]">Zero-Polling WebSocket</span>
                  </div>
                  <p className="text-[11px] text-[#636366]">
                    Scan with smartphone camera on the same Wi-Fi network
                  </p>
                </div>
              </div>

              {/* Network Interface & Direct URL */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-[#8E8E93]">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Wifi className="w-3.5 h-3.5 text-[#D4AF37]" />
                    Network Interface (LAN)
                  </span>
                  {status && status.interfaces.length > 1 && (
                    <div className="relative">
                      <select
                        value={selectedIp}
                        onChange={(e) => setSelectedIp(e.target.value)}
                        className="bg-black/40 border border-white/[0.08] rounded-lg px-2 py-1 text-xs text-[#EDEDED] outline-none cursor-pointer pr-6 appearance-none font-mono"
                      >
                        {status.interfaces.map((iface) => (
                          <option key={iface.ip} value={iface.ip}>
                            {iface.name} ({iface.ip}){iface.isRecommended ? ' ★' : ''}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="w-3 h-3 text-[#8E8E93] absolute right-1.5 top-2 pointer-events-none" />
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={pairingUrl}
                    className="flex-1 bg-black/40 border border-white/[0.06] rounded-xl px-3 py-2 text-xs font-mono text-[#8E8E93] select-all outline-none"
                  />
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 px-3 py-2 bg-white/[0.05] hover:bg-white/[0.1] text-[#EDEDED] border border-white/[0.08] rounded-xl text-xs font-medium transition cursor-pointer active:scale-95 shrink-0"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-[#10B981]" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>

                {mDnsUrl && (
                  <div className="text-[11px] font-mono text-[#636366] flex items-center justify-between px-1">
                    <span>mDNS: <code className="text-[#8E8E93]">{mDnsUrl}</code></span>
                    <span>Port {activePort}</span>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Pairing Security PIN Token */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-black/30 border border-white/[0.06]">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="w-4 h-4 text-[#D4AF37]" />
              <div className="text-left">
                <div className="text-xs font-medium text-[#EDEDED]">Pairing Security Token</div>
                <div className="text-[11px] font-mono text-[#636366]">
                  PIN: <code className="text-[#D4AF37] font-bold tracking-wider">{activeToken}</code> {hasValidIp ? '(Encoded in QR)' : ''}
                </div>
              </div>
            </div>
            <button
              onClick={handleRegenerate}
              disabled={isRegenerating}
              className="flex items-center gap-1 px-2.5 py-1 text-xs text-[#8E8E93] hover:text-[#EDEDED] hover:bg-white/[0.05] rounded-lg transition cursor-pointer"
              title="Generate new PIN to disconnect active mobile sessions"
            >
              <RefreshCw className={`w-3 h-3 ${isRegenerating ? 'animate-spin' : ''}`} />
              <span>Reset PIN</span>
            </button>
          </div>

          {/* Audiophile Architecture Notes */}
          <div className="p-3.5 rounded-xl bg-black/20 border border-white/[0.04] text-xs text-[#8E8E93] space-y-1.5">
            <div className="font-semibold text-[#EDEDED] flex items-center gap-1.5">
              <span>Audiophile Remote Architecture</span>
            </div>
            <ul className="list-disc list-inside space-y-1 text-[11px] text-[#8E8E93] leading-relaxed">
              <li>
                <strong className="text-[#EDEDED]">Zero Storage Contention:</strong> Remote browsing accesses lightweight pre-cached thumbnails; music disks remain 100% idle.
              </li>
              <li>
                <strong className="text-[#EDEDED]">Wi-Fi Low-Noise Pacing:</strong> Progress slider advances via 120fps client interpolation with no network polling bursts.
              </li>
              <li>
                <strong className="text-[#EDEDED]">PWA Native Feel:</strong> On Android Chrome or iOS Safari, tap <em className="text-[#EDEDED]">Add to Home Screen</em> for full-screen couch control.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
