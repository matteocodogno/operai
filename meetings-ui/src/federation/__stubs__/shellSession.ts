// Test-only resolution stub for the `shell/session` federated module
// (specs/021-meetings). vitest.config.ts aliases the specifier here so Vite's import
// analysis can resolve it; every test that relies on shell/session overrides
// these exports with vi.mock. In production the specifier resolves through
// @module-federation/vite (vite.config.ts `remotes`).
export const useSession = () => ({ data: null })
export const apiFetch = async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)
export const getMeetingsApiBaseUrl = () => ''
export const getAuthBaseUrl = () => ''
export const navigateSuite = (to: string): void => {
  window.location.assign(to)
}

// The shell's navigation blocker seam (AC-2.10). A shell that predates it has no
// such export, so the real caller feature-detects; the stub always has it and returns
// the unregister function.
// Takes (shouldBlock, message) in production; the stub ignores both.
export const registerNavigationBlocker = (): (() => void) => () => undefined

// No capability by default: a test of something capability-gated says what it grants.
export const usePermissions = () => ({
  epoch: 0,
  apps: [] as string[],
  roles: [] as string[],
  departments: [] as string[],
  permissions: [] as { resource: string; action: string; conditions?: unknown }[],
})
