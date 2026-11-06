import { DateTimeInput, Field, FormDialog, RadioGroupField, focusFirstInvalid } from '@operai/ui'
import { useRef, useState } from 'react'
import { codeOf, errorMessage, fieldErrorsOf } from '../../lib/errors'
import { getMeeting, updateMeeting } from '../../lib/meetingsApi'
import type { MeetingPatch } from '../../lib/meetingsApi'
import type { Meeting, MeetingFormat, MeetingLanguage, MeetingSource } from '../../lib/types'
import { strings } from '../../strings'

export type EditDetailsDialogProps = {
  meeting: Meeting
  onClose: () => void
  onChanged: (meeting: Meeting) => void
}

const TITLE_MAX = 200

const pad = (value: number) => String(value).padStart(2, '0')

/** An ISO instant as the `datetime-local` value it is edited in (the viewer's own time zone). */
function toLocalInput(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A `datetime-local` value as an ISO instant, or null when it is not a date. */
function fromLocalInput(value: string): string | null {
  if (value === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const LOCKED_CODES = new Set(['language_locked', 'source_locked'])

/**
 * EditDetailsDialog — title, date and time, format, language, source and Remove link in one `FormDialog` (S3c, F7b). Which of them can change is the SERVER's call, read
 * from the meeting's `can` flags: the language is a control only while `can.changeLanguage`
 * (AC-1.8), the source only while `can.changeSource` (plan G1) and Remove link only while `can.link`.
 * Host visibility is deliberately NOT here: it lives only in the People and access card (design S3/F13). Locked
 * fields read as plain text with the reason. Only what changed is sent (`PATCH`); a refusal
 * because the state moved on (`409 language_locked | source_locked`) shows inline and reloads the
 * meeting so the field locks. Linking and re-linking happen from the host's panel, not here.
 */
export default function EditDetailsDialog({ meeting, onClose, onChanged }: EditDetailsDialogProps) {
  const t = strings.editDetails
  const { can } = meeting
  const initialStart = toLocalInput(meeting.startsAt)

  const [title, setTitle] = useState(meeting.title)
  const [startsAt, setStartsAt] = useState(initialStart)
  const [format, setFormat] = useState<MeetingFormat>(meeting.format)
  const [language, setLanguage] = useState<MeetingLanguage>(meeting.language)
  const [source, setSource] = useState<MeetingSource>(meeting.source)
  const [removeLink, setRemoveLink] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fieldsRef = useRef<HTMLDivElement>(null)

  const host = meeting.host
  const canRemoveLink = host !== null && can.link

  const failWith = (errors: Record<string, string>, message: string | null) => {
    setFieldErrors(errors)
    setFormError(message)
    requestAnimationFrame(() => focusFirstInvalid(fieldsRef.current))
  }

  const submit = async () => {
    const errors: Record<string, string> = {}
    const trimmed = title.trim()
    if (trimmed === '') errors['title'] = t.errors.titleRequired
    else if (trimmed.length > TITLE_MAX) errors['title'] = t.errors.titleTooLong
    const startsAtIso = fromLocalInput(startsAt)
    if (startsAtIso === null) errors['startsAt'] = t.errors.startsAtInvalid
    if (Object.keys(errors).length > 0) {
      failWith(errors, null)
      return
    }

    const patch: MeetingPatch = {}
    if (trimmed !== meeting.title) patch.title = trimmed
    // Compared as the input's own text, so an untouched value (seconds and all) is never re-sent.
    if (startsAt !== initialStart && startsAtIso !== null) patch.startsAt = startsAtIso
    if (format !== meeting.format) patch.format = format
    if (can.changeLanguage && language !== meeting.language) patch.language = language
    if (can.changeSource && source !== meeting.source) patch.source = source
    if (removeLink && canRemoveLink) patch.host = null

    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }

    setBusy(true)
    setFieldErrors({})
    setFormError(null)
    try {
      onChanged(await updateMeeting(meeting.id, patch))
      onClose()
    } catch (failure) {
      const named = fieldErrorsOf(failure)
      if (named.length > 0) {
        failWith(Object.fromEntries(named.map((entry) => [entry.field, entry.message])), null)
      } else {
        failWith({}, errorMessage(failure))
        const code = codeOf(failure)
        if (code !== null && LOCKED_CODES.has(code)) {
          // The state moved on while the dialog was open: read it again so the field locks.
          try {
            onChanged(await getMeeting(meeting.id))
          } catch {
            // The message above already says what happened; the page's next read catches up.
          }
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormDialog
      title={t.title}
      size="md"
      submitLabel={t.submit}
      busyLabel={t.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      error={formError}
      onSubmit={() => void submit()}
      onCancel={onClose}
      testIdPrefix="meetings-edit-details"
    >
      <div ref={fieldsRef} className="flex flex-col gap-4">
        <Field label={t.fields.title} error={fieldErrors['title']} required>
          {(control) => (
            <input {...control} type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
          )}
        </Field>

        <Field label={t.fields.startsAt} error={fieldErrors['startsAt']} required>
          {(control) => (
            <DateTimeInput {...control} value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
          )}
        </Field>

        <Field label={t.fields.format} error={fieldErrors['format']}>
          {(control) => (
            <select {...control} value={format} onChange={(event) => setFormat(event.target.value as MeetingFormat)}>
              <option value="in_person">{strings.meeting.format.in_person}</option>
              <option value="online">{strings.meeting.format.online}</option>
            </select>
          )}
        </Field>

        {can.changeLanguage ? (
          <Field label={t.fields.language} error={fieldErrors['language']}>
            {(control) => (
              <select
                {...control}
                value={language}
                onChange={(event) => setLanguage(event.target.value as MeetingLanguage)}
              >
                <option value="en">{strings.meeting.language.en}</option>
                <option value="it">{strings.meeting.language.it}</option>
              </select>
            )}
          </Field>
        ) : (
          <div>
            <p className="field-label">{t.fields.language}</p>
            <p className="text-sm">{strings.meeting.language[meeting.language]}</p>
            <p className="field-hint">{t.languageFixed}</p>
          </div>
        )}

        {can.changeSource ? (
          <RadioGroupField label={t.fields.source} error={fieldErrors['source']}>
            {(['recorded', 'uploaded', 'text'] as const).map((option) => (
              <label key={option} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="meetings-edit-details-source"
                  value={option}
                  checked={source === option}
                  onChange={() => setSource(option)}
                />
                {t.sourceOptions[option]}
              </label>
            ))}
            {source === 'text' && meeting.source !== 'text' && meeting.consent !== null && (
              <p className="field-hint">{t.textClearsConsent}</p>
            )}
            {source !== 'text' && meeting.source === 'text' && <p className="field-hint">{t.consentAskedAgain}</p>}
          </RadioGroupField>
        ) : (
          <div>
            <p className="field-label">{t.fields.source}</p>
            <p className="text-sm">{strings.meeting.source[meeting.source]}</p>
            <p className="field-hint">{t.sourceFixed}</p>
          </div>
        )}

        {canRemoveLink && (
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={removeLink} onChange={(event) => setRemoveLink(event.target.checked)} />
              {t.removeLink}
            </label>
            <p className="field-hint">{t.removeLinkHint}</p>
          </div>
        )}
      </div>
    </FormDialog>
  )
}
