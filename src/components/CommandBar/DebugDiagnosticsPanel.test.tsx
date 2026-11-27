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
        label: 'Missing tracks, albums, or playlists after an update',
        description: 'Tracks disappeared',
      },
      {
        id: 'enrichment_stuck',
        label: 'Album metadata or cover art enrichment is stuck',
        description: 'Metadata stalled',
      },
    ])
    vi.spyOn(tauriBridge, 'getSupportWebhookConfig').mockResolvedValue({
      webhookUrl: 'https://script.google.com/macros/s/test-webhook/exec',
      source: 'saved',
    })
  })

  it('supports progressive 3-stage diagnosis, 5-state health checklist, lineage cards, and consent-gated submission', async () => {
    const user = userEvent.setup()
    const previewSpy = vi.spyOn(tauriBridge, 'previewSupportDiagnostics').mockResolvedValue({
      scenarioId: 'lost_library_after_upgrade',
      scenarioLabel: 'Missing tracks, albums, or playlists after an update',
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
          releasesCount: 95,
          playlistsCount: 12,
          hasLocalhostPairing: true,
          crashLogCount: 0,
          migrationHistory: null,
        },
      ],
      doctorReports: [
        {
          label: 'Windows Engine (Default Service)',
          dataDir: 'C:\\ProgramData\\CadenceEngine',
          healthy: true,
          checks: [
            { name: 'data_directory', status: 'OK', detail: 'exists' },
            { name: 'sqlite_integrity', status: 'OK', detail: 'PRAGMA integrity_check passed (ok)' },
            { name: 'sqlite_foreign_keys', status: 'OK', detail: '0 violations' },
            { name: 'identity_and_tls', status: 'OK', detail: 'validated' },
            { name: 'memory_lock_limits', status: 'OK', detail: 'ok' },
          ],
        },
      ],
      plannedBundleFiles: ['manifest.json', 'self-diagnosis.json', 'database-lineage.json'],
      emailSubject: '[Cadence Support] Missing tracks, albums, or playlists after an update',
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
        scenarioLabel: 'Missing tracks, albums, or playlists after an update',
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
          scenarioLabel: 'Missing tracks, albums, or playlists after an update',
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

    // Stage 3 is hidden initially until diagnosis or Skip
    expect(screen.queryByRole('button', { name: /Send to Cadence Support/i })).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText(/Issue scenario/i), 'lost_library_after_upgrade')
    await user.click(screen.getByRole('button', { name: /Diagnose Problem/i }))

    await waitFor(() => {
      expect(previewSpy).toHaveBeenCalledWith(
        expect.objectContaining({ scenarioId: 'lost_library_after_upgrade' }),
      )
    })

    // Stage 2 findings, 5-state System Health Checklist (including Not checked), and Lineage cards
    expect(screen.getByText(/Found a library with 1200 tracks/i)).toBeVisible()
    expect(screen.getByText(/System Health Checklist/i)).toBeVisible()
    expect(screen.getByText(/Live engine health/i)).toBeVisible()
    expect(screen.getByText(/^Not checked$/i)).toBeVisible()
    expect(screen.getByText('1200')).toBeVisible()
    expect(screen.getByText('95')).toBeVisible()
    expect(screen.getByText('12')).toBeVisible()

    // Stage 3 appears with consent gating
    const sendBtn = screen.getByRole('button', { name: /Send to Cadence Support/i })
    const saveBtn = screen.getByRole('button', { name: /Export Diagnostic Report/i })
    expect(sendBtn).toBeDisabled()
    expect(saveBtn).toBeDisabled()

    await user.type(screen.getByLabelText(/Reply email/i), 'listener@example.com')

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

  it('allows typing a custom problem not in the list and surfaces guided playback capture when relevant', async () => {
    const user = userEvent.setup()
    const previewSpy = vi.spyOn(tauriBridge, 'previewSupportDiagnostics').mockResolvedValue({
      scenarioId: 'upnp_dropouts',
      scenarioLabel: 'Music stutters on my dining room speaker',
      generatedAtUtc: '2026-11-27T00:00:00Z',
      supportEmail: 'matbhuvitech@gmail.com',
      desktopVersion: '0.1.0',
      osInfo: 'windows (x86_64)',
      windowsServiceRunning: false,
      activeEngineUrl: 'https://127.0.0.1:4040',
      activeEngineReachable: true,
      activeEngineProbeError: null,
      desktopDebugState: {
        mode: 'off',
        ringCapacity: 2048,
        bufferedApprox: 0,
        droppedCount: 0,
        persistedCount: 0,
        hygieneState: 'idle',
      },
      hints: [
        {
          severity: 'info',
          code: 'CAPTURE_RECOMMENDED_FOR_ISSUE',
          title: 'Live diagnostic capture recommended for this issue',
          detail: 'Local database checks passed.',
          recommendedAction: 'Start Diagnostic Capture and reproduce the stutter.',
        },
      ],
      databaseLineage: [],
      doctorReports: [],
      plannedBundleFiles: ['manifest.json'],
      emailSubject: '[Cadence Support] Music stutters on my dining room speaker',
      emailBody: 'Summary',
      mailtoUrl: 'mailto:matbhuvitech@gmail.com?subject=Test',
    })

    render(<DebugDiagnosticsPanel isActive />)

    const customInput = screen.getByLabelText(/Describe your issue/i)
    await user.type(customInput, 'Music stutters on my dining room speaker')

    expect(screen.getByText(/Guided capture \+ health checks/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /Start Diagnostic Capture/i })).toBeVisible()

    await user.click(screen.getByRole('button', { name: /Diagnose Problem/i }))

    await waitFor(() => {
      expect(previewSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          scenarioId: 'Music stutters on my dining room speaker',
        }),
      )
    })
    expect(screen.getByText(/Issue: Music stutters on my dining room speaker/i)).toBeVisible()
  })
})
