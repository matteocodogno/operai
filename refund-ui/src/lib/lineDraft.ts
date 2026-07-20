/**
 * lineDraft — the shared "in-progress expense line form" shape and its
 * validation/conversion helpers, used by both `ExpenseLineComposer` (a new,
 * not-yet-persisted line) and `ExpenseLineRow` (an existing persisted line
 * being edited in place) — T16, specs/007-refund-service/tasks.md.
 *
 * A draft's fields are always plain strings (what an `<input>`/`<select>`
 * actually holds), never the typed wire values `POST/PUT
 * /requests/:id/lines[/:lineId]` expect — `lineDraftToPayload` is the one
 * place that conversion happens, so the two call sites (composer/row) never
 * duplicate it. Money is entered as major units (e.g. "45.50") and converted
 * to integer cents here — `amountToCents` returns `null` for anything that
 * isn't a valid non-negative number, which both `isLineDraftComplete` and
 * every caller treat as "not yet valid," never as "0".
 *
 * `km` is deliberately kept as a *string* field on the draft — its numeric
 * meaning is `ExpenseType`-conditional (required & `>0` only for
 * `travel_km`, plan.md "## API contracts": "km required and > 0 iff
 * type==travel_km, rejected if present for any other type") — carrying the
 * type-driven presence/validity logic here means `ExpenseLineComposer`/
 * `ExpenseLineRow` don't each reimplement the branch.
 *
 * `currency` (post-close change, specs/007): a separately-stored,
 * independently-selectable field — no longer derived from `entity` — with
 * its own no-default select (same "explicit, deliberate choice" pattern as
 * `entity`/`type`, AC-1.2). Any entity/currency pair is valid; this module
 * never cross-validates the two.
 */

import type { ExpenseType } from './expenseTypes'
import { requiresKm } from './expenseTypes'
import type { Entity } from '../components/EntityBadge'
import type { Currency } from './money'
import type { LinePayload, RefundLine } from './requestsApi'
import { todayIsoDate } from './dates'

export type LineDraftValue = {
  date: string
  type: ExpenseType | ''
  motivo: string
  /** Major-unit amount as typed, e.g. "45.50" — never cents. */
  amount: string
  entity: Entity | ''
  /** Independent of `entity` — no default, any entity/currency pair is valid. */
  currency: Currency | ''
  /** Only meaningful when `type` requires km (`requiresKm`) — ignored otherwise. */
  km: string
}

/** A fresh draft for `ExpenseLineComposer` — no default type/entity/currency (AC-1.2: "no default … an explicit, deliberate choice"). */
export const emptyLineDraft = (): LineDraftValue => ({
  date: todayIsoDate(),
  type: '',
  motivo: '',
  amount: '',
  entity: '',
  currency: '',
  km: '',
})

/** Converts a persisted `RefundLine` into an editable draft for `ExpenseLineRow`. */
export const lineToDraft = (line: RefundLine): LineDraftValue => ({
  date: line.date,
  type: line.type,
  motivo: line.motivo,
  amount: centsToAmountInput(line.requestedAmountCents),
  entity: line.entity,
  currency: line.currency,
  km: line.km !== null ? String(line.km) : '',
})

/**
 * Parses a major-unit amount string (e.g. "45.50") into integer cents.
 * Returns `null` for empty/negative/non-finite input — callers must treat
 * `null` as "not a valid amount yet," never coerce it to `0`.
 */
export const amountToCents = (raw: string): number | null => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

/** The inverse of `amountToCents`, for pre-filling an existing line's amount field. */
export const centsToAmountInput = (cents: number): string => (cents / 100).toFixed(2)

/**
 * True once every field required for the draft's *current* type is present
 * and valid (AC-1.2) — `km` is only checked when `requiresKm(type)`, and its
 * absence/invalidity never blocks a draft of any other type.
 *
 * specs/009-mileage-rate amendment (design.md F1 "Add/Done enable
 * condition"): for `travel_km`, "complete" becomes date + type + motivo +
 * entity + `km > 0` — amount/currency are DROPPED from this check (they no
 * longer exist as fields for this type, AC-1.1). `rateInEffect` is
 * deliberately NOT part of completeness either — a line with no rate
 * configured yet is still a valid, saveable draft (AC-2.2's blocked state is
 * a submission-time gate, not a save-time one).
 */
export const isLineDraftComplete = (draft: LineDraftValue): boolean => {
  if (!draft.date || !draft.type || draft.motivo.trim() === '' || !draft.entity) return false
  if (requiresKm(draft.type)) {
    const km = Number(draft.km)
    return Number.isFinite(km) && km > 0
  }
  if (!draft.currency) return false
  if (amountToCents(draft.amount) === null) return false
  return true
}

/**
 * Converts a complete draft into the wire payload `POST/PUT
 * /requests/:id/lines[/:lineId]` expects. Only call once
 * `isLineDraftComplete(draft)` is true — an incomplete draft's payload would
 * carry a `0`/`NaN` in place of a required field.
 *
 * specs/009-mileage-rate amendment (AC-1.1/AC-1.6, plan.md "## API
 * contracts"): for `travel_km`, `requestedAmountCents`/`currency` are
 * server-derived and OMITTED from the payload entirely — never a
 * client-guessed `0`/entity guess sent as if it were authoritative. Every
 * other type is unchanged: both fields are always included.
 */
export const lineDraftToPayload = (draft: LineDraftValue): LinePayload => {
  const type = draft.type as ExpenseType
  const payload: LinePayload = {
    date: draft.date,
    type,
    motivo: draft.motivo.trim(),
    entity: draft.entity as Entity,
  }
  if (requiresKm(type)) {
    payload.km = Number(draft.km)
  } else {
    payload.requestedAmountCents = amountToCents(draft.amount) ?? 0
    payload.currency = draft.currency as Currency
  }
  return payload
}
