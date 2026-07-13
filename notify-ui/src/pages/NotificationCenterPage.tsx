import { useEffect, useRef } from 'react'

/**
 * NotificationCenterPage — notify-ui's single, flat screen (T14,
 * specs/005-notification-center/tasks.md). This task ships only the page
 * shell: a heading that takes programmatic focus on mount (the established
 * repo-wide convention for pages reached by navigation — see
 * `admin-ui/src/pages/NotFoundPage.tsx`'s identical technique, reused per
 * design.md's Accessibility section) and a short placeholder body.
 *
 * T15 (deps: T14, T10, T5, T6) replaces this placeholder with the real
 * content described in design.md "Notification center page (`/notify`,
 * rendered by `notify-ui`)": the header-row "Mark all as read" control, the
 * `GET /notifications`-sourced newest-first list with its loading/empty/
 * error states, per-item severity/title/body/origin-app/timestamp, and the
 * session-scoped "was-unread" affordance. None of that domain logic belongs
 * in this scaffolding task.
 */
export default function NotificationCenterPage() {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div className="mx-auto max-w-2xl px-6 py-16" style={{ color: 'var(--text)' }}>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-3xl font-bold outline-none"
        style={{ fontFamily: 'var(--disp)' }}
        data-testid="notify-center-heading"
      >
        Notifications
      </h1>
      <p className="mt-4 text-base" style={{ color: 'var(--soft)' }}>
        Coming soon — this is a scaffold placeholder proving the notification center loads as
        its own, independently deployed tool inside the Operai suite. The notification list,
        read/unread state, and "mark all as read" control ship in a later task.
      </p>
    </div>
  )
}
