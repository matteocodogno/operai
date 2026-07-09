import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'

// R1 GATE (specs/003-suite-shell/tasks.md, T2): throwaway/seed Module
// Federation remote. `@module-federation/vite` officially supports Vite 8
// (peerDependencies: "vite": "^5 || ^6 || ^7 || ^8") as of 1.16.x, so this
// walking skeleton targets Vite 8 directly — no R1 version-pin fallback was
// needed. See shell/vite.config.ts for the matching host config and the
// shared-singleton note.
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'seed',
      filename: 'remoteEntry.js',
      // dts generation cross-compiles exposed modules with a separate tsc
      // invocation and is not needed for this throwaway probe (the host
      // declares the remote's shape via an ambient .d.ts instead).
      dts: false,
      exposes: {
        './SeedProbe': './src/SeedProbe.tsx',
      },
      shared: {
        react: { singleton: true, requiredVersion: '^19.2.4' },
        'react-dom': { singleton: true, requiredVersion: '^19.2.4' },
      },
    }),
  ],
  build: {
    // Required by @module-federation/vite: federated chunks use top-level
    // await to resolve shared modules asynchronously at runtime.
    target: 'esnext',
    modulePreload: false,
  },
  server: {
    port: 5175,
    strictPort: true,
    cors: true,
  },
  preview: {
    port: 5175,
    strictPort: true,
    cors: true,
  },
})
