/**
 * @vitest-environment jsdom
 *
 * Component tests for NotificationCenterPage (T15,
 * specs/005-notification-center/tasks.md). Mocks `../lib/notificationsApi`
 * (module-level, mirrors admin-ui/src/pages/UsersPage.test.tsx's
 * `vi.mock('../lib/adminApi', ...)`) and `shell/session`'s `resetUnreadCount`
 * (this page's only direct import from it).
 *
 * Covers every "done when" bullet of T15:
 *   (A) populated list + newest-first ordering (AC-2.3)
 *   (B) empty state (AC-2.4)
 *   (C) loading (skeleton)
 *   (D) error + Retry
 *   (E) "was-unread" affordance present on first mount, absent on a fresh
 *       remount (AC-3.2/3.3 — design.md's page-only reconciliation)
 *   (F) mark-all-read invoked on open: `resetUnreadCount()` THEN
 *       `POST /notifications/mark-all-read` (AC-3.1)
 *   (G) the explicit "Mark all as read" control (AC-3.4)
 *   (H) a linked item renders as a real anchor with the correct in-suite href
 *       (AC-2.5) — the actual cross-remote navigation is a real browser
 *       navigation handled by the shell's top-level router, exercised at the
 *       e2e level (T21), not simulable via a same-page router harness
 *
 * NotificationCenterPage itself never touches `@tanstack/react-router`
 * directly (NotificationItem renders a plain `<a href>`, not a `<Link>`,
 * see NotificationItem.tsx), so no router harness/context is needed here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import NotificationCenterPage from './NotificationCenterPage'
import type { ListNotificationsResponse, Notification } from '../lib/notificationsApi'

vi.mock('shell/session', () => ({
  resetUnreadCount: vi.fn(),
}))

vi.mock('../lib/notificationsApi', () => ({
  listNotifications: vi.fn(),
  markAllRead: vi.fn(),
}))

import { resetUnreadCount } from 'shell/session'
import { listNotifications, markAllRead } from '../lib/notificationsApi'

function renderCenterPage() {
  return render(<NotificationCenterPage />)
}

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

const listOf = (items: Notification[]): ListNotificationsResponse => ({ items, nextCursor: null })

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const unreadNotification: Notification = {
  id: 'n-1',
  title: 'Export finished',
  body: 'Your XLSX export is ready.',
  severity: 'success',
  originApp: 'estimai',
  toastWorthy: false,
  readAt: null,
  createdAt: '2026-07-13T09:00:00.000Z',
}

const readNotification: Notification = {
  id: 'n-2',
  title: 'Weekly digest',
  body: 'Nothing new to report.',
  severity: 'info',
  originApp: 'refund',
  toastWorthy: false,
  readAt: '2026-07-11T09:00:00.000Z',
  createdAt: '2026-07-12T09:00:00.000Z',
}

const linkedNotification: Notification = {
  id: 'n-3',
  title: 'Estimate ready for review',
  body: 'Open it to check the numbers.',
  severity: 'warning',
  originApp: 'estimai',
  link: { href: '/estimai/estimates/abc', label: 'Open this estimate' },
  toastWorthy: false,
  readAt: null,
  createdAt: '2026-07-13T10:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(markAllRead).mockResolvedValue({ updated: 0, count: 0 })
})

afterEach(() => {
  vi.clearAllMocks()
  cleanup()
  window.history.pushState(null, '', '/')
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationCenterPage', () => {
  // (C) Loading
  it('renders the loading skeleton while the list is in-flight', async () => {
    vi.mocked(listNotifications).mockReturnValue(pendingPromise())

    renderCenterPage()

    expect(await screen.findByTestId('notify-skeleton')).not.toBeNull()
    expect(screen.queryByTestId('notify-list')).toBeNull()
    expect(screen.queryByTestId('notify-empty-state')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // (A) Populated + ordering
  it('renders notifications newest-first, in the order the API returns them', async () => {
    vi.mocked(listNotifications).mockResolvedValue(listOf([linkedNotification, unreadNotification, readNotification]))

    renderCenterPage()

    await waitFor(() => {
      expect(screen.getByTestId('notify-list')).not.toBeNull()
    })

    const rows = Array.from(document.querySelectorAll('[data-testid^="notification-item-"]'))
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'notification-item-n-3',
      'notification-item-n-1',
      'notification-item-n-2',
    ])
  })

  // (B) Empty
  it('renders the explicit empty state when there are no notifications', async () => {
    vi.mocked(listNotifications).mockResolvedValue(listOf([]))

    renderCenterPage()

    await waitFor(() => {
      expect(screen.getByTestId('notify-empty-state')).not.toBeNull()
    })
    expect(screen.getByText('Nothing here yet')).not.toBeNull()
    expect(screen.queryByTestId('notify-list')).toBeNull()
  })

  // (D) Error + Retry
  it('renders an error banner on a failed fetch and retries on click', async () => {
    vi.mocked(listNotifications)
      .mockRejectedValueOnce(new Error('notify-api unreachable'))
      .mockResolvedValueOnce(listOf([readNotification]))

    renderCenterPage()

    await waitFor(() => {
      expect(screen.getByRole('alert')).not.toBeNull()
    })
    expect(screen.getByRole('alert').textContent).toContain('notify-api unreachable')

    fireEvent.click(screen.getByTestId('notify-error-retry'))

    await waitFor(() => {
      expect(screen.getByTestId('notify-list')).not.toBeNull()
    })
    expect(listNotifications).toHaveBeenCalledTimes(2)
  })

  // (F) Mark-all-read invoked on open: resetUnreadCount() THEN POST
  it('calls resetUnreadCount then POSTs mark-all-read exactly once when the list first loads', async () => {
    vi.mocked(listNotifications).mockResolvedValue(listOf([unreadNotification, readNotification]))

    renderCenterPage()

    await waitFor(() => {
      expect(screen.getByTestId('notify-list')).not.toBeNull()
    })

    await waitFor(() => {
      expect(markAllRead).toHaveBeenCalledTimes(1)
    })
    expect(resetUnreadCount).toHaveBeenCalledTimes(1)

    const resetOrder = vi.mocked(resetUnreadCount).mock.invocationCallOrder[0]
    const markOrder = vi.mocked(markAllRead).mock.invocationCallOrder[0]
    expect(resetOrder).toBeLessThan(markOrder)
  })

  it('does not call resetUnreadCount/markAllRead again on a later Retry (only once per viewing session)', async () => {
    vi.mocked(listNotifications)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(listOf([unreadNotification]))

    renderCenterPage()

    await waitFor(() => {
      expect(screen.getByRole('alert')).not.toBeNull()
    })
    expect(resetUnreadCount).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('notify-error-retry'))

    await waitFor(() => {
      expect(markAllRead).toHaveBeenCalledTimes(1)
    })
    expect(resetUnreadCount).toHaveBeenCalledTimes(1)
  })

  // (E) Was-unread present on first mount, gone on a fresh remount
  it('shows the was-unread affordance on first mount, and not after a fresh remount', async () => {
    vi.mocked(listNotifications).mockResolvedValueOnce(listOf([unreadNotification]))

    renderCenterPage()

    await waitFor(() => {
      expect(screen.getByTestId('notification-new-tag-n-1')).not.toBeNull()
    })
    expect(screen.getByTestId('notification-title-n-1').className).toContain('font-semibold')

    // Simulates leaving `/notify` and coming back (or a reload) — a brand
    // new component instance, brand new `capturedRef`/`wasUnreadIds` state.
    cleanup()

    // Simulates the server having persisted the mark-all-read call from the
    // first mount (design.md Flow 3, step 4: "the previous batch is already
    // readAt-set and carries no affordance") — the SAME notification now
    // comes back read.
    vi.mocked(listNotifications).mockResolvedValueOnce(listOf([{ ...unreadNotification, readAt: '2026-07-13T09:05:00.000Z' }]))

    renderCenterPage()

    await waitFor(() => {
      expect(screen.getByTestId('notification-title-n-1')).not.toBeNull()
    })
    expect(screen.queryByTestId('notification-new-tag-n-1')).toBeNull()
    expect(screen.getByTestId('notification-title-n-1').className).toContain('font-normal')
  })

  // (G) Explicit "Mark all as read" control (AC-3.4)
  it('clears the was-unread tags immediately and re-POSTs on "Mark all as read"', async () => {
    vi.mocked(listNotifications).mockResolvedValue(listOf([unreadNotification]))

    renderCenterPage()

    await waitFor(() => {
      expect(screen.getByTestId('notification-new-tag-n-1')).not.toBeNull()
    })
    await waitFor(() => {
      expect(markAllRead).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(screen.getByTestId('notify-mark-all-read'))

    // Client-side clear is immediate — no waitFor needed for the tag itself.
    expect(screen.queryByTestId('notification-new-tag-n-1')).toBeNull()
    await waitFor(() => {
      expect(markAllRead).toHaveBeenCalledTimes(2)
    })
  })

  // (H) Linked item — real anchor with the untouched in-suite href
  it('renders a notification link as a real anchor with the correct in-suite href', async () => {
    vi.mocked(listNotifications).mockResolvedValue(listOf([linkedNotification]))

    renderCenterPage()

    const row = await screen.findByTestId('notification-item-n-3')
    expect(row.tagName).toBe('A')
    expect(row.getAttribute('href')).toBe('/estimai/estimates/abc')
    expect(row.getAttribute('href')).not.toMatch(/^\/notify/)
  })
})
