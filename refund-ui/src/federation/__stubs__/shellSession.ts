// Test-only resolution stub for the `shell/session` federated module (T15,
// specs/003-suite-shell). Mirrors shell/src/federation/__stubs__/estimaiApp.tsx's
// rationale exactly: Vite's import-analysis needs a real, resolvable module
// for every static import specifier in a transformed file — even one a
// test's `vi.mock('shell/session', factory)` fully overrides once resolution
// has found something. In production, `shell/session` resolves via the real
// `@module-federation/vite` runtime (see ../../../vite.config.ts's `remotes`
// + ../remotes.d.ts's ambient type declaration); `vitest.config.ts` runs
// without that plugin, so it aliases the bare specifier here instead (see
// vitest.config.ts's `resolve.alias`). Every test file that imports App.tsx
// overrides this via vi.mock — these exports are never actually used.
export const useSession = () => ({ data: null })
export const getSession = async () => null
export const apiFetch = async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)
export const signOut = async () => undefined
export const clearJwtCache = () => undefined

// usePermissions (specs/004-auth-roles-permissions) — added for RefundShell's
// client-side accounting-tab gate (specs/008-refund-monthly-processing
// follow-up). Unlike the other exports above, App.test.tsx does NOT
// vi.mock('shell/session') and so resolves straight to this stub — its nav
// assertions (App.test.tsx: "nav links carry the /refund basepath") expect
// the pre-existing three-tab nav, so this default grants an unconditioned
// request:review rather than mirroring EMPTY_PERMISSIONS. router.test.tsx and
// RefundShell.test.tsx both override this via vi.mock to exercise the gate
// itself (including the EMPTY_PERMISSIONS/no-grant cases) in isolation.
export const usePermissions = () => ({
  epoch: 0,
  apps: ['refund'] as string[],
  roles: [] as string[],
  departments: [] as string[],
  permissions: [{ resource: 'request', action: 'review' }] as {
    resource: string
    action: string
    conditions?: unknown
  }[],
})
