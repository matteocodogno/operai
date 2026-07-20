import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { strings } from '../strings'
import * as batchesApi from '../lib/batchesApi'
import type { CandidatePreview } from '../lib/batchesApi'
import { ApiError } from '../lib/refundApi'
import { formatDateTime } from '../lib/dates'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import PermissionDenied from '../components/PermissionDenied'
import ConfirmDeleteModal from '../components/ConfirmDeleteModal'
import GuardrailDialog from '../components/GuardrailDialog'
import BatchSubtotalsPanel from '../components/BatchSubtotalsPanel'
import BatchEmployeeGroupList from '../components/BatchEmployeeGroupList'

/**
 * CompileBatchPage — Screen B2 ("Compile & preview", `/refund/batches/new`
 * — T11, specs/008-refund-monthly-processing/tasks.md, design.md F1/Screen
 * B2). Replaces T9's placeholder.
 *
 * Loads with the cutoff pre-filled to "now" and immediately fires
 * `GET /batches/candidates` — a dry-run, no-writes preview — so the accounting
 * user sees the candidate set (and, crucially, an EMPTY one, AC-1.4) before
 * ever clicking Compile.
 *
 * **Frozen-cutoff WYSIWYG (design.md F1 step 2, Gap #2):** `activeCutoffIso`
 * is the single source of truth for "the cutoff that produced the preview
 * currently on screen" — it changes ONLY when the user clicks "Preview" (or
 * retries), never silently at compile time. `POST /batches` always sends
 * exactly this value, so the candidate set the user reviewed is the set that
 * gets compiled.
 *
 * States (design.md "L/E/P/Err/PD"):
 *   L   — SkeletonListRows + an sr-only "Loading candidates" announcement.
 *   E   — the compile-empty-set refusal (AC-1.4): a real, successful, empty
 *         result, not an error — "Compile this batch" is disabled.
 *   P   — overall BatchSubtotalsPanel + BatchEmployeeGroupList (mode
 *         `preview`); "Compile this batch" enabled.
 *   Err — ErrorBanner + Retry (a genuine network/5xx failure).
 *   PD  — PermissionDenied (AC-1.8, no `request:review` at all), no Retry —
 *         defense-in-depth for a direct URL (Screen B1's own "+ Compile" is
 *         itself gated, design.md F1 step 6).
 *
 * Compile confirm reuses `ConfirmDeleteModal` directly with `tone="positive"`
 * (design.md F1 step 6 — no dedicated wrapper, this dialog's copy is used
 * nowhere else). A 422 (the candidate set changed since the last preview) is
 * surfaced in the dialog's own inline `errorMessage` slot, not a
 * `GuardrailDialog` — this is "changed under you", not "already decided".
 * Canceling the dialog re-runs the preview for the same frozen cutoff so the
 * screen reflects the new reality either way (design.md F1 step 6).
 *
 * A 201 navigates to Screen B3 (`/refund/batches/$id`) carrying a one-shot
 * `confirmation` search param, the same technique `ReviewQueuePage`/
 * `ReviewDetailPage` already use for Approve/Reject, applied here to a
 * DETAIL route instead of a list route (design.md F1 step 6, Gap #4).
 */

type PreviewState =
  | { status: 'loading' }
  | { status: 'loaded'; preview: CandidatePreview }
  | { status: 'error'; message: string }
  | { status: 'forbidden' }

type CompileDialogState = { open: false } | { open: true; compiling: boolean; error: string | null }

const errorMessageFor = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) return error.detail ?? error.title
  return fallback
}

/** `<input type="datetime-local">` has no timezone — this is the browser's own local-time value format (`yyyy-MM-ddTHH:mm`). */
const toDatetimeLocalValue = (date: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Parses a `datetime-local` value (interpreted in the browser's local timezone) into an ISO 8601 UTC instant. `null` for an unparseable/empty value. */
const datetimeLocalToIso = (value: string): string | null => {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

export default function CompileBatchPage() {
  const navigate = useNavigate()
  const t = strings.pages.compileBatch

  const [cutoffInput, setCutoffInput] = useState(() => toDatetimeLocalValue(new Date()))
  const [activeCutoffIso, setActiveCutoffIso] = useState(() => datetimeLocalToIso(cutoffInput) as string)
  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [compileDialog, setCompileDialog] = useState<CompileDialogState>({ open: false })
  // The empty-candidate warning modal is a response to an explicit "Preview"
  // click, NOT to the initial auto-load (which the user reaches just by opening
  // the screen) nor to error retries / post-cancel refreshes. `previewInitiatedRef`
  // marks the in-flight load as user-initiated; the effect consumes it and only
  // then opens the warning when the result is empty.
  const previewInitiatedRef = useRef(false)
  const [emptyWarningOpen, setEmptyWarningOpen] = useState(false)

  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setPreviewState({ status: 'loading' })
      })
      .then(() => batchesApi.listCandidates(activeCutoffIso))
      .then((preview) => {
        if (cancelled) return
        setPreviewState({ status: 'loaded', preview })
        const userInitiated = previewInitiatedRef.current
        previewInitiatedRef.current = false
        if (userInitiated && preview.requestCount === 0) setEmptyWarningOpen(true)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        previewInitiatedRef.current = false
        if (error instanceof ApiError && error.status === 403) {
          setPreviewState({ status: 'forbidden' })
        } else {
          setPreviewState({ status: 'error', message: errorMessageFor(error, t.loadErrorFallback) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeCutoffIso, reloadToken, t.loadErrorFallback])

  const handleRetry = useCallback(() => {
    setReloadToken((n) => n + 1)
  }, [])

  const handlePreviewClick = useCallback(() => {
    const iso = datetimeLocalToIso(cutoffInput)
    if (iso === null) return
    // Mark this load as user-initiated so the effect surfaces the empty-set
    // warning modal if it comes back with no candidates.
    previewInitiatedRef.current = true
    setActiveCutoffIso(iso)
    setReloadToken((n) => n + 1)
  }, [cutoffInput])

  const handleCompileOpen = useCallback(() => {
    setCompileDialog({ open: true, compiling: false, error: null })
  }, [])

  const handleCompileCancel = useCallback(() => {
    setCompileDialog({ open: false })
    // Re-run the preview for the same frozen cutoff so the screen reflects
    // the current reality (design.md F1 step 6) — a no-op refresh in the
    // common case, the recovery path after a 422 race.
    setReloadToken((n) => n + 1)
  }, [])

  const handleCompileConfirm = useCallback(async () => {
    if (previewState.status !== 'loaded') return
    setCompileDialog((prev) => (prev.open ? { ...prev, compiling: true, error: null } : prev))
    try {
      const batch = await batchesApi.compile(activeCutoffIso)
      setCompileDialog({ open: false })
      void navigate({
        to: '/batches/$id',
        params: { id: batch.id },
        search: { confirmation: t.successConfirmation(batch.requestCount) },
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        setCompileDialog((prev) => (prev.open ? { ...prev, compiling: false, error: t.confirm.staleCandidatesError } : prev))
      } else {
        setCompileDialog((prev) =>
          prev.open ? { ...prev, compiling: false, error: errorMessageFor(err, t.confirm.genericError) } : prev,
        )
      }
    }
  }, [previewState, activeCutoffIso, navigate, t])

  const canCompile = previewState.status === 'loaded' && previewState.preview.requestCount > 0

  return (
    <section aria-labelledby="refund-compile-batch-heading" data-testid="refund-compile-batch-page">
      <div className="flex items-center justify-between gap-4">
        <h2 id="refund-compile-batch-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
          {t.heading}
        </h2>
        <Link
          to="/batches"
          data-testid="compile-batch-cancel-link"
          className="text-sm underline underline-offset-2"
          style={{ color: 'var(--acc)' }}
        >
          {t.cancelLink}
        </Link>
      </div>

      {previewState.status === 'forbidden' ? (
        <div className="mt-4">
          <PermissionDenied />
        </div>
      ) : (
        <>
          <div className="mt-4" data-testid="compile-batch-cutoff-row">
            <label
              htmlFor="compile-batch-cutoff"
              className="block text-sm font-medium mb-1"
              style={{ color: 'var(--text)' }}
            >
              {t.cutoffLabel}
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <input
                id="compile-batch-cutoff"
                type="datetime-local"
                value={cutoffInput}
                onChange={(e) => setCutoffInput(e.target.value)}
                aria-describedby="compile-batch-cutoff-help"
                data-testid="compile-batch-cutoff-input"
                className="text-sm px-2.5 py-1.5 rounded-md border"
                style={{
                  borderColor: 'var(--rule)',
                  backgroundColor: 'var(--ink-soft)',
                  color: 'var(--text)',
                  colorScheme: 'dark',
                }}
              />
              <button
                type="button"
                onClick={handlePreviewClick}
                data-testid="compile-batch-preview-button"
                className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80"
                style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
              >
                {t.previewButton}
              </button>
            </div>
            <p id="compile-batch-cutoff-help" className="text-xs max-w-sm mt-1" style={{ color: 'var(--muted)' }}>
              {t.cutoffHelp}
            </p>
          </div>

          <div className="mt-4">
            {previewState.status === 'loading' && (
              <>
                <p className="sr-only" aria-live="polite">
                  {t.loadingAnnouncement}
                </p>
                <SkeletonListRows />
              </>
            )}

            {previewState.status === 'error' && <ErrorBanner message={previewState.message} onRetry={handleRetry} />}

            {previewState.status === 'loaded' && previewState.preview.requestCount === 0 && (
              <p
                className="text-sm py-16 text-center"
                style={{ color: 'var(--muted)' }}
                data-testid="compile-batch-empty-state"
                aria-live="polite"
              >
                {t.empty}
              </p>
            )}

            {previewState.status === 'loaded' && previewState.preview.requestCount > 0 && (
              <div className="flex flex-col gap-4" data-testid="compile-batch-preview">
                <BatchSubtotalsPanel subtotals={previewState.preview.subtotals} />
                <BatchEmployeeGroupList mode="preview" groups={previewState.preview.employees} />
              </div>
            )}
          </div>

          <div className="mt-4">
            <button
              type="button"
              onClick={handleCompileOpen}
              disabled={!canCompile}
              data-testid="compile-batch-compile-button"
              className="py-2 px-4 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ borderColor: 'var(--grn)', color: 'var(--grn)' }}
            >
              {t.compileButton}
            </button>
          </div>
        </>
      )}

      {emptyWarningOpen && (
        <GuardrailDialog
          title={t.emptyWarning.title}
          message={t.emptyWarning.message}
          onAcknowledge={() => setEmptyWarningOpen(false)}
        />
      )}

      {compileDialog.open && previewState.status === 'loaded' && (
        <ConfirmDeleteModal
          entityLabel=""
          itemName=""
          tone="positive"
          title={t.confirm.title}
          body={<p>{t.confirm.body(previewState.preview.requestCount, formatDateTime(activeCutoffIso))}</p>}
          confirmLabel={t.confirm.confirmLabel}
          confirmingLabel={t.confirm.confirmingLabel}
          isDeleting={compileDialog.compiling}
          errorMessage={compileDialog.error}
          onConfirm={() => void handleCompileConfirm()}
          onCancel={handleCompileCancel}
          testIdPrefix="compile-batch-confirm"
        />
      )}
    </section>
  )
}
