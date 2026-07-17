/**
 * ExpenseLineRow — one expense line, in one of four modes (T16/T18,
 * specs/007-refund-service/tasks.md):
 *
 *   - `edit` (Screen R2 `draft` variant): every field is a live input,
 *     buffered in local draft state exactly like `estimai-ui/src/components/
 *     ActivityTable.tsx`'s `EpicCell`/`MLCell` (value diverges from the
 *     committed line until focus leaves the row), then commits as ONE `PUT
 *     /requests/:id/lines/:lineId` carrying the whole line object — not
 *     per-keystroke, not per-field (design.md F1 step 4). Detected via the
 *     row container's own `onBlur` + `e.relatedTarget` (focus landing
 *     outside this row's DOM subtree), not each field's individual blur,
 *     so tabbing between this row's own fields never fires a PUT per field.
 *     Includes an inline "×" delete (no confirm modal — design.md F1 step 6:
 *     "a draft line is cheap, reversible working state" — a `title` tooltip
 *     is the delete-safety measure instead, post-close change specs/007) and
 *     the real `AttachmentList` (T17, specs/007-refund-service/tasks.md) in
 *     upload/remove mode — fills the seam T16 left here. `currency` (also
 *     post-close, specs/007) is its own independently-editable `<select>`
 *     next to `entity` — no longer derived from it.
 *   - `readOnly` (Screen R2 `submitted`/`rejected` variants, and Screen A2's
 *     own decided-request RO render, T18 F6 step 8): plain text, no inputs,
 *     no delete — editing controls are absent, not disabled (design.md F2
 *     step 3). `AttachmentList` renders in download-only mode here too — a
 *     submitted/decided line's receipts stay viewable, just not editable
 *     (T17: "AttachmentDownloadLink … used by … the RO employee variants").
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
 * mount-focus.
 */

import { useRef, useState } from 'react'
import type { FocusEvent } from 'react'
import { strings } from '../strings'
import { EXPENSE_TYPES, requiresKm } from '../lib/expenseTypes'
import type { ExpenseType } from '../lib/expenseTypes'
import type { Entity } from './EntityBadge'
import EntityBadge from './EntityBadge'
import type { Currency } from '../lib/money'
import { formatMoney } from '../lib/money'
import CurrencyBadge from './CurrencyBadge'
import type { Attachment, LinePayload, RefundLine } from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'
import type { LineDraftValue } from '../lib/lineDraft'
import { amountToCents, centsToAmountInput, isLineDraftComplete, lineDraftToPayload, lineToDraft } from '../lib/lineDraft'
import AttachmentList from './AttachmentList'

export type ExpenseLineRowMode = 'edit' | 'readOnly' | 'readOnlyApproved' | 'review'

export type ExpenseLineRowProps = {
  line: RefundLine
  mode: ExpenseLineRowMode
  /** Required in `edit` mode — performs `PUT /requests/:id/lines/:lineId`. */
  onCommit?: (payload: LinePayload) => Promise<void>
  /** Required in `edit` mode — performs `DELETE /requests/:id/lines/:lineId`. */
  onDelete?: () => Promise<void>
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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kmStatus, setKmStatus] = useState('')
  const [deleting, setDeleting] = useState(false)

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

  const commit = async () => {
    if (!isLineDraftComplete(draft) || draftsEqual(draft, committedRef.current)) return
    setSaving(true)
    setError(null)
    try {
      await onCommit?.(lineDraftToPayload(draft))
      committedRef.current = draft
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : t.updateError)
    } finally {
      setSaving(false)
    }
  }

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

  const handleDelete = async () => {
    setDeleting(true)
    setError(null)
    try {
      await onDelete?.()
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : t.updateError)
      setDeleting(false)
    }
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
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span style={{ color: 'var(--soft)' }}>{line.date}</span>
          <span style={{ color: 'var(--text)' }}>{typeLabel(line.type)}</span>
          <EntityBadge entity={line.entity} />
          <CurrencyBadge currency={line.currency} />
          {line.km !== null && (
            <span style={{ color: 'var(--muted)' }}>{line.km} km</span>
          )}
        </div>
        <p className="text-sm" style={{ color: 'var(--text)' }}>
          {line.motivo}
        </p>
        <dl className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5">
            <dt style={{ color: 'var(--soft)' }}>{t.requestedLabel}</dt>
            <dd className="font-mono" style={{ color: 'var(--text)' }}>
              {formatMoney(line.requestedAmountCents, line.currency)}
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
        </dl>

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
  // Editable render (draft)
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
            id={`row-${line.id}-date`}
            type="date"
            value={draft.date}
            onChange={(e) => setDraft((prev) => ({ ...prev, date: e.target.value }))}
            data-testid={`row-${line.id}-date`}
            className="text-sm px-2.5 py-1.5 border rounded"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
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
          onClick={() => void handleDelete()}
          disabled={deleting}
          aria-label={t.deleteLineLabel(draft.motivo || line.motivo)}
          title={t.deleteLineTitle}
          data-testid={`row-${line.id}-delete`}
          className="text-lg leading-none transition-opacity hover:opacity-80 disabled:opacity-40"
          style={{ color: 'var(--muted)' }}
        >
          ×
        </button>
      </div>
    </div>
  )
}
