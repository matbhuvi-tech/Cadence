/**
 * Circular Dependency and Module Initialization Order Analyzer
 * Crawls all TypeScript source files in src/ and checks for import cycles.
 */
import fs from 'node:fs'
import path from 'node:path'

function findTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'test' && entry.name !== 'node_modules') {
        files.push(...findTsFiles(full))
      }
    } else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
      files.push(full)
    }
  }
  return files
}

function resolveImport(sourceFile: string, importPath: string): string | null {
  if (!importPath.startsWith('.')) return null
  const dir = path.dirname(sourceFile)
  const candidate = path.resolve(dir, importPath)
  const extensions = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
  for (const ext of extensions) {
    const p = candidate + ext
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return p
    }
  }
  return null
}

export function detectCircularDependencies(): { cycle: string[] }[] {
  const srcDir = path.resolve(process.cwd(), 'src')
  const allFiles = findTsFiles(srcDir)
  const graph = new Map<string, string[]>()

  const importRegex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?|export\s+[\w*\s{},]*\s+from\s+)["']([^"']+)["']/g

  for (const file of allFiles) {
    const content = fs.readFileSync(file, 'utf-8')
    const deps: string[] = []
    let match: RegExpExecArray | null
    while ((match = importRegex.exec(content)) !== null) {
      const depPath = resolveImport(file, match[1])
      if (depPath) {
        deps.push(depPath)
      }
    }
    graph.set(file, deps)
  }

  // Find cycles using DFS
  const cycles: { cycle: string[] }[] = []
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const stack: string[] = []

  function dfs(node: string) {
    visited.add(node)
    inStack.add(node)
    stack.push(node)

    const neighbors = graph.get(node) || []
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor)
      } else if (inStack.has(neighbor)) {
        // Cycle detected
        const cycleStartIndex = stack.indexOf(neighbor)
        if (cycleStartIndex !== -1) {
          const cycle = stack.slice(cycleStartIndex).map((p) => path.relative(srcDir, p))
          cycle.push(path.relative(srcDir, neighbor))
          cycles.push({ cycle })
        }
      }
    }

    stack.pop()
    inStack.delete(node)
  }

  for (const file of allFiles) {
    if (!visited.has(file)) {
      dfs(file)
    }
  }

  return cycles
}

// Self-run when executed directly
if (process.argv[1]?.includes('detectCircularDependencies')) {
  console.log('Analyzing codebase for circular dependency cycles...')
  const cycles = detectCircularDependencies()
  if (cycles.length === 0) {
    console.log('✅ ZERO circular dependencies found in src/!')
  } else {
    console.warn(`⚠️ Found ${cycles.length} circular dependency cycles:`)
    for (const c of cycles) {
      console.warn(`  - ${c.cycle.join(' -> ')}`)
    }
  }
}
