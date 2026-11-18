import { useCallback, useEffect, useRef, useState } from 'react'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { Banner, Button, Card, Icon, PageHeader, VisuallyHidden, useFocusOnMount } from '@operai/ui'
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
import AccountingExportCard from '../components/AccountingExportCard'

const route = getRouteApi('/batches/$id')

/**
 * BatchDetailPage — Screen B3 ("Batch detail", `/refund/batches/$id` — T12,
 * specs/20260719-refund-monthly-processing/tasks.md, design.md "Screen B3"/F2/F3/
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
  // INC-19: the post-compile confirmation is shown, not only announced.
  const [visibleConfirmation, setVisibleConfirmation] = useState<string | null>(null)
  const [justTransitioned, setJustTransitioned] = useState(false)

  // The not-found heading takes focus when that state replaces the page (INC-30).
  const headingRef = useFocusOnMount<HTMLHeadingElement>(pageState.status === 'notFound')
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

  // Focus the status heading right after a mark-paid/discard transition completes.
  useEffect(() => {
    if (justTransitioned) {
      headingRef.current?.focus()
      setJustTransitioned(false)
    }
  }, [justTransitioned, headingRef])

  // Announce the one-shot post-compile confirmation once, then strip it from the URL.
  useEffect(() => {
    if (!confirmation || strippedConfirmationRef.current) return
    strippedConfirmationRef.current = true
    setLiveMessage(confirmation)
    setVisibleConfirmation(confirmation)
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

  /** The export card found the batch discarded (409 `batch_discarded`): say so, and reload so the card goes (AC-6.9). */
  const handleExportBatchDiscarded = useCallback(() => {
    setLiveMessage(t.accountingExport.discardedAnnouncement)
    void reloadBatch()
  }, [reloadBatch, t.accountingExport.discardedAnnouncement])

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

      <PageHeader
        title={pageState.status === 'notFound' ? t.notFound.heading : t.heading}
        titleId="refund-batch-detail-heading"
        headingRef={pageState.status === 'loaded' || pageState.status === 'notFound' ? headingRef : undefined}
        focusableHeading={pageState.status === 'loaded' || pageState.status === 'notFound'}
        status={pageState.status === 'loaded' && <BatchStatusBadge status={pageState.batch.status} />}
        back={
          pageState.status !== 'notFound' && (
            <Link to="/batches" className="link inline-flex items-center gap-1" data-testid="batch-detail-back">
              <Icon name="arrow-left" />
              {t.notFound.backLink}
            </Link>
          )
        }
      />

      <VisuallyHidden live data-testid="batch-detail-live-message">
        {liveMessage}
      </VisuallyHidden>

      {/* The visible copy of the post-compile confirmation the live region above
          announces — `aria-live="off"` so a screen reader hears it once. */}
      {visibleConfirmation && (
        <Banner
          tone="success"
          compact
          aria-live="off"
          autoDismiss
          onDismiss={() => setVisibleConfirmation(null)}
          dismissLabel={t.confirmationDismissLabel}
          className="mt-4"
          data-testid="batch-detail-confirmation"
        >
          {visibleConfirmation}
        </Banner>
      )}

      <div className="mt-4 flex flex-col gap-4">
        {pageState.status === 'loading' && (
          <>
            <VisuallyHidden live>{t.loadingAnnouncement}</VisuallyHidden>
            <SkeletonListRows />
          </>
        )}

        {pageState.status === 'error' && <ErrorBanner message={pageState.message} onRetry={handleRetry} />}

        {pageState.status === 'forbidden' && <PermissionDenied />}

        {pageState.status === 'notFound' && (
          <div data-testid="batch-detail-not-found">
            <p className="text-sm text-soft">{t.notFound.body}</p>
            <Link to="/batches" data-testid="batch-detail-not-found-back" className="link mt-3 inline-block text-sm">
              {t.notFound.backLink}
            </Link>
          </div>
        )}

        {pageState.status === 'loaded' && (
          <div data-testid="batch-detail-loaded" className="flex flex-col gap-4">
            <Card title={t.summaryHeading}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-soft">
                <span data-testid="batch-detail-cutoff">
                  {t.meta.cutoffLabel(formatDateTime(pageState.batch.cutoff))}
                </span>
                <span data-testid="batch-detail-generated">
                  {t.meta.generatedLabel(formatDateTime(pageState.batch.createdAt), pageState.batch.createdBy.email)}
                </span>
                <span
                  data-testid="batch-detail-reference"
                  title={t.meta.referenceTooltip}
                  className="text-xs px-1.5 py-0.5 rounded font-mono text-soft bg-ink"
                >
                  {t.meta.referenceLabel}: {pageState.batch.id}
                </span>
              </div>

              {pageState.batch.status === 'paid' && pageState.batch.paidAt && pageState.batch.paidBy && (
                <p className="text-sm text-grn-text" data-testid="batch-detail-paid-line">
                  {t.paidLine(formatDateTime(pageState.batch.paidAt), pageState.batch.paidBy.email)}
                </p>
              )}

              {pageState.batch.status === 'discarded' && pageState.batch.discardedAt && pageState.batch.discardedBy && (
                <p className="text-sm text-soft" data-testid="batch-detail-discarded-line">
                  {t.discardedLine(formatDateTime(pageState.batch.discardedAt), pageState.batch.discardedBy.email)}
                </p>
              )}

              <BatchSubtotalsPanel subtotals={pageState.batch.subtotals} />

              <div className="flex flex-wrap items-center gap-3">
                {pageState.batch.pdf ? (
                  <BatchPdfLink batchId={pageState.batch.id} />
                ) : (
                  <span className="text-xs text-soft" data-testid="batch-detail-pdf-unavailable">
                    {strings.components.batchPdfLink.unavailable}
                  </span>
                )}
                <span className="text-sm text-soft" data-testid="batch-detail-email-status">
                  {t.email[pageState.batch.email.status ?? 'notAttempted']}
                </span>
                <Button
                  variant="secondary"
                  onClick={() => void handleResend()}
                  disabled={resending}
                  data-testid="batch-detail-resend-email"
                  busy={resending}
                >
                  {resending ? t.email.resendingLabel : t.email.resendButton}
                </Button>
              </div>

              {emailToast && (
                <ToastBanner message={emailToast.message} tone={emailToast.tone} onDismiss={dismissEmailToast} />
              )}
            </Card>

            {/* Not for a discarded batch (AC-6.9): nothing of it is exported. The card loads on its own. */}
            {pageState.batch.status !== 'discarded' && (
              <AccountingExportCard
                batchId={pageState.batch.id}
                cutoff={pageState.batch.cutoff}
                onBatchDiscarded={handleExportBatchDiscarded}
              />
            )}

            <BatchEmployeeGroupList mode="detail" groups={pageState.batch.employees} />

            {pageState.batch.status === 'compiled' && (
              <div className="flex items-center gap-3">
                <Button variant="primary" onClick={handleMarkPaidOpen} data-testid="batch-detail-mark-paid">
                  {t.markPaid.button}
                </Button>
                <Button variant="danger" onClick={handleDiscardOpen} data-testid="batch-detail-discard">
                  {t.discard.button}
                </Button>
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
