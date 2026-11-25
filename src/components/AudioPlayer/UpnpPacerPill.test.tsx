import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { UpnpPacerPill } from './UpnpPacerPill'
import type { EngineEventRecord } from '../../core/coreProtocol'
import type { DeliverySnapshot } from '../../core/upnpDelivery'
import type { EngineClient } from '../../services/engineClient'

function makeSnapshot(overrides: Partial<DeliverySnapshot> = {}): DeliverySnapshot {
  return {
    sampledAtMs: 10_000,
    pacerEnabled: true,
    streamId: 1,
    realtimeBytesPerSec: 176_400,
    bytesSent: 1_764_000,
    tcpSamples: 12,
    rttUs: 2400,
    retransmits: 0,
    capture: null,
    ...overrides,
  } as DeliverySnapshot
}

function makeMockClient(initial: DeliverySnapshot) {
  const getUpnpDelivery = vi.fn().mockResolvedValue(initial)
  const setUpnpPacer = vi.fn().mockResolvedValue(undefined)
  return {
    client: {
      getUpnpDelivery,
      setUpnpPacer,
    } as unknown as EngineClient,
    getUpnpDelivery,
    setUpnpPacer,
  }
}

describe('UpnpPacerPill', () => {
  it('opens the Delivery Inspector dialog, toggles the UPnP Pacer switch, and closes on Escape', async () => {
    const user = userEvent.setup()
    const enabledSnap = makeSnapshot({ pacerEnabled: true })
    const disabledSnap = makeSnapshot({ pacerEnabled: false, sampledAtMs: 15_000 })
    const { client, getUpnpDelivery, setUpnpPacer } = makeMockClient(enabledSnap)

    let listener: ((event: EngineEventRecord) => void) | null = null
    const subscribe = vi.fn((fn: (event: EngineEventRecord) => void) => {
      listener = fn
      return () => {
        listener = null
      }
    })

    render(<UpnpPacerPill client={client} subscribe={subscribe} connected playing={false} />)

    await waitFor(() => expect(getUpnpDelivery).toHaveBeenCalledTimes(1))

    // Open inspector popover
    const trigger = screen.getByRole('button', { name: /Inspect sender delivery/i })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: 'UPnP Delivery Inspector' })).toBeInTheDocument()
    expect(screen.getByText('2.4 ms RTT')).toBeInTheDocument()

    // Toggle UPnP Pacer off
    getUpnpDelivery.mockResolvedValueOnce(disabledSnap)
    const pacerSwitch = screen.getByRole('switch', { name: 'UPnP Pacer' })
    expect(pacerSwitch).toHaveAttribute('aria-checked', 'true')
    await user.click(pacerSwitch)

    await waitFor(() => expect(setUpnpPacer).toHaveBeenCalledWith(false))
    await waitFor(() => expect(pacerSwitch).toHaveAttribute('aria-checked', 'false'))

    // Simulate stream disconnect event -> alert shown
    act(() => {
      listener?.({ event: 'stream.disconnected', seq: 1, timestampMs: 16_000, data: {} } as EngineEventRecord)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/delivery event stream disconnected/i)

    // Press Escape to close
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'UPnP Delivery Inspector' })).not.toBeInTheDocument()
  })
})
