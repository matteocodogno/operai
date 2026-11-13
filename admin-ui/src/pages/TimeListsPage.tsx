import { useCallback, useEffect, useRef, useState } from 'react'
import { usePermissions } from 'shell/session'
import { Card, PageHeader } from '@operai/ui'
import * as timeListsApi from '../lib/timeListsApi'
import { ApiError } from '../lib/timeListsApi'
import type { TimeLists } from '../lib/timeListsApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import PermissionDenied from '../components/PermissionDenied'
import { strings } from '../strings'

const t = strings.timeLists

/**
 * TimeListsPage — the admin screen for the categories and the two work-type lists people pick from
 * when they record hours (T31, specs/029-time-tracking/tasks.md, refs AC-3.3, AC-5.5; design.md S5).
 *
 * This task is the page's frame and its states; the three cards (rows, Add / Rename, Retire /
 * Restore) are T32 and mount in `time-lists-loaded` from `state.lists`. The shape is the one of
 * MileageRatesPage (ADR-0023): hours-api is called directly through `shell/session`, and the page
 * is a state union.
 *
 * States, exactly one at a time:
 *   denied     — the caller does not hold `time-list:manage`, or hours-api answered 403: `PermissionDenied`
 *                in place of the cards, focused. Nothing is fetched without the permission.
 *   loading    — three skeleton cards and one polite announcement.
 *   error      — `503 authz_unavailable`: the "Authorization service unavailable" banner; any other
 *                failure: the warning banner. Both with Retry, which asks again.
 *   loaded     — the lists.
 *
 * Why the permission is read here and not only from the API: hours-api serves `GET /time-lists` to
 * any JWT (the entry dialog reads the same lists), so the read never answers 403 for a missing
 * `time-list:manage`; only the writes are gated. The page decides from `usePermissions()` (the same
 * seam `SectionNav` uses, INC-32). The shell resolves the permissions before it mounts a gated
 * remote, so they are already there when this renders; an empty result (a failed `/authz/me`) holds
 * no grant and fails CLOSED, as the nav link does. UX only: hours-api enforces the permission live on
 * every list write (plan.md § Lists), and a 403 from it lands in the same state.
 *
 * Fetch pattern: an explicit Promise chain rather than an async helper called from the effect, for
 * `react-hooks/set-state-in-effect`, as in MileageRatesPage and RolesPage.
 */

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; lists: TimeLists }
  | { status: 'error'; cause: 'authz' | 'load' }
  | { status: 'forbidden' }

/** Whether `permissions` contains the given (resource, action) pair. */
const hasCapability = (
  permissions: { resource: string; action: string }[],
  resource: string,
  action: string,
): boolean => permissions.some((p) => p.resource === resource && p.action === action)

/** What a failed load becomes. Only a 503 that says it was the authorization check is that banner. */
const failureState = (error: unknown): ListState => {
  if (error instanceof ApiError && error.status === 403) return { status: 'forbidden' }
  if (error instanceof ApiError && error.status === 503 && error.code === 'authz_unavailable') {
    return { status: 'error', cause: 'authz' }
  }
  return { status: 'error', cause: 'load' }
}

const CARD_TITLES = [t.cards.categories, t.cards.projectWorkTypes, t.cards.dealWorkTypes]

export default function TimeListsPage() {
  // Derived at render; empty until the permissions resolve and on any failure (no grants).
  const { permissions } = usePermissions()
  const canManage = hasCapability(permissions, 'time-list', 'manage')

  const [state, setState] = useState<ListState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!canManage) return
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'loading' })
      })
      .then(() => timeListsApi.listTimeLists())
      .then((lists) => {
        if (!cancelled) setState({ status: 'loaded', lists })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState(failureState(error))
      })

    return () => {
      cancelled = true
    }
  }, [canManage, reloadToken])

  // Retry replaces its own banner with the loading state; without a deliberate move, focus would fall
  // to <body> and the next Tab would start from the top of the document (design-system.md § a11y).
  const headingRef = useRef<HTMLHeadingElement>(null)
  const handleRetry = useCallback(() => {
    headingRef.current?.focus()
    setReloadToken((token) => token + 1)
  }, [])

  const denied = !canManage || state.status === 'forbidden'

  return (
    <section aria-labelledby="time-lists-heading" data-testid="time-lists-page">
      <PageHeader
        title={t.heading}
        titleId="time-lists-heading"
        description={t.description}
        headingRef={headingRef}
        focusableHeading
      />

      <div className="flex flex-col gap-4">
        {denied && <PermissionDenied headingLevel={3} title={t.forbidden.title} message={t.forbidden.body} />}

        {!denied &&
          state.status === 'loading' &&
          CARD_TITLES.map((title, index) => (
            <Card key={title} title={title}>
              {/* One announcement for the whole screen, on the first card. */}
              <SkeletonListRows rows={3} label={index === 0 ? t.loading : null} />
            </Card>
          ))}

        {!denied && state.status === 'error' && state.cause === 'authz' && (
          <ErrorBanner title={t.authzUnavailable.title} message={t.authzUnavailable.body} onRetry={handleRetry} />
        )}

        {!denied && state.status === 'error' && state.cause === 'load' && (
          <ErrorBanner message={t.loadError} onRetry={handleRetry} />
        )}

        {!denied && state.status === 'loaded' && <div data-testid="time-lists-loaded" />}
      </div>
    </section>
  )
}
