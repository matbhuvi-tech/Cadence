import React, { useEffect, useState, useCallback } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  KeyRound,
  QrCode,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wifi,
  X,
} from 'lucide-react';
import type { DiscoveredServer, ProbeResult, ServerProfile } from '../../types/remote';
import {
  extractHostAndPort,
  formatFingerprintBlocks,
  loadSavedServerProfiles,
  normalizeBaseUrl,
  parsePairingInput,
  removeSavedServerProfile,
} from '../../services/serverProfiles';
import {
  cancelFallbackQrScan,
  discoverLanDesktops,
  isNativeAndroid,
  probeCadenceServer,
  scanPairingQrCode,
} from '../../platform/cadenceBridge';

interface PairingViewProps {
  onPaired: (profile: ServerProfile) => void;
  onCancel?: () => void;
}

interface PendingCertReview {
  profile: ServerProfile;
  observedFingerprint: string;
  isMismatch: boolean;
}

export const PairingView: React.FC<PairingViewProps> = ({ onPaired, onCancel }) => {
  const nativeAndroid = isNativeAndroid();

  const [savedProfiles, setSavedProfiles] = useState<ServerProfile[]>(() => loadSavedServerProfiles());
  const [discovered, setDiscovered] = useState<DiscoveredServer[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);

  const [isCameraOverlay, setIsCameraOverlay] = useState(false);
  const [isScanningQr, setIsScanningQr] = useState(false);

  const [showManual, setShowManual] = useState(!nativeAndroid);
  const [scheme, setScheme] = useState<'https' | 'http'>('https');
  const [hostInput, setHostInput] = useState('');
  const [portInput, setPortInput] = useState('4040');
  const [pinInput, setPinInput] = useState('');
  const [selectedDiscovered, setSelectedDiscovered] = useState<DiscoveredServer | null>(null);

  const [isConnecting, setIsConnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formHint, setFormHint] = useState<string | null>(null);
  const [pendingCert, setPendingCert] = useState<PendingCertReview | null>(null);

  const runDiscovery = useCallback(async () => {
    if (!nativeAndroid) return;
    setIsDiscovering(true);
    setDiscovered([]);
    try {
      const results = await discoverLanDesktops(3000, (item) => {
        setDiscovered((prev) => {
          const exists = prev.some((s) => s.baseUrl === item.baseUrl);
          return exists ? prev : [...prev, item];
        });
      });
      setDiscovered(results);
    } catch {
      // NSD failure is non-fatal; user still has QR scan + manual IP
    } finally {
      setIsDiscovering(false);
    }
  }, [nativeAndroid]);

  useEffect(() => {
    if (nativeAndroid) {
      void Promise.resolve().then(() => runDiscovery());
    }
    return () => {
      void cancelFallbackQrScan();
    };
  }, [nativeAndroid, runDiscovery]);

  const handleProbeFailure = (candidate: ServerProfile, probe: ProbeResult) => {
    if (
      (probe.errorKind === 'cert_untrusted' || probe.errorKind === 'cert_mismatch') &&
      probe.certFingerprint
    ) {
      setPendingCert({
        profile: candidate,
        observedFingerprint: probe.certFingerprint,
        isMismatch: probe.errorKind === 'cert_mismatch',
      });
      return;
    }

    if (probe.errorKind === 'unauthorized') {
      setFormError('Desktop rejected the pairing PIN.');
      setFormHint('Check the 4-digit PIN shown in Cadence Desktop → Mobile Remote.');
    } else if (probe.errorKind === 'timeout') {
      setFormError('Connection to desktop timed out.');
      setFormHint(
        'Confirm Cadence Desktop is running on the same Wi-Fi network and AP/Client Isolation is disabled on your router.'
      );
    } else if (probe.errorKind === 'connection_refused') {
      setFormError('Desktop refused connection on port ' + candidate.port + '.');
      setFormHint('Ensure Mobile Remote is enabled in Cadence Desktop and Windows Firewall allows Private networks.');
    } else if (probe.errorKind === 'dns_error') {
      setFormError('Could not resolve hostname.');
      setFormHint('Try selecting the discovered LAN desktop or entering the IPv4 address directly.');
    } else {
      setFormError(probe.errorMessage || 'Could not reach Cadence Desktop.');
      setFormHint('Check Wi-Fi connectivity and desktop port settings.');
    }
  };

  const verifyAndCompletePairing = async (candidate: ServerProfile) => {
    setFormError(null);
    setFormHint(null);
    setIsConnecting(true);
    try {
      const probe = await probeCadenceServer(
        candidate.baseUrl,
        candidate.token,
        candidate.certFingerprint,
        Boolean(candidate.trustInsecure),
        4000
      );

      if (probe.reachable && probe.authenticated) {
        const finalized: ServerProfile = {
          ...candidate,
          certFingerprint: probe.certFingerprint || candidate.certFingerprint,
          lastConnectedAt: Date.now(),
        };
        onPaired(finalized);
        return;
      }

      handleProbeFailure(candidate, probe);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleScanQr = async () => {
    setFormError(null);
    setFormHint(null);
    setIsScanningQr(true);
    try {
      const raw = await scanPairingQrCode({
        onCameraFallbackStart: () => setIsCameraOverlay(true),
        onCameraFallbackStop: () => setIsCameraOverlay(false),
      });
      if (!raw) return;

      const parsed = parsePairingInput(raw);
      if (!parsed?.baseUrl) {
        setFormError('Unrecognized QR code.');
        setFormHint('Scan the QR code generated inside Cadence Desktop → Mobile Remote.');
        return;
      }

      const { host, port, scheme: parsedScheme } = extractHostAndPort(parsed.baseUrl);
      if (!parsed.token) {
        setShowManual(true);
        setScheme(parsedScheme);
        setHostInput(host);
        setPortInput(String(port));
        setFormError('QR code did not include a pairing PIN.');
        setFormHint('Enter the 4-digit PIN displayed in Cadence Desktop.');
        return;
      }

      const candidate: ServerProfile = {
        id: parsed.baseUrl,
        label: parsed.label || host,
        baseUrl: parsed.baseUrl,
        mDnsHost: parsed.mDnsHost,
        fallbackIps: parsed.fallbackIps,
        port,
        token: parsed.token,
        certFingerprint: parsed.certFingerprint,
        trustInsecure: parsedScheme === 'http' ? true : parsed.trustInsecure,
      };
      await verifyAndCompletePairing(candidate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'CAMERA_PERMISSION_DENIED') {
        setFormError('Camera permission was denied.');
        setFormHint(
          'Camera access is only used to scan your Cadence Desktop QR code. You can also use Auto-Discover or Manual IP below.'
        );
      } else {
        setFormError(msg || 'QR scan failed.');
      }
      setShowManual(true);
    } finally {
      setIsCameraOverlay(false);
      setIsScanningQr(false);
    }
  };

  const handleCancelCameraOverlay = () => {
    void cancelFallbackQrScan();
    setIsCameraOverlay(false);
    setIsScanningQr(false);
  };

  const handleSelectDiscovered = (server: DiscoveredServer) => {
    setFormError(null);
    setFormHint(null);
    setSelectedDiscovered(server);

    const parsedScheme = server.protocol === 'http' ? 'http' : 'https';
    setScheme(parsedScheme);
    setHostInput(server.ip || server.mDnsHost || server.hostName);
    setPortInput(String(server.port || 4040));
    setShowManual(true);

    const matchingSaved = savedProfiles.find(
      (p) =>
        p.baseUrl === server.baseUrl ||
        (server.fingerprint && p.certFingerprint === server.fingerprint.toLowerCase())
    );
    if (matchingSaved?.token) {
      setPinInput(matchingSaved.token);
      void verifyAndCompletePairing({
        ...matchingSaved,
        baseUrl: server.baseUrl,
        port: server.port || matchingSaved.port,
        mDnsHost: server.mDnsHost || matchingSaved.mDnsHost,
        certFingerprint: server.fingerprint || matchingSaved.certFingerprint,
      });
    }
  };

  const handleHostInputChange = (val: string) => {
    setHostInput(val);
    if (selectedDiscovered) {
      setSelectedDiscovered(null);
    }
    if (val.includes('://') && val.includes('token=')) {
      const parsed = parsePairingInput(val);
      if (parsed?.baseUrl) {
        const { host, port, scheme: s } = extractHostAndPort(parsed.baseUrl);
        setScheme(s);
        setHostInput(host);
        setPortInput(String(port));
        if (parsed.token) setPinInput(parsed.token);
      }
    }
  };

  const handleManualConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormHint(null);

    const trimmedHost = hostInput.trim();
    const trimmedPin = pinInput.trim();
    const portNum = Math.max(1, Math.min(65535, Number(portInput) || 4040));

    if (!trimmedHost) {
      setFormError('Enter your Cadence Desktop IP address or .local hostname.');
      return;
    }
    if (!trimmedPin) {
      setFormError('Enter the 4-digit pairing PIN from Cadence Desktop.');
      return;
    }

    const parsedUrl = trimmedHost.includes('://')
      ? normalizeBaseUrl(trimmedHost, portNum, scheme)
      : normalizeBaseUrl(`${scheme}://${trimmedHost}:${portNum}`, portNum, scheme);
    const { host, port, scheme: resolvedScheme } = extractHostAndPort(parsedUrl);

    const candidate: ServerProfile = {
      id: parsedUrl,
      label: selectedDiscovered?.serviceName || (host.endsWith('.local') ? host.replace(/\.local$/i, '') : host),
      baseUrl: parsedUrl,
      mDnsHost: selectedDiscovered?.mDnsHost || (host.endsWith('.local') ? host : undefined),
      port,
      token: trimmedPin,
      certFingerprint: selectedDiscovered?.fingerprint,
      trustInsecure: resolvedScheme === 'http' ? true : false,
    };

    await verifyAndCompletePairing(candidate);
  };

  const handleTrustPendingCert = () => {
    if (!pendingCert) return;
    const pinned: ServerProfile = {
      ...pendingCert.profile,
      certFingerprint: pendingCert.observedFingerprint.toLowerCase(),
      trustInsecure: false,
    };
    setPendingCert(null);
    void verifyAndCompletePairing(pinned);
  };

  const handleRemoveSaved = (e: React.MouseEvent, targetUrl: string) => {
    e.stopPropagation();
    setSavedProfiles(removeSavedServerProfile(targetUrl));
  };

  // Transparent CameraX viewfinder overlay for devices without Google Code Scanner
  if (isCameraOverlay) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-between bg-transparent p-5 pt-safe pb-safe">
        <div className="rounded-2xl bg-black/75 backdrop-blur-md border border-zinc-800 px-4 py-3 text-center shadow-xl">
          <p className="text-sm font-semibold text-zinc-100">Point at Cadence Desktop QR Code</p>
          <p className="text-xs text-zinc-400 mt-0.5">
            Open Mobile Remote on your PC to display the QR pairing code.
          </p>
        </div>

        <div className="mx-auto w-64 h-64 rounded-3xl border-2 border-[#D4AF37]/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />

        <button
          type="button"
          onClick={handleCancelCameraOverlay}
          className="w-full min-h-[52px] rounded-2xl bg-zinc-950/90 border border-zinc-700 text-zinc-100 font-semibold text-sm active:scale-[0.99] transition-transform"
        >
          Cancel Scan
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-[#0D0E11] text-zinc-100 flex flex-col px-4 py-6 pb-safe pt-safe overflow-y-auto">
      <div className="mx-auto w-full max-w-md flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#D4AF37]/15 border border-[#D4AF37]/30 text-[#D4AF37] text-[11px] font-semibold mb-2">
              <Radio className="w-3.5 h-3.5" />
              <span>Bit-Perfect Wi-Fi Remote</span>
            </div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-100">
              Connect to Cadence Desktop
            </h1>
            <p className="text-xs text-zinc-400 mt-1">
              Scan the QR code in Cadence Desktop or pick a discovered PC on your Wi-Fi network.
            </p>
          </div>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Cancel switching desktop"
              className="min-w-[48px] min-h-[48px] rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-100"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Primary Action: In-App QR Scanner */}
        {nativeAndroid && (
          <button
            type="button"
            onClick={() => void handleScanQr()}
            disabled={isScanningQr || isConnecting}
            className="w-full min-h-[54px] rounded-2xl bg-[#D4AF37] hover:bg-[#e1be4b] text-zinc-950 font-bold text-sm flex items-center justify-center gap-2.5 shadow-lg shadow-[#D4AF37]/15 active:scale-[0.98] transition-all disabled:opacity-60"
          >
            {isScanningQr ? (
              <RefreshCw className="w-5 h-5 animate-spin" />
            ) : (
              <QrCode className="w-5 h-5" />
            )}
            <span>{isScanningQr ? 'Opening Camera...' : 'Scan Desktop QR Code'}</span>
          </button>
        )}

        {/* Inline Validation / Connection Error */}
        {formError && (
          <div
            role="alert"
            className="rounded-2xl bg-rose-500/10 border border-rose-500/35 p-3.5 flex items-start gap-2.5"
          >
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-rose-200">{formError}</p>
              {formHint && <p className="text-[11px] text-rose-300/80 mt-1 leading-relaxed">{formHint}</p>}
            </div>
          </div>
        )}

        {/* Saved Desktops */}
        {savedProfiles.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 px-1">
              Recent Desktops
            </h2>
            <div className="flex flex-col gap-2">
              {savedProfiles.map((prof) => (
                <div
                  key={prof.baseUrl}
                  onClick={() => void verifyAndCompletePairing(prof)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void verifyAndCompletePairing(prof);
                    }
                  }}
                  className="min-h-[56px] w-full rounded-2xl bg-zinc-900/75 border border-zinc-800 hover:border-[#D4AF37]/50 px-3.5 py-2.5 flex items-center justify-between gap-2 cursor-pointer transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-zinc-800 flex items-center justify-center shrink-0 text-[#D4AF37]">
                      <Server className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-zinc-100 truncate">{prof.label}</p>
                      <p className="text-[11px] font-mono text-zinc-400 truncate">
                        {prof.baseUrl}
                        {prof.certFingerprint ? ' • Pinned' : ''}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => handleRemoveSaved(e, prof.baseUrl)}
                    aria-label={`Remove ${prof.label}`}
                    className="min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center text-zinc-500 hover:text-rose-400 hover:bg-zinc-800"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Local Wi-Fi mDNS Auto-Discovery */}
        {nativeAndroid && (
          <section className="rounded-2xl bg-zinc-900/50 border border-zinc-800/80 p-3.5 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Wifi className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-semibold text-zinc-200">Nearby Desktops on Wi-Fi</span>
              </div>
              <button
                type="button"
                onClick={() => void runDiscovery()}
                disabled={isDiscovering}
                className="min-h-[36px] px-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] font-medium text-zinc-300 flex items-center gap-1.5 disabled:opacity-60"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isDiscovering ? 'animate-spin' : ''}`} />
                <span>{isDiscovering ? 'Scanning...' : 'Scan LAN'}</span>
              </button>
            </div>

            {discovered.length === 0 ? (
              <p className="text-[11px] text-zinc-500 py-1">
                {isDiscovering
                  ? 'Listening for _cadence._tcp servers on your local Wi-Fi...'
                  : 'No servers advertised yet. Ensure Cadence Desktop Mobile Remote is enabled on the same Wi-Fi.'}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {discovered.map((srv) => (
                  <button
                    key={srv.baseUrl}
                    type="button"
                    onClick={() => handleSelectDiscovered(srv)}
                    className="w-full min-h-[52px] rounded-xl bg-zinc-950/70 border border-zinc-800 hover:border-[#D4AF37]/60 px-3 py-2 flex items-center justify-between gap-2 text-left transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-zinc-100 truncate">
                        {srv.serviceName || srv.hostName}
                      </p>
                      <p className="text-[11px] font-mono text-zinc-400 truncate">
                        {srv.ip}:{srv.port}
                        {srv.mDnsHost ? ` • ${srv.mDnsHost}` : ''}
                      </p>
                    </div>
                    <span className="shrink-0 px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-mono text-emerald-300">
                      {srv.fingerprint ? 'HTTPS Pin' : srv.protocol.toUpperCase()}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Secondary Disclosure: Manual IP / Hostname & Port */}
        <section className="rounded-2xl bg-zinc-900/40 border border-zinc-800/80 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowManual((prev) => !prev)}
            className="w-full min-h-[50px] px-4 flex items-center justify-between text-xs font-semibold text-zinc-300 hover:text-zinc-100"
          >
            <span>Manual IP / Hostname & PIN</span>
            {showManual ? (
              <ChevronDown className="w-4 h-4 text-zinc-500" />
            ) : (
              <ChevronRight className="w-4 h-4 text-zinc-500" />
            )}
          </button>

          {showManual && (
            <form onSubmit={(e) => void handleManualConnect(e)} className="px-4 pb-4 pt-1 flex flex-col gap-3">
              {/* Protocol Selector */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setScheme('https')}
                  className={`min-h-[44px] rounded-xl text-xs font-semibold border transition-colors ${
                    scheme === 'https'
                      ? 'bg-[#D4AF37]/15 border-[#D4AF37] text-[#D4AF37]'
                      : 'bg-zinc-950/60 border-zinc-800 text-zinc-400'
                  }`}
                >
                  HTTPS (Pinned)
                </button>
                <button
                  type="button"
                  onClick={() => setScheme('http')}
                  className={`min-h-[44px] rounded-xl text-xs font-semibold border transition-colors ${
                    scheme === 'http'
                      ? 'bg-amber-500/15 border-amber-500 text-amber-300'
                      : 'bg-zinc-950/60 border-zinc-800 text-zinc-400'
                  }`}
                >
                  HTTP (Local LAN)
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                    Desktop IP, .local Host, or Full QR URL
                  </label>
                  <input
                    type="text"
                    value={hostInput}
                    onChange={(e) => handleHostInputChange(e.target.value)}
                    placeholder="192.168.1.42 or pc.local"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="w-full min-h-[44px] rounded-xl bg-zinc-950 border border-zinc-800 px-3 text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-zinc-400 mb-1">Port</label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={portInput}
                    onChange={(e) => setPortInput(e.target.value)}
                    placeholder="4040"
                    className="w-full min-h-[44px] rounded-xl bg-zinc-950 border border-zinc-800 px-3 text-sm font-mono text-zinc-100 focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                  4-Digit Pairing PIN
                </label>
                <div className="relative flex items-center">
                  <KeyRound className="w-4 h-4 text-zinc-500 absolute left-3 pointer-events-none" />
                  <input
                    type="text"
                    inputMode="numeric"
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value)}
                    placeholder="e.g. 4829"
                    className="w-full min-h-[44px] rounded-xl bg-zinc-950 border border-zinc-800 pl-9 pr-3 text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isConnecting}
                className="w-full min-h-[48px] rounded-xl bg-zinc-100 hover:bg-white text-zinc-950 font-bold text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition-all disabled:opacity-60"
              >
                {isConnecting ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Verifying Desktop...</span>
                  </>
                ) : (
                  <span>Connect</span>
                )}
              </button>
            </form>
          )}
        </section>
      </div>

      {/* TOFU / Mismatch TLS Fingerprint Confirmation Modal */}
      {pendingCert && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-md rounded-3xl bg-[#14171D] border border-zinc-800 p-5 flex flex-col gap-3.5 shadow-2xl">
            <div className="flex items-start gap-3">
              {pendingCert.isMismatch ? (
                <ShieldAlert className="w-6 h-6 text-rose-400 shrink-0 mt-0.5" />
              ) : (
                <ShieldCheck className="w-6 h-6 text-[#D4AF37] shrink-0 mt-0.5" />
              )}
              <div>
                <h3 className="text-sm font-bold text-zinc-100">
                  {pendingCert.isMismatch
                    ? 'Desktop Certificate Changed'
                    : 'Confirm Desktop TLS Certificate'}
                </h3>
                <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                  {pendingCert.isMismatch
                    ? 'The HTTPS certificate at this address differs from your saved pin. Verify that Cadence Desktop regenerated its key before trusting.'
                    : 'Verify that this SHA-256 fingerprint matches Cadence Desktop → Mobile Remote before pinning.'}
                </p>
              </div>
            </div>

            <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                Observed SPKI SHA-256
              </p>
              <p className="text-xs font-mono text-amber-200 break-all leading-relaxed">
                {formatFingerprintBlocks(pendingCert.observedFingerprint)}
              </p>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPendingCert(null)}
                className="flex-1 min-h-[48px] rounded-xl bg-zinc-800 text-zinc-200 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleTrustPendingCert}
                className="flex-1 min-h-[48px] rounded-xl bg-[#D4AF37] text-zinc-950 text-xs font-bold"
              >
                Trust & Pin Server
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
