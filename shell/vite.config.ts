import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { federation } from '@module-federation/vite'
import { readFileSync } from 'node:fs'

// requiredVersion for shared singletons is sourced from this package's own
// dependency ranges rather than hardcoded, so host and remote (estimai-ui,
// refund-ui) cannot silently drift — mirrors estimai-ui/vite.config.ts.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// __APP_VERSION__ (consumed by src/lib/appInfo.ts's APP_VERSION, rendered by
// Footer.tsx and AboutModal.tsx) is the OPERAI UMBRELLA suite version, not
// this package's own `version` field (which stays a meaningless `0.0.0` —
// per-app SemVer for `@operai/shell` is a separate, real number tracked in
// package.json for Changesets, but it is not what the footer/About dialog
// show). Reading `pkg.version` here was the original bug this file now fixes
// (see the version-bump plan): it rendered the shell's own package version
// instead of the suite's.
//
// The umbrella version is sourced from a small, COMMITTED, generated file —
// shell/src/lib/suiteVersion.generated.json — written by the root release
// tooling (scripts/version.mjs) in the same step that bumps the root
// package.json's `version`, so it can never drift between releases. This is
// deliberately a same-directory read via `readFileSync(new URL(...,
// import.meta.url))`, exactly like the `pkg` read above, and NEVER
// `../../package.json` (the root manifest): the shell deploys on Vercel with
// Root Directory = `shell`, "include files outside the Root Directory" is
// off by default there, and CLAUDE.md's own architecture note explains the
// whole monorepo is deliberately built so no app's build needs to reach
// outside its own directory. Reaching for the root package.json here would
// work locally and silently break in production the first time that Vercel
// setting matters.
function readSuiteVersion(): string {
  let raw: string
  try {
    raw = readFileSync(new URL('./src/lib/suiteVersion.generated.json', import.meta.url), 'utf-8')
  } catch (cause) {
    // Fail LOUD, not soft: this file is committed and should always be
    // present (mirrors the "validate at startup, exit on missing" posture
    // CLAUDE.md mandates for the backends' env vars). Silently falling back
    // to a placeholder here would ship a wrong-but-plausible-looking version
    // number to production with no signal anything was wrong — worse than a
    // build that fails with an actionable message pointing at the fix.
    throw new Error(
      'shell/src/lib/suiteVersion.generated.json is missing. This file is committed to the ' +
        'repo and rewritten by scripts/version.mjs during a release cut (see CLAUDE.md, ' +
        '"Versioning & releases"). Restore it from git, or run `mise run release:version` from ' +
        'the repo root, then retry the build.',
      { cause },
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(
      'shell/src/lib/suiteVersion.generated.json is not valid JSON. Expected {"version": "x.y.z"}.',
      { cause },
    )
  }

  const version = (parsed as { version?: unknown } | null)?.version
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(
      `shell/src/lib/suiteVersion.generated.json has no valid "version" string (got ${JSON.stringify(version)}). Expected {"version": "x.y.z"}.`,
    )
  }
  return version
}

const suiteVersion = readSuiteVersion()

// Module Federation host config.
//
// `@module-federation/vite` (MF2 runtime, per ADR-0006) officially supports
// Vite 8 — its peerDependencies declare "vite": "^5 || ^6 || ^7 || ^8" as of
// 1.16.x. The R1 gate (T2, specs/003-suite-shell/tasks.md) proved this clean
// against a throwaway seed remote (`mf-seed-remote/`, since deleted — see
// docs/adr/0006 and the T2 run trace for the proof); no R1 fallback (pinning
// Vite down a minor, or switching to @originjs/vite-plugin-federation) was
// necessary. The two real remotes below (estimai-ui T12, refund-ui T15)
// replace that probe now that the mechanism is proven.
//
// The remote URLs below are build-time dev defaults only, overridable via
// env var (mirrors the retired seed remote's SEED_REMOTE_URL pattern). The
// plan's actual deploy model (T17) resolves remote URLs per-environment at
// *runtime* via MF's dynamic-remote API, not build-baked — do not treat
// these hardcoded localhost URLs as the production pattern.
//
// Stable local-dev port scheme (pinned via server/preview below, matched by
// every remote's own config): shell 5173, estimai-ui 5174, refund-ui 5175,
// notify-ui 5176 (the slot admin-ui/vite.config.ts deliberately left free —
// see notify-ui/vite.config.ts, T14), admin-ui 5177. The shell consumes
// estimai at :5174, refund at :5175, notify at :5176, and admin at :5177;
// each remote consumes the shell (shell/session, shell/tokens.css) at :5173.
// The e2e harness (playwright.config.ts) uses its own explicit ports+env and
// is unaffected by these dev defaults.
const estimaiRemoteUrl =
  process.env['ESTIMAI_REMOTE_URL'] ?? 'http://localhost:5174/remoteEntry.js'
const refundRemoteUrl =
  process.env['REFUND_REMOTE_URL'] ?? 'http://localhost:5175/remoteEntry.js'
// T25 (specs/004-auth-roles-permissions/tasks.md): admin-ui (T13) as a third
// suite remote — same env-override + localhost dev-default pattern as
// estimai/refund above. Dev default targets admin-ui's own pinned port
// (5177, see admin-ui/vite.config.ts).
const adminRemoteUrl =
  process.env['ADMIN_REMOTE_URL'] ?? 'http://localhost:5177/remoteEntry.js'
// T13 (specs/005-notification-center/tasks.md): notify-ui (T14) — the
// notification center's federated remote. Same env-override + localhost
// dev-default pattern as estimai/refund/admin above. Dev default targets
// notify-ui's own pinned port (5176, see notify-ui/vite.config.ts).
const notifyRemoteUrl =
  process.env['NOTIFY_REMOTE_URL'] ?? 'http://localhost:5176/remoteEntry.js'

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: 'shell',
      // BUGFIX (found by T16's real-browser e2e run, specs/003-suite-shell):
      // without an explicit `filename`, the plugin emits the shell's own
      // remote entry under a hashed asset name instead of a stable
      // `/remoteEntry.js`. estimai-ui and refund-ui already set this
      // explicitly (see their own vite.config.ts) because THEY are consumed
      // as remotes by the shell host — but the shell is *also* consumed as a
      // remote (bidirectional graph: estimai-ui/refund-ui both declare a
      // `shell` remote pointing at `${SHELL_REMOTE_URL}/remoteEntry.js` to
      // import `shell/session`/`shell/tokens.css`), and that side was missed
      // here. Without this, every remote's `shell` import 404s (silently
      // SPA-fallback-served as `index.html` by `vite preview`), which makes
      // `import('estimai/App')`/`import('refund/App')` reject — RemoteMount
      // (T11) then correctly shows its "couldn't load" error for BOTH tools,
      // even though estimai-ui/refund-ui themselves are fine. Matches the
      // exact same line already used by estimai-ui/vite.config.ts and
      // refund-ui/vite.config.ts.
      filename: 'remoteEntry.js',
      // dts generation stays disabled (as it was for the retired seed
      // remote): refund-ui (T15) doesn't exist yet, so a dts fetch attempt
      // against its dev server would just fail noisily on host dev-server
      // startup. Not needed anyway: both remotes' shapes are declared via
      // src/federation/remotes.d.ts (ambient module declarations, T9).
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
        // T9 (specs/003-suite-shell/tasks.md): the two real suite tools.
        // Shape mirrors the retired seed remote's entry exactly (proven
        // working by the R1 gate) — only the name/URL differ.
        estimai: {
          type: 'module',
          name: 'estimai',
          entry: estimaiRemoteUrl,
          entryGlobalName: 'estimai',
          shareScope: 'default',
        },
        refund: {
          type: 'module',
          name: 'refund',
          entry: refundRemoteUrl,
          entryGlobalName: 'refund',
          shareScope: 'default',
        },
        // T25: admin-ui (T13) — the Roles & Permissions management GUI.
        // Same shape as estimai/refund above.
        admin: {
          type: 'module',
          name: 'admin',
          entry: adminRemoteUrl,
          entryGlobalName: 'admin',
          shareScope: 'default',
        },
        // T13 (specs/005-notification-center/tasks.md): notify-ui (T14) —
        // the notification center remote. Same shape as estimai/refund/admin
        // above. Unlike those, the shell route that mounts this remote
        // (`/notify/$`, src/router.tsx) is deliberately NOT app-access-gated
        // (plan.md "Shell changes" — every signed-in user has notifications).
        notify: {
          type: 'module',
          name: 'notify',
          entry: notifyRemoteUrl,
          entryGlobalName: 'notify',
          shareScope: 'default',
        },
      },
      shared: {
        react: { singleton: true, requiredVersion: pkg.dependencies.react },
        'react-dom': { singleton: true, requiredVersion: pkg.dependencies['react-dom'] },
        // @tanstack/react-router MUST be a shared singleton on the HOST side
        // too (plan.md federation contract, Risk R2): once a remote
        // (estimai-ui T12/refund-ui T15) is mounted under the shell's Outlet,
        // both sides must resolve ONE router instance — otherwise the remote
        // falls back to its own bundled copy and context/history is split.
        // (Caught by QE on T5/T12; the host omitted it while the remote
        // already declared it.)
        '@tanstack/react-router': {
          singleton: true,
          requiredVersion: pkg.dependencies['@tanstack/react-router'],
        },
        // T4: the session module (./session) wraps a single better-auth
        // client instance; a second better-auth copy across the host↔remote
        // boundary would mean two independent auth-client instances (and,
        // via its cross-tab broadcast-channel, two signalling identities) —
        // singleton: true keeps it one instance for the whole suite, same
        // rationale as react/react-dom above.
        'better-auth': { singleton: true, requiredVersion: pkg.dependencies['better-auth'] },
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(suiteVersion),
  },
  build: {
    // Required by @module-federation/vite: federated chunks use top-level
    // await to resolve shared modules asynchronously at runtime.
    target: 'esnext',
    modulePreload: false,
  },
  // Pinned local-dev port for the suite host (5173 — a trusted origin in
  // auth's committed ALLOWED_ORIGINS default). strictPort fails fast rather
  // than silently drifting to another port the remotes/auth wouldn't trust.
  server: { port: 5173, strictPort: true, cors: true },
  preview: { port: 5173, strictPort: true, cors: true },
})
