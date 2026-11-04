import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // One React for the app and the library's source (ADR-0050).
    dedupe: ['react', 'react-dom'],
    // `shell/session` and `shell/tokens.css` are federated specifiers that only
    // resolve at runtime through `@module-federation/vite` (vite.config.ts), a
    // plugin this test config deliberately does not load. Vite's import
    // analysis still needs something resolvable before a test's
    // `vi.mock('shell/session', ...)` can take over — see
    // src/federation/__stubs__/* (never used for real values). Mirrors
    // refund-ui/vitest.config.ts.
    alias: {
      // The shared component library, compiled from source (ADR-0050).
      '@operai/ui': fileURLToPath(new URL('../operai-ui/src/index.ts', import.meta.url)),
      'shell/session': fileURLToPath(new URL('./src/federation/__stubs__/shellSession.ts', import.meta.url)),
      // The host-extension seam (specs/021-meetings, ADR-0060), same reason.
      'shell/extensions': fileURLToPath(new URL('./src/federation/__stubs__/shellExtensions.ts', import.meta.url)),
      'shell/tokens.css': fileURLToPath(new URL('./src/federation/__stubs__/shellTokens.css', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
