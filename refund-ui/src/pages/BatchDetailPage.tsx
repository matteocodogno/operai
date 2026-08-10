import { useCallback, useEffect, useRef, useState } from 'react'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { strings } from '../strings'
import * as batchesApi from '../lib/batchesApi'
import type { BatchDetail } from '../lib/batchesApi'
import { ApiError } from '../lib/refundApi'
import { formatDateTime } from '../lib/dates'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import PermissionDenied from '../components/PermissionDenied'
import GuardrailDialog from '../components/GuardrailDialog'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import ToastBanner from '../components/ToastBanner'
import BatchStatusBadge from '../components/BatchStatusBadge'
import BatchSubtotalsPanel from '../components/BatchSubtotalsPanel'
import BatchEmployeeGroupList from '../components/BatchEmployeeGroupList'
import BatchPdfLink from '../components/BatchPdfLink'
import MarkPaidDialog from '../components/MarkPaidDialog'

const route = getRouteApi('/batches/$id')

/**
 * BatchDetailPage — Screen B3 ("Batch detail", `/refund/batches/$id` — T12,
 * specs/008-refund-monthly-processing/tasks.md, design.md "Screen B3"/F2/F3/
 * F4/F6). Replaces T9's placeholder. Also the email deep-link landing page
 * (design.md F2/F3 — a compilation email's "app deep link" resolves here,
 * gated by this page's own `403`/`404` handling exactly like a direct visit).
 *
 * One route, rendering EVERY batch status (`compiled`/`paid`/`discarded`)
 * through the SAME inspection layout (header, overall subtotals, per-employee
 * groups, PDF download, email status + resend) — only the status badge, the
 * presence of paid/discarded stamps, and the availability of Mark-as-paid/
 * Discard (compiled-only) change (design.md F2 step 8).
 *
 * States (design.md "L/Err/NF/PD/G"):
 *   L   — SkeletonListRows while `GET /batches/:id` is in flight.
 *   Err — ErrorBanner + Retry (a genuine network/5xx failure).
 *   NF  — a genuinely nonexistent batch id (batch reads are NOT
 *         entity-scoped, plan.md's D1 — there is no "exists but you can't
 *         see it" case here).
 *   PD  — PermissionDenied (AC-2.3, no `request:review` at all), no Retry.
 *   G   — a 409 on Mark-as-paid or Discard (a concurrent-resolution race,
 *         AC-4.3/AC-6.2) surfaces the SAME shared `GuardrailDialog` message
 *         for both actions ("someone else already closed this batch out"),
 *         then reloads so the screen reflects the real, current terminal
 *         state.
 *
 * Mark-as-paid/Discard success reloads the batch IN PLACE (no navigation,
 * mirroring `RequestDetailPage`/`ReviewDetailPage`'s submit/withdraw/approve/
 * reject convention): the response `BatchDetail` becomes the new page state
 * directly (both endpoints return the fresh 200 body), `aria-live="polite"`
 * announces the outcome, and focus moves to the status heading
 * (`justTransitioned` + `headingRef`, the same technique those pages use).
 *
 * `MarkPaidDialog` (NEW) is the irreversible, checkbox-gated confirm
 * (design.md F4 step 2/Accessibility) — see its own doc comment. Discard
 * reuses `ConfirmDeleteModal` (`tone="destructive"`, unchanged) — less severe
 * than Mark-as-paid because discard is correctable (released requests can be
 * recompiled), so it does NOT get the extra checkbox gate.
 *
 * Resend email breaks from this suite's usual "aria-live only" lifecycle
 * posture with a `ToastBanner` (design.md F3 step 2) — repeatable,
 * non-navigating feedback, not a one-way lifecycle transition.
 *
 * Reads a one-shot `confirmation` search param (router.tsx's
 * `validateSearch` on this route) left by `CompileBatchPage`'s post-compile
 * navigation (design.md F1 step 6) — announced once via `aria-live`, then
 * stripped with a `replace` navigation, the SAME technique
 * `ReviewQueuePage` already uses for its own `/review` search param, applied
 * here to a DETAIL route instead of a list route.
 */

type PageState =
  | { status: 'loading' }
  | { status: 'notFound' }
  | { status: 'error'; message: string }
  | { status: 'forbidden' }
  | { status: 'loaded'; batch: BatchDetail }

type MarkPaidDialogState = { open: false } | { open: true; confirming: boolean; error: string | null }
type DiscardDialogState = { open: false } | { open: true; discarding: boolean; error: string | null }
type GuardrailState = { title: string; message: string } | null
type EmailToastState = { message: string; tone: 'success' | 'error' } | null

const errorMessageFor = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) return error.detail ?? error.title
  return fallback
}

export default function BatchDetailPage() {
  const { id } = route.useParams()
  const { confirmation } = route.useSearch()
  const navigate = useNavigate()
  const t = strings.pages.batchDetail

  const [pageState, setPageState] = useState<PageState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [guardrail, setGuardrail] = useState<GuardrailState>(null)
  const [markPaidDialog, setMarkPaidDialog] = useState<MarkPaidDialogState>({ open: false })
  const [discardDialog, setDiscardDialog] = useState<DiscardDialogState>({ open: false })
  const [emailToast, setEmailToast] = useState<EmailToastState>(null)
  const [resending, setResending] = useState(false)
  const [liveMessage, setLiveMessage] = useState('')
  const [justTransitioned, setJustTransitioned] = useState(false)

  const headingRef = useRef<HTMLHeadingElement>(null)
  const strippedConfirmationRef = useRef(false)

  // ---------------------------------------------------------------------------
  // Load — Promise chain (react-hooks/set-state-in-effect; mirrors RequestDetailPage/ReviewDetailPage)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setPageState({ status: 'loading' })
      })
      .then(() => batchesApi.get(id))
      .then((batch) => {
        if (!cancelled) setPageState({ status: 'loaded', batch })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 404) {
          setPageState({ status: 'notFound' })
        } else if (error instanceof ApiError && error.status === 403) {
          setPageState({ status: 'forbidden' })
        } else {
          setPageState({ status: 'error', message: errorMessageFor(error, t.loadErrorFallback) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [id, reloadToken, t.loadErrorFallback])

  // Focus the not-found heading on mount too (mirrors NotFoundPage.tsx/RequestDetailPage.tsx).
  useEffect(() => {
    if (pageState.status === 'notFound') {
      headingRef.current?.focus()
    }
  }, [pageState.status])

  // Focus the status heading right after a mark-paid/discard transition completes.
  useEffect(() => {
    if (justTransitioned) {
      headingRef.current?.focus()
      setJustTransitioned(false)
    }
  }, [justTransitioned])

  // Announce the one-shot post-compile confirmation once, then strip it from the URL.
  useEffect(() => {
    if (!confirmation || strippedConfirmationRef.current) return
    strippedConfirmationRef.current = true
    setLiveMessage(confirmation)
    void navigate({ to: '/batches/$id', params: { id }, search: {}, replace: true })
  }, [confirmation, navigate, id])

  const handleRetry = useCallback(() => {
    setReloadToken((n) => n + 1)
  }, [])

  const reloadBatch = useCallback(async () => {
    try {
      const fresh = await batchesApi.get(id)
      setPageState({ status: 'loaded', batch: fresh })
    } catch {
      // Best-effort — the last known-good state stays on screen; explicit Retry remains available.
    }
  }, [id])

  // ---------------------------------------------------------------------------
  // Resend email (design.md F3 step 2)
  // ---------------------------------------------------------------------------

  const handleResend = useCallback(async () => {
    setResending(true)
    try {
      const result = await batchesApi.sendEmail(id)
      await reloadBatch()
      setEmailToast(
        result.emailStatus === 'sent'
          ? { message: t.email.resendSuccessToast, tone: 'success' }
          : { message: t.email.resendFailureToast, tone: 'error' },
      )
    } catch (err) {
      setEmailToast({ message: errorMessageFor(err, t.email.resendFailureToast), tone: 'error' })
    } finally {
      setResending(false)
    }
  }, [id, reloadBatch, t.email.resendSuccessToast, t.email.resendFailureToast])

  const dismissEmailToast = useCallback(() => setEmailToast(null), [])

  // ---------------------------------------------------------------------------
  // Mark as paid (design.md F4)
  // ---------------------------------------------------------------------------

  const handleMarkPaidOpen = useCallback(() => {
    setMarkPaidDialog({ open: true, confirming: false, error: null })
  }, [])

  const handleMarkPaidCancel = useCallback(() => {
    setMarkPaidDialog({ open: false })
  }, [])

  const handleMarkPaidConfirm = useCallback(async () => {
    if (pageState.status !== 'loaded') return
    setMarkPaidDialog((prev) => (prev.open ? { ...prev, confirming: true, error: null } : prev))
    try {
      const updated = await batchesApi.markPaid(pageState.batch.id)
      setPageState({ status: 'loaded', batch: updated })
      setMarkPaidDialog({ open: false })
      setLiveMessage(t.markPaid.confirmation(updated.requestCount))
      setJustTransitioned(true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setMarkPaidDialog({ open: false })
        setGuardrail({ title: t.guardrail.title, message: t.guardrail.message })
        await reloadBatch()
      } else {
        setMarkPaidDialog((prev) =>
          prev.open ? { ...prev, confirming: false, error: errorMessageFor(err, t.markPaid.genericError) } : prev,
        )
      }
    }
  }, [pageState, reloadBatch, t])

  // ---------------------------------------------------------------------------
  // Discard (design.md F6)
  // ---------------------------------------------------------------------------

  const handleDiscardOpen = useCallback(() => {
    setDiscardDialog({ open: true, discarding: false, error: null })
  }, [])

  const handleDiscardCancel = useCallback(() => {
    setDiscardDialog({ open: false })
  }, [])

  const handleDiscardConfirm = useCallback(async () => {
    if (pageState.status !== 'loaded') return
    setDiscardDialog((prev) => (prev.open ? { ...prev, discarding: true, error: null } : prev))
    try {
      const updated = await batchesApi.discard(pageState.batch.id)
      setPageState({ status: 'loaded', batch: updated })
      setDiscardDialog({ open: false })
      setLiveMessage(t.discard.confirmation(updated.requestCount))
      setJustTransitioned(true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDiscardDialog({ open: false })
        setGuardrail({ title: t.guardrail.title, message: t.guardrail.message })
        await reloadBatch()
      } else {
        setDiscardDialog((prev) =>
          prev.open ? { ...prev, discarding: false, error: errorMessageFor(err, t.discard.genericError) } : prev,
        )
      }
    }
  }, [pageState, reloadBatch, t])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section aria-labelledby="refund-batch-detail-heading" data-testid="refund-batch-detail-page">
      <span className="sr-only" data-testid="refund-batch-detail-id">
        {id}
      </span>

      {guardrail && (
        <GuardrailDialog title={guardrail.title} message={guardrail.message} onAcknowledge={() => setGuardrail(null)} />
      )}

      {pageState.status === 'loaded' ? (
        <div className="flex items-center gap-3">
          <h2
            id="refund-batch-detail-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold outline-none"
            style={{ fontFamily: 'var(--disp)' }}
          >
            {t.heading}
          </h2>
          <BatchStatusBadge status={pageState.batch.status} />
        </div>
      ) : (
        <h2
          id="refund-batch-detail-heading"
          ref={pageState.status === 'notFound' ? headingRef : undefined}
          tabIndex={pageState.status === 'notFound' ? -1 : undefined}
          className="text-lg font-semibold outline-none"
          style={{ fontFamily: 'var(--disp)' }}
        >
          {pageState.status === 'notFound' ? t.notFound.heading : t.heading}
        </h2>
      )}

      <p aria-live="polite" className="sr-only" data-testid="batch-detail-live-message">
        {liveMessage}
      </p>

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

        {pageState.status === 'forbidden' && <PermissionDenied />}

        {pageState.status === 'notFound' && (
          <div data-testid="batch-detail-not-found">
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              {t.notFound.body}
            </p>
            <Link
              to="/batches"
              data-testid="batch-detail-not-found-back"
              className="mt-3 inline-block text-sm underline underline-offset-2"
              style={{ color: 'var(--acc)' }}
            >
              {t.notFound.backLink}
            </Link>
          </div>
        )}

        {pageState.status === 'loaded' && (
          <div data-testid="batch-detail-loaded" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" style={{ color: 'var(--soft)' }}>
              <span data-testid="batch-detail-cutoff">
                {t.meta.cutoffLabel(formatDateTime(pageState.batch.cutoff))}
              </span>
              <span data-testid="batch-detail-generated">
                {t.meta.generatedLabel(formatDateTime(pageState.batch.createdAt), pageState.batch.createdBy.email)}
              </span>
              <span
                data-testid="batch-detail-reference"
                title={t.meta.referenceTooltip}
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ fontFamily: 'var(--mono)', color: 'var(--muted)', backgroundColor: 'var(--ink-soft)' }}
              >
                {t.meta.referenceLabel}: {pageState.batch.id}
              </span>
            </div>

            {pageState.batch.status === 'paid' && pageState.batch.paidAt && pageState.batch.paidBy && (
              <p className="text-sm" style={{ color: 'var(--grn)' }} data-testid="batch-detail-paid-line">
                {t.paidLine(formatDateTime(pageState.batch.paidAt), pageState.batch.paidBy.email)}
              </p>
            )}

            {pageState.batch.status === 'discarded' && pageState.batch.discardedAt && pageState.batch.discardedBy && (
              <p className="text-sm" style={{ color: 'var(--muted)' }} data-testid="batch-detail-discarded-line">
                {t.discardedLine(formatDateTime(pageState.batch.discardedAt), pageState.batch.discardedBy.email)}
              </p>
            )}

            <BatchSubtotalsPanel subtotals={pageState.batch.subtotals} />
            <BatchEmployeeGroupList mode="detail" groups={pageState.batch.employees} />

            <div className="flex flex-wrap items-center gap-3">
              {pageState.batch.pdf ? (
                <BatchPdfLink batchId={pageState.batch.id} />
              ) : (
                <span className="text-xs" style={{ color: 'var(--muted)' }} data-testid="batch-detail-pdf-unavailable">
                  {strings.components.batchPdfLink.unavailable}
                </span>
              )}
              <span className="text-sm" style={{ color: 'var(--soft)' }} data-testid="batch-detail-email-status">
                {t.email[pageState.batch.email.status ?? 'notAttempted']}
              </span>
              <button
                type="button"
                onClick={() => void handleResend()}
                disabled={resending}
                data-testid="batch-detail-resend-email"
                className="text-sm font-medium border px-2.5 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ borderColor: 'var(--rule)', color: 'var(--acc)' }}
              >
                {resending ? t.email.resendingLabel : t.email.resendButton}
              </button>
            </div>

            {emailToast && (
              <ToastBanner message={emailToast.message} tone={emailToast.tone} onDismiss={dismissEmailToast} />
            )}

            {pageState.batch.status === 'compiled' && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleMarkPaidOpen}
                  data-testid="batch-detail-mark-paid"
                  className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80"
                  style={{ borderColor: 'var(--grn)', color: 'var(--grn)' }}
                >
                  {t.markPaid.button}
                </button>
                <button
                  type="button"
                  onClick={handleDiscardOpen}
                  data-testid="batch-detail-discard"
                  className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80"
                  style={{ borderColor: 'var(--red)', color: 'var(--red)' }}
                >
                  {t.discard.button}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {markPaidDialog.open && pageState.status === 'loaded' && (
        <MarkPaidDialog
          requestCount={pageState.batch.requestCount}
          subtotals={pageState.batch.subtotals}
          emailStatus={pageState.batch.email.status}
          isConfirming={markPaidDialog.confirming}
          errorMessage={markPaidDialog.error}
          onConfirm={() => void handleMarkPaidConfirm()}
          onCancel={handleMarkPaidCancel}
        />
      )}

      {discardDialog.open && pageState.status === 'loaded' && (
        <ConfirmDeleteModal
          entityLabel={t.discard.entityLabel}
          itemName={pageState.batch.id}
          body={<p>{t.discard.body(pageState.batch.requestCount)}</p>}
          isDeleting={discardDialog.discarding}
          errorMessage={discardDialog.error}
          onConfirm={() => void handleDiscardConfirm()}
          onCancel={handleDiscardCancel}
          testIdPrefix="batch-discard-confirm"
        />
      )}
    </section>
  )
}
