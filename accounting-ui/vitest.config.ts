import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // One React for the app and the library's source (ADR 20261031-shared-ui-library-consumed-as-source).
    dedupe: ['react', 'react-dom'],
    // `shell/session` and `shell/tokens.css` are federated specifiers that only
    // resolve at runtime through `@module-federation/vite` (vite.config.ts), a
    // plugin this test config deliberately does not load. Vite's import
    // analysis still needs something resolvable before a test's
    // `vi.mock('shell/session', ...)` can take over — see
    // src/federation/__stubs__/* (never used for real values). Mirrors
    // refund-ui/vitest.config.ts.
    alias: [
      // The shared component library, compiled from source (ADR 20261031-shared-ui-library-consumed-as-source); exact matches, the longer first.
      { find: /^@operai\/ui$/, replacement: fileURLToPath(new URL('../operai-ui/src/index.ts', import.meta.url)) },
      { find: 'shell/session', replacement: fileURLToPath(new URL('./src/federation/__stubs__/shellSession.ts', import.meta.url)) },
      { find: 'shell/tokens.css', replacement: fileURLToPath(new URL('./src/federation/__stubs__/shellTokens.css', import.meta.url)) },
    ],
  },
  test: {
    // Default `node`; a test that renders opts into jsdom with a `@vitest-environment jsdom` docblock (as refund-ui).
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
