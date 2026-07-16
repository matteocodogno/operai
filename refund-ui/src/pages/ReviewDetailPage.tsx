import { useCallback, useEffect, useRef, useState } from 'react'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { strings } from '../strings'
import * as requestsApi from '../lib/requestsApi'
import type { RefundRequestDetail } from '../lib/requestsApi'
import * as reviewApi from '../lib/reviewApi'
import * as attachmentsApi from '../lib/attachmentsApi'
import { ApiError } from '../lib/refundApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import GuardrailDialog from '../components/GuardrailDialog'
import ApproveDialog from '../components/ApproveDialog'
import RejectDialog from '../components/RejectDialog'
import ExpenseLineRow from '../components/ExpenseLineRow'
import SubtotalsPanel from '../components/SubtotalsPanel'
import MonthlyProcessingNote from '../components/MonthlyProcessingNote'

const route = getRouteApi('/review/$id')

/**
 * ReviewDetailPage — Screen A2 ("Review detail & decide",
 * `/refund/review/$id` — T18, specs/007-refund-service/tasks.md,
 * design.md "Screen A2"/F6). Replaces T14's placeholder. `GET /requests/:id`
 * is the SAME route the employee side uses (`requestsApi.get`) — plan.md's
 * contract table gives it accounting-specific semantics (whole-request, all
 * lines, entity-scope-gated 404), not a separate accounting endpoint.
 *
 *   - `submitted` (decidable): full RO line list in `review` mode (read-only
 *     fields + download-only attachments + an editable approved-total
 *     input per line, AC-6.1/6.5/7.1), `SubtotalsPanel` (requested-only —
 *     no approved figures exist yet), Approve/Reject actions.
 *   - `approved`/`rejected` (decided, AC-6.3): renders the EXACT SAME
 *     read-only variant `RequestDetailPage` already built for the employee's
 *     own approved/rejected detail (design.md F6 step 8: "accounting's
 *     'inspect a past decision' need is met by the SAME read-only render
 *     path"), plus the "Requested by" identity line every A2 render shows.
 *   - L    — SkeletonListRows while `GET /requests/:id` is in flight.
 *   - Err  — ErrorBanner + Retry.
 *   - NF   — neutral "doesn't exist or you don't have access" on a 404
 *            (out-of-scope deep link, AC-6.4, or a genuinely nonexistent
 *            id) — never "permission denied" (would leak existence).
 *   - G    — a 409 on approved-total/approve/reject surfaces
 *            GuardrailDialog; acknowledging has already reloaded the
 *            record underneath.
 *
 * Mutations never merge partial responses into local state — every
 * successful approved-total edit re-fetches the full record via
 * `GET /requests/:id` (`reloadRequest`), mirroring `RequestDetailPage`'s own
 * convention (plan.md R7: money/subtotal math is never re-derived
 * client-side).
 *
 * Approve/Reject success navigates back to Screen A1 with a one-shot
 * `confirmation` search param (design.md F6 steps 4-5: "returned to Screen
 * A1 … with an aria-live confirmation") — see router.tsx's `validateSearch`
 * on the `/review` route and ReviewQueuePage's own read-and-strip of it.
 */

type PageState =
  | { status: 'loading' }
  | { status: 'notFound' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; request: RefundRequestDetail }

type DecisionDialogState =
  | { open: false }
  | { open: true; kind: 'approve'; deciding: boolean; error: string | null }
  | { open: true; kind: 'reject'; deciding: boolean; error: string | null }

type GuardrailState = { title: string; message: string } | null

const errorMessageFor = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) return error.detail ?? error.title
  return fallback
}

export default function ReviewDetailPage() {
  const { id } = route.useParams()
  const navigate = useNavigate()
  const t = strings.pages.reviewDetail

  const [pageState, setPageState] = useState<PageState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [guardrail, setGuardrail] = useState<GuardrailState>(null)
  const [decisionDialog, setDecisionDialog] = useState<DecisionDialogState>({ open: false })
  const headingRef = useRef<HTMLHeadingElement>(null)
  const rowNodesRef = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setPageState({ status: 'loading' })
      })
      .then(() => requestsApi.get(id))
      .then((request) => {
        if (!cancelled) setPageState({ status: 'loaded', request })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 404) {
          setPageState({ status: 'notFound' })
        } else {
          setPageState({ status: 'error', message: errorMessageFor(error, t.loadErrorFallback) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [id, reloadToken, t.loadErrorFallback])

  useEffect(() => {
    if (pageState.status === 'notFound') {
      headingRef.current?.focus()
    }
  }, [pageState.status])

  const handleRetry = useCallback(() => {
    setReloadToken((n) => n + 1)
  }, [])

  const reloadRequest = useCallback(async () => {
    try {
      const fresh = await requestsApi.get(id)
      setPageState({ status: 'loaded', request: fresh })
    } catch {
      // Best-effort — the last known-good state stays on screen; explicit Retry remains available.
    }
  }, [id])

  const registerRowRef = useCallback(
    (lineId: string) => (node: HTMLDivElement | null) => {
      if (node) rowNodesRef.current.set(lineId, node)
      else rowNodesRef.current.delete(lineId)
    },
    [],
  )

  // ---------------------------------------------------------------------------
  // Approved-total edits — same "swallow 409 behind GuardrailDialog, rethrow
  // anything else" contract as RequestDetailPage's `runLineMutation`.
  // ---------------------------------------------------------------------------

  const runReviewMutation = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      try {
        await action()
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setGuardrail({ title: t.guardrail.title, message: t.guardrail.message })
          await reloadRequest()
          return
        }
        throw err
      }
      await reloadRequest()
    },
    [reloadRequest, t.guardrail.message, t.guardrail.title],
  )

  const handleApprovedTotalChange = useCallback(
    (lineId: string, cents: number) => runReviewMutation(() => reviewApi.setApprovedTotal(id, lineId, cents)),
    [id, runReviewMutation],
  )

  const handleDownloadAttachment = useCallback(
    (lineId: string, attachmentId: string) => attachmentsApi.getDownloadUrl(id, lineId, attachmentId),
    [id],
  )

  // ---------------------------------------------------------------------------
  // Approve / Reject (design.md F6 steps 4-6)
  // ---------------------------------------------------------------------------

  const handleApproveOpen = useCallback(() => {
    setDecisionDialog({ open: true, kind: 'approve', deciding: false, error: null })
  }, [])

  const handleRejectOpen = useCallback(() => {
    setDecisionDialog({ open: true, kind: 'reject', deciding: false, error: null })
  }, [])

  const handleDialogCancel = useCallback(() => {
    setDecisionDialog({ open: false })
  }, [])

  const handleApproveConfirm = useCallback(async () => {
    if (pageState.status !== 'loaded') return
    const employeeName = pageState.request.owner.name
    setDecisionDialog((prev) => (prev.open ? { ...prev, deciding: true, error: null } : prev))
    try {
      await reviewApi.approve(id)
      setDecisionDialog({ open: false })
      void navigate({ to: '/review', search: { confirmation: t.decide.approveConfirmation(employeeName) } })
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDecisionDialog({ open: false })
        setGuardrail({ title: t.guardrail.title, message: t.guardrail.message })
        await reloadRequest()
      } else {
        setDecisionDialog((prev) =>
          prev.open ? { ...prev, deciding: false, error: errorMessageFor(err, t.decide.genericError) } : prev,
        )
      }
    }
  }, [pageState, id, navigate, t, reloadRequest])

  const handleRejectConfirm = useCallback(
    async (motivation: string) => {
      if (pageState.status !== 'loaded') return
      const employeeName = pageState.request.owner.name
      setDecisionDialog((prev) => (prev.open ? { ...prev, deciding: true, error: null } : prev))
      try {
        await reviewApi.reject(id, motivation)
        setDecisionDialog({ open: false })
        void navigate({ to: '/review', search: { confirmation: t.decide.rejectConfirmation(employeeName) } })
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setDecisionDialog({ open: false })
          setGuardrail({ title: t.guardrail.title, message: t.guardrail.message })
          await reloadRequest()
        } else {
          setDecisionDialog((prev) =>
            prev.open ? { ...prev, deciding: false, error: errorMessageFor(err, t.decide.genericError) } : prev,
          )
        }
      }
    },
    [pageState, id, navigate, t, reloadRequest],
  )

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section aria-labelledby="refund-review-detail-heading" data-testid="refund-review-detail-page">
      <span className="sr-only" data-testid="refund-review-detail-id">
        {id}
      </span>

      {guardrail && (
        <GuardrailDialog title={guardrail.title} message={guardrail.message} onAcknowledge={() => setGuardrail(null)} />
      )}

      <h2
        id="refund-review-detail-heading"
        ref={pageState.status === 'notFound' ? headingRef : undefined}
        tabIndex={pageState.status === 'notFound' ? -1 : undefined}
        className="text-lg font-semibold outline-none"
        style={{ fontFamily: 'var(--disp)' }}
      >
        {pageState.status === 'notFound' ? t.notFound.heading : t.heading}
      </h2>

      {pageState.status === 'loaded' && (
        <p className="mt-1 text-sm" style={{ color: 'var(--soft)' }} data-testid="review-detail-requested-by">
          {t.requestedByLabel(pageState.request.owner.name, pageState.request.owner.email)}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-4">
        {pageState.status === 'loading' && (
          <>
            <p className="sr-only" aria-live="polite">
              {t.loadingAnnouncement}
            </p>
            <SkeletonListRows />
          </>
        )}

        {pageState.status === 'error' && <ErrorBanner message={pageState.message} onRetry={handleRetry} />}

        {pageState.status === 'notFound' && (
          <div data-testid="review-detail-not-found">
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              {t.notFound.body}
            </p>
            <Link
              to="/review"
              data-testid="review-detail-not-found-back"
              className="mt-3 inline-block text-sm underline underline-offset-2"
              style={{ color: 'var(--acc)' }}
            >
              {t.notFound.backLink}
            </Link>
          </div>
        )}

        {pageState.status === 'loaded' && pageState.request.status === 'submitted' && (
          <div data-testid="review-detail-decidable" className="flex flex-col gap-4">
            <SubtotalsPanel subtotals={pageState.request.subtotals} />

            <div className="flex flex-col gap-2">
              {pageState.request.lines.map((line) => (
                <ExpenseLineRow
                  key={line.id}
                  line={line}
                  mode="review"
                  onApprovedTotalChange={(cents) => handleApprovedTotalChange(line.id, cents)}
                  onDownloadAttachment={(attachmentId) => handleDownloadAttachment(line.id, attachmentId)}
                  registerRef={registerRowRef(line.id)}
                />
              ))}
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleApproveOpen}
                data-testid="review-detail-approve"
                className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80"
                style={{ borderColor: 'var(--grn)', color: 'var(--grn)' }}
              >
                {t.decide.approveButton}
              </button>
              <button
                type="button"
                onClick={handleRejectOpen}
                data-testid="review-detail-reject"
                className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80"
                style={{ borderColor: 'var(--red)', color: 'var(--red)' }}
              >
                {t.decide.rejectButton}
              </button>
            </div>
          </div>
        )}

        {pageState.status === 'loaded' && pageState.request.status === 'approved' && (
          <div data-testid="review-detail-approved" className="flex flex-col gap-4">
            <SubtotalsPanel subtotals={pageState.request.subtotals} showApproved />
            <div className="flex flex-col gap-2">
              {pageState.request.lines.map((line) => (
                <ExpenseLineRow
                  key={line.id}
                  line={line}
                  mode="readOnlyApproved"
                  onDownloadAttachment={(attachmentId) => handleDownloadAttachment(line.id, attachmentId)}
                  registerRef={registerRowRef(line.id)}
                />
              ))}
            </div>
            <MonthlyProcessingNote />
          </div>
        )}

        {pageState.status === 'loaded' && pageState.request.status === 'rejected' && (
          <div data-testid="review-detail-rejected" className="flex flex-col gap-4">
            <div
              className="px-4 py-3 rounded-md border text-sm"
              style={{ borderColor: 'var(--red)', backgroundColor: 'color-mix(in srgb, var(--red) 8%, transparent)' }}
              data-testid="review-detail-rejection-motivation"
            >
              <p className="font-medium mb-1" style={{ color: 'var(--red)' }}>
                {strings.pages.requestDetail.rejected.motivationHeading}
              </p>
              <p style={{ color: 'var(--text)' }}>{pageState.request.rejectionMotivation}</p>
            </div>
            <SubtotalsPanel subtotals={pageState.request.subtotals} />
            <div className="flex flex-col gap-2">
              {pageState.request.lines.map((line) => (
                <ExpenseLineRow
                  key={line.id}
                  line={line}
                  mode="readOnly"
                  onDownloadAttachment={(attachmentId) => handleDownloadAttachment(line.id, attachmentId)}
                  registerRef={registerRowRef(line.id)}
                />
              ))}
            </div>
          </div>
        )}

        {pageState.status === 'loaded' && pageState.request.status !== 'submitted' && pageState.request.status !== 'approved' && pageState.request.status !== 'rejected' && (
          <div data-testid="review-detail-readonly-fallback" className="flex flex-col gap-2">
            {pageState.request.lines.map((line) => (
              <ExpenseLineRow
                key={line.id}
                line={line}
                mode="readOnly"
                onDownloadAttachment={(attachmentId) => handleDownloadAttachment(line.id, attachmentId)}
                registerRef={registerRowRef(line.id)}
              />
            ))}
          </div>
        )}
      </div>

      {decisionDialog.open && decisionDialog.kind === 'approve' && pageState.status === 'loaded' && (
        <ApproveDialog
          employeeName={pageState.request.owner.name}
          isDeciding={decisionDialog.deciding}
          errorMessage={decisionDialog.error}
          onConfirm={() => void handleApproveConfirm()}
          onCancel={handleDialogCancel}
        />
      )}

      {decisionDialog.open && decisionDialog.kind === 'reject' && pageState.status === 'loaded' && (
        <RejectDialog
          employeeName={pageState.request.owner.name}
          isDeciding={decisionDialog.deciding}
          errorMessage={decisionDialog.error}
          onConfirm={(motivation) => void handleRejectConfirm(motivation)}
          onCancel={handleDialogCancel}
        />
      )}
    </section>
  )
}
