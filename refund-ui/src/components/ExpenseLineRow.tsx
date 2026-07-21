/**
 * ExpenseLineRow — one expense line, in one of four modes (T16/T18,
 * specs/007-refund-service/tasks.md; **post-close UX amendment, specs/007,
 * 2026-07-17** — see `specs/007-refund-service/design.md`'s dated amendment
 * note for the full rationale):
 *
 *   - `edit` (Screen R2 `draft` variant): a committed line renders as a
 *     **compact read-only summary row** by default (date, type, motivo,
 *     `formatMoney` amount, `EntityBadge`/`CurrencyBadge`, a small "N files"
 *     attachment indicator when the line has attachments) with native
 *     "Edit" and "Delete" buttons — NOT an always-open field form. Clicking
 *     "Edit" expands the row inline into the full editable field layout
 *     (Date/Type/Motivo/Amount/Entity/Currency, the type-driven `km` field,
 *     and the full `AttachmentList` in upload/remove mode) exactly as this
 *     component always rendered pre-amendment; fields are buffered in local
 *     draft state exactly like `estimai-ui/src/components/
 *     ActivityTable.tsx`'s `EpicCell`/`MLCell` (value diverges from the
 *     committed line until focus leaves the row), then commits as ONE `PUT
 *     /requests/:id/lines/:lineId` carrying the whole line object — not
 *     per-keystroke, not per-field (design.md F1 step 4). Detected via the
 *     row container's own `onBlur` + `e.relatedTarget` (focus landing outside
 *     this row's DOM subtree), not each field's individual blur, so tabbing
 *     between this row's own fields never fires a PUT per field. A **Done**
 *     button collapses the row back to its summary — Done does not introduce
 *     a second save path, it explicitly calls the SAME `commit()` the
 *     blur-outside path uses (a click on a button living inside this row's
 *     own container never satisfies the "focus left the row" blur check), so
 *     an edit made and finished via Done is never silently dropped.
 *     Deleting a committed line now opens a `ConfirmDeleteModal` (overrides
 *     the original no-confirm decision — the user asked for the safety net
 *     post-close) naming the line's type + motivo; a `title` tooltip on the
 *     Edit/Delete buttons remains as a secondary affordance.
 *   - `readOnly` (Screen R2 `submitted`/`rejected` variants, and Screen A2's
 *     own decided-request RO render, T18 F6 step 8): plain text, no inputs,
 *     no delete — editing controls are absent, not disabled (design.md F2
 *     step 3). Shares the same summary presentation `edit` mode's collapsed
 *     row uses (date/type/motivo/badges/amounts), just without Edit/Delete —
 *     these renders were already compact/read-only pre-amendment, this just
 *     makes the visual language explicitly the same one. `AttachmentList`
 *     renders in download-only mode here too — a submitted/decided line's
 *     receipts stay viewable, just not editable (T17: "AttachmentDownloadLink
 *     … used by … the RO employee variants").
 *   - `readOnlyApproved` (Screen R2 `approved` variant, and A2's decided
 *     `approved` render): same as `readOnly` plus the line's finalized
 *     approved total alongside its requested amount (AC-3.2).
 *   - `review` (Screen A2, `submitted`, decidable — T18, design.md F6 step
 *     1-2): same read-only field display as `readOnly` (accounting never
 *     edits date/type/motivo/entity/km — only the employee does, pre-submit)
 *     plus an editable **approved-total input**, visually pre-filled with
 *     `approvedTotalCents ?? requestedAmountCents` (AC-7.1). Write-on-
 *     change-only (design.md F6 step 2): the pre-filled default is never
 *     eagerly `PUT` — a write fires only once the value actually differs
 *     from what was last committed AND the field blurs, mirroring `edit`
 *     mode's own blur-commit convention for the rest of the row. The input
 *     carries a full, row-identity `aria-label` ("Approved total for {date}
 *     · {motivo} · {currency}") per design.md's Accessibility section, since
 *     accounting tabs through many otherwise-identical inputs by role.
 *
 * `registerRef` lets the parent (`RequestDetailPage`/`ReviewDetailPage`)
 * capture this row's container node so `SubmitValidationSummary`'s jump
 * links can scroll to and focus it (design.md F2 step 1) — the container
 * carries `tabIndex={-1}` for exactly that programmatic-focus target, the
 * same technique `PermissionDenied.tsx`/`NotFoundPage.tsx` use for their own
 * mount-focus. This still works for a collapsed summary row (it focuses the
 * row's own container, the same target it always has); expanding it further
 * is a manual follow-on click, not attempted automatically.
 *
 * A11y (post-close amendment): expanding moves focus to the row's first
 * field (Date); collapsing via Done returns focus to the row's own Edit
 * button — `isFirstRenderRef` skips this focus-management effect on mount so
 * every already-collapsed row doesn't steal focus on initial paint.
 *
 * Debounced auto-save (content-app auto-save, specs/NNN): while `edit` mode
 * is expanded, an in-progress `draft` that's both `isLineDraftComplete` and
 * dirty (differs from `committedRef.current`) auto-commits via the same
 * `commit()` the blur/Done paths already use, `LINE_AUTOSAVE_DEBOUNCE_MS`
 * (1500ms) after the last change — an incomplete/invalid draft never
 * auto-saves, so it can never trigger a spurious 422. The existing
 * blur-outside / Done paths still commit immediately (an "immediate flush"),
 * and `commit()` itself cancels any pending debounce timer at its very start
 * so a flush and a still-pending debounce can never both PUT for the same
 * edit. `onSaveOutcome`, if provided, reports the tone/message of every
 * commit (success or failure) so a page-level toast (`ToastBanner`) can
 * surface it — this row never renders its own toast, to keep "one toast at a
 * time" a property of the page, not each row.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEvent } from 'react'
import { strings } from '../strings'
import { EXPENSE_TYPES, requiresKm } from '../lib/expenseTypes'
import type { ExpenseType } from '../lib/expenseTypes'
import type { Entity } from './EntityBadge'
import EntityBadge from './EntityBadge'
import type { Currency } from '../lib/money'
import { formatMoney, formatRatePerKm } from '../lib/money'
import CurrencyBadge from './CurrencyBadge'
import type { Attachment, LinePayload, RefundLine } from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'
import { formatDate } from '../lib/dates'
import type { LineDraftValue } from '../lib/lineDraft'
import { amountToCents, centsToAmountInput, isLineDraftComplete, lineDraftToPayload, lineToDraft } from '../lib/lineDraft'
import AttachmentList from './AttachmentList'
import ConfirmDeleteModal from './ConfirmDeleteModal'
import MileageAmountField from './MileageAmountField'

export type ExpenseLineRowMode = 'edit' | 'readOnly' | 'readOnlyApproved' | 'review'

/** Debounce delay for a line edit's auto-save (ms) — mirrors estimai-ui's AUTOSAVE_DEBOUNCE_MS. */
const LINE_AUTOSAVE_DEBOUNCE_MS = 1500

export type LineSaveOutcome = { tone: 'success' | 'error'; message: string }

export type ExpenseLineRowProps = {
  line: RefundLine
  mode: ExpenseLineRowMode
  /** Required in `edit` mode — performs `PUT /requests/:id/lines/:lineId`. */
  onCommit?: (payload: LinePayload) => Promise<void>
  /** Required in `edit` mode — performs `DELETE /requests/:id/lines/:lineId`. */
  onDelete?: () => Promise<void>
  /** `edit` mode only — reports every field-edit commit's outcome (debounced auto-save OR blur/Done flush), for a page-level toast. Delete/attachment mutations do not report here. */
  onSaveOutcome?: (outcome: LineSaveOutcome) => void
  /** Lets the parent capture this row's container node for jump-to-on-validation-error focus. */
  registerRef?: (node: HTMLDivElement | null) => void
  /** Required in `edit` mode — the full mint→upload→confirm sequence for one file (`lib/attachmentsApi.ts`). */
  onUploadAttachment?: (file: File) => Promise<Attachment>
  /** Required in `edit` mode — removes a persisted attachment (draft-only, no confirm). */
  onRemoveAttachment?: (attachmentId: string) => Promise<void>
  /** Required in every mode — mints a short-lived signed GET for one attachment (`lib/attachmentsApi.ts`). */
  onDownloadAttachment: (attachmentId: string) => Promise<{ url: string }>
  /** Required in `review` mode — `PUT .../lines/:lineId/approved-total`, fired only on an actual edit (see this file's `review` mode doc above). */
  onApprovedTotalChange?: (cents: number) => Promise<void>
}

const ENTITY_OPTIONS: Entity[] = ['welld_it', 'welld_ch']
const CURRENCY_OPTIONS: Currency[] = ['EUR', 'CHF', 'USD', 'GBP']

const draftsEqual = (a: LineDraftValue, b: LineDraftValue): boolean =>
  a.date === b.date &&
  a.type === b.type &&
  a.motivo === b.motivo &&
  a.amount === b.amount &&
  a.entity === b.entity &&
  a.currency === b.currency &&
  a.km === b.km

const typeLabel = (type: ExpenseType): string => EXPENSE_TYPES.find((o) => o.id === type)?.labelEn ?? type

export default function ExpenseLineRow({
  line,
  mode,
  onCommit,
  onDelete,
  onSaveOutcome,
  registerRef,
  onUploadAttachment,
  onRemoveAttachment,
  onDownloadAttachment,
  onApprovedTotalChange,
}: ExpenseLineRowProps) {
  const t = strings.pages.requestDetail.lines
  const composerStrings = strings.pages.requestDetail.composer
  const badgeStrings = strings.badges.entity
  const currencyStrings = strings.badges.currency
  const reviewStrings = strings.pages.reviewDetail.approvedTotal

  const [draft, setDraft] = useState<LineDraftValue>(() => lineToDraft(line))
  const committedRef = useRef<LineDraftValue>(lineToDraft(line))
  const containerRef = useRef<HTMLDivElement>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kmStatus, setKmStatus] = useState('')
  const [deleting, setDeleting] = useState(false)

  // `edit` mode only — collapsed (summary) vs. expanded (full field form),
  // and the line-delete confirm modal (post-close amendment).
  const [expanded, setExpanded] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const isFirstRenderRef = useRef(true)

  // `edit` mode, expanded, only — the debounced auto-save timer (content-app
  // auto-save). `commit()` itself clears this at its very start, so an
  // immediate flush (blur-outside / Done) always cancels a still-pending
  // debounce before it can also PUT the same edit.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // `review` mode only — the approved-total input's own local draft +
  // "last committed cents" (write-on-change-only comparison base).
  const approvedTotalDefaultCents = line.approvedTotalCents ?? line.requestedAmountCents
  const [approvedDraft, setApprovedDraft] = useState<string>(() => centsToAmountInput(approvedTotalDefaultCents))
  const approvedCommittedRef = useRef<number>(approvedTotalDefaultCents)
  const [approvedSaving, setApprovedSaving] = useState(false)
  const [approvedError, setApprovedError] = useState<string | null>(null)

  const setContainerRef = (node: HTMLDivElement | null) => {
    containerRef.current = node
    registerRef?.(node)
  }

  // Focus management on expand/collapse (A11y) — skips the initial mount so
  // every already-collapsed row doesn't steal focus on first paint.
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      return
    }
    if (mode !== 'edit') return
    if (expanded) firstFieldRef.current?.focus()
    else editButtonRef.current?.focus()
  }, [expanded, mode])

  const commitApprovedTotal = async () => {
    const cents = amountToCents(approvedDraft)
    if (cents === null) {
      setApprovedError(reviewStrings.invalidAmount)
      return
    }
    if (cents === approvedCommittedRef.current) return // untouched (or reverted to the default) — no write (design.md F6 step 2)
    setApprovedSaving(true)
    setApprovedError(null)
    try {
      await onApprovedTotalChange?.(cents)
      approvedCommittedRef.current = cents
    } catch (err) {
      setApprovedError(err instanceof ApiError ? (err.detail ?? err.title) : reviewStrings.updateError)
    } finally {
      setApprovedSaving(false)
    }
  }

  const commit = useCallback(async () => {
    // An immediate flush (blur-outside / Done) and the debounced auto-save
    // both funnel through this one function — cancel any still-pending
    // debounce timer first so a flush can never be followed by a redundant
    // late PUT for the same edit.
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = undefined
    }
    if (!isLineDraftComplete(draft) || draftsEqual(draft, committedRef.current)) return
    setSaving(true)
    setError(null)
    try {
      await onCommit?.(lineDraftToPayload(draft))
      committedRef.current = draft
      onSaveOutcome?.({ tone: 'success', message: t.savedToast })
    } catch (err) {
      const message = err instanceof ApiError ? (err.detail ?? err.title) : t.updateError
      setError(message)
      onSaveOutcome?.({ tone: 'error', message })
    } finally {
      setSaving(false)
    }
  }, [draft, onCommit, onSaveOutcome, t.savedToast, t.updateError])

  // Debounced auto-save (content-app auto-save): while expanded, a complete
  // AND dirty draft auto-commits LINE_AUTOSAVE_DEBOUNCE_MS after the last
  // change. An incomplete/invalid draft is never scheduled — never a
  // spurious 422. Re-runs (and so re-debounces) on every keystroke because
  // `draft` — and therefore `commit`, which closes over it — changes
  // identity each time.
  useEffect(() => {
    if (mode !== 'edit' || !expanded) return
    if (!isLineDraftComplete(draft) || draftsEqual(draft, committedRef.current)) return
    debounceTimerRef.current = setTimeout(() => void commit(), LINE_AUTOSAVE_DEBOUNCE_MS)
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = undefined
      }
    }
  }, [draft, mode, expanded, commit])

  const handleRowBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (containerRef.current?.contains(e.relatedTarget as Node)) return
    void commit()
  }

  const handleTypeChange = (value: string) => {
    const nextType = value as ExpenseType
    const wasKm = requiresKm(draft.type as ExpenseType)
    const willBeKm = requiresKm(nextType)
    setDraft((prev) => ({ ...prev, type: nextType, km: willBeKm ? prev.km : '' }))
    if (willBeKm && !wasKm) setKmStatus(composerStrings.kmFieldAdded)
    else if (!willBeKm && wasKm) setKmStatus(composerStrings.kmFieldRemoved)
  }

  const handleEditClick = () => {
    setExpanded(true)
  }

  const handleDoneClick = () => {
    // Done never introduces a second save path — it calls the SAME commit()
    // the blur-outside path uses. A click on a button that lives inside this
    // row's own container never satisfies handleRowBlur's "focus left the
    // row" check, so without this an edit finished via Done would silently
    // never be saved.
    void commit()
    setExpanded(false)
  }

  const handleDeleteClick = () => {
    setDeleteError(null)
    setDeleteConfirmOpen(true)
  }

  const handleDeleteCancel = () => {
    setDeleteConfirmOpen(false)
    setDeleteError(null)
  }

  const handleDeleteConfirm = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await onDelete?.()
      setDeleteConfirmOpen(false)
    } catch (err) {
      setDeleteError(err instanceof ApiError ? (err.detail ?? err.title) : t.deleteError)
    } finally {
      setDeleting(false)
    }
  }

  // -------------------------------------------------------------------------
  // Shared summary content (date/type/badges/motivo/amounts) — reused by the
  // read-only-family render (`readOnly`/`readOnlyApproved`/`review`) AND
  // `edit` mode's collapsed summary row, so committed lines read as the same
  // presentation everywhere they aren't the live editable form.
  // -------------------------------------------------------------------------

  // specs/009-mileage-rate — `line.mileage` is present (non-null) only for a
  // travel_km line; `?? null` also covers pre-feature test fixtures that
  // predate this field entirely (`RefundLine.mileage` is optional exactly
  // for that reason, see requestsApi.ts's own doc comment).
  const mileage = line.mileage ?? null
  // AC-2.2: no rate configured for this line's (entity, date) — only ever
  // true for a still-draft/withdrawn-to-draft line (a submitted+ line always
  // had a rate in effect at submit time, and is then frozen, per Decision 1).
  const mileageBlocked = mileage !== null && !mileage.rateInEffect

  const summaryCore = (
    <>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span style={{ color: 'var(--soft)' }}>{line.date}</span>
        <span style={{ color: 'var(--text)' }}>{typeLabel(line.type)}</span>
        <EntityBadge entity={line.entity} />
        <CurrencyBadge currency={line.currency} />
        {line.km !== null && (
          <span style={{ color: 'var(--muted)' }}>
            {line.km} km
            {mileage?.appliedRate && ` × ${formatRatePerKm(mileage.appliedRate.ratePerKm, mileage.appliedRate.currency)}`}
          </span>
        )}
      </div>
      <p className="text-sm" style={{ color: 'var(--text)' }}>
        {line.motivo}
      </p>
      <dl className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-1.5">
          <dt style={{ color: 'var(--soft)' }}>{t.requestedLabel}</dt>
          <dd className="font-mono" style={{ color: 'var(--text)' }}>
            {mileageBlocked ? t.mileageBlockedAmount : formatMoney(line.requestedAmountCents, line.currency)}
          </dd>
        </div>
        {mode === 'readOnlyApproved' && (
          <div className="flex items-center gap-1.5">
            <dt style={{ color: 'var(--soft)' }}>{t.approvedLabel}</dt>
            <dd className="font-mono" style={{ color: 'var(--grn)' }}>
              {formatMoney(line.approvedTotalCents ?? line.requestedAmountCents, line.currency)}
            </dd>
          </div>
        )}
        {/* specs/009-mileage-rate AC-6.4 — the applied rate + valid-from, shown
            alongside the amount in every mode. `appliedRate` is non-null only
            once a travel_km line has ever been submitted under this feature
            (Decision 1); a legacy pre-feature submitted line omits this pair
            entirely (graceful degradation — amount only, no breakdown). */}
        {mileage?.appliedRate && (
          <div className="flex items-center gap-1.5">
            <dt style={{ color: 'var(--soft)' }}>{t.rateAppliedLabel}</dt>
            <dd className="font-mono" style={{ color: 'var(--text)' }}>
              {t.rateAppliedValue(
                formatRatePerKm(mileage.appliedRate.ratePerKm, mileage.appliedRate.currency),
                formatDate(mileage.appliedRate.validFrom),
              )}
            </dd>
          </div>
        )}
      </dl>
    </>
  )

  // -------------------------------------------------------------------------
  // `edit` mode, collapsed — compact read-only summary row + Edit/Delete
  // -------------------------------------------------------------------------

  if (mode === 'edit' && !expanded) {
    return (
      <div
        ref={setContainerRef}
        tabIndex={-1}
        data-testid={`expense-line-row-${line.id}`}
        className="flex flex-col gap-2 rounded-md border px-4 py-3 outline-none"
        style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
      >
        {summaryCore}

        <div className="flex items-center justify-between gap-3 pt-1 border-t" style={{ borderColor: 'var(--rule)' }}>
          {line.attachments.length > 0 ? (
            <span
              data-testid={`row-${line.id}-attachments-indicator`}
              className="text-[11px]"
              style={{ color: 'var(--muted)' }}
            >
              <span aria-hidden="true">📎</span> {t.attachmentsIndicator(line.attachments.length)}
            </span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              ref={editButtonRef}
              type="button"
              onClick={handleEditClick}
              aria-label={t.editLineLabel(line.motivo)}
              title={t.editLineTitle}
              data-testid={`row-${line.id}-edit`}
              className="text-[11px] font-medium border px-2 py-1 transition-opacity hover:opacity-80"
              style={{ borderColor: 'var(--rule)', color: 'var(--acc)' }}
            >
              {t.editButton}
            </button>
            <button
              type="button"
              onClick={handleDeleteClick}
              aria-label={t.deleteLineLabel(line.motivo)}
              title={t.deleteLineTitle}
              data-testid={`row-${line.id}-delete`}
              className="text-[11px] font-medium border px-2 py-1 transition-opacity hover:opacity-80"
              style={{ borderColor: 'var(--rule)', color: 'var(--muted)' }}
            >
              {t.deleteButton}
            </button>
          </div>
        </div>

        {deleteConfirmOpen && (
          <ConfirmDeleteModal
            entityLabel={t.deleteLineConfirmEntityLabel}
            itemName={line.motivo}
            title={t.deleteLineConfirmTitle}
            body={<p>{t.deleteLineConfirmBody(typeLabel(line.type), line.motivo)}</p>}
            isDeleting={deleting}
            errorMessage={deleteError}
            onConfirm={() => void handleDeleteConfirm()}
            onCancel={handleDeleteCancel}
            testIdPrefix={`row-${line.id}-delete-confirm`}
          />
        )}
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Read-only render (submitted / approved / rejected / accounting review)
  // -------------------------------------------------------------------------

  if (mode === 'readOnly' || mode === 'readOnlyApproved' || mode === 'review') {
    return (
      <div
        ref={setContainerRef}
        tabIndex={-1}
        data-testid={`expense-line-row-${line.id}`}
        className="flex flex-col gap-2 rounded-md border px-4 py-3 outline-none"
        style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
      >
        {summaryCore}

        {mode === 'review' && (
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
              {reviewStrings.label}
            </span>
            <input
              type="number"
              step="0.01"
              min="0"
              aria-label={reviewStrings.ariaLabel(line.date, line.motivo, line.currency)}
              value={approvedDraft}
              disabled={approvedSaving}
              onChange={(e) => setApprovedDraft(e.target.value)}
              onBlur={() => void commitApprovedTotal()}
              data-testid={`row-${line.id}-approved-total`}
              className="text-sm px-2.5 py-1.5 border rounded w-28"
              style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
            />
            {approvedSaving && (
              <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                {reviewStrings.savingLabel}
              </span>
            )}
            {approvedError && (
              <span role="alert" data-testid={`row-${line.id}-approved-total-error`} className="text-xs" style={{ color: 'var(--red)' }}>
                {approvedError}
              </span>
            )}
          </div>
        )}

        <AttachmentList lineId={line.id} attachments={line.attachments} mode="readOnly" onDownload={onDownloadAttachment} />
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // `edit` mode, expanded — the full editable field layout
  // -------------------------------------------------------------------------

  const showKm = draft.type !== '' && requiresKm(draft.type as ExpenseType)

  return (
    <div
      ref={setContainerRef}
      tabIndex={-1}
      onBlur={handleRowBlur}
      data-testid={`expense-line-row-${line.id}`}
      className="flex flex-col gap-3 rounded-md border px-4 py-3 outline-none"
      style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
    >
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <div className="flex flex-col gap-1">
          <label htmlFor={`row-${line.id}-date`} className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
            {composerStrings.dateLabel}
          </label>
          <input
            ref={firstFieldRef}
            id={`row-${line.id}-date`}
            type="date"
            value={draft.date}
            onChange={(e) => setDraft((prev) => ({ ...prev, date: e.target.value }))}
            data-testid={`row-${line.id}-date`}
            className="text-sm px-2.5 py-1.5 border rounded"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)', colorScheme: 'dark' }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`row-${line.id}-type`} className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
            {composerStrings.typeLabel}
          </label>
          <select
            id={`row-${line.id}-type`}
            value={draft.type}
            onChange={(e) => handleTypeChange(e.target.value)}
            data-testid={`row-${line.id}-type`}
            className="text-sm px-2.5 py-1.5 border rounded"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
          >
            {EXPENSE_TYPES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.labelEn}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`row-${line.id}-motivo`} className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
            {composerStrings.motivoLabel}
          </label>
          <input
            id={`row-${line.id}-motivo`}
            type="text"
            value={draft.motivo}
            onChange={(e) => setDraft((prev) => ({ ...prev, motivo: e.target.value }))}
            data-testid={`row-${line.id}-motivo`}
            className="text-sm px-2.5 py-1.5 border rounded"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
          />
        </div>

        {/* specs/009-mileage-rate AC-1.1: for travel_km, Amount is replaced by the
            read-only computed breakdown (MileageAmountField) — not merely disabled. */}
        {showKm ? (
          <div className="flex flex-col gap-1">
            <MileageAmountField entity={draft.entity} date={draft.date} km={draft.km} />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor={`row-${line.id}-amount`} className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
              {composerStrings.amountLabel}
            </label>
            <input
              id={`row-${line.id}-amount`}
              type="number"
              step="0.01"
              min="0"
              value={draft.amount}
              onChange={(e) => setDraft((prev) => ({ ...prev, amount: e.target.value }))}
              data-testid={`row-${line.id}-amount`}
              className="text-sm px-2.5 py-1.5 border rounded"
              style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor={`row-${line.id}-entity`} className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
            {composerStrings.entityLabel}
          </label>
          <select
            id={`row-${line.id}-entity`}
            value={draft.entity}
            onChange={(e) => setDraft((prev) => ({ ...prev, entity: e.target.value as Entity }))}
            data-testid={`row-${line.id}-entity`}
            className="text-sm px-2.5 py-1.5 border rounded"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
          >
            {ENTITY_OPTIONS.map((entity) => (
              <option key={entity} value={entity}>
                {badgeStrings[entity]}
              </option>
            ))}
          </select>
        </div>

        {/* specs/009-mileage-rate AC-1.6: for travel_km, currency is entity-designated,
            never independently selectable — the select is absent, not disabled. */}
        {!showKm && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`row-${line.id}-currency`} className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
              {composerStrings.currencyLabel}
            </label>
            <select
              id={`row-${line.id}-currency`}
              value={draft.currency}
              onChange={(e) => setDraft((prev) => ({ ...prev, currency: e.target.value as Currency }))}
              data-testid={`row-${line.id}-currency`}
              className="text-sm px-2.5 py-1.5 border rounded"
              style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
            >
              {CURRENCY_OPTIONS.map((currency) => (
                <option key={currency} value={currency}>
                  {currencyStrings[currency]}
                </option>
              ))}
            </select>
          </div>
        )}

        {showKm && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`row-${line.id}-km`} className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
              {composerStrings.kmLabel}
            </label>
            <input
              id={`row-${line.id}-km`}
              type="number"
              min="1"
              step="1"
              aria-required="true"
              aria-describedby={`row-${line.id}-km-help`}
              value={draft.km}
              onChange={(e) => setDraft((prev) => ({ ...prev, km: e.target.value }))}
              data-testid={`row-${line.id}-km`}
              className="text-sm px-2.5 py-1.5 border rounded"
              style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
            />
            <p id={`row-${line.id}-km-help`} className="text-[11px]" style={{ color: 'var(--muted)' }}>
              {composerStrings.kmHelp}
            </p>
          </div>
        )}
      </div>

      <p aria-live="polite" className="sr-only" data-testid={`row-${line.id}-km-status`}>
        {kmStatus}
      </p>

      {saving && (
        <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
          {t.savingLabel}
        </p>
      )}
      {error && (
        <p role="alert" data-testid={`row-${line.id}-error`} className="text-xs" style={{ color: 'var(--red)' }}>
          {error}
        </p>
      )}

      <div className="flex items-start justify-between gap-3 pt-1 border-t" style={{ borderColor: 'var(--rule)' }}>
        <AttachmentList
          lineId={line.id}
          attachments={line.attachments}
          mode="edit"
          onUpload={onUploadAttachment}
          onRemove={onRemoveAttachment}
          onDownload={onDownloadAttachment}
        />
        <button
          type="button"
          onClick={handleDoneClick}
          aria-label={t.doneLabel(draft.motivo || line.motivo)}
          title={t.doneTitle}
          data-testid={`row-${line.id}-done`}
          className="text-[11px] font-medium border px-2 py-1 transition-opacity hover:opacity-80 shrink-0"
          style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
        >
          {t.doneButton}
        </button>
      </div>
    </div>
  )
}
