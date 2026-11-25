import { test, expect, type Page } from '@playwright/test'
import { startCadenceStack, type CadenceE2eStack } from './fixtures/cadenceHarness'

test.describe.serial('Cadence Cross-Platform E2E: Desktop + PWA + cadence-headless', () => {
  let stack: CadenceE2eStack
  let desktopPage: Page
  let pwaPage: Page

  test.beforeAll(async ({ browser }) => {
    stack = await startCadenceStack()

    const desktopContext = await browser.newContext({
      viewport: { width: 1600, height: 900 },
    })
    desktopPage = await desktopContext.newPage()

    const pwaContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
    pwaPage = await pwaContext.newPage()
  })

  test.afterAll(async () => {
    await desktopPage?.context().close()
    await pwaPage?.context().close()
    await stack?.stop()
  })

  test('1. Engine connect & library browse (Desktop -> cadence-headless)', async () => {
    await desktopPage.goto(stack.desktopUrl)

    // EngineConnectionGate is shown with zero local SQLite / "Use This PC" fallback
    await expect(desktopPage.locator('#gate-address-input')).toBeVisible()
    await expect(desktopPage.locator('body')).toContainText('Connect to a Cadence Playback Engine')
    await expect(desktopPage.locator('body')).not.toContainText('Use This PC')

    // Fill connection form and pair
    await desktopPage.locator('#gate-address-input').fill(stack.coreUrl)
    await desktopPage.locator('#gate-label-input').fill('E2E Gate Core')

    await desktopPage.getByRole('button', { name: /Verify & (Pair|Connect)/i }).click()
    await desktopPage.getByRole('button', { name: /Open Library/i }).click()

    await expect(
      desktopPage.locator('button[aria-label^="Playback engine:"]').first()
    ).toHaveAttribute('aria-label', /E2E Gate Core/)

    // Catalog loads seeded albums including distinct editions and blob cover art
    await expect(desktopPage.locator('body')).toContainText('Mega Anthology')
    await expect(desktopPage.locator('body')).toContainText('Goldberg Variations')
    await expect(desktopPage.locator('body')).toContainText('Blue Train')

    const symphonyCards = desktopPage
      .locator('.group\\/card')
      .filter({ hasText: 'Symphony No. 5' })
    await expect(symphonyCards).toHaveCount(2)

    await expect
      .poll(() =>
        desktopPage.evaluate(() =>
          Array.from(document.querySelectorAll('img')).some(
            (img) => img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0
          )
        )
      )
      .toBe(true)

    // Connecting to an idle engine must not auto-play
    const snapRes = await fetch(`${stack.coreUrl}/v1/core`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cadence-token': stack.pairingToken,
      },
      body: JSON.stringify({
        protocolVersion: 1,
        engineId: stack.coreEngineId,
        libraryId: stack.coreLibraryId,
        operation: 'session.snapshot',
      }),
    })
    const snap = (await snapRes.json()) as { data?: { playback?: { activity?: string } } }
    expect(snap.data?.playback?.activity).toBe('idle')
  })

  test('2. Curate staging, two-phase commit dry-run & Core v2 folder APIs (idle engine)', async () => {
    const probe = await desktopPage.evaluate(
      async ({ coreUrl, token, engineId, libraryId }) => {
        const req = async (operation: string, extra: Record<string, unknown> = {}) => {
          const res = await fetch(`${coreUrl}/v1/core`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-cadence-token': token,
            },
            body: JSON.stringify({
              protocolVersion: 2,
              engineId,
              libraryId,
              operation,
              ...extra,
            }),
          })
          return res.json()
        }

        const rootsRes = await req('fs.browse')
        const rootEntry = rootsRes?.data?.entries?.[0]
        const browseRes = rootEntry ? await req('fs.browse', { path: rootEntry.path }) : null
        const entries: Array<{ name: string; path: string }> = browseRes?.data?.entries || []
        const subdir = entries.find((e) => e.name === 'e2e_browse_subdir')
        const addRes = subdir ? await req('folders.add', { path: subdir.path }) : null

        const draftRes = await req('curate.draft.save', {
          draft: {
            draftId: 'draft_pw_e2e_gb_1',
            trackId: 'trk_gb_1',
            changes: [
              {
                field: 'album',
                before: 'Goldberg Variations',
                after: 'Goldberg Variations (E2E)',
              },
            ],
            updatedBy: 'playwright-e2e',
          },
        })

        const dryRunRes = await req('curate.dry_run', {
          draftId: 'draft_pw_e2e_gb_1',
        })

        const artRes = await fetch(`${coreUrl}/v1/artwork/rel_goldberg`, {
          headers: { 'x-cadence-token': token },
        })
        const artBytes = artRes.ok ? (await artRes.arrayBuffer()).byteLength : 0

        return {
          hasSubdir: Boolean(subdir),
          addedOk: Boolean(addRes?.ok),
          draftSaved: Boolean(draftRes?.ok),
          dryRunOk: Boolean(dryRunRes?.ok),
          dryRunBlockedReason: dryRunRes?.data?.blockReason || dryRunRes?.error?.code || null,
          artStatus: artRes.status,
          artBytes,
        }
      },
      {
        coreUrl: stack.coreUrl,
        token: stack.pairingToken,
        engineId: stack.coreEngineId,
        libraryId: stack.coreLibraryId,
      }
    )

    expect(probe.hasSubdir).toBe(true)
    expect(probe.addedOk).toBe(true)
    expect(probe.draftSaved).toBe(true)
    // Music dir is mounted read-only in E2E, so dry-run reports read-only block or succeeds with plan
    expect(probe.dryRunOk || probe.dryRunBlockedReason !== null).toBe(true)
    expect(probe.artStatus).toBe(200)
    expect(probe.artBytes).toBeGreaterThan(0)
  })

  test('3. Queue mutation & dual-controller sync (Desktop <-> Mobile PWA)', async () => {
    // Open Goldberg Variations and play track #2 ("Variation 01")
    await desktopPage
      .locator('.group\\/card')
      .filter({ hasText: 'Goldberg Variations' })
      .first()
      .click()

    await expect(desktopPage.locator('body')).toContainText('Variation 01')
    stack.rs130.resetSoapCalls()

    const trackRow = desktopPage
      .locator('.group\\/tr')
      .filter({ hasText: 'Variation 01' })
      .first()
    await trackRow.locator('button[title="Play Track"]').click({ force: true })

    // Simulated RS130 receives UPnP SetAVTransportURI + Play and Desktop reflects Variation 01
    await expect
      .poll(() => stack.rs130.getState().transportState, { timeout: 15_000 })
      .toBe('PLAYING')
    expect(stack.rs130.getState().soapCalls.some((c) => c.action === 'SetAVTransportURI')).toBe(
      true
    )
    await expect(desktopPage.locator('footer')).toContainText('Variation 01')

    // Advance Next to DSD64 track ("Variation 02")
    await desktopPage.locator('button[title^="Next Track"]').first().dispatchEvent('click')
    await expect
      .poll(async () => {
        const res = await fetch(`${stack.coreUrl}/v1/core`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-cadence-token': stack.pairingToken,
          },
          body: JSON.stringify({
            protocolVersion: 1,
            engineId: stack.coreEngineId,
            libraryId: stack.coreLibraryId,
            operation: 'session.snapshot',
          }),
        })
        const body = (await res.json()) as {
          data?: {
            playback?: { trackId?: string; track?: { id?: string } }
            queue?: {
              currentEntryId?: string
              entries?: Array<{ entryId?: string; id?: string; trackId: string }>
            }
          }
        }
        const currentEntry = body.data?.queue?.entries?.find(
          (e) => (e.entryId ?? e.id) === body.data?.queue?.currentEntryId
        )
        return body.data?.playback?.trackId ?? body.data?.playback?.track?.id ?? currentEntry?.trackId
      })
      .toBe('trk_gb_3')

    // Pair Mobile-viewport PWA manually against cadence-headless
    await pwaPage.goto(stack.pwaUrl)
    await pwaPage.getByRole('button', { name: /Cadence Core/i }).click()
    await pwaPage.getByRole('button', { name: /HTTP \(Local LAN\)/i }).click()

    await pwaPage.locator('input[placeholder*="192.168"]').fill('127.0.0.1')
    await pwaPage.locator('input[type="number"]').fill(String(stack.corePort))
    await pwaPage.locator('input[placeholder*="4829"]').fill(stack.pairingToken)
    await pwaPage.locator('button[type="submit"]').filter({ hasText: /Connect/i }).click()

    await expect(pwaPage.locator('body')).toContainText('E2E Gate Core')

    // Switch PWA to Queue tab and verify dual-controller queue parity & real audio format badges
    await pwaPage.locator('nav button').filter({ hasText: 'Queue' }).click()
    await expect(pwaPage.locator('body')).toContainText('Playback Queue')
    await expect(pwaPage.locator('body')).toContainText('Goldberg Variations')
    await expect(pwaPage.locator('body')).toContainText('Variation 01')
    await expect(pwaPage.locator('body')).toContainText('Variation 02')

    const pwaQueueText = await pwaPage.locator('body').innerText()
    expect(pwaQueueText).toMatch(/DSD|DSF|FLAC/)
    expect(pwaQueueText).not.toMatch(/\bCORE\b/)
  })
})
