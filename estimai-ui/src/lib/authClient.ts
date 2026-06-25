import { createAuthClient } from 'better-auth/react'

/**
 * better-auth client for estimai-ui.
 *
 * Pointed at VITE_AUTH_URL (set in .env.example; never hardcoded).
 *
 * Provides:
 *   authClient.useSession()   — reactive user/session state (React hook)
 *   authClient.getSession()   — promise-based session fetch (route guards, interceptors)
 *   authClient.signOut()      — ends the session (cookie-based)
 *
 * The auth service also exposes GET /auth/token (cookie-authenticated) which returns
 * the RS256 JWT consumed by api.ts (T6). That endpoint is reached directly via fetch
 * (not via this client) and the resulting token is cached in memory per ADR-0001.
 */
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_AUTH_URL,
})
