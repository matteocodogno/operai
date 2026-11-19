/**
 * ExpenseLineComposer — the "add a new expense line" form on Screen R2's
 * `draft` variant (T16, specs/20260716-refund-service/tasks.md, AC-1.2; design.md
 * F1 step 3). Collects Date/Expense type/Motivo/Requested amount/Entity, and
 * — only once Expense type is `travel_km` — a required `km` field
 * (AC-1.2: "inapplicable — not shown/not required", not merely disabled).
 *
 * Validation (INC-16, operai-ui/docs/design-system.md § Forms): every field is
 * a `Field` (label, `*` required marker + `aria-required`, its own error under
 * it with `aria-invalid`). Errors show on blur of a touched field and on
 * "Add"; a failed "Add" moves focus to the first invalid field. "Add line" is
 * disabled only while nothing has been typed yet (the date is pre-filled) —
 * never as the only explanation of an error. `POST /requests/:id/lines` has no
 * partial-line endpoint, so an invalid draft is never sent. On success the parent re-fetches/prepends the new line;
 * this component resets its own draft (back to today's date, everything
 * else blank) and stays mounted, open for rapid successive adds (design.md:
 * "the composer resets and stays open").
 *
 * Currency (post-close change, specs/20260716-refund-service): a separately-stored,
 * independently-selectable field, no longer derived from entity — its own
 * `<select>` with the same explicit "Select a currency…" no-default pattern
 * as entity/type (AC-1.2), required for "Add line" to enable. Any
 * entity/currency combination is valid; this component never cross-validates
 * the two.
 *
 * A11y (design.md "## Accessibility"):
 *   - Every field has an explicit `<label htmlFor>` (through `Field`).
 *   - The `km` field, when shown, carries `aria-required="true"` and a
 *     permanent "must be greater than 0" help association via
 *     `aria-describedby` (Field's hint — not just an on-error message).
 *   - The field's appearance/disappearance is announced via a local
 *     `aria-live="polite"` status line (mirrors `RoleEditor.tsx`'s
 *     `rule-composer-status` technique) — a sighted user sees the field
 *     appear, a screen-reader user needs the same information stated.
 *
 * Motivo autocomplete (T12, specs/20260811-motivo-autocomplete/tasks.md): the raw
 * Motivo `<input>` is now rendered by `MotivoSuggestField`, which layers an
 * ARIA combobox over the SAME element — same `id`/`data-testid`
 * `composer-motivo`, same `required`/`disabled`, one JSX node across both
 * expense-type branches so React preserves the DOM node, its focus, its caret
 * and any IME composition when the type changes. It is active only for
 * `travel_km` (`enabled={showKm}`, AC-1.1) and owns its corpus entirely —
 * this component never sees it, and no failure of it can reach the `error`
 * state below (AC-5.2).
 *
 * Picking a suggestion overwrites exactly three draft fields — motivo, km and
 * entity — in ONE `setDraft` (AC-3.1/3.4: an explicit deliberate act, not a
 * fill-the-blanks merge whose result depends on typing order). The DATE is
 * deliberately untouched (AC-3.2 — a new claim is a new date), nothing is
 * saved (AC-3.7), and no amount/currency control exists for this type to fill
 * (AC-3.3, specs/20260720-mileage-rate). `MileageAmountField` is already a pure function of
 * `(entity, date, km)`, so it re-derives the amount on its own with NO new
 * wiring (AC-3.5). A successful add bumps `corpusEpoch`, so the trip just
 * claimed becomes suggestible on the next threshold crossing (plan D6).
 *
 * Split-receipt hint (specs/20261119-accounting T68, SO-15, AC-3.12): under the
 * Amount of a line whose entity is WellD CH only (never WellD Italia, never
 * `travel_km` where Amount is replaced by the computed mileage). It is the
 * Field's hint, so it is wired to the amount input by `aria-describedby`; it
 * is plain guidance and validates nothing.
 *
 * `ExpenseLineRow` is deliberately NOT touched: AC-1.8 (no autocomplete on the
 * in-place line editor) is satisfied structurally, by absence.
 */

import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button, DateInput, Field, MoneyInput } from '@operai/ui'
import { strings } from '../strings'
import { EXPENSE_TYPES, expenseTypeLabel, requiresKm } from '../lib/expenseTypes'
import type { ExpenseType } from '../lib/expenseTypes'
import type { Entity } from './EntityBadge'
import type { Currency } from '../lib/money'
import type { LinePayload } from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'
import type { LineDraftValue } from '../lib/lineDraft'
import { emptyLineDraft, isLineDraftBlank, lineDraftToPayload } from '../lib/lineDraft'
import { useLineDraftValidation } from '../lib/useLineDraftValidation'
import MileageAmountField from './MileageAmountField'
import MotivoSuggestField from './MotivoSuggestField'
import type { TripSuggestion } from '../lib/suggestionsApi'

export type ExpenseLineComposerProps = {
  /** Performs `POST /requests/:id/lines`. Rejects (ApiError) on failure — the composer stays open with the entered draft intact. */
  onAdd: (payload: LinePayload) => Promise<void>
}

const ENTITY_OPTIONS: Entity[] = ['welld_it', 'welld_ch']
const CURRENCY_OPTIONS: Currency[] = ['EUR', 'CHF', 'USD', 'GBP']

export default function ExpenseLineComposer({ onAdd }: ExpenseLineComposerProps) {
  const t = strings.pages.requestDetail.composer
  const badgeStrings = strings.badges.entity
  const currencyStrings = strings.badges.currency

  const [draft, setDraft] = useState<LineDraftValue>(emptyLineDraft())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kmStatus, setKmStatus] = useState('')
  /** Bumped after a successful add so `MotivoSuggestField` re-fetches its corpus and the trip just claimed is immediately suggestible (plan D6, AC-2.6). */
  const [corpusEpoch, setCorpusEpoch] = useState(0)
  const formRef = useRef<HTMLFormElement>(null)
  const validation = useLineDraftValidation(draft, formRef)

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

  /**
   * AC-3.1/AC-3.4: motivo + km + entity are OVERWRITTEN together, in one
   * `setDraft`, so the three controls change in a single React commit rather
   * than one at a time. Date, amount and currency are never written (AC-3.2,
   * AC-3.3), and nothing is saved (AC-3.7) — `onAdd` is not called here and no
   * request is issued.
   *
   * The announcement reuses the EXISTING `composer-km-status` polite region
   * rather than adding a second live region to the same form: for a non-visual
   * user, the list closing, the atomic commit and the amount re-deriving are
   * all silent, so this sentence is the only cue that three fields changed
   * (AC-5.6). No collision is possible — a pick never changes the expense
   * type, so it can never race the km-field-added/removed message.
   */
  const handlePickSuggestion = (suggestion: TripSuggestion) => {
    setDraft((prev) => ({
      ...prev,
      motivo: suggestion.motivo,
      km: String(suggestion.km),
      entity: suggestion.entity,
    }))
    setKmStatus(t.suggestionApplied(suggestion.motivo, suggestion.km, badgeStrings[suggestion.entity]))
  }

  // INC-16: "Add" is disabled only while nothing has been typed yet; an
  // incomplete draft is explained by per-field errors on submit, never by a
  // silently disabled button.
  const canAdd = !isLineDraftBlank(draft) && !submitting

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canAdd) return
    if (!validation.validate({ focus: true })) return
    setSubmitting(true)
    setError(null)
    try {
      await onAdd(lineDraftToPayload(draft))
      setDraft(emptyLineDraft())
      validation.reset()
      setKmStatus('')
      setCorpusEpoch((epoch) => epoch + 1)
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.title) : t.genericError)
    } finally {
      setSubmitting(false)
    }
  }

  const showKm = draft.type !== '' && requiresKm(draft.type)
  const motivoError = validation.errorFor('motivo')

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(e) => void handleSubmit(e)}
      data-testid="expense-line-composer"
      className="card"
    >
      <h3 className="card-title">{t.heading}</h3>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Field label={t.dateLabel} error={validation.errorFor('date')} required>
          {(control) => (
            <DateInput
              {...control}
              value={draft.date}
              disabled={submitting}
              onChange={(e) => setDraft((prev) => ({ ...prev, date: e.target.value }))}
              onBlur={validation.touch('date')}
              data-testid="composer-date"
            />
          )}
        </Field>

        <Field label={t.typeLabel} error={validation.errorFor('type')} required>
          {(control) => (
            <select
              {...control}
              value={draft.type}
              disabled={submitting}
              onChange={(e) => handleTypeChange(e.target.value)}
              onBlur={validation.touch('type')}
              data-testid="composer-type"
            >
              <option value="">{t.typePlaceholder}</option>
              {EXPENSE_TYPES.map((option) => (
                <option key={option.id} value={option.id}>
                  {expenseTypeLabel(option.id)}
                </option>
              ))}
            </select>
          )}
        </Field>

        {/*
          Field's own markup, written out (not `<Field>`): the combobox keeps
          its fixed id `composer-motivo`, which it also uses as its test id and
          as the prefix of its listbox/option/live-region ids — `Field` would
          replace it with a generated one. Same classes, same wiring: label →
          control, required marker + aria-required, error → aria-invalid +
          aria-describedby.

          ONE JSX node across both expense-type branches (never a
          `showKm ? <MotivoSuggestField/> : <input/>` fork), so React
          reconciles the same DOM element and the employee's focus, caret and
          IME composition survive an expense-type change. `enabled` alone
          switches the combobox behaviour on and off (AC-1.1).
        */}
        <div className="field">
          <label htmlFor="composer-motivo" className="field-label">
            {t.motivoLabel}
            <span aria-hidden="true" className="field-required">
              *
            </span>
          </label>
          <MotivoSuggestField
            id="composer-motivo"
            value={draft.motivo}
            onChange={(motivo) => setDraft((prev) => ({ ...prev, motivo }))}
            onPick={handlePickSuggestion}
            enabled={showKm}
            disabled={submitting}
            required
            corpusEpoch={corpusEpoch}
            invalid={motivoError !== undefined}
            describedBy={motivoError ? 'composer-motivo-error' : undefined}
            onFieldBlur={validation.touch('motivo')}
          />
          {motivoError && (
            <p id="composer-motivo-error" className="field-error">
              {motivoError}
            </p>
          )}
        </div>

        {/* specs/20260720-mileage-rate AC-1.1: for travel_km, Amount is replaced by the
            read-only computed breakdown (MileageAmountField) — not merely disabled. */}
        {showKm ? (
          <div className="flex flex-col gap-1">
            <MileageAmountField entity={draft.entity} date={draft.date} km={draft.km} />
          </div>
        ) : (
          <Field
            label={t.amountLabel}
            hint={draft.entity === 'welld_ch' ? t.splitReceiptHint : undefined}
            error={validation.errorFor('amount')}
            required
          >
            {(control) => (
              <MoneyInput
                {...control}
                value={draft.amount}
                disabled={submitting}
                onChange={(e) => setDraft((prev) => ({ ...prev, amount: e.target.value }))}
                onBlur={validation.touch('amount')}
                data-testid="composer-amount"
              />
            )}
          </Field>
        )}

        <Field label={t.entityLabel} error={validation.errorFor('entity')} required>
          {(control) => (
            <select
              {...control}
              value={draft.entity}
              disabled={submitting}
              onChange={(e) => setDraft((prev) => ({ ...prev, entity: e.target.value as Entity | '' }))}
              onBlur={validation.touch('entity')}
              data-testid="composer-entity"
            >
              <option value="">{t.entityPlaceholder}</option>
              {ENTITY_OPTIONS.map((entity) => (
                <option key={entity} value={entity}>
                  {badgeStrings[entity]}
                </option>
              ))}
            </select>
          )}
        </Field>

        {/* specs/20260720-mileage-rate AC-1.6: for travel_km, currency is entity-designated,
            never independently selectable — the select is absent, not disabled. */}
        {!showKm && (
          <Field label={t.currencyLabel} error={validation.errorFor('currency')} required>
            {(control) => (
              <select
                {...control}
                value={draft.currency}
                disabled={submitting}
                onChange={(e) => setDraft((prev) => ({ ...prev, currency: e.target.value as Currency | '' }))}
                onBlur={validation.touch('currency')}
                data-testid="composer-currency"
              >
                <option value="">{t.currencyPlaceholder}</option>
                {CURRENCY_OPTIONS.map((currency) => (
                  <option key={currency} value={currency}>
                    {currencyStrings[currency]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}

        {/* A distance is a quantity, not money: it stays `type="number"` (INC-17). */}
        {showKm && (
          <Field label={t.kmLabel} hint={t.kmHelp} error={validation.errorFor('km')} required>
            {(control) => (
              <input
                {...control}
                type="number"
                min="1"
                step="1"
                className="input-figure"
                value={draft.km}
                disabled={submitting}
                onChange={(e) => setDraft((prev) => ({ ...prev, km: e.target.value }))}
                onBlur={validation.touch('km')}
                data-testid="composer-km"
              />
            )}
          </Field>
        )}
      </div>

      {/* AC-1.2 a11y hotspot: announces the km field's appearance/disappearance */}
      <p aria-live="polite" data-testid="composer-km-status" className="sr-only">
        {kmStatus}
      </p>

      {error && (
        <p role="alert" data-testid="composer-error" className="form-error">
          {error}
        </p>
      )}

      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={!canAdd}
          busy={submitting}
          data-testid="composer-add-button"
        >
          {submitting ? t.addingLabel : t.addButton}
        </Button>
      </div>
    </form>
  )
}
