import type { DeliverySnapshot } from '../core/upnpDelivery'

export interface DeliveryCaptureOptions {
  captureAction?: 'start' | 'stop'
  captureId?: number
  includeCapture?: boolean
}

/** One bounded, opt-in capture. No timer exists before opening or after closing. */
export function createDeliveryCapture(
  request: (options: DeliveryCaptureOptions) => Promise<DeliverySnapshot>,
  publish: (snapshot: DeliverySnapshot) => void,
  reportError: (error: Error) => void,
  clock = { schedule: (callback: () => void, ms: number): (() => void) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  } },
): () => void {
  let stopped = false
  let captureId: number | undefined
  let cancelTimer: (() => void) | undefined
  const stopRemote = () => {
    if (captureId !== undefined) {
      void request({ captureAction: 'stop', captureId }).catch(() => {})
    }
  }
  const read = async (start: boolean) => {
    try {
      const snapshot = await request(start ? { captureAction: 'start', includeCapture: true }
        : { captureId, includeCapture: true })
      if (start) captureId = snapshot.capture?.id
      if (stopped) { if (start) stopRemote(); return }
      if (!snapshot.capture || snapshot.capture.id !== captureId) {
        throw new Error('The stream or capture changed. Start a new capture to continue.')
      }
      publish(snapshot)
      if (!snapshot.capture.complete) cancelTimer = clock.schedule(() => { void read(false) }, 5000)
    } catch (error) {
      if (!stopped) {
        stopped = true
        stopRemote()
        reportError(error instanceof Error ? error : new Error('Delivery capture unavailable.'))
      }
    }
  }
  void read(true)
  return () => {
    if (stopped) return
    stopped = true
    cancelTimer?.()
    stopRemote()
  }
}
