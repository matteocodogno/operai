// Test-only resolution stub for the `shell/session` federated module (T24,
// specs/015-hardware-inventory). Mirrors refund-ui's stub: Vite's import
// analysis needs a resolvable module for every static import specifier even
// when a test's `vi.mock('shell/session', factory)` overrides it afterwards;
// in production the specifier resolves through `@module-federation/vite`
// (vite.config.ts `remotes`, typed by ../remotes.d.ts). vitest.config.ts
// aliases it here. Every test that touches shell/session overrides these
// exports with vi.mock — the values below are never relied on.
export const useSession = () => ({ data: null })
export const getSession = async () => null
export const apiFetch = async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)
export const signOut = async () => undefined
export const clearJwtCache = () => undefined
export const getInventoryApiBaseUrl = () => ''
export const getAuthBaseUrl = () => ''

// No capability by default: a test that renders something capability-gated
// must say which capabilities it grants.
export const usePermissions = () => ({
  epoch: 0,
  apps: [] as string[],
  roles: [] as string[],
  departments: [] as string[],
  permissions: [] as { resource: string; action: string; conditions?: unknown }[],
})
