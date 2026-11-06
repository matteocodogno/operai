import { Banner, SkeletonRows, StatePanel, VisuallyHidden } from '@operai/ui'
import { describeFailure } from '../lib/errors'
import { strings } from '../strings'
import PermissionDenied from './PermissionDenied'

/** The loading state (building-pages § 2): a polite live line plus skeleton rows. */
export function Loading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div data-testid="meetings-loading">
      <VisuallyHidden live role="status">
        {label}
      </VisuallyHidden>
      <SkeletonRows rows={rows} actions={2} />
    </div>
  )
}

export type LoadFailureProps = {
  error: unknown
  onRetry: () => void
  /**
   * The 404 copy of the record being loaded ("Meeting not found"). Identical for "does not exist"
   * and "not visible" (AC-5.3): a page passes its own words, nothing here hints at which.
   */
  notFound?: { title: string; body: string }
}

/**
 * The failed-load state, sorted by `describeFailure` (lib/errors.ts):
 * 403 → PermissionDenied; 404 → the not-found panel; 503 from `auth` → the "authorization service
 * unavailable" banner (ADR-0014, AC-10.6); a 403 that means "you can open this but not do that"
 * (frozen, creator only) → an inline warning, not a replaced page; anything else → a warning
 * banner with the message. Everything but the 403 and the 404 offers Retry.
 */
export function LoadFailure({ error, onRetry, notFound }: LoadFailureProps) {
  const failure = describeFailure(error)
  if (failure.kind === 'forbidden') return <PermissionDenied />
  if (failure.kind === 'notFound') {
    return (
      <StatePanel
        role="alert"
        focusOnMount
        headingLevel={2}
        title={notFound?.title ?? strings.common.notFound.heading}
        testId="meetings-not-found-record"
      >
        {notFound?.body ?? strings.common.notFound.body}
      </StatePanel>
    )
  }
  const auth = failure.kind === 'authUnavailable'
  return (
    <Banner
      tone="warning"
      data-testid="meetings-load-error"
      title={auth ? strings.common.authUnavailable.heading : strings.common.loadErrorTitle}
      onRetry={onRetry}
      retryLabel={strings.common.retry}
      retryTestId="meetings-load-error-retry"
    >
      {auth ? strings.common.authUnavailable.body : failure.message}
    </Banner>
  )
}

/** A write refused because the record changed meanwhile (409 version_conflict / 428): reload, then retry. */
export function StaleWriteBanner({ onReload }: { onReload: () => void }) {
  return (
    <Banner
      tone="danger"
      data-testid="meetings-stale-write"
      title={strings.common.staleWrite.title}
      onRetry={onReload}
      retryLabel={strings.common.reload}
      retryTestId="meetings-stale-write-reload"
    >
      {strings.common.staleWrite.body}
    </Banner>
  )
}

/** The compact, auto-dismissing confirmation of the person's own action (INC-19). */
export function Saved({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <Banner
      tone="success"
      compact
      autoDismiss
      onDismiss={onDismiss}
      dismissLabel={strings.common.dismiss}
      data-testid="meetings-saved"
    >
      {message}
    </Banner>
  )
}
