import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'
import { readFileSync } from 'node:fs'

// T13 (specs/004-auth-roles-permissions/tasks.md): admin-ui — the Roles &
// Permissions management GUI's dedicated Module Federation REMOTE (plan.md
// "New admin-ui remote (ADR-0006 shape)"). Mirrors refund-ui/vite.config.ts
// (T15, specs/003-suite-shell) exactly — same federation shape, same shared
// singletons, same dev-default pattern — so the whole suite's remotes stay
// structurally identical. requiredVersion for shared singletons is sourced
// from this package's own dependency ranges so the graph cannot silently
// drift.
//
// The same `pkg.version` now also backs `__REMOTE_VERSION__` (version-bump
// plan §C): this remote's OWN version, exposed via Module Federation as
// `./version` (see `exposes` below + src/version.ts) so the shell's About
// dialog can show it alongside the suite's umbrella version. Same
// same-directory `readFileSync('./package.json')` read already used for the
// `shared.requiredVersion` entries — no new cross-directory risk.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// Build-time dev default only, overridable via env var — mirrors the
// SHELL_REMOTE_URL pattern in refund-ui/vite.config.ts and
// estimai-ui/vite.config.ts. The plan's actual deploy model resolves remote
// URLs per-environment at *runtime* via MF's dynamic-remote API, not
// build-baked. Dev default points at the shell's pinned port (:5173) —
// admin-ui consumes shell/session + shell/tokens.css from there.
const shellRemoteUrl = process.env['SHELL_REMOTE_URL'] ?? 'http://localhost:5173/remoteEntry.js'

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'admin',
      filename: 'remoteEntry.js',
      // dts generation disabled: this remote's own build may run without a
      // live shell dev server (e.g. CI, `pnpm --dir admin-ui build` in
      // isolation) — a dts fetch attempt against `shellRemoteUrl` would fail
      // noisily in that case. Same call made for refund-ui's own config (dts:
      // false there too) and for the same reason. Not needed anyway:
      // `shell/session` and `shell/tokens.css`'s shapes are declared via
      // src/federation/remotes.d.ts (ambient module declarations).
      dts: false,
      // T13's own federation contract: admin-ui EXPOSES its root component
      // (mirrors refund-ui/vite.config.ts's T15 shape exactly: name/
      // filename/exposes/shared) AND CONSUMES the shell as a remote, for
      // `shell/session` (shared auth) and `shell/tokens.css` (shared design
      // tokens) — see src/App.tsx. This makes admin-ui bidirectional, same
      // as the shell itself and refund-ui (plan.md federation contract;
      // ADR-0006): the shell is a host to admin-ui's exposed `./App`, and
      // admin-ui is in turn a host to the shell's exposed
      // `./session`/`./tokens.css`.
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
    // Pinned local-dev port for admin-ui as a remote (5177 — shell=5173,
    // estimai-ui=5174, refund-ui=5175 are already taken; 5177 leaves 5176
    // free for a future remote). The shell (:5173) consumes its
    // remoteEntry.js from here. cors lets the shell's different dev origin
    // fetch it; strictPort fails fast on a collision.
    port: 5177,
    strictPort: true,
    cors: true,
  },
  preview: {
    port: 5177,
    strictPort: true,
    cors: true,
  },
})
