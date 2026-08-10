import { useCallback, useEffect, useRef, useState } from 'react'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { strings } from '../strings'
import * as requestsApi from '../lib/requestsApi'
import type { Attachment, LinePayload, RefundRequestDetail } from '../lib/requestsApi'
import { SubmitValidationApiError } from '../lib/requestsApi'
import * as attachmentsApi from '../lib/attachmentsApi'
import { ApiError } from '../lib/refundApi'
import { formatDate } from '../lib/dates'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import GuardrailDialog from '../components/GuardrailDialog'
import RequestStatusBadge from '../components/RequestStatusBadge'
import ExpenseLineComposer from '../components/ExpenseLineComposer'
import ExpenseLineRow from '../components/ExpenseLineRow'
import type { LineSaveOutcome } from '../components/ExpenseLineRow'
import ToastBanner from '../components/ToastBanner'
import SubtotalsPanel from '../components/SubtotalsPanel'
import SubmitValidationSummary from '../components/SubmitValidationSummary'
import type { SubmitValidationSummaryItem } from '../components/SubmitValidationSummary'
import MonthlyProcessingNote from '../components/MonthlyProcessingNote'

const route = getRouteApi('/requests/$id')

/**
 * RequestDetailPage — Screen R2 (draft composer / request detail,
 * `/refund/requests/$id` — T16, specs/007-refund-service/tasks.md,
 * design.md "Screen R2"). Replaces T14's placeholder. One route, five
 * `status`-driven render variants plus L/Err/NF/G, exactly as design.md
 * lists them:
 *
 *   - `draft`     — ExpenseLineComposer, editable ExpenseLineRow list,
 *                   SubtotalsPanel (requested-only), Submit / Delete-request.
 *   - `submitted` — every editing control absent (not disabled);
 *                   RequestStatusBadge "Awaiting decision"; Withdraw only.
 *   - `approved`  — requested + approved per line and per currency;
 *                   MonthlyProcessingNote (only here — AC-4.2).
 *   - `rejected`  — rejection-motivation block; "+ New request" link.
 *   - `paid`      — (T13, specs/008-refund-monthly-processing/tasks.md,
 *                   design.md F5) the SAME requested+approved layout as
 *                   `approved` (reuses `ExpenseLineRow`'s `readOnlyApproved`
 *                   mode/`SubtotalsPanel showApproved` unchanged — reaching
 *                   `paid` adds a fact on top of the already-final approved
 *                   figures, it doesn't alter them) PLUS a "Paid on `<date>`"
 *                   line reading `paidAt`; MonthlyProcessingNote and
 *                   "+ New request" are structurally absent (not
 *                   conditionally hidden), same discipline `draft`/
 *                   `submitted` already get for MonthlyProcessingNote.
 *   - L    — SkeletonListRows while `GET /requests/:id` is in flight.
 *   - Err  — ErrorBanner + Retry (a genuine network/5xx failure).
 *   - NF   — neutral "doesn't exist or you don't have access" (never
 *            "permission denied" — AC-2.5/6.4's leak-avoidance).
 *   - G    — a 409 race on submit/withdraw/delete/line-edit surfaces
 *            GuardrailDialog; acknowledging has already reloaded the record
 *            underneath, so the screen reflects the real, current state.
 *
 * Mutations never merge partial responses into local state — every
 * successful add/edit/delete/submit/withdraw re-fetches the full record via
 * `GET /requests/:id` (`reloadRequest`) so `lines`/`subtotals` are always
 * server-truth (plan.md R7: money/subtotal math is never re-derived
 * client-side).
 *
 * A11y (design.md "## Accessibility"): focus moves to the status heading
 * immediately after submit/withdraw (`justTransitioned` + `headingRef`,
 * the same `tabIndex={-1}` + `ref.current?.focus()` technique
 * `PermissionDenied.tsx` uses); lifecycle confirmations (submit/withdraw/
 * delete-request/decisions) stay `aria-live="polite"` inline text, never a
 * toast (design.md: "never a toast that could be missed" — that anti-toast
 * posture is specifically about consequential, once-per-request lifecycle
 * actions). `SubmitValidationSummary`'s jump links focus+scroll the
 * offending `ExpenseLineRow` via `rowNodesRef`.
 *
 * Content-app auto-save (specs/NNN, distinct from the lifecycle posture
 * above): a `draft`-status line's field edits auto-save debounced 1500ms
 * after the last change (or immediately on blur-outside/Done —
 * `ExpenseLineRow`'s own concern), and DO surface a page-level `ToastBanner`
 * ("Changes stored" / the RFC 7807 `detail` on failure) via `lineSaveToast` +
 * `ExpenseLineRow`'s `onSaveOutcome` — one toast at a time, success
 * auto-dismisses. This is a narrower, lower-stakes confirmation than a
 * lifecycle transition (it's reversible — the field can just be edited
 * again) and is genuinely easy to miss without *some* transient feedback
 * beyond the row's own inline "Saving…"/error text, which is why it's the
 * one confirmation in this file that IS a toast.
 */

type PageState =
  | { status: 'loading' }
  | { status: 'notFound' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; request: RefundRequestDetail }

type DeleteModalState = { open: false } | { open: true; isDeleting: boolean; error: string | null }

type GuardrailState = { title: string; message: string } | null

const errorMessageFor = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) return error.detail ?? error.title
  return fallback
}

export default function RequestDetailPage() {
  const { id } = route.useParams()
  const navigate = useNavigate()
  const t = strings.pages.requestDetail

  const [pageState, setPageState] = useState<PageState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [deleteModal, setDeleteModal] = useState<DeleteModalState>({ open: false })
  const [guardrail, setGuardrail] = useState<GuardrailState>(null)
  const [submitting, setSubmitting] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitValidation, setSubmitValidation] = useState<SubmitValidationSummaryItem[]>([])
  const [liveMessage, setLiveMessage] = useState('')
  const [justTransitioned, setJustTransitioned] = useState(false)
  // Draft-mode line auto-save toast (content-app auto-save) — one at a time,
  // driven by ExpenseLineRow's onSaveOutcome. Distinct from `actionError`
  // (Submit/Withdraw/Delete-request, which stay inline per design.md).
  const [lineSaveToast, setLineSaveToast] = useState<LineSaveOutcome | null>(null)

  const headingRef = useRef<HTMLHeadingElement>(null)
  const rowNodesRef = useRef(new Map<string, HTMLDivElement>())

  // ---------------------------------------------------------------------------
  // Load — Promise chain (react-hooks/set-state-in-effect; mirrors RolesPage.tsx)
  // ---------------------------------------------------------------------------

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

  // Focus the record-not-found heading on mount too (mirrors NotFoundPage.tsx).
  useEffect(() => {
    if (pageState.status === 'notFound') {
      headingRef.current?.focus()
    }
  }, [pageState.status])

  // Focus the status heading right after a submit/withdraw transition completes.
  useEffect(() => {
    if (justTransitioned) {
      headingRef.current?.focus()
      setJustTransitioned(false)
    }
  }, [justTransitioned])

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

  // ---------------------------------------------------------------------------
  // Line mutations — every one re-fetches on success; a 409 surfaces the
  // shared GuardrailDialog instead of propagating to the caller.
  // ---------------------------------------------------------------------------

  const runLineMutation = useCallback(
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

  const handleAddLine = useCallback(
    (payload: LinePayload) => runLineMutation(() => requestsApi.addLine(id, payload)),
    [id, runLineMutation],
  )

  const handleUpdateLine = useCallback(
    (lineId: string, payload: LinePayload) => runLineMutation(() => requestsApi.updateLine(id, lineId, payload)),
    [id, runLineMutation],
  )

  const handleDeleteLine = useCallback(
    (lineId: string) => runLineMutation(() => requestsApi.removeLine(id, lineId)),
    [id, runLineMutation],
  )

  const handleLineSaveOutcome = useCallback((outcome: LineSaveOutcome) => setLineSaveToast(outcome), [])
  const dismissLineSaveToast = useCallback(() => setLineSaveToast(null), [])

  const registerRowRef = useCallback(
    (lineId: string) => (node: HTMLDivElement | null) => {
      if (node) rowNodesRef.current.set(lineId, node)
      else rowNodesRef.current.delete(lineId)
    },
    [],
  )

  const handleJumpToLine = useCallback((lineId: string) => {
    const node = rowNodesRef.current.get(lineId)
    if (!node) return
    // Optional chaining guards environments without `scrollIntoView` (e.g. jsdom in tests) —
    // focus is the part assistive tech and keyboard users actually depend on.
    node.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    node.focus()
  }, [])

  // ---------------------------------------------------------------------------
  // Attachment mutations (T17, specs/007-refund-service/tasks.md) — mint/
  // upload/confirm and remove are draft-only on the wire (same 409 → mint-only
  // routes as line mutations, plan.md "### Employee endpoints"); a 409 here
  // surfaces the same GuardrailDialog + reload as `runLineMutation`, then
  // rethrows so `AttachmentList`'s per-file item shows `failed` too (the
  // dialog already explains why; the row's own status text just needs to
  // stop reading "Uploading…" forever). `handleDownloadAttachment` is a
  // plain read (mint a signed GET) — no draft-only guard, no reload.
  // ---------------------------------------------------------------------------

  const handleUploadAttachment = useCallback(
    async (lineId: string, file: File): Promise<Attachment> => {
      try {
        const attachment = await attachmentsApi.uploadAttachment(id, lineId, file)
        await reloadRequest()
        return attachment
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setGuardrail({ title: t.guardrail.title, message: t.guardrail.message })
          await reloadRequest()
        }
        throw err
      }
    },
    [id, reloadRequest, t.guardrail.message, t.guardrail.title],
  )

  const handleRemoveAttachment = useCallback(
    (lineId: string, attachmentId: string) =>
      runLineMutation(() => attachmentsApi.removeAttachment(id, lineId, attachmentId)),
    [id, runLineMutation],
  )

  const handleDownloadAttachment = useCallback(
    (lineId: string, attachmentId: string) => attachmentsApi.getDownloadUrl(id, lineId, attachmentId),
    [id],
  )

  // ---------------------------------------------------------------------------
  // Submit / withdraw (design.md F2 steps 1-2)
  // ---------------------------------------------------------------------------

  const handleSubmit = useCallback(async () => {
    if (pageState.status !== 'loaded') return
    setSubmitting(true)
    setActionError(null)
    setSubmitValidation([])
    try {
      const updated = await requestsApi.submit(pageState.request.id)
      setPageState({ status: 'loaded', request: updated })
      setLiveMessage(t.submit.confirmation)
      setJustTransitioned(true)
    } catch (err) {
      if (err instanceof SubmitValidationApiError) {
        const lines = pageState.request.lines
        setSubmitValidation(
          err.offendingLineIds.map((lineId) => {
            const line = lines.find((l) => l.id === lineId)
            const label = line
              ? `${line.date} · ${line.motivo || t.validationSummary.noMotivo}`
              : t.validationSummary.fallbackLineLabel(lineId)
            return { lineId, label }
          }),
        )
      } else if (err instanceof ApiError && err.status === 409) {
        setGuardrail({ title: t.guardrail.title, message: t.guardrail.message })
        await reloadRequest()
      } else {
        setActionError(errorMessageFor(err, t.submit.genericError))
      }
    } finally {
      setSubmitting(false)
    }
  }, [pageState, reloadRequest, t])

  const handleWithdraw = useCallback(async () => {
    if (pageState.status !== 'loaded') return
    setWithdrawing(true)
    setActionError(null)
    try {
      const updated = await requestsApi.withdraw(pageState.request.id)
      setPageState({ status: 'loaded', request: updated })
      setLiveMessage(t.withdraw.confirmation)
      setJustTransitioned(true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setGuardrail({ title: t.withdraw.guardrailTitle, message: t.withdraw.guardrailMessage })
        await reloadRequest()
      } else {
        setActionError(errorMessageFor(err, t.withdraw.genericError))
      }
    } finally {
      setWithdrawing(false)
    }
  }, [pageState, reloadRequest, t])

  // ---------------------------------------------------------------------------
  // Delete request (design.md F1 step 7)
  // ---------------------------------------------------------------------------

  const handleDeleteRequestOpen = useCallback(() => {
    setDeleteModal({ open: true, isDeleting: false, error: null })
  }, [])

  const handleDeleteRequestCancel = useCallback(() => {
    setDeleteModal({ open: false })
  }, [])

  const handleDeleteRequestConfirm = useCallback(async () => {
    if (pageState.status !== 'loaded') return
    setDeleteModal((prev) => (prev.open ? { ...prev, isDeleting: true, error: null } : prev))
    try {
      await requestsApi.remove(pageState.request.id)
      setDeleteModal({ open: false })
      void navigate({ to: '/requests' })
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDeleteModal({ open: false })
        setGuardrail({ title: t.guardrail.title, message: t.guardrail.message })
        await reloadRequest()
      } else {
        setDeleteModal((prev) =>
          prev.open ? { ...prev, isDeleting: false, error: errorMessageFor(err, 'Delete failed. Try again.') } : prev,
        )
      }
    }
  }, [pageState, navigate, reloadRequest, t.guardrail.message, t.guardrail.title])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section aria-labelledby="refund-request-detail-heading" data-testid="refund-request-detail-page">
      <span className="sr-only" data-testid="refund-request-detail-id">
        {id}
      </span>

      {guardrail && (
        <GuardrailDialog title={guardrail.title} message={guardrail.message} onAcknowledge={() => setGuardrail(null)} />
      )}

      {pageState.status === 'loaded' ? (
        <div className="flex items-center gap-3">
          <h2
            id="refund-request-detail-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold outline-none"
            style={{ fontFamily: 'var(--disp)' }}
          >
            {t.heading}
          </h2>
          <RequestStatusBadge status={pageState.request.status} />
        </div>
      ) : (
        <h2
          id="refund-request-detail-heading"
          ref={pageState.status === 'notFound' ? headingRef : undefined}
          tabIndex={pageState.status === 'notFound' ? -1 : undefined}
          className="text-lg font-semibold outline-none"
          style={{ fontFamily: 'var(--disp)' }}
        >
          {pageState.status === 'notFound' ? t.notFound.heading : t.heading}
        </h2>
      )}

      <p aria-live="polite" className="sr-only" data-testid="request-detail-live-message">
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

        {pageState.status === 'notFound' && (
          <div data-testid="request-detail-not-found">
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              {t.notFound.body}
            </p>
            <Link
              to="/requests"
              data-testid="request-detail-not-found-back"
              className="mt-3 inline-block text-sm underline underline-offset-2"
              style={{ color: 'var(--acc)' }}
            >
              {t.notFound.backLink}
            </Link>
          </div>
        )}

        {pageState.status === 'loaded' && pageState.request.status === 'draft' && (
          <div data-testid="request-detail-draft" className="flex flex-col gap-4">
            <ExpenseLineComposer onAdd={handleAddLine} />

            {lineSaveToast && (
              <ToastBanner tone={lineSaveToast.tone} message={lineSaveToast.message} onDismiss={dismissLineSaveToast} />
            )}

            <div className="flex flex-col gap-2 pt-1 border-t" style={{ borderColor: 'var(--rule)' }}>
              <h3
                className="text-sm font-semibold"
                style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
                data-testid="request-detail-lines-heading"
              >
                {t.lines.sectionHeading(pageState.request.lines.length)}
              </h3>

              {pageState.request.lines.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--soft)' }} data-testid="request-detail-lines-empty">
                  {t.lines.emptyDraft}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {pageState.request.lines.map((line) => (
                    <ExpenseLineRow
                      key={line.id}
                      line={line}
                      mode="edit"
                      onCommit={(payload) => handleUpdateLine(line.id, payload)}
                      onDelete={() => handleDeleteLine(line.id)}
                      onSaveOutcome={handleLineSaveOutcome}
                      onUploadAttachment={(file) => handleUploadAttachment(line.id, file)}
                      onRemoveAttachment={(attachmentId) => handleRemoveAttachment(line.id, attachmentId)}
                      onDownloadAttachment={(attachmentId) => handleDownloadAttachment(line.id, attachmentId)}
                      registerRef={registerRowRef(line.id)}
                    />
                  ))}
                </div>
              )}
            </div>

            <SubtotalsPanel subtotals={pageState.request.subtotals} />

            {submitValidation.length > 0 && (
              <SubmitValidationSummary items={submitValidation} onJump={handleJumpToLine} />
            )}

            {actionError && (
              <p
                role="alert"
                data-testid="request-detail-action-error"
                className="text-sm"
                style={{ color: 'var(--red)' }}
              >
                {actionError}
              </p>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={pageState.request.lines.length === 0 || submitting}
                data-testid="request-detail-submit"
                className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
              >
                {submitting ? t.submit.submittingLabel : t.submit.button}
              </button>
              {pageState.request.lines.length === 0 && (
                <p
                  className="text-xs"
                  style={{ color: 'var(--muted)' }}
                  data-testid="request-detail-submit-blocked-note"
                >
                  {t.submit.blockedNote}
                </p>
              )}
              <button
                type="button"
                onClick={handleDeleteRequestOpen}
                data-testid="request-detail-delete-request"
                className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80"
                style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
              >
                {t.deleteRequest.button}
              </button>
            </div>
          </div>
        )}

        {pageState.status === 'loaded' && pageState.request.status === 'submitted' && (
          <div data-testid="request-detail-submitted" className="flex flex-col gap-4">
            <p className="text-sm" style={{ color: 'var(--soft)' }}>
              {t.statusBadges.submittedNote}
            </p>
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
            {actionError && (
              <p
                role="alert"
                data-testid="request-detail-action-error"
                className="text-sm"
                style={{ color: 'var(--red)' }}
              >
                {actionError}
              </p>
            )}
            <div>
              <button
                type="button"
                onClick={() => void handleWithdraw()}
                disabled={withdrawing}
                data-testid="request-detail-withdraw"
                className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
              >
                {withdrawing ? t.withdraw.withdrawingLabel : t.withdraw.button}
              </button>
            </div>
          </div>
        )}

        {pageState.status === 'loaded' && pageState.request.status === 'approved' && (
          <div data-testid="request-detail-approved" className="flex flex-col gap-4">
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
          <div data-testid="request-detail-rejected" className="flex flex-col gap-4">
            <div
              className="px-4 py-3 rounded-md border text-sm"
              style={{ borderColor: 'var(--red)', backgroundColor: 'color-mix(in srgb, var(--red) 8%, transparent)' }}
              data-testid="request-detail-rejection-motivation"
            >
              <p className="font-medium mb-1" style={{ color: 'var(--red)' }}>
                {t.rejected.motivationHeading}
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
            <Link
              to="/requests/new"
              data-testid="request-detail-new-request-link"
              className="inline-block text-sm py-1.5 px-3 font-medium transition-opacity hover:opacity-90 self-start"
              style={{ color: 'white', backgroundColor: 'var(--acc)' }}
            >
              {t.rejected.newRequestLink}
            </Link>
          </div>
        )}

        {pageState.status === 'loaded' && pageState.request.status === 'paid' && (
          <div data-testid="request-detail-paid" className="flex flex-col gap-4">
            {pageState.request.paidAt && (
              <p className="text-sm" style={{ color: 'var(--grn)' }} data-testid="request-detail-paid-line">
                {t.paid.paidLine(formatDate(pageState.request.paidAt))}
              </p>
            )}
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
          </div>
        )}
      </div>

      {deleteModal.open && pageState.status === 'loaded' && (
        <ConfirmDeleteModal
          entityLabel={t.deleteRequest.entityLabel}
          itemName={pageState.request.id}
          body={t.deleteRequest.body(pageState.request.lines.length)}
          isDeleting={deleteModal.isDeleting}
          errorMessage={deleteModal.error}
          onConfirm={() => void handleDeleteRequestConfirm()}
          onCancel={handleDeleteRequestCancel}
        />
      )}
    </section>
  )
}
