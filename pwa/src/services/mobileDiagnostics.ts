import type { ConnectionDiagnostic, ProbeResult, ServerProfile } from '../types/remote';
import type { DiagnosticsRunResult } from '../hooks/useRemoteSocket';

export const MOBILE_SUPPORT_EMAIL = 'matbhuvitech@gmail.com';
export const DEFAULT_MOBILE_SUPPORT_WEBHOOK_URL =
  'https://script.google.com/macros/s/AKfycbzdnWVHCUtReC9EPOYDVIvUBbZy-9IoItxPwu5JlEY0-DVz9pTYMQQ5SA3RXss9d2L_wg/exec';
const STORAGE_KEY = 'cadence_mobile_diag_log_v1';
const WEBHOOK_STORAGE_KEY = 'cadence_mobile_support_webhook_url_v1';
const MAX_MOBILE_EVENTS = 250;

export function getMobileSupportWebhookUrl(): string {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const saved = window.localStorage.getItem(WEBHOOK_STORAGE_KEY)?.trim();
      if (saved) return saved;
    }
  } catch {
    // ignore storage errors
  }
  const envUrl =
    typeof import.meta !== 'undefined'
      ? (import.meta as unknown as { env?: Record<string, string | undefined> }).env
          ?.VITE_CADENCE_SUPPORT_WEBHOOK_URL?.trim()
      : undefined;
  return envUrl || DEFAULT_MOBILE_SUPPORT_WEBHOOK_URL;
}

export function setMobileSupportWebhookUrl(url: string): string {
  const trimmed = url.trim();
  if (
    trimmed &&
    !trimmed.startsWith('https://') &&
    !trimmed.startsWith('http://127.0.0.1') &&
    !trimmed.startsWith('http://localhost')
  ) {
    throw new Error('Support webhook URL must start with https://');
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      if (trimmed) {
        window.localStorage.setItem(WEBHOOK_STORAGE_KEY, trimmed);
      } else {
        window.localStorage.removeItem(WEBHOOK_STORAGE_KEY);
      }
    }
  } catch {
    // ignore storage errors
  }
  return trimmed;
}

export interface MobileSupportSubmissionResult {
  submitted: boolean;
  ticketId: string;
  message: string;
  driveFileUrl?: string;
}

export async function submitMobileSupportReport(options: {
  report: MobileSupportReport;
  scenario: MobileSupportScenario;
  customProblem?: string;
  userNotes?: string;
  contactEmail?: string;
  webhookUrl: string;
}): Promise<MobileSupportSubmissionResult> {
  const url = options.webhookUrl.trim();
  if (!url) {
    throw new Error('Support webhook URL is not configured yet.');
  }
  const customLabel = options.customProblem?.trim();
  const scenarioLabel =
    customLabel ||
    MOBILE_SUPPORT_SCENARIOS.find((s) => s.id === options.scenario)?.label ||
    options.scenario;
  const fallbackTicket = `CAD-MOB-${Date.now().toString(36).toUpperCase()}`;

  const body = JSON.stringify({
    ticketId: fallbackTicket,
    source: 'cadence-mobile',
    platform: 'mobile-pwa',
    scenarioId: options.scenario,
    scenarioLabel,
    contactEmail: options.contactEmail?.trim() || undefined,
    userNotes: options.userNotes?.trim() || '',
    fileName: options.report.fileName,
    jsonPayload: options.report.jsonPayload,
  });

  // Use text/plain so Google Apps Script Web Apps do not fail browser CORS preflight checks.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Support webhook returned HTTP ${res.status}: ${text.slice(0, 180)}`);
  }

  try {
    const parsed = JSON.parse(text) as {
      ok?: boolean;
      error?: string;
      ticketId?: string;
      message?: string;
      driveFileUrl?: string;
    };
    if (parsed.ok === false) {
      throw new Error(parsed.error || 'Webhook rejected the support report.');
    }
    return {
      submitted: true,
      ticketId: parsed.ticketId || fallbackTicket,
      message: parsed.message || `Diagnostics delivered to ${MOBILE_SUPPORT_EMAIL}.`,
      driveFileUrl: parsed.driveFileUrl,
    };
  } catch (err) {
    if (err instanceof SyntaxError) {
      return {
        submitted: true,
        ticketId: fallbackTicket,
        message: `Diagnostics submitted (${fallbackTicket}).`,
      };
    }
    throw err;
  }
}

export type MobileDiagEventKind =
  | 'connect_attempt'
  | 'connect_success'
  | 'connect_failed'
  | 'ws_error'
  | 'ws_closed'
  | 'probe_result'
  | 'fallback_probe';

export interface MobileDiagEvent {
  timestamp: string;
  kind: MobileDiagEventKind;
  detail: string;
}

export type MobileSupportScenario =
  | 'mobile_not_connecting'
  | 'cert_mismatch'
  | 'pin_rejected'
  | 'upnp_or_playback'
  | 'other';

export const MOBILE_SUPPORT_SCENARIOS: Array<{ id: MobileSupportScenario; label: string }> = [
  { id: 'mobile_not_connecting', label: 'Cannot connect to Playback Engine' },
  { id: 'cert_mismatch', label: 'Security certificate warning or untrusted engine' },
  { id: 'pin_rejected', label: 'Pairing PIN rejected or keeps asking' },
  { id: 'upnp_or_playback', label: 'Playback, queue, or speaker control issue' },
  { id: 'other', label: 'Describe my own issue...' },
];

function redactMobileDetail(raw: string): string {
  return raw
    .replace(/token=[^&\s]+/gi, 'token=[REDACTED]')
    .replace(/"token"\s*:\s*"[^"]*"/gi, '"token":"[REDACTED]"')
    .replace(/"pairingToken"\s*:\s*"[^"]*"/gi, '"pairingToken":"[REDACTED]"')
    .replace(/x-cadence-token:\s*\S+/gi, 'x-cadence-token:[REDACTED]');
}

class MobileDiagnosticsStore {
  private events: MobileDiagEvent[] = [];

  constructor() {
    this.events = this.loadFromStorage();
  }

  private loadFromStorage(): MobileDiagEvent[] {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return [];
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(-MAX_MOBILE_EVENTS) : [];
    } catch {
      return [];
    }
  }

  private persist() {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.events));
    } catch {
      // ignore storage quota errors
    }
  }

  public record(kind: MobileDiagEventKind, detail: string) {
    const entry: MobileDiagEvent = {
      timestamp: new Date().toISOString(),
      kind,
      detail: redactMobileDetail(detail).slice(0, 320),
    };
    this.events.push(entry);
    if (this.events.length > MAX_MOBILE_EVENTS) {
      this.events.splice(0, this.events.length - MAX_MOBILE_EVENTS);
    }
    this.persist();
  }

  public getEvents(): MobileDiagEvent[] {
    return [...this.events];
  }

  public clear() {
    this.events = [];
    this.persist();
  }
}

export const mobileDiagnostics = new MobileDiagnosticsStore();

export interface MobileSupportReport {
  fileName: string;
  jsonPayload: string;
  emailTo: string;
  emailSubject: string;
  emailBody: string;
  mailtoUrl: string;
}

export function buildMobileSupportReport(options: {
  scenario: MobileSupportScenario;
  customProblem?: string;
  userNotes?: string;
  consentGranted: boolean;
  nativeAndroid: boolean;
  activeProfile: ServerProfile | null;
  isConnected: boolean;
  isConnecting: boolean;
  diagResult: DiagnosticsRunResult | null;
  connectionDiagnostic: ConnectionDiagnostic | null;
}): MobileSupportReport {
  if (!options.consentGranted) {
    throw new Error('Explicit user consent is required before exporting mobile diagnostics.');
  }

  const customLabel = options.customProblem?.trim();
  const scenarioLabel =
    customLabel ||
    MOBILE_SUPPORT_SCENARIOS.find((s) => s.id === options.scenario)?.label ||
    options.scenario;

  const sanitizedProfile = options.activeProfile
    ? {
        label: options.activeProfile.label,
        baseUrl: options.activeProfile.baseUrl,
        port: options.activeProfile.port,
        mDnsHost: options.activeProfile.mDnsHost ?? null,
        fallbackIps: options.activeProfile.fallbackIps ?? [],
        engineKind: options.activeProfile.engineKind ?? 'core',
        engineId: options.activeProfile.engineId ?? null,
        libraryId: options.activeProfile.libraryId ?? null,
        hasCertFingerprint: Boolean(options.activeProfile.certFingerprint),
        hasPairingToken: Boolean(options.activeProfile.token),
        trustInsecure: Boolean(options.activeProfile.trustInsecure),
      }
    : null;

  const probe: ProbeResult | null = options.diagResult?.probe ?? null;
  const network = options.diagResult?.network ?? null;
  const activeDiag = options.diagResult?.diagnostic ?? options.connectionDiagnostic;

  const reportObj = {
    generatedAtUtc: new Date().toISOString(),
    platform: options.nativeAndroid ? 'android-capacitor' : 'mobile-pwa',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    scenario: options.scenario,
    scenarioLabel,
    userNotes: options.userNotes?.trim() || '',
    connectionState: {
      isConnected: options.isConnected,
      isConnecting: options.isConnecting,
      activeProfile: sanitizedProfile,
      network,
      probe,
      activeDiagnostic: activeDiag,
    },
    recentEvents: mobileDiagnostics.getEvents(),
  };

  const jsonPayload = JSON.stringify(reportObj, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `cadence-mobile-support-${stamp}-${options.scenario}.json`;
  const emailSubject = `[Cadence Mobile Support] ${scenarioLabel}`;
  const emailBody = [
    `Issue: ${scenarioLabel}`,
    `Platform: ${reportObj.platform}`,
    `Connected: ${options.isConnected}`,
    `Engine URL: ${sanitizedProfile?.baseUrl ?? 'None'}`,
    `Network Wi-Fi: ${network ? (network.isWifi ? 'Yes' : 'No') : 'Unknown'} (VPN: ${network?.isVpn ? 'Yes' : 'No'})`,
    `Last Probe: ${probe ? (probe.reachable ? `reachable (${probe.latencyMs}ms)` : probe.errorKind) : 'N/A'}`,
    options.userNotes?.trim() ? `Notes: ${options.userNotes.trim()}` : null,
    '',
    'Recent Connection Events (last 10):',
    ...reportObj.recentEvents.slice(-10).map((ev) => `- ${ev.timestamp} [${ev.kind}] ${ev.detail}`),
    '',
    'Full JSON Report:',
    jsonPayload.slice(0, 2500),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const mailtoUrl = `mailto:${MOBILE_SUPPORT_EMAIL}?subject=${encodeURIComponent(
    emailSubject,
  )}&body=${encodeURIComponent(emailBody)}`;

  return {
    fileName,
    jsonPayload,
    emailTo: MOBILE_SUPPORT_EMAIL,
    emailSubject,
    emailBody,
    mailtoUrl,
  };
}
