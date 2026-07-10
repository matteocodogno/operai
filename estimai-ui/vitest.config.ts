import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // T13 (specs/003-suite-shell/tasks.md): src/lib/api.ts and
    // src/lib/authClient.ts now import the federated `shell/session` module
    // (see vite.config.ts's `remotes` + src/federation/remotes.d.ts's ambient
    // type declaration). That bare specifier only resolves at runtime via the
    // `@module-federation/vite` plugin configured in vite.config.ts — a
    // plugin this test config deliberately does not load (unit tests mock
    // the remote instead of depending on a live shell dev server / built
    // remoteEntry.js, see src/lib/api.test.ts, src/lib/authClient.test.ts,
    // and src/router.test.tsx). Vite's import-analysis still needs
    // *something* resolvable for every import specifier it sees before a
    // test's `vi.mock('shell/session', …)` can take over — see
    // src/federation/__stubs__/shellSession.ts for why it's a safe stub even
    // when a test exercises it unmocked. Mirrors shell/vitest.config.ts's own
    // `resolve.alias` for `estimai/App`/`refund/App` exactly.
    alias: {
      'shell/session': fileURLToPath(
        new URL('./src/federation/__stubs__/shellSession.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
