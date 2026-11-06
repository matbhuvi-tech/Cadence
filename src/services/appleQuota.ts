const DEFAULT_RETRY_DELAY_MS = 60_000

function appleRetryDelay(retryAfter: string | null): number {
  if (retryAfter === null) return DEFAULT_RETRY_DELAY_MS
  const seconds = Number(retryAfter)
  if (retryAfter.trim() && Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000)
  const retryTime = Date.parse(retryAfter)
  return Number.isNaN(retryTime) ? DEFAULT_RETRY_DELAY_MS : Math.max(1000, retryTime - Date.now())
}

function waitForQuota(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, ms)
    function cancel() {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export async function fetchAppleWithQuota(url: string, signal: AbortSignal, timeoutMs: number): Promise<Response> {
  while (true) {
    signal.throwIfAborted()
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      redirect: 'error',
    })
    const retryAfter = response.headers.get('Retry-After')
    if (response.status !== 429 && !(response.status === 503 && retryAfter)) return response
    void response.body?.cancel().catch(() => {})
    await waitForQuota(Math.min(appleRetryDelay(retryAfter), 2_147_483_647), signal)
  }
}
