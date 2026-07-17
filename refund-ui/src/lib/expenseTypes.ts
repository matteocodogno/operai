/**
 * expenseTypes — the twelve fixed expense-line categories carried over from
 * the paper form (T14, specs/007-refund-service/tasks.md; spec.md "Domain
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

export type ExpenseType =
  | 'travel_highway'
  | 'travel_km'
  | 'travel_parking'
  | 'travel_train'
  | 'travel_other_public_transport'
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

/** Order matches spec.md's domain-language table (#1–#12). */
export const EXPENSE_TYPES: readonly ExpenseTypeOption[] = [
  { id: 'travel_highway', labelEn: 'Travel — highway', labelIt: 'spese di viaggio (autostrada)' },
  { id: 'travel_km', labelEn: 'Travel — mileage (km)', labelIt: 'spese di viaggio (km)' },
  { id: 'travel_parking', labelEn: 'Travel — parking', labelIt: 'spese di viaggio (parcheggio)' },
  { id: 'travel_train', labelEn: 'Travel — train', labelIt: 'spese di viaggio (treno)' },
  {
    id: 'travel_other_public_transport',
    labelEn: 'Travel — other public transport',
    labelIt: 'spese di viaggio (altri mezzi pubblici)',
  },
  { id: 'company_manuals', labelEn: 'Company manuals', labelIt: 'spese manualistica societaria' },
  { id: 'stationery', labelEn: 'Stationery', labelIt: 'spese di cancelleria' },
  {
    id: 'representation_meals',
    labelEn: 'Representation — meals',
    labelIt: 'spese di rappresentanza (pranzi/cene/aperitivi)',
  },
  {
    id: 'representation_gifts',
    labelEn: 'Representation — gifts',
    labelIt: 'spese di rappresentanza (regali)',
  },
  { id: 'office_material', labelEn: 'Office material', labelIt: 'spese materiale ufficio' },
  { id: 'postal', labelEn: 'Postal', labelIt: 'spese postali' },
  { id: 'telephone', labelEn: 'Telephone', labelIt: 'spese telefoniche' },
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
export const KM_REQUIRED_TYPE: ExpenseType = 'travel_km'

/** True only for the one expense type that requires (and accepts) `km`. */
export const requiresKm = (type: ExpenseType): boolean => type === KM_REQUIRED_TYPE
