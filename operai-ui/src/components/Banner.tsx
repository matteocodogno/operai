import { useEffect, useRef } from 'react'
import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { cx } from '../lib/cx'
import { Button } from './Button'
import { Icon } from './Icon'

export type BannerTone = 'info' | 'success' | 'warning' | 'danger'

/**
 * How a banner is announced. `assertive` is `role="alert"`, `polite` a
 * `role="status"` live region, `off` static content (`role="note"`, no live
 * region) for a persistent condition that is read in place, not announced.
 */
export type BannerLive = 'assertive' | 'polite' | 'off'

/**
 * How long a success confirmation stays before it dismisses itself — one value
 * for the whole suite (design-system.md § Feedback, decisions D-61).
 */
export const CONFIRMATION_DISMISS_MS = 3000

export type BannerProps = Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'role'> & {
  /**
   * `warning` — a recoverable failure (a load that can be retried);
   * `danger` — something failed and needs the user; `success` — a confirmation;
   * `info` — a neutral notice.
   */
  tone?: BannerTone
  /**
   * How it is announced. Defaults from the tone (`warning`/`danger` assertive,
   * `info`/`success` polite). Pass `polite` or `off` for a `warning` that is
   * not time-critical, such as a persistent, non-dismissible notice; the tone,
   * icon and colours do not change. `off` renders `role="note"`, so an
   * `aria-label` still gives it an accessible name when it is focused.
   */
  live?: BannerLive
  /** Bold first line, in the tone's text colour. */
  title?: ReactNode
  titleTestId?: string
  /** The message (typically an RFC 7807 `detail`). */
  children: ReactNode
  /** Adds a Retry button (`secondary`, `sm`). */
  onRetry?: () => void
  retryLabel?: string
  retryTestId?: string
  /** Other actions, before Retry and ×: e.g. "Reload latest" and "Save as a copy" (`Button size="sm"`). */
  actions?: ReactNode
  /** Adds a × button (unless `dismissible` is false). Requires `dismissLabel` (its accessible name). */
  onDismiss?: () => void
  /** False hides the × while keeping `onDismiss` for `autoDismiss`. Defaults to true. */
  dismissible?: boolean
  dismissLabel?: string
  dismissTestId?: string
  /** Calls `onDismiss` after CONFIRMATION_DISMISS_MS (success confirmations only). */
  autoDismiss?: boolean
  /** Slimmer, left-border variant — a transient save confirmation. */
  compact?: boolean
  /** For a banner that takes focus (an error summary after a failed submit, with `tabIndex={-1}`). */
  ref?: Ref<HTMLDivElement>
}

/**
 * Banner — an inline message about the page or a section of it. `warning` and
 * `danger` are `role="alert"` (announced at once); `info` and `success` are a
 * polite `role="status"`; `live` overrides that (`polite`, or `off` for a static
 * `role="note"`). The body text stays in --text for contrast in both
 * themes; the tone is in the border, the tint and the title.
 */
export function Banner({
  tone = 'info',
  live,
  title,
  titleTestId,
  children,
  actions,
  dismissible = true,
  onRetry,
  retryLabel,
  retryTestId,
  onDismiss,
  dismissLabel,
  dismissTestId,
  autoDismiss = false,
  compact = false,
  ref,
  className,
  ...rest
}: BannerProps) {
  const mode: BannerLive = live ?? (tone === 'warning' || tone === 'danger' ? 'assertive' : 'polite')

  // Keep the latest onDismiss without restarting the timer on every render.
  const onDismissRef = useRef(onDismiss)
  useEffect(() => {
    onDismissRef.current = onDismiss
  })

  // The timer restarts when the MESSAGE changes (a new confirmation), never on
  // a re-render that recreates the same content as a new element.
  const messageKey = typeof children === 'string' || typeof children === 'number' ? children : null
  useEffect(() => {
    if (!autoDismiss) return
    const timer = setTimeout(() => onDismissRef.current?.(), CONFIRMATION_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [autoDismiss, messageKey])

  return (
    <div
      ref={ref}
      role={mode === 'assertive' ? 'alert' : mode === 'polite' ? 'status' : 'note'}
      aria-live={mode === 'polite' ? 'polite' : undefined}
      className={cx('banner', tone !== 'info' && `banner-${tone}`, compact && 'banner-compact', className)}
      {...rest}
    >
      {/* <div>s, so the body can hold block content (a list of problems). */}
      <div className="banner-content">
        {title && (
          <strong className="banner-title" data-testid={titleTestId}>
            {title}
          </strong>
        )}
        <div>{children}</div>
      </div>
      {(actions || onRetry || (onDismiss && dismissible)) && (
        <span className="banner-actions">
          {actions}
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry} data-testid={retryTestId}>
              {retryLabel}
            </Button>
          )}
          {onDismiss && dismissible && (
            <Button variant="ghost" iconOnly onClick={onDismiss} aria-label={dismissLabel} data-testid={dismissTestId}>
              <Icon name="close" />
            </Button>
          )}
        </span>
      )}
    </div>
  )
}
