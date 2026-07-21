import { useCallback, useEffect, useRef, useState } from 'react'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { ownerDisplay, strings } from '../strings'
import * as reviewApi from '../lib/reviewApi'
import type { ReviewQueueItem } from '../lib/reviewApi'
import { ApiError } from '../lib/refundApi'
import { formatDate } from '../lib/dates'
import { formatSubtotalsPreview } from '../lib/subtotals'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import PermissionDenied from '../components/PermissionDenied'
import RequestStatusBadge from '../components/RequestStatusBadge'

const route = getRouteApi('/review')

/**
 * ReviewQueuePage — Screen A1 ("Review queue", `/refund/review` — T18,
 * specs/007-refund-service/tasks.md, design.md "Screen A1"/F5). Replaces
 * T14's placeholder: the entity-scoped worklist of every `submitted` request
 * PLUS every `approved`-but-not-yet-batched one (007 AC-5.2 amendment,
 * 2026-07-21 — accounting wanted approved-but-not-processed requests to stay
 * visible; a per-row status badge distinguishes the two) in the caller's
 * scope — `GET /review/requests` is the live server
 * query design.md is explicit the UI renders exactly as returned (no
 * client-side "was this withdrawn?" logic).
 *
 * States (design.md "L/E/P/Err/PD"):
 *   L   — SkeletonListRows + an sr-only aria-live loading announcement.
 *   E   — "Nothing awaiting your decision right now" (a real, successful,
 *         empty result, not a denial — distinct copy from PD below).
 *   P   — the row list (employee, submitted date, subtotal preview); each
 *         row opens Screen A2.
 *   Err — ErrorBanner + Retry.
 *   PD  — PermissionDenied (403 — no `request:review` grant at all, AC-5.4,
 *         the common case since most Operai users are plain employees) — no
 *         Retry, reachable via direct URL even though the shell's own nav
 *         already hides the entry point for non-accounting users (design.md:
 *         "refund-ui's own internal chrome deliberately always renders a
 *         'Review queue' link … so this defense-in-depth PD state is the
 *         thing that actually enforces the boundary").
 *
 * No pagination — `GET /review/requests` is also a bare array in plan.md's
 * contract (design.md Gap #6).
 *
 * Reads a one-shot `confirmation` search param (see router.tsx's
 * `validateSearch` on this route) left by `ReviewDetailPage` after an
 * Approve/Reject navigates back here, announces it via `aria-live="polite"`
 * once, then strips it with a `replace` navigation so a page refresh never
 * repeats the announcement.
 */

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; items: ReviewQueueItem[] }
  | { status: 'error'; message: string }
  | { status: 'forbidden' }

const errorMessageFor = (error: unknown): string => {
  if (error instanceof ApiError) return error.detail ?? error.title
  return strings.pages.reviewQueue.loadErrorFallback
}

export default function ReviewQueuePage() {
  const { confirmation } = route.useSearch()
  const navigate = useNavigate()
  const [listState, setListState] = useState<ListState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [liveMessage, setLiveMessage] = useState('')
  const t = strings.pages.reviewQueue
  const strippedConfirmationRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setListState({ status: 'loading' })
      })
      .then(() => reviewApi.listQueue())
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

  // Announce the one-shot confirmation once, then strip it from the URL.
  useEffect(() => {
    if (!confirmation || strippedConfirmationRef.current) return
    strippedConfirmationRef.current = true
    setLiveMessage(confirmation)
    void navigate({ to: '/review', search: {}, replace: true })
  }, [confirmation, navigate])

  const handleRetry = useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  return (
    <section aria-labelledby="refund-review-queue-heading" data-testid="refund-review-queue-page">
      <h2 id="refund-review-queue-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        {t.heading}
      </h2>

      <p aria-live="polite" className="sr-only" data-testid="review-queue-live-message">
        {liveMessage}
      </p>

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
          <p className="text-sm py-16 text-center" style={{ color: 'var(--muted)' }} data-testid="review-queue-empty-state">
            {t.empty}
          </p>
        )}

        {listState.status === 'loaded' && listState.items.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="review-queue-list">
            {listState.items.map((item) => {
              const preview = formatSubtotalsPreview(item.subtotals)
              const submitted = formatDate(item.submittedAt)
              const ownerName = ownerDisplay(item.owner)
              return (
                <Link
                  to="/review/$id"
                  params={{ id: item.id }}
                  key={item.id}
                  data-testid={`review-queue-row-${item.id}`}
                  aria-label={t.row.openLabel(ownerName, submitted)}
                  className="flex items-center justify-between gap-4 px-4 py-3 rounded-md border text-left transition-colors hover:opacity-90"
                  style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
                >
                  <div className="flex items-center gap-3">
                    <RequestStatusBadge status={item.status} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                      {ownerName}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      {t.row.submittedLabel(submitted)}
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
