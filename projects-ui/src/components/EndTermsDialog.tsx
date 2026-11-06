import { useState } from 'react'
import { DateInput, Field, FormDialog } from '@operai/ui'
import { isStaleWrite } from '../lib/api'
import { errorMessage, fieldErrorOf } from '../lib/errors'
import { updateTerms } from '../lib/projectsApi'
import type { Terms } from '../lib/types'
import { strings } from '../strings'

/** Today as `YYYY-MM-DD` in the person's own calendar (never shifted through UTC). */
const today = (): string => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * EndTermsDialog — ending terms is setting their end date (specs/021 AC-2.10); the terms stay on the
 * project. Sends only `endDate` with the terms' `version` as If-Match; a stale save closes the dialog
 * and is the page's (`onStale`).
 */
export default function EndTermsDialog({
  projectId,
  terms,
  onEnded,
  onCancel,
  onStale,
}: {
  projectId: string
  terms: Terms
  onEnded: (next: Terms) => void
  onCancel: () => void
  onStale: () => void
}) {
  const t = strings.terms.endDialog
  const [endDate, setEndDate] = useState(() => {
    const now = today()
    return now < terms.startDate ? terms.startDate : now
  })
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const found =
      endDate === ''
        ? strings.common.validation.required
        : endDate < terms.startDate
          ? strings.terms.errors.endBeforeStart
          : null
    setFieldError(found)
    if (found) return
    setBusy(true)
    setError(null)
    updateTerms(projectId, terms.version, { endDate }).then(onEnded, (failure: unknown) => {
      setBusy(false)
      if (isStaleWrite(failure)) return onStale()
      const named = fieldErrorOf(failure)
      if (named?.field === 'endDate') return setFieldError(named.message)
      setError(errorMessage(failure))
    })
  }

  return (
    <FormDialog
      title={t.title}
      description={t.description}
      submitLabel={t.submit}
      busyLabel={t.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
      testIdPrefix="terms-end"
    >
      <Field label={t.date} required error={fieldError} testId="terms-end-date">
        {(control) => (
          <DateInput
            {...control}
            value={endDate}
            onChange={(event) => {
              setEndDate(event.target.value)
              // The message is about the date it was raised on: a new date ends it, right or not (AC-7.1).
              setFieldError(null)
            }}
          />
        )}
      </Field>
    </FormDialog>
  )
}
