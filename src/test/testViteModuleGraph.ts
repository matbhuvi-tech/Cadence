/**
 * Crawler test that crawls all ES modules served by Vite dev server starting from /src/main.tsx
 * Checks every module for 404s, 500s, syntax errors, or server-side compiler crashes.
 */
async function testViteModuleGraph() {
  const baseUrl = 'http://localhost:5173'
  const visited = new Set<string>()
  const queue: string[] = ['/src/main.tsx']
  const errors: { url: string; error: string }[] = []

  console.log('Starting Vite module graph crawl from /src/main.tsx...')

  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)

    const fullUrl = `${baseUrl}${current}`
    let res: Response
    let text: string
    try {
      res = await fetch(fullUrl)
      if (!res.ok) {
        errors.push({ url: current, error: `HTTP ${res.status} ${res.statusText}` })
        console.error(`❌ [${res.status}] ${current}`)
        continue
      }
      text = await res.text()
    } catch (e: any) {
      errors.push({ url: current, error: `Network fetch failed: ${e.message}` })
      console.error(`❌ Fetch failed for ${current}:`, e.message)
      continue
    }

    // Check if the response is an actual 500 error or syntax failure
    if (res.status >= 400 || (text.includes('plugin:vite:') && text.includes('error'))) {
      errors.push({ url: current, error: 'Vite returned compilation error' })
      console.error(`❌ Vite error in ${current}:\n`, text.slice(0, 500))
    }

    // Parse import statements: import ... from "..." or import "..."
    const importRegex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?|export\s+[\w*\s{},]*\s+from\s+)["']([^"']+)["']/g
    let match: RegExpExecArray | null
    while ((match = importRegex.exec(text)) !== null) {
      const importPath = match[1]
      // Only crawl internal project modules or vite deps, not external http
      if (importPath.startsWith('/') || importPath.startsWith('./') || importPath.startsWith('../')) {
        let resolved = importPath
        if (importPath.startsWith('.')) {
          const currentDir = current.substring(0, current.lastIndexOf('/'))
          resolved = new URL(importPath, `http://localhost${currentDir}/`).pathname
        }
        if (!visited.has(resolved) && !queue.includes(resolved)) {
          queue.push(resolved)
        }
      }
    }
  }

  console.log(`\nCrawl complete. Checked ${visited.size} modules.`)
  if (errors.length > 0) {
    console.error(`\n❌ Found ${errors.length} module loading errors:`)
    errors.forEach((e) => console.error(` - ${e.url}: ${e.error}`))
    process.exit(1)
  } else {
    console.log('✅ ALL MODULES LOADED CLEANLY WITH HTTP 200!')
  }
}

testViteModuleGraph().catch((err) => {
  console.error('Fatal crawler error:', err)
  process.exit(1)
})
