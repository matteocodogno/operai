/**
 * legalEntityMappings — the single mappings from the registry's answers to what the page shows (T34, design
 * "Component inventory": `legalEntityStatus()`, `problemSentence()`, `valueName()`, `addressProblemTarget()`):
 * badge, sentence, word, input. Pure; every sentence comes from `strings.legalEntities` and is chosen by the
 * problem's `reason`, never by the server's wording. Each function takes the catalog as its last argument
 * (default: the resolved language) so both languages are testable without touching `<html lang>`.
 */
import type { BadgeTone, IconName } from '@operai/ui'
import { strings } from '../strings'
import {
  FIELD_PAGE_ORDER,
  LIMITS,
  addressLanguage,
  cleanText,
  codePointLength,
  isAddressField,
  normalizeIban,
  normalizeLines,
} from './legalEntityModel'
import type { LegalEntity, LegalEntityDetails, LegalEntityField, LegalEntityProblem } from './legalEntityModel'

type Catalog = typeof strings.legalEntities

// ---------------------------------------------------------------------------
// Status badge (design S1)
// ---------------------------------------------------------------------------

export type LegalEntityStatusKind = 'complete' | 'incomplete' | 'needsCorrection' | 'notMoved'

export type LegalEntityStatus = {
  kind: LegalEntityStatusKind
  label: string
  tone: BadgeTone
  icon: IconName
}

/**
 * The badge of an entity, shown on its tab and in its panel header.
 *
 * - `version: 0` is **Not moved yet**, before anything else: its values are empty, so `complete` is false, but
 *   "Incomplete" would be wrong (nothing was moved, and there is no form to fill in);
 * - `complete: false` is **Incomplete** (a required value is missing: offers are refused, AC-6.3), also when values
 *   needing correction exist too (the panel lists both);
 * - `complete: true` with `invalid` entries is **Needs correction** (blocks nothing, AC-7.5; E13);
 * - otherwise **Complete**.
 * `complete` is the answer's own word (plan decision 10): this function does not recompute it from `missing`.
 */
export const legalEntityStatus = (
  entity: Pick<LegalEntity, 'version' | 'complete' | 'invalid'>,
  s: Catalog = strings.legalEntities,
): LegalEntityStatus => {
  if (entity.version === 0) return { kind: 'notMoved', label: s.status.notMoved, tone: 'muted', icon: 'clock' }
  if (!entity.complete) return { kind: 'incomplete', label: s.status.incomplete, tone: 'warning', icon: 'alert' }
  if (entity.invalid.length > 0) {
    return { kind: 'needsCorrection', label: s.status.needsCorrection, tone: 'warning', icon: 'alert' }
  }
  return { kind: 'complete', label: s.status.complete, tone: 'success', icon: 'check-circle' }
}

// ---------------------------------------------------------------------------
// Value names
// ---------------------------------------------------------------------------

/** The word for a value ("VAT number", "Address (Italian)"). A field this build does not know is shown as received. */
export const valueName = (field: LegalEntityField, s: Catalog = strings.legalEntities): string => {
  switch (field) {
    case 'legalName':
      return s.value.legalName
    case 'vatNumber':
      return s.value.vat
    case 'iban':
      return s.value.iban
    case 'address.it':
      return s.value.addressIt
    case 'address.en':
      return s.value.addressEn
    case 'contacts.it':
      return s.value.contactsIt
    case 'contacts.en':
      return s.value.contactsEn
    default:
      return String(field)
  }
}

/** "Legal name, VAT number": names joined for a sentence. Order is the order given. */
export const valueNameList = (fields: readonly LegalEntityField[], s: Catalog = strings.legalEntities): string =>
  fields.map((field) => valueName(field, s)).join(', ')

/**
 * A word in the middle of a sentence: first letter lower-cased unless the word is an acronym ("VAT number" stays,
 * "Legal name" becomes "legal name", "IBAN" stays).
 */
const inSentence = (word: string): string => {
  const [first = '', second = ''] = Array.from(word)
  if (first === '' || (second !== '' && second === second.toUpperCase() && second !== second.toLowerCase())) return word
  return first.toLowerCase() + word.slice(first.length)
}

// ---------------------------------------------------------------------------
// Address problem -> input (design S2 table)
// ---------------------------------------------------------------------------

/** The address line input a problem lands on: `line` is the 0-based position of the input ("Line {line + 1}"). */
export type AddressProblemTarget = { language: 'it' | 'en'; line: number }

/** The first input beyond the fourth: where `too_many_lines` lands (only reachable from a moved longer address). */
const FIRST_LINE_BEYOND_LIMIT = LIMITS.addressLines

const isLineIndex = (line: unknown): line is number => typeof line === 'number' && Number.isInteger(line) && line >= 0

/**
 * Which address input a problem belongs to, or `null` when the problem is not about an address.
 *
 * | API problem | Lands on |
 * | per-line reason (`too_long`, `line_break`, `control_character`) with `line: k` | the input at position k (E5) |
 * | `required` (no `line`) | Line 1 |
 * | `too_many_lines` (no `line`) | Line 5, the first input beyond the fourth |
 * | any other address reason without a `line` | Line 1 |
 */
export const addressProblemTarget = (problem: LegalEntityProblem): AddressProblemTarget | null => {
  if (!isAddressField(problem.field)) return null
  const language = addressLanguage(problem.field)
  if (problem.reason === 'too_many_lines') return { language, line: FIRST_LINE_BEYOND_LIMIT }
  if (problem.reason === 'required') return { language, line: 0 }
  return { language, line: isLineIndex(problem.line) ? problem.line : 0 }
}

/**
 * Problems in the order of the controls on the page, so the summary lists them as the page reads and focus goes
 * to the first one. Within an address, by input position. Stable for equal positions (two problems on one line
 * keep the server's order). Does not mutate its argument.
 */
export const problemsInPageOrder = (problems: readonly LegalEntityProblem[]): LegalEntityProblem[] =>
  problems
    .map((problem, index) => ({
      problem,
      index,
      field: FIELD_PAGE_ORDER.indexOf(problem.field),
      line: addressProblemTarget(problem)?.line ?? 0,
    }))
    .sort((a, b) => a.field - b.field || a.line - b.line || a.index - b.index)
    .map(({ problem }) => problem)

// ---------------------------------------------------------------------------
// Problem sentences (design S2: "Problem -> sentence (by `reason`)")
// ---------------------------------------------------------------------------

export type ProblemContext = {
  /**
   * The values the problem is about, indexed like the problem says: the submitted details for a save refusal
   * (E5: positions before blank lines were dropped), the entity itself for a read's `invalid[]` (E6). The server
   * answers a `limit` but not how far over it the value is; the sentence counts it here, in code points.
   */
  values: LegalEntityDetails
  /** The problem comes from a read of a moved value, not from a refused save (its `too_many_lines` wording differs). */
  moved?: boolean
}

const limitOf = (problem: LegalEntityProblem): number => {
  if (typeof problem.limit === 'number') return problem.limit
  switch (problem.field) {
    case 'legalName':
      return LIMITS.legalName
    case 'address.it':
    case 'address.en':
      return problem.reason === 'too_many_lines' ? LIMITS.addressLines : LIMITS.addressLine
    case 'vatNumber':
      return LIMITS.vatNumber
    case 'iban':
      return LIMITS.iban
    case 'contacts.it':
    case 'contacts.en':
      return LIMITS.contacts
  }
}

/** How long the offending value is, in code points, in the form the server judged (trimmed; an IBAN without spaces). */
const lengthOfValue = (problem: LegalEntityProblem, values: LegalEntityDetails): number => {
  switch (problem.field) {
    case 'legalName':
      return codePointLength(cleanText(values.legalName))
    case 'vatNumber':
      return codePointLength(cleanText(values.vatNumber))
    case 'iban':
      return codePointLength(normalizeIban(cleanText(values.iban)))
    case 'contacts.it':
      return codePointLength(cleanText(values.contacts.it))
    case 'contacts.en':
      return codePointLength(cleanText(values.contacts.en))
    case 'address.it':
    case 'address.en': {
      const lines = values.address[addressLanguage(problem.field)]
      return codePointLength(cleanText(lines[problem.line ?? 0] ?? ''))
    }
  }
}

/** How many non-blank lines an address holds (what `too_many_lines` counts). */
const nonBlankLines = (problem: LegalEntityProblem, values: LegalEntityDetails): number =>
  isAddressField(problem.field) ? normalizeLines(values.address[addressLanguage(problem.field)]).length : 0

/** The value as a sentence names it after "Enter": an address by its group, the language is in the legend. */
const requiredWord = (problem: LegalEntityProblem, s: Catalog): string =>
  inSentence(isAddressField(problem.field) ? s.form.group.address : valueName(problem.field, s))

/**
 * The sentence for a problem, the same under its control and in the error summary. Chosen by `reason`. A reason
 * this build does not know is shown as received (the parser refuses such an answer first, so this is a backstop).
 * A problem read from a moved value (`context.moved`) ends "(Kept as moved from the CRM.)" whatever its reason
 * (FU-7); the refusal of a save never does.
 */
export const problemSentence = (
  problem: LegalEntityProblem,
  context: ProblemContext,
  s: Catalog = strings.legalEntities,
): string => {
  const plain = ((): string => {
    switch (problem.reason) {
      case 'required':
        return s.problem.required(requiredWord(problem, s))
      case 'too_long':
        return s.problem.tooLong(limitOf(problem), lengthOfValue(problem, context.values))
      case 'too_many_lines':
        return context.moved
          ? s.problem.tooManyLinesMoved
          : s.problem.tooManyLines(nonBlankLines(problem, context.values))
      case 'line_break':
        return s.problem.lineBreak
      case 'control_character':
        return s.problem.controlChar
      case 'iban_format':
        return s.problem.ibanFormat
      case 'iban_check_digits':
        return s.problem.ibanCheck
      default:
        return String(problem.reason)
    }
  })()
  return context.moved ? s.problem.moved(plain) : plain
}

/**
 * The static marker of a required value that is missing on a moved entity: "Not filled in. Enter the VAT number."
 * (a refusal after a save keeps `problem.required`).
 */
export const notFilledSentence = (field: LegalEntityField, s: Catalog = strings.legalEntities): string =>
  s.problem.notFilled(requiredWord({ field, reason: 'required' }, s))

/**
 * The text of a problem's button in the error summary: "Line 3 of the Italian address: Too long: …" for an address
 * (the line is where `addressProblemTarget` lands), "{Value}: {sentence}" for everything else.
 */
export const problemSummary = (
  problem: LegalEntityProblem,
  context: ProblemContext,
  s: Catalog = strings.legalEntities,
): string => {
  const sentence = problemSentence(problem, context, s)
  const target = addressProblemTarget(problem)
  return target
    ? s.problem.line(target.language, target.line + 1, sentence)
    : `${valueName(problem.field, s)}: ${sentence}`
}
