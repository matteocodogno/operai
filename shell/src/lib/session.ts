/**
 * shell/session — the Operai suite's single shared session/runtime module.
 *
 * Extracted from estimai-ui/src/lib/api.ts + authClient.ts (T4, specs/003-suite-shell,
 * ADR-0001, ADR-0006). The shell exposes this module via Module Federation as
 * `./session` so every remote (estimai-ui, refund-ui, …) consumes ONE in-memory
 * JWT cache and ONE better-auth client instance for the whole suite, instead of
 * each tool holding its own copy. estimai-ui keeps its own copy of api.ts/
 * authClient.ts until it is rewired to consume `shell/session` (T13) — this
 * file is not imported by estimai-ui yet.
 *
 * JWT caching strategy (ADR-0001):
 *   The RS256 JWT is cached in module-scope memory only — never written to
 *   localStorage, sessionStorage, IndexedDB, or any other persistent storage.
 *   The 7-day session cookie managed by better-auth is the sole durable
 *   credential; the JWT is a derived, re-fetchable artifact.
 *
 * Refresh protocol (per ADR-0001):
 *   1. No JWT cached → fetch GET /auth/token, cache result, attach Bearer header.
 *   2. Request returns 401 → clear cache, re-fetch /auth/token once, retry once.
 *   3. Retry also returns 401 → clear cache, redirect to sign-in page with
 *      current URL as the `redirect` param.
 *
 * Trusted-origin policy (OWASP):
 *   The Bearer JWT is only attached when the request targets a trusted origin:
 *     • Same origin as the current page (relative URLs resolve here automatically).
 *     • The auth service origin (VITE_AUTH_URL).
 *     • The API service origin (VITE_API_URL), if that env var is defined.
 *     • The notify-api origin (VITE_NOTIFY_API_URL), if that env var is
 *       defined (T10, specs/005-notification-center) — trusted so
 *       `raiseNotification`/the SSE ticket mint/`GET /notifications/*` (this
 *       module's notification seam, notify-ui) go through this same
 *       Bearer-attach machinery.
 *     • The refund-api origin (VITE_REFUND_API_URL), if that env var is
 *       defined (T20, specs/007-refund-service — closes the drift flagged by
 *       refund-ui's own T14: `refund-ui/src/lib/refundApi.ts` read
 *       `VITE_REFUND_API_URL` and called through `apiFetch` from day one, but
 *       until this origin was added here every refund-api request went out
 *       WITHOUT the Bearer header and refund-api 401'd everything). Same
 *       shape as the notify-api entry above — refund-api is a sibling
 *       resource server, not the auth service, so it gets its own entry
 *       rather than reusing VITE_API_URL.
 *   Requests to any other origin proceed unauthenticated — no Authorization
 *   header is sent and credentials are not included cross-origin.
 *
 * Permission resolution (T23, specs/004-auth-roles-permissions, ADR-0007):
 *   Roles/permissions are deliberately NOT embedded in the JWT (only a
 *   forward-looking `perm_epoch` claim rides the token — see ADR-0007). The
 *   shell instead resolves the caller's effective permissions **live** via
 *   `GET /authz/me` on the auth service, through the same `apiFetch` machinery
 *   used for every other trusted-origin call (Bearer attach + 401 refresh/
 *   retry/redirect). The result is cached in module-scope memory only — never
 *   web storage (ADR-0001) — and is:
 *     • populated lazily by `ensurePermissions()` (first call fetches; later
 *       calls return the cache);
 *     • force-refreshed by `ensurePermissions({ force: true })` (aliased as
 *       `revalidatePermissions()`), which the shell's per-navigation route
 *       guard calls so a revoked grant disappears on the very next navigation
 *       (AC-7.5) instead of waiting for the JWT to expire;
 *     • concurrency-safe: overlapping callers while a fetch is in flight share
 *       the same in-flight promise rather than triggering duplicate requests;
 *     • cleared on `signOut()` alongside the JWT cache;
 *     • never thrown on failure — a missing session, a network error, or a
 *       non-2xx response all resolve to `EMPTY_PERMISSIONS` (`apps: []`) so
 *       the route guard can treat "no data" as "no access" uniformly instead
 *       of special-casing errors.
 */

import { useEffect, useState } from 'react'
import { authClient } from './authClient'

/** In-memory JWT cache (module scope — cleared on page reload, never persisted). */
let cachedJwt: string | null = null

/**
 * Returns the auth service base URL from the Vite environment.
 * Read lazily (not at module scope) so that tests can inject the value before
 * the first call without relying on module-evaluation order.
 */
const getAuthUrl = (): string => import.meta.env.VITE_AUTH_URL as string

/**
 * The auth service base URL (`VITE_AUTH_URL`), exposed for federated remotes.
 * A remote (e.g. admin-ui) building `/admin/*` or `/authz/*` request URLs MUST
 * use the SHELL's configured auth origin — remotes ship no `VITE_AUTH_URL` of
 * their own, so reading `import.meta.env.VITE_AUTH_URL` inside a remote yields
 * `undefined` (which collapses to a broken relative URL). Import this instead.
 */
export const getAuthBaseUrl = (): string => getAuthUrl()

/** Clears the in-memory JWT cache. */
export const clearJwtCache = (): void => {
  cachedJwt = null
}

/**
 * Resolves the origin of a RequestInfo | URL value.
 * Relative string paths (no scheme) resolve against window.location.href,
 * which means they share the current page's origin (always trusted).
 */
const resolveOrigin = (input: RequestInfo | URL): string => {
  let href: string
  if (input instanceof Request) {
    href = input.url
  } else if (input instanceof URL) {
    href = input.href
  } else {
    href = input
  }
  try {
    return new URL(href, window.location.href).origin
  } catch {
    // Unparseable URL — treat as same-origin (will fail at fetch level anyway).
    return new URL(window.location.href).origin
  }
}

/**
 * Returns the set of origins to which the Bearer JWT may be sent.
 * Built lazily so tests can inject VITE_AUTH_URL / VITE_API_URL before the
 * first call.
 *
 * The current-page origin is derived from window.location.href (not .origin)
 * so that test environments which mock location as a plain object without the
 * .origin accessor still resolve correctly.
 */
const getTrustedOrigins = (): Set<string> => {
  const currentOrigin = new URL(window.location.href).origin
  const trusted = new Set<string>([currentOrigin])

  const authUrl = import.meta.env.VITE_AUTH_URL as string | undefined
  if (authUrl) {
    try {
      trusted.add(new URL(authUrl).origin)
    } catch { /* ignore invalid env value */ }
  }

  const apiUrl = import.meta.env.VITE_API_URL as string | undefined
  if (apiUrl) {
    try {
      trusted.add(new URL(apiUrl).origin)
    } catch { /* ignore invalid env value */ }
  }

  // T10 (specs/005-notification-center): notify-api origin — raiseNotification,
  // the SSE stream-ticket mint, and GET /notifications/* (this module's
  // notification seam, notify-ui) all go through apiFetch too.
  const notifyUrl = import.meta.env.VITE_NOTIFY_API_URL as string | undefined
  if (notifyUrl) {
    try {
      trusted.add(new URL(notifyUrl).origin)
    } catch { /* ignore invalid env value */ }
  }

  // T20 (specs/007-refund-service, tasks.md "Trusted-origin fix"): refund-api
  // origin — refund-ui's requestsApi/reviewApi/attachments calls (all via
  // refund-ui/src/lib/refundApi.ts's getJson/sendJson/deleteJson, which
  // already call apiFetch) need the Bearer JWT attached the same way every
  // other resource server's calls do. Without this entry every refund-api
  // request 401s (ADR-0001: apiFetch only attaches Authorization to a
  // trusted origin).
  const refundUrl = import.meta.env.VITE_REFUND_API_URL as string | undefined
  if (refundUrl) {
    try {
      trusted.add(new URL(refundUrl).origin)
    } catch { /* ignore invalid env value */ }
  }

  return trusted
}

/**
 * Returns true when the request targets an origin the app trusts with its JWT.
 */
const isTrustedOrigin = (input: RequestInfo | URL): boolean =>
  getTrustedOrigins().has(resolveOrigin(input))

/**
 * Fetches a fresh RS256 JWT from the auth service token endpoint.
 * The endpoint is cookie-authenticated; no credentials are sent in the body.
 * Returns the JWT string, or null if the session is absent (auth service 401).
 */
const fetchJwt = async (): Promise<string | null> => {
  const response = await fetch(`${getAuthUrl()}/auth/token`, {
    credentials: 'include',
  })
  if (!response.ok) {
    return null
  }
  const body = (await response.json()) as { token: string }
  return body.token
}

/**
 * Ensures a JWT is present in the module-scope cache.
 * Fetches from /auth/token if the cache is empty.
 * Returns the JWT string, or null if the session is invalid/absent.
 */
const ensureJwt = async (): Promise<string | null> => {
  if (cachedJwt === null) {
    cachedJwt = await fetchJwt()
  }
  return cachedJwt
}

/**
 * Redirects the user to the auth service sign-in page.
 * Encodes the current absolute URL as the `redirect` query param so that
 * after sign-in the user is returned to where they were.
 */
const redirectToSignIn = (): void => {
  const redirect = encodeURIComponent(window.location.href)
  window.location.assign(`${getAuthUrl()}/sign-in?redirect=${redirect}`)
}

/**
 * Authenticated fetch wrapper.
 *
 * Drop-in replacement for the browser's `fetch` that attaches an
 * `Authorization: Bearer <jwt>` header to every request **targeting a trusted
 * origin** and handles token expiry transparently (one refresh + retry on 401,
 * then redirect to sign-in).
 *
 * Trusted origins: same-origin (relative URLs), VITE_AUTH_URL origin, and
 * VITE_API_URL origin (if defined). Requests to any other origin proceed
 * without the Authorization header and without credentials (OWASP).
 *
 * Note — verifying that the token identifies the correct user against the
 * auth service JWKS requires a live auth service and is covered at the
 * integration / e2e layer. The unit tests here cover the interceptor
 * contract only.
 */
export const apiFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const trusted = isTrustedOrigin(input)

  // For untrusted origins: pass through unauthenticated, without credentials.
  if (!trusted) {
    return fetch(input, init)
  }

  // Step 1: ensure a JWT is cached and attach it.
  const jwt = await ensureJwt()

  const makeHeaders = (token: string | null): HeadersInit => ({
    ...(init?.headers as Record<string, string> | undefined),
    ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
  })

  const firstResponse = await fetch(input, {
    ...init,
    credentials: 'include',
    headers: makeHeaders(jwt),
  })

  if (firstResponse.status !== 401) {
    return firstResponse
  }

  // Step 2: first 401 — drop the cached JWT, re-fetch once, retry.
  cachedJwt = null
  const refreshedJwt = await fetchJwt()
  cachedJwt = refreshedJwt

  const retryResponse = await fetch(input, {
    ...init,
    credentials: 'include',
    headers: makeHeaders(refreshedJwt),
  })

  if (retryResponse.status !== 401) {
    return retryResponse
  }

  // Step 3: second 401 — session is genuinely gone; clear cache and redirect.
  cachedJwt = null
  redirectToSignIn()

  // Return the response to satisfy the return type; the redirect is in flight.
  return retryResponse
}

/**
 * A single effective permission grant, as resolved by the auth service's
 * authorization resolver (union of direct + department-derived role rules,
 * de-duplicated by (resource, action) — widest condition wins; see plan.md
 * "Effective permissions (resolution)"). `conditions` is opaque here — the
 * shell does not evaluate ownership/attribute conditions itself; each app
 * enforces those against its own records (out of scope for this feature).
 */
export interface Permission {
  resource: string
  action: string
  conditions?: unknown
}

/** The `GET /authz/me` response shape (plan.md "API contracts"). */
export interface PermissionsResult {
  epoch: number
  apps: string[]
  roles: string[]
  departments: string[]
  permissions: Permission[]
}

/**
 * The denied/absent result used whenever the caller's permissions cannot be
 * determined (no session, network failure, non-2xx response). `apps: []`
 * means the route guard hides/blocks every app — "absence = no-access",
 * never a thrown error the guard would have to special-case.
 */
export const EMPTY_PERMISSIONS: PermissionsResult = Object.freeze({
  epoch: 0,
  apps: [],
  roles: [],
  departments: [],
  permissions: [],
})

/** In-memory permissions cache (module scope — cleared on sign-out, never persisted). */
let cachedPermissions: PermissionsResult | null = null

/** Shares one in-flight `/authz/me` request across concurrent callers. */
let inFlightPermissions: Promise<PermissionsResult> | null = null

/** Components subscribed via `usePermissions()`, notified when the cache changes. */
const permissionsListeners = new Set<(result: PermissionsResult) => void>()

const notifyPermissionsListeners = (result: PermissionsResult): void => {
  for (const listener of permissionsListeners) {
    listener(result)
  }
}

/**
 * Narrows an arbitrary decoded JSON body down to a well-formed
 * `PermissionsResult`, falling back to `EMPTY_PERMISSIONS` for anything that
 * doesn't match the contract shape (defensive — a malformed/absent body must
 * never crash the caller, per the "resolve, never throw" contract).
 */
const toPermissionsResult = (body: unknown): PermissionsResult => {
  if (typeof body !== 'object' || body === null) {
    return EMPTY_PERMISSIONS
  }
  const candidate = body as Partial<PermissionsResult>
  if (
    typeof candidate.epoch !== 'number' ||
    !Array.isArray(candidate.apps) ||
    !Array.isArray(candidate.roles) ||
    !Array.isArray(candidate.departments) ||
    !Array.isArray(candidate.permissions)
  ) {
    return EMPTY_PERMISSIONS
  }
  return {
    epoch: candidate.epoch,
    apps: candidate.apps,
    roles: candidate.roles,
    departments: candidate.departments,
    permissions: candidate.permissions,
  }
}

/**
 * Fetches the caller's live effective permissions from `GET /authz/me`.
 *
 * Goes through `apiFetch` — the same trusted-origin/Bearer-attach/401-refresh
 * machinery used for the JWT itself, since `/authz/me` is guarded by the same
 * session middleware as every other authenticated auth-service route (plan.md
 * "API contracts": `sessionMiddleware + requireAuth`). Never throws: a
 * non-2xx response (401 with no session, 5xx, …) or a network-level failure
 * both resolve to `EMPTY_PERMISSIONS`, matching the "absence = no-access"
 * contract the shell's route guard relies on.
 */
const fetchPermissions = async (): Promise<PermissionsResult> => {
  try {
    const response = await apiFetch(`${getAuthUrl()}/authz/me`)
    if (!response.ok) {
      return EMPTY_PERMISSIONS
    }
    return toPermissionsResult(await response.json())
  } catch {
    return EMPTY_PERMISSIONS
  }
}

/**
 * Ensures the caller's effective permissions are present in the module-scope
 * cache, fetching `GET /authz/me` only when needed.
 *
 * - First call (empty cache): fetches, caches the result, notifies any
 *   `usePermissions()` subscribers, and returns it.
 * - Subsequent calls: return the cached value without a network request.
 * - `{ force: true }` (aliased as `revalidatePermissions()`) always re-fetches
 *   and replaces the cache — used by the shell's per-navigation route guard
 *   so a revoked grant is gone on the very next navigation (AC-7.5).
 * - Concurrent callers while a (non-forced) fetch is already in flight share
 *   that single in-flight request instead of firing duplicate ones.
 */
export const ensurePermissions = async (
  options?: { force?: boolean },
): Promise<PermissionsResult> => {
  if (!options?.force) {
    if (cachedPermissions !== null) {
      return cachedPermissions
    }
    if (inFlightPermissions !== null) {
      return inFlightPermissions
    }
  }

  const request = fetchPermissions().then((result) => {
    cachedPermissions = result
    inFlightPermissions = null
    notifyPermissionsListeners(result)
    return result
  })
  inFlightPermissions = request
  return request
}

/**
 * Forces a fresh `GET /authz/me` fetch and replaces the cache.
 * Convenience alias for `ensurePermissions({ force: true })` — used by the
 * shell's per-navigation route guard (AC-7.5).
 */
export const revalidatePermissions = (): Promise<PermissionsResult> =>
  ensurePermissions({ force: true })

/**
 * Synchronously reads the module-scope permissions cache WITHOUT ever
 * fetching — `null` when nothing has been resolved yet this session (cold
 * cache: first tool navigation, hard refresh, deep link).
 *
 * `ensurePermissions`/`revalidatePermissions` are both `async` (they return
 * a Promise even on a cache hit), which is exactly why they're unsuitable
 * for the shell router's same-app fast path (router.tsx's
 * `createToolAccessBeforeLoad`): a route's `beforeLoad` must return a
 * non-Promise value to resolve SYNCHRONOUSLY within TanStack Router — the
 * instant it returns a Promise (even one that settles on the same tick),
 * the router enters its pending state and the `defaultPendingMs: 0` fallback
 * unmounts the current route's content while it "awaits". This getter is the
 * synchronous escape hatch: same-app navigation with a warm cache can check
 * the cached permissions and return/throw synchronously, so the mounted
 * remote is never torn down for an inner-route change.
 */
export const getCachedPermissions = (): PermissionsResult | null => cachedPermissions

/** Clears the in-memory permissions cache (does not notify subscribers with a fetch). */
export const clearPermissionsCache = (): void => {
  cachedPermissions = null
  inFlightPermissions = null
}

/**
 * React hook exposing the caller's resolved effective permissions.
 *
 * Mirrors how `useSession` is exposed: a component-friendly reactive read of
 * shared, module-scope state. Unlike `useSession` (backed by better-auth's
 * own reactive store), there is no external store here, so this hook
 * subscribes itself to the module-scope cache via a small listener set and
 * re-renders whenever `ensurePermissions()`/`revalidatePermissions()` resolve
 * a new value anywhere in the app.
 *
 * Returns `EMPTY_PERMISSIONS` synchronously on first render if the cache is
 * still empty, then updates once the initial `ensurePermissions()` fetch
 * resolves — never throws, never suspends.
 */
export function usePermissions(): PermissionsResult {
  const [permissions, setPermissions] = useState<PermissionsResult>(
    () => cachedPermissions ?? EMPTY_PERMISSIONS,
  )

  useEffect(() => {
    permissionsListeners.add(setPermissions)

    if (cachedPermissions === null) {
      void ensurePermissions()
    }

    return () => {
      permissionsListeners.delete(setPermissions)
    }
  }, [])

  return permissions
}

/**
 * Sign-out teardown hooks (T10, specs/005-notification-center, ADR-0009 R8).
 *
 * `signOut()` must close the shell's live SSE notification connection on
 * every identity change (notifications.ts's `closeSseConnection()`), so a
 * signed-out user's stream never lingers and the next sign-in reconnects
 * fresh, bound to the new identity. `session.ts` cannot import
 * `notifications.ts` directly to call that function — `notifications.ts`
 * already imports `apiFetch`/`onSignOut` from THIS module, and a reverse
 * static import would make the cycle two-directional at the declaration
 * level in a way that's harder to reason about. Instead, `notifications.ts`
 * registers its own teardown here (lazily — see its
 * `ensureSignOutTeardownRegistered`) via `onSignOut`, and `signOut()` below
 * just invokes whatever has been registered. Same "module holds a listener
 * set, exposes a register + notify pair" shape already used for
 * `permissionsListeners` above.
 */
const signOutHooks = new Set<() => void>()

/**
 * Registers a callback to run whenever `signOut()` is called, before the
 * better-auth client's own `signOut` and before the JWT/permissions caches
 * are cleared. Returns an unregister function (unused today — hooks
 * registered here are expected to live for the module's lifetime, mirroring
 * `usePermissions`'s listener set — but returning it costs nothing and
 * matches that same shape).
 */
export function onSignOut(hook: () => void): () => void {
  signOutHooks.add(hook)
  return () => {
    signOutHooks.delete(hook)
  }
}

/**
 * Session wrappers — the single better-auth client instance for the suite.
 *
 * getSession / useSession resolve the cookie-based session as-is (mirrors
 * estimai-ui/src/router.tsx's `_authed` guard usage, ADR-0002).
 *
 * signOut additionally clears the shared in-memory JWT cache and the
 * permissions cache *before* ending the better-auth session, so a suite-wide
 * sign-out invalidates every remote's cached Bearer token and resolved
 * permissions immediately rather than waiting for the next 401 or navigation
 * (plan.md federation contract: "authClient.signOut() — suite-wide sign-out;
 * clears the shared JWT cache + redirects"). It also runs every registered
 * sign-out hook (T10 — closes the shared SSE notification connection).
 */
export const getSession = authClient.getSession
export const useSession = authClient.useSession

export const signOut = async (
  ...args: Parameters<typeof authClient.signOut>
): Promise<Awaited<ReturnType<typeof authClient.signOut>>> => {
  clearJwtCache()
  clearPermissionsCache()
  for (const hook of signOutHooks) {
    hook()
  }
  try {
    return await authClient.signOut(...args)
  } finally {
    // Clearing the session client-side does NOT re-run the router's `_authed`
    // guard (it only redirects on navigation), so without an explicit redirect a
    // signed-out user is stranded on the now-session-less page (avatar gone, but
    // no login screen). Send them to the hosted sign-in page — the SAME target
    // the guard uses (`<AUTH_URL>/sign-in?redirect=<current URL>`, ADR-0002) — via
    // a full-document navigation. In a finally so it fires even if the better-auth
    // sign-out call rejects (e.g. a transient network error), which still leaves
    // the local caches cleared above.
    if (typeof window !== 'undefined') {
      const authUrl = import.meta.env.VITE_AUTH_URL as string
      window.location.href = `${authUrl}/sign-in?redirect=${encodeURIComponent(window.location.href)}`
    }
  }
}

/**
 * Suite-wide cross-remote navigation seam (follow-up to specs/005-notification-
 * center, T15/AC-2.5): a remote (e.g. notify-ui's `NotificationItem`) cannot
 * drive a client-side navigation into ANOTHER remote's route — each remote
 * runs its own inner TanStack Router scoped to its own `basepath` (`/notify`,
 * `/estimai`, …), and there is no shared router *instance* across the
 * federation boundary (ADR-0006: `@tanstack/react-router` is a shared MF
 * *library* singleton, not a shared router instance). Only the SHELL's
 * top-level router (basepath `/`, `shell/src/router.tsx`) knows every remote's
 * route, so cross-remote navigation must go through it.
 *
 * `registerSuiteNavigate` / `navigateSuite` form the same "module holds a
 * registry, exposes a register + invoke pair" shape already used for
 * `onSignOut` above — used here (instead of importing `router.tsx` directly)
 * to avoid a session↔router import cycle: `router.tsx` already imports
 * `ensurePermissions`/`getSession`/`revalidatePermissions` from THIS module,
 * so a reverse static import (this module importing the router instance)
 * would make the cycle bidirectional at the declaration level. Instead,
 * whichever code owns the router instance (`shell/src/main.tsx`) registers
 * its real `navigate` here once, and every caller — this module's own
 * `export`, and every remote that imports `shell/session` — calls the single
 * `navigateSuite(to)` function without needing to know the router exists.
 *
 * `navigateSuite` falls back to `window.location.assign(to)` (a full
 * document navigation) when nothing is registered yet — e.g. a call that
 * somehow races module init before `main.tsx`'s registration runs, or a test
 * that exercises this seam without a real router. That fallback still
 * reaches the right place (the shell owns every route), just via a full
 * reload instead of a client-side transition.
 */
const suiteNavigateRegistry: { fn: ((to: string) => void) | null } = { fn: null }

/**
 * Registers the shell's real navigate function (called once, from wherever
 * the router instance lives — `shell/src/main.tsx`). A later call replaces
 * any previous registration; there is exactly one shell router per tab, so
 * this is expected to be called at most once in production.
 */
export function registerSuiteNavigate(fn: (to: string) => void): void {
  suiteNavigateRegistry.fn = fn
}

/**
 * Navigates the suite to an absolute in-suite path (e.g. `/estimai/estimates/
 * 42`), routing through the shell's top-level router — the ONLY router
 * instance that spans every remote's basepath — instead of a plain document
 * navigation, so cross-remote clicks (e.g. a notification's link) feel like
 * an in-app transition rather than a full reload. Falls back to
 * `window.location.assign(to)` when the shell hasn't registered a navigate
 * function yet (see this seam's doc comment above).
 */
export function navigateSuite(to: string): void {
  if (suiteNavigateRegistry.fn) {
    suiteNavigateRegistry.fn(to)
    return
  }
  window.location.assign(to)
}

/**
 * Re-exports the shell's notification transport seam (T10,
 * specs/005-notification-center, ADR-0009) so it rides the suite's existing
 * `shell/session` federation export (vite.config.ts `exposes['./session']`)
 * — the same module every remote already imports for
 * `apiFetch`/`usePermissions`. See notifications.ts's file-level doc for why
 * this `export *` forms a safe ES-module cycle (notifications.ts imports
 * `apiFetch`/`onSignOut` from this file).
 */
export * from './notifications'
