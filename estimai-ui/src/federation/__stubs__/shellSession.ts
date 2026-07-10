// Test-only resolution stub for the `shell/session` federated module (T13,
// specs/003-suite-shell/tasks.md).
//
// Vite's import-analysis needs a real, resolvable module for every
// static import specifier in a transformed file — even one a test's
// `vi.mock('shell/session', factory)` fully overrides once resolution has
// found something (vi.mock replaces a module's CONTENT, it can't stand in
// for resolution itself). In production, `shell/session` resolves via the
// real `@module-federation/vite` runtime (see ../../../vite.config.ts's
// `remotes` + ../remotes.d.ts's ambient type declaration); vitest.config.ts
// runs without that plugin (no live remoteEntry.js in a unit-test run), so
// it aliases the bare specifier here instead (see vitest.config.ts's
// `resolve.alias`) — mirrors shell/src/federation/__stubs__/estimaiApp.tsx's
// own approach exactly, in the other direction.
//
// Every test that needs REAL apiFetch/session behavior mocks `./lib/api` /
// `./lib/authClient` directly (the existing estimai-ui suite already does
// this everywhere — see EstimatorApp.test.tsx, EstimatesPage.test.tsx,
// ConfirmDeleteModal.test.tsx, ImportOfferModal.test.tsx, estimatesApi.test.ts),
// so those tests never load this stub's real body. The handful of tests that
// DO exercise this stub (src/lib/api.test.ts, src/lib/authClient.test.ts,
// src/router.test.tsx) only assert delegation — that `./api`/`./authClient`
// re-export these exact bindings — or exercise a route (e.g. /share) that
// never calls apiFetch/getSession itself. `apiFetch` therefore rejects
// loudly if ever actually invoked unmocked, rather than silently
// succeeding with fabricated data: the real interceptor contract (JWT
// refresh circuit, trusted-origin guard, sign-in redirect) is owned and
// tested by shell/src/lib/session.ts + shell/src/lib/session.test.ts now.
export const apiFetch = (): Promise<Response> =>
  Promise.reject(
    new Error(
      'shell/session stub: apiFetch was called without being mocked. ' +
        "Add vi.mock('shell/session', …) (or mock './lib/api') in this test.",
    ),
  )

export const clearJwtCache = (): void => {}

export const getSession = (): Promise<null> => Promise.resolve(null)

export const useSession = (): { data: null } => ({ data: null })

export const signOut = (): Promise<void> => Promise.resolve()
