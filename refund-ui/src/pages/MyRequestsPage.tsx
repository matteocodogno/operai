import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { strings } from '../strings'
import * as requestsApi from '../lib/requestsApi'
import type { RequestListItem } from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'
import { formatDate } from '../lib/dates'
import { formatSubtotalsPreview } from '../lib/subtotals'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import PermissionDenied from '../components/PermissionDenied'
import RequestStatusBadge from '../components/RequestStatusBadge'

/**
 * MyRequestsPage — Screen R1 ("My requests", `/refund/requests` — T16,
 * specs/007-refund-service/tasks.md, design.md "Screen R1"). Replaces T14's
 * placeholder with the real screen: a flat list of the caller's own
 * requests (status badge + last-updated date + a compact per-currency
 * subtotal preview), "+ New request", and every list state design.md names.
 *
 * States (design.md "L/E/P/Err/PD"):
 *   L   — SkeletonListRows + an sr-only aria-live loading announcement.
 *   E   — true first-time zero-requests onboarding CTA.
 *   P   — the row list; each row opens Screen R2.
 *   Err — ErrorBanner + Retry.
 *   PD  — PermissionDenied (403 on `GET /requests`) — no Retry (design.md:
 *         "a 403 here isn't transient").
 *
 * No pagination — `GET /requests` is a bare array in plan.md's contract
 * (design.md Gap #6); this screen renders every row it gets.
 *
 * Fetch pattern: an explicit Promise chain, not async/await invoked from the
 * effect — mirrors `admin-ui/src/pages/RolesPage.tsx`'s own doc comment
 * (`react-hooks/set-state-in-effect` flags an async function that calls a
 * state setter anywhere in its body, even after an `await`).
 */

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; items: RequestListItem[] }
  | { status: 'error'; message: string }
  | { status: 'forbidden' }

const errorMessageFor = (error: unknown): string => {
  if (error instanceof ApiError) return error.detail ?? error.title
  return strings.pages.myRequests.loadErrorFallback
}

export default function MyRequestsPage() {
  const [listState, setListState] = useState<ListState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const t = strings.pages.myRequests

  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setListState({ status: 'loading' })
      })
      .then(() => requestsApi.list())
      .then((items) => {
        if (!cancelled) setListState({ status: 'loaded', items })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 403) {
          setListState({ status: 'forbidden' })
        } else {
          setListState({ status: 'error', message: errorMessageFor(error) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const handleRetry = useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  return (
    <section aria-labelledby="refund-my-requests-heading" data-testid="refund-my-requests-page">
      <div className="flex items-center justify-between gap-4">
        <h2 id="refund-my-requests-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
          {t.heading}
        </h2>
        {listState.status !== 'forbidden' && (
          <Link
            to="/requests/new"
            data-testid="my-requests-new-button"
            className="text-sm py-1.5 px-3 font-medium transition-opacity hover:opacity-90"
            style={{ color: 'white', backgroundColor: 'var(--acc)' }}
          >
            {t.newRequestButton}
          </Link>
        )}
      </div>

      <div className="mt-4">
        {listState.status === 'forbidden' && <PermissionDenied />}

        {listState.status === 'loading' && (
          <>
            <p className="sr-only" aria-live="polite">
              {t.loadingAnnouncement}
            </p>
            <SkeletonListRows />
          </>
        )}

        {listState.status === 'error' && <ErrorBanner message={listState.message} onRetry={handleRetry} />}

        {listState.status === 'loaded' && listState.items.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center" data-testid="my-requests-empty-state">
            <h3 className="text-base font-semibold" style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}>
              {t.empty.heading}
            </h3>
            <p className="max-w-md text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
              {t.empty.body}
            </p>
            {/* No CTA here — the header's "+ New request" already serves this;
                a centered second button would be redundant. */}
          </div>
        )}

        {listState.status === 'loaded' && listState.items.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="my-requests-list">
            {listState.items.map((item) => {
              const preview = formatSubtotalsPreview(item.subtotals)
              const updated = formatDate(item.updatedAt)
              return (
                <Link
                  to="/requests/$id"
                  params={{ id: item.id }}
                  key={item.id}
                  data-testid={`my-requests-row-${item.id}`}
                  aria-label={t.row.openLabel(updated)}
                  className="flex items-center justify-between gap-4 px-4 py-3 rounded-md border text-left transition-colors hover:opacity-90"
                  style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
                >
                  <div className="flex items-center gap-3">
                    <RequestStatusBadge status={item.status} />
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      {t.row.updatedLabel(updated)}
                    </span>
                  </div>
                  {preview && (
                    <span className="text-sm font-mono" style={{ color: 'var(--text)' }}>
                      {preview}
                    </span>
                  )}
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
