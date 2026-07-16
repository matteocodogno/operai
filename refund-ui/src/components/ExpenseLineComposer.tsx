/**
 * ExpenseLineComposer — the "add a new expense line" form on Screen R2's
 * `draft` variant (T16, specs/007-refund-service/tasks.md, AC-1.2; design.md
 * F1 step 3). Collects Date/Expense type/Motivo/Requested amount/Entity, and
 * — only once Expense type is `travel_km` — a required `km` field
 * (AC-1.2: "inapplicable — not shown/not required", not merely disabled).
 *
 * "Add line" stays disabled until every field required for the *current*
 * type is valid (ported pattern from `admin-ui/src/components/
 * InviteUserModal.tsx`'s disabled-until-valid submit) — `POST
 * /requests/:id/lines` has no partial-line endpoint, so there is no useful
 * "submit and see what's wrong" path here the way a modal-with-server-
 * validation has. On success the parent re-fetches/prepends the new line;
 * this component resets its own draft (back to today's date, everything
 * else blank) and stays mounted, open for rapid successive adds (design.md:
 * "the composer resets and stays open").
 *
 * A11y (design.md "## Accessibility"):
 *   - Every field has an explicit `<label htmlFor>`.
 *   - The `km` field, when shown, carries `aria-required="true"` and a
 *     permanent "must be greater than 0" help association via
 *     `aria-describedby` (not just an on-error message).
 *   - The field's appearance/disappearance is announced via a local
 *     `aria-live="polite"` status line (mirrors `RoleEditor.tsx`'s
 *     `rule-composer-status` technique) — a sighted user sees the field
 *     appear, a screen-reader user needs the same information stated.
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import { strings } from '../strings'
import { EXPENSE_TYPES, requiresKm } from '../lib/expenseTypes'
import type { ExpenseType } from '../lib/expenseTypes'
import type { Entity } from './EntityBadge'
import type { LinePayload } from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'
import type { LineDraftValue } from '../lib/lineDraft'
import { emptyLineDraft, isLineDraftComplete, lineDraftToPayload } from '../lib/lineDraft'

export type ExpenseLineComposerProps = {
  /** Performs `POST /requests/:id/lines`. Rejects (ApiError) on failure — the composer stays open with the entered draft intact. */
  onAdd: (payload: LinePayload) => Promise<void>
}

const ENTITY_OPTIONS: Entity[] = ['welld_it', 'welld_ch']

export default function ExpenseLineComposer({ onAdd }: ExpenseLineComposerProps) {
  const t = strings.pages.requestDetail.composer
  const badgeStrings = strings.badges.entity

  const [draft, setDraft] = useState<LineDraftValue>(emptyLineDraft())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kmStatus, setKmStatus] = useState('')

  const handleTypeChange = (value: string) => {
    const nextType = value as ExpenseType | ''
    const wasKm = draft.type !== '' && requiresKm(draft.type)
    const willBeKm = nextType !== '' && requiresKm(nextType)

    setDraft((prev) => ({ ...prev, type: nextType, km: willBeKm ? prev.km : '' }))

    if (willBeKm && !wasKm) {
      setKmStatus(t.kmFieldAdded)
    } else if (!willBeKm && wasKm) {
      setKmStatus(t.kmFieldRemoved)
    }
  }

  const canAdd = isLineDraftComplete(draft) && !submitting

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canAdd) return
    setSubmitting(true)
    setError(null)
    try {
      await onAdd(lineDraftToPayload(draft))
      setDraft(emptyLineDraft())
      setKmStatus('')
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : t.genericError)
    } finally {
      setSubmitting(false)
    }
  }

  const showKm = draft.type !== '' && requiresKm(draft.type)

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      data-testid="expense-line-composer"
      className="flex flex-col gap-3 rounded-md border p-4"
      style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-soft)' }}
    >
      <h3 className="text-sm font-semibold" style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}>
        {t.heading}
      </h3>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <div className="flex flex-col gap-1">
          <label htmlFor="composer-date" className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
            {t.dateLabel}
          </label>
          <input
            id="composer-date"
            type="date"
            required
            value={draft.date}
            disabled={submitting}
            onChange={(e) => setDraft((prev) => ({ ...prev, date: e.target.value }))}
            data-testid="composer-date"
            className="text-sm px-2.5 py-1.5 border rounded"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="composer-type" className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
            {t.typeLabel}
          </label>
          <select
            id="composer-type"
            required
            value={draft.type}
            disabled={submitting}
            onChange={(e) => handleTypeChange(e.target.value)}
            data-testid="composer-type"
            className="text-sm px-2.5 py-1.5 border rounded"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
          >
            <option value="">{t.typePlaceholder}</option>
            {EXPENSE_TYPES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.labelEn}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="composer-motivo" className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
            {t.motivoLabel}
          </label>
          <input
            id="composer-motivo"
            type="text"
            required
            value={draft.motivo}
            disabled={submitting}
            onChange={(e) => setDraft((prev) => ({ ...prev, motivo: e.target.value }))}
            data-testid="composer-motivo"
            className="text-sm px-2.5 py-1.5 border rounded"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="composer-amount" className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
            {t.amountLabel}
          </label>
          <input
            id="composer-amount"
            type="number"
            step="0.01"
            min="0"
            required
            value={draft.amount}
            disabled={submitting}
            onChange={(e) => setDraft((prev) => ({ ...prev, amount: e.target.value }))}
            data-testid="composer-amount"
            className="text-sm px-2.5 py-1.5 border rounded"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="composer-entity" className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
            {t.entityLabel}
          </label>
          <select
            id="composer-entity"
            required
            value={draft.entity}
            disabled={submitting}
            onChange={(e) => setDraft((prev) => ({ ...prev, entity: e.target.value as Entity | '' }))}
            data-testid="composer-entity"
            className="text-sm px-2.5 py-1.5 border rounded"
            style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
          >
            <option value="">{t.entityPlaceholder}</option>
            {ENTITY_OPTIONS.map((entity) => (
              <option key={entity} value={entity}>
                {badgeStrings[entity]}
              </option>
            ))}
          </select>
        </div>

        {showKm && (
          <div className="flex flex-col gap-1">
            <label htmlFor="composer-km" className="text-xs font-medium" style={{ color: 'var(--soft)' }}>
              {t.kmLabel}
            </label>
            <input
              id="composer-km"
              type="number"
              min="1"
              step="1"
              required
              aria-required="true"
              aria-describedby="composer-km-help"
              value={draft.km}
              disabled={submitting}
              onChange={(e) => setDraft((prev) => ({ ...prev, km: e.target.value }))}
              data-testid="composer-km"
              className="text-sm px-2.5 py-1.5 border rounded"
              style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
            />
            <p id="composer-km-help" className="text-[11px]" style={{ color: 'var(--muted)' }}>
              {t.kmHelp}
            </p>
          </div>
        )}
      </div>

      {/* AC-1.2 a11y hotspot: announces the km field's appearance/disappearance */}
      <p aria-live="polite" data-testid="composer-km-status" className="sr-only">
        {kmStatus}
      </p>

      {error && (
        <p role="alert" data-testid="composer-error" className="text-xs" style={{ color: 'var(--red)' }}>
          {error}
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={!canAdd}
          data-testid="composer-add-button"
          className="py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
        >
          {submitting ? t.addingLabel : t.addButton}
        </button>
      </div>
    </form>
  )
}
