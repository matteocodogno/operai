import { createRootRoute, createRouter } from '@tanstack/react-router'

// ---------------------------------------------------------------------------
// Walking-skeleton router for the Operai suite shell host.
//
// This is a bare placeholder: a single root route rendering a static page.
// It exists only so the app boots, builds, and dev-serves (T1's "done when").
// The real shell — the federation walking skeleton (T2), the pathless
// `_authed` session guard, and the `/estimai/*` / `/refund/*` tool routes —
// is built up in later tasks (T2, T9, T10). Do not add routing/auth logic
// here ahead of those tasks.
// ---------------------------------------------------------------------------

const rootRoute = createRootRoute({
  component: () => (
    <main className="flex min-h-screen items-center justify-center bg-white text-neutral-900">
      <p className="font-sans text-lg">Operai suite shell</p>
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
