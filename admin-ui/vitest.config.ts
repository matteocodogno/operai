import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // T13 (specs/004-auth-roles-permissions/tasks.md): App.tsx consumes the
    // suite's shared shell modules (`shell/session`, `shell/tokens.css`).
    // These bare specifiers only resolve at runtime via the
    // `@module-federation/vite` plugin configured in vite.config.ts — a
    // plugin this test config deliberately does not load (unit tests mock
    // shell/session instead of depending on a live remoteEntry.js, see
    // App.test.tsx). Vite's import-analysis still needs *something*
    // resolvable for every import specifier it sees before a test's
    // `vi.mock(...)` can take over — mirrors refund-ui/vitest.config.ts's
    // identical treatment — see src/federation/__stubs__/* for why they're
    // never actually used for real values.
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
