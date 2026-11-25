import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PairingView } from './PairingView'
import type { ProbeResult } from '../../types/remote'

const probeCadenceServerMock = vi.fn<(...args: unknown[]) => Promise<ProbeResult>>()

function makeProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    reachable: true,
    authenticated: true,
    httpStatus: 200,
    errorKind: 'ok',
    errorMessage: '',
    latencyMs: 5,
    ...overrides,
  }
}

vi.mock('../../platform/cadenceBridge', () => ({
  isNativeAndroid: () => false,
  discoverLanDesktops: vi.fn().mockResolvedValue([]),
  scanPairingQrCode: vi.fn().mockResolvedValue(null),
  cancelFallbackQrScan: vi.fn().mockResolvedValue(undefined),
  probeCadenceServer: (...args: unknown[]) => probeCadenceServerMock(...args),
}))

describe('PairingView', () => {
  beforeEach(() => {
    localStorage.clear()
    probeCadenceServerMock.mockReset()
  })

  it('validates missing host and PIN before probing', async () => {
    const user = userEvent.setup()
    render(<PairingView onPaired={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/Enter your Cadence Desktop IP address/i)

    await user.type(screen.getByPlaceholderText('192.168.1.42 or pc.local'), '192.168.1.42')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/Enter the 4-digit pairing PIN/i)
    expect(probeCadenceServerMock).not.toHaveBeenCalled()
  })

  it('auto-fills fields from a pasted QR pairing URL and pairs after successful probe', async () => {
    const user = userEvent.setup()
    const onPaired = vi.fn()
    probeCadenceServerMock.mockResolvedValueOnce(makeProbe({ certFingerprint: 'aabbccdd' }))

    render(<PairingView onPaired={onPaired} />)

    const hostInput = screen.getByPlaceholderText('192.168.1.42 or pc.local')
    await user.click(hostInput)
    await user.paste('https://192.168.1.50:4040/?token=4829')

    expect(hostInput).toHaveValue('192.168.1.50')
    expect(screen.getByPlaceholderText('e.g. 4829')).toHaveValue('4829')

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1))
    expect(onPaired).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://192.168.1.50:4040',
        token: '4829',
        certFingerprint: 'aabbccdd',
      }),
    )
  })

  it('shows TOFU certificate confirmation modal and re-probes with pinned fingerprint on Trust', async () => {
    const user = userEvent.setup()
    const onPaired = vi.fn()
    probeCadenceServerMock
      .mockResolvedValueOnce(
        makeProbe({
          reachable: false,
          authenticated: false,
          httpStatus: 0,
          errorKind: 'cert_untrusted',
          certFingerprint: '0123456789abcdef',
        }),
      )
      .mockResolvedValueOnce(makeProbe({ certFingerprint: '0123456789abcdef' }))

    render(<PairingView onPaired={onPaired} />)

    await user.type(screen.getByPlaceholderText('192.168.1.42 or pc.local'), '192.168.1.77')
    await user.type(screen.getByPlaceholderText('e.g. 4829'), '1234')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText('Confirm Desktop TLS Certificate')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Trust & Pin Server' }))

    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1))
    expect(probeCadenceServerMock).toHaveBeenCalledTimes(2)
    expect(probeCadenceServerMock.mock.calls[1]?.[2]).toBe('0123456789abcdef')
  })

  it('prompts Leave Core modal when switching away from active Core playback', async () => {
    const user = userEvent.setup()
    const onSwitchWithCoreDisposition = vi.fn()
    probeCadenceServerMock.mockResolvedValueOnce(makeProbe())

    render(
      <PairingView
        onPaired={vi.fn()}
        activeEngineKind="core"
        activeEngineLabel="TrueNAS Core"
        isActivePlaybackRunning
        onSwitchWithCoreDisposition={onSwitchWithCoreDisposition}
      />,
    )

    await user.type(screen.getByPlaceholderText('192.168.1.42 or pc.local'), '192.168.1.99')
    await user.type(screen.getByPlaceholderText('e.g. 4829'), '9999')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText('Switch away from TrueNAS Core?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep Core playing and switch' }))

    expect(onSwitchWithCoreDisposition).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://192.168.1.99:4040' }),
      'leave_core_playing',
    )
  })
})
