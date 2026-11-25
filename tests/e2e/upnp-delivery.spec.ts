import { test, expect } from '@playwright/test'
import { startViteServer, type ManagedProcess } from './fixtures/cadenceHarness'

type QaWindow = Window & {
  qa: {
    calls: Array<Record<string, unknown>>
    emit: (slow?: boolean) => void
    failToggle: (flag: boolean) => void
  }
}

test.describe('UPnP Delivery Inspector (UpnpPacerPill)', () => {
  let vite: ManagedProcess

  test.beforeAll(async () => {
    vite = await startViteServer({ cwd: process.cwd() })
  })

  test.afterAll(async () => {
    await vite?.stop()
  })

  test('lifecycle: heartbeat, on-demand capture, freeze, toggle error handling, responsive bounds & hidden pause', async ({
    page,
  }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${vite.url}/tests/e2e/fixtures/upnp-delivery.html`)

    const pillButton = page.locator('[aria-haspopup="dialog"]')
    await expect(pillButton).toBeVisible()

    // Initial delivery status fetch happened, but closed pill must not collect capture history
    await expect
      .poll(() => page.evaluate(() => (window as unknown as QaWindow).qa.calls.length))
      .toBe(1)

    await page.evaluate(() => (window as unknown as QaWindow).qa.emit())
    await expect(page.locator('body')).toContainText('Pacer · Pacing steady')

    const startedWhileClosed = await page.evaluate(() =>
      (window as unknown as QaWindow).qa.calls.some((c) => c.captureAction === 'start')
    )
    expect(startedWhileClosed).toBe(false)

    // Open inspector popover -> starts capture & renders SVG timing graph after batch interval
    await pillButton.click()
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as QaWindow).qa.calls.some((c) => c.captureAction === 'start')
        )
      )
      .toBe(true)

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const paths = Array.from(document.querySelectorAll('svg[role="img"] path'))
            return Math.max(0, ...paths.map((p) => (p.getAttribute('d') || '').length))
          }),
        { timeout: 12_000 }
      )
      .toBeGreaterThan(0)

    await expect(page.locator('body')).toContainText('4096 bytes · consistent')
    await expect(page.locator('body')).toContainText('1.462 ms')
    await expect(page.locator('svg[role="img"]')).toContainText('Deviation (ms)')
    await expect(page.locator('body')).not.toContainText('Absolute timing deviation')

    // Freeze stops subsequent capture reads and renders deviation summary
    await page.getByRole('button', { name: 'Freeze', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as QaWindow).qa.calls.at(-1)?.captureAction)
      )
      .toBe('stop')
    await expect(page.locator('body')).toContainText('Mean 0.125 ms · Median 0.042 ms')

    const frozenCallCount = await page.evaluate(
      () => (window as unknown as QaWindow).qa.calls.length
    )
    await page.waitForTimeout(5_200)
    expect(
      await page.evaluate(() => (window as unknown as QaWindow).qa.calls.length)
    ).toBe(frozenCallCount)

    // Pacer toggle updates state; failed toggle preserves observed engine state & shows alert
    const toggleSwitch = page.locator('[role="switch"]')
    await toggleSwitch.click()
    await expect(toggleSwitch).toHaveAttribute('aria-checked', 'false')

    await page.evaluate(() => (window as unknown as QaWindow).qa.failToggle(true))
    await toggleSwitch.click()
    await expect(page.locator('[role="alert"]')).toBeVisible()
    await expect(toggleSwitch).toHaveAttribute('aria-checked', 'false')

    // Narrow mobile viewport keeps dialog within bounds
    await page.setViewportSize({ width: 375, height: 812 })
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(812)

    // Escape closes dialog and restores focus to trigger pill
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(pillButton).toBeFocused()

    // Hidden tab pauses capture polling
    await page.evaluate(() => {
      const qa = (window as unknown as QaWindow).qa
      qa.failToggle(false)
      qa.emit(true)
    })
    await pillButton.click()
    await expect(dialog).toBeVisible()

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as QaWindow).qa.calls.at(-1)?.captureAction)
      )
      .toBe('stop')

    await page.waitForTimeout(500)
    const hiddenCallCount = await page.evaluate(
      () => (window as unknown as QaWindow).qa.calls.length
    )
    await page.waitForTimeout(5_200)
    expect(
      await page.evaluate(() => (window as unknown as QaWindow).qa.calls.length)
    ).toBe(hiddenCallCount)

    expect(pageErrors).toEqual([])
  })
})
