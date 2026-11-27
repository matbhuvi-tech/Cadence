import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildMobileSupportReport,
  MOBILE_SUPPORT_EMAIL,
  mobileDiagnostics,
} from './mobileDiagnostics';

describe('mobileDiagnostics', () => {
  beforeEach(() => {
    mobileDiagnostics.clear();
  });

  it('caps the ring buffer at 250 events and redacts tokens/PINs', () => {
    for (let i = 0; i < 275; i++) {
      mobileDiagnostics.record(
        'connect_attempt',
        `idx=${i} token=secret-pin-${i} "pairingToken":"9999" x-cadence-token: abcdef`
      );
    }

    const events = mobileDiagnostics.getEvents();
    expect(events).toHaveLength(250);
    expect(events[0].detail).toContain('idx=25');
    expect(events[249].detail).toContain('idx=274');
    for (const ev of events) {
      expect(ev.detail).not.toContain('secret-pin');
      expect(ev.detail).not.toContain('9999');
      expect(ev.detail).not.toContain('abcdef');
      expect(ev.detail).toContain('[REDACTED]');
    }
  });

  it('requires explicit consent and builds a sanitized support report for matbhuvitech@gmail.com', () => {
    expect(() =>
      buildMobileSupportReport({
        scenario: 'mobile_not_connecting',
        consentGranted: false,
        nativeAndroid: true,
        activeProfile: null,
        isConnected: false,
        isConnecting: false,
        diagResult: null,
        connectionDiagnostic: null,
      })
    ).toThrow(/consent/i);

    mobileDiagnostics.record('connect_failed', 'core url=https://192.168.1.50:4040 code=unavailable');
    const report = buildMobileSupportReport({
      scenario: 'mobile_not_connecting',
      userNotes: 'Phone on 5GHz Wi-Fi',
      consentGranted: true,
      nativeAndroid: true,
      activeProfile: {
        id: 'https://192.168.1.50:4040',
        label: 'Living Room Core',
        baseUrl: 'https://192.168.1.50:4040',
        port: 4040,
        token: '4321',
        certFingerprint: 'abcd',
        engineKind: 'core',
      },
      isConnected: false,
      isConnecting: false,
      diagResult: null,
      connectionDiagnostic: null,
    });

    expect(report.emailTo).toBe(MOBILE_SUPPORT_EMAIL);
    expect(report.mailtoUrl).toContain('mailto:matbhuvitech@gmail.com?subject=');
    expect(report.jsonPayload).not.toContain('4321');
    expect(report.jsonPayload).toContain('Living Room Core');
    expect(report.jsonPayload).toContain('Phone on 5GHz Wi-Fi');
  });
});
