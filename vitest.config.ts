import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TEST_BUILD_INFO = {
  tag: 'v0.1.0-test',
  commitsSinceTag: 0,
  commitSha: 'test000',
  commitDate: '2026-01-01',
  commitSummary: 'vitest',
  dirty: false,
  display: 'v0.1.0-test',
}

const SHARED_REACT_ALIAS = {
  react: path.resolve(__dirname, 'node_modules/react'),
  'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime.js'),
  'react/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime.js'),
  'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
  'lucide-react': path.resolve(__dirname, 'node_modules/lucide-react'),
}

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}', 'pwa/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/src/test/**',
        '**/*.d.ts',
        '**/vite-env.d.ts',
        'src/main.tsx',
        'pwa/src/main.tsx',
      ],
    },
    projects: [
      {
        plugins: [react()],
        define: {
          __CADENCE_BUILD_INFO__: JSON.stringify(TEST_BUILD_INFO),
        },
        resolve: {
          alias: SHARED_REACT_ALIAS,
        },
        test: {
          name: 'desktop',
          environment: 'happy-dom',
          globals: false,
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['src/test/vitest.setup.ts'],
        },
      },
      {
        plugins: [react()],
        define: {
          __CADENCE_BUILD_INFO__: JSON.stringify(TEST_BUILD_INFO),
        },
        resolve: {
          alias: SHARED_REACT_ALIAS,
        },
        test: {
          name: 'pwa',
          environment: 'happy-dom',
          globals: false,
          include: ['pwa/src/**/*.test.{ts,tsx}'],
          setupFiles: ['src/test/vitest.setup.ts'],
        },
      },
    ],
  },
})
