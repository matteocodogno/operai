import { Banner, SkeletonRows, VisuallyHidden } from '@operai/ui'
import { errorMessage, statusOf } from '../lib/errors'
import { strings } from '../strings'
import PermissionDenied from './PermissionDenied'

/** The loading state (building-pages § 2): a polite live line plus skeleton rows. */
export function Loading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div data-testid="projects-loading">
      <VisuallyHidden live role="status">
        {label}
      </VisuallyHidden>
      <SkeletonRows rows={rows} actions={2} />
    </div>
  )
}

/**
 * The failed-load state: 403 → PermissionDenied; 503 → the "authorization
 * service unavailable" banner (ADR-0014); anything else → a warning banner
 * with the Problem detail. Each with Retry except the 403.
 */
export function LoadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const status = statusOf(error)
  if (status === 403) return <PermissionDenied />
  const auth = status === 503
  return (
    <Banner
      tone="warning"
      data-testid="projects-load-error"
      title={auth ? strings.common.authUnavailable.heading : strings.common.loadErrorTitle}
      onRetry={onRetry}
      retryLabel={strings.common.retry}
      retryTestId="projects-load-error-retry"
    >
      {auth ? strings.common.authUnavailable.body : errorMessage(error)}
    </Banner>
  )
}

/** A write refused because the record changed meanwhile (409 version_conflict / 428): reload, then retry. */
export function StaleWriteBanner({ onReload }: { onReload: () => void }) {
  return (
    <Banner
      tone="danger"
      data-testid="projects-stale-write"
      title={strings.common.staleWrite.title}
      onRetry={onReload}
      retryLabel={strings.common.reload}
      retryTestId="projects-stale-write-reload"
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
      data-testid="projects-saved"
    >
      {message}
    </Banner>
  )
}
