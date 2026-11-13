import { useState } from 'react'
import { Field } from '@operai/ui'
import { strings } from '../strings'
import type { PersonOption } from './PersonFilterOptions'

/** The options of the Person select, from the read of the `person` totals (it is a read of its own). */
export type PeopleView =
  { status: 'loading' } | { status: 'error' } | { status: 'loaded'; options: readonly PersonOption[] }

export type PersonFilterProps = {
  /** The user id chosen; '' is everyone. */
  value: string
  people: PeopleView
  onChange: (personId: string) => void
}

/**
 * PersonFilter — the Person select of Everyone's hours (specs/029-time-tracking T29; AC-4.4, AC-4.8; design S4
 * "Filters card"). Its options are the people who have hours under the view's OTHER filters, so they are
 * exactly the people worth choosing and no user directory is needed; the page gives it the answer (it never
 * reads anything). "Everyone" is first, then the people in the order the server sent them (by name).
 *
 * The current choice is always an option: a person who drops out of a narrowed list is not silently reset
 * to everyone, and keeps the name the page last had for them (renamed meanwhile, the new one). A person the
 * page never saw named (a pasted link) is "Unknown user" — nothing here can look a name up.
 *
 * While the options load, or when they could not be loaded, the select shows only "Everyone" and the current
 * choice and says why in its hint; it stays reachable (`aria-disabled`, not `disabled`) and does nothing.
 * That is not an alert: the rest of the view works without the options.
 */
export default function PersonFilter({ value, people, onChange }: PersonFilterProps) {
  const t = strings.filters.person
  const options = people.status === 'loaded' ? people.options : []

  // The name the page last had for each person it has seen, so the current choice keeps it when a narrower
  // answer no longer lists them. Held as state, updated while rendering the answer that brings it.
  const [known, setKnown] = useState<ReadonlyMap<string, string>>(new Map())
  if (options.some((option) => known.get(option.id) !== option.label)) {
    setKnown(new Map([...known, ...options.map((option) => [option.id, option.label] as const)]))
  }

  const kept =
    value !== '' && !options.some((option) => option.id === value)
      ? { id: value, label: known.get(value) ?? strings.everyone.person.unknown }
      : null
  const usable = people.status === 'loaded'
  const hint = people.status === 'loading' ? t.loading : people.status === 'error' ? t.error : undefined

  return (
    <Field label={t.label} hint={hint}>
      {(control) => (
        <select
          {...control}
          value={value}
          aria-disabled={usable ? undefined : true}
          onChange={(event) => {
            if (usable) onChange(event.target.value)
          }}
          data-testid="hours-filter-person"
        >
          <option value="">{t.everyone}</option>
          {kept && <option value={kept.id}>{kept.label}</option>}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}
