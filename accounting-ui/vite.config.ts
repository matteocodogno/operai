import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'
import { readFileSync } from 'node:fs'

// specs/20261119-accounting: accounting-ui — the Accounting tool's federated REMOTE (ADR 20260709-suite-frontend-module-federation),
// modelled on letterheads-ui/vite.config.ts (commit a8448b6f). Two exposed modules: `./App` (the
// access-gated tool, mounted at the shell's `/accounting/*`) and `./version`
// (ADR 20260803-suite-version-generated-file-federated-export, the About modal). `requiredVersion` for every shared singleton is
// read from this package's own dependency ranges so the graph cannot drift.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// Build-time dev default only, overridable via env var (the shell's runtime
// remote resolution is separate, ADR 20260709-suite-frontend-module-federation): the shell dev server's pinned port.
const shellRemoteUrl = process.env['SHELL_REMOTE_URL'] ?? 'http://localhost:5173/remoteEntry.js'

// @operai/ui (operai-ui/, ADR 20261031-shared-ui-library-consumed-as-source) is NOT bundled by this remote: it is a Module
// Federation shared singleton the shell provides (ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell), declared below with
// `import: false`. The `link:../operai-ui` devDependency exists only so the plugin can read the
// library's named exports at build time; a Vite alias would bypass the sharing. tsconfig `paths`
// still give the types.

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  plugins: [
    react(),
    federation({
      name: 'accounting',
      filename: 'remoteEntry.js',
      // dts off: this remote's own build must work without a live shell dev
      // server; the shell's ambient shapes live in src/federation/remotes.d.ts.
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
        // ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell: consumed from the shell, never bundled here (no fallback).
        '@operai/ui': { singleton: true, import: false, requiredVersion: false },
      },
    }),
  ],
  define: {
    // Consumed by src/version.ts's REMOTE_VERSION — this remote's own
    // version, exposed federated as `./version` (ADR 20260803-suite-version-generated-file-federated-export).
    __REMOTE_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // Required by @module-federation/vite: federated chunks use top-level
    // await to resolve shared modules asynchronously at runtime.
    target: 'esnext',
    modulePreload: false,
  },
  server: {
    // Pinned local-dev port for accounting-ui as a remote (5183); the shell
    // (:5173) consumes its remoteEntry.js from here. cors lets the shell's
    // different dev origin fetch it; strictPort fails fast on a collision.
    port: 5183,
    strictPort: true,
    cors: true,
  },
  preview: {
    port: 5183,
    strictPort: true,
    cors: true,
  },
})
