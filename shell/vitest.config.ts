import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // T9 (specs/003-suite-shell/tasks.md): router.tsx dynamically imports
    // the suite's federated remotes (`estimai/App`, `refund/App`, and now
    // `admin/App` — T25, specs/004-auth-roles-permissions). These bare
    // specifiers only resolve at runtime via the `@module-federation/vite`
    // plugin configured in vite.config.ts — a plugin this test config
    // deliberately does not load (unit tests mock the remotes instead of
    // depending on a live remoteEntry.js, see router.test.tsx and
    // router.integration.test.tsx). Vite's import-analysis still needs
    // *something* resolvable for every import specifier it sees before a
    // test's `vi.mock(...)` can take over, so these aliases point at small
    // local stubs purely to satisfy resolution — see
    // src/federation/__stubs__/*.tsx for why they're never actually
    // rendered.
    alias: {
      'estimai/App': fileURLToPath(new URL('./src/federation/__stubs__/estimaiApp.tsx', import.meta.url)),
      'refund/App': fileURLToPath(new URL('./src/federation/__stubs__/refundApp.tsx', import.meta.url)),
      'admin/App': fileURLToPath(new URL('./src/federation/__stubs__/adminApp.tsx', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
