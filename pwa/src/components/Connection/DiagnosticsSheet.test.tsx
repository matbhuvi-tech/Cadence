import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsSheet } from './DiagnosticsSheet';
import { setMobileSupportWebhookUrl } from '../../services/mobileDiagnostics';

vi.mock('../../platform/cadenceBridge', () => ({
  isNativeAndroid: () => false,
  CadenceRemote: {
    requestNotificationPermission: vi.fn().mockResolvedValue({ granted: true }),
    openBatterySettings: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('DiagnosticsSheet offline support export', () => {
  beforeEach(() => {
    setMobileSupportWebhookUrl('https://script.google.com/macros/s/mobile-test/exec');
  });

  it('enables 1-click webhook submit and offline report export only after explicit consent', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          ticketId: 'CAD-MOB-42',
          message: 'Saved to Drive & sent email.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    render(
      <DiagnosticsSheet
        isOpen
        onClose={vi.fn()}
        activeProfile={null}
        isConnected={false}
        isConnecting={false}
        connectionDiagnostic={null}
        lockScreenControls={false}
        onToggleLockScreenControls={vi.fn()}
        onRunDiagnostics={vi.fn().mockResolvedValue({
          network: {
            isWifi: true,
            isCellular: false,
            isVpn: false,
            localIpv4s: ['192.168.1.25'],
            isBatteryOptimized: false,
          },
          probe: null,
          diagnostic: null,
        })}
        onProbeAlternateEndpoints={vi.fn().mockResolvedValue(false)}
        onRetryConnection={vi.fn()}
        onUpdatePin={vi.fn()}
        onTrustFingerprint={vi.fn()}
        onSwitchDesktop={vi.fn()}
        onDisconnectDesktop={vi.fn()}
      />
    );

    const sendBtn = screen.getByRole('button', { name: /Send to Support/i });
    const exportBtn = screen.getByRole('button', { name: /Export Report/i });
    expect(sendBtn).toBeDisabled();
    expect(exportBtn).toBeDisabled();

    await user.click(
      screen.getByRole('checkbox', { name: /Consent to share mobile diagnostic report/i })
    );
    expect(sendBtn).toBeEnabled();
    expect(exportBtn).toBeEnabled();

    await user.click(sendBtn);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://script.google.com/macros/s/mobile-test/exec',
        expect.objectContaining({ method: 'POST' })
      );
    });
    expect(screen.getByRole('status')).toHaveTextContent(/CAD-MOB-42/i);

    await user.click(exportBtn);
    expect(screen.getByRole('status')).toHaveTextContent(/matbhuvitech@gmail\.com/i);

    fetchSpy.mockRestore();
  });

  it('allows typing a custom mobile problem description and includes it in the submitted report', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          ticketId: 'CAD-MOB-CUSTOM-1',
          message: 'Saved custom report.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    render(
      <DiagnosticsSheet
        isOpen
        onClose={vi.fn()}
        activeProfile={null}
        isConnected={false}
        isConnecting={false}
        connectionDiagnostic={null}
        lockScreenControls={false}
        onToggleLockScreenControls={vi.fn()}
        onRunDiagnostics={vi.fn().mockResolvedValue({
          network: {
            isWifi: true,
            isCellular: false,
            isVpn: false,
            localIpv4s: ['192.168.1.25'],
            isBatteryOptimized: false,
          },
          probe: null,
          diagnostic: null,
        })}
        onProbeAlternateEndpoints={vi.fn().mockResolvedValue(false)}
        onRetryConnection={vi.fn()}
        onUpdatePin={vi.fn()}
        onTrustFingerprint={vi.fn()}
        onSwitchDesktop={vi.fn()}
        onDisconnectDesktop={vi.fn()}
      />
    );

    await user.type(
      screen.getByLabelText(/Describe mobile issue/i),
      'Lock-screen play button disappears on Pixel 9'
    );
    await user.click(
      screen.getByRole('checkbox', { name: /Consent to share mobile diagnostic report/i })
    );
    await user.click(screen.getByRole('button', { name: /Send to Support/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    const bodyText = String(fetchSpy.mock.calls[0]?.[1]?.body ?? '');
    const parsed = JSON.parse(bodyText) as { scenarioLabel: string; jsonPayload: string };
    expect(parsed.scenarioLabel).toBe('Lock-screen play button disappears on Pixel 9');
    expect(parsed.jsonPayload).toContain('Lock-screen play button disappears on Pixel 9');

    fetchSpy.mockRestore();
  });
});
