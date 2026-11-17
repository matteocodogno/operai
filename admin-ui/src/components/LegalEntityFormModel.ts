/**
 * LegalEntityFormModel — the pure part of the entity form (T37, specs/20261117-legal-entities, design S2/S3): what
 * the address inputs are, what a save sends, which control a refused value belongs to, and which controls carry a
 * "kept as moved" mark. No React here, so every rule below has its own plain test.
 *
 * Nothing in this file judges a value (plan decision 10: the rules live in auth only). It counts inputs, pads
 * lines, trims for comparison, and maps the registry's own answers (`problems[]` of a refusal, `invalid[]` and
 * `missing[]` of a read) onto the controls they land on.
 */
import { addressProblemTarget, notFilledSentence, problemSentence, problemSummary, problemsInPageOrder } from '../lib/legalEntityMappings'
import {
  LIMITS,
  addressLanguage,
  cleanText,
  detailsOf,
  getFieldValue,
  isAddressField,
  normalizeIban,
  sameFieldValue,
} from '../lib/legalEntityModel'
import type {
  AddressField,
  LegalEntity,
  LegalEntityDetails,
  LegalEntityId,
  LegalEntityProblem,
} from '../lib/legalEntityModel'
import { strings } from '../strings'

type Lang = 'it' | 'en'

// ---------------------------------------------------------------------------
// Address inputs (Q2=B)
// ---------------------------------------------------------------------------

/** How many line inputs an address shows: four, or one per stored line for a moved address of more than four (D3). */
export const addressInputCount = (lines: readonly string[]): number => Math.max(LIMITS.addressLines, lines.length)

/** The lines as the inputs hold them: `count` entries, blanks included, in input order. */
export const padLines = (lines: readonly string[], count: number): string[] =>
  Array.from({ length: Math.max(count, lines.length) }, (_, index) => lines[index] ?? '')

/**
 * The details exactly as a save sends them: every address as its inputs hold it, blank lines included (E5:
 * `problems[].line` is the position in the array the client submitted, so the positions must be the inputs').
 */
export const submissionOf = (details: LegalEntityDetails): LegalEntityDetails => {
  const copy = detailsOf(details)
  copy.address.it = padLines(copy.address.it, addressInputCount(copy.address.it))
  copy.address.en = padLines(copy.address.en, addressInputCount(copy.address.en))
  return copy
}

/** The values of an entity as the form opens on them: the IBAN in groups of four, as the read printed it. */
export const formBase = (entity: LegalEntity): LegalEntityDetails => {
  const details = detailsOf(entity)
  if (entity.ibanPrint !== '') details.iban = entity.ibanPrint
  return details
}

/** An IBAN in groups of four, upper case, no stray spaces. Cosmetic only: applied on blur, never while typing. */
export const groupIban = (raw: string): string => normalizeIban(cleanText(raw)).replace(/(.{4})(?=.)/gu, '$1 ')

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/**
 * A control of the form: `legalName`, `vatNumber`, `iban`, `contacts.it`, `contacts.en`, or `address.it.2` (the
 * third line input of the Italian address).
 */
export type ControlKey = string

export const lineKey = (language: Lang, index: number): ControlKey => `address.${language}.${index}`

/** The DOM id of a control: stable, so the error summary and the refusal focus can find it. */
export const controlDomId = (entity: LegalEntityId, key: ControlKey): string =>
  `admin-legal-${entity}-${key.replaceAll('.', '-')}`

/** The control a problem lands on. An address problem lands on an input that exists (never beyond the last one). */
export const problemControl = (problem: LegalEntityProblem, inputCounts: Record<Lang, number>): ControlKey => {
  const target = addressProblemTarget(problem)
  if (target === null) return problem.field
  return lineKey(target.language, Math.min(target.line, inputCounts[target.language] - 1))
}

export const inputCountsOf = (details: LegalEntityDetails): Record<Lang, number> => ({
  it: addressInputCount(details.address.it),
  en: addressInputCount(details.address.en),
})

// ---------------------------------------------------------------------------
// A refused save (F4)
// ---------------------------------------------------------------------------

/** The sentences of each refused control, from the details that were submitted (their lengths are counted there). */
export const refusalErrors = (
  problems: readonly LegalEntityProblem[],
  submitted: LegalEntityDetails,
): Map<ControlKey, string[]> => {
  const counts = inputCountsOf(submitted)
  const errors = new Map<ControlKey, string[]>()
  for (const problem of problemsInPageOrder(problems)) {
    const key = problemControl(problem, counts)
    const sentence = problemSentence(problem, { values: submitted })
    const list = errors.get(key) ?? []
    if (!list.includes(sentence)) list.push(sentence)
    errors.set(key, list)
  }
  return errors
}

/** The summary's items, in page order: the id is the control's DOM id, the text names the value and the line. */
export const refusalItems = (
  entity: LegalEntityId,
  problems: readonly LegalEntityProblem[],
  submitted: LegalEntityDetails,
): { id: string; text: string }[] => {
  const counts = inputCountsOf(submitted)
  return problemsInPageOrder(problems).map((problem) => ({
    id: controlDomId(entity, problemControl(problem, counts)),
    text: problemSummary(problem, { values: submitted }),
  }))
}

/**
 * The problems left once the person changed `key`: that control's own are gone (their sentences, with the counts in
 * them, would be stale), and so is a `required` of the same address when any of its lines changed (any non-blank
 * line satisfies it). The rest stay until the next save says otherwise.
 */
export const problemsAfterEdit = (
  problems: readonly LegalEntityProblem[],
  key: ControlKey,
  inputCounts: Record<Lang, number>,
): LegalEntityProblem[] =>
  problems.filter((problem) => {
    if (problemControl(problem, inputCounts) === key) return false
    if (problem.reason === 'required' && isAddressField(problem.field)) {
      return !key.startsWith(`${problem.field}.`)
    }
    return true
  })

// ---------------------------------------------------------------------------
// Values the registry holds as moved (S3, F11)
// ---------------------------------------------------------------------------

const isBlank = (text: string): boolean => cleanText(text) === ''

const addressLines = (details: LegalEntityDetails, field: AddressField): readonly string[] =>
  details.address[addressLanguage(field)]

/**
 * The static marks of an entity read from the registry: what is `missing` and what `invalid` holds (a moved value
 * the rules refuse, E6), each on its own control with the sentence it will have after a refusal — plus, for a moved
 * value, nothing the server did not say. A mark holds while the control still holds what was moved (an empty value
 * stays "not filled in" until something is typed): the moment the person changes it the mark is gone, and the next
 * save says what is still wrong. Values are shown exactly as moved; nothing here repairs them.
 */
export const movedMarks = (entity: LegalEntity, shown: LegalEntityDetails): Map<ControlKey, string[]> => {
  const marks = new Map<ControlKey, string[]>()
  const add = (key: ControlKey, sentence: string) => {
    const list = marks.get(key) ?? []
    if (!list.includes(sentence)) list.push(sentence)
    marks.set(key, list)
  }
  const stored = detailsOf(entity)
  const shownCounts = inputCountsOf(shown)

  for (const field of entity.missing) {
    if (isAddressField(field)) {
      if (addressLines(shown, field).every(isBlank)) {
        add(lineKey(addressLanguage(field), 0), notFilledSentence(field))
      }
    } else if (isBlank(getFieldValue(shown, field) as string)) {
      add(field, notFilledSentence(field))
    }
  }

  for (const problem of entity.invalid) {
    const sentence = problemSentence(problem, { values: stored, moved: true })
    if (!isAddressField(problem.field)) {
      if (sameFieldValue(problem.field, getFieldValue(shown, problem.field), getFieldValue(stored, problem.field))) {
        add(problem.field, sentence)
      }
      continue
    }
    const language = addressLanguage(problem.field)
    const storedLines = stored.address[language]
    const shownLines = shown.address[language]
    if (problem.reason === 'too_many_lines') {
      // The inputs beyond the fourth that still hold what was moved.
      for (let index = LIMITS.addressLines; index < storedLines.length; index += 1) {
        if (
          !isBlank(storedLines[index] ?? '') &&
          cleanText(shownLines[index] ?? '') === cleanText(storedLines[index] ?? '')
        ) {
          add(lineKey(language, index), sentence)
        }
      }
      continue
    }
    const index = Math.min(addressProblemTarget(problem)?.line ?? 0, shownCounts[language] - 1)
    if (cleanText(shownLines[index] ?? '') === cleanText(storedLines[index] ?? ''))
      add(lineKey(language, index), sentence)
  }
  return marks
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/** Why Save does nothing right now (its hidden description), or `null` when it will save. */
export const saveBlockedReason = (dirty: boolean, conflict: boolean): string | null =>
  conflict ? strings.legalEntities.bar.reloadFirst : !dirty ? strings.legalEntities.bar.nothingToSave : null
