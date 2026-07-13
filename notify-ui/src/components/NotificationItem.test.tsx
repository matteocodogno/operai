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
 *       renders the whole row as a real `<a href>` — a genuine browser
 *       anchor, never a TanStack Router `<Link>` and never a raw
 *       `window.location` assignment; one without renders a static,
 *       non-interactive `<div>`.
 *   (D) The anchor's `href` is the untouched, absolute in-suite path (e.g.
 *       "/estimai/estimates/abc") — NOT rewritten relative to notify-ui's
 *       own `/notify` basepath. This is the regression check for the
 *       cross-remote navigation bug: a `<Link>` here would have resolved
 *       the path against notify-ui's inner router and produced
 *       "/notify/estimai/estimates/abc", which 404s inside notify-ui and
 *       never reaches the target remote. A real anchor's `href` is left
 *       alone by the browser and is handled by the shell's own top-level
 *       router once the resulting navigation reaches it (ADR-0006).
 *   (E) Follow-up (ADR-0006-consistent): a plain left-click on the row
 *       calls `shell/session`'s `navigateSuite` (no full reload) instead of
 *       letting the browser follow the anchor's `href`; a MODIFIED click
 *       (metaKey, here — standing in for ctrl/shift/alt/middle-click too,
 *       since they're all checked by the same guard clause) does NOT call
 *       `navigateSuite`, leaving the anchor free to drive the browser's own
 *       "open in new tab" behavior.
 *
 * NotificationItem no longer needs a TanStack Router context (it renders a
 * plain `<a>`, not a `<Link>`), so these are now bare
 * `render(<NotificationItem .../>)` calls — no router harness required. It
 * DOES need `shell/session`'s `navigateSuite`, mocked below the same way
 * `NotificationCenterPage.test.tsx` mocks `resetUnreadCount`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import NotificationItem from './NotificationItem'
import type { Notification } from '../lib/notificationsApi'

vi.mock('shell/session', () => ({
  navigateSuite: vi.fn(),
}))

import { navigateSuite } from 'shell/session'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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

describe('NotificationItem', () => {
  // (A) Base render
  it('renders title, body, origin app, time, and a severity icon+sr-only label', () => {
    render(<NotificationItem notification={baseNotification} wasUnread={false} />)

    expect(screen.getByTestId('notification-title-notif-1')).not.toBeNull()
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

  it("renders each severity's own icon + sr-only label", () => {
    const cases: Array<[Notification['severity'], string, string]> = [
      ['info', 'ⓘ', 'Severity: Info'],
      ['success', '✓', 'Severity: Success'],
      ['warning', '⚠', 'Severity: Warning'],
      ['error', '✕', 'Severity: Error'],
    ]

    for (const [severity, icon, label] of cases) {
      render(<NotificationItem notification={{ ...baseNotification, severity }} wasUnread={false} />)
      expect(screen.getByText(icon)).not.toBeNull()
      expect(screen.getByText(label)).not.toBeNull()
      cleanup()
    }
  })

  // (B) Was-unread affordance
  it('renders the "New" tag, sr-only "New: " prefix, and a heavier title weight when wasUnread', () => {
    render(<NotificationItem notification={baseNotification} wasUnread={true} />)

    const tag = screen.getByTestId('notification-new-tag-notif-1')
    expect(tag.textContent).toBe('New')

    const prefix = screen.getByTestId('notification-new-prefix-notif-1')
    expect(prefix.className).toContain('sr-only')
    expect(prefix.textContent?.trim()).toBe('New:')

    const title = screen.getByTestId('notification-title-notif-1')
    expect(title.className).toContain('font-semibold')
  })

  it('renders none of the was-unread affordance when not wasUnread', () => {
    render(<NotificationItem notification={baseNotification} wasUnread={false} />)

    screen.getByTestId('notification-title-notif-1')
    expect(screen.queryByTestId('notification-new-tag-notif-1')).toBeNull()
    expect(screen.queryByTestId('notification-new-prefix-notif-1')).toBeNull()
    expect(screen.getByTestId('notification-title-notif-1').className).toContain('font-normal')
  })

  // (C) Link vs static row
  it('renders a static, non-interactive row when there is no link', () => {
    render(<NotificationItem notification={baseNotification} wasUnread={false} />)

    const row = screen.getByTestId('notification-item-notif-1')
    expect(row.tagName).toBe('DIV')
  })

  it('renders the whole row as a real anchor when a link is present', () => {
    const withLink: Notification = {
      ...baseNotification,
      link: { href: '/estimai/estimates/abc', label: 'Open this estimate' },
    }
    render(<NotificationItem notification={withLink} wasUnread={false} />)

    const row = screen.getByTestId('notification-item-notif-1')
    expect(row.tagName).toBe('A')
    expect(screen.getByText('Open this estimate')).not.toBeNull()
  })

  // (D) Cross-remote link — the href must be the untouched absolute path
  it('keeps an in-suite absolute link href intact (not rewritten under /notify)', () => {
    const withLink: Notification = {
      ...baseNotification,
      link: { href: '/estimai/estimates/abc', label: 'Open this estimate' },
    }
    render(<NotificationItem notification={withLink} wasUnread={false} />)

    const row = screen.getByTestId('notification-item-notif-1')
    expect(row.getAttribute('href')).toBe('/estimai/estimates/abc')
    expect(row.getAttribute('href')).not.toMatch(/^\/notify/)
  })

  // (E) Cross-remote navigation without a full reload
  describe('cross-remote navigation (ADR-0006-consistent)', () => {
    const withLink: Notification = {
      ...baseNotification,
      link: { href: '/estimai/estimates/abc', label: 'Open this estimate' },
    }

    it('calls navigateSuite (not a full browser navigation) on a plain left-click', () => {
      render(<NotificationItem notification={withLink} wasUnread={false} />)
      const row = screen.getByTestId('notification-item-notif-1')

      const event = fireEvent.click(row, { button: 0 })

      expect(navigateSuite).toHaveBeenCalledOnce()
      expect(navigateSuite).toHaveBeenCalledWith('/estimai/estimates/abc')
      // fireEvent.click returns false when the event's default was prevented
      // — i.e. the anchor's native navigation was suppressed in favor of
      // navigateSuite.
      expect(event).toBe(false)
      // The href itself is untouched — navigateSuite is called with the
      // exact same absolute path a modified click would have followed.
      expect(row.getAttribute('href')).toBe('/estimai/estimates/abc')
    })

    it('does NOT call navigateSuite on a modified click (metaKey), leaving the anchor to the browser', () => {
      render(<NotificationItem notification={withLink} wasUnread={false} />)
      const row = screen.getByTestId('notification-item-notif-1')

      const event = fireEvent.click(row, { button: 0, metaKey: true })

      expect(navigateSuite).not.toHaveBeenCalled()
      // Default was NOT prevented — fireEvent.click returns true when the
      // event is allowed to proceed (the browser handles the real anchor).
      expect(event).toBe(true)
    })

    it('does NOT call navigateSuite on a non-primary mouse button (e.g. middle-click)', () => {
      render(<NotificationItem notification={withLink} wasUnread={false} />)
      const row = screen.getByTestId('notification-item-notif-1')

      const event = fireEvent.click(row, { button: 1 })

      expect(navigateSuite).not.toHaveBeenCalled()
      expect(event).toBe(true)
    })
  })
})
