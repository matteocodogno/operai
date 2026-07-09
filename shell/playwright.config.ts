import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for shell e2e tests.
 *
 * T2 (specs/003-suite-shell/tasks.md) — the R1 gate — is currently the only
 * suite here: it proves the Module Federation walking skeleton actually
 * works at runtime (not just "it builds"). Both the shell host AND the
 * throwaway `mf-seed-remote` are built and served via `vite preview` (not
 * `vite dev`) — dev-mode host + build-mode remote was tried first and does
 * NOT reliably negotiate the shared React singleton (esbuild's dev
 * dependency pre-bundling and the federation runtime's dev-mode virtual
 * modules don't line up the same way build-mode chunks do); build+preview
 * on both sides is the reliable, reproducible mode and also mirrors how the
 * suite actually deploys (independently built + served remotes).
 */

const shellUrl = 'http://localhost:5174'
const seedRemoteUrl = 'http://localhost:5175'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',

  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,

  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: shellUrl,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Two independent webServers: the seed remote (built + previewed on 5175,
  // the URL shell/vite.config.ts's federation host config points at) and the
  // shell host itself (built + previewed on 5174). Order matters: the remote
  // must be up before the shell's build-time SEED_REMOTE_URL default is
  // dereferenced at runtime.
  webServer: [
    {
      command: 'pnpm --dir ../mf-seed-remote build && pnpm --dir ../mf-seed-remote preview --port 5175 --strictPort',
      url: seedRemoteUrl,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm build && pnpm preview --port 5174 --strictPort',
      url: shellUrl,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
