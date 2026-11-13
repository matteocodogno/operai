import { useEffect, useRef, useState } from 'react'
import { Field, FormDialog } from '@operai/ui'
import { strings } from '../strings'
import type { TimeListRow, TimeListScope } from './TimeListCard'

const t = strings.timeLists

/**
 * The longest a name may be, in Unicode code points after trimming (plan.md § Lists, amended
 * 2026-11-13): hours-api counts the same way, so 80 emoji pass and 81 do not. Never `.length`, which
 * counts UTF-16 units and would refuse 41 emoji.
 */
export const NAME_MAX_CODE_POINTS = 80

/** What the form sends: the trimmed name, and the note flag for a category only. */
export type TimeListItemValues = { name: string; requiresNote?: boolean }

/**
 * How the page's request failed, as far as the form is concerned. `name_taken` is the Name field's
 * error; the others are one line above the buttons. (A 404 is the page's: it closes the form.)
 */
export type TimeListItemFailure = 'name_taken' | 'forbidden' | 'authz' | 'other'

export type TimeListItemDialogProps = {
  scope: TimeListScope
  /** The item being renamed; absent for an Add. */
  item?: TimeListRow
  /**
   * Sends the request. Resolves `null` when it worked — the page then closes the dialog, so the form
   * stays busy until it is gone — or the failure, which keeps the dialog open with every value.
   */
  onSubmit: (values: TimeListItemValues) => Promise<TimeListItemFailure | null>
  onCancel: () => void
}

const nameProblem = (value: string): string | null => {
  const name = value.trim()
  if (name === '') return strings.common.nameRequired
  if ([...name].length > NAME_MAX_CODE_POINTS) return t.dialog.nameTooLong
  // Postgres text cannot hold a NUL; hours-api answers 400 for one, so say so here, on the field.
  if (name.includes('\u0000')) return t.dialog.nameNullCharacter
  return null
}

/**
 * TimeListItemDialog — Add or Rename one category or work type (T32, specs/029-time-tracking,
 * design.md S5). A `FormDialog`: focus starts in Name, Enter submits, a failed request keeps it open
 * with every value, and while it saves it cannot be dismissed.
 *
 * The page owns the request and what follows a success; this owns the form: the Name check (empty,
 * over 80 code points after trimming, no NUL), the "Entries in this category need a note" checkbox
 * of a category, and how each failure reads — a duplicate name on the field (`aria-invalid`, focus
 * back in Name), anything else as one alert line (the page's own words for 403 and 503).
 *
 * The name is data: shown exactly as typed, in both languages (AC-3.8).
 */
export default function TimeListItemDialog({ scope, item, onSubmit, onCancel }: TimeListItemDialogProps) {
  const renaming = item !== undefined
  const isCategory = scope === 'categories'

  const [name, setName] = useState(item?.name ?? '')
  const [requiresNote, setRequiresNote] = useState(item?.requiresNote ?? false)
  const [typed, setTyped] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // A refused submit moves focus back to Name. Counted rather than derived from the error: a blur
  // error must not pull focus back into the field the person is leaving.
  const nameRef = useRef<HTMLInputElement>(null)
  const [focusNameRequests, setFocusNameRequests] = useState(0)
  useEffect(() => {
    if (focusNameRequests > 0) nameRef.current?.focus()
  }, [focusNameRequests])

  const handleSubmit = async () => {
    const problem = nameProblem(name)
    if (problem) {
      setNameError(problem)
      setFocusNameRequests((count) => count + 1)
      return
    }
    setNameError(null)
    setFormError(null)
    setSubmitting(true)

    const trimmed = name.trim()
    const failure = await onSubmit(isCategory ? { name: trimmed, requiresNote } : { name: trimmed })
    if (failure === null) return

    setSubmitting(false)
    if (failure === 'name_taken') {
      setNameError(isCategory ? t.dialog.nameTaken.category : t.dialog.nameTaken.workType)
      setFocusNameRequests((count) => count + 1)
    } else if (failure === 'forbidden') {
      setFormError(t.dialog.forbidden)
    } else if (failure === 'authz') {
      setFormError(t.dialog.authzUnavailable)
    } else {
      setFormError(t.failed)
    }
  }

  return (
    <FormDialog
      title={renaming ? t.dialog.renameTitle[scope] : t.dialog.addTitle[scope]}
      size="md"
      submitLabel={renaming ? strings.common.actions.save : strings.common.actions.add}
      busyLabel={renaming ? strings.common.actions.saving : strings.common.actions.adding}
      cancelLabel={strings.common.actions.cancel}
      closeLabel={strings.common.actions.cancel}
      busy={submitting}
      error={formError}
      onSubmit={handleSubmit}
      onCancel={onCancel}
      testIdPrefix="time-lists-dialog"
    >
      <Field
        label={strings.common.fields.name}
        hint={t.dialog.nameHint}
        required
        error={nameError}
        errorRole="alert"
        errorTestId="time-lists-dialog-name-error"
      >
        {(control) => (
          <input
            {...control}
            ref={nameRef}
            type="text"
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setTyped(true)
              setNameError(null)
              setName(event.target.value)
            }}
            onBlur={() => {
              if (typed) setNameError(nameProblem(name))
            }}
            data-testid="time-lists-dialog-name"
          />
        )}
      </Field>

      {isCategory && (
        <label className="flex items-start gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={requiresNote}
            onChange={(event) => setRequiresNote(event.target.checked)}
            data-testid="time-lists-dialog-requires-note"
          />
          <span>{t.dialog.requiresNote}</span>
        </label>
      )}
    </FormDialog>
  )
}
