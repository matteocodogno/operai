/**
 * ExpenseLineRow — one expense line, in one of three modes (T16,
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
 *     "a draft line is cheap, reversible working state") and an
 *     `AttachmentList` SEAM (a labelled placeholder slot, not the real
 *     upload machinery — that's T17, explicitly out of this task's scope).
 *   - `readOnly` (Screen R2 `submitted`/`rejected` variants): plain text,
 *     no inputs, no delete — editing controls are absent, not disabled
 *     (design.md F2 step 3).
 *   - `readOnlyApproved` (Screen R2 `approved` variant): same as `readOnly`
 *     plus the line's finalized approved total alongside its requested
 *     amount (AC-3.2).
 *
 * `registerRef` lets the parent (`RequestDetailPage`) capture this row's
 * container node so `SubmitValidationSummary`'s jump links can scroll to and
 * focus it (design.md F2 step 1) — the container carries `tabIndex={-1}` for
 * exactly that programmatic-focus target, the same technique
 * `PermissionDenied.tsx`/`NotFoundPage.tsx` use for their own mount-focus.
 */

import { useRef, useState } from 'react'
import type { FocusEvent } from 'react'
import { strings } from '../strings'
import { EXPENSE_TYPES, requiresKm } from '../lib/expenseTypes'
import type { ExpenseType } from '../lib/expenseTypes'
import type { Entity } from './EntityBadge'
import EntityBadge from './EntityBadge'
import { formatMoney } from '../lib/money'
import type { LinePayload, RefundLine } from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'
import type { LineDraftValue } from '../lib/lineDraft'
import { isLineDraftComplete, lineDraftToPayload, lineToDraft } from '../lib/lineDraft'

export type ExpenseLineRowMode = 'edit' | 'readOnly' | 'readOnlyApproved'

export type ExpenseLineRowProps = {
  line: RefundLine
  mode: ExpenseLineRowMode
  /** Required in `edit` mode — performs `PUT /requests/:id/lines/:lineId`. */
  onCommit?: (payload: LinePayload) => Promise<void>
  /** Required in `edit` mode — performs `DELETE /requests/:id/lines/:lineId`. */
  onDelete?: () => Promise<void>
  /** Lets the parent capture this row's container node for jump-to-on-validation-error focus. */
  registerRef?: (node: HTMLDivElement | null) => void
}

const ENTITY_OPTIONS: Entity[] = ['welld_it', 'welld_ch']

const draftsEqual = (a: LineDraftValue, b: LineDraftValue): boolean =>
  a.date === b.date &&
  a.type === b.type &&
  a.motivo === b.motivo &&
  a.amount === b.amount &&
  a.entity === b.entity &&
  a.km === b.km

const typeLabel = (type: ExpenseType): string => EXPENSE_TYPES.find((o) => o.id === type)?.labelEn ?? type

export default function ExpenseLineRow({ line, mode, onCommit, onDelete, registerRef }: ExpenseLineRowProps) {
  const t = strings.pages.requestDetail.lines
  const composerStrings = strings.pages.requestDetail.composer
  const badgeStrings = strings.badges.entity

  const [draft, setDraft] = useState<LineDraftValue>(() => lineToDraft(line))
  const committedRef = useRef<LineDraftValue>(lineToDraft(line))
  const containerRef = useRef<HTMLDivElement>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kmStatus, setKmStatus] = useState('')
  const [deleting, setDeleting] = useState(false)

  const setContainerRef = (node: HTMLDivElement | null) => {
    containerRef.current = node
    registerRef?.(node)
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
  // Read-only render (submitted / approved / rejected)
  // -------------------------------------------------------------------------

  if (mode === 'readOnly' || mode === 'readOnlyApproved') {
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

      <div className="flex items-center justify-between gap-3 pt-1 border-t" style={{ borderColor: 'var(--rule)' }}>
        {/* T17 seam: the real AttachmentList (upload/remove) replaces this placeholder. */}
        <div className="text-[11px]" style={{ color: 'var(--muted)' }} data-testid={`row-${line.id}-attachments-seam`}>
          {t.attachmentsSeamLabel}: {t.attachmentsSeamComingSoon}
        </div>
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={deleting}
          aria-label={t.deleteLineLabel(draft.motivo || line.motivo)}
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
