/**
 * shell/notifications — the shell-owned notification transport seam (T10,
 * specs/005-notification-center, plan.md "Shell changes", design.md,
 * ADR-0008, ADR-0009).
 *
 * This module is the ONLY place notification transport/session glue lives in
 * the shell (ADR-0009 Constraint 4 — "no notification business logic lives
 * here"). It owns:
 *   - `raiseNotification()`      — the raise-capability seam (US-4): wraps
 *     `apiFetch(POST {notifyBase}/notifications)`. The request type has no
 *     `recipient` field at all — the server derives `recipientId` from the
 *     JWT `sub` unconditionally (notify-api's RaiseNotificationSchema, OWASP
 *     A01); the wire contract already forbids sending one.
 *   - `useUnreadCount()`         — the single, suite-wide unread-count
 *     read, SSE-driven and REST-seeded. Mirrors `usePermissions()`'s
 *     module-scope-state + listener-set + `useState` pattern in session.ts
 *     (this codebase's established shape for "shared live state exposed to
 *     React components without a store library").
 *   - `resetUnreadCount()`       — optimistic local zero (AC-3.1), called by
 *     notify-ui the instant the center opens.
 *   - `getNotifyBaseUrl()`       — reads `VITE_NOTIFY_API_URL`, mirrors
 *     `getAuthBaseUrl()` in session.ts.
 *   - `subscribeToasts()`        — the toast-worthy-event subscription seam
 *     `ToastHost` (T12) consumes; not itself a UI component.
 *   - The internal SSE connection manager: mints a stream ticket
 *     (ADR-0008), opens one `EventSource` per tab, dispatches `notification`/
 *     `unread-reset` events, and reconnects (with a FRESH ticket — a
 *     consumed ticket is worthless, ADR-0008) on error/disconnect,
 *     re-syncing the count from REST on every (re)connect (plan.md Risk R3).
 *
 * Circular-import note: this file imports `apiFetch`/`onSignOut` from
 * `./session`, and `session.ts` re-exports this module's surface (`export *
 * from './notifications'`) so the whole thing rides the suite's existing
 * `shell/session` federation export (plan.md: "exposed via shell/session's
 * existing ./session federation export — same module the suite already
 * imports for apiFetch/usePermissions"). That is a genuine ES-module import
 * cycle. It is safe ONLY because nothing at this module's top level touches
 * a `session.ts` binding that might still be mid-initialization on the other
 * side of the cycle — every use of `apiFetch`/`onSignOut` happens inside a
 * function body, invoked long after both modules have finished evaluating.
 * `registerSignOutTeardown()` below exists specifically to keep the ONE
 * exception (registering a sign-out hook) lazy for the same reason — see its
 * doc comment.
 */

import { useEffect, useState } from 'react'
import { apiFetch, onSignOut } from './session'

// ---------------------------------------------------------------------------
// Wire types — mirror notify-api's notifications.schemas.ts verbatim
// (NotificationSchema / RaiseNotificationSchema / LinkSchema / severity +
// originApp enums). Kept in sync by hand (no shared package between
// notify-api and the shell); if notify-api's contract changes, update here.
// ---------------------------------------------------------------------------

/** Known Operai suite tool ids that can originate a notification (notify-api's ORIGIN_APPS). */
export type NotificationOriginApp = 'estimai' | 'refund' | 'admin'

/** notify-api's severity enum. */
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'

/** An optional in-suite relative link carried by a notification. */
export interface NotificationLink {
  href: string
  label?: string
}

/** The shape returned by notify-api for a single notification (201 / list items / SSE payload). */
export interface Notification {
  id: string
  title: string
  body: string
  severity: NotificationSeverity
  originApp: NotificationOriginApp
  link?: NotificationLink
  toastWorthy: boolean
  readAt: string | null
  createdAt: string
}

/**
 * `POST /notifications` request body (RaiseNotificationSchema). Deliberately
 * has NO `recipient`/`recipientId` field — v1 always targets the caller
 * (JWT `sub`); this is the forward-compat seam ADR-0009 documents (a future
 * `recipient` field is additive, not a breaking change to this type).
 */
export interface RaiseNotificationInput {
  title: string
  body: string
  severity?: NotificationSeverity
  originApp: NotificationOriginApp
  link?: NotificationLink
  toast?: boolean
}

// ---------------------------------------------------------------------------
// getNotifyBaseUrl — mirrors getAuthBaseUrl (session.ts)
// ---------------------------------------------------------------------------

/**
 * Returns the notify-api base URL from the Vite environment. Read lazily
 * (not at module scope) so tests can inject the value before the first call,
 * exactly like `getAuthBaseUrl`/`getAuthUrl` in session.ts.
 */
const getNotifyUrl = (): string => import.meta.env.VITE_NOTIFY_API_URL as string

/**
 * The notify-api base URL (`VITE_NOTIFY_API_URL`), exposed for federated
 * remotes (notify-ui builds `GET /notifications`/`POST /mark-all-read` URLs
 * against this; any other remote raising a notification builds `POST
 * /notifications` against it too). Mirrors `getAuthBaseUrl` exactly.
 */
export const getNotifyBaseUrl = (): string => getNotifyUrl()

// ---------------------------------------------------------------------------
// raiseNotification — the raise-capability seam (US-4, AC-4.1..4.5)
// ---------------------------------------------------------------------------

/**
 * Raises a notification for the CALLING user. Wraps `apiFetch(POST
 * {notifyBase}/notifications)` — the trusted-origin/Bearer-attach machinery
 * already used for every other Operai API call. `RaiseNotificationInput` has
 * no recipient field (see its doc comment) — notify-api derives
 * `recipientId` from the JWT `sub` unconditionally, so there is nothing for
 * a caller to spoof (OWASP A01).
 *
 * Throws on a non-2xx response (400 validation failure, 401, 413 body too
 * large) — validation failures surface to the RAISING app's own code
 * (design.md Flow 6: "each app author is responsible for handling that
 * error in their own call site"), not to any shared shell UI.
 */
export async function raiseNotification(input: RaiseNotificationInput): Promise<Notification> {
  const response = await apiFetch(`${getNotifyBaseUrl()}/notifications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(`raiseNotification failed: notify-api responded ${response.status}`)
  }

  return (await response.json()) as Notification
}

// ---------------------------------------------------------------------------
// useUnreadCount / resetUnreadCount — module-scope state + listener set,
// same shape as usePermissions() in session.ts.
// ---------------------------------------------------------------------------

/** The suite's single shared unread count (module scope — one per tab). */
let unreadCount = 0

/** Components subscribed via `useUnreadCount()`, notified when the count changes. */
const unreadCountListeners = new Set<(count: number) => void>()

const setUnreadCount = (count: number): void => {
  unreadCount = count
  for (const listener of unreadCountListeners) {
    listener(count)
  }
}

/**
 * React hook exposing the suite's shared unread notification count.
 *
 * SSE-driven (a `notification` event increments it; an `unread-reset` event
 * zeroes it) and REST-seeded (every SSE (re)connect re-syncs from `GET
 * /notifications/unread-count` — plan.md Risk R3/R4: the server is always
 * the authority, SSE-driven local changes are hints only). Lazily opens the
 * tab's one shared SSE connection on first mount (mirrors
 * `usePermissions()`'s lazy `ensurePermissions()` call in its `useEffect`).
 *
 * Returns `0` synchronously on first render if nothing has been seeded yet
 * (mirrors `usePermissions()` returning `EMPTY_PERMISSIONS` before its first
 * fetch resolves) — never throws, never suspends.
 */
export function useUnreadCount(): number {
  const [count, setCount] = useState<number>(() => unreadCount)

  useEffect(() => {
    unreadCountListeners.add(setCount)
    ensureSseConnection()

    return () => {
      unreadCountListeners.delete(setCount)
    }
  }, [])

  return count
}

/**
 * Optimistic local zero (AC-3.1) — called by notify-ui the instant the
 * center opens, for an immediate badge clear in the acting tab. The
 * server-side `unread-reset` SSE event (published by `POST
 * /notifications/mark-all-read`) reconciles every sibling tab.
 */
export function resetUnreadCount(): void {
  setUnreadCount(0)
}

// ---------------------------------------------------------------------------
// subscribeToasts — the toast-worthy-event subscription seam (US-5).
// ToastHost (T12) is the consumer; this module only ever PRODUCES events —
// it renders nothing and decides nothing about HOW a toast looks (ADR-0009:
// "the shell renders exactly what notify-api decides").
// ---------------------------------------------------------------------------

/** Emitted for every SSE `notification` event whose `toastWorthy` flag is true. */
export interface ToastEvent {
  notification: Notification
}

const toastListeners = new Set<(event: ToastEvent) => void>()

const emitToast = (notification: Notification): void => {
  const event: ToastEvent = { notification }
  for (const listener of toastListeners) {
    listener(event)
  }
}

/**
 * Subscribes to toast-worthy notification events (US-5, AC-5.1/5.5).
 * Returns an unsubscribe function. `ToastHost` (T12) is the intended
 * consumer — this seam intentionally carries no rendering/dismissal/timing
 * logic, only "a toast-worthy notification just arrived."
 */
export function subscribeToasts(listener: (event: ToastEvent) => void): () => void {
  toastListeners.add(listener)
  return () => {
    toastListeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// Internal SSE connection manager (ADR-0008, ADR-0009, plan.md "SSE stream
// authentication", Risks R3/R4/R8).
//
// One EventSource per tab, opened lazily on first `useUnreadCount()` mount.
// Sequence per (re)connect:
//   1. mint a ticket:  apiFetch(POST {notifyBase}/notifications/stream-ticket)
//   2. open:           new EventSource({notifyBase}/notifications/stream?ticket=<t>)
//   3. re-sync count:  GET {notifyBase}/notifications/unread-count (covers
//      anything raised while this tab had no live connection — R3/R5, SSE is
//      a nudge, the DB is the source of truth)
//   4. on 'notification': optimistic local increment (a hint — R4) + a
//      fire-and-forget REST re-sync to reconcile; toastWorthy → emitToast()
//   5. on 'unread-reset': zero the count (server truth, e.g. after
//      mark-all-read from ANY tab)
//   6. on error/disconnect: close the EventSource (stops the browser's OWN
//      built-in reconnect-to-the-same-URL behavior — critical, since the
//      ticket in that URL is now single-use-consumed and would 401 forever)
//      and reconnect from step 1 with a FRESH ticket, after a short backoff.
// ---------------------------------------------------------------------------

/** Backoff before minting a fresh ticket + reconnecting after an SSE error. */
const RECONNECT_DELAY_MS = 1000

interface SseConnectionState {
  eventSource: EventSource | null
  connecting: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

const connectionState: SseConnectionState = {
  eventSource: null,
  connecting: false,
  reconnectTimer: null,
}

/**
 * Re-syncs the shared unread count from server truth. Best-effort: a failed
 * fetch leaves the count as-is rather than throwing — the next successful
 * event or reconnect will reconcile it (plan.md R3).
 */
async function syncUnreadCountFromRest(): Promise<void> {
  try {
    const response = await apiFetch(`${getNotifyBaseUrl()}/notifications/unread-count`)
    if (!response.ok) {
      return
    }
    const body = (await response.json()) as { count: number }
    setUnreadCount(body.count)
  } catch {
    // Network failure — best-effort only, see doc comment above.
  }
}

/**
 * Mints a fresh, single-use SSE handshake ticket via the normal Bearer/JWKS
 * path (ADR-0008). Returns `null` (rather than throwing) when the mint
 * fails — e.g. the caller is signed out, in which case there is nothing to
 * connect to yet; a later `ensureSseConnection()` call (the next
 * `useUnreadCount()` mount, or the reconnect path below) tries again.
 */
async function mintStreamTicket(): Promise<string | null> {
  try {
    const response = await apiFetch(`${getNotifyBaseUrl()}/notifications/stream-ticket`, {
      method: 'POST',
    })
    if (!response.ok) {
      return null
    }
    const body = (await response.json()) as { ticket: string; expiresIn: number }
    return body.ticket
  } catch {
    return null
  }
}

function handleNotificationEvent(raw: string): void {
  let notification: Notification
  try {
    notification = JSON.parse(raw) as Notification
  } catch {
    // Malformed payload — ignore; a subsequent event/reconnect still
    // reconciles the count from REST.
    return
  }

  // Optimistic local increment (a hint only, R4) — every open tab reflects
  // the push within ~2s (AC-1.4/1.5) without waiting on the network.
  setUnreadCount(unreadCount + 1)
  // Reconcile with server truth in the background (R4: "local increments
  // are hints only").
  void syncUnreadCountFromRest()

  if (notification.toastWorthy) {
    emitToast(notification)
  }
}

function handleUnreadResetEvent(): void {
  setUnreadCount(0)
}

function clearReconnectTimer(): void {
  if (connectionState.reconnectTimer !== null) {
    clearTimeout(connectionState.reconnectTimer)
    connectionState.reconnectTimer = null
  }
}

function teardownEventSource(): void {
  if (connectionState.eventSource) {
    // .close() is essential here, not optional: it stops EventSource's OWN
    // built-in retry-to-the-same-URL behavior. That URL's ticket is
    // single-use and already consumed — the browser's native retry would
    // just 401 forever. We reconnect ourselves, with a fresh ticket.
    connectionState.eventSource.close()
    connectionState.eventSource = null
  }
}

function scheduleReconnect(): void {
  if (connectionState.reconnectTimer !== null) {
    return
  }
  connectionState.reconnectTimer = setTimeout(() => {
    connectionState.reconnectTimer = null
    void openConnection()
  }, RECONNECT_DELAY_MS)
}

async function openConnection(): Promise<void> {
  if (connectionState.connecting || connectionState.eventSource) {
    return
  }
  connectionState.connecting = true

  const ticket = await mintStreamTicket()
  if (!ticket) {
    connectionState.connecting = false
    // No session to mint against right now (e.g. signed out) — nothing to
    // retry from in here; the next useUnreadCount() mount (a fresh sign-in)
    // or an explicit ensureSseConnection() call tries again.
    return
  }

  const es = new EventSource(
    `${getNotifyBaseUrl()}/notifications/stream?ticket=${encodeURIComponent(ticket)}`,
  )
  connectionState.eventSource = es
  connectionState.connecting = false

  es.addEventListener('notification', (event) => {
    handleNotificationEvent((event as MessageEvent<string>).data)
  })
  es.addEventListener('unread-reset', () => {
    handleUnreadResetEvent()
  })
  es.onerror = () => {
    teardownEventSource()
    // R3: reconcile whatever was missed while the connection was down, then
    // reconnect with a FRESH ticket (a consumed/expired one is worthless).
    void syncUnreadCountFromRest()
    scheduleReconnect()
  }

  // Seed/re-sync the count for this (re)connect — covers anything raised
  // while this tab had no live connection (R3, and the AC-5.6 mechanism).
  void syncUnreadCountFromRest()
}

/**
 * Lazily opens the tab's one shared SSE connection if it isn't already open
 * or in the process of opening. Safe to call repeatedly (every
 * `useUnreadCount()` mount calls it) — a no-op once connected.
 */
function ensureSseConnection(): void {
  ensureSignOutTeardownRegistered()
  if (connectionState.eventSource || connectionState.connecting) {
    return
  }
  void openConnection()
}

/**
 * Closes the tab's SSE connection and resets all connection-manager state,
 * without attempting to reopen it. Exported for tests; the sign-out
 * teardown below is the production caller (ADR-0009 R8).
 */
export function closeSseConnection(): void {
  clearReconnectTimer()
  connectionState.connecting = false
  teardownEventSource()
}

// ---------------------------------------------------------------------------
// Sign-out teardown (ADR-0009 R8, plan.md "signOut closes + reconnects").
//
// session.ts's signOut() must close this tab's live SSE connection on every
// identity change so a signed-out user's stream never lingers, and so the
// NEXT sign-in (same tab, no full page reload) reconnects fresh, bound to
// the new identity, rather than reusing stale connection state. Registration
// is deliberately LAZY (called from inside ensureSseConnection(), never at
// this module's top level) — see the file-level "Circular-import note"
// above: `onSignOut` lives in session.ts, which re-exports this whole
// module, so a top-level call here could run before session.ts has finished
// its own top-level evaluation on the other side of the cycle. Registering
// lazily, the first time a real consumer (useUnreadCount) actually mounts,
// sidesteps that entirely — by then the whole module graph has settled.
// ---------------------------------------------------------------------------

let signOutTeardownRegistered = false

function ensureSignOutTeardownRegistered(): void {
  if (signOutTeardownRegistered) {
    return
  }
  signOutTeardownRegistered = true
  onSignOut(() => {
    // Close only — deliberately NOT an eager reconnect attempt here. An
    // eager `ensureSseConnection()` right after sign-out would fire an
    // unawaited async chain (mint → maybe-401 → apiFetch's own
    // refresh/retry/redirect dance) that can easily outlive signOut()'s own
    // caller, which is exactly the kind of dangling work that turns into an
    // unhandled rejection once whatever triggered it (a component, a test)
    // has already gone away. "Closing and re-establishing the connection on
    // every identity change" (ADR-0009 R8) still holds: closeSseConnection()
    // fully resets connection-manager state, so the NEXT real trigger — a
    // `useUnreadCount()` mount for whichever identity is signed in next
    // (AC-6.3) — opens a correct, fresh connection on its own via the
    // existing `ensureSseConnection()` call in its effect. Nothing here
    // needs to force that eagerly.
    closeSseConnection()
  })
}
