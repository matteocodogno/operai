import type { CSSProperties } from 'react'
import { Link } from '@tanstack/react-router'
import { SEVERITY_META, originAppLabel } from '../lib/severity'
import type { Notification } from '../lib/notificationsApi'

/**
 * NotificationItem — one row of the notification center list (T15,
 * specs/005-notification-center/tasks.md, design.md "Notification center
 * page" / "NotificationItem row"). Renders (AC-2.2):
 *   - severity icon (aria-hidden) + sr-only severity label
 *   - title (heavier weight when `wasUnread` this session)
 *   - body (the row *is* the detail — no separate detail screen in v1)
 *   - origin-app tag
 *   - a `<time>` with a relative label, exact ISO `dateTime`, and an
 *     absolute human-formatted `title` attribute
 *   - the "was-unread" affordance (design.md, AC-3.2/3.3) — NOT color-only:
 *     a visible "New" tag, a heavier title weight, a `--acc` left-border
 *     accent, AND a sr-only "New: " prefix so the cue survives for
 *     assistive-tech users who perceive none of the visual channels.
 *
 * When the notification carries a `link` (AC-2.5, AC-4.3) the entire row is
 * a real `<Link>` (design.md Accessibility: "the whole row itself is the
 * real, natively keyboard-operable anchor" — reusing Sidebar.tsx's/
 * SectionNav.tsx's "always a real anchor for navigation" convention, and
 * matching Sidebar.tsx's own precedent of passing a plain runtime `string`
 * to `to=`, not just a route-tree literal). When absent, the row is a
 * static, non-interactive container (no tab stop — "don't make
 * non-interactive content focusable").
 *
 * `to={link.href}` targets an in-suite ABSOLUTE path (e.g.
 * "/estimai/estimates/abc") that lives outside notify-ui's own inner router
 * (which only ever registers `/`, see ../router.tsx) — cross-remote
 * navigation ultimately depends on the shell's own top-level router picking
 * up the resulting history change once mounted inside the real shell
 * (ADR-0006's per-remote nested-router model). This is exercised at the
 * unit level here (a `<Link>`/real anchor is rendered, never a raw
 * `window.location` assignment — AC-2.5's explicit security note) and
 * across remotes at the e2e level (T21, plan.md's test-strategy row for
 * AC-2.5) — flagging this boundary explicitly since it is the first
 * notify-ui code to link to a path outside its own basepath.
 */

export interface NotificationItemProps {
  notification: Notification
  /**
   * True when this notification was unread at the moment THIS viewing
   * session's center opened (the captured set from `NotificationCenterPage`,
   * design.md Flow 3) — drives the transient "was-unread" affordance. This
   * is independent of `notification.readAt` itself, which the server may
   * have already flipped to read by the time this renders (AC-2.5).
   */
  wasUnread: boolean
}

function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime()
  const diffSec = Math.max(0, Math.round((now - then) / 1000))
  if (diffSec < 60) return 'just now'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHour = Math.round(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`
  const diffDay = Math.round(diffHour / 24)
  return `${diffDay}d ago`
}

function formatAbsoluteTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

export default function NotificationItem({ notification, wasUnread }: NotificationItemProps) {
  const meta = SEVERITY_META[notification.severity]

  // Generic Tailwind utilities only (no custom-color utility classes like
  // `border-acc`/`text-org`) — notify-ui's own build never processes
  // shell/tokens.css's `@theme` block (design.md Component inventory: it
  // follows admin-ui's convention, inline `style={{ ... var(--x) }}` for
  // every accent color, plain `hover:opacity-*` for interactive feedback).
  const rowClassName = 'flex items-start gap-3 rounded-md border px-4 py-3 transition-opacity hover:opacity-90'
  // `borderLeftColor`/`borderLeftWidth` are ALWAYS present (never added/
  // removed between renders) — only their VALUE toggles with `wasUnread`.
  // Mixing a shorthand (`borderColor`) with a longhand that's only
  // sometimes present makes React warn ("Removing a style property during
  // rerender... don't mix shorthand and non-shorthand properties") the
  // instant a row's `wasUnread` flips (e.g. the "Mark all as read" click).
  const rowStyle: CSSProperties = {
    borderColor: 'var(--rule)',
    backgroundColor: 'var(--ink-soft)',
    borderLeftWidth: wasUnread ? '2px' : '1px',
    borderLeftColor: wasUnread ? 'var(--acc)' : 'var(--rule)',
  }

  const body = (
    <>
      {wasUnread && (
        <span className="sr-only" data-testid={`notification-new-prefix-${notification.id}`}>
          New:{' '}
        </span>
      )}
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-base leading-none" style={{ color: meta.token }}>
        {meta.icon}
      </span>
      <span className="sr-only">{`Severity: ${meta.label}`}</span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          {wasUnread && (
            <span
              aria-hidden="true"
              data-testid={`notification-new-tag-${notification.id}`}
              className="rounded-full border px-1.5 py-0 text-[10px] leading-tight"
              style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
            >
              New
            </span>
          )}
          <span
            className={wasUnread ? 'font-semibold' : 'font-normal'}
            style={{ color: 'var(--text)' }}
            data-testid={`notification-title-${notification.id}`}
          >
            {notification.title}
          </span>
        </span>

        <span className="text-sm" style={{ color: 'var(--soft)' }}>
          {notification.body}
        </span>

        <span className="flex items-center gap-2 text-xs" style={{ color: 'var(--soft)' }}>
          <span className="font-mono uppercase tracking-wider" data-testid={`notification-origin-${notification.id}`}>
            {originAppLabel(notification.originApp)}
          </span>
          <time dateTime={notification.createdAt} title={formatAbsoluteTime(notification.createdAt)}>
            {formatRelativeTime(notification.createdAt)}
          </time>
        </span>

        {notification.link?.label && (
          <span className="mt-1 text-sm font-medium" style={{ color: 'var(--acc)' }}>
            {notification.link.label}
          </span>
        )}
      </span>
    </>
  )

  if (notification.link) {
    return (
      <li role="listitem">
        <Link
          to={notification.link.href}
          data-testid={`notification-item-${notification.id}`}
          className={rowClassName}
          style={rowStyle}
        >
          {body}
        </Link>
      </li>
    )
  }

  return (
    <li role="listitem">
      <div data-testid={`notification-item-${notification.id}`} className={rowClassName} style={rowStyle}>
        {body}
      </div>
    </li>
  )
}
