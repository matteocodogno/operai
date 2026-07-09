import { createRootRoute, createRouter } from '@tanstack/react-router'
import { SeedProbeMount } from './federation/SeedProbeMount'

// ---------------------------------------------------------------------------
// Walking-skeleton router for the Operai suite shell host.
//
// This is still a bare placeholder route (T1's "done when": the app boots,
// builds, and dev-serves). T2 adds the federation R1-gate proof below —
// `SeedProbeMount` loads the throwaway `mf-seed-remote`'s exposed component
// via Module Federation and asserts a shared React singleton across the
// host↔remote boundary. This is a temporary probe mount, not real routing:
// the pathless `_authed` session guard and the `/estimai/*` / `/refund/*`
// tool routes are built up in T9/T10 and will replace this. Do not add
// further routing/auth logic here ahead of those tasks.
// ---------------------------------------------------------------------------

const rootRoute = createRootRoute({
  component: () => (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ink font-body text-text">
      <p className="font-disp text-lg">Operai suite shell</p>
      <SeedProbeMount />
    </main>
  ),
})

const routeTree = rootRoute.addChildren([])

export const router = createRouter({ routeTree })

// TypeScript registration
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
