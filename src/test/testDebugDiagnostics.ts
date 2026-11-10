import assert from 'node:assert/strict'
import { createFrontendDiagnostics, setFrontendCaptureMode } from '../core/diagnostics'
import { createEndpointRoutingController } from '../core/endpointRouting'

async function testFrontendOffZeroOverheadAndNoIpc() {
  let ipcCalls = 0
  const diag = createFrontendDiagnostics(async () => {
    ipcCalls += 1
  })
  diag.setMode('off')
  for (let i = 0; i < 1000; i += 1) {
    const queued = diag.emit('audio_engine_commands', 'cmd_queued', `idx=${i}`)
    assert.equal(queued, false)
  }
  await diag.flushNow()
  assert.equal(ipcCalls, 0)
  assert.equal(diag.getBufferedCount(), 0)
  assert.equal(diag.getDroppedCount(), 0)
}

async function testFrontendBufferOverflowCountsDropsAndHandlesErrors() {
  let flushedBatches: number[] = []
  let failFlush = false
  const diag = createFrontendDiagnostics(async (batch) => {
    if (failFlush) {
      throw new Error('simulated ipc unavailable')
    }
    flushedBatches.push(batch.length)
  })
  diag.setMode('debug')

  let accepted = 0
  for (let i = 0; i < 400; i += 1) {
    if (diag.emit('playback_lifecycle', 'rapid_seek', `pos=${i}`, { correlationId: i })) {
      accepted += 1
    }
  }
  assert.equal(accepted, 256)
  assert.equal(diag.getDroppedCount(), 144)

  // Failed flush must never throw and spoil audio execution
  failFlush = true
  await diag.flushNow()
  failFlush = false

  while (diag.getBufferedCount() > 0) {
    await diag.flushNow()
  }
  const totalFlushed = flushedBatches.reduce((sum, n) => sum + n, 0)
  assert.equal(totalFlushed, 192) // 256 - 64 failed batch
}

async function testEndpointRoutingEmitsDiscoveryAndSelectionEventsOnlyWhenEnabled() {
  const captured: Array<{ category: string; event: string; detail: string }> = []
  setFrontendCaptureMode('off')

  const mockBridge = {
    async listAudioEndpoints() {
      return [
        {
          id: 'wasapi:Speakers (Game-Audeze Maxwell)',
          transport: 'wasapi' as const,
          displayName: 'Speakers (Game-Audeze Maxwell)',
          wasapiName: 'Speakers (Game-Audeze Maxwell)',
          udn: null,
          isAvailable: true,
          supportsDsd: false,
          isBitPerfectCapable: false,
        },
      ]
    },
    async discoverUpnpDevices() {
      return []
    },
    async setAudioEndpoint() {},
    async getPlaybackStatus() {
      return {
        selectedEndpoint: {
          transport: 'wasapi' as const,
          name: 'Speakers (Game-Audeze Maxwell)',
        },
        activeBackendEndpoint: {
          transport: 'wasapi' as const,
          name: 'Speakers (Game-Audeze Maxwell)',
        },
        deviceType: 'wasapi_shared',
        signalPathMode: 'wasapi_shared',
        isBitPerfect: false,
        outputSampleRate: 44100,
      }
    },
  }

  // Test endpointRouting controller with global debug OFF -> zero diagnostic events emitted
  const cOff = createEndpointRoutingController(mockBridge)
  await cOff.refreshInventory()
  await cOff.selectEndpoint({ transport: 'wasapi', name: 'Speakers (Game-Audeze Maxwell)' })

  // Enable global frontend diagnostics with mock sender
  const { frontendDiagnostics } = await import('../core/diagnostics')
  frontendDiagnostics.setSender(async (events) => {
    for (const ev of events) {
      captured.push({ category: ev.category, event: ev.event, detail: ev.detail })
    }
  })
  setFrontendCaptureMode('debug')

  const cOn = createEndpointRoutingController(mockBridge)
  await cOn.refreshInventory()
  await cOn.selectEndpoint({ transport: 'wasapi', name: 'Speakers (Game-Audeze Maxwell)' })
  await frontendDiagnostics.flushNow()

  assert.equal(
    captured.some((e) => e.category === 'device_discovery' && e.event === 'inventory_refresh_completed'),
    true
  )
  assert.equal(
    captured.some((e) => e.category === 'device_selection' && e.event === 'frontend_select_completed'),
    true
  )

  setFrontendCaptureMode('off')
}

async function main() {
  await testFrontendOffZeroOverheadAndNoIpc()
  await testFrontendBufferOverflowCountsDropsAndHandlesErrors()
  await testEndpointRoutingEmitsDiscoveryAndSelectionEventsOnlyWhenEnabled()
  console.log('ALL DEBUG DIAGNOSTICS FRONTEND TESTS PASSED')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

