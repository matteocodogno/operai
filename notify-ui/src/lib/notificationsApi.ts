/**
 * notificationsApi — typed client for the notify-api endpoints the
 * notification center itself calls (T15, specs/005-notification-center/tasks.md):
 * `GET /notifications` and `POST /notifications/mark-all-read`. Mirrors
 * `admin-ui/src/lib/adminApi.ts`'s conventions (typed request/response
 * shapes, `apiFetch` imported directly from the federated `shell/session`
 * module rather than a local facade, base URL from the shell not this
 * remote's own env — see `getNotifyBaseUrl`'s doc comment there).
 *
 * Wire types mirror notify-api's `notifications.schemas.ts` /
 * `shell/src/lib/notifications.ts`'s `Notification` shape verbatim. Kept in
 * sync by hand (no shared package between notify-api/shell/notify-ui); if
 * notify-api's contract changes, update here too.
 *
 * `raiseNotification`/`useUnreadCount`/`getNotifyBaseUrl`'s stream-manager
 * machinery all live in `shell/session` (T10) — this file only wraps the two
 * REST calls `NotificationCenterPage` itself needs, the same "one remote-
 * scoped API-client file" shape every other remote already has
 * (`estimai-ui/src/lib/estimatesApi.ts`, `admin-ui/src/lib/adminApi.ts`).
 */

import { apiFetch, getNotifyBaseUrl } from 'shell/session'
import type { NotificationOriginApp, NotificationSeverity } from './severity'

export type { NotificationOriginApp, NotificationSeverity }

/** An optional in-suite relative link carried by a notification (AC-2.5, AC-4.3). */
export interface NotificationLink {
  href: string
  label?: string
}

/** The shape notify-api returns for a single notification (list items / 201 / SSE payload). */
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

export interface ListNotificationsResponse {
  items: Notification[]
  nextCursor: string | null
}

export interface MarkAllReadResponse {
  updated: number
  count: 0
}

/**
 * `GET /notifications` — the caller's notifications, newest-first (AC-2.3),
 * `{ items: [], nextCursor: null }` for a caller with none (AC-2.4 — not an
 * error). Throws on a non-2xx response.
 */
export async function listNotifications(): Promise<ListNotificationsResponse> {
  const response = await apiFetch(`${getNotifyBaseUrl()}/notifications`)
  if (!response.ok) {
    throw new Error(`listNotifications failed: notify-api responded ${response.status}`)
  }
  return (await response.json()) as ListNotificationsResponse
}

/**
 * `POST /notifications/mark-all-read` — idempotent, harmless no-op when
 * nothing is unread (AC-3.4). Throws on a non-2xx response — callers treat
 * this as best-effort (see `NotificationCenterPage`'s doc comment: a failed
 * mark-all-read must never block rendering the already-fetched list).
 */
export async function markAllRead(): Promise<MarkAllReadResponse> {
  const response = await apiFetch(`${getNotifyBaseUrl()}/notifications/mark-all-read`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`markAllRead failed: notify-api responded ${response.status}`)
  }
  return (await response.json()) as MarkAllReadResponse
}
