import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // T9 (specs/003-suite-shell/tasks.md): router.tsx dynamically imports
    // the suite's federated remotes (`estimai/App`, `refund/App`, `admin/App`
    // — T25, specs/004-auth-roles-permissions — and now `notify/App` — T13,
    // specs/005-notification-center). These bare specifiers only resolve at
    // runtime via the `@module-federation/vite` plugin configured in
    // vite.config.ts — a plugin this test config deliberately does not load
    // (unit tests mock the remotes instead of depending on a live
    // remoteEntry.js, see router.test.tsx and router.integration.test.tsx).
    // Vite's import-analysis still needs *something* resolvable for every
    // import specifier it sees before a test's `vi.mock(...)` can take over,
    // so these aliases point at small local stubs purely to satisfy
    // resolution — see src/federation/__stubs__/*.tsx for why they're never
    // actually rendered.
    alias: {
      'estimai/App': fileURLToPath(new URL('./src/federation/__stubs__/estimaiApp.tsx', import.meta.url)),
      'refund/App': fileURLToPath(new URL('./src/federation/__stubs__/refundApp.tsx', import.meta.url)),
      'admin/App': fileURLToPath(new URL('./src/federation/__stubs__/adminApp.tsx', import.meta.url)),
      'notify/App': fileURLToPath(new URL('./src/federation/__stubs__/notifyApp.tsx', import.meta.url)),
      // AboutModal.tsx dynamically imports each remote's `./version` module
      // (../hooks/useRemoteVersions.ts) — same bare-specifier-only-resolves-
      // at-runtime-via-MF situation as `*/App` above, same fix: alias to a
      // local stub so Vite's import-analysis has something resolvable before
      // a test's `vi.mock(...)` takes over (see AboutModal.test.tsx).
      'estimai/version': fileURLToPath(
        new URL('./src/federation/__stubs__/estimaiVersion.ts', import.meta.url),
      ),
      'refund/version': fileURLToPath(
        new URL('./src/federation/__stubs__/refundVersion.ts', import.meta.url),
      ),
      'admin/version': fileURLToPath(
        new URL('./src/federation/__stubs__/adminVersion.ts', import.meta.url),
      ),
      'notify/version': fileURLToPath(
        new URL('./src/federation/__stubs__/notifyVersion.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
