import { Banner, Button, Card, Field, formatNumber } from '@operai/ui'
import { useId, useRef, useState } from 'react'
import { errorMessage, fieldErrorsOf, isAuthUnavailable } from '../../lib/errors'
import { saveText } from '../../lib/meetingsApi'
import type { Meeting } from '../../lib/types'
import { strings } from '../../strings'

export type TextCardProps = {
  meeting: Meeting
  /** The server's fresh view after a write, so the page replaces its copy. */
  onChanged: (meeting: Meeting) => void
}

const t = strings.text

/** AC-3.4: at most 200,000 characters. Counted as the server counts them (UTF-16 code units, `String.length`). */
const MAX_CHARACTERS = 200_000

type Failure = { title?: string; message: string }

/**
 * The text card (F7, AC-3.4): a text meeting is typed or pasted instead of recorded, so there is no
 * consent step and no timestamps. The count is live; over the limit the field says so at once and Save
 * refuses, the same way an empty text is refused. Saving moves the meeting to `ready`.
 */
export default function TextCard({ meeting, onChanged }: TextCardProps) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  // Shown only after Save was tried on a blank text: a field nobody has touched yet is not an error.
  const [blank, setBlank] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const countId = useId()

  if (!meeting.can.capture) return null

  const tooLong = value.length > MAX_CHARACTERS
  const fieldError = tooLong ? t.errors.tooLong(formatNumber(MAX_CHARACTERS)) : blank ? t.errors.empty : serverError

  const save = async () => {
    if (busy) return
    if (value.trim() === '') {
      setBlank(true)
      area.current?.focus()
      return
    }
    if (tooLong) {
      area.current?.focus()
      return
    }
    setBusy(true)
    setFailure(null)
    setServerError(null)
    try {
      onChanged(await saveText(meeting.id, value))
    } catch (error) {
      const own = fieldErrorsOf(error).find((entry) => entry.field === 'text')
      if (own) setServerError(own.message)
      else {
        setFailure(
          isAuthUnavailable(error)
            ? { title: strings.common.authUnavailable.heading, message: strings.common.authUnavailable.body }
            : { message: errorMessage(error) },
        )
      }
      setBusy(false)
    }
  }

  return (
    <Card title={t.title} data-testid="meetings-text-card">
      <Field label={t.label} hint={t.hint} error={fieldError} errorRole="alert" testId="meetings-text-field">
        {(control) => (
          <textarea
            {...control}
            ref={area}
            aria-describedby={[control['aria-describedby'], countId].filter(Boolean).join(' ')}
            rows={14}
            className="w-full"
            value={value}
            readOnly={busy}
            onChange={(event) => {
              setValue(event.target.value)
              setBlank(false)
              setServerError(null)
            }}
            data-testid="meetings-text-input"
          />
        )}
      </Field>
      <p id={countId} className="mt-1 text-xs text-soft" data-testid="meetings-text-count">
        {t.count(formatNumber(value.length), formatNumber(MAX_CHARACTERS))}
      </p>

      {failure && (
        <div className="mt-3">
          <Banner tone="danger" title={failure.title} data-testid="meetings-text-error">
            {failure.message}
          </Banner>
        </div>
      )}

      <div className="mt-4">
        <Button variant="primary" busy={busy} onClick={() => void save()} data-testid="meetings-text-save">
          {busy ? t.saving : t.save}
        </Button>
      </div>
    </Card>
  )
}
