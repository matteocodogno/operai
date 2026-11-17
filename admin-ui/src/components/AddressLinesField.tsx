/**
 * AddressLinesField — one address, one language, as single-line inputs (T37, owner decision Q2=B, design S2
 * "Address", hotspot "Address lines").
 *
 * A `fieldset` whose legend is the value's name ("Address (Italian)", marked required) holds four inputs
 * "Line 1" to "Line 4", each in a `Field`; a moved address of more than four lines shows one input per stored line
 * (D3), the extra ones marked in place by their own error. Line 1 is the required one (`aria-required`, `*`). The
 * shared hint describes every input; each input's own errors (the static "kept as moved" sentence, or the refusal's)
 * are its `Field` error, so the control is `aria-invalid` and described by the same sentence the summary shows.
 * "n / 120" beside a label is display only: aria-hidden (the limit is in the hint), not live, never blocking, and
 * counted the way the server judges (trimmed, in code points) so it can never disagree with a refusal's sentence.
 * The language of the typed text is on each input (`lang`, which also drives spell checking), not on the legend or
 * labels, which are in the language of the page.
 *
 * A **note** slot sits under the shared hint (FU-7): the conflict's "Also changed in version n by …", the moved
 * address's "moved with n lines" hint, or both. It is listed in every line's `aria-describedby`, so the focused
 * line reads it. What is not words to read (the "Use theirs" button) goes in `noteAction`, after the note and
 * outside the description. `noteId` lets the caller point the action's own description at the note.
 *
 * There is no add or remove control: the input count changes only when the entity is loaded or saved.
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { Field, Icon } from '@operai/ui'
import { addressInputCount, padLines } from './LegalEntityFormModel'
import { LIMITS, cleanText, codePointLength } from '../lib/legalEntityModel'
import { strings } from '../strings'

const t = strings.legalEntities

export type AddressLinesFieldProps = {
  language: 'it' | 'en'
  /** The legend: the value's name in words ("Address (Italian)"). */
  legend: string
  /** The lines as typed, blanks included. Fewer than the inputs is fine: the rest are empty. */
  lines: readonly string[]
  /** The sentences of each input (0-based), when it carries any. */
  errors: ReadonlyMap<number, readonly string[]>
  /** The DOM id of the input at `index`. */
  idFor: (index: number) => string
  /** Every line, padded to the number of inputs, with the typed one replaced; `index` is the input that changed. */
  onChange: (lines: string[], index: number) => void
  testIdPrefix: string
  /** Words under the shared hint, described by every line. */
  note?: ReactNode
  /** The id of the note's element, when the caller needs to refer to it. */
  noteId?: string
  /** A control that goes with the note: shown after it, not part of the description. */
  noteAction?: ReactNode
}

export default function AddressLinesField({
  language,
  legend,
  lines,
  errors,
  idFor,
  onChange,
  testIdPrefix,
  note,
  noteId,
  noteAction,
}: AddressLinesFieldProps) {
  const hintId = useId()
  const ownNoteId = useId()
  const noteElementId = noteId ?? ownNoteId
  const hasNote = note !== undefined && note !== null && note !== false
  const count = addressInputCount(lines)
  const padded = padLines(lines, count)

  return (
    <fieldset className="m-0 min-w-0 border-0 p-0" data-testid={`${testIdPrefix}-${language}`}>
      <legend className="field-label mb-2 p-0">
        {legend}
        <span aria-hidden="true" className="field-required">
          *
        </span>
      </legend>
      <div className="flex flex-col gap-3">
        {padded.map((line, index) => {
          const own = errors.get(index) ?? []
          const length = codePointLength(cleanText(line))
          return (
            <Field
              key={index}
              id={idFor(index)}
              label={
                <span className="flex items-baseline justify-between gap-2">
                  <span>
                    {t.address.line(index + 1)}
                    {index === 0 && (
                      <span aria-hidden="true" className="field-required">
                        *
                      </span>
                    )}
                  </span>
                  <span aria-hidden="true" className={own.length > 0 ? 'tabular-nums text-red-text' : 'tabular-nums'}>
                    {t.address.count(length, LIMITS.addressLine)}
                  </span>
                </span>
              }
              error={
                own.length > 0 && (
                  <>
                    {own.map((sentence) => (
                      <span key={sentence} className="flex items-start gap-1">
                        <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                        {sentence}
                      </span>
                    ))}
                  </>
                )
              }
            >
              {(control) => (
                <input
                  {...control}
                  type="text"
                  lang={language}
                  spellCheck
                  autoComplete="off"
                  aria-required={index === 0 ? true : undefined}
                  aria-describedby={[control['aria-describedby'], hintId, hasNote ? noteElementId : undefined].filter(Boolean).join(' ')}
                  className="scroll-mb-28"
                  value={line}
                  onChange={(event) => {
                    const next = [...padded]
                    next[index] = event.target.value
                    onChange(next, index)
                  }}
                  data-testid={`${testIdPrefix}-${language}-${index}`}
                />
              )}
            </Field>
          )
        })}
      </div>
      <p id={hintId} className="field-hint mt-2">
        {t.address.hint}
      </p>
      {(hasNote || noteAction) && (
        <p className="field-hint mt-1" data-testid={`${testIdPrefix}-${language}-note`}>
          {hasNote && <span id={noteElementId}>{note}</span>}
          {hasNote && noteAction ? ' ' : null}
          {noteAction}
        </p>
      )}
    </fieldset>
  )
}
