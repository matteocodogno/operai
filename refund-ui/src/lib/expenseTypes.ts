/**
 * expenseTypes — the fourteen fixed expense-line categories (twelve from the paper form, plus flight and taxi, specs/20261119-accounting T68) carried over from
 * the paper form (T14, specs/20260716-refund-service/tasks.md; spec.md "Domain
 * language" table). Single source of truth for `ExpenseLineComposer`/
 * `ExpenseLineRow`'s type `<select>` (T16) and for spec.md's own
 * English-identifier/Italian-source-form-label pairing — see design.md's
 * Accessibility note: "the 12 expense-type labels … sourced from a single
 * EXPENSE_TYPES-shaped dictionary keyed for both locales, not inlined JSX
 * text."
 *
 * `id` values are the WIRE format: they match `refund-api`'s Prisma
 * `ExpenseType` enum verbatim (plan.md "## Data model" — snake_case, e.g.
 * `travel_km`), NOT spec.md's prose-readability hyphenated form
 * (`travel-km`). These ids round-trip directly through
 * `POST/PUT /requests/:id/lines` request bodies and `GET` responses without
 * any transform — a translation layer between a UI-only id and the API's id
 * would be a pure liability with no upside.
 *
 * `labelEn` is what v1 renders (strings.ts's English-only Gate-2 decision
 * applies here too). `labelIt` is the paper form's original Italian text,
 * kept as data now — per this task's instructions ("keep the Italian
 * source-form label available as data for later") — so a future locale
 * switch needs no re-derivation from spec.md.
 */

import { resolveLocale } from '@operai/ui'
import type { Locale } from '@operai/ui'

export type ExpenseType =
  | 'travel_highway'
  | 'travel_km'
  | 'travel_parking'
  | 'travel_train'
  | 'travel_other_public_transport'
  | 'travel_flight'
  | 'travel_taxi'
  | 'company_manuals'
  | 'stationery'
  | 'representation_meals'
  | 'representation_gifts'
  | 'office_material'
  | 'postal'
  | 'telephone'

export type ExpenseTypeOption = {
  id: ExpenseType
  labelEn: string
  labelIt: string
}

/** Enum order of refund-api's `ExpenseType` (14 types; flight and taxi follow `travel_other_public_transport`, T58/T68). */
export const EXPENSE_TYPES: readonly ExpenseTypeOption[] = [
  { id: 'travel_highway', labelEn: 'Travel — highway', labelIt: 'Spese di viaggio (autostrada)' },
  { id: 'travel_km', labelEn: 'Travel — mileage (km)', labelIt: 'Spese di viaggio (km)' },
  { id: 'travel_parking', labelEn: 'Travel — parking', labelIt: 'Spese di viaggio (parcheggio)' },
  { id: 'travel_train', labelEn: 'Travel — train', labelIt: 'Spese di viaggio (treno)' },
  {
    id: 'travel_other_public_transport',
    labelEn: 'Travel — other public transport',
    labelIt: 'Spese di viaggio (altri mezzi pubblici)',
  },
  { id: 'travel_flight', labelEn: 'Travel — flight', labelIt: 'Spese di viaggio (aereo)' },
  { id: 'travel_taxi', labelEn: 'Travel — taxi', labelIt: 'Spese di viaggio (taxi)' },
  { id: 'company_manuals', labelEn: 'Company manuals', labelIt: 'Spese manualistica societaria' },
  { id: 'stationery', labelEn: 'Stationery', labelIt: 'Spese di cancelleria' },
  {
    id: 'representation_meals',
    labelEn: 'Meals with clients',
    labelIt: 'Pranzi/cene con clienti',
  },
  {
    id: 'representation_gifts',
    labelEn: 'Representation — gifts',
    labelIt: 'Spese di rappresentanza (regali)',
  },
  { id: 'office_material', labelEn: 'Office material', labelIt: 'Spese materiale ufficio' },
  { id: 'postal', labelEn: 'Postal', labelIt: 'Spese postali' },
  { id: 'telephone', labelEn: 'Telephone', labelIt: 'Spese telefoniche' },
] as const

/**
 * The one expense type for which `km` is required (and must be `> 0`) —
 * every other type must NOT render/accept a `km` field at all (AC-1.2,
 * design.md F1 step 3: "for every other type the km input is not rendered at
 * all, not merely disabled"). Exported here, next to `EXPENSE_TYPES`, since
 * it is a fact about this same domain constant, not a UI decision —
 * `ExpenseLineComposer`/`ExpenseLineRow` (T16) drive their conditional field
 * off this rather than re-hardcoding the literal `'travel_km'` string.
 */
/**
 * An expense type's label in the person's language (INC-25). `labelEn` is the
 * canonical document label shared with refund-api's PDFs
 * (documentLabels.parity.test.ts); `labelIt` its Italian name.
 */
export const expenseTypeLabel = (type: ExpenseType, locale: Locale = resolveLocale()): string => {
  const option = EXPENSE_TYPES.find((o) => o.id === type)
  if (!option) return type
  return locale === 'it' ? option.labelIt : option.labelEn
}

export const KM_REQUIRED_TYPE: ExpenseType = 'travel_km'

/** True only for the one expense type that requires (and accepts) `km`. */
export const requiresKm = (type: ExpenseType): boolean => type === KM_REQUIRED_TYPE
