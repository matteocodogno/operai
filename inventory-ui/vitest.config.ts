import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // `shell/session` and `shell/tokens.css` are federated specifiers that only
    // resolve at runtime through `@module-federation/vite` (vite.config.ts), a
    // plugin this test config deliberately does not load. Vite's import
    // analysis still needs something resolvable before a test's
    // `vi.mock('shell/session', ...)` can take over — see
    // src/federation/__stubs__/* (never used for real values). Mirrors
    // refund-ui/vitest.config.ts.
    alias: {
      'shell/session': fileURLToPath(new URL('./src/federation/__stubs__/shellSession.ts', import.meta.url)),
      'shell/tokens.css': fileURLToPath(new URL('./src/federation/__stubs__/shellTokens.css', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
