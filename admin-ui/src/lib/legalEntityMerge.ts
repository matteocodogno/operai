/**
 * legalEntityMerge — "Reapply my changes" after a 409 `version_conflict` (T34, design S2 "Conflict behaviour",
 * owner decision Q3=B; AC-2.6). Pure.
 *
 * The merge is per value, over the seven values, using three snapshots: what the person loaded (`base`), what
 * they typed (`mine`) and what the newer version holds (`theirs`):
 *
 * | base vs mine | base vs theirs | result |
 * | unchanged | unchanged | `same`: the newer version's value |
 * | changed | unchanged | `mine` |
 * | unchanged | changed | `theirs`: taken from the newer version |
 * | changed | changed, and the two differ | `flagged`: mine is kept, theirs is reported with it ("Use theirs") |
 * | changed | changed, and the two agree | `same`: nothing to review, both people typed the same value |
 *
 * "Changed" and "agree" are judged after normalisation (the same rule as the server's no-op, AC-2.1), so a value
 * the person only re-spaced, or an IBAN typed in lower case, is not a change. An address is **one value of up to
 * four lines**: it is never merged line by line, and "Use theirs" replaces all of that language's lines.
 */
import {
  FIELD_PAGE_ORDER,
  LEGAL_ENTITY_FIELDS,
  detailsOf,
  getFieldValue,
  sameFieldValue,
  setFieldValue,
} from './legalEntityModel'
import type { FieldValue, LegalEntityDetails, LegalEntityField } from './legalEntityModel'

export type MergeOutcome = 'same' | 'mine' | 'theirs' | 'flagged'

/** A value both people changed to different things: the person's own is kept, the other is offered. */
export type FlaggedValue = { field: LegalEntityField; theirs: FieldValue }

export type MergeResult = {
  /** The merged form values, ready to put in the form. Fresh arrays: nothing is shared with the inputs. */
  details: LegalEntityDetails
  outcomes: Record<LegalEntityField, MergeOutcome>
  /** The flagged values in page order; the first one takes focus. Empty: focus goes to Save. */
  flagged: FlaggedValue[]
}

const copyValue = (value: FieldValue): FieldValue => (Array.isArray(value) ? [...value] : value)

export const mergeOnConflict = (input: {
  base: LegalEntityDetails
  mine: LegalEntityDetails
  theirs: LegalEntityDetails
}): MergeResult => {
  const { base, mine, theirs } = input
  let merged = detailsOf(theirs)
  const outcomes = {} as Record<LegalEntityField, MergeOutcome>
  const flaggedByField = new Map<LegalEntityField, FlaggedValue>()

  for (const field of LEGAL_ENTITY_FIELDS) {
    const baseValue = getFieldValue(base, field)
    const myValue = getFieldValue(mine, field)
    const theirValue = getFieldValue(theirs, field)
    const iChanged = !sameFieldValue(field, baseValue, myValue)
    const theyChanged = !sameFieldValue(field, baseValue, theirValue)

    if (!iChanged && !theyChanged) {
      outcomes[field] = 'same'
    } else if (!iChanged) {
      outcomes[field] = 'theirs'
    } else if (!theyChanged) {
      outcomes[field] = 'mine'
      merged = setFieldValue(merged, field, copyValue(myValue))
    } else if (sameFieldValue(field, myValue, theirValue)) {
      outcomes[field] = 'same'
    } else {
      outcomes[field] = 'flagged'
      merged = setFieldValue(merged, field, copyValue(myValue))
      flaggedByField.set(field, { field, theirs: copyValue(theirValue) })
    }
  }

  const flagged = FIELD_PAGE_ORDER.flatMap((field) => {
    const entry = flaggedByField.get(field)
    return entry ? [entry] : []
  })
  return { details: merged, outcomes, flagged }
}

/** "Use theirs" on a flagged value: a copy of `details` with that value replaced (all of an address's lines). */
export const takeTheirs = (details: LegalEntityDetails, flagged: FlaggedValue): LegalEntityDetails =>
  setFieldValue(details, flagged.field, copyValue(flagged.theirs))
