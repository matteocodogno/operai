/**
 * ToastHost — the shell-chrome toast overlay (T12, specs/005-notification-center,
 * design.md "Toast (ToastHost, shell-chrome overlay)", US-5: AC-5.1, AC-5.2, AC-5.3,
 * AC-5.5).
 *
 * Mounted exactly ONCE, in ShellLayout.tsx, as a sibling of `<main>` — so it overlays
 * whichever remote is currently mounted (EstimAI/Refund/Admin/notify-ui), regardless of
 * route (design.md: "a toast in the app the user currently has open" — plan.md's "single
 * shell-owned host" reasoning). It renders exactly what it is told: it subscribes to
 * `subscribeToasts()` (shell/lib/notifications.ts, T10) and pops one toast per
 * toast-worthy SSE `notification` event. `subscribeToasts()` only ever fires for events
 * whose `toastWorthy` flag is true (T10's `handleNotificationEvent`); a notification that
 * isn't toast-worthy never reaches this component at all, so "pop nothing" (AC-5.5) is
 * satisfied by construction — there is nothing here to filter.
 *
 * Severity → ARIA role (design.md table): info/success are `role="status"`
 * (polite — a routine ping shouldn't interrupt); warning/error are `role="alert"`
 * (assertive — the point of a time-sensitive alert is to interrupt). Never
 * conveyed by color alone: every toast also carries an aria-hidden icon + an
 * sr-only "Severity: <word>" label read before the title.
 *
 * Auto-dismiss (AC-5.2) is severity-scaled (6s info/success, 8s warning, 10s error —
 * longer for the more consequential ones, but always finite) and pauses on
 * hover/keyboard-focus, resuming on mouse-leave/blur (WCAG 2.2.1 "timing adjustable" —
 * a toast a screen-reader/keyboard user has tabbed onto to read/act on must not vanish
 * out from under them). Manual dismiss (AC-5.3, the "×" button or Escape while any part
 * of the toast has focus) removes the toast from state immediately and permanently — it
 * is not re-added by anything, so it never reappears.
 *
 * Stacking: newest toast renders at the top of the list (a `<div>` per toast, most
 * recent first). Visually capped at MAX_VISIBLE_TOASTS simultaneously visible — a
 * concurrent toast beyond that is queued and promoted the moment a slot frees up
 * (dismissed or auto-dismissed), rather than overflowing the viewport (design.md
 * "Stacking").
 *
 * Reduced motion: entrance uses a simple opacity/translate transition, skipped
 * entirely (`motion-reduce:transition-none`, and the initial state itself does not
 * animate) under `prefers-reduced-motion: reduce` — same posture as the Bell badge
 * (T11), the codebase's first two "unprompted" visual changes.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { subscribeToasts, type Notification, type NotificationSeverity, type ToastEvent } from '../lib/notifications'

/** Visually cap concurrent toasts; anything beyond this queues (design.md "Stacking"). */
const MAX_VISIBLE_TOASTS = 4

/** Auto-dismiss timeout per severity (design.md "Auto-dismiss") — always finite. */
const AUTO_DISMISS_MS: Record<NotificationSeverity, number> = {
  info: 6000,
  success: 6000,
  warning: 8000,
  error: 10000,
}

/**
 * ARIA role per severity (design.md table): polite for routine pings, assertive
 * for warning/error — "the whole point of a time-sensitive alert is to interrupt."
 */
const ARIA_ROLE: Record<NotificationSeverity, 'status' | 'alert'> = {
  info: 'status',
  success: 'status',
  warning: 'alert',
  error: 'alert',
}

const ARIA_LIVE: Record<NotificationSeverity, 'polite' | 'assertive'> = {
  info: 'polite',
  success: 'polite',
  warning: 'assertive',
  error: 'assertive',
}

/** Aria-hidden decorative glyph per severity (design.md table). */
const SEVERITY_ICON: Record<NotificationSeverity, string> = {
  info: 'ⓘ',
  success: '✓',
  warning: '⚠',
  error: '✕',
}

/** Accent border color token per severity (design.md table). */
const SEVERITY_BORDER_CLASS: Record<NotificationSeverity, string> = {
  info: 'border-acc',
  success: 'border-grn',
  warning: 'border-org',
  error: 'border-red',
}

const SEVERITY_ICON_CLASS: Record<NotificationSeverity, string> = {
  info: 'text-acc',
  success: 'text-grn',
  warning: 'text-org',
  error: 'text-red',
}

interface ToastItem {
  id: string
  notification: Notification
}

export default function ToastHost() {
  const [visible, setVisible] = useState<ToastItem[]>([])
  // Toasts beyond MAX_VISIBLE_TOASTS wait here until a slot frees up. A ref (not
  // state) because the queue itself is never rendered — only `visible` is.
  const queueRef = useRef<ToastItem[]>([])

  useEffect(() => {
    const unsubscribe = subscribeToasts((event: ToastEvent) => {
      const item: ToastItem = { id: event.notification.id, notification: event.notification }
      setVisible(current => {
        if (current.some(existing => existing.id === item.id)) {
          // Same notification id already showing — never double-pop it.
          return current
        }
        if (current.length >= MAX_VISIBLE_TOASTS) {
          queueRef.current.push(item)
          return current
        }
        return [item, ...current]
      })
    })
    return unsubscribe
  }, [])

  const dismiss = (id: string): void => {
    setVisible(current => {
      const next = current.filter(item => item.id !== id)
      if (next.length < MAX_VISIBLE_TOASTS) {
        const promoted = queueRef.current.shift()
        if (promoted) {
          return [promoted, ...next]
        }
      }
      return next
    })
  }

  if (visible.length === 0) {
    return null
  }

  return (
    <div className="pointer-events-none fixed top-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
      {visible.map(item => (
        <Toast key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
      ))}
    </div>
  )
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const { notification } = item
  const severity = notification.severity
  const duration = AUTO_DISMISS_MS[severity]

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const remainingRef = useRef(duration)
  const startedAtRef = useRef(0)
  const pausedRef = useRef(false)
  const [entered, setEntered] = useState(false)

  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const startTimer = (ms: number): void => {
    clearTimer()
    startedAtRef.current = Date.now()
    remainingRef.current = ms
    timerRef.current = setTimeout(onDismiss, ms)
  }

  useEffect(() => {
    startTimer(duration)
    // Entrance transition: flip on the next frame so the initial (pre-transition)
    // state actually paints first. Reduced-motion users get the same end state
    // instantly via `motion-reduce:transition-none` below, not a different value here.
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => {
      clearTimer()
      cancelAnimationFrame(frame)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mounted toast
  }, [])

  const pause = (): void => {
    if (pausedRef.current || timerRef.current === null) {
      return
    }
    pausedRef.current = true
    const elapsed = Date.now() - startedAtRef.current
    remainingRef.current = Math.max(remainingRef.current - elapsed, 0)
    clearTimer()
  }

  const resume = (): void => {
    if (!pausedRef.current) {
      return
    }
    pausedRef.current = false
    startTimer(remainingRef.current)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      onDismiss()
    }
  }

  return (
    <div
      role={ARIA_ROLE[severity]}
      aria-live={ARIA_LIVE[severity]}
      aria-atomic="true"
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
      onKeyDown={handleKeyDown}
      className={`pointer-events-auto rounded-md border border-rule border-l-2 ${SEVERITY_BORDER_CLASS[severity]} bg-ink-soft px-4 py-3 shadow-lg transition-all duration-200 motion-reduce:transition-none ${
        entered ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'
      }`}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className={`shrink-0 text-base leading-none ${SEVERITY_ICON_CLASS[severity]}`}>
          {SEVERITY_ICON[severity]}
        </span>
        <span className="sr-only">Severity: {severity}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text">{notification.title}</p>
          <p className="mt-0.5 text-sm text-soft">{notification.body}</p>
          {notification.link && (
            <Link
              to={notification.link.href}
              onClick={onDismiss}
              className="mt-1 inline-block text-sm text-acc underline underline-offset-2 hover:text-acc-hi"
            >
              {notification.link.label ?? 'Open'}
            </Link>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="shrink-0 text-base leading-none text-muted transition-colors hover:text-text"
        >
          ×
        </button>
      </div>
    </div>
  )
}
