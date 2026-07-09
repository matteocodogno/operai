import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'
import { readFileSync } from 'node:fs'

// Read the app version from package.json (bumped by `mise run release`) and
// expose it to the client as the compile-time constant __APP_VERSION__ so the
// About dialog can show it without bundling the whole package.json.
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
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'estimai',
      filename: 'remoteEntry.js',
      exposes: {
        './App': './src/App.tsx',
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
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // Required by @module-federation/vite: federated chunks use top-level
    // await to resolve shared modules asynchronously at runtime.
    target: 'esnext',
    modulePreload: false,
  },
  server: {
    // Allow the shell (a different dev-server origin) to fetch this remote's
    // remoteEntry.js and chunks in local development.
    cors: true,
  },
  preview: {
    cors: true,
  },
})
