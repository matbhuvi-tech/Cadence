import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DebugDiagnosticsPanel } from './DebugDiagnosticsPanel'
import { tauriBridge } from '../../services/tauriBridge'

describe('DebugDiagnosticsPanel support bundle & self-diagnosis', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(tauriBridge, 'getDebugLogState').mockResolvedValue({
      mode: 'off',
      ringCapacity: 2048,
      bufferedApprox: 0,
      droppedCount: 0,
      persistedCount: 0,
      hygieneState: 'idle',
      cooldownRemainingSecs: null,
      logFilePath: null,
      logDirPath: null,
      lastFlushError: null,
      crashLogCount: 1,
      latestCrashLog: 'crash-123.log',
    })
    vi.spyOn(tauriBridge, 'subscribeDebugLogState').mockReturnValue(() => {})
    vi.spyOn(tauriBridge, 'getSupportScenarios').mockResolvedValue([
      {
        id: 'lost_library_after_upgrade',
        label: 'Lost library after upgrading playback engine',
        description: 'Tracks disappeared',
      },
      {
        id: 'enrichment_stuck',
        label: 'Enrichment is not working or got stuck',
        description: 'Metadata stalled',
      },
    ])
    vi.spyOn(tauriBridge, 'getSupportWebhookConfig').mockResolvedValue({
      webhookUrl: 'https://script.google.com/macros/s/test-webhook/exec',
      source: 'saved',
    })
  })

  it('requires explicit user consent before submitting or generating a support bundle and displays self-diagnosis hints', async () => {
    const user = userEvent.setup()
    const previewSpy = vi.spyOn(tauriBridge, 'previewSupportDiagnostics').mockResolvedValue({
      scenarioId: 'lost_library_after_upgrade',
      scenarioLabel: 'Lost library after upgrading playback engine',
      generatedAtUtc: '2026-11-27T00:00:00Z',
      supportEmail: 'matbhuvitech@gmail.com',
      desktopVersion: '0.1.0',
      osInfo: 'windows (x86_64)',
      windowsServiceRunning: true,
      activeEngineUrl: null,
      activeEngineReachable: false,
      activeEngineProbeError: null,
      desktopDebugState: {
        mode: 'off',
        ringCapacity: 2048,
        bufferedApprox: 0,
        droppedCount: 0,
        persistedCount: 0,
        hygieneState: 'idle',
        crashLogCount: 1,
      },
      hints: [
        {
          severity: 'warn',
          code: 'SPLIT_OR_UNMIGRATED_LIBRARY_DETECTED',
          title: 'Found a library with 1200 tracks in Windows Engine (User Tray)',
          detail: 'Active service DB has 0 tracks.',
          recommendedAction: 'Migrate or switch mode.',
        },
      ],
      databaseLineage: [
        {
          label: 'Windows Engine (User Tray)',
          path: 'C:\\Users\\<USER>\\AppData\\Local\\CadenceEngine',
          exists: true,
          dbExists: true,
          tracksCount: 1200,
          hasLocalhostPairing: true,
          crashLogCount: 0,
          migrationHistory: null,
        },
      ],
      doctorReports: [],
      plannedBundleFiles: ['manifest.json', 'self-diagnosis.json', 'database-lineage.json'],
      emailSubject: '[Cadence Support] Lost library after upgrading playback engine',
      emailBody: 'Summary',
      mailtoUrl: 'mailto:matbhuvitech@gmail.com?subject=Test',
    })

    const generateSpy = vi.spyOn(tauriBridge, 'generateSupportBundle').mockResolvedValue({
      zipPath: 'C:\\Logs\\support-bundles\\cadence-support-test.zip',
      fileName: 'cadence-support-test.zip',
      sizeBytes: 4096,
      filesIncluded: ['manifest.json', 'self-diagnosis.json'],
      emailTo: 'matbhuvitech@gmail.com',
      emailSubject: '[Cadence Support] Test',
      emailBody: 'Body',
      mailtoUrl: 'mailto:matbhuvitech@gmail.com?subject=Test',
      preview: {
        scenarioId: 'lost_library_after_upgrade',
        scenarioLabel: 'Lost library after upgrading playback engine',
        generatedAtUtc: '2026-11-27T00:00:00Z',
        supportEmail: 'matbhuvitech@gmail.com',
        desktopVersion: '0.1.0',
        osInfo: 'windows (x86_64)',
        windowsServiceRunning: true,
        activeEngineReachable: false,
        desktopDebugState: {
          mode: 'off',
          ringCapacity: 2048,
          bufferedApprox: 0,
          droppedCount: 0,
          persistedCount: 0,
          hygieneState: 'idle',
        },
        hints: [],
        databaseLineage: [],
        doctorReports: [],
        plannedBundleFiles: [],
        emailSubject: '[Cadence Support] Test',
        emailBody: 'Body',
        mailtoUrl: 'mailto:matbhuvitech@gmail.com?subject=Test',
      },
    })
    const revealSpy = vi.spyOn(tauriBridge, 'revealSupportBundleInFolder').mockResolvedValue()
    const submitSpy = vi.spyOn(tauriBridge, 'submitSupportBundle').mockResolvedValue({
      submitted: true,
      ticketId: 'CAD-20261127-ABCD',
      message: 'Diagnostics delivered to matbhuvitech@gmail.com',
      driveFileUrl: 'https://drive.google.com/file/d/xyz/view',
      bundle: {
        zipPath: 'C:\\Logs\\support-bundles\\cadence-support-test.zip',
        fileName: 'cadence-support-test.zip',
        sizeBytes: 4096,
        filesIncluded: ['manifest.json', 'self-diagnosis.json'],
        emailTo: 'matbhuvitech@gmail.com',
        emailSubject: '[Cadence Support] Test',
        emailBody: 'Body',
        mailtoUrl: 'mailto:matbhuvitech@gmail.com?subject=Test',
        preview: {
          scenarioId: 'lost_library_after_upgrade',
          scenarioLabel: 'Lost library after upgrading playback engine',
          generatedAtUtc: '2026-11-27T00:00:00Z',
          supportEmail: 'matbhuvitech@gmail.com',
          desktopVersion: '0.1.0',
          osInfo: 'windows (x86_64)',
          windowsServiceRunning: true,
          activeEngineReachable: false,
          desktopDebugState: {
            mode: 'off',
            ringCapacity: 2048,
            bufferedApprox: 0,
            droppedCount: 0,
            persistedCount: 0,
            hygieneState: 'idle',
          },
          hints: [],
          databaseLineage: [],
          doctorReports: [],
          plannedBundleFiles: [],
          emailSubject: '[Cadence Support] Test',
          emailBody: 'Body',
          mailtoUrl: 'mailto:matbhuvitech@gmail.com?subject=Test',
        },
      },
    })

    render(<DebugDiagnosticsPanel isActive />)

    const sendBtn = screen.getByRole('button', { name: /Send to Cadence Support/i })
    const saveBtn = screen.getByRole('button', { name: /Save \.zip & Copy Summary/i })
    expect(sendBtn).toBeDisabled()
    expect(saveBtn).toBeDisabled()

    await user.selectOptions(screen.getByLabelText(/Issue scenario/i), 'lost_library_after_upgrade')
    await user.type(screen.getByLabelText(/Reply email/i), 'listener@example.com')
    await user.click(screen.getByRole('button', { name: /Run Self-Diagnosis & Preview/i }))

    await waitFor(() => {
      expect(previewSpy).toHaveBeenCalledWith(
        expect.objectContaining({ scenarioId: 'lost_library_after_upgrade' }),
      )
    })
    expect(screen.getByText(/Found a library with 1200 tracks/i)).toBeVisible()
    expect(screen.getAllByText(/1200 tracks/i).length).toBeGreaterThanOrEqual(2)

    // Grant consent and verify 1-click webhook submit + local .zip fallback
    await user.click(
      screen.getByRole('checkbox', {
        name: /Consent to share diagnostic package with Cadence Support/i,
      }),
    )
    await waitFor(() => {
      expect(sendBtn).toBeEnabled()
    })
    expect(saveBtn).toBeEnabled()

    await user.click(sendBtn)
    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          scenarioId: 'lost_library_after_upgrade',
          contactEmail: 'listener@example.com',
          consentGranted: true,
          redactPaths: true,
        }),
      )
    })
    expect(screen.getByText(/Submitted — Ticket #CAD-20261127-ABCD/i)).toBeVisible()

    await user.click(saveBtn)
    await waitFor(() => {
      expect(generateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          scenarioId: 'lost_library_after_upgrade',
          consentGranted: true,
          redactPaths: true,
        }),
      )
    })
    expect(revealSpy).toHaveBeenCalledWith('C:\\Logs\\support-bundles\\cadence-support-test.zip')
    expect(screen.getAllByText(/cadence-support-test\.zip/i).length).toBeGreaterThanOrEqual(2)
  })
})
