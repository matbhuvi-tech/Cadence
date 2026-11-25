import { test as vitestTest, vi } from 'vitest'

export interface TestContext {
  mock: {
    method: <T extends object, K extends keyof T>(
      obj: T,
      prop: K,
      impl: (...args: any[]) => any,
    ) => {
      mock: {
        callCount: () => number
        mockImplementation: (next: (...args: any[]) => any) => void
      }
    }
  }
}

export function test(name: string, fn: (t: TestContext) => unknown | Promise<unknown>) {
  vitestTest(name, async () => {
    const t: TestContext = {
      mock: {
        method(obj, prop, impl) {
          const spy = vi.spyOn(obj as Record<PropertyKey, any>, prop as PropertyKey).mockImplementation(impl)
          return {
            mock: {
              callCount: () => spy.mock.calls.length,
              mockImplementation: (next) => {
                spy.mockImplementation(next)
              },
            },
          }
        },
      },
    }
    await fn(t)
  })
}
