// Test-only resolution stub for the `shell/session` federated module
// (specs/029-time-tracking). vitest.config.ts aliases the specifier here so Vite's import
// analysis can resolve it; every test that relies on shell/session overrides
// these exports with vi.mock (src/test-support/fakeSession.ts builds the usual factory).
// In production the specifier resolves through @module-federation/vite
// (vite.config.ts `remotes`).
export const apiFetch = async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)
export const getHoursApiBaseUrl = () => ''
export const getProjectsApiBaseUrl = () => ''
export const getCrmApiBaseUrl = () => ''
export const getMeetingsApiBaseUrl = () => ''
export const getActivitiesApiBaseUrl = () => ''

// No capability by default: a test of something capability-gated says what it grants.
export const usePermissions = () => ({
  epoch: 0,
  apps: [] as string[],
  roles: [] as string[],
  departments: [] as string[],
  permissions: [] as { resource: string; action: string; conditions?: unknown }[],
})
