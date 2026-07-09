import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'

// R1 GATE (specs/003-suite-shell/tasks.md, T2): Module Federation host config.
//
// `@module-federation/vite` (MF2 runtime, per ADR-0006) officially supports
// Vite 8 — its peerDependencies declare "vite": "^5 || ^6 || ^7 || ^8" as of
// 1.16.x — so this walking skeleton targets Vite 8 directly. Building and
// running it here (see mf-seed-remote/) proved that clean; no R1 fallback
// (pinning Vite down a minor, or switching to @originjs/vite-plugin-federation)
// was necessary.
//
// The remote URL below is a build-time default for the walking skeleton only.
// The plan's actual deploy model (T17) resolves remote URLs per-environment
// at *runtime* via MF's dynamic-remote API, not build-baked — do not treat
// this hardcoded localhost URL as the production pattern.
const seedRemoteUrl = process.env['SEED_REMOTE_URL'] ?? 'http://localhost:5175/remoteEntry.js'

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'shell',
      // dts generation is disabled on the seed remote's producer side (see
      // mf-seed-remote/vite.config.ts) — matching it here avoids a noisy
      // failed download of a nonexistent @mf-types.zip on host dev-server
      // startup. Not needed anyway: the remote's shape is declared via
      // src/federation/remotes.d.ts (ambient module declaration).
      dts: false,
      // T3 (specs/003-suite-shell/tasks.md): the shell doubles as a producer
      // for the shared Operai design tokens (fonts, palette, Tailwind
      // `@theme` block — see src/styles/tokens.css), per the plan's
      // federation contract (`shell` exposes `./tokens.css`, `./session`).
      // This makes the shell bidirectional — it both consumes remotes
      // (`remotes` below) and exposes modules of its own — which MF2
      // supports. Remotes (estimai-ui T12/T13, refund-ui T15) import this
      // as `shell/tokens.css` instead of duplicating the stylesheet, so the
      // whole suite renders in one design system (AC-1.3).
      // T4 (specs/003-suite-shell/tasks.md): the shell also exposes the
      // shared session/runtime module — the in-memory-JWT `apiFetch`, the
      // better-auth client wrappers (getSession/useSession/signOut), and the
      // trusted-origin Bearer guard, extracted from estimai-ui's
      // src/lib/api.ts + authClient.ts (ADR-0001). Remotes import
      // `shell/session` instead of holding their own copy, so the ADR-0001
      // in-memory JWT is cached ONCE for the whole suite (plan.md federation
      // contract).
      exposes: {
        './tokens.css': './src/styles/tokens.css',
        './session': './src/lib/session.ts',
      },
      remotes: {
        seed: {
          type: 'module',
          name: 'seed',
          entry: seedRemoteUrl,
          entryGlobalName: 'seed',
          shareScope: 'default',
        },
      },
      shared: {
        react: { singleton: true, requiredVersion: '^19.2.4' },
        'react-dom': { singleton: true, requiredVersion: '^19.2.4' },
        // T4: the session module (./session) wraps a single better-auth
        // client instance; a second better-auth copy across the host↔remote
        // boundary would mean two independent auth-client instances (and,
        // via its cross-tab broadcast-channel, two signalling identities) —
        // singleton: true keeps it one instance for the whole suite, same
        // rationale as react/react-dom above.
        'better-auth': { singleton: true, requiredVersion: '^1.2.5' },
      },
    }),
  ],
  build: {
    // Required by @module-federation/vite: federated chunks use top-level
    // await to resolve shared modules asynchronously at runtime.
    target: 'esnext',
    modulePreload: false,
  },
})
