import React, { useEffect, useState, useCallback } from 'react';
import {
  AlertTriangle,
  Battery,
  Bell,
  CheckCircle2,
  ClipboardCopy,
  Download,
  KeyRound,
  Link2,
  Lock,
  RefreshCw,
  Send,
  Server,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type { ConnectionDiagnostic, ServerProfile } from '../../types/remote';
import type { DiagnosticsRunResult } from '../../hooks/useRemoteSocket';
import { formatFingerprintBlocks } from '../../services/serverProfiles';
import { CadenceRemote, isNativeAndroid } from '../../platform/cadenceBridge';
import {
  buildMobileSupportReport,
  getMobileSupportWebhookUrl,
  MOBILE_SUPPORT_EMAIL,
  MOBILE_SUPPORT_SCENARIOS,
  mobileDiagnostics,
  setMobileSupportWebhookUrl,
  submitMobileSupportReport,
  type MobileSupportScenario,
} from '../../services/mobileDiagnostics';

interface DiagnosticsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  activeProfile: ServerProfile | null;
  isConnected: boolean;
  isConnecting: boolean;
  connectionDiagnostic: ConnectionDiagnostic | null;
  lockScreenControls: boolean;
  onToggleLockScreenControls: (enabled: boolean) => void;
  onRunDiagnostics: () => Promise<DiagnosticsRunResult>;
  onProbeAlternateEndpoints: () => Promise<boolean>;
  onRetryConnection: () => void;
  onUpdatePin: (newToken: string) => void;
  onTrustFingerprint: (fp: string) => void;
  onSwitchDesktop: () => void;
  onDisconnectDesktop: () => void;
}

export const DiagnosticsSheet: React.FC<DiagnosticsSheetProps> = ({
  isOpen,
  onClose,
  activeProfile,
  isConnected,
  isConnecting,
  connectionDiagnostic,
  lockScreenControls,
  onToggleLockScreenControls,
  onRunDiagnostics,
  onProbeAlternateEndpoints,
  onRetryConnection,
  onUpdatePin,
  onTrustFingerprint,
  onSwitchDesktop,
  onDisconnectDesktop,
}) => {
  const nativeAndroid = isNativeAndroid();

  const [diagResult, setDiagResult] = useState<DiagnosticsRunResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isProbingFallback, setIsProbingFallback] = useState(false);
  const [fallbackMessage, setFallbackMessage] = useState<string | null>(null);
  const [editingPin, setEditingPin] = useState(false);
  const [pinDraft, setPinDraft] = useState(activeProfile?.token || '');
  const [notifDeniedHint, setNotifDeniedHint] = useState(false);
  const [supportScenario, setSupportScenario] = useState<MobileSupportScenario>('mobile_not_connecting');
  const [supportNotes, setSupportNotes] = useState('');
  const [supportContactEmail, setSupportContactEmail] = useState('');
  const [supportWebhookUrl, setSupportWebhookUrl] = useState(() => getMobileSupportWebhookUrl());
  const [showWebhookConfig, setShowWebhookConfig] = useState(false);
  const [supportConsent, setSupportConsent] = useState(false);
  const [supportSending, setSupportSending] = useState(false);
  const [supportStatus, setSupportStatus] = useState<string | null>(null);

  const runChecks = useCallback(async () => {
    setIsChecking(true);
    try {
      const res = await onRunDiagnostics();
      setDiagResult(res);
      mobileDiagnostics.record(
        'probe_result',
        `reachable=${Boolean(res.probe?.reachable)} kind=${res.probe?.errorKind ?? 'none'} wifi=${res.network.isWifi}`
      );
    } finally {
      setIsChecking(false);
    }
  }, [onRunDiagnostics]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void onRunDiagnostics().then((res) => {
      if (!cancelled) {
        setDiagResult(res);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeProfile?.baseUrl, activeProfile?.token, onRunDiagnostics]);

  if (!isOpen) return null;

  const handleToggleLockScreen = async () => {
    const next = !lockScreenControls;
    if (next && nativeAndroid) {
      try {
        const { granted } = await CadenceRemote.requestNotificationPermission();
        if (!granted) {
          setNotifDeniedHint(true);
        }
      } catch {
        // non-fatal
      }
    }
    onToggleLockScreenControls(next);
  };

  const handleProbeBackup = async () => {
    setIsProbingFallback(true);
    setFallbackMessage(null);
    try {
      const switched = await onProbeAlternateEndpoints();
      if (switched) {
        setFallbackMessage('Found and switched to a reachable address for your Cadence Desktop.');
      } else {
        setFallbackMessage('None of the cached mDNS or fallback IPs responded.');
      }
      await runChecks();
    } finally {
      setIsProbingFallback(false);
    }
  };

  const handleSavePin = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = pinDraft.trim();
    if (!cleaned) return;
    onUpdatePin(cleaned);
    setEditingPin(false);
  };

  const handleSaveMobileWebhook = () => {
    try {
      const saved = setMobileSupportWebhookUrl(supportWebhookUrl);
      setSupportWebhookUrl(saved);
      setShowWebhookConfig(false);
      setSupportStatus(
        saved ? 'Mobile support webhook URL saved.' : 'Cleared mobile support webhook URL.'
      );
    } catch (err) {
      setSupportStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const handleExportSupport = async (mode: 'submit' | 'download') => {
    if (!supportConsent) return;
    setSupportStatus(null);
    setSupportSending(true);
    try {
      const report = buildMobileSupportReport({
        scenario: supportScenario,
        userNotes: supportNotes,
        consentGranted: true,
        nativeAndroid,
        activeProfile,
        isConnected,
        isConnecting,
        diagResult,
        connectionDiagnostic,
      });

      if (mode === 'submit') {
        const res = await submitMobileSupportReport({
          report,
          scenario: supportScenario,
          userNotes: supportNotes,
          contactEmail: supportContactEmail,
          webhookUrl: supportWebhookUrl,
        });
        setSupportStatus(`Submitted (${res.ticketId}): ${res.message}`);
        return;
      }

      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(report.jsonPayload);
        } catch {
          // clipboard optional
        }
      }

      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
          const file = new File([report.jsonPayload], report.fileName, {
            type: 'application/json',
          });
          await navigator.share({
            title: report.emailSubject,
            text: report.emailBody,
            files: [file],
          });
          setSupportStatus(`Shared ${report.fileName}.`);
          return;
        } catch {
          // Fall back to direct blob download / clipboard
        }
      }

      if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const blob = new Blob([report.jsonPayload], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = report.fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
      setSupportStatus(
        `Saved ${report.fileName} and copied diagnostic JSON for ${report.emailTo}.`
      );
    } catch (err) {
      setSupportStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSupportSending(false);
    }
  };

  const network = diagResult?.network;
  const probe = diagResult?.probe;
  const activeDiag = diagResult?.diagnostic ?? connectionDiagnostic;
  const observedFp = activeDiag?.observedFingerprint || probe?.certFingerprint;

  const hasAlternates =
    Boolean(activeProfile?.mDnsHost) || Boolean(activeProfile?.fallbackIps?.length);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex flex-col justify-end sm:justify-center sm:items-center">
      <div className="w-full max-w-md bg-[#121418] border-t sm:border border-zinc-800 rounded-t-3xl sm:rounded-3xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl pb-safe">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            {isConnected ? (
              <Wifi className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <WifiOff className="w-5 h-5 text-rose-400 shrink-0" />
            )}
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-zinc-100 truncate">
                Connection &amp; Engine Status
              </h2>
              <p className="text-[11px] text-zinc-400 truncate">
                {isConnected
                  ? `Connected${probe?.latencyMs ? ` • ${probe.latencyMs} ms` : ''}`
                  : isConnecting
                  ? 'Connecting...'
                  : 'Disconnected'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close connection diagnostics"
            className="min-w-[48px] min-h-[48px] -mr-2 rounded-full flex items-center justify-center text-zinc-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {!isConnected && activeProfile?.engineKind === 'core' && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-2xl bg-rose-500/10 border border-rose-500/35 p-3.5 flex flex-col gap-2.5"
            >
              <p className="text-xs font-semibold text-rose-100">
                Connection lost. Playback may still be continuing.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onRetryConnection}
                  className="flex-1 min-h-[40px] rounded-xl bg-rose-500/25 border border-rose-400/40 text-rose-100 text-xs font-semibold"
                >
                  Reconnect
                </button>
                <button
                  type="button"
                  onClick={onSwitchDesktop}
                  className="flex-1 min-h-[40px] rounded-xl bg-zinc-800 text-zinc-100 text-xs font-semibold"
                >
                  Choose engine
                </button>
              </div>
            </div>
          )}

          {/* Active Error / Diagnostic Guidance */}
          {activeDiag && (
            <div className="rounded-2xl bg-rose-500/10 border border-rose-500/35 p-3.5 flex flex-col gap-2">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-xs font-bold text-rose-200">{activeDiag.title}</p>
                  <p className="text-[11px] text-rose-200/80 mt-0.5 leading-relaxed">
                    {activeDiag.detail}
                  </p>
                  {activeDiag.hint && (
                    <p className="text-[11px] text-amber-200/90 mt-1.5 leading-relaxed">
                      {activeDiag.hint}
                    </p>
                  )}
                </div>
              </div>

              {(activeDiag.kind === 'cert_mismatch' || activeDiag.kind === 'cert_untrusted') &&
                observedFp && (
                  <div className="mt-1 rounded-xl bg-zinc-950/90 border border-zinc-800 p-2.5 flex flex-col gap-2">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                      Observed Desktop SPKI SHA-256
                    </p>
                    <p className="text-[11px] font-mono text-amber-200 break-all">
                      {formatFingerprintBlocks(observedFp)}
                    </p>
                    <button
                      type="button"
                      onClick={() => onTrustFingerprint(observedFp)}
                      className="min-h-[44px] rounded-xl bg-[#D4AF37] text-zinc-950 font-bold text-xs"
                    >
                      Trust & Pin This Certificate
                    </button>
                  </div>
                )}

              {activeDiag.kind === 'unauthorized' && (
                <button
                  type="button"
                  onClick={() => {
                    setPinDraft(activeProfile?.token || '');
                    setEditingPin(true);
                  }}
                  className="min-h-[44px] rounded-xl bg-rose-500/20 border border-rose-400/40 text-rose-100 text-xs font-semibold"
                >
                  Update Pairing PIN
                </button>
              )}
            </div>
          )}

          {/* Configured Desktop Card */}
          <div className="rounded-2xl bg-zinc-900/70 border border-zinc-800 p-3.5 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Server className="w-4 h-4 text-[#D4AF37] shrink-0" />
                <div className="min-w-0">
                  <span className="block text-xs font-semibold text-zinc-100 truncate">
                    {`Playback engine: ${activeProfile?.label || 'None Selected'}`}
                  </span>
                  <span className="block text-[11px] text-zinc-400 truncate">
                    {`Audio output: ${activeProfile?.outputLabel || 'Unassigned'}`}
                  </span>
                </div>
              </div>
              {activeProfile?.certFingerprint ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-mono text-emerald-300">
                  <ShieldCheck className="w-3 h-3" />
                  <span>Pinned TLS</span>
                </span>
              ) : activeProfile?.baseUrl.startsWith('http://') ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-[10px] font-mono text-amber-300">
                  <ShieldAlert className="w-3 h-3" />
                  <span>Local HTTP</span>
                </span>
              ) : null}
            </div>
            {activeProfile && (
              <>
                <p className="text-[11px] font-mono text-zinc-400 break-all">
                  {activeProfile.baseUrl}
                </p>
                {activeProfile.mDnsHost && (
                  <p className="text-[11px] font-mono text-zinc-500">
                    mDNS: {activeProfile.mDnsHost}
                  </p>
                )}
              </>
            )}

            {/* Quick Update PIN Form */}
            {editingPin && (
              <form onSubmit={handleSavePin} className="mt-1 flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={pinDraft}
                  onChange={(e) => setPinDraft(e.target.value)}
                  placeholder="4-digit PIN"
                  className="flex-1 min-h-[44px] rounded-xl bg-zinc-950 border border-zinc-700 px-3 text-xs font-mono text-zinc-100 focus:outline-none focus:border-[#D4AF37]"
                />
                <button
                  type="submit"
                  className="min-h-[44px] px-4 rounded-xl bg-[#D4AF37] text-zinc-950 font-bold text-xs"
                >
                  Save
                </button>
              </form>
            )}

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={onRetryConnection}
                className="min-h-[44px] rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isConnecting ? 'animate-spin' : ''}`} />
                <span>Reconnect</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setPinDraft(activeProfile?.token || '');
                  setEditingPin((v) => !v);
                }}
                className="min-h-[44px] rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>Edit PIN</span>
              </button>
            </div>
          </div>

          {/* Live Diagnostic Checks */}
          <div className="rounded-2xl bg-zinc-900/45 border border-zinc-800/90 p-3.5 flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-200">Network Health Checks</span>
              <button
                type="button"
                onClick={() => void runChecks()}
                disabled={isChecking}
                className="min-h-[36px] px-2.5 rounded-lg bg-zinc-800 text-[11px] font-medium text-zinc-300 flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
                <span>{isChecking ? 'Checking...' : 'Re-check'}</span>
              </button>
            </div>

            <div className="flex flex-col gap-2 text-xs">
              <div className="flex items-center justify-between py-1 border-b border-zinc-800/60">
                <span className="text-zinc-400">Phone Wi-Fi Link</span>
                <span
                  className={`font-mono ${
                    network?.isWifi ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {network
                    ? network.isWifi
                      ? network.localIpv4s[0] || 'Connected'
                      : network.isCellular
                      ? 'Cellular Only'
                      : 'Disconnected'
                    : '...'}
                </span>
              </div>

              {network?.isVpn && (
                <div className="flex items-center justify-between py-1 border-b border-zinc-800/60 text-amber-300">
                  <span>VPN Tunnel Detected</span>
                  <span className="font-mono text-[11px]">May block LAN</span>
                </div>
              )}

              <div className="flex items-center justify-between py-1 border-b border-zinc-800/60">
                <span className="text-zinc-400">Desktop Reachable</span>
                <span className="font-mono flex items-center gap-1">
                  {probe ? (
                    probe.reachable ? (
                      <span className="text-emerald-400 inline-flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {probe.latencyMs} ms
                      </span>
                    ) : (
                      <span className="text-rose-400">{probe.errorKind}</span>
                    )
                  ) : (
                    <span className="text-zinc-500">—</span>
                  )}
                </span>
              </div>

              <div className="flex items-center justify-between py-1">
                <span className="text-zinc-400">Pairing PIN Auth</span>
                <span
                  className={`font-mono ${
                    probe?.authenticated
                      ? 'text-emerald-400'
                      : probe?.reachable
                      ? 'text-rose-400'
                      : 'text-zinc-500'
                  }`}
                >
                  {probe
                    ? probe.authenticated
                      ? 'Verified'
                      : probe.errorKind === 'unauthorized'
                      ? 'Rejected'
                      : 'Unverified'
                    : '—'}
                </span>
              </div>
            </div>

            {hasAlternates && (
              <button
                type="button"
                onClick={() => void handleProbeBackup()}
                disabled={isProbingFallback}
                className="min-h-[44px] w-full rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isProbingFallback ? 'animate-spin' : ''}`} />
                <span>Probe mDNS & Backup Desktop IPs</span>
              </button>
            )}
            {fallbackMessage && (
              <p className="text-[11px] text-zinc-400 text-center">{fallbackMessage}</p>
            )}
          </div>

          {/* Android Lock-Screen & Battery Controls */}
          <div className="rounded-2xl bg-zinc-900/45 border border-zinc-800/90 p-3.5 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <Lock className="w-4 h-4 text-[#D4AF37] shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-semibold text-zinc-100">Lock-Screen Controls</p>
                  <p className="text-[11px] text-zinc-400 mt-0.5 leading-relaxed">
                    Keeps Android media controls synced while locked using event-only updates (zero heartbeat ticks).
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={lockScreenControls}
                onClick={() => void handleToggleLockScreen()}
                className={`min-w-[52px] min-h-[32px] rounded-full p-1 transition-colors shrink-0 ${
                  lockScreenControls ? 'bg-[#D4AF37]' : 'bg-zinc-700'
                }`}
              >
                <span
                  className={`block w-6 h-6 rounded-full bg-zinc-950 transition-transform ${
                    lockScreenControls ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {notifDeniedHint && (
              <p className="text-[11px] text-amber-300 flex items-center gap-1.5">
                <Bell className="w-3.5 h-3.5 shrink-0" />
                <span>Enable Notifications for Cadence Remote in Android Settings to see lock-screen media controls.</span>
              </p>
            )}

            {nativeAndroid && network && (
              <div className="pt-2 border-t border-zinc-800/70 flex items-center justify-between gap-2">
                <div className="flex items-start gap-2.5">
                  <Battery className="w-4 h-4 text-zinc-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-zinc-200">Android Battery Saver</p>
                    <p className="text-[11px] text-zinc-400">
                      {network.isBatteryOptimized
                        ? 'Restricted — OS may pause lock-screen controls'
                        : 'Unrestricted'}
                    </p>
                  </div>
                </div>
                {network.isBatteryOptimized && (
                  <button
                    type="button"
                    onClick={() => void CadenceRemote.openBatterySettings()}
                    className="min-h-[40px] px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-[11px] font-semibold text-zinc-200 shrink-0"
                  >
                    Allow
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Consent-First Mobile Support Export (Works Offline) */}
          <div className="rounded-2xl bg-zinc-900/45 border border-zinc-800/90 p-3.5 flex flex-col gap-2.5">
            <div>
              <p className="text-xs font-semibold text-zinc-100">
                Report Issue to Cadence Support
              </p>
              <p className="text-[11px] text-zinc-400 mt-0.5 leading-relaxed">
                Export sanitized connection logs on consent even if your phone cannot reach the Playback Engine.
              </p>
            </div>

            <select
              aria-label="Mobile support issue"
              value={supportScenario}
              onChange={(e) => setSupportScenario(e.target.value as MobileSupportScenario)}
              className="w-full min-h-[40px] rounded-xl bg-zinc-950 border border-zinc-700 px-3 text-xs text-zinc-100 focus:outline-none focus:border-[#D4AF37]"
            >
              {MOBILE_SUPPORT_SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>

            <textarea
              aria-label="Mobile issue notes"
              rows={2}
              value={supportNotes}
              onChange={(e) => setSupportNotes(e.target.value)}
              placeholder="Optional notes (router, VPN, Android/iOS version)..."
              className="w-full rounded-xl bg-zinc-950 border border-zinc-700 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#D4AF37] resize-none"
            />

            <input
              aria-label="Mobile reply email"
              type="email"
              value={supportContactEmail}
              onChange={(e) => setSupportContactEmail(e.target.value)}
              placeholder="Your email (optional, for reply)"
              className="w-full min-h-[38px] rounded-xl bg-zinc-950 border border-zinc-700 px-3 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#D4AF37]"
            />

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setShowWebhookConfig((prev) => !prev)}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
              >
                <Link2 className="w-3 h-3" />
                <span>
                  {supportWebhookUrl ? 'Support webhook ready' : 'Configure Support Webhook URL'}
                </span>
              </button>
            </div>

            {(showWebhookConfig || !supportWebhookUrl) && (
              <div className="flex items-center gap-1.5">
                <input
                  aria-label="Mobile support webhook URL"
                  type="url"
                  value={supportWebhookUrl}
                  onChange={(e) => setSupportWebhookUrl(e.target.value)}
                  placeholder="https://script.google.com/macros/s/.../exec"
                  className="flex-1 min-h-[36px] rounded-xl bg-zinc-950 border border-zinc-700 px-2.5 text-[11px] font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#D4AF37]"
                />
                <button
                  type="button"
                  onClick={handleSaveMobileWebhook}
                  className="min-h-[36px] px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-[11px] font-semibold text-zinc-100 shrink-0"
                >
                  Save
                </button>
              </div>
            )}

            <label className="flex items-start gap-2.5 text-[11px] text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                aria-label="Consent to share mobile diagnostic report"
                checked={supportConsent}
                onChange={(e) => setSupportConsent(e.target.checked)}
                className="mt-0.5 rounded border-zinc-600 bg-zinc-950 accent-[#D4AF37]"
              />
              <span>
                I consent to sharing this redacted connection report with{' '}
                <span className="font-mono text-zinc-100">{MOBILE_SUPPORT_EMAIL}</span>.
              </span>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!supportConsent || supportSending || !supportWebhookUrl.trim()}
                onClick={() => void handleExportSupport('submit')}
                className="min-h-[44px] rounded-xl bg-[#D4AF37] text-zinc-950 text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Send to Support</span>
              </button>
              <button
                type="button"
                disabled={!supportConsent || supportSending}
                onClick={() => void handleExportSupport('download')}
                className="min-h-[44px] rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40"
              >
                {typeof navigator !== 'undefined' && typeof navigator.share === 'function' ? (
                  <ClipboardCopy className="w-3.5 h-3.5" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span>Export Report</span>
              </button>
            </div>

            {supportStatus && (
              <p role="status" className="text-[11px] text-emerald-300 leading-relaxed">
                {supportStatus}
              </p>
            )}
          </div>

          {/* Switch / Disconnect Actions */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSwitchDesktop}
              className="flex-1 min-h-[48px] rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-xs font-semibold"
            >
              Choose engine
            </button>
            <button
              type="button"
              onClick={onDisconnectDesktop}
              className="min-h-[48px] px-4 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-semibold"
            >
              Unpair
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
