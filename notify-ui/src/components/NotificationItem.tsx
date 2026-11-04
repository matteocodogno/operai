import type { MouseEvent } from 'react'
import { Badge, Icon, cx, formatDateTime, formatRelative, listRowClassName } from '@operai/ui'
import { navigateSuite } from 'shell/session'
import { SEVERITY_META, localizedText, originAppLabel } from '../lib/severity'
import { strings } from '../strings'
import type { Notification } from '../lib/notificationsApi'

/**
 * NotificationItem — one row of the notification center list (T15,
 * specs/005-notification-center/tasks.md, design.md "Notification center
 * page" / "NotificationItem row"). Renders (AC-2.2):
 *   - severity icon (aria-hidden) + sr-only severity label
 *   - title (heavier weight when `wasUnread` this session)
 *   - body (the row *is* the detail — no separate detail screen in v1)
 *   - origin-app tag
 *   - a `<time>` with a relative label (`formatRelative`), exact ISO
 *     `dateTime`, and the absolute date and time (`formatDateTime`) as its
 *     `title` — the suite's formatters, in the person's language (INC-26)
 *   - the "was-unread" affordance (design.md, AC-3.2/3.3) — NOT color-only:
 *     a visible "New" tag, a heavier title weight, a `--acc` left-border
 *     accent, AND a sr-only "New: " prefix so the cue survives for
 *     assistive-tech users who perceive none of the visual channels.
 *
 * The row is one `ListRows` row (INC-33): the page renders the list, this
 * component renders the row element (`list-row`) without its own `<li>`.
 *
 * When the notification carries a `link` (AC-2.5, AC-4.3) the entire row is
 * a real `<a href>` (design.md Accessibility: "the whole row itself is the
 * real, natively keyboard-operable anchor"). When absent, the row is a
 * static, non-interactive container (no tab stop — "don't make
 * non-interactive content focusable").
 *
 * IMPORTANT: this is a plain `<a href={link.href}>`, NOT a TanStack Router
 * `<Link>`. `link.href` targets an in-suite ABSOLUTE path (e.g.
 * "/estimai/estimates/abc") that lives outside notify-ui's own inner router
 * (which only ever registers `/`, see ../router.tsx and its own
 * `basepath: '/notify'`). A `<Link>` here would resolve that path RELATIVE
 * TO notify-ui's basepath (producing `/notify/estimai/estimates/abc`, a
 * dead route that 404s inside notify-ui and never reaches the target
 * remote) — there is no shared router *instance* across remotes (ADR-0006:
 * `@tanstack/react-router` is a shared MF *library* singleton, not a shared
 * router instance), so a remote's inner `<Link>` cannot navigate outside
 * its own basepath. This is exercised at the unit level here (a real anchor
 * with the untouched absolute `href` is rendered) and across remotes at the
 * e2e level (T21, plan.md's test-strategy row for AC-2.5) — flagging this
 * boundary explicitly since it is the first notify-ui code to link to a
 * path outside its own basepath.
 *
 * Follow-up (specs/005-notification-center, ADR-0006-consistent): a plain
 * `<a href>` alone means every click — even an unmodified left-click meant
 * to stay in-app — performs a full DOCUMENT reload, since the browser has no
 * way to know the target lives inside the same federated suite. The anchor
 * stays (middle-click / ctrl+click / cmd+click / "open in new tab" all still
 * need a real `href` to work), but a plain left-click is intercepted: the
 * default browser navigation is prevented and `shell/session`'s
 * `navigateSuite(link.href)` is called instead, which drives the SHELL's
 * single top-level router (the only router instance that spans every
 * remote's basepath) client-side, with no full reload. A MODIFIED click
 * (any of metaKey/ctrlKey/shiftKey/altKey, or a non-primary mouse button)
 * is deliberately left alone — `preventDefault()` is never called for those,
 * so the browser's own "open in new tab/window" behavior fires exactly as a
 * user expects from a real anchor.
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

export default function NotificationItem({ notification, wasUnread }: NotificationItemProps) {
  const meta = SEVERITY_META[notification.severity]
  // The reader's language picks the variant, not the sender (ADR-0065).
  const { title, body: bodyText } = localizedText(notification)

  // The library list row (INC-33): border, padding, surface and — for a row
  // that is a link — the hover border. An unread row gets a 2px accent left
  // border, which a utility keeps over the row's hover colour.
  const rowClassName = cx(listRowClassName, 'items-start justify-start gap-3', wasUnread && 'border-l-2 border-l-acc')

  const body = (
    <>
      {wasUnread && (
        <span className="sr-only" data-testid={`notification-new-prefix-${notification.id}`}>
          {`${strings.item.newPrefix} `}
        </span>
      )}
      <span aria-hidden="true" className={`mt-0.5 shrink-0 text-base leading-none ${meta.iconClassName}`}>
        <Icon name={meta.icon} />
      </span>
      <span className="sr-only">{strings.item.severity(meta.label)}</span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          {wasUnread && (
            <Badge tone="accent" aria-hidden="true" data-testid={`notification-new-tag-${notification.id}`}>
              {strings.item.newTag}
            </Badge>
          )}
          <span
            className={`${wasUnread ? 'font-semibold' : 'font-normal'} text-text`}
            data-testid={`notification-title-${notification.id}`}
          >
            {title}
          </span>
        </span>

        <span className="text-sm text-soft">{bodyText}</span>

        <span className="flex items-center gap-2 text-xs text-soft">
          <span className="font-mono uppercase tracking-wider" data-testid={`notification-origin-${notification.id}`}>
            {originAppLabel(notification.originApp)}
          </span>
          <time dateTime={notification.createdAt} title={formatDateTime(notification.createdAt)}>
            {formatRelative(notification.createdAt)}
          </time>
        </span>

        {notification.link?.label && (
          <span className="mt-1 text-sm font-medium text-acc">{notification.link.label}</span>
        )}
      </span>
    </>
  )

  if (notification.link) {
    const link = notification.link

    // A plain, unmodified left-click stays in-app via the shell's router
    // (navigateSuite); a modified click (new-tab/new-window/etc.) is left
    // untouched so the anchor's own `href` drives the browser's native
    // behavior — see the module doc comment's "Follow-up" section above.
    const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }
      event.preventDefault()
      navigateSuite(link.href)
    }

    return (
      <a
        href={link.href}
        onClick={handleClick}
        data-testid={`notification-item-${notification.id}`}
        className={rowClassName}
      >
        {body}
      </a>
    )
  }

  return (
    <div data-testid={`notification-item-${notification.id}`} className={rowClassName}>
      {body}
    </div>
  )
}
