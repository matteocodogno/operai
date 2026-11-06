import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Combobox } from './Combobox'
import type { ComboboxOption } from './Combobox'
import { Field } from './Field'

/** One entry of the list the app loads: an Operai user. */
export type Person = { id: string; name: string | null; email: string }

/** What a pick reports: the id and the text the field shows. */
export type PersonChoice = { id: string; label: string }

/**
 * How the app reads a failed `load` (the library knows nothing of the app's
 * HTTP client): the list is off limits for this caller, the service asked to
 * come back later, or anything else.
 */
export type PersonLoadFailure =
  { kind: 'forbidden' } | { kind: 'rate_limited'; retryAfterSeconds: number } | { kind: 'failed' }

export type PersonPickerProps = {
  label: ReactNode
  /**
   * Fetches the people the caller may choose from. Called ONCE on mount (and
   * again only when `loadKey` changes), so a new function on every render is
   * fine. Honour `signal`: it aborts on unmount.
   */
  load: (signal: AbortSignal) => Promise<readonly Person[]>
  /** Changes when the audience changes (another app id): the picker starts over and loads again. */
  loadKey?: string
  /** Maps a rejected `load` to what the picker should show. Unset: every failure is `failed`. */
  classifyError?: (error: unknown) => PersonLoadFailure
  value: PersonChoice | null
  onChange: (value: PersonChoice | null) => void
  error?: ReactNode
  required?: boolean
  /** Ids not offered (people already chosen). */
  exclude?: readonly string[]
  /** Empties the field after a choice: the picker adds people to a list. */
  clearOnSelect?: boolean
  /** The most people listed at once. Default 20. */
  maxOptions?: number
  /** `data-testid` of the field; the input is `<testId>-input`, the read-only fallback `<testId>-readonly`. */
  testId: string
  copy: {
    loading: string
    noMatch: string
    failed: string
    /** The label of a person who has no name. */
    noName: string
    /** The polite announcement of how many people the filter leaves. */
    results: (count: number) => string
    rateLimited: (seconds: number) => string
    /** Shown under the read-only field when the list is `forbidden` for this caller. */
    unavailableHint: string
  }
}

type Outcome = { ok: true; people: readonly Person[] } | { ok: false; failure: PersonLoadFailure }

const NEVER_CLASSIFIED = (): PersonLoadFailure => ({ kind: 'failed' })

/**
 * PersonPicker — choose an Operai user from a list the app loads. The list is
 * fetched once and filtered client-side by name or email, so the typed text
 * never leaves the browser. Built on `Combobox`; the app injects `load` (the
 * library cannot call an API) and every string.
 *
 * A caller the list refuses (`forbidden`) cannot pick someone else: the field
 * shows the current choice read-only with `unavailableHint`, and the record
 * keeps its default. A `rate_limited` failure says when to retry.
 */
export function PersonPicker({ loadKey, ...props }: PersonPickerProps) {
  // A new audience is a new picker: remounting drops the old list and any half-typed text.
  return <PersonPickerBody key={loadKey ?? ''} {...props} />
}

function PersonPickerBody({
  label,
  load,
  classifyError = NEVER_CLASSIFIED,
  value,
  onChange,
  error,
  required = false,
  exclude,
  clearOnSelect = false,
  maxOptions = 20,
  testId,
  copy,
}: Omit<PersonPickerProps, 'loadKey'>) {
  // The loader of the first render is the one used: an inline arrow must not refetch on every render.
  const [loader] = useState(() => load)
  const [classify] = useState(() => classifyError)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [text, setText] = useState(value?.label ?? '')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    loader(controller.signal).then(
      (people) => {
        if (!controller.signal.aborted) setOutcome({ ok: true, people })
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setOutcome({ ok: false, failure: classify(failure) })
      },
    )
    return () => controller.abort()
  }, [loader, classify])

  const options = useMemo<ComboboxOption[]>(() => {
    if (outcome === null || !outcome.ok) return []
    const needle = text.trim().toLowerCase()
    return outcome.people
      .filter((person) => !exclude?.includes(person.id))
      .filter((person) => !needle || `${person.name ?? ''} ${person.email}`.toLowerCase().includes(needle))
      .slice(0, maxOptions)
      .map((person) => ({ id: person.id, label: person.name ?? copy.noName, secondaryLabel: person.email }))
  }, [outcome, text, exclude, maxOptions, copy.noName])

  if (outcome !== null && !outcome.ok && outcome.failure.kind === 'forbidden') {
    return (
      <Field label={label} hint={copy.unavailableHint} testId={testId}>
        {(control) => <input {...control} value={value?.label ?? ''} readOnly data-testid={`${testId}-readonly`} />}
      </Field>
    )
  }

  const emptyState =
    outcome === null
      ? copy.loading
      : outcome.ok
        ? copy.noMatch
        : outcome.failure.kind === 'rate_limited'
          ? copy.rateLimited(outcome.failure.retryAfterSeconds)
          : copy.failed

  return (
    <Field label={label} error={error} required={required} testId={testId}>
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
            setText(clearOnSelect ? '' : option.label)
            setOpen(false)
            onChange({ id: option.id, label: option.label })
          }}
          isOpen={open}
          onOpenChange={setOpen}
          onFocus={() => setOpen(true)}
          emptyState={emptyState}
          liveRegionText={outcome?.ok ? copy.results(options.length) : ''}
          testId={`${testId}-input`}
        />
      )}
    </Field>
  )
}
