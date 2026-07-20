// Test-only resolution stub for the `shell/session` federated module (T13,
// specs/004-auth-roles-permissions). Mirrors
// refund-ui/src/federation/__stubs__/shellSession.ts's rationale exactly:
// Vite's import-analysis needs a real, resolvable module for every static
// import specifier in a transformed file — even one a test's
// `vi.mock('shell/session', factory)` fully overrides once resolution has
// found something. In production, `shell/session` resolves via the real
// `@module-federation/vite` runtime (see ../../../vite.config.ts's
// `remotes` + ../remotes.d.ts's ambient type declaration); `vitest.config.ts`
// runs without that plugin, so it aliases the bare specifier here instead
// (see vitest.config.ts's `resolve.alias`). Every test file that imports
// App.tsx overrides this via vi.mock — these exports are never actually
// used.
export const useSession = () => ({ data: null })
export const getSession = async () => null
export const apiFetch = async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)
export const getAuthBaseUrl = () => (import.meta.env.VITE_AUTH_URL as string | undefined) ?? ''
export const getRefundApiBaseUrl = () => (import.meta.env.VITE_REFUND_API_URL as string | undefined) ?? ''
export const signOut = async () => undefined
export const clearJwtCache = () => undefined
