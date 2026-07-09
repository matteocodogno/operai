import { createAuthClient } from 'better-auth/react'

/**
 * better-auth client for the Operai suite shell.
 *
 * Extracted from estimai-ui/src/lib/authClient.ts (T4, specs/003-suite-shell) —
 * the shell now owns the ONE better-auth client instance for the whole suite;
 * remotes consume it indirectly via `shell/session` instead of holding their
 * own copy (ADR-0001, ADR-0006). estimai-ui keeps its own copy until it is
 * rewired to consume `shell/session` (T13); this file is not imported by
 * estimai-ui.
 *
 * Pointed at VITE_AUTH_URL (set in .env.example; never hardcoded).
 *
 * Provides:
 *   authClient.useSession()   — reactive user/session state (React hook)
 *   authClient.getSession()   — promise-based session fetch (route guards, interceptors)
 *   authClient.signOut()      — ends the session (cookie-based)
 *
 * The auth service also exposes GET /auth/token (cookie-authenticated) which returns
 * the RS256 JWT consumed by session.ts. That endpoint is reached directly via fetch
 * (not via this client) and the resulting token is cached in memory per ADR-0001.
 */
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_AUTH_URL,
  // The auth service registers better-auth routes under /auth (basePath in auth.config.ts).
  // Without this, better-auth/react defaults to /api/auth, which returns 404.
  basePath: '/auth',
})
