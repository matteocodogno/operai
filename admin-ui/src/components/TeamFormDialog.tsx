/**
 * TeamFormDialog — the one dialog that creates and edits a team (specs/20261126-teams, design S2, T4; T5 mounts it
 * in `edit` mode). A library `FormDialog` (focus, Escape = Cancel, never dismissed while busy) with two fields:
 * Name (required, 1 to 80 characters) and Description (optional, up to 500).
 *
 * Presentational, like `CreateDepartmentModal`: the page owns the request and its outcome.
 *   • `busy`, `error` (anything not about one field: a failed save, a stale form) and `submitBlocked` (the form is
 *     known to be stale: Save stays disabled, the typed values stay on screen) come from the page.
 *   • `existingName` is the structured field of a 409 `team_name_taken`. The message is composed HERE, from the
 *     catalog, in the reader's language (AC-3.3), and goes on the Name field: the clash is about one field. The
 *     server's English `detail` is never shown. A 409 without the name is the page's generic failure in `error`.
 *     The name is plain text (React escapes it), and is the stored one, which may differ in case from the typed one.
 *
 * Validation runs on submit (and on blur of a name typed then cleared), never by `maxLength`: truncating a paste
 * silently is worse than saying so. The first invalid field takes focus. Values are trimmed; a blank description is
 * sent as an empty string, and the page decides what that means (create omits it, edit sends null).
 *
 * Mount it beside the page's content, never inside a `<form>` (ADR 20261118): `FormDialog` renders its own.
 */

import { useEffect, useRef, useState } from 'react'
import { Field, FormDialog } from '@operai/ui'
import { strings } from '../strings'

const NAME_MAX = 80
const DESCRIPTION_MAX = 500

const t = strings.teams

export type TeamFormValues = { name: string; description: string }

export type TeamFormDialogProps = {
  mode: 'create' | 'edit'
  /** The team being edited (`edit` only). A null description opens as an empty field. */
  initial?: { name: string; description: string | null }
  busy: boolean
  /** A failure that is not about one field; null = none. */
  error: string | null
  /** The clashing team's name from a 409 `team_name_taken`; null = no clash. Set it back to null when a submit starts. */
  existingName: string | null
  /** True while the form is known to be stale: Save is disabled, Cancel still works. */
  submitBlocked?: boolean
  /** Called with the trimmed values once validation passes. */
  onSubmit: (values: TeamFormValues) => void
  onCancel: () => void
}

export default function TeamFormDialog({
  mode,
  initial,
  busy,
  error,
  existingName,
  submitBlocked = false,
  onSubmit,
  onCancel,
}: TeamFormDialogProps) {
  const prefix = `${mode}-team`
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [typedName, setTypedName] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [descriptionError, setDescriptionError] = useState<string | null>(null)
  // The clash belongs to the text it was raised for: typing clears it, a new answer from the page raises it again.
  const [clash, setClash] = useState(existingName)
  const [seenClash, setSeenClash] = useState(existingName)
  if (existingName !== seenClash) {
    setSeenClash(existingName)
    setClash(existingName)
  }
  const nameRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (existingName) nameRef.current?.focus()
  }, [existingName])

  const handleSubmit = () => {
    const trimmedName = name.trim()
    const trimmedDescription = description.trim()
    const nextNameError =
      trimmedName === '' ? strings.common.nameRequired : trimmedName.length > NAME_MAX ? t.form.nameTooLong : null
    const nextDescriptionError = trimmedDescription.length > DESCRIPTION_MAX ? t.form.descriptionTooLong : null
    setNameError(nextNameError)
    setDescriptionError(nextDescriptionError)
    if (nextNameError) {
      nameRef.current?.focus()
      return
    }
    if (nextDescriptionError) {
      descriptionRef.current?.focus()
      return
    }
    onSubmit({ name: trimmedName, description: trimmedDescription })
  }

  const shownNameError = nameError ?? (clash ? t.form.nameTaken(clash) : null)

  return (
    <FormDialog
      title={mode === 'create' ? t.form.createTitle : t.form.editTitle}
      size="sm"
      submitLabel={mode === 'create' ? strings.common.actions.create : strings.common.actions.save}
      busyLabel={mode === 'create' ? strings.common.actions.creating : strings.common.actions.saving}
      cancelLabel={strings.common.actions.cancel}
      closeLabel={strings.common.actions.cancel}
      busy={busy}
      canSubmit={!submitBlocked}
      error={error}
      onSubmit={handleSubmit}
      onCancel={onCancel}
      testIdPrefix={prefix}
      backdropTestId={`${prefix}-dialog`}
    >
      <Field
        label={strings.common.fields.name}
        hint={t.form.nameHint}
        required
        error={shownNameError}
        errorTestId={`${prefix}-name-error`}
        errorRole="alert"
      >
        {(control) => (
          <input
            {...control}
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => {
              setTypedName(true)
              setNameError(null)
              setClash(null)
              setName(e.target.value)
            }}
            onBlur={() => {
              if (typedName && name.trim() === '') setNameError(strings.common.nameRequired)
            }}
            data-testid={`${prefix}-name-input`}
          />
        )}
      </Field>

      <Field
        label={strings.common.fields.description}
        hint={t.form.descriptionHint}
        error={descriptionError}
        errorTestId={`${prefix}-description-error`}
        errorRole="alert"
      >
        {(control) => (
          <textarea
            {...control}
            ref={descriptionRef}
            value={description}
            rows={3}
            onChange={(e) => {
              setDescriptionError(null)
              setDescription(e.target.value)
            }}
            data-testid={`${prefix}-description-input`}
          />
        )}
      </Field>
    </FormDialog>
  )
}
