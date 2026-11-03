import { useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Combobox, Field } from '@operai/ui'
import type { ComboboxOption } from '@operai/ui'
import { ApiError } from '../lib/api'
import { listDirectory } from '../lib/projectsApi'
import type { DirectoryUser } from '../lib/types'
import { strings } from '../strings'

export type PersonChoice = { id: string; label: string }

type Outcome = { ok: true; users: DirectoryUser[] } | { ok: false; error: unknown }

const toOption = (user: DirectoryUser): ComboboxOption => ({
  id: user.id,
  label: user.name ?? strings.people.picker.noName,
  secondaryLabel: user.email,
})

const failureText = (error: unknown): string =>
  error instanceof ApiError && error.status === 429 && error.retryAfterSeconds !== null
    ? strings.people.picker.rateLimited(error.retryAfterSeconds)
    : strings.people.picker.failed

/**
 * PersonPicker — choose an Operai user who holds access to the Projects module
 * (`auth`'s directory filtered by `appId=projects`, ADR-0053, ADR-0055): a
 * project manager (AC-1.6) or a filter on one. The list is fetched once and
 * filtered client-side by name or email.
 *
 * The directory is open to `project:manage` holders only. A caller it refuses
 * (403) cannot pick someone else: `whenForbidden` renders in place of the picker
 * (the list filter offers "Only my projects"); without it the field shows the
 * current choice read-only, with `forbiddenHint`.
 */
export default function PersonPicker({
  label,
  hint,
  value,
  onChange,
  error,
  required = false,
  testId,
  forbiddenHint,
  whenForbidden,
}: {
  label: string
  hint?: string
  value: PersonChoice | null
  onChange: (value: PersonChoice | null) => void
  error?: string | null
  required?: boolean
  testId: string
  forbiddenHint?: string
  whenForbidden?: ReactNode
}) {
  const id = useId()
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [text, setText] = useState(value?.label ?? '')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    listDirectory({ signal: controller.signal }).then(
      ({ users }) => {
        if (!controller.signal.aborted) setOutcome({ ok: true, users })
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setOutcome({ ok: false, error: failure })
      },
    )
    return () => controller.abort()
  }, [])

  const options = useMemo(() => {
    if (outcome === null || !outcome.ok) return []
    // The chosen person's own name is not a search: focusing a filled field lists everyone again.
    const needle = value !== null && text === value.label ? '' : text.trim().toLowerCase()
    return outcome.users
      .filter((user) => !needle || `${user.name ?? ''} ${user.email}`.toLowerCase().includes(needle))
      .slice(0, 20)
      .map(toOption)
  }, [outcome, text, value])

  const forbidden = outcome !== null && !outcome.ok && outcome.error instanceof ApiError && outcome.error.status === 403

  if (forbidden && whenForbidden !== undefined) return <>{whenForbidden}</>
  if (forbidden) {
    return (
      <Field label={label} hint={forbiddenHint} testId={testId}>
        {(control) => <input {...control} value={value?.label ?? ''} readOnly data-testid={`${testId}-readonly`} />}
      </Field>
    )
  }

  const emptyState =
    outcome === null
      ? strings.people.picker.loading
      : !outcome.ok
        ? failureText(outcome.error)
        : strings.people.picker.noMatch

  return (
    <Field label={label} hint={hint} error={error} required={required} id={id} testId={testId}>
      {(control) => (
        <Combobox
          id={control.id}
          ariaInvalid={control['aria-invalid']}
          ariaDescribedBy={control['aria-describedby']}
          ariaRequired={control['aria-required']}
          value={text}
          onValueChange={(next) => {
            setText(next)
            setOpen(true)
            if (value !== null && next !== value.label) onChange(null)
          }}
          options={options}
          onSelect={(option) => {
            setText(option.label)
            setOpen(false)
            onChange({ id: option.id, label: option.label })
          }}
          isOpen={open}
          onOpenChange={setOpen}
          onFocus={() => setOpen(true)}
          emptyState={emptyState}
          liveRegionText={outcome?.ok ? strings.people.picker.results(options.length) : ''}
          testId={`${testId}-input`}
        />
      )}
    </Field>
  )
}
