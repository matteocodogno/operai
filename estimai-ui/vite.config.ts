import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'
import { readFileSync } from 'node:fs'

// Read package.json so the federation `shared.requiredVersion` entries below
// stay in sync with this package's own dependency ranges rather than being
// hardcoded (see the T12 comment further down). The suite-level About dialog
// (which used to read the app version from here, via __APP_VERSION__) is now
// owned by the shell — specs/003-suite-shell, T6/T14.
//
// The same `pkg.version` now also backs `__REMOTE_VERSION__` (version-bump
// plan §C): this remote's OWN version, exposed via Module Federation as
// `./version` (see `exposes` below + src/version.ts) so the shell's About
// dialog can show it alongside the suite's umbrella version. Same
// same-directory `readFileSync('./package.json')` read already used for the
// `shared.requiredVersion` entries — no new cross-directory risk.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// T12 (specs/003-suite-shell/tasks.md): estimai-ui as a Module Federation
// REMOTE — not a host. It exposes a single root component, `./App` (see
// src/App.tsx), that the shell (T9/T11, out of scope here) mounts under its
// `/estimai/*` catch-all route. Shared singletons mirror shell/vite.config.ts
// exactly (react, react-dom, @tanstack/react-router, better-auth, all
// singleton: true) so host and remote negotiate ONE instance of each — the
// R2 concern (duplicate React/singleton skew) already proven by the T2
// walking skeleton. requiredVersion strings below are copied from this
// package's own dependency ranges (package.json) rather than hardcoded, so
// they cannot silently drift from what estimai-ui actually ships.
//
// T13 (specs/003-suite-shell/tasks.md, AC-2.3): estimai-ui is ALSO, now, a
// consumer — it makes the shell a `remotes` entry so it can import the
// shell-exposed `shell/session` module (shell/src/lib/session.ts, T4) rather
// than holding its own JWT cache / better-auth client (see src/lib/api.ts,
// src/lib/authClient.ts). This mirrors shell/vite.config.ts's own `remotes`
// entries for estimai/refund exactly (type: 'module', shareScope: 'default').
// The URL is env-configurable with a localhost dev default, matching the
// ESTIMAI_REMOTE_URL/REFUND_REMOTE_URL pattern shell/vite.config.ts already
// uses. `dts: false` for the same reason shell disables it for its own
// (not-yet-built) remotes: a dts fetch against the shell's dev server would
// fail noisily whenever estimai-ui's dev server / CI build runs without the
// shell also running — `shell/session`'s shape is instead hand-declared via
// src/federation/remotes.d.ts (ambient module declaration), mirroring
// shell/src/federation/remotes.d.ts's own approach for estimai/App + refund/App.
//
// Neither estimai-ui nor the shell currently pin a dev-server port (both
// default to Vite's 5173 — see shell/vite.config.ts's own comment on this),
// so running the shell + estimai-ui concurrently in local dev needs an
// explicit `--port`/`SHELL_REMOTE_URL` override today; this is the same T17
// (deploy wiring) concern the shell's comment already flags for
// ESTIMAI_REMOTE_URL/REFUND_REMOTE_URL, not something this task resolves.
const shellRemoteUrl =
  process.env['SHELL_REMOTE_URL'] ?? 'http://localhost:5173/remoteEntry.js'

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'estimai',
      filename: 'remoteEntry.js',
      dts: false,
      exposes: {
        './App': './src/App.tsx',
        './version': './src/version.ts',
      },
      remotes: {
        shell: {
          type: 'module',
          name: 'shell',
          entry: shellRemoteUrl,
          entryGlobalName: 'shell',
          shareScope: 'default',
        },
      },
      shared: {
        react: { singleton: true, requiredVersion: pkg.dependencies.react },
        'react-dom': { singleton: true, requiredVersion: pkg.dependencies['react-dom'] },
        '@tanstack/react-router': {
          singleton: true,
          requiredVersion: pkg.dependencies['@tanstack/react-router'],
        },
        'better-auth': { singleton: true, requiredVersion: pkg.dependencies['better-auth'] },
      },
    }),
  ],
  define: {
    // Consumed by src/version.ts's REMOTE_VERSION — this remote's own
    // version, exposed federated as `./version` (version-bump plan §C).
    __REMOTE_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // Required by @module-federation/vite: federated chunks use top-level
    // await to resolve shared modules asynchronously at runtime.
    target: 'esnext',
    modulePreload: false,
  },
  server: {
    // Pinned local-dev port for estimai-ui as a remote (5174); the shell
    // (:5173) consumes its remoteEntry.js from here. cors lets the shell's
    // different dev origin fetch it; strictPort fails fast on a collision.
    port: 5174,
    strictPort: true,
    cors: true,
  },
  preview: {
    port: 5174,
    strictPort: true,
    cors: true,
  },
})
