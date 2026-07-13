// Test-only resolution stub for the `shell/session` federated module (T14,
// specs/005-notification-center). Mirrors admin-ui/src/federation/__stubs__/
// shellSession.ts's rationale exactly: Vite's import-analysis needs a real,
// resolvable module for every static import specifier in a transformed file
// — even one a test's `vi.mock('shell/session', factory)` fully overrides
// once resolution has found something. In production, `shell/session`
// resolves via the real `@module-federation/vite` runtime (see
// ../../../vite.config.ts's `remotes` + ../remotes.d.ts's ambient type
// declaration); `vitest.config.ts` runs without that plugin, so it aliases
// the bare specifier here instead (see vitest.config.ts's `resolve.alias`).
// Every test file that imports App.tsx/notificationsApi.ts overrides this via
// vi.mock — these exports are never actually used for real values.
export const useSession = () => ({ data: null })
export const getSession = async () => null
export const apiFetch = async (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)
export const getAuthBaseUrl = () => (import.meta.env.VITE_AUTH_URL as string | undefined) ?? ''
export const signOut = async () => undefined
export const clearJwtCache = () => undefined
// T15 (specs/005-notification-center/tasks.md): notificationsApi.ts imports
// these two (T10's shell/session seam) — same never-actually-used rationale.
export const getNotifyBaseUrl = () => (import.meta.env.VITE_NOTIFY_API_URL as string | undefined) ?? ''
export const resetUnreadCount = () => undefined
// Follow-up (specs/005-notification-center, ADR-0006-consistent):
// NotificationItem.tsx imports this for cross-remote, no-full-reload
// navigation — same never-actually-used rationale (every test that renders
// NotificationItem with a link overrides this via vi.mock('shell/session', ...)).
export const navigateSuite = () => undefined
