/**
 * legalEntityModel — the shapes of the legal-entity registry as admin-ui sees them, and the small pure helpers
 * every other `legalEntit*` module shares (T34, specs/20261117-legal-entities).
 *
 * The shapes mirror plan.md "API contracts" with its amendments E1 (`restorable`), E5 (`problems[].line` is the
 * position in the submitted array), E6 (`invalid[]` carries `line?` and `limit?`). The rules themselves live in
 * auth only (plan decision 10); this file never decides whether a value is valid. The one thing it does mirror from
 * `auth/src/legalEntities/rules.ts` is the *normalisation* (NFC, trim, blank address lines out, IBAN in electronic
 * form), because the form's "did anything change?" check and the conflict merge must agree with the server about
 * when two values are the same value (AC-2.1: equal after normalisation is a no-op, not a new version).
 */

/** The two entities, in the fixed order the page shows them. Mirrors auth's `LEGAL_ENTITIES`. */
export const LEGAL_ENTITY_IDS = ['welld_it', 'welld_ch'] as const
export type LegalEntityId = (typeof LEGAL_ENTITY_IDS)[number]

export const isLegalEntityId = (value: unknown): value is LegalEntityId =>
  typeof value === 'string' && (LEGAL_ENTITY_IDS as readonly string[]).includes(value)

/**
 * The closed set of values (`changedFields`, `problems[].field`, `missing[]`, `invalid[].field`), in the API's
 * order. Use `FIELD_PAGE_ORDER` for anything laid out like the form.
 */
export const LEGAL_ENTITY_FIELDS = [
  'legalName',
  'address.it',
  'address.en',
  'vatNumber',
  'iban',
  'contacts.it',
  'contacts.en',
] as const
export type LegalEntityField = (typeof LEGAL_ENTITY_FIELDS)[number]

/**
 * The order the controls appear on the page (design S2): Company (name, VAT, IBAN), the Italian address lines, the
 * English address lines, then the contacts lines. "Focus goes to the first refused control in page order."
 */
export const FIELD_PAGE_ORDER: readonly LegalEntityField[] = [
  'legalName',
  'vatNumber',
  'iban',
  'address.it',
  'address.en',
  'contacts.it',
  'contacts.en',
]

export type AddressField = 'address.it' | 'address.en'

export const isAddressField = (field: LegalEntityField): field is AddressField =>
  field === 'address.it' || field === 'address.en'

/** `address.it` -> `it`. */
export const addressLanguage = (field: AddressField): 'it' | 'en' => (field === 'address.it' ? 'it' : 'en')

/** Closed set of `reason`s of a problem (plan "API contracts"). */
export const PROBLEM_REASONS = [
  'required',
  'too_long',
  'too_many_lines',
  'line_break',
  'control_character',
  'iban_format',
  'iban_check_digits',
] as const
export type ProblemReason = (typeof PROBLEM_REASONS)[number]

/** AC-1.3's limits, in Unicode code points. Display fallbacks only: the answer's own `limit` wins. */
export const LIMITS = {
  legalName: 200,
  addressLine: 120,
  addressLines: 4,
  vatNumber: 40,
  iban: 34,
  contacts: 200,
} as const

/** `{ field, line?, reason, limit? }`: a 422 `problems[]` item (E5) and a read's `invalid[]` item (E6). */
export type LegalEntityProblem = {
  field: LegalEntityField
  /** 0-based. Only on a per-line address reason. A save: the submitted array (E5). A read: the stored array (E6). */
  line?: number
  reason: ProblemReason
  limit?: number
}

/** The seven values of an entity, as the form edits them and as a save sends them (`POST …/versions` `details`). */
export type LegalEntityDetails = {
  legalName: string
  address: { it: string[]; en: string[] }
  vatNumber: string
  /** Electronic form on a read (upper case, no spaces); whatever the person typed on a save. */
  iban: string
  contacts: { it: string; en: string }
}

/** One entity as the read routes answer (the one serializer, plan decision 2). */
export type LegalEntity = LegalEntityDetails & {
  entity: LegalEntityId
  /** 0 = not moved yet (every value empty). */
  version: number
  updatedAt: string | null
  /** Groups of four, for display. */
  ibanPrint: string
  complete: boolean
  missing: LegalEntityField[]
  invalid: LegalEntityProblem[]
}

export type VersionAction = 'import' | 'save' | 'restore'

export type VersionAuthor = { id: string; name: string }

/** An item of `GET …/versions` (newest first), with E1's `restorable`. */
export type VersionListItem = {
  version: number
  action: VersionAction
  restoredFrom: number | null
  /** `null` = the system (the move). */
  createdBy: VersionAuthor | null
  createdAt: string
  changedFields: LegalEntityField[]
  restorable: boolean
}

/** `GET …/versions/{n}`: the `LegalEntity` of version n and where it came from. */
export type LegalEntityVersion = LegalEntity & {
  action: VersionAction
  restoredFrom: number | null
  createdBy: VersionAuthor | null
  createdAt: string
}

/** A value of one field: a line of text, or the lines of an address. */
export type FieldValue = string | string[]

export const emptyDetails = (): LegalEntityDetails => ({
  legalName: '',
  address: { it: [], en: [] },
  vatNumber: '',
  iban: '',
  contacts: { it: '', en: '' },
})

/** The seven values of anything that carries them, as a fresh object (never shares an array with its source). */
export const detailsOf = (source: LegalEntityDetails): LegalEntityDetails => ({
  legalName: source.legalName,
  address: { it: [...source.address.it], en: [...source.address.en] },
  vatNumber: source.vatNumber,
  iban: source.iban,
  contacts: { it: source.contacts.it, en: source.contacts.en },
})

export const getFieldValue = (details: LegalEntityDetails, field: LegalEntityField): FieldValue => {
  switch (field) {
    case 'legalName':
      return details.legalName
    case 'address.it':
      return details.address.it
    case 'address.en':
      return details.address.en
    case 'vatNumber':
      return details.vatNumber
    case 'iban':
      return details.iban
    case 'contacts.it':
      return details.contacts.it
    case 'contacts.en':
      return details.contacts.en
  }
}

/**
 * A copy of `details` with one value replaced. An address takes an array, every other value a string; the wrong
 * kind is a programming error and throws rather than storing a value the form could not show.
 */
export const setFieldValue = (
  details: LegalEntityDetails,
  field: LegalEntityField,
  value: FieldValue,
): LegalEntityDetails => {
  const next = detailsOf(details)
  if (isAddressField(field)) {
    if (!Array.isArray(value)) throw new TypeError(`${field} takes lines`)
    next.address[addressLanguage(field)] = [...value]
    return next
  }
  if (typeof value !== 'string') throw new TypeError(`${field} takes text`)
  switch (field) {
    case 'legalName':
      next.legalName = value
      break
    case 'vatNumber':
      next.vatNumber = value
      break
    case 'iban':
      next.iban = value
      break
    case 'contacts.it':
      next.contacts.it = value
      break
    case 'contacts.en':
      next.contacts.en = value
      break
  }
  return next
}

// ---------------------------------------------------------------------------
// Normalisation (mirrors auth/src/legalEntities/rules.ts `normalise`; judging validity stays with auth)
// ---------------------------------------------------------------------------

/** NFC, then trim. */
export const cleanText = (raw: string): string => raw.normalize('NFC').trim()

/**
 * Electronic form of an IBAN: every whitespace removed (U+0085 included), ASCII letters upper-cased, nothing else
 * touched (a lone `toUpperCase` would turn "ß" into "SS").
 */
export const normalizeIban = (raw: string): string =>
  raw
    .normalize('NFC')
    .replace(/[\s\u0085]+/gu, '')
    .replace(/[a-z]/g, (c) => c.toUpperCase())

/** Trimmed address lines with the blank ones left out. */
export const normalizeLines = (lines: readonly string[]): string[] => lines.map(cleanText).filter((line) => line !== '')

/** A value in the form a save would persist. */
export const normalizeFieldValue = (field: LegalEntityField, value: FieldValue): FieldValue => {
  if (Array.isArray(value)) return normalizeLines(value)
  return field === 'iban' ? normalizeIban(cleanText(value)) : cleanText(value)
}

/** Every value in the form a save would persist. */
export const normalizeDetails = (details: LegalEntityDetails): LegalEntityDetails => ({
  legalName: cleanText(details.legalName),
  address: { it: normalizeLines(details.address.it), en: normalizeLines(details.address.en) },
  vatNumber: cleanText(details.vatNumber),
  iban: normalizeIban(cleanText(details.iban)),
  contacts: { it: cleanText(details.contacts.it), en: cleanText(details.contacts.en) },
})

const sameValue = (a: FieldValue, b: FieldValue): boolean => {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  return a.length === b.length && a.every((line, index) => line === b[index])
}

/** Are two values the same value once normalised (so "CH93 0076…" and "ch930076…", or a blank extra line, are)? */
export const sameFieldValue = (field: LegalEntityField, a: FieldValue, b: FieldValue): boolean =>
  sameValue(normalizeFieldValue(field, a), normalizeFieldValue(field, b))

/** The fields whose value differs after normalisation, in the API's order. Empty exactly when a save is a no-op. */
export const changedFieldsBetween = (a: LegalEntityDetails, b: LegalEntityDetails): LegalEntityField[] =>
  LEGAL_ENTITY_FIELDS.filter((field) => !sameFieldValue(field, getFieldValue(a, field), getFieldValue(b, field)))

/** Number of Unicode code points, the unit of every limit (an emoji counts 1). */
export const codePointLength = (text: string): number => Array.from(text).length
