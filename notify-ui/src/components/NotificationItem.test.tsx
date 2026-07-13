/**
 * @vitest-environment jsdom
 *
 * Component tests for NotificationItem — the notification-center row (T15,
 * specs/005-notification-center/tasks.md).
 *
 * Covers:
 *   (A) Base render: severity icon is aria-hidden, a sr-only "Severity: X"
 *       label is present, title/body/origin-app/time all render.
 *   (B) "Was-unread" affordance (AC-3.2), NOT color-only: the visible "New"
 *       tag, the sr-only "New: " prefix, and the heavier title weight are
 *       ALL present when `wasUnread` is true, and ALL absent when false.
 *   (C) Link vs static row (AC-2.5, AC-4.3): a notification with a `link`
 *       renders the whole row as a real `<a>` (TanStack Router `<Link>`) —
 *       never a `window.location` assignment; one without renders a static,
 *       non-interactive `<div>`.
 *   (D) Link follow: activating a linked row is a real in-suite route
 *       navigation (checked against a router harness with a stub
 *       destination route, mirroring admin-ui/src/pages/UsersPage.test.tsx's
 *       `<Link to="/users/$id">` harness technique).
 *
 * `<Link>` requires a TanStack Router context, so every render here goes
 * through a minimal two-route harness (this component's row + a stub
 * destination route) rather than a bare `render(<NotificationItem .../>)`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import NotificationItem from './NotificationItem'
import type { Notification } from '../lib/notificationsApi'

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

const baseNotification: Notification = {
  id: 'notif-1',
  title: 'Export finished',
  body: 'Your XLSX export is ready.',
  severity: 'success',
  originApp: 'estimai',
  toastWorthy: false,
  readAt: '2026-07-10T09:00:00.000Z',
  createdAt: '2026-07-10T08:00:00.000Z',
}

function renderItem(notification: Notification, wasUnread: boolean) {
  window.history.pushState(null, '', '/')
  const rootRoute = createRootRoute()
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <ul role="list">
        <NotificationItem notification={notification} wasUnread={wasUnread} />
      </ul>
    ),
  })
  const destinationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/estimai/estimates/$id',
    component: () => <p>Estimate detail</p>,
  })
  const routeTree = rootRoute.addChildren([listRoute, destinationRoute])
  const router = createRouter({ routeTree })
  return render(<RouterProvider router={router} />)
}

describe('NotificationItem', () => {
  // (A) Base render
  it('renders title, body, origin app, time, and a severity icon+sr-only label', async () => {
    renderItem(baseNotification, false)

    expect(await screen.findByTestId('notification-title-notif-1')).not.toBeNull()
    expect(screen.getByTestId('notification-title-notif-1').textContent).toBe('Export finished')
    expect(screen.getByText('Your XLSX export is ready.')).not.toBeNull()
    expect(screen.getByTestId('notification-origin-notif-1').textContent).toBe('EstimAI')
    expect(screen.getByText('Severity: Success')).not.toBeNull()

    const icon = screen.getByText('✓')
    expect(icon.getAttribute('aria-hidden')).toBe('true')

    const time = document.querySelector('time')
    expect(time).not.toBeNull()
    expect(time?.getAttribute('dateTime')).toBe('2026-07-10T08:00:00.000Z')
  })

  it("renders each severity's own icon + sr-only label", async () => {
    const cases: Array<[Notification['severity'], string, string]> = [
      ['info', 'ⓘ', 'Severity: Info'],
      ['success', '✓', 'Severity: Success'],
      ['warning', '⚠', 'Severity: Warning'],
      ['error', '✕', 'Severity: Error'],
    ]

    for (const [severity, icon, label] of cases) {
      renderItem({ ...baseNotification, severity }, false)
      expect(await screen.findByText(icon)).not.toBeNull()
      expect(screen.getByText(label)).not.toBeNull()
      cleanup()
    }
  })

  // (B) Was-unread affordance
  it('renders the "New" tag, sr-only "New: " prefix, and a heavier title weight when wasUnread', async () => {
    renderItem(baseNotification, true)

    const tag = await screen.findByTestId('notification-new-tag-notif-1')
    expect(tag.textContent).toBe('New')

    const prefix = screen.getByTestId('notification-new-prefix-notif-1')
    expect(prefix.className).toContain('sr-only')
    expect(prefix.textContent?.trim()).toBe('New:')

    const title = screen.getByTestId('notification-title-notif-1')
    expect(title.className).toContain('font-semibold')
  })

  it('renders none of the was-unread affordance when not wasUnread', async () => {
    renderItem(baseNotification, false)

    await screen.findByTestId('notification-title-notif-1')
    expect(screen.queryByTestId('notification-new-tag-notif-1')).toBeNull()
    expect(screen.queryByTestId('notification-new-prefix-notif-1')).toBeNull()
    expect(screen.getByTestId('notification-title-notif-1').className).toContain('font-normal')
  })

  // (C) Link vs static row
  it('renders a static, non-interactive row when there is no link', async () => {
    renderItem(baseNotification, false)

    const row = await screen.findByTestId('notification-item-notif-1')
    expect(row.tagName).toBe('DIV')
  })

  it('renders the whole row as a real anchor when a link is present', async () => {
    const withLink: Notification = {
      ...baseNotification,
      link: { href: '/estimai/estimates/abc', label: 'Open this estimate' },
    }
    renderItem(withLink, false)

    const row = await screen.findByTestId('notification-item-notif-1')
    expect(row.tagName).toBe('A')
    expect(row.getAttribute('href')).toBe('/estimai/estimates/abc')
    expect(screen.getByText('Open this estimate')).not.toBeNull()
  })

  // (D) Link follow — a real in-suite route navigation
  it('activating a linked row navigates to the destination route (not window.location)', async () => {
    const withLink: Notification = {
      ...baseNotification,
      link: { href: '/estimai/estimates/abc', label: 'Open this estimate' },
    }
    renderItem(withLink, false)

    const row = await screen.findByTestId('notification-item-notif-1')
    fireEvent.click(row)

    expect(await screen.findByText('Estimate detail')).not.toBeNull()
    expect(window.location.pathname).toBe('/estimai/estimates/abc')
  })
})
