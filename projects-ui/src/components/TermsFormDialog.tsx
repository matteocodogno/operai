import { useRef, useState } from 'react'
import { DateInput, Field, FormDialog, focusFirstInvalid, formatNumber } from '@operai/ui'
import { ApiError, isStaleWrite } from '../lib/api'
import { errorMessage, fieldErrorOf, termsRefusalOf } from '../lib/errors'
import { termsErrorKeysChanged, withoutErrors } from '../lib/fieldErrors'
import { createTerms, updateTerms } from '../lib/projectsApi'
import { emptyTermsForm, termsFormOf } from '../lib/terms'
import type { TermsErrors, TermsForm } from '../lib/terms'
import { termsFieldKey, termsRequestOf } from '../lib/termsRequest'
import type { Project, Terms } from '../lib/types'
import { strings } from '../strings'
import TermsFields from './TermsFields'

type ProjectRef = Pick<Project, 'id' | 'type' | 'purchaseOrder'>

/**
 * TermsFormDialog — add the terms of a hand-made project, or edit the terms of any project (specs/021
 * AC-2.1 – AC-2.8; specs/022 AC-1.8, AC-5.3, AC-5.4). The terms' type is the project's (never
 * chosen), and the fields are that type's: fixed price (deadline, estimated man-days, max effort),
 * maintenance and SaaS (an optional SLA, prefilled 1 / 3, and an optional hour package; maintenance
 * terms need one of the two), time and material (1 to 50 positions). A SaaS's company is the
 * project's, fixed when it was made. No amount, price or rate exists in the form (specs/021 AC-2.9).
 *
 * Errors are keyed by the server's dotted field names (lib/terms.ts), so a check made here and a
 * 400/422 from the server land on the same input. Editing sends the dates and the whole set of
 * members with the terms' `version` as If-Match; a stale save closes the dialog and is the
 * page's (`onStale`). Terms the deal's estimate backs show their man-days read-only and never send them.
 */
export default function TermsFormDialog({
  project,
  terms,
  onSaved,
  onCancel,
  onStale,
}: {
  project: ProjectRef
  terms?: Terms
  onSaved: (terms: Terms) => void
  onCancel: () => void
  onStale: () => void
}) {
  const t = strings.terms.form
  const editing = terms !== undefined
  const type = terms?.type ?? project.type
  const initialTerms = terms ? termsFormOf(terms) : emptyTermsForm(type)

  const [startDate, setStartDate] = useState(terms?.startDate ?? '')
  const [endDate, setEndDate] = useState(terms?.endDate ?? '')
  const [form, setForm] = useState<TermsForm>(initialTerms)
  const [errors, setErrors] = useState<TermsErrors>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldsRef = useRef<HTMLDivElement>(null)
  const [initial] = useState(() => JSON.stringify([terms?.startDate ?? '', terms?.endDate ?? '', initialTerms]))

  const dirty = JSON.stringify([startDate, endDate, form]) !== initial
  // Terms of a purchase order whose deal has an estimate take their man-days from it: shown read-only, never sent (AC-3.1).
  const estimateBacked = project.purchaseOrder?.estimate != null && type === 'fixed_price'
  const storedEstimate = terms?.type === 'fixed_price' ? terms.terms.estimatedManDays : null
  const lockedManDays =
    storedEstimate !== null
      ? t.estimatedFromEstimate(formatNumber(storedEstimate, { maximumFractionDigits: 1 }))
      : t.estimatedFromEstimateNone

  // An error is about the value it was raised on: when that value changes, the message goes (AC-7.1). The
  // next submit checks everything again.
  const clearErrors = (...fields: string[]) => setErrors((current) => withoutErrors(current, ...fields))
  const patchForm = (patch: Partial<TermsForm>) => {
    const next = { ...form, ...patch }
    setForm(next)
    clearErrors(...termsErrorKeysChanged(form, next))
  }

  const submit = () => {
    const checked = termsRequestOf(type, { startDate, endDate, terms: form }, { estimateBacked })
    setErrors(checked.errors)
    if (Object.keys(checked.errors).length > 0) {
      requestAnimationFrame(() => focusFirstInvalid(fieldsRef.current))
      return
    }
    setBusy(true)
    setError(null)
    const request = terms
      ? // Editing always says what the end date is: empty reopens ended terms.
        updateTerms(project.id, terms.version, { ...checked.input, endDate: endDate === '' ? null : endDate })
      : createTerms(project.id, checked.input)
    request.then(onSaved, (failure: unknown) => {
      setBusy(false)
      if (isStaleWrite(failure)) return onStale()
      const refusal = termsRefusalOf(failure)
      if (refusal === 'maintenance_needs_sla_or_hours') {
        return setErrors({ terms: strings.terms.refusals[refusal] })
      }
      if (refusal) return setError(strings.terms.refusals[refusal])
      if (failure instanceof ApiError && failure.status === 503) {
        return setError(`${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`)
      }
      const named = fieldErrorOf(failure)
      const key = named ? termsFieldKey(named.field, 'terms-route') : null
      if (named && key) return setErrors({ [key]: named.message })
      setError(errorMessage(failure))
    })
  }

  const dateField = (
    name: 'startDate' | 'endDate',
    label: string,
    value: string,
    onChange: (value: string) => void,
    hint?: string,
    required = false,
  ) => (
    <Field label={label} hint={hint} required={required} error={errors[name]} testId={`terms-form-${name}`}>
      {(control) => <DateInput {...control} value={value} onChange={(event) => onChange(event.target.value)} />}
    </Field>
  )

  return (
    <FormDialog
      title={editing ? t.editTitle : t.createTitle}
      submitLabel={editing ? t.save : t.create}
      busyLabel={editing ? t.saving : t.creating}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      canSubmit={!editing || dirty}
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
      size="lg"
      testIdPrefix="terms-form"
    >
      <div ref={fieldsRef} className="contents">
        {dateField(
          'startDate',
          t.startDate,
          startDate,
          (value) => {
            setStartDate(value)
            // An end before the start is raised on the end date, and a new start may settle it.
            clearErrors('startDate', 'endDate')
          },
          type === 'saas' ? t.saasPeriodHint : undefined,
          true,
        )}
        {dateField(
          'endDate',
          t.endDate,
          endDate,
          (value) => {
            setEndDate(value)
            clearErrors('endDate')
          },
          t.endDateHint,
        )}

        <TermsFields
          type={type}
          terms={form}
          errors={errors}
          onChange={patchForm}
          estimatedManDaysReadOnly={estimateBacked ? lockedManDays : undefined}
          testIdPrefix="terms-form"
        />
      </div>
    </FormDialog>
  )
}
