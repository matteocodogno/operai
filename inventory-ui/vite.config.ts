import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'
import { readFileSync } from 'node:fs'

// specs/015-hardware-inventory, T24: inventory-ui — the hardware inventory
// tool's federated REMOTE (ADR-0006), modelled on refund-ui/vite.config.ts.
// One remote, THREE exposed modules (ADR-0045): `./App` (the access-gated
// tool, mounted at the shell's `/inventory/*`), `./MyDevices` (the ungated,
// identity-scoped devices view, mounted at `/devices`) and `./version`
// (ADR-0030, the About modal). `requiredVersion` for every shared singleton is
// read from this package's own dependency ranges so the graph cannot drift.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// Build-time dev default only, overridable via env var (the shell's runtime
// remote resolution is separate, ADR-0006): the shell dev server's pinned port.
const shellRemoteUrl = process.env['SHELL_REMOTE_URL'] ?? 'http://localhost:5173/remoteEntry.js'

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'inventory',
      filename: 'remoteEntry.js',
      // dts off: this remote's own build must work without a live shell dev
      // server; the shell's ambient shapes live in src/federation/remotes.d.ts.
      dts: false,
      exposes: {
        './App': './src/App.tsx',
        './MyDevices': './src/MyDevices.tsx',
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
    // version, exposed federated as `./version` (ADR-0030).
    __REMOTE_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // Required by @module-federation/vite: federated chunks use top-level
    // await to resolve shared modules asynchronously at runtime.
    target: 'esnext',
    modulePreload: false,
  },
  server: {
    // Pinned local-dev port for inventory-ui as a remote (5178); the shell
    // (:5173) consumes its remoteEntry.js from here. cors lets the shell's
    // different dev origin fetch it; strictPort fails fast on a collision.
    port: 5178,
    strictPort: true,
    cors: true,
  },
  preview: {
    port: 5178,
    strictPort: true,
    cors: true,
  },
})
